"""Insider-activity scoring via SEC Form 4.

Public API:
    score_insider_activity(ticker, force_refresh=False) -> InsiderScore
"""
from .score import compute as score_insider_activity, InsiderScore

__all__ = ["score_insider_activity", "InsiderScore"]
