import pytest

from src.domain import (focus_listing_text, canonical_neighborhood, detect_neighborhood, detect_operation, detect_property_type, hints_from_text, infer_currency,
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


def test_number_words_and_hyphenated_bedrooms():
    assert parse_bedrooms("Departamento de dos habitaciones en venta") == 2
    assert parse_bedrooms("Penthouse de tres recámaras") == 3
    assert parse_bedrooms("Artia Condos 2-Bedroom Penthouse") == 2
    assert parse_bedrooms("un baño") is None and parse_bathrooms("dos baños") == 2


def test_focus_keeps_the_listing_and_drops_navigation_repeats_and_neighbours():
    page = "\n".join([
        "Menu Inicio Contacto", "[Entrar](x)",
        "# Depa en Aldea Zama", "$250,000 USD", "2 recámaras", "Depa en Aldea Zama", "Depa en Aldea Zama", "105 m2 de construcción",
        "## Propiedades similares", "### Otra casa", "$9,999,999 MXN", "5 recámaras",
    ])
    out = focus_listing_text(page)
    assert out.startswith("# Depa en Aldea Zama") and "Menu Inicio" not in out
    assert out.count("Depa en Aldea Zama") == 1
    assert "9,999,999" not in out and "5 recámaras" not in out
    hints = hints_from_text(out)
    assert (hints["price"], hints["bedrooms"], hints["m2_size"]) == (250_000, 2, 105)


def test_visible_text_beats_json_ld_and_a_disagreement_is_recorded():
    html = '<script type="application/ld+json">{"@type":"Product","offers":{"price":"341152","priceCurrency":"USD"},"numberOfBedrooms":3}</script>'
    text = "# Departamentos 2 recamaras en venta en Aldea Zama\n$223,684 USD\nDormitorios 2\nBaños 2\nÁrea 710.416 Sq Ft"
    hints = hints_from_text(text, html)
    assert (hints["price"], hints["bedrooms"]) == (223_684, 2)
    assert sorted(hints["conflicts"]) == ["bedrooms", "price"]
    assert hints["m2_size"] == pytest.approx(66.0, abs=0.01), "710.416 sq ft is about 66 m2, not 710 m2"
    # JSON-LD still fills what the visible text does not say, and agreement is not a conflict
    fill = hints_from_text("# Casa en venta en Tulum", '<script type="application/ld+json">{"offers":{"price":"200000","priceCurrency":"USD"}}</script>')
    assert fill["price"] == 200_000 and "conflicts" not in fill


# ---------- found by the first real backfill (2026-10-25) ----------

def test_a_stray_small_number_next_to_a_currency_word_is_not_the_price():
    assert parse_money("Casa 4 MN de calle. Precio $550,553") == (550_553, None)
    assert parse_money("Habitaciones 4 mxn") == (None, None)


def test_millions_written_with_a_capital_m():
    assert parse_money("US$1.2M") == (1_200_000, "USD")
    assert parse_money("$4.5M USD") == (4_500_000, "USD")
    assert parse_money("105 m2 de construcción") == (None, None), "m2 is an area, not millions"


def test_investment_talk_about_rent_is_not_a_rental():
    page = "# Apartamento Playa del Carmen: oportunidad perfecta de inversión para generar renta\n$1,495,000 USD\n2 recámaras"
    assert hints_from_text(page)["operation"] == "sale"
    assert detect_operation("# Casa de renta en Tulum\n$900 USD", title="Casa de renta en Tulum")[0] == "rental_long"
    assert detect_operation("Renta 2 recámaras Aldea Zama")[0] == "rental_long"


def test_the_town_comes_from_the_title_not_from_a_menu():
    page = "# Macrolotes en Venta en Corasol, Playa del Carmen\n$133,900 USD\nMenu: Tulum | Cancún | Contacto"
    assert hints_from_text(page)["town"] == "Playa del Carmen"
    # a menu that lists another town first must not win either
    assert hints_from_text("# Casa en venta, Playacar\n$400,000 USD\n" + "Tulum Tulum Tulum")["town"] == "Playa del Carmen"


def test_places_outside_the_four_markets_are_flagged_from_the_title():
    assert hints_from_text("# Terreno en Venta en Mérida Norte - Comunidad de Golf\n$238,000 USD\nTambién en Playa del Carmen")["out_of_area"] is True
    assert hints_from_text("# Lotes en Venta en Bacalar\n$50,500 USD")["out_of_area"] is True
    assert "out_of_area" not in hints_from_text("# Terreno en Venta en Tulum, cerca de Bacalar\n$90,000 USD"), "a title that names one of ours is ours"


def test_a_lot_has_no_bedrooms():
    hints = hints_from_text("# Lotes en Venta en Akumal desde $38,000 USD\nLote de 300 m2. 1 recámara disponible en el desarrollo cercano")
    assert hints["property_type"] == "land"
    assert "bedrooms" not in hints and "bathrooms" not in hints


def test_akumal_and_puerto_aventuras_belong_to_our_markets():
    assert hints_from_text("# Lotes en Venta en Akumal desde $38,000 USD")["town"] == "Tulum"
    assert hints_from_text("# Villa en Venta en Puerto Aventuras\n$900,000 USD")["town"] == "Playa del Carmen"


def test_without_a_town_at_the_top_the_text_may_name_one_town_only():
    only_one = "# Sukha - 111 - Moskito Real Estate\n" + "Descripción del condominio. " * 20 + "\nUbicado en La Veleta, Tulum.\n$11,000 MXN /mes"
    assert hints_from_text(only_one)["town"] == "Tulum"
    menu = "# Sukha - 111\n" + "Texto. " * 60 + "\nMenú: Tulum | Playa del Carmen | Cancún"
    assert "town" not in hints_from_text(menu), "a menu that lists several towns is not an address"
