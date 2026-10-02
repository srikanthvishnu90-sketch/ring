# Ring "Doing" Features Audit
**Date:** 2026-10-01
**Scope:** Every feature where Ring actually DOES something (not just answers)
**Total doing-features found:** 43

## Status Key
- ✅ WORKS — Verified real transaction completed
- 🟡 CODE EXISTS — Implemented and deployed, never completed a real transaction
- 🔴 NOT BUILT — No code exists
- ⬜ BLOCKED — Needs user action, API key, or external dependency

---

## HIGH-RISK Action Tools (10)

These perform irreversible real-world actions. All require approval cards.

| # | Tool | What it does | Status | Blocker |
|---|------|--------------|--------|---------|
| 1 | `ride_book` | Books a real Uber ride via browser automation | 🟡 CODE EXISTS | Never completed a real booking. Needs: user pickup/dropoff, phone, fare approval, Uber account login. Driver: `sites/uber.js` exists. |
| 2 | `browser_run` | Generic browser job runner (rides, logins, tasks) | 🟡 CODE EXISTS | Framework exists (`sites/_framework.js`). Used by ride_book, subscription_cancel. Never verified E2E on a real site. |
| 3 | `dining_book` | Books restaurant table via OpenTable | 🟡 CODE EXISTS | Driver `sites/dining.js` exists. OpenTable has Akamai bot protection — previous Alla Vita attempt got "Access Denied." Never completed a real booking. |
| 4 | `dining_change` | Changes/cancels restaurant reservation | 🟡 CODE EXISTS | Same OpenTable bot issue as dining_book. Never tested. |
| 5 | `subscription_cancel` | Cancels subscriptions via browser (two-approval flow) | 🟡 CODE EXISTS | Full tool chain built 2026-10-01: browser_open → browser_continue → browser_inspect → browser_act. Driver `sites/subscription.js` exists. BLOCKED on merchant login (e.g., ElevenLabs needs Google OAuth via user Take Over). |
| 6 | `gmail_send` | Sends email as the user | 🟡 CODE EXISTS | Needs Gmail OAuth connected. Risk: sending under user's name. Requires exact-draft approval per standing rules. |
| 7 | `gmail_reply` | Replies to an email thread | 🟡 CODE EXISTS | Same as gmail_send — needs OAuth + approval. |
| 8 | `gmail_forward` | Forwards an email | 🟡 CODE EXISTS | Same as gmail_send — needs OAuth + approval. |
| 9 | `browser_act` | Clicks/fills in browser (used for cancellations) | 🟡 CODE EXISTS | Deployed 2026-10-01. Never used in a real cancellation yet. |
| 10 | `note_delete` | Deletes a user note | 🟡 CODE EXISTS | Low-stakes. Likely works but never explicitly verified. |

---

## MEDIUM-RISK Action Tools (9)

These modify state but are reversible or low-consequence.

| # | Tool | What it does | Status | Blocker |
|---|------|--------------|--------|---------|
| 11 | `calendar_create` | Creates a calendar event | 🟡 CODE EXISTS | Needs Google Calendar OAuth. Code exists in `google.js`. |
| 12 | `calendar_update` | Updates/reschedules an event | 🟡 CODE EXISTS | Same OAuth dependency. |
| 13 | `calendar_delete` | Deletes a calendar event | 🟡 CODE EXISTS | Same OAuth dependency. |
| 14 | `calendar_from_email` | Creates event from email invite | 🟡 CODE EXISTS | Needs Gmail + Calendar OAuth. |
| 15 | `gmail_draft` | Saves an email draft (doesn't send) | 🟡 CODE EXISTS | Needs Gmail OAuth. Safe — doesn't send. |
| 16 | `gmail_archive` | Archives an email | 🟡 CODE EXISTS | Needs Gmail OAuth. |
| 17 | `gmail_delete` | Moves email to trash | 🟡 CODE EXISTS | Needs Gmail OAuth. Reversible (trash). |
| 18 | `gmail_mark` | Marks read/unread | 🟡 CODE EXISTS | Needs Gmail OAuth. |
| 19 | `gmail_star` | Stars/unstars an email | 🟡 CODE EXISTS | Needs Gmail OAuth. |

---

## LOW-RISK State-Changing Tools (7)

These write state but are not destructive.

| # | Tool | What it does | Status | Blocker |
|---|------|--------------|--------|---------|
| 20 | `browser_open` | Opens URL in live Browserbase session | 🟡 CODE EXISTS | Verified: creates session, navigates. But: single screenshot only (no continuous live view), serverless persistence fixed 2026-10-01 via Supabase. Take Over URL works. |
| 21 | `browser_continue` | Resumes session after user takeover | 🟡 CODE EXISTS | Deployed 2026-10-01. Never tested E2E with real takeover → resume. |
| 22 | `browser_inspect` | Extracts page text, prices, dates | 🟡 CODE EXISTS | Deployed 2026-10-01. Never tested on a real subscription page. |
| 23 | `browser_close` | Closes browser session, cleans up | 🟡 CODE EXISTS | Deployed 2026-10-01. |
| 24 | `memory_save` | Saves a durable fact/preference | ✅ WORKS | Verified in output quality testing (Task 15): saved peanut allergy, recalled it correctly in next turn. |
| 25 | `note_save` | Saves a user note | 🟡 CODE EXISTS | Code exists. Not explicitly verified. |
| 26 | `health_log` | Logs a health metric | 🟡 CODE EXISTS | Code exists. Not verified. |

---

## Benchmark "Doing" Features (13)

From benchmarks.md categories 2, 6, 7, 8.

### Category 2: Agentic Capability

| # | Benchmark | Pts | Status | Blocker |
|---|-----------|-----|--------|---------|
| 2.1 | Multi-step tasks end-to-end (find → approval → booking) | 3 | 🟡 CODE EXISTS | Tools exist. Never completed a full find→approve→book flow with real outcome. |
| 2.2 | 8+ working connectors | 3 | 🟡 CODE EXISTS | Has: Gmail, Calendar, Places, Rides (Uber), Dining (OpenTable). Missing: messaging, payments, smart home. That's 5/8. |
| 2.3 | Long-running work continues after app closes + notification | 2 | 🔴 NOT BUILT | No background job system. No push notifications for completed work. |
| 2.4 | Shareable deliverables (own surface, not chat dump) | 2 | 🟡 CODE EXISTS | Doc-block format implemented (`doc:Title` fenced blocks). Verified in testing — Ring produced formatted documents. |
| 2.5 | Proactive triggers ("nudge me when…") | 2 | 🔴 NOT BUILT | No trigger/scheduler system for user-defined nudges. |
| 2.6 | Group chats: @-mention routing, in-thread approvals | 3 | 🟡 CODE EXISTS | Code exists for @ring in group chats. Never tested with real multi-user group. |

### Category 6: Reliability

| # | Benchmark | Pts | Status | Blocker |
|---|-----------|-----|--------|---------|
| 6.1 | Idempotent irreversible actions (no double-book/double-charge) | 3 | 🟡 CODE EXISTS | Approval idempotency implemented (dedupe + atomic resolve). Never stress-tested with real double-tap. |
| 6.4 | Full audit trail (what/when/args/result/who approved) | 2 | ✅ WORKS | `ring_tool_runs` table exists and logs. Verified in code. |

### Category 7: Trust & Safety

| # | Benchmark | Pts | Status | Blocker |
|---|-----------|-----|--------|---------|
| 7.1 | Risk-tiered approvals enforced, no bypass | 3 | ✅ WORKS | Approval gates in agent.js. Red-team tested (15 probes passed per 2026-09-21 log). |
| 7.2 | Approval cards show exact details before tap | 2 | 🟡 CODE EXISTS | Card format exists. Verified in Task 1 test — first card correctly showed "sign-in only" scope. Second card (exact terms) not yet tested E2E. |
| 7.5 | Destructive actions need confirmation + undo window | 1 | 🟡 CODE EXISTS | Confirmation via approval cards. No explicit undo window implemented. |

### Category 8: Memory

| # | Benchmark | Pts | Status | Blocker |
|---|-----------|-----|--------|---------|
| 8.1 | Remembers facts across sessions | 2 | ✅ WORKS | Verified: peanut allergy saved and recalled across turns in testing. |
| 8.2 | User can view/edit/delete memories | 1 | 🟡 CODE EXISTS | `memory_list` exists. Edit/delete endpoints exist (`/api/memories/:id`). UI not verified. |

---

## NOT BUILT — Missing Doing-Features (4+)

Features the user asked about that don't exist:

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Order Uber Eats / food delivery | 🔴 NOT BUILT | No `food_order` tool. Could use browser_open + browser_act manually, but no clean flow. |
| 2 | Text/send message to group chat | 🔴 NOT BUILT | No messaging send tool. Telegram webhook receives, but no `telegram_send` or `group_message` tool in agent. |
| 3 | Send photos from media library | 🔴 NOT BUILT | No media library access. No photo picker. |
| 4 | Smart home controls | 🔴 NOT BUILT | No smart home connector (would be needed for 2.2's 8+ connectors). |
| 5 | Payment processing | 🔴 NOT BUILT | Excluded by owner order (Stripe is last). |
| 6 | Background notifications | 🔴 NOT BUILT | Needed for 2.3. No push notification system for completed work. |

---

## Summary Counts

| Status | Count | % |
|--------|-------|---|
| ✅ WORKS (verified real transaction) | 4 | 9% |
| 🟡 CODE EXISTS (never tested E2E) | 33 | 77% |
| 🔴 NOT BUILT | 6 | 14% |
| ⬜ BLOCKED (external dependency) | 0 | 0%* |

*Blocked items are counted under CODE EXISTS with blocker noted, since the code is ready.

**The core problem:** 77% of doing-features have code but have never completed a real-world transaction. Ring can *talk* about doing things (93.44% output quality) but has almost no verified *doing* track record.

## Top Blockers to Fix

1. **Google OAuth not connected** — Blocks all 9 Gmail tools + 4 Calendar tools (13 features). User must complete OAuth consent.
2. **Merchant logins** — Blocks subscription_cancel, ride_book, dining_book. Each needs user Take Over login.
3. **OpenTable bot protection** — Blocks dining_book/dining_change. Akamai returns Access Denied.
4. **Missing API keys** — DUFFEL_API_KEY blocks flight search. No Stripe (by owner order).
5. **No messaging send** — Blocks group chat texting. Needs new tool.
6. **No background jobs** — Blocks 2.3 (long-running work) and 2.5 (proactive triggers).
