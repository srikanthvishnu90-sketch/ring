// backend/lib/sites/subscription.js — dispatcher for 'cancel-subscription'.
//
// Routes to a merchant-specific module (sites/<merchant>.js) based on
// job.merchant. Each merchant module implements 'cancel-subscription'.

const MERCHANT_MODULES = {
  myclaw: './myclaw',
  // cluely: './cluely', devin: './devin', — add as built
};

async function cancelSubscription(ctx, job) {
  const merchant = String(job.merchant || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const modPath = MERCHANT_MODULES[merchant];
  if (!modPath) {
    return {
      ok: false, code: 'merchant_not_implemented',
      note: `No cancellation flow implemented for merchant "${job.merchant}". Implemented: ${Object.keys(MERCHANT_MODULES).join(', ')}.`,
    };
  }
  let mod;
  try {
    mod = require(modPath);
  } catch (e) {
    return { ok: false, code: 'site_load_failed', note: `Could not load ${modPath}: ${String(e.message).slice(0, 120)}` };
  }
  const fn = mod && mod['cancel-subscription'];
  if (typeof fn !== 'function') {
    return { ok: false, code: 'kind_not_implemented', note: `${modPath} does not implement cancel-subscription.` };
  }
  ctx.log('merchant_dispatch', { merchant });
  return fn(ctx, job);
}

module.exports = {
  'cancel-subscription': cancelSubscription,
};
