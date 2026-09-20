// Google OAuth token storage + refresh + authed fetch.
// Tokens stay server-side. Persistence backends, in order of preference:
//   1. Supabase (SUPABASE_URL + SUPABASE_SERVICE_KEY) — ring_oauth_tokens table
//   2. JSON file (default ~/.ring/tokens.json, override with GOOGLE_TOKEN_FILE)
// Supabase is authoritative when configured; the file is the dev fallback.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { env } = require('./config');

const TOKEN_FILE = env('GOOGLE_TOKEN_FILE') || path.join(os.homedir(), '.ring', 'tokens.json');
const SB_URL = env('SUPABASE_URL');
const SB_KEY = env('SUPABASE_SERVICE_KEY');
const SB_TABLE = 'ring_oauth_tokens';
const USE_SUPABASE = !!(SB_URL && SB_KEY);

const store = new Map(); // userId -> { access_token, refresh_token, expires_at, scope, token_type }

async function sbRequest(pathname, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${pathname}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function loadFromSupabase() {
  const rows = await sbRequest(`/${SB_TABLE}?select=user_id,access_token,refresh_token,expires_at,scope,token_type`);
  for (const row of rows || []) {
    if (row && row.access_token) {
      store.set(row.user_id, {
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        expires_at: Number(row.expires_at) || 0,
        scope: row.scope,
        token_type: row.token_type,
      });
    }
  }
}

function loadFromFile() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) {
      if (v && v.access_token) store.set(k, { ...v, expires_at: v.expires_at || 0 });
    }
  } catch (e) { /* no saved tokens yet */ }
}

async function persistToSupabase() {
  const rows = [];
  for (const [userId, t] of store) {
    rows.push({
      user_id: userId,
      provider: 'google',
      access_token: t.access_token,
      refresh_token: t.refresh_token || null,
      expires_at: t.expires_at || 0,
      scope: t.scope || null,
      token_type: t.token_type || null,
      updated_at: new Date().toISOString(),
    });
  }
  if (!rows.length) return;
  await sbRequest(`/${SB_TABLE}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
}

function persistToFile() {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(Object.fromEntries(store), null, 2), { mode: 0o600 });
  } catch (e) { /* best effort */ }
}

// Boot load: Supabase when configured (fall back to file on error), else file.
const bootLoad = (async () => {
  if (USE_SUPABASE) {
    try {
      await loadFromSupabase();
      return;
    } catch (e) {
      console.error('[google] Supabase token load failed, falling back to file:', e.message);
    }
  }
  loadFromFile();
})();
const ready = () => bootLoad.catch(() => {});

function saveTokens(userId, tok) {
  store.set(userId || 'local', {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
    scope: tok.scope,
    token_type: tok.token_type,
  });
  if (USE_SUPABASE) {
    persistToSupabase().catch(e => console.error('[google] Supabase token save failed:', e.message));
  } else {
    persistToFile();
  }
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

module.exports = { saveTokens, isConnected, getAccessToken, gfetch, ready, usesSupabase: () => USE_SUPABASE };
