// backend/lib/agentic_browser.js — Vision-driven browser automation.
//
// Replaces brittle hardcoded selectors with an LLM-driven action loop.
// The LLM sees the page (via accessibility tree) and decides what to do,
// just like Muse does when operating a browser.
//
// Serverless-safe: each navigate() call runs a bounded loop (default 5 steps)
// within the phase time budget, then returns. The agent loop re-invokes for
// multi-phase flows.
//
// Usage:
//   const ab = require('./agentic_browser');
//   const result = await ab.navigate(ctx, {
//     goal: 'Find the billing/subscription page and extract plan name, price, billing date',
//     constraints: ['Do not click Cancel', 'Do not submit any forms'],
//     maxSteps: 5,
//   });
//   // result: { ok, action_taken, extracted, steps, note }

const { env } = require('./config');

// ── Page observation ──────────────────────────────────────────────
// Get a simplified accessibility tree + URL + title for the LLM.
async function observe(page) {
  const url = page.url();
  let title = '';
  try { title = await page.title(); } catch {}
  
  let axTree = '';
  try {
    const snapshot = await page.accessibility.snapshot();
    axTree = simplifyAxTree(snapshot);
  } catch (e) {
    axTree = '(accessibility tree unavailable)';
  }
  
  let textSnippet = '';
  try {
    const bodyText = await page.evaluate(() => 
      (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 2000)
    ).catch(() => '');
    textSnippet = bodyText;
  } catch {}
  
  return { url, title, axTree, textSnippet };
}

// Simplify the AX tree to something LLM-friendly.
// Keep: role, name, and ref for interactive elements.
function simplifyAxTree(node, depth = 0, out = []) {
  if (!node || depth > 8) return out;
  if (out.length > 150) return out; // cap size
  
  const indent = '  '.repeat(depth);
  const role = node.role || 'unknown';
  const name = (node.name || '').slice(0, 80);
  
  // Only include meaningful nodes: interactive elements or text containers
  const isInteractive = /button|link|textbox|checkbox|combobox|menuitem|tab/i.test(role);
  const hasName = name.length > 0;
  
  if (isInteractive || (hasName && depth < 4)) {
    const ref = node.ref ? ` [ref=${node.ref}]` : '';
    out.push(`${indent}${role}: "${name}"${ref}`);
  }
  
  for (const child of node.children || []) {
    simplifyAxTree(child, depth + 1, out);
  }
  return out;
}

function formatAxTree(treeArray) {
  if (typeof treeArray === 'string') return treeArray;
  return treeArray.join('\n');
}

// ── LLM decision ──────────────────────────────────────────────────
// Ask the LLM what to do next based on the page state.
async function decide(ctx, { goal, constraints, observation, history }) {
  const systemPrompt = `You are a browser automation agent. You see a web page's accessibility tree and must decide the next action to achieve the goal.

RULES:
- Return ONLY valid JSON, no other text.
- Available actions: click, fill, press, goto, wait, done, fail
- For click: target is the element's description (e.g. "the Billing link" or "button labeled Continue")
- For fill: target is the field description, value is the text to enter
- For press: key is like "Enter", "Tab", "Escape"
- For goto: target is the full URL
- For done: goal_complete=true and extracted contains the requested data
- For fail: explain why in reason
- NEVER click anything labeled Cancel, Delete, Remove, or Unsubscribe unless the goal explicitly says to.
- NEVER submit payment forms or enter credit card details.
- If the page shows an error or you're stuck, return fail with the reason.

CONSTRAINTS:
${(constraints || []).map(c => `- ${c}`).join('\n')}`;

  const userPrompt = `GOAL: ${goal}

CURRENT PAGE:
URL: ${observation.url}
Title: ${observation.title}

ACCESSIBILITY TREE:
${formatAxTree(observation.axTree)}

VISIBLE TEXT (snippet):
${observation.textSnippet.slice(0, 1000)}

ACTION HISTORY (what we've tried):
${history.length === 0 ? '(none yet)' : history.map((h, i) => `${i+1}. ${h.action} ${h.target || ''} — ${h.result}`).join('\n')}

What is the next action? Return JSON:
{
  "action": "click|fill|press|goto|wait|done|fail",
  "target": "element description or URL",
  "value": "text for fill action",
  "key": "key for press action",
  "reason": "brief explanation",
  "goal_complete": false,
  "extracted": {}
}`;

  const body = {
    model: env('AGENT_MODEL', 'gpt-4o'),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 500,
    temperature: 0.1,
  };
  
  const base = env('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${env('OPENAI_API_KEY')}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify(body),
  });
  
  if (!res.ok) {
    throw new Error(`LLM decision failed: HTTP ${res.status}`);
  }
  
  const data = await res.json();
  const text = data.choices[0].message.content || '';
  
  // Parse JSON (handle markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('LLM did not return valid JSON');
  }
  
  return JSON.parse(jsonMatch[0]);
}

// ── Action execution ──────────────────────────────────────────────
// Execute the LLM's chosen action via Playwright.
async function executeAction(ctx, page, decision) {
  const { action, target, value, key } = decision;
  
  try {
    switch (action) {
      case 'click': {
        // Try to find the element by its accessible name.
        // Use Playwright's getByRole/getByText for robust matching.
        const clicked = await clickByDescription(page, target);
        return { ok: clicked, detail: clicked ? `clicked ${target}` : `could not find ${target}` };
      }
      case 'fill': {
        const filled = await fillByDescription(page, target, value);
        return { ok: filled, detail: filled ? `filled ${target}` : `could not find ${target}` };
      }
      case 'press': {
        await page.keyboard.press(key || 'Enter');
        await page.waitForTimeout(2000);
        return { ok: true, detail: `pressed ${key}` };
      }
      case 'goto': {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(3000);
        return { ok: true, detail: `navigated to ${target}` };
      }
      case 'wait': {
        await page.waitForTimeout(3000);
        return { ok: true, detail: 'waited' };
      }
      case 'done':
      case 'fail':
        return { ok: true, detail: action };
      default:
        return { ok: false, detail: `unknown action: ${action}` };
    }
  } catch (e) {
    return { ok: false, detail: `action failed: ${e.message}` };
  }
}

// Click an element by its description (fuzzy match on accessible name).
async function clickByDescription(page, description) {
  // Try getByRole with name
  const roles = ['button', 'link', 'menuitem', 'tab'];
  for (const role of roles) {
    try {
      const el = page.getByRole(role, { name: new RegExp(escapeRegExp(description), 'i') });
      if (await el.count() > 0) {
        await el.first().click({ timeout: 5000 });
        await page.waitForTimeout(2000);
        return true;
      }
    } catch {}
  }
  // Try getByText
  try {
    const el = page.getByText(new RegExp(escapeRegExp(description), 'i'));
    if (await el.count() > 0) {
      await el.first().click({ timeout: 5000 });
      await page.waitForTimeout(2000);
      return true;
    }
  } catch {}
  return false;
}

// Fill a field by its description.
async function fillByDescription(page, description, value) {
  const roles = ['textbox', 'combobox', 'searchbox'];
  for (const role of roles) {
    try {
      const el = page.getByRole(role, { name: new RegExp(escapeRegExp(description), 'i') });
      if (await el.count() > 0) {
        await el.first().fill(value, { timeout: 5000 });
        await page.waitForTimeout(1000);
        return true;
      }
    } catch {}
  }
  // Try by placeholder
  try {
    const el = page.getByPlaceholder(new RegExp(escapeRegExp(description), 'i'));
    if (await el.count() > 0) {
      await el.first().fill(value, { timeout: 5000 });
      return true;
    }
  } catch {}
  return false;
}

function escapeRegExp(str) {
  return (str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 50);
}

// ── Main loop ─────────────────────────────────────────────────────
// Run the agentic browser loop for up to maxSteps.
async function navigate(ctx, { goal, constraints = [], maxSteps = 5, onStep } = {}) {
  const page = ctx.page;
  const history = [];
  const steps = [];
  
  for (let i = 0; i < maxSteps; i++) {
    // 1. Observe
    const observation = await observe(page);
    ctx.log && ctx.log('agentic_observe', { 
      step: i + 1, 
      url: observation.url.slice(0, 100),
      title: observation.title.slice(0, 80),
    });
    
    // 2. Decide
    let decision;
    try {
      decision = await decide(ctx, { goal, constraints, observation, history });
    } catch (e) {
      return { 
        ok: false, 
        code: 'llm_failed', 
        note: `LLM decision failed: ${e.message}`,
        steps,
      };
    }
    
    ctx.log && ctx.log('agentic_decide', {
      step: i + 1,
      action: decision.action,
      target: (decision.target || '').slice(0, 80),
      reason: (decision.reason || '').slice(0, 120),
    });
    
    // 3. Check terminal
    if (decision.action === 'done') {
      return {
        ok: true,
        phase: 'done',
        extracted: decision.extracted || {},
        steps,
        note: decision.reason || 'Goal achieved',
      };
    }
    if (decision.action === 'fail') {
      await ctx.screenshot && await ctx.screenshot('agentic-fail').catch(() => {});
      return {
        ok: false,
        code: 'agentic_failed',
        note: decision.reason || 'Agent could not complete the goal',
        steps,
      };
    }
    
    // 4. Execute
    const result = await executeAction(ctx, page, decision);
    const stepRecord = {
      step: i + 1,
      action: decision.action,
      target: decision.target,
      reason: decision.reason,
      result: result.detail,
      url: page.url(),
    };
    steps.push(stepRecord);
    history.push({
      action: decision.action,
      target: decision.target,
      result: result.detail,
    });
    
    if (onStep) onStep(stepRecord);
    
    if (!result.ok && decision.action !== 'wait') {
      // Action failed — let the LLM see the result and try something else
      history.push({
        action: 'note',
        target: '',
        result: `Previous action failed: ${result.detail}. Try a different approach.`,
      });
    }
  }
  
  // Max steps reached — return what we have
  const finalObs = await observe(page).catch(() => null);
  return {
    ok: false,
    code: 'max_steps',
    note: `Reached ${maxSteps} steps without completing goal. Last URL: ${finalObs?.url || 'unknown'}`,
    steps,
    lastUrl: finalObs?.url,
    lastText: finalObs?.textSnippet?.slice(0, 500),
  };
}

module.exports = { navigate, observe, decide };
