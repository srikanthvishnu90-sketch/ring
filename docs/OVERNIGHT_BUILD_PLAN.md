# Overnight Build + Test Plan — Ring 50 Features

**Date:** 2026-09-29 (night of Sept 29 → morning Sept 30)
**Source:** `docs/FEATURE_LEDGER.md` (32 real-verified · 18 safety-path-held · 0 blocked)
**Standing rule:** every consequential action needs Vishnu's approval of the exact card. Overnight work = build code + stage approval cards; his approve taps happen when he's awake. Email tests go to `srikanthvishnu90@gmail.com`.

## 1. Actionable vs read-only

**Read-only (22)** — produce information, mutate nothing: #1 `gmail_search`, #2 `gmail_read`, #3 `gmail_triage`, #4 `gmail_thread`, #13 `gmail_receipts`, #14 `gmail_attachments`, #15 `calendar_list`, #19 `calendar_freetime`, #20 `calendar_conflict`, #21 `calendar_briefing`, #23 `calendar_reminders`, #24 `calendar_week`, #25 `intel_meeting_prep`, #27 `intel_rsvp`, #28 `intel_followup`, #29 `intel_subscriptions`, #30 `intel_spending`, #31 `intel_contact`, #37 `dining_tonight`, #40 `order_status`, #41 `price_check`, #42 `reservation_fix`, #43 `memory_save`, #44 `memory_list`, #47 `daily_brief`, #49 `routine_learn`, #50 `smart_nudge`. (That's 28 — all already real-verified; nothing to build.)

**Actionable (18)** — change the real world; all currently `safety-path-held` except #7:

| # | Tool | Does what |
|---|------|-----------|
| 5 | `gmail_reply` | Sends a reply email |
| 6 | `gmail_forward` | Forwards an email |
| 7 | `gmail_send` | Sends an email — **already fully verified end-to-end 2026-09-29** (approval `appr_munb4qp7hun4` → sent → message `1a0ef9ffbc926717` → found in inbox) |
| 8 | `gmail_draft` | Creates a Gmail draft |
| 9 | `gmail_delete` | Moves a message to trash |
| 10 | `gmail_archive` | Archives a message |
| 11 | `gmail_mark` | Marks read/unread |
| 12 | `gmail_star` | Stars a message |
| 16 | `calendar_create` | Creates a calendar event |
| 17 | `calendar_update` | Reschedules an event (needs an event to exist) |
| 18 | `calendar_delete` | Deletes an event (needs an event to exist) |
| 22 | `calendar_from_email` | Creates event from email invite (staged) |
| 26 | `intel_trip` | Creates itinerary calendar events (staged) |
| 32 | `intel_deadlines` | Creates deadline reminders (staged) |
| 33 | `dining_book` | Books a restaurant table for real |
| 35 | `subscription_cancel` | Cancels a subscription for real |
| 36 | `ride_book` | Orders an Uber for real — **wired to Ring's browser driver tonight** (`browser_run` + real `ride_book` agent tool → `local_driver` → `sites/uber.js`) |
| 38 | `web_login_task` | Logs into a website, completes a task |
| 39 | `web_form_fill` | Fills a web form |
| 46 | `group_plan` | Runs a group poll, locks event time |

## 2. Build + test overnight with ZERO info from Vishnu

These need only what Ring already has (live Gmail grant, live Calendar grant, Ring memory, Supabase). Staging + approval cards overnight; his approve taps in the morning.

| # | Why no info needed |
|---|-------------------|
| 5 `gmail_reply` | Reply to the self-sent "Ring send test" email already in his inbox; exact body staged for approval |
| 6 `gmail_forward` | Forward the same self-sent test email to `srikanthvishnu90@gmail.com`; nothing added |
| 8 `gmail_draft` | Draft to `srikanthvishnu90@gmail.com`, synthetic subject/body |
| 9 `gmail_delete` | Trash the self-sent test email (already read, purely synthetic) |
| 10 `gmail_archive` | Archive the self-sent test email |
| 11 `gmail_mark` | Mark the self-sent test email unread → read (fully reversible) |
| 12 `gmail_star` | Star the self-sent test email (reversible) |
| 16 `calendar_create` | Create "Ring test event — delete me", synthetic time; proves the create path |
| 17 `calendar_update` | Reschedule the #16 test event (depends on #16 approval first) |
| 18 `calendar_delete` | Delete the #16 test event (depends on #16 approval first) |
| 22 `calendar_from_email` | Stage from a real invite email; creates nothing until approved |
| 26 `intel_trip` | Stages only; creates nothing until approved |
| 32 `intel_deadlines` | Stages reminders only; creates nothing until approved |
| 46 `group_plan` (poll part) | Poll drafting needs no external info; event-locking stays held |

**Note:** #9–#12 and #5–#6 all target the synthetic "Ring send test" email (`1a0ef9ffbc926717`) already in his inbox — zero risk to real mail.

## 3. Needs info from Vishnu (exact ask for each)

| # | Exact info needed |
|---|-------------------|
| 33 `dining_book` | Restaurant name + date/time + party size; which platform (OpenTable / Resy / Tock / restaurant's own site); platform account login via vault **only if** the platform requires an account |
| 35 `subscription_cancel` | **Which subscription to cancel** (merchant name). Needs a currently-active subscription — the MyClaw cancellation was Muse's, not Ring's, so it can't be reused as evidence |
| 36 `ride_book` | Nothing structural missing — pickup/dropoff known (Clybourn Metra → 4016 N Kenmore Ave). At runtime: the **Uber OTP code** texted to +12246029341 (he relays it), then fare-approval tap |
| 38 `web_login_task` | Which site + login credentials via Ring vault (never chat) |
| 39 `web_form_fill` | Which form URL + the exact field values to fill |
| 46 `group_plan` (full) | Which group chat (platform + group name); Telegram path needs him to message Ring's bot once (chat ID unknown) and add the bot to the group |
| 45 `group_reply` (send path) | Same Telegram prerequisites as #46 if sending for real |

## 4. Needs code built first

| # | What's missing (one sentence) |
|---|------|
| 36 `ride_book` | **Scheduled-ride support**: `sites/uber.js` `book-ride` only does immediate booking — needs the schedule picker (clock icon → date/time selection). Parent agent is building this now. |
| 36 `ride_book` | **Login-form detection fix**: the one live test returned `login_blocked` (phone form not found on m.uber.com) — selectors need hardening against Uber's current DOM. |
| 33 `dining_book` | **No browser booking module exists**: only prefilled deep links (`opentableLink`/`resyLink`) — needs `sites/dining-book.js` (find restaurant → pick slot → fill name/phone from Ring memory → confirm). Neither OpenTable nor Resy offers a booking API. |
| 35 `subscription_cancel` | `sites/subscription.js` exists but needs **per-merchant login + cancel-flow selectors** for whichever merchant he names. |
| 38/39 `web_login_task` / `web_form_fill` | Framework (`sites/_framework.js`) exists; each target site needs its **own selector module** (only `uber`, `myclaw`, `subscription`, `d2l` exist today). |
| All 18 held | **Overnight staging script**: `bench-turn.js` never writes to the approvals table (ledger notes this) — needs a script that calls `approvals.create()` for each held feature so Vishnu wakes to a ready approval queue. |

## 5. Recommended overnight build order

1. **Finish Uber scheduled-ride support** (`sites/uber.js` schedule picker) — Vishnu's #1 stated priority; unblocks #36, the current flagship task. Fix `login_blocked` selectors in the same pass.
2. **Build the overnight staging script** — one script that stages approval cards for #5, #6, #8, #9, #10, #11, #12, #16, #22, #26, #32 via `approvals.create()`. Highest leverage: converts the entire held backlog into a morning approval queue with zero new info.
3. **Calendar test-event chain** — stage #16 create → (after his approval) #17 update → #18 delete. Three features proven by one chain, no info needed.
4. **Gmail action suite** — stage #5/#6/#8 cards and #9–#12 cards, all targeted at the synthetic test email. After his taps: reply/forward/draft/delete/archive/mark/star all verified against live Gmail.
5. **Dining browser booking module** (`sites/dining-book.js`) — blocked on his restaurant choice, but the module (OpenTable slot-pick + memory autofill) can be built overnight against a demo restaurant.
6. **Subscription cancel merchant flow** — audit `sites/subscription.js`; build the generic cancel pattern further once he names the subscription.
7. **Telegram group wiring** (#45 send / #46 full) — code is ready (`notify.js` fans out already); blocked purely on him messaging the bot once.

## Hard blockers (cannot be solved overnight, for the record)

- **Twilio SMS/WhatsApp**: no phone number until Trust Hub KYC (his tap) + number purchase (~$1–2/mo). Tracked as goal_665af5b98f08.
- **iMessage group chats**: not automatable server-side, ever — out of scope by platform, not by effort.
- **Stripe**: explicitly last per Vishnu's 2026-09-27 order. Not touched.
- **Voice**: explicitly last per the same order. Not touched.
- **Uber OTP at 10:30 AM ride**: the login OTP must be relayed by him at runtime — the code can be 100% ready, but first login needs him awake.
- **D2L**: autonomous graded-answer submission is hard-disabled by policy — inspection/explanation only.
