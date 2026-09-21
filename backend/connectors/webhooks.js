// Webhooks connector — the smart-home / automation bridge.
//
// Outbound: user-defined named webhooks the agent can fire. Configured via
// env: RING_WEBHOOKS = JSON object mapping name -> {url, method, headers}.
//   {"living_room_lamp":{"url":"https://...","method":"POST","headers":{"Authorization":"Bearer ..."}}}
// Inbound (handled in server.js, POST /api/webhooks/in/:name): external
// services push events into Ring, authenticated per-name via
// RING_INBOUND_SECRETS = JSON {name: secret}.
//
// Registration (the registry agent owns this file list — one line each):
//   agent.js:    ...require('./connectors/webhooks').tools,
//   server.js:   webhooks: require('./connectors/webhooks'),   // in the connectors map
const dns = require('node:dns').promises;
const { env, NotConfigured } = require('../lib/config');

const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;
const BODY_TRUNCATE = 500;

function loadConfig() {
  const raw = env('RING_WEBHOOKS', '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    throw new Error(`RING_WEBHOOKS is not valid JSON: ${e.message}`);
  }
}

function names() {
  return Object.keys(loadConfig());
}

function status() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    return { ok: false, missing: ['RING_WEBHOOKS'], error: e.message };
  }
  const n = Object.keys(cfg);
  return {
    ok: n.length > 0,
    missing: n.length ? [] : ['RING_WEBHOOKS'],
    names: n, // names only — never URLs or secrets
    configured: n.length,
  };
}

function guard(name) {
  const cfg = loadConfig();
  const def = cfg[name];
  if (!def) {
    const avail = Object.keys(cfg);
    throw Object.assign(
      new Error(avail.length
        ? `Unknown webhook "${name}". Configured: ${avail.join(', ')}`
        : `Unknown webhook "${name}". No webhooks are configured — set RING_WEBHOOKS.`),
      { code: 'UNKNOWN_WEBHOOK' }
    );
  }
  return def;
}

// --- SSRF guard -----------------------------------------------------------
// The fire tool hits a user-configured URL server-side, so we resolve the
// hostname ourselves and refuse private/loopback/link-local targets before
// any request is made. Redirects are followed manually (max 3) so each hop
// is checked. Known limitation: DNS could change between lookup and fetch
// (TOCTOU) — a dedicated fetch agent pinning resolved IPs would close that.
function isPrivateIp(addr) {
  const a = String(addr).toLowerCase();
  if (a.includes(':')) {
    if (a === '::1' || a === '::') return true;
    const first = parseInt(a.split(':')[0] || '0', 16) || 0;
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // fail closed
  if (p[0] === 10) return true;                       // 10.0.0.0/8
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16.0.0/12
  if (p[0] === 192 && p[1] === 168) return true;       // 192.168.0.0/16
  if (p[0] === 127) return true;                       // 127.0.0.0/8 loopback
  if (p[0] === 0) return true;                         // 0.0.0.0/8
  return false;
}

async function assertPublicHttp(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Object.assign(
      new Error(`Refused: webhook URL must be http(s), got "${url.protocol}"`),
      { code: 'SSRF_BLOCKED' }
    );
  }
  let addrs;
  try {
    addrs = await dns.lookup(url.hostname, { all: true });
  } catch (e) {
    throw Object.assign(new Error(`DNS lookup failed for ${url.hostname}: ${e.message}`), { code: 'DNS_FAILED' });
  }
  const blocked = addrs.find((r) => isPrivateIp(r.address));
  if (blocked) {
    throw Object.assign(
      new Error(`Refused: ${url.hostname} resolves to a private/loopback address (${blocked.address})`),
      { code: 'SSRF_BLOCKED' }
    );
  }
}

async function safeFetch(url, { method, headers, body }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttp(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, { method, headers, body, redirect: 'manual', signal: ctrl.signal });
    } catch (e) {
      throw Object.assign(
        new Error(`Webhook request failed: ${e.name === 'AbortError' ? 'timed out after 10s' : e.message}`),
        { code: e.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_FAILED' }
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current);
      continue;
    }
    return res;
  }
  throw Object.assign(new Error('Too many redirects'), { code: 'TOO_MANY_REDIRECTS' });
}

async function fireWebhook({ name, payload }) {
  const def = guard(name);
  let url;
  try {
    url = new URL(def.url);
  } catch (e) {
    throw Object.assign(new Error(`Invalid URL configured for webhook "${name}"`), { code: 'BAD_CONFIG' });
  }
  const method = (def.method || 'POST').toUpperCase();
  const headers = { ...(def.headers || {}) };
  let body;
  if (payload !== undefined) {
    body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  }
  const res = await safeFetch(url, { method, headers, body });
  const text = await res.text().catch(() => '');
  return {
    name,
    status: res.status,
    ok: res.ok,
    body: text.slice(0, BODY_TRUNCATE),
    truncated: text.length > BODY_TRUNCATE,
  };
}

async function listWebhooks() {
  const cfg = loadConfig();
  return {
    configured: names(),
    webhooks: names().map((n) => ({ name: n, method: (cfg[n].method || 'POST').toUpperCase() })),
    note: 'URLs and secrets are never exposed here.',
  };
}

// Tools in the agent.js TOOLS shape: { name, describe, schema, risk, fn }.
// webhook_fire is medium risk: it acts on the physical world, so it goes
// through the confirm gate in server.js like calendar_create.
const tools = [
  {
    name: 'webhook_fire', risk: 'medium',
    describe: 'Fire a configured named webhook (smart home / automation). Acts on the physical world — needs confirmation.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Configured webhook name, e.g. living_room_lamp' },
        payload: { description: 'Optional JSON payload to send as the request body' },
      },
      required: ['name'],
    },
    fn: fireWebhook,
  },
  {
    name: 'webhook_list', risk: 'low',
    describe: 'List configured webhook names and their HTTP methods (no URLs or secrets)',
    schema: { type: 'object', properties: {} },
    fn: listWebhooks,
  },
];

module.exports = {
  // Registry shape (see connectors/registry.js): one-line registration is
  //   const webhooks = require('./webhooks');  →  CONNECTORS.webhooks = webhooks;
  id: 'webhooks',
  name: 'Webhooks',
  description: 'Smart-home / automation bridge: named outbound webhooks the agent can fire, plus inbound endpoints for external services.',
  envVars: ['RING_WEBHOOKS', 'RING_INBOUND_SECRETS'],
  requiredEnv: ['RING_WEBHOOKS'],
  status, fireWebhook, listWebhooks, tools,
};
