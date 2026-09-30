// Overnight staging script: creates approval cards for all held actionable
// features so Vishnu wakes to a ready approval queue. All Gmail actions
// target the synthetic "Ring send test" email (1a0ef9ffbc926717).
require('dotenv').config({ path: '/home/hatch/workspace/ring/.env' });
const approvals = require('/home/hatch/workspace/ring/backend/lib/approvals.js');

const USER_ID = 'dad5f844-724d-4bb9-80b7-6918c140feef';
const TEST_MSG_ID = '1a0ef9ffbc926717';
const SAFE_TO = 'srikanthvishnu90@gmail.com';

const STAGES = [
  { tool: 'gmail_reply', args: { messageId: TEST_MSG_ID, body: 'Ring self-test reply — this is a test, please ignore.' }, label: '#5 gmail_reply' },
  { tool: 'gmail_forward', args: { messageId: TEST_MSG_ID, to: SAFE_TO }, label: '#6 gmail_forward' },
  { tool: 'gmail_draft', args: { to: SAFE_TO, subject: 'Ring draft test', body: 'just a test' }, label: '#8 gmail_draft' },
  { tool: 'gmail_delete', args: { messageId: TEST_MSG_ID }, label: '#9 gmail_delete' },
  { tool: 'gmail_archive', args: { messageId: TEST_MSG_ID }, label: '#10 gmail_archive' },
  { tool: 'gmail_mark', args: { messageId: TEST_MSG_ID, mark: 'unread' }, label: '#11 gmail_mark' },
  { tool: 'gmail_star', args: { messageId: TEST_MSG_ID }, label: '#12 gmail_star' },
  { tool: 'calendar_create', args: { summary: 'Ring test event — delete me', start: '2026-09-30T15:00:00-05:00', end: '2026-09-30T15:30:00-05:00' }, label: '#16 calendar_create' },
];

(async () => {
  const results = [];
  for (const s of STAGES) {
    try {
      const rec = await approvals.create({
        toolName: s.tool,
        args: s.args,
        userId: USER_ID,
        threadId: 'overnight-stage',
      });
      results.push({ label: s.label, id: rec.id, status: rec.status });
      console.log(`staged ${s.label}: ${rec.id}`);
    } catch (e) {
      console.log(`FAILED ${s.label}: ${e.message}`);
      results.push({ label: s.label, error: e.message });
    }
  }
  console.log(`\nDone: ${results.filter(r => r.id).length}/${STAGES.length} staged`);
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
