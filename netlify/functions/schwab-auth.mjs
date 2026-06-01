/**
 * Netlify serverless function — Schwab OAuth 2.0 Authorization Code flow.
 *
 * GET /api/schwab-auth          → redirects browser to Schwab authorization page
 * GET /api/schwab-auth?code=... → receives callback, exchanges code for tokens,
 *                                  stores in Netlify Blobs, redirects to /?schwab=connected
 */
import { getStore } from '@netlify/blobs';

const AUTH_URL  = 'https://api.schwabapi.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const BLOB_KEY  = 'tokens';

export default async (req) => {
  const url          = new URL(req.url);
  const code         = url.searchParams.get('code');
  const clientId     = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  // Must match the Callback URL registered in the Schwab developer portal exactly
  const redirectUri  = process.env.SCHWAB_REDIRECT_URI
    || 'https://alphadesk-app.netlify.app/callback';

  if (!clientId || !clientSecret) {
    return new Response(
      'SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET env vars not set.',
      { status: 500 },
    );
  }

  // ── Step 1: No code — start the OAuth flow ───────────────────────────────
  if (!code) {
    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    // scope=readonly is largely cosmetic in Schwab's OAuth — the actual
    // permissions come from the product entitlements attached to the app
    // (Market Data Production + Accounts and Trading Production). We send
    // it anyway as good OAuth hygiene; harmless if ignored.
    authUrl.searchParams.set('scope', 'readonly');
    return Response.redirect(authUrl.toString(), 302);
  }

  // ── Step 2: Code received — exchange for tokens ──────────────────────────
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: {
        Authorization:  `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return new Response(`Token exchange failed (${res.status}): ${body}`, { status: 502 });
    }

    const data = await res.json();
    const tokens = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + (data.expires_in || 1800) * 1000,
    };

    const store = getStore('schwab-auth');
    await store.set(BLOB_KEY, JSON.stringify(tokens));

    // Response.redirect requires an absolute URL in server-side context
    const origin = url.origin;
    return Response.redirect(`${origin}/?schwab=connected`, 302);

  } catch (err) {
    return new Response(`Internal error: ${err.message}`, { status: 500 });
  }
};
