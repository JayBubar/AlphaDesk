"""TF-IDF cosine drift between two text documents. Pure stdlib.

Used to measure year-over-year language change in 10-K sections. Low cosine
similarity = bigger language shift = potential signal worth surfacing.
"""
import math
import re
from collections import Counter


_WORD_RE = re.compile(r"[a-z]{2,}")  # only ASCII letter tokens of length 2+

# Standard English stopword list (concise, ~80 terms).
STOPWORDS = frozenset("""
a an and are as at be been being but by can do does for from had has have he her him his
how i in is it its like may might more most no nor not of on or other our she so some such
than that the their them then there these they this those to too up was we were what when
where which while who whom why will with would you your yours including such would shall
""".split())


def tokenize(text: str) -> list[str]:
    return [t for t in _WORD_RE.findall(text.lower()) if t not in STOPWORDS]


def _term_frequency(tokens: list[str]) -> dict:
    if not tokens:
        return {}
    counts = Counter(tokens)
    total = len(tokens)
    return {term: c / total for term, c in counts.items()}


def _inverse_document_frequency(docs: list[list[str]]) -> dict:
    n = len(docs)
    if n == 0:
        return {}
    df = Counter()
    for doc in docs:
        df.update(set(doc))
    # Smoothed IDF: log((1 + n) / (1 + df)) + 1
    return {term: math.log((1 + n) / (1 + count)) + 1 for term, count in df.items()}


def _tfidf_vector(tokens: list[str], idf: dict) -> dict:
    tf = _term_frequency(tokens)
    return {term: w * idf.get(term, 0) for term, w in tf.items()}


def _cosine(a: dict, b: dict) -> float:
    if not a or not b:
        return 0.0
    common = set(a) & set(b)
    dot = sum(a[t] * b[t] for t in common)
    norm_a = math.sqrt(sum(v * v for v in a.values()))
    norm_b = math.sqrt(sum(v * v for v in b.values()))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def cosine_similarity(text_a: str, text_b: str) -> float:
    """Return cosine similarity in [0, 1]. 1 = identical, 0 = no overlap."""
    tokens_a = tokenize(text_a)
    tokens_b = tokenize(text_b)
    if not tokens_a or not tokens_b:
        return 0.0
    idf = _inverse_document_frequency([tokens_a, tokens_b])
    vec_a = _tfidf_vector(tokens_a, idf)
    vec_b = _tfidf_vector(tokens_b, idf)
    return _cosine(vec_a, vec_b)


def drift_score(text_current: str, text_prior: str) -> float:
    """Return 0..100 drift score: 100 = totally different, 0 = identical."""
    sim = cosine_similarity(text_current, text_prior)
    return round((1 - sim) * 100, 1)
