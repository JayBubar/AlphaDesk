"""Netlify Python function — 10-K NLP filing-tone score.

Lazy endpoint. The frontend calls this when promoting a stock to the watchlist;
running it across the full screening universe would burn EDGAR rate limit and
add multi-second latency to every screen.
"""
import json
import sys
from dataclasses import asdict
from pathlib import Path

# Robust sys.path: scan parent levels until backend/filings is found.
# Netlify's runtime may place the function at the bundle root (parents[0])
# or preserve the repo structure (parents[2]); try both.
_here = Path(__file__).resolve()
for _lvl in range(5):
    try:
        _candidate = _here.parents[_lvl]
    except IndexError:
        break
    if (_candidate / "backend" / "filings" / "__init__.py").exists():
        sys.path.insert(0, str(_candidate))
        break

try:
    from backend.filings import score_filing_tone
    _IMPORT_ERR = None
except Exception as _exc:
    _IMPORT_ERR = str(_exc)


def handler(event, context):
    if _IMPORT_ERR:
        return {
            "statusCode": 500,
            "headers": _headers(),
            "body": json.dumps({"error": f"Import failed: {_IMPORT_ERR}"}),
        }

    # Path comes through as /api/filings/{ticker} -> /.netlify/functions/filings/{ticker}.
    path = event.get("path", "")
    parts = [p for p in path.split("/") if p]
    ticker = parts[-1].upper() if parts else ""

    if not ticker or ticker.lower() == "filings":
        return {
            "statusCode": 400,
            "headers": _headers(),
            "body": json.dumps({"error": "ticker required"}),
        }

    qs = event.get("queryStringParameters") or {}
    refresh = qs.get("refresh") in ("1", "true", "yes")

    try:
        result = score_filing_tone(ticker, force_refresh=refresh)
        return {
            "statusCode": 200,
            "headers": _headers(),
            "body": json.dumps(asdict(result)),
        }
    except Exception as e:
        import traceback
        return {
            "statusCode": 502,
            "headers": _headers(),
            "body": json.dumps({"error": str(e), "trace": traceback.format_exc()}),
        }


def _headers():
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
    }
