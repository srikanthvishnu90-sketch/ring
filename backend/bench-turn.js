// One-shot agent turn runner for benchmarking. Usage:
/// node backend/bench-turn.js "<user message>" <threadId>
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { runAgentTurn } = require('./lib/agent');

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
    toolsUsed: (r.toolsUsed || []).map((t) => ({ name: t.name, args: t.args })),
    reply: r.text,
  }));
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
