// Durable memory: per-user facts/preferences the agent remembers across
// sessions. Supabase (ring_memories) when configured, in-memory otherwise.
// Keyword-overlap recall keeps this dependency-free (no embeddings).
//
// NOTE: does not require ./agent — agent.js will require this module, so
// keep it free of the agent dependency to avoid a require cycle. The LLM
// provider logic below mirrors agent.js's (same env keys).
const { env } = require('./config');
const { ENABLED, sbRequest, eq } = require('./supabase');

const TBL = 'ring_memories';
const FETCH_CAP = 200;

// ---- in-memory fallback (local dev) ----
const mem = new Map(); // `${userId}:${key}` -> record
let seq = 1;

const nowIso = () => new Date().toISOString();
const newId = () => 'mem_' + Date.now().toString(36) + (seq++).toString(36);

function toRec(row) {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind || 'fact',
    key: row.key,
    value: row.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 1. List all memories for a user, newest last.
async function list(userId) {
  if (ENABLED) {
    const rows = await sbRequest(
      `/${TBL}?select=*&user_id=eq.${eq(userId)}&order=created_at.asc&limit=${FETCH_CAP}`
    );
    return (rows || []).map(toRec);
  }
  return [...mem.values()]
    .filter((r) => r.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map(toRec);
}

// 2. Upsert on (user_id, key). Returns the record.
async function save(userId, { key, value, kind }) {
  if (!key || value == null) throw new Error('key and value are required');
  const k = kind || 'fact';
  if (ENABLED) {
    const existing = await sbRequest(
      `/${TBL}?select=*&user_id=eq.${eq(userId)}&key=eq.${eq(key)}&limit=1`
    );
    const now = nowIso();
    if (existing && existing.length) {
      const rows = await sbRequest(`/${TBL}?id=eq.${eq(existing[0].id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ value, kind: k, updated_at: now }),
      });
      return toRec(rows[0]);
    }
    const rows = await sbRequest(`/${TBL}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        id: newId(), user_id: userId, kind: k, key, value,
        created_at: now, updated_at: now,
      }),
    });
    return toRec(rows[0]);
  }
  const mk = `${userId}:${key}`;
  const prev = mem.get(mk);
  const rec = prev
    ? { ...prev, value, kind: k, updatedAt: nowIso() }
    : { id: newId(), userId, kind: k, key, value, createdAt: nowIso(), updatedAt: nowIso() };
  mem.set(mk, rec);
  return rec;
}

// 3. Delete one memory.
async function remove(userId, id) {
  if (ENABLED) {
    await sbRequest(`/${TBL}?id=eq.${eq(id)}&user_id=eq.${eq(userId)}`, { method: 'DELETE' });
    return;
  }
  for (const [mk, r] of mem) {
    if (r.userId === userId && r.id === id) { mem.delete(mk); break; }
  }
}

// ---- keyword recall (dependency-free) ----

const STOPWORDS = new Set(
  'a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,can,could,should,shall,may,might,must,i,you,he,she,it,we,they,me,him,her,us,them,my,your,his,its,our,their,this,that,these,those,what,which,who,whom,how,when,where,why,not,no,yes,so,very,just,about,into,over,after,before,between,up,down,out,off,again,once,here,there,all,any,both,each,few,more,most,other,some,such,only,own,same,than,too,also'.split(',')
);

function tokens(s) {
  return (s || '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/'s$/, ''))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// 4. Rank the user's memories by keyword overlap with `text`.
async function recall(userId, text, limit = 8) {
  const all = await list(userId);
  const q = new Set(tokens(text));
  if (!q.size) return [];
  const scored = all
    .map((m) => {
      const mt = new Set([...tokens(m.key), ...tokens(m.value)]);
      let score = 0;
      for (const t of q) if (mt.has(t)) score++;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ key: s.m.key, value: s.m.value }));
  return scored;
}

// ---- LLM extraction (mirrors agent.js provider config) ----

function llmConfigured() {
  const p = env('LLM_PROVIDER', 'openai');
  return p === 'anthropic' ? !!env('ANTHROPIC_API_KEY') : !!env('OPENAI_API_KEY');
}

const EXTRACT_SYSTEM = `Extract durable facts about the user from the conversation below — things worth remembering long-term: their name, preferences, tastes, routines, ongoing projects, important people. Output ONLY a JSON array of objects with "key" (short snake_case label like "favorite_cuisine") and "value" (concise fact). Maximum 5 entries. Ignore trivia, one-off remarks, and anything about the assistant. If nothing durable, output [].`;

function parseExtracted(text) {
  try {
    const clean = (text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const arr = JSON.parse(clean);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.key === 'string' && typeof e.value === 'string')
      .slice(0, 5)
      .map((e) => ({ key: e.key.trim(), value: e.value.trim(), kind: 'fact' }))
      .filter((e) => e.key && e.value);
  } catch {
    return [];
  }
}

async function callExtractOpenAI(conversationText) {
  const base = env('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env('AGENT_MODEL', 'gpt-4o'),
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: conversationText.slice(0, 6000) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content || '[]';
}

async function callExtractAnthropic(conversationText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env('AGENT_MODEL', 'claude-sonnet-4-5'),
      max_tokens: 512,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: conversationText.slice(0, 6000) }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') || '[]';
}

// 5. Extract durable facts from a conversation. [] on any failure.
async function extract(userId, conversationText) {
  try {
    if (!conversationText || !llmConfigured()) return [];
    const provider = env('LLM_PROVIDER', 'openai');
    const raw = provider === 'anthropic'
      ? await callExtractAnthropic(conversationText)
      : await callExtractOpenAI(conversationText);
    return parseExtracted(raw);
  } catch {
    return [];
  }
}

// 6. Prompt-ready memory block for the agent turn.
async function contextBlock(userId, text) {
  const hits = await recall(userId, text);
  if (!hits.length) return '';
  return 'What you remember about the user:\n' + hits.map((h) => `- ${h.key}: ${h.value}`).join('\n');
}

module.exports = { list, save, remove, recall, extract, contextBlock };
