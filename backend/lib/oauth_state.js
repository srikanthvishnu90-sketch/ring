// OAuth state: signed, expiring, and bound to the authenticated user.
//
// Flow:
//   1. POST /api/oauth/google/start (requireUser) → issueState(userId)
//      returns the Google auth URL; sets an HttpOnly SameSite=Lax cookie
//      holding the state's nonce (CSRF binding: the callback must present
//      the same nonce via the cookie).
//   2. GET /auth/google/callback?code=…&state=… → verifyState(state) checks
//      the HMAC signature, the 10-minute expiry, and the cookie nonce;
//      tokens are saved ONLY under the userId sealed inside the state.
//
// The old plaintext `state=<userId|local>` is gone: without a signature the
// callback refuses, and there is no anonymous 'local' binding anymore.
const crypto = require('crypto');
const { env } = require('./config');

const STATE_TTL_MS = 10 * 60 * 1000;
const COOKIE_NAME = 'ring_oauth_state';

function secret() {
  const s = env('OAUTH_STATE_SECRET', '');
  if (!s) {
    throw Object.assign(
      new Error('OAuth is not configured — set OAUTH_STATE_SECRET'),
      { code: 'NOT_CONFIGURED' }
    );
  }
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b + '='.repeat((4 - (b.length % 4)) % 4), 'base64');
}

// Issue a signed state token for an authenticated user. Returns
// { state, nonce } — the caller stores the nonce in the CSRF cookie.
function issueState(userId) {
  if (!userId || userId === 'local' || userId === 'demo') {
    throw Object.assign(new Error('OAuth requires a signed-in user'), { code: 'UNAUTHENTICATED' });
  }
  const payload = {
    v: 1,
    userId,
    nonce: crypto.randomBytes(16).toString('hex'),
    iat: Date.now(),
    exp: Date.now() + STATE_TTL_MS,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  return { state: `${body}.${sig}`, nonce: payload.nonce };
}

// Verify a state token and the CSRF cookie nonce. Returns { userId }.
// Throws { code } on any failure: BAD_STATE, EXPIRED, CSRF_MISMATCH.
function verifyState(state, cookieNonce) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  if (!state || typeof state !== 'string') fail('BAD_STATE', 'missing state');
  const [body, sig] = String(state).split('.');
  if (!body || !sig) fail('BAD_STATE', 'malformed state');
  const expected = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail('BAD_STATE', 'bad state signature');
  let payload;
  try { payload = JSON.parse(unb64url(body).toString('utf8')); } catch { fail('BAD_STATE', 'bad state payload'); }
  if (!payload || payload.v !== 1 || !payload.userId || !payload.nonce) fail('BAD_STATE', 'bad state payload');
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) fail('EXPIRED', 'OAuth state expired — start again');
  if (!cookieNonce || cookieNonce !== payload.nonce) fail('CSRF_MISMATCH', 'session mismatch — start the connect flow again');
  return { userId: payload.userId };
}

module.exports = { issueState, verifyState, COOKIE_NAME, STATE_TTL_MS };
