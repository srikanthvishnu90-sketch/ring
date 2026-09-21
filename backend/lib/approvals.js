// Pending approvals: the trust core. When the agent wants to run a
// medium/high-risk tool, the call is HELD here instead of executing.
// The client renders it as an approval card; resolving 'approve' executes
// the tool, 'decline' drops it. Nothing irreversible runs without this.
//
// Persistence: Supabase (ring_approvals) when configured, in-memory Map
// otherwise. resolve() claims the row atomically (UPDATE ... WHERE
// status='pending'), so double-resolve — including across serverless
// instances — can never execute a tool twice. create() dedupes identical
// pending approvals inside a short window and honors an explicit
// idempotencyKey, so retried agent turns don't stack duplicate cards.
const { TOOLS } = require('./agent');
const { logToolRun } = require('./audit');
const { ENABLED, sbRequest, eq } = require('./supabase');

const TBL = 'ring_approvals';
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

// ---- in-memory fallback (local dev) ----
const mem = new Map();
let seq = 1;
const memId = () => 'appr_' + seq++ + '_' + Date.now().toString(36);

function newId() {
  return 'appr_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function toRec(row) {
  return {
    id: row.id,
    tool: row.tool,
    risk: row.risk,
    describe: row.describe,
    args: row.args || {},
    userId: row.user_id,
    threadId: row.thread_id || null,
    idempotencyKey: row.idempotency_key || null,
    status: row.status,
    result: row.result || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null,
  };
}

function toRow(rec) {
  return {
    id: rec.id,
    tool: rec.tool,
    risk: rec.risk,
    describe: rec.describe,
    args: rec.args,
    user_id: rec.userId,
    thread_id: rec.threadId,
    idempotency_key: rec.idempotencyKey,
    status: rec.status,
    result: rec.result,
    created_at: rec.createdAt,
    resolved_at: rec.resolvedAt,
  };
}

function sameArgs(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

async function findDuplicate(toolName, args, userId, threadId) {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
  const rows = await sbRequest(
    `/${TBL}?select=*&status=eq.pending&tool=eq.${eq(toolName)}&user_id=eq.${eq(userId)}&created_at=gte.${eq(since)}&order=created_at.desc&limit=25`
  );
  return (rows || []).find(
    (r) => sameArgs(r.args, args) && (r.thread_id || null) === (threadId || null)
  );
}

function buildRec({ tool, args, userId, threadId, idempotencyKey }) {
  return {
    id: newId(),
    tool: tool.name,
    risk: tool.risk,
    describe: tool.describe,
    args: args || {},
    userId: userId || 'local',
    threadId: threadId || null,
    idempotencyKey: idempotencyKey || null,
    status: 'pending',
    result: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
}

async function create({ toolName, args, userId, threadId, idempotencyKey }) {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error('unknown tool: ' + toolName);
  const uid = userId || 'local';

  if (ENABLED) {
    if (idempotencyKey) {
      const rows = await sbRequest(
        `/${TBL}?select=*&idempotency_key=eq.${eq(idempotencyKey)}&status=eq.pending&limit=1`
      );
      if (rows && rows.length) return toRec(rows[0]);
    }
    const dup = await findDuplicate(tool.name, args, uid, threadId || null);
    if (dup) return toRec(dup);
    const rec = buildRec({ tool, args, userId: uid, threadId, idempotencyKey });
    await sbRequest(`/${TBL}`, { method: 'POST', body: JSON.stringify(toRow(rec)) });
    return rec;
  }

  // in-memory fallback
  if (idempotencyKey) {
    const hit = [...mem.values()].find(
      (r) => r.status === 'pending' && r.idempotencyKey === idempotencyKey
    );
    if (hit) return hit;
  }
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  const dup = [...mem.values()].find(
    (r) => r.status === 'pending' && r.tool === tool.name && r.userId === uid
      && (r.threadId || null) === (threadId || null) && sameArgs(r.args, args)
      && new Date(r.createdAt).getTime() > cutoff
  );
  if (dup) return dup;
  const rec = { ...buildRec({ tool, args, userId: uid, threadId, idempotencyKey }), id: memId() };
  mem.set(rec.id, rec);
  return rec;
}

async function get(id) {
  if (ENABLED) {
    const rows = await sbRequest(`/${TBL}?select=*&id=eq.${eq(id)}&limit=1`);
    return rows && rows.length ? toRec(rows[0]) : undefined;
  }
  return mem.get(id);
}

async function listPending(userId) {
  if (ENABLED) {
    const u = userId ? `&user_id=eq.${eq(userId)}` : '';
    const rows = await sbRequest(
      `/${TBL}?select=*&status=eq.pending${u}&order=created_at.desc&limit=100`
    );
    return (rows || []).map(toRec);
  }
  return [...mem.values()].filter(
    (r) => r.status === 'pending' && (!userId || r.userId === userId)
  );
}

async function executeTool(rec) {
  const tool = TOOLS.find((t) => t.name === rec.tool);
  try {
    return await tool.fn({ userId: rec.userId, ...rec.args });
  } catch (e) {
    return { error: e.message, code: e.code };
  }
}

async function resolve(id, decision) {
  const status = decision === 'approve' ? 'approved' : 'declined';
  const now = new Date().toISOString();

  if (ENABLED) {
    // Atomic claim: only a pending row flips. A concurrent resolve on another
    // instance gets zero rows back and returns the already-resolved record —
    // the tool can never execute twice.
    const claimed = await sbRequest(
      `/${TBL}?id=eq.${eq(id)}&status=eq.pending`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status, resolved_at: now }),
      }
    );
    if (!claimed || !claimed.length) {
      const existing = await get(id);
      if (!existing) throw Object.assign(new Error('approval not found'), { code: 'NOT_FOUND' });
      return existing;
    }
    const rec = toRec(claimed[0]);
    if (rec.status === 'approved') {
      rec.result = await executeTool(rec);
      await sbRequest(`/${TBL}?id=eq.${eq(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ result: rec.result }),
      });
      // Audit the approved execution (fire-and-forget; never throws).
      logToolRun({
        userId: rec.userId, tool: rec.tool, args: rec.args, result: rec.result,
        approvalId: rec.id, status: rec.result && rec.result.error ? 'failed' : 'executed',
      }).catch(() => {});
    } else {
      // Declined: nothing executed — audit the hold, not an execution.
      logToolRun({
        userId: rec.userId, tool: rec.tool, args: rec.args,
        result: { declined: true }, approvalId: rec.id, status: 'held',
      }).catch(() => {});
    }
    return rec;
  }

  // in-memory fallback
  const rec = mem.get(id);
  if (!rec) throw Object.assign(new Error('approval not found'), { code: 'NOT_FOUND' });
  if (rec.status !== 'pending') return rec;
  rec.status = status;
  rec.resolvedAt = now;
  if (rec.status === 'approved') {
    rec.result = await executeTool(rec);
    logToolRun({
      userId: rec.userId, tool: rec.tool, args: rec.args, result: rec.result,
      approvalId: rec.id, status: rec.result && rec.result.error ? 'failed' : 'executed',
    }).catch(() => {});
  } else {
    logToolRun({
      userId: rec.userId, tool: rec.tool, args: rec.args,
      result: { declined: true }, approvalId: rec.id, status: 'held',
    }).catch(() => {});
  }
  return rec;
}

module.exports = { create, get, listPending, resolve };
