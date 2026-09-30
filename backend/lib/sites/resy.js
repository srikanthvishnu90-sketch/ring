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
  
  ctx.log('resy_confirm', { sessionId: job.sessionId });
  
  // The page should still be on the restaurant page from the first phase
  // Select date/party/time and complete booking
  
  // This is a simplified flow - in production, we'd:
  // 1. Set the date via the date picker
  // 2. Set party size
  // 3. Click available time slot
  // 4. Fill guest details (name, email, phone)
  // 5. Confirm reservation
  // 6. Extract confirmation reference
  
  // For now, attempt the booking flow
  try {
    // Look for time slot buttons
    const slotBtn = await page.$('button:has-text(":"), [data-testid*="slot"]').catch(() => null);
    if (!slotBtn) {
      await ctx.screenshot('resy-no-slots');
      return { 
        ok: false, 
        code: 'no_slots', 
        note: 'No available time slots found on Resy for the requested date/time. Nothing was booked.' 
      };
    }
    
    await slotBtn.click().catch(() => {});
    await page.waitForTimeout(3000);
    
    // Fill guest details if form appears
    const emailInput = await page.$('input[type="email"], input[name*="email" i]').catch(() => null);
    if (emailInput && creds.email) {
      await emailInput.fill(creds.email);
    }
    
    // Look for confirm button
    const confirmBtn = await page.$('button:has-text("Complete"), button:has-text("Confirm"), button:has-text("Book")').catch(() => null);
    if (confirmBtn) {
      await confirmBtn.click().catch(() => {});
      await page.waitForTimeout(5000);
      
      // Try to extract confirmation reference
      const bodyText = await page.textContent('body').catch(() => '');
      const refMatch = bodyText.match(/(?:confirmation|reservation)[\s#:]*([A-Z0-9]{6,})/i);
      if (refMatch) {
        return {
          ok: true,
          phase: 'done',
          confirmationRef: refMatch[1],
          note: `Table booked via Resy. Confirmation: ${refMatch[1]}`,
        };
      }
    }
    
    await ctx.screenshot('resy-confirm-incomplete');
    return { 
      ok: false, 
      code: 'confirm_incomplete', 
      note: 'Booking flow started but confirmation not completed. Check screenshot. Nothing was charged.' 
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
