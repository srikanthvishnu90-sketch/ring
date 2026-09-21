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
//   POST /api/chat/stream             → SSE token streaming (+ held approvals)
//   GET  /api/auth/me                   → current user (Bearer Supabase JWT)
//   POST /api/auth/otp                   → send magic-link email
//   GET/POST/DELETE /api/memories        → durable user memory
//   GET  /api/export                    → export all user data (JSON)
//   DELETE /api/account                 → wipe all user data
//
// Static: serves ../index.html so one `npm start` runs the whole prototype
// with the API live underneath it.
const path = require('path');
const express = require('express');
require('dotenv').config();

const { env, missing } = require('./lib/config');
const { saveTokens, ready: googleReady } = require('./lib/google');
const { TOOLS, runAgentTurn, runAgentTurnStream, llmConfigured } = require('./lib/agent');
const approvals = require('./lib/approvals');
const threads = require('./lib/threads');
const memory = require('./lib/memory');
const { sendMagicLink, requireUser, optionalUser } = require('./lib/auth');
const { processVoice } = require('./lib/voice');
const { sbRequest, eq, ENABLED: SB_ENABLED } = require('./lib/supabase');

const connectors = {
  gmail: require('./connectors/gmail'),
  calendar: require('./connectors/calendar'),
  places: require('./connectors/places'),
  uber: require('./connectors/uber'),
  dining: require('./connectors/dining'),
};

const app = express();
// /api/voice carries base64 audio — give it a bigger body; everything else
// stays at 1mb.
app.use((req, res, next) => {
  const limit = req.path === '/api/voice' ? '15mb' : '1mb';
  express.json({ limit })(req, res, next);
});
app.use(express.static(path.join(__dirname, '..')));
// Attach identity when a Supabase JWT is present; falls back to 'local'.
app.use(optionalUser);

// Serverless (Vercel) exports the app without awaiting the token boot-load,
// so gate every request on it: first request waits, the rest pass through.
let googleGate = null;
app.use((req, res, next) => {
  if (!googleGate) googleGate = googleReady();
  googleGate.then(() => next(), () => next());
});

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
  const { text, threadId } = req.body || {};
  const userId = req.userId || req.body?.userId || 'local';
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
  try {
    const reply = await runAgentTurn({ text, userId, threadId });

    // Approval gate: medium/high-risk calls are HELD as approval records —
    // never executed silently. The client renders them as approval cards and
    // resolves them via POST /api/approvals/:id/resolve.
    const held = [];
    for (const t of (reply.toolsUsed || []).filter((t) => t.risk !== 'low')) {
      const rec = await approvals.create({ toolName: t.name, args: t.args, userId, threadId });
      held.push({ id: rec.id, name: rec.tool, risk: rec.risk, args: rec.args });
    }

    // Learn loop: extract durable facts from this turn (fire-and-forget).
    memory.extract(userId, `User: ${text}\nAssistant: ${reply.text}`)
      .then((facts) => Promise.all(facts.map((f) => memory.save(userId, f))))
      .catch(() => {});

    res.json({ ...reply, pendingApprovals: held, executed: held.length === 0 });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code });
  }
});

// --- Streaming chat ------------------------------------------------------
// POST /api/chat/stream → SSE: `data: {"token":"..."}` … then
// `data: {"done":true, ...full reply...}`. Same approval gating as /api/chat.
app.post('/api/chat/stream', async (req, res) => {
  const { text, threadId } = req.body || {};
  const userId = req.userId || req.body?.userId || 'local';
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    const reply = await runAgentTurnStream({
      text, userId, threadId,
      onToken: (token) => send({ token }),
    });
    const held = [];
    for (const t of (reply.toolsUsed || []).filter((t) => t.risk !== 'low')) {
      const rec = await approvals.create({ toolName: t.name, args: t.args, userId, threadId });
      held.push({ id: rec.id, name: rec.tool, risk: rec.risk, args: rec.args });
    }
    memory.extract(userId, `User: ${text}\nAssistant: ${reply.text}`)
      .then((facts) => Promise.all(facts.map((f) => memory.save(userId, f))))
      .catch(() => {});
    send({ done: true, text: reply.text, toolsUsed: reply.toolsUsed, mode: reply.mode, pendingApprovals: held, executed: held.length === 0 });
  } catch (e) {
    send({ done: true, error: e.message, code: e.code });
  }
  res.end();
});

// --- Auth (Supabase magic link) ------------------------------------------
app.post('/api/auth/otp', async (req, res) => {
  try {
    await sendMagicLink(req.body?.email);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.code === 'BAD_EMAIL' ? 400 : 500).json({ error: e.message, code: e.code });
  }
});

app.get('/api/auth/me', requireUser, (req, res) => {
  res.json({ id: req.userId, email: req.userEmail });
});

// --- Memories ------------------------------------------------------------
app.get('/api/memories', requireUser, async (req, res) => {
  res.json(await memory.list(req.userId));
});

app.post('/api/memories', requireUser, async (req, res) => {
  const { key, value, kind } = req.body || {};
  if (!key || !value) return res.status(400).json({ error: 'key and value are required' });
  res.json(await memory.save(req.userId, { key, value, kind }));
});

app.delete('/api/memories/:id', requireUser, async (req, res) => {
  await memory.remove(req.userId, req.params.id);
  res.json({ ok: true });
});

// --- Privacy: export + delete --------------------------------------------
const USER_TABLES = ['ring_oauth_tokens', 'ring_approvals', 'ring_threads', 'ring_messages', 'ring_memories', 'ring_tool_runs'];

app.get('/api/export', requireUser, async (req, res) => {
  if (!SB_ENABLED) return res.status(501).json({ error: 'persistence not configured' });
  const out = { user: { id: req.userId, email: req.userEmail }, exportedAt: new Date().toISOString(), data: {} };
  for (const t of USER_TABLES) {
    out.data[t] = await sbRequest('GET', `/${t}?user_id=${eq(req.userId)}&select=*`);
  }
  res.json(out);
});

app.delete('/api/account', requireUser, async (req, res) => {
  if (!SB_ENABLED) return res.status(501).json({ error: 'persistence not configured' });
  for (const t of USER_TABLES) {
    await sbRequest('DELETE', `/${t}?user_id=${eq(req.userId)}`);
  }
  res.json({ ok: true, deletedUser: req.userId });
});

// --- Approvals -----------------------------------------------------------
app.get('/api/approvals', async (req, res) => {
  res.json(await approvals.listPending(req.userId || req.query.userId));
});

app.post('/api/approvals/:id/resolve', optionalUser, async (req, res) => {
  try {
    const rec = await approvals.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'approval not found' });
    // Legacy unauthenticated 'local' cards stay resolvable without auth.
    // Anything owned by a real user needs their token.
    if (rec.userId !== 'local' && rec.userId !== req.userId)
      return res.status(rec.userId && req.userId ? 403 : 401).json({ error: 'forbidden' });
    const out = await approvals.resolve(req.params.id, req.body?.decision);
    res.json(out);
  } catch (e) {
    res.status(e.code === 'NOT_FOUND' ? 404 : 500).json({ error: e.message });
  }
});

// --- Group threads -------------------------------------------------------
app.get('/api/threads', async (req, res) => res.json(await threads.listThreads()));

app.post('/api/threads', async (req, res) => {
  const { name, members } = req.body || {};
  res.json(await threads.createThread({ name, members }));
});

app.get('/api/threads/:id/messages', async (req, res) => {
  const th = await threads.getThread(req.params.id);
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

app.get('/api/threads/:id/stream', async (req, res) => {
  const th = await threads.getThread(req.params.id);
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
// Tokens stay server-side in lib/google.js (Supabase ring_oauth_tokens,
// file fallback for local dev).
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
    state: req.userId && req.userId !== 'local' ? req.userId : 'local',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString());
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
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
    saveTokens(state && typeof state === 'string' ? state : 'local', tok);
    res.send('<p style="font-family:sans-serif">Gmail + Calendar connected. Close this tab and return to the app.</p>');
  } catch (e) {
    res.status(500).send('OAuth failed: ' + e.message);
  }
});

// --- Voice (ring hardware path) -------------------------------------------
// Phone app posts base64 audio from the ring's BLE mic stream; the server
// transcribes, runs the agent turn, and (when TTS is configured) speaks back.
app.post('/api/voice', async (req, res) => {
  const { audio, mime } = req.body || {};
  const userId = req.userId || req.body?.userId || 'local';
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: 'audio is required', code: 'EMPTY_AUDIO' });
  }
  try {
    const out = await processVoice({ audioBase64: audio, mimeType: mime, userId });

    // Approval gate: mirrors /api/chat — medium/high-risk calls are HELD.
    const held = [];
    for (const t of (out.toolsUsed || []).filter((t) => t.risk !== 'low')) {
      const rec = await approvals.create({ toolName: t.name, args: t.args, userId, threadId: null });
      held.push({ id: rec.id, name: rec.tool, risk: rec.risk, args: rec.args });
    }

    res.json({
      transcript: out.transcript,
      text: out.text,
      audio: out.audioBase64, // base64 mp3, or null when TTS unavailable
      pendingApprovals: held,
      executed: held.length === 0,
    });
  } catch (e) {
    const status = e.code === 'VOICE_NOT_CONFIGURED' ? 501
      : e.code === 'EMPTY_AUDIO' ? 400
      : e.code === 'VOICE_RATE_LIMITED' ? 429 : 500;
    res.status(status).json({ error: e.message, code: e.code || 'VOICE_FAILED' });
  }
});

module.exports = app;
if (require.main === module) {
  const PORT = env('PORT', '3000');
  googleReady().then(() => {
    app.listen(PORT, () => console.log(`Ring backend live → http://localhost:${PORT}  (api: /api/health)`));
  });
}
