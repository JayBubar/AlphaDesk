"""Netlify Python function — per-ticker historical backtest.

GET /api/backtest/{ticker}            → cached or fresh
GET /api/backtest/{ticker}?refresh=1  → bypass cache and refetch FMP history
"""
import json
import sys
from dataclasses import asdict
from pathlib import Path

_here = Path(__file__).resolve()
for _lvl in range(5):
    try:
        _candidate = _here.parents[_lvl]
    except IndexError:
        break
    if (_candidate / "backend" / "backtest" / "__init__.py").exists():
        sys.path.insert(0, str(_candidate))
        break

try:
    from backend.backtest import run_backtest
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

    path = event.get("path", "")
    parts = [p for p in path.split("/") if p]
    ticker = parts[-1].upper() if parts else ""

    if not ticker or ticker.lower() == "backtest":
        return {
            "statusCode": 400,
            "headers": _headers(),
            "body": json.dumps({"error": "ticker required"}),
        }

    qs = event.get("queryStringParameters") or {}
    refresh = qs.get("refresh") in ("1", "true", "yes")
    profile = qs.get("profile")

    try:
        result = run_backtest(ticker, profile=profile, force_refresh=refresh)
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
