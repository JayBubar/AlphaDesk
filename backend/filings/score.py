"""Composite filing-tone score.

Combines YoY language drift (Item 1A + Item 7) and YoY hedging-language delta
into a single 0..100 score that replaces the beta-as-proxy in main.py.

Higher = better (steady, confident language). Lower = bigger language shift
or rising hedging — worth a closer look.
"""
import json
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

from .edgar import fetch_two_latest_10k, fetch_filing_html, FilingMeta
from .parse import extract_risk_factors, extract_mda
from .drift import drift_score
from .hedging import hedging_frequency, hedging_delta
from ..scoring.version import METHODOLOGY_VERSION


_CACHE_ROOT = Path(__file__).resolve().parent.parent / "data" / "filings"


@dataclass
class FilingScore:
    ticker: str
    score: float                      # 0..100, higher is better
    risk_drift: float | None          # 0..100
    mda_drift: float | None           # 0..100
    hedging_freq_current: float | None
    hedging_freq_prior: float | None
    hedging_delta: float | None       # YoY relative change
    current_filing: dict | None       # FilingMeta as dict
    prior_filing: dict | None
    methodology_version: str
    timestamp: str
    error: str | None = None


def _compose_score(risk_drift, mda_drift, hedging_delta_value) -> float:
    """Blend drift + hedging into 0..100. Baseline 70."""
    base = 70.0
    drifts = [d for d in (risk_drift, mda_drift) if d is not None]
    drift_avg = sum(drifts) / len(drifts) if drifts else 0
    drift_penalty = drift_avg * 0.30  # 100% drift = -30 pts
    hedging_penalty = max(0.0, (hedging_delta_value or 0)) * 30  # +50% hedging = -15 pts
    score = base - drift_penalty - hedging_penalty
    return round(max(0.0, min(100.0, score)), 1)


def _empty(ticker: str, error: str) -> FilingScore:
    return FilingScore(
        ticker=ticker, score=50.0,
        risk_drift=None, mda_drift=None,
        hedging_freq_current=None, hedging_freq_prior=None, hedging_delta=None,
        current_filing=None, prior_filing=None,
        methodology_version=METHODOLOGY_VERSION,
        timestamp=datetime.now(timezone.utc).isoformat(),
        error=error,
    )


def _result_cache_path(ticker: str) -> Path:
    return _CACHE_ROOT / "_scores" / f"{ticker.upper()}.json"


def _load_cached(ticker: str) -> FilingScore | None:
    p = _result_cache_path(ticker)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text())
    except Exception:
        return None
    if data.get("methodology_version") != METHODOLOGY_VERSION:
        return None
    return FilingScore(**data)


def _save_cached(result: FilingScore) -> None:
    p = _result_cache_path(result.ticker)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(asdict(result), indent=2))


def compute(ticker: str, force_refresh: bool = False) -> FilingScore:
    """Fetch, parse, and score the two latest 10-Ks for a ticker.

    Cached per (ticker, methodology_version). 10-Ks are annual so this is
    essentially a long-lived cache; pass force_refresh=True to bypass.
    """
    if not force_refresh:
        cached = _load_cached(ticker)
        if cached:
            return cached

    filings = fetch_two_latest_10k(ticker)
    if len(filings) == 0:
        return _empty(ticker, "no 10-K filings found on EDGAR")
    if len(filings) == 1:
        # Single-year filer (recent IPO) — drift unmeasurable, score baseline.
        result = FilingScore(
            ticker=ticker, score=60.0,
            risk_drift=None, mda_drift=None,
            hedging_freq_current=None, hedging_freq_prior=None, hedging_delta=None,
            current_filing=_meta_to_dict(filings[0]),
            prior_filing=None,
            methodology_version=METHODOLOGY_VERSION,
            timestamp=datetime.now(timezone.utc).isoformat(),
            error="only one 10-K on file; YoY drift unmeasurable",
        )
        _save_cached(result)
        return result

    current, prior = filings[0], filings[1]

    try:
        current_html = fetch_filing_html(current)
        prior_html = fetch_filing_html(prior)
    except Exception as e:
        return _empty(ticker, f"EDGAR fetch failed: {e}")

    risk_cur = extract_risk_factors(current_html)
    risk_pri = extract_risk_factors(prior_html)
    mda_cur = extract_mda(current_html)
    mda_pri = extract_mda(prior_html)

    risk_d = drift_score(risk_cur, risk_pri) if (risk_cur and risk_pri) else None
    mda_d = drift_score(mda_cur, mda_pri) if (mda_cur and mda_pri) else None

    full_cur = (risk_cur + " " + mda_cur).strip()
    full_pri = (risk_pri + " " + mda_pri).strip()
    h_cur = hedging_frequency(full_cur) if full_cur else None
    h_pri = hedging_frequency(full_pri) if full_pri else None
    h_delta = hedging_delta(full_cur, full_pri) if (full_cur and full_pri) else None

    score = _compose_score(risk_d, mda_d, h_delta)

    result = FilingScore(
        ticker=ticker.upper(),
        score=score,
        risk_drift=risk_d,
        mda_drift=mda_d,
        hedging_freq_current=h_cur,
        hedging_freq_prior=h_pri,
        hedging_delta=h_delta,
        current_filing=_meta_to_dict(current),
        prior_filing=_meta_to_dict(prior),
        methodology_version=METHODOLOGY_VERSION,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    _save_cached(result)
    return result


def _meta_to_dict(meta: FilingMeta) -> dict:
    return {
        "cik": meta.cik,
        "accession": meta.accession,
        "primaryDoc": meta.primary_doc,
        "filingDate": meta.filing_date,
        "fiscalYearEnd": meta.fiscal_year_end,
        "url": meta.url,
    }
