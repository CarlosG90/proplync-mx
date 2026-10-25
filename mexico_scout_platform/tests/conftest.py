"""Shared fixtures: an offline vector store (hashed bag-of-words instead of a downloaded model) and a local fake portal."""

from __future__ import annotations

import hashlib
import math
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from qdrant_client import QdrantClient

from src.config import Settings
from src.db.vector_db import ListingStore


class OfflineStore(ListingStore):
    """Same Qdrant logic, deterministic offline embeddings (no model download)."""

    def embed(self, texts):  # type: ignore[override]
        out = []
        for text in texts:
            vec = [0.0] * self.dim
            for token in str(text).lower().replace(",", " ").replace(".", " ").split():
                vec[int(hashlib.md5(token.encode()).hexdigest(), 16) % self.dim] += 1.0
            norm = math.sqrt(sum(v * v for v in vec)) or 1.0
            out.append([v / norm for v in vec])
        return out


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None, qdrant_path=str(tmp_path / "q"), qdrant_collection="test", request_delay_min=0, request_delay_max=0,
        browser_fallback=False, allowed_domains=("localhost", "127.0.0.1"), max_pages_per_run=50, usd_mxn_rate=18.0,
    )


@pytest.fixture()
def store(settings) -> OfflineStore:
    s = OfflineStore(settings, client=QdrantClient(":memory:"))
    yield s
    s.close()


# --- a fake portal ----------------------------------------------------------------------------------------------------

def listing_html(title: str, price_line: str, rooms: str = "2 recámaras", baths: str = "2 baños", area: str = "105 m² de construcción", extra: str = "") -> str:
    return f"""<html><head><title>{title}</title></head><body><nav>Inicio Venta Renta Contacto</nav><main>
<h1>{title}</h1><div class="price">{price_line}</div><ul><li>{rooms}</li><li>{baths}</li><li>{area}</li></ul>
<p>Hermoso departamento con alberca y roof garden en Aldea Zama, Tulum. Seguridad 24 horas y a pasos de la playa. {extra}</p>
</main><footer>Aviso de privacidad</footer></body></html>"""


def build_site() -> dict[str, tuple[int, str]]:
    site: dict[str, tuple[int, str]] = {
        "/robots.txt": (200, "User-agent: *\nDisallow: /privado\n"),
        "/privado/1": (200, "<html><body>private</body></html>"),
        "/bloqueado": (403, "<html><title>Just a moment...</title><body>Verify you are human cf-chl</body></html>"),
        "/venta/propiedad-1": (200, listing_html("Departamento en venta en Aldea Zama, Tulum", "$4,500,000 MXN")),
    }
    for i, nightly in enumerate((140, 160, 150), start=1):
        site[f"/renta-vacacional/propiedad-{i}"] = (200, listing_html(
            f"Departamento en renta vacacional Aldea Zama Tulum {i}", f"${nightly} USD por noche", area=f"{90 + i * 5} m² de construcción"))
    for i, monthly in enumerate((1700, 1900, 1800), start=1):
        site[f"/renta/propiedad-{i}"] = (200, listing_html(
            f"Departamento en renta Aldea Zama Tulum {i}", f"${monthly} USD /mes", area=f"{90 + i * 5} m² de construcción"))
    links = "".join(f'<a href="{p}">x</a>' for p in site if p.startswith(("/venta/", "/renta/", "/renta-vacacional/")))
    site["/resultados"] = (200, f"<html><body>{links}<a href='/contacto'>Contacto</a><a href='https://otro.com/propiedad-9'>otro</a></body></html>")
    return site


@pytest.fixture(scope="session")
def portal():
    site = build_site()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            status, body = site.get(self.path.split("?")[0], (404, "not found"))
            data = body.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):  # silence
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
