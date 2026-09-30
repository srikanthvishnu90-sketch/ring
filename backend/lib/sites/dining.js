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
    // OpenTable also renders the strip as <button>s (observed 2026-09-30).
    'ul[data-test="time-slots"] button',
    '[data-test="time-slots"] button',
    '[data-testid="time-slots"] button',
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
    // Diagnose: did the strip render at all? Distinguish three cases:
    // (a) markup renamed (slot text present, selectors wrong),
    // (b) bot-degraded page (no slot text anywhere),
    // (c) genuine no-availability (page says so in text).
    const stripDiag = await page.evaluate(() => {
      const cands = [
        document.querySelector('ul[data-test="time-slots"]'),
        document.querySelector('[data-test="time-slots"]'),
        document.querySelector('[data-testid="time-slots"]'),
      ];
      const el = cands.find(Boolean);
      const bodyText = (document.body ? document.body.innerText : '').slice(0, 600);
      // Any element anywhere whose text looks like a reservable time slot?
      const timeLike = Array.from(document.querySelectorAll('a,button')).filter((n) => {
        const t = (n.textContent || '').trim();
        return /reserve table at/i.test(t) || /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(t);
      }).length;
      return {
        strip: el ? 'present' : 'absent',
        tag: el ? el.tagName : undefined,
        childCount: el ? el.children.length : undefined,
        timeLikeElsewhere: timeLike,
        title: document.title,
        bodyText,
      };
    }).catch(() => ({ strip: 'eval_failed' }));
    ctx.log('dining_slots_zero_diag', stripDiag);
  }

  // OpenTable renders hidden duplicate slot elements (carousel clones). A
  // hidden element can never be clicked — filter to visible slots only before
  // matching text or clicking. (A prior attempt grabbed a hidden "10:00 PM"
  // clone: visible=false, box=null, and every click silently failed.)
  const visibleButtons = [];
  for (const b of slotButtons) {
    try {
      if (await b.isVisible().catch(() => false)) visibleButtons.push(b);
    } catch { /* skip */ }
  }
  ctx.log('dining_slots_visible', { visible: visibleButtons.length, total: slotButtons.length });
  slotButtons = visibleButtons.length ? visibleButtons : slotButtons;

  if (!slotButtons.length) {
    // Blocked by the site's bot protection? Report honestly — never disguise
    // an access-denied page as "no availability".
    const d = stripDiag || {};
    const denied = /access denied/i.test(d.title || '') ||
      /you don't have permission to access/i.test(d.bodyText || '');
    if (denied) {
      return {
        ok: false,
        code: 'site_blocked',
        note: `OpenTable blocked the booking browser with an "Access Denied" page, so availability could not be checked at ${restaurant} for ${partySize} on ${date}. This is the site's bot protection, not a sold-out restaurant. Nothing was booked. Please try again later.`,
      };
    }
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
  // Re-query a fresh handle before clicking: the scanned handle may be stale
  // if OpenTable re-rendered the slot list, and a stale/non-actionable click
  // silently does nothing (the last attempt burned its whole click timeout
  // with no navigation). Scroll into view, click, then VERIFY navigation.
  const beforeUrl = page.url();
  let clicked = false;
  let clickMethod = 'none';
  for (let attempt = 0; attempt < 2 && !clicked; attempt++) {
    // Pick the first VISIBLE match: hidden duplicates (carousel clones) can
    // never receive a click. Fall back to the scanned handle only if no
    // visible candidate exists.
    const candidates = await page.$$(`ul[data-test="time-slots"] a[role="button"]:has-text("${pickedText}"), ul[data-test="time-slots"] button:has-text("${pickedText}"), [data-test="time-slots"] button:has-text("${pickedText}")`).catch(() => []);
    let el = null;
    for (const c of candidates) {
      try {
        if (await c.isVisible().catch(() => false)) { el = c; break; }
      } catch { /* next candidate */ }
    }
    el = el || targetButton;
    // Diagnose actionability on the first attempt: log visibility, geometry,
    // and which element actually sits at the click point (an overlay covering
    // the slot is the prime suspect when clicks never dispatch).
    if (attempt === 0) {
      const box = await el.boundingBox().catch(() => null);
      const visible = await el.isVisible().catch(() => false);
      const enabled = await el.isEnabled().catch(() => false);
      let topEl = 'n/a';
      if (box) {
        topEl = await page.evaluate(([x, y]) => {
          const e = document.elementFromPoint(x, y);
          if (!e) return 'none';
          let cls = '';
          try { cls = typeof e.className === 'string' ? e.className : ''; } catch { /* ignore */ }
          return e.tagName + (cls ? '.' + cls.slice(0, 60) : '') + '|' + (e.textContent || '').trim().slice(0, 50);
        }, [box.x + box.width / 2, box.y + box.height / 2]).catch(() => 'eval-failed');
      }
      ctx.log('dining_slot_state', { visible, enabled, box, topEl });
    }
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await el.click({ timeout: 10000 });
      clicked = true; clickMethod = 'click';
    } catch {
      // Fallback 1: keyboard activation (works when the slot is focusable but
      // pointer-hit-testing fails).
      try {
        await el.focus({ timeout: 3000 }).catch(() => {});
        await page.keyboard.press('Enter');
        clicked = true; clickMethod = 'enter';
      } catch { /* fallback 2 */ }
      // Fallback 2: dispatch the click event directly on the element,
      // bypassing hit-testing entirely. The slot is a JS-driven
      // <a role="button"> (no href), so its handler runs on the event.
      if (!clicked) {
        try {
          await el.dispatchEvent('click');
          clicked = true; clickMethod = 'dispatch';
        } catch { /* retry loop */ }
      }
    }
    // A dispatched click that doesn't navigate didn't work — retry.
    if (clicked) {
      await page.waitForTimeout(2000);
      if (page.url() === beforeUrl) {
        ctx.log('dining_click_no_nav', { method: clickMethod });
        clicked = false;
      }
    }
    if (!clicked) await page.waitForTimeout(1000);
  }
  ctx.log('dining_slot_clicked', { clicked, method: clickMethod, url: page.url() });
  if (!clicked) {
    return { ok: false, code: 'slot_click_failed', note: 'Selected the time slot but the page did not move to booking. Nothing was booked — please try again.' };
  }

  // The click must navigate away from the restaurant page. If the URL never
  // changes, the click didn't take — fail fast instead of waiting on a page
  // that will never load the booking form.
  try {
    await page.waitForFunction((u) => window.location.href !== u, beforeUrl, { timeout: 10000 }).catch(() => null);
  } catch { /* fall through */ }
  const afterClickUrl = page.url();
  const navigated = afterClickUrl !== beforeUrl;
  ctx.log('dining_after_click', { navigated, url: afterClickUrl });
  if (!navigated) {
    return { ok: false, code: 'slot_click_failed', note: 'Selected the time slot but the page did not move to booking. Nothing was booked — please try again.' };
  }

  // Best-effort: note whether the details form is already up. Phase 2 waits
  // for the form with its own budget, so don't burn phase 1's budget here.
  let formUp = false;
  try {
    await page.waitForSelector(DETAILS_FORM_SEL, { timeout: 10000 });
    formUp = true;
  } catch { /* phase 2 will wait */ }

  ctx.log('dining_phase1_done', { pickedText, formUp, url: page.url() });
  // need_approval + sessionId: the approval path auto-continues into phase 2
  // with booking_approved=true. The user already approved via the card.
  return {
    ok: true,
    phase: 'need_approval',
    summary: { restaurant, date, time: pickedText || time, partySize },
    note: `Slot selected at ${restaurant} (${pickedText || time}); continuing to guest details.`,
  };
}

// Marketing-only opt-out (label-aware): uncheck marketing opt-in checkboxes.
// Never touch anything else — no terms, policies, deposits, or transactional
// prefs are ever changed automatically.
async function marketingOptOut(page, ctx) {
  const marketingRe = /opt.?in.?email|newsletter|offers|promotions|marketing|\bdeals\b|news from this restaurant/i;
  try {
    const boxes = await page.$$('input[type="checkbox"]').catch(() => []);
    for (const box of boxes) {
      let id = '';
      try {
        id = [
          await box.getAttribute('id').catch(() => ''),
          await box.getAttribute('name').catch(() => ''),
          await box.getAttribute('value').catch(() => ''),
        ].filter(Boolean).join(' ');
      } catch { /* ignore */ }
      if (!marketingRe.test(id)) continue;
      const checked = await box.isChecked().catch(() => false);
      if (checked) {
        await box.uncheck({ timeout: 10000 }).catch(() => {});
        ctx.log('dining_optout', { id: id.slice(0, 60) });
      }
    }
  } catch { /* best effort */ }
}

// Fill guest details wherever the inputs exist (page or modal dialog).
async function fillGuestForm(page, { firstName, lastName, email, phone }) {
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
  return {
    first: await fillField(['input#firstName', 'input[name="firstName"]', 'input[placeholder*="First name" i]'], firstName),
    last: await fillField(['input#lastName', 'input[name="lastName"]', 'input[placeholder*="Last name" i]'], lastName),
    email: await fillField(['input#email', 'input[name="email"]', 'input[type="email"]'], email),
    phone: await fillField(['input#phoneNumber', 'input[name="phone"]', 'input[type="tel"]', 'input[placeholder*="Phone" i]'], phone),
  };
}

// Compact state probe after clicking Complete reservation.
async function probeAfterComplete(page) {
  return page.evaluate(() => {
    const body = document.body ? document.body.innerText : '';
    const test = (re) => re.test(body);
    let dialogText = 'none';
    try {
      const d = document.querySelector('[role="dialog"]');
      if (d && d.innerText) dialogText = d.innerText.slice(0, 300);
    } catch { /* ignore */ }
    let completeBtn = 'absent';
    try {
      const b = document.querySelector('#complete-reservation, button[data-test="complete-reservation-button"]');
      if (b) completeBtn = b.disabled ? 'disabled' : 'enabled';
    } catch { /* ignore */ }
    return {
      url: location.href,
      isConfirmed: test(/confirmed|reservation complete|you're booked|booking confirmed/i),
      hasGuestForm: test(/first name/i),
      hasSignIn: test(/sign in|log in|create an account/i),
      hasOtp: test(/verification code|enter the (code|verification)|one-time pass/i),
      hasError: test(/no longer available|no longer valid|expired|something went wrong|not available/i),
      dialogText,
      completeBtn,
      buttons: Array.from(document.querySelectorAll('button'))
        .map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 6).join('|').slice(0, 120),
    };
  }).catch(() => ({ evalFailed: true }));
}

// Extract the provider's confirmation reference. Strict: a real confirmation
// identifier is required — page text alone is not proof of booking.
async function extractConfirmation(page, ctx, { restaurant, date, time, partySize }) {
  const withTimeout = (p, ms, label) => Promise.race([
    Promise.resolve(p),
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || 'extract_timeout')), ms)),
  ]);
  const pageText = await withTimeout(page.content().catch(() => ''), 15000, 'content_timeout').catch(() => '');
  const text = await withTimeout(page.$eval('body', (el) => el.innerText).catch(() => ''), 15000, 'innerText_timeout').catch(() => '');

  const confMatch = text.match(/confirmation\s*(?:number|#|code)?\s*:?\s*([A-Z0-9-]{6,})/i) ||
                    pageText.match(/confirmation[^<]{0,50}([A-Z0-9-]{8,})/i);
  const isConfirmed = /confirmed|reservation complete|you're booked|booking confirmed/i.test(text);

  if (confMatch) {
    const ref = confMatch[1];
    ctx.log('dining_booked', { ref });
    return {
      ok: true,
      phase: 'done',
      confirmationRef: ref,
      restaurant,
      date,
      time,
      partySize,
      note: `Booked ${restaurant} for ${partySize} on ${date} at ${time}. Confirmation: ${ref}`,
    };
  }
  if (isConfirmed) {
    // The page claims confirmation but no reference could be extracted —
    // honest: do not report booked without the identifier.
    ctx.log('dining_confirm_no_ref', { url: page.url(), textSnippet: text.slice(0, 200) });
    return {
      ok: false,
      code: 'confirmation_unverified',
      note: 'The page indicates a reservation may have been created but no confirmation number could be read. Please check your email for the confirmation before treating this as booked.',
    };
  }
  ctx.log('dining_unclear', { url: page.url(), textSnippet: text.slice(0, 300) });
  return {
    ok: false,
    code: 'confirmation_unclear',
    note: `Clicked confirm but could not verify the booking completed. Page shows: ${text.slice(0, 200)}. Please check your email for a confirmation.`,
  };
}

// Phase 2: resume the live session's details page and complete the booking.
// OpenTable serves two layouts: (A) legacy guest-details form on the page,
// (B) summary + "Complete reservation" with the guest form (or a sign-in
// wall) appearing only after the click. Both are handled.
async function phase2FillAndConfirm(ctx, job) {
  const page = ctx.page;
  const { restaurant, date, time, partySize } = job;

  ctx.log('dining_phase2_start', { url: page.url() });

  const { email, phone, name } = await getCreds(ctx, job);
  const nameParts = String(name || '').split(' ');
  const guest = {
    firstName: nameParts[0] || 'Demo',
    lastName: nameParts.slice(1).join(' ') || 'User',
    email,
    phone,
  };

  await dismissCookies(page);

  // Detect which booking-page layout OpenTable served (bounded).
  let layout = 'unknown';
  try {
    await page.waitForSelector(DETAILS_FORM_SEL, { timeout: 15000 });
    layout = 'guest_form';
  } catch { /* detect layout B */ }
  if (layout === 'unknown') {
    try {
      const btn = await page.$('button#complete-reservation, button[data-test="complete-reservation-button"]');
      if (btn && await btn.isVisible().catch(() => false)) layout = 'complete_first';
    } catch { /* unknown */ }
  }
  ctx.log('dining_phase2_layout', { layout, url: page.url() });
  if (layout === 'unknown') {
    return { ok: false, code: 'details_form_missing', note: 'The booking details page did not load after selecting the slot. Nothing was booked — please try again.' };
  }

  // Marketing opt-out only (label-aware — never blanket uncheck).
  await marketingOptOut(page, ctx);

  if (layout === 'guest_form') {
    const got = await fillGuestForm(page, guest);
    ctx.log('dining_details_filled', { ...got, email });
  }

  // Click the final confirmation button (bounded).
  const confirmSelectors = [
    '#complete-reservation',
    'button[data-test="complete-reservation-button"]',
    'button:has-text("Complete reservation")',
    'button:has-text("Book now")',
    'button[type="submit"]',
  ];
  const clickComplete = async () => {
    for (const sel of confirmSelectors) {
      try {
        const btn = await page.$(sel).catch(() => null);
        if (btn && await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 15000 }).catch(() => {});
          ctx.log('dining_confirm_clicked', { selector: sel, layout });
          return true;
        }
      } catch { /* next */ }
    }
    return false;
  };
  if (!await clickComplete()) {
    return { ok: false, code: 'confirm_not_found', note: 'Could not find the reservation confirmation button. Nothing was booked.' };
  }

  // Observe what OpenTable does after the click: poll a few times (bounded)
  // because the confirmation can render well after the click resolves.
  // Also watch for a popup tab (sign-in or confirmation opening elsewhere).
  let after = { evalFailed: true };
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(i === 0 ? 8000 : 10000);
    try {
      const pages = page.context ? page.context().pages() : [];
      if (pages.length > 1) {
        ctx.log('dining_popup_pages', { count: pages.length, urls: pages.map((p) => { try { return p.url().slice(0, 80); } catch { return '?'; } }) });
      }
    } catch { /* ignore */ }
    after = await probeAfterComplete(page);
    ctx.log('dining_after_complete_probe', { attempt: i + 1, ...after });
    if (after.isConfirmed || after.hasSignIn || after.hasOtp || after.hasError || after.hasGuestForm) break;
  }

  // Layout B may reveal a guest-details form in a dialog — fill it and
  // confirm once more.
  if (!after.isConfirmed && after.hasGuestForm && !after.hasSignIn && !after.hasOtp) {
    const got = await fillGuestForm(page, guest);
    ctx.log('dining_modal_form_filled', { ...got });
    await marketingOptOut(page, ctx);
    await clickComplete();
    await page.waitForTimeout(8000);
    after = await probeAfterComplete(page);
    ctx.log('dining_after_complete_probe2', after);
  }

  if (after.isConfirmed) {
    return extractConfirmation(page, ctx, { restaurant, date, time, partySize });
  }
  if (after.hasSignIn || after.hasOtp) {
    return {
      ok: false,
      code: 'signin_required',
      note: `OpenTable is asking the booker to ${after.hasOtp ? 'enter a verification code' : 'sign in to OpenTable'} before completing this reservation — that step needs you, so Ring stopped. Nothing was booked.`,
    };
  }
  if (after.hasError) {
    return { ok: false, code: 'provider_error', note: `OpenTable reported a problem completing the reservation (${String(after.dialogText || '').slice(0, 120)}). Nothing was booked.` };
  }
  return {
    ok: false,
    code: 'confirmation_unclear',
    note: `Clicked Complete reservation but OpenTable did not confirm the booking. Page state: ${String(after.dialogText || 'no dialog').slice(0, 160)}. Nothing was booked — please try again.`,
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
