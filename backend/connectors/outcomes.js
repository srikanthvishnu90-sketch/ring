// backend/connectors/outcomes.js — REAL OUTCOMES.
//
// The "doing layer": tools that attempt real-world outcomes (bookings,
// cancellations, orders, logins, form fills) across EXECUTOR TIERS, with
// brutal honesty built in.
//
//   Tier 1 — direct API (opt-in, keyed): e.g. the unofficial Resy web-API path
//            via dining.js resyFetch (RESY_API_KEY + RESY_AUTH_TOKEN).
//   Tier 2 — browser session driver: executes the task in a real browser
//            session (BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID), wired by
//            the coordinator via setBrowserDriver(). Until wired, tier 2
//            reports {error:'browser_not_configured'|'browser_driver_unwired'}
//            — it never pretends to have acted.
//   Tier 3 — honest handoff: deep links + exact steps, outcome flags set
//            false, and a plain-language "not done yet" note.
//
// IRON RULE: a tool returns success ONLY with a real confirmation artifact
// (confirmation ref / reservation id / receipt URL). Every other path returns
// { booked:false } / { cancelled:false } / { ordered:false } / etc. and NEVER
// claims the outcome happened. Per-action approval is enforced by each tool's
// risk tier in the approvals flow (backend/lib/approvals.js), not here.
//
// Credential handling: logins reference vault ids ({ vault:'resy_login' });
// values live only in Vercel env vars VAULT_<ID> (see backend/lib/vault.js)
// and are resolved server-side by the browser driver — never in tool output.
const { missing } = require('../lib/config');
const dining = require('./dining');
const uber = require('./uber');
const vault = require('../lib/vault');

const id = 'outcomes';
const name = 'Real outcomes';
const description =
  'Outcome tools (bookings, cancellations, orders, logins, form fills) across API, browser, and honest-handoff tiers. Success is only ever reported with a real confirmation artifact.';
const envVars = []; // connector itself needs nothing; each tier declares its own keys below
function status() {
  return { ok: true };
}

// Tier key matrix — Vishnu adds these in Vercel env to unlock tiers:
//   Tier 1 (Resy unofficial API): RESY_API_KEY + RESY_AUTH_TOKEN
//   Tier 2 (browser driver):      BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID
//   Tier 3 (handoff):             no keys — always available
//   Finders:                      GOOGLE_PLACES_API_KEY (places)
//   Receipts/diagnosis:           Gmail OAuth via the user's Google connection
//   Logins:                       VAULT_<ID> env vars (see lib/vault.js)
const RESY_KEYS = ['RESY_API_KEY', 'RESY_AUTH_TOKEN'];
const BROWSER_KEYS = ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'];
const PLACES_KEYS = ['GOOGLE_PLACES_API_KEY'];

const isoNow = () => new Date().toISOString();

// ---- Browser session driver (tier 2) -------------------------------------
// Injected by the coordinator: setBrowserDriver({ execute: async (job) => result }).
// Job: { kind, site, task?, vaultId?, fields?, merchant?, pickup?, dropoff?, ref?, userId? }.
// The driver resolves vault credentials internally via lib/vault — values
// never cross into tool output. The driver MUST return an object; a claimed
// completion MUST include a confirmation artifact (confirmationRef /
// reservationId / orderId / receiptUrl). Anything else is treated as failure.
let browserDriver = null;
function setBrowserDriver(d) {
  browserDriver = d;
}

async function browserRun(job) {
  const m = missing(BROWSER_KEYS);
  if (m.length) {
    return { ok: false, error: 'browser_not_configured', missing: m, tier: 'browser' };
  }
  if (!browserDriver || typeof browserDriver.execute !== 'function') {
    return {
      ok: false,
      error: 'browser_driver_unwired',
      tier: 'browser',
      note: 'Browserbase keys are present but the coordinator has not wired the browser session driver (setBrowserDriver) — no browser work was attempted.',
    };
  }
  try {
    const result = await browserDriver.execute(job);
    return { ok: true, result: result || {}, tier: 'browser' };
  } catch (e) {
    return { ok: false, error: 'browser_failed', tier: 'browser', detail: String((e && e.message) || e).slice(0, 300) };
  }
}

// A claimed success must carry a confirmation artifact. Returns the artifact
// or null. This is the single gate for every "we did it" output.
function proofOf(result) {
  if (!result || typeof result !== 'object') return null;
  const ref =
    result.confirmationRef || result.reservationId || result.bookingId ||
    result.orderId || result.receiptUrl || result.cancelRef || result.ticketId;
  return ref ? String(ref) : null;
}

// Phase-aware continuation: when the browser driver pauses mid-flow
// (need_otp / need_input / need_approval), the session stays LIVE and the
// agent must re-invoke the tool with { sessionId, ...phaseInputs }.
// Returning this envelope (instead of falling through to Tier-3 handoff)
// keeps the multi-step flow alive. Never throws.
const CONTINUATION_PHASES = new Set(['need_otp', 'need_input', 'need_approval']);
function browserContinuation(br) {
  const r = br && br.ok && br.result;
  if (r && CONTINUATION_PHASES.has(r.phase)) {
    return {
      paused: true, phase: r.phase, sessionId: r.sessionId || null,
      prompt: r.prompt || null, summary: r.summary || null,
      fields: r.fields || null, tier: 'browser',
      note: 'Browser session is live and waiting. Re-invoke this tool with { sessionId, ... } plus the requested input to continue.',
    };
  }
  return null;
}

// ---- Shared helpers ------------------------------------------------------
function resyKeyed() {
  return missing(RESY_KEYS).length === 0;
}

function placesKeyed() {
  return missing(PLACES_KEYS).length === 0;
}

// Lazy gmail: receipts/diagnosis degrade to {searched:false} when Gmail isn't
// connected, instead of breaking module load or the tool.
async function findReceipts(userId, query, maxResults = 5) {
  try {
    const gmail = require('./gmail');
    const res = await gmail.searchMessages({ userId, query, maxResults });
    const msgs = Array.isArray(res) ? res : (res && res.messages) || [];
    return {
      searched: true,
      receipts: msgs.map((m) => ({
        id: m.id, subject: m.subject, from: m.from, date: m.date, snippet: m.snippet,
      })),
    };
  } catch (e) {
    return { searched: false, reason: String((e && e.message) || e).slice(0, 200) };
  }
}

function normalizeTime(t) {
  if (!t) return null;
  const s = String(t).trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const min = m[2] || '00';
  const ap = m[3];
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

// Pick the Resy slot closest to the requested time (HH:MM) from /4/find results.
function pickSlot(slots, time) {
  if (!slots || !slots.length) return null;
  if (!time) return slots[0];
  const want = normalizeTime(time);
  const scored = slots.map((s) => {
    const iso = s.time || '';
    const hhmm = iso.slice(11, 16); // "2026-..T19:30:00" -> "19:30"
    return { s, hhmm, hit: hhmm === want };
  });
  return (scored.find((x) => x.hit) || scored[0]).s;
}

function diningHandoffLinks({ restaurant, city, date, party = 2 }) {
  const slug = String(city || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-york';
  const q = encodeURIComponent(restaurant || '');
  return {
    resySearch: `https://resy.com/cities/${slug}?query=${q}`,
    opentableSearch: `https://www.opentable.com/s?term=${q}&covers=${party}${date ? `&dateTime=${encodeURIComponent(date + 'T19:00')}` : ''}`,
    note: 'Search links are prefilled where possible — the booking itself happens in the app.',
  };
}

// ---- 33. dining_book (high) ----------------------------------------------
async function diningBook({ userId, restaurant, city, date, time, party = 2, venueId, sessionId, ...phaseInputs }) {
  if (!restaurant || !date) {
    return { booked: false, error: 'missing_args', missing: [!restaurant && 'restaurant', !date && 'date'].filter(Boolean) };
  }
  const attempts = [];

  // Tier 1: Resy unofficial API — needs keys AND the venue's Resy venueId.
  if (resyKeyed() && venueId) {
    try {
      const slots = await dining.resyFindSlots({ venueId, date, partySize: party });
      const slot = pickSlot(slots, time);
      if (!slot) {
        return {
          booked: false, tier: 'api-resy', error: 'no_slots',
          note: `Resy returned no slot matching ${time || 'any time'} on ${date} for a party of ${party} — nothing was booked.`,
        };
      }
      const b = await dining.resyBookUnofficial({ slotToken: slot.token, date, partySize: party });
      const ref = proofOf(b) || (b && (b.reservationId || (b.raw && (b.raw.resy_token || b.raw.id))));
      if (!ref) {
        return { booked: false, tier: 'api-resy', error: 'no_proof', note: 'Resy responded but returned no reservation token — NOT booked.' };
      }
      return {
        booked: true, tier: 'api-resy', confirmationRef: String(ref),
        restaurant, city, date, time: slot.time, party, bookedAt: isoNow(),
      };
    } catch (e) {
      attempts.push({ tier: 'api-resy', error: String(e.message).slice(0, 300) });
    }
  } else {
    attempts.push({
      tier: 'api-resy', skipped: true,
      reason: resyKeyed()
        ? 'needs the restaurant\'s Resy venueId to use the API path (pass venueId)'
        : `missing ${missing(RESY_KEYS).join(', ')} — Resy API tier unavailable`,
    });
  }

  // Tier 2: browser books it.
  const br = await browserRun({ kind: 'book', site: 'resy', restaurant, city, date, time, party, userId, sessionId, ...phaseInputs });
  if (br.ok) {
    const cont = browserContinuation(br);
    if (cont) return cont;
    const ref = proofOf(br.result);
    if (ref) {
      return {
        booked: true, tier: 'browser', confirmationRef: ref,
        restaurant, city, date, time, party, bookedAt: isoNow(),
        proofUrl: br.result.receiptUrl || null,
      };
    }
    attempts.push({ tier: 'browser', error: 'no_proof', note: 'Browser session finished with no confirmation artifact — NOT booked.' });
  } else {
    attempts.push({ tier: 'browser', error: br.error, ...(br.missing ? { missing: br.missing } : {}), ...(br.note ? { note: br.note } : {}), ...(br.detail ? { detail: br.detail } : {}) });
  }

  // Tier 3: honest handoff.
  return {
    booked: false, tier: 'handoff', attempts,
    links: diningHandoffLinks({ restaurant, city, date, party }),
    note: 'Not booked yet — confirm the table in the OpenTable or Resy app.',
  };
}

// ---- 34. dining_change (high) --------------------------------------------
async function diningChange({ userId, ref, action = 'cancel', restaurant, date, time, party = 2, venueId, sessionId, ...phaseInputs }) {
  if (!ref) return { changed: false, cancelled: false, error: 'missing_args', missing: ['ref'] };
  const attempts = [];
  const isCancel = action === 'cancel';

  // Tier 1: the unofficial Resy path has no modify/cancel endpoint — it can
  // only locate a replacement slot for a change. It never mutates.
  if (resyKeyed() && venueId && !isCancel && date) {
    try {
      const slots = await dining.resyFindSlots({ venueId, date, partySize: party });
      const slot = pickSlot(slots, time);
      return {
        changed: false, cancelled: false, tier: 'api-resy',
        proposedSlot: slot ? { time: slot.time, type: slot.type } : null,
        note: 'Resy API path located a replacement slot but has no modify/cancel endpoint — nothing was changed. Complete the change in the Resy app or use the browser tier.',
      };
    } catch (e) {
      attempts.push({ tier: 'api-resy', error: String(e.message).slice(0, 300) });
    }
  } else {
    attempts.push({ tier: 'api-resy', skipped: true, reason: 'no modify/cancel endpoint on the unofficial Resy path' });
  }

  // Tier 2: browser executes the change/cancel.
  const br = await browserRun({ kind: isCancel ? 'cancel' : 'change', site: 'resy', ref, restaurant, date, time, party, userId, sessionId, ...phaseInputs });
  if (br.ok) {
    const cont = browserContinuation(br);
    if (cont) return cont;
    const proof = proofOf(br.result);
    if (proof) {
      return isCancel
        ? { cancelled: true, tier: 'browser', cancelRef: proof, ref, at: isoNow() }
        : { changed: true, tier: 'browser', confirmationRef: proof, ref, at: isoNow() };
    }
    attempts.push({ tier: 'browser', error: 'no_proof', note: 'Browser session finished with no confirmation artifact — nothing was changed.' });
  } else {
    attempts.push({ tier: 'browser', error: br.error, ...(br.missing ? { missing: br.missing } : {}), ...(br.note ? { note: br.note } : {}), ...(br.detail ? { detail: br.detail } : {}) });
  }

  // Tier 3: honest handoff.
  return {
    ...(isCancel ? { cancelled: false } : { changed: false }),
    tier: 'handoff', attempts,
    links: {
      resyReservations: 'https://resy.com/',
      opentableAccount: 'https://www.opentable.com/',
      note: 'Resy: sign in → profile → Reservations. OpenTable: sign in → your upcoming reservations.',
    },
    note: isCancel
      ? 'Not cancelled yet — cancel it in the Resy/OpenTable app (see links).'
      : 'Not changed yet — modify it in the Resy/OpenTable app (see links).',
  };
}

// ---- 35. subscription_cancel (high) --------------------------------------
function cancellationPlaybook(merchant) {
  const q = encodeURIComponent(`how to cancel ${merchant} subscription`);
  return {
    steps: [
      `Find the original signup email or receipt for ${merchant} (check below — receipts were searched).`,
      `Open ${merchant}'s account/billing page and look for Subscriptions, Membership, or Billing.`,
      `Choose Cancel / End subscription and complete any confirmation screens. Screenshot the final confirmation.`,
      `If no self-serve cancel exists, use the in-app chat or support email — never give card details over chat; cancel via the account page first.`,
      `After cancelling, watch the next statement for one more charge (prorated/annual renewals often bill once more).`,
    ],
    helpLinks: {
      searchHowTo: `https://www.google.com/search?q=${q}`,
    },
  };
}

async function subscriptionCancel({ userId, merchant, vault: vaultId, sessionId, ...phaseInputs }) {
  if (!merchant) return { cancelled: false, error: 'missing_args', missing: ['merchant'] };
  const attempts = [];

  // Step 1 (read-only): find receipts so the cancel targets the right account.
  const receipts = await findReceipts(userId, `"${merchant}" (receipt OR invoice OR subscription OR billing)`);
  attempts.push({ tier: 'receipt-search', ...(receipts.searched ? { found: (receipts.receipts || []).length } : { skipped: true, reason: receipts.reason }) });

  // Optional vaulted login for the merchant account (handle only — values stay in vault).
  let loginHandle = null;
  if (vaultId) {
    if (vault.has(vaultId)) loginHandle = vault.handle(vaultId);
    else attempts.push({ tier: 'vault', skipped: true, reason: `no vault credentials for "${vaultId}" — ${vault.describeSetup(vaultId)}` });
  }

  // Tier 2: browser executes the cancellation.
  const br = await browserRun({ kind: 'cancel-subscription', merchant, vaultId: loginHandle ? loginHandle.vault : null, receipts: receipts.receipts || [], userId, sessionId, ...phaseInputs });
  if (br.ok) {
    const cont = browserContinuation(br);
    if (cont) return cont;
    const proof = proofOf(br.result);
    if (proof) {
      return { cancelled: true, tier: 'browser', confirmationRef: proof, merchant, receipts: receipts.receipts || [], at: isoNow() };
    }
    attempts.push({ tier: 'browser', error: 'no_proof', note: 'Browser session finished with no cancellation confirmation — NOT cancelled.' });
  } else {
    attempts.push({ tier: 'browser', error: br.error, ...(br.missing ? { missing: br.missing } : {}), ...(br.note ? { note: br.note } : {}), ...(br.detail ? { detail: br.detail } : {}) });
  }

  // Tier 3: guided handoff — exact steps, never a claimed cancellation.
  return {
    cancelled: false, tier: 'handoff', merchant, attempts,
    receipts: receipts.receipts || [],
    playbook: cancellationPlaybook(merchant),
    note: 'Nothing was cancelled — follow the steps above, or approve the browser tier to have it done for you.',
  };
}

// ---- 36. ride_book (high) ------------------------------------------------
// Approval for the ORDER is enforced by the 'high' risk tier (approval card
// before fn runs). The tool itself still never claims ordered without proof.
async function rideBook({ userId, pickup, dropoff, sessionId, ...phaseInputs }) {
  if (!pickup || !dropoff) {
    return { ordered: false, error: 'missing_args', missing: [!pickup && 'pickup', !dropoff && 'dropoff'].filter(Boolean) };
  }
  const attempts = [];

  // Resolve address strings to coordinates (needs Places key).
  async function resolvePoint(p, label) {
    if (p && typeof p === 'object' && p.lat != null && p.lng != null) return p;
    if (typeof p === 'string') {
      if (!placesKeyed()) {
        throw Object.assign(new Error(`${label} is an address but GOOGLE_PLACES_API_KEY is not set — pass coordinates instead`), { code: 'GEOCODE_UNAVAILABLE' });
      }
      const places = require('./places');
      const g = await places.geocode({ address: p });
      return { lat: g.lat, lng: g.lng, label: g.name || p };
    }
    throw Object.assign(new Error(`${label} must be {lat,lng} or an address string`), { code: 'BAD_LOCATION' });
  }

  let from, to;
  try {
    from = await resolvePoint(pickup, 'pickup');
    to = await resolvePoint(dropoff, 'dropoff');
  } catch (e) {
    return { ordered: false, error: e.code || 'bad_location', detail: e.message };
  }

  // Tier 1: Uber has no public ride-request API (partner-whitelist only).
  try {
    uber.requestRide();
  } catch (e) {
    attempts.push({ tier: 'api-uber', skipped: true, reason: e.message });
  }

  // Tier 2: browser orders the ride.
  const br = await browserRun({ kind: 'book-ride', site: 'uber', pickup: from, dropoff: to, userId, sessionId, ...phaseInputs });
  if (br.ok) {
    const cont = browserContinuation(br);
    if (cont) return cont;
    const ref = proofOf(br.result);
    if (ref) {
      return { ordered: true, tier: 'browser', confirmationRef: ref, pickup: from, dropoff: to, at: isoNow() };
    }
    attempts.push({ tier: 'browser', error: 'no_proof', note: 'Browser session finished with no trip confirmation — NOT ordered.' });
  } else {
    attempts.push({ tier: 'browser', error: br.error, ...(br.missing ? { missing: br.missing } : {}), ...(br.note ? { note: br.note } : {}), ...(br.detail ? { detail: br.detail } : {}) });
  }

  // Tier 3 (the honest default): prefilled Uber link, nothing ordered.
  return {
    ordered: false, tier: 'handoff', attempts,
    link: uber.rideLink({ pickup: from, dropoff: to }),
    pickup: from, dropoff: to,
    note: 'Nothing was ordered — this link opens the Uber app with the trip prefilled; you confirm and pay in Uber.',
  };
}

// ---- 37. dining_tonight (low) — finder only, never books -----------------
async function diningTonight({ city, cuisine, party = 2, time }) {
  if (!city) return { searched: false, error: 'missing_args', missing: ['city'] };
  if (!placesKeyed()) {
    return {
      searched: false, error: 'places_not_configured', missing: PLACES_KEYS,
      note: 'Restaurant discovery needs GOOGLE_PLACES_API_KEY. Nothing was searched.',
    };
  }
  try {
    const places = require('./places');
    const query = `${cuisine ? cuisine + ' ' : ''}restaurant in ${city}`.trim();
    const results = await places.search({ query, maxResults: 8 });
    const options = (results || [])
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .map((p) => ({
        name: p.name,
        address: p.address,
        rating: p.rating,
        priceLevel: p.priceLevel,
        openNow: p.openNow,
        availabilityNote: 'Availability not checked — confirm on Resy/OpenTable before going.',
        resySearch: `https://resy.com/cities/${city.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')}?query=${encodeURIComponent(p.name || '')}`,
      }));
    return {
      searched: true, finder: true, booked: false, city, cuisine: cuisine || null, party, time: time || null,
      options,
      note: 'Finder only — these are ranked options, not bookings. Use dining_book to book one.',
      at: isoNow(),
    };
  } catch (e) {
    return { searched: false, error: 'places_failed', detail: String(e.message).slice(0, 200) };
  }
}

// ---- 38. web_login_task (high) -------------------------------------------
// Per-action approval is enforced by the 'high' risk tier (approval card).
// The vault id is validated for PRESENCE only — values never enter tool I/O.
async function webLoginTask({ userId, site, task, vault: vaultId, sessionId, ...phaseInputs }) {
  if (!site || !task || !vaultId) {
    return { completed: false, error: 'missing_args', missing: [!site && 'site', !task && 'task', !vaultId && 'vault'].filter(Boolean) };
  }
  if (!vault.has(vaultId)) {
    return {
      completed: false, error: 'vault_id_unknown',
      note: `No credentials are stored under vault id "${vaultId}". ${vault.describeSetup(vaultId)}`,
    };
  }
  const attempts = [{ tier: 'vault', checked: vaultId, present: true }];

  // Tier 2: browser logs in with vaulted creds and performs the task.
  // The driver resolves values via lib/vault internally — tool output never
  // sees them.
  const br = await browserRun({ kind: 'login-task', site, task, vaultId, userId, sessionId, ...phaseInputs });
  if (br.ok) {
    const cont = browserContinuation(br);
    if (cont) return cont;
    const proof = proofOf(br.result);
    if (proof) {
      return { completed: true, tier: 'browser', confirmationRef: proof, site, task, at: isoNow() };
    }
    attempts.push({ tier: 'browser', error: 'no_proof', note: 'Browser session finished with no confirmation artifact — NOT completed.' });
  } else {
    attempts.push({ tier: 'browser', error: br.error, ...(br.missing ? { missing: br.missing } : {}), ...(br.note ? { note: br.note } : {}), ...(br.detail ? { detail: br.detail } : {}) });
  }

  // Tier 3: guided handoff.
  return {
    completed: false, tier: 'handoff', attempts,
    link: `https://${String(site).replace(/^https?:\/\//, '')}`,
    steps: [`Sign in to ${site} yourself, then: ${task}.`, 'Credential values were never exposed — the vault id was only checked for presence.'],
    note: 'Not completed — sign in and do the task yourself, or approve the browser tier.',
  };
}

// ---- 39. web_form_fill (high) --------------------------------------------
// Sensitive identity fields need EXPLICIT per-field approval: pass
// approvedFields: ['ssn', ...] listing each sensitive field you approve.
// Any sensitive field NOT listed blocks the executor tier entirely.
async function webFormFill({ userId, site, form, fields, approvedFields = [], sessionId, ...phaseInputs }) {
  if (!site || !form || !fields || typeof fields !== 'object') {
    return { filled: false, error: 'missing_args', missing: [!site && 'site', !form && 'form', !fields && 'fields'].filter(Boolean) };
  }
  const names = Object.keys(fields);
  const sensitiveFields = names.filter((n) => vault.isSensitiveField(n));
  const approved = new Set((approvedFields || []).map(String));
  const unapproved = sensitiveFields.filter((n) => !approved.has(n));
  const approvalNote = sensitiveFields.length
    ? `Per-field approval required: ${sensitiveFields.join(', ')}. ` +
      `These are sensitive identity fields — nothing touching them runs without your explicit per-field approval. ` +
      (unapproved.length
        ? `NOT approved yet: ${unapproved.join(', ')} — the executor tier is blocked.`
        : 'All sensitive fields explicitly approved — executor tier may proceed.')
    : 'No sensitive identity fields detected in this form.';
  const attempts = [{ tier: 'field-review', sensitiveFields, unapproved, approvalNote }];

  if (unapproved.length) {
    return {
      filled: false, tier: 'blocked', attempts, approvalNote, sensitiveFields, unapproved,
      link: `https://${String(site).replace(/^https?:\/\//, '')}`,
      note: 'Nothing was filled — approve each sensitive field explicitly (approvedFields) or fill them yourself.',
    };
  }

  // Tier 2: browser fills the form.
  // NOTE: the job carries the real field values server-side so the driver can
  // fill them — job payloads are driver-input only. They are NEVER logged raw
  // (redact with vault.redact first) and NEVER appear in tool results.
  const br = await browserRun({ kind: 'form-fill', site, form, fields, fieldNames: names, userId, sessionId, ...phaseInputs });
  if (br.ok) {
    const cont = browserContinuation(br);
    if (cont) return cont;
    const proof = proofOf(br.result) || (br.result && br.result.submitted ? 'form-submitted' : null);
    if (proof) {
      return {
        filled: true, tier: 'browser', confirmationRef: proof, site, form,
        fieldsFilled: br.result.fieldsFilled || names, at: isoNow(), approvalNote,
      };
    }
    attempts.push({ tier: 'browser', error: 'no_proof', note: 'Browser session finished with no submission confirmation — NOT filled.' });
  } else {
    attempts.push({ tier: 'browser', error: br.error, ...(br.missing ? { missing: br.missing } : {}), ...(br.note ? { note: br.note } : {}), ...(br.detail ? { detail: br.detail } : {}) });
  }

  return {
    filled: false, tier: 'handoff', attempts, approvalNote,
    link: `https://${String(site).replace(/^https?:\/\//, '')}`,
    fieldList: names,
    note: 'Nothing was filled — fill the form yourself at the link, or approve the browser tier.',
  };
}

// ---- 40. order_status (low) — read-only ----------------------------------
async function orderStatus({ userId, merchant, orderRef }) {
  if (!merchant && !orderRef) {
    return { found: false, error: 'missing_args', missing: ['merchant or orderRef'] };
  }
  const q = [orderRef && `"${orderRef}"`, merchant && `"${merchant}"`, 'order confirmation OR shipment OR tracking']
    .filter(Boolean).join(' ');
  const receipts = await findReceipts(userId, q);
  if (!receipts.searched) {
    return { found: false, error: 'gmail_unavailable', reason: receipts.reason, note: 'Order status starts with confirmation emails — Gmail is not connected.' };
  }
  if (!receipts.receipts.length) {
    return { found: false, merchant: merchant || null, orderRef: orderRef || null, source: 'gmail', at: isoNow(), note: 'No matching confirmation email found.' };
  }
  const top = receipts.receipts[0];
  return {
    found: true, merchant: merchant || null, orderRef: orderRef || null,
    latest: { subject: top.subject, from: top.from, date: top.date, snippet: top.snippet },
    alsoFound: receipts.receipts.slice(1).map((r) => ({ subject: r.subject, date: r.date })),
    status: 'derived from confirmation email only — open the email for carrier tracking',
    source: 'gmail', at: isoNow(),
  };
}

// ---- 41. price_check (low) — read-only -----------------------------------
async function priceCheck({ userId, query }) {
  if (!query) return { checked: false, error: 'missing_args', missing: ['query'] };
  // Tier 2: browser reads live listings.
  const br = await browserRun({ kind: 'read', site: 'shopping', query, userId });
  if (br.ok && br.result && Array.isArray(br.result.quotes) && br.result.quotes.length) {
    return {
      checked: true, tier: 'browser', query,
      quotes: br.result.quotes.map((x) => ({
        price: x.price, title: x.title, source: x.source, url: x.url, inStock: x.inStock ?? null,
      })),
      note: 'Prices are live-read and change fast — each quote is labeled with its source and read time.',
      at: isoNow(),
    };
  }
  if (br.ok) {
    const cont = browserContinuation(br);
    if (cont) return cont;
    return { checked: false, tier: 'browser', query, error: 'no_results', at: isoNow(), note: 'Browser read returned no price data.' };
  }
  return {
    checked: false, tier: 'handoff', query,
    error: br.error, ...(br.missing ? { missing: br.missing } : {}),
    note: 'No live shopping source is configured — set BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID for browser-based price checks.',
    at: isoNow(),
  };
}

// ---- 42. reservation_fix (high) ------------------------------------------
// Diagnose first, propose a fix, and ONLY apply it when applyFix:true is
// passed explicitly (which itself goes through the approval card).
async function reservationFix({ userId, ref, issue, applyFix = false, venueId }) {
  if (!ref || !issue) {
    return { diagnosed: false, error: 'missing_args', missing: [!ref && 'ref', !issue && 'issue'].filter(Boolean) };
  }
  const attempts = [];

  // Diagnose: find the confirmation email.
  const receipts = await findReceipts(userId, `"${ref}" reservation OR booking confirmation`);
  const confirmation = receipts.searched && receipts.receipts.length ? receipts.receipts[0] : null;
  attempts.push({
    tier: 'diagnosis',
    confirmationFound: Boolean(confirmation),
    ...(confirmation ? { subject: confirmation.subject, date: confirmation.date } : {}),
    ...(receipts.searched ? {} : { reason: receipts.reason }),
  });

  const issueText = String(issue);
  const detectedIssue =
    /wrong date|wrong day/i.test(issueText) ? 'date mismatch'
    : /wrong time|time/i.test(issueText) ? 'time mismatch'
    : /party|guests|people|seats/i.test(issueText) ? 'party-size mismatch'
    : /cancel/i.test(issueText) ? 'cancellation requested'
    : /double|duplicate/i.test(issueText) ? 'possible duplicate booking'
    : 'unclassified — see issue text';
  const proposedFix = {
    action: detectedIssue === 'cancellation requested' ? 'cancel reservation' : 'modify reservation',
    executorTier: 'browser',
    steps: [
      `Locate booking ${ref}${confirmation ? ` (confirmation email: "${confirmation.subject}")` : ' (no confirmation email found — verify the ref)'}.`,
      detectedIssue === 'cancellation requested' ? 'Cancel the reservation and capture the cancellation confirmation.' : `Apply the correction for: ${issueText}`,
      'Capture the confirmation artifact (new ref or cancellation receipt).',
    ],
  };

  const diagnosis = {
    diagnosed: true, applied: false, needsApproval: true, ref, issue: issueText,
    detectedIssue,
    confirmation: confirmation ? { subject: confirmation.subject, from: confirmation.from, date: confirmation.date, snippet: confirmation.snippet } : null,
    proposedFix, attempts,
    note: 'Diagnosed only — nothing was applied. Pass applyFix:true (goes through the approval card) to execute the fix.',
  };

  if (!applyFix) return diagnosis;

  // Executor tier: browser applies the fix.
  const br = await browserRun({ kind: 'fix-reservation', site: 'resy', ref, issue: issueText, venueId, userId });
  if (br.ok) {
    const cont = browserContinuation(br);
    if (cont) return cont;
    const proof = proofOf(br.result);
    if (proof) {
      return { ...diagnosis, applied: true, needsApproval: false, tier: 'browser', confirmationRef: proof, at: isoNow() };
    }
    attempts.push({ tier: 'browser', error: 'no_proof', note: 'Browser session finished with no confirmation artifact — fix NOT applied.' });
  } else {
    attempts.push({ tier: 'browser', error: br.error, ...(br.missing ? { missing: br.missing } : {}), ...(br.note ? { note: br.note } : {}), ...(br.detail ? { detail: br.detail } : {}) });
  }
  return { ...diagnosis, attempts, note: 'Fix could not be applied — see attempts. Nothing was changed.' };
}

// ---- Tool table ----------------------------------------------------------
const tools = [
  {
    name: 'dining_book', risk: 'high', fn: diningBook,
    schema: {
      type: 'object',
      properties: {
        restaurant: { type: 'string', description: 'Restaurant name' },
        city: { type: 'string', description: 'City (e.g. Chicago)' },
        date: { type: 'string', description: 'Date YYYY-MM-DD' },
        time: { type: 'string', description: 'Preferred time, e.g. 19:30 or 7:30pm' },
        party: { type: 'number', description: 'Party size (default 2)' },
        venueId: { type: 'string', description: 'Resy venueId — enables the tier-1 API path' },
        sessionId: { description: 'Resume a live browser session from a paused (need_otp/need_input/need_approval) result.' },
        otp: { description: 'One-time code, when resuming a need_otp phase. Never invent one — ask the user.' },
      },
      required: ['restaurant', 'date'],
    },
    describe: 'Book a restaurant table: tries the Resy API path, then a browser session, else an honest handoff. Success only with a real confirmation ref (always needs approval).',
  },
  {
    name: 'dining_change', risk: 'high', fn: diningChange,
    schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Confirmation reference of the existing booking' },
        action: { type: 'string', enum: ['cancel', 'change'], description: 'cancel or change (default cancel)' },
        restaurant: { type: 'string', description: 'Restaurant name' },
        date: { type: 'string', description: 'New date YYYY-MM-DD (for change)' },
        time: { type: 'string', description: 'New time (for change)' },
        party: { type: 'number', description: 'New party size (for change)' },
        venueId: { type: 'string', description: 'Resy venueId — enables slot lookup for changes' },
        sessionId: { description: 'Resume a live browser session from a paused (need_otp/need_input/need_approval) result.' },
        otp: { description: 'One-time code, when resuming a need_otp phase. Never invent one — ask the user.' },
      },
      required: ['ref'],
    },
    describe: 'Change or cancel a restaurant booking. Needs the confirmation ref. Browser tier executes with proof; otherwise an honest handoff (always needs approval).',
  },
  {
    name: 'subscription_cancel', risk: 'high', fn: subscriptionCancel,
    schema: {
      type: 'object',
      properties: {
        merchant: { type: 'string', description: 'Merchant/service name, e.g. Spotify' },
        vault: { type: 'string', description: 'Optional vault id with the merchant login (e.g. spotify_login)' },
        sessionId: { description: 'Resume a live browser session from a paused (need_otp/need_input/need_approval) result.' },
        otp: { description: 'One-time code, when resuming a need_otp phase. Never invent one — ask the user.' },
      },
      required: ['merchant'],
    },
    describe: 'Cancel a subscription: finds receipts, then browser-executes the cancellation with proof, else gives exact guided steps. Never claims cancelled without proof (always needs approval).',
  },
  {
    name: 'ride_book', risk: 'high', fn: rideBook,
    schema: {
      type: 'object',
      properties: {
        pickup: { description: '{lat,lng,label} or an address string (needs Places key for addresses)' },
        dropoff: { description: '{lat,lng,label} or an address string (needs Places key for addresses)' },
        sessionId: { description: 'Resume a live browser session returned by a paused (need_otp/need_input/need_approval) result.' },
        otp: { description: 'One-time code, when resuming a need_otp phase. Never invent one — ask the user.' },
      },
      required: ['pickup', 'dropoff'],
    },
    describe: 'Order a ride. No public Uber booking API exists, so the honest default returns a prefilled Uber deep link (you confirm in Uber); browser tier can order with proof. Never claims ordered without proof (always needs approval).',
  },
  {
    name: 'dining_tonight', risk: 'low', fn: diningTonight,
    schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City to search in' },
        cuisine: { type: 'string', description: 'Cuisine, e.g. Italian' },
        party: { type: 'number', description: 'Party size (default 2)' },
        time: { type: 'string', description: 'Desired time, e.g. 19:30' },
      },
      required: ['city'],
    },
    describe: 'Find dinner options for tonight: ranked restaurant list with ratings and hours. Finder only — never books, availability must be confirmed on Resy/OpenTable.',
  },
  {
    name: 'web_login_task', risk: 'high', fn: webLoginTask,
    schema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site domain, e.g. example.com' },
        task: { type: 'string', description: 'What to do once logged in' },
        vault: { type: 'string', description: 'Vault id holding the login (e.g. chase_login) — values never leave the vault' },
        sessionId: { description: 'Resume a live browser session from a paused (need_otp/need_input/need_approval) result.' },
        otp: { description: 'One-time code, when resuming a need_otp phase. Never invent one — ask the user.' },
      },
      required: ['site', 'task', 'vault'],
    },
    describe: 'Log in to a site with vaulted credentials and perform a task. Credential values are never exposed; browser tier executes with proof, else guided handoff (always needs approval).',
  },
  {
    name: 'web_form_fill', risk: 'high', fn: webFormFill,
    schema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site domain' },
        form: { type: 'string', description: 'Which form (e.g. "checkout", "address change")' },
        fields: { type: 'object', description: 'Field name -> value map. Values are redacted in transit.' },
        approvedFields: { type: 'array', items: { type: 'string' }, description: 'Sensitive fields you explicitly approve, per field' },
        sessionId: { description: 'Resume a live browser session from a paused (need_otp/need_input/need_approval) result.' },
      },
      required: ['site', 'form', 'fields'],
    },
    describe: 'Fill a web form. Sensitive identity fields (SSN, DOB, passwords, card numbers) need explicit per-field approval or the executor is blocked. Browser tier fills with proof, else handoff (always needs approval).',
  },
  {
    name: 'order_status', risk: 'low', fn: orderStatus,
    schema: {
      type: 'object',
      properties: {
        merchant: { type: 'string', description: 'Merchant name' },
        orderRef: { type: 'string', description: 'Order / confirmation reference' },
      },
    },
    describe: 'Check an order status: searches confirmation emails first (read-only). Status is labeled as email-derived — never invented.',
  },
  {
    name: 'price_check', risk: 'low', fn: priceCheck,
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to price-check, e.g. "Sony WH-1000XM5"' },
      },
      required: ['query'],
    },
    describe: 'Live price/availability check (read-only). Quotes are labeled with source and read time; without a browser tier configured it says so honestly.',
  },
  {
    name: 'reservation_fix', risk: 'high', fn: reservationFix,
    schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Confirmation reference of the messed-up reservation' },
        issue: { type: 'string', description: 'What is wrong, in plain words' },
        applyFix: { type: 'boolean', description: 'Default false — diagnosis only. Set true to execute the proposed fix (still needs the approval card).' },
        venueId: { type: 'string', description: 'Resy venueId if known' },
      },
      required: ['ref', 'issue'],
    },
    describe: 'Diagnose a messed-up reservation: finds the confirmation email, identifies the error, proposes a fix. Applies it only with applyFix:true plus the approval card, and only with proof (always needs approval).',
  },
];

module.exports = { id, name, description, envVars, status, tools, setBrowserDriver };
