"""Profile-aware peer-normalized scoring engine.

Workflow:
    1. Adapter converts provider-specific data -> canonical metrics dict.
    2. score_universe() runs across all stocks together so percentile ranks
       are computed within the screening peer set, not against fixed thresholds.
    3. Each ticker gets a ScoreResult with a full breakdown explaining every
       metric's contribution: raw value, peer percentile, weight, rationale.
"""
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone

from .metrics import METRICS, PILLARS
from .profiles import get_profile, DEFAULT_PROFILE
from .normalize import directional_score
from .version import METHODOLOGY_VERSION


@dataclass
class MetricContribution:
    metric: str
    raw: float | None
    score: float | None        # 0..100 directional peer percentile
    weight: float              # within-pillar weight, normalized to sum to 100
    weighted: float | None     # score * (weight / 100)
    rationale: str


@dataclass
class PillarBreakdown:
    pillar: str
    score: float               # 0..100, 50.0 if no metrics scored
    weight: float              # pillar weight from profile (0..100, raw)
    contributions: list[MetricContribution] = field(default_factory=list)


@dataclass
class ScoreResult:
    ticker: str
    profile: str
    composite: int             # 0..100
    pillars: dict              # legacy-compatible {fundamentals, momentum, sentiment, filingTone, insider}
    breakdown: list[PillarBreakdown]
    methodology_version: str
    timestamp: str             # ISO8601 UTC


def _rationale(score: float | None, direction: int) -> str:
    if score is None:
        return "data unavailable"
    # score is already direction-adjusted: high score always = good
    if score >= 80:
        return "top quintile vs peers"
    if score >= 60:
        return "above peer median"
    if score >= 40:
        return "near peer median"
    if score >= 20:
        return "below peer median"
    return "bottom quintile vs peers"


def _normalize_weights(weights: dict) -> dict:
    total = sum(w for w in weights.values() if w > 0)
    if total <= 0:
        return {k: 0.0 for k in weights}
    return {k: (w / total) * 100 if w > 0 else 0.0 for k, w in weights.items()}


def _score_pillar(
    pillar: str,
    metrics_dict: dict,
    universe_metrics: list[dict],
    sub_weights: dict,
) -> PillarBreakdown:
    contributions: list[MetricContribution] = []
    norm_weights = _normalize_weights(sub_weights)

    weighted_sum = 0.0
    weight_sum = 0.0

    for metric_key, raw_weight in sub_weights.items():
        if raw_weight <= 0 or metric_key not in METRICS:
            continue
        spec = METRICS[metric_key]
        peer_values = [m.get(metric_key) for m in universe_metrics if m.get(metric_key) is not None]
        value = metrics_dict.get(metric_key)
        score = directional_score(value, peer_values, spec.direction)
        norm_w = norm_weights.get(metric_key, 0.0)

        contributions.append(MetricContribution(
            metric=metric_key,
            raw=value,
            score=score,
            weight=round(norm_w, 1),
            weighted=round(score * (norm_w / 100), 1) if score is not None else None,
            rationale=_rationale(score, spec.direction),
        ))

        if score is not None:
            weighted_sum += score * raw_weight
            weight_sum += raw_weight

    pillar_score = round(weighted_sum / weight_sum, 1) if weight_sum > 0 else 50.0
    return PillarBreakdown(pillar=pillar, score=pillar_score, weight=0.0, contributions=contributions)


def _score_one_internal(
    ticker: str,
    metrics_dict: dict,
    universe_metrics: list[dict],
    profile_name: str,
) -> ScoreResult:
    profile = get_profile(profile_name)
    pillar_weights = profile["pillar_weights"]
    sub_weights = profile["sub_weights"]

    breakdown: list[PillarBreakdown] = []
    pillar_scores: dict = {}

    for pillar in PILLARS:
        bd = _score_pillar(pillar, metrics_dict, universe_metrics, sub_weights.get(pillar, {}))
        bd.weight = float(pillar_weights.get(pillar, 0))
        breakdown.append(bd)
        pillar_scores[pillar] = bd.score

    total_w = sum(pillar_weights.values()) or 1
    composite = round(sum(pillar_scores[p] * pillar_weights.get(p, 0) for p in PILLARS) / total_w)

    pillars_flat = {
        "fundamentals": pillar_scores.get("fundamentals", 50),
        "momentum":     pillar_scores.get("momentum", 50),
        "sentiment":    pillar_scores.get("sentiment", 50),
        "filingTone":   pillar_scores.get("filings", 50),
        "insider":      pillar_scores.get("insider", 50),
    }

    return ScoreResult(
        ticker=ticker,
        profile=profile_name if profile_name in {"value_long", "growth_mid", "speculative", "penny"} else DEFAULT_PROFILE,
        composite=max(0, min(100, composite)),
        pillars=pillars_flat,
        breakdown=breakdown,
        methodology_version=METHODOLOGY_VERSION,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )


def score_universe(
    stocks: list[tuple],
    profile_name: str = DEFAULT_PROFILE,
) -> list[ScoreResult]:
    """Score a list of (ticker, metrics_dict) tuples against each other as peers."""
    universe_metrics = [m for _, m in stocks]
    return [_score_one_internal(t, m, universe_metrics, profile_name) for t, m in stocks]


def score_one(
    ticker: str,
    metrics_dict: dict,
    peers: list[dict],
    profile_name: str = DEFAULT_PROFILE,
) -> ScoreResult:
    """Score a single ticker against an explicit peer-metrics list."""
    return _score_one_internal(ticker, metrics_dict, peers, profile_name)


def result_to_dict(result: ScoreResult) -> dict:
    """Serialize ScoreResult for JSON output."""
    return {
        "ticker": result.ticker,
        "profile": result.profile,
        "composite": result.composite,
        "pillars": result.pillars,
        "breakdown": [
            {
                "pillar": pb.pillar,
                "score": pb.score,
                "weight": pb.weight,
                "contributions": [asdict(c) for c in pb.contributions],
            }
            for pb in result.breakdown
        ],
        "methodologyVersion": result.methodology_version,
        "timestamp": result.timestamp,
    }
