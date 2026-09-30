// backend/lib/sites/web_login.js — Generic website login via browser.
//
// Kinds:
//   'login-task' — navigate to site -> fill credentials (from vault) ->
//                  handle 2FA if needed -> perform task -> done { result }
//
// Credentials: job.vaultId (preferred) or job.username/job.password.
// Security: credentials come from vault; never logged. Per-action approval required.

async function loginTask(ctx, job) {
  const page = ctx.page;
  const { site, task } = job;
  
  if (!site) {
    return { ok: false, code: 'missing_site', note: 'Need a website URL or name. Nothing was attempted.' };
  }

  ctx.log('web_login_start', { site, task: task ? 'specified' : 'none' });
  
  // Navigate to the site
  const url = site.startsWith('http') ? site : `https://${site}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  
  ctx.log('web_login_page', { url: page.url() });
  
  // Get credentials from vault
  let creds = null;
  if (job.vaultId) {
    try {
      creds = await ctx.vault.withCredentials(job.vaultId, (x) => x);
    } catch (e) {
      return { ok: false, code: 'vault_error', note: `Could not retrieve credentials: ${e.message}` };
    }
  } else if (job.username && job.password) {
    // Direct credentials (less secure, but allowed if user provided)
    creds = { username: job.username, password: job.password };
  }
  
  if (!creds || (!creds.username && !creds.email)) {
    return { 
      ok: false, 
      code: 'need_credentials', 
      note: 'No credentials available. Provide a vaultId or username/password. Nothing was attempted.' 
    };
  }

  // Try to find and fill login form
  // Common selectors for username/email and password fields
  const userSels = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[id*="email" i]',
    'input[id*="username" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="username" i]',
  ];
  
  const passSels = [
    'input[type="password"]',
    'input[name="password"]',
    'input[id*="password" i]',
  ];

  let userInput = null;
  for (const sel of userSels) {
    userInput = await page.$(sel).catch(() => null);
    if (userInput) break;
  }

  let passInput = null;
  for (const sel of passSels) {
    passInput = await page.$(sel).catch(() => null);
    if (passInput) break;
  }

  if (!userInput || !passInput) {
    return { 
      ok: false, 
      code: 'login_form_not_found', 
      note: 'Could not find login form on the page. The site may use a different login flow. Nothing was submitted.' 
    };
  }

  // Fill credentials (do not log values)
  const username = creds.email || creds.username;
  await userInput.fill(username).catch(() => {});
  await passInput.fill(creds.password || creds.pass).catch(() => {});
  
  ctx.log('web_login_filled', { site });
  
  // Find and click submit
  const submitSels = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'button:has-text("Login")',
  ];
  
  let submitBtn = null;
  for (const sel of submitSels) {
    submitBtn = await page.$(sel).catch(() => null);
    if (submitBtn) break;
  }

  if (submitBtn) {
    await submitBtn.click().catch(() => {});
    await page.waitForTimeout(5000);
  } else {
    // Try pressing Enter in password field
    await passInput.press('Enter').catch(() => {});
    await page.waitForTimeout(5000);
  }

  ctx.log('web_login_submitted', { url: page.url() });

  // Check if we're still on a login page (failed) or moved on (success)
  // This is heuristic; real implementation needs site-specific checks
  const stillHasPassword = await page.$('input[type="password"]').catch(() => null);
  
  if (stillHasPassword) {
    // Might need 2FA or login failed
    return {
      ok: false,
      code: 'need_2fa_or_failed',
      note: 'Login form still visible after submit. May need 2FA code or credentials were rejected. Check the page.',
      url: page.url(),
    };
  }

  // Login appears successful. If there's a specific task, attempt it.
  if (task) {
    ctx.log('web_login_task', { task });
    // TODO: Implement task-specific logic based on job.task description
    return {
      ok: true,
      phase: 'logged_in',
      note: `Logged in to ${site}. Task "${task}" needs site-specific implementation.`,
      url: page.url(),
    };
  }

  return {
    ok: true,
    phase: 'logged_in',
    note: `Successfully logged in to ${site}.`,
    url: page.url(),
  };
}

module.exports = {
  'login-task': loginTask,
};
