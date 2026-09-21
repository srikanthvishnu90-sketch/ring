// Auth: Supabase GoTrue (magic link), passwordless by design.
//
// Flow: client collects an email → POST /api/auth/otp → GoTrue emails a
// magic link → user taps it → GoTrue returns a JWT → client sends it as
// `Authorization: Bearer <jwt>` on API calls. requireUser validates the
// JWT against GoTrue and stamps req.userId with the Supabase user id, so
// durable rows (approvals, threads, messages, memories, tool runs) become
// per-user instead of the shared 'local' identity.
const { env } = require('./config');

const sbUrl = () => env('SUPABASE_URL');
const sbAnon = () => env('SUPABASE_ANON_KEY');
const appUrl = () => env('APP_URL', 'https://ringsss.vercel.app');

function authError(message, code, extra) {
  return Object.assign(new Error(message), { code, ...(extra || {}) });
}

function ensureConfigured() {
  if (!sbUrl() || !sbAnon()) {
    throw authError('auth is not configured — set SUPABASE_URL and SUPABASE_ANON_KEY', 'NOT_CONFIGURED');
  }
}

// Send a magic-link OTP to an email address. GoTrue rate-limits this
// server-side; no client-side throttle needed.
async function sendMagicLink(email) {
  ensureConfigured();
  if (!email || typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    throw authError('a valid email is required', 'BAD_EMAIL');
  }
  const r = await fetch(`${sbUrl()}/auth/v1/otp`, {
    method: 'POST',
    headers: { apikey: sbAnon(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: email.trim().toLowerCase(),
      options: { email_redirect_to: appUrl() },
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw authError(`magic link failed: ${text.slice(0, 200)}`, 'OTP_FAILED', { status: r.status });
  }
  return { ok: true };
}

// Validate a JWT against GoTrue. Returns { id, email } on success.
// Throws { code: 'UNAUTHORIZED' } for bad/expired tokens.
async function validateToken(jwt) {
  ensureConfigured();
  const r = await fetch(`${sbUrl()}/auth/v1/user`, {
    headers: { apikey: sbAnon(), Authorization: `Bearer ${jwt}` },
  });
  if (r.status === 401 || r.status === 400 || r.status === 403) {
    throw authError('invalid or expired token', 'UNAUTHORIZED', { status: r.status });
  }
  if (!r.ok) {
    const text = await r.text();
    throw authError(`auth validation failed: ${text.slice(0, 200)}`, 'AUTH_ERROR', { status: r.status });
  }
  const u = await r.json();
  return { id: u.id, email: u.email };
}

function bearerToken(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+?)\s*$/.exec(h);
  return m ? m[1] : null;
}

// Express middleware: require a valid JWT. Sets req.userId (Supabase user
// id) and req.userEmail; 401s otherwise.
async function requireUser(req, res, next) {
  const jwt = bearerToken(req);
  if (!jwt) {
    res.status(401).json({ error: 'missing authorization token', code: 'UNAUTHORIZED' });
    return;
  }
  try {
    const u = await validateToken(jwt);
    req.userId = u.id;
    req.userEmail = u.email;
    next();
  } catch (e) {
    res.status(401).json({ error: e.message || 'invalid token', code: e.code || 'UNAUTHORIZED' });
  }
}

// Express middleware: same as requireUser, but a missing or invalid token
// falls back to req.userId = 'local' instead of 401ing. Back-compat for
// unauthenticated dev use; production routes should use requireUser.
async function optionalUser(req, res, next) {
  const jwt = bearerToken(req);
  if (!jwt) {
    req.userId = 'local';
    next();
    return;
  }
  try {
    const u = await validateToken(jwt);
    req.userId = u.id;
    req.userEmail = u.email;
  } catch (e) {
    req.userId = 'local';
  }
  next();
}

module.exports = { sendMagicLink, validateToken, bearerToken, requireUser, optionalUser };
