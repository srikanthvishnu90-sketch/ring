// backend/lib/sites/subscription.js — dispatcher for 'cancel-subscription'.
//
// GENERAL METHOD (like ChatGPT/Claude): No per-merchant code. The agentic
// browser sees the page and figures out how to cancel, just like a human
// would. Merchant-specific modules (myclaw) are used only if they exist;
// otherwise the generic agentic flow handles any merchant.

const MERCHANT_MODULES = {
  myclaw: './myclaw',
  // Merchant-specific modules are optional optimizations.
  // The generic agentic flow below handles any merchant.
};

async function cancelSubscription(ctx, job) {
  const merchant = String(job.merchant || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const email = job.email || job.accountEmail || '';
  
  // Try merchant-specific module first (if it exists)
  const modPath = MERCHANT_MODULES[merchant];
  if (modPath) {
    try {
      const mod = require(modPath);
      const fn = mod && mod['cancel-subscription'];
      if (typeof fn === 'function') {
        ctx.log('merchant_dispatch', { merchant, via: 'specific' });
        return fn(ctx, job);
      }
    } catch (e) {
      ctx.log('merchant_specific_failed', { merchant, msg: String(e.message).slice(0, 100) });
      // Fall through to generic
    }
  }
  
  // GENERIC FLOW: Use the intelligence layer for any merchant.
  // This is how ChatGPT/Claude/Operator do it — see screenshots,
  // reason with vision, click coordinates, remember, self-correct.
  ctx.log('merchant_dispatch', { merchant, via: 'intelligence_layer' });
  try {
    const intel = require('../intelligence_layer');
    const page = ctx.page;
    
    // Navigate to the merchant's site
    const merchantUrls = {
      elevenlabs: 'https://elevenlabs.io',
      myclaw: 'https://myclaw.ai',
    };
    const startUrl = merchantUrls[merchant] || `https://${merchant}.com`;
    
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
    
    // Intelligence layer: see → reason → act → verify
    // Phase 1: Sign in and locate subscription (stops before cancelling)
    const inspectResult = await intel.runIntelligent(ctx, {
      goal: `Sign in to ${merchant} (account email: ${email}) and navigate to the billing/subscription management page. Find the current plan name, price, billing period, and cancellation policy. DO NOT cancel yet — just gather the details and report them.`,
      constraints: [
        'Do NOT click Cancel, Delete, Remove, Unsubscribe, or any cancellation confirmation button.',
        'Do NOT submit payment forms or enter credit card details.',
        'If sign-in requires a password you don\'t have, look for "Forgot password" and check Gmail for reset emails.',
        `The account email is ${email}. Use it wherever an email is needed.`,
        'Take screenshots seriously — look at the visual layout to find navigation.',
      ],
      maxSteps: 12,
    });
    
    if (!inspectResult.ok) {
      await ctx.screenshot && await ctx.screenshot(`${merchant}-agentic-fail`).catch(() => {});
      return {
        ok: false,
        code: inspectResult.code || 'agentic_failed',
        note: `Couldn't reach ${merchant} subscription details. ${inspectResult.note || ''} Nothing was cancelled.`.slice(0, 300),
      };
    }
    
    // Return need_approval with the extracted details
    const extracted = inspectResult.extracted || {};
    return {
      ok: true,
      phase: 'need_approval',
      sessionId: ctx.sessionId,
      summary: {
        merchant,
        email,
        plan: extracted.plan || 'Unknown plan',
        price: extracted.price || 'Unknown price',
        billingPeriod: extracted.billingPeriod || extracted.cadence || 'Unknown',
        cancellationPolicy: extracted.policy || extracted.cancellationPolicy || 'Unknown',
        effectiveDate: extracted.effectiveDate || extracted.accessEnd || 'Unknown',
      },
      note: `Found ${merchant} subscription. Review the details and approve to cancel.`,
    };
  } catch (e) {
    return {
      ok: false,
      code: 'generic_flow_failed',
      note: `Generic cancellation flow failed for ${merchant}: ${String((e && e.message) || e).slice(0, 150)}. Nothing was cancelled.`,
    };
  }
}

module.exports = {
  'cancel-subscription': cancelSubscription,
};
