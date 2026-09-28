// Social connector — memory-powered group coordination.
//
// Id: 'social'. Low-risk read/draft/compose tools plus one medium-risk
// group-planning tool. NOTHING here sends anything externally: group_plan
// STAGES a calendar event (returns it for the agent to create via the
// approval-gated calendar_create tool), draft_message returns labeled
// drafts, and smart_nudge returns a nudge list without delivering.
//
// NOTE: registry.js intentionally not touched — the coordinator wires this
// connector into CONNECTORS. Tool fns receive { userId, ...args } from the
// agent loop (lib/agent.js injects userId), exactly like twilio.js.
const memory = require('../lib/memory');
const threads = require('../lib/threads');
const calendar = require('./calendar');

// ./intel does not exist yet — daily_brief treats it as optional and
// proceeds with memory + calendar alone.
let intel = null;
try { intel = require('./intel'); } catch { intel = null; }

const id = 'social';
const name = 'Memory+Group';
const description = 'Group planning polls, daily briefs, message drafts, learned routines, and timely nudges — powered by durable memory';
const envVars = [];

function status() {
  return { ok: true, auth: 'none', connected: true };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested on canned fixtures, no network)
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function tokens(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

// tallyVotes(plan, messages) -> { votes: {optionIndex: count}, voters, leader, total }
// A message votes for an option when it mentions a token distinctive to that
// option (a token no other option contains), or names the option by number
// ("option 2", "the second one"). Each message counts at most once; the
// agent's own messages never vote.
function tallyVotes(plan, messages) {
  const opts = plan.options || [];
  const tokSets = opts.map((o) => new Set(tokens(o)));
  const distinctive = tokSets.map((ts, i) => {
    const others = new Set();
    tokSets.forEach((o, j) => { if (j !== i) for (const t of o) others.add(t); });
    return new Set([...ts].filter((t) => !others.has(t)));
  });

  const votes = opts.map(() => 0);
  const voters = {};
  for (const m of messages || []) {
    if (/^(agent|ring assistant)$/i.test(m.from || '')) continue;
    const mt = new Set(tokens(m.text || ''));
    let pick = -1;
    // Explicit number reference first: "option 2", "#2", "2nd", or a bare
    // "2" as the entire message. (Bare numbers inside longer text like
    // "see you at 5" are NOT votes — too noisy.)
    const numMatch = (m.text || '').match(/(?:option\s*|#)(\d+)(?:st|nd|rd|th)?\b|^\s*(\d+)(?:st|nd|rd|th)?\s*[.!]?\s*$/i);
    const num = numMatch ? (numMatch[1] || numMatch[2]) : null;
    if (num) {
      const n = parseInt(num, 10) - 1;
      if (n >= 0 && n < opts.length) pick = n;
    }
    if (pick === -1) {
      for (let i = 0; i < opts.length; i++) {
        for (const t of distinctive[i]) {
          if (mt.has(t)) { pick = i; break; }
        }
        if (pick !== -1) break;
      }
    }
    if (pick !== -1) {
      votes[pick]++;
      voters[m.from || 'unknown'] = (voters[m.from || 'unknown'] || 0) + 1;
    }
  }
  let leader = -1;
  votes.forEach((v, i) => { if (v > 0 && (leader === -1 || v > votes[leader])) leader = i; });
  return { votes, voters, leader, total: votes.reduce((a, b) => a + b, 0) };
}

// detectRoutines(events) -> [{ key, label, weekdayIndexes }]
// Finds recurring summaries: same event text ≥3 times with ≥2/3 of
// occurrences on ≤2 distinct weekdays (e.g. "gym Tue/Thu").
function detectRoutines(events) {
  const groups = new Map();
  for (const e of events || []) {
    const summary = String(e.summary || '').trim();
    if (!summary) continue;
    const norm = summary.toLowerCase().replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)?\b/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!norm) continue;
    const d = new Date(e.start || e.end || Date.now());
    if (!groups.has(norm)) groups.set(norm, { summary, days: [] });
    groups.get(norm).days.push(d.getDay());
  }
  const out = [];
  for (const [norm, g] of groups) {
    if (g.days.length < 3) continue;
    const counts = {};
    for (const d of g.days) counts[d] = (counts[d] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const topTwo = top.slice(0, 2).reduce((a, [, c]) => a + c, 0);
    if (topTwo >= Math.ceil((g.days.length * 2) / 3)) {
      const idx = top.slice(0, 2).map(([d]) => parseInt(d, 10));
      out.push({
        key: 'routine_' + norm.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
        label: `${g.summary} on ${idx.map((i) => DAY_NAMES[i]).join('/')}`,
        weekdayIndexes: idx,
      });
    }
  }
  return out;
}

// composeBrief({ memories, events, intelItems, now }) -> markdown brief string.
function composeBrief({ memories, events, intelItems, now }) {
  const date = (now || new Date()).toDateString();
  const lines = [`Daily brief — ${date}`, ''];
  lines.push('On your calendar today:');
  if (!events.length) lines.push('- Nothing scheduled.');
  else for (const e of events) lines.push(`- ${e.summary || '(untitled)'}${e.start ? ` at ${e.start}` : ''}`);
  lines.push('');
  lines.push('From memory:');
  const mems = (memories || []).filter((m) => m.kind !== 'routine').slice(0, 5);
  if (!mems.length) lines.push('- Nothing stored yet.');
  else for (const m of mems) lines.push(`- ${m.key}: ${m.value}`);
  const routines = (memories || []).filter((m) => m.kind === 'routine');
  if (routines.length) {
    lines.push('');
    lines.push('Your routines:');
    for (const r of routines) lines.push(`- ${r.value}`);
  }
  if (intelItems && intelItems.length) {
    lines.push('');
    lines.push('Worth knowing:');
    for (const i of intelItems.slice(0, 3)) lines.push(`- ${i}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Plan store: in-memory keyed by threadId (with a clear explanation why).
//
// lib/threads.js exposes no plan-state API and ring_threads/ring_messages
// have no schema column for it; votes are collected fresh from thread
// messages at tally time, so only the proposal + options need storing.
// Process-scoped (lost on restart) — acceptable for a poll that resolves
// in minutes/hours; the staged event is handed to calendar_create instead
// of being persisted.
// ---------------------------------------------------------------------------
const plans = new Map(); // threadId-or-userId -> { title, options, status, createdAt, lockedOption?, stagedEvent? }
const planKey = (userId, threadId) => String(threadId || userId || 'local');

function pollText(plan) {
  return [
    `Poll: ${plan.title}`,
    ...plan.options.map((o, i) => `${i + 1}. ${o}`),
    'Reply with the option number or a time that works for you.',
  ].join('\n');
}

async function groupPlan({ userId, threadId, title, options, action = 'create' }) {
  const key = planKey(userId, threadId);
  if (action === 'create') {
    if (!title || !String(title).trim()) throw Object.assign(new Error('title is required'), { code: 'BAD_ARGS' });
    if (!Array.isArray(options) || options.length < 2) throw Object.assign(new Error('options needs at least 2 time options'), { code: 'BAD_ARGS' });
    const plan = { title: String(title).trim(), options: options.map(String), status: 'open', createdAt: new Date().toISOString() };
    plans.set(key, plan);
    return { status: 'open', title: plan.title, options: plan.options, poll: pollText(plan), note: 'Proposal created — share the poll text with the group, then run group_plan with action "tally" or "lock" once people reply.' };
  }
  const plan = plans.get(key);
  if (!plan) throw Object.assign(new Error('no open plan — create one first'), { code: 'NO_PLAN' });
  if (!threadId) throw Object.assign(new Error('threadId is required to tally or lock votes'), { code: 'BAD_ARGS' });
  let messages = [];
  try { messages = await threads.getRecentMessages(threadId, 50); } catch { messages = []; }
  const tally = tallyVotes(plan, messages);
  if (action === 'tally') {
    return {
      status: plan.status, title: plan.title,
      options: plan.options.map((o, i) => ({ option: o, votes: tally.votes[i] })),
      leader: tally.leader >= 0 ? plan.options[tally.leader] : null,
      voters: tally.voters,
      note: tally.total ? 'Run group_plan with action "lock" to pick the winner and stage the calendar event.' : 'No votes yet — share the poll text and wait for replies.',
    };
  }
  if (action === 'lock') {
    if (tally.leader === -1) throw Object.assign(new Error('no votes yet — cannot lock'), { code: 'NO_VOTES' });
    const winner = plan.options[tally.leader];
    // STAGE the event — return it for the agent to create via the
    // approval-gated calendar_create tool. Never create here.
    const stagedEvent = {
      staged: true, summary: `${plan.title} — group plan`,
      start: winner, end: null,
      description: `Group plan "${plan.title}" locked by poll. Votes: ${plan.options.map((o, i) => `${o} (${tally.votes[i]})`).join(', ')}.`,
      note: 'STAGED ONLY — not created. The agent must run calendar_create (approval-gated) to put this on the calendar.',
    };
    plan.status = 'locked';
    plan.lockedOption = winner;
    plan.stagedEvent = stagedEvent;
    plans.set(key, plan);
    return { status: 'locked', title: plan.title, winner, votes: tally.votes, stagedEvent };
  }
  throw Object.assign(new Error(`unknown action "${action}" — use create, tally, or lock`), { code: 'BAD_ARGS' });
}

async function dailyBrief({ userId }) {
  const memories = await memory.list(userId).catch(() => []);
  let events = [];
  let calNote = null;
  try {
    const now = new Date();
    events = await calendar.listEvents({
      userId,
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 24 * 3600e3).toISOString(),
    });
  } catch (e) {
    calNote = `Calendar unavailable: ${e.message}`;
  }
  let intelItems = [];
  if (intel && typeof intel.recent === 'function') {
    try { intelItems = await intel.recent({ userId }); } catch { intelItems = []; }
  }
  const brief = composeBrief({ memories, events, intelItems });
  return { brief, calendarNote: calNote };
}

async function draftMessage({ to, context }) {
  if (!to || !String(to).trim()) throw Object.assign(new Error('"to" is required'), { code: 'BAD_ARGS' });
  if (!context || !String(context).trim()) throw Object.assign(new Error('"context" is required'), { code: 'BAD_ARGS' });
  return {
    draft: true,
    to: String(to).trim(),
    text: `Draft to ${String(to).trim()}:\n\n${String(context).trim()}`,
    note: 'DRAFT ONLY — this tool never sends anything. Sending happens only through an approval-gated send tool (e.g. gmail_send, sms_send).',
  };
}

async function routineLearn({ userId }) {
  let events = [];
  try {
    const now = new Date();
    events = await calendar.listEvents({
      userId,
      timeMin: new Date(now.getTime() - 60 * 24 * 3600e3).toISOString(),
      timeMax: now.toISOString(),
    });
  } catch (e) {
    return { learned: [], note: `Calendar unavailable, nothing analyzed: ${e.message}` };
  }
  const routines = detectRoutines(events);
  const saved = [];
  for (const r of routines) {
    await memory.save(userId, { key: r.key, value: r.label, kind: 'routine' }).catch(() => {});
    saved.push({ key: r.key, label: r.label });
  }
  return { learned: saved, analyzedEvents: events.length, note: saved.length ? 'Saved as durable routines (kind "routine").' : 'No recurring patterns found in the last 60 days.' };
}

async function smartNudge({ userId }) {
  const nudges = [];
  // 1. Upcoming events (next 24h).
  try {
    const now = new Date();
    const events = await calendar.listEvents({
      userId,
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 24 * 3600e3).toISOString(),
    });
    for (const e of (events || []).slice(0, 5)) {
      nudges.push({ kind: 'event', text: `Coming up: ${e.summary || '(untitled)'}${e.start ? ` at ${e.start}` : ''}` });
    }
  } catch { /* calendar not connected — skip */ }
  // 2. Learned routines due today.
  try {
    const memories = await memory.list(userId);
    const today = new Date().getDay();
    for (const m of memories.filter((m) => m.kind === 'routine')) {
      nudges.push({ kind: 'routine', text: `Routine check: ${m.value} — still on for today?` });
    }
  } catch { /* memory unavailable — skip */ }
  // 3. Unanswered threads: thread whose latest message is not from the user.
  try {
    const threadList = await threads.listThreads({ userId });
    for (const t of (threadList || []).slice(0, 10)) {
      const recent = await threads.getRecentMessages(t.id, 1).catch(() => []);
      const last = recent && recent[0];
      if (last && !/^(agent|ring assistant)$/i.test(last.from || '') && last.from !== userId) {
        nudges.push({ kind: 'thread', text: `Unanswered in "${t.name}": last message from ${last.from} — "${String(last.text || '').slice(0, 80)}"` });
      }
    }
  } catch { /* threads unavailable — skip */ }
  return { nudges, note: 'Read-only suggestions — nothing was sent or scheduled.' };
}

const tools = [
  {
    name: 'group_plan', risk: 'medium',
    fn: groupPlan,
    schema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Group thread id the poll runs in' },
        title: { type: 'string', description: 'Plan title, e.g. "Dinner this weekend"' },
        options: { type: 'array', items: { type: 'string' }, description: 'At least 2 time options' },
        action: { type: 'string', enum: ['create', 'tally', 'lock'], description: 'create: start poll; tally: count votes from thread messages; lock: pick winner and stage the calendar event (default: create)' },
      },
      required: ['title', 'options'],
    },
    describe: 'Run a group plan poll: create proposal, tally votes from thread messages, lock the winner — stages (never creates) a calendar event',
  },
  {
    name: 'daily_brief', risk: 'low',
    fn: dailyBrief,
    schema: { type: 'object', properties: {} },
    describe: 'Compose a daily brief from memory, today\'s calendar, and intel',
  },
  {
    name: 'draft_message', risk: 'low',
    fn: draftMessage,
    schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient name or handle' },
        context: { type: 'string', description: 'What the message should say' },
      },
      required: ['to', 'context'],
    },
    describe: 'Draft a message text. DRAFT ONLY — never sends anything',
  },
  {
    name: 'routine_learn', risk: 'low',
    fn: routineLearn,
    schema: { type: 'object', properties: {} },
    describe: 'Analyze calendar history for recurring routines (e.g. gym Tue/Thu) and save learned patterns to memory',
  },
  {
    name: 'smart_nudge', risk: 'low',
    fn: smartNudge,
    schema: { type: 'object', properties: {} },
    describe: 'Generate timely nudges (upcoming events, unanswered threads, learned routines). Returns a list — sends nothing',
  },
];

module.exports = { id, name, description, envVars, status, tools, tallyVotes, detectRoutines, composeBrief };
