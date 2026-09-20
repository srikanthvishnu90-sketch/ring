// Gmail connector — read + send via the Gmail API (OAuth 2.0).
// Needs: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (+ per-user tokens from
// /auth/google, kept server-side in lib/google.js — never in the repo).
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
    scopes: ['gmail.readonly', 'gmail.send'],
  };
}

function guard() {
  const m = missing(requiredEnv);
  if (m.length) throw new NotConfigured('Gmail', m);
}

const header = (m, name) =>
  (m.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

async function searchMessages({ userId, query, maxResults = 5 }) {
  guard();
  const list = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`
  );
  const full = await Promise.all(
    (list.messages || []).map((m) =>
      gfetch(
        userId,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
      )
    )
  );
  return full.map((m) => ({
    id: m.id,
    subject: header(m, 'Subject'),
    from: header(m, 'From'),
    date: header(m, 'Date'),
    snippet: m.snippet,
  }));
}

async function sendMessage({ userId, to, subject, body }) {
  guard();
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
    'utf8'
  ).toString('base64url');
  const sent = await gfetch(userId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw }),
  });
  return { id: sent.id, to, subject };
}

module.exports = { requiredEnv, status, searchMessages, sendMessage };
