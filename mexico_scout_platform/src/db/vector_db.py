"""Local-first vector store: Qdrant on disk + fastembed embeddings.

WHY THIS EXISTS
The platform remembers every listing it has read, so a second run is cheap and the financial analyst can ask "what else
looks like this, in this neighbourhood?" without touching the web again.

WHY QDRANT LOCAL + FASTEMBED
No server, no API key, no per-token cost: QdrantClient(path=...) keeps everything in one folder, and fastembed runs an
ONNX embedding model on the CPU. Spanish listings need a multilingual model (see config.embedding_model).

WHY FILTER FIRST
A comparable is only comparable inside the same market. Every search applies strict payload conditions (operation,
neighbourhood, bedrooms, price band...) as a Qdrant filter, and only then ranks the survivors by cosine similarity.
Widening the net (neighbourhood -> town) is an explicit, labelled step in `find_comps`, never a silent one.

NOTE: local mode takes a lock on the folder, so one process at a time. For several workers, run a Qdrant server and
swap QdrantClient(path=...) for QdrantClient(url=...); nothing else here changes.
"""

from __future__ import annotations

import warnings
from typing import Iterable

from fastembed import TextEmbedding
from loguru import logger
from qdrant_client import QdrantClient, models

from src.config import Settings, get_settings
from src.models import Operation, PropertyListing, ScoredListing

# Fields we filter on; indexed so a server deployment stays fast (a no-op in local mode).
_KEYWORD_INDEXES = ("operation", "town", "neighborhood", "property_type", "url_normalized")
_FLOAT_INDEXES = ("price_usd", "m2_size")
_INTEGER_INDEXES = ("bedrooms",)


class ListingStore:
    def __init__(self, settings: Settings | None = None, client: QdrantClient | None = None) -> None:
        self.settings = settings or get_settings()
        self.collection = self.settings.qdrant_collection
        if client is None:
            self.settings.qdrant_dir.mkdir(parents=True, exist_ok=True)
            client = QdrantClient(path=str(self.settings.qdrant_dir))
        self.client = client
        self._embedder: TextEmbedding | None = None
        self._dim: int | None = None

    # -- embeddings ------------------------------------------------------------------------------------------------
    @property
    def embedder(self) -> TextEmbedding:
        if self._embedder is None:
            logger.info("Loading embedding model {} (first run downloads it once)", self.settings.embedding_model)
            self._embedder = TextEmbedding(model_name=self.settings.embedding_model)
        return self._embedder

    @property
    def dim(self) -> int:
        if self._dim is None:
            self._dim = TextEmbedding.get_embedding_size(self.settings.embedding_model)
        return self._dim

    def embed(self, texts: Iterable[str]) -> list[list[float]]:
        return [vector.tolist() for vector in self.embedder.embed(list(texts))]

    # -- collection ------------------------------------------------------------------------------------------------
    def ensure_collection(self) -> None:
        if self.client.collection_exists(self.collection):
            return
        logger.info("Creating collection {} ({} dims, cosine)", self.collection, self.dim)
        self.client.create_collection(
            collection_name=self.collection,
            vectors_config=models.VectorParams(size=self.dim, distance=models.Distance.COSINE),
        )
        with warnings.catch_warnings():
            # Local mode ignores payload indexes (and says so); they are declared anyway so a Qdrant server needs no change.
            warnings.simplefilter("ignore", UserWarning)
            for name in _KEYWORD_INDEXES:
                self.client.create_payload_index(self.collection, name, models.PayloadSchemaType.KEYWORD)
            for name in _FLOAT_INDEXES:
                self.client.create_payload_index(self.collection, name, models.PayloadSchemaType.FLOAT)
            for name in _INTEGER_INDEXES:
                self.client.create_payload_index(self.collection, name, models.PayloadSchemaType.INTEGER)

    def count(self) -> int:
        if not self.client.collection_exists(self.collection):
            return 0
        return self.client.count(self.collection, exact=True).count

    # -- write -----------------------------------------------------------------------------------------------------
    def upsert(self, listings: list[PropertyListing]) -> int:
        """Store listings. The point id comes from the URL, so re-scraping a listing updates it in place."""
        if not listings:
            return 0
        self.ensure_collection()
        vectors = self.embed(l.embedding_text() for l in listings)
        points = [models.PointStruct(id=l.point_id, vector=v, payload=l.to_payload()) for l, v in zip(listings, vectors)]
        self.client.upsert(self.collection, points=points, wait=True)
        logger.info("Upserted {} listing(s) into {}", len(points), self.collection)
        return len(points)

    def get(self, url: str) -> PropertyListing | None:
        if not self.client.collection_exists(self.collection):
            return None
        probe = PropertyListing(url=url)
        found = self.client.retrieve(self.collection, ids=[probe.point_id], with_payload=True)
        return PropertyListing.from_payload(found[0].payload or {}) if found else None

    # -- read ------------------------------------------------------------------------------------------------------
    @staticmethod
    def build_filter(
        *,
        operation: Operation | str | None = None,
        town: str | None = None,
        neighborhood: str | None = None,
        property_type: str | None = None,
        bedrooms: int | None = None,
        bedroom_tolerance: int = 0,
        min_price_usd: float | None = None,
        max_price_usd: float | None = None,
        min_m2: float | None = None,
        max_m2: float | None = None,
        exclude_url: str | None = None,
    ) -> models.Filter | None:
        must: list[models.Condition] = []
        must_not: list[models.Condition] = []
        if operation is not None:
            must.append(models.FieldCondition(key="operation", match=models.MatchValue(value=Operation(operation).value)))
        if town:
            must.append(models.FieldCondition(key="town", match=models.MatchValue(value=town)))
        if neighborhood:
            must.append(models.FieldCondition(key="neighborhood", match=models.MatchValue(value=neighborhood)))
        if property_type:
            must.append(models.FieldCondition(key="property_type", match=models.MatchValue(value=property_type)))
        if bedrooms is not None:
            must.append(models.FieldCondition(key="bedrooms", range=models.Range(gte=bedrooms - bedroom_tolerance, lte=bedrooms + bedroom_tolerance)))
        if min_price_usd is not None or max_price_usd is not None:
            must.append(models.FieldCondition(key="price_usd", range=models.Range(gte=min_price_usd, lte=max_price_usd)))
        if min_m2 is not None or max_m2 is not None:
            must.append(models.FieldCondition(key="m2_size", range=models.Range(gte=min_m2, lte=max_m2)))
        if exclude_url:
            probe = PropertyListing(url=exclude_url)
            must_not.append(models.HasIdCondition(has_id=[probe.point_id]))
        return models.Filter(must=must or None, must_not=must_not or None) if (must or must_not) else None

    def search(self, query_text: str, *, limit: int = 10, min_score: float = 0.0, **filters) -> list[ScoredListing]:
        """Filter on the payload first (strict), then rank what is left by cosine similarity to `query_text`."""
        if not self.client.collection_exists(self.collection):
            return []
        query_filter = self.build_filter(**filters)
        vector = self.embed([query_text])[0]
        response = self.client.query_points(
            self.collection, query=vector, query_filter=query_filter, limit=limit, with_payload=True,
        )
        hits = [
            ScoredListing(listing=PropertyListing.from_payload(p.payload or {}), score=float(p.score))
            for p in response.points if p.score >= min_score
        ]
        logger.debug("search {!r} filters={} -> {} hit(s)", query_text[:60], {k: v for k, v in filters.items() if v is not None}, len(hits))
        return hits

    def find_comps(
        self,
        subject: PropertyListing,
        operation: Operation,
        *,
        limit: int = 8,
        min_comps: int = 3,
        bedroom_tolerance: int = 1,
    ) -> tuple[list[ScoredListing], str]:
        """Comparable listings of a given operation, nearest-in-meaning first.

        Tries the subject's neighbourhood; if that gives fewer than `min_comps`, widens to the whole town and says so.
        Returns (comps, scope) with scope in {"neighborhood", "town", "none"}, so a report can state how local the comps are.
        """
        common = dict(operation=operation, bedrooms=subject.bedrooms, bedroom_tolerance=bedroom_tolerance, exclude_url=subject.url)
        query = subject.embedding_text()
        if subject.neighborhood:
            comps = self.search(query, limit=limit, town=subject.town, neighborhood=subject.neighborhood, **common)
            if len(comps) >= min_comps:
                return comps, "neighborhood"
        if subject.town:
            comps = self.search(query, limit=limit, town=subject.town, **common)
            if comps:
                return comps, "town"
        return [], "none"

    def close(self) -> None:
        self.client.close()
