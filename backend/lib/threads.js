// Group threads: the product's core social surface.
//
// A thread is a group chat with members. Anyone can post; mentioning the
// agent (@<AGENT_NAME>, default @ring) routes the message through the same
// agent loop as 1:1 chat, with the thread as context. The agent's reply —
// including any held approvals — lands back in the thread for everyone.
//
// Persistence: Supabase (ring_threads, ring_messages) when configured,
// in-memory otherwise. Realtime: SSE at GET /api/threads/:id/stream covers
// same-instance clients; broadcast() also fans out through Supabase Realtime
// Broadcast so websocket subscribers get messages posted on any instance.
const { runAgentTurn } = require('./agent');
const approvals = require('./approvals');
const { broadcastRealtime } = require('./realtime');
const { ENABLED, sbRequest, eq } = require('./supabase');

const THREADS_TBL = 'ring_threads';
const MSGS_TBL = 'ring_messages';

const AGENT_NAME = (process.env.AGENT_NAME || 'ring').toLowerCase();

// ---- in-memory fallback (local dev) ----
const memThreads = new Map();
let tseq = 1;

// ---- SSE (always in-memory, per instance) ----
const sseClients = new Map(); // threadId -> Set<res>

function newThreadId() {
  return 'th_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
function newMsgId() {
  return 'm_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

function toThread(row, messages) {
  return {
    id: row.id,
    name: row.name,
    members: row.members || [],
    messages: messages || [],
    createdAt: row.created_at,
  };
}
function toMsg(row) {
  return {
    id: row.id,
    from: row.sender,
    text: row.text,
    at: row.created_at,
    ...(row.pending_approvals ? { pendingApprovals: row.pending_approvals } : {}),
  };
}

async function dbMessages(threadId, limit) {
  const lim = limit ? `&limit=${limit}` : '';
  const rows = await sbRequest(
    `/${MSGS_TBL}?select=*&thread_id=eq.${eq(threadId)}&order=created_at.asc${lim}`
  );
  return (rows || []).map(toMsg);
}

// Ownership model: a thread belongs to its members. The thread's `members`
// array holds Supabase user UUIDs for app-created threads; webhook-created
// threads (Telegram etc.) hold the external sender name instead, so they
// never match a user id and stay out of user listings.
function isMember(thread, userId) {
  return !!userId && Array.isArray(thread.members) && thread.members.includes(userId);
}

async function createThread({ name, members, userId }) {
  const mems = [...(members || [])];
  if (userId && !mems.includes(userId)) mems.push(userId);
  const rec = {
    id: newThreadId(),
    name: name || 'New group',
    members: mems,
    createdAt: new Date().toISOString(),
  };
  if (ENABLED) {
    await sbRequest(`/${THREADS_TBL}`, {
      method: 'POST',
      body: JSON.stringify({
        id: rec.id, name: rec.name, members: mems, created_at: rec.createdAt,
      }),
    });
    return { ...rec, messages: [] };
  }
  const th = { ...rec, messages: [] };
  memThreads.set(rec.id, th);
  return th;
}

async function getThread(id) {
  if (ENABLED) {
    const rows = await sbRequest(`/${THREADS_TBL}?select=*&id=eq.${eq(id)}&limit=1`);
    if (!rows || !rows.length) return undefined;
    return toThread(rows[0], await dbMessages(id));
  }
  return memThreads.get(id);
}

async function listThreads({ userId } = {}) {
  if (ENABLED) {
    // members is jsonb: PostgREST contains filter matches the user id.
    const scope = userId ? `&members=cs.${encodeURIComponent(JSON.stringify([userId]))}` : '';
    const rows = await sbRequest(`/${THREADS_TBL}?select=*&order=created_at.desc&limit=50${scope}`);
    const threads = rows || [];
    if (!threads.length) return [];
    const ids = threads.map((t) => t.id);
    const msgs = await sbRequest(
      `/${MSGS_TBL}?select=*&thread_id=in.(${ids.map(eq).join(',')})&order=created_at.desc&limit=${ids.length * 3}`
    );
    const lastByThread = {};
    for (const m of msgs || []) {
      if (!lastByThread[m.thread_id]) lastByThread[m.thread_id] = toMsg(m);
    }
    return threads.map((t) => toThread(t, lastByThread[t.id] ? [lastByThread[t.id]] : []));
  }
  const all = [...memThreads.values()].map((t) => ({ ...t, messages: t.messages.slice(-1) }));
  return userId ? all.filter((t) => isMember(t, userId)) : all;
}

function broadcast(threadId, event) {
  // Local path: SSE clients on this instance.
  const clients = sseClients.get(threadId);
  if (clients) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch (e) { /* dead client, cleaned on close */ }
    }
  }
  // Cross-instance path: Supabase Realtime Broadcast reaches websocket
  // subscribers no matter which instance posted the message. Fire-and-forget
  // — broadcastRealtime never throws, so the local path can't break.
  try {
    broadcastRealtime(`thread:${threadId}`, 'message', event).catch(() => {});
  } catch (e) { /* never break the local path */ }
}

function subscribe(threadId, res) {
  if (!sseClients.has(threadId)) sseClients.set(threadId, new Set());
  sseClients.get(threadId).add(res);
}

function unsubscribe(threadId, res) {
  sseClients.get(threadId)?.delete(res);
}

async function storeMessage(threadId, { from, text, pendingApprovals }) {
  const msg = {
    id: newMsgId(),
    from,
    text,
    at: new Date().toISOString(),
    ...(pendingApprovals ? { pendingApprovals } : {}),
  };
  if (ENABLED) {
    await sbRequest(`/${MSGS_TBL}`, {
      method: 'POST',
      body: JSON.stringify({
        id: msg.id,
        thread_id: threadId,
        sender: from,
        text,
        pending_approvals: pendingApprovals || null,
        created_at: msg.at,
      }),
    });
  } else {
    memThreads.get(threadId)?.messages.push(msg);
  }
  return msg;
}

async function postMessage(threadId, { from, text }) {
  const th = await getThread(threadId);
  if (!th) throw Object.assign(new Error('thread not found'), { code: 'NOT_FOUND' });

  const msg = await storeMessage(threadId, { from, text });
  broadcast(threadId, { type: 'message', message: msg });

  // @agent mention → agent turn with thread context.
  // Runs in DEMO MODE (simulated tools, 'demo'-owned cards) until thread
  // membership/ownership is enforced: an unauthenticated thread post must
  // never be able to trigger real tool calls or create executable cards.
  if (new RegExp(`@${AGENT_NAME}\\b`, 'i').test(text)) {
    const history = (await dbOrMemHistory(threadId))
      .slice(-12).map((m) => `${m.from}: ${m.text}`).join('\n');
    let reply;
    try {
      reply = await runAgentTurn({
        text: `You are @${AGENT_NAME} in the group chat "${th.name}" with members: ${th.members.join(', ') || 'unknown'}. Recent messages:\n${history}\n\nRespond to the latest message from ${from}. If they want options (restaurants, times), offer 2-3 concrete options and say you'll book once they pick one.`,
        userId: 'demo',
        demo: true,
        threadId,
      });
    } catch (e) {
      reply = { text: "Couldn't reach my brain just now — try again in a moment.", toolsUsed: [] };
    }
    const held = [];
    for (const t of (reply.toolsUsed || []).filter((t) => t.risk !== 'low')) {
      const rec = await approvals.create({ toolName: t.name, args: t.args, userId: 'demo', threadId });
      held.push({ id: rec.id, name: rec.tool, risk: rec.risk, args: rec.args });
    }
    const amsg = await storeMessage(threadId, {
      from: 'agent',
      text: reply.text,
      pendingApprovals: held.length ? held : undefined,
    });
    broadcast(threadId, { type: 'message', message: amsg });
  }
  return msg;
}

async function dbOrMemHistory(threadId) {
  if (ENABLED) return dbMessages(threadId, 12);
  return memThreads.get(threadId)?.messages || [];
}

// Last N messages, oldest-first — for giving chat surfaces (Telegram)
// short-term conversational context without a memory write.
async function getRecentMessages(threadId, limit = 10) {
  const lim = Math.min(Math.max(limit | 0, 1), 30);
  if (ENABLED) {
    const rows = await sbRequest(
      `/${MSGS_TBL}?select=id,sender,text,created_at&thread_id=eq.${eq(threadId)}&order=created_at.desc&limit=${lim}`
    );
    return (rows || []).reverse().map(toMsg);
  }
  const all = memThreads.get(threadId)?.messages || [];
  return all.slice(-lim);
}

module.exports = { createThread, getThread, listThreads, postMessage, subscribe, unsubscribe, getRecentMessages, isMember, AGENT_NAME };
