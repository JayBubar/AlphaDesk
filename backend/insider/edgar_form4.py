"""SEC EDGAR Form 4 (insider transactions) client.

Reuses the throttled HTTP client, CIK lookup, and submissions cache from
backend/filings/edgar.py. Form 4s are filed within 2 business days of an
insider transaction — much higher frequency than 10-Ks.
"""
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..filings.edgar import (
    _http_get, _submissions, cik_for_ticker, EDGAR_BASE,
)

_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "insider"
_FORM4_TTL_SECONDS = 6 * 3600  # 6h — Form 4s come in fast, recheck frequently

# Window we score over.
LOOKBACK_DAYS = 90
MAX_FORM4_FETCH = 20  # hard cap to keep request volume bounded


@dataclass
class Form4Meta:
    cik: str
    accession: str
    filing_date: str
    primary_doc: str
    url: str  # full URL to the primary XML


@dataclass
class Transaction:
    transaction_date: str
    transaction_code: str         # P = open-market buy, S = open-market sell, etc.
    acquired_disposed: str        # A or D
    shares: float
    price_per_share: float | None
    value: float | None           # shares * price, when both known


def _list_recent_form4s(cik: str) -> list[Form4Meta]:
    """Return up to MAX_FORM4_FETCH most recent Form 4 filings for a CIK."""
    submissions = _submissions(cik)
    recent = submissions.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    primaries = recent.get("primaryDocument", [])
    dates = recent.get("filingDate", [])

    cutoff = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).date().isoformat()

    out: list[Form4Meta] = []
    for i, form in enumerate(forms):
        if form != "4":
            continue
        filing_date = dates[i]
        if filing_date < cutoff:
            break  # submissions.json is sorted newest-first; we can stop
        acc = accessions[i]
        acc_no_dash = acc.replace("-", "")
        primary = primaries[i]
        url = f"{EDGAR_BASE}/Archives/edgar/data/{int(cik)}/{acc_no_dash}/{primary}"
        out.append(Form4Meta(cik=cik, accession=acc, filing_date=filing_date,
                             primary_doc=primary, url=url))
        if len(out) >= MAX_FORM4_FETCH:
            break
    return out


# ── XML parsing ───────────────────────────────────────────────────────────────
# Form 4 XMLs have a stable schema. We pull non-derivative transactions only —
# derivative table (options) is signal but noisier; skip for v1.

_NON_DERIV_RE = re.compile(
    r"<nonDerivativeTransaction>(.*?)</nonDerivativeTransaction>", re.DOTALL)
_VALUE_RE = lambda tag: re.compile(
    rf"<{tag}>\s*<value>([^<]+)</value>", re.DOTALL)

_TRANS_DATE_RE = _VALUE_RE("transactionDate")
_TRANS_CODE_RE = re.compile(r"<transactionCode>\s*([A-Z])\s*</transactionCode>")
_TRANS_AD_RE   = _VALUE_RE("transactionAcquiredDisposedCode")
_TRANS_SHARES_RE = _VALUE_RE("transactionShares")
_TRANS_PRICE_RE = _VALUE_RE("transactionPricePerShare")


def _parse_transactions(xml: str) -> list[Transaction]:
    out: list[Transaction] = []
    for block in _NON_DERIV_RE.findall(xml):
        date_m   = _TRANS_DATE_RE.search(block)
        code_m   = _TRANS_CODE_RE.search(block)
        ad_m     = _TRANS_AD_RE.search(block)
        shares_m = _TRANS_SHARES_RE.search(block)
        price_m  = _TRANS_PRICE_RE.search(block)
        if not (date_m and code_m and ad_m and shares_m):
            continue
        try:
            shares = float(shares_m.group(1))
        except ValueError:
            continue
        price = None
        if price_m:
            try: price = float(price_m.group(1))
            except ValueError: price = None
        value = shares * price if price is not None else None
        out.append(Transaction(
            transaction_date=date_m.group(1).strip(),
            transaction_code=code_m.group(1).strip(),
            acquired_disposed=ad_m.group(1).strip(),
            shares=shares,
            price_per_share=price,
            value=value,
        ))
    return out


def _cached_xml_path(meta: Form4Meta) -> Path:
    return _CACHE_DIR / meta.cik / meta.accession.replace("-", "") / "form4.xml"


def _fetch_form4_xml(meta: Form4Meta) -> str:
    cache = _cached_xml_path(meta)
    if cache.exists():
        return cache.read_text(encoding="utf-8", errors="replace")
    data = _http_get(meta.url)
    text = data.decode("utf-8", errors="replace")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(text, encoding="utf-8")
    return text


def fetch_recent_transactions(ticker: str) -> tuple[list[Transaction], list[Form4Meta]]:
    """Return (transactions, filings) over the last LOOKBACK_DAYS.

    Returns ([], []) if the ticker is unknown to EDGAR.
    """
    cik = cik_for_ticker(ticker)
    if not cik:
        return [], []
    filings = _list_recent_form4s(cik)
    txs: list[Transaction] = []
    for f in filings:
        try:
            xml = _fetch_form4_xml(f)
        except Exception:
            continue
        txs.extend(_parse_transactions(xml))
    return txs, filings
