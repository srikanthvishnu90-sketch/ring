// Google Calendar connector — read + create events (OAuth 2.0).
// Needs: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (same Google Cloud project
// as Gmail). Scope: calendar.events (calendar_from_email also reads the
// invite body, so gmail.readonly is needed for that one tool).
const { missing, NotConfigured } = require('../lib/config');
const { gfetch } = require('../lib/google');

const requiredEnv = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

function status() {
  const m = missing(requiredEnv);
  return {
    ok: m.length === 0,
    missing: m,
    auth: 'oauth2',
    // Honest by construction: this module has no per-user context, so it can
    // NEVER report a real connection from server-side token state.
    // Real per-user state comes only from authenticated
    // GET /api/oauth/google/status.
    connected: false,
    scopes: ['calendar.events', 'gmail.readonly'],
  };
}

function guard() {
  const m = missing(requiredEnv);
  if (m.length) throw new NotConfigured('Google Calendar', m);
}

async function listEvents({ userId, timeMin, timeMax }) {
  guard();
  const q = new URLSearchParams({
    timeMin: timeMin || new Date().toISOString(),
    ...(timeMax ? { timeMax } : {}),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '10',
  });
  const data = await gfetch(userId, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
  return (data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location,
  }));
}

async function createEvent({ userId, summary, start, end, location, description }) {
  guard();
  const created = await gfetch(userId, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    body: JSON.stringify({
      summary,
      location,
      description,
      start: { dateTime: start },
      end: { dateTime: end },
    }),
  });
  return { id: created.id, summary: created.summary, link: created.htmlLink };
}

async function updateEvent({ userId, id, summary, start, end, location, description }) {
  guard();
  if (!id) throw new Error('event id is required');
  const body = {};
  if (summary !== undefined) body.summary = summary;
  if (location !== undefined) body.location = location;
  if (description !== undefined) body.description = description;
  if (start !== undefined) body.start = { dateTime: start };
  if (end !== undefined) body.end = { dateTime: end };
  const updated = await gfetch(
    userId,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(body) }
  );
  return { id: updated.id, summary: updated.summary, link: updated.htmlLink };
}

async function deleteEvent({ userId, id }) {
  guard();
  if (!id) throw new Error('event id is required');
  await gfetch(
    userId,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// Internal helpers (shared by features 19-24).
// ---------------------------------------------------------------------------

// Richer event fetch than listEvents (higher cap, prep-relevant fields).
// Read-only: GET /calendar/v3/calendars/primary/events.
async function fetchEvents({ userId, timeMin, timeMax, maxResults = 50 }) {
  guard();
  const q = new URLSearchParams({
    timeMin: timeMin || new Date().toISOString(),
    ...(timeMax ? { timeMax } : {}),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResults),
  });
  const data = await gfetch(userId, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
  return (data.items || []).map((e) => {
    const start = e.start?.dateTime || e.start?.date;
    const end = e.end?.dateTime || e.end?.date;
    return {
      id: e.id,
      summary: e.summary,
      start,
      end,
      startMs: start ? Date.parse(start) : null,
      endMs: end ? Date.parse(end) : null,
      allDay: !e.start?.dateTime && !!e.start?.date,
      location: e.location || null,
      description: e.description ? String(e.description).slice(0, 500) : null,
      attendees: (e.attendees || []).map((a) => a.email || a.displayName).filter(Boolean),
    };
  });
}

// Pure: given busy intervals (ms) and a window, return gaps >= minMs.
// Exported for unit tests.
function computeFreeSlots(busy, windowStartMs, windowEndMs, minMs) {
  const clipped = busy
    .map((b) => ({ start: Math.max(b.start, windowStartMs), end: Math.min(b.end, windowEndMs) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const b of clipped) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else merged.push({ ...b });
  }
  const slots = [];
  let cursor = windowStartMs;
  for (const b of merged) {
    if (b.start - cursor >= minMs) slots.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (windowEndMs - cursor >= minMs) slots.push({ start: cursor, end: windowEndMs });
  return slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Local-day window bounds: [day 00:00, next 00:00) in server-local time.
function localDayBounds(yyyyMmDd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd || '');
  if (!m) throw new Error('date must be YYYY-MM-DD');
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end };
}

// ---------------------------------------------------------------------------
// 19. calendar_freetime — find free slots in a day given existing events.
// ---------------------------------------------------------------------------
async function freeTime({ userId, date, durationMin = 30, startHour = 8, endHour = 22 }) {
  const now = new Date();
  const day = date || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const { start: dayStart, end: dayEnd } = localDayBounds(day);
  if (!(durationMin > 0)) throw new Error('durationMin must be a positive number of minutes');
  if (!(startHour >= 0 && endHour <= 24 && startHour < endHour))
    throw new Error('startHour/endHour must be within 0-24 with startHour < endHour');

  const events = await fetchEvents({
    userId,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    maxResults: 50,
  });
  const windowStart = dayStart.getTime() + startHour * 3600 * 1000;
  const windowEnd = dayStart.getTime() + endHour * 3600 * 1000;
  const busy = events
    .filter((e) => e.startMs != null && e.endMs != null)
    .map((e) => ({ start: e.startMs, end: e.endMs }));
  const slots = computeFreeSlots(busy, windowStart, windowEnd, durationMin * 60 * 1000);
  return {
    date: day,
    durationMin,
    window: { startHour, endHour },
    busy: events.map((e) => ({ summary: e.summary, start: e.start, end: e.end, allDay: e.allDay })),
    freeSlots: slots,
  };
}

// ---------------------------------------------------------------------------
// 20. calendar_conflict — check whether a time range conflicts.
// ---------------------------------------------------------------------------
async function conflict({ userId, start, end }) {
  if (!start || !end) throw new Error('start and end are required (ISO 8601)');
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
    throw new Error('invalid range: end must be after start');
  const events = await fetchEvents({ userId, timeMin: start, timeMax: end, maxResults: 50 });
  const hits = events.filter(
    (e) => e.startMs != null && e.endMs != null && e.startMs < endMs && e.endMs > startMs
  );
  return {
    conflict: hits.length > 0,
    range: { start, end },
    events: hits.map((e) => ({ id: e.id, summary: e.summary, start: e.start, end: e.end, location: e.location })),
  };
}

// ---------------------------------------------------------------------------
// 21. calendar_briefing — morning briefing: today's events + prep flags.
// ---------------------------------------------------------------------------
async function briefing({ userId }) {
  const now = new Date();
  const day = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const { start: dayStart, end: dayEnd } = localDayBounds(day);
  const events = await fetchEvents({
    userId,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    maxResults: 50,
  });
  const needsPrep = events.filter(
    (e) => e.location || e.description || e.attendees.length > 0
  );
  return {
    date: day,
    count: events.length,
    events: events.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      location: e.location,
      attendees: e.attendees,
    })),
    needsPrep: needsPrep.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      reason: [
        e.location && `location: ${e.location}`,
        e.description && 'has details to review',
        e.attendees.length > 0 && `${e.attendees.length} attendee(s)`,
      ].filter(Boolean),
    })),
  };
}

// ---------------------------------------------------------------------------
// 22. calendar_from_email — parse a Gmail invite/booking email and STAGE
// event fields for approval. Does NOT create anything (creation goes through
// the approval gate + calendar_create).
// ---------------------------------------------------------------------------
const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};

// Pure + deterministic (takes `now` for testability). Exported for tests.
function parseInviteEmail({ subject = '', from = '', body = '', now = new Date() }) {
  const summary =
    subject.replace(/^(re|fwd?|aw)\s*:\s*/i, '').trim().slice(0, 120) || 'Untitled event';
  const text = `${subject}\n${body}`.slice(0, 8000);

  // Date: "October 5", "Oct 5, 2026", "today", "tomorrow".
  let year, month, day;
  const rel = text.match(/\b(today|tomorrow)\b/i);
  const dm = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?/i
  );
  if (rel) {
    const d = new Date(now.getTime() + (rel[1].toLowerCase() === 'tomorrow' ? 24 : 0) * 3600 * 1000);
    year = d.getFullYear(); month = d.getMonth(); day = d.getDate();
  } else if (dm) {
    month = MONTHS[dm[1].toLowerCase()];
    day = Number(dm[2]);
    year = dm[3] ? Number(dm[3]) : now.getFullYear();
  }

  // Time: "2:30 PM", "2pm", "14:30".
  let hour = null, minute = 0;
  const t12 = text.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i);
  const t24 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (t12) {
    hour = Number(t12[1]) % 12 + (t12[3].toLowerCase() === 'p' ? 12 : 0);
    minute = Number(t12[2] || 0);
  } else if (t24) {
    hour = Number(t24[1]); minute = Number(t24[2]);
  }

  // Duration: "for 2 hours", "90 minutes".
  let durMin = 60;
  const dur = text.match(/(?:for|lasts?|about)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)/i);
  if (dur) durMin = dur[2].startsWith('hour') || dur[2].startsWith('hr') ? Number(dur[1]) * 60 : Number(dur[1]);

  // Location: "Location: X", "Where: X", "Venue: X".
  const loc = text.match(/(?:location|where|venue|address)\s*[:\-]\s*([^\n]{1,120})/i);
  const location = loc ? loc[1].trim() : null;

  let start = null, end = null, inferredTime = false, needsDate = false;
  if (year != null) {
    if (hour == null) { hour = 9; minute = 0; inferredTime = true; }
    start = new Date(year, month, day, hour, minute, 0);
    // Roll forward a year if the parsed date is clearly in the past.
    if (start.getTime() < now.getTime() - 24 * 3600 * 1000 && !dm?.[3] && !rel) {
      start = new Date(year + 1, month, day, hour, minute, 0);
    }
    end = new Date(start.getTime() + durMin * 60 * 1000);
  } else {
    needsDate = true;
  }

  return {
    staged: true,
    summary,
    start: start ? start.toISOString() : null,
    end: end ? end.toISOString() : null,
    location,
    description: `From invite email "${subject}" (${from}).\n\n${body.slice(0, 300)}`.trim(),
    inferredTime,
    needsDate,
    source: { from, subject },
  };
}

async function eventFromEmail({ userId, messageId }) {
  if (!messageId) throw new Error('messageId is required');
  guard();
  // Read via the Gmail connector's read path (same grant, gmail.readonly).
  const gmail = require('./gmail');
  const msg = await gmail.readMessage({ userId, id: messageId });
  return parseInviteEmail({ subject: msg.subject, from: msg.from, body: msg.body });
}

// ---------------------------------------------------------------------------
// 23. calendar_reminders — upcoming events in next 48h needing reminders.
// ---------------------------------------------------------------------------
async function reminders({ userId }) {
  const now = new Date();
  const horizon = new Date(now.getTime() + 48 * 3600 * 1000);
  const events = await fetchEvents({
    userId,
    timeMin: now.toISOString(),
    timeMax: horizon.toISOString(),
    maxResults: 50,
  });
  const upcoming = events.filter((e) => e.startMs != null && e.startMs <= horizon.getTime());
  return {
    windowHours: 48,
    count: upcoming.length,
    reminders: upcoming.map((e) => {
      // Lead time: longer events get earlier heads-up.
      const durationH = e.endMs != null ? (e.endMs - e.startMs) / 3600000 : 1;
      const leadMinutes = e.allDay ? 0 : durationH >= 4 ? 180 : 60;
      const base = e.allDay
        ? new Date(new Date(e.startMs).setHours(8, 0, 0, 0)).getTime() // 8am local, day of
        : e.startMs;
      const remindAt = new Date(base - leadMinutes * 60 * 1000).toISOString();
      return {
        id: e.id,
        summary: e.summary,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        location: e.location,
        leadMinutes,
        remindAt,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 24. calendar_week — 7-day preview, grouped by day.
// ---------------------------------------------------------------------------
async function week({ userId }) {
  const now = new Date();
  const day = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const { start: dayStart } = localDayBounds(day);
  const horizon = new Date(dayStart.getTime() + 7 * 24 * 3600 * 1000);
  const events = await fetchEvents({
    userId,
    timeMin: dayStart.toISOString(),
    timeMax: horizon.toISOString(),
    maxResults: 100,
  });
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(dayStart.getTime() + i * 24 * 3600 * 1000);
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    days.push({
      date: key,
      weekday: d.toLocaleDateString('en-US', { weekday: 'long' }),
      events: [],
    });
  }
  const byKey = Object.fromEntries(days.map((d) => [d.date, d]));
  for (const e of events) {
    if (e.startMs == null) continue;
    const d = new Date(e.startMs);
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    if (byKey[key]) {
      byKey[key].events.push({
        id: e.id,
        summary: e.summary,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        location: e.location,
      });
    }
  }
  return { startDate: day, days, total: events.length };
}

module.exports = {
  requiredEnv,
  status,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  freeTime,
  conflict,
  briefing,
  eventFromEmail,
  reminders,
  week,
  // Pure helpers, exported for unit tests (not agent tools):
  computeFreeSlots,
  parseInviteEmail,
};
