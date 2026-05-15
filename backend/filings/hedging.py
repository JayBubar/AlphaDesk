"""Hedging-language detector.

Counts the frequency (per 1000 words) of equivocating / uncertain phrases in
a document, and compares year-over-year. A meaningful uptick is a soft signal
that management's language is becoming less assertive.
"""
import re


# Hedging lexicon — multi-word phrases first (longest-match wins via boundary anchors).
HEDGING_TERMS = [
    "no assurance can be given",
    "no assurance",
    "we cannot predict",
    "we cannot assure",
    "we may not",
    "we might not",
    "subject to",
    "depends on",
    "dependent on",
    "could adversely affect",
    "could materially",
    "may adversely affect",
    "may materially",
    "if we are unable",
    "we are unable",
    "are uncertain",
    "uncertain",
    "uncertainty",
    "uncertainties",
    "potentially",
    "potential",
    "anticipate",
    "anticipates",
    "anticipated",
    "believe",
    "believes",
    "expect",
    "expects",
    "intend",
    "intends",
    "may be",
    "might be",
    "could be",
    "should be",
    "we may",
    "we might",
    "we could",
    "we should",
    "estimate",
    "estimates",
    "estimated",
    "approximate",
    "approximately",
    "possibly",
    "perhaps",
    "no guarantee",
    "if any",
]


def _count_phrase(text_lower: str, phrase: str) -> int:
    pattern = r"\b" + re.escape(phrase) + r"\b"
    return len(re.findall(pattern, text_lower))


def hedging_frequency(text: str) -> float:
    """Return hedging-term hits per 1000 words."""
    if not text:
        return 0.0
    text_lower = text.lower()
    words = len(re.findall(r"\b\w+\b", text_lower))
    if words == 0:
        return 0.0
    hits = sum(_count_phrase(text_lower, p) for p in HEDGING_TERMS)
    return round((hits / words) * 1000, 2)


def hedging_delta(text_current: str, text_prior: str) -> float:
    """Return YoY relative change in hedging frequency.

    +0.30 = 30% more hedging this year. Negative means less hedging (a positive
    qualitative signal). When prior had zero hedging and current has any, we
    treat that as a maximum +1.0 increase rather than dividing by zero.
    """
    cur = hedging_frequency(text_current)
    prior = hedging_frequency(text_prior)
    if prior <= 0:
        return 0.0 if cur <= 0 else 1.0
    return round((cur - prior) / prior, 3)
