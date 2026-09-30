// One-shot agent turn runner for benchmarking. Usage:
/// node scripts/bench-turn.js "<user message>" <threadId>
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { runAgentTurn } = require('../backend/lib/agent');

const text = process.argv[2];
const threadId = process.argv[3] || ('bench-' + Date.now());

(async () => {
  const r = await runAgentTurn({
    text,
    userId: 'dad5f844-724d-4bb9-80b7-6918c140feef',
    threadId,
  });
  console.log(JSON.stringify({
    threadId,
    mode: r.mode,
    toolsUsed: (r.toolsUsed || []).map((t) => t.name),
    reply: r.text,
  }));
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
