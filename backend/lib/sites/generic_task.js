// backend/lib/sites/generic_task.js — Generic task executor for outcomes2 kinds.
//
// Each kind gets a FLOW: a start URL builder plus safety metadata. The runner
// is two-phase, mirroring the myclaw cancel flow:
//   Phase 1 (no approval flag): navigate to the task start page, log in with
//     vault credentials when provided, capture the page state, and return
//     need_approval with an exact summary. NOTHING is confirmed in phase 1.
//   Phase 2 (approval flag set via the auto-continue): re-verify the page
//     still matches the expected action, click ONE strictly-matched confirm
//     button, extract the confirmation artifact, and return done + proof.
// A done without a confirmation artifact is rejected by the driver (no_proof).
//
// v1 scope: real navigation + real login + real page-state capture. The final
// confirming click uses strict visible-text matching and aborts honestly when
// the page does not match expectations.

const vault = require('../vault');

const CONFIRM_RES = [
  /confirmation\s*(?:number|#|code|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,24})/i,
  /order\s*(?:number|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,24})/i,
  /booking\s*(?:reference|ref|#|number)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,24})/i,
  /reference\s*(?:number|#|code)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,24})/i,
  /\bPNR\b\s*[:#]?\s*([A-Z0-9]{6})/i,
  /reservation\s*(?:number|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,24})/i,
];

function extractProof(text) {
  if (!text) return null;
  for (const re of CONFIRM_RES) {
    const m = text.match(re);
    if (m && m[1] && !/^(the|and|for|with)$/i.test(m[1])) return m[1];
  }
  return null;
}

function extractTotal(text) {
  if (!text) return null;
  const m = text.match(/total\s*(?:due)?\s*[:#]?\s*(\$[\d,]+(?:\.\d{2})?)/i) || text.match(/(\$[\d,]+\.\d{2})/);
  return m ? m[1] : null;
}

function isApproved(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.approved === true) return true;
  return Object.keys(job).some((k) => k.endsWith('_approved') && job[k] === true);
}

function redactJob(job) {
  const { otp_code, password, ...rest } = job || {};
  return rest;
}

// ---- Login ----------------------------------------------------------------

const EMAIL_SELS = ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[placeholder*="email" i]'];
const PASS_SELS = ['input[type="password"]', 'input[name*="password" i]'];

async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.fill(value);
        return true;
      }
    } catch (e) { /* try next */ }
  }
  return false;
}

// Email-first login inside the vault callback — credential values never leave.
async function vaultLogin(ctx, page, job) {
  if (!job.vaultId || !ctx.vault.has(job.vaultId)) return { attempted: false };
  try {
    return await ctx.vault.withCredentials(job.vaultId, async (creds) => {
      const email = creds.email || creds.username;
      if (!email) return { attempted: true, ok: false, note: 'vault entry has no email/username' };
      const emailOk = await fillFirst(page, EMAIL_SELS, email);
      if (!emailOk) return { attempted: true, ok: false, note: 'no email field found' };
      // Submit the email step (continue/next/sign-in button).
      const btn = await page.$('button:has-text("Continue"), button:has-text("Next"), input[type="submit"], button[type="submit"]');
      if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(2500); }
      if (creds.password) {
        const passOk = await fillFirst(page, PASS_SELS, creds.password);
        if (passOk) {
          const btn2 = await page.$('button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in")');
          if (btn2) { await btn2.click().catch(() => {}); await page.waitForTimeout(3000); }
          return { attempted: true, ok: true, method: 'password' };
        }
        return { attempted: true, ok: false, note: 'password field not found after email step' };
      }
      return { attempted: true, ok: false, code: 'need_input', note: 'email submitted; check for a magic link or code' };
    });
  } catch (e) {
    return { attempted: true, ok: false, note: `vault error: ${String(e.message).slice(0, 120)}` };
  }
}

// ---- Strict confirm click ---------------------------------------------------

const CONFIRM_BTN_RES = [
  /^(book now|book flight|book hotel|complete booking)$/i,
  /^(place order|place your order|submit order)$/i,
  /^(pay now|pay \$|complete payment|submit payment)$/i,
  /^(confirm|confirm booking|confirm order|confirm purchase)$/i,
  /^(reserve now|reserve parking)$/i,
  /^(join waitlist|join the waitlist)$/i,
  /^(create alert|set alert)$/i,
  /^(donate|complete donation)$/i,
  /^(send gift|send)$/i,
  /^(request export|download my data|request my data)$/i,
  /^(register|register product|submit registration)$/i,
  /^(start return|submit return)$/i,
  /^(pause subscription|confirm pause)$/i,
  /^(unsubscribe|confirm unsubscribe)$/i,
];

async function strictConfirmClick(page, ctx) {
  const buttons = await page.$$('button, input[type="submit"], a[role="button"], [role="button"]');
  for (const b of buttons) {
    let label = '';
    try { label = ((await b.innerText()) || (await b.getAttribute('value')) || '').trim(); } catch (e) { continue; }
    if (CONFIRM_BTN_RES.some((re) => re.test(label))) {
      try {
        const visible = await b.isVisible();
        if (!visible) continue;
        ctx.log('generic_confirm_click', { label: label.slice(0, 60) });
        await b.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(4000);
        return { clicked: true, label };
      } catch (e) { /* keep looking */ }
    }
  }
  return { clicked: false };
}

// ---- Flows ------------------------------------------------------------------

const enc = encodeURIComponent;
const FLOWS = {
  'book-flight': {
    label: 'flight booking',
    start: (j) => `https://www.google.com/flights?hl=en#flt=${enc(j.from || '')}.${enc(j.to || '')}.${enc(j.date || '')}`,
    expectRe: /flight|book/i,
  },
  'book-hotel': {
    label: 'hotel booking',
    start: (j) => `https://www.google.com/travel/hotels?q=${enc(`hotels ${j.city || ''} ${j.checkIn || ''} ${j.checkOut || ''}`)}`,
    expectRe: /hotel/i,
  },
  'order-food': {
    label: 'food order',
    start: (j) => `https://www.doordash.com/food/search/store/${enc(j.restaurant || 'food')}/`,
    expectRe: /doordash|restaurant|menu/i,
  },
  'order-groceries': {
    label: 'grocery order',
    start: (j) => `https://www.instacart.com/store/s?k=${enc(j.store || 'groceries')}`,
    expectRe: /instacart|grocery|cart/i,
  },
  'join-waitlist': {
    label: 'waitlist signup',
    start: (j) => `https://www.google.com/search?q=${enc(`${j.restaurant || ''} ${j.city || ''} waitlist resy opentable`)}`,
    expectRe: /waitlist|restaurant/i,
  },
  'order-product': {
    label: 'product order',
    start: (j) => `https://www.google.com/search?q=${enc(`${j.product || ''} buy ${j.merchant || ''}`)}`,
    expectRe: /buy|order|cart|checkout/i,
  },
  'create-price-alert': {
    label: 'price alert',
    start: (j) => `https://camelcamelcamel.com/search?sq=${enc(j.product || '')}`,
    expectRe: /camelcamelcamel|price|alert/i,
  },
  'start-return': {
    label: 'return',
    start: (j) => `https://www.google.com/search?q=${enc(`${j.merchant || ''} return order ${j.orderRef || ''}`)}`,
    expectRe: /return/i,
  },
  'pay-bill': {
    label: 'bill payment',
    start: (j) => `https://www.google.com/search?q=${enc(`${j.biller || ''} pay bill online`)}`,
    expectRe: /pay|bill/i,
  },
  'pause-subscription': {
    label: 'subscription pause',
    start: (j) => `https://www.google.com/search?q=${enc(`${j.merchant || ''} pause subscription`)}`,
    expectRe: /pause|subscription/i,
  },
  'make-donation': {
    label: 'donation',
    start: (j) => `https://www.google.com/search?q=${enc(`${j.charity || ''} donate`)}`,
    expectRe: /donat/i,
  },
  'order-gift': {
    label: 'gift order',
    start: (j) => `https://www.google.com/search?q=${enc(`${j.gift || 'gift'} delivery buy`)}`,
    expectRe: /gift|flower|checkout/i,
  },
  'book-appointment': {
    label: 'appointment booking',
    start: (j) => `https://www.google.com/search?q=${enc(`${j.service || ''} ${j.business || ''} book appointment`)}`,
    expectRe: /book|appointment/i,
  },
  'book-service': {
    label: 'home service booking',
    start: (j) => `https://www.taskrabbit.com/search?q=${enc(j.serviceType || 'handyman')}`,
    expectRe: /taskrabbit|service|book/i,
  },
  'reserve-parking': {
    label: 'parking reservation',
    start: (j) => `https://spothero.com/search?kind=city&search=${enc(j.location || '')}`,
    expectRe: /spothero|park/i,
  },
  'book-tickets': {
    label: 'ticket purchase',
    start: (j) => `https://www.ticketmaster.com/search?q=${enc(j.event || '')}`,
    expectRe: /ticketmaster|ticket|event/i,
  },
  'book-car-rental': {
    label: 'car rental booking',
    start: (j) => `https://www.kayak.com/cars/${enc(j.pickupLocation || '')}/${enc(j.pickupDate || '')}/${enc(j.dropoffDate || '')}`,
    expectRe: /kayak|car|rental/i,
  },
  'unsubscribe': {
    label: 'email unsubscribe',
    start: (j) => `https://www.google.com/search?q=${enc(`${j.sender || ''} unsubscribe`)}`,
    expectRe: /unsubscri/i,
  },
  'request-data-export': {
    label: 'data export request',
    start: (j) => `https://www.google.com/search?q=${enc(`${j.service || ''} download my data export`)}`,
    expectRe: /data|export|privacy/i,
  },
  'register-warranty': {
    label: 'warranty registration',
    start: (j) => `https://www.google.com/search?q=${enc(`${j.brand || ''} product registration warranty`)}`,
    expectRe: /regist|warranty/i,
  },
};

async function runFlow(ctx, job, flow, kind) {
  const page = ctx.page;
  ctx.log('generic_task_start', { kind, ...redactJob(job) });

  if (!isApproved(job)) {
    // ---- Phase 1: navigate, log in, capture state. Nothing confirmed. ----
    const url = flow.start(job);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    ctx.log('generic_task_page', { url: page.url(), title: (await page.title().catch(() => '')).slice(0, 120) });

    const login = await vaultLogin(ctx, page, job);
    ctx.log('generic_task_login', { attempted: login.attempted, ok: login.ok, note: login.note });

    await ctx.screenshot('phase1').catch(() => {});
    const text = (await page.innerText('body').catch(() => '')).slice(0, 2000);
    const total = extractTotal(text);
    const summary = {
      action: flow.label,
      page: page.url(),
      title: (await page.title().catch(() => '')).slice(0, 120),
      ...(total ? { total } : {}),
      loggedIn: login.ok === true,
      note: 'Phase 1 complete: on the task start page. Approve to attempt the confirming step.',
    };
    return { ok: true, phase: 'need_approval', summary };
  }

  // ---- Phase 2: approved — re-verify context, strict confirm click, proof. ----
  const text = (await page.innerText('body').catch(() => '')).slice(0, 4000);
  if (!flow.expectRe.test(text)) {
    await ctx.screenshot('phase2-mismatch').catch(() => {});
    return {
      ok: false, code: 'context_mismatch',
      note: `Phase 2 page no longer looks like a ${flow.label} page — refusing to click. Nothing was confirmed.`,
    };
  }
  const click = await strictConfirmClick(page, ctx);
  if (!click.clicked) {
    await ctx.screenshot('phase2-no-confirm').catch(() => {});
    return {
      ok: false, code: 'no_confirm_button',
      note: `Reached the ${flow.label} page but found no clearly-labeled confirm button — refusing to guess. Nothing was confirmed.`,
    };
  }
  await page.waitForTimeout(4000);
  await ctx.screenshot('phase2-after').catch(() => {});
  const afterText = (await page.innerText('body').catch(() => '')).slice(0, 6000);
  const proof = extractProof(afterText);
  if (!proof) {
    return {
      ok: false, code: 'no_proof',
      note: `Clicked "${click.label}" but no confirmation artifact appeared — treated as NOT done.`,
    };
  }
  return { ok: true, phase: 'done', confirmationRef: proof, summary: { action: flow.label, clicked: click.label } };
}

const handlers = {};
for (const [kind, flow] of Object.entries(FLOWS)) {
  handlers[kind] = (ctx, job) => runFlow(ctx, job, flow, kind);
}

module.exports = handlers;
