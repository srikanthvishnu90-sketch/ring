# Ring 50-Capability Implementation Research

**Date:** 2026-09-30
**Purpose:** Deep research foundation for implementing all 50 Ring features end-to-end —
real execution through Ring's production chat + approval path, with independent
external verification. This is the build plan, not a status report.

**Strict benchmark recap (per feature):** (1) Ring handles the request; (2) 3 genuinely
different realistic scenarios; (3) correct tool with real-world outcome; (4) exact
production approval card for consequential actions; (5) user approves exact
recipient/content/action/amount; (6) Ring executes after approval; (7) independently
verify external state; (8) only then mark complete.

---

## 1. Architecture map (how a feature actually executes)

```
User chat → POST /api/chat → runAgentTurn (backend/lib/agent.js)
  → LLM picks tool from TOOLS → risk tier check
  → low: executes immediately
  → medium/high: creates ring_approvals row → renders approval card
  → user taps Approve → POST /api/approvals/:id/resolve
  → approvals.resolve() → executeTool(rec) → tool fn runs → result stored
  → agent follow-up message (should describe outcome honestly)
```

### Tool registration (critical — there are TWO ride_books)

`backend/lib/agent.js`:
```js
const _seen = new Set(_RAW_TOOLS.map((t) => t.name));
const TOOLS = [
  ...require('../connectors/registry').allTools().filter((t) => !_seen.has(t.name)),
  ..._RAW_TOOLS,
];
```
**`_RAW_TOOLS` wins on name collision.** Consequences:
- `ride_book` → agent.js line 71 version, which does `require('./local_driver')` directly.
  The outcomes.js tiered `ride_book` (deep-link fallback) is **shadowed and never runs**.
- `browser_run` → agent.js line 93 version, also hardcoded to `local_driver`.
- All other outcomes tools (`dining_book`, `dining_change`, `subscription_cancel`,
  `dining_tonight`, `web_login_task`, `web_form_fill`, `order_status`, `price_check`,
  `reservation_fix`) come from `backend/connectors/outcomes.js` via the registry and
  use the tiered `browserRun()` → `browserDriver.execute(job)`.

### Driver selection (`backend/server.js` lines 54–70)

```js
const bbKeys = BROWSERBASE_API_KEY && BROWSERBASE_PROJECT_ID;
const useLocal = process.env.RING_LOCAL_BROWSER === '1';
const { createDriver } = bbKeys
  ? require('./lib/browser_driver')      // Browserbase cloud
  : useLocal
    ? require('./lib/local_driver')      // local Chromium (dev only)
    : require('./lib/browser_driver');   // stub → "not configured"
outcomes.setBrowserDriver(createDriver());
```

### The two drivers

| | `backend/lib/browser_driver.js` (main) | `backend/lib/local_driver.js` (main) | `executor/tier2-core` branch |
|---|---|---|---|
| State | **STUB** — `execute()` returns `browser_driver_unwired` | Full implementation (Playwright, sessions, phases) | Full Browserbase CDP implementation |
| `loadSite()` | never called | called → loads `sites/<site>.js` | called → loads `sites/<site>.js` |
| Works on Vercel | n/a (returns honest error) | **NO** — no Chromium in serverless; `findChromium()` → null → `NO_LOCAL_CHROMIUM` | YES (cloud browser) |
| Needs | Browserbase keys | `RING_LOCAL_BROWSER=1` + Playwright cache | Browserbase keys |

### Site-module contract (`backend/lib/sites/_framework.js`)

A site module at `backend/lib/sites/<site>.js` exports `{ '<kind>': async (ctx, job) => envelope }`.

`ctx`: `{ page, job (redacted), log(step, data), screenshot(name), vault: { has, withCredentials } }`

Envelopes (never throw for expected failures):
- `{ ok: true, phase: 'done', <proofArtifact>, ... }` — proof artifact REQUIRED
  (`confirmationRef` | `reservationId` | `bookingId` | `orderId` | `receiptUrl` |
  `cancelRef` | `ticketId`); driver downgrades proof-less `done` to `no_proof` failure.
- `{ ok: true, phase: 'need_otp', prompt, fields }` — session stays live; agent
  re-invokes `execute()` with `{ sessionId, otp_code }`.
- `{ ok: true, phase: 'need_input', prompt, fields }` — same pattern, generic input.
- `{ ok: true, phase: 'need_approval', summary, prompt }` — session stays live;
  agent re-invokes with `{ sessionId, fare_approved: true }` (or equivalent flag).
- `{ ok: false, code, note }` — honest failure, nothing claimed.

Rules: one phase per `execute()` call; never sleep-loop for a human; `ctx.log()` every
meaningful step (audit trail); never log/return credential values, OTPs, cookies,
or `connect_url` (`sanitize()` redacts keys matching
`/connect_?url|cookie|api[-_ ]?key|token|passwd|password|secret|otp|2fa|authorization/i`).

### Existing site modules (`backend/lib/sites/`)

| File | Kinds | Notes |
|---|---|---|
| `_framework.js` | — | contract, `loadSite`, `runPhase`, `sanitize`, `makeCtx` |
| `uber.js` | `book-ride`, `trip-status`, `cancel-ride` | 413 lines. Multi-phase: phone OTP → route → schedule picker → fare `need_approval` → confirm → `orderId`. **Not yet live-proven.** Schedule-picker selectors speculative. |
| `myclaw.js` | `cancel-subscription` | 702 lines. Email+password or magic-link login → billing → cancel → confirm. Blocked by Cloudflare on local driver (2026-09-29). Anti-bot stealth added (commit `486ff22`, merged) but unverified. |
| `subscription.js` | `cancel-subscription` | Dispatcher: `MERCHANT_MODULES = { myclaw: './myclaw' }` — add per-merchant modules here. |
| `d2l.js` | (graded entry hard-disabled, commit `4c701a9`) | Pattern reference for form-fill style modules. |

### Approval execution (`backend/lib/approvals.js`)

- `create()` dedupes identical-pending (10-min window) + idempotencyKey.
- `resolve(id, 'approve', { executorUserId })` atomically claims the card, then
  `executeTool(rec, tools)` runs the real tool fn. A card can never execute twice.
- Demo-sandbox cards can only run simulated `DEMO_TOOLS` — no real-world effect.

### Credentials (`backend/lib/vault.js`)

Values live ONLY in Vercel env vars `VAULT_<ID>` (JSON `{"username":..,"password":..}` or
raw string), set by Vishnu in the dashboard — never in chat/repo/logs. Site modules
resolve via `ctx.vault.withCredentials(id, cb)`; the value never leaves the callback —
return only proofs/summaries. `vault.has(id)` / `vault.describeSetup(id)` are safe for
presence checks and user-facing setup guidance.

---

## 2. Critical findings (blockers & traps)

### F1. Production `ride_book` hardcodes `local_driver` — cannot work on Vercel
`agent.js` `_RAW_TOOLS` `ride_book`/`browser_run` do `require('./local_driver')`.
On Vercel serverless there is no Chromium → `findChromium()` returns null →
`NO_LOCAL_CHROMIUM`. Even after `uber.js` deploys, `ride_book` on production will
fail at browser launch. **Fix:** make these tools use the configured driver
(`outcomes.setBrowserDriver` / the `browserRun` tier path) instead of hardcoding
`local_driver`, OR route `ride_book` through the outcomes connector's tiered
`rideBook` (which is currently shadowed). The outcomes `browserRun()` path is the
correct production path — it degrades honestly (`browser_not_configured`) when keys
are absent.

### F2. `executor/tier2-core` (full Browserbase driver) is not merged
The production-capable cloud driver lives on branch `executor/tier2-core`
(commits `0a6fa77`, `858db33`, `9a6fa76`) — real `execute()` via Browserbase CDP,
session persistence (`browser_sessions` table, migration-005), phase-aware
continuation. `main`'s `browser_driver.js` is still the stub. **Nothing browser-based
can execute in production until this merges AND Browserbase keys work.**

### F3. Browserbase is unusable right now
- Free plan exhausted: 62/60 browser minutes (resets Oct 26).
- Stored API key returns 401.
- **Needs from Vishnu:** plan upgrade + fresh `BROWSERBASE_API_KEY` +
  `BROWSERBASE_PROJECT_ID` in Vercel (Production env).

### F4. Deployment lag burned two approvals (2026-09-30)
`ride_book` approvals `appr_munh4dxsjvn9` (02:16:42Z) and `appr_munh8val6g95`
(02:19:56Z) both resolved to
`{ok:false, code:'site_not_implemented', note:'Site module sites/uber.js is not
implemented yet — nothing was attempted.'}` because Vercel hadn't finished
deploying `uber.js`. **Lesson:** after pushing site-module changes, verify the
deploy is live (e.g. hit a version/health marker) BEFORE staging approval cards.
Consider adding a `?v=` deploy marker or a `/api/version` endpoint returning the
deployed commit SHA.

### F5. Agent honesty about multi-phase flows
Commit `0faf1e5` (2026-09-30) added explicit phase labels to the system prompt:
`staged → approved/starting → verification code sent → logged in → fare shown →
booked (only with confirmation ref)`, plus a mandatory follow-up message after
every approval execution. The chatbox must never say "booked"/"done"/"confirmed"
without a proof artifact.

### F6. `group_reply` (#45) is not a tool
No `group_reply` tool exists in `backend/` — the ledger's #45 ("live @ring reply
drafted for a signed-in member's thread") was exercised via the @ring mention path
in group chats (`agent/improvements` branch work), not a callable tool. For strict
verification, define what the testable surface is: the agent's reply behavior when
mentioned in a group thread.

### F7. Test residue
`memory_save` test left `ring_test_passphrase = BLUE-DELMAR-TEST` (and
`BLUE-DELMAR-TEST2`) in Vishnu's durable memory. Do not delete (standing rule) —
note it in test plans so recall tests aren't polluted.

---

## 3. Feature-by-feature catalog

Legend — **Impl**: what exists · **Missing**: what must be built · **Driver**: L=local
Chromium only, B=Browserbase cloud, A=direct API, -=no browser needed · **Verify**:
how to independently confirm the external outcome.

### Email (1–14) — Gmail API connector (`backend/connectors/gmail.js`). No browser needed.

| # | Tool | Impl | Missing for strict pass | Verify |
|---|---|---|---|---|
| 1 | `gmail_search` | live | 3-scenario rerun incl. Bill Billeaud Databricks 9/29 case (prior #1 missed it) | cross-check against Gmail web UI |
| 2 | `gmail_read` | live | rerun with "Bill Billeaud" explicitly (prior read Bill Gates) | same |
| 3 | `gmail_triage` | live | 3 scenarios (busy inbox day, quiet day, travel-heavy) | manual spot-check |
| 4 | `gmail_thread` | live | 3 scenarios (long thread, short thread, thread with attachments) | same |
| 5 | `gmail_reply` | held (never executed) | execute 1 real reply (safe target: self-email), then 2 more variants | Gmail Sent + thread shows reply |
| 6 | `gmail_forward` | held | execute 3 forwards (promo→self, receipt→self, thread→self) | inbox receipt |
| 7 | `gmail_send` | executed once via manual card (no credit) | re-execute 3 sends **through production chat cards** | Gmail Sent + received |
| 8 | `gmail_draft` | held | execute 3 drafts (to self, with attachment ref, reply-draft) | Gmail Drafts |
| 9 | `gmail_delete` | held | execute 3 trashes (promo, old receipt, self-test mail) | Trash label + absent from inbox |
| 10 | `gmail_archive` | held | execute 3 archives | All Mail, absent from inbox |
| 11 | `gmail_mark` | held | execute read/unread toggles ×3 | label state in Gmail UI |
| 12 | `gmail_star` | held | execute star/unstar ×3 | Starred label |
| 13 | `gmail_receipts` | live | 3 scenarios (30d window, merchant filter, no-receipt honest empty) | manual |
| 14 | `gmail_attachments` | live | 3 scenarios (by sender, by type, large-file) | manual |

**Approval shape:** each mutating email tool needs the exact card:
`{ to, subject, body }` for send/reply/forward; `{ messageId, subject }` for
delete/archive/mark/star; `{ to, subject }` for draft. Body must be Vishnu-approved
verbatim — he must personally see every outbound draft.

**Test accounts/addresses:** safe recipient `srikanthvishnu90@gmail.com`. Conflicting
pending cards (`appr_mungqig4ldn7`, `appr_mungqivz4mzq`, `appr_mungqjdnbgl0`,
`appr_mungqjrbisgc`, `appr_mungqk8u7s2h`, `appr_mungqklwbhxh`, `appr_mungqkys8i7p`)
were manually inserted — decline/ignore and restage sequentially through production
chat to avoid cross-targeting message `1a0ef9ffbc926717`.

### Calendar (15–24) — Google Calendar connector (`backend/connectors/calendar.js`). No browser needed.

| # | Tool | Impl | Missing for strict pass | Verify |
|---|---|---|---|---|
| 15 | `calendar_list` | live | 3 scenarios (week view, day view, empty day honest) | Google Calendar UI |
| 16 | `calendar_create` | held (`appr_mungqldh58ci` manual — no credit) | execute 3 creates **via production cards** (lunch w/ mom, 2 more) | Calendar UI shows events; then delete them |
| 17 | `calendar_update` | live (honest no-op) | needs a real event: create → reschedule → verify new time (×3 variants: time change, day change, title change) | Calendar UI |
| 18 | `calendar_delete` | live (honest no-op) | delete the #16/#17 test events (×3) | event gone in UI |
| 19 | `calendar_freetime` | live | 3 scenarios (busy afternoon, free day, weekend) | manual |
| 20 | `calendar_conflict` | live | 3 scenarios (overlap, adjacent, no conflict) | manual |
| 21 | `calendar_briefing` | live | 3 scenarios (meeting-heavy day, empty day, travel day) | manual |
| 22 | `calendar_from_email` | staged/held | execute 3 (real invite email → event; promo-invite correctly rejected; all-day event) | Calendar UI |
| 23 | `calendar_reminders` | live | 3 scenarios (reminders exist, none, far-future) | manual |
| 24 | `calendar_week` | live | 3 scenarios | manual |

**Approval shape:** `{ summary, start, end, attendees? }` with exact time + timezone.
Timezone handling: agent must use America/Chicago (Vishnu confirmed 2026-09-28;
a stale `Europe/Rome` comment remains in `agent.js` `tzOffsetISO` — fix to prefer
`~/workspace/user/timezones.yaml` or explicit user tz).

### Intel (25–32) — composed tools (`backend/connectors/intel.js`). No browser needed.

| # | Tool | Impl | Missing | Verify |
|---|---|---|---|---|
| 25 | `intel_meeting_prep` | live | 3 scenarios (external attendee, internal, no meeting → honest) | cross-check email+calendar |
| 26 | `intel_trip` | staged/held | execute 3: itinerary from real confirmations + staged events approved | calendar events exist; itinerary accurate |
| 27 | `intel_rsvp` | live (honest empty) | 3 scenarios incl. one with a real RSVP-able invite → draft accept (approval) | draft text |
| 28 | `intel_followup` | live | 3 scenarios (unanswered sent, all-answered, old thread) | manual |
| 29 | `intel_subscriptions` | live | 3 scenarios; verify cadence detection on known subs | manual |
| 30 | `intel_spending` | live | 3 scenarios (month with charges, empty month, merchant filter) | manual |
| 31 | `intel_contact` | live | 3 scenarios (vendor, personal, unknown → honest) | cross-check email |
| 32 | `intel_deadlines` | staged/held | execute 3: reminders actually created after approval | reminders exist |

### Real-world outcomes (33–42) — the hard group. All need browser (B) except where noted.

| # | Tool | Path today | Missing | Site module / API needed | Verify |
|---|---|---|---|---|---|
| 33 | `dining_book` | outcomes tiered (api-resy → browser → handoff) | **A:** `RESY_API_KEY`+`RESY_AUTH_TOKEN` (unofficial API, needs Vishnu's Resy session tokens) and/or **B:** `sites/resy.js` `book` kind | `backend/lib/sites/resy.js`: login (vault) → search venue → pick slot → confirm → `reservationId` | Resy app/confirmation email; cancel after test |
| 34 | `dining_change` | outcomes tiered | same as #33; needs a real booking first (book → change party → change time → cancel) | `sites/resy.js`: `change` kind (modify/cancel w/ ref) | Resy app reflects change |
| 35 | `subscription_cancel` | outcomes → `browserRun({kind:'cancel-subscription'})` → `sites/subscription.js` dispatcher | merchant modules beyond myclaw; **B** driver merge; vault creds per merchant | `sites/<merchant>.js` per merchant (`cancel-subscription` kind). Have: `myclaw.js`. Need: `netflix.js`, `spotify.js`, `hulu.js`, … (one per test) | merchant account page shows cancelled; confirmation email |
| 36 | `ride_book` | **agent.js `_RAW_TOOLS` → `local_driver` directly** (outcomes version shadowed) | **F1+F2+F3 fixes**; `uber.js` deploy verification; OTP handoff UX (secure one-time Ring input, never plain chat) | `sites/uber.js` exists — needs live proving: phone-input selectors, schedule picker, fare `need_approval`, confirm → `orderId`, `trip-status`, `cancel-ride` | Uber app scheduled trips + trip reference; cancel after test (fee risk ~$5–10 — needs Vishnu's explicit OK per test) |
| 37 | `dining_tonight` | outcomes, Places API | `GOOGLE_PLACES_API_KEY` in Vercel; 3-city scenario runs | none (finder only) | spot-check 2–3 venues are real |
| 38 | `web_login_task` | outcomes → `browserRun({kind:'login-task'})` | **generic** `sites/generic.js` `login-task` kind: vault login → perform `task` description steps → `confirmationRef`/summary; **B** driver | `backend/lib/sites/generic.js` (new): `{ 'login-task': fn, 'form-fill': fn }` — domain-driven, credential via vault only | target site reflects the task outcome |
| 39 | `web_form_fill` | outcomes → `browserRun({kind:'form-fill'})` | same `sites/generic.js`; per-field approval already enforced in `webFormFill` (`approvedFields`) | same as #38 | form confirmation page / email |
| 40 | `order_status` | outcomes, Gmail-based (read-only) | 3 scenarios (real order email, tracking email, none → honest) | none | cross-check merchant email |
| 41 | `price_check` | outcomes, read-only | 3 scenarios (in-stock product, price change, unknown → honest) | optional `sites/generic.js` `read` kind for live pages; without browser, honest "unavailable" | spot-check against retailer |
| 42 | `reservation_fix` | outcomes, Gmail diagnosis | 3 scenarios (real messed-up reservation → propose+apply fix w/ approval; no reservation → honest; ambiguous → asks) | `sites/resy.js` `change` kind (reuse #34) | confirmation email / Resy app |

**Test-scenario design for outcomes (each needs 3 genuinely different runs):**
- #33: (a) Resy venue tonight 2ppl, (b) OpenTable-path restaurant weekend 4ppl,
  (c) fully-booked restaurant → honest `no_slots` (negative case counts as a scenario).
- #35: (a) MyClaw (have module; needs Cloudflare pass), (b) a cheap real
  subscription Vishnu actually holds (needs his pick), (c) unknown merchant →
  honest `merchant_not_implemented`.
- #36: (a) immediate ride (short hop), (b) scheduled ride (the Clybourn→Kenmore
  case), (c) bad address → honest `route_failed`. **Each books a real car — fee
  exposure; batch approvals and cancel promptly.**
- #38: (a) Amazon "recent orders" (vault creds), (b) a second site, (c) wrong
  vault id → honest `vault_id_unknown`.
- #39: (a) non-sensitive feedback form, (b) address-change form (sensitive fields
  → per-field approval), (c) sensitive fields without approval → blocked honestly.

### Memory + groups (43–50) — `backend/lib/memory.js`, `backend/connectors/social.js`. No browser needed.

| # | Tool | Impl | Missing for strict pass | Verify |
|---|---|---|---|---|
| 43 | `memory_save` | live | 3 scenarios (fact, preference, routine) — avoid `BLUE-DELMAR-TEST` residue confusion | `memory_list` recall |
| 44 | `memory_list` | live | 3 scenarios | manual |
| 45 | `group_reply` | @ring mention path (not a tool) | define testable surface: 3 group-thread scenarios where @ring drafts/sends the reply correctly | thread shows correct reply |
| 46 | `group_plan` | staged/held | execute 3: create poll → tally votes → lock winner → staged calendar event approved → event exists | calendar + thread |
| 47 | `daily_brief` | live | 3 scenarios (busy day, quiet day, travel day) | manual |
| 48 | `draft_message` | live (draft only) | 3 scenarios (friend, vendor, formal) — verify nothing sent | no sent artifacts |
| 49 | `routine_learn` | live | 3 scenarios; verify learned routines are genuine | memory entries |
| 50 | `smart_nudge` | live | 3 scenarios incl. one with real nudges (seed an event/thread first) | nudges match reality |

---

## 4. What to build — prioritized

### Phase 0 — unblock production browser (do first; everything in §3-outcomes depends on it)
1. **Merge `executor/tier2-core` → main.** Full Browserbase driver, session
   persistence, phase-aware continuation, arrival notifications (`backend/lib/notify.js`).
   Files: `backend/lib/browser_driver.js` (replace stub), `backend/lib/browser_sessions.js`,
   migration-005 (already applied to Supabase `ring` project).
2. **Fix F1:** `ride_book`/`browser_run` in `agent.js` `_RAW_TOOLS` must not hardcode
   `local_driver`. Options: (a) delete the `_RAW_TOOLS` overrides so the registry
   (outcomes.js tiered) versions win; (b) make them call `outcomes.browserRun`.
   **Recommend (a)** — the outcomes versions already implement tier1→tier2→tier3
   honestly. But note the outcomes `ride_book` schema only takes
   `{pickup, dropoff}` — extend it with `phone`, `scheduled_time`, `sessionId`,
   `otp_code`, `fare_approved` to preserve the multi-phase flow `uber.js` supports.
3. **Vishnu actions (all required before any browser test):**
   - Upgrade Browserbase plan + provide fresh `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` (Vercel → Production).
   - Confirm OK for ~$5–10 Uber cancellation-fee exposure per ride test.
   - Pick which real subscription to cancel for #35 (or create a cheap test one).
   - Provide `VAULT_<MERCHANT>_LOGIN` creds for login-gated tests (#35, #38).
4. **Add `/api/version`** returning deployed commit SHA — prevents repeat of F4
   (verify deploy live before staging cards).
5. **Fix stale timezone comment** in `agent.js` (`Europe/Rome` → America/Chicago default).

### Phase 1 — prove the pipe with Uber (#36) — the reference implementation
6. Deploy-verify `sites/uber.js` on production (F4 check).
7. Live-prove each phase through production chat + cards: phone-input discovery →
   OTP `need_otp` → route set → schedule picker → fare `need_approval` (exact-fare
   card) → confirm → `orderId`. Fix selectors live; commit fixes.
8. Prove `trip-status` (arrival notification path via `notify.js` — needs Vishnu's
   Telegram `chat_id`; he must message the bot once) and `cancel-ride` → `cancelRef`.
9. This becomes the template for every other site module.

### Phase 2 — merchant/site modules (one per row, each needs 3 scenarios)
10. `sites/resy.js` (`book`, `change`) — unlocks #33, #34, #42. Needs Resy vault
    login; check `RESY_API_KEY`/`RESY_AUTH_TOKEN` tier-1 as alternative.
11. `sites/generic.js` (`login-task`, `form-fill`, `read`) — unlocks #38, #39, #41.
    Domain-driven with vault-only credentials; per-field approval already in tool layer.
12. Merchant modules for #35: `sites/netflix.js`, `sites/spotify.js` (or whichever
    Vishnu picks). Each: login → account/billing → cancel → confirm → `cancelRef`.
    Re-verify `myclaw.js` against Cloudflare with the `486ff22` stealth flags.
13. `GOOGLE_PLACES_API_KEY` in Vercel — unlocks #37 + address geocoding for #36.

### Phase 3 — execute the 18 held mutating features (no new code, just production runs)
14. Email #5–#12 (sequential, one at a time — several target overlapping messages;
    decline the stale manual cards first). Calendar #16–#18, #22. Intel #26, #32.
    Outcomes #33–#36, #38–#39, #42 (need Phase 0–2). Group #46.
15. Each: fresh chatbox run → exact approval card → Vishnu approves → Ring executes
    → independent verification (Gmail UI / Calendar UI / merchant app / Uber app).
    3 scenarios per feature per the tables above.

### Phase 4 — re-prove the 32 read-only features (3 scenarios each)
16. Mostly mechanical: run the ledger's chatbox prompts ×3 variants, verify outputs
    against live data. Fix the known gaps: #1 (Bill Billeaud Databricks), #2 (Bill
    Billeaud not Bill Gates).

---

## 5. Testing strategy

- **Harness:** `backend/bench-turn.js "<prompt>" <threadId>` drives `runAgentTurn`
  in-process with the real user + live Google grant (no auth middleware). For
  approval-gated runs, use production chat (the harness doesn't write approval rows).
- **Driver matrix:** Gmail/Calendar/Intel/Memory/Social tests need no browser —
  run anytime. Browser tests: local driver (`RING_LOCAL_BROWSER=1`) for development
  on a machine with Playwright Chromium; Browserbase for production truth.
- **Negative scenarios are first-class:** `no_slots`, `merchant_not_implemented`,
  `vault_id_unknown`, `route_failed`, honest empty results — each counts as one of
  the 3 scenarios and must be verified to report honestly.
- **Proof discipline:** every mutating test ends with an independent check OUTSIDE
  Ring (Gmail web UI, Google Calendar UI, merchant account page, Uber app,
  confirmation email). A Ring screenshot or `phase:'done'` alone is never enough.
- **Cleanup:** every test booking/subscription/event is cancelled/deleted after
  verification; record the cancellation proof too.
- **Ledger updates:** `docs/FEATURE_LEDGER.md` gets a per-feature row update only
  after all 8 benchmark steps pass; never mark on partial evidence.

## 6. Open questions for Vishnu (blocking Phase 0–2)

1. Browserbase: upgrade plan + fresh API key + project ID → Vercel Production env.
2. Uber tests: approve ~$5–10 cancellation-fee exposure per ride test?
3. Subscription cancel target: which subscription may Ring actually cancel?
4. Vault logins: `VAULT_UBER_PHONE` (phone is enough — OTP flow), Resy login,
   merchant logins, Amazon login for #38.
5. Telegram: message the bot once so arrival notifications have a `chat_id`.
6. Places: `GOOGLE_PLACES_API_KEY` → Vercel.
7. Resy: `RESY_API_KEY` + `RESY_AUTH_TOKEN` (optional tier-1 fast path).
