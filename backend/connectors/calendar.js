// Google Calendar connector — read + create events (OAuth 2.0).
// Needs: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (same Google Cloud project
// as Gmail). Scope: calendar.events.
const { missing, NotConfigured } = require('../lib/config');

const requiredEnv = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

function status() {
  const m = missing(requiredEnv);
  return { ok: m.length === 0, missing: m, auth: 'oauth2', scopes: ['calendar.events'] };
}

function guard() {
  const m = missing(requiredEnv);
  if (m.length) throw new NotConfigured('Google Calendar', m);
}

// TODO: GET https://www.googleapis.com/calendar/v3/calendars/primary/events
async function listEvents({ userId, timeMin, timeMax }) {
  guard();
  throw new Error('TODO: wire stored OAuth token for user ' + userId);
}

// TODO: POST https://www.googleapis.com/calendar/v3/calendars/primary/events
async function createEvent({ userId, summary, start, end, location, description }) {
  guard();
  throw new Error('TODO: wire stored OAuth token for user ' + userId);
}

module.exports = { requiredEnv, status, listEvents, createEvent };
