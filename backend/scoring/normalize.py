"""Peer-percentile normalization. Pure stdlib, no NumPy."""


def percentile_rank(value, peers: list) -> float | None:
    """Return 0..100 percentile rank of `value` within `peers`.

    Uses the midrank definition: (#below + 0.5 * #equal) / total. This avoids
    ties always landing on the extremes (0 or 100). None values in `peers`
    are filtered out before ranking. Returns None if value is None or no
    valid peers exist.
    """
    if value is None:
        return None
    cleaned = [p for p in peers if p is not None]
    if not cleaned:
        return None
    below = sum(1 for p in cleaned if p < value)
    equal = sum(1 for p in cleaned if p == value)
    return round(((below + 0.5 * equal) / len(cleaned)) * 100, 1)


def directional_score(value, peers: list, direction: int) -> float | None:
    """Convert raw metric to a 0..100 score using peer percentile.

    direction +1: higher value is better -> percentile as-is
    direction -1: lower value is better  -> 100 - percentile
    """
    pct = percentile_rank(value, peers)
    if pct is None:
        return None
    return pct if direction >= 0 else round(100 - pct, 1)
