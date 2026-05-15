"""Metric registry. Every numeric input the engine knows how to score is declared here."""
from dataclasses import dataclass


@dataclass(frozen=True)
class MetricSpec:
    key: str
    pillar: str
    direction: int  # +1 higher is better, -1 lower is better
    description: str


PILLARS = ("fundamentals", "momentum", "sentiment", "filings", "insider")


METRICS: dict[str, MetricSpec] = {
    # Fundamentals
    "pe":           MetricSpec("pe",           "fundamentals", -1, "Trailing P/E ratio"),
    "fcf_yield":    MetricSpec("fcf_yield",    "fundamentals", +1, "Free cash flow yield"),
    "roic":         MetricSpec("roic",         "fundamentals", +1, "Return on invested capital (or ROE proxy)"),
    "gross_margin": MetricSpec("gross_margin", "fundamentals", +1, "Gross margin"),
    "debt_equity":  MetricSpec("debt_equity",  "fundamentals", -1, "Total debt to equity"),

    # Momentum
    "price_position_52w": MetricSpec("price_position_52w", "momentum", +1, "Position in 52-week range (0-1)"),
    "ma_trend":           MetricSpec("ma_trend",           "momentum", +1, "MA trend signal (-1 down, 0 mixed, +1 up)"),
    "price_change":       MetricSpec("price_change",       "momentum", +1, "Recent price change %"),

    # Sentiment
    "analyst_upside":  MetricSpec("analyst_upside",  "sentiment", +1, "Analyst price target vs current (%)"),
    "dcf_upside":      MetricSpec("dcf_upside",      "sentiment", +1, "DCF fair value vs current (%)"),
    "short_interest":  MetricSpec("short_interest",  "sentiment", -1, "Short % of float"),
    "recommendation":  MetricSpec("recommendation",  "sentiment", -1, "Analyst rec mean (1=strong buy, 5=sell)"),

    # Filings (populated by the 10-K NLP layer; None until P2 lands data)
    "filing_drift":  MetricSpec("filing_drift",  "filings", -1, "YoY language drift in 10-K (0-100)"),
    "hedging_delta": MetricSpec("hedging_delta", "filings", -1, "YoY change in hedging-language frequency"),

    # Insider / institutional
    "insider_pct":   MetricSpec("insider_pct",   "insider", +1, "Insider ownership %"),
    "inst_pct":      MetricSpec("inst_pct",      "insider", +1, "Institutional ownership %"),
}


def metrics_for_pillar(pillar: str) -> list[str]:
    return [k for k, m in METRICS.items() if m.pillar == pillar]
