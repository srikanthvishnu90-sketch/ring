// Pending approvals: the trust core. When the agent wants to run a
// medium/high-risk tool, the call is HELD here instead of executing.
// The client renders it as an approval card; resolving 'approve' executes
// the tool, 'decline' drops it. Nothing irreversible runs without this.
const { TOOLS } = require('./agent');

const store = new Map();
let seq = 1;

function create({ toolName, args, userId, threadId }) {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error('unknown tool: ' + toolName);
  const id = 'appr_' + seq++ + '_' + Date.now().toString(36);
  const rec = {
    id,
    tool: tool.name,
    risk: tool.risk,
    describe: tool.describe,
    args,
    userId: userId || 'local',
    threadId: threadId || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  store.set(id, rec);
  return rec;
}

function get(id) {
  return store.get(id);
}

function listPending(userId) {
  return [...store.values()].filter(
    (r) => r.status === 'pending' && (!userId || r.userId === userId)
  );
}

async function resolve(id, decision) {
  const rec = store.get(id);
  if (!rec) throw Object.assign(new Error('approval not found'), { code: 'NOT_FOUND' });
  if (rec.status !== 'pending') return rec;
  rec.status = decision === 'approve' ? 'approved' : 'declined';
  rec.resolvedAt = new Date().toISOString();
  if (rec.status === 'approved') {
    const tool = TOOLS.find((t) => t.name === rec.tool);
    try {
      rec.result = await tool.fn({ userId: rec.userId, ...rec.args });
    } catch (e) {
      rec.result = { error: e.message, code: e.code };
    }
  }
  return rec;
}

module.exports = { create, get, listPending, resolve };
