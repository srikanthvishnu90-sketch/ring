// backend/lib/sites/dining.js — Restaurant table booking via OpenTable.
//
// Two-phase flow (serverless-safe: each phase gets its own budget):
//   Phase 1 (no job.sessionId): navigate → find slots → click the exact slot
//     → wait for the booking details page → return need_approval + sessionId.
//     The approval path (approvals.js executeTool) automatically continues.
//   Phase 2 (job.sessionId set): reattach to the live session, resume the
//     details page, fill guest info → confirm → extract confirmation → done.
// Exact requested time is always required — never silently book nearby.

const OPENTABLE_HOME = 'https://www.opentable.com';

async function dismissCookies(page) {
  for (const sel of ['button:has-text("Accept")', '#onetrust-accept-btn-handler', 'button:has-text("Got it")']) {
    try {
      const el = await page.$(sel).catch(() => null);
      if (el) { await el.click().catch(() => {}); await page.waitForTimeout(400); }
    } catch { /* next */ }
  }
}

async function getCreds(ctx, job) {
  if (job.vaultId && ctx.vault) {
    const c = await ctx.vault.withCredentials(job.vaultId, (x) => x);
    return { email: c.email, phone: c.phone, name: c.name };
  }
  return {
    email: job.email || 'demo@ring.app',
    phone: job.phone || '2246029341',
    name: job.name || 'Demo User',
  };
}

// ---- book-table (two phases; dispatched on job.sessionId) ------------------
async function bookTable(ctx, job) {
  if (job.sessionId) return phase2FillAndConfirm(ctx, job);
  return phase1SelectSlot(ctx, job);
}

// Details-page form selectors, shared by both phases.
const DETAILS_FORM_SEL = 'input#firstName, input[name="firstName"], input[type="email"]';

// Phase 1: land on the restaurant page, find the exact slot, click it, and
// wait for the booking details page. Returns need_approval + sessionId so the
// approval path auto-continues into phase 2.
async function phase1SelectSlot(ctx, job) {
  const page = ctx.page;
  const { restaurant, date, time, partySize } = job;

  if (!restaurant || !date || !partySize) {
    return { ok: false, code: 'missing_details', note: 'Need restaurant name, date, and party size. Nothing was attempted.' };
  }

  ctx.log('dining_phase1_start', { restaurant, date, time, partySize });

  // Build OpenTable URL with date/party params.
  // Format: https://www.opentable.com/r/{slug}?covers=4&dateTime=2026-10-03T19%3A30
  // Known slugs: Alla Vita Chicago -> alla-vita-chicago
  let slug = restaurant.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Fix known restaurants where guessed slug is wrong
  const KNOWN_SLUGS = {
    'alla-vita': 'alla-vita-chicago',
  };
  let slugWasCorrected = false;
  if (KNOWN_SLUGS[slug]) {
    slug = KNOWN_SLUGS[slug];
    slugWasCorrected = true;
    ctx.log('dining_slug_corrected', { from: restaurant, to: slug });
  }
  // Try direct restaurant URL first (works for known slugs like alla-vita-chicago)
  const dateTime = time ? `${date}T${time}` : date;
  const directUrl = `https://www.opentable.com/r/${slug}?covers=${partySize}&dateTime=${encodeURIComponent(dateTime)}`;

  await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  await dismissCookies(page);

  // If direct URL didn't land on a restaurant page, search.
  // Also verify the page shows the correct restaurant name (guessed slug may be wrong).
  // Skip verification if we used a known-correct slug.
  const url = page.url();
  ctx.log('dining_landed', { url });
  let needSearch = !url.includes('/r/') || url.includes('search');
  if (!needSearch && !slugWasCorrected) {
    // Verify the page title contains the restaurant name (only for guessed slugs)
    try {
      const title = await page.title().catch(() => '');
      const pageText = await page.$eval('h1', el => el.textContent).catch(() => '');
      const restaurantLower = restaurant.toLowerCase();
      if (!title.toLowerCase().includes(restaurantLower.split(' ')[0]) && 
          !pageText.toLowerCase().includes(restaurantLower.split(' ')[0])) {
        ctx.log('dining_wrong_restaurant', { title, pageText: pageText.slice(0, 100) });
        needSearch = true;
      }
    } catch { /* proceed */ }
  }
  if (needSearch) {
    await page.goto(OPENTABLE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await dismissCookies(page);
    // OpenTable homepage search input: #home-autocomplete-input
    // Placeholder: "Location, Restaurant, or Cuisine"
    const searchInput = await page.$('#home-autocomplete-input, input[data-test="search-autocomplete-input"], input[placeholder="Location, Restaurant, or Cuisine"]').catch(() => null);
    if (!searchInput) {
      return { ok: false, code: 'search_not_found', note: 'Could not find OpenTable search. Nothing was booked.' };
    }
    await searchInput.fill(restaurant, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const firstResult = await page.$('a[href*="/r/"]').catch(() => null);
    if (!firstResult) {
      return { ok: false, code: 'not_found', note: `Restaurant "${restaurant}" not found on OpenTable. Nothing was booked.` };
    }
    await firstResult.click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  ctx.log('dining_restaurant_page', { url: page.url() });

  // Find available time slots. OpenTable shows them as <a role="button"> inside
  // ul[data-test="time-slots"]. IMPORTANT: the container renders BEFORE its
  // slot links do, so waiting for the container alone is not enough — poll
  // for actual slot links (bounded), otherwise we falsely report no_availability.
  // The URL already has ?covers=4&dateTime=... so slots should be filtered.
  // Look for time slot links - OpenTable uses <a role="button"> not <button>
  // Container: ul[data-test="time-slots"], slots: a[role="button"] with aria-label
  // Format: "Reserve table at {Restaurant} at {TIME} on {Month Day}, for a party of {N}"
  const slotSelectors = [
    'ul[data-test="time-slots"] a[role="button"]',
    '[data-testid="time-slots"] a[role="button"]',
    'ul[data-test="time-slots"] a',
    '[data-test="time-slots"] a',
  ];

  let slotButtons = [];
  const scanDeadline = Date.now() + 15000;
  while (!slotButtons.length && Date.now() < scanDeadline) {
    for (const sel of slotSelectors) {
      try {
        const els = await page.$$(sel).catch(() => []);
        if (els.length) { slotButtons = els; break; }
      } catch { /* next */ }
    }
    if (!slotButtons.length) await page.waitForTimeout(1500);
  }
  ctx.log('dining_slots_found', { count: slotButtons.length });

  if (!slotButtons.length) {
    return {
      ok: false,
      code: 'no_availability',
      note: `No available time slots found at ${restaurant} for ${partySize} on ${date}. The restaurant may be fully booked or not taking reservations for that date. Nothing was booked.`,
    };
  }

  // Collect all available slot times for honest reporting (deduplicated)
  const availableTimes = [];
  const seenTimes = new Set();
  for (const btn of slotButtons) {
    try {
      const text = (await btn.textContent().catch(() => '') || '').trim();
      const m = text.match(/(\d+:\d+\s*(?:AM|PM))/i);
      if (m && !seenTimes.has(m[1])) {
        seenTimes.add(m[1]);
        availableTimes.push(m[1]);
      }
    } catch { /* next */ }
  }
  ctx.log('dining_available_times', { availableTimes });

  // REQUIRE EXACT TIME MATCH — never silently book a nearby time.
  // If the exact requested time is not available, report what IS available.
  let targetButton = null;
  if (time) {
    const [rh, rm] = time.split(':').map(Number);
    const targetMin = rh * 60 + rm;
    for (const btn of slotButtons) {
      try {
        const text = (await btn.textContent().catch(() => '') || '').trim();
        const m = text.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (m) {
          let h = parseInt(m[1]);
          const min = parseInt(m[2]);
          const ap = m[3].toUpperCase();
          if (ap === 'PM' && h !== 12) h += 12;
          if (ap === 'AM' && h === 12) h = 0;
          const slotMin = h * 60 + min;
          if (slotMin === targetMin) { targetButton = btn; break; }
        }
      } catch { /* next */ }
    }
    if (!targetButton) {
      // Exact time not available — report honestly, do NOT book a different time
      const timeStr = availableTimes.length ? availableTimes.join(', ') : 'none shown';
      return {
        ok: false,
        code: 'time_unavailable',
        note: `The requested time is not available at ${restaurant} for ${partySize} on ${date}. Available times: ${timeStr}. Nothing was booked. Please approve a different time to proceed.`,
        availableTimes,
      };
    }
    ctx.log('dining_slot_exact_match', { time });
  } else {
    targetButton = slotButtons[0];
  }

  const pickedText = (await targetButton.textContent().catch(() => '') || '').trim();
  ctx.log('dining_slot_click', { text: pickedText });
  await targetButton.click({ timeout: 15000 }).catch(() => {});

  // Wait for the booking details page. OpenTable can be slow here (a prior
  // run needed ~30s for the form to render), so allow a generous bounded wait.
  ctx.log('dining_details_wait_start', { url: page.url() });
  let detailsReady = false;
  try {
    await page.waitForSelector(DETAILS_FORM_SEL, { timeout: 35000 });
    detailsReady = true;
  } catch { /* fall through to URL check */ }
  if (!detailsReady) {
    const u = page.url();
    detailsReady = /booking/i.test(u);
    if (detailsReady) {
      // On the booking page but the form isn't up yet — one more bounded wait.
      try {
        await page.waitForSelector(DETAILS_FORM_SEL, { timeout: 15000 });
        detailsReady = true;
      } catch { /* give up */ }
    }
    ctx.log('dining_details_page_check', { url: u, detailsReady });
  } else {
    ctx.log('dining_details_page_check', { url: page.url(), detailsReady });
  }
  if (!detailsReady) {
    return { ok: false, code: 'details_page_timeout', note: 'Selected the time slot but the booking details page did not load in time. Nothing was booked — please try again.' };
  }

  ctx.log('dining_phase1_done', { pickedText });
  // need_approval + sessionId: the approval path auto-continues into phase 2
  // with booking_approved=true. The user already approved via the card.
  return {
    ok: true,
    phase: 'need_approval',
    summary: { restaurant, date, time: pickedText || time, partySize },
    note: `Slot selected at ${restaurant} (${pickedText || time}); continuing to guest details.`,
  };
}

// Phase 2: resume the live session's details page, fill guest info, confirm,
// and extract the confirmation reference.
async function phase2FillAndConfirm(ctx, job) {
  const page = ctx.page;
  const { restaurant, date, time, partySize } = job;

  ctx.log('dining_phase2_start', { url: page.url() });

  const { email, phone, name } = await getCreds(ctx, job);
  const nameParts = name.split(' ');
  const firstName = nameParts[0] || 'Demo';
  const lastName = nameParts.slice(1).join(' ') || 'User';

  // The details page should be open from phase 1 — wait for the form.
  try {
    await page.waitForSelector(DETAILS_FORM_SEL, { timeout: 30000 });
  } catch {
    return { ok: false, code: 'details_form_missing', note: 'The booking details page did not load after selecting the slot. Nothing was booked — please try again.' };
  }
  await dismissCookies(page);
  ctx.log('dining_details_page_ready', { url: page.url() });

  // Fill first name, last name, email, phone
  const fillField = async (selectors, value) => {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel).catch(() => null);
        if (el) {
          await el.fill(value).catch(() => {});
          await page.waitForTimeout(100);
          return true;
        }
      } catch { /* next */ }
    }
    return false;
  };

  await fillField(['input#firstName', 'input[name="firstName"]', 'input[placeholder*="First name" i]'], firstName);
  await fillField(['input#lastName', 'input[name="lastName"]', 'input[placeholder*="Last name" i]'], lastName);
  await fillField(['input#email', 'input[name="email"]', 'input[type="email"]'], email);
  await fillField(['input#phoneNumber', 'input[name="phone"]', 'input[type="tel"]'], phone);

  ctx.log('dining_details_filled', { email });

  // Uncheck marketing opt-ins if present (bounded — never hang here)
  for (const sel of ['input[type="checkbox"]']) {
    try {
      const boxes = await page.$$(sel).catch(() => []);
      for (const box of boxes) {
        const checked = await box.isChecked().catch(() => false);
        if (checked) await box.uncheck({ timeout: 10000 }).catch(() => {});
      }
    } catch { /* next */ }
  }

  // Click the final confirmation button (bounded)
  const confirmSelectors = [
    'button:has-text("Complete reservation")',
    'button:has-text("Book now")',
    'button:has-text("Confirm")',
    'button[type="submit"]',
  ];
  let confirmed = false;
  for (const sel of confirmSelectors) {
    try {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        const visible = await btn.isVisible().catch(() => false);
        if (visible) {
          await btn.click({ timeout: 15000 }).catch(() => {});
          confirmed = true;
          ctx.log('dining_confirm_clicked', { selector: sel });
          break;
        }
      }
    } catch { /* next */ }
  }

  if (!confirmed) {
    return { ok: false, code: 'confirm_not_found', note: 'Could not find the reservation confirmation button. Nothing was booked.' };
  }

  // Wait for the confirmation to render (bounded — the click may trigger a
  // slow navigation; never wait forever).
  await page.waitForFunction(
    () => /confirmed|reservation complete|you're booked|booking confirmed/i.test(document.body ? document.body.innerText : ''),
    { timeout: 25000 }
  ).catch(() => {});
  ctx.log('dining_confirm_wait_done', { url: page.url() });

  // Extract confirmation (each read bounded so extraction can never hang
  // the phase the way the last attempt did).
  const withTimeout = (p, ms, label) => Promise.race([
    Promise.resolve(p),
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || 'extract_timeout')), ms)),
  ]);
  const pageText = await withTimeout(page.content().catch(() => ''), 15000, 'content_timeout').catch(() => '');
  const text = await withTimeout(page.$eval('body', el => el.innerText).catch(() => ''), 15000, 'innerText_timeout').catch(() => '');

  // Look for confirmation number
  const confMatch = text.match(/confirmation\s*(?:number|#|code)?\s*:?\s*([A-Z0-9-]{6,})/i) ||
                    pageText.match(/confirmation[^<]{0,50}([A-Z0-9-]{8,})/i);

  const isConfirmed = /confirmed|reservation complete|you're booked|booking confirmed/i.test(text);

  if (isConfirmed || confMatch) {
    const ref = confMatch ? confMatch[1] : 'CONFIRMED';
    ctx.log('dining_booked', { ref });
    return {
      ok: true,
      phase: 'done',
      confirmationRef: ref,
      restaurant,
      date,
      time: time,
      partySize,
      note: `Booked ${restaurant} for ${partySize} on ${date} at ${time}. Confirmation: ${ref}`,
    };
  }

  // Check if we're still on the form (failed) or on a confirmation page
  ctx.log('dining_unclear', { url: page.url(), textSnippet: text.slice(0, 300) });
  return {
    ok: false,
    code: 'confirmation_unclear',
    note: `Clicked confirm but could not verify the booking completed. Page shows: ${text.slice(0, 200)}. Please check your email for a confirmation.`,
  };
}

async function changeBooking(ctx, job) {
  return { ok: false, code: 'not_implemented', note: 'Reservation change not yet implemented.' };
}

async function cancelBooking(ctx, job) {
  return { ok: false, code: 'not_implemented', note: 'Reservation cancellation not yet implemented.' };
}

module.exports = {
  'book-table': bookTable,
  'change-booking': changeBooking,
  'cancel-booking': cancelBooking,
};
