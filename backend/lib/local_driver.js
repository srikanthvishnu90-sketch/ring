// backend/lib/local_driver.js — Ring's LOCAL browser driver.
//
// Same execute(job) interface as browser_driver.js (Browserbase), but drives a
// local Chromium from the ms-playwright cache instead of a cloud session.
// This is how Ring opens its own browser for development and testing —
// no Browserbase keys needed. Production (Vercel) uses browser_driver.js.
//
// Session model: one persistent Chromium process; each logical session is a
// dedicated browser CONTEXT (cookies/storage persist across phases, so
// login -> OTP -> action flows work). Contexts are held in memory and closed
// on terminal done/failure (unless job.keepAlive).
//
// Security: mirrors browser_driver.js — execute() never throws, results are
// sanitized, credentials never logged or returned.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const framework = require('./sites/_framework');

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';

// Proof keys mirror browser_driver.js / outcomes.js proofOf().
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
  return framework.sanitize(result);
}

// ---- Chromium discovery -------------------------------------------------
function findChromium() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const d of fs.readdirSync(base)) {
      if (d.startsWith('chromium-') && !d.includes('headless_shell')) {
        const p = path.join(base, d, 'chrome-linux', 'chrome');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch { /* no cache dir */ }
  return null;
}

// ---- Persistent browser + in-memory sessions -----------------------------
let _browser = null;
let _launching = null;
let _relayServer = null;
const _sessions = new Map(); // sessionId -> { context, createdAt, lastTouch }

// CONNECT relay: the sandbox egress proxy drops Chromium's direct CONNECTs
// (ERR_EMPTY_RESPONSE). An in-process relay on loopback forwards them to the
// egress proxy, which answers. (Pattern from sporve-agent-clone ci-browse.mjs.)
async function startRelay() {
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyServer) return null;
  let upstreamHost = null, upstreamPort = 3128;
  try {
    const u = new URL(proxyServer);
    upstreamHost = u.hostname;
    upstreamPort = Number(u.port) || 3128;
  } catch { return null; }
  if (!upstreamHost) return null;
  const net = require('net');
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    let up = null, sent = false;
    client.on('data', (c) => {
      if (!sent) {
        buf = Buffer.concat([buf, c]);
        if (buf.includes('\r\n\r\n')) {
          sent = true;
          const head = buf;
          up = net.connect(upstreamPort, upstreamHost, () => up.write(head));
          up.on('data', (d) => client.write(d));
          up.on('error', () => client.destroy());
          up.on('close', () => client.end());
        }
      } else if (up) {
        up.write(c);
      }
    });
    client.on('error', () => { if (up) up.destroy(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

async function getBrowser() {
  if (_browser) return _browser;
  if (_launching) return _launching;
  _launching = (async () => {
    let pw;
    try {
      pw = require('playwright-core');
    } catch {
      const err = new Error('playwright-core is not installed — run `npm install` in backend/');
      err.code = 'PLAYWRIGHT_CORE_MISSING';
      throw err;
    }
    const exe = findChromium();
    if (!exe) {
      const err = new Error('No local Chromium found in ~/.cache/ms-playwright');
      err.code = 'NO_LOCAL_CHROMIUM';
      throw err;
    }
    const launchOpts = { executablePath: exe, headless: true };
    const relay = await startRelay();
    if (relay) {
      _relayServer = relay.server;
      launchOpts.proxy = {
        server: `http://127.0.0.1:${relay.port}`,
        bypass: process.env.NO_PROXY || process.env.no_proxy || 'localhost,127.0.0.1',
      };
      launchOpts.ignoreHTTPSErrors = true;
    }
    _browser = await pw.chromium.launch(launchOpts);
    // Tag contexts to ignore HTTPS errors when relaying through the MITM proxy.
    _browser._relayActive = !!relay;
    return _browser;
  })();
  try {
    return await _launching;
  } finally {
    _launching = null;
  }
}

async function resolveSession(job) {
  if (job.sessionId) {
    const s = _sessions.get(job.sessionId);
    if (!s) {
      return { error: { ok: false, code: 'session_not_found', note: `No local browser session "${String(job.sessionId).slice(0, 16)}…" — start a fresh job without sessionId.` } };
    }
    s.lastTouch = Date.now();
    return { session: s, created: false };
  }
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: MOBILE_UA,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    // Relay goes through the sandbox MITM proxy — accept its CA.
    ...(browser._relayActive ? { ignoreHTTPSErrors: true } : {}),
  });
  const sessionId = `local-${randomUUID().slice(0, 8)}`;
  const rec = { id: sessionId, context, createdAt: Date.now(), lastTouch: Date.now(), userId: job.userId || null };
  _sessions.set(sessionId, rec);
  return { session: rec, created: true };
}

async function closeSession(sessionId) {
  const s = _sessions.get(sessionId);
  if (!s) return;
  _sessions.delete(sessionId);
  try { await s.context.close(); } catch { /* best effort */ }
}

// ---- execute() -----------------------------------------------------------
async function execute(job, deps = {}) {
  const started = Date.now();
  try {
    return await executeInner(job, deps);
  } catch (e) {
    const code = (e && e.code) || 'browser_failed';
    return {
      ok: false, code,
      note: `Local browser phase failed: ${String((e && e.message) || e).slice(0, 280)}`,
      ...(job && job.sessionId ? { sessionId: job.sessionId } : {}),
      phaseMs: Date.now() - started,
    };
  }
}

async function executeInner(job, deps = {}) {
  // 1. Validate the job.
  if (!job || typeof job !== 'object' || typeof job.kind !== 'string' || !job.kind) {
    return { ok: false, code: 'bad_job', note: 'execute(job) requires job.kind (string). Nothing was attempted.' };
  }
  // 2. Resolve the site module BEFORE creating a session.
  const loaded = framework.loadSite(job, deps.siteDir);
  if (loaded.error) {
    return stripSensitive({ ...loaded.error, kind: job.kind });
  }
  const jobWithSite = { ...job, _site: loaded.site };
  // 3. Resolve or create the local session.
  let session;
  try {
    const r = await resolveSession(jobWithSite);
    if (r.error) return stripSensitive(r.error);
    session = r.session;
  } catch (e) {
    return { ok: false, code: e.code || 'browser_failed', note: `Local session setup failed: ${String(e.message).slice(0, 200)}` };
  }
  const sessionId = session.id;
  // 4. Run ONE phase on a fresh page in the session's context.
  let page = null;
  let ctx = null;
  try {
    page = await session.context.newPage();
    ctx = framework.makeCtx(page, jobWithSite);
    ctx.log('phase_start', { site: loaded.site, kind: job.kind, driver: 'local' });
    const out = await loaded.fn(ctx, jobWithSite);
    ctx.log('phase_end', { phase: out && out.phase, ok: out && out.ok });
    const result = { ...(out || {}), steps: ctx.steps, phaseMs: Date.now() - (ctx._t0 || Date.now()) };
    return await classify(sessionId, result, job);
  } catch (e) {
    if (ctx) {
      try { await ctx.screenshot(`fail-${loaded.site}-${job.kind}`); } catch { /* best effort */ }
      ctx.log('phase_error', { message: String((e && e.message) || e).slice(0, 300), code: e && e.code });
    }
    await closeSession(sessionId);
    return {
      ok: false, code: (e && e.code) || 'browser_failed', sessionId,
      note: `Local browser phase threw: ${String((e && e.message) || e).slice(0, 240)} — session closed, nothing was completed.`,
      steps: ctx ? ctx.steps : [],
    };
  } finally {
    try { if (page) await page.close(); } catch { /* best effort */ }
  }
}

async function classify(sessionId, out, job) {
  const phase = out.phase || (out.ok ? 'done' : 'failed');
  if (out.ok && phase === 'done') {
    const proof = proofOf(out);
    if (!proof) {
      await closeSession(sessionId);
      return { ok: false, code: 'no_proof', sessionId, note: 'Site module returned phase "done" without a confirmation artifact — treated as NOT done. Session closed.', steps: out.steps || [] };
    }
    if (job.keepAlive) {
      return stripSensitive({ ...out, phase: 'done', sessionId, keptAlive: true, driver: 'local' });
    }
    await closeSession(sessionId);
    return stripSensitive({ ...out, phase: 'done', sessionId, driver: 'local' });
  }
  if (out.ok && CONTINUATION_PHASES.has(phase)) {
    // Session stays LIVE for the next phase.
    return stripSensitive({ ...out, phase, sessionId, driver: 'local' });
  }
  await closeSession(sessionId);
  const failure = out.ok === false
    ? { ok: false, code: out.code || 'browser_failed', note: out.note || 'Site module reported failure.', sessionId, driver: 'local' }
    : { ok: false, code: 'browser_failed', sessionId, driver: 'local', note: `Site module returned an unrecognized envelope (phase "${phase}") — treated as failure.` };
  if (out.steps) failure.steps = out.steps;
  return stripSensitive(failure);
}

// The driver object consumed by outcomes.setBrowserDriver().
function createDriver() {
  return { execute, keysPresent: () => !!findChromium() };
}

module.exports = { createDriver, execute };
