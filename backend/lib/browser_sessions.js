// backend/lib/browser_sessions.js — persistence for tier-2 browser sessions.
//
// One row per Browserbase session so chunked multi-phase jobs (OTP login,
// estimate -> approval -> book) can resume the same live browser across
// separate serverless invocations. Supabase (PostgREST, service_role) when
// SUPABASE_URL + SUPABASE_SERVICE_KEY are set; otherwise an in-memory Map
// (local dev / tests). The table is browser_sessions (migration-005.sql).
//
// SECURITY: connect_url is sensitive. getForDriver() is the ONLY read that
// returns it, and it is for the driver's CDP connect only — it must never be
// logged or placed in a tool result. All other reads strip it.

const { ENABLED, sbRequest, eq } = require('./supabase');

const TABLE = 'browser_sessions';

// In-memory fallback (no Supabase configured).
const mem = new Map();

function rowToPublic(r) {
  if (!r) return null;
  const { connect_url, ...rest } = r;
  return rest;
}

async function save(rec) {
  // rec: { user_id, site, bb_session_id, connect_url, purpose }
  const row = {
    user_id: rec.user_id || null,
    site: rec.site,
    bb_session_id: rec.bb_session_id,
    connect_url: rec.connect_url,
    status: 'live',
    purpose: rec.purpose || null,
  };
  if (!ENABLED) {
    const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const full = { id, ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    mem.set(id, full);
    return rowToPublic(full);
  }
  const rows = await sbRequest(`/${TABLE}`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  return rowToPublic(rows && rows[0]);
}

async function get(id) {
  if (!ENABLED) return rowToPublic(mem.get(id) || null);
  const rows = await sbRequest(`/${TABLE}?id=eq.${eq(id)}&select=*`);
  return rowToPublic((rows && rows[0]) || null);
}

// Driver-internal read: includes connect_url for the CDP connect. NEVER log it.
async function getForDriver(id) {
  if (!ENABLED) return mem.get(id) || null;
  const rows = await sbRequest(`/${TABLE}?id=eq.${eq(id)}&select=*`);
  return (rows && rows[0]) || null;
}

async function touch(id) {
  const now = new Date().toISOString();
  if (!ENABLED) {
    const r = mem.get(id);
    if (r) r.updated_at = now;
    return;
  }
  await sbRequest(`/${TABLE}?id=eq.${eq(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ updated_at: now }),
  });
}

async function setStatus(id, status) {
  const now = new Date().toISOString();
  if (!ENABLED) {
    const r = mem.get(id);
    if (r) { r.status = status; r.updated_at = now; }
    return;
  }
  await sbRequest(`/${TABLE}?id=eq.${eq(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, updated_at: now }),
  });
}

async function close(id) {
  return setStatus(id, 'closed');
}

async function markExpired(id) {
  return setStatus(id, 'expired');
}

// Live sessions for a user+site (for status screens / cleanup). connect_url stripped.
async function listLive(userId) {
  if (!ENABLED) {
    return [...mem.values()]
      .filter((r) => r.status === 'live' && (!userId || r.user_id === userId))
      .map(rowToPublic);
  }
  const q = userId
    ? `/${TABLE}?status=eq.live&user_id=eq.${eq(userId)}&select=id,user_id,site,status,purpose,created_at,updated_at&order=created_at.desc`
    : `/${TABLE}?status=eq.live&select=id,user_id,site,status,purpose,created_at,updated_at&order=created_at.desc`;
  return (await sbRequest(q)) || [];
}

module.exports = { save, get, getForDriver, touch, close, markExpired, listLive };
