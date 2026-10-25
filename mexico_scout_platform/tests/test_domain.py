import pytest

from src.domain import (canonical_neighborhood, detect_neighborhood, detect_operation, detect_property_type, hints_from_text, infer_currency,
                        jsonld_hints, parse_areas, parse_bathrooms, parse_bedrooms, parse_money, to_usd)


@pytest.mark.parametrize("text,expected", [
    ("$4,500,000 MXN", (4_500_000, "MXN")),
    ("USD 245,000", (245_000, "USD")),
    ("US$245,000", (245_000, "USD")),
    ("$3.5 MDP", (3_500_000, "MXN")),
    ("$250 mil USD", (250_000, "USD")),
    ("$4,500,000", (4_500_000, None)),
    ("MXN$ 18,000 /mes", (18_000, "MXN")),
    ("$120 USD por noche", (120, "USD")),
    ("precio 2 millones de pesos", (2_000_000, "MXN")),
])
def test_parse_money(text, expected):
    assert parse_money(text) == expected


def test_a_number_without_currency_is_not_a_price():
    assert parse_money("105 m2, 2 recamaras, 3 banos") == (None, None)
    assert parse_money(None) == (None, None)


def test_bare_dollar_sign_currency_is_inferred_and_flagged_by_callers():
    assert infer_currency(4_500_000, "total", "sale") == "MXN"
    assert infer_currency(175_000, "total", "sale") == "USD"
    assert infer_currency(1_800, "month", "rental_long") == "USD"
    assert infer_currency(22_000, "month", "rental_long") == "MXN"
    assert infer_currency(150, "night", "rental_short") == "USD"


def test_to_usd_converts_mxn_and_refuses_unsupported_currencies():
    assert to_usd(4_500_000, "MXN", 18.0) == 250_000
    assert to_usd(100, "USD", 18.0) == 100
    assert to_usd(100, "EUR", 18.0) is None
    assert to_usd(None, "MXN", 18.0) is None


def test_areas_labelled_and_unlabelled():
    assert parse_areas("105 m² de construcción y 300 m² de terreno") == (105, 300)
    assert parse_areas("Construcción: 120.5 m2. Terreno: 250 m2") == (120.5, 250)
    assert parse_areas("departamento de 85 mts2") == (85, None)
    assert parse_areas("sin datos") == (None, None)


def test_bedrooms_and_bathrooms_in_spanish_and_english():
    assert parse_bedrooms("Departamento de 2 recámaras") == 2
    assert parse_bedrooms("3 habitaciones, 2 baños") == 3
    assert parse_bedrooms("Bedrooms: 4") == 4
    assert parse_bedrooms("Estudio amueblado") == 0
    assert parse_bedrooms("terreno") is None
    assert parse_bathrooms("2 baños") == 2
    assert parse_bathrooms("2 baños y medio") == 2.5
    assert parse_bathrooms("1.5 bathrooms") == 1.5


def test_neighborhood_aliases_map_to_canonical_names():
    assert detect_neighborhood("Departamento en Aldea Zamá, Tulum") == ("Aldea Zama", "Tulum")
    assert detect_neighborhood("Zama Village penthouse") == ("Aldea Zama", "Tulum")
    assert detect_neighborhood("casa en Gonzalo Guerrero Playa del Carmen")[0] == "Gonzalo Guerrero"
    assert detect_neighborhood("Zona Hotelera Cancún")[0] == "Zona Hotelera Cancun"
    assert detect_neighborhood("zona hotelera tulum, beach road")[0] == "Tulum Beach Zone"
    assert detect_neighborhood("algo en el centro")[0] is None


def test_unknown_neighborhood_is_kept_not_dropped():
    assert canonical_neighborhood("barrio nuevo", "Tulum") == ("Barrio Nuevo", "Tulum")
    assert canonical_neighborhood("Aldea Zamá", None) == ("Aldea Zama", "Tulum")


def test_operation_is_read_from_the_price_unit_and_title_not_from_the_navigation_bar():
    nav = "Inicio Venta Renta Contacto\n"
    assert detect_operation(nav + "# Departamento en venta en Tulum\n$4,500,000 MXN\nCuota de mantenimiento mensual $2,500")[0] == "sale"
    assert detect_operation(nav + "# Depa\n$150 USD por noche")[0] == "rental_short"
    assert detect_operation(nav + "# Depa\n$1,800 USD /mes")[0] == "rental_long"
    assert detect_operation("sin titulo", title="Casa en renta vacacional")[0] == "rental_short"
    assert detect_operation("Se renta departamento amueblado", title="Depa")[0] == "rental_long"
    assert detect_operation("") == ("sale", "total")


def test_operation_and_property_type():
    assert detect_operation("Depa en venta") == ("sale", "total")
    assert detect_operation("$1,800 USD /mes en renta") == ("rental_long", "month")
    assert detect_operation("$150 USD por noche, airbnb") == ("rental_short", "night")
    assert detect_property_type("Penthouse con roof garden") == "penthouse"
    assert detect_property_type("Casa en venta") == "house"
    assert detect_property_type("Departamento 2 recámaras") == "apartment"


def test_jsonld_hints_read_schema_org():
    html = '<script type="application/ld+json">{"@type":"Product","name":"Depto","offers":{"price":"4,500,000","priceCurrency":"MXN"},"numberOfBedrooms":2,"floorSize":{"value":"105"},"address":{"streetAddress":"Calle 1","addressLocality":"Tulum"}}</script>'
    hints = jsonld_hints(html)
    assert hints["price"] == 4_500_000 and hints["currency"] == "MXN" and hints["bedrooms"] == 2 and hints["m2_size"] == 105
    assert "Tulum" in hints["location"]
    assert jsonld_hints("<script type='application/ld+json'>{broken</script>") == {}


def test_hints_from_text_reads_a_whole_listing():
    hints = hints_from_text("# Departamento en venta en Aldea Zama, Tulum\n$4,500,000 MXN\n* 2 recámaras\n* 2 baños\n* 105 m² de construcción")
    assert (hints["price"], hints["currency"], hints["bedrooms"], hints["bathrooms"], hints["m2_size"]) == (4_500_000, "MXN", 2, 2, 105)
    assert (hints["neighborhood"], hints["town"], hints["operation"], hints["property_type"]) == ("Aldea Zama", "Tulum", "sale", "apartment")
