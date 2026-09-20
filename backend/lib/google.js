// Google OAuth token storage + refresh + authed fetch.
// Tokens stay server-side. In-memory here; persist to Supabase for prod.
const { env } = require('./config');

const store = new Map(); // userId -> { access_token, refresh_token, expires_at }

function saveTokens(userId, tok) {
  store.set(userId || 'local', {
    ...tok,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
  });
}

function isConnected(userId) {
  return store.has(userId || 'local');
}

async function getAccessToken(userId) {
  const key = userId || 'local';
  const t = store.get(key);
  if (!t) throw new Error('Google not connected — visit /auth/google to connect');
  if (Date.now() < t.expires_at - 60000) return t.access_token;
  if (!t.refresh_token) throw new Error('Google token expired — reconnect via /auth/google');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const nt = await r.json();
  if (!r.ok) throw new Error('Google token refresh failed: ' + (nt.error_description || r.status));
  saveTokens(key, { ...t, ...nt });
  return store.get(key).access_token;
}

async function gfetch(userId, url, opts = {}) {
  const token = await getAccessToken(userId);
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google API ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

module.exports = { saveTokens, isConnected, getAccessToken, gfetch };
