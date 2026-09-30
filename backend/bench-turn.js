// One-shot agent turn runner for benchmarking, using the production DB-backed chat path.
// Usage: node backend/bench-turn.js "<user message>" <threadId>
//
// This unifies with the production chat flow:
// 1. Ensures a real ring_threads row exists for the demo user
// 2. Persists the user message via threads.postMessage
// 3. Triggers the agent turn (via @ring mention) with real tools
// 4. Persists the assistant response and approval cards in the same thread
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const DEMO_USER_ID = '36c81014-c968-4de4-b301-5992fcb392c4';

const text = process.argv[2];
const threadIdArg = process.argv[3];

if (!text) {
  console.error('Usage: node backend/bench-turn.js "<user message>" [threadId]');
  process.exit(1);
}

(async () => {
  const threads = require('./lib/threads');
  
  // 1. Get or create a thread for the demo user
  let threadId = threadIdArg;
  let thread;
  if (threadId) {
    try {
      thread = await threads.getThread(threadId);
    } catch (e) {
      thread = null;
    }
  }
  if (!thread) {
    // Find existing bench thread or create new one
    const existing = (await threads.listThreads({ userId: DEMO_USER_ID }))
      .find((t) => t.name === 'Benchmark');
    if (existing && !threadIdArg) {
      thread = existing;
      threadId = existing.id;
    } else {
      thread = await threads.createThread({
        name: threadIdArg ? `Bench ${threadIdArg}` : 'Benchmark',
        members: [DEMO_USER_ID],
        userId: DEMO_USER_ID,
      });
      threadId = thread.id;
    }
  }
  
  // 2. Post user message with @ring mention to trigger agent turn
  // The postMessage flow will: store message, run agent with real tools,
  // create approval cards, store agent reply - all in the DB-backed thread
  const mentionText = text.includes('@ring') ? text : `@ring ${text}`;
  const msg = await threads.postMessage(threadId, {
    from: 'Demo User',
    text: mentionText,
    userId: DEMO_USER_ID,
  });
  
  // 3. Get the agent's reply (most recent message from agent)
  const recent = await threads.getRecentMessages(threadId, 5);
  const agentReply = recent.filter((m) => m.from === 'agent').pop();
  
  console.log(JSON.stringify({
    threadId,
    messageId: msg.id,
    reply: agentReply ? agentReply.text : '(no agent reply)',
    pendingApprovals: agentReply ? agentReply.pendingApprovals : undefined,
    threadUrl: `https://ringsss.vercel.app/chat/${threadId}`,
  }, null, 2));
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
