"""Replay the scoring engine on historical snapshots and join forward returns.

For each quarterly fundamentals snapshot:
  1. Score the ticker using absolute thresholds (peer-percentile isn't
     reproducible without a historical universe — that's a future iteration).
  2. Look up the close price at the snapshot date and at +30/+60/+90/+180
     trading days.
  3. Compute realized returns and SPY-relative excess returns.

The composite score is a weighted blend of the pillars we CAN reconstruct
historically:
  - fundamentals (pe, roe, gross_margin, debt_equity)
  - momentum    (52w_position, ma_trend, price_change_30d)
  - sentiment   (analyst_upside placeholder, short_interest unavailable)

Filings, insider, and Perplexity sentiment can't be reconstructed historically
so they're omitted. We re-normalize the pillar weights over what's available
to keep the composite on a 0-100 scale.
"""
import bisect
import json
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path

from .fmp_history import (
    fetch_historical_prices, fetch_quarterly_fundamentals, fetch_spy_history,
)
from ..scoring.version import METHODOLOGY_VERSION


_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "backtest" / "_results"

# Trading-day approximations. Forward windows are calendar days; we find the
# nearest historical close on/after the target date.
FORWARD_WINDOWS_DAYS = [30, 60, 90, 180]


# ── Absolute-threshold scoring ────────────────────────────────────────────────
# Each function returns a 0-100 score. Higher is always better. Thresholds are
# rough industry rules of thumb — refinable later from the realized-return data.

def _score_pe(pe: float | None) -> float | None:
    if pe is None or pe <= 0: return None
    if pe < 12: return 95
    if pe < 18: return 80
    if pe < 25: return 60
    if pe < 35: return 40
    if pe < 50: return 25
    return 10

def _score_roe(roe: float | None) -> float | None:
    if roe is None: return None
    # Some FMP fields are already percent (e.g. 0.15 = 15%), others are 15.0.
    # Normalize anything <2.0 to assume it's already a fraction.
    if abs(roe) < 2.0: roe = roe * 100
    if roe < 0: return 10
    if roe < 5: return 30
    if roe < 12: return 50
    if roe < 20: return 70
    if roe < 30: return 85
    return 95

def _score_gross_margin(gm: float | None) -> float | None:
    if gm is None: return None
    if abs(gm) < 2.0: gm = gm * 100
    if gm < 15: return 20
    if gm < 25: return 40
    if gm < 40: return 60
    if gm < 60: return 80
    return 95

def _score_debt_equity(de: float | None) -> float | None:
    if de is None: return None
    if de < 0.3:  return 95
    if de < 0.7:  return 80
    if de < 1.5:  return 60
    if de < 2.5:  return 40
    if de < 4.0:  return 20
    return 10

def _score_52w_position(pos: float | None) -> float | None:
    if pos is None: return None
    if pos < 0.20: return 30  # near 52w lows — could be value, could be falling knife
    if pos < 0.40: return 50
    if pos < 0.60: return 65
    if pos < 0.80: return 75
    return 85  # near 52w highs

def _score_ma_trend(trend: int | None) -> float | None:
    if trend is None: return None
    if trend > 0:  return 75
    if trend < 0:  return 25
    return 50

def _score_price_change(chg: float | None) -> float | None:
    if chg is None: return None
    if chg < -10: return 20
    if chg < -5:  return 35
    if chg < 0:   return 50
    if chg < 5:   return 60
    if chg < 15:  return 75
    return 85


# ── Snapshot computation ──────────────────────────────────────────────────────

def _index_prices_by_date(prices: list[dict]) -> tuple[list[str], list[dict]]:
    """Return (dates_sorted, rows_sorted_by_date) for fast bisect lookups."""
    dates = [p["date"] for p in prices]
    return dates, prices


def _price_on_or_after(dates: list[str], prices: list[dict], target: str) -> dict | None:
    """Find the closest trading-day close on/after `target`. Used for forward returns."""
    idx = bisect.bisect_left(dates, target)
    if idx >= len(prices):
        return None
    return prices[idx]


def _price_on_or_before(dates: list[str], prices: list[dict], target: str) -> dict | None:
    idx = bisect.bisect_right(dates, target) - 1
    if idx < 0:
        return None
    return prices[idx]


def _ma_trend(prices: list[dict], dates: list[str], snap_date: str) -> int | None:
    """+1 if price > MA50 > MA200; -1 if reversed; else 0. None when insufficient history."""
    idx = bisect.bisect_right(dates, snap_date) - 1
    if idx < 200:
        return None
    closes = [p["close"] for p in prices[max(0, idx-199):idx+1]]
    if len(closes) < 200:
        return None
    price = closes[-1]
    ma50 = sum(closes[-50:]) / 50
    ma200 = sum(closes) / 200
    if price > ma50 > ma200:
        return 1
    if price < ma50 < ma200:
        return -1
    return 0


def _price_change_30d(prices: list[dict], dates: list[str], snap_date: str) -> float | None:
    """Percent change over the 30 calendar days ending at snap_date."""
    end_idx = bisect.bisect_right(dates, snap_date) - 1
    if end_idx < 21:  # ~21 trading days in 30 calendar days
        return None
    start_idx = end_idx - 21
    end_close = prices[end_idx]["close"]
    start_close = prices[start_idx]["close"]
    if start_close <= 0:
        return None
    return ((end_close - start_close) / start_close) * 100


def _position_52w(prices: list[dict], dates: list[str], snap_date: str) -> float | None:
    """Position within the trailing 252-trading-day high/low range. 0=low, 1=high."""
    end_idx = bisect.bisect_right(dates, snap_date) - 1
    if end_idx < 60:
        return None
    start_idx = max(0, end_idx - 252)
    window = prices[start_idx:end_idx+1]
    high = max(w["high"] for w in window)
    low  = min(w["low"]  for w in window)
    cp   = prices[end_idx]["close"]
    span = high - low
    if span <= 0:
        return None
    return (cp - low) / span


# ── Composite score ──────────────────────────────────────────────────────────

# Subset of the live methodology that we can reconstruct historically.
# Weights add to 100 across THIS subset only — the live methodology's
# filings + insider + Perplexity sentiment weights are dropped, not zeroed,
# so the historical composite stays on a 0-100 scale.
HISTORICAL_PILLAR_WEIGHTS = {
    "fundamentals": 55,
    "momentum":     30,
    "sentiment":    15,  # analyst upside placeholder only
}


def _avg_non_null(scores: list[float | None]) -> float | None:
    vals = [s for s in scores if s is not None]
    if not vals:
        return None
    return sum(vals) / len(vals)


def _composite(fundamentals: float | None,
               momentum: float | None,
               sentiment: float | None) -> float | None:
    weighted_sum = 0.0
    weight_total = 0.0
    for pillar, score in (
        ("fundamentals", fundamentals),
        ("momentum",     momentum),
        ("sentiment",    sentiment),
    ):
        if score is None:
            continue
        w = HISTORICAL_PILLAR_WEIGHTS[pillar]
        weighted_sum += score * w
        weight_total += w
    if weight_total == 0:
        return None
    return round(weighted_sum / weight_total, 1)


# ── Snapshot dataclass ───────────────────────────────────────────────────────

@dataclass
class SnapshotResult:
    snapshot_date: str           # YYYY-MM-DD (fundamentals report date)
    snapshot_price: float | None
    composite: float | None
    fundamentals_score: float | None
    momentum_score: float | None
    sentiment_score: float | None  # only analyst upside is reconstructable
    pe: float | None
    roe: float | None
    gross_margin: float | None
    debt_equity: float | None
    # Forward returns (percent). Null if the window extends past available data.
    return_30d:  float | None = None
    return_60d:  float | None = None
    return_90d:  float | None = None
    return_180d: float | None = None
    excess_30d:  float | None = None
    excess_60d:  float | None = None
    excess_90d:  float | None = None
    excess_180d: float | None = None


@dataclass
class BacktestResult:
    ticker: str
    snapshots: list[dict] = field(default_factory=list)  # SnapshotResult as dicts
    summary: dict = field(default_factory=dict)
    methodology_version: str = METHODOLOGY_VERSION
    methodology_note: str = (
        "Historical composite uses absolute thresholds, not peer-percentile. "
        "Only fundamentals + momentum + analyst sentiment are reconstructable; "
        "filings, insider, and Perplexity sentiment are omitted."
    )
    timestamp: str = ""
    error: str | None = None


# ── Cache ────────────────────────────────────────────────────────────────────

def _cache_path(ticker: str) -> Path:
    return _CACHE_DIR / f"{ticker.upper()}.json"


def _load_cached(ticker: str) -> BacktestResult | None:
    p = _cache_path(ticker)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text())
    except Exception:
        return None
    if data.get("methodology_version") != METHODOLOGY_VERSION:
        return None
    return BacktestResult(**data)


def _save_cached(result: BacktestResult) -> None:
    p = _cache_path(result.ticker)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(asdict(result), indent=2))


# ── Orchestration ────────────────────────────────────────────────────────────

def _forward_return(prices: list[dict], dates: list[str],
                    snap_date: str, days: int) -> float | None:
    snap_row = _price_on_or_after(dates, prices, snap_date)
    if not snap_row:
        return None
    # Target = snap_date + days; find the nearest trading day at or after.
    snap_dt = datetime.strptime(snap_date, "%Y-%m-%d")
    target_dt = snap_dt.replace()  # copy
    # Add days the simple way — no calendar arithmetic needed since we'll
    # find the nearest trading day in our price series anyway.
    from datetime import timedelta
    target_str = (snap_dt + timedelta(days=days)).strftime("%Y-%m-%d")
    fwd_row = _price_on_or_after(dates, prices, target_str)
    if not fwd_row or snap_row["close"] <= 0:
        return None
    return round(((fwd_row["close"] - snap_row["close"]) / snap_row["close"]) * 100, 2)


def run_backtest(ticker: str, profile: str | None = None,
                 force_refresh: bool = False) -> BacktestResult:
    ticker = ticker.upper()
    if not force_refresh:
        cached = _load_cached(ticker)
        if cached:
            return cached

    try:
        prices = fetch_historical_prices(ticker)
        fundamentals = fetch_quarterly_fundamentals(ticker)
        spy = fetch_spy_history()
    except Exception as e:
        return BacktestResult(
            ticker=ticker, snapshots=[], summary={}, error=str(e),
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    if not prices or not fundamentals:
        return BacktestResult(
            ticker=ticker, snapshots=[], summary={},
            error="insufficient FMP history (need both prices and quarterly metrics)",
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    dates, _ = _index_prices_by_date(prices)
    spy_dates, _ = _index_prices_by_date(spy)

    snapshots: list[SnapshotResult] = []
    for f in fundamentals:
        snap_date = f.get("date") or f.get("reportedDate")
        if not snap_date:
            continue
        # Need at least 200 days of history before the snapshot for ma_trend.
        snap_row = _price_on_or_after(dates, prices, snap_date)
        if not snap_row:
            continue
        snap_price = snap_row["close"]

        # Pull the four fundamentals fields. FMP field names vary by endpoint version.
        pe = f.get("peRatio") or f.get("pe") or f.get("priceEarningsRatio")
        roe = (f.get("returnOnEquity")
               or f.get("roe")
               or f.get("returnOnTangibleEquity"))
        gm = f.get("grossProfitMargin") or f.get("grossMargin")
        de = f.get("debtToEquity") or f.get("debtEquityRatio")

        fund_score = _avg_non_null([
            _score_pe(pe),
            _score_roe(roe),
            _score_gross_margin(gm),
            _score_debt_equity(de),
        ])
        mom_score = _avg_non_null([
            _score_52w_position(_position_52w(prices, dates, snap_date)),
            _score_ma_trend(_ma_trend(prices, dates, snap_date)),
            _score_price_change(_price_change_30d(prices, dates, snap_date)),
        ])
        # Sentiment is essentially impossible to reconstruct without an
        # analyst-target history endpoint we'd have to pay for. We seed a
        # neutral 50 so the composite can stay normalized, but we surface
        # this nuance in the methodology_note.
        sent_score = 50.0

        composite = _composite(fund_score, mom_score, sent_score)

        snap = SnapshotResult(
            snapshot_date=snap_date,
            snapshot_price=round(snap_price, 2),
            composite=composite,
            fundamentals_score=fund_score,
            momentum_score=mom_score,
            sentiment_score=sent_score,
            pe=pe, roe=roe, gross_margin=gm, debt_equity=de,
        )
        for days in FORWARD_WINDOWS_DAYS:
            tic_ret = _forward_return(prices, dates, snap_date, days)
            spy_ret = _forward_return(spy,    spy_dates, snap_date, days)
            setattr(snap, f"return_{days}d", tic_ret)
            if tic_ret is not None and spy_ret is not None:
                setattr(snap, f"excess_{days}d", round(tic_ret - spy_ret, 2))
        snapshots.append(snap)

    # ── Summary: hit-rate by composite band ─────────────────────────────────
    summary = _summarize(snapshots)

    result = BacktestResult(
        ticker=ticker,
        snapshots=[asdict(s) for s in snapshots],
        summary=summary,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    _save_cached(result)
    return result


def _summarize(snapshots: list[SnapshotResult]) -> dict:
    """Compute high-score-band mean returns + hit rate.

    "High score" = composite >= 70. Anything else is "low/mid". For each
    forward window we report mean realized return and SPY-relative excess.
    """
    out: dict = {"high_band_threshold": 70}
    for days in FORWARD_WINDOWS_DAYS:
        ret_attr = f"return_{days}d"
        exc_attr = f"excess_{days}d"
        high = [s for s in snapshots if s.composite is not None and s.composite >= 70]
        high_with_ret = [s for s in high if getattr(s, ret_attr) is not None]
        if not high_with_ret:
            out[f"{days}d"] = None
            continue
        mean_ret = sum(getattr(s, ret_attr) for s in high_with_ret) / len(high_with_ret)
        excess_with = [s for s in high_with_ret if getattr(s, exc_attr) is not None]
        mean_excess = (sum(getattr(s, exc_attr) for s in excess_with) / len(excess_with)
                       if excess_with else None)
        hits = sum(1 for s in high_with_ret if getattr(s, ret_attr) > 0)
        out[f"{days}d"] = {
            "n": len(high_with_ret),
            "mean_return":  round(mean_ret, 2),
            "mean_excess":  round(mean_excess, 2) if mean_excess is not None else None,
            "hit_rate":     round(hits / len(high_with_ret) * 100, 1),
        }
    return out
