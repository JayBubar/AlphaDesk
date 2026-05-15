"""
AlphaDesk backend - FastAPI + FMP /stable/ API (free tier compatible)
Run: python -m uvicorn backend.main:app --reload --port 8000

Set your key first in CMD:
  set FMP_API_KEY=your_key_here
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import math, time, os, httpx

from backend.scoring import (
    score_universe, fmp_to_metrics, result_to_dict,
    PROFILES, DEFAULT_PROFILE, METHODOLOGY_VERSION,
)
from backend.scoring.audit import write_universe_snapshot
from backend.filings import score_filing_tone
from dataclasses import asdict

app = FastAPI(title="AlphaDesk API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FMP_KEY  = os.environ.get("FMP_API_KEY", "PASTE_YOUR_KEY_HERE")
FMP_BASE = "https://financialmodelingprep.com/stable"

UNIVERSE = [
    "MSFT", "AAPL", "GOOGL", "NVDA", "META",
    "UNH",  "JPM",  "LLY",   "V",    "PG",
    "KO",   "COST", "WMT",   "MCD",  "AMD",
    "AMAT", "AXON", "CRWD",  "WM",   "BAC",
]

CAP_RANGES = {
    "sm": (3e8,  2e9),
    "md": (2e9,  1e10),
    "lg": (1e10, 2e11),
    "mg": (2e11, float("inf")),
}


def safe(val, default=None):
    if val is None:
        return default
    try:
        if isinstance(val, float) and math.isnan(val):
            return default
    except Exception:
        pass
    return val


def fmp_get(path: str, params: dict = {}) -> list | dict:
    url = f"{FMP_BASE}/{path}"
    p = {**params, "apikey": FMP_KEY}
    with httpx.Client(timeout=15) as client:
        r = client.get(url, params=p)
        r.raise_for_status()
        return r.json()


def fetch_one(ticker: str) -> dict:
    profile, quote = {}, {}
    try:
        data = fmp_get("profile", {"symbol": ticker})
        profile = data[0] if isinstance(data, list) and data else {}
    except Exception as e:
        print(f"  [{ticker}] profile error: {e}")

    try:
        data = fmp_get("quote", {"symbol": ticker})
        quote = data[0] if isinstance(data, list) and data else {}
    except Exception as e:
        print(f"  [{ticker}] quote error: {e}")

    return {"profile": profile, "quote": quote}


def build_flags(profile: dict, quote: dict, pe_max: float) -> list:
    flags = []
    pe    = safe(profile.get("pe") or quote.get("pe"))
    dcf   = safe(profile.get("dcf"))
    price = safe(quote.get("price"))

    if pe and pe > pe_max:
        flags.append({"type": "warn",  "label": f"P/E {pe:.0f}"})
    elif pe is None:
        flags.append({"type": "info",  "label": "No P/E"})
    else:
        flags.append({"type": "clear", "label": "P/E ok"})

    if dcf and price:
        if price > dcf * 1.2:
            flags.append({"type": "warn",  "label": "Above DCF"})
        elif price < dcf * 0.85:
            flags.append({"type": "clear", "label": "Below DCF"})

    return flags


def build_why(profile: dict, quote: dict, ticker: str) -> str:
    name   = safe(profile.get("companyName"), ticker)
    sector = safe(profile.get("sector"), "Unknown sector")
    dcf    = safe(profile.get("dcf"))
    price  = safe(quote.get("price"))
    desc   = safe(profile.get("description"), "")

    upside = ""
    if dcf and price and price > 0:
        pct = ((dcf - price) / price) * 100
        direction = "upside" if pct > 0 else "downside"
        upside = f"DCF model implies {abs(pct):.1f}% {direction}. "

    summary = desc[:150] + "..." if len(desc) > 150 else desc
    return f"{name} ({sector}). {upside}{summary}"


@app.get("/screen")
def screen(
    sector:   Optional[str] = None,
    cap:      Optional[str] = None,
    peMax:    float = 100,
    priceMin: float = 0,
    priceMax: float = 99999,
    volMin:   float = 0,
    betaMax:  float = 5,
    profile:  str = DEFAULT_PROFILE,
):
    if FMP_KEY == "PASTE_YOUR_KEY_HERE":
        raise HTTPException(status_code=500,
            detail="FMP_API_KEY not set. Run: set FMP_API_KEY=your_key in CMD then restart server.")

    print(f"\nScreen started — {len(UNIVERSE)} tickers, profile={profile}")
    survivors = []  # list of (ticker, raw_payload, metrics)

    for i, ticker in enumerate(UNIVERSE):
        print(f"  [{i+1}/{len(UNIVERSE)}] Fetching {ticker}...")
        data = fetch_one(ticker)
        prof = data["profile"]
        quote = data["quote"]

        if not prof or not quote:
            print(f"    No data for {ticker}, skipping")
            continue

        try:
            price = safe(quote.get("price"), 0)
            if not price:
                continue

            vol  = safe(quote.get("avgVolume") or prof.get("volAvg"), 0)
            beta = safe(prof.get("beta"), 0)
            mcap = safe(prof.get("mktCap") or quote.get("marketCap"), 0)
            sec  = safe(prof.get("sector"), "")

            # Pass-1 filters
            if sector and sec != sector: continue
            if cap and cap in CAP_RANGES:
                lo, hi = CAP_RANGES[cap]
                if not (lo <= mcap <= hi): continue
            if price < priceMin or price > priceMax: continue
            if vol and vol < volMin * 1000: continue
            if beta and beta > betaMax: continue

            metrics = fmp_to_metrics(prof, quote)
            survivors.append((ticker, {"profile": prof, "quote": quote}, metrics))

        except Exception as e:
            print(f"    Error preparing {ticker}: {e}")
            continue

        time.sleep(0.2)

    # Pass-2: peer-percentile scoring across the survivor universe
    score_inputs = [(t, m) for t, _, m in survivors]
    score_results = score_universe(score_inputs, profile)

    # Persist audit-log snapshots for backtest seed
    try:
        write_universe_snapshot(score_results, {t: m for t, _, m in survivors})
    except Exception as e:
        print(f"  snapshot write failed (non-fatal): {e}")

    # Assemble response
    results = []
    for (ticker, payload, metrics), score_result in zip(survivors, score_results):
        prof = payload["profile"]
        quote = payload["quote"]
        price = safe(quote.get("price"), 0)
        pe    = safe(prof.get("pe") or quote.get("pe"))

        results.append({
            "ticker":    ticker,
            "name":      safe(prof.get("companyName"), ticker),
            "sector":    safe(prof.get("sector"), ""),
            "industry":  safe(prof.get("industry"), ""),
            "price":     round(price, 2),
            "pe":        round(pe, 1) if pe else None,
            "marketCap": safe(prof.get("mktCap") or quote.get("marketCap"), 0),
            "beta":      round(safe(prof.get("beta"), 0), 2) if safe(prof.get("beta")) else None,
            "volume":    int(safe(quote.get("avgVolume") or prof.get("volAvg"), 0) or 0),
            "high52w":   safe(quote.get("yearHigh")),
            "low52w":    safe(quote.get("yearLow")),
            "divYield":  safe(prof.get("lastDiv")),
            "change":    safe(quote.get("changesPercentage")),
            "dcf":       safe(prof.get("dcf")),
            "scores":    score_result.pillars,
            "composite": score_result.composite,
            "breakdown": result_to_dict(score_result)["breakdown"],
            "profile":   score_result.profile,
            "methodologyVersion": METHODOLOGY_VERSION,
            "flags":     build_flags(prof, quote, peMax),
            "why":       build_why(prof, quote, ticker),
        })

    print(f"\nScreen complete: {len(results)}/{len(UNIVERSE)} passed\n")
    return results


@app.get("/profiles")
def list_profiles():
    return {
        "default": DEFAULT_PROFILE,
        "methodologyVersion": METHODOLOGY_VERSION,
        "profiles": [
            {
                "key": k,
                "label": p["label"],
                "description": p["description"],
                "pillarWeights": p["pillar_weights"],
            }
            for k, p in PROFILES.items()
        ],
    }


@app.get("/filings/{ticker}")
def get_filing_score(ticker: str, refresh: bool = False):
    """Compute (or fetch from cache) the 10-K NLP filing-tone score for a ticker.

    Lazy endpoint — not called during the bulk screen (EDGAR is rate-limited).
    Use it when promoting a stock to the watchlist for deeper analysis.
    """
    try:
        result = score_filing_tone(ticker.upper(), force_refresh=refresh)
        return asdict(result)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Filing fetch failed: {e}")


@app.get("/quote/{ticker}")
def get_quote(ticker: str):
    try:
        data = fmp_get("quote", {"symbol": ticker})
        q = data[0] if data else {}
        return {
            "ticker": ticker,
            "price":  safe(q.get("price")),
            "change": safe(q.get("changesPercentage")),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class PricesRequest(BaseModel):
    tickers: List[str]


@app.post("/prices")
def refresh_prices(body: PricesRequest):
    result = {}
    for ticker in body.tickers:
        try:
            data = fmp_get("quote", {"symbol": ticker})
            q = data[0] if data else {}
            result[ticker] = {
                "price":  safe(q.get("price")),
                "change": safe(q.get("changesPercentage")),
            }
        except Exception:
            result[ticker] = {"price": None, "change": None}
        time.sleep(0.1)
    return result


@app.get("/health")
def health():
    return {
        "status": "ok",
        "fmp_key_set": FMP_KEY != "PASTE_YOUR_KEY_HERE",
        "methodologyVersion": METHODOLOGY_VERSION,
    }
