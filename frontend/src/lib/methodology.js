/**
 * Single source of truth for metric and pillar definitions.
 *
 * Used by:
 *   - ScoreExplainer.jsx (inline tooltips in the expanded row)
 *   - public/methodology.html (full downloadable doc — keep in sync by hand
 *     until we wire a build step that generates it from this file)
 */

export const PILLAR_DEFS = {
  fundamentals: {
    label: 'Fundamentals',
    summary:
      'Is the underlying business healthy and reasonably valued? ' +
      'Combines profitability, leverage, and valuation metrics.',
    why:
      'Fundamentals separate companies that make real money from ones that ' +
      'survive on storytelling. Even if everything else looks great, weak ' +
      'fundamentals make a stock fragile under any market stress.',
  },
  momentum: {
    label: 'Momentum',
    summary:
      'Where is the stock in its recent trading range, and which way is ' +
      'price drifting?',
    why:
      'Markets are not perfectly efficient — winners tend to keep winning ' +
      'for stretches, and beaten-down stocks can keep falling. Momentum ' +
      'captures this drift without becoming a pure trend-chase.',
  },
  sentiment: {
    label: 'Sentiment',
    summary:
      'What does the rest of the market think? Aggregates analyst targets, ' +
      'short interest, and AI-summarized news sentiment.',
    why:
      'Markets are a voting machine in the short term. If everyone hates a ' +
      'name, the price reflects that — and a fundamentals-only view will ' +
      "miss the catalyst when sentiment flips. Inversely, crowded longs " +
      'can disappoint when news turns.',
  },
  filings: {
    label: 'Filings tone',
    summary:
      'How is management writing about the business? Compares year-over-year ' +
      'language in the 10-K Risk Factors and MD&A sections.',
    why:
      "Management's word choice is signal. When 'Risk Factors' get heavier " +
      "year-over-year, or hedging phrases ('subject to', 'no assurance') " +
      'multiply, the people running the company are quietly telling you ' +
      "something the press release didn't.",
  },
  insider: {
    label: 'Insider activity',
    summary:
      'Open-market buys vs sales by company insiders over the last 90 days, ' +
      'sourced from SEC Form 4 filings.',
    why:
      'Officers and directors have a hundred reasons to sell (taxes, ' +
      'diversification, kids in college). They have exactly one reason to ' +
      'buy: they think the stock goes up. Net buying — especially clustered ' +
      'and at meaningful dollar size — is one of the cleanest signals ' +
      "available because it's the people closest to the actual numbers.",
  },
}

export const METRIC_DEFS = {
  pe: {
    label: 'P/E ratio',
    pillar: 'fundamentals',
    direction: 'lower-better',
    summary: 'Price divided by trailing twelve-month earnings.',
    why:
      'How much you pay for each dollar of profit. A P/E of 15 means you ' +
      "wait 15 years (at today's earnings) to recoup your purchase. " +
      'Lower-is-better with the giant caveat that growth companies command ' +
      'higher multiples for a reason.',
  },
  fcf_yield: {
    label: 'FCF yield',
    pillar: 'fundamentals',
    direction: 'higher-better',
    summary: 'Free cash flow per share divided by share price.',
    why:
      "Cash you'd theoretically receive if the company paid out all its " +
      'free cash. The gold standard of valuation because — unlike earnings ' +
      'or revenue — it is almost impossible to fake. Currently null in ' +
      'our pipeline; planned upgrade.',
  },
  roic: {
    label: 'ROIC (proxy: ROE)',
    pillar: 'fundamentals',
    direction: 'higher-better',
    summary: 'Return on equity — net income divided by shareholder equity.',
    why:
      "Measures how efficiently the company turns its capital into profit. " +
      'A 25% ROE means every dollar of equity throws off 25 cents of ' +
      'profit per year. The proxy we use (ROE) is imperfect — true ROIC ' +
      'would adjust for debt and operating leases — but the direction is ' +
      'reliable.',
  },
  gross_margin: {
    label: 'Gross margin',
    pillar: 'fundamentals',
    direction: 'higher-better',
    summary: 'Gross profit divided by revenue.',
    why:
      'The most pricing-power-y metric in fundamental analysis. A 65% gross ' +
      'margin company has structural advantages (brand, network effects, ' +
      "patents) that a 20% gross margin company doesn't. Margins are sticky " +
      'so this is a strong moat indicator.',
  },
  debt_equity: {
    label: 'Debt / equity',
    pillar: 'fundamentals',
    direction: 'lower-better',
    summary: 'Total debt divided by shareholder equity.',
    why:
      "Leverage. A little debt is fine — it's cheap capital. Too much and " +
      "the company can't survive a downturn. Above 2.0 means more debt " +
      'than equity, which historically correlates with worse drawdowns.',
  },
  price_position_52w: {
    label: '52-week position',
    pillar: 'momentum',
    direction: 'higher-better',
    summary:
      'Where the current price sits in the 52-week high-to-low range. ' +
      '0 = at lows, 1 = at highs.',
    why:
      'Stocks near 52-week highs tend to keep working (institutional ' +
      "comfort, momentum traders pile in). Stocks near 52-week lows aren't " +
      'automatically bargains — they may have broken below technical ' +
      'support for fundamental reasons.',
  },
  ma_trend: {
    label: 'Moving average trend',
    pillar: 'momentum',
    direction: 'higher-better',
    summary:
      'Whether price > 50-day MA > 200-day MA (uptrend), the reverse ' +
      '(downtrend), or mixed (sideways).',
    why:
      "The classic 'price above all moving averages' setup that " +
      'institutional rotation strategies use. Captures medium-term ' +
      'directional bias without overreacting to single-day noise.',
  },
  price_change: {
    label: 'Recent price change',
    pillar: 'momentum',
    direction: 'higher-better',
    summary: 'Percent change over the latest available window.',
    why:
      "Short-term momentum complement to the longer-window indicators. " +
      'When all three momentum signals agree, the trend is durable; ' +
      'when they disagree, you may be catching a turning point.',
  },
  analyst_upside: {
    label: 'Analyst upside',
    pillar: 'sentiment',
    direction: 'higher-better',
    summary:
      'Percent gap between the average Wall Street price target and the ' +
      'current price.',
    why:
      "Sell-side analysts are wrong as often as they're right, but their " +
      'consensus target is a useful anchor. Large positive upside = ' +
      'analysts think the market is mispricing the stock low. Large ' +
      'negative upside = even the cheerleaders think this is expensive.',
  },
  short_interest: {
    label: 'Short interest',
    pillar: 'sentiment',
    direction: 'lower-better',
    summary: 'Shares sold short as a percentage of float.',
    why:
      "Smart money's bearish bet against the stock. >5% short interest " +
      "means meaningful skepticism; >15% can either be a coiled spring " +
      '(short squeeze) or a real warning (shorts often catch problems first). ' +
      'Lower-is-better in the default direction but worth tracking either way.',
  },
  recommendation: {
    label: 'Analyst consensus',
    pillar: 'sentiment',
    direction: 'higher-better',
    summary:
      'Buy/hold/sell consensus, AI-aggregated from recent analyst notes ' +
      'via Perplexity.',
    why:
      'Crude but real: a strong-buy consensus reflects updated information ' +
      "from many analysts. Treat it as a sanity check, not a decision rule." +
      ' Populated only when you research a ticker (or the nightly cron does).',
  },
  sentiment_score: {
    label: 'News sentiment',
    pillar: 'sentiment',
    direction: 'higher-better',
    summary:
      'Overall bullish/neutral/bearish read on the last 90 days of news, ' +
      'AI-summarized via Perplexity.',
    why:
      "Captures the tone of recent media coverage. A name with strong " +
      'fundamentals but uniformly negative recent press deserves more ' +
      'scrutiny than the screener alone would suggest. Populated only ' +
      'after research is run.',
  },
  filing_drift: {
    label: '10-K language drift',
    pillar: 'filings',
    direction: 'lower-better',
    summary:
      'TF-IDF cosine drift between this year and last year for the ' +
      'Risk Factors + MD&A sections. 0 = identical, 100 = totally different.',
    why:
      "Companies recycle most of their 10-K language verbatim. When they " +
      "don't — when this year's Risk Factors are written from scratch — " +
      'something material changed in their assessment of the business. ' +
      'High drift is a flag to read the actual filing.',
  },
  hedging_delta: {
    label: 'Hedging language',
    pillar: 'filings',
    direction: 'lower-better',
    summary:
      "Year-over-year change in the frequency of hedging phrases " +
      "('no assurance', 'subject to', 'we may not', etc.) per 1,000 words.",
    why:
      "When management starts hedging more in writing, they're often " +
      'preparing the disclosure ground for bad news. A rising hedging ' +
      'frequency is a quiet warning that often precedes guidance cuts ' +
      'or restructurings.',
  },
  insider_activity: {
    label: 'Insider buy/sell ratio',
    pillar: 'insider',
    direction: 'higher-better',
    summary:
      'Open-market buys vs sales over the last 90 days, blended 60/40 ' +
      'between transaction count and dollar value.',
    why:
      'See the pillar overview. The blend prevents one giant CEO sale ' +
      'from drowning out a chorus of smaller director buys, and vice versa.',
  },
  insider_pct: {
    label: 'Insider ownership',
    pillar: 'insider',
    direction: 'higher-better',
    summary: 'Percent of shares outstanding held by insiders.',
    why:
      "Skin in the game. Managers who personally own meaningful equity " +
      'tend to behave more like owners. Currently null in our pipeline; ' +
      'requires FMP institutional ownership tier.',
  },
  inst_pct: {
    label: 'Institutional ownership',
    pillar: 'insider',
    direction: 'higher-better',
    summary: 'Percent of shares outstanding held by institutions.',
    why:
      "Smart money concentration. High institutional ownership signals " +
      "that professionals have vetted this name; very high can also " +
      'signal crowding risk. Currently null in our pipeline.',
  },
}
