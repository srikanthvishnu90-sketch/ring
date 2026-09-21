// Twilio connector — SMS + WhatsApp messaging.
// Needs: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (+E.164,
// e.g. +15551234567). No SDK: plain HTTPS to the Twilio REST API.
//
// Standing product rule: NEVER place voice calls — this connector exposes
// messaging only. There is intentionally no voice-call tool here.
const crypto = require('node:crypto');
const { missing, NotConfigured } = require('../lib/config');

const id = 'twilio';
const name = 'Twilio';
const description = 'Send and receive SMS and WhatsApp messages';
const envVars = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'];

function status() {
  const m = missing(envVars);
  return {
    ok: m.length === 0,
    missing: m,
    auth: 'api-key',
    connected: m.length === 0,
  };
}

function guard() {
  const m = missing(envVars);
  if (m.length) throw new NotConfigured('Twilio', m);
}

const E164 = /^\+[1-9]\d{7,14}$/;
function assertE164(to) {
  if (!E164.test(to)) {
    throw Object.assign(new Error(`"to" must be E.164 (e.g. +15551234567), got "${to}"`), { code: 'BAD_NUMBER' });
  }
}

// Minimal Twilio REST client: POST /2010-04-01/Accounts/{sid}/Messages.json
// with HTTP Basic auth (sid:token) and a form-encoded body.
async function twilioPost(path, params) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.twilio.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(`Twilio API ${res.status}: ${data.message || 'request failed'}`),
      { code: 'TWILIO_API_ERROR', status: res.status, twilioCode: data.code }
    );
  }
  return data;
}

async function twilioGet(path) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const res = await fetch(`https://api.twilio.com${path}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(`Twilio API ${res.status}: ${data.message || 'request failed'}`),
      { code: 'TWILIO_API_ERROR', status: res.status }
    );
  }
  return data;
}

async function sendMessage({ to, body, channel }) {
  guard();
  assertE164(to);
  if (!body || !String(body).trim()) throw Object.assign(new Error('message body is required'), { code: 'EMPTY_BODY' });
  const from = process.env.TWILIO_PHONE_NUMBER;
  const msg = await twilioPost(`/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    To: channel === 'whatsapp' ? `whatsapp:${to}` : to,
    From: channel === 'whatsapp' ? `whatsapp:${from}` : from,
    Body: String(body).slice(0, 1600),
  });
  return { sid: msg.sid, to: msg.to, status: msg.status, channel: channel || 'sms' };
}

// Tools exposed to the agent loop. Sends are risk 'medium' — the approval
// gate in server.js/lib/approvals.js holds them for a tap/phone confirm.
// sms_history is read-only ('low') and runs immediately.
const tools = [
  {
    name: 'sms_send', risk: 'medium', fn: ({ to, body }) => sendMessage({ to, body, channel: 'sms' }),
    schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient phone in E.164 format, e.g. +15551234567' },
        body: { type: 'string', description: 'Message text (max 1600 chars)' },
      },
      required: ['to', 'body'],
    },
    describe: 'Send an SMS text message (always needs approval)',
  },
  {
    name: 'whatsapp_send', risk: 'medium', fn: ({ to, body }) => sendMessage({ to, body, channel: 'whatsapp' }),
    schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient phone in E.164 format, e.g. +15551234567' },
        body: { type: 'string', description: 'Message text (max 1600 chars)' },
      },
      required: ['to', 'body'],
    },
    describe: 'Send a WhatsApp message (always needs approval; requires a WhatsApp-enabled Twilio number)',
  },
  {
    name: 'sms_history', risk: 'low', fn: async ({ limit = 10 }) => {
      guard();
      const data = await twilioGet(
        `/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json?PageSize=${Math.min(Math.max(limit | 0, 1), 50)}`
      );
      return (data.messages || []).map((m) => ({
        sid: m.sid, from: m.from, to: m.to, body: m.body,
        direction: m.direction, status: m.status, date: m.date_sent,
      }));
    },
    schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many recent messages (max 50)' } },
    },
    describe: 'List recent SMS/WhatsApp messages on the Twilio number',
  },
];

// --- Inbound webhook signature validation ---------------------------------
// Twilio signs each webhook: HMAC-SHA1(authToken, fullUrl + sorted(name+value))
// base64-encoded, sent as X-Twilio-Signature. `url` must be the exact public
// URL Twilio called (configure APP_URL accordingly).
function validateSignature(url, params, signature) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  const keys = Object.keys(params || {}).sort();
  const data = keys.reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { id, name, description, envVars, status, tools, validateSignature };
