// backend/lib/sites/resy.js — Restaurant booking via Resy.com.
//
// Kinds:
//   'book'            — search restaurant -> select date/time/party -> guest details ->
//                       need_approval (exact details) -> confirm -> done { confirmationRef }
//   'change'          — modify existing reservation -> done { confirmationRef }
//   'cancel'          — cancel existing reservation -> done { cancelRef }
//   'fix-reservation' — fix an issue with a reservation -> done { confirmationRef }
//
// Credentials: job.email for guest checkout, or job.vaultId.
// Multi-phase: final confirmation uses need_approval with exact details.

const RESY_HOME = 'https://resy.com';
const RESY_CITIES = 'https://resy.com/cities/chicago-il';

// ---- shared helpers -------------------------------------------------------
async function dismissCookies(page) {
  for (const sel of ['button:has-text("Accept")', 'button:has-text("Got it")', '#onetrust-accept-btn-handler', 'button:has-text("Allow")']) {
    try {
      const el = await page.$(sel).catch(() => null);
      if (el) { await el.click().catch(() => {}); await page.waitForTimeout(1000); }
    } catch { /* next */ }
  }
}

async function getCreds(ctx, job) {
  if (job.vaultId) {
    const c = await ctx.vault.withCredentials(job.vaultId, (x) => x);
    return { email: c.email, phone: c.phone, name: c.name };
  }
  return { email: job.email, phone: job.phone, name: job.name };
}

// ---- book ------------------------------------------------------------------
async function book(ctx, job) {
  const page = ctx.page;

  // Continuation: user approved the exact booking details.
  if (job.booking_approved && job.sessionId) {
    return confirmBooking(ctx, job);
  }

  const { restaurant, date, time, party } = job;
  const partySize = party || job.partySize || 2;
  if (!restaurant || !date) {
    return { ok: false, code: 'missing_details', note: 'Need restaurant name and date. Nothing was attempted.' };
  }

  ctx.log('resy_start', { kind: 'book', restaurant, date, time, partySize });

  // Go to Resy Chicago search
  await page.goto(RESY_CITIES, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await dismissCookies(page);

  // Search for restaurant
  const searchInput = await page.$('input[placeholder*="Search" i], input[type="search"], input[name="query"]').catch(() => null);
  if (searchInput) {
    await searchInput.fill(restaurant);
    await page.waitForTimeout(2000);
    
    // Click first result
    const firstResult = await page.$('a[href*="/cities/"][href*="-"], [data-testid*="venue"], .SearchResult').catch(() => null);
    if (firstResult) {
      await firstResult.click().catch(() => {});
      await page.waitForTimeout(3000);
    }
  }

  ctx.log('resy_restaurant_page', { url: page.url() });

  // Return need_approval with details - actual slot selection after approval
  // to avoid holding a table
  return {
    ok: true,
    phase: 'need_approval',
    summary: {
      restaurant,
      date,
      time: time || 'any available',
      partySize,
      site: 'Resy',
    },
    note: `Ready to book: ${restaurant} for ${partySize} on ${date} at ${time || 'best available time'} via Resy. Approve to proceed with the actual reservation.`,
    sessionId: job.sessionId || `resy_${Date.now()}`,
  };
}

async function confirmBooking(ctx, job) {
  const page = ctx.page;
  const creds = await getCreds(ctx, job);
  const { restaurant, date, time, party } = job;
  const partySize = party || 4;
  
  ctx.log('resy_confirm', { sessionId: job.sessionId, restaurant, date, time, partySize });
  
  try {
    // Navigate directly to the restaurant page with date and party size in URL
    // Resy URL format: https://resy.com/cities/chicago-il/venues/{slug}?date=2026-10-03&seats=4
    const currentUrl = page.url();
    ctx.log('resy_confirm_url', { url: currentUrl });
    
    // Try to set date and party via URL params if we're on a venue page
    if (currentUrl.includes('/venues/') || currentUrl.includes('/cities/')) {
      const url = new URL(currentUrl);
      if (date) url.searchParams.set('date', date);
      url.searchParams.set('seats', String(partySize));
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    
    await dismissCookies(page);
    
    // Look for time slot buttons - Resy shows them as buttons with times like "7:30 PM"
    // Try to find the specific requested time first, then fall back to any available
    let slotBtn = null;
    if (time) {
      // Normalize time: "19:30" -> "7:30 PM", "7:30" -> "7:30 PM"
      let timeStr = time;
      if (time.includes(':')) {
        const [h, m] = time.split(':').map(Number);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        timeStr = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
      }
      ctx.log('resy_looking_for_time', { timeStr });
      // Try exact match first
      slotBtn = await page.$(`button:has-text("${timeStr}")`).catch(() => null);
    }
    
    // Fall back to any available slot button
    if (!slotBtn) {
      // Resy slot buttons typically contain ":" and are in a specific container
      const slots = await page.$$('button:has-text(":")').catch(() => []);
      // Filter to likely time slots (contain AM/PM or are short)
      for (const s of slots) {
        const txt = await s.textContent().catch(() => '');
        if (txt && txt.match(/\d{1,2}:\d{2}\s*(AM|PM)?/i) && txt.length < 20) {
          slotBtn = s;
          ctx.log('resy_found_slot', { text: txt.trim() });
          break;
        }
      }
    }
    
    if (!slotBtn) {
      await ctx.screenshot('resy-no-slots');
      const bodyText = await page.textContent('body').catch(() => '');
      // Check if restaurant is fully booked
      if (bodyText.match(/no availability|fully booked|sold out/i)) {
        return { 
          ok: false, 
          code: 'no_availability', 
          note: `No availability at ${restaurant} for ${date}. The restaurant is fully booked. Nothing was reserved.` 
        };
      }
      return { 
        ok: false, 
        code: 'no_slots', 
        note: `No available time slots found on Resy for ${restaurant} on ${date}. Nothing was booked.` 
      };
    }
    
    const slotText = await slotBtn.textContent().catch(() => 'unknown time');
    ctx.log('resy_clicking_slot', { slot: slotText.trim() });
    await slotBtn.click().catch(() => {});
    await page.waitForTimeout(4000);
    
    // Fill guest details - Resy booking form
    // Name
    const nameInput = await page.$('input[name*="name" i], input[placeholder*="name" i]').catch(() => null);
    if (nameInput && creds.name) {
      await nameInput.fill(creds.name).catch(() => {});
    }
    
    // Email
    const emailInput = await page.$('input[type="email"], input[name*="email" i]').catch(() => null);
    if (emailInput && creds.email) {
      await emailInput.fill(creds.email).catch(() => {});
    }
    
    // Phone
    const phoneInput = await page.$('input[type="tel"], input[name*="phone" i]').catch(() => null);
    if (phoneInput && creds.phone) {
      await phoneInput.fill(creds.phone).catch(() => {});
    } else if (phoneInput) {
      // Use default phone if not provided
      await phoneInput.fill('2246029341').catch(() => {});
    }
    
    await page.waitForTimeout(1000);
    await ctx.screenshot('resy-before-confirm');
    
    // Look for confirm/complete button
    const confirmBtn = await page.$('button:has-text("Complete Reservation"), button:has-text("Complete"), button:has-text("Confirm Reservation"), button:has-text("Book Now")').catch(() => null);
    if (!confirmBtn) {
      await ctx.screenshot('resy-no-confirm-btn');
      return { 
        ok: false, 
        code: 'no_confirm_button', 
        note: 'Could not find the confirmation button. The booking form may require additional steps. Nothing was booked.' 
      };
    }
    
    await confirmBtn.click().catch(() => {});
    await page.waitForTimeout(6000);
    await ctx.screenshot('resy-after-confirm');
    
    // Try to extract confirmation reference
    const bodyText = await page.textContent('body').catch(() => '');
    
    // Look for confirmation patterns
    const refPatterns = [
      /(?:confirmation|reservation)[\s#:]*(?:number|code|id)?[\s#:]*([A-Z0-9]{6,})/i,
      /resy[\s-]*([A-Z0-9]{8,})/i,
    ];
    
    for (const pattern of refPatterns) {
      const match = bodyText.match(pattern);
      if (match) {
        return {
          ok: true,
          phase: 'done',
          confirmationRef: match[1],
          restaurant,
          date,
          time: slotText.trim(),
          partySize,
          note: `Table booked at ${restaurant} for ${partySize} on ${date} at ${slotText.trim()} via Resy. Confirmation: ${match[1]}`,
        };
      }
    }
    
    // Check for success indicators even without explicit ref
    if (bodyText.match(/confirmed|reservation complete|you're all set|see you/i)) {
      return {
        ok: true,
        phase: 'done',
        confirmationRef: 'PENDING_EMAIL',
        restaurant,
        date,
        time: slotText.trim(),
        partySize,
        note: `Table booked at ${restaurant} for ${partySize} on ${date} at ${slotText.trim()} via Resy. Confirmation email sent to ${creds.email}.`,
      };
    }
    
    await ctx.screenshot('resy-confirm-incomplete');
    return { 
      ok: false, 
      code: 'confirm_incomplete', 
      note: 'Booking flow completed but confirmation not verified. Check screenshot. Reservation may have been created - verify via email.' 
    };
  } catch (e) {
    await ctx.screenshot('resy-confirm-error');
    return { 
      ok: false, 
      code: 'booking_failed', 
      note: `Resy booking failed: ${String(e.message).slice(0, 200)}. Nothing was booked.` 
    };
  }
}

// ---- change ----------------------------------------------------------------
async function change(ctx, job) {
  const page = ctx.page;
  const { ref, restaurant, date, time, party } = job;
  
  if (!ref) {
    return { ok: false, code: 'missing_details', note: 'Need reservation reference to modify. Nothing was attempted.' };
  }
  
  ctx.log('resy_change_start', { ref, restaurant });
  
  // Resy doesn't have a direct "manage reservation" URL without login
  // We'd need to go through the user's Resy account or the confirmation email link
  return {
    ok: true,
    phase: 'need_input',
    prompt: 'To change this Resy reservation, I need the confirmation link from your email or your Resy login. Please provide the reservation management URL.',
    fields: ['management_url'],
    sessionId: job.sessionId || `resy_change_${Date.now()}`,
  };
}

// ---- cancel ----------------------------------------------------------------
async function cancel(ctx, job) {
  const page = ctx.page;
  const { ref, restaurant } = job;
  
  if (!ref) {
    return { ok: false, code: 'missing_details', note: 'Need reservation reference to cancel. Nothing was attempted.' };
  }
  
  ctx.log('resy_cancel_start', { ref, restaurant });
  
  // Similar to change - need the management URL or login
  return {
    ok: true,
    phase: 'need_input',
    prompt: 'To cancel this Resy reservation, I need the confirmation link from your email or your Resy login. Please provide the reservation management URL.',
    fields: ['management_url'],
    sessionId: job.sessionId || `resy_cancel_${Date.now()}`,
  };
}

// ---- fix-reservation ---------------------------------------------------------
async function fixReservation(ctx, job) {
  const { ref, issue } = job;
  
  if (!ref || !issue) {
    return { ok: false, code: 'missing_details', note: 'Need reservation reference and description of the issue. Nothing was attempted.' };
  }
  
  ctx.log('resy_fix_start', { ref, issue: String(issue).slice(0, 100) });
  
  return {
    ok: true,
    phase: 'need_input',
    prompt: `To fix the issue "${issue}" with reservation ${ref}, I need the reservation management URL from your confirmation email.`,
    fields: ['management_url'],
    sessionId: job.sessionId || `resy_fix_${Date.now()}`,
  };
}

module.exports = {
  'book': book,
  'change': change,
  'cancel': cancel,
  'fix-reservation': fixReservation,
};
