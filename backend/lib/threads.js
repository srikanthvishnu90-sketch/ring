// Group threads: the product's core social surface.
//
// A thread is a group chat with members. Anyone can post; mentioning the
// agent (@<AGENT_NAME>, default @ring) routes the message through the same
// agent loop as 1:1 chat, with the thread as context. The agent's reply —
// including any held approvals — lands back in the thread for everyone.
//
// Realtime: SSE at GET /api/threads/:id/stream (works on serverless; plain
// WebSocket doesn't). In-memory here; move to Supabase (Realtime) for prod.
const { runAgentTurn } = require('./agent');
const approvals = require('./approvals');

const threads = new Map();
const sseClients = new Map(); // threadId -> Set<res>
let tseq = 1;

const AGENT_NAME = (process.env.AGENT_NAME || 'ring').toLowerCase();

function createThread({ name, members }) {
  const id = 'th_' + tseq++ + '_' + Date.now().toString(36);
  const th = { id, name: name || 'New group', members: members || [], messages: [], createdAt: new Date().toISOString() };
  threads.set(id, th);
  return th;
}

function getThread(id) {
  return threads.get(id);
}

function listThreads() {
  return [...threads.values()].map((t) => ({ ...t, messages: t.messages.slice(-1) }));
}

function broadcast(threadId, event) {
  const clients = sseClients.get(threadId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch (e) { /* dead client, cleaned on close */ }
  }
}

function subscribe(threadId, res) {
  if (!sseClients.has(threadId)) sseClients.set(threadId, new Set());
  sseClients.get(threadId).add(res);
}

function unsubscribe(threadId, res) {
  sseClients.get(threadId)?.delete(res);
}

async function postMessage(threadId, { from, text }) {
  const th = threads.get(threadId);
  if (!th) throw Object.assign(new Error('thread not found'), { code: 'NOT_FOUND' });
  const msg = { id: 'm_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), from, text, at: new Date().toISOString() };
  th.messages.push(msg);
  broadcast(threadId, { type: 'message', message: msg });

  // @agent mention → agent turn with thread context
  if (new RegExp(`@${AGENT_NAME}\\b`, 'i').test(text)) {
    const history = th.messages.slice(-12).map((m) => `${m.from}: ${m.text}`).join('\n');
    let reply;
    try {
      reply = await runAgentTurn({
        text: `You are @${AGENT_NAME} in the group chat "${th.name}" with members: ${th.members.join(', ') || 'unknown'}. Recent messages:\n${history}\n\nRespond to the latest message from ${from}. If they want options (restaurants, times), offer 2-3 concrete options and say you'll book once they pick one.`,
        userId: 'local',
        threadId,
      });
    } catch (e) {
      reply = { text: "Couldn't reach my brain just now — try again in a moment.", toolsUsed: [] };
    }
    const held = (reply.toolsUsed || [])
      .filter((t) => t.risk !== 'low')
      .map((t) => {
        const rec = approvals.create({ toolName: t.name, args: t.args, userId: 'local', threadId });
        return { id: rec.id, name: rec.tool, risk: rec.risk, args: rec.args };
      });
    const amsg = {
      id: 'm_' + Date.now().toString(36) + 'a',
      from: 'agent',
      text: reply.text,
      at: new Date().toISOString(),
      pendingApprovals: held,
    };
    th.messages.push(amsg);
    broadcast(threadId, { type: 'message', message: amsg });
  }
  return msg;
}

module.exports = { createThread, getThread, listThreads, postMessage, subscribe, unsubscribe, AGENT_NAME };
