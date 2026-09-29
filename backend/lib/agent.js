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
    describe: 'Search the user\'s email. Returns unique THREADS newest-first (one entry per thread: threadId, subject, from, date, snippet) — read candidates with gmail_thread. Pass a high maxResults (e.g. 30) when the question needs full coverage of a topic.',
  },
  {
    name: 'gmail_read', risk: 'low', fn: gmail.readMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' } }, required: ['id'] },
    describe: 'Read the full body of a single email by message id',
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
    name: 'calendar_update', risk: 'medium', fn: calendar.updateEvent,
    schema: { type: 'object', properties: { id: { type: 'string' }, summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' } }, required: ['id'] },
    describe: 'Change a calendar event (needs confirmation)',
  },
  {
    name: 'calendar_delete', risk: 'medium', fn: calendar.deleteEvent,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Event id from calendar_list' } }, required: ['id'] },
    describe: 'Delete a calendar event (needs confirmation)',
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
  {
    name: 'memory_save', risk: 'low', fn: async ({ userId, key, value }) => memory.save(userId, { key, value, kind: 'fact' }),
    schema: { type: 'object', properties: { key: { type: 'string', description: 'Short snake_case label, e.g. maya_dietary' }, value: { type: 'string', description: 'The fact to remember' } }, required: ['key', 'value'] },
    describe: 'Remember a durable fact about the user or someone they mention (dietary needs, preferences, birthdays)',
  },
  {
    name: 'memory_list', risk: 'low', fn: async ({ userId }) => (await memory.list(userId)).map((m) => ({ key: m.key, value: m.value })),
    schema: { type: 'object', properties: {} },
    describe: 'List what you remember about the user',
  },
  // --- Gmail extended (features 3-6, 8-14) --------------------------------
  {
    name: 'gmail_triage', risk: 'low', fn: gmail.triageMessages,
    schema: { type: 'object', properties: { maxResults: { type: 'number' } } },
    describe: 'List unread inbox bucketed into urgent / needs-reply / fyi, each with a one-line reason',
  },
  {
    name: 'gmail_thread', risk: 'low', fn: gmail.readThread,
    schema: { type: 'object', properties: { threadId: { type: 'string', description: 'Thread id from gmail_search' } }, required: ['threadId'] },
    describe: 'Fetch a full email thread: summary, participants, key dates, action items',
  },
  {
    name: 'gmail_reply', risk: 'high', fn: gmail.replyMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' }, body: { type: 'string' } }, required: ['id', 'body'] },
    describe: 'Reply to an email as the user, threaded (always needs approval of the exact body)',
  },
  {
    name: 'gmail_forward', risk: 'high', fn: gmail.forwardMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' }, to: { type: 'string' } }, required: ['id', 'to'] },
    describe: 'Forward an email to someone (always needs approval)',
  },
  {
    name: 'gmail_draft', risk: 'medium', fn: gmail.createDraft,
    schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to'] },
    describe: 'Save a Gmail draft and return its draft id',
  },
  {
    name: 'gmail_delete', risk: 'medium', fn: gmail.trashMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' } }, required: ['id'] },
    describe: 'Move an email to Trash (needs confirmation)',
  },
  {
    name: 'gmail_archive', risk: 'medium', fn: gmail.archiveMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' } }, required: ['id'] },
    describe: 'Archive an email (remove from inbox)',
  },
  {
    name: 'gmail_mark', risk: 'medium', fn: gmail.markMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' }, read: { type: 'boolean' } }, required: ['id', 'read'] },
    describe: 'Mark an email read or unread',
  },
  {
    name: 'gmail_star', risk: 'medium', fn: gmail.starMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' }, starred: { type: 'boolean' } }, required: ['id', 'starred'] },
    describe: 'Star or unstar an email',
  },
  {
    name: 'gmail_receipts', risk: 'low', fn: gmail.findReceipts,
    schema: { type: 'object', properties: { days: { type: 'number', description: 'Lookback window, 1-365, default 30' } } },
    describe: 'Find order confirmations and receipts: merchant, amount, date',
  },
  {
    name: 'gmail_attachments', risk: 'low', fn: gmail.findAttachments,
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    describe: 'Find messages with attachments: filename, type, size, message id',
  },
  // --- Calendar extended (features 19-24) ----------------------------------
  {
    name: 'calendar_freetime', risk: 'low', fn: calendar.freeTime,
    schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' }, durationMin: { type: 'number' }, startHour: { type: 'number' }, endHour: { type: 'number' } } },
    describe: 'Find free time slots in a day given existing events',
  },
  {
    name: 'calendar_conflict', risk: 'low', fn: calendar.conflict,
    schema: { type: 'object', properties: { start: { type: 'string', description: 'Range start, ISO 8601' }, end: { type: 'string', description: 'Range end, ISO 8601' } }, required: ['start', 'end'] },
    describe: 'Check whether a time range conflicts with existing events',
  },
  {
    name: 'calendar_briefing', risk: 'low', fn: calendar.briefing,
    schema: { type: 'object', properties: {} },
    describe: "Morning briefing: today's events plus which ones need prep",
  },
  {
    name: 'calendar_from_email', risk: 'medium', fn: calendar.eventFromEmail,
    schema: { type: 'object', properties: { messageId: { type: 'string', description: 'Gmail message id from gmail_search' } }, required: ['messageId'] },
    describe: 'Parse a real personal meeting invite or booking email and stage event fields for approval (does not create anything). Prefer .ics attachments or event details sent to the user personally; never stage marketing/promotional "you\'re invited" emails — if none exists, say so honestly.',
  },
  {
    name: 'calendar_reminders', risk: 'low', fn: calendar.reminders,
    schema: { type: 'object', properties: {} },
    describe: 'Upcoming events in the next 48h that need reminders, with lead times',
  },
  {
    name: 'calendar_week', risk: 'low', fn: calendar.week,
    schema: { type: 'object', properties: {} },
    describe: '7-day calendar preview grouped by day',
  },
];

// Legacy entries win on name collisions: a connector-contributed tool can
// never shadow an existing one.
const _seen = new Set(_RAW_TOOLS.map((t) => t.name));
const TOOLS = [
  ...require('../connectors/registry').allTools().filter((t) => !_seen.has(t.name)),
  ..._RAW_TOOLS,
];

const SYSTEM_PROMPT = `You are the user's personal agent inside the Ring app. You can:
- Email: search, read full messages and threads, triage the inbox (urgent/needs-reply/fyi), reply and forward (always with approval of the exact text), save drafts, delete, archive, mark read/unread, star, find receipts and attachments.
- Calendar: list, create, reschedule, and cancel events (changes need confirmation), find free time, check conflicts, morning briefings, turn invite emails into staged events, pre-event reminders, week previews.
- Inbox intel: meeting prep (attendees + related mail), trip confirmations pulled into itineraries with staged calendar events, RSVPs (approval), follow-up radar for unanswered mail, subscription detection from receipts, spending recaps, contact lookup from inbox history, deadline watching with staged reminders.
- Real outcomes: book restaurant tables for real (confirmation reference required — never claim booked without one), change/cancel reservations, cancel subscriptions with proof, book rides (confirm before ordering), find tonight's restaurants, log into websites and complete tasks (per-action approval, vaulted credentials), fill web forms, check order/delivery status, live price checks, diagnose and fix messed-up reservations.
- Memory + groups: remember durable facts, recall them, reply as @ring in group chats, run polls to plan with friends and lock a time, daily briefs, draft messages (never send without approval), learn routines, smart nudges.
Be concise and plainspoken. Never claim a booking, cancellation, message, or send is done until its tool returns proof — and anything that spends money or sends as the user needs their explicit approval first.
Exhaustiveness: when the user asks about a topic as a whole ("all the emails about X", "everything on Y"), miss nothing — start with the BROADEST query (one or two words, e.g. just "ring") with maxResults 30, enumerate every matching threadId, then read each candidate thread; never rely on narrow phrasings that silently drop threads with different subject lines. One broad search is enough — scan its ENTIRE thread list before reading anything, then batch-read every thread where the other party replied. Prefer reading threads over running more searches; don't burn your budget re-searching. and never present a partial count as the complete picture. If you cannot verify completeness, say what you covered and what you might have missed. When the user asks for a specific number ("give me 5"), do the opposite: read each candidate thread fully and rank by substance.
Approval mechanics: when the user asks for something that needs approval (reply, forward, send, draft, trash, archive, mark, star, create/reschedule/cancel events, bookings, orders, logins), CALL the tool with the exact arguments — the system automatically holds it for the user's approval instead of executing it. Never substitute a text question ("should I do X?") for the tool call; the approval card is how the user confirms. Honesty rule: if your reply says you submitted, staged, or are holding something for approval, you MUST have called the corresponding tool in this turn. Never describe a tool call you did not make — no approval card exists unless the tool was actually called.`;

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

// Per-turn date/timezone context. The model has no clock, so without this
// relative dates ("tomorrow") default to wrong days and bare times to UTC.
// Vishnu's standing timezone is Europe/Rome.
function tzOffsetISO(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const diffMin = Math.round((asUTC - date.getTime()) / 60000);
  const a = Math.abs(diffMin);
  return `${diffMin >= 0 ? '+' : '-'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
function withTimeContext(base, tz) {
  // Prefer the client's actual timezone (sent with chat turns); fall back to
  // the stored default. A wrong "today" makes every relative date wrong, so
  // never trust a hardcoded zone when the client told us where the user is.
  let zone = 'Europe/Rome';
  if (typeof tz === 'string' && tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); zone = tz; } catch { /* invalid zone: keep default */ }
  }
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(now);
  const timeStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const offset = tzOffsetISO(zone, now);
  return `${base}\n\nCurrent date/time: ${dateStr}, ${timeStr} in the user's timezone (${zone}, UTC${offset}). Interpret relative dates ("today", "tomorrow", "next Friday") and bare times in this timezone, and pass event start/end as ISO datetimes with this numeric offset (e.g. 2026-09-29T10:00:00${offset}) — never bare UTC "Z" times.`;
}

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
    case 'gmail_read':
      return {
        demo: true, id: a.id || 'demo-msg-1', subject: 'Demo: your inbox at a glance',
        from: 'demo@example.com', body: 'Demo mode: simulated email body. Sign in to read your real email.',
      };
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
    case 'calendar_update':
      return { demo: true, updated: false, note: 'Demo mode: no calendar event was actually changed. Sign in for the real thing.' };
    case 'calendar_delete':
      return { demo: true, deleted: false, note: 'Demo mode: no calendar event was actually deleted. Sign in for the real thing.' };
    case 'places_search':
      return {
        demo: true,
        places: [{ name: 'Demo Bistro', vicinity: '123 Demo St', rating: 4.5, note: `Simulated result for "${a.query || ''}"` }],
      };
    case 'uber_ride_link':
      return { demo: true, url: 'https://m.uber.com/?demo=1', note: 'Demo mode: simulated deep link.' };
    case 'dining_links':
      return { demo: true, opentable: 'https://www.opentable.com/?demo=1', note: 'Demo mode: simulated deep links.' };
    case 'gmail_triage': return { demo: true, counts: { urgent: 1, 'needs-reply': 0, fyi: 0 }, messages: [{ id: 'demo-msg-1', subject: 'Demo: payment failed', from: 'billing@example.com', category: 'urgent', reason: 'Demo mode: simulated. Sign in to triage your real inbox.' }] };
    case 'gmail_thread': return { demo: true, threadId: a.threadId || 'demo-t1', messageCount: 2, participants: ['demo@example.com'], firstDate: new Date().toISOString(), lastDate: new Date().toISOString(), summary: 'Demo mode: simulated thread. Sign in for the real thing.', actionItems: [] };
    case 'gmail_reply': return { demo: true, sent: false, note: 'Demo mode: no reply was sent. Sign in to reply for real.' };
    case 'gmail_forward': return { demo: true, sent: false, note: 'Demo mode: nothing was forwarded. Sign in to forward for real.' };
    case 'gmail_draft': return { demo: true, created: false, note: 'Demo mode: no draft was saved. Sign in to draft for real.' };
    case 'gmail_delete': return { demo: true, trashed: false, note: 'Demo mode: nothing was trashed. Sign in for the real thing.' };
    case 'gmail_archive': return { demo: true, archived: false, note: 'Demo mode: nothing was archived. Sign in for the real thing.' };
    case 'gmail_mark': return { demo: true, note: 'Demo mode: read state unchanged. Sign in for the real thing.' };
    case 'gmail_star': return { demo: true, note: 'Demo mode: star unchanged. Sign in for the real thing.' };
    case 'gmail_receipts': return { demo: true, receipts: [{ merchant: 'Demo Store', amount: '$24.99', date: new Date().toISOString(), note: 'Demo mode: simulated. Sign in for real receipts.' }] };
    case 'gmail_attachments': return { demo: true, attachments: [{ filename: 'demo.pdf', mimeType: 'application/pdf', size: 12345, messageId: 'demo-msg-1', note: 'Demo mode: simulated. Sign in for real attachments.' }] };
    case 'calendar_freetime': return { demo: true, slots: [{ start: '09:30', end: '10:30' }, { start: '14:00', end: '16:00' }], note: 'Demo mode: sample free slots. Sign in for the real thing.' };
    case 'calendar_conflict': return { demo: true, conflict: false, note: 'Demo mode: no conflicts found. Sign in for the real thing.' };
    case 'calendar_briefing': return { demo: true, events: [{ summary: 'Team standup', start: '09:00' }], note: 'Demo mode: sample briefing. Sign in for the real thing.' };
    case 'calendar_from_email': return { demo: true, staged: true, created: false, note: 'Demo mode: staged fields only, nothing created. Sign in for the real thing.' };
    case 'calendar_reminders': return { demo: true, reminders: [], note: 'Demo mode: no reminders. Sign in for the real thing.' };
    case 'calendar_week': return { demo: true, days: [], note: 'Demo mode: empty week. Sign in for the real thing.' };
    case 'intel_meeting_prep': return { demo: true, brief: 'Demo mode: simulated meeting prep. Sign in for the real thing.' };
    case 'intel_trip': return { demo: true, stagedOnly: true, bookings: [], stagedEvents: [], note: 'Demo mode: simulated trip pull. Sign in for the real thing.' };
    case 'intel_rsvp': return { demo: true, sent: false, note: 'Demo mode: no RSVP was sent. Sign in for the real thing.' };
    case 'intel_followup': return { demo: true, sentUnanswered: [], unrepliedImportant: [], note: 'Demo mode: simulated follow-up radar.' };
    case 'intel_subscriptions': return { demo: true, subscriptions: [{ merchant: 'Demo Monthly', amount: 9.99, currency: 'USD', cadence: 'monthly', note: 'Demo mode: simulated.' }] };
    case 'intel_spending': return { demo: true, total: 0, byMerchant: [], byCategory: [], note: 'Demo mode: simulated spending recap.' };
    case 'intel_contact': return { demo: true, contacts: [], note: 'Demo mode: simulated contact search.' };
    case 'intel_deadlines': return { demo: true, stagedOnly: true, deadlines: [], stagedReminders: [], note: 'Demo mode: simulated deadline watch.' };
    case 'dining_book': return { demo: true, booked: false, tier: 'handoff', note: 'Demo mode: nothing was booked. Sign in for real booking.' };
    case 'dining_change': return { demo: true, changed: false, cancelled: false, note: 'Demo mode: no reservation was changed or cancelled.' };
    case 'subscription_cancel': return { demo: true, cancelled: false, note: 'Demo mode: nothing was cancelled. Sign in for the real thing.' };
    case 'ride_book': return { demo: true, ordered: false, link: 'https://m.uber.com/?demo=1', note: 'Demo mode: no ride was ordered.' };
    case 'dining_tonight': return { demo: true, options: [{ name: 'Demo Bistro', rating: 4.5, availabilityNote: 'Demo mode: simulated options.' }] };
    case 'web_login_task': return { demo: true, completed: false, note: 'Demo mode: no login was performed.' };
    case 'web_form_fill': return { demo: true, filled: false, note: 'Demo mode: nothing was filled.' };
    case 'order_status': return { demo: true, found: false, note: 'Demo mode: sign in to check real orders.' };
    case 'price_check': return { demo: true, checked: false, note: 'Demo mode: no live price was checked.' };
    case 'reservation_fix': return { demo: true, diagnosed: false, applied: false, note: 'Demo mode: nothing was diagnosed or fixed.' };
    case 'group_plan': return { demo: true, note: 'Demo mode: no plan was created. Sign in for the real thing.' };
    case 'daily_brief': return { demo: true, brief: 'Demo mode: simulated daily brief. Sign in for the real thing.' };
    case 'draft_message': return { demo: true, draft: true, text: 'Demo mode: simulated draft.', note: 'DRAFT ONLY — never sent.' };
    case 'routine_learn': return { demo: true, routines: [], note: 'Demo mode: no routines learned.' };
    case 'smart_nudge': return { demo: true, nudges: [], note: 'Demo mode: no nudges.' };
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

// Honesty guard: the model sometimes tells the user it submitted, staged,
// or is holding an action for approval without ever calling the tool —
// leaving the user waiting on an approval card that can never arrive.
// claimsSelfSubmitted detects that lie so the turn can be corrected.
function claimsSelfSubmitted(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase();
  // Describing the existing approval queue ("you have 2 items pending
  // approval") is not a submission claim — only correct when the model
  // implies IT submitted or staged something this turn.
  if (/\b(you have|there are) \d+[^.\n]{0,80}pending approval\b/.test(t)) return false;
  return /\bi(['’]ve| have) (submitted|staged|held|created a draft)\b/.test(t)
    || /\bi(['’]m| am) (waiting on your approval|holding this for approval)\b/.test(t)
    || /\b(held for your approval|waiting for your approval|pending approval|approval card|confirm the (action|prompt))\b/.test(t);
}

const HONESTY_CORRECTION = `Your last reply told the user you submitted, staged, or are holding an action for their approval, but you did not call any tool — so nothing was submitted. If the user asked you to do something that needs approval, CALL the exact tool now with the exact arguments; the system holds it for approval automatically. If you were only describing the approval queue or answering a question, reply briefly WITHOUT claiming you submitted anything.`;

// One round of tool-call processing, shared by both turn functions so the
// honesty guard reuses the exact same execution semantics as the main loop.
async function processToolCalls({ toolCalls, tools, userId, toolsUsed, allResults }) {
  const results = [];
  for (const tc of toolCalls) {
    const tool = tools.find((t) => t.name === tc.name);
    if (!tool) continue;
    toolsUsed.push({ name: tool.name, risk: tool.risk, args: tc.args });
    if (tool.risk === 'low') {
      try {
        const out = await tool.fn({ userId, ...tc.args });
        results.push(`${tc.name} → ${JSON.stringify(out).slice(0, 10000)}`);
        logToolRun({ userId, tool: tool.name, args: tc.args, result: out, status: 'executed' }).catch(() => {});
      } catch (e) {
        results.push(`${tc.name} → ERROR ${e.code || ''}: ${e.message}`.slice(0, 400));
        logToolRun({ userId, tool: tool.name, args: tc.args, result: { error: e.message, code: e.code }, status: 'failed' }).catch(() => {});
      }
    } else {
      results.push(`${tc.name} → HELD for user approval`);
    }
  }
  allResults.push(...results);
}

async function runAgentTurnStream({ text, userId = 'local', threadId = 'local', onToken, demo = false, maxTokens = null, voice = false, tz = null }) {
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
  const streamOpts = { system: withTimeContext(SYSTEM_PROMPT + (voice ? VOICE_STYLE : ''), tz), ...(maxTokens || voice ? { maxTokens: maxTokens || 150 } : {}) };
  const first = await call(prompt, onToken, tools, streamOpts);

  const toolsUsed = [];
  const allResults = [];
  // Multi-round agent loop (same fix as runAgentTurn): keep executing tool
  // calls and re-prompting until the model answers with no further tool
  // calls, bounded at MAX_ROUNDS (12: enough for exhaustive multi-thread reads).
  const MAX_ROUNDS = 12;
  let pending = first.toolCalls || [];
  let finalText = first.text;
  let rounds = 0;
  while (pending.length && rounds < MAX_ROUNDS) {
    rounds++;
    await processToolCalls({ toolCalls: pending, tools, userId, toolsUsed, allResults });
    const roundBase = finalText;
    const follow = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nNow reply to the user concisely (1-3 short sentences). If something is held for approval, say what you're waiting on.`,
      (tok) => { if (onToken) onToken(tok); },
      tools,
      streamOpts
    );
    // follow.text was already streamed token-by-token; rebuild final text.
    if (follow.text) finalText = roundBase + follow.text;
    pending = follow.toolCalls || [];
  }
  // Honesty guard: the model sometimes tells the user it submitted, staged,
  // or is holding an action for approval without ever calling the tool —
  // leaving the user waiting on a card that can never arrive. Detect that
  // and run up to two corrective rounds so it actually calls the tool.
  let corrections = 0;
  while (corrections < 2 && rounds < MAX_ROUNDS && !pending.length
         && claimsSelfSubmitted(finalText)
         && !toolsUsed.some((t) => t.risk !== 'low')) {
    corrections++;
    rounds++;
    // The correction round is internal self-correction: its tokens are not
    // streamed to the UI and its text never reaches the user — only the
    // honest closing reply below is user-visible.
    const fix = await call(
      `${prompt}\n\n${HONESTY_CORRECTION}`,
      () => {},
      tools,
      streamOpts
    );
    const fixCalls = fix.toolCalls || [];
    if (fixCalls.length && rounds < MAX_ROUNDS) {
      rounds++;
      await processToolCalls({ toolCalls: fixCalls, tools, userId, toolsUsed, allResults });
    }
    const closeBase = finalText;
    const close = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nNow reply to the user concisely (1-3 short sentences). If something is held for approval, say what you're waiting on.`,
      (tok) => { if (onToken) onToken(tok); },
      tools,
      streamOpts
    );
    // close.text was already streamed token-by-token; rebuild final text.
    if (close.text) finalText = closeBase + close.text;
    pending = close.toolCalls || [];
  }

  // Round cap hit mid-research: one final tool-free call so the user gets a
  // synthesized answer instead of a stale/empty reply.
  if (pending.length) {
    const wrap = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nYou have reached your research limit. Write your best complete answer from the results above. If coverage is partial, say exactly what you checked and what you didn't get to — never present a partial count as the whole.`,
      (tok) => { if (onToken) onToken(tok); },
      [],
      streamOpts
    );
    if (wrap.text) finalText = finalText + wrap.text;
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

async function runAgentTurn({ text, userId = 'local', threadId = 'local', demo = false, telegram = null, maxTokens = null, voice = false, tz = null }) {
  const tg = telegram && telegram.style === 'telegram' ? telegram : null;
  const tools = demo ? DEMO_TOOLS : TOOLS;
  if (!llmConfigured()) return { ...cannedReply(text), mode: demo ? 'canned-demo' : 'canned' };

  const system = withTimeContext(SYSTEM_PROMPT + (tg ? TG_STYLE(tg.name) : '') + (voice ? VOICE_STYLE : ''), tz);
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
  const allResults = [];
  // Multi-round agent loop: keep executing the model's tool calls and
  // re-prompting with results until it answers with no further tool calls
  // (bounded so a confused model can't spin forever). Without this, any
  // two-step flow (e.g. gmail_search → gmail_read) dies after round one
  // and the user gets an empty reply.
  const MAX_ROUNDS = 12;
  let pending = first.toolCalls || [];
  let finalText = first.text;
  let rounds = 0;
  while (pending.length && rounds < MAX_ROUNDS) {
    rounds++;
    await processToolCalls({ toolCalls: pending, tools, userId, toolsUsed, allResults });
    const follow = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nNow reply to the user concisely${tg ? ' — one or two short texts' : ' (1-3 short sentences)'}. If something is held for approval, say what you're waiting on.`,
      tools,
      callOpts
    );
    if (follow.text) finalText = follow.text;
    pending = follow.toolCalls || [];
  }
  // Honesty guard: the model sometimes tells the user it submitted, staged,
  // or is holding an action for approval without ever calling the tool —
  // leaving the user waiting on a card that can never arrive. Detect that
  // and run up to two corrective rounds so it actually calls the tool.
  let corrections = 0;
  while (corrections < 2 && rounds < MAX_ROUNDS && !pending.length
         && claimsSelfSubmitted(finalText)
         && !toolsUsed.some((t) => t.risk !== 'low')) {
    corrections++;
    rounds++;
    const fix = await call(`${prompt}\n\n${HONESTY_CORRECTION}`, tools, callOpts);
    if (fix.text) finalText = fix.text;
    const fixCalls = fix.toolCalls || [];
    if (fixCalls.length && rounds < MAX_ROUNDS) {
      rounds++;
      await processToolCalls({ toolCalls: fixCalls, tools, userId, toolsUsed, allResults });
    }
    const close = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nNow reply to the user concisely (1-3 short sentences). If something is held for approval, say what you're waiting on.`,
      tools,
      callOpts
    );
    if (close.text) finalText = close.text;
    pending = close.toolCalls || [];
  }

  // If the round cap hit mid-research, never return an empty or stale reply:
  // one final tool-free call synthesizes everything gathered so far.
  if (pending.length) {
    const wrap = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nYou have reached your research limit. Write your best complete answer from the results above. If coverage is partial, say exactly what you checked and what you didn't get to — never present a partial count as the whole.`,
      [],
      callOpts
    );
    if (wrap.text) finalText = wrap.text;
  }
  return { text: finalText, toolsUsed, mode: 'live' };
}

module.exports = { TOOLS, DEMO_TOOLS, runAgentTurn, runAgentTurnStream, llmConfigured };
