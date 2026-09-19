// Ring backend — serves the app, exposes the agent API, reports connector status.
//
//   GET  /api/health      → which capabilities are live (keys present?)
//   GET  /api/connectors  → connector list + what each needs
//   POST /api/chat        → { text } → agent reply (+ tools used)
//   POST /api/voice       → (stub) audio in → transcribed turn out
//
// Static: serves ../index.html so one `npm start` runs the whole prototype
// with the API live underneath it.
const path = require('path');
const express = require('express');
require('dotenv').config();

const { env } = require('./lib/config');
const { TOOLS, runAgentTurn, llmConfigured } = require('./lib/agent');

const connectors = {
  gmail: require('./connectors/gmail'),
  calendar: require('./connectors/calendar'),
  uber: require('./connectors/uber'),
  dining: require('./connectors/dining'),
};

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..')));

app.get('/api/health', (req, res) => {
  const out = { ok: true, time: new Date().toISOString(), llm: llmConfigured() ? env('LLM_PROVIDER', 'openai') : 'canned-fallback', connectors: {} };
  for (const [name, c] of Object.entries(connectors)) {
    try {
      out.connectors[name] = c.status();
    } catch (e) {
      out.connectors[name] = { ok: false, error: e.message };
    }
  }
  res.json(out);
});

app.get('/api/connectors', (req, res) => {
  res.json(
    Object.entries(connectors).map(([name, c]) => ({
      name,
      requiredEnv: c.requiredEnv,
      status: (() => { try { return c.status(); } catch (e) { return { ok: false, error: e.message }; } })(),
    }))
  );
});

app.post('/api/chat', async (req, res) => {
  const { text, userId, threadId } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
  try {
    const reply = await runAgentTurn({ text, userId, threadId });

    // Approval gate: anything medium/high risk becomes a pending approval,
    // never executes silently. (Persistence + push delivery are the next step;
    // for now the client receives them to render as approval cards.)
    const needsApproval = (reply.toolsUsed || []).filter((t) => t.risk !== 'low');
    if (needsApproval.length) {
      return res.json({ ...reply, pendingApprovals: needsApproval, executed: false });
    }
    res.json({ ...reply, executed: true });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code });
  }
});

// Stub: ring/phone posts audio, gets back the agent's turn. STT hookup next.
app.post('/api/voice', (req, res) => {
  res.status(501).json({ error: 'voice relay not wired yet — see docs/architecture.md' });
});

const PORT = env('PORT', '3000');
app.listen(PORT, () => console.log(`Ring backend live → http://localhost:${PORT}  (api: /api/health)`));
