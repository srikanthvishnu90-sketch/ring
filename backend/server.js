// Ring backend — serves the app, exposes the agent API, reports connector status.
//
//   GET  /api/health                  → which capabilities are live (keys present?)
//   GET  /api/connectors              → connector list + what each needs
//   POST /api/chat                   → { text } → agent reply (+ held approvals)
//   GET  /api/approvals               → pending approvals
//   POST /api/approvals/:id/resolve   → { decision: 'approve'|'decline' } → executes on approve
//   GET/POST /api/threads             → group chats
//   GET  /api/threads/:id/messages    → thread history
//   POST /api/threads/:id/messages    → post; @agent mention triggers the agent loop
//   GET  /api/threads/:id/stream      → SSE live updates
//   GET  /auth/google                 → start Google OAuth (Gmail + Calendar)
//   POST /api/voice                   → (stub) audio in → transcribed turn out
//
// Static: serves ../index.html so one `npm start` runs the whole prototype
// with the API live underneath it.
const path = require('path');
const express = require('express');
require('dotenv').config();

const { env, missing } = require('./lib/config');
const { saveTokens, ready: googleReady } = require('./lib/google');
const { TOOLS, runAgentTurn, llmConfigured } = require('./lib/agent');
const approvals = require('./lib/approvals');
const threads = require('./lib/threads');

const connectors = {
  gmail: require('./connectors/gmail'),
  calendar: require('./connectors/calendar'),
  places: require('./connectors/places'),
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

    // Approval gate: medium/high-risk calls are HELD as approval records —
    // never executed silently. The client renders them as approval cards and
    // resolves them via POST /api/approvals/:id/resolve.
    const held = (reply.toolsUsed || [])
      .filter((t) => t.risk !== 'low')
      .map((t) => {
        const rec = approvals.create({ toolName: t.name, args: t.args, userId, threadId });
        return { id: rec.id, name: rec.tool, risk: rec.risk, args: rec.args };
      });
    res.json({ ...reply, pendingApprovals: held, executed: held.length === 0 });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code });
  }
});

// --- Approvals -----------------------------------------------------------
app.get('/api/approvals', (req, res) => {
  res.json(approvals.listPending(req.query.userId));
});

app.post('/api/approvals/:id/resolve', async (req, res) => {
  try {
    const rec = await approvals.resolve(req.params.id, req.body?.decision);
    res.json(rec);
  } catch (e) {
    res.status(e.code === 'NOT_FOUND' ? 404 : 500).json({ error: e.message });
  }
});

// --- Group threads -------------------------------------------------------
app.get('/api/threads', (req, res) => res.json(threads.listThreads()));

app.post('/api/threads', (req, res) => {
  const { name, members } = req.body || {};
  res.json(threads.createThread({ name, members }));
});

app.get('/api/threads/:id/messages', (req, res) => {
  const th = threads.getThread(req.params.id);
  if (!th) return res.status(404).json({ error: 'thread not found' });
  res.json(th.messages);
});

app.post('/api/threads/:id/messages', async (req, res) => {
  const { from, text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const msg = await threads.postMessage(req.params.id, { from: from || 'you', text });
    res.json(msg);
  } catch (e) {
    res.status(e.code === 'NOT_FOUND' ? 404 : 500).json({ error: e.message });
  }
});

app.get('/api/threads/:id/stream', (req, res) => {
  const th = threads.getThread(req.params.id);
  if (!th) return res.status(404).json({ error: 'thread not found' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'hello', thread: th.id })}\n\n`);
  threads.subscribe(req.params.id, res);
  req.on('close', () => threads.unsubscribe(req.params.id, res));
});

// --- Google OAuth (Gmail + Calendar) -------------------------------------
// Tokens stay server-side in lib/google.js (in-memory; Supabase for prod).
app.get('/auth/google', (req, res) => {
  const m = missing(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']);
  if (m.length) return res.status(500).send('Google OAuth not configured — see .env.example');
  const q = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'),
    redirect_uri: env('GOOGLE_REDIRECT_URI'),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString());
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env('GOOGLE_CLIENT_ID'),
        client_secret: env('GOOGLE_CLIENT_SECRET'),
        redirect_uri: env('GOOGLE_REDIRECT_URI'),
        grant_type: 'authorization_code',
      }),
    });
    const tok = await r.json();
    if (!r.ok) throw new Error(tok.error_description || 'token exchange failed');
    saveTokens('local', tok); // TODO: tie to real user id + Supabase
    res.send('<p style="font-family:sans-serif">Gmail + Calendar connected. Close this tab and return to the app.</p>');
  } catch (e) {
    res.status(500).send('OAuth failed: ' + e.message);
  }
});

// Stub: ring/phone posts audio, gets back the agent's turn. STT hookup next.
app.post('/api/voice', (req, res) => {
  res.status(501).json({ error: 'voice relay not wired yet — see docs/architecture.md' });
});

module.exports = app;
if (require.main === module) {
  const PORT = env('PORT', '3000');
  googleReady().then(() => {
    app.listen(PORT, () => console.log(`Ring backend live → http://localhost:${PORT}  (api: /api/health)`));
  });
}
