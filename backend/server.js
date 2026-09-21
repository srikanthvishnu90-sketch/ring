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
//   POST /api/twilio/inbound            → Twilio SMS/WhatsApp webhook (signature-verified)
//
// Static: serves ../index.html so one `npm start` runs the whole prototype
// with the API live underneath it.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
require('dotenv').config();

const { env, missing } = require('./lib/config');
const { saveTokens, ready: googleReady } = require('./lib/google');
const { TOOLS, runAgentTurn, runAgentTurnStream, llmConfigured } = require('./lib/agent');
const approvals = require('./lib/approvals');
const threads = require('./lib/threads');
const memory = require('./lib/memory');
const { sendMagicLink, requireUser, optionalUser, validateToken, bearerToken } = require('./lib/auth');
const { processVoice } = require('./lib/voice');
const { sbRequest, eq, ENABLED: SB_ENABLED } = require('./lib/supabase');

const connectors = {
  gmail: require('./connectors/gmail'),
  calendar: require('./connectors/calendar'),
  places: require('./connectors/places'),
  uber: require('./connectors/uber'),
  dining: require('./connectors/dining'),
  twilio: require('./connectors/twilio'),
  telegram: require('./connectors/telegram'),
  stripe: require('./connectors/stripe'),
};
const { connectorStatus } = require('./connectors/registry');

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
  // Registry view (same data, single source of truth going forward).
  try { Object.assign(out.connectors, connectorStatus()); } catch (e) { /* never break health */ }
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
  // Caller identity: a valid Supabase JWT → real user id; anything else →
  // the 'demo' sandbox. Demo turns run simulated tools only and can never
  // create real approval cards. There is no unauthenticated 'local'
  // identity anymore — 'local' is a legacy card owner that can never
  // execute. (The request body's userId is deliberately ignored.)
  const authed = req.userId && req.userId !== 'local';
  const userId = authed ? req.userId : 'demo';
  const demo = !authed;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
  try {
    const reply = await runAgentTurn({ text, userId, threadId, demo });

    // Approval gate: medium/high-risk calls are HELD as approval records —
    // never executed silently. The client renders them as approval cards and
    // resolves them via POST /api/approvals/:id/resolve.
    const held = [];
    for (const t of (reply.toolsUsed || []).filter((t) => t.risk !== 'low')) {
      const rec = await approvals.create({ toolName: t.name, args: t.args, userId, threadId });
      held.push({ id: rec.id, name: rec.tool, risk: rec.risk, args: rec.args });
    }

    // Learn loop: extract durable facts from this turn (fire-and-forget).
    // Demo turns are never memorized.
    if (!demo) {
      memory.extract(userId, `User: ${text}\nAssistant: ${reply.text}`)
        .then((facts) => Promise.all(facts.map((f) => memory.save(userId, f))))
        .catch(() => {});
    }

    res.json({ ...reply, demo, pendingApprovals: held, executed: held.length === 0 });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code });
  }
});

// --- Streaming chat ------------------------------------------------------
// POST /api/chat/stream → SSE: `data: {"token":"..."}` … then
// `data: {"done":true, ...full reply...}`. Same approval gating as /api/chat.
app.post('/api/chat/stream', async (req, res) => {
  const { text, threadId } = req.body || {};
  const authed = req.userId && req.userId !== 'local';
  const userId = authed ? req.userId : 'demo';
  const demo = !authed;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    const reply = await runAgentTurnStream({
      text, userId, threadId, demo,
      onToken: (token) => send({ token }),
    });
    const held = [];
    for (const t of (reply.toolsUsed || []).filter((t) => t.risk !== 'low')) {
      const rec = await approvals.create({ toolName: t.name, args: t.args, userId, threadId });
      held.push({ id: rec.id, name: rec.tool, risk: rec.risk, args: rec.args });
    }
    if (!demo) {
      memory.extract(userId, `User: ${text}\nAssistant: ${reply.text}`)
        .then((facts) => Promise.all(facts.map((f) => memory.save(userId, f))))
        .catch(() => {});
    }
    send({ done: true, text: reply.text, toolsUsed: reply.toolsUsed, mode: reply.mode, demo, pendingApprovals: held, executed: held.length === 0 });
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
const USER_TABLES = ['ring_oauth_tokens', 'ring_approvals', 'ring_threads', 'ring_messages', 'ring_memories', 'ring_tool_runs', 'ring_devices'];

app.get('/api/export', requireUser, async (req, res) => {
  if (!SB_ENABLED) return res.status(501).json({ error: 'persistence not configured' });
  const out = { user: { id: req.userId, email: req.userEmail }, exportedAt: new Date().toISOString(), data: {} };
  for (const t of USER_TABLES) {
    out.data[t] = await sbRequest('GET', `/${t}?user_id=eq.${eq(req.userId)}&select=*`);
  }
  res.json(out);
});

app.delete('/api/account', requireUser, async (req, res) => {
  if (!SB_ENABLED) return res.status(501).json({ error: 'persistence not configured' });
  for (const t of USER_TABLES) {
    await sbRequest('DELETE', `/${t}?user_id=eq.${eq(req.userId)}`);
  }
  res.json({ ok: true, deletedUser: req.userId });
});

// --- Approvals -----------------------------------------------------------
app.get('/api/approvals', requireUser, async (req, res) => {
  res.json(await approvals.listPending(req.userId));
});

app.post('/api/approvals/:id/resolve', async (req, res) => {
  try {
    const rec = await approvals.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'approval not found' });
    // Demo sandbox cards resolve without auth, but can only ever run the
    // simulated tools (enforced inside approvals.resolve) — no real-world
    // effect is possible from a demo card, no matter who resolves it.
    if (rec.userId === 'demo') {
      return res.json(await approvals.resolve(req.params.id, req.body?.decision));
    }
    // Legacy pre-auth 'local' cards are dead: they can never execute again.
    if (rec.userId === 'local') {
      return res.status(410).json({ error: 'legacy approval expired — sign in and retry', code: 'LEGACY_CARD' });
    }
    // Real user cards need the card owner's token. (We validate the bearer
    // directly instead of trusting the global optionalUser fallback.)
    const jwt = bearerToken(req);
    if (!jwt) return res.status(401).json({ error: 'missing authorization token', code: 'UNAUTHORIZED' });
    let me;
    try {
      me = await validateToken(jwt);
    } catch (e) {
      return res.status(401).json({ error: e.message || 'invalid token', code: e.code || 'UNAUTHORIZED' });
    }
    if (me.id !== rec.userId) return res.status(403).json({ error: 'forbidden', code: 'FORBIDDEN' });
    const out = await approvals.resolve(req.params.id, req.body?.decision, { executorUserId: me.id });
    res.json(out);
  } catch (e) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'FORBIDDEN' ? 403 : e.code === 'LEGACY_CARD' ? 410 : 500;
    res.status(status).json({ error: e.message, code: e.code });
  }
});

// --- Webhook inbound (Home Assistant etc. → Ring) ---------------------------
// External services push events here. Per-name secret via RING_INBOUND_SECRETS
// = JSON {name: secret}, sent as ?secret= or the X-Webhook-Secret header.
// Unknown name → 404, wrong secret → 403 (the two are intentionally distinct).
app.post('/api/webhooks/in/:name', async (req, res) => {
  let secrets = {};
  try { secrets = JSON.parse(process.env.RING_INBOUND_SECRETS || '{}'); } catch (e) { /* malformed env */ }
  const expected = secrets[req.params.name];
  if (!expected) return res.status(404).json({ error: 'not found' });
  const got = req.query.secret || req.get('x-webhook-secret') || '';
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(403).json({ error: 'forbidden' });

  let th = (await threads.listThreads()).find((t) => t.name === 'Automations');
  if (!th) th = await threads.createThread({ name: 'Automations', members: [] });
  const body = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '';
  const text = `⚡ ${req.params.name}${body ? ': ' + body : ''}`;
  const msg = await threads.postMessage(th.id, { from: req.params.name, text });
  res.json({ ok: true, threadId: th.id, messageId: msg.id });
});

// --- Telegram webhook -----------------------------------------------------
// Telegram delivers inbound messages here. When TELEGRAM_WEBHOOK_SECRET is set,
// the request must carry it in the X-Telegram-Bot-Api-Secret-Token header
// (Telegram sends this automatically when secret_token was passed to
// setWebhook). A ?secret= query fallback exists for manual testing.
// Wrong secret → 403. Each sender gets their own thread; the message is
// stored and broadcast (threads.postMessage handles that), and the bot
// ANSWERS in the chat. Replies run in the same 'demo' sandbox as the
// signed-out web chat: simulated tools only, no memory learning, and any
// approval card created is owned by 'demo' so it can never execute a real
// tool. Held actions point the user at the Ring app for approval.
// Best-effort dedup of update_ids guards against Telegram retries.
const _seenTgUpdates = new Set();
const TG_BOT_USERNAME = '@ring_assistant_vishnu_bot';
const TG_CHUNK = 4000;

function tgChunks(s) {
  const out = [];
  const t = String(s || '');
  for (let i = 0; i < t.length; i += TG_CHUNK) out.push(t.slice(i, i + TG_CHUNK));
  return out.length ? out : [''];
}

app.post('/api/telegram/webhook', async (req, res) => {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  // Fail closed: no secret configured means the webhook is disabled.
  if (!expected) return res.status(403).json({ error: 'webhook_not_configured' });
  const headerSecret = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
  const querySecret = req.query.secret || '';
  const got = headerSecret || querySecret;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(403).json({ error: 'forbidden' });

  const update = req.body || {};
  if (update.update_id != null) {
    if (_seenTgUpdates.has(update.update_id)) return res.json({ ok: true, duplicate: true });
    _seenTgUpdates.add(update.update_id);
    if (_seenTgUpdates.size > 1000) _seenTgUpdates.clear();
  }

  const msg = update.message;
  const chatId = msg && msg.chat && msg.chat.id;
  const chatType = msg && msg.chat && msg.chat.type; // private | group | supergroup | channel
  let text = msg && msg.text;
  const from = (msg && msg.from && (msg.from.first_name || msg.from.username)) || 'telegram';

  const trySend = async (t) => {
    try { await connectors.telegram.sendMessage({ chat_id: chatId, text: t }); return true; }
    catch (e) { return false; }
  };

  if (!text || !chatId) {
    if (chatId && chatType === 'private') {
      await trySend('I can only read text messages for now — send me text and I\u2019ll answer.');
    }
    return res.json({ ok: true, ignored: true });
  }

  // In groups, only answer when addressed: @mention or reply to the bot.
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (isGroup) {
    const mentioned = text.includes(TG_BOT_USERNAME);
    const replyToBot = !!(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot);
    if (!mentioned && !replyToBot) return res.json({ ok: true, ignored: true, reason: 'group_not_addressed' });
    text = text.split(TG_BOT_USERNAME).join('').trim() || 'Hey';
  }

  const threadName = `Telegram — ${from}`;
  let th = (await threads.listThreads()).find((t) => t.name === threadName);
  if (!th) th = await threads.createThread({ name: threadName, members: [from] });
  const stored = await threads.postMessage(th.id, { from, text });

  // Answer back in Telegram. Errors here must never fail the webhook
  // (a 5xx makes Telegram retry and the user gets double replies).
  let replied = false;
  try {
    let out;
    if (text.trim() === '/start') {
      out = `Hey ${from}! I\u2019m Ring Assistant. Ask me anything and I\u2019ll answer right here. I\u2019m in demo mode in this chat, so for real actions (email, bookings) open the Ring app: https://ringsss.vercel.app`;
    } else {
      const reply = await runAgentTurn({ text, userId: 'demo', threadId: th.id, demo: true });
      const held = [];
      for (const t of (reply.toolsUsed || []).filter((t) => t.risk !== 'low')) {
        held.push(await approvals.create({ toolName: t.name, args: t.args, userId: 'demo', threadId: th.id }));
      }
      out = (reply.text || '').trim() || 'Got it.';
      if (held.length) {
        out += `\n\n\u23f3 That needs your approval first \u2014 I\u2019ve queued it in the Ring app: https://ringsss.vercel.app`;
      }
    }
    for (const chunk of tgChunks(out)) {
      // eslint-disable-next-line no-await-in-loop
      await trySend(chunk);
    }
    await threads.postMessage(th.id, { from: 'Ring Assistant', text: out }).catch(() => {});
    replied = true;
  } catch (e) {
    await trySend('Hmm, something glitched on my end \u2014 try again in a moment.');
  }
  res.json({ ok: true, threadId: th.id, messageId: stored.id, replied });
});

// --- Ring devices (hardware) -----------------------------------------------
const DEV_TBL = 'ring_devices';
const audit = (() => { try { return require('./lib/audit'); } catch { return null; } })();

app.get('/api/devices', requireUser, async (req, res) => {
  if (!SB_ENABLED) return res.status(501).json({ error: 'persistence not configured' });
  const rows = await sbRequest('GET', `/${DEV_TBL}?user_id=eq.${eq(req.userId)}&select=*&order=last_seen_at.desc`);
  res.json(rows || []);
});

app.post('/api/devices/register', requireUser, async (req, res) => {
  if (!SB_ENABLED) return res.status(501).json({ error: 'persistence not configured' });
  const { ble_id, name, firmware } = req.body || {};
  if (!ble_id) return res.status(400).json({ error: 'ble_id is required' });
  const now = new Date().toISOString();
  const existing = await sbRequest('GET', `/${DEV_TBL}?ble_id=eq.${eq(ble_id)}&select=id,user_id`);
  let row;
  if (existing && existing.length) {
    if (existing[0].user_id !== req.userId) return res.status(409).json({ error: 'device is paired to another account' });
    row = await sbRequest(`/${DEV_TBL}?ble_id=eq.${eq(ble_id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ last_seen_at: now, ...(name ? { name } : {}), ...(firmware ? { firmware } : {}) }),
    });
    row = row && row[0];
  } else {
    row = await sbRequest(`/${DEV_TBL}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ user_id: req.userId, ble_id, name: name || null, firmware: firmware || null, last_seen_at: now }),
    });
    row = row && row[0];
  }
  res.json(row);
});

app.post('/api/devices/:id/battery', requireUser, async (req, res) => {
  if (!SB_ENABLED) return res.status(501).json({ error: 'persistence not configured' });
  const { level } = req.body || {};
  if (typeof level !== 'number' || level < 0 || level > 100)
    return res.status(400).json({ error: 'level must be a number 0-100' });
  const rows = await sbRequest('GET', `/${DEV_TBL}?id=eq.${eq(req.params.id)}&select=id,user_id`);
  if (!rows || !rows.length) return res.status(404).json({ error: 'device not found' });
  if (rows[0].user_id !== req.userId) return res.status(403).json({ error: 'forbidden' });
  await sbRequest(`/${DEV_TBL}?id=eq.${eq(req.params.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ battery: Math.round(level), last_seen_at: new Date().toISOString() }),
  });
  res.json({ ok: true });
});

// Tap events from the ring. Double-tap approves the most recent pending card
// (haptic success/error tells the app what to buzz), long-press declines it.
app.post('/api/devices/:id/tap', requireUser, async (req, res) => {
  if (!SB_ENABLED) return res.status(501).json({ error: 'persistence not configured' });
  const { type } = req.body || {};
  if (!['single', 'double', 'long'].includes(type))
    return res.status(400).json({ error: "type must be 'single', 'double', or 'long'" });
  const devs = await sbRequest('GET', `/${DEV_TBL}?id=eq.${eq(req.params.id)}&select=id,user_id`);
  if (!devs || !devs.length) return res.status(404).json({ error: 'device not found' });
  if (devs[0].user_id !== req.userId) return res.status(403).json({ error: 'forbidden' });

  await sbRequest(`/${DEV_TBL}?id=eq.${eq(req.params.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  });

  if (type === 'single') return res.json({ action: 'voice_invoke' });

  const pending = await approvals.listPending(req.userId);
  if (!pending.length) return res.json({ action: type === 'double' ? 'voice_invoke' : 'noop', haptic: 'error', pending: 0 });

  const card = pending[pending.length - 1]; // most recent
  const decision = type === 'double' ? 'approve' : 'decline';
  // Tap is an authenticated device action: the card owner is req.userId, so
  // execution is authorized here. Demo/legacy cards can never appear in this
  // list (listPending is scoped to the user), and resolve() enforces the
  // ownership policy a second time.
  const rec = await approvals.resolve(card.id, decision, { executorUserId: req.userId });
  if (audit) audit.logToolRun({
    userId: req.userId,
    tool: `ring_tap_${decision}`,
    args: { deviceId: req.params.id, approvalId: card.id, tool: card.tool },
    result: { status: rec.status },
    approvalId: card.id,
    status: decision === 'approve' ? 'approved' : 'held',
  }).catch(() => {});
  res.json({
    action: decision === 'approve' ? 'approved' : 'declined',
    approvalId: card.id,
    tool: card.tool,
    haptic: decision === 'approve' ? 'success' : 'error',
    pending: pending.length - 1,
  });
});

// --- Twilio inbound SMS/WhatsApp webhook ------------------------------------
// Configure in the Twilio console as the messaging webhook for your number.
// Validates X-Twilio-Signature; on success the message lands in a per-sender
// thread (created on first contact) and broadcasts to chat clients. No
// auto-reply — replies go out only when the user approves them via chat.
app.post(
  '/api/twilio/inbound',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    try {
      const twilio = require('./connectors/twilio');
      const url = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '') + req.path;
      const sig = req.get('X-Twilio-Signature');
      if (!twilio.validateSignature(url, req.body || {}, sig)) {
        return res.status(403).json({ error: 'invalid Twilio signature' });
      }
      const from = (req.body.From || '').replace(/^whatsapp:/, '');
      const body = (req.body.Body || '').trim();
      if (!from || !body) return res.status(200).type('text/xml').send('<Response/>');
      const threadName = `SMS ${from}`;
      let thread = (await threads.listThreads()).find((t) => t.name === threadName);
      if (!thread) thread = await threads.createThread({ name: threadName, members: [from] });
      await threads.postMessage(thread.id, { from, text: body });
      res.status(200).type('text/xml').send('<Response/>');
    } catch (e) {
      res.status(500).json({ error: 'inbound failed' });
    }
  }
);

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
  const authed = req.userId && req.userId !== 'local';
  const userId = authed ? req.userId : 'demo';
  const demo = !authed;
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: 'audio is required', code: 'EMPTY_AUDIO' });
  }
  try {
    const out = await processVoice({ audioBase64: audio, mimeType: mime, userId, demo });

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
      demo,
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
