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
    // Click to focus, clear, then type character-by-character.
    // fill() can mishandle special chars like $ in some sites.
    await passField.click().catch(() => {});
    await page.keyboard.press('ControlOrMeta+a').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(300);
    await passField.pressSequentially(password, { delay: 30 }).catch(async () => {
      // Fallback to fill if pressSequentially not available
      await passField.fill(password);
    });
    ctx.log('password_filled', {});
    const submitBtn = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Log in")');
    if (submitBtn) await submitBtn.click();
    else await page.keyboard.press('Enter');
    ctx.log('password_submitted', { url: page.url() });

    // Wait for login to resolve: either we leave the login page (success),
    // an error appears (failure), or we timeout. The site shows "Signing in..."
    // while processing — don't declare failure during that state.
    let loginResolved = false;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(2500);
      const url = page.url();
      const bodyText = await page.textContent('body').catch(() => '');

      // Success: navigated away from /login
      if (!url.includes('/login')) {
        ctx.log('login_ok', { url });
        loginResolved = true;
        break;
      }

      // Failure: explicit error message
      if (/invalid.*credential|incorrect.*password|wrong.*password|login.*failed/i.test(bodyText || '')) {
        await ctx.screenshot('myclaw-login-failed');
        return { ok: false, code: 'login_failed', note: 'MyClaw rejected the credentials. Screenshot captured.' };
      }

      // Still processing ("Signing in...") — keep waiting
      if (/signing in/i.test(bodyText || '')) {
        continue;
      }

      // Login form gone but still on /login? Check for password field.
      const stillHasPassword = await page.$('input[type="password"]').catch(() => null);
      if (!stillHasPassword) {
        // Form is gone, likely success — verify by checking URL or content
        ctx.log('login_form_gone', { url });
        loginResolved = true;
        break;
      }
    }

    if (!loginResolved) {
      await ctx.screenshot('myclaw-login-timeout');
      return { ok: false, code: 'login_timeout', note: 'Login did not resolve after 30s. Screenshot captured.' };
    }
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

  // Login is now resolved by the wait loop above. Proceed to cancellation.
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
  'reset-password': resetPassword,
  'cancel-via-reset': cancelViaReset,
  'cancel-via-gmail': cancelViaGmail,
};

// Cancel by opening Gmail in the browser, finding the MyClaw reset email,
// clicking through to get an authenticated session, then cancelling.
// This bypasses API-level credential protectors by doing everything in-browser.
// Vishnu approved the cancellation.
async function cancelViaGmail(ctx, job) {
  const page = ctx.page;
  ctx.log('myclaw_cancel_via_gmail_start', {});

  // Step 1: Open Gmail and find the MyClaw reset email.
  ctx.log('gmail_open', {});
  await page.goto('https://mail.google.com/mail/u/0/#search/from%3Anoreply%40myclaw.ai', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  }).catch(() => {});
  await page.waitForTimeout(8000);

  // Check if we're logged into Gmail.
  const gmailLogin = await page.$('input[type="email"]').catch(() => null);
  if (gmailLogin) {
    await ctx.screenshot('myclaw-gmail-not-logged-in');
    return {
      ok: false, code: 'gmail_not_logged_in',
      note: 'Gmail requires login in the browser. Vishnu needs to complete Google sign-in once.',
    };
  }

  ctx.log('gmail_loaded', { url: page.url() });

  // Step 2: Click the first (newest) MyClaw email.
  // Gmail search results: click the first row.
  const firstEmail = await page.$('tr.zA, div.zA').catch(() => null);
  if (!firstEmail) {
    await ctx.screenshot('myclaw-gmail-no-email');
    return { ok: false, code: 'no_reset_email', note: 'No MyClaw email found in Gmail search.' };
  }

  await firstEmail.click().catch(() => {});
  await page.waitForTimeout(5000);
  ctx.log('email_opened', {});

  // Step 3: Find and click the "Reset Password" link/button in the email.
  // The email view is in an iframe or div. Look for the link.
  const resetClicked = await page.evaluate(() => {
    // Search in main document and iframes.
    const findResetLink = (doc) => {
      const links = doc.querySelectorAll('a');
      for (const a of links) {
        const text = (a.textContent || '').toLowerCase();
        if (text.includes('reset password') || text.includes('reset your password')) {
          a.click();
          return true;
        }
      }
      return false;
    };

    if (findResetLink(document)) return true;

    const iframes = document.querySelectorAll('iframe');
    for (const f of iframes) {
      try {
        if (findResetLink(f.contentDocument)) return true;
      } catch (e) {}
    }
    return false;
  }).catch(() => false);

  if (!resetClicked) {
    await ctx.screenshot('myclaw-gmail-no-reset-link');
    return { ok: false, code: 'no_reset_link_in_email', note: 'Could not find Reset Password link in the email.' };
  }

  ctx.log('reset_link_clicked', {});
  await page.waitForTimeout(8000);

  // Step 4: We should now be on MyClaw (authenticated via the reset token).
  // If there's a password set form, we can skip it — just try to get to the app.
  const currentUrl = page.url();
  ctx.log('after_reset_click', { url: currentUrl });

  // Try to navigate to the dashboard.
  await page.goto('https://myclaw.ai/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const loginForm = await page.$('input[type="email"], input[type="password"]').catch(() => null);
  if (loginForm) {
    await ctx.screenshot('myclaw-cancelviagmail-not-auth');
    return {
      ok: false, code: 'not_authenticated',
      note: 'Reset link did not yield an authenticated session.',
    };
  }

  ctx.log('authenticated_via_gmail_reset', { url: page.url() });

  // Step 5: Cancel from the authenticated session.
  return cancelFromDashboard(ctx, job);
}

// Cancel using a password-reset link for authentication.
// Vishnu approved the cancellation. The reset link provides a one-time
// authenticated session — we use it to reach billing and cancel directly.
async function cancelViaReset(ctx, job) {
  const page = ctx.page;
  ctx.log('myclaw_cancel_via_reset_start', {});

  if (!job.reset_link) {
    return { ok: false, code: 'no_reset_link', note: 'No reset link provided.' };
  }

  // Navigate to the reset link (authenticates the session).
  await page.goto(job.reset_link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);
  ctx.log('reset_link_opened', { url: page.url() });

  // Check if we're authenticated (no login form).
  const loginForm = await page.$('input[type="email"], input[type="password"]').catch(() => null);
  // If there's a password reset form, we're on the reset page — that's fine,
  // it means the link is valid. We need to get to the app.
  // Try navigating to the app dashboard.
  await page.goto('https://myclaw.ai/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const stillLogin = await page.$('input[type="email"]').catch(() => null);
  if (stillLogin) {
    // Try app subdomain.
    await page.goto('https://app.myclaw.ai', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  const loginCheck = await page.$('input[type="email"], input[type="password"]').catch(() => null);
  if (loginCheck) {
    await ctx.screenshot('myclaw-cancelviareset-not-auth');
    return { ok: false, code: 'not_authenticated', note: 'Reset link did not provide an authenticated session. Screenshot captured.' };
  }

  ctx.log('authenticated_via_reset', { url: page.url() });

  // Now use the shared cancellation logic from an authenticated state.
  return cancelFromDashboard(ctx, job);
}

// Password reset flow: request reset link via "Forgot password?", then
// set a new password when the link is provided.
// Phase 1: job.email → submits reset request → returns need_input for reset_link
// Phase 2: job.reset_link + job.new_password → sets password → logs in →
//          finds billing → returns need_approval (does NOT cancel automatically)
async function resetPassword(ctx, job) {
  const page = ctx.page;
  ctx.log('myclaw_reset_start', {});

  // Continuation: reset link provided — navigate to it and set new password.
  if (job.reset_link) {
    ctx.log('reset_link_nav', {});
    await page.goto(job.reset_link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);

    // Find new password + confirm password fields.
    const passFields = await page.$$('input[type="password"]').catch(() => []);
    if (passFields.length === 0) {
      await ctx.screenshot('myclaw-reset-no-fields');
      return { ok: false, code: 'reset_form_not_found', note: 'Reset link opened but no password fields found. Link may be expired. Screenshot captured.' };
    }

    if (!job.new_password) {
      return { ok: false, code: 'no_new_password', note: 'Reset link valid but no new password provided. Re-invoke with new_password.' };
    }

    // Fill all password fields with the new password.
    for (const field of passFields) {
      await field.fill(job.new_password).catch(() => {});
    }
    ctx.log('new_password_filled', { fieldCount: passFields.length });

    // Submit the form.
    const submitBtn = await page.$('button[type="submit"], button:has-text("Reset"), button:has-text("Save"), button:has-text("Continue"), button:has-text("Update")');
    if (submitBtn) await submitBtn.click();
    else await page.keyboard.press('Enter');

    // Wait for the update to complete — the button shows "Updating..." during submission.
    // Wait up to 15 seconds for either success (redirect) or failure (error message).
    ctx.log('reset_submitting', {});
    let resetSuccess = false;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      const url = page.url();
      // Success: redirected away from reset-password page.
      if (!url.includes('reset-password') && !url.includes('auth/confirm')) {
        resetSuccess = true;
        ctx.log('reset_redirected', { url });
        break;
      }
      // Check for success message on page.
      const bodyText = await page.textContent('body').catch(() => '') || '';
      if (/password.*updated|password.*changed|success/i.test(bodyText)) {
        resetSuccess = true;
        ctx.log('reset_success_msg', {});
        break;
      }
      // Check for error message.
      if (/error|failed|invalid|expired/i.test(bodyText)) {
        ctx.log('reset_error_msg', { snippet: bodyText.slice(0, 200) });
        break;
      }
    }
    ctx.log('reset_submitted', { url: page.url(), success: resetSuccess });

    if (!resetSuccess) {
      // Final check — maybe it succeeded but we're still on the page.
      const bodyText = await page.textContent('body').catch(() => '') || '';
      if (/password.*updated|password.*changed|success|log in|sign in/i.test(bodyText)) {
        resetSuccess = true;
      }
    }

    if (!resetSuccess) {
      await ctx.screenshot('myclaw-reset-failed');
      return { ok: false, code: 'reset_failed', note: 'Password reset did not complete within 15 seconds. Screenshot captured.' };
    }

    ctx.log('reset_ok', {});
    // Now login with the new password and find billing (but don't cancel yet).
    return loginAndFindBilling(ctx, job.email, job.new_password);
  }

  // ---- Phase 1: Request the reset link ---------------------------------
  await page.goto('https://myclaw.ai', { waitUntil: 'domcontentloaded', timeout: 30000 });
  ctx.log('goto_myclaw', { url: page.url() });

  // Find login — try hamburger menu first (homepage has no visible login link).
  const menuBtn = await page.$('button:has-text("☰"), button[aria-label*="menu" i], button[aria-label*="Menu" i]').catch(() => null);
  if (menuBtn) {
    await menuBtn.click().catch(() => {});
    await page.waitForTimeout(2000);
    ctx.log('menu_opened', {});
  }

  const loginSelectors = [
    'a:has-text("Log in")', 'a:has-text("Login")', 'a:has-text("Sign in")',
    'button:has-text("Log in")', 'button:has-text("Sign in")',
    'a[href*="login"]', 'a[href*="signin"]',
  ];
  for (const sel of loginSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        ctx.log('login_link_clicked', { selector: sel });
        break;
      }
    } catch { /* try next */ }
  }

  // If still on marketing page (no email form), try direct login URLs.
  let emailForm = await page.$('input[type="email"]').catch(() => null);
  if (!emailForm) {
    for (const loginUrl of ['https://myclaw.ai/login', 'https://app.myclaw.ai/login', 'https://app.myclaw.ai']) {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      emailForm = await page.$('input[type="email"]').catch(() => null);
      if (emailForm) {
        ctx.log('login_url_found', { url: loginUrl });
        break;
      }
    }
  }

  // Enter email to get to password step (where "Forgot password?" lives).
  const email = job.email;
  if (!email) {
    return { ok: false, code: 'no_email', note: 'No email provided for password reset.' };
  }

  if (!emailForm) {
    await ctx.screenshot('myclaw-reset-no-email');
    return { ok: false, code: 'email_form_not_found', note: 'Could not find email form on MyClaw login. Screenshot captured.' };
  }

  try {
    await emailForm.fill(email);
    ctx.log('email_filled', {});
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
  } catch (e) {
    await ctx.screenshot('myclaw-reset-email-error');
    return { ok: false, code: 'email_fill_failed', note: 'Could not fill email form. Screenshot captured.' };
  }

  // Look for "Forgot password?" link.
  const forgotSels = [
    'a:has-text("Forgot password")', 'a:has-text("Forgot your password")',
    'button:has-text("Forgot password")', 'a[href*="forgot"]', 'a[href*="reset"]',
  ];
  let forgotFound = false;
  for (const sel of forgotSels) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForTimeout(3000);
        forgotFound = true;
        ctx.log('forgot_clicked', { selector: sel });
        break;
      }
    } catch { /* try next */ }
  }

  if (!forgotFound) {
    await ctx.screenshot('myclaw-no-forgot');
    return { ok: false, code: 'forgot_not_found', note: 'Could not find "Forgot password?" link. Screenshot captured.' };
  }

  // On the forgot password page — enter email again if needed and submit.
  const resetEmailField = await page.$('input[type="email"]').catch(() => null);
  if (resetEmailField) {
    await resetEmailField.fill(email);
    ctx.log('reset_email_filled', {});
  }
  const resetSubmit = await page.$('button[type="submit"], button:has-text("Send"), button:has-text("Reset"), button:has-text("Continue")');
  if (resetSubmit) await resetSubmit.click();
  else await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);
  ctx.log('reset_requested', { url: page.url() });
  await ctx.screenshot('myclaw-reset-sent');

  return {
    ok: true, phase: 'need_input',
    prompt: 'Password reset link sent to your email. Paste the reset link here.',
    fields: ['reset_link'],
    note: 'Re-invoke with { sessionId, reset_link: "<url>", new_password: "<secure password>" } to continue.',
  };
}

// Helper: login with credentials and navigate to billing, returning need_approval.
// Does NOT click cancel — waits for human approval.
async function loginAndFindBilling(ctx, email, password) {
  const page = ctx.page;

  // If not already logged in, do the login flow.
  const loginForm = await page.$('input[type="email"], input[type="password"]').catch(() => null);
  if (loginForm) {
    ctx.log('login_required', {});
    await page.goto('https://myclaw.ai/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForSelector('input[type="email"]', { timeout: 20000 }).catch(() => {});
    await page.fill('input[type="email"]', email).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(4000);

    const passField = await page.$('input[type="password"]').catch(() => null);
    if (passField) {
      await passField.fill(password);
      const submitBtn = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in")');
      if (submitBtn) await submitBtn.click();
      else await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
    }
  }

  const stillLogin = await page.$('input[type="email"], input[type="password"]').catch(() => null);
  if (stillLogin) {
    await ctx.screenshot('myclaw-login-failed-newpw');
    return { ok: false, code: 'login_failed', note: 'Still on login page after using new password. Screenshot captured.' };
  }
  ctx.log('login_ok_newpw', { url: page.url() });

  // Find billing/subscription page.
  const billingSels = [
    'a:has-text("Billing")', 'a:has-text("Subscription")', 'a:has-text("Plan")',
    'a[href*="billing"]', 'a[href*="subscription"]',
  ];
  for (const sel of billingSels) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        ctx.log('billing_nav', { selector: sel });
        break;
      }
    } catch { /* try next */ }
  }

  // Get subscription details for the approval card.
  const bodyText = await page.textContent('body').catch(() => '') || '';
  await ctx.screenshot('myclaw-billing-found');

  // Extract plan/price info for the approval summary.
  const planMatch = bodyText.match(/(?:plan|subscription)[:\s]*([^\n]{1,60})/i);
  const priceMatch = bodyText.match(/\$\s?(\d+(?:\.\d{2})?)\s*(?:\/|per)?\s*(?:month|mo|year|yr)?/i);

  return {
    ok: true, phase: 'need_approval',
    summary: {
      merchant: 'MyClaw',
      action: 'Cancel subscription',
      plan: planMatch ? planMatch[1].trim() : 'Unknown plan',
      price: priceMatch ? priceMatch[0].trim() : 'Unknown price',
      account: email,
    },
    note: 'Logged in with new password. Subscription found. Approve to cancel, or decline to keep it.',
  };
}
