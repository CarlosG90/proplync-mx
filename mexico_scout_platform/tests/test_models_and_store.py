import pytest
from pydantic import ValidationError

from src.models import Operation, PropertyListing, normalize_url


def make(url="https://x.mx/p/1", **kw):
    base = dict(title="Depto Aldea Zama", operation="sale", property_type="apartment", town="Tulum", neighborhood="Aldea Zamá",
                bedrooms=2, bathrooms=2, m2_size=105, price=4_500_000, currency="MXN", usd_mxn_rate=18.0)
    base.update(kw)
    return PropertyListing(url=url, **base)


def test_listing_is_normalised_and_priced_in_usd():
    l = make()
    assert l.neighborhood == "Aldea Zama" and l.town == "Tulum"
    assert l.price_usd == 250_000
    assert l.price_per_m2_usd == pytest.approx(2380.95, abs=0.01)
    assert l.source_site == "x.mx"


def test_currency_is_assumed_and_flagged_when_missing():
    l = make(currency=None, price=4_500_000)
    assert (l.currency, l.currency_assumed) == ("MXN", True)
    assert make(currency=None, price=175_000).currency == "USD"


def test_operation_aliases_and_period_follow_the_operation():
    assert make(operation="renta").operation is Operation.RENTAL_LONG
    l = make(operation="rental_short", price=150, currency="USD")
    assert l.price_period == "night" and l.price_usd == 150


def test_invalid_records_are_rejected_before_the_database():
    with pytest.raises(ValidationError):
        make(url="ftp://x")
    with pytest.raises(ValidationError):
        make(bedrooms=99)
    with pytest.raises(ValidationError):
        make(price=-5)


def test_same_listing_same_point_id_even_with_tracking_params():
    a, b = make("https://www.X.mx/p/1/?utm_source=fb#top"), make("https://x.mx/p/1")
    assert a.point_id == b.point_id
    assert normalize_url("https://www.X.mx/p/1/?utm_source=fb&id=3#t") == "https://x.mx/p/1?id=3"


def test_scout_card_matches_the_proplync_shape():
    card = make().to_scout_card()
    assert card["operation"] == "sale" and card["built_m2"] == 105 and card["neighborhood"] == "Aldea Zama"
    assert card["sources"] == [{"url": "https://x.mx/p/1", "site": "x.mx", "price": 4_500_000, "currency": "MXN"}]
    assert make(operation="rental_long", price=1800, currency="USD").to_scout_card()["operation"] == "rental"


def test_payload_round_trips():
    l = make()
    assert PropertyListing.from_payload(l.to_payload()).point_id == l.point_id


# --- the vector store ------------------------------------------------------------------------------------------------

def test_upsert_is_idempotent_and_get_reads_it_back(store):
    store.upsert([make()])
    store.upsert([make(price=4_000_000)])  # same URL: updates in place
    assert store.count() == 1
    assert store.get("https://x.mx/p/1").price == 4_000_000
    assert store.get("https://x.mx/never") is None


def test_search_applies_strict_filters_before_ranking(store):
    store.upsert([
        make("https://x.mx/p/1"),
        make("https://x.mx/p/2", neighborhood="La Veleta", price=3_600_000),
        make("https://x.mx/p/3", bedrooms=4, price=9_000_000),
        make("https://x.mx/p/4", operation="rental_long", price=1800, currency="USD"),
    ])
    everything = store.search("departamento en Tulum", limit=10)
    assert len(everything) == 4
    aldea = store.search("departamento en Tulum", neighborhood="Aldea Zama", operation="sale", limit=10)
    assert {h.listing.url for h in aldea} == {"https://x.mx/p/1", "https://x.mx/p/3"}
    cheap = store.search("departamento", operation="sale", max_price_usd=210_000, limit=10)
    assert {h.listing.url for h in cheap} == {"https://x.mx/p/2"}
    two_bed = store.search("departamento", operation="sale", bedrooms=2, bedroom_tolerance=0, limit=10)
    assert {h.listing.url for h in two_bed} == {"https://x.mx/p/1", "https://x.mx/p/2"}
    assert store.search("x", town="Cancún") == []


def test_semantic_ranking_puts_the_closest_listing_first(store):
    store.upsert([make("https://x.mx/p/1", summary="alberca roof garden terraza"), make("https://x.mx/p/2", summary="bodega industrial")])
    hits = store.search("departamento con alberca y roof garden", limit=2)
    assert hits[0].listing.url == "https://x.mx/p/1" and hits[0].score >= hits[1].score


def test_find_comps_prefers_the_neighbourhood_then_widens_to_the_town_and_says_so(store):
    subject = make("https://x.mx/subject")
    store.upsert([subject] + [make(f"https://x.mx/r{i}", operation="rental_long", price=1800, currency="USD") for i in range(3)])
    comps, scope = store.find_comps(subject, Operation.RENTAL_LONG)
    assert scope == "neighborhood" and len(comps) == 3
    assert all(c.listing.url != subject.url for c in comps)

    lonely = make("https://x.mx/lonely", neighborhood="La Veleta")
    comps, scope = store.find_comps(lonely, Operation.RENTAL_LONG)
    assert scope == "town" and len(comps) == 3
    comps, scope = store.find_comps(make("https://x.mx/c", town="Cancún", neighborhood="Puerto Cancun"), Operation.RENTAL_LONG)
    assert (comps, scope) == ([], "none")
