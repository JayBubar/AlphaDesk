"""Composite insider-activity score from Form 4 transactions.

Score is built from open-market buys (code P) vs open-market sells (code S)
over the lookback window. Grants/option exercises/tax withholdings (codes
A, M, F, G) are excluded — they're noise, not conviction signal.

Higher = more buying. Lower = more selling. 50 = balanced or no data.
"""
import json
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

from .edgar_form4 import (
    fetch_recent_transactions, LOOKBACK_DAYS,
)
from ..scoring.version import METHODOLOGY_VERSION


_CACHE_ROOT = Path(__file__).resolve().parent.parent / "data" / "insider" / "_scores"
_RESULT_TTL_SECONDS = 6 * 3600


@dataclass
class InsiderScore:
    ticker: str
    score: float                  # 0..100
    buy_count: int
    sell_count: int
    buy_value: float | None
    sell_value: float | None
    net_value: float | None
    filing_count: int
    lookback_days: int
    methodology_version: str
    timestamp: str
    error: str | None = None


def _empty(ticker: str, error: str) -> InsiderScore:
    return InsiderScore(
        ticker=ticker, score=50.0,
        buy_count=0, sell_count=0,
        buy_value=None, sell_value=None, net_value=None,
        filing_count=0, lookback_days=LOOKBACK_DAYS,
        methodology_version=METHODOLOGY_VERSION,
        timestamp=datetime.now(timezone.utc).isoformat(),
        error=error,
    )


def _result_cache_path(ticker: str) -> Path:
    return _CACHE_ROOT / f"{ticker.upper()}.json"


def _load_cached(ticker: str) -> InsiderScore | None:
    p = _result_cache_path(ticker)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text())
    except Exception:
        return None
    if data.get("methodology_version") != METHODOLOGY_VERSION:
        return None
    # Soft TTL: skip cache if older than _RESULT_TTL_SECONDS.
    try:
        ts = datetime.fromisoformat(data["timestamp"])
        if (datetime.now(timezone.utc) - ts).total_seconds() > _RESULT_TTL_SECONDS:
            return None
    except Exception:
        return None
    return InsiderScore(**data)


def _save_cached(result: InsiderScore) -> None:
    p = _result_cache_path(result.ticker)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(asdict(result), indent=2))


def _compose_score(buy_count: int, sell_count: int,
                   buy_value: float, sell_value: float) -> float:
    """Combine transaction count + dollar value.

    - If no qualifying transactions, return 50 (neutral, no data).
    - Otherwise compute a buy ratio by count and by value, then blend
      (count-weighted so a single huge sale doesn't dominate noise).
    """
    total = buy_count + sell_count
    if total == 0:
        return 50.0

    count_ratio = buy_count / total

    total_value = buy_value + sell_value
    value_ratio = buy_value / total_value if total_value > 0 else count_ratio

    blended = 0.6 * count_ratio + 0.4 * value_ratio
    return round(max(0.0, min(100.0, blended * 100)), 1)


def compute(ticker: str, force_refresh: bool = False) -> InsiderScore:
    if not force_refresh:
        cached = _load_cached(ticker)
        if cached:
            return cached

    try:
        transactions, filings = fetch_recent_transactions(ticker)
    except Exception as e:
        return _empty(ticker, f"EDGAR fetch failed: {e}")

    # Only count open-market buys (P) and sells (S). Everything else is noise.
    buys  = [t for t in transactions if t.transaction_code == "P"]
    sells = [t for t in transactions if t.transaction_code == "S"]

    buy_value  = sum(t.value or 0 for t in buys)
    sell_value = sum(t.value or 0 for t in sells)

    score = _compose_score(len(buys), len(sells), buy_value, sell_value)

    result = InsiderScore(
        ticker=ticker.upper(),
        score=score,
        buy_count=len(buys),
        sell_count=len(sells),
        buy_value=round(buy_value, 2) if buy_value else None,
        sell_value=round(sell_value, 2) if sell_value else None,
        net_value=round(buy_value - sell_value, 2) if (buy_value or sell_value) else None,
        filing_count=len(filings),
        lookback_days=LOOKBACK_DAYS,
        methodology_version=METHODOLOGY_VERSION,
        timestamp=datetime.now(timezone.utc).isoformat(),
        error=None if (buys or sells) else "no open-market transactions in window",
    )
    _save_cached(result)
    return result
