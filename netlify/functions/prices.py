import json, math
import yfinance as yf

def safe(val, default=None):
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return default
    return val

def handler(event, context):
    body = json.loads(event.get("body") or "{}")
    tickers = body.get("tickers", [])
    result = {}
    for ticker in tickers:
        try:
            info = yf.Ticker(ticker).info
            result[ticker] = {
                "price": safe(info.get("currentPrice") or info.get("regularMarketPrice")),
                "change": safe(info.get("regularMarketChangePercent")),
            }
        except:
            result[ticker] = {"price": None, "change": None}
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
        "body": json.dumps(result),
    }
