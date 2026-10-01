// backend/connectors/outcomes2.js — Real-world outcomes, batch 2 (features 51–75).
//
// 25 new tools extending the outcomes connector: travel, food, shopping,
// money, local services, and everyday tasks. Every tool follows the same
// tiered philosophy as outcomes.js:
//   1. Validate args (honest missing_args — nothing attempted).
//   2. Action tools: browser tier via browserRun() with a kind routed to the
//      generic_task site module; success ONLY with a confirmation artifact
//      (proofOf gate); otherwise an honest handoff with a concrete playbook.
//   3. Read-only tools: best real path available (API when configured,
//      otherwise an honest deep link) — never invented data.
//
// High-risk tools are approval-gated by the agent framework before fn runs;
// the browser tier additionally requires the auto-continue approval flag
// (see approvals.js) before any confirming click.

const { browserRun, proofOf, browserContinuation } = require('./outcomes');

function isoNow() { return new Date().toISOString(); }

function missingArgs(args, required) {
  return required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
}

// Generic tiered executor for the action tools in this file.
// kind: job kind routed to the generic_task site module.
// playbook: concrete steps for the honest handoff tier.
async function executeAction(toolName, kind, args, required, playbook) {
  const missing = missingArgs(args, required);
  if (missing.length) {
    return { ok: false, error: 'missing_args', missing, note: 'Nothing was attempted.' };
  }
  const attempts = [];
  const { sessionId, otp, userId, ...rest } = args;
  const br = await browserRun({
    kind, userId, sessionId,
    ...(otp ? { otp_code: otp } : {}),
    ...rest,
  });
  if (br.ok) {
    const cont = browserContinuation(br);
    if (cont) return cont;
    const proof = proofOf(br.result);
    if (proof) {
      return {
        ok: true, tier: 'browser', confirmationRef: proof, tool: toolName,
        at: isoNow(), detail: br.result && br.result.summary ? br.result.summary : undefined,
      };
    }
    attempts.push({
      tier: 'browser',
      error: (br.result && br.result.code) || 'no_proof',
      note: (br.result && br.result.note) || 'Browser finished with no confirmation artifact — NOT done.',
    });
  } else {
    attempts.push({
      tier: 'browser', error: br.error,
      ...(br.missing ? { missing: br.missing } : {}),
      ...(br.note ? { note: br.note } : {}),
      ...(br.detail ? { detail: br.detail } : {}),
    });
  }
  return {
    ok: false, tier: 'handoff', tool: toolName, attempts, playbook,
    note: 'Nothing was completed — follow the playbook, or approve the browser tier to have it attempted.',
  };
}

// ---- Travel ---------------------------------------------------------------

async function flightSearch({ from, to, date, returnDate, passengers }) {
  const missing = missingArgs({ from, to, date }, ['from', 'to', 'date']);
  if (missing.length) return { ok: false, error: 'missing_args', missing, note: 'Nothing was searched.' };
  const key = process.env.DUFFEL_API_KEY;
  const deepLink = `https://www.google.com/flights?hl=en#flt=${encodeURIComponent(from)}.${encodeURIComponent(to)}.${date}${returnDate ? `*${encodeURIComponent(to)}.${encodeURIComponent(from)}.${returnDate}` : ''}`;
  if (!key) {
    return {
      ok: false, error: 'not_configured', searched: false, deepLink,
      note: 'Live flight search needs DUFFEL_API_KEY on the server (not set). Open the link to see real options; nothing was searched.',
    };
  }
  try {
    const resp = await fetch('https://api.duffel.com/air/offer_requests', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`, 'Duffel-Version': 'v2', 'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          slices: [
            { origin: from, destination: to, departure_date: date },
            ...(returnDate ? [{ origin: to, destination: from, departure_date: returnDate }] : []),
          ],
          passengers: Array.from({ length: passengers || 1 }, () => ({})),
          max_connections: 1,
        },
      }),
    });
    if (!resp.ok) {
      return { ok: false, error: 'duffel_error', detail: `Duffel ${resp.status}`, deepLink, note: 'Live search failed — open the link for real options.' };
    }
    const body = await resp.json();
    const offers = (body.data && body.data.offers || []).slice(0, 10).map((o) => ({
      airline: o.owner && o.owner.name, total: o.total_amount, currency: o.total_currency,
      slices: (o.slices || []).map((s) => `${s.origin.iata_code}→${s.destination.iata_code} ${s.departing_at}`),
    }));
    return { ok: true, tier: 'duffel', searched: true, offers, deepLink, at: isoNow() };
  } catch (e) {
    return { ok: false, error: 'search_failed', detail: String(e.message).slice(0, 200), deepLink };
  }
}

async function flightStatus({ airline, flightNumber, date }) {
  const missing = missingArgs({ airline, flightNumber }, ['airline', 'flightNumber']);
  if (missing.length) return { ok: false, error: 'missing_args', missing, note: 'Nothing was checked.' };
  const code = `${String(airline).toUpperCase().replace(/[^A-Z]/g, '')}${String(flightNumber).replace(/\D/g, '')}`;
  const deepLink = `https://www.flightaware.com/live/flight/${code}`;
  return {
    ok: false, error: 'not_configured', checked: false, deepLink,
    note: `Live status for ${code}${date ? ` on ${date}` : ''} needs a flight-status API key (not set). Open the link for the real status; nothing was checked.`,
  };
}

async function hotelSearch({ city, checkIn, checkOut, guests }) {
  const missing = missingArgs({ city, checkIn, checkOut }, ['city', 'checkIn', 'checkOut']);
  if (missing.length) return { ok: false, error: 'missing_args', missing, note: 'Nothing was searched.' };
  const q = encodeURIComponent(`hotels in ${city} ${checkIn} to ${checkOut} ${guests || 2} guests`);
  const deepLink = `https://www.google.com/travel/hotels?q=${q}`;
  return {
    ok: false, error: 'not_configured', searched: false, deepLink,
    note: 'Live hotel search needs a hotel API key (not set). Open the link for real options; nothing was searched.',
  };
}

async function packageTrack({ trackingNumber, carrier }) {
  const missing = missingArgs({ trackingNumber }, ['trackingNumber']);
  if (missing.length) return { ok: false, error: 'missing_args', missing, note: 'Nothing was tracked.' };
  const num = String(trackingNumber).replace(/\s/g, '');
  let detected = carrier;
  if (!detected) {
    if (/^1Z[0-9A-Z]{16}$/i.test(num)) detected = 'UPS';
    else if (/^\d{12,15}$/.test(num) || /^612\d+/.test(num)) detected = 'FedEx';
    else if (/^\d{20,22}$/.test(num) || /^9[0-9]{15,}$/.test(num)) detected = 'USPS';
    else if (/^TBA\d{12}$/i.test(num)) detected = 'Amazon';
  }
  const links = {
    UPS: `https://www.ups.com/track?tracknum=${encodeURIComponent(num)}`,
    FedEx: `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(num)}`,
    USPS: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(num)}`,
    Amazon: `https://www.amazon.com/progress-tracker/package/ref=ppx_hod_st_track`,
    DHL: `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(num)}`,
  };
  const deepLink = (detected && links[detected]) || `https://www.google.com/search?q=${encodeURIComponent(num + ' tracking')}`;
  return {
    ok: false, error: 'not_configured', tracked: false, carrier: detected || 'unknown', deepLink,
    note: 'Live package status needs a tracking API key (not set). Open the link for the real status; nothing was tracked.',
  };
}

async function couponFind({ query }) {
  const missing = missingArgs({ query }, ['query']);
  if (missing.length) return { ok: false, error: 'missing_args', missing, note: 'Nothing was searched.' };
  const deepLink = `https://www.google.com/search?q=${encodeURIComponent(query + ' coupon code')}`;
  return {
    ok: false, error: 'not_configured', searched: false, deepLink,
    note: 'Live coupon lookup is not wired to a source yet. Open the link for real codes; nothing was searched.',
  };
}

// ---- Food -----------------------------------------------------------------

async function foodOrder(args) {
  return executeAction('food_order', 'order-food', args, ['restaurant', 'items', 'address'], [
    `Open DoorDash/Uber Eats and search "${args.restaurant || 'the restaurant'}".`,
    'Add the items to the cart and set the delivery address.',
    'Review the total (food + fees + tip) and place the order.',
    'Save the confirmation number.',
  ]);
}

async function groceryOrder(args) {
  return executeAction('grocery_order', 'order-groceries', args, ['store', 'items', 'address'], [
    `Open ${args.store || 'your grocery app'} (Instacart / store app).`,
    'Add each item to the cart; pick substitutes where allowed.',
    'Set the delivery address and window.',
    'Review the total and place the order; save the confirmation number.',
  ]);
}

async function waitlistJoin(args) {
  return executeAction('waitlist_join', 'join-waitlist', args, ['restaurant', 'party', 'name'], [
    `Open the restaurant's page (${args.restaurant || 'the restaurant'}) on Resy/OpenTable/Yelp.`,
    'Find "Join waitlist" / "Notify me".',
    `Enter party of ${args.party || 2} under ${args.name || 'your name'}.`,
    'Confirm and save the waitlist position / quote time.',
  ]);
}

// ---- Shopping ---------------------------------------------------------------

async function productOrder(args) {
  return executeAction('product_order', 'order-product', args, ['product', 'address'], [
    `Search for "${args.product || 'the product'}" at ${args.merchant || 'the merchant'}.`,
    'Add to cart; set the shipping address.',
    'Review the total (item + tax + shipping) and place the order.',
    'Save the order confirmation number.',
  ]);
}

async function priceAlert(args) {
  return executeAction('price_alert', 'create-price-alert', args, ['product', 'targetPrice'], [
    `Search for "${args.product || 'the product'}" on a price tracker (CamelCamelCamel, Slickdeals, Google Shopping).`,
    `Create an alert for price at or below ${args.targetPrice || 'the target'}.`,
    'Confirm the alert is active and save its ID/link.',
  ]);
}

async function returnStart(args) {
  return executeAction('return_start', 'start-return', args, ['merchant', 'orderRef', 'reason'], [
    `Open ${args.merchant || 'the merchant'} order ${args.orderRef || ''} → Start a return.`,
    `Select reason: ${args.reason || 'as stated'}.`,
    'Choose refund method and print/save the return label.',
    'Save the RMA / return confirmation number.',
  ]);
}

// ---- Money ------------------------------------------------------------------

async function billPay(args) {
  return executeAction('bill_pay', 'pay-bill', args, ['biller'], [
    `Open ${args.biller || 'the biller'} billing portal and sign in.`,
    `Verify the amount due${args.amount ? ` (expected ${args.amount})` : ''}.`,
    'Select the payment method and submit the payment.',
    'Save the payment confirmation number.',
  ]);
}

async function subscriptionPause(args) {
  return executeAction('subscription_pause', 'pause-subscription', args, ['merchant'], [
    `Sign in to ${args.merchant || 'the merchant'} account → Subscriptions/Billing.`,
    'Choose Pause (not Cancel) and pick the resume date.',
    'Confirm; save the confirmation that billing is paused.',
  ]);
}

async function donate(args) {
  return executeAction('donate', 'make-donation', args, ['charity', 'amount'], [
    `Open ${args.charity || 'the charity'} donation page.`,
    `Enter the donation amount (${args.amount || 'as stated'}) — one-time unless specified.`,
    'Enter payment details and submit.',
    'Save the donation receipt.',
  ]);
}

async function giftOrder(args) {
  return executeAction('gift_order', 'order-gift', args, ['gift', 'recipient', 'address'], [
    `Search for "${args.gift || 'the gift'}" (florist / gift site).`,
    'Add the gift message if provided.',
    `Set the delivery address for ${args.recipient || 'the recipient'}.`,
    'Review the total and place the order; save the confirmation number.',
  ]);
}

// ---- Local services ---------------------------------------------------------

async function appointmentBook(args) {
  return executeAction('appointment_book', 'book-appointment', args, ['service', 'date'], [
    `Search for "${args.service || 'the service'}"${args.business ? ` at ${args.business}` : ''}.`,
    `Pick ${args.date || 'the date'}${args.time ? ` at ${args.time}` : ''}; enter name/phone.`,
    'Confirm the booking; save the confirmation number.',
  ]);
}

async function serviceBook(args) {
  return executeAction('service_book', 'book-service', args, ['serviceType', 'address', 'date'], [
    `Open a home-services marketplace (Taskrabbit / Thumbtack) for "${args.serviceType || 'the service'}".`,
    `Set the address and preferred date (${args.date || 'asap'}).`,
    'Pick a provider, review the quote, and book; save the confirmation.',
  ]);
}

async function parkingBook(args) {
  return executeAction('parking_book', 'reserve-parking', args, ['location', 'date'], [
    `Search parking near "${args.location || 'the location'}" on SpotHero for ${args.date || 'the date'}.`,
    'Pick a garage/lot and the time window.',
    'Pay and save the parking pass / confirmation.',
  ]);
}

async function ticketBook(args) {
  return executeAction('ticket_book', 'book-tickets', args, ['event', 'date'], [
    `Search for "${args.event || 'the event'}" on ${args.date || 'the date'} (Ticketmaster / venue site).`,
    `Select ${args.quantity || 2} tickets and seats.`,
    'Review fees + total, pay, and save the order confirmation.',
  ]);
}

async function carRentalBook(args) {
  return executeAction('car_rental_book', 'book-car-rental', args, ['pickupLocation', 'pickupDate', 'dropoffDate'], [
    `Search rentals at "${args.pickupLocation || 'the location'}" ${args.pickupDate || ''} → ${args.dropoffDate || ''}.`,
    'Pick a car class; review rate + fees + total.',
    'Book and save the confirmation number.',
  ]);
}

// ---- Everyday ---------------------------------------------------------------

async function unsubscribeEmail(args) {
  return executeAction('unsubscribe_email', 'unsubscribe', args, ['sender'], [
    `Find a recent email from "${args.sender || 'the sender'}".`,
    'Open the List-Unsubscribe link (usually at the bottom).',
    'Confirm the unsubscribe on the landing page.',
  ]);
}

async function dataExportRequest(args) {
  return executeAction('data_export_request', 'request-data-export', args, ['service'], [
    `Sign in to ${args.service || 'the service'} → Settings → Privacy/Data.`,
    'Choose "Download your data" / "Request export".',
    'Confirm; note where the export will be delivered.',
  ]);
}

async function warrantyRegister(args) {
  return executeAction('warranty_register', 'register-warranty', args, ['product', 'brand'], [
    `Open ${args.brand || 'the brand'} product registration page.`,
    `Enter the product (${args.product || ''})${args.serial ? `, serial ${args.serial}` : ''}${args.purchaseDate ? `, purchased ${args.purchaseDate}` : ''}.`,
    'Submit and save the registration confirmation.',
  ]);
}

// ---- Group chat -----------------------------------------------------------
// group_send: post a real message to a Ring group thread as the user.
// This is the tool the ledger's #45 ("group_reply") never had — that entry
// was the @ring mention path, not a callable tool. This one is real:
// membership-checked, persisted to ring_messages, broadcast live.

async function groupSend({ userId, threadId, text, from }) {
  const missing = missingArgs({ threadId, text }, ['threadId', 'text']);
  if (missing.length) return { ok: false, error: 'missing_args', missing, note: 'Nothing was sent.' };
  let threads;
  try {
    threads = require('../lib/threads');
  } catch (e) {
    return { ok: false, error: 'threads_unavailable', note: 'Group messaging is not available in this environment. Nothing was sent.' };
  }
  const th = await threads.getThread(threadId).catch(() => null);
  if (!th) return { ok: false, error: 'thread_not_found', note: 'No such group thread. Nothing was sent.' };
  if (!threads.isMember(th, userId)) {
    return { ok: false, error: 'not_a_member', note: 'You are not a member of that thread. Nothing was sent.' };
  }
  try {
    // skipMention: sending "@ring ..." text via this tool must not trigger a
    // second agent turn — the mention path already works through the app.
    const msg = await threads.postMessage(threadId, { from: from || 'you', text, userId, skipMention: true });
    return { ok: true, sent: true, messageId: msg.id || msg.ts || 'stored', threadId, at: isoNow() };
  } catch (e) {
    return { ok: false, error: 'send_failed', detail: String((e && e.message) || e).slice(0, 200), note: 'Nothing was sent.' };
  }
}

// ---- Tool table -------------------------------------------------------------

const tools = [
  { name: 'group_send', risk: 'medium', fn: groupSend,
    schema: { type: 'object', properties: {
      threadId: { type: 'string', description: 'Ring group thread id' },
      text: { type: 'string', description: 'Message text to post' },
      from: { type: 'string', description: 'Display name (default "you")' },
    }, required: ['threadId', 'text'] },
    describe: 'Send a real message to a Ring group chat thread as the user: membership-checked, persisted, broadcast live. Returns the message id as proof. Never claims sent without it (needs approval).' },
  { name: 'flight_search', risk: 'low', fn: flightSearch,
    schema: { type: 'object', properties: {
      from: { type: 'string', description: 'Origin airport code, e.g. ORD' },
      to: { type: 'string', description: 'Destination airport code, e.g. LAX' },
      date: { type: 'string', description: 'Departure date YYYY-MM-DD' },
      returnDate: { type: 'string', description: 'Return date YYYY-MM-DD (optional)' },
      passengers: { type: 'number', description: 'Passenger count (default 1)' },
    }, required: ['from', 'to', 'date'] },
    describe: 'Search live flights: real offers via Duffel when configured, otherwise an honest prefilled deep link. Read-only — never books.' },
  { name: 'flight_book', risk: 'high', fn: (a) => executeAction('flight_book', 'book-flight', a, ['from', 'to', 'date'], [
      `Search flights ${a.from || ''} → ${a.to || ''} on ${a.date || 'the date'}.`,
      'Pick the flight; enter traveler details.',
      'Review the total fare and book; save the confirmation / PNR.',
    ]),
    schema: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' },
      returnDate: { type: 'string' }, passengers: { type: 'number' },
      travelerName: { type: 'string' }, vault: { type: 'string', description: 'Vault id with the booking-site login' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['from', 'to', 'date'] },
    describe: 'Book a flight for real: browser executes with proof (PNR/confirmation ref) or an honest handoff. Never claims booked without proof (always needs approval).' },
  { name: 'hotel_search', risk: 'low', fn: hotelSearch,
    schema: { type: 'object', properties: {
      city: { type: 'string' }, checkIn: { type: 'string', description: 'YYYY-MM-DD' },
      checkOut: { type: 'string', description: 'YYYY-MM-DD' }, guests: { type: 'number' },
    }, required: ['city', 'checkIn', 'checkOut'] },
    describe: 'Search hotels: honest prefilled deep link until a hotel API is configured. Read-only — never books.' },
  { name: 'hotel_book', risk: 'high', fn: (a) => executeAction('hotel_book', 'book-hotel', a, ['city', 'checkIn', 'checkOut'], [
      `Search hotels in ${a.city || 'the city'} ${a.checkIn || ''} → ${a.checkOut || ''}.`,
      'Pick the hotel/room; enter guest details.',
      'Review the total and book; save the confirmation number.',
    ]),
    schema: { type: 'object', properties: {
      city: { type: 'string' }, hotel: { type: 'string' }, checkIn: { type: 'string' }, checkOut: { type: 'string' },
      guests: { type: 'number' }, guestName: { type: 'string' }, vault: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['city', 'checkIn', 'checkOut'] },
    describe: 'Book a hotel for real: browser executes with proof (confirmation number) or an honest handoff. Never claims booked without proof (always needs approval).' },
  { name: 'flight_status', risk: 'low', fn: flightStatus,
    schema: { type: 'object', properties: {
      airline: { type: 'string', description: 'Airline code or name, e.g. AA' },
      flightNumber: { type: 'string', description: 'Flight number, e.g. 123' },
      date: { type: 'string', description: 'Date YYYY-MM-DD (optional)' },
    }, required: ['airline', 'flightNumber'] },
    describe: 'Check a flight status: honest live-tracking deep link until a status API is configured. Read-only.' },
  { name: 'food_order', risk: 'high', fn: foodOrder,
    schema: { type: 'object', properties: {
      restaurant: { type: 'string' }, items: { type: 'string', description: 'Items to order' },
      address: { type: 'string', description: 'Delivery address' }, vault: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['restaurant', 'items', 'address'] },
    describe: 'Order food delivery for real: browser executes with proof (order confirmation) or an honest handoff. Never claims ordered without proof (always needs approval).' },
  { name: 'grocery_order', risk: 'high', fn: groceryOrder,
    schema: { type: 'object', properties: {
      store: { type: 'string' }, items: { type: 'string', description: 'Grocery list' },
      address: { type: 'string', description: 'Delivery address' }, vault: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['store', 'items', 'address'] },
    describe: 'Order groceries for real: browser executes with proof or an honest handoff. Never claims ordered without proof (always needs approval).' },
  { name: 'waitlist_join', risk: 'medium', fn: waitlistJoin,
    schema: { type: 'object', properties: {
      restaurant: { type: 'string' }, city: { type: 'string' }, party: { type: 'number' },
      name: { type: 'string' }, phone: { type: 'string' },
    }, required: ['restaurant', 'party', 'name'] },
    describe: 'Join a restaurant waitlist for real: browser executes with proof (position/quote time) or an honest handoff. Never claims joined without proof.' },
  { name: 'product_order', risk: 'high', fn: productOrder,
    schema: { type: 'object', properties: {
      product: { type: 'string' }, merchant: { type: 'string' }, address: { type: 'string' }, vault: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['product', 'address'] },
    describe: 'Buy a product online for real: browser executes with proof (order number) or an honest handoff. Never claims ordered without proof (always needs approval).' },
  { name: 'price_alert', risk: 'medium', fn: priceAlert,
    schema: { type: 'object', properties: {
      product: { type: 'string' }, targetPrice: { type: 'string' }, email: { type: 'string' },
    }, required: ['product', 'targetPrice'] },
    describe: 'Create a real price-drop alert: browser executes with proof (alert ID/link) or an honest handoff. Never claims created without proof.' },
  { name: 'return_start', risk: 'high', fn: returnStart,
    schema: { type: 'object', properties: {
      merchant: { type: 'string' }, orderRef: { type: 'string' }, reason: { type: 'string' }, vault: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['merchant', 'orderRef', 'reason'] },
    describe: 'Start a real return: browser executes with proof (RMA/return label) or an honest handoff. Never claims started without proof (always needs approval).' },
  { name: 'coupon_find', risk: 'low', fn: couponFind,
    schema: { type: 'object', properties: { query: { type: 'string', description: 'Merchant or product' } }, required: ['query'] },
    describe: 'Find coupon codes: honest deep link until a coupon source is wired. Read-only.' },
  { name: 'bill_pay', risk: 'high', fn: billPay,
    schema: { type: 'object', properties: {
      biller: { type: 'string' }, amount: { type: 'string' }, accountRef: { type: 'string' }, vault: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['biller'] },
    describe: 'Pay a bill for real: browser executes with proof (payment confirmation) or an honest handoff. Never claims paid without proof (always needs approval).' },
  { name: 'subscription_pause', risk: 'high', fn: subscriptionPause,
    schema: { type: 'object', properties: {
      merchant: { type: 'string' }, vault: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['merchant'] },
    describe: 'Pause a subscription for real: browser executes with proof or an honest handoff. Never claims paused without proof (always needs approval).' },
  { name: 'donate', risk: 'high', fn: donate,
    schema: { type: 'object', properties: {
      charity: { type: 'string' }, amount: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['charity', 'amount'] },
    describe: 'Make a real charitable donation: browser executes with proof (receipt) or an honest handoff. Never claims donated without proof (always needs approval).' },
  { name: 'gift_order', risk: 'high', fn: giftOrder,
    schema: { type: 'object', properties: {
      gift: { type: 'string' }, recipient: { type: 'string' }, address: { type: 'string' },
      occasion: { type: 'string' }, message: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['gift', 'recipient', 'address'] },
    describe: 'Send a real gift/flowers: browser executes with proof (order confirmation) or an honest handoff. Never claims sent without proof (always needs approval).' },
  { name: 'appointment_book', risk: 'high', fn: appointmentBook,
    schema: { type: 'object', properties: {
      service: { type: 'string' }, business: { type: 'string' }, date: { type: 'string' },
      time: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['service', 'date'] },
    describe: 'Book a real appointment: browser executes with proof (confirmation) or an honest handoff. Never claims booked without proof (always needs approval).' },
  { name: 'service_book', risk: 'high', fn: serviceBook,
    schema: { type: 'object', properties: {
      serviceType: { type: 'string' }, address: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' }, vault: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['serviceType', 'address', 'date'] },
    describe: 'Book a real home service: browser executes with proof or an honest handoff. Never claims booked without proof (always needs approval).' },
  { name: 'parking_book', risk: 'high', fn: parkingBook,
    schema: { type: 'object', properties: {
      location: { type: 'string' }, date: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['location', 'date'] },
    describe: 'Reserve real parking: browser executes with proof (pass/confirmation) or an honest handoff. Never claims reserved without proof (always needs approval).' },
  { name: 'ticket_book', risk: 'high', fn: ticketBook,
    schema: { type: 'object', properties: {
      event: { type: 'string' }, venue: { type: 'string' }, date: { type: 'string' }, quantity: { type: 'number' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['event', 'date'] },
    describe: 'Buy real event/movie tickets: browser executes with proof (order confirmation) or an honest handoff. Never claims bought without proof (always needs approval).' },
  { name: 'package_track', risk: 'low', fn: packageTrack,
    schema: { type: 'object', properties: {
      trackingNumber: { type: 'string' }, carrier: { type: 'string', description: 'UPS/FedEx/USPS/Amazon/DHL (auto-detected if omitted)' },
    }, required: ['trackingNumber'] },
    describe: 'Track a package: detects the carrier and returns the live tracking link until a tracking API is configured. Read-only.' },
  { name: 'car_rental_book', risk: 'high', fn: carRentalBook,
    schema: { type: 'object', properties: {
      pickupLocation: { type: 'string' }, pickupDate: { type: 'string' }, dropoffDate: { type: 'string' }, driverName: { type: 'string' }, vault: { type: 'string' },
      sessionId: { description: 'Resume a live browser session.' }, otp: { description: 'One-time code when resuming.' },
    }, required: ['pickupLocation', 'pickupDate', 'dropoffDate'] },
    describe: 'Book a real rental car: browser executes with proof (confirmation) or an honest handoff. Never claims booked without proof (always needs approval).' },
  { name: 'unsubscribe_email', risk: 'medium', fn: unsubscribeEmail,
    schema: { type: 'object', properties: { sender: { type: 'string', description: 'Sender/merchant to unsubscribe from' } }, required: ['sender'] },
    describe: 'Unsubscribe from marketing emails for real: browser follows the List-Unsubscribe flow with proof or an honest handoff. Never claims unsubscribed without proof.' },
  { name: 'data_export_request', risk: 'medium', fn: dataExportRequest,
    schema: { type: 'object', properties: { service: { type: 'string' }, vault: { type: 'string' } }, required: ['service'] },
    describe: 'Request a real data export from a service: browser executes with proof or an honest handoff. Never claims requested without proof.' },
  { name: 'warranty_register', risk: 'medium', fn: warrantyRegister,
    schema: { type: 'object', properties: {
      product: { type: 'string' }, brand: { type: 'string' }, purchaseDate: { type: 'string' }, serial: { type: 'string' }, email: { type: 'string' },
    }, required: ['product', 'brand'] },
    describe: 'Register a real product warranty: browser executes with proof (registration confirmation) or an honest handoff. Never claims registered without proof.' },
];

module.exports = {
  id: 'outcomes2',
  name: 'Real-world outcomes II',
  description: 'Batch 2 of real-world outcome tools: travel, food, shopping, money, local services, everyday tasks.',
  envVars: ['DUFFEL_API_KEY'],
  status: () => ({ ok: true, tools: tools.length }),
  tools,
};
