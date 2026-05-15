# AlphaDesk — Investment Research Platform

A quantitative + qualitative stock screening and portfolio tracking tool.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite |
| Backend (local) | FastAPI + uvicorn |
| Data | yfinance (free) |
| Production | Netlify (frontend + serverless functions) |
| Fonts | DM Serif Display, DM Mono, Outfit |

---

## Local Development

### Prerequisites
- [Node.js 18+](https://nodejs.org) — LTS version, check "Add to PATH" during install
- [Python 3.10+](https://www.python.org/downloads) — check "Add Python to PATH" during install

### Setup — Windows (first time)

Double-click `setup.bat`, or run in Command Prompt:

```cmd
setup.bat
```

### Setup — Mac / Linux (first time)

```bash
chmod +x setup.sh && ./setup.sh
```

### Start

```cmd
npm run dev
```

This starts both:
- **Frontend** at http://localhost:3000
- **Backend** at http://localhost:8000
- **API docs** at http://localhost:8000/docs (FastAPI Swagger UI)

Vite proxies `/api/*` → `http://localhost:8000` automatically.

---

## Project Structure

```
investment-tool/
├── frontend/
│   ├── index.html
│   └── src/
│       ├── App.jsx             # Root, navigation, watchlist state
│       ├── index.css           # Design tokens (CSS vars)
│       ├── components/
│       │   ├── Nav.jsx/css     # Top navigation bar
│       │   ├── Screener.jsx/css # Pass 1 filters + Pass 2 scoring
│       │   ├── Portfolio.jsx/css # Watchlist + P&L tracker
│       │   └── ScoreBar.jsx/css # Reusable mini score bar
│       └── lib/
│           ├── api.js          # fetch wrappers (local + Netlify)
│           └── scoring.js      # Weight math + formatting helpers
├── backend/
│   ├── main.py                 # FastAPI app with all scoring logic
│   └── requirements.txt
├── netlify/
│   └── functions/
│       ├── screen.py           # Netlify function: screener
│       ├── prices.py           # Netlify function: price refresh
│       └── requirements.txt    # yfinance for Netlify
├── netlify.toml                # Build config + redirects
├── vite.config.js
├── package.json
└── setup.sh
```

---

## Scoring System

Each stock receives a **composite score (0–100)** from five weighted pillars:

| Pillar | What it measures | Default weight |
|---|---|---|
| Fundamentals | P/E, gross margin, FCF, debt/equity, revenue growth | 25% |
| Momentum | 52W position, MA50 vs MA200, price trend | 20% |
| Sentiment | Analyst rating, price target upside, short interest | 20% |
| Filing tone | Audit risk, governance proxies (→ full NLP in v2) | 20% |
| Insider / inst. | Insider ownership %, institutional holding | 15% |

Weights are **user-adjustable** in the UI — drag sliders, must sum to 100.

---

## Deploy to Netlify

### Option A — Netlify CLI

```bash
npm install -g netlify-cli
netlify login
netlify init        # creates a new site
netlify deploy --prod
```

### Option B — Connect GitHub

1. Push to a GitHub repo
2. Log in to netlify.com → "Add new site" → "Import from Git"
3. Set build command: `npm run build`
4. Set publish directory: `dist`
5. Deploy

Netlify auto-detects the Python functions in `netlify/functions/`.

---

## Roadmap

- [ ] SEC EDGAR 10-K reader (NLP filing tone analysis)
- [ ] News + social sentiment via web search
- [ ] Schwab OAuth integration for live portfolio sync
- [ ] Sell signal / hold engine with trailing stops
- [ ] Historical score tracking (score drift over time)
- [ ] Email alerts when composite score drops threshold
