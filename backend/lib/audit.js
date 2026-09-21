// Audit log of tool runs: every tool execution lands in ring_tool_runs.
// status: 'executed' | 'held' | 'failed'.
// Never throws — logging failures must not break the agent or approvals path.
const { ENABLED, sbRequest } = require('./supabase');

const TBL = 'ring_tool_runs';

function newId() {
  return 'run_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

async function logToolRun({ userId, tool, args, result, approvalId, status }) {
  try {
    if (!ENABLED) return false;
    await sbRequest(`/${TBL}`, {
      method: 'POST',
      body: JSON.stringify({
        id: newId(),
        user_id: userId || 'local',
        tool,
        args: args || {},
        result: result === undefined ? null : result,
        approval_id: approvalId || null,
        status,
        created_at: new Date().toISOString(),
      }),
    });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { logToolRun };
