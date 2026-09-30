// backend/lib/browser_driver.js — Tier-2 browser automation driver.
//
// Turns "we held it for approval" into "we actually did it": executes outcome
// jobs (book a ride, book a table, cancel a subscription, ...) inside a real
// browser session hosted by Browserbase, driven over CDP with playwright-core.
//
// ═══════════════════════════════════════════════════════════════════════════
//  THE CHUNKED-PHASE CONTRACT (serverless-safe)
// ═══════════════════════════════════════════════════════════════════════════
//  Each execute(job) call is ONE Vercel invocation and runs ONE phase. A phase
//  never sleeps waiting for a human — it does its unit of work and returns.
//  Multi-step flows (OTP login, estimate -> approval -> book) chain phases:
//  the agent loop re-invokes execute() with the returned sessionId.
//
//  Job in:
//    { kind: 'book-ride' | 'book' | 'cancel' | 'change' | 'cancel-subscription'
//           | 'login-task' | 'form-fill' | 'read' | 'fix-reservation' | ...,
//      site?: 'uber' | 'resy' | ...,   // site module at lib/sites/<site>.js
//      sessionId?: string,             // resume a live session from a prior phase
//      userId?: string,
//      keepAlive?: boolean,            // after a terminal done/failure, leave
//                                      // the session LIVE (e.g. trip tracking
//                                      // after ordering). Caller must close it.
//      ...siteParams }                 // pickup/dropoff, restaurant/date, otp, ...
//
//  Result out (execute() NEVER throws — failures are values):
//    Terminal success — MUST carry a confirmation artifact:
//      { ok:true, phase:'done', sessionId,
//        confirmationRef|reservationId|bookingId|orderId|receiptUrl|cancelRef|ticketId,
//        ...siteFields, steps:[...] }
//    Continuation — session stays LIVE, agent re-invokes with sessionId:
//      { ok:true, phase:'need_otp'|'need_input', sessionId, prompt, fields? }
//      { ok:true, phase:'need_approval', sessionId, summary:{...} }
//    Honest failure — nothing was done, nothing is claimed:
//      { ok:false, code, note, sessionId? }
//      codes: browser_not_configured | bad_job | site_not_implemented |
//             kind_not_implemented | session_not_found | session_expired |
//             session_user_mismatch | no_proof | phase_timeout | browser_failed
//
//  Session lifecycle: created on first phase, persisted to the
//  browser_sessions table (lib/browser_sessions.js), verified alive on
//  resume via the Browserbase API, STOPPED on terminal done/failure so we
//  never leak billed sessions. Continuation phases and timeouts keep it live.
//
//  SECURITY: connect_url is sensitive — stored in Supabase, used for the CDP
//  connect, NEVER logged, NEVER in a result. Credential values / OTPs /
//  cookies are never logged or returned (see sites/_framework.js sanitize).
// ═══════════════════════════════════════════════════════════════════════════
//
// Env: BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID (Vercel env, set by
// Vishnu — never in chat or code). BROWSERBASE_API_BASE overrides the API
// host (tests). BROWSER_PHASE_TIMEOUT_MS caps one phase (default 50000).

const { env, missing } = require('./config');
const framework = require('./sites/_framework');
const sessions = require('./browser_sessions');

const BROWSER_KEYS = ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'];

function keysPresent() {
  return missing(BROWSER_KEYS).length === 0;
}

function bbBase() {
  return env('BROWSERBASE_API_BASE', 'https://api.browserbase.com/v1').replace(/\/+$/, '');
}

function phaseTimeoutMs() {
  const n = Number(env('BROWSER_PHASE_TIMEOUT_MS', '50000'));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 780000) : 50000;
}

// Browserbase REST. The API key travels in the header only — never logged.
async function bbFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${bbBase()}${path}`, {
    method,
    headers: { 'x-bb-api-key': env('BROWSERBASE_API_KEY'), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const err = new Error(`Browserbase ${method} ${path} failed (HTTP ${res.status})`);
    err.code = 'BB_API_ERROR';
    err.httpStatus = res.status;
    throw err;
  }
  return json;
}

async function createBrowserbaseSession() {
  const j = await bbFetch('/sessions', {
    method: 'POST',
    body: { projectId: env('BROWSERBASE_PROJECT_ID') },
  });
  const id = j && j.id;
  const connectUrl = j && (j.connectUrl || j.connect_url);
  if (!id || !connectUrl) throw Object.assign(new Error('Browserbase returned no session id/connectUrl'), { code: 'BB_BAD_RESPONSE' });
  return { id, connectUrl };
}

async function browserbaseSessionAlive(bbSessionId) {
  try {
    await bbFetch(`/sessions/${encodeURIComponent(bbSessionId)}`);
    return true;
  } catch (e) {
    if (e.httpStatus === 404) return false;
    throw e;
  }
}

async function stopBrowserbaseSession(bbSessionId) {
  try {
    await bbFetch(`/sessions/${encodeURIComponent(bbSessionId)}`, { method: 'DELETE' });
  } catch { /* best effort — session may already be gone */ }
}

// Confirmation artifacts — mirrors proofOf() in connectors/outcomes.js.
// A terminal 'done' without one is downgraded to no_proof (brutal honesty).
const PROOF_KEYS = ['confirmationRef', 'reservationId', 'bookingId', 'orderId', 'receiptUrl', 'cancelRef', 'ticketId'];
function proofOf(result) {
  if (!result || typeof result !== 'object') return null;
  for (const k of PROOF_KEYS) {
    if (result[k] != null && String(result[k]).trim() !== '') return String(result[k]);
  }
  return null;
}

const CONTINUATION_PHASES = new Set(['need_otp', 'need_input', 'need_approval']);

function stripSensitive(result) {
  // Defense in depth: even if a site module leaks, the envelope is scrubbed.
  return framework.sanitize(result);
}

// Resolve (or create) the session for this execute() call.
// Returns { session, created } or { error }.
async function resolveSession(job) {
  if (job.sessionId) {
    const rec = await sessions.getForDriver(job.sessionId);
    if (!rec) {
      return { error: { ok: false, code: 'session_not_found', note: `No browser session "${String(job.sessionId).slice(0, 12)}…" — start a fresh job without sessionId.` } };
    }
    if (rec.status !== 'live') {
      return { error: { ok: false, code: 'session_expired', sessionId: job.sessionId, note: `Browser session is ${rec.status} — start a fresh job without sessionId.` } };
    }
    if (job.userId && rec.user_id && job.userId !== rec.user_id) {
      return { error: { ok: false, code: 'session_user_mismatch', note: 'Session belongs to a different user — refusing to resume it.' } };
    }
    let alive;
    try {
      alive = await browserbaseSessionAlive(rec.bb_session_id);
    } catch (e) {
      return { error: { ok: false, code: 'browser_failed', sessionId: job.sessionId, note: `Could not verify session liveness: ${String(e.message).slice(0, 160)}` } };
    }
    if (!alive) {
      try { await sessions.markExpired(job.sessionId); } catch { /* best effort */ }
      return { error: { ok: false, code: 'session_expired', sessionId: job.sessionId, note: 'The browser session ended remotely — start a fresh job without sessionId.' } };
    }
    try { await sessions.touch(job.sessionId); } catch { /* best effort */ }
    return { session: rec, created: false };
  }
  // Fresh session.
  const bb = await createBrowserbaseSession();
  const saved = await sessions.save({
    user_id: job.userId || null,
    site: job._site,
    bb_session_id: bb.id,
    connect_url: bb.connectUrl,
    purpose: job.kind,
  });
  return { session: { ...saved, connect_url: bb.connectUrl, bb_session_id: bb.id }, created: true };
}

async function endSession(sessionId, bbSessionId, terminalStatus = 'closed') {
  try {
    if (bbSessionId) await stopBrowserbaseSession(bbSessionId);
  } finally {
    try { await sessions.setStatus(sessionId, terminalStatus); } catch { /* best effort */ }
  }
}

async function execute(job, deps = {}) {
  const started = Date.now();
  try {
    return await executeInner(job, deps);
  } catch (e) {
    // execute() NEVER throws — every failure is a value.
    const code = (e && e.code) || 'browser_failed';
    return {
      ok: false,
      code: code === 'PLAYWRIGHT_CORE_MISSING' ? 'browser_failed' : code,
      note: `Browser phase failed: ${String((e && e.message) || e).slice(0, 280)}`,
      ...(job && job.sessionId ? { sessionId: job.sessionId } : {}),
      phaseMs: Date.now() - started,
    };
  }
}

async function executeInner(job, deps = {}) {
  // 0. Keys absent -> honest, no throw, no pretend.
  if (!keysPresent()) {
    return { ok: false, code: 'browser_not_configured', missing: missing(BROWSER_KEYS), note: 'Browser automation needs BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID in Vercel env (set by Vishnu). Nothing was attempted.' };
  }
  // 1. Validate the job.
  if (!job || typeof job !== 'object' || typeof job.kind !== 'string' || !job.kind) {
    return { ok: false, code: 'bad_job', note: 'execute(job) requires job.kind (string). Nothing was attempted.' };
  }
  // 2. Resolve the site module BEFORE creating a session (no orphan sessions
  //    for unimplemented sites).
  const loaded = framework.loadSite(job, deps.siteDir);
  if (loaded.error) {
    return stripSensitive({ ...loaded.error, kind: job.kind });
  }
  const jobWithSite = { ...job, _site: loaded.site };
  // 3. Resolve or create the session.
  let session;
  try {
    const r = await resolveSession(jobWithSite);
    if (r.error) return stripSensitive(r.error);
    session = r.session;
  } catch (e) {
    return { ok: false, code: 'browser_failed', note: `Session setup failed: ${String((e && e.message) || e).slice(0, 200)}` };
  }
  const sessionId = session.id;
  // 4. Run ONE phase with a wall-clock budget (serverless-safe).
  let phaseResult;
  const budget = phaseTimeoutMs();
  let onTimeout;
  const timeoutP = new Promise((_, reject) => {
    onTimeout = setTimeout(() => {
      const t = new Error(`Phase exceeded the ${budget}ms budget`);
      t.code = 'PHASE_TIMEOUT';
      reject(t);
    }, budget);
  });
  try {
    phaseResult = await Promise.race([
      framework.runPhase(
        { connectUrl: session.connect_url, job: jobWithSite, siteFn: loaded.fn, site: loaded.site },
        deps,
      ),
      timeoutP,
    ]);
  } catch (e) {
    if (e && e.code === 'PHASE_TIMEOUT') {
      // Keep the session live — the agent can retry the phase.
      try { await sessions.touch(sessionId); } catch { /* best effort */ }
      return { ok: false, code: 'phase_timeout', sessionId, note: `Phase exceeded the ${budget}ms serverless budget; the browser session is still live — retry the phase with sessionId.` };
    }
    if (e && e.code === 'PLAYWRIGHT_CORE_MISSING') {
      await endSession(sessionId, session.bb_session_id);
      return { ok: false, code: 'browser_failed', sessionId, note: 'playwright-core is not installed in backend/ — run `npm install` there. Session closed.' };
    }
    // Unexpected throw mid-phase: screenshot already captured by the
    // framework; close the session to avoid leaking billed time.
    await endSession(sessionId, session.bb_session_id);
    return {
      ok: false, code: (e && e.code) || 'browser_failed', sessionId,
      note: `Browser phase threw: ${String((e && e.message) || e).slice(0, 240)} — session closed, nothing was completed.`,
    };
  } finally {
    clearTimeout(onTimeout);
  }
  // 5. Classify the phase outcome.
  const out = phaseResult && typeof phaseResult === 'object' ? phaseResult : {};
  const phase = out.phase || (out.ok ? 'done' : 'failed');
  if (out.ok && phase === 'done') {
    const proof = proofOf(out);
    if (!proof) {
      await endSession(sessionId, session.bb_session_id);
      return { ok: false, code: 'no_proof', sessionId, note: 'Site module returned phase "done" without a confirmation artifact — treated as NOT done. Session closed.', steps: out.steps || [] };
    }
    if (job.keepAlive) {
      try { await sessions.touch(sessionId); } catch { /* best effort */ }
      return stripSensitive({ ...out, phase: 'done', sessionId, keptAlive: true });
    }
    await endSession(sessionId, session.bb_session_id);
    return stripSensitive({ ...out, phase: 'done', sessionId });
  }
  if (out.ok && CONTINUATION_PHASES.has(phase)) {
    // Session stays LIVE for the next phase.
    try { await sessions.touch(sessionId); } catch { /* best effort */ }
    return stripSensitive({ ...out, phase, sessionId });
  }
  // Explicit failure envelope from the site module (or unknown shape):
  // terminal — close the session, report honestly.
  await endSession(sessionId, session.bb_session_id);
  const failure = out.ok === false
    ? { ok: false, code: out.code || 'browser_failed', note: out.note || 'Site module reported failure.', sessionId }
    : { ok: false, code: 'browser_failed', sessionId, note: `Site module returned an unrecognized envelope (phase "${phase}") — treated as failure.` };
  if (out.steps) failure.steps = out.steps;
  return stripSensitive(failure);
}

// ---- Legacy exports (kept working) ----------------------------------------

// Create a raw session (REST only — no CDP). Used by tooling/scripts.
async function createSession() {
  if (!keysPresent()) throw new Error('BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID are not set');
  const { id, connectUrl } = await createBrowserbaseSession();
  return { id, connectUrl };
}

async function stopSession(id) {
  // Accepts a Browserbase session id; best effort.
  await stopBrowserbaseSession(id);
}

// The driver object consumed by outcomes.setBrowserDriver().
// Always an object now — execute() itself reports browser_not_configured
// when keys are absent (never throws, never pretends).
function createDriver() {
  return { execute, createSession, stopSession, keysPresent };
}

module.exports = { createDriver, createSession, stopSession, keysPresent, execute };
