// Stripe connector — money in, never money out on autopilot.
// Needs: STRIPE_SECRET_KEY. **Use a restricted key**, not the secret key:
// Stripe Dashboard → Developers → API keys → Restricted keys, scoped to
// exactly: Payment Links (write), Invoices (write), Customers (write),
// Balance (read). A restricted key cannot refund, transfer, or touch payouts,
// so a leaked key can't drain the account.
//
// Rules (non-negotiable):
// - Amounts are integer cents, always. $12.50 → 1250.
// - We NEVER accept raw card numbers, tokens, or bank details — there is no
//   card input anywhere in this module; refuse loudly if one shows up.
// - We never charge a card directly. Payment Links and finalized draft
//   invoices let Stripe email/collect from the customer — the money move is
//   always one human click away from the customer, and one approval from ours.
// - stripe_payment_link and stripe_invoice are risk 'high' → in-app approval
//   card before anything is created. stripe_balance is 'low'.
// - Every money tool logs to ring_tool_runs via audit.js (defensive require).
const { env, missing, NotConfigured } = require('../lib/config');

let logToolRun = null;
try {
  // Defensive: audit.js is optional in some environments (local-only mode).
  ({ logToolRun } = require('../lib/audit'));
} catch (e) { /* no audit log available — money tools still work */ }

const id = 'stripe';
const name = 'Stripe';
const description = 'Create Stripe Payment Links and draft email invoices (never direct card charges); read balance.';
const envVars = ['STRIPE_SECRET_KEY'];
const requiredEnv = envVars; // server.js /api/connectors reads this

function status() {
  const m = missing(requiredEnv);
  return { ok: m.length === 0, missing: m };
}

function guard() {
  const m = missing(requiredEnv);
  if (m.length) throw new NotConfigured('Stripe', m);
}

function formEncode(obj, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) parts.push(formEncode(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

async function stripe(path, method = 'GET', body) {
  guard();
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env('STRIPE_SECRET_KEY')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? formEncode(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Stripe ${path} failed (${r.status}): ${String(data?.error?.message || 'unknown error').slice(0, 200)}`);
  }
  return data;
}

function checkCents(amount_cents) {
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    throw new Error('amount_cents must be a positive integer (e.g. $12.50 → 1250)');
  }
}

const CARD_KEYS = ['card_number', 'cardnumber', 'pan', 'cvc', 'cvv', 'expiry', 'exp_month', 'exp_year', 'card_token', 'payment_method_id', 'source'];
function refuseCardData(args) {
  for (const k of CARD_KEYS) {
    if (args && args[k] !== undefined) {
      throw new Error(`Refused: ${k} looks like card data — this connector never accepts card numbers or payment details`);
    }
  }
}

async function audit(userId, tool, args, result, status) {
  if (!logToolRun) return;
  try { await logToolRun({ userId, tool, args, result, status }); } catch (e) { /* never break the money path */ }
}

// High-risk: creates a hosted payment page. The customer still has to open
// it and pay — we never touch their card.
async function paymentLink({ amount_cents, currency = 'usd', description, userId }) {
  refuseCardData(arguments[0]);
  checkCents(amount_cents);
  if (!description) throw new Error('description is required');
  const pl = await stripe('payment_links', 'POST', {
    line_items: [{ price_data: { currency: currency.toLowerCase(), unit_amount: amount_cents, product_data: { name: description.slice(0, 200) } }, quantity: 1 }],
  });
  const result = { id: pl.id, url: pl.url, amount_cents, currency: currency.toLowerCase(), description };
  await audit(userId || 'local', 'stripe_payment_link', { amount_cents, currency, description }, result, 'executed');
  return result;
}

// Low-risk: read-only balance snapshot.
async function balance({ userId } = {}) {
  const b = await stripe('balance');
  const result = {
    available: (b.available || []).map((x) => ({ amount: x.amount, currency: x.currency })),
    pending: (b.pending || []).map((x) => ({ amount: x.amount, currency: x.currency })),
  };
  await audit(userId || 'local', 'stripe_balance', {}, result, 'executed');
  return result;
}

// High-risk: creates a customer (by email), adds one invoice item, creates a
// send_invoice invoice, and finalizes it — Stripe emails the invoice to the
// customer. No auto-charge: collection_method=send_invoice only.
async function invoice({ customer_email, amount_cents, currency = 'usd', description, days_until_due = 7, userId }) {
  refuseCardData(arguments[0]);
  checkCents(amount_cents);
  if (!customer_email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer_email)) throw new Error('a valid customer_email is required');
  if (!description) throw new Error('description is required');
  const customer = await stripe('customers', 'POST', { email: customer_email });
  await stripe('invoiceitems', 'POST', {
    customer: customer.id,
    amount: amount_cents,
    currency: currency.toLowerCase(),
    description: description.slice(0, 200),
  });
  const inv = await stripe('invoices', 'POST', {
    customer: customer.id,
    collection_method: 'send_invoice',
    days_until_due,
  });
  const fin = await stripe(`invoices/${inv.id}/finalize`, 'POST');
  const result = {
    id: fin.id,
    customer_id: customer.id,
    customer_email,
    amount_cents,
    currency: currency.toLowerCase(),
    description,
    status: fin.status,
    hosted_url: fin.hosted_invoice_url,
    pdf_url: fin.invoice_pdf,
  };
  await audit(userId || 'local', 'stripe_invoice', { customer_email, amount_cents, currency, description }, result, 'executed');
  return result;
}

const tools = [
  {
    name: 'stripe_payment_link', risk: 'high', fn: paymentLink,
    schema: { type: 'object', properties: { amount_cents: { type: 'number' }, currency: { type: 'string' }, description: { type: 'string' } }, required: ['amount_cents', 'description'] },
    describe: 'Create a Stripe Payment Link for a one-off payment (needs approval; customer pays on Stripe\'s hosted page)',
  },
  {
    name: 'stripe_balance', risk: 'low', fn: balance,
    schema: { type: 'object', properties: {} },
    describe: 'Read the Stripe account balance (available + pending)',
  },
  {
    name: 'stripe_invoice', risk: 'high', fn: invoice,
    schema: { type: 'object', properties: { customer_email: { type: 'string' }, amount_cents: { type: 'number' }, currency: { type: 'string' }, description: { type: 'string' }, days_until_due: { type: 'number' } }, required: ['customer_email', 'amount_cents', 'description'] },
    describe: 'Create and finalize a Stripe invoice emailed to the customer (needs approval; never auto-charges)',
  },
];

module.exports = { id, name, description, envVars, requiredEnv, status, paymentLink, balance, invoice, tools };
