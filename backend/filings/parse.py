"""10-K section extraction.

10-K HTML formatting is wildly inconsistent across filers. We strip tags first,
then locate the canonical "Item 1A. Risk Factors" and "Item 7. Management's
Discussion..." sections by regex on the plain text. The slice ends at the
*next* item header.
"""
import re
import html as _html
from pathlib import Path


_TAG_RE = re.compile(r"<[^>]+>")
_ENTITY_RE = re.compile(r"&[a-zA-Z]+;|&#\d+;")
_WS_RE = re.compile(r"\s+")
_PAGE_NOISE_RE = re.compile(r"\bTable of Contents\b|^\s*\d+\s*$", re.MULTILINE)

# All standard 10-K item headers — used to find boundaries.
_ITEM_HEADERS = [
    "ITEM 1.",  "ITEM 1A.", "ITEM 1B.", "ITEM 1C.", "ITEM 2.", "ITEM 3.",
    "ITEM 4.",  "ITEM 5.",  "ITEM 6.",  "ITEM 7.",  "ITEM 7A.",
    "ITEM 8.",  "ITEM 9.",  "ITEM 9A.", "ITEM 9B.",
    "ITEM 10.", "ITEM 11.", "ITEM 12.", "ITEM 13.", "ITEM 14.", "ITEM 15.", "ITEM 16.",
    "PART I",   "PART II",  "PART III", "PART IV",
]


def html_to_text(html: str) -> str:
    """Strip HTML tags and entities; collapse whitespace; remove page noise."""
    # Remove script/style blocks first
    cleaned = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    # Strip remaining tags
    cleaned = _TAG_RE.sub(" ", cleaned)
    # Decode entities
    cleaned = _html.unescape(cleaned)
    # Drop page numbers / "Table of Contents" lines
    cleaned = _PAGE_NOISE_RE.sub(" ", cleaned)
    # Normalize whitespace
    cleaned = _WS_RE.sub(" ", cleaned).strip()
    return cleaned


def _header_pattern(label: str) -> str:
    """Build a regex that matches an item/part header *exactly* (no prefix overlap).

    "ITEM 1." must NOT match the "ITEM 1" inside "ITEM 1A." — so we anchor a
    word boundary right after the number/letter.
    """
    label = label.rstrip(".").strip().upper()
    parts = label.split()
    if not parts:
        return ""
    if parts[0] == "ITEM" and len(parts) >= 2:
        num = parts[1]
        return rf"\bITEM\s+{re.escape(num)}\b\s*\.?"
    if parts[0] == "PART" and len(parts) >= 2:
        return rf"\bPART\s+{re.escape(parts[1])}\b"
    return r"\b" + re.escape(label) + r"\b"


def _find_section(text: str, start_label: str) -> tuple[int, int] | None:
    upper = text.upper()
    pattern = _header_pattern(start_label)
    if not pattern:
        return None
    matches = list(re.finditer(pattern, upper))
    if not matches:
        return None
    # In real 10-Ks the section appears at least twice (ToC + body). We pick the
    # latest occurrence so we get the body, not the ToC entry.
    start = matches[-1].start()

    # Find the closest next item header
    end = len(text)
    for header in _ITEM_HEADERS:
        if header == start_label:
            continue
        h_pat = _header_pattern(header)
        if not h_pat:
            continue
        for m in re.finditer(h_pat, upper):
            if m.start() > start + 20 and m.start() < end:
                end = m.start()
                break
    return start, end


def extract_section(html_or_text: str, item_label: str) -> str:
    """Extract one item-section by label (e.g. 'ITEM 1A.', 'ITEM 7.')."""
    is_html = "<" in html_or_text[:200]
    text = html_to_text(html_or_text) if is_html else html_or_text
    span = _find_section(text, item_label.upper())
    if span is None:
        return ""
    return text[span[0]:span[1]].strip()


def extract_risk_factors(html: str) -> str:
    return extract_section(html, "ITEM 1A.")


def extract_mda(html: str) -> str:
    return extract_section(html, "ITEM 7.")


def cache_sections(cache_root: Path, cik: str, accession: str, html: str) -> dict:
    """Parse + cache sections to disk. Returns dict of section_name -> text."""
    out_dir = cache_root / cik / accession.replace("-", "")
    out_dir.mkdir(parents=True, exist_ok=True)

    sections = {
        "risk_factors": extract_risk_factors(html),
        "mda":          extract_mda(html),
    }
    for name, body in sections.items():
        (out_dir / f"{name}.txt").write_text(body, encoding="utf-8")
    return sections
