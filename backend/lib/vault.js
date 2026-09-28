// backend/lib/vault.js — vaulted credentials.
//
// ═══════════════════════════════════════════════════════════════════════════
//  *** READ THIS FIRST: HOW CREDENTIALS WORK HERE ***
//
//  A credential is referenced by VAULT ID only:  { vault: 'resy_login' }
//  The VALUE lives ONLY in a Vercel env var named VAULT_<ID>:
//
//      VAULT_RESY_LOGIN  =  '{"username":"vishnu","password":"..."}'
//      VAULT_CHASE_LOGIN =  '{"username":"...","password":"..."}'
//
//  Format: a JSON object (preferred) or a single raw string. Examples:
//      VAULT_RESY_LOGIN='{"username":"vishnu","password":"s3cret"}'
//      VAULT_API_TOKEN='"tok_abc123"'          (JSON string)
//      VAULT_API_TOKEN='tok_abc123'             (raw string also accepted)
//
//  *** VALUES ARE SET BY VISHNU IN THE VERCEL DASHBOARD ***
//  (Project settings → Environment Variables, Production + Preview.)
//  NEVER in chat. NEVER in the repo. NEVER in logs. NEVER echoed back.
//
//  Rules this module enforces:
//    1. has() / list() reveal only PRESENCE — never values.
//    2. handle() returns an opaque { vault: id } reference, safe to show the
//       model and safe to put in tool args / approval cards.
//    3. withCredentials() hands the parsed value to a callback INSIDE this
//       module. The value must never escape except through the callback's
//       return value, which MUST be a proof/summary — never the credential.
//       In practice, values are consumed server-side by the browser session
//       driver, which resolves them via this module; tool outputs only ever
//       carry confirmation artifacts (refs, receipts), never secrets.
//    4. This module contains ZERO logging of values. redact() exists for any
//       call site that must log something adjacent to a credential.
//    5. Per-action approval is NOT this module's job — it is enforced by each
//       tool's risk tier in the approvals flow (backend/lib/approvals.js).
//       High-risk tools always produce an approval card before executing.
// ═══════════════════════════════════════════════════════════════════════════

const { NotConfigured } = require('./config');

// id 'resy_login' -> env var 'VAULT_RESY_LOGIN'
function envName(id) {
  return 'VAULT_' + String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function isVaultVar(k) {
  return typeof k === 'string' && k.startsWith('VAULT_') && k.length > 6;
}

function idFromEnvVar(k) {
  return k.slice('VAULT_'.length).toLowerCase();
}

// Presence check only — never touches the value.
function has(id) {
  return Boolean(process.env[envName(id)]);
}

// Ids only — for status screens and "what's missing" messages.
function list() {
  return Object.keys(process.env)
    .filter(isVaultVar)
    .map((k) => ({ id: idFromEnvVar(k), envVar: k, present: true }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Opaque handle: safe to embed in tool args, approval cards, model output.
function handle(id) {
  assertPresent(id);
  return { vault: id };
}

function assertPresent(id) {
  if (!has(id)) {
    throw new NotConfigured(`Vault credential "${id}"`, [envName(id)]);
  }
}

// Setup instructions for the human (Vishnu) — names the env var, never a value.
function describeSetup(id) {
  return (
    `To store credentials for "${id}": Vercel dashboard → project Settings → ` +
    `Environment Variables → add ${envName(id)} (Production + Preview) with a ` +
    `JSON value like '{"username":"...","password":"..."}', then redeploy. ` +
    `Values are set by Vishnu in Vercel env — never in chat.`
  );
}

function parseValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('vault value is empty');
  try {
    return JSON.parse(s);
  } catch {
    return s; // raw single-string secret
  }
}

// Runs fn(parsedValue) and returns fn's result. The parsed value never leaves
// this call except through what fn returns — fn MUST return proofs/summaries,
// never the credential itself.
async function withCredentials(id, fn) {
  assertPresent(id);
  let parsed;
  try {
    parsed = parseValue(process.env[envName(id)]);
  } catch (e) {
    throw Object.assign(
      new Error(`vault credential "${id}" is set but not parseable: ${e.message}`),
      { code: 'VAULT_PARSE_ERROR' }
    );
  }
  return fn(parsed);
}

// Field names that must never be autofilled or logged without explicit
// per-field approval (used by web_form_fill and logging call sites).
const SENSITIVE_FIELD_RE =
  /passw(or)?d|passwd|secret|token|api[-_ ]?key|auth|ssn|social[-_ ]?security|dob|date[-_ ]?of[-_ ]?birth|birth(date)?|passport|driver'?s?[-_ ]?licen[sc]e|id[-_ ]?number|national[-_ ]?id|bank[-_ ]?account|account[-_ ]?number|routing|card[-_ ]?number|credit[-_ ]?card|cc[-_ ]?(num|number)|cvv|cvc|pin|otp|2fa|recovery[-_ ]?code/i;

function isSensitiveField(name) {
  return SENSITIVE_FIELD_RE.test(String(name || ''));
}

// Deep-clone replacing values under secret-shaped keys with '[redacted]'.
// Plain values pass through untouched — redaction is key-driven, so call it
// on the container object (args, job, log line), never on a bare secret.
function redact(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = isSensitiveField(k) || /credential|vault/i.test(k) ? '[redacted]' : redact(value[k]);
  }
  return out;
}

module.exports = {
  envName,
  has,
  list,
  handle,
  assertPresent,
  describeSetup,
  withCredentials,
  isSensitiveField,
  redact,
  SENSITIVE_FIELD_RE,
};
