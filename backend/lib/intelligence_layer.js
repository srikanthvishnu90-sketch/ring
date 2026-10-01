// backend/lib/intelligence_layer.js — Simplified for Gemini compatibility.
//
// What makes ChatGPT/Claude capable: they see the page, reason simply,
// and act. This version uses simple prompts that work reliably.

const { env } = require('./config');
const { pushFrame, pushStatus } = require('./live_view');

// ── Observation ───────────────────────────────────────────────
async function observe(page) {
  const url = page.url();
  let title = '';
  try { title = await page.title(); } catch {}
  
  let axTree = '';
  try {
    const snapshot = await page.accessibility.snapshot();
    axTree = simplifyAx(snapshot);
  } catch {}
  
  let textSnippet = '';
  try {
    textSnippet = await page.evaluate(() =>
      (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 2000)
    ).catch(() => '');
  } catch {}
  
  return { url, title, axTree, textSnippet };
}

function simplifyAx(node, depth = 0, out = []) {
  if (!node || depth > 5 || out.length > 80) return out;
  const role = node.role || '';
  const name = (node.name || '').slice(0, 50);
  const isInteractive = /button|link|textbox|checkbox|combobox|menuitem|tab/i.test(role);
  if (isInteractive && name) {
    out.push(`${role}: "${name}"`);
  }
  for (const child of node.children || []) simplifyAx(child, depth + 1, out);
  return out;
}

// ── Memory ────────────────────────────────────────────────────
class TaskMemory {
  constructor() {
    this.steps = [];
    this.learnings = [];
  }
  addStep(action, target, result) {
    this.steps.push({ action, target, result });
  }
  addLearning(insight) {
    if (!this.learnings.includes(insight)) this.learnings.push(insight);
  }
  getContext() {
    const steps = this.steps.slice(-8).map((s, i) => `${i+1}. ${s.action} ${s.target} -> ${s.result}`).join('\n');
    return `History:\n${steps || '(none)'}\nLearnings: ${this.learnings.join('; ') || '(none)'}`;
  }
  isLooping(action, target) {
    const recent = this.steps.slice(-4);
    return recent.filter(s => s.action === action && s.target === target).length >= 2;
  }
}

// ── Reasoning ─────────────────────────────────────────────────
// Simple prompt that Gemini handles reliably.
async function reason(memory, { goal, constraints, observation, screenshotBase64 }) {
  const systemPrompt = 'You are a browser automation assistant. You can see the page screenshot. Respond with JSON only.';
  
  const userPrompt = `Goal: ${goal}

Rules:
${(constraints || []).map(c => '- ' + c).join('\n')}

Google Sign-In: If you see "Sign in with Google" or "Continue with Google", CLICK IT. You'll go to accounts.google.com. Type the email, click Next, type the password, click Next. If you see "Choose an account", click the matching email.
Login forms: Type email into the email field, password into password field, then click Sign In / Log In / Continue.
If a step fails, try a different selector or approach. Don't give up after one try.

Page: ${observation.url}
Title: ${observation.title}

${memory.getContext()}

Interactive elements:
${Array.isArray(observation.axTree) ? observation.axTree.join('\n') : observation.axTree}

Page text:
${observation.textSnippet.slice(0, 1200)}

What is the next action? Respond with JSON:
{"action":"click|type|press|goto|wait|done|fail","target":"description of element or URL","value":"text to type","key":"Enter","reason":"brief reason","extracted":{}}`;

  const body = {
    model: env('AGENT_MODEL', 'gpt-4o'),
    messages: screenshotBase64 ? [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [
        { type: 'text', text: userPrompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } },
      ]},
    ] : [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 1000,
    temperature: 0.2,
  };
  
  const base = env('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  let res;
  let lastErr;
  // Retry on 503/429 (model overloaded) with backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env('OPENAI_API_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (res.ok) break;
      if (res.status !== 503 && res.status !== 429) break;
      lastErr = `HTTP ${res.status}`;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    } catch (e) {
      lastErr = e.message;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  
  if (!res || !res.ok) throw new Error(`Model failed: ${lastErr || `HTTP ${res?.status}`}`);
  const data = await res.json();
  const text = data.choices[0].message.content || '';
  
  // Extract JSON: handle markdown code blocks, then bare JSON
  let jsonStr = null;
  const mdMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (mdMatch) {
    jsonStr = mdMatch[1].trim();
  } else {
    // No closing ``` — model returned truncated markdown block. Extract from ```json to end.
    const mdOpen = text.match(/```(?:json)?\s*([\s\S]*)$/);
    if (mdOpen) {
      jsonStr = mdOpen[1].trim();
    } else {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      } else {
        // Bare truncated JSON (no closing brace). Extract from first { to end.
        const bareOpen = text.match(/\{[\s\S]*$/);
        if (bareOpen) jsonStr = bareOpen[0].trim();
      }
    }
  }
  
  if (!jsonStr) throw new Error(`No JSON in response: ${text.slice(0, 200)}`);
  
  // Repair truncated JSON: if it doesn't end with }, try to close it
  if (!jsonStr.endsWith('}')) {
    // Count open braces vs close braces
    const open = (jsonStr.match(/\{/g) || []).length;
    const close = (jsonStr.match(/\}/g) || []).length;
    if (open > close) {
      // Try to close the string value if it's unterminated
      if (jsonStr.match(/"[^"]*$/)) jsonStr += '"';
      jsonStr += '}'.repeat(open - close);
    }
  }
  
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Try to fix truncated JSON by finding the last complete object
    throw new Error(`Invalid JSON: ${e.message}. Got: ${jsonStr.slice(0, 200)}`);
  }
}

// ── Execution ─────────────────────────────────────────────────
// Uses text-based element finding (no coordinates needed).
async function execute(page, decision) {
  const { action, target, value, key } = decision;
  
  try {
    switch (action) {
      case 'click': {
        // Try multiple selector strategies
        const selectors = [
          `a:has-text("${target}")`,
          `button:has-text("${target}")`,
          `[aria-label="${target}"]`,
          `text="${target}"`,
        ];
        for (const sel of selectors) {
          try {
            await page.click(sel, { timeout: 3000 });
            await page.waitForTimeout(2500);
            return { ok: true, detail: `clicked ${target}` };
          } catch {}
        }
        return { ok: false, detail: `could not find ${target}` };
      }
      case 'type': {
        const selectors = [
          `input[placeholder*="${target}" i]`,
          `input[aria-label*="${target}" i]`,
          `textarea[placeholder*="${target}" i]`,
        ];
        for (const sel of selectors) {
          try {
            await page.fill(sel, value || '', { timeout: 3000 });
            await page.waitForTimeout(1000);
            return { ok: true, detail: `typed into ${target}` };
          } catch {}
        }
        // Fallback: click then type
        try {
          await page.click(`text="${target}"`, { timeout: 3000 });
          await page.keyboard.press('ControlOrMeta+a');
          await page.keyboard.type(value || '', { delay: 30 });
          return { ok: true, detail: `typed ${target}` };
        } catch {}
        return { ok: false, detail: `could not type into ${target}` };
      }
      case 'press':
        await page.keyboard.press(key || 'Enter');
        await page.waitForTimeout(2000);
        return { ok: true, detail: `pressed ${key}` };
      case 'goto':
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(3000);
        return { ok: true, detail: `went to ${target}` };
      case 'wait':
        await page.waitForTimeout(3000);
        return { ok: true, detail: 'waited' };
      case 'done':
      case 'fail':
        return { ok: true, detail: action };
      default:
        return { ok: false, detail: `unknown: ${action}` };
    }
  } catch (e) {
    return { ok: false, detail: e.message.slice(0, 80) };
  }
}

// ── Main Loop ─────────────────────────────────────────────────
async function runIntelligent(ctx, { goal, constraints = [], maxSteps = 10, memory = null, passwords = [] } = {}) {
  const page = ctx.page;
  const mem = memory || new TaskMemory();
  const threadId = ctx.threadId || (ctx.job && ctx.job.threadId) || ctx.sessionId;
  // Store passwords in memory for the model to reference
  if (passwords.length > 0) {
    mem.addLearning(`Passwords available: ${passwords.length} provided. Try in order.`);
  }
  
  // Initial frame: show where we're starting
  await pushStatus({ threadId, status: 'starting', detail: goal.slice(0, 100) });
  await pushFrame({ threadId, page, label: 'Starting', step: 0 });
  
  for (let i = 0; i < maxSteps; i++) {
    const observation = await observe(page);
    ctx.log && ctx.log('intel_step', { step: i + 1, url: observation.url.slice(0, 60) });
    
    await pushStatus({ threadId, status: 'thinking', detail: `Step ${i+1}: analyzing ${observation.url.slice(0, 60)}` });
    
    // Capture screenshot for vision (small to avoid token limits)
    let screenshotBase64 = null;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 30 });
      // Resize check: if too large, skip vision for this step
      if (buf.length < 100000) {
        screenshotBase64 = buf.toString('base64');
      }
    } catch {}
    
    let decision;
    try {
      decision = await reason(mem, { goal, constraints, observation, screenshotBase64 });
    } catch (e) {
      await pushStatus({ threadId, status: 'error', detail: e.message.slice(0, 150) });
      return { ok: false, code: 'reasoning_failed', note: e.message.slice(0, 200), steps: mem.steps };
    }
    
    await pushStatus({ threadId, status: 'acting', detail: `${decision.action}: ${decision.target || ''} — ${decision.reason || ''}`.slice(0, 150) });
    
    if (decision.action === 'done') {
      await pushFrame({ threadId, page, label: 'Done', step: i + 1 });
      await pushStatus({ threadId, status: 'done', detail: decision.reason || 'Complete' });
      return { ok: true, phase: 'done', extracted: decision.extracted || {}, steps: mem.steps, note: decision.reason };
    }
    if (decision.action === 'fail') {
      await pushFrame({ threadId, page, label: 'Failed', step: i + 1 });
      await pushStatus({ threadId, status: 'failed', detail: decision.reason || 'Could not complete' });
      return { ok: false, code: 'intel_failed', note: decision.reason || 'Could not complete', steps: mem.steps };
    }
    
    if (mem.isLooping(decision.action, decision.target)) {
      mem.addLearning(`Looping on ${decision.target}, need different approach`);
      mem.addStep(decision.action, decision.target, 'LOOP - trying different');
      continue;
    }
    
    const result = await execute(page, decision);
    mem.addStep(decision.action, decision.target, result.detail);
    ctx.log && ctx.log('intel_action', { action: decision.action, target: (decision.target || '').slice(0, 50), result: result.detail.slice(0, 80) });
    
    // Push frame after each action so the user sees what happened
    await pushFrame({ threadId, page, label: `${decision.action}: ${decision.target || ''}`.slice(0, 60), step: i + 1 });
  }
  
  await pushStatus({ threadId, status: 'max_steps', detail: `Tried ${maxSteps} steps` });
  return { ok: false, code: 'max_steps', note: `Tried ${maxSteps} steps`, steps: mem.steps };
}

module.exports = { runIntelligent, TaskMemory, observe, reason };
