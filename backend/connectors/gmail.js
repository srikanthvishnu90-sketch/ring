// Gmail connector — read + send via the Gmail API (OAuth 2.0).
// Needs: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (+ per-user tokens stored
// server-side after the /auth/google/callback OAuth flow — never in the repo).
const { missing, NotConfigured } = require('../lib/config');

const requiredEnv = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

function status() {
  const m = missing(requiredEnv);
  return { ok: m.length === 0, missing: m, auth: 'oauth2', scopes: ['gmail.readonly', 'gmail.send'] };
}

function guard() {
  const m = missing(requiredEnv);
  if (m.length) throw new NotConfigured('Gmail', m);
}

// TODO: complete with the stored per-user refresh token:
//   GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=<query>
async function searchMessages({ userId, query, maxResults = 5 }) {
  guard();
  throw new Error('TODO: wire stored OAuth token for user ' + userId);
}

// TODO: POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send
// Body is a base64url RFC 2822 message. Always behind an approval gate.
async function sendMessage({ userId, to, subject, body }) {
  guard();
  throw new Error('TODO: wire stored OAuth token for user ' + userId);
}

module.exports = { requiredEnv, status, searchMessages, sendMessage };
