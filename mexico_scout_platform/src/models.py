"""Pydantic schemas shared by every layer.

WHY THIS EXISTS
One typed shape for "a property" travels from the scraper hints, through the agent's output, into Qdrant's payload and
out to the maths engine. Validation here is what stops a local LLM's malformed JSON from reaching the database.

MERGE PATH INTO proplync.mx
Field names follow what Scout already stores in `scout_candidates` / `search_properties` (operation, property_type,
town, neighborhood, bedrooms, bathrooms, built_m2, land_m2, sources[{url, site, price, currency}]).
`PropertyListing.to_scout_card()` produces that shape, so this package can feed Scout's merge step unchanged.
`m2_size` is the payload name this project was specified with; it maps to Scout's `built_m2`.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, Field, field_validator, model_validator

from src.domain import canonical_neighborhood, infer_currency, to_usd

Currency = Literal["MXN", "USD", "EUR", "CAD"]


class Operation(str, Enum):
    SALE = "sale"
    RENTAL_LONG = "rental_long"  # monthly
    RENTAL_SHORT = "rental_short"  # nightly (vacation rental)


def normalize_url(url: str) -> str:
    """Stable identity for a listing: scheme/host lower-cased, no fragment, no tracking query, no trailing slash."""
    parts = urlsplit(url.strip())
    query = "&".join(
        p for p in parts.query.split("&")
        if p and not p.lower().startswith(("utm_", "fbclid", "gclid", "ref=", "source="))
    )
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower().removeprefix("www."), path, query, ""))


class PropertyListing(BaseModel):
    url: str
    title: str | None = None
    operation: Operation = Operation.SALE
    price_period: Literal["total", "month", "night"] = "total"
    property_type: str | None = None
    town: str | None = None
    neighborhood: str | None = None
    bedrooms: int | None = Field(default=None, ge=0, le=20)
    bathrooms: float | None = Field(default=None, ge=0, le=20)
    m2_size: float | None = Field(default=None, gt=0, le=1_000_000)
    land_m2: float | None = Field(default=None, gt=0, le=100_000_000)
    price: float | None = Field(default=None, gt=0)
    currency: Currency | None = None
    currency_assumed: bool = False
    price_usd: float | None = None
    amenities: list[str] = Field(default_factory=list)
    summary: str | None = None
    source_site: str | None = None
    scraped_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    # Filled by the pipeline when the FX rate in force is known; kept so a stored price can be audited later.
    usd_mxn_rate: float | None = None

    @field_validator("url")
    @classmethod
    def _url_ok(cls, value: str) -> str:
        if not value.lower().startswith(("http://", "https://")):
            raise ValueError("url must start with http:// or https://")
        return value.strip()

    @field_validator("operation", mode="before")
    @classmethod
    def _operation_aliases(cls, value: Any) -> Any:
        aliases = {"rental": "rental_long", "rent": "rental_long", "renta": "rental_long", "venta": "sale", "for_sale": "sale",
                   "airbnb": "rental_short", "vacation": "rental_short", "short_term": "rental_short", "long_term": "rental_long"}
        if isinstance(value, str):
            return aliases.get(value.strip().lower(), value.strip().lower())
        return value

    @field_validator("bedrooms", mode="before")
    @classmethod
    def _bedrooms_number(cls, value: Any) -> Any:
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
        return value

    @field_validator("currency", mode="before")
    @classmethod
    def _currency_upper(cls, value: Any) -> Any:
        if isinstance(value, str):
            cleaned = value.strip().upper()
            return {"US$": "USD", "USDOLLARS": "USD", "PESOS": "MXN", "MN": "MXN", "": None}.get(cleaned, cleaned)
        return value

    @model_validator(mode="after")
    def _derive(self) -> "PropertyListing":
        # An operation says what the price means; keep the period consistent with it.
        self.price_period = {Operation.SALE: "total", Operation.RENTAL_LONG: "month", Operation.RENTAL_SHORT: "night"}[self.operation]
        if self.neighborhood or self.town:
            hood, town = canonical_neighborhood(self.neighborhood, self.town)
            self.neighborhood, self.town = hood, town or self.town
        if self.price is not None and self.currency is None:
            self.currency = infer_currency(self.price, self.price_period, self.operation.value)  # type: ignore[assignment]
            self.currency_assumed = True
        if self.price is not None and self.price_usd is None and self.currency:
            rate = self.usd_mxn_rate or 18.0
            self.price_usd = to_usd(self.price, self.currency, rate)
        if self.source_site is None:
            self.source_site = urlsplit(self.url).netloc.lower().removeprefix("www.") or None
        return self

    # -- identity and storage --------------------------------------------------------------------------------------
    @property
    def point_id(self) -> str:
        """Deterministic id: re-scraping the same listing overwrites its point instead of duplicating it."""
        return str(uuid.uuid5(uuid.NAMESPACE_URL, normalize_url(self.url)))

    @property
    def price_per_m2_usd(self) -> float | None:
        if self.price_usd and self.m2_size and self.operation is Operation.SALE:
            return round(self.price_usd / self.m2_size, 2)
        return None

    def embedding_text(self) -> str:
        """What gets embedded: Spanish + English cues so a query in either language lands near it."""
        bits = [
            self.property_type or "propiedad",
            f"{self.bedrooms} recámaras bedrooms" if self.bedrooms is not None else "",
            f"{self.bathrooms:g} baños bathrooms" if self.bathrooms is not None else "",
            f"{self.m2_size:g} m²" if self.m2_size else "",
            f"en {self.neighborhood}" if self.neighborhood else "",
            f"{self.town}, Quintana Roo, México" if self.town else "",
            {"sale": "en venta for sale", "rental_long": "en renta for rent long term",
             "rental_short": "renta vacacional short-term vacation rental"}[self.operation.value],
            self.title or "",
            self.summary or "",
            ", ".join(self.amenities),
        ]
        return ". ".join(b for b in bits if b)

    def to_payload(self) -> dict[str, Any]:
        """Qdrant payload: the filterable facts (price, neighborhood, bedrooms, url, m2_size) plus the rest."""
        data = self.model_dump(mode="json")
        data["operation"] = self.operation.value
        data["price_per_m2_usd"] = self.price_per_m2_usd
        data["url_normalized"] = normalize_url(self.url)
        return data

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "PropertyListing":
        known = {k: v for k, v in payload.items() if k in cls.model_fields}
        return cls.model_validate(known)

    def to_scout_card(self) -> dict[str, Any]:
        """The shape of a Scout candidate in proplync.mx (see api/_lib/scout-merge.js)."""
        return {
            "origin": "web",
            "title": self.title,
            "operation": "rental" if self.operation is not Operation.SALE else "sale",
            "property_type": self.property_type,
            "town": self.town,
            "neighborhood": self.neighborhood,
            "bedrooms": self.bedrooms,
            "bathrooms": self.bathrooms,
            "built_m2": self.m2_size,
            "land_m2": self.land_m2,
            "sources": [{"url": self.url, "site": self.source_site, "price": self.price, "currency": self.currency}],
        }


class ScoredListing(BaseModel):
    listing: PropertyListing
    score: float = Field(description="Cosine similarity, 0..1: how close in meaning to the query")


class SearchBrief(BaseModel):
    """What the user wants scouted. Mirrors the useful part of a proplync.mx buyer brief."""
    town: str | None = None
    neighborhoods: list[str] = Field(default_factory=list)
    max_price_usd: float | None = None
    min_bedrooms: int | None = None
    property_type: str | None = None
    notes: str = ""
    urls: list[str] = Field(default_factory=list, description="Listing or results pages to scout")
