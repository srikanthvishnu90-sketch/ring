// Google OAuth token storage + refresh + authed fetch.
// Tokens stay server-side. Persistence backends, in order of preference:
//   1. Supabase (SUPABASE_URL + SUPABASE_SERVICE_KEY) — ring_oauth_tokens table
//   2. JSON file (default ~/.ring/tokens.json, override with GOOGLE_TOKEN_FILE)
// Supabase is authoritative when configured; the file is the dev fallback.
//
// MULTI-ACCOUNT SUPPORT: A Ring user can connect multiple Google accounts.
// Primary account: stored under `userId` (backward compat).
// Additional accounts: stored under `userId:google:{email}`.
// Use listGoogleAccounts(userId) to find all connected Google emails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { env } = require('./config');
const { ENABLED: USE_SUPABASE, sbRequest } = require('./supabase');

const TOKEN_FILE = env('GOOGLE_TOKEN_FILE') || path.join(os.homedir(), '.ring', 'tokens.json');
const SB_TABLE = 'ring_oauth_tokens';

const store = new Map(); // userId -> { access_token, refresh_token, expires_at, scope, token_type, googleEmail }

function accountKey(userId, googleEmail) {
  const base = userId || 'local';
  return googleEmail ? `${base}:google:${googleEmail.toLowerCase()}` : base;
}

function parseAccountKey(key) {
  const m = /^(.+):google:(.+)$/.exec(key || '');
  return m ? { ringUserId: m[1], googleEmail: m[2] } : { ringUserId: key, googleEmail: null };
}

async function loadFromSupabase() {
  const rows = await sbRequest(`/${SB_TABLE}?select=user_id,access_token,refresh_token,expires_at,scope,token_type`);
  for (const row of rows || []) {
    if (row && row.access_token) {
      const parsed = parseAccountKey(row.user_id);
      store.set(row.user_id, {
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        expires_at: Number(row.expires_at) || 0,
        scope: row.scope,
        token_type: row.token_type,
        googleEmail: parsed.googleEmail,
        ringUserId: parsed.ringUserId,
      });
    }
  }
}

function loadFromFile() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) {
      if (v && v.access_token) {
        const parsed = parseAccountKey(k);
        store.set(k, { ...v, expires_at: v.expires_at || 0, googleEmail: parsed.googleEmail, ringUserId: parsed.ringUserId });
      }
    }
  } catch (e) { /* no saved tokens yet */ }
}

// Lazy per-user load: picks up rows written by another process (or linked
// manually) without waiting for a restart. Called on cache miss and before
// listing accounts — a warm serverless instance that booted before the
// tokens were saved would otherwise see an empty store.
// Loads the primary row plus any :google: suffixed rows for the user; only
// fills keys missing from the in-memory store so a fresher in-instance
// token (e.g. from an OAuth callback in this process) is never clobbered.
async function ensureUser(userId) {
  const key = userId || 'local';
  if (!USE_SUPABASE) return;
  try {
    // NOTE: the LIKE wildcard MUST be sent as %25. A raw % in the URL is
    // rejected at the edge (Cloudflare 1101) and the miss is silent.
    const rows = await sbRequest(`/${SB_TABLE}?select=user_id,access_token,refresh_token,expires_at,scope,token_type&user_id=like.${encodeURIComponent(key)}%25`);
    for (const row of rows || []) {
      if (row && row.access_token && !store.has(row.user_id)) {
        const parsed = parseAccountKey(row.user_id);
        store.set(row.user_id, {
          access_token: row.access_token,
          refresh_token: row.refresh_token,
          expires_at: Number(row.expires_at) || 0,
          scope: row.scope,
          token_type: row.token_type,
          googleEmail: parsed.googleEmail,
          ringUserId: parsed.ringUserId,
        });
      }
    }
  } catch (e) { console.warn('[ring-google] ensureUser miss:', String((e && e.message) || e).slice(0, 160)); }
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

function saveTokens(userId, tok, googleEmail = null) {
  const key = accountKey(userId, googleEmail);
  const parsed = parseAccountKey(key);
  store.set(key, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
    scope: tok.scope,
    token_type: tok.token_type,
    googleEmail: parsed.googleEmail,
    ringUserId: parsed.ringUserId,
  });
  if (USE_SUPABASE) {
    persistToSupabase().catch(e => console.error('[google] Supabase token save failed:', e.message));
  } else {
    persistToFile();
  }
  return key;
}

function isConnected(userId) {
  const base = userId || 'local';
  // Connected if primary OR any additional Google account exists
  if (store.has(base)) return true;
  for (const key of store.keys()) {
    if (key.startsWith(base + ':google:')) return true;
  }
  return false;
}

// List all Google account emails connected for a Ring user.
// Returns [{ email, key }] — key is the token lookup key for gfetch.
// Async: refreshes the user's rows from Supabase first, so a warm
// serverless instance whose in-memory store predates the token save
// still sees the accounts.
async function listGoogleAccounts(userId) {
  const base = userId || 'local';
  try { await ensureUser(base); } catch (e) { /* fall back to memory */ }
  const accounts = [];
  // Ensure Supabase rows are loaded (lazy)
  for (const [key, t] of store) {
    if (key === base) {
      accounts.push({ email: t.googleEmail || '(primary)', key });
    } else if (key.startsWith(base + ':google:')) {
      const parsed = parseAccountKey(key);
      accounts.push({ email: parsed.googleEmail, key });
    }
  }
  return accounts;
}

// Fetch the Google account email for an access token (used during OAuth
// callback to store multi-account tokens under the composite key).
async function fetchGoogleEmail(accessToken) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Failed to fetch Google profile: ' + r.status);
  return data.emailAddress || null;
}

// Granted OAuth scopes for the stored grant (from the token response's
// `scope` field). Lets the app show what access was actually approved,
// instead of inferring it from a toast.
function getScopes(userId) {
  const t = store.get(userId || 'local');
  return t && t.scope ? String(t.scope).split(' ').filter(Boolean) : [];
}

async function getAccessToken(userId) {
  const key = userId || 'local';
  await ensureUser(key);
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
  // Preserve the composite key structure on refresh: parse the key to get
  // ringUserId and googleEmail, then save with those.
  const parsed = parseAccountKey(key);
  saveTokens(parsed.ringUserId, { ...t, ...nt }, parsed.googleEmail);
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

module.exports = { saveTokens, isConnected, getScopes, getAccessToken, gfetch, ready, ensureUser, listGoogleAccounts, fetchGoogleEmail, accountKey, parseAccountKey, usesSupabase: () => USE_SUPABASE };
