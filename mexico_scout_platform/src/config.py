"""Configuration loader (Pydantic Settings).

WHY THIS EXISTS
Every knob (Qdrant path, embedding model, LLM endpoint, proxy, scraping politeness, FX rate) lives in one typed object
read from `.env` or the environment, so no module reads os.environ on its own and a typo fails at start-up, not
mid-run.

WHY NOT A PAID LLM BY DEFAULT
The platform is 100% open-source: the default model is a local Ollama model. Point LLM_MODEL / LLM_BASE_URL at any
OpenAI-compatible or LiteLLM-supported endpoint to change it. Nothing here needs an API key to run the deterministic
parts (scraping, parsing, vector search, financial maths).
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# The crew framework phones home by default; this is a local-first tool, so it does not.
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Hosts for plain fetches, from real runs on 2026-10-25 (this machine's network):
#   opened     bestcaribbeanproperty.com, moskito.mx, remaxmaya.com  (rules read price, rooms and m2 correctly)
#   challenged propiedades.com, hausrealestate.com.mx, luxuryhabitat.com.mx, sienteei.com  (a visitor-check page, served with 200)
#   refused    Inmuebles24, Lamudi, Vivanuncios, MercadoLibre (in the PropLync Scout runs)
# Only hosts that opened, plus two not yet tried from here, are allowed by default: asking a site that has just challenged us
# again is not polite. The platform does not defeat these checks; for those portals use the Apify adapters in proplync.mx's
# `ingest/` or a licensed feed. Re-test with `python -m src.pipeline ingest <url>` and add hosts via ALLOWED_DOMAINS.
DEFAULT_ALLOWED_DOMAINS = (
    "bestcaribbeanproperty.com",
    "moskito.mx",
    "remaxmaya.com",
    "junglerealtor.com",  # opened 2026-10-31 (robots.txt allows crawlers, sitemaps readable); added for its long-term rentals
    "mudafy.com.mx",      # not yet tried from here
    "selvacorealty.com",  # not yet tried from here
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=PROJECT_ROOT / ".env", env_file_encoding="utf-8", extra="ignore")

    # --- vector store -------------------------------------------------------------------------------------------
    qdrant_path: str = "./qdrant_storage"
    qdrant_collection: str = "mx_listings"
    # Multilingual on purpose: listings are written in Spanish, buyers search in either language.
    embedding_model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

    # --- LLM for the CrewAI agents (local by default) -------------------------------------------------------------
    llm_model: str = "ollama/llama3.1"
    llm_base_url: str = "http://localhost:11434"
    llm_api_key: str = ""
    llm_temperature: float = 0.1
    # Hosted free tiers rate-limit by tokens per minute (Groq: 7,000 input tokens/min on qwen3.8-27b). The agent waits and
    # retries instead of dying mid-run, and sees a shorter page than the rules do (the rules read the full text).
    llm_num_retries: int = Field(default=8, ge=0)
    # Output cap per model call. Groq's free tier allows 1,000 output tokens/min, so one request may not ask for more than that.
    llm_max_tokens: int = Field(default=4096, gt=0)
    agent_markdown_chars: int = Field(default=2500, gt=0)

    # --- money ----------------------------------------------------------------------------------------------------
    usd_mxn_rate: float = Field(default=18.0, gt=0)  # MXN per USD. No paid FX API: set it, or keep the default.

    # --- scraping -------------------------------------------------------------------------------------------------
    proxy_url: str = ""  # e.g. http://user:pass@host:port ; empty = direct
    impersonate: str = "chrome"  # browser whose TLS/HTTP2 fingerprint the HTTP layer mimics
    request_delay_min: float = Field(default=3.0, ge=0)
    request_delay_max: float = Field(default=9.0, ge=0)
    fetch_timeout: int = Field(default=30, gt=0)
    browser_fallback: bool = True  # retry a blocked page once in a headless browser before giving up
    respect_robots: bool = True
    allowed_domains: Annotated[tuple[str, ...], NoDecode] = DEFAULT_ALLOWED_DOMAINS
    max_pages_per_run: int = Field(default=12, gt=0)
    max_markdown_chars: int = Field(default=6000, gt=0)

    # --- run ------------------------------------------------------------------------------------------------------
    log_level: str = "INFO"
    agent_verbose: bool = False

    @field_validator("allowed_domains", mode="before")
    @classmethod
    def _split_domains(cls, value: object) -> object:
        if isinstance(value, str):
            return tuple(d.strip().lower() for d in value.split(",") if d.strip())
        return value

    @field_validator("request_delay_max")
    @classmethod
    def _max_not_below_min(cls, value: float, info) -> float:  # type: ignore[no-untyped-def]
        low = info.data.get("request_delay_min", 0.0)
        return max(value, low)

    @property
    def qdrant_dir(self) -> Path:
        path = Path(self.qdrant_path)
        return path if path.is_absolute() else (PROJECT_ROOT / path).resolve()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
