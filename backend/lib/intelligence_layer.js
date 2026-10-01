// backend/lib/intelligence_layer.js — How ChatGPT/Claude/Operator do browser tasks.
//
// The core insight: large models don't use selectors. They SEE the screen
// (screenshots), REASON about what they're looking at (vision-language),
// and ACT by clicking coordinates. They remember everything and self-correct.
//
// This module replicates that:
//   1. Screenshot → the model sees actual pixels, not just text
//   2. Vision reasoning → chain-of-thought about what to do next
//   3. Coordinate actions → click (x,y), no brittle selectors
//   4. Session memory → full history of what was tried
//   5. Self-correction → verify each action worked, adapt if not

const { env } = require('./config');

// ── Observation: See Like a Human ─────────────────────────────
// Capture screenshot + AX tree + URL. The screenshot is the primary
// input — it's what lets the model understand visual layout.
async function observe(page) {
  const url = page.url();
  let title = '';
  try { title = await page.title(); } catch {}
  
  // Screenshot: the model SEES the page
  let screenshotBase64 = null;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
    screenshotBase64 = buf.toString('base64');
  } catch (e) {
    // Screenshot failed, continue with AX tree only
  }
  
  // AX tree: supplementary structure
  let axTree = '';
  try {
    const snapshot = await page.accessibility.snapshot();
    axTree = simplifyAx(snapshot);
  } catch {}
  
  // Visible text: fallback context
  let textSnippet = '';
  try {
    textSnippet = await page.evaluate(() =>
      (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 1500)
    ).catch(() => '');
  } catch {}
  
  return { url, title, screenshotBase64, axTree, textSnippet };
}

function simplifyAx(node, depth = 0, out = []) {
  if (!node || depth > 6 || out.length > 100) return out;
  const role = node.role || '';
  const name = (node.name || '').slice(0, 60);
  const isInteractive = /button|link|textbox|checkbox|combobox|menuitem|tab/i.test(role);
  if (isInteractive && name) {
    out.push(`${'  '.repeat(depth)}${role}: "${name}"`);
  }
  for (const child of node.children || []) simplifyAx(child, depth + 1, out);
  return out;
}

// ── Session Memory ────────────────────────────────────────────
// Remember everything across the entire task, not just one phase.
// This is what lets the model learn from mistakes and avoid loops.
class TaskMemory {
  constructor() {
    this.steps = [];       // Every action taken + result
    this.observations = []; // What was seen
    this.learnings = [];    // Key insights ("billing is under avatar menu")
  }
  
  addStep(action, target, result, reasoning) {
    this.steps.push({ action, target, result, reasoning, t: Date.now() });
  }
  
  addLearning(insight) {
    if (!this.learnings.includes(insight)) {
      this.learnings.push(insight);
    }
  }
  
  // Build the context for the next decision
  getContext() {
    const recentSteps = this.steps.slice(-10).map((s, i) => 
      `${i+1}. ${s.action} ${s.target || ''} → ${s.result}`
    ).join('\n');
    
    return `PREVIOUS ACTIONS (most recent last):
${recentSteps || '(none yet)'}

KEY LEARNINGS:
${this.learnings.map(l => `- ${l}`).join('\n') || '(none yet)'}`;
  }
  
  // Detect loops: same action+target repeated
  isLooping(action, target) {
    const recent = this.steps.slice(-4);
    return recent.filter(s => s.action === action && s.target === target).length >= 2;
  }
}

// ── Vision Reasoning: Think Like Claude ───────────────────────
// Send screenshot + context to the vision model.
// The model reasons step-by-step, then outputs a structured action.
async function reason(memory, { goal, constraints, observation }) {
  const systemPrompt = `You are an expert browser automation agent, like ChatGPT Operator or Claude Computer Use. You see screenshots of web pages and decide what to do.

HOW YOU THINK:
1. OBSERVE: What do you see on the screen? Where are you? What's visible?
2. ORIENT: How does this relate to the goal? What have you tried? What worked?
3. DECIDE: What's the single best next action? Be specific.
4. VERIFY: After acting, you'll see the result. If it didn't work, try differently.

RULES:
- Return ONLY valid JSON, no other text.
- Actions: click, type, press, scroll, goto, wait, done, fail
- For click: provide coordinates as {x, y} (0-1000 scale, estimate from screenshot)
- For type: provide coordinates {x, y} of the field + text to type
- For press: key like "Enter", "Tab", "Escape"
- For scroll: direction "up" or "down"
- For goto: full URL
- For done: include extracted data
- NEVER click Cancel/Delete/Remove/Unsubscribe unless the goal says to cancel.
- NEVER enter payment details.
- If stuck in a loop, try a completely different approach.
- If the page shows an error, describe it and try to recover.

CONSTRAINTS:
${(constraints || []).map(c => `- ${c}`).join('\n')}`;

  const userContent = [
    {
      type: 'text',
      text: `GOAL: ${goal}

CURRENT PAGE:
URL: ${observation.url}
Title: ${observation.title}

${memory.getContext()}

ACCESSIBILITY TREE (supplementary):
${Array.isArray(observation.axTree) ? observation.axTree.join('\n') : observation.axTree}

VISIBLE TEXT:
${observation.textSnippet.slice(0, 800)}

Look at the screenshot. What do you see? What's the next action?

Return JSON:
{
  "observe": "what you see on screen (1-2 sentences)",
  "orient": "how this relates to goal + what you've learned (1-2 sentences)",
  "action": "click|type|press|scroll|goto|wait|done|fail",
  "x": 500,
  "y": 300,
  "text": "text to type (for type action)",
  "key": "Enter (for press action)",
  "url": "https://... (for goto action)",
  "direction": "down (for scroll action)",
  "reason": "why this action (1 sentence)",
  "goal_complete": false,
  "extracted": {},
  "learning": "key insight to remember (optional)"
}`,
    },
  ];
  
  // Add screenshot if available
  if (observation.screenshotBase64) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${observation.screenshotBase64}`,
        detail: 'low', // faster + cheaper, sufficient for UI understanding
      },
    });
  }

  const body = {
    model: env('AGENT_MODEL', 'gpt-4o'),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: 800,
    temperature: 0.1,
  };
  
  const base = env('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  
  if (!res.ok) throw new Error(`Vision model failed: HTTP ${res.status}`);
  
  const data = await res.json();
  const text = data.choices[0].message.content || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Model did not return JSON');
  
  return JSON.parse(jsonMatch[0]);
}

// ── Action Execution: Act Like a Human ────────────────────────
// Execute actions using coordinates (like Operator does).
async function execute(page, decision, viewport) {
  const { action, x, y, text, key, url, direction } = decision;
  const vw = viewport?.width || 1280;
  const vh = viewport?.height || 720;
  
  // Convert 0-1000 scale to pixels
  const px = Math.round((x / 1000) * vw);
  const py = Math.round((y / 1000) * vh);
  
  try {
    switch (action) {
      case 'click':
        await page.mouse.click(px, py);
        await page.waitForTimeout(2500);
        return { ok: true, detail: `clicked (${x},${y})` };
      
      case 'type':
        await page.mouse.click(px, py);
        await page.waitForTimeout(500);
        // Clear existing text, then type
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(text || '', { delay: 30 });
        await page.waitForTimeout(1000);
        return { ok: true, detail: `typed into (${x},${y})` };
      
      case 'press':
        await page.keyboard.press(key || 'Enter');
        await page.waitForTimeout(2000);
        return { ok: true, detail: `pressed ${key}` };
      
      case 'scroll':
        await page.mouse.wheel(0, direction === 'up' ? -500 : 500);
        await page.waitForTimeout(1500);
        return { ok: true, detail: `scrolled ${direction}` };
      
      case 'goto':
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(3000);
        return { ok: true, detail: `went to ${url}` };
      
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
    return { ok: false, detail: `failed: ${e.message.slice(0, 80)}` };
  }
}

// ── Main Loop: The Intelligence ───────────────────────────────
// This is the core: observe → reason → act → verify → repeat.
// Like ChatGPT Operator, it keeps going until the goal is done.
async function runIntelligent(ctx, { goal, constraints = [], maxSteps = 10, memory = null } = {}) {
  const page = ctx.page;
  const mem = memory || new TaskMemory();
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  
  for (let i = 0; i < maxSteps; i++) {
    // 1. OBSERVE: See the page like a human
    const observation = await observe(page);
    ctx.log && ctx.log('intel_observe', {
      step: i + 1,
      url: observation.url.slice(0, 80),
      hasScreenshot: !!observation.screenshotBase64,
    });
    
    // 2. REASON: Think like Claude
    let decision;
    try {
      decision = await reason(mem, { goal, constraints, observation });
    } catch (e) {
      return { ok: false, code: 'reasoning_failed', note: e.message, steps: mem.steps };
    }
    
    ctx.log && ctx.log('intel_decide', {
      step: i + 1,
      observe: (decision.observe || '').slice(0, 100),
      action: decision.action,
      reason: (decision.reason || '').slice(0, 100),
    });
    
    // 3. CHECK TERMINAL
    if (decision.action === 'done') {
      if (decision.learning) mem.addLearning(decision.learning);
      return {
        ok: true,
        phase: 'done',
        extracted: decision.extracted || {},
        steps: mem.steps,
        note: decision.reason || 'Goal achieved',
      };
    }
    if (decision.action === 'fail') {
      await ctx.screenshot && await ctx.screenshot('intel-fail').catch(() => {});
      return {
        ok: false,
        code: 'intel_failed',
        note: decision.reason || 'Could not complete goal',
        steps: mem.steps,
      };
    }
    
    // 4. CHECK LOOPS: Don't repeat the same failing action
    if (decision.action === 'click' || decision.action === 'type') {
      const target = `${decision.x},${decision.y}`;
      if (mem.isLooping(decision.action, target)) {
        mem.addLearning(`Clicking (${target}) repeatedly doesn't work — tried different approach needed`);
        // Force the model to try something different next time
        mem.addStep(decision.action, target, 'LOOP DETECTED — must try different approach', decision.reason);
        continue;
      }
    }
    
    // 5. ACT: Execute like a human
    const result = await execute(page, decision, viewport);
    mem.addStep(decision.action, `${decision.x},${decision.y}`, result.detail, decision.reason);
    if (decision.learning) mem.addLearning(decision.learning);
    
    // 6. VERIFY: Check if we're making progress (implicit in next observation)
    // The next loop's observation will show whether the action worked.
  }
  
  const lastObs = await observe(page).catch(() => null);
  return {
    ok: false,
    code: 'max_steps',
    note: `Tried ${maxSteps} steps. Last saw: ${lastObs?.url || 'unknown'}`,
    steps: mem.steps,
    learnings: mem.learnings,
  };
}

module.exports = { runIntelligent, TaskMemory, observe, reason };
