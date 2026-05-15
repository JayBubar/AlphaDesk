"""AlphaDesk profile-aware peer-normalized scoring engine.

Public API:
    score_universe(stocks, profile_name) -> list[ScoreResult]
    score_one(ticker, metrics, peers, profile_name) -> ScoreResult
    fmp_to_metrics(profile, quote) -> dict
    yfinance_to_metrics(info) -> dict
    PROFILES, get_profile, DEFAULT_PROFILE
    METHODOLOGY_VERSION
"""
from .engine import (
    ScoreResult,
    PillarBreakdown,
    MetricContribution,
    score_universe,
    score_one,
    result_to_dict,
)
from .profiles import PROFILES, get_profile, DEFAULT_PROFILE
from .adapters import fmp_to_metrics, yfinance_to_metrics
from .metrics import METRICS, PILLARS
from .version import METHODOLOGY_VERSION

__all__ = [
    "ScoreResult", "PillarBreakdown", "MetricContribution",
    "score_universe", "score_one", "result_to_dict",
    "PROFILES", "get_profile", "DEFAULT_PROFILE",
    "fmp_to_metrics", "yfinance_to_metrics",
    "METRICS", "PILLARS",
    "METHODOLOGY_VERSION",
]
