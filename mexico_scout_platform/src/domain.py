"""Mexican real-estate domain knowledge: money, areas, rooms, Quintana Roo neighbourhoods.

WHY THIS EXISTS
Listings arrive as messy Spanish/English text ("$4,500,000 MXN", "105 m²", "2 recámaras y medio baño", "Aldea Zamá").
Everything that turns that text into numbers lives here, as pure functions with no I/O, so it is unit-tested and the LLM
only has to fix what the rules cannot.

WHY NOT LET THE LLM DO ALL OF IT
A local model drops digits and swaps currencies. Rules are exact where the format is regular (prices, areas, counts);
the model is kept for the judgement calls (is this a penthouse? is "Zona Hotelera" Cancún or Tulum?).
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any

# --- text ----------------------------------------------------------------------------------------------------------


def fold(text: str | None) -> str:
    """Lower-case, accents removed, '²' -> '2': the form every matcher below works on."""
    if not text:
        return ""
    decomposed = unicodedata.normalize("NFKD", str(text))
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


# --- Quintana Roo neighbourhoods -----------------------------------------------------------------------------------
# canonical name -> (town, aliases). Aliases are folded (no accents, lower case). Extend freely: the order below is
# the match order, so the more specific name goes first ("zona hotelera tulum" before "zona hotelera").
NEIGHBORHOODS: dict[str, tuple[str, tuple[str, ...]]] = {
    # Tulum
    "Aldea Zama": ("Tulum", ("aldea zama", "aldea zamá", "aldeazama", "zama village", "boca zama", "selvazama")),
    "La Veleta": ("Tulum", ("la veleta", "veleta")),
    "Region 15": ("Tulum", ("region 15", "región 15", "r15")),
    "Tulum Beach Zone": ("Tulum", ("zona hotelera tulum", "tulum beach", "beach road", "carretera tulum-boca paila", "boca paila")),
    "Tulum Centro": ("Tulum", ("tulum centro", "centro de tulum", "downtown tulum", "tulum pueblo")),
    "Holistika": ("Tulum", ("holistika",)),
    # Playa del Carmen
    "Playacar": ("Playa del Carmen", ("playacar",)),
    "Gonzalo Guerrero": ("Playa del Carmen", ("gonzalo guerrero", "ggz")),
    "Playa Centro": ("Playa del Carmen", ("playa centro", "centro de playa", "5th avenue", "quinta avenida", "zona gotica")),
    "Luis Donaldo Colosio": ("Playa del Carmen", ("colosio", "luis donaldo colosio")),
    "Mayakoba": ("Playa del Carmen", ("mayakoba",)),
    "Playa Pacifico": ("Playa del Carmen", ("pacifico", "playa del carmen pacifico")),
    "Playa Magna": ("Playa del Carmen", ("playa magna",)),
    # Cancún
    "Zona Hotelera Cancun": ("Cancún", ("zona hotelera cancun", "zona hotelera", "hotel zone", "kukulcan")),
    "Puerto Cancun": ("Cancún", ("puerto cancun",)),
    "Cancun Centro": ("Cancún", ("cancun centro", "centro de cancun", "downtown cancun", "supermanzana", "sm 4", "sm 5")),
    "Malecon Tajamar": ("Cancún", ("malecon tajamar", "tajamar")),
    "Isla Mujeres Costa": ("Cancún", ("isla blanca", "costa mujeres")),
    "Residencial Cumbres": ("Cancún", ("cumbres", "residencial cumbres")),
    # Puerto Morelos
    "Puerto Morelos Centro": ("Puerto Morelos", ("puerto morelos centro", "centro de puerto morelos")),
    "Playa Mamitas": ("Puerto Morelos", ("mamitas",)),
}

TOWNS: dict[str, tuple[str, ...]] = {
    "Tulum": ("tulum", "akumal"),   # Akumal belongs to the municipality of Tulum
    "Playa del Carmen": ("playa del carmen", "playa del c", "solidaridad", "puerto aventuras", "playacar", "mayakoba"),
    "Cancún": ("cancun",),
    "Puerto Morelos": ("puerto morelos",),
}


# Places a Riviera Maya agency also sells in that are NOT one of our four markets. A title that names one (and none of ours) is skipped:
# the rules would otherwise find "Tulum" somewhere in the page's menu and file a Mérida lot under it.
OUT_OF_AREA = ("merida", "bacalar", "cozumel", "holbox", "isla mujeres", "chetumal", "valladolid", "yucatan", "mahahual", "costa maya",
               "campeche", "oaxaca", "ciudad de mexico", "cdmx", "san miguel de allende", "puerto vallarta", "los cabos", "cabo san lucas")


def mentions_out_of_area(text: str | None) -> bool:
    folded = fold(text)
    return any(re.search(rf"(?<![a-z]){re.escape(place)}(?![a-z])", folded) for place in OUT_OF_AREA) and detect_town(text) is None


def detect_town(text: str | None) -> str | None:
    folded = fold(text)
    for town, aliases in TOWNS.items():
        if any(a in folded for a in aliases):
            return town
    return None


def detect_neighborhood(text: str | None, town_hint: str | None = None) -> tuple[str | None, str | None]:
    """Return (canonical neighbourhood, town) found in free text, or (None, detected town)."""
    folded = fold(text)
    for canonical, (town, aliases) in NEIGHBORHOODS.items():
        if town_hint and fold(town_hint) != fold(town):
            continue
        for alias in aliases:
            if re.search(rf"(?<![a-z0-9]){re.escape(fold(alias))}(?![a-z0-9])", folded):
                return canonical, town
    return None, town_hint or detect_town(text)


def canonical_neighborhood(name: str | None, town_hint: str | None = None) -> tuple[str | None, str | None]:
    """Normalise a neighbourhood the agent or a portal wrote. Unknown names are kept (title-cased), not dropped."""
    if not name or not str(name).strip():
        return None, town_hint
    found, town = detect_neighborhood(name, town_hint)
    if found:
        return found, town
    return str(name).strip().title(), town_hint or detect_town(name)


# --- money ---------------------------------------------------------------------------------------------------------

_CURRENCY_WORDS: dict[str, str] = {
    "us$": "USD", "us": "USD", "usd": "USD", "u$s": "USD", "dolares": "USD", "dolar": "USD", "dlls": "USD", "dls": "USD",
    "mxn": "MXN", "mxp": "MXN", "mn": "MXN", "pesos": "MXN", "peso": "MXN", "mdp": "MXN",
    "eur": "EUR", "euros": "EUR", "cad": "CAD",
}
_MULTIPLIERS: dict[str, float] = {
    "millones": 1e6, "millon": 1e6, "mdp": 1e6, "mdd": 1e6, "mm": 1e6, "mil": 1e3, "k": 1e3, "m": 1e6,
}
_NUM = r"\d{1,3}(?:[, ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?"
_MONEY_RE = re.compile(
    rf"(?P<cur1>(?:usd|mxn|mxp|mn|eur|cad|us|u\$s)\s*\$?|\$)?\s*(?P<num>{_NUM})\s*"
    rf"(?P<mult>millones|millon|mdp|mdd|mm\b|mil\b|k\b|m(?![a-z0-9]))?\s*(?:de\s+)?(?P<cur2>usd|mxn|mxp|mn\b|eur|cad|dolares|dlls|dls|pesos|mdp|mdd)?",
    re.IGNORECASE,
)


def parse_money(text: str | None) -> tuple[float | None, str | None]:
    """First price in `text` as (amount, currency). Currency is None when only a bare '$' was written.

    '$4,500,000 MXN' -> (4500000, 'MXN'); 'USD 245,000' -> (245000, 'USD'); '$3.5 MDP' -> (3500000, 'MXN');
    '$250 mil USD' -> (250000, 'USD'); '$4,500,000' -> (4500000, None): the caller decides, see infer_currency().
    A number with no currency marker at all ('105 m2', '2 recamaras') is never a price.
    """
    folded = fold(text)
    for match in _MONEY_RE.finditer(folded):
        cur1, cur2, mult = match.group("cur1"), match.group("cur2"), match.group("mult")
        if not (cur1 or cur2 or (mult in ("mdp", "mdd"))):
            continue
        raw = match.group("num").replace(",", "").replace(" ", "")
        try:
            amount = float(raw)
        except ValueError:
            continue
        if mult:
            amount *= _MULTIPLIERS.get(mult.lower().strip(), 1.0)
        cur1_word = re.sub(r"[\s$]", "", cur1 or "") or None
        marker = (cur2 or cur1_word or mult or "").lower().strip()
        currency = _CURRENCY_WORDS.get(marker)
        # A "4" next to a currency word ("4 MN", a room count in a line that also says MXN) is never a price: the first real
        # amount on a page is often preceded by such noise. 20 is below any nightly rate, rent or sale price in this market.
        if amount >= 20:
            return amount, currency
    return None, None


def infer_currency(amount: float, price_period: str, operation: str) -> str:
    """Guess MXN vs USD for a bare '$'. Callers must flag the result as an assumption (currency_assumed)."""
    if price_period == "night":
        return "MXN" if amount >= 2500 else "USD"
    if price_period == "month" or operation.startswith("rental"):
        return "MXN" if amount >= 15000 else "USD"
    return "MXN" if amount >= 1_500_000 else "USD"


def to_usd(amount: float | None, currency: str | None, usd_mxn: float) -> float | None:
    """Convert to USD. EUR/CAD are not supported (no paid FX feed); they return None so nothing is silently wrong."""
    if amount is None or currency is None:
        return None
    if currency == "USD":
        return round(amount, 2)
    if currency == "MXN":
        return round(amount / usd_mxn, 2)
    return None


# --- sizes and rooms -----------------------------------------------------------------------------------------------

_AREA_NUM = r"(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
_UNIT = r"\s*(?:m2|mt2|mts2|mts|metros cuadrados|metros2|sqm|m\.2)\b"


def _number(raw: str) -> float:
    return float(raw.replace(",", ""))


def parse_areas(text: str | None) -> tuple[float | None, float | None]:
    """(built m2, land m2). A bare '105 m2' with no label counts as built area."""
    folded = fold(text)
    built = land = None
    labelled_built = re.search(rf"(?:construccion|construidos?|const\.?|built|habitable|interior)[^0-9]{{0,25}}{_AREA_NUM}{_UNIT}", folded)
    # "<number> m2 de construccion": the label must follow on the SAME line. "Terreno 1,081 m2\nConstruccion 420 m2" is two facts, and a
    # \s* that crossed the line break read the plot's 1,081 as built area.
    labelled_built_after = re.search(rf"{_AREA_NUM}{_UNIT}[ \t]*(?:de[ \t]+)?(?:construccion|construidos?|built)", folded)
    labelled_land = re.search(rf"(?:terreno|lote|land|superficie de terreno)[^0-9]{{0,25}}{_AREA_NUM}{_UNIT}", folded)
    labelled_land_after = re.search(rf"{_AREA_NUM}{_UNIT}[ \t]*(?:de[ \t]+)?(?:terreno|lote|land)", folded)
    # "105 m2 de construccion" is checked before "construccion: 105 m2": the second form can run on into the next number.
    for m in (labelled_built_after, labelled_built):
        if m:
            built = _number(m.group(1)); break
    for m in (labelled_land_after, labelled_land):
        if m:
            land = _number(m.group(1)); break
    if built is None:
        for m in re.finditer(rf"{_AREA_NUM}{_UNIT}", folded):
            value = _number(m.group(1))
            if land is None or value != land:
                built = value
                break
    if built is None:
        # Some portals publish square feet ("Area 710.416 Sq Ft"). Convert, never mistake it for m2.
        m = re.search(rf"{_AREA_NUM}\s*(?:sq\.? ?ft|sqft|ft2|square feet|pies cuadrados|pies2)\b", folded)
        if m:
            built = round(_number(m.group(1)) * 0.092903, 2)
    return built, land


_NUMBER_WORDS = {"un": 1, "uno": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6, "siete": 7, "ocho": 8,
                 "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}
_NUMBER_WORD_RE = re.compile(r"\b(" + "|".join(_NUMBER_WORDS) + r")\b(?=\s*(?:-\s*)?(?:recamaras?|habitaciones|habitacion|dormitorios?|bedrooms?|banos?|bathrooms?))")


def _digits(folded: str) -> str:
    """'dos habitaciones' -> '2 habitaciones', so one set of digit patterns reads both."""
    return _NUMBER_WORD_RE.sub(lambda m: str(_NUMBER_WORDS[m.group(1)]), folded)


def parse_bedrooms(text: str | None) -> int | None:
    folded = _digits(fold(text))
    if re.search(r"\b(?:estudio|studio|loft)\b", folded) and not re.search(r"\d\s*(?:recamara|habitacion|bedroom)", folded):
        return 0
    patterns = (
        r"(\d{1,2})\s*-?\s*(?:recamaras?|recs?\b|habitaciones|habitacion|dormitorios?|bedrooms?|beds?\b|br\b|bd\b|cuartos|hab\b)",
        r"(?:recamaras?|habitaciones|dormitorios?|bedrooms?|cuartos)\s*[:\-]?\s*(\d{1,2})\b",
    )
    for pattern in patterns:
        m = re.search(pattern, folded)
        if m:
            value = int(m.group(1))
            if 0 <= value <= 20:
                return value
    return None


def parse_bathrooms(text: str | None) -> float | None:
    folded = _digits(fold(text))
    m = re.search(r"(\d{1,2}(?:\.\d)?)\s*(?:banos?|bathrooms?|baths?\b)(?:\s*y\s*medio)?", folded)
    if m:
        value = float(m.group(1))
        if re.search(r"banos?\s*y\s*medio", folded[m.start():m.end() + 12]):
            value += 0.5
        return value if 0 < value <= 20 else None
    m = re.search(r"(?:banos?|bathrooms?)\s*[:\-]?\s*(\d{1,2}(?:\.\d)?)\b", folded)
    if m:
        value = float(m.group(1))
        return value if 0 < value <= 20 else None
    if re.search(r"\bmedio bano\b", folded):
        return 0.5
    return None


# --- listing kind ---------------------------------------------------------------------------------------------------


def detect_property_type(text: str | None) -> str | None:
    folded = fold(text)
    for label, words in (
        ("penthouse", ("penthouse", "ph ", "atico")),
        ("land", ("terreno", "lote", "land for sale", "lot ")),
        ("house", ("casa", "villa", "house", "townhouse")),
        ("apartment", ("departamento", "depa ", "condominio", "condo", "apartamento", "apartment", "estudio", "loft")),
        ("commercial", ("local comercial", "oficina", "bodega", "commercial")),
    ):
        if any(w in folded for w in words):
            return label
    return None


_SHORT_PERIOD = re.compile(r"por noche|/\s*noche|per night|nightly|/\s*night")
_LONG_PERIOD = re.compile(r"/\s*mes\b|al mes|por mes|per month|/\s*month|mensuales?\b|monthly")
_SHORT_WORDS = re.compile(r"renta vacacional|vacation rental|vacacional|airbnb|renta corta|short[- ]term")
_RENT_WORDS = re.compile(r"en renta|se renta|de renta|for rent|alquiler|\brental\b|^\s*renta\b|^\s*rent\b")
_SALE_WORDS = re.compile(r"en venta|for sale|se vende|de venta|\bventa\b|preventa|pre-venta")


def detect_operation(text: str | None, title: str | None = None) -> tuple[str, str]:
    """(operation, price_period), from the strongest evidence first.

    1. The unit written right after the first price ("$150 USD por noche", "$1,800 /mes"): the least ambiguous signal.
       (A bare "mensual" elsewhere is not used: sales mention "mantenimiento mensual" all the time.)
    2. The title and the first lines: "en venta", "renta vacacional", "for rent".
    3. The whole text, where "venta" beats the bare word "renta" (navigation bars list both).
    """
    folded = fold(text)
    for match in _MONEY_RE.finditer(folded):
        if match.group("cur1") or match.group("cur2"):
            after = folded[match.end(): match.end() + 28]
            if _SHORT_PERIOD.search(after):
                return "rental_short", "night"
            if _LONG_PERIOD.search(after):
                return "rental_long", "month"
            break
    # The title is the page's own statement of what it offers; navigation bars in the body list "Venta" and "Renta" both.
    ftitle = fold(title)
    if _SHORT_WORDS.search(ftitle):
        return "rental_short", "night"
    if _SALE_WORDS.search(ftitle) and not _RENT_WORDS.search(ftitle):
        return "sale", "total"
    if _RENT_WORDS.search(ftitle) and not _SALE_WORDS.search(ftitle):
        return "rental_long", "month"
    head = ftitle + " " + folded[:200]
    if _SHORT_WORDS.search(head):
        return "rental_short", "night"
    sale_in_head, rent_in_head = _SALE_WORDS.search(head), _RENT_WORDS.search(head)
    if rent_in_head and not sale_in_head:
        return "rental_long", "month"
    if sale_in_head:
        return "sale", "total"
    if _SHORT_WORDS.search(folded):
        return "rental_short", "night"
    if _RENT_WORDS.search(folded) and not _SALE_WORDS.search(folded):
        return "rental_long", "month"
    return "sale", "total"


# --- reading a real portal page -------------------------------------------------------------------------------------

_RELATED_RE = re.compile(
    r"^\s*#{1,6}\s*(?:propiedades similares|propiedades relacionadas|inmuebles similares|similar (?:properties|listings)|related (?:properties|listings)|"
    r"you may also like|te puede interesar|tambien te (?:puede|pueden)|otras propiedades|more properties|ver mas propiedades)",
    re.IGNORECASE,
)


def focus_listing_text(markdown: str | None, max_chars: int = 20000) -> str:
    """The part of a portal page that describes THE listing.

    Real pages repeat their title dozens of times, start with navigation, and end with cards of other listings that
    carry their own prices and room counts. Rules that read "the first price" would happily read a neighbour's. So:
    keep each distinct line once, start at the first heading, and stop at a "similar properties" section.
    """
    lines = str(markdown or "").splitlines()
    for i, line in enumerate(lines):
        if re.match(r"^\s*#\s+\S", line):
            lines = lines[i:]
            break
    seen: set[str] = set()
    kept: list[str] = []
    for line in lines:
        if _RELATED_RE.match(fold(line)):
            break
        key = re.sub(r"\s+", " ", re.sub(r"^[\s#*\-_>]+", "", fold(line))).strip()
        if not key:
            kept.append("")
            continue
        if key in seen:
            continue
        seen.add(key)
        kept.append(line.rstrip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()[:max_chars]


# --- structured data in the page -------------------------------------------------------------------------------------

_JSONLD_RE = re.compile(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", re.DOTALL | re.IGNORECASE)


def _walk(node: Any):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk(item)


def jsonld_hints(html: str | None) -> dict[str, Any]:
    """Facts published as schema.org JSON-LD (many portals do): price, currency, name, rooms, floor size, locality."""
    hints: dict[str, Any] = {}
    for block in _JSONLD_RE.findall(html or ""):
        try:
            data = json.loads(block.strip())
        except (ValueError, TypeError):
            continue
        for node in _walk(data):
            offers = node.get("offers")
            for offer in _walk(offers) if offers else ():
                if "price" in offer and "price" not in hints:
                    try:
                        hints["price"] = float(str(offer["price"]).replace(",", ""))
                        hints["currency"] = _CURRENCY_WORDS.get(fold(str(offer.get("priceCurrency", ""))), None)
                    except ValueError:
                        pass
            if node.get("name") and "title" not in hints and isinstance(node["name"], str):
                hints["title"] = node["name"].strip()
            rooms = node.get("numberOfBedrooms") or node.get("numberOfRooms")
            if rooms and "bedrooms" not in hints:
                try: hints["bedrooms"] = int(float(rooms))
                except (ValueError, TypeError): pass
            baths = node.get("numberOfBathroomsTotal") or node.get("numberOfBathrooms")
            if baths and "bathrooms" not in hints:
                try: hints["bathrooms"] = float(baths)
                except (ValueError, TypeError): pass
            floor = node.get("floorSize")
            if isinstance(floor, dict) and floor.get("value") and "m2_size" not in hints:
                try: hints["m2_size"] = float(str(floor["value"]).replace(",", ""))
                except ValueError: pass
            address = node.get("address")
            if isinstance(address, dict):
                locality = " ".join(str(address.get(k, "")) for k in ("streetAddress", "addressLocality", "addressRegion")).strip()
                if locality and "location" not in hints:
                    hints["location"] = locality
    return hints


def hints_from_text(text: str | None, html: str | None = None, title: str | None = None) -> dict[str, Any]:
    """Everything the rules can read from a listing page.

    `text` should be the UNPRUNED, focused page text (content filters drop short lines such as "2 recámaras", and
    related-listing cards carry other properties' numbers). The VISIBLE text wins over the page's JSON-LD: on a real
    portal (bestcaribbeanproperty.com) the structured data said 3 bedrooms and US$341k while the page showed 2 bedrooms and
    $223,684. JSON-LD fills what the text does not say, and a disagreement is listed in `conflicts` for the agent to look at.
    """
    structured = jsonld_hints(html)
    hints: dict[str, Any] = {}
    body = text or ""
    heading = re.search(r"^\s*#\s+(\S.*)$", body, re.MULTILINE)   # the page's own H1, when no <title> was passed
    if title:
        hints["title"] = title
    elif "title" in structured:
        hints["title"] = structured["title"]
    elif heading:
        hints["title"] = heading.group(1).strip()
    operation, period = detect_operation(body[:1500], str(hints.get("title", "")))
    amount, currency = parse_money(body[:2500])
    built, land = parse_areas(body)
    from_text: dict[str, Any] = {"price": amount, "currency": currency, "m2_size": built, "bedrooms": parse_bedrooms(body),
                                 "bathrooms": parse_bathrooms(body)}
    conflicts: list[str] = []
    # The title is the listing's own one-line summary ("Casa 7BR en Venta..."); a number found deeper in the text (a floor plan, a
    # neighbouring unit) is not. In the first real backfill 14 of 165 titles that state a bedroom count disagreed with what was stored.
    title_bedrooms = parse_bedrooms(str(hints.get("title", "")))
    if title_bedrooms is not None:
        if from_text["bedrooms"] not in (None, title_bedrooms):
            conflicts.append("bedrooms")
        from_text["bedrooms"] = title_bedrooms
    for key in ("price", "currency", "m2_size", "bedrooms", "bathrooms"):
        seen_text, seen_ld = from_text.get(key), structured.get(key)
        if seen_text is not None:
            hints[key] = seen_text
            if seen_ld is not None and seen_ld != seen_text and not (isinstance(seen_ld, (int, float)) and abs(seen_ld - seen_text) <= 0.05 * abs(seen_text)):
                conflicts.append(key)
        elif seen_ld is not None:
            hints[key] = seen_ld
    if structured.get("location"):
        hints["location"] = structured["location"]
    if conflicts:
        hints["conflicts"] = conflicts
    if land:
        hints["land_m2"] = land
    # The title says what the listing is. A house page that prints "Terreno 1,081 m2" (its plot) is still a house; reading title and body
    # together let that one word turn it into land, which then lost its bedrooms.
    prop = detect_property_type(str(hints.get("title", ""))) or detect_property_type(body[:800])
    if prop:
        hints["property_type"] = prop
    hints["operation"], hints["price_period"] = operation, period
    # Where it is: the title first, then the page's own address, then only the top of the text. Never the whole page: a menu that lists
    # "Tulum" would otherwise beat a title that says "Playa del Carmen" (it did, in the first real backfill).
    title_text = str(hints.get("title", ""))
    if mentions_out_of_area(title_text):
        hints["out_of_area"] = True
    neighborhood = town = None
    for place in (title_text, str(hints.get("location", "")), body[:300]):
        neighborhood, town = detect_neighborhood(place)
        if neighborhood or town:
            break
    if not town:
        # Nothing at the top of the page. Use the rest only when it names exactly ONE of our towns: a menu that lists several is not an address.
        named = {t for t in TOWNS if any(a in fold(body[:2000]) for a in TOWNS[t])}
        if len(named) == 1:
            neighborhood, town = detect_neighborhood(body[:2000], next(iter(named)))
    if neighborhood:
        hints["neighborhood"] = neighborhood
    if town:
        hints["town"] = town
    # Land has no bedrooms: any "1 recamara" on a lot's page is about something else (a nearby plan, a sales pitch).
    if hints.get("property_type") == "land":
        hints.pop("bedrooms", None)
        hints.pop("bathrooms", None)
    return {k: v for k, v in hints.items() if v is not None}
