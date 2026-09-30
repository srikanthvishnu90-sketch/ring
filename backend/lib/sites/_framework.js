// backend/lib/sites/_framework.js — site-module contract + phase runner.
//
// ═══════════════════════════════════════════════════════════════════════════
//  SITE MODULE CONTRACT (for the agents building uber.js, resy.js, ...)
// ═══════════════════════════════════════════════════════════════════════════
//  A site module lives at backend/lib/sites/<site>.js and exports an object
//  keyed by job kind:
//
//      module.exports = {
//        'book-ride': async (ctx, job) => { ... },
//        'trip-status': async (ctx, job) => { ... },
//      };
//
//  ctx — what the driver hands your function:
//    ctx.page    Playwright page (mobile viewport 390x844, realistic UA).
//    ctx.job     The job object (redacted copy — safe to log).
//    ctx.log(step, data?)      Append a structured step to the phase log.
//    ctx.screenshot(name?)     Capture to /tmp (returns the path, for debugging).
//    ctx.vault.has(id)         Presence check for a vaulted credential.
//    ctx.vault.withCredentials(id, async (creds) => {...})
//                              Resolve a VAULT_<ID> credential server-side.
//                              creds NEVER leave this callback — return only
//                              proofs/summaries from it, never the value.
//
//  Your function MUST return one of these envelopes (never throw for an
//  expected failure — return the failure envelope):
//
//    Terminal success (ONE phase did the whole job):
//      { ok: true, phase: 'done', confirmationRef: 'ABC123', /* site fields */ }
//      → a confirmation artifact (confirmationRef | reservationId | bookingId |
//        orderId | receiptUrl | cancelRef | ticketId) is REQUIRED. The driver
//        downgrades a 'done' without one to { ok:false, code:'no_proof' }.
//
//    Phase continuation (multi-step across serverless invocations):
//      { ok: true, phase: 'need_otp', prompt: 'Enter the 6-digit code sent to your phone' }
//      { ok: true, phase: 'need_input', prompt: '...', fields: ['otp'] }
//      → the session stays LIVE; the agent re-invokes execute() with
//        { sessionId, <the requested input> } to continue the SAME browser.
//
//    Approval gate (work paused for a human decision, e.g. fare estimate):
//      { ok: true, phase: 'need_approval', summary: { pickup, dropoff, fare: '$23.40', eta: '4 min' } }
//      → session stays LIVE; agent re-invokes after the user approves.
//
//    Honest failure (nothing was done — never claim otherwise):
//      { ok: false, code: 'login_failed' | 'no_slots' | 'blocked' | ..., note: '...' }
//
//  RULES:
//    1. One phase per execute() call. Never sleep-loop waiting for a human —
//       return a continuation phase and let the agent loop re-invoke you.
//    2. NEVER log or return credential values, OTPs, raw cookies, or the
//       session connect_url. ctx.job is already redacted for you.
//    3. Use ctx.log() for every meaningful step — it becomes the audit trail.
//    4. Screenshots on failure are automatic; call ctx.screenshot() yourself
//       at decision points you may need to debug later.
// ═══════════════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const vault = require('../vault');

// Static site module registry — ensures Vercel bundles these files.
// Dynamic require() alone may not include them in the serverless bundle.
const SITE_MODULES = {
  'dining': () => require('./dining.js'),
  'uber': () => { try { return require('./uber.js'); } catch (e) { return null; } },
  'resy': () => { try { return require('./resy.js'); } catch (e) { return null; } },
  'resy_api': () => { try { return require('./resy_api.js'); } catch (e) { return null; } },
};

const SITES_DIR = __dirname;

const SITE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

// Jobs without an explicit site fall back to this map (outcomes.js passes no
// site for some kinds). Keep in sync with the kinds in connectors/outcomes.js.
const KIND_DEFAULT_SITE = {
  'cancel-subscription': 'subscription',
  'login-task': 'web_login',
  'form-fill': 'web_form',
};

function resolveSiteName(job) {
  if (job && typeof job.site === 'string' && SITE_NAME_RE.test(job.site)) return job.site;
  const fb = job && KIND_DEFAULT_SITE[job.kind];
  return fb || null;
}

// Returns { site, fn } or { error } — never throws for a missing module.
function loadSite(job, dir) {
  const site = resolveSiteName(job);
  if (!site) {
    return { error: { ok: false, code: 'site_not_implemented', note: `No site module for kind "${job && job.kind}" (no site given and no default mapping).` } };
  }
  // Try static registry first (ensures Vercel bundling), then dynamic require.
  let mod = null;
  if (SITE_MODULES[site]) {
    try {
      mod = SITE_MODULES[site]();
    } catch (e) {
      // Fall through to dynamic require
    }
  }
  if (!mod) {
    const base = dir || SITES_DIR;
    const file = path.join(base, `${site}.js`);
    try {
      // Bust require cache in tests only (NODE_ENV=test); production caches.
      if (process.env.NODE_ENV === 'test') delete require.cache[require.resolve(file)];
      mod = require(file);
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        return { error: { ok: false, code: 'site_not_implemented', site, kind: job.kind, note: `Site module sites/${site}.js is not implemented yet — nothing was attempted.` } };
      }
      return { error: { ok: false, code: 'site_load_failed', site, kind: job.kind, note: `Site module sites/${site}.js failed to load: ${String(e.message).slice(0, 200)}` } };
    }
  }
  const fn = mod && mod[job.kind];
  if (typeof fn !== 'function') {
    return { error: { ok: false, code: 'kind_not_implemented', site, kind: job.kind, note: `Site module "${site}" does not implement kind "${job.kind}" — nothing was attempted.` } };
  }
  return { site, fn };
}

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';

// Sanitize anything that might carry secrets before it hits logs or results.
const SECRET_KEY_RE = /connect_?url|cookie|set-cookie|api[-_ ]?key|x-bb-api-key|token|passwd|password|secret|otp|2fa|authorization/i;
function sanitize(value, depth = 0) {
  if (depth > 6) return '[depth]';
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) {
    if (SECRET_KEY_RE.test(k)) out[k] = '[redacted]';
    else out[k] = sanitize(value[k], depth + 1);
  }
  return out;
}

function makeCtx(page, job) {
  const started = Date.now();
  const steps = [];
  const safeJob = sanitize(job);
  return {
    page,
    job: safeJob,
    steps,
    log(step, data) {
      steps.push({ t: new Date().toISOString(), ms: Date.now() - started, step: String(step), ...(data !== undefined ? { data: sanitize(data) } : {}) });
      if (steps.length > 200) steps.splice(0, steps.length - 200);
    },
    async screenshot(name) {
      const p = `/tmp/ring-bb-${String(name || 'shot').replace(/[^a-z0-9_-]+/gi, '_')}-${Date.now()}.png`;
      try { await page.screenshot({ path: p }); return p; } catch { return null; }
    },
    vault: {
      has: (id) => vault.has(id),
      withCredentials: (id, fn) => vault.withCredentials(id, fn),
    },
  };
}

// Default CDP connector (playwright-core, CDP only — no browser download).
// Separated for test injection: pass { connectCdp } in deps to override.
function defaultConnectCdp(connectUrl) {
  let pw;
  try {
    pw = require('playwright-core');
  } catch {
    const err = new Error('playwright-core is not installed — run `npm install` in backend/');
    err.code = 'PLAYWRIGHT_CORE_MISSING';
    throw err;
  }
  // Add 30s timeout for CDP connection — don't hang forever
  return Promise.race([
    pw.chromium.connectOverCDP(connectUrl),
    new Promise((_, reject) => 
      setTimeout(() => reject(Object.assign(new Error('CDP connection timeout after 30s'), { code: 'CDP_TIMEOUT' })), 30000
    )
  ]);
}

// Run ONE phase: connect CDP -> new page -> site fn -> disconnect.
// Returns the site fn's envelope augmented with { steps }.
// deps: { connectCdp } (test seam). Never throws expected failures — but an
// unexpected throw propagates to the driver, which converts it honestly.
async function runPhase({ connectUrl, job, siteFn, site }, deps = {}) {
  const connectCdp = deps.connectCdp || defaultConnectCdp;
  const started = Date.now();
  let browser = null;
  let ctx = null;
  try {
    browser = await connectCdp(connectUrl);
    const contexts = browser.contexts();
    const context = contexts[0] || (await browser.newContext());
    const page = await context.newPage({
      viewport: { width: 390, height: 844 },
      userAgent: MOBILE_UA,
    });
    ctx = makeCtx(page, job);
    ctx.log('phase_start', { site, kind: job.kind });
    const out = await siteFn(ctx, job);
    ctx.log('phase_end', { phase: out && out.phase, ok: out && out.ok });
    return { ...(out || {}), steps: ctx.steps, phaseMs: Date.now() - started };
  } catch (e) {
    if (ctx) {
      try { await ctx.screenshot(`fail-${site}-${job.kind}`); } catch { /* best effort */ }
      ctx.log('phase_error', { message: String((e && e.message) || e).slice(0, 300), code: e && e.code });
    }
    throw e;
  } finally {
    // Disconnect OUR CDP connection only — the remote Browserbase session
    // stays alive for continuation phases. Never browser.close() the remote.
    try { if (browser) await browser.close(); } catch { /* best effort */ }
  }
}

module.exports = {
  loadSite,
  runPhase,
  resolveSiteName,
  sanitize,
  makeCtx,
  KIND_DEFAULT_SITE,
  SITES_DIR,
};
