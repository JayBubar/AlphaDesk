"""Tests for the profile-aware peer-normalized scoring engine."""
from backend.scoring import (
    score_universe, score_one, result_to_dict,
    PROFILES, METHODOLOGY_VERSION,
)
from backend.scoring.normalize import percentile_rank, directional_score


# ── normalize ──────────────────────────────────────────────────────────────

def test_percentile_rank_midrank():
    # value equal to all peers -> 50% (midrank)
    assert percentile_rank(5, [5, 5, 5, 5]) == 50.0
    # value above all peers -> 100%
    assert percentile_rank(10, [1, 2, 3, 4]) == 100.0
    # value below all peers -> 0%
    assert percentile_rank(0, [1, 2, 3, 4]) == 0.0
    # value in middle of distribution
    assert percentile_rank(3, [1, 2, 3, 4, 5]) == 50.0


def test_percentile_rank_handles_none():
    assert percentile_rank(None, [1, 2, 3]) is None
    assert percentile_rank(5, []) is None
    assert percentile_rank(5, [None, None]) is None
    # None values in peers are filtered, not used
    assert percentile_rank(2, [1, 2, 3, None]) == percentile_rank(2, [1, 2, 3])


def test_directional_score_inverts_for_lower_better():
    peers = [10, 20, 30, 40, 50]
    # value=10, direction=+1 -> 10% (it's the lowest, so worst when higher=better)
    # value=10, direction=-1 -> 90% (lowest = best when lower=better)
    high_better = directional_score(10, peers, +1)
    low_better = directional_score(10, peers, -1)
    assert high_better is not None and low_better is not None
    assert abs(high_better + low_better - 100) < 0.001


# ── engine: profile differentiation ────────────────────────────────────────

def _sample_universe():
    """Three stocks with very different profiles to make scoring diffs visible."""
    return [
        ("VALUEY", {  # cheap, profitable, slow-growing
            "pe": 8, "fcf_yield": 0.08, "roic": 0.18, "gross_margin": 0.55,
            "debt_equity": 30,
            "price_position_52w": 0.4, "ma_trend": 0.0, "price_change": 0.5,
            "analyst_upside": 5, "dcf_upside": 25, "short_interest": 0.02, "recommendation": 2.5,
            "filing_drift": None, "hedging_delta": None,
            "insider_pct": 0.10, "inst_pct": 0.7,
        }),
        ("GROWTHY", {  # expensive, momentum-y, growing
            "pe": 45, "fcf_yield": 0.02, "roic": 0.25, "gross_margin": 0.70,
            "debt_equity": 60,
            "price_position_52w": 0.9, "ma_trend": 1.0, "price_change": 4.0,
            "analyst_upside": 18, "dcf_upside": -5, "short_interest": 0.04, "recommendation": 1.8,
            "filing_drift": None, "hedging_delta": None,
            "insider_pct": 0.05, "inst_pct": 0.85,
        }),
        ("PENNY", {  # ugly fundamentals, hot momentum, lots of buzz
            "pe": 200, "fcf_yield": -0.05, "roic": -0.10, "gross_margin": 0.20,
            "debt_equity": 250,
            "price_position_52w": 0.95, "ma_trend": 1.0, "price_change": 12.0,
            "analyst_upside": 40, "dcf_upside": 80, "short_interest": 0.30, "recommendation": 3.5,
            "filing_drift": None, "hedging_delta": None,
            "insider_pct": 0.30, "inst_pct": 0.20,
        }),
    ]


def test_profile_changes_composite_for_same_ticker():
    universe = _sample_universe()

    by_profile = {}
    for profile in ("value_long", "growth_mid", "speculative", "penny"):
        results = score_universe(universe, profile)
        by_profile[profile] = {r.ticker: r.composite for r in results}

    # VALUEY should rank best under value_long, not under penny
    assert by_profile["value_long"]["VALUEY"] > by_profile["penny"]["VALUEY"]

    # PENNY should rank best under penny, not under value_long
    assert by_profile["penny"]["PENNY"] > by_profile["value_long"]["PENNY"]

    # Same ticker should produce noticeably different composites across profiles
    valuey_scores = [by_profile[p]["VALUEY"] for p in by_profile]
    assert max(valuey_scores) - min(valuey_scores) >= 5


def test_methodology_version_stamped_on_every_result():
    results = score_universe(_sample_universe(), "growth_mid")
    for r in results:
        assert r.methodology_version == METHODOLOGY_VERSION
        assert r.timestamp  # ISO8601


def test_breakdown_has_contributions_with_rationale():
    results = score_universe(_sample_universe(), "growth_mid")
    r = results[0]
    fundamentals = next(p for p in r.breakdown if p.pillar == "fundamentals")
    assert fundamentals.contributions, "fundamentals pillar should have contributions"
    for c in fundamentals.contributions:
        assert c.metric
        assert c.rationale  # always present, even when raw is None


def test_legacy_pillars_keys_for_ui_compat():
    results = score_universe(_sample_universe(), "growth_mid")
    r = results[0]
    # UI still expects this exact shape
    assert set(r.pillars.keys()) == {"fundamentals", "momentum", "sentiment", "filingTone", "insider"}


def test_unknown_profile_falls_back_to_default():
    results = score_universe(_sample_universe(), "not-a-real-profile")
    assert results[0].profile == "growth_mid"


def test_zero_weight_metric_excluded_from_pillar():
    # In "penny" profile, fundamentals.fcf_yield is weight 0 -> shouldn't appear
    results = score_universe(_sample_universe(), "penny")
    fundamentals = next(p for p in results[0].breakdown if p.pillar == "fundamentals")
    metrics_present = {c.metric for c in fundamentals.contributions}
    assert "fcf_yield" not in metrics_present
    # but debt_equity is weight 100 -> should appear
    assert "debt_equity" in metrics_present


def test_serializable_to_dict():
    results = score_universe(_sample_universe(), "growth_mid")
    payload = result_to_dict(results[0])
    assert payload["methodologyVersion"] == METHODOLOGY_VERSION
    assert payload["composite"] == results[0].composite
    assert "breakdown" in payload
    # All breakdown contributions should be plain dicts (JSON-safe)
    for pb in payload["breakdown"]:
        assert isinstance(pb, dict)
        for c in pb["contributions"]:
            assert isinstance(c, dict)


def test_all_profiles_well_formed():
    for name, profile in PROFILES.items():
        assert "label" in profile
        assert "description" in profile
        assert set(profile["pillar_weights"].keys()) == {
            "fundamentals", "momentum", "sentiment", "filings", "insider"
        }, f"{name} missing pillars"
        for pillar, sub in profile["sub_weights"].items():
            assert sum(sub.values()) > 0, f"{name}/{pillar} has all-zero weights"


def test_score_one_against_explicit_peers():
    universe = _sample_universe()
    peers = [m for _, m in universe]
    r = score_one("GROWTHY", universe[1][1], peers, "growth_mid")
    assert 0 <= r.composite <= 100
    assert r.ticker == "GROWTHY"
