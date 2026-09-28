// Email+Calendar intel connector — derived intelligence from the user's
// Gmail + Google Calendar. No secrets of its own: it composes the gmail.js
// and calendar.js connectors (their guards throw NotConfigured when the
// user hasn't connected Google). lib/memory enriches contact lookups.
//
// WRITE RULES (owner-bound):
// - intel_trip and intel_deadlines return STAGED items only — the agent
//   loop creates calendar events / reminders through the approval gate.
// - intel_rsvp composes the exact reply text deterministically so the
//   approval card shows precisely what will be sent.
//
// All parsing helpers are pure and exported under `pure` for unit tests
// (no grant, no network).
const { searchMessages, readMessage, sendMessage } = require('./gmail');
const { listEvents } = require('./calendar');
const { gfetch } = require('../lib/google');
const memory = require('../lib/memory');

const id = 'intel';
const name = 'Email+Calendar intel';
const description = 'Derived intelligence: meeting prep, trip itineraries, follow-ups, subscriptions, spending, contacts, deadlines';
const envVars = []; // rides on the Google (Gmail + Calendar) connector

function status() {
  return { ok: true, auth: 'via-google', dependsOn: ['gmail', 'calendar'] };
}

// ---------------- pure helpers (no I/O) ----------------

const STOPWORDS = new Set(
  'a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,can,could,should,shall,may,might,must,your,you,our,we,they,them,this,that,these,those,what,which,who,how,when,where,not,no,yes,re,fw,fwd,vs,update,updates,updated,meeting,call,email,invitation,invite,reminder,confirm,confirmed,confirmation'.split(',')
);

function keywords(text, max = 6) {
  const counts = new Map();
  for (const t of (text || '').toLowerCase().split(/[^a-z0-9']+/)) {
    const w = t.replace(/'s$/, '');
    if (w.length > 3 && !STOPWORDS.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

function emailOf(from) {
  const m = (from || '').match(/<([^>]+)>/) || (from || '').match(/([\w.+-]+@[\w.-]+\.\w+)/);
  return m ? m[1].toLowerCase() : null;
}

function nameOf(from) {
  const m = (from || '').match(/^"?([^"<]+?)"?\s*</);
  if (m && m[1].trim()) return m[1].trim();
  return null;
}

function orgOf(email) {
  if (!email || !email.includes('@')) return null;
  const domain = email.split('@')[1].toLowerCase();
  const freemail = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com']);
  if (freemail.has(domain)) return null;
  return domain.split('.')[0].replace(/[-_]/g, ' ');
}

const AMT = /(?:\$|USD\s*|€|EUR\s*|£|GBP\s*)\s?([\d,]+(?:\.\d{1,2})?)/i;
function parseAmount(text) {
  const m = (text || '').match(AMT);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(amount)) return null;
  const currency = /€|EUR/i.test(m[0]) ? 'EUR' : /£|GBP/i.test(m[0]) ? 'GBP' : 'USD';
  return { amount, currency };
}

function parseReceipt(msg) {
  const from = msg.from || '';
  const disp = nameOf(from);
  const em = emailOf(from);
  const merchant = disp || (em ? orgOf(em) : null) || 'Unknown';
  const amt = parseAmount((msg.subject || '') + ' ' + (msg.snippet || ''));
  return { merchant, amount: amt ? amt.amount : null, currency: amt ? amt.currency : null, date: msg.date || null, subject: msg.subject || '' };
}

// Given sorted ISO-ish date strings, classify billing cadence.
function detectCadence(dates) {
  const ts = (dates || [])
    .map((d) => new Date(d).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (ts.length < 2) return 'unknown';
  const days = [];
  for (let i = 1; i < ts.length; i++) days.push((ts[i] - ts[i - 1]) / 86400000);
  const med = days.slice().sort((a, b) => a - b)[Math.floor(days.length / 2)];
  if (med >= 5 && med <= 9) return 'weekly';
  if (med >= 25 && med <= 35) return 'monthly';
  if (med >= 85 && med <= 100) return 'quarterly';
  if (med >= 350 && med <= 380) return 'yearly';
  return 'irregular';
}

const CATEGORY_RULES = [
  ['streaming', /netflix|spotify|hulu|disney\+|hbo|youtube|prime video|apple tv|paramount|peacock/i],
  ['food', /doordash|uber eats|grubhub|chipotle|starbucks|dominos|papa john|panera|mcdonald|chick-fil-a/i],
  ['transport', /uber|lyft|delta|united|american airlines|spirit|airbnb|hotel|marriott|hyatt|hertz|enterprise/i],
  ['software', /github|openai|anthropic|figma|notion|slack|adobe|dropbox|zoom/i],
  ['shopping', /amazon|walmart|target|costco|best buy|apple\.com|ikea/i],
  ['utilities', /comcast|xfinity|at&t|verizon|t-mobile|coned|pg&e|duke energy/i],
  ['fitness', /planet fitness|equinox|peloton|gym/i],
];
function categorizeMerchant(merchant) {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(merchant || '')) return cat;
  return 'other';
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
function extractDeadlines(text) {
  const out = [];
  const seen = new Set();
  const re = new RegExp(
    `(deadline|due\\s+(?:by|on)|payment\\s+due|expires?\\s+(?:on|by)|submit\\s+by|rsvp\\s+by|apply\\s+by)\\s*:?\\s*((?:${MONTHS})\\w*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)`,
    'gi'
  );
  let m;
  while ((m = re.exec(text || '')) && out.length < 10) {
    const key = (m[1] + m[2]).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ trigger: m[1].trim(), dateText: m[2].trim(), context: (text || '').slice(Math.max(0, m.index - 80), m.index + 120).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

const CONF_STOP = new Set(['CONFIRM', 'CONFIRMED', 'CONFIRMATION', 'BOOKING', 'RESERVATION', 'RESERVED', 'ITINERARY', 'TICKET', 'REFERENCE', 'NUMBER', 'CODE']);
// Token-walk after a label: avoids matching the label's own tail
// ("conf" + "irmation") as the code.
function confirmationCode(hay) {
  const label = /\b(?:confirmation|conf\.?|booking|reservation|ref(?:erence)?|pnr|itinerary)\b\s*(?:#|no\.?|code\b)?\s*[:#]?\s*/gi;
  let lm;
  while ((lm = label.exec(hay))) {
    let rest = hay.slice(label.lastIndex);
    for (let guard = 0; guard < 5; guard++) {
      const tm = rest.match(/^[^\w]*([A-Za-z0-9]{5,8})\b/);
      if (!tm) break;
      const code = tm[1].toUpperCase();
      if (!CONF_STOP.has(code)) return code;
      rest = rest.slice(tm[0].length);
    }
  }
  return null;
}
const FLIGHT_RE = /\b([A-Z]{2})\s?(\d{1,4}[A-Z]?)\b/;
function parseTravel(msg) {
  const hay = `${msg.subject || ''} ${msg.snippet || ''} ${msg.from || ''}`;
  const from = (msg.from || '').toLowerCase();
  let kind = 'other';
  if (/flight|airline|boarding|e-?ticket|airways|delta|united|american|spirit|southwest|jetblue/i.test(hay)) kind = 'flight';
  else if (/hotel|airbnb|check-?in|reservation|marriott|hyatt|hilton|booking\.com/i.test(hay)) kind = 'hotel';
  else if (/rental|hertz|enterprise|avis|budget/i.test(from) && /car|rental/i.test(hay)) kind = 'car';
  const conf = confirmationCode(hay);
  const flight = kind === 'flight' ? hay.match(FLIGHT_RE) : null;
  return {
    kind,
    subject: msg.subject || '',
    from: msg.from || '',
    date: msg.date || null,
    confirmation: conf || null,
    flight: flight ? `${flight[1]}${flight[2]}` : null,
  };
}

function isNewsletter(from) {
  return /no-?reply|donotreply|noreply|news@|newsletter|updates@|notify@|alerts@|marketing@/i.test(from || '');
}

const pure = { keywords, emailOf, nameOf, orgOf, parseAmount, parseReceipt, detectCadence, categorizeMerchant, extractDeadlines, confirmationCode, parseTravel, isNewsletter };

// ---------------- tool implementations (compose gmail.js / calendar.js) ----------------

async function getEventById(userId, eventId) {
  // Not exposed by calendar.js; use the shared Google fetch helper directly.
  const e = await gfetch(
    userId,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`
  );
  return {
    id: e.id,
    summary: e.summary,
    description: e.description,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location,
    attendees: (e.attendees || []).map((a) => ({ email: a.email, name: a.displayName || a.email })),
  };
}

async function meetingPrep({ userId, eventId }) {
  if (!eventId) throw new Error('eventId is required');
  const event = await getEventById(userId, eventId);
  const attendeeEmails = event.attendees.map((a) => a.email);
  const kws = keywords(`${event.summary || ''} ${event.description || ''}`);
  const queries = [];
  if (kws.length) queries.push(`{${kws.slice(0, 4).join(' ')}}`);
  if (attendeeEmails.length) queries.push(`from:{${attendeeEmails.slice(0, 3).join(' OR ')}}`);
  const seen = new Set();
  const related = [];
  for (const q of queries) {
    const hits = await searchMessages({ userId, query: q, maxResults: 5 });
    for (const h of hits) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      related.push(h);
    }
  }
  const context = [];
  for (const h of related.slice(0, 3)) {
    const full = await readMessage({ userId, id: h.id });
    context.push({ subject: full.subject, from: full.from, body: full.body.slice(0, 1200) });
  }
  const brief = [
    `Meeting: ${event.summary || '(untitled)'} — ${event.start || ''}`,
    event.location ? `Location: ${event.location}` : null,
    attendeeEmails.length ? `Attendees: ${attendeeEmails.join(', ')}` : null,
    event.description ? `Notes: ${event.description.slice(0, 400)}` : null,
    context.length ? `Recent related mail (${context.length}):\n` + context.map((c) => `• ${c.subject} (${nameOf(c.from) || emailOf(c.from) || c.from}): ${c.body.slice(0, 220)}`).join('\n') : 'No related emails found.',
  ].filter(Boolean).join('\n');
  return { event, relatedEmails: related.slice(0, 8), brief };
}

async function trip({ userId, days = 90 }) {
  const d = Math.min(Math.max(days | 0 || 90, 1), 365);
  const q = `subject:(itinerary OR confirmation OR "e-ticket" OR "booking confirmation" OR reservation) newer_than:${d}d`;
  const hits = await searchMessages({ userId, query: q, maxResults: 20 });
  const bookings = [];
  const seen = new Set();
  for (const h of hits) {
    const t = parseTravel(h);
    if (t.kind === 'other') continue;
    const key = t.confirmation || `${t.subject}${t.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bookings.push(t);
  }
  const stagedEvents = bookings.map((b) => ({
    staged: true,
    summary: `${b.kind === 'flight' ? '✈' : b.kind === 'hotel' ? '🏨' : '🚗'} ${b.subject}`.slice(0, 120),
    location: null,
    note: [b.confirmation && `Confirmation: ${b.confirmation}`, b.flight && `Flight: ${b.flight}`, `From email: ${b.date || 'unknown date'}`].filter(Boolean).join(' · '),
  }));
  return {
    stagedOnly: true,
    windowDays: d,
    bookings,
    stagedEvents,
    note: 'Events are STAGED, not created. Creation goes through the normal confirmation gate.',
  };
}

async function rsvp({ userId, messageId, response }) {
  if (!messageId) throw new Error('messageId is required');
  if (response !== 'yes' && response !== 'no') throw new Error('response must be "yes" or "no"');
  const msg = await readMessage({ userId, id: messageId });
  const to = emailOf(msg.from);
  if (!to) throw new Error('could not determine the invite sender address');
  const sender = nameOf(msg.from) || to;
  const body = response === 'yes'
    ? `Hi ${sender},\n\nThanks for the invite — I'd love to come.\n\nEvent: ${msg.subject}\n\nLet me know if anything changes.\n`
    : `Hi ${sender},\n\nThanks so much for thinking of me, but I won't be able to make it this time.\n\nEvent: ${msg.subject}\n\nHope it goes great.\n`;
  const sent = await sendMessage({ userId, to, subject: `Re: ${msg.subject}`, body });
  return { response, sent: { id: sent.id, to: sent.to, subject: sent.subject, body } };
}

async function followup({ userId, days = 7 }) {
  const d = Math.min(Math.max(days | 0 || 7, 1), 90);
  const [sent, received] = await Promise.all([
    searchMessages({ userId, query: `in:sent newer_than:${d}d`, maxResults: 20 }),
    searchMessages({ userId, query: `in:inbox newer_than:${d}d`, maxResults: 20 }),
  ]);
  const sentUnanswered = sent.map((m) => ({
    id: m.id, to: m.to || m.from, subject: m.subject, date: m.date,
    note: 'sent in window; reply status not tracked — confirm before nudging',
  }));
  const unrepliedImportant = received
    .filter((m) => !isNewsletter(m.from))
    .slice(0, 10)
    .map((m) => ({
      id: m.id, from: m.from, subject: m.subject, date: m.date,
      note: 'received in window; may need a reply',
    }));
  return { windowDays: d, sentUnanswered, unrepliedImportant };
}

async function subscriptions({ userId }) {
  const hits = await searchMessages({
    userId,
    query: 'subject:(receipt OR invoice OR "payment confirmation" OR "subscription renewed" OR billing) newer_than:180d',
    maxResults: 20,
  });
  const groups = new Map();
  for (const h of hits) {
    const r = parseReceipt(h);
    if (r.amount == null) continue;
    const key = `${r.merchant.toLowerCase()}|${r.amount.toFixed(2)}`;
    if (!groups.has(key)) groups.set(key, { merchant: r.merchant, amount: r.amount, currency: r.currency, dates: [] });
    if (r.date) groups.get(key).dates.push(r.date);
  }
  const subs = [...groups.values()].map((g) => ({
    merchant: g.merchant,
    amount: g.amount,
    currency: g.currency,
    occurrences: g.dates.length,
    cadence: detectCadence(g.dates),
    lastSeen: g.dates.length ? g.dates.slice().sort().reverse()[0] : null,
  }));
  subs.sort((a, b) => b.occurrences - a.occurrences || (b.amount || 0) - (a.amount || 0));
  return { subscriptions: subs };
}

async function spending({ userId, days = 30 }) {
  const d = Math.min(Math.max(days | 0 || 30, 1), 365);
  const hits = await searchMessages({
    userId,
    query: `subject:(receipt OR invoice OR "payment confirmation" OR "your order" OR "transaction") newer_than:${d}d`,
    maxResults: 20,
  });
  const byMerchant = new Map();
  const byCategory = new Map();
  let total = 0;
  let count = 0;
  for (const h of hits) {
    const r = parseReceipt(h);
    if (r.amount == null) continue;
    count++;
    total += r.amount;
    byMerchant.set(r.merchant, (byMerchant.get(r.merchant) || 0) + r.amount);
    const cat = categorizeMerchant(r.merchant);
    byCategory.set(cat, (byCategory.get(cat) || 0) + r.amount);
  }
  const sortDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, total: Math.round(v * 100) / 100 }));
  return {
    windowDays: d,
    charges: count,
    total: Math.round(total * 100) / 100,
    byMerchant: sortDesc(byMerchant),
    byCategory: sortDesc(byCategory),
  };
}

async function contact({ userId, name }) {
  if (!name || !name.trim()) throw new Error('name is required');
  const remembered = await memory.recall(userId, name, 5).catch(() => []);
  const hits = await searchMessages({ userId, query: `"${name.trim()}"`, maxResults: 10 });
  const seen = new Set();
  const contacts = [];
  for (const h of hits) {
    const em = emailOf(h.from);
    if (!em || seen.has(em)) continue;
    seen.add(em);
    contacts.push({
      name: nameOf(h.from) || name,
      email: em,
      org: orgOf(em),
      context: h.subject,
      lastSeen: h.date,
    });
  }
  return { query: name, remembered, contacts };
}

async function deadlines({ userId, days = 14 }) {
  const d = Math.min(Math.max(days | 0 || 14, 1), 90);
  const hits = await searchMessages({ userId, query: `in:inbox newer_than:${d}d`, maxResults: 20 });
  const found = [];
  const seen = new Set();
  for (const h of hits.slice(0, 8)) {
    const full = await readMessage({ userId, id: h.id });
    for (const dl of extractDeadlines(`${full.subject}\n${full.body}`)) {
      const key = (dl.dateText + dl.trigger).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ...dl, from: full.from, subject: full.subject });
    }
  }
  const stagedReminders = found.map((f) => ({
    staged: true,
    title: `${f.trigger}: ${f.subject}`.slice(0, 120),
    when: f.dateText,
    detail: f.context,
  }));
  return {
    stagedOnly: true,
    windowDays: d,
    deadlines: found,
    stagedReminders,
    note: 'Reminders are STAGED, not created. Creation goes through the normal confirmation gate.',
  };
}

// ---------------- tool registry entries ----------------

const tools = [
  {
    name: 'intel_meeting_prep', risk: 'low',
    fn: ({ userId, eventId }) => meetingPrep({ userId, eventId }),
    schema: {
      type: 'object',
      properties: { eventId: { type: 'string', description: 'Google Calendar event id' } },
      required: ['eventId'],
    },
    describe: 'Build an agenda-ready brief for a calendar event: details plus related emails from attendees/subject keywords',
  },
  {
    name: 'intel_trip', risk: 'medium',
    fn: ({ userId, days }) => trip({ userId, days }),
    schema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Look back this many days for travel confirmations (default 90)' } },
    },
    describe: 'Find flight/hotel bookings in Gmail and build an itinerary with STAGED calendar events (never created without confirmation)',
  },
  {
    name: 'intel_rsvp', risk: 'high',
    fn: ({ userId, messageId, response }) => rsvp({ userId, messageId, response }),
    schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Gmail id of the invitation email' },
        response: { type: 'string', enum: ['yes', 'no'], description: "yes = accept, no = decline" },
      },
      required: ['messageId', 'response'],
    },
    describe: 'Send an RSVP reply to an invite email (exact text shown on the approval card)',
  },
  {
    name: 'intel_followup', risk: 'low',
    fn: ({ userId, days }) => followup({ userId, days }),
    schema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Look back this many days (default 7)' } },
    },
    describe: 'Emails that may need follow-up: recent sent mail plus unreplied important inbound mail',
  },
  {
    name: 'intel_subscriptions', risk: 'low',
    fn: ({ userId }) => subscriptions({ userId }),
    schema: { type: 'object', properties: {} },
    describe: 'Recurring charges detected from receipts: merchant, amount, cadence, last seen',
  },
  {
    name: 'intel_spending', risk: 'low',
    fn: ({ userId, days }) => spending({ userId, days }),
    schema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Look back this many days (default 30)' } },
    },
    describe: 'Spending recap from receipts: totals by merchant and category',
  },
  {
    name: 'intel_contact', risk: 'low',
    fn: ({ userId, name }) => contact({ userId, name }),
    schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Person to look up' } },
      required: ['name'],
    },
    describe: 'Find contact details for a person from inbox history (name, email, org, context) plus remembered facts',
  },
  {
    name: 'intel_deadlines', risk: 'medium',
    fn: ({ userId, days }) => deadlines({ userId, days }),
    schema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Look back this many days (default 14)' } },
    },
    describe: 'Dates and deadlines extracted from recent emails, returned as STAGED reminders (never created without confirmation)',
  },
];

module.exports = { id, name, description, envVars, status, tools, pure };
