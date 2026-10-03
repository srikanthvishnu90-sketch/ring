// Unit tests for rich message block wiring (RMsg roles).
// Run: node backend/test-rich-blocks.js
const assert = require('assert');

// Load RMsg (pure string builders, no DOM needed)
global.window = global;
require('../frontend/components/messages/messages.js');
const RMsg = global.RMsg;
assert(RMsg && typeof RMsg.render === 'function', 'RMsg.render must load');

const { TOOLS, DEMO_TOOLS, normalizeBlock } = require('./lib/agent');

let pass = 0;
function ok(name, cond) {
  assert(cond, 'FAIL: ' + name);
  pass++;
  console.log('  ✓', name);
}

console.log('normalizeBlock:');
ok('quickreplies: pills -> options', (() => {
  const b = normalizeBlock({ role: 'quickreplies', pills: ['Cancel it', 'Show details'] });
  return b && b.role === 'quickreplies' && b.options.length === 2 && b.options[0] === 'Cancel it';
})());
ok('quickreplies: caps at 6', (() => {
  const b = normalizeBlock({ role: 'quickreplies', pills: ['1','2','3','4','5','6','7','8'] });
  return b.options.length === 6;
})());
ok('quickreplies: empty -> null', normalizeBlock({ role: 'quickreplies', pills: [] }) === null);
ok('quickreplies: {label,send} objects', (() => {
  const b = normalizeBlock({ role: 'quickreplies', options: [{ label: 'Retry', send: 'try again please' }] });
  return b.options[0].label === 'Retry' && b.options[0].send === 'try again please';
})());
ok('progress: text -> label', (() => {
  const b = normalizeBlock({ role: 'progress', text: 'Searching your emails…' });
  return b && b.role === 'progress' && b.label === 'Searching your emails…' && b.state === 'working';
})());
ok('progress: state passthrough', (() => {
  const b = normalizeBlock({ role: 'progress', label: 'Done', state: 'done', detail: 'Found 3' });
  return b.state === 'done' && b.detail === 'Found 3';
})());
ok('results: type -> kind', (() => {
  const b = normalizeBlock({ role: 'results', type: 'subscriptions', items: [{ merchant: 'ElevenLabs', amount: 22, currency: 'USD', cadence: 'monthly' }] });
  return b && b.kind === 'subscriptions' && b.items.length === 1 && b.state === 'ready';
})());
ok('results: empty items -> empty state', (() => {
  const b = normalizeBlock({ role: 'results', kind: 'search', items: [] });
  return b.state === 'empty';
})());
ok('results: caps items at 8', (() => {
  const items = Array.from({ length: 20 }, (_, i) => ({ merchant: 'M' + i }));
  return normalizeBlock({ role: 'results', kind: 'subscriptions', items }).items.length === 8;
})());
ok('notice: kind/text/actions mapped', (() => {
  const b = normalizeBlock({ role: 'notice', kind: 'error', text: 'The page didn\'t load.', actions: [{ label: 'Try again', send: 'retry' }, { label: 'Other way', send: 'alt' }] });
  return b && b.tone === 'error' && b.body === "The page didn't load." && b.retryText === 'Try again' && b.retryTextSend === 'retry' && b.altText === 'Other way' && b.altTextSend === 'alt';
})());
ok('notice: empty -> null', normalizeBlock({ role: 'notice', kind: 'info' }) === null);
ok('steps: passthrough, cap 4', (() => {
  const b = normalizeBlock({ role: 'steps', title: 'Plan', items: ['a','b','c','d','e','f'] });
  return b && b.items.length === 4 && b.title === 'Plan';
})());
ok('steps: {t,done} objects', (() => {
  const b = normalizeBlock({ role: 'steps', items: [{ t: 'Booked', done: true }] });
  return b.items[0].done === true;
})());
ok('unknown role -> null', normalizeBlock({ role: 'frobnicate' }) === null);
ok('missing role -> null', normalizeBlock({}) === null);

console.log('RMsg.render on normalized blocks:');
const renderCases = [
  ['quickreplies', { role: 'quickreplies', pills: ['Yes', 'No'] }, 'rm-qr'],
  ['progress', { role: 'progress', text: 'Searching your emails…' }, 'rm-prog'],
  ['results/subscriptions', { role: 'results', type: 'subscriptions', items: [{ merchant: 'ElevenLabs', amount: 22, currency: 'USD', cadence: 'monthly', renews: 'Oct 14', email: 'you@gmail.com' }] }, 'rm-res'],
  ['results/restaurants', { role: 'results', kind: 'restaurants', items: [{ name: 'Alla Vita', cuisine: 'Italian', rating: 4, distance: '0.5 mi', price: '$$', open: 'Open until 11 PM' }] }, 'rm-res'],
  ['notice', { role: 'notice', kind: 'error', text: 'Something broke.', actions: [{ label: 'Try again', send: 'retry' }] }, 'rm-notice'],
  ['steps', { role: 'steps', title: 'Plan', items: ['One', 'Two'] }, 'rm-steps'],
];
for (const [name, input, marker] of renderCases) {
  const b = normalizeBlock(input);
  assert(b, 'normalize failed for ' + name);
  const html = RMsg.render(b);
  ok(`${name} renders (${marker})`, typeof html === 'string' && html.includes(marker));
}
ok('results empty state renders', RMsg.render(normalizeBlock({ role: 'results', kind: 'search', items: [] })).includes('rm-empty'));
ok('subscription card has Cancel button', RMsg.render(normalizeBlock({ role: 'results', type: 'subscriptions', items: [{ merchant: 'X', amount: 5 }] })).includes('data-rsub'));
ok('restaurant card has Book button', RMsg.render(normalizeBlock({ role: 'results', kind: 'restaurants', items: [{ name: 'Y' }] })).includes('data-rbook'));

console.log('emit_block tool wiring:');
(async () => {
  const tool = TOOLS.find((t) => t.name === 'emit_block');
  ok('emit_block registered in TOOLS', !!tool);
  ok('emit_block risk is low', tool.risk === 'low');
  ok('emit_block has schema+describe', !!tool.schema && !!tool.describe);

  // Simulate exactly what processToolCalls does: fn({userId, threadId, ...args, _blocks})
  const blocks = [];
  const out = await tool.fn({ userId: 'u1', threadId: 't1', role: 'progress', text: 'Searching…', _blocks: blocks });
  ok('fn returns ok:true + role', out.ok === true && out.role === 'progress');
  ok('block queued with normalized shape', blocks.length === 1 && blocks[0].role === 'progress' && blocks[0].label === 'Searching…');
  ok('no _blocks leak into stored shape', !('_blocks' in blocks[0]));

  // Unknown role -> ok:false, nothing queued
  const blocks2 = [];
  const out2 = await tool.fn({ userId: 'u1', threadId: 't1', role: 'nope', _blocks: blocks2 });
  ok('unknown role -> ok:false, dropped', out2.ok === false && blocks2.length === 0);

  // No _blocks array (defensive) -> doesn't crash
  const out3 = await tool.fn({ userId: 'u1', role: 'steps', items: ['a'] });
  ok('missing _blocks tolerated', out3.ok === true);

  // DEMO_TOOLS path (demoResult case)
  const demoTool = DEMO_TOOLS.find((t) => t.name === 'emit_block');
  ok('emit_block in DEMO_TOOLS', !!demoTool);
  const dblocks = [];
  const dout = await demoTool.fn({ userId: 'demo', threadId: 't', role: 'notice', kind: 'warn', text: 'Heads up', _blocks: dblocks });
  ok('demo path queues normalized notice', dout.ok !== false && dblocks.length === 1 && dblocks[0].tone === 'warn');

  // Subscription results end-to-end: normalize -> render -> cancel button present
  const sblocks = [];
  await tool.fn({ userId: 'u1', threadId: 't1', role: 'results', type: 'subscriptions',
    items: [{ merchant: 'ElevenLabs', amount: 22, currency: 'USD', cadence: 'monthly', renews: 'Oct 14, 2026', email: 'you@gmail.com' }],
    _blocks: sblocks });
  const html = RMsg.render(sblocks[0]);
  ok('subscription flow: card renders merchant+amount', html.includes('ElevenLabs') && html.includes('22'));

  console.log(`\nALL ${pass} TESTS PASSED`);
})().catch((e) => { console.error('\nTEST FAILURE:', e.message); process.exit(1); });
