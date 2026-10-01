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
  'subscription': () => { try { return require('./subscription.js'); } catch (e) { return null; } },
  'myclaw': () => { try { return require('./myclaw.js'); } catch (e) { return null; } },
  'generic_task': () => { try { return require('./generic_task.js'); } catch (e) { return null; } },
};

const SITES_DIR = __dirname;

const SITE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

// Jobs without an explicit site fall back to this map (outcomes.js passes no
// site for some kinds). Keep in sync with the kinds in connectors/outcomes.js.
const KIND_DEFAULT_SITE = {
  'cancel-subscription': 'subscription',
  'login-task': 'web_login',
  'form-fill': 'web_form',
  // outcomes2 (features 51–75) — all routed to the generic task executor.
  'book-flight': 'generic_task',
  'book-hotel': 'generic_task',
  'order-food': 'generic_task',
  'order-groceries': 'generic_task',
  'join-waitlist': 'generic_task',
  'order-product': 'generic_task',
  'create-price-alert': 'generic_task',
  'start-return': 'generic_task',
  'pay-bill': 'generic_task',
  'pause-subscription': 'generic_task',
  'make-donation': 'generic_task',
  'order-gift': 'generic_task',
  'book-appointment': 'generic_task',
  'book-service': 'generic_task',
  'reserve-parking': 'generic_task',
  'book-tickets': 'generic_task',
  'book-car-rental': 'generic_task',
  'unsubscribe': 'generic_task',
  'request-data-export': 'generic_task',
  'register-warranty': 'generic_task',
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
      const entry = { t: new Date().toISOString(), ms: Date.now() - started, step: String(step), ...(data !== undefined ? { data: sanitize(data) } : {}) };
      steps.push(entry);
      if (steps.length > 200) steps.splice(0, steps.length - 200);
      // Mirror to stdout with elapsed ms — Vercel captures this, so the next
      // slow phase leaves a timing trail showing exactly where it hung.
      // Include the data payload: without it the trail shows step names only
      // and hides the values (URLs, counts) needed to diagnose a failure.
      try {
        const d = entry.data !== undefined ? ' ' + JSON.stringify(entry.data).slice(0, 400) : '';
        console.log(`[ring-bb] +${entry.ms}ms ${entry.step}${d}`);
      } catch { /* never break the phase for logging */ }
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
      setTimeout(() => reject(Object.assign(new Error('CDP connection timeout after 30s'), { code: 'CDP_TIMEOUT' })), 30000)
    )
  ]);
}

// Run ONE phase: connect CDP -> new page -> site fn -> disconnect.
// Returns the site fn's envelope augmented with { steps }.
// deps: { connectCdp } (test seam). Never throws expected failures — but an
// unexpected throw propagates to the driver, which converts it honestly.

// Live CDP connections kept across chained phases IN THIS PROCESS.
// A fresh connectOverCDP cannot see a previous phase's pages (proven:
// phase 2 resumed onto about:blank with resumed=false), so when phase 1
// returns a continuation (need_approval + sessionId) the connection must stay
// open for phase 2 to reuse THE SAME pages. Entries are keyed by connectUrl
// and evicted after 5 minutes so a dropped chain can never leak a browser.
const cdpCache = new Map();
const CDP_CACHE_TTL_MS = 5 * 60 * 1000;
const CONTINUATION_PHASES = new Set(['need_otp', 'need_input', 'need_approval']);

function evictStaleCdp() {
  const now = Date.now();
  for (const [key, entry] of cdpCache) {
    if (!entry || now - entry.savedAt > CDP_CACHE_TTL_MS) {
      cdpCache.delete(key);
      try { if (entry && entry.browser && entry.browser.close) entry.browser.close().catch(() => {}); } catch { /* ignore */ }
    }
  }
  // Hard cap: never hold more than a handful of browsers.
  while (cdpCache.size > 4) {
    const oldest = cdpCache.keys().next().value;
    const entry = cdpCache.get(oldest);
    cdpCache.delete(oldest);
    try { if (entry && entry.browser && entry.browser.close) entry.browser.close().catch(() => {}); } catch { /* ignore */ }
  }
}

async function disconnectCdp(browser) {
  // Bounded: a wedged CDP connection must never hold the function hostage.
  // This only disconnects OUR connection — the remote Browserbase session
  // stays alive unless the driver explicitly stops it.
  try {
    if (browser) {
      await Promise.race([
        browser.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('cdp_disconnect_timeout')), 10000)),
      ]);
    }
  } catch { /* best effort */ }
}

async function runPhase(params, deps = {}) {
  const { connectUrl, job, siteFn, site } = params;
  const connectCdp = deps.connectCdp || defaultConnectCdp;
  const started = Date.now();
  let browser = null;
  let ctx = null;
  // True when this phase chains into another phase in this process: keep the
  // CDP connection open so the next phase reuses the SAME live pages.
  let keepAlive = false;
  try {
    evictStaleCdp();
    // Reuse a live connection from a chained phase in this process. A fresh
    // connectOverCDP cannot see the previous phase's pages, so without this
    // the continuation phase lands on a blank tab.
    if (job.sessionId) {
      const cached = cdpCache.get(connectUrl);
      if (cached && cached.browser) {
        let alive = false;
        try { alive = typeof cached.browser.isConnected === 'function' ? cached.browser.isConnected() : true; } catch { alive = false; }
        if (alive) browser = cached.browser;
        else cdpCache.delete(connectUrl);
      }
    }
    if (!browser) browser = await connectCdp(connectUrl);
    const contexts = browser.contexts();
    const context = contexts[0] || (await browser.newContext());
    // Resume the phase's real page: prefer the most recently opened non-blank
    // page (Browserbase keeps a default about:blank tab alongside real ones).
    // Fresh phase with no pages: create one as before.
    let page;
    const existingPages = context.pages();
    if (existingPages.length) {
      page = null;
      for (let i = existingPages.length - 1; i >= 0; i--) {
        let u = '';
        try { u = existingPages[i].url() || ''; } catch { u = ''; }
        if (u && u !== 'about:blank') { page = existingPages[i]; break; }
      }
      page = page || existingPages[existingPages.length - 1];
      await page.bringToFront().catch(() => {});
      try { await page.setViewportSize({ width: 390, height: 844 }); } catch { /* best effort */ }
    } else {
      page = await context.newPage({
        viewport: { width: 390, height: 844 },
        userAgent: MOBILE_UA,
      });
    }
    ctx = makeCtx(page, job);
    // Expose the ctx on the params object so a serverless timeout can still
    // report the partial step trail (browser_driver reads params._ctx.steps).
    params._ctx = ctx;
    ctx.log('phase_start', { site, kind: job.kind, resumed: !!(job.sessionId && existingPages.length), reusedConn: !!browser && cdpCache.has(connectUrl) });
    const out = await siteFn(ctx, job);
    ctx.log('phase_end', { phase: out && out.phase, ok: out && out.ok });
    keepAlive = !!(out && out.ok && CONTINUATION_PHASES.has(out.phase));
    if (keepAlive) {
      cdpCache.set(connectUrl, { browser, savedAt: Date.now() });
      ctx.log('phase_conn_kept', { pages: context.pages().length });
    }
    return { ...(out || {}), steps: ctx.steps, phaseMs: Date.now() - started };
  } catch (e) {
    if (ctx) {
      try { await ctx.screenshot(`fail-${site}-${job.kind}`); } catch { /* best effort */ }
      ctx.log('phase_error', { message: String((e && e.message) || e).slice(0, 300), code: e && e.code });
    }
    throw e;
  } finally {
    if (keepAlive) {
      // Leave the connection open for the chained phase (same process).
    } else {
      cdpCache.delete(connectUrl);
      await disconnectCdp(browser);
    }
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
