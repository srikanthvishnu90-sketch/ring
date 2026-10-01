// Pending approvals: the trust core. When the agent wants to run a
// medium/high-risk tool, the call is HELD here instead of executing.
// The client renders it as an approval card; resolving 'approve' executes
// the tool, 'decline' drops it. Nothing irreversible runs without this.
//
// Persistence: Supabase (ring_approvals) when configured, in-memory Map
// otherwise. resolve() claims the row atomically (UPDATE ... WHERE
// status='pending'), so double-resolve — including across serverless
// instances — can never execute a tool twice. create() dedupes identical
// pending approvals inside a short window and honors an explicit
// idempotencyKey, so retried agent turns don't stack duplicate cards.
// NOTE: lib/agent.js (transitively: connectors/registry -> social -> threads
// -> this module) requires this file while it is still initializing, so an
// eager require('./agent') here captures its half-built exports and
// TOOLS/DEMO_TOOLS stay undefined forever — every create()/resolve() would
// crash with "Cannot read properties of undefined (reading 'find')".
// Resolve them lazily: by call time agent.js is always fully loaded.
function agentTools() { return require('./agent').TOOLS; }
function agentDemoTools() { return require('./agent').DEMO_TOOLS; }
const { logToolRun } = require('./audit');
const { ENABLED, sbRequest, eq } = require('./supabase');

const TBL = 'ring_approvals';
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

// Ownership policy (the trust core):
//   'demo'     — sandbox cards from unauthenticated demo turns. Anyone may
//                resolve them, but ONLY the simulated DEMO_TOOLS ever run.
//   'local'    — legacy pre-auth cards. NEVER executable by anyone; resolve
//                throws LEGACY_CARD so the client can prompt re-auth.
//   <uuid>     — a real authenticated user's card. Resolving with 'approve'
//                executes the real tool ONLY when opts.executorUserId matches
//                the card owner; otherwise FORBIDDEN.
// create() fails closed on 'local': new cards must be owned by a real user
// or by the 'demo' sandbox — never the shared legacy identity.

// ---- in-memory fallback (local dev) ----
const mem = new Map();
let seq = 1;
const memId = () => 'appr_' + seq++ + '_' + Date.now().toString(36);

function newId() {
  return 'appr_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function toRec(row) {
  return {
    id: row.id,
    tool: row.tool,
    risk: row.risk,
    describe: row.describe,
    args: row.args || {},
    userId: row.user_id,
    threadId: row.thread_id || null,
    idempotencyKey: row.idempotency_key || null,
    status: row.status,
    result: row.result || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null,
  };
}

function toRow(rec) {
  return {
    id: rec.id,
    tool: rec.tool,
    risk: rec.risk,
    describe: rec.describe,
    args: rec.args,
    user_id: rec.userId,
    thread_id: rec.threadId,
    idempotency_key: rec.idempotencyKey,
    status: rec.status,
    result: rec.result,
    created_at: rec.createdAt,
    resolved_at: rec.resolvedAt,
  };
}

function sameArgs(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

async function findDuplicate(toolName, args, userId, threadId) {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
  const rows = await sbRequest(
    `/${TBL}?select=*&status=eq.pending&tool=eq.${eq(toolName)}&user_id=eq.${eq(userId)}&created_at=gte.${eq(since)}&order=created_at.desc&limit=25`
  );
  return (rows || []).find(
    (r) => sameArgs(r.args, args) && (r.thread_id || null) === (threadId || null)
  );
}

function buildRec({ tool, args, userId, threadId, idempotencyKey }) {
  return {
    id: newId(),
    tool: tool.name,
    risk: tool.risk,
    describe: tool.describe,
    args: args || {},
    userId: userId || 'local',
    threadId: threadId || null,
    idempotencyKey: idempotencyKey || null,
    status: 'pending',
    result: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
}

async function create({ toolName, args, userId, threadId, idempotencyKey }, opts = {}) {
  const tool = agentTools().find((t) => t.name === toolName);
  if (!tool) throw new Error('unknown tool: ' + toolName);
  const uid = userId || 'local';
  // Fail closed: the shared legacy 'local' identity may never own new cards.
  // Unauthenticated callers get the 'demo' sandbox; everyone else must be a
  // real authenticated user id.
  if (uid === 'local') {
    throw Object.assign(new Error('approval creation requires authentication'), { code: 'AUTH_REQUIRED' });
  }
  // SAFETY: for subscription_cancel, cancel_approved + sessionId may ONLY be
  // set by the server when chaining the second (terms) approval card after
  // phase 1. The agent/LLM must never smuggle them into the first card —
  // approving "sign in and inspect" must never silently arm cancellation.
  const safeArgs = { ...(args || {}) };
  if (toolName === 'subscription_cancel' && !opts.serverChained) {
    delete safeArgs.cancel_approved;
    delete safeArgs.sessionId;
  }
  const argsForRec = safeArgs;

  if (ENABLED) {
    if (idempotencyKey) {
      const rows = await sbRequest(
        `/${TBL}?select=*&idempotency_key=eq.${eq(idempotencyKey)}&status=eq.pending&limit=1`
      );
      if (rows && rows.length) return toRec(rows[0]);
    }
    const dup = await findDuplicate(tool.name, argsForRec, uid, threadId || null);
    if (dup) return toRec(dup);
    const rec = buildRec({ tool, args: argsForRec, userId: uid, threadId, idempotencyKey });
    await sbRequest(`/${TBL}`, { method: 'POST', body: JSON.stringify(toRow(rec)) });
    return rec;
  }

  // in-memory fallback
  if (idempotencyKey) {
    const hit = [...mem.values()].find(
      (r) => r.status === 'pending' && r.idempotencyKey === idempotencyKey
    );
    if (hit) return hit;
  }
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  const dup = [...mem.values()].find(
    (r) => r.status === 'pending' && r.tool === tool.name && r.userId === uid
      && (r.threadId || null) === (threadId || null) && sameArgs(r.args, argsForRec)
      && new Date(r.createdAt).getTime() > cutoff
  );
  if (dup) return dup;
  const rec = { ...buildRec({ tool, args: argsForRec, userId: uid, threadId, idempotencyKey }), id: memId() };
  mem.set(rec.id, rec);
  return rec;
}

async function get(id) {
  if (ENABLED) {
    const rows = await sbRequest(`/${TBL}?select=*&id=eq.${eq(id)}&limit=1`);
    return rows && rows.length ? toRec(rows[0]) : undefined;
  }
  return mem.get(id);
}

async function listPending(userId) {
  if (ENABLED) {
    const u = userId ? `&user_id=eq.${eq(userId)}` : '';
    const rows = await sbRequest(
      `/${TBL}?select=*&status=eq.pending${u}&order=created_at.desc&limit=100`
    );
    return (rows || []).map(toRec);
  }
  return [...mem.values()].filter(
    (r) => r.status === 'pending' && (!userId || r.userId === userId)
  );
}

async function executeTool(rec, tools) {
  const tool = (tools || agentTools()).find((t) => t.name === rec.tool);
  if (!tool) return { error: 'unknown tool: ' + rec.tool };
  try {
    const out = await tool.fn({ userId: rec.userId, ...rec.args });
    // Multi-phase continuation: if the tool returns need_approval with a sessionId,
    // automatically continue with the approval flag. This handles the case where
    // the tool does phase 1 (search/setup) and needs approval to do phase 2 (confirm).
    //
    // EXCEPTION — subscription_cancel NEVER auto-continues. Its first card only
    // authorizes sign-in/inspection; the exact plan/price/terms are unknown until
    // phase 1 runs. Auto-continuing would silently turn "inspect" approval into
    // cancellation. Instead the need_approval result is returned as-is and
    // resolve() chains a SECOND, separate approval card carrying the exact
    // terms — only approving THAT card may set cancel_approved=true.
    if (out && out.phase === 'need_approval' && out.sessionId && rec.tool !== 'subscription_cancel') {
      const continueArgs = { ...rec.args, sessionId: out.sessionId };
      // Generic flag every multi-phase tool understands (generic_task checks it).
      continueArgs.approved = true;
      // Set the appropriate approval flag based on tool name
      if (rec.tool === 'dining_book') continueArgs.booking_approved = true;
      else if (rec.tool === 'browser_run') continueArgs.booking_approved = true;
      else if (rec.tool === 'ride_book') continueArgs.fare_approved = true;
      // NOTE: subscription_cancel intentionally has no auto-continue branch —
      // its second phase requires a separate terms approval card (see the
      // need_approval exception above and maybeChainSubscriptionCancel).
      // outcomes2 batch (features 51–75)
      else if (['flight_book', 'hotel_book', 'car_rental_book', 'ticket_book', 'appointment_book', 'service_book', 'parking_book'].includes(rec.tool)) continueArgs.booking_approved = true;
      else if (['food_order', 'grocery_order', 'product_order', 'gift_order'].includes(rec.tool)) continueArgs.order_approved = true;
      else if (['bill_pay', 'donate'].includes(rec.tool)) continueArgs.payment_approved = true;
      else if (rec.tool === 'subscription_pause') continueArgs.cancel_approved = true;
      else if (rec.tool === 'return_start') continueArgs.return_approved = true;
      else if (['waitlist_join', 'price_alert', 'unsubscribe_email', 'data_export_request', 'warranty_register'].includes(rec.tool)) continueArgs.task_approved = true;
      
      const out2 = await tool.fn({ userId: rec.userId, ...continueArgs });
      // Return the final result, preserving the session info
      return { ...out2, _phase1: out };
    }
    // Demo executions are always labeled as simulated, whatever the fn says.
    return rec.userId === 'demo' ? { ...out, simulated: true } : out;
  } catch (e) {
    return { error: e.message, code: e.code };
  }
}

// Two-phase honesty for subscription_cancel: after the first ("sign in and
// inspect") card is approved and phase 1 returns need_approval with the exact
// subscription terms, chain a SECOND, separate approval card carrying those
// terms plus the live sessionId. Only approving THAT card may run phase 2
// (cancel_approved=true). Returns a client-renderable card stub, or null.
async function maybeChainSubscriptionCancel(rec) {
  const res = rec && rec.result;
  if (!rec || rec.tool !== 'subscription_cancel') return null;
  if (!res || res.phase !== 'need_approval' || !res.sessionId) return null;
  if (rec.args && rec.args.cancel_approved) return null; // already the 2nd card
  const terms = (res.summary && typeof res.summary === 'object') ? res.summary : {};
  const second = await create({
    toolName: 'subscription_cancel',
    args: {
      merchant: rec.args.merchant,
      email: rec.args.email,
      sessionId: res.sessionId,
      cancel_approved: true,
      terms,
      termsNote: res.note || null,
    },
    userId: rec.userId,
    threadId: rec.threadId,
  }, { serverChained: true });
  return { id: second.id, name: second.tool, args: second.args, describe: second.describe };
}

// Decide which toolset may run for this record, enforcing the ownership
// policy. Throws {code:'LEGACY_CARD'} or {code:'FORBIDDEN'} — never returns
// a real toolset for a card that must not execute.
function toolsetFor(rec, opts) {
  if (rec.userId === 'demo') return agentDemoTools();
  if (rec.userId === 'local') {
    throw Object.assign(
      new Error('legacy approval can no longer be resolved — sign in and retry'),
      { code: 'LEGACY_CARD' }
    );
  }
  if (!opts || opts.executorUserId !== rec.userId) {
    throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' });
  }
  return agentTools();
}

async function resolve(id, decision, opts) {
  const status = decision === 'approve' ? 'approved' : 'declined';
  const now = new Date().toISOString();

  if (ENABLED) {
    const rec0 = await get(id);
    if (!rec0) throw Object.assign(new Error('approval not found'), { code: 'NOT_FOUND' });
    // Policy check BEFORE the atomic claim: a card that must not execute
    // never gets claimed for execution.
    const tools = toolsetFor(rec0, opts);
    // Atomic claim: only a pending row flips. A concurrent resolve on another
    // instance gets zero rows back and returns the already-resolved record —
    // the tool can never execute twice.
    const claimed = await sbRequest(
      `/${TBL}?id=eq.${eq(id)}&status=eq.pending`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status, resolved_at: now }),
      }
    );
    if (!claimed || !claimed.length) {
      const existing = await get(id);
      if (!existing) throw Object.assign(new Error('approval not found'), { code: 'NOT_FOUND' });
      return existing;
    }
    const rec = toRec(claimed[0]);
    if (rec.status === 'approved') {
      rec.result = await executeTool(rec, tools);
      // Chain the second (terms) approval card for subscription_cancel.
      try {
        const followup = await maybeChainSubscriptionCancel(rec);
        if (followup) rec.followupApproval = followup;
      } catch (e) { /* chaining must never break the resolve */ }
      await sbRequest(`/${TBL}?id=eq.${eq(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ result: rec.result }),
      });
      // Audit the approved execution (fire-and-forget; never throws).
      logToolRun({
        userId: rec.userId, tool: rec.tool, args: rec.args, result: rec.result,
        approvalId: rec.id, status: rec.result && rec.result.error ? 'failed' : 'executed',
      }).catch(() => {});
      // Post the honest result to the chat thread (fire-and-forget; never throws).
      // CRITICAL: Never claim "booked" without a real confirmationRef.
      postApprovalResult(rec).catch(() => {});
    } else {
      // Declined: nothing executed — audit the hold, not an execution.
      logToolRun({
        userId: rec.userId, tool: rec.tool, args: rec.args,
        result: { declined: true }, approvalId: rec.id, status: 'held',
      }).catch(() => {});
    }
    return rec;
  }

  // in-memory fallback
  const rec = mem.get(id);
  if (!rec) throw Object.assign(new Error('approval not found'), { code: 'NOT_FOUND' });
  const tools = toolsetFor(rec, opts);
  if (rec.status !== 'pending') return rec;
  rec.status = status;
  rec.resolvedAt = now;
  if (rec.status === 'approved') {
    rec.result = await executeTool(rec, tools);
    try {
      const followup = await maybeChainSubscriptionCancel(rec);
      if (followup) rec.followupApproval = followup;
    } catch (e) { /* chaining must never break the resolve */ }
    logToolRun({
      userId: rec.userId, tool: rec.tool, args: rec.args, result: rec.result,
      approvalId: rec.id, status: rec.result && rec.result.error ? 'failed' : 'executed',
    }).catch(() => {});
    postApprovalResult(rec).catch(() => {});
  } else {
    logToolRun({
      userId: rec.userId, tool: rec.tool, args: rec.args,
      result: { declined: true }, approvalId: rec.id, status: 'held',
    }).catch(() => {});
  }
  return rec;
}

// Post the tool execution result as an honest chat message.
// CRITICAL RULE: Never claim "booked" without a real confirmationRef.
// If the tool succeeded with proof, report the confirmation.
// If it failed, report the failure honestly. Never fake success.
async function postApprovalResult(rec) {
  if (!rec.threadId) return;
  const result = rec.result || {};
  const tool = rec.tool;
  
  let message;
  
  if (tool === 'dining_book') {
    if (result.ok && result.confirmationRef) {
      // REAL booking with proof
      message = `Booked ${result.restaurant || 'the restaurant'} for ${result.partySize || result.party} on ${result.date} at ${result.time}. Confirmation: ${result.confirmationRef}`;
    } else {
      // Honest failure - never claim booked. Don't duplicate the terminal
      // "Nothing was booked" if the reason already says it.
      const reason = result.note || result.error || 'The booking could not be completed.';
      const alreadyTerminal = /nothing was (booked|done|ordered)/i.test(reason);
      message = `I couldn't complete the booking. ${reason}${alreadyTerminal ? '' : ' Nothing was booked.'}`;
    }
  } else if (tool === 'ride_book') {
    if (result.ok && (result.orderId || result.confirmationRef)) {
      message = `Ride booked. Confirmation: ${result.orderId || result.confirmationRef}`;
    } else {
      const reason = result.note || 'Please try again.';
      const alreadyTerminal = /nothing was (booked|done|ordered)/i.test(reason);
      message = `I couldn't book the ride. ${reason}${alreadyTerminal ? '' : ' Nothing was ordered.'}`;
    }
  } else if (tool === 'subscription_cancel') {
    // Phase-honest: only claim cancelled with provider proof (cancelRef).
    // need_input relays the required user action; a "cancelled" page without
    // a reference is reported as unverified, never a bare "Done" and never
    // a fabricated reference.
    if (result.ok && result.phase === 'done' && result.cancelRef) {
      message = `Cancelled ${result.merchant || 'the subscription'}. Confirmation: ${result.cancelRef}`;
    } else if (result.ok && result.phase === 'done') {
      message = `The MyClaw page indicated the subscription was cancelled, but no confirmation reference appeared — a screenshot was saved for review. Please verify in your MyClaw account before counting this as done.`;
    } else if (result.phase === 'need_input') {
      message = result.prompt || 'I need something from you to continue the cancellation.';
    } else if (result.phase === 'need_approval') {
      message = 'The subscription details are on the approval card above — approve it to continue with the cancellation.';
    } else {
      const reason = result.note || result.error || 'The cancellation could not be completed.';
      const alreadyTerminal = /nothing was (cancelled|done)/i.test(reason);
      message = `I couldn't complete the cancellation. ${reason}${alreadyTerminal ? '' : ' Nothing was cancelled.'}`;
    }
  } else {
    // Generic: phase-aware honesty — an unfinished phase is never "completed".
    const phase = result.phase;
    if (phase === 'need_input') {
      message = result.prompt || result.note || `${tool} needs your input to continue.`;
    } else if (phase === 'need_approval') {
      message = 'Review the approval card above and approve to continue.';
    } else if (phase && phase !== 'done') {
      message = result.note || `${tool} is still in progress — not done yet.`;
    } else if (result.ok) {
      message = result.note || `${tool} completed.`;
    } else {
      message = result.note || `${tool} could not be completed. Nothing was done.`;
    }
  }
  
  // Post as the agent via Supabase directly (avoids circular require with threads.js)
  try {
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();
    if (ENABLED) {
      await sbRequest(`/ring_messages`, {
        method: 'POST',
        body: JSON.stringify({
          id: msgId,
          thread_id: rec.threadId,
          sender: 'ring assistant',
          text: message,
          created_at: now,
        }),
      });
    }
    // Note: SSE broadcast happens via Supabase Realtime; the message will appear
    // in the chat on next poll/refresh. The approval card result is also returned
    // to the frontend via the resolve() API response.
  } catch (e) {
    // Log but never throw - the approval result is already stored
    console.error('[approvals] postApprovalResult failed:', e.message);
  }
}

module.exports = { create, get, listPending, resolve };
