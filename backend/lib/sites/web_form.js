// backend/lib/sites/web_form.js — Generic web form filling via browser.
//
// Kinds:
//   'fill-form' — navigate to URL -> fill fields from job.fields ->
//                 need_approval (show exact field values) -> submit ->
//                 done { confirmation }
//
// Security: form values shown in approval card before submission.
// Never submit without explicit approval of the exact values.

async function fillForm(ctx, job) {
  const page = ctx.page;
  const { url, fields } = job;
  
  if (!url) {
    return { ok: false, code: 'missing_url', note: 'Need a form URL. Nothing was attempted.' };
  }
  
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    return { ok: false, code: 'missing_fields', note: 'Need field values to fill. Nothing was attempted.' };
  }

  // Continuation: user approved the exact field values.
  if (job.form_approved && job.sessionId) {
    return submitForm(ctx, job);
  }

  ctx.log('web_form_start', { url, fieldCount: Object.keys(fields).length });
  
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  
  ctx.log('web_form_page', { url: page.url() });

  // Attempt to fill each field by name, id, placeholder, or label
  const filled = [];
  const notFound = [];
  
  for (const [name, value] of Object.entries(fields)) {
    let input = null;
    
    // Try various selectors
    const sels = [
      `[name="${name}"]`,
      `#${name}`,
      `input[placeholder*="${name}" i]`,
      `textarea[name="${name}"]`,
      `select[name="${name}"]`,
    ];
    
    for (const sel of sels) {
      try {
        input = await page.$(sel).catch(() => null);
        if (input) break;
      } catch { /* next */ }
    }
    
    if (input) {
      try {
        const tagName = await input.evaluate(el => el.tagName.toLowerCase()).catch(() => 'input');
        if (tagName === 'select') {
          await input.selectOption(value).catch(() => {});
        } else {
          await input.fill(String(value)).catch(() => {});
        }
        filled.push(name);
      } catch (e) {
        notFound.push(name);
      }
    } else {
      notFound.push(name);
    }
  }

  ctx.log('web_form_filled', { filled: filled.length, notFound: notFound.length });

  if (filled.length === 0) {
    return {
      ok: false,
      code: 'no_fields_filled',
      note: `Could not find any of the specified fields on the page. Tried: ${Object.keys(fields).join(', ')}. Nothing was submitted.`,
    };
  }

  // Return need_approval with exact values for user to review
  return {
    ok: false,
    code: 'need_approval',
    phase: 'form_filled',
    url,
    fields,
    filled,
    notFound,
    note: `Form fields filled. Review the exact values and approve to submit. Filled: ${filled.join(', ')}${notFound.length ? `. Not found: ${notFound.join(', ')}` : ''}`,
    sessionId: job.sessionId || `form_${Date.now()}`,
  };
}

async function submitForm(ctx, job) {
  const page = ctx.page;
  
  ctx.log('web_form_submit', { sessionId: job.sessionId });
  
  // Find and click submit button
  const submitSels = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Send")',
  ];
  
  let submitBtn = null;
  for (const sel of submitSels) {
    submitBtn = await page.$(sel).catch(() => null);
    if (submitBtn) break;
  }

  if (!submitBtn) {
    return { ok: false, code: 'no_submit', note: 'Could not find submit button. Nothing was submitted.' };
  }

  await submitBtn.click().catch(() => {});
  await page.waitForTimeout(5000);
  
  ctx.log('web_form_submitted', { url: page.url() });

  return {
    ok: true,
    phase: 'submitted',
    note: `Form submitted.`,
    url: page.url(),
  };
}

module.exports = {
  'fill-form': fillForm,
};
