"""Provider-specific quote/profile dicts -> normalized metrics dict.

The engine doesn't care where the numbers come from. These adapters translate
FMP and yfinance shapes into the canonical metric keys defined in metrics.py.
"""
import math


def _safe(v, default=None):
    if v is None:
        return default
    try:
        if isinstance(v, float) and math.isnan(v):
            return default
    except Exception:
        pass
    return v


def _ratio(num, den):
    if num is None or den is None or den == 0:
        return None
    return num / den


def fmp_to_metrics(profile: dict | None, quote: dict | None) -> dict:
    """Map FMP /stable/ profile + quote payloads to the canonical metrics dict."""
    profile = profile or {}
    quote = quote or {}

    pe     = _safe(profile.get("pe") or quote.get("pe"))
    price  = _safe(quote.get("price"))
    h52    = _safe(quote.get("yearHigh"))
    l52    = _safe(quote.get("yearLow"))
    ma50   = _safe(quote.get("priceAvg50"))
    ma200  = _safe(quote.get("priceAvg200"))
    chg    = _safe(quote.get("changesPercentage"))
    rev    = _safe(profile.get("revenueTTM"))
    gp     = _safe(profile.get("grossProfitTTM"))
    de     = _safe(profile.get("debtToEquity") or profile.get("totalDebtToEquity"))
    dcf    = _safe(profile.get("dcf"))
    target = _safe(profile.get("targetMeanPrice") or profile.get("priceTarget"))

    gross_margin = _ratio(gp, rev)

    pos52 = None
    if h52 is not None and l52 is not None and price is not None and (h52 - l52) > 0:
        pos52 = (price - l52) / (h52 - l52)

    ma_trend = None
    if price and ma50 and ma200:
        if price > ma50 > ma200:
            ma_trend = 1.0
        elif price < ma50 < ma200:
            ma_trend = -1.0
        else:
            ma_trend = 0.0

    dcf_upside = None
    if dcf is not None and price:
        dcf_upside = ((dcf - price) / price) * 100

    analyst_upside = None
    if target is not None and price:
        analyst_upside = ((target - price) / price) * 100

    return {
        "pe": pe,
        "fcf_yield": None,            # FMP /stable/ profile doesn't expose FCF here
        "roic": None,
        "gross_margin": gross_margin,
        "debt_equity": de,
        "price_position_52w": pos52,
        "ma_trend": ma_trend,
        "price_change": chg,
        "analyst_upside": analyst_upside,
        "dcf_upside": dcf_upside,
        "short_interest": None,
        "recommendation": None,
        "filing_drift": None,
        "hedging_delta": None,
        "insider_pct": None,
        "inst_pct": None,
    }


def yfinance_to_metrics(info: dict | None) -> dict:
    """Map yfinance .info dict to the canonical metrics dict."""
    info = info or {}

    pe     = _safe(info.get("trailingPE"))
    gm     = _safe(info.get("grossMargins"))
    de     = _safe(info.get("debtToEquity"))
    fcf    = _safe(info.get("freeCashflow"))
    mcap   = _safe(info.get("marketCap"))
    price  = _safe(info.get("currentPrice") or info.get("regularMarketPrice"))
    h52    = _safe(info.get("fiftyTwoWeekHigh"))
    l52    = _safe(info.get("fiftyTwoWeekLow"))
    ma50   = _safe(info.get("fiftyDayAverage"))
    ma200  = _safe(info.get("twoHundredDayAverage"))
    rec    = _safe(info.get("recommendationMean"))
    target = _safe(info.get("targetMeanPrice"))
    short  = _safe(info.get("shortPercentOfFloat"))
    ins    = _safe(info.get("heldPercentInsiders"))
    inst   = _safe(info.get("heldPercentInstitutions"))
    roe    = _safe(info.get("returnOnEquity"))   # ROE proxy until full ROIC available

    fcf_yield = _ratio(fcf, mcap)

    pos52 = None
    if h52 is not None and l52 is not None and price is not None and (h52 - l52) > 0:
        pos52 = (price - l52) / (h52 - l52)

    ma_trend = None
    if price and ma50 and ma200:
        if price > ma50 > ma200:
            ma_trend = 1.0
        elif price < ma50 < ma200:
            ma_trend = -1.0
        else:
            ma_trend = 0.0

    analyst_upside = None
    if target is not None and price:
        analyst_upside = ((target - price) / price) * 100

    return {
        "pe": pe,
        "fcf_yield": fcf_yield,
        "roic": roe,
        "gross_margin": gm,
        "debt_equity": de,
        "price_position_52w": pos52,
        "ma_trend": ma_trend,
        "price_change": None,
        "analyst_upside": analyst_upside,
        "dcf_upside": None,
        "short_interest": short,
        "recommendation": rec,
        "filing_drift": None,
        "hedging_delta": None,
        "insider_pct": ins,
        "inst_pct": inst,
    }
