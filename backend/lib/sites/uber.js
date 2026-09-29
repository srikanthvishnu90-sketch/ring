// backend/lib/sites/uber.js — Uber ride booking via mobile web (m.uber.com).
//
// Kinds:
//   'book-ride'    — login (phone OTP) -> pickup/dropoff -> fare estimate ->
//                    need_approval -> confirm -> done { orderId }
//   'trip-status'  — poll current trip status (for arrival notifications)
//   'cancel-ride'  — cancel the active trip -> done { cancelRef }
//
// Credentials: job.phone (E.164) for OTP login, or job.vaultId.
// Multi-phase: login OTP and fare approval use need_otp / need_approval.

const UBER_HOME = 'https://m.uber.com/go/home';

// ---- shared helpers -------------------------------------------------------
async function getCreds(ctx, job) {
  if (job.vaultId) {
    const c = await ctx.vault.withCredentials(job.vaultId, (x) => x);
    return { phone: c.phone, email: c.email || c.username };
  }
  return { phone: job.phone, email: job.email || job.username };
}

async function dismissCookies(page) {
  for (const sel of ['button:has-text("Got it")', 'button:has-text("Opt out")', 'button:has-text("Accept")']) {
    try {
      const el = await page.$(sel).catch(() => null);
      if (el) { await el.click().catch(() => {}); await page.waitForTimeout(1000); }
    } catch { /* next */ }
  }
}

// Returns true if we're logged in (no Login button visible).
async function isLoggedIn(page) {
  const loginBtn = await page.$('button:has-text("Login"), a:has-text("Login")').catch(() => null);
  return !loginBtn;
}

// ---- book-ride -------------------------------------------------------------
async function bookRide(ctx, job) {
  const page = ctx.page;

  // Continuation: OTP code provided.
  if (job.otp_code && job.sessionId) {
    return submitOtp(ctx, job);
  }
  // Continuation: fare approved.
  if (job.fare_approved && job.sessionId) {
    return confirmBooking(ctx, job);
  }

  ctx.log('uber_start', { kind: 'book-ride' });
  await page.goto(UBER_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await dismissCookies(page);
  ctx.log('uber_home', { url: page.url() });

  // ---- Login if needed ----------------------------------------------------
  if (!(await isLoggedIn(page))) {
    const { phone } = await getCreds(ctx, job);
    if (!phone) {
      return { ok: false, code: 'no_credentials', note: 'Uber needs a phone number for OTP login (job.phone or vault). Nothing was attempted.' };
    }
    const loginBtn = await page.$('button:has-text("Login"), a:has-text("Login")').catch(() => null);
    if (loginBtn) {
      await loginBtn.click().catch(() => {});
      await page.waitForTimeout(3000);
    }
    // Phone input.
    const phoneSel = 'input[type="tel"], input[name="phone"], input[inputmode="tel"]';
    try {
      await page.waitForSelector(phoneSel, { timeout: 15000 });
      await page.fill(phoneSel, phone);
      ctx.log('phone_filled', {});
      const contBtn = await page.$('button:has-text("Continue"), button[type="submit"]').catch(() => null);
      if (contBtn) await contBtn.click().catch(() => {});
      else await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
    } catch (e) {
      await ctx.screenshot('uber-no-phone-form');
      return { ok: false, code: 'login_blocked', note: 'Could not find Uber phone login form. Screenshot captured.' };
    }
    // OTP should now be on its way.
    await ctx.screenshot('uber-otp-prompt');
    return {
      ok: true, phase: 'need_otp',
      prompt: `Uber sent a verification code to ${String(phone).slice(0, 6)}…. Enter it here.`,
      fields: ['otp_code'],
      note: 'Re-invoke with { sessionId, otp_code: "<code>" } to continue.',
    };
  }

  return setRouteAndFare(ctx, job);
}

async function submitOtp(ctx, job) {
  const page = ctx.page;
  ctx.log('otp_submit', {});
  const otpSel = 'input[inputmode="numeric"], input[name*="otp" i], input[name*="code" i], input[type="tel"]';
  try {
    await page.waitForSelector(otpSel, { timeout: 15000 });
    await page.fill(otpSel, String(job.otp_code));
    await page.waitForTimeout(4000);
    // Often auto-submits; if not, press Enter.
    const verifyBtn = await page.$('button:has-text("Verify"), button[type="submit"]').catch(() => null);
    if (verifyBtn) await verifyBtn.click().catch(() => {});
    await page.waitForTimeout(5000);
  } catch (e) {
    return { ok: false, code: 'otp_failed', note: 'Could not enter the OTP code.' };
  }
  if (!(await isLoggedIn(page))) {
    await ctx.screenshot('uber-otp-failed');
    return { ok: false, code: 'otp_failed', note: 'OTP was not accepted (still not logged in). Screenshot captured.' };
  }
  ctx.log('otp_ok', {});
  await page.goto(UBER_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  return setRouteAndFare(ctx, job);
}

async function setRouteAndFare(ctx, job) {
  const page = ctx.page;
  const { pickup, dropoff } = job;
  if (!pickup || !dropoff) {
    return { ok: false, code: 'missing_route', note: 'book-ride needs job.pickup and job.dropoff addresses.' };
  }
  ctx.log('set_route', { pickup: String(pickup).slice(0, 40), dropoff: String(dropoff).slice(0, 40) });

  // Tap pickup, enter address, pick first suggestion. Same for dropoff.
  for (const [which, addr, testid] of [['pickup', pickup, 'pudo-button-pickup'], ['dropoff', dropoff, 'pudo-button-drop0']]) {
    try {
      const btn = await page.$(`[data-testid="${testid}"]`).catch(() => null);
      if (!btn) {
        await ctx.screenshot(`uber-no-${which}-btn`);
        return { ok: false, code: 'route_failed', note: `Could not find the ${which} location button.` };
      }
      await btn.click().catch(() => {});
      await page.waitForTimeout(2000);
      const input = await page.$('input[placeholder*="address" i], input[placeholder*="location" i], input[type="text"]').catch(() => null);
      if (!input) {
        return { ok: false, code: 'route_failed', note: `Address input did not appear for ${which}.` };
      }
      await input.fill(String(addr));
      await page.waitForTimeout(2500);
      // Pick the first suggestion.
      const suggestion = await page.$('[role="option"], li[role="button"], [data-testid*="suggestion"]').catch(() => null);
      if (suggestion) await suggestion.click().catch(() => {});
      else await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
      ctx.log(`${which}_set`, {});
    } catch (e) {
      return { ok: false, code: 'route_failed', note: `Failed setting ${which}: ${String(e.message).slice(0, 120)}` };
    }
  }

  // Fare estimate should now be visible. Extract it.
  await page.waitForTimeout(4000);
  await ctx.screenshot('uber-fare');
  const fareText = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    // Look for $ amounts near product names.
    const m = body.match(/\$(\d+\.\d{2})/);
    return m ? m[0] : null;
  }).catch(() => null);
  const etaText = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    const m = body.match(/(\d+)\s*min/i);
    return m ? m[0] : null;
  }).catch(() => null);

  ctx.log('fare_estimate', { fare: fareText, eta: etaText });
  return {
    ok: true, phase: 'need_approval',
    summary: {
      pickup: String(pickup).slice(0, 60),
      dropoff: String(dropoff).slice(0, 60),
      fare: fareText || 'see screenshot',
      eta: etaText || 'unknown',
    },
    prompt: `Uber fare estimate: ${fareText || 'unknown'} (${etaText || 'no ETA shown'}). Approve to request the ride.`,
    note: 'Re-invoke with { sessionId, fare_approved: true } to book.',
  };
}

async function confirmBooking(ctx, job) {
  const page = ctx.page;
  ctx.log('confirm_booking', {});
  // Tap the request/confirm button.
  const reqBtn = await page.$('button:has-text("Request"), button:has-text("Confirm"), button:has-text("Choose")').catch(() => null);
  if (!reqBtn) {
    await ctx.screenshot('uber-no-request-btn');
    return { ok: false, code: 'book_failed', note: 'Could not find the ride request button after fare approval.' };
  }
  await reqBtn.click().catch(() => {});
  await page.waitForTimeout(8000);
  await ctx.screenshot('uber-booked');

  // Extract trip/order ID.
  const bodyText = await page.textContent('body').catch(() => '');
  const tripMatch = (bodyText || '').match(/(?:trip|order)[\s#:]*([A-Z0-9-]{6,})/i);
  const driverMatch = (bodyText || '').match(/(?:driver|arriving)[^.]{0,80}/i);
  ctx.log('booking_confirmed', { hasTripId: !!tripMatch });

  return {
    ok: true, phase: 'done',
    orderId: tripMatch ? tripMatch[1] : 'uber-trip-active',
    driver: driverMatch ? driverMatch[0].slice(0, 100) : null,
    note: 'Uber ride requested. Screenshot captured.',
  };
}

// ---- trip-status ------------------------------------------------------------
async function tripStatus(ctx, job) {
  const page = ctx.page;
  ctx.log('trip_status_start', {});
  await page.goto(UBER_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const bodyText = await page.textContent('body').catch(() => '') || '';

  // Look for active trip indicators.
  const arriving = /arriving|on the way|(\d+)\s*min away/i.exec(bodyText);
  const driverName = /(?:driver|your driver)[\s:]*([A-Z][a-z]+)/i.exec(bodyText);
  const noTrip = /request a ride|where to\?/i.test(bodyText) && !arriving;

  await ctx.screenshot('uber-status');
  if (noTrip) {
    return { ok: true, phase: 'done', confirmationRef: 'no-active-trip', status: 'no_active_trip', note: 'No active Uber trip found.' };
  }
  return {
    ok: true, phase: 'done',
    confirmationRef: 'uber-trip-status',
    status: arriving ? 'driver_en_route' : 'unknown',
    eta: arriving ? arriving[0] : null,
    driver: driverName ? driverName[1] : null,
    note: `Trip status: ${arriving ? arriving[0] : 'checked'}.`,
  };
}

// ---- cancel-ride --------------------------------------------------------------
async function cancelRide(ctx, job) {
  const page = ctx.page;
  ctx.log('cancel_start', {});
  await page.goto(UBER_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // Find the active trip / cancel option.
  const cancelBtn = await page.$('button:has-text("Cancel"), a:has-text("Cancel trip")').catch(() => null);
  if (!cancelBtn) {
    // Try tapping the trip card first.
    const tripCard = await page.$('[data-testid*="trip"], button:has-text("Arriving")').catch(() => null);
    if (tripCard) {
      await tripCard.click().catch(() => {});
      await page.waitForTimeout(3000);
    }
  }
  const cancel2 = await page.$('button:has-text("Cancel"), button:has-text("Cancel trip")').catch(() => null);
  if (!cancel2) {
    await ctx.screenshot('uber-no-cancel');
    return { ok: false, code: 'no_active_trip', note: 'No active trip with a cancel option found.' };
  }
  await cancel2.click().catch(() => {});
  await page.waitForTimeout(2000);

  // Reason selection (pick "Other" or skip).
  const reasonBtn = await page.$('button:has-text("Other"), [role="option"]').catch(() => null);
  if (reasonBtn) { await reasonBtn.click().catch(() => {}); await page.waitForTimeout(1500); }

  // Confirm cancellation.
  const confirmBtn = await page.$('button:has-text("Confirm"), button:has-text("Yes, cancel")').catch(() => null);
  if (confirmBtn) { await confirmBtn.click().catch(() => {}); await page.waitForTimeout(4000); }

  await ctx.screenshot('uber-cancelled');
  const bodyText = await page.textContent('body').catch(() => '') || '';
  const cancelled = /cancelled|canceled|trip.*end/i.test(bodyText);
  // Capture any fee notice.
  const feeMatch = bodyText.match(/(?:cancellation fee|fee)[\s:]*\$?(\d+\.?\d*)/i);

  if (cancelled || feeMatch) {
    return {
      ok: true, phase: 'done',
      cancelRef: 'uber-cancelled',
      fee: feeMatch ? `$${feeMatch[1]}` : 'none shown',
      note: `Trip cancelled. Fee: ${feeMatch ? '$' + feeMatch[1] : 'none shown'}.`,
    };
  }
  return { ok: false, code: 'cancel_unverified', note: 'Clicked cancel but could not verify. Screenshot captured.' };
}

module.exports = {
  'book-ride': bookRide,
  'trip-status': tripStatus,
  'cancel-ride': cancelRide,
};
