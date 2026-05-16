/**
 * Netlify serverless function — Schwab connection status.
 * Returns { connected: bool, expiresAt: number|null } for the frontend.
 */
import { getStore } from '@netlify/blobs';

export default async (_req) => {
  try {
    const store = getStore('schwab-auth');
    const stored = await store.get('tokens', { type: 'json' });

    if (!stored?.access_token) {
      return Response.json({ connected: false, expiresAt: null });
    }

    // Consider "connected" if we have a refresh token within 7-day window
    const { refresh_token, expires_at } = stored;
    const refreshWindow = 7 * 24 * 60 * 60 * 1000;
    const connected = !!refresh_token && Date.now() < (expires_at + refreshWindow);

    return Response.json({ connected, expiresAt: expires_at ?? null });

  } catch {
    // Blobs unavailable (local dev outside netlify dev)
    return Response.json({ connected: false, expiresAt: null });
  }
};
