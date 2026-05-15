"""Tests for the 10-K NLP filing-tone layer.

Network-dependent tests (CIK lookup, EDGAR fetch) are gated behind
ALPHADESK_RUN_NETWORK_TESTS=1 so the default suite runs offline.
"""
import os
import pytest

from backend.filings.parse import (
    html_to_text, extract_risk_factors, extract_mda, extract_section,
)
from backend.filings.drift import (
    tokenize, cosine_similarity, drift_score,
)
from backend.filings.hedging import (
    hedging_frequency, hedging_delta,
)


# ── parse ─────────────────────────────────────────────────────────────────

def test_html_to_text_strips_tags_and_entities():
    html = "<p>Risk &amp; reward.</p><script>bad()</script><b>Bold</b>"
    text = html_to_text(html)
    assert "Risk & reward." in text
    assert "bad()" not in text
    assert "Bold" in text
    assert "<" not in text and ">" not in text


def test_extract_section_locates_risk_factors():
    fixture = """
    Item 1. Business overview text here.
    Item 1A. Risk Factors
    Our business may be affected by various uncertainties such as the global economy.
    Item 1B. Unresolved staff comments. None.
    Item 2. Properties.
    """
    rf = extract_risk_factors(fixture)
    assert "may be affected" in rf
    assert "Properties" not in rf  # stops at next item header


def test_extract_section_returns_empty_when_missing():
    assert extract_section("nothing here", "ITEM 99.") == ""


def test_extract_mda():
    fixture = """
    Item 6. Selected Data.
    Item 7. Management's Discussion and Analysis
    Revenue grew 15% YoY driven by strong demand in North America.
    Item 7A. Quantitative disclosures.
    """
    mda = extract_mda(fixture)
    assert "Revenue grew" in mda
    assert "Quantitative" not in mda


# ── drift ─────────────────────────────────────────────────────────────────

def test_tokenize_filters_stopwords_and_short_tokens():
    tokens = tokenize("The quick brown fox a")
    assert "the" not in tokens
    assert "a" not in tokens
    assert "quick" in tokens
    assert "fox" in tokens


def test_cosine_identical_text_is_one():
    text = "Our risk factors include market volatility supply chain disruption inflation."
    assert cosine_similarity(text, text) == pytest.approx(1.0, abs=0.001)


def test_cosine_disjoint_text_is_zero():
    a = "alpha beta gamma delta epsilon"
    b = "ostrich pelican flamingo sparrow eagle"
    assert cosine_similarity(a, b) == 0.0


def test_drift_score_identical_is_zero():
    text = "Risk factors include cyber attacks regulatory changes and competition."
    assert drift_score(text, text) == 0.0


def test_drift_score_completely_different_approaches_100():
    a = "alpha beta gamma delta epsilon zeta eta theta iota"
    b = "ostrich pelican flamingo sparrow eagle owl swallow heron"
    assert drift_score(a, b) >= 90


# ── hedging ───────────────────────────────────────────────────────────────

def test_hedging_frequency_counts_known_phrases():
    text = "We may not achieve. There is no assurance. Results are uncertain."
    freq = hedging_frequency(text)
    assert freq > 0


def test_hedging_frequency_zero_for_empty():
    assert hedging_frequency("") == 0.0
    assert hedging_frequency("   ") == 0.0


def test_hedging_delta_positive_when_hedging_increases():
    prior = "Our results are stable. We deliver on plan. The outlook is clear."
    current = ("Our results may be impacted. We cannot predict whether we will achieve. "
               "There is no assurance. Conditions are uncertain. We may not deliver.")
    delta = hedging_delta(current, prior)
    assert delta > 0


def test_hedging_delta_capped_when_no_prior_baseline():
    # zero -> nonzero is treated as a maximum +1.0 (100%) increase, not div-by-zero
    assert hedging_delta("we may not", "") == 1.0
    # zero -> zero stays zero (no information)
    assert hedging_delta("", "") == 0.0
    assert hedging_delta("nothing here.", "no hedging here either.") == 0.0


# ── network gated ─────────────────────────────────────────────────────────

@pytest.mark.skipif(
    os.environ.get("ALPHADESK_RUN_NETWORK_TESTS") != "1",
    reason="set ALPHADESK_RUN_NETWORK_TESTS=1 to enable EDGAR network tests",
)
def test_cik_lookup_for_apple():
    from backend.filings.edgar import cik_for_ticker
    assert cik_for_ticker("AAPL") == "0000320193"


@pytest.mark.skipif(
    os.environ.get("ALPHADESK_RUN_NETWORK_TESTS") != "1",
    reason="set ALPHADESK_RUN_NETWORK_TESTS=1 to enable EDGAR network tests",
)
def test_fetch_two_latest_10k_for_apple():
    from backend.filings.edgar import fetch_two_latest_10k
    filings = fetch_two_latest_10k("AAPL")
    assert len(filings) == 2
    for f in filings:
        assert f.cik == "0000320193"
        assert f.accession
        assert f.primary_doc.endswith(".htm")
