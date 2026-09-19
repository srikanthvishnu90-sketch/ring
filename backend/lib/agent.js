// Agent loop: the model's tool registry + turn execution.
//
// With no LLM key set, runAgentTurn falls back to a canned response so the
// app is always demoable. With a key, it calls the provider with tools and
// executes them — high-risk tools (send/book/request) must go through the
// approval gate in server.js, never straight from the model.
const { env } = require('./config');
const gmail = require('../connectors/gmail');
const calendar = require('../connectors/calendar');
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
    name: 'calendar_create', risk: 'medium', fn: calendar.createEvent,
    schema: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' } }, required: ['summary', 'start', 'end'] },
    describe: 'Create a calendar event',
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

const SYSTEM_PROMPT = `You are the user's personal agent inside the Ring app. You can search email, manage the calendar, build ride and restaurant-booking links, and coordinate group plans. Be concise and plainspoken. Never claim a booking or message is done until its tool confirms it — and anything that spends money or sends as the user needs their explicit approval first.`;

function llmConfigured() {
  const p = env('LLM_PROVIDER', 'openai');
  return p === 'openai' ? !!env('OPENAI_API_KEY') : p === 'anthropic' ? !!env('ANTHROPIC_API_KEY') : false;
}

async function callOpenAI(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env('AGENT_MODEL', 'gpt-4o'),
      messages,
      tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.describe, parameters: t.schema } })),
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}`);
  return res.json();
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
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: text },
  ];
  const data = provider === 'openai' ? await callOpenAI(messages) : null;
  const msg = data.choices[0].message;

  // Execute any tool calls the model requested (approval gate enforced by caller).
  const toolsUsed = [];
  for (const call of msg.tool_calls || []) {
    const tool = TOOLS.find((t) => t.name === call.function.name);
    if (!tool) continue;
    const args = JSON.parse(call.function.arguments);
    toolsUsed.push({ name: tool.name, risk: tool.risk, args });
    // NOTE: server.js must intercept risk medium/high here and create an
    // approval instead of executing. Direct execution below is for low-risk.
    if (tool.risk === 'low') {
      try {
        const result = await tool.fn({ userId, ...args });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 4000) });
      } catch (e) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: `ERROR ${e.code || ''}: ${e.message}`.slice(0, 500) });
      }
    }
  }

  if ((msg.tool_calls || []).length && provider === 'openai') {
    const follow = await callOpenAI(messages);
    return { text: follow.choices[0].message.content, toolsUsed, mode: 'live' };
  }
  return { text: msg.content, toolsUsed, mode: 'live' };
}

module.exports = { TOOLS, runAgentTurn, llmConfigured };
