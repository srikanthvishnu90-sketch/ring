// Connector registry — the single source of truth for what the app can do.
//
// A connector module exports:
//   { id, name, description, envVars, status(), tools? }
// `tools` is optional: legacy connectors (gmail, calendar, …) define their
// agent tools in lib/agent.js; new connectors define them in their own module
// (see twilio.js and CONNECTORS.md).
const gmail = require('./gmail');
const calendar = require('./calendar');
const places = require('./places');
const uber = require('./uber');
const dining = require('./dining');
const twilio = require('./twilio');
const telegram = require('./telegram');
const stripe = require('./stripe');
const webhooks = require('./webhooks');

const CONNECTORS = { gmail, calendar, places, uber, dining, twilio, telegram, stripe, webhooks };

function allConnectors() {
  return Object.values(CONNECTORS);
}

// Shape for /api/health: { [id]: status() } — never throws.
function connectorStatus() {
  const out = {};
  for (const [key, c] of Object.entries(CONNECTORS)) {
    const id = c.id || key;
    try {
      out[id] = c.status();
    } catch (e) {
      out[id] = { ok: false, error: e.message };
    }
  }
  return out;
}

// All tools contributed by connectors that define their own `tools` array.
// Deduped by name (first registration wins); result is merged with the
// legacy TOOLS list in lib/agent.js.
function allTools() {
  const seen = new Set();
  const tools = [];
  for (const c of allConnectors()) {
    for (const t of c.tools || []) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        tools.push({ ...t, connector: c.id });
      }
    }
  }
  return tools;
}

module.exports = { CONNECTORS, allConnectors, connectorStatus, allTools };
