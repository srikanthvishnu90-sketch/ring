// backend/lib/sites/myclaw.js — MyClaw subscription cancellation.
//
// Implements kind 'cancel-subscription' for merchant 'myclaw'.
// Flow: login (email+password) -> billing/subscription -> cancel -> confirm.
// Returns { ok:true, phase:'done', cancelRef } with proof, or honest failure.
//
// Credentials: via ctx.vault.withCredentials(vaultId) when job.vaultId is set,
// or via job.username/job.password for direct (transient) use. Values never
// logged or returned.

async function cancelSubscription(ctx, job) {
  const page = ctx.page;
  ctx.log('myclaw_start', { merchant: job.merchant });

  // Continuation: magic link provided — navigate to it.
  if (job.magic_link) {
    ctx.log('magic_link_nav', {});
    await page.goto(job.magic_link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const stillLogin = await page.$('input[type="email"], input[type="password"]').catch(() => null);
    if (stillLogin) {
      return { ok: false, code: 'login_failed', note: 'Magic link did not sign in (still on login page).' };
    }
    ctx.log('magic_link_ok', { url: page.url() });
    return cancelFromDashboard(ctx, job);
  }

  // ---- 1. Go to MyClaw and find login ---------------------------------
  await page.goto('https://myclaw.ai', { waitUntil: 'domcontentloaded', timeout: 30000 });
  ctx.log('goto_myclaw', { url: page.url() });

  // Look for a login/sign-in link or button.
  const loginSelectors = [
    'a:has-text("Log in")', 'a:has-text("Login")', 'a:has-text("Sign in")',
    'button:has-text("Log in")', 'button:has-text("Sign in")',
    'a[href*="login"]', 'a[href*="signin"]',
  ];
  let loginFound = false;
  for (const sel of loginSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        loginFound = true;
        ctx.log('login_link_clicked', { selector: sel });
        break;
      }
    } catch { /* try next */ }
  }
  if (!loginFound) {
    // Maybe we're already on a login page, or try /login directly.
    if (!/login|signin/i.test(page.url())) {
      await page.goto('https://myclaw.ai/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      ctx.log('goto_login_direct', { url: page.url() });
    }
  }

  // ---- 2. Fill credentials (email-first flow) -------------------------------
  let username, password;
  if (job.vaultId) {
    const creds = await ctx.vault.withCredentials(job.vaultId, (c) => c);
    username = creds.username || creds.email;
    password = creds.password;
  } else {
    username = job.username || job.email;
    password = job.password;
  }
  if (!username) {
    return { ok: false, code: 'no_credentials', note: 'No MyClaw email available. Nothing was attempted.' };
  }

  // Step 1: email (NOT "Continue with Google" — the email-specific button).
  try {
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.fill('input[type="email"]', username);
    ctx.log('email_filled', {});
    // Find the Continue button associated with the email form, not OAuth.
    // Strategy: the email input's form, or a button near it without "Google"/"Slack".
    const emailContinue = await page.evaluate(() => {
      const emailInput = document.querySelector('input[type="email"]');
      if (!emailInput) return null;
      const form = emailInput.closest('form');
      if (form) {
        const btn = form.querySelector('button[type="submit"], button:not([type])');
        if (btn) return { byForm: true, text: btn.innerText?.slice(0, 40) };
      }
      // Fallback: buttons with "Continue" but not "Google"/"Slack"/"Apple".
      const btns = [...document.querySelectorAll('button')];
      const match = btns.find((b) => /continue/i.test(b.innerText || '') && !/google|slack|apple/i.test(b.innerText || ''));
      if (match) return { byText: true, text: match.innerText?.slice(0, 40) };
      return null;
    });
    ctx.log('email_continue_found', emailContinue || {});
    if (emailContinue?.byForm) {
      await page.evaluate(() => {
        const emailInput = document.querySelector('input[type="email"]');
        const form = emailInput?.closest('form');
        form?.querySelector('button[type="submit"], button:not([type])')?.click();
      });
    } else if (emailContinue?.byText) {
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        btns.find((b) => /continue/i.test(b.innerText || '') && !/google|slack|apple/i.test(b.innerText || ''))?.click();
      });
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(4000);
    ctx.log('email_submitted', { url: page.url() });
  } catch (e) {
    await ctx.screenshot('myclaw-no-email-form');
    return { ok: false, code: 'login_form_not_found', note: 'Could not find the MyClaw email form. Screenshot captured.' };
  }

  // Step 2: check what comes next — password field, magic link, or OAuth.
  const bodyAfter = await page.textContent('body').catch(() => '');
  const passField = await page.$('input[type="password"]').catch(() => null);
  if (passField && password) {
    await passField.fill(password);
    ctx.log('password_filled', {});
    const submitBtn = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Log in")');
    if (submitBtn) await submitBtn.click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
    ctx.log('password_submitted', { url: page.url() });
  } else if (/check your email|magic link|sent.*link|verify.*email/i.test(bodyAfter || '')) {
    await ctx.screenshot('myclaw-magic-link');
    return {
      ok: true, phase: 'need_input',
      prompt: 'MyClaw sent a sign-in link to your email. Paste the link or the code here.',
      fields: ['magic_link'],
      note: 'Re-invoke with { sessionId, magic_link: "<url>" } to continue.',
    };
  } else if (!passField) {
    await ctx.screenshot('myclaw-after-email');
    return { ok: false, code: 'login_blocked', note: 'After email, no password field appeared — the site may require OAuth or a magic link. Screenshot captured.' };
  }

  // Verify login succeeded.
  const stillLogin = await page.$('input[type="email"], input[type="password"]').catch(() => null);
  if (stillLogin) {
    await ctx.screenshot('myclaw-login-failed');
    return { ok: false, code: 'login_failed', note: 'Login form still present after submit — credentials likely rejected. Screenshot captured.' };
  }
  ctx.log('login_ok', { url: page.url() });
  return cancelFromDashboard(ctx, job);
}

// Steps 3-5: from a logged-in state, find billing and cancel.
async function cancelFromDashboard(ctx, job) {
  const page = ctx.page;

  // ---- 3. Find billing/subscription --------------------------------------
  const billingSels = [
    'a:has-text("Billing")', 'a:has-text("Subscription")', 'a:has-text("Plan")',
    'a[href*="billing"]', 'a[href*="subscription"]', 'a[href*="settings"]',
  ];
  let billingFound = false;
  for (const sel of billingSels) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        billingFound = true;
        ctx.log('billing_nav', { selector: sel, url: page.url() });
        break;
      }
    } catch { /* try next */ }
  }
  if (!billingFound) {
    // Try common billing URLs.
    for (const u of ['https://myclaw.ai/settings/billing', 'https://myclaw.ai/billing', 'https://myclaw.ai/settings']) {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      const hasCancel = await page.$('button:has-text("Cancel"), a:has-text("Cancel")').catch(() => null);
      if (hasCancel) { billingFound = true; ctx.log('billing_url_found', { url: u }); break; }
    }
  }
  if (!billingFound) {
    await ctx.screenshot('myclaw-no-billing');
    return { ok: false, code: 'billing_not_found', note: 'Logged in but could not find billing/subscription settings. Screenshot captured.' };
  }

  // ---- 4. Cancel ---------------------------------------------------------
  const cancelSels = [
    'button:has-text("Cancel subscription")', 'button:has-text("Cancel plan")',
    'a:has-text("Cancel subscription")', 'button:has-text("Cancel")',
  ];
  let cancelClicked = false;
  for (const sel of cancelSels) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForTimeout(2000);
        cancelClicked = true;
        ctx.log('cancel_clicked', { selector: sel });
        break;
      }
    } catch { /* try next */ }
  }
  if (!cancelClicked) {
    await ctx.screenshot('myclaw-no-cancel-btn');
    return { ok: false, code: 'cancel_not_found', note: 'On billing page but no cancel button found. May already be cancelled — screenshot captured.' };
  }

  // Confirm cancellation (second step).
  const confirmSels = [
    'button:has-text("Confirm")', 'button:has-text("Yes, cancel")',
    'button:has-text("Cancel subscription")', 'button:has-text("Continue")',
  ];
  for (const sel of confirmSels) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForTimeout(3000);
        ctx.log('cancel_confirmed', { selector: sel });
        break;
      }
    } catch { /* try next */ }
  }

  // ---- 5. Verify and capture proof ---------------------------------------
  await page.waitForTimeout(2000);
  const bodyText = await page.textContent('body').catch(() => '');
  const cancelled = /cancelled|canceled|will not renew|no longer.*active|subscription.*end/i.test(bodyText || '');
  await ctx.screenshot('myclaw-cancel-result');

  if (cancelled) {
    // Extract a confirmation reference if visible.
    const refMatch = (bodyText || '').match(/(?:confirmation|reference|id)[:\s]*([A-Z0-9-]{6,})/i);
    ctx.log('cancel_verified', { cancelled: true });
    return {
      ok: true, phase: 'done',
      cancelRef: refMatch ? refMatch[1] : 'myclaw-cancelled',
      merchant: 'myclaw',
      note: 'MyClaw subscription cancelled. Confirmation text captured in screenshot.',
    };
  }
  return {
    ok: false, code: 'cancel_unverified',
    note: 'Clicked cancel but could not verify cancellation from the page text. Screenshot captured for review.',
  };
}

module.exports = {
  'cancel-subscription': cancelSubscription,
};
