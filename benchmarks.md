# Ring App Benchmarks v1

**Goal:** be as good an app as **Muse** (Meta's personal agent), **Oura** (the gold-standard ring companion app), and **Claude** (the gold-standard conversational AI) — measured, not vibes.

**Scoring:** 10 categories, 100 points total. Each benchmark is binary-ish: 0 = missing, partial credit where noted, full = meets the bar. Re-score monthly. A benchmark counts only after it's verified on a real device against production.

**Comparators**
- **Muse** — the agentic bar: one agent that learns one person over time; persistent main conversation + side chats; goals, memory, activity log; works on a schedule or when conditions change; connectors let it browse, fill forms, connect apps, make purchases, and keep working after the app closes.
- **Oura** — the hardware-companion bar: Nordic-clean design that stays navigable under information density; three-tab simplicity (Today / Vitals / My Health); scores with explanations, not raw numbers; AI advisor grounded in your actual data; hardware that feels like jewellery, pairs invisibly, and never makes you think about Bluetooth.
- **Claude** — the conversation bar: nuanced, honest, well-structured answers; Artifacts (output lives in its own surface, iterated in place, shareable); Projects with persistent context; memory you can view and edit; voice on mobile.

---

## 1. Conversational intelligence — 15 pts (bar: Claude)

| # | Benchmark | Pts |
|---|-----------|-----|
| 1.1 | Answers are structured and skimmable by default (headers, short lists) without being asked | 2 |
| 1.2 | Says "I don't know" / asks a clarifying question instead of hallucinating an answer | 3 |
| 1.3 | Handles follow-ups with correct pronoun/context resolution across a 20+ turn conversation | 2 |
| 1.4 | Understands uploaded files (PDF, image, spreadsheet) and answers questions grounded in them | 3 |
| 1.5 | Voice answers are concise (under ~30 seconds spoken) unless detail was requested; chat answers can be fuller | 2 |
| 1.6 | Never claims an action succeeded unless a real tool result confirms it | 3 |

## 2. Agentic capability — 15 pts (bar: Muse)

| # | Benchmark | Pts |
|---|-----------|-----|
| 2.1 | Completes multi-step tasks end-to-end (e.g. "find a sushi spot near me Friday and book for 2" → options → approval → booking/deep link) | 3 |
| 2.2 | 8+ working connectors: email, calendar, rides, dining, maps/places, messaging, payments, smart home | 3 |
| 2.3 | Long-running work continues after the app closes; user gets notified on completion | 2 |
| 2.4 | Produces shareable deliverables (itinerary, comparison, document) rendered as their own surface, not a chat dump | 2 |
| 2.5 | Proactive on user-defined triggers (schedule, location, event) — e.g. "nudge me when…" actually fires | 2 |
| 2.6 | Group chats: @-mention routes with full thread context; approvals resolve in-thread for all members | 3 |

## 3. Voice & hardware experience — 15 pts (bar: Oura ring + best voice UX)

| # | Benchmark | Pts |
|---|-----------|-----|
| 3.1 | Double-tap → mic live in the app in under 1 second; BLE audio streams without manual pairing dances | 3 |
| 3.2 | Tap, double-tap, and long-press are distinct, reliable, and confirmed by haptics | 2 |
| 3.3 | First spoken/visible response starts in under 2 seconds from end of speech | 3 |
| 3.4 | Battery level always visible; low-battery warns in-app before the ring dies mid-day | 2 |
| 3.5 | Works with phone locked / app backgrounded; call-quality audio in noisy environments | 2 |
| 3.6 | Hardware disappears: no daily charging anxiety, no re-pairing, comfortable 24/7 wear | 3 |

## 4. Design & craft — 10 pts (bar: Oura + Claude)

| # | Benchmark | Pts |
|---|-----------|-----|
| 4.1 | Three-or-fewer primary tabs; a new user reaches the core action (talk to agent) in under 10 seconds | 2 |
| 4.2 | Typography, spacing, and color feel intentional and consistent on every screen — no placeholder styling | 2 |
| 4.3 | Dark mode first-class; respects system theme; accessible contrast and tap targets (44pt+) | 2 |
| 4.4 | Motion is purposeful: transitions, loading states, and haptics all confirm what's happening | 2 |
| 4.5 | Onboarding gets a user from install to first successful voice task in under 3 minutes | 2 |

## 5. Performance — 10 pts

| # | Benchmark | Pts |
|---|-----------|-----|
| 5.1 | App cold start to interactive in under 2s on a 2-year-old phone | 2 |
| 5.2 | Time-to-first-token under 1.5s on chat; streaming renders token-by-token, never a blank wait | 2 |
| 5.3 | Serverless cold starts don't lose state: approvals, threads, and tokens survive and load fast | 2 |
| 5.4 | Graceful offline/poor-network behavior: queued messages, clear status, no silent failures | 2 |
| 5.5 | 99.5%+ monthly uptime on production API; p95 API latency under 800ms | 2 |

## 6. Reliability & backend depth — 10 pts

| # | Benchmark | Pts |
|---|-----------|-----|
| 6.1 | Every irreversible action is idempotent: retries and double-taps can never double-send, double-book, or double-charge | 3 |
| 6.2 | All durable state (approvals, threads, messages, tokens, memories) in Postgres; zero in-memory-only state except ephemeral SSE | 2 |
| 6.3 | Realtime works across serverless instances (group chat updates reach every member's device) | 2 |
| 6.4 | Full audit trail: every tool run records what was called, with what args, what resulted, and who approved it | 2 |
| 6.5 | OAuth tokens refresh silently; a dead/expired grant degrades to a clear reconnect prompt, never a crash | 1 |

## 7. Trust & safety — 10 pts

| # | Benchmark | Pts |
|---|-----------|-----|
| 7.1 | Risk-tiered approvals enforced for every medium/high-risk tool, no bypass paths | 3 |
| 7.2 | Approval cards show exactly what will happen (recipient, amount, time) before the user taps approve | 2 |
| 7.3 | Real user authentication: tokens and data are per-user, never shared across a global "local" identity | 2 |
| 7.4 | Adversarial prompts (jailbreaks, "send without approval", prompt reveal) are refused; verified by a red-team pass | 2 |
| 7.5 | Destructive actions (delete data, cancel bookings) require explicit confirmation with an undo window where possible | 1 |

## 8. Memory & personalization — 5 pts (bar: Muse)

| # | Benchmark | Pts |
|---|-----------|-----|
| 8.1 | Remembers durable facts and preferences across sessions (name, tastes, routines) without being re-told | 2 |
| 8.2 | User can view, edit, and delete what the agent remembers | 1 |
| 8.3 | Agent is nameable; group invocation ("hey <name>") works by voice | 1 |
| 8.4 | Suggestions improve with history (e.g. restaurant picks reflect past likes) | 1 |

## 9. Privacy & security — 5 pts

| # | Benchmark | Pts |
|---|-----------|-----|
| 9.1 | No secrets in client bundles, logs, or git; all keys server-side or in secure storage | 1 |
| 9.2 | Voice audio is never stored longer than needed to fulfill the request; retention policy stated in-app | 1 |
| 9.3 | Per-connector scopes are minimal and shown at connect time; disconnect truly revokes | 1 |
| 9.4 | Data export and full account deletion work from the app in under 2 minutes | 1 |
| 9.5 | No third-party analytics/tracking SDKs in the app binary | 1 |

## 10. Delight — 5 pts

| # | Benchmark | Pts |
|---|-----------|-----|
| 10.1 | First-run moment makes someone smile (the Oura "this feels like jewellery" test, applied to software) | 2 |
| 10.2 | At least one signature interaction competitors don't have (voice-first group planning, tap gestures, ambient haptics) | 2 |
| 10.3 | Empty states and errors are helpful and human, never dead ends | 1 |

---

## Re-score: 2026-09-21 (~49/100)

Production-verified tonight (curl against ringsss.vercel.app + local adversarial suite; real-device phone testing still pending):

| Category | Score | Change | Notes |
|---|---|---|---|
| 1. Conversational intelligence | 7/15 | +2 | Token streaming live on prod; durable memory injected into prompts; honesty rule holds |
| 2. Agentic capability | 5/15 | — | Approvals + Gmail/Calendar/Places unchanged; voice pipeline built but unconfigured |
| 3. Voice & hardware | 0/15 | — | Server pipeline exists (STT→agent→TTS, graceful 501s); no provider key, no real device, no BLE |
| 4. Design & craft | 6/10 | +3 | Streaming UI, dark/light themes, voice button, memories screen, onboarding polish — deployed, needs real-phone check |
| 5. Performance | 5/10 | +2 | /api/chat/stream live (first token fast); cold-start persistence; no offline queue yet |
| 6. Reliability & backend | 9/10 | +3 | Audit log (ring_tool_runs), cross-instance Realtime broadcast, all durable state in Postgres, atomic idempotent approvals |
| 7. Trust & safety | 9/10 | +3 | Magic-link auth; 15-probe red-team pass (all safe); critical cross-user approval hole found and fixed; 401/403/404 correct |
| 8. Memory & personalization | 3/5 | +3 | Durable fact extraction + recall; user can view/add/delete memories; no learning-from-history yet |
| 9. Privacy & security | 3/5 | +1 | Export + full account delete from the app; no stated audio-retention policy yet |
| 10. Delight | 2/5 | +1 | Streaming caret, voice UI, motion pass; no signature interaction yet |

**Biggest leverage to 100:** voice & hardware (15 pts untouched — provider key + real ring audio path), real-device verification of everything above, background work + notifications (2.3/2.5), more connectors (2.2), proactive triggers (2.5), agent naming + voice invocation (8.3), signature interaction (10.2).

## Build log: 2026-09-21 (score unchanged at 49/100 — pending real-device verification)

- **Telegram bot v2** (commit `209997b`, deployed): typing indicator fires instantly; chat-style system prompt (short, warm, texting tone); replies use the sender's first name and mirror their language; last-8 thread messages included for context; long replies split into short paragraph messages; demo disclosure only when a real action is requested; generation capped at 320 tokens. Locally verified 200/replied:true in ~8s; test rows cleaned from prod. Awaiting Vishnu's real-phone feel check before scoring.
- **OAuth state hardened** (commit `e0f4445`, deployed): `state` is now HMAC-SHA256-signed, 10-minute expiry, bound to the authenticated user; `POST /api/oauth/google/start` (requireUser) issues state + sets HttpOnly SameSite=Lax CSRF-nonce cookie; `/auth/google` bridge page completes the authed start from the app's stored token; callback verifies signature/expiry/cookie and saves tokens only under the sealed userId; plaintext `state=<userId|local>` and anonymous binding removed. Unit + route tests pass (401/403 paths). **Needs Vishnu:** add `OAUTH_STATE_SECRET` (generate: `openssl rand -hex 32`) to ringsss → Settings → Environment Variables (Production) + redeploy, then sign in and reconnect Google.
- **Security incident:** `.env.example` was committed with real-looking credential values (history: `6c86441`/`fb8056a`). Scrubbed in `e0f4445`, but git history still holds them — exposed values (Stripe, database URL, Telegram webhook secret, Uber/Resy, APNS, session secret) must be rotated. Flagged to Vishnu.

## Rough self-score: Ring today (~30/100)

| Category | Score | Notes |
|---|---|---|
| 1. Conversational intelligence | 5/15 | Chat works, streaming not yet; honesty rule is coded (1.6) |
| 2. Agentic capability | 5/15 | Real approvals + Gmail/Calendar/Places; group @-mention works; no background work, few connectors |
| 3. Voice & hardware | 0/15 | Nothing built yet — biggest gap |
| 4. Design & craft | 3/10 | Oura/Whoop-informed pass done; needs motion, dark mode, onboarding polish |
| 5. Performance | 3/10 | Cold-start gating done; no streaming, no offline handling |
| 6. Reliability & backend | 6/10 | Postgres persistence + atomic approvals done; no cross-instance realtime, no audit log |
| 7. Trust & safety | 6/10 | Approval gates real and tested; no user auth, no red-team pass |
| 8. Memory & personalization | 0/5 | Not started |
| 9. Privacy & security | 2/5 | Keys server-side; no stated retention policy, no export/delete |
| 10. Delight | 1/5 | Splash screen exists; no signature moment yet |

**Biggest leverage:** voice & hardware (15 pts, all unearned), user auth (unlocks 7.3 + all of 8), streaming responses (1.2/5.2), background work + notifications (2.3/2.5).

## Rules of the game
- A point counts only when verified on a real phone against production.
- Re-score monthly; track the delta, not just the total.
- Never trade trust/safety points for capability points — 7.x is a gate, not a trade.
