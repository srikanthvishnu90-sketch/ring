// Notes: per-user titled notes with tags. Supabase (ring_notes) when
// configured, in-memory otherwise. Follows the lib/memory.js pattern.
//
// NOTE: does not require ./agent — keep it free of the agent dependency to
// avoid a require cycle.
const { ENABLED, sbRequest, eq } = require('./supabase');

const TBL = 'ring_notes';
const FETCH_CAP = 200;

// ---- in-memory fallback (local dev) ----
const mem = new Map(); // id -> record
let seq = 1;

const nowIso = () => new Date().toISOString();
const newId = () => 'note_' + Date.now().toString(36) + (seq++).toString(36);

function toRec(row) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    content: row.content,
    tags: row.tags || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toListRec(r) {
  return { id: r.id, title: r.title, tags: r.tags, createdAt: r.createdAt };
}

// Escape PostgREST ilike wildcards in a user query.
function ilikeEsc(q) {
  return q.replace(/[%_*\\]/g, (c) => '\\' + c);
}

// ~120-char snippet centered on the first match of query in text.
function snippet(text, query) {
  const t = text || '';
  const i = t.toLowerCase().indexOf(String(query || '').toLowerCase());
  if (i < 0) return t.slice(0, 120) + (t.length > 120 ? '…' : '');
  const s = Math.max(0, i - 50);
  const e = Math.min(t.length, i + String(query).length + 70);
  return (s > 0 ? '…' : '') + t.slice(s, e).trim() + (e < t.length ? '…' : '');
}

// 1. Create a note. Title and content required.
async function save(userId, { title, content, tags }) {
  if (!title || !String(title).trim()) throw new Error('title is required');
  if (content == null || !String(content).trim()) throw new Error('content is required');
  const now = nowIso();
  const rec = {
    id: newId(),
    user_id: userId,
    title: String(title).trim(),
    content: String(content),
    tags: Array.isArray(tags) ? tags.map(String) : tags ? [String(tags)] : null,
    created_at: now,
    updated_at: now,
  };
  if (ENABLED) {
    const rows = await sbRequest(`/${TBL}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(rec),
    });
    return toRec(rows[0]);
  }
  const stored = toRec(rec);
  mem.set(stored.id, stored);
  return stored;
}

// 2. Recent notes, newest first — id/title/tags/created_at only.
async function list(userId, { limit = 20 } = {}) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  if (ENABLED) {
    const rows = await sbRequest(
      `/${TBL}?select=id,title,tags,created_at&user_id=eq.${eq(userId)}&order=created_at.desc&limit=${n}`
    );
    return (rows || []).map((r) => ({ id: r.id, title: r.title, tags: r.tags || [], createdAt: r.created_at }));
  }
  return [...mem.values()]
    .filter((r) => r.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, n)
    .map(toListRec);
}

// 3. Keyword search on title + content. Returns matches with snippets.
async function search(userId, { query, limit = 20 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query is required');
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  let rows;
  if (ENABLED) {
    const pat = `*${ilikeEsc(q)}*`;
    rows = await sbRequest(
      `/${TBL}?select=*&user_id=eq.${eq(userId)}&or=(title.ilike.${eq(pat)},content.ilike.${eq(pat)})&order=created_at.desc&limit=${n}`
    );
    rows = (rows || []).map(toRec);
  } else {
    const ql = q.toLowerCase();
    rows = [...mem.values()]
      .filter((r) => r.userId === userId &&
        (r.title.toLowerCase().includes(ql) || r.content.toLowerCase().includes(ql)))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, n);
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    tags: r.tags,
    createdAt: r.createdAt,
    snippet: snippet(
      r.title.toLowerCase().includes(q.toLowerCase()) ? `${r.title} — ${r.content}` : r.content,
      q
    ),
  }));
}

// 4. Full note by id.
async function get(userId, { id }) {
  if (!id) throw new Error('id is required');
  if (ENABLED) {
    const rows = await sbRequest(`/${TBL}?select=*&id=eq.${eq(id)}&user_id=eq.${eq(userId)}&limit=1`);
    if (!rows || !rows.length) throw new Error('note not found');
    return toRec(rows[0]);
  }
  const r = mem.get(id);
  if (!r || r.userId !== userId) throw new Error('note not found');
  return r;
}

// 5. Delete a note.
async function remove(userId, { id }) {
  if (!id) throw new Error('id is required');
  if (ENABLED) {
    await sbRequest(`/${TBL}?id=eq.${eq(id)}&user_id=eq.${eq(userId)}`, { method: 'DELETE' });
    return { deleted: id };
  }
  const r = mem.get(id);
  if (r && r.userId === userId) mem.delete(id);
  return { deleted: id };
}

module.exports = { save, list, search, get, remove };
