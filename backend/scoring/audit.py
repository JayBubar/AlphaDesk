"""Append-only score-snapshot writer.

Seeds backtest data: every screening run writes one JSON per ticker to
backend/data/scores/<YYYY-MM-DD>/<TICKER>.json containing the full ScoreResult
plus the raw input metrics. The methodology version is stamped on each file
so future calibration work can compare apples to apples.
"""
import json
from pathlib import Path
from datetime import datetime, timezone

from .engine import ScoreResult, result_to_dict


_DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "scores"


def snapshot_dir(date: str | None = None) -> Path:
    d = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    p = _DATA_DIR / d
    p.mkdir(parents=True, exist_ok=True)
    return p


def write_snapshot(result: ScoreResult, raw_metrics: dict | None = None) -> Path:
    payload = result_to_dict(result)
    if raw_metrics is not None:
        payload["inputs"] = raw_metrics
    p = snapshot_dir() / f"{result.ticker}.json"
    p.write_text(json.dumps(payload, indent=2))
    return p


def write_universe_snapshot(results: list, raw_metrics_by_ticker: dict | None = None):
    """Convenience: write snapshots for a whole screening run."""
    raw_metrics_by_ticker = raw_metrics_by_ticker or {}
    paths = []
    for r in results:
        raw = raw_metrics_by_ticker.get(r.ticker)
        paths.append(write_snapshot(r, raw))
    return paths
