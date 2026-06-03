"""FMP historical-data client for backtest replay.

Three endpoints:
  - /stable/historical-price-eod/full      → daily OHLCV per ticker
  - /stable/historical-key-metrics         → quarterly fundamentals
  - SPY history is fetched and cached separately so per-ticker backtests
    don't re-pay for the same benchmark series.

Local file cache mirrors the structure used elsewhere in the backend
(backend/data/...). TTLs are generous (30d) since historical fundamentals
don't change — only the most recent quarter could shift after a restatement.
"""
import json
import os
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path


FMP_BASE = "https://financialmodelingprep.com/stable"
_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "backtest"
_TTL_SECONDS = 30 * 24 * 3600  # 30 days


def _api_key() -> str | None:
    return os.environ.get("FMP_API_KEY") or None


def _cached_get(cache_path: Path, url: str) -> list | dict:
    if cache_path.exists() and (time.time() - cache_path.stat().st_mtime) < _TTL_SECONDS:
        try:
            return json.loads(cache_path.read_text())
        except Exception:
            pass  # corrupt cache — re-fetch

    req = urllib.request.Request(url, headers={"User-Agent": "AlphaDeskBacktest/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8", errors="replace"))
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(data))
    return data


def fetch_historical_prices(ticker: str, years: int = 2) -> list[dict]:
    """Return list of {date, close, high, low} sorted oldest→newest."""
    key = _api_key()
    if not key:
        raise RuntimeError("FMP_API_KEY not set")
    cache_path = _CACHE_DIR / "prices" / f"{ticker.upper()}.json"
    url = (f"{FMP_BASE}/historical-price-eod/full"
           f"?symbol={ticker.upper()}&apikey={key}")
    data = _cached_get(cache_path, url)

    # FMP returns either { historical: [...] } or a flat array depending on
    # endpoint version. Normalize either way.
    rows = data.get("historical", data) if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return []
    out = []
    for r in rows:
        date = r.get("date")
        close = r.get("close") or r.get("adjClose")
        if not date or close is None:
            continue
        out.append({
            "date": date,
            "close": float(close),
            "high": float(r.get("high") or close),
            "low": float(r.get("low") or close),
        })
    out.sort(key=lambda r: r["date"])
    # Trim to roughly `years` of history — anything older won't have a forward
    # return window inside our snapshot range anyway.
    if out:
        cutoff_year = int(out[-1]["date"][:4]) - years - 1
        out = [r for r in out if int(r["date"][:4]) > cutoff_year]
    return out


def fetch_quarterly_fundamentals(ticker: str, limit: int = 12) -> list[dict]:
    """Return quarterly key-metrics rows, newest first (FMP's native order).

    Fields used downstream: peRatio (or pe), returnOnEquity, grossProfitMargin,
    debtToEquity, freeCashFlowPerShare, dividendYield.
    """
    key = _api_key()
    if not key:
        raise RuntimeError("FMP_API_KEY not set")
    cache_path = _CACHE_DIR / "metrics" / f"{ticker.upper()}.json"
    url = (f"{FMP_BASE}/key-metrics?symbol={ticker.upper()}"
           f"&period=quarter&limit={limit}&apikey={key}")
    data = _cached_get(cache_path, url)
    if not isinstance(data, list):
        return []
    return data


# ── SPY benchmark cache ──────────────────────────────────────────────────────
# SPY history is shared across all per-ticker backtests. Fetch once per 24h.

_SPY_TTL_SECONDS = 24 * 3600
_SPY_CACHE = _CACHE_DIR / "spy_history.json"


def fetch_spy_history(years: int = 2) -> list[dict]:
    """Daily SPY closes, sorted oldest→newest."""
    key = _api_key()
    if not key:
        raise RuntimeError("FMP_API_KEY not set")

    # SPY uses a shorter TTL because it changes daily.
    if _SPY_CACHE.exists() and (time.time() - _SPY_CACHE.stat().st_mtime) < _SPY_TTL_SECONDS:
        try:
            return json.loads(_SPY_CACHE.read_text())
        except Exception:
            pass

    url = (f"{FMP_BASE}/historical-price-eod/full"
           f"?symbol=SPY&apikey={key}")
    req = urllib.request.Request(url, headers={"User-Agent": "AlphaDeskBacktest/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = json.loads(resp.read().decode("utf-8", errors="replace"))
    rows = raw.get("historical", raw) if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        return []
    out = []
    for r in rows:
        date = r.get("date")
        close = r.get("close") or r.get("adjClose")
        if not date or close is None:
            continue
        out.append({"date": date, "close": float(close)})
    out.sort(key=lambda r: r["date"])
    cutoff_year = int(out[-1]["date"][:4]) - years - 1 if out else 0
    out = [r for r in out if int(r["date"][:4]) > cutoff_year]
    _SPY_CACHE.parent.mkdir(parents=True, exist_ok=True)
    _SPY_CACHE.write_text(json.dumps(out))
    return out
