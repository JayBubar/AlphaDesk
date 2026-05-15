"""Netlify Python function — screening + scoring.

Two key fixes vs the original:
  1. sys.path: scan parent levels until backend/scoring is found rather than
     assuming parents[2]. Netlify's runtime may place the file at the bundle
     root, making parents[0] the right level.
  2. Parallel fetch: yfinance .info calls are I/O-bound (~1-2 s each).
     Running 25 tickers serially blows Netlify's 10-second timeout. Eight
     concurrent workers brings total wall time to ~3-4 s.
"""
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ── sys.path: find the directory that contains backend/scoring ──────────────
_here = Path(__file__).resolve()
_path_fixed = False
for _lvl in range(5):
    try:
        _candidate = _here.parents[_lvl]
    except IndexError:
        break
    if (_candidate / "backend" / "scoring" / "__init__.py").exists():
        sys.path.insert(0, str(_candidate))
        _path_fixed = True
        break

# ── imports after path fix ──────────────────────────────────────────────────
try:
    import yfinance as yf
    from backend.scoring import (
        score_universe, yfinance_to_metrics, result_to_dict,
        DEFAULT_PROFILE, METHODOLOGY_VERSION,
    )
    _IMPORT_ERR = None
except Exception as _exc:
    _IMPORT_ERR = f"Import failed (path_fixed={_path_fixed}): {_exc}"

# ── constants ───────────────────────────────────────────────────────────────
UNIVERSE = [
    "MSFT", "AAPL", "GOOGL", "NVDA", "META",
    "UNH",  "JPM",  "LLY",   "V",    "PG",
    "KO",   "COST", "WMT",   "MCD",  "AMD",
    "AMAT", "AXON", "CRWD",  "WM",   "BAC",
    "AMZN", "AVGO", "NFLX",  "CRM",  "ADBE",
]

CAP_RANGES = {
    "sm": (3e8,  2e9),
    "md": (2e9,  1e10),
    "lg": (1e10, 2e11),
    "mg": (2e11, float("inf")),
}

_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
}


def safe(val, default=None):
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return default
    return val


def _fetch_ticker(ticker):
    """Fetch yfinance .info for one ticker. Returns (ticker, info) or (ticker, None)."""
    try:
        info = yf.Ticker(ticker).info
        if not info:
            return ticker, None
        # Minimal check — yfinance returns a stub dict when the ticker is unknown
        if not (info.get("currentPrice") or info.get("regularMarketPrice")):
            return ticker, None
        return ticker, info
    except Exception as e:
        print(f"  Skip {ticker}: {e}")
        return ticker, None


def handler(event, context):
    # Always return JSON — never let an exception propagate to an HTML 502
    try:
        if _IMPORT_ERR:
            return {
                "statusCode": 500,
                "headers": _HEADERS,
                "body": json.dumps({"error": _IMPORT_ERR}),
            }

        params    = event.get("queryStringParameters") or {}
        sector    = params.get("sector", "")
        cap       = params.get("cap", "")
        pe_max    = float(params.get("peMax", 100))
        price_min = float(params.get("priceMin", 0))
        price_max = float(params.get("priceMax", 99999))
        vol_min   = float(params.get("volMin", 0))
        beta_max  = float(params.get("betaMax", 5))
        profile   = params.get("profile", DEFAULT_PROFILE)

        # ── Parallel fetch — 8 workers, I/O-bound so GIL doesn't block ──────
        raw_map: dict[str, dict] = {}
        with ThreadPoolExecutor(max_workers=8) as executor:
            for ticker, info in executor.map(_fetch_ticker, UNIVERSE):
                if info:
                    raw_map[ticker] = info

        # ── Pass-1 filter ────────────────────────────────────────────────────
        survivors = []  # (ticker, metrics_dict, surface_fields)

        for ticker in UNIVERSE:          # preserve stable ordering
            info = raw_map.get(ticker)
            if not info:
                continue

            price = safe(info.get("currentPrice") or info.get("regularMarketPrice"), 0)
            if not price:
                continue

            vol  = safe(info.get("averageVolume"), 0) / 1000  # → K/day
            beta = safe(info.get("beta"), 0)
            mcap = safe(info.get("marketCap"), 0)
            sec  = safe(info.get("sector"), "")
            pe   = safe(info.get("trailingPE"))

            if sector and sec != sector:
                continue
            if cap and cap in CAP_RANGES:
                lo, hi = CAP_RANGES[cap]
                if not (lo <= mcap <= hi):
                    continue
            if price < price_min or price > price_max:
                continue
            if vol < vol_min:
                continue
            if beta and beta > beta_max:
                continue

            metrics = yfinance_to_metrics(info)
            surface = {
                "name":      safe(info.get("longName") or info.get("shortName"), ticker),
                "sector":    sec,
                "industry":  safe(info.get("industry"), ""),
                "price":     round(price, 2),
                "change":    safe(info.get("regularMarketChangePercent")),
                "pe":        round(pe, 1) if pe else None,
                "marketCap": mcap,
                "beta":      round(beta, 2) if beta else None,
                "volume":    int(vol * 1000),
                "high52w":   safe(info.get("fiftyTwoWeekHigh")),
                "low52w":    safe(info.get("fiftyTwoWeekLow")),
                "divYield":  safe(info.get("dividendYield")),
                "dcf":       None,
            }
            survivors.append((ticker, metrics, surface))

        if not survivors:
            return {
                "statusCode": 200,
                "headers": _HEADERS,
                "body": json.dumps([]),
            }

        # ── Pass-2 peer-percentile scoring ───────────────────────────────────
        score_inputs  = [(t, m) for t, m, _ in survivors]
        score_results = score_universe(score_inputs, profile)

        results = []
        for (ticker, _, surface), sr in zip(survivors, score_results):
            name   = surface["name"]
            sector = surface["sector"]
            results.append({
                "ticker": ticker,
                **surface,
                "scores":    sr.pillars,
                "composite": sr.composite,
                "breakdown": result_to_dict(sr)["breakdown"],
                "profile":   sr.profile,
                "methodologyVersion": METHODOLOGY_VERSION,
                "flags":     [],
                "why":       f"{name} ({sector}).",
            })

        return {
            "statusCode": 200,
            "headers": _HEADERS,
            "body": json.dumps(results),
        }

    except Exception as exc:
        import traceback
        return {
            "statusCode": 500,
            "headers": _HEADERS,
            "body": json.dumps({
                "error": str(exc),
                "trace": traceback.format_exc(),
            }),
        }
