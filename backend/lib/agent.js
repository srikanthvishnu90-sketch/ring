// Agent loop: the model's tool registry + turn execution.
//
// With no LLM key set, runAgentTurn falls back to a canned response so the
// app is always demoable. With a key (OpenAI or Anthropic), it calls the
// provider with tools and executes them — high-risk tools (send/book/request)
// must go through the approval gate in server.js / lib/approvals.js, never
// straight from the model.
const { env } = require('./config');
const gmail = require('../connectors/gmail');
const calendar = require('../connectors/calendar');
const places = require('../connectors/places');
const uber = require('../connectors/uber');
const dining = require('../connectors/dining');

// Tools the model can call. `risk`: low runs immediately, medium needs a
// tap/voice confirm, high needs an in-app approval card. Nothing irreversible
// runs without the gate in server.js checking this field.
const TOOLS = [
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
  },
];

const SYSTEM_PROMPT = `You are the user's personal agent inside the Ring app. You can search email, manage the calendar, find restaurants, build ride and booking links, and coordinate group plans. Be concise and plainspoken. Never claim a booking or message is done until its tool confirms it — and anything that spends money or sends as the user needs their explicit approval first.`;

function llmConfigured() {
  const p = env('LLM_PROVIDER', 'openai');
  return p === 'anthropic' ? !!env('ANTHROPIC_API_KEY') : !!env('OPENAI_API_KEY');
}

// Both providers normalize to { text, toolCalls: [{id, name, args}] }.
async function callOpenAI(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env('AGENT_MODEL', 'gpt-4o'),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.describe, parameters: t.schema } })),
    }),
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

async function callAnthropic(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env('AGENT_MODEL', 'claude-sonnet-4-5'),
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      tools: TOOLS.map((t) => ({ name: t.name, description: t.describe, input_schema: t.schema })),
    }),
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

// Minimal fallback so the app works with zero keys (mirrors the prototype).
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

async function runAgentTurn({ text, userId = 'local', threadId = 'local' }) {
  if (!llmConfigured()) return { ...cannedReply(text), mode: 'canned' };

  const provider = env('LLM_PROVIDER', 'openai');
  const call = provider === 'anthropic' ? callAnthropic : callOpenAI;
  const first = await call(text);

  const toolsUsed = [];
  const results = [];
  for (const tc of first.toolCalls) {
    const tool = TOOLS.find((t) => t.name === tc.name);
    if (!tool) continue;
    toolsUsed.push({ name: tool.name, risk: tool.risk, args: tc.args });
    if (tool.risk === 'low') {
      try {
        const out = await tool.fn({ userId, ...tc.args });
        results.push(`${tc.name} → ${JSON.stringify(out).slice(0, 2000)}`);
      } catch (e) {
        results.push(`${tc.name} → ERROR ${e.code || ''}: ${e.message}`.slice(0, 400));
      }
    } else {
      results.push(`${tc.name} → HELD for user approval`);
    }
  }

  let finalText = first.text;
  if (first.toolCalls.length) {
    const follow = await call(
      `${text}\n\nTool results:\n${results.join('\n')}\n\nNow reply to the user concisely (1-3 short sentences). If something is held for approval, say what you're waiting on.`
    );
    if (follow.text) finalText = follow.text;
  }
  return { text: finalText, toolsUsed, mode: 'live' };
}

module.exports = { TOOLS, runAgentTurn, llmConfigured };
