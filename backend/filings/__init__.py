"""10-K NLP filing-tone layer.

Public API:
    score_filing_tone(ticker, force_refresh=False) -> FilingScore
    fetch_two_latest_10k(ticker) -> list[FilingMeta]  (this year + prior year)
"""
from .score import compute as score_filing_tone, FilingScore
from .edgar import fetch_two_latest_10k, FilingMeta

__all__ = ["score_filing_tone", "FilingScore", "fetch_two_latest_10k", "FilingMeta"]
