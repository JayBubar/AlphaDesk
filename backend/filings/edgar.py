"""SEC EDGAR client.

EDGAR rate limits: 10 req/sec, mandatory User-Agent. We batch fetches with a
hand-rolled token-bucket throttle and cache aggressively (10-Ks are annual).
"""
import json
import time
import threading
from dataclasses import dataclass
from pathlib import Path
import urllib.request
import urllib.error


SEC_USER_AGENT = "AlphaDesk research@alphadesk.app"
EDGAR_BASE = "https://www.sec.gov"
EDGAR_DATA = "https://data.sec.gov"

_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "filings"
_CIK_FILE = _CACHE_DIR / "_company_tickers.json"
_CIK_TTL_SECONDS = 30 * 24 * 3600  # refresh monthly


@dataclass
class FilingMeta:
    cik: str             # zero-padded 10-digit
    accession: str       # e.g. 0000320193-24-000123
    primary_doc: str     # filename of the primary 10-K document
    filing_date: str     # YYYY-MM-DD
    fiscal_year_end: str # YYYY-MM-DD
    url: str             # full URL to the primary document


# ── Rate limiting ──────────────────────────────────────────────────────────
_lock = threading.Lock()
_last_call = 0.0
_MIN_INTERVAL = 0.11  # ~9 req/sec, comfortably under SEC's 10/sec limit


def _throttle():
    global _last_call
    with _lock:
        now = time.time()
        wait = _MIN_INTERVAL - (now - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()


def _http_get(url: str, timeout: int = 20) -> bytes:
    _throttle()
    req = urllib.request.Request(url, headers={
        "User-Agent": SEC_USER_AGENT,
        "Accept-Encoding": "gzip, deflate",
        "Host": _host_for(url),
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            import gzip
            data = gzip.decompress(data)
        elif resp.headers.get("Content-Encoding") == "deflate":
            import zlib
            data = zlib.decompress(data)
        return data


def _host_for(url: str) -> str:
    if url.startswith(EDGAR_DATA):
        return "data.sec.gov"
    return "www.sec.gov"


# ── CIK lookup ─────────────────────────────────────────────────────────────

def _load_cik_table() -> dict:
    """Return ticker -> 10-digit CIK mapping. Cached locally and refreshed monthly."""
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if _CIK_FILE.exists() and (time.time() - _CIK_FILE.stat().st_mtime) < _CIK_TTL_SECONDS:
        raw = json.loads(_CIK_FILE.read_text())
    else:
        data = _http_get(f"{EDGAR_BASE}/files/company_tickers.json")
        raw = json.loads(data.decode())
        _CIK_FILE.write_text(json.dumps(raw))

    table = {}
    for entry in raw.values():
        cik = str(entry["cik_str"]).zfill(10)
        table[entry["ticker"].upper()] = cik
    return table


def cik_for_ticker(ticker: str) -> str | None:
    return _load_cik_table().get(ticker.upper())


# ── Filing index ───────────────────────────────────────────────────────────

def _submissions(cik: str) -> dict:
    cache = _CACHE_DIR / cik / "submissions.json"
    if cache.exists() and (time.time() - cache.stat().st_mtime) < 24 * 3600:
        return json.loads(cache.read_text())
    data = _http_get(f"{EDGAR_DATA}/submissions/CIK{cik}.json")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(data.decode())
    return json.loads(data.decode())


def fetch_two_latest_10k(ticker: str) -> list[FilingMeta]:
    """Return the two most recent 10-K filings for `ticker` (newest first).

    Returns [] if the ticker is unknown or has fewer than one 10-K on file.
    """
    cik = cik_for_ticker(ticker)
    if not cik:
        return []
    submissions = _submissions(cik)
    recent = submissions.get("filings", {}).get("recent", {})
    if not recent:
        return []

    forms = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    primaries = recent.get("primaryDocument", [])
    filing_dates = recent.get("filingDate", [])
    period_dates = recent.get("reportDate", [])

    out: list[FilingMeta] = []
    for i, form in enumerate(forms):
        if form != "10-K":
            continue
        acc = accessions[i]
        acc_no_dash = acc.replace("-", "")
        primary = primaries[i]
        url = f"{EDGAR_BASE}/Archives/edgar/data/{int(cik)}/{acc_no_dash}/{primary}"
        out.append(FilingMeta(
            cik=cik,
            accession=acc,
            primary_doc=primary,
            filing_date=filing_dates[i],
            fiscal_year_end=period_dates[i] if i < len(period_dates) else "",
            url=url,
        ))
        if len(out) >= 2:
            break
    return out


# ── Document fetch + cache ─────────────────────────────────────────────────

def fetch_filing_html(meta: FilingMeta) -> str:
    """Download and cache the raw HTML of a 10-K filing."""
    cache = _CACHE_DIR / meta.cik / meta.accession.replace("-", "") / "primary.html"
    if cache.exists():
        return cache.read_text(encoding="utf-8", errors="replace")
    data = _http_get(meta.url)
    text = data.decode("utf-8", errors="replace")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(text, encoding="utf-8")
    return text
