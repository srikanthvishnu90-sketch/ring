// Browser automation driver for the outcomes executor (tier 2).
//
// Lives behind BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID (Vercel env,
// set by Vishnu — never in chat or code). The outcomes connector calls
// setBrowserDriver() at boot; when keys are absent the driver is null and
// outcomes honestly reports `browser_not_configured`.
//
// CURRENT STATE: session-lifecycle + key detection only. The full job
// executor (CDP site scripts that actually book/cancel/fill on real sites)
// gets built and tested LIVE once the keys land — shipping untested browser
// automation that touches real bookings would be reckless. Until then,
// execute() returns browser_driver_unwired so outcomes falls through to the
// honest handoff tier and never claims an outcome it didn't produce.
const { env } = require('./config');

const BB_API = 'https://api.browserbase.com/v1';

function keysPresent() {
  return !!(env('BROWSERBASE_API_KEY') && env('BROWSERBASE_PROJECT_ID'));
}

async function bbFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BB_API}${path}`, {
    method,
    headers: { 'x-bb-api-key': env('BROWSERBASE_API_KEY'), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Browserbase ${method} ${path} failed (HTTP ${res.status})`);
  return res.json();
}

async function createSession() {
  const j = await bbFetch('/sessions', {
    method: 'POST',
    body: { projectId: env('BROWSERBASE_PROJECT_ID') },
  });
  if (!j.id || !j.connectUrl) throw new Error('Browserbase returned no session id/connectUrl');
  return { id: j.id, connectUrl: j.connectUrl };
}

async function stopSession(id) {
  try {
    await bbFetch(`/sessions/${id}`, { method: 'DELETE' });
  } catch { /* best effort */ }
}

// The driver object consumed by outcomes.setBrowserDriver().
function createDriver() {
  if (!keysPresent()) return null;
  return {
    // Job: { kind, site, vaultId, ...params }. Must resolve to an object
    // containing a confirmation artifact (confirmationRef / reservationId /
    // orderId / receiptUrl) for outcomes.proofOf() to accept it.
    async execute(job) {
      return {
        ok: false,
        code: 'browser_driver_unwired',
        note: 'Browser automation executor is not built yet — it ships once BROWSERBASE keys are live and tested. Job was not executed.',
        jobKind: job && job.kind,
      };
    },
    createSession,
    stopSession,
    keysPresent,
  };
}

module.exports = { createDriver, keysPresent };
