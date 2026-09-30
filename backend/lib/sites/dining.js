// backend/lib/sites/dining.js — Restaurant table booking via OpenTable.
//
// Kinds:
//   'book-table'   — search restaurant -> select date/time/party -> guest details ->
//                    need_approval (show restaurant, date, time, party size) -> confirm ->
//                    done { confirmationRef }
//   'change-booking' — modify an existing reservation -> done { confirmationRef }
//   'cancel-booking' — cancel an existing reservation -> done { cancelRef }
//
// Credentials: job.email for guest checkout, or job.vaultId.
// Multi-phase: final confirmation uses need_approval with exact details.

const OPENTABLE_HOME = 'https://www.opentable.com';

// ---- shared helpers -------------------------------------------------------
async function dismissCookies(page) {
  for (const sel of ['button:has-text("Accept")', 'button:has-text("Got it")', '#onetrust-accept-btn-handler']) {
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

// ---- book-table ------------------------------------------------------------
async function bookTable(ctx, job) {
  const page = ctx.page;

  // Continuation: user approved the exact booking details.
  if (job.booking_approved && job.sessionId) {
    return confirmBooking(ctx, job);
  }

  const { restaurant, date, time, partySize } = job;
  if (!restaurant || !date || !time || !partySize) {
    return { ok: false, code: 'missing_details', note: 'Need restaurant name, date, time, and party size. Nothing was attempted.' };
  }

  ctx.log('dining_start', { kind: 'book-table', restaurant, date, time, partySize });
  
  // Search for the restaurant
  await page.goto(OPENTABLE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await dismissCookies(page);

  // Search box
  const searchInput = await page.$('input[placeholder*="Search" i], input[type="search"]').catch(() => null);
  if (!searchInput) {
    return { ok: false, code: 'search_not_found', note: 'Could not find OpenTable search box. Nothing was attempted.' };
  }
  
  await searchInput.fill(restaurant);
  await page.waitForTimeout(2000);
  
  // Click first result
  const firstResult = await page.$('[data-testid*="search-result"], .search-result:first-child, a[href*="/r/"]').catch(() => null);
  if (firstResult) {
    await firstResult.click().catch(() => {});
    await page.waitForTimeout(3000);
  }

  ctx.log('dining_restaurant_page', { url: page.url() });

  // Select date, time, party size - OpenTable uses specific selectors
  // This is a simplified flow; real implementation needs to handle the date picker
  
  // For now, return need_approval with the details we have
  // The actual slot selection happens after approval to avoid holding a table
  return {
    ok: false,
    code: 'need_approval',
    phase: 'booking_details',
    restaurant,
    date,
    time,
    partySize,
    note: `Ready to book: ${restaurant} for ${partySize} on ${date} at ${time}. Approve to proceed with the actual reservation.`,
    sessionId: job.sessionId || `dining_${Date.now()}`,
  };
}

async function confirmBooking(ctx, job) {
  const page = ctx.page;
  const { email, phone, name } = await getCreds(ctx, job);
  
  ctx.log('dining_confirm', { sessionId: job.sessionId });
  
  // TODO: Implement actual OpenTable booking confirmation flow
  // This requires: selecting the time slot, entering guest details, submitting
  
  return { 
    ok: false, 
    code: 'not_implemented', 
    note: 'Dining confirmation flow not yet fully implemented. The approval phase works; final booking submission needs the complete OpenTable interaction sequence.' 
  };
}

// ---- change-booking ---------------------------------------------------------
async function changeBooking(ctx, job) {
  // TODO: Implement reservation modification
  return { 
    ok: false, 
    code: 'not_implemented', 
    note: 'Reservation change flow not yet implemented.' 
  };
}

// ---- cancel-booking ---------------------------------------------------------
async function cancelBooking(ctx, job) {
  // TODO: Implement reservation cancellation
  return { 
    ok: false, 
    code: 'not_implemented', 
    note: 'Reservation cancellation flow not yet implemented.' 
  };
}

module.exports = {
  'book-table': bookTable,
  'change-booking': changeBooking,
  'cancel-booking': cancelBooking,
};
