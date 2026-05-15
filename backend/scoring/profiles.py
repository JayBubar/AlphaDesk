"""Investment profile definitions.

Each profile carries:
- pillar_weights: relative pillar contribution to the composite (any positive scale)
- sub_weights:    within each pillar, relative metric contribution

Both are *relative* — the engine normalizes them. A sub-weight of 0 means the metric
is intentionally ignored for that profile (e.g., P/E is meaningless for a penny stock).
"""

PROFILES: dict[str, dict] = {
    "value_long": {
        "label":       "Value / Long-Term",
        "description": "Heavy fundamentals (FCF, ROIC, balance sheet). De-emphasizes momentum and sentiment.",
        "pillar_weights": {
            "fundamentals": 45,
            "momentum":     10,
            "sentiment":    10,
            "filings":      25,
            "insider":      10,
        },
        "sub_weights": {
            "fundamentals": {"fcf_yield": 30, "roic": 25, "debt_equity": 20, "pe": 15, "gross_margin": 10},
            "momentum":     {"ma_trend": 60,  "price_position_52w": 40, "price_change": 0},
            "sentiment":    {"dcf_upside": 60, "analyst_upside": 30, "short_interest": 10, "recommendation": 0},
            "filings":      {"filing_drift": 50, "hedging_delta": 50},
            "insider":      {"insider_pct": 60, "inst_pct": 40},
        },
    },
    "growth_mid": {
        "label":       "Growth / Mid-Term",
        "description": "Balanced fundamentals + momentum. The default lens for quality compounders.",
        "pillar_weights": {
            "fundamentals": 30,
            "momentum":     30,
            "sentiment":    20,
            "filings":      15,
            "insider":      5,
        },
        "sub_weights": {
            "fundamentals": {"roic": 25, "gross_margin": 25, "fcf_yield": 20, "pe": 15, "debt_equity": 15},
            "momentum":     {"ma_trend": 35, "price_position_52w": 35, "price_change": 30},
            "sentiment":    {"analyst_upside": 30, "dcf_upside": 30, "recommendation": 20, "short_interest": 20},
            "filings":      {"filing_drift": 50, "hedging_delta": 50},
            "insider":      {"insider_pct": 50, "inst_pct": 50},
        },
    },
    "speculative": {
        "label":       "Speculative / Short-Term",
        "description": "Heavy momentum and sentiment. Fundamentals reduced to balance-sheet sanity check.",
        "pillar_weights": {
            "fundamentals": 10,
            "momentum":     40,
            "sentiment":    35,
            "filings":      5,
            "insider":      10,
        },
        "sub_weights": {
            "fundamentals": {"debt_equity": 50, "fcf_yield": 30, "gross_margin": 20, "pe": 0, "roic": 0},
            "momentum":     {"price_change": 40, "price_position_52w": 30, "ma_trend": 30},
            "sentiment":    {"analyst_upside": 25, "recommendation": 25, "dcf_upside": 25, "short_interest": 25},
            "filings":      {"filing_drift": 50, "hedging_delta": 50},
            "insider":      {"inst_pct": 70, "insider_pct": 30},
        },
    },
    "penny": {
        "label":       "Penny Stock",
        "description": "Sentiment-first. Story and flow dominate; fundamentals reduced to a survival check.",
        "pillar_weights": {
            "fundamentals": 5,
            "momentum":     15,
            "sentiment":    70,
            "filings":      5,
            "insider":      5,
        },
        "sub_weights": {
            "fundamentals": {"debt_equity": 100, "fcf_yield": 0, "roic": 0, "gross_margin": 0, "pe": 0},
            "momentum":     {"price_change": 60, "price_position_52w": 40, "ma_trend": 0},
            "sentiment":    {"short_interest": 30, "analyst_upside": 25, "recommendation": 25, "dcf_upside": 20},
            "filings":      {"filing_drift": 70, "hedging_delta": 30},
            "insider":      {"insider_pct": 70, "inst_pct": 30},
        },
    },
}

DEFAULT_PROFILE = "growth_mid"


def get_profile(name: str | None) -> dict:
    if not name:
        return PROFILES[DEFAULT_PROFILE]
    return PROFILES.get(name, PROFILES[DEFAULT_PROFILE])
