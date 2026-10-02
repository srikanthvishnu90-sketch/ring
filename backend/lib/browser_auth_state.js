// backend/lib/browser_auth_state.js — Per-user persistent browser auth state.
//
// Instinct-parity: the user's logins (Google, etc.) persist across browser
// sessions. Each authenticated user gets ONE auth state blob: the Playwright
// storageState (cookies + localStorage) from their browser sessions.
//
// Security:
// - The blob is AES-256-GCM encrypted with BROWSER_AUTH_KEY before storage.
// - Stored in Supabase table browser_auth_states (service_role only) when
//   configured; otherwise ~/.ring/auth_states/<userId>.enc on disk.
// - Values are NEVER logged. getAuthState returns the decrypted object only
//   to the browser session driver (server-side).
// - Users can wipe their state via clearAuthState (e.g. "log me out everywhere").

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ENABLED, sbRequest, eq } = require('./supabase');

const TABLE = 'browser_auth_states';
const ALGO = 'aes-256-gcm';

function getKey() {
  const raw = process.env.BROWSER_AUTH_KEY;
  if (!raw) {
    throw new Error(
      'BROWSER_AUTH_KEY is not set. Set it to a 32+ char secret in Vercel env ' +
      '(used to encrypt persisted browser auth state).'
    );
  }
  // Derive a 32-byte key from the secret.
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
  const key = getKey();
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ─── Filesystem fallback ────────────────────────────────────────────

function fsPath(userId) {
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(os.homedir(), '.ring', 'auth_states', `${safe}.enc`);
}

async function fsSave(userId, encrypted) {
  const p = fsPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, encrypted, { mode: 0o600 });
}

async function fsLoad(userId) {
  const p = fsPath(userId);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

async function fsClear(userId) {
  const p = fsPath(userId);
  try { fs.unlinkSync(p); } catch {}
}

// ─── Public API ─────────────────────────────────────────────────────

// Save the Playwright storageState object for a user (encrypted).
async function saveAuthState(userId, storageState) {
  if (!userId) throw new Error('saveAuthState: userId required');
  if (!storageState || typeof storageState !== 'object') {
    throw new Error('saveAuthState: storageState must be an object');
  }
  const plaintext = JSON.stringify(storageState);
  const encrypted = encrypt(plaintext);

  if (!ENABLED) {
    await fsSave(userId, encrypted);
    return { ok: true, backend: 'fs' };
  }
  const now = new Date().toISOString();
  // Upsert on user_id.
  await sbRequest(`/${TABLE}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      user_id: userId,
      encrypted_state: encrypted,
      updated_at: now,
    }),
  });
  return { ok: true, backend: 'supabase' };
}

// Load and decrypt the storageState for a user. Returns null if none.
async function loadAuthState(userId) {
  if (!userId) return null;
  let encrypted = null;
  if (!ENABLED) {
    encrypted = await fsLoad(userId);
  } else {
    const rows = await sbRequest(
      `/${TABLE}?user_id=eq.${eq(userId)}&select=encrypted_state`
    );
    encrypted = rows && rows[0] ? rows[0].encrypted_state : null;
  }
  if (!encrypted) return null;
  try {
    return JSON.parse(decrypt(encrypted));
  } catch (e) {
    console.log('[browser_auth_state] decrypt/parse failed (non-fatal):', e.message);
    return null;
  }
}

// Wipe a user's persisted auth state.
async function clearAuthState(userId) {
  if (!userId) return { ok: false };
  if (!ENABLED) {
    await fsClear(userId);
    return { ok: true, backend: 'fs' };
  }
  await sbRequest(`/${TABLE}?user_id=eq.${eq(userId)}`, { method: 'DELETE' });
  return { ok: true, backend: 'supabase' };
}

// Presence check (for status screens) — never touches values.
async function hasAuthState(userId) {
  if (!userId) return false;
  if (!ENABLED) return fs.existsSync(fsPath(userId));
  const rows = await sbRequest(
    `/${TABLE}?user_id=eq.${eq(userId)}&select=user_id`
  );
  return Boolean(rows && rows.length);
}

module.exports = {
  saveAuthState,
  loadAuthState,
  clearAuthState,
  hasAuthState,
};
