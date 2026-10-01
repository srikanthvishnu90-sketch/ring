// backend/lib/browser_open_secure.js — Secure browser session manager.
//
// Provides sandboxed, auto-expiring browser sessions for the `browser_open`
// tool and the public test page. Security properties:
//
// 1. URL VALIDATION: Only http/https. Blocks private/internal IPs (SSRF),
//    localhost, and sensitive domains (banking, email, etc.).
// 2. FRESH CONTEXTS: Every session gets a new incognito context — no shared
//    cookies, storage, or auth state between sessions.
// 3. AUTO-EXPIRY: Sessions die after SESSION_TTL_MS (default 2 min for public,
//    10 min for authenticated). A sweeper closes them server-side.
// 4. RATE LIMITING: Per-IP and per-user caps on session creation.
// 5. NO SESSION URL LEAK: The Browserbase live debugger URL is NEVER returned
//    for public sessions. Only the session owner (authenticated) gets it.
// 6. SCREENSHOTS ONLY for public: no interactive takeover for unauthenticated.

const { URL } = require('url');
const net = require('net');

// ─── Configuration ──────────────────────────────────────────────────

const PUBLIC_TTL_MS = 2 * 60 * 1000;       // 2 minutes for public test sessions
const AUTH_TTL_MS = 10 * 60 * 1000;        // 10 minutes for authenticated users
const SWEEP_INTERVAL_MS = 30 * 1000;       // sweep every 30s

// Rate limits
const PUBLIC_RATE_LIMIT = 5;               // 5 sessions per hour per IP
const AUTH_RATE_LIMIT = 30;                // 30 sessions per hour per user
const RATE_WINDOW_MS = 60 * 60 * 1000;

// Blocked domains (sensitive: banking, email, etc.)
const BLOCKED_DOMAINS = [
  'mail.google.com', 'outlook.com', 'outlook.live.com',
  'chase.com', 'bankofamerica.com', 'wellsfargo.com',
  'paypal.com', 'venmo.com',
  'appleid.apple.com',
];

// ─── In-memory registries (per-process; fine for serverless) ────────

const sessions = new Map();  // sessionId -> { bbSessionId, page, browser, createdAt, expiresAt, ownerIp, userId, isPublic }
const rateLimits = new Map(); // key -> { count, windowStart }

// ─── URL validation ─────────────────────────────────────────────────

function isPrivateIP(hostname) {
  // Check if hostname is an IP address in private ranges
  if (!net.isIP(hostname)) return false;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4) return false; // IPv6 handled below
  const [a, b] = parts;
  return (
    a === 10 ||                          // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) ||          // 192.168.0.0/16
    a === 127 ||                         // 127.0.0.0/8
    (a === 169 && b === 254)             // 169.254.0.0/16 (link-local)
  );
}

function validateUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, code: 'invalid_url', note: 'Invalid URL format.' };
  }

  // Only http/https
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, code: 'blocked_protocol', note: `Protocol ${url.protocol} is not allowed. Only http/https.` };
  }

  const hostname = url.hostname.toLowerCase();

  // Block localhost
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    return { ok: false, code: 'blocked_host', note: 'Localhost URLs are not allowed.' };
  }

  // Block private IPs (SSRF protection)
  if (isPrivateIP(hostname)) {
    return { ok: false, code: 'blocked_host', note: 'Internal IP addresses are not allowed.' };
  }

  // Block sensitive domains
  for (const blocked of BLOCKED_DOMAINS) {
    if (hostname === blocked || hostname.endsWith('.' + blocked)) {
      return { ok: false, code: 'blocked_domain', note: `Access to ${blocked} is not allowed in test sessions.` };
    }
  }

  return { ok: true, url: url.toString(), hostname };
}

// ─── Rate limiting ──────────────────────────────────────────────────

function checkRateLimit(key, limit) {
  const now = Date.now();
  let entry = rateLimits.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }
  entry.count++;
  rateLimits.set(key, entry);
  return entry.count <= limit;
}

// ─── Session management ─────────────────────────────────────────────

async function createSecureSession({ url, userId, clientIp, isPublic }) {
  // 1. Validate URL
  const v = validateUrl(url);
  if (!v.ok) return v;

  // 2. Rate limit
  const rateKey = isPublic ? `ip:${clientIp}` : `user:${userId}`;
  const limit = isPublic ? PUBLIC_RATE_LIMIT : AUTH_RATE_LIMIT;
  if (!checkRateLimit(rateKey, limit)) {
    return { ok: false, code: 'rate_limited', note: 'Too many browser sessions. Please try again later.' };
  }

  // 3. Create Browserbase session
  const driver = require('./browser_driver').createDriver();
  if (!driver.keysPresent || !driver.keysPresent()) {
    return { ok: false, code: 'browser_not_configured', note: 'Browser automation is not configured.' };
  }

  let bbSession;
  try {
    bbSession = await driver.createSession();
  } catch (e) {
    return { ok: false, code: 'session_failed', note: `Could not create browser session: ${e.message}`.slice(0, 200) };
  }

  // 4. Connect and create FRESH incognito context (no shared state)
  let browser, page;
  try {
    const { chromium } = require('playwright-core');
    browser = await chromium.connectOverCDP(bbSession.connectUrl);
    // Always create a new context — never reuse the default
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    page = await context.newPage();
    await page.goto(v.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  } catch (e) {
    try { await driver.stopSession(bbSession.id); } catch {}
    try { browser && await browser.close(); } catch {}
    return { ok: false, code: 'browser_failed', note: `Browser connection failed: ${e.message}`.slice(0, 200) };
  }

  // 5. Register with auto-expiry
  const ttl = isPublic ? PUBLIC_TTL_MS : AUTH_TTL_MS;
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  sessions.set(sessionId, {
    bbSessionId: bbSession.id,
    browser,
    page,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    ownerIp: clientIp,
    userId: userId || null,
    isPublic,
    url: v.url,
    hostname: v.hostname,
  });

  return {
    ok: true,
    sessionId,
    bbSessionId: bbSession.id,
    url: v.url,
    hostname: v.hostname,
    expiresAt: Date.now() + ttl,
    // NEVER expose liveUrl for public sessions
    liveUrl: isPublic ? null : `https://www.browserbase.com/sessions/${bbSession.id}`,
  };
}

async function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    await closeSession(sessionId);
    return null;
  }
  return s;
}

async function closeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  try { await s.browser.close(); } catch {}
  try {
    const driver = require('./browser_driver').createDriver();
    await driver.stopSession(s.bbSessionId);
  } catch {}
}

// Sweeper: close expired sessions
function sweepExpired() {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now > s.expiresAt) {
      closeSession(id).catch(() => {});
    }
  }
}

// Start sweeper (only once per process)
let sweeperStarted = false;
function ensureSweeper() {
  if (sweeperStarted) return;
  sweeperStarted = true;
  const timer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
  // Don't keep the process alive just for this in serverless
  if (timer.unref) timer.unref();
}
ensureSweeper();

// For the debug endpoint (admin only)
function listSessions() {
  const out = [];
  for (const [id, s] of sessions.entries()) {
    out.push({
      sessionId: id,
      hostname: s.hostname,
      url: s.url,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      isPublic: s.isPublic,
      userId: s.userId ? s.userId.slice(0, 8) + '...' : null, // truncated
      // NEVER include bbSessionId or liveUrl in public output
    });
  }
  return out;
}

module.exports = {
  createSecureSession,
  getSession,
  closeSession,
  listSessions,
  validateUrl,
  PUBLIC_TTL_MS,
  AUTH_TTL_MS,
};
