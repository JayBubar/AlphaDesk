/**
 * Shared Schwab OAuth token getter/refresher.
 * Reads stored tokens from Netlify Blobs and auto-refreshes when expired.
 * Returns null if no tokens are stored (user hasn't connected Schwab yet).
 */
import { getStore } from '@netlify/blobs';

const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const BLOB_KEY  = 'tokens';
const STORE_NAME = 'schwab-auth';

export async function getSchwabToken() {
  try {
    const store = getStore(STORE_NAME);
    const stored = await store.get(BLOB_KEY, { type: 'json' });
    if (!stored) return null;

    const { access_token, refresh_token, expires_at } = stored;

    // Still valid (with 60 s buffer)
    if (Date.now() < expires_at - 60_000) {
      return access_token;
    }

    // Attempt refresh
    const clientId     = process.env.SCHWAB_CLIENT_ID;
    const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
    if (!clientId || !clientSecret || !refresh_token) return null;

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: {
        Authorization:  `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token,
      }),
    });

    if (!res.ok) {
      // Refresh token expired — clear stored tokens so status shows disconnected
      await store.delete(BLOB_KEY);
      return null;
    }

    const data = await res.json();
    const newTokens = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token || refresh_token,
      expires_at:    Date.now() + (data.expires_in || 1800) * 1000,
    };

    await store.set(BLOB_KEY, JSON.stringify(newTokens));
    return newTokens.access_token;

  } catch {
    // Blobs not available in this environment (local dev outside netlify dev)
    return null;
  }
}
