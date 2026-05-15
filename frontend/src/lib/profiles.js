// Mirror of backend/scoring/profiles.py for UI labelling.
// The actual scoring math runs server-side; this file only powers the dropdown
// and the "what does this profile mean" copy in the Screener.

export const PROFILES = {
  value_long: {
    label: 'Value / Long-Term',
    short: 'Value',
    description: 'Heavy fundamentals (FCF, ROIC, balance sheet). De-emphasizes momentum and sentiment.',
    pillarWeights: { fundamentals: 45, momentum: 10, sentiment: 10, filings: 25, insider: 10 },
  },
  growth_mid: {
    label: 'Growth / Mid-Term',
    short: 'Growth',
    description: 'Balanced fundamentals + momentum. The default lens for quality compounders.',
    pillarWeights: { fundamentals: 30, momentum: 30, sentiment: 20, filings: 15, insider: 5 },
  },
  speculative: {
    label: 'Speculative / Short-Term',
    short: 'Spec',
    description: 'Heavy momentum and sentiment. Fundamentals reduced to a sanity check.',
    pillarWeights: { fundamentals: 10, momentum: 40, sentiment: 35, filings: 5, insider: 10 },
  },
  penny: {
    label: 'Penny Stock',
    short: 'Penny',
    description: 'Sentiment-first. Story and flow dominate; fundamentals reduced to a survival check.',
    pillarWeights: { fundamentals: 5, momentum: 15, sentiment: 70, filings: 5, insider: 5 },
  },
}

export const DEFAULT_PROFILE = 'growth_mid'

export const PROFILE_KEYS = Object.keys(PROFILES)

export function getProfile(key) {
  return PROFILES[key] || PROFILES[DEFAULT_PROFILE]
}
