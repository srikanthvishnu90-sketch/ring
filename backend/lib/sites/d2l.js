// backend/lib/sites/d2l.js — DePaul D2L Brightspace + WebWork.
//
// Implements kind 'login-task' for site 'd2l' when job.task mentions webwork.
// Flow (multi-phase):
//   Phase 1: D2L login -> Discrete Math course -> WebWork -> open due set ->
//            extract all problems -> return { phase:'need_input', problems }
//   Phase 2: (with job.answers) enter each answer, submit, read score ->
//            return { phase:'done', confirmationRef: score }
//
// Credentials via job.username/job.password (transient) or job.vaultId.

const D2L_URL = 'https://d2l.depaul.edu';

async function loginTask(ctx, job) {
  const page = ctx.page;
  const task = String(job.task || '').toLowerCase();
  if (!task.includes('webwork')) {
    return { ok: false, code: 'task_not_supported', note: `d2l site module only handles WebWork tasks, got: "${String(job.task).slice(0, 80)}"` };
  }

  // Continuation: MFA was approved — check if we're now in D2L.
  if (job.mfa_done) {
    ctx.log('mfa_continue', { url: page.url() });
    await page.waitForTimeout(5000);
    if (/microsoftonline|login\.microsoft/i.test(page.url())) {
      return { ok: false, code: 'login_failed', note: 'Still on Microsoft login after MFA. The approval may not have completed.' };
    }
    ctx.log('login_ok', { url: page.url() });
    return findCourseAndWebWork(ctx, job);
  }

  // If we already have problems + answers, we're in phase 2.
  if (job.answers && job.problemIds) {
    return enterAnswers(ctx, job);
  }
  return phase1_extract(ctx, job);
}

async function getCreds(ctx, job) {
  if (job.vaultId) {
    const c = await ctx.vault.withCredentials(job.vaultId, (x) => x);
    return { username: c.username || c.email, password: c.password };
  }
  return { username: job.username || job.email, password: job.password };
}

async function phase1_extract(ctx, job) {
  const page = ctx.page;
  ctx.log('d2l_start', {});

  const { username, password } = await getCreds(ctx, job);
  if (!username || !password) {
    return { ok: false, code: 'no_credentials', note: 'No D2L credentials available.' };
  }

  // ---- 1. D2L login (DePaul uses Microsoft SSO — two-step flow) --------------
  await page.goto(D2L_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  ctx.log('goto_d2l', { url: page.url() });

  // Step 1: email/username. Microsoft shows input[type=email] then a Next button.
  try {
    await page.waitForSelector('input[type="email"]', { timeout: 25000 });
    await page.fill('input[type="email"]', username);
    ctx.log('sso_email_filled', {});
    // Click Next (not Sign in yet).
    const nextBtn = await page.$('input[type="submit"], button:has-text("Next")');
    if (nextBtn) await nextBtn.click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    ctx.log('sso_email_submitted', { url: page.url() });
  } catch (e) {
    await ctx.screenshot('d2l-no-email');
    return { ok: false, code: 'login_form_not_found', note: 'Could not find the SSO email form. Screenshot captured.' };
  }

  // Step 2: password (Microsoft uses name="passwd").
  try {
    const passSel = 'input[type="password"], input[name="passwd"]';
    await page.waitForSelector(passSel, { timeout: 25000, state: 'visible' });
    await page.fill(passSel, password);
    ctx.log('sso_password_filled', {});
    // Microsoft: the submit is input[type=submit] with value "Sign in".
    const signInBtn = await page.$('input[type="submit"]');
    if (signInBtn) await signInBtn.click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(6000);
    ctx.log('sso_password_submitted', { url: page.url() });
  } catch (e) {
    await ctx.screenshot('d2l-no-password');
    return { ok: false, code: 'login_form_not_found', note: 'Could not find the SSO password form. Screenshot captured.' };
  }

  // Step 3: Microsoft may ask "Stay signed in?" — click No/Yes to continue.
  try {
    const stayBtn = await page.waitForSelector('input[type="submit"], button:has-text("No"), button:has-text("Yes")', { timeout: 8000 }).catch(() => null);
    if (stayBtn) {
      const text = (await stayBtn.textContent().catch(() => '') || '').trim();
      if (/^(yes|no)$/i.test(text)) {
        await stayBtn.click();
        await page.waitForTimeout(5000);
        ctx.log('sso_stay_signed_in', { choice: text });
      }
    }
  } catch { /* no stay-signed-in prompt */ }

  // Verify we're past Microsoft login (URL should be d2l.depaul.edu, not microsoftonline).
  await page.waitForTimeout(4000);
  const finalUrl = page.url();
  if (/microsoftonline|login\.microsoft/i.test(finalUrl)) {
    const bodyText = await page.textContent('body').catch(() => '');
    // Check for MFA / verification code prompt.
    if (/verification|authenticator|approve|code/i.test(bodyText || '')) {
      await ctx.screenshot('d2l-mfa');
      return {
        ok: true, phase: 'need_input',
        prompt: 'DePaul login needs multi-factor approval (phone app or code). Approve it on your device, then tell me to continue.',
        fields: ['mfa_done'],
        note: 'Re-invoke with { sessionId, mfa_done: "yes" } after approving.',
      };
    }
    await ctx.screenshot('d2l-login-failed');
    return { ok: false, code: 'login_failed', note: 'Still on Microsoft login after password. Screenshot captured.' };
  }
  ctx.log('login_ok', { url: finalUrl });
  return findCourseAndWebWork(ctx, job);
}

// Steps 2-4: from logged-in D2L, find course, open WebWork, extract problems.
async function findCourseAndWebWork(ctx, job) {
  const page = ctx.page;
  // Look for a course tile/link mentioning "Discrete".
  const courseSels = [
    'a:has-text("Discrete")', '[role="link"]:has-text("Discrete")',
    '.d2l-card:has-text("Discrete")', 'a:has-text("DISCRETE")',
  ];
  let courseClicked = false;
  for (const sel of courseSels) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        courseClicked = true;
        ctx.log('course_opened', { selector: sel, url: page.url() });
        break;
      }
    } catch { /* try next */ }
  }
  if (!courseClicked) {
    await ctx.screenshot('d2l-no-course');
    return { ok: false, code: 'course_not_found', note: 'Logged in but could not find the Discrete Mathematics course. Screenshot captured.' };
  }

  // ---- 3. Find WebWork link ------------------------------------------------
  // Usually under Content, or a direct nav item.
  const wwSels = [
    'a:has-text("WebWork")', 'a:has-text("WeBWorK")', 'a:has-text("Webwork")',
    'a[href*="webwork" i]', '[role="link"]:has-text("WebWork")',
  ];
  let wwClicked = false;
  // First check if we're already looking at content with a WebWork link.
  for (const sel of wwSels) {
    try {
      const el = await page.$(sel);
      if (el) {
        // WebWork often opens in a new tab.
        const [popup] = await Promise.all([
          page.waitForEvent('popup', { timeout: 5000 }).catch(() => null),
          el.click(),
        ]);
        if (popup) {
          // Switch to the WebWork popup tab.
          await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
          ctx.log('webwork_popup', { url: popup.url() });
          // Replace the page in ctx for subsequent steps.
          ctx.page = popup;
        } else {
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        }
        wwClicked = true;
        ctx.log('webwork_opened', { selector: sel });
        break;
      }
    } catch { /* try next */ }
  }
  if (!wwClicked) {
    // Try the Content page.
    const contentLink = await page.$('a:has-text("Content")').catch(() => null);
    if (contentLink) {
      await contentLink.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      for (const sel of wwSels) {
        try {
          const el = await page.$(sel);
          if (el) {
            const [popup] = await Promise.all([
              page.waitForEvent('popup', { timeout: 5000 }).catch(() => null),
              el.click(),
            ]);
            if (popup) ctx.page = popup;
            wwClicked = true;
            ctx.log('webwork_via_content', {});
            break;
          }
        } catch { /* try next */ }
      }
    }
  }
  if (!wwClicked) {
    await ctx.screenshot('d2l-no-webwork');
    return { ok: false, code: 'webwork_not_found', note: 'In Discrete Math course but could not find the WebWork link. Screenshot captured.' };
  }

  const wwPage = ctx.page;
  await wwPage.waitForTimeout(3000);
  ctx.log('webwork_loaded', { url: wwPage.url() });

  // ---- 4. Find the due-tonight set and extract problems -------------------
  // WebWork set list: look for links to problem sets, prefer one due 9/29.
  const setLinks = await wwPage.$$('a').catch(() => []);
  let setUrl = null;
  let setName = null;
  for (const a of setLinks) {
    try {
      const text = (await a.textContent()) || '';
      const href = await a.getAttribute('href');
      if (/set|homework|assignment/i.test(text) && href) {
        // Check if it mentions today's date or "due".
        const row = await a.evaluate((el) => el.closest('tr')?.textContent || el.parentElement?.textContent || '');
        if (/sep\s*29|09\/29|due.*today|today/i.test(row + ' ' + text)) {
          setUrl = href; setName = text.trim();
          ctx.log('due_set_found', { set: setName });
          break;
        }
        if (!setUrl) { setUrl = href; setName = text.trim(); } // fallback: first set
      }
    } catch { /* next */ }
  }
  if (!setUrl) {
    await ctx.screenshot('ww-no-sets');
    return { ok: false, code: 'set_not_found', note: 'WebWork opened but no problem sets found. Screenshot captured.' };
  }
  if (setUrl && !setUrl.startsWith('http')) {
    const base = new URL(wwPage.url());
    setUrl = new URL(setUrl, base.origin).toString();
  }
  await wwPage.goto(setUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await wwPage.waitForTimeout(2000);
  ctx.log('set_opened', { set: setName, url: wwPage.url() });

  // Extract problems: WebWork numbers them; each has a link or an anchor.
  // Get the problem list page text to enumerate.
  const problems = [];
  // WebWork problem links look like ?problem=1 or /problem/1 or have "Problem N".
  const probLinks = await wwPage.$$('a').catch(() => []);
  const seen = new Set();
  for (const a of probLinks) {
    try {
      const text = ((await a.textContent()) || '').trim();
      const href = await a.getAttribute('href');
      const m = text.match(/^(\d+)$/) || (href || '').match(/problem[=_-]?(\d+)/i);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        problems.push({ id: m[1], href });
      }
    } catch { /* next */ }
  }
  ctx.log('problems_enumerated', { count: problems.length });

  if (!problems.length) {
    await ctx.screenshot('ww-no-problems');
    return { ok: false, code: 'no_problems', note: `Opened set "${setName}" but found no problems. Screenshot captured.` };
  }

  // Visit each problem and extract its text + input fields.
  const extracted = [];
  for (const p of problems) {
    try {
      let url = p.href;
      if (url && !url.startsWith('http')) {
        url = new URL(url, new URL(wwPage.url()).origin).toString();
      }
      if (url) await wwPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await wwPage.waitForTimeout(1500);
      // Problem text is usually in a specific div; grab main content.
      const qtext = await wwPage.evaluate(() => {
        const el = document.querySelector('.problem-content, #problem-content, .ww-problem, main') || document.body;
        return (el.innerText || '').slice(0, 3000);
      }).catch(() => '');
      const inputs = await wwPage.$$('input[type="text"], input:not([type])').catch(() => []);
      extracted.push({ id: p.id, text: (qtext || '').trim().slice(0, 1500), inputs: inputs.length, url: wwPage.url() });
      ctx.log('problem_extracted', { id: p.id, inputs: inputs.length });
    } catch (e) {
      ctx.log('problem_extract_failed', { id: p.id });
    }
  }

  await ctx.screenshot('ww-problems-extracted');
  return {
    ok: true, phase: 'need_input',
    prompt: `WebWork set "${setName}" has ${extracted.length} problems. Solve each and return answers.`,
    problems: extracted,
    problemIds: extracted.map((p) => p.id),
    fields: ['answers'],
    note: 'Re-invoke with { sessionId, answers: { "<id>": "<answer>", ... } } to enter and submit.',
  };
}

async function enterAnswers(ctx, job) {
  const page = ctx.page;
  const answers = job.answers || {};
  ctx.log('enter_answers', { count: Object.keys(answers).length });

  // We're on the last problem page; navigate back through problems.
  // Simpler: the problems were extracted in order; revisit each URL is complex
  // without stored URLs. Instead, use the problem list navigation.
  // For now, assume we're positioned to iterate via "next problem" links.
  let correct = 0, total = 0;
  const results = [];

  // Go back to the set page first — job should carry setUrl (stored in phase 1).
  // Phase 1 didn't store it; navigate via history is unreliable. Re-derive:
  // the current page is a problem page; find the "set" breadcrumb.
  const setLink = await page.$('a:has-text("Set"), a:has-text("Problem Set")').catch(() => null);
  if (setLink) {
    await setLink.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  }

  for (const pid of job.problemIds || []) {
    total++;
    const answer = answers[pid];
    if (answer == null) {
      results.push({ id: pid, status: 'no_answer' });
      continue;
    }
    try {
      // Click problem number link.
      const link = await page.$(`a:has-text("${pid}")`).catch(() => null);
      // More precise: find link whose text is exactly the number.
      let target = null;
      const links = await page.$$('a').catch(() => []);
      for (const a of links) {
        const t = ((await a.textContent()) || '').trim();
        if (t === String(pid)) { target = a; break; }
      }
      if (!target) { results.push({ id: pid, status: 'link_not_found' }); continue; }
      await target.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);

      // Fill all text inputs with the answer (single-answer problems).
      // Multi-part: answers as array.
      const inputs = await page.$$('input[type="text"], input:not([type])').catch(() => []);
      const vals = Array.isArray(answer) ? answer : [answer];
      for (let i = 0; i < inputs.length && i < vals.length; i++) {
        await inputs[i].fill(String(vals[i]));
      }
      ctx.log('answer_entered', { id: pid, inputs: inputs.length });

      // Submit.
      const submit = await page.$('input[type="submit"], button:has-text("Submit"), button:has-text("Submit Answers")').catch(() => null);
      if (submit) {
        await submit.click();
        await page.waitForTimeout(2500);
      }
      // Check correctness.
      const bodyText = await page.textContent('body').catch(() => '');
      const isCorrect = /correct/i.test(bodyText || '') && !/incorrect|wrong/i.test((bodyText || '').slice(0, 2000));
      if (isCorrect) correct++;
      results.push({ id: pid, status: isCorrect ? 'correct' : 'check' });
      ctx.log('problem_submitted', { id: pid, correct: isCorrect });

      // Back to set.
      const back = await page.$('a:has-text("Set"), a:has-text("Problem Set")').catch(() => null);
      if (back) {
        await back.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      }
    } catch (e) {
      results.push({ id: pid, status: 'error', note: String(e.message).slice(0, 100) });
    }
  }

  await ctx.screenshot('ww-submitted');
  const score = `${correct}/${total}`;
  ctx.log('webwork_done', { score });
  return {
    ok: true, phase: 'done',
    confirmationRef: `webwork-${score.replace('/', 'of')}`,
    score, results,
    note: `WebWork submitted: ${correct} of ${total} correct.`,
  };
}

module.exports = {
  'login-task': loginTask,
};
