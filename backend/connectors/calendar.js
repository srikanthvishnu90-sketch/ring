// Google Calendar connector — read + create events (OAuth 2.0).
// Needs: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (same Google Cloud project
// as Gmail). Scope: calendar.events.
const { missing, NotConfigured } = require('../lib/config');
const { gfetch, isConnected } = require('../lib/google');

const requiredEnv = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

function status() {
  const m = missing(requiredEnv);
  return {
    ok: m.length === 0,
    missing: m,
    auth: 'oauth2',
    connected: m.length === 0 && isConnected('local'),
    scopes: ['calendar.events'],
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

module.exports = { requiredEnv, status, listEvents, createEvent };
