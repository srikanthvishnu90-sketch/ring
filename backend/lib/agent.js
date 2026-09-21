// Agent loop: the model's tool registry + turn execution.
//
// With no LLM key set, runAgentTurn falls back to a canned response so the
// app is always demoable. With a key (OpenAI or Anthropic), it calls the
// provider with tools and executes them — high-risk tools (send/book/request)
// must go through the approval gate in server.js / lib/approvals.js, never
// straight from the model.
const { env } = require('./config');
const { logToolRun } = require('./audit');
const memory = require('./memory');
const gmail = require('../connectors/gmail');
const calendar = require('../connectors/calendar');
const places = require('../connectors/places');
const uber = require('../connectors/uber');
const dining = require('../connectors/dining');

// Tools the model can call. `risk`: low runs immediately, medium needs a
// tap/voice confirm, high needs an in-app approval card. Nothing irreversible
// runs without the gate in server.js checking this field.
const _RAW_TOOLS = [
  // Tools contributed by connectors that define their own `tools` array
  // (see backend/connectors/registry.js).
  {
    name: 'gmail_search', risk: 'low', fn: gmail.searchMessages,
    schema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
    describe: 'Search the user\'s email',
  },
  {
    name: 'gmail_send', risk: 'high', fn: gmail.sendMessage,
    schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
    describe: 'Send an email as the user (always needs approval)',
  },
  {
    name: 'calendar_list', risk: 'low', fn: calendar.listEvents,
    schema: { type: 'object', properties: { timeMin: { type: 'string' }, timeMax: { type: 'string' } } },
    describe: 'List upcoming calendar events',
  },
  {
    name: 'calendar_create', risk: 'medium', fn: calendar.createEvent,
    schema: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' } }, required: ['summary', 'start', 'end'] },
    describe: 'Create a calendar event (needs confirmation)',
  },
  {
    name: 'places_search', risk: 'low', fn: places.search,
    schema: { type: 'object', properties: { query: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' }, radius: { type: 'number' } }, required: ['query'] },
    describe: 'Search restaurants and places by name, cuisine, or vibe',
  },
  {
    name: 'uber_ride_link', risk: 'low', fn: async (a) => ({ url: uber.rideLink(a) }),
    schema: { type: 'object', properties: { pickup: { type: 'object' }, dropoff: { type: 'object' } }, required: ['pickup', 'dropoff'] },
    describe: 'Build a prefilled Uber deep link for the user to confirm',
  },
  {
    name: 'dining_links', risk: 'low',
    fn: async ({ slug, city, date, dateTime, seats }) => ({
      opentable: dining.opentableLink({ slug, dateTime, covers: seats }),
      resy: city ? dining.resyLink({ city, slug, date, seats }) : undefined,
    }),
    schema: { type: 'object', properties: { slug: { type: 'string' }, city: { type: 'string' }, date: { type: 'string' }, dateTime: { type: 'string' }, seats: { type: 'number' } }, required: ['slug'] },
    describe: 'Build prefilled booking deep links for a restaurant',
  },];

// Legacy entries win on name collisions: a connector-contributed tool can
// never shadow an existing one.
const _seen = new Set(_RAW_TOOLS.map((t) => t.name));
const TOOLS = [
  ...require('../connectors/registry').allTools().filter((t) => !_seen.has(t.name)),
  ..._RAW_TOOLS,
];

const SYSTEM_PROMPT = `You are the user's personal agent inside the Ring app. You can search email, manage the calendar, find restaurants, build ride and booking links, and coordinate group plans. Be concise and plainspoken. Never claim a booking or message is done until its tool confirms it — and anything that spends money or sends as the user needs their explicit approval first.`;

const DEMO_PROMPT_SUFFIX = `

You are running in DEMO MODE: every tool is simulated and returns sample data. Nothing you do here touches the user's real accounts. Never claim a real email was sent, a real event was created, or any real-world action happened — say clearly that this is a demo and they should sign in for the real thing.`;

// Voice style: this reply will be SPOKEN aloud through the ring. Keep it
// short enough to say in one breath — one or two sentences, no lists, no
// markdown, no spelling things out. If an action is held for approval, name
// it and say "double-tap to approve".
const VOICE_STYLE = `

This reply will be spoken aloud. Answer in one or two short sentences, plain words, no lists or formatting. If something is held for the user's approval, say what it is and tell them to double-tap to approve it.`;

// Telegram chat style: texting, not a document. The demo disclosure is
// lighter here — it only matters when the user asks for something real.
const TG_STYLE = (name) => `
You are chatting with ${name || 'the user'} inside Telegram — this is a texting conversation, not a document.
Write like a warm, sharp friend texting back: short, natural, contractions, plain words. Never stiff, never corporate.
Keep it tight: one or two short paragraphs max. No bullet-list essays, no walls of text, unless they explicitly ask for detail.
Use their first name now and then, naturally — not in every message.
Reply in the same language they write in.
If they refer to something from earlier in this chat, use the recent conversation below for context.`;

const TG_DEMO_SUFFIX = `

DEMO MODE: every tool is simulated sample data — nothing touches real accounts. Never claim a real email was sent, event created, or action happened. Do NOT announce "demo mode" unprompted; only mention signing into the Ring app when they ask you to do something real.`;

function tgHistoryBlock(history) {
  if (!history || !history.length) return '';
  const lines = history.slice(-8).map((m) =>
    `${m.from || 'them'}: ${String(m.text || '').slice(0, 300)}`.trim()
  ).join('\n');
  return `\n\nRecent conversation:\n${lines}`;
}

// ---- Demo mode -----------------------------------------------------------
// Unauthenticated callers get DEMO_TOOLS: same names, schemas, and risk
// tiers as the real tools, but every fn returns canned simulated data and
// NEVER touches a connector, credential, or external API. Approval cards
// created from demo turns are owned by user_id 'demo', and resolve() will
// only ever run the simulated fn for them — a demo card can never execute
// a real tool, no matter who resolves it.
function demoResult(name, args) {
  const a = args || {};
  switch (name) {
    case 'gmail_search':
      return {
        demo: true,
        messages: [{
          id: 'demo-msg-1',
          subject: 'Demo: your inbox at a glance',
          from: 'demo@example.com',
          date: new Date().toISOString(),
          snippet: `Simulated result for "${a.query || ''}" — sign in to search your real Gmail.`,
        }],
      };
    case 'gmail_send':
      return { demo: true, sent: false, note: 'Demo mode: no email was actually sent. Sign in to send real email.' };
    case 'calendar_list':
      return {
        demo: true,
        events: [{
          id: 'demo-ev-1',
          summary: 'Demo: coffee with a friend',
          start: new Date(Date.now() + 3600e3).toISOString(),
          end: new Date(Date.now() + 7200e3).toISOString(),
        }],
      };
    case 'calendar_create':
      return { demo: true, created: false, note: 'Demo mode: no calendar event was actually created. Sign in for the real thing.' };
    case 'places_search':
      return {
        demo: true,
        places: [{ name: 'Demo Bistro', vicinity: '123 Demo St', rating: 4.5, note: `Simulated result for "${a.query || ''}"` }],
      };
    case 'uber_ride_link':
      return { demo: true, url: 'https://m.uber.com/?demo=1', note: 'Demo mode: simulated deep link.' };
    case 'dining_links':
      return { demo: true, opentable: 'https://www.opentable.com/?demo=1', note: 'Demo mode: simulated deep links.' };
    default:
      return { demo: true, simulated: true, note: `Demo mode: ${name} was not actually executed. Sign in for the real thing.` };
  }
}

const DEMO_TOOLS = TOOLS.map((t) => ({
  ...t,
  fn: async (args) => demoResult(t.name, args || {}),
}));

function llmConfigured() {
  const p = env('LLM_PROVIDER', 'openai');
  return p === 'anthropic' ? !!env('ANTHROPIC_API_KEY') : !!env('OPENAI_API_KEY');
}

// Both providers normalize to { text, toolCalls: [{id, name, args}] }.
// OPENAI_BASE_URL lets the OpenAI path point at any OpenAI-compatible
// endpoint (e.g. Gemini's: https://generativelanguage.googleapis.com/v1beta/openai).
async function callOpenAI(prompt, tools = TOOLS, opts = {}) {
  const base = env('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  const body = {
    model: env('AGENT_MODEL', 'gpt-4o'),
    messages: [
      { role: 'system', content: opts.system || SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.describe, parameters: t.schema } })),
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}`);
  const data = await res.json();
  const msg = data.choices[0].message;
  return {
    text: msg.content || '',
    toolCalls: (msg.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function.name,
      args: JSON.parse(c.function.arguments || '{}'),
    })),
  };
}

async function callAnthropic(prompt, tools = TOOLS, opts = {}) {
  const body = {
    model: env('AGENT_MODEL', 'claude-sonnet-4-5'),
    max_tokens: opts.maxTokens || 1024,
    system: opts.system || SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    tools: tools.map((t) => ({ name: t.name, description: t.describe, input_schema: t.schema })),
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}`);
  const data = await res.json();
  return {
    text: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
    toolCalls: (data.content || []).filter((b) => b.type === 'tool_use').map((b) => ({
      id: b.id,
      name: b.name,
      args: b.input || {},
    })),
  };
}

// --- Streaming variants ----------------------------------------------------
// Same contract as callOpenAI/callAnthropic, but text tokens are forwarded
// to onToken as they arrive. Tool-call argument fragments are accumulated
// and returned whole at the end.
async function callOpenAIStream(prompt, onToken, tools = TOOLS, opts = {}) {
  const base = env('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env('AGENT_MODEL', 'gpt-4o'),
      stream: true,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      messages: [
        { role: 'system', content: opts.system || SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.describe, parameters: t.schema } })),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`LLM error ${res.status}`);
  let text = '';
  const calls = {};
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
      if (!delta) continue;
      if (delta.content) { text += delta.content; if (onToken) onToken(delta.content); }
      for (const tc of delta.tool_calls || []) {
        const c = (calls[tc.index || 0] = calls[tc.index || 0] || { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function && tc.function.name) c.name = tc.function.name;
        if (tc.function && tc.function.arguments) c.args += tc.function.arguments;
      }
    }
  }
  return {
    text,
    toolCalls: Object.values(calls).map((c) => ({
      id: c.id, name: c.name,
      args: (() => { try { return JSON.parse(c.args || '{}'); } catch { return {}; } })(),
    })).filter((c) => c.name),
  };
}

async function callAnthropicStream(prompt, onToken, tools = TOOLS, opts = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env('AGENT_MODEL', 'claude-sonnet-4-5'),
      max_tokens: opts.maxTokens || 1024,
      stream: true,
      system: opts.system || SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      tools: tools.map((t) => ({ name: t.name, description: t.describe, input_schema: t.schema })),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`LLM error ${res.status}`);
  let text = '';
  const blocks = {};
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let evType = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (s.startsWith('event:')) { evType = s.slice(6).trim(); continue; }
      if (!s.startsWith('data:')) continue;
      let d;
      try { d = JSON.parse(s.slice(5).trim()); } catch { continue; }
      if (evType === 'content_block_start') {
        blocks[d.index] = { type: d.content_block.type, name: d.content_block.name, id: d.content_block.id, json: '' };
      } else if (evType === 'content_block_delta') {
        const b = blocks[d.index];
        if (!b) continue;
        if (d.delta.type === 'text_delta') { text += d.delta.text; if (onToken) onToken(d.delta.text); }
        if (d.delta.type === 'input_json_delta') b.json += d.delta.partial_json;
      }
    }
  }
  return {
    text,
    toolCalls: Object.values(blocks).filter((b) => b.type === 'tool_use').map((b) => ({
      id: b.id, name: b.name,
      args: (() => { try { return JSON.parse(b.json || '{}'); } catch { return {}; } })(),
    })),
  };
}

async function runAgentTurnStream({ text, userId = 'local', threadId = 'local', onToken, demo = false, maxTokens = null, voice = false }) {
  const tools = demo ? DEMO_TOOLS : TOOLS;
  if (!llmConfigured()) {
    const c = cannedReply(text);
    if (onToken) onToken(c.text);
    return { ...c, mode: demo ? 'canned-demo' : 'canned' };
  }

  const memBlock = demo ? '' : await memory.contextBlock(userId, text).catch(() => '');
  const prompt = (memBlock ? `${memBlock}\n\nUser message: ${text}` : text)
    + (demo ? DEMO_PROMPT_SUFFIX : '');

  const provider = env('LLM_PROVIDER', 'openai');
  const call = provider === 'anthropic' ? callAnthropicStream : callOpenAIStream;
  const streamOpts = { system: SYSTEM_PROMPT + (voice ? VOICE_STYLE : ''), ...(maxTokens || voice ? { maxTokens: maxTokens || 150 } : {}) };
  const first = await call(prompt, onToken, tools, streamOpts);

  const toolsUsed = [];
  const results = [];
  for (const tc of first.toolCalls) {
    const tool = tools.find((t) => t.name === tc.name);
    if (!tool) continue;
    toolsUsed.push({ name: tool.name, risk: tool.risk, args: tc.args });
    if (tool.risk === 'low') {
      try {
        const out = await tool.fn({ userId, ...tc.args });
        results.push(`${tc.name} → ${JSON.stringify(out).slice(0, 2000)}`);
        logToolRun({ userId, tool: tool.name, args: tc.args, result: out, status: 'executed' }).catch(() => {});
      } catch (e) {
        results.push(`${tc.name} → ERROR ${e.code || ''}: ${e.message}`.slice(0, 400));
        logToolRun({ userId, tool: tool.name, args: tc.args, result: { error: e.message, code: e.code }, status: 'failed' }).catch(() => {});
      }
    } else {
      results.push(`${tc.name} → HELD for user approval`);
    }
  }

  let finalText = first.text;
  if (first.toolCalls.length) {
    const follow = await call(
      `${prompt}\n\nTool results:\n${results.join('\n')}\n\nNow reply to the user concisely (1-3 short sentences). If something is held for approval, say what you're waiting on.`,
      (tok) => { finalText += ''; if (onToken) onToken(tok); },
      tools,
      streamOpts
    );
    // follow.text was already streamed token-by-token; rebuild final text.
    if (follow.text) finalText = first.text + follow.text;
  }
  return { text: finalText, toolsUsed, mode: 'live' };
}
function cannedReply(text) {
  const t = text.toLowerCase();
  if (t.includes('uber') || t.includes('ride'))
    return { text: 'I can line that up — where to?', toolsUsed: [] };
  if (t.includes('book') || t.includes('table') || t.includes('dinner'))
    return { text: 'On it — which spot, and for when?', toolsUsed: [] };
  if (t.includes('email'))
    return { text: 'I can check that once Gmail is connected.', toolsUsed: [] };
  return { text: 'Got it — say more and I\'ll take it from there.', toolsUsed: [] };
}

async function runAgentTurn({ text, userId = 'local', threadId = 'local', demo = false, telegram = null, maxTokens = null, voice = false }) {
  const tg = telegram && telegram.style === 'telegram' ? telegram : null;
  const tools = demo ? DEMO_TOOLS : TOOLS;
  if (!llmConfigured()) return { ...cannedReply(text), mode: demo ? 'canned-demo' : 'canned' };

  const system = SYSTEM_PROMPT + (tg ? TG_STYLE(tg.name) : '') + (voice ? VOICE_STYLE : '');
  const memBlock = demo ? '' : await memory.contextBlock(userId, text).catch(() => '');
  const histBlock = tg ? tgHistoryBlock(tg.history) : '';
  const prompt = (memBlock ? `${memBlock}\n\n` : '')
    + (histBlock ? `${histBlock}\n\n` : '')
    + `User message: ${text}`
    + (demo ? (tg ? TG_DEMO_SUFFIX : DEMO_PROMPT_SUFFIX) : '');

  const provider = env('LLM_PROVIDER', 'openai');
  const call = provider === 'anthropic' ? callAnthropic : callOpenAI;
  // Voice turns get a tight token cap: shorter replies = faster first audio.
  const callOpts = { system, ...(maxTokens ? { maxTokens } : voice ? { maxTokens: 150 } : tg ? { maxTokens: 320 } : {}) };
  const first = await call(prompt, tools, callOpts);

  const toolsUsed = [];
  const results = [];
  for (const tc of first.toolCalls) {
    const tool = tools.find((t) => t.name === tc.name);
    if (!tool) continue;
    toolsUsed.push({ name: tool.name, risk: tool.risk, args: tc.args });
    if (tool.risk === 'low') {
      try {
        const out = await tool.fn({ userId, ...tc.args });
        results.push(`${tc.name} → ${JSON.stringify(out).slice(0, 2000)}`);
        // Audit (fire-and-forget; logToolRun never throws).
        logToolRun({ userId, tool: tool.name, args: tc.args, result: out, status: 'executed' }).catch(() => {});
      } catch (e) {
        results.push(`${tc.name} → ERROR ${e.code || ''}: ${e.message}`.slice(0, 400));
        logToolRun({ userId, tool: tool.name, args: tc.args, result: { error: e.message, code: e.code }, status: 'failed' }).catch(() => {});
      }
    } else {
      results.push(`${tc.name} → HELD for user approval`);
    }
  }

  let finalText = first.text;
  if (first.toolCalls.length) {
    const follow = await call(
      `${prompt}\n\nTool results:\n${results.join('\n')}\n\nNow reply to the user concisely${tg ? ' — one or two short texts' : ' (1-3 short sentences)'}. If something is held for approval, say what you're waiting on.`,
      tools,
      callOpts
    );
    if (follow.text) finalText = follow.text;
  }
  return { text: finalText, toolsUsed, mode: 'live' };
}

module.exports = { TOOLS, DEMO_TOOLS, runAgentTurn, runAgentTurnStream, llmConfigured };
