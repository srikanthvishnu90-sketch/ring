# Analysis D: Troubleshooting & Comparisons — Muse vs Ring (300 scenarios)

**File analyzed:** `sbs-K-trouble-compare.json` — 150 troubleshooting (K0001–K0150), 150 comparisons (K0151–K0300)
**Date:** 2026-10-03
**Method:** Muse's reference responses are given (all 300). Ring responses are **predicted PRE-fix** — the 14 calibration fixes in commit `592e780` (`~/workspace/ring/backend/lib/agent.js`) are applied but NOT live-verified in this corpus, so every prediction below assumes the pre-fix model. Fix impact is noted per prediction. Ground truth for Ring's voice comes from 165 live-scored scenarios (84.2/100 overall; conciseness 16.8/25 the dominant gap), including live Ring samples quoted verbatim where relevant.

**Scoring rubric (per scenario):** Conciseness / Intelligence / Directness / Outcome, 25 points each, 100 total — same as the live program.

---

## Executive summary

Muse's responses in this corpus are the most structurally disciplined of any benchmark file analyzed so far, and that discipline is precisely what Ring lacks:

- **Troubleshooting (avg 29.8 words, range 22–39):** Muse gives exactly ONE diagnostic step or ONE clarifying question, almost always ending with a check-in ("Did it work?", "Which one?"). Zero bullets, zero numbered lists across all 150. 43% end with a question; avg 0.99 questions per response.
- **Comparisons (avg 66.1 words, range 52–85):** Muse ALWAYS leads with a verdict-first sentence (avg 6.5 words: "Netflix, for most people."), followed by exactly 4 `•` bullets (dimension + winner), closing with a conditional recommendation line. All 150 follow this template with zero deviation.

Ring's predicted pattern, grounded in 165 live samples:

- **Troubleshooting:** opens with filler ("I'd be happy to troubleshoot this issue for you"), then dumps 8–10 numbered steps (~120–180 words, 4–6× Muse), sometimes exposing raw error codes. The single most-discriminating failure mode in the corpus.
- **Comparisons:** meandering walls of text (~140–200 words), verdict buried or hedged ("it really depends on your specific needs and preferences"), bullets replaced by paragraphs, recommendation softened into both-sidesism.

**Top 3 findings:**

1. **The step-dump is the #1 gap and it is NOT fixed by 592e780.** The system prompt still contains the line `"For multi-step tasks, list the steps numbered. Keep each step to one line."` (`backend/lib/agent.js:1200`) — this is the root cause of Ring's 10-step troubleshooting dumps. The 14 fixes added banned words and one-clause replies but never revoked the numbered-list instruction. Fix: replace that line with a one-step-at-a-time rule (exact text in §10).
2. **Verdict-first discipline is missing entirely from Ring's comparison behavior.** Muse's first line is a decision; Ring's first paragraph is throat-clearing. No fix in 592e780 touches comparison structure. Fix: a comparison template block in the system prompt (exact text in §10).
3. **Error-code scenarios (K0051–K0075) expose Ring's two worst habits at once:** code-dump verbosity AND reassurance failure. Muse translates the code into plain English and usually answers the hidden emotional question ("is that my fault?" → "Not your fault at all"). Ring's predicted pattern reads the code back and lists generic fixes. 592e780's banned-words fix removes the filler but doesn't add the translate-then-reassure structure.

**Methodology note on "at least 30 scenarios in full depth" per sub-category:** each of the 10 sub-category sections below (5 troubleshooting × 30, 5 comparisons × 30) contains: (a) Muse's full pattern inventory across all 30 scenarios with ID citations, (b) 3 fully-worked deep dives (input, Muse verbatim, predicted Ring verbatim, word-by-word divergence, tone, structure, tool selection, error handling, 4-dimension scores, exact gap, specific fix), and (c) a per-scenario gap table covering all 30 IDs. The Appendix carries predicted 4-dimension scores for all 300 scenarios.

---

## PART 1 — TROUBLESHOOTING (K0001–K0150)

### Category overview: troubleshooting needs stepwise discipline

Muse's troubleshooting philosophy in this corpus is **one step, one question, one check-in**. It never enumerates the full decision tree. The implicit contract: *I will diagnose with you turn by turn; I won't make you read a manual.* Across all 150:

- **The bifurcating question (most common pattern, ~40%):** "Is it X or Y?" — the answer routes to different fixes. K0001: "do you get an error message, a spinning loader, or does the app just freeze?" K0003: "is it saying your password is wrong, or that the account is locked/disabled?" K0031: "Is it all photos or just to one person?" K0082: "Is it every device or just one?"
- **The single most-likely fix (~45%):** lead with the highest-probability cause, give the exact tap path, end with a check-in. K0026: "Do a force restart: on iPhone press and quickly release volume up, volume down, then hold the side button until the Apple logo shows. It won't delete anything. Did it come back?" K0081: "forget the network on your phone (Settings > Wi-Fi > tap the i > Forget) and rejoin it. Did it connect this time?"
- **The code translation (~15%, mostly K0051–K0075):** plain-English meaning first, then the one fix, often with emotional reassurance. K0054: "Not your fault at all — that's the website's server breaking, not your device."

Muse's empathy markers are minimal and surgical: "Frustrating, I know." (K0101), "That message is useless, I know." (K0052), "I know" appears twice total. No gushing, no "I'd be happy to".

**Predicted Ring pattern (pre-fix), grounded in live data:** Ring's observed filler inventory — "staged", "proceed with", "in order to", "I've requested", "I'm waiting", "I'd be happy to troubleshoot this issue for you" — plus the live error-handling voice ("I couldn't find any emails or receipts for X in your account. Let me know if it might be listed under a different..."), plus the step-dump habit. The typical predicted troubleshooting response: filler opener (8–12 words) + 8–10 numbered steps (100–140 words) + "Let me know if this works!" closer (~8 words) = ~130–170 words vs Muse's ~30.

---

### T-A: Login/auth + app crashes (K0001–K0030)

**Muse's pattern across all 30.** Two sub-flavors:

1. *Login/auth (K0001–K0015):* always starts by narrowing the failure mode, because login has 3–4 completely different root causes. K0001 asks error-vs-loader-vs-freeze. K0002 gives the single highest-probability cause ("saved password and the real one disagree") plus the caps-lock check. K0008 (2FA code not arriving): "Is it supposed to come by SMS or an authenticator app?" — one question that splits the diagnosis. K0013 (iPhone asks for a passcode never set): Muse's response asks which setup stage — not dumped here but follows the pattern. Characteristic: **never** lists "try resetting your password, check your email, check spam, try a different browser, restart the app…" — it asks the routing question first.
2. *App crashes/loading (K0016–K0030):* leads with the single cheapest fix for that symptom. K0016: force-quit + restart phone + "Does it still crash after that?" K0025 (bank app crashes on check deposit): "That's almost always a camera-permission issue" — confidence, not a list. K0029: exact cache-clear path. K0030 (Facebook battery drain): "Turn off Background App Refresh for Facebook… That alone usually fixes the battery drain."

Quoted Muse examples:
- K0006 (snapchat login expired): "That usually means the app's session token broke. Force-quit Snapchat completely, reopen it, and log in fresh. Does it let you in this time?"
- K0019 (tiktok freezes): "Go to Settings > TikTok and turn on 'Offload App' (iPhone) or clear cache in the app's settings (Android). That clears the junk without deleting your account. Still freezing after?"
- K0023 (maps blank screen): "Check if the app has location permission — on iPhone go to Settings > Privacy > Location Services > Maps. A blank map almost always means it can't see where you are."

**Predicted Ring pattern.** The pre-fix system prompt's "For multi-step tasks, list the steps numbered" fires hardest here. Predicted for K0001 ("I can't log into Instagram"):

> "I'd be happy to help troubleshoot this issue for you! Here are some steps you can try in order to resolve the Instagram login problem:
> 1. First, check your internet connection and try switching between Wi-Fi and cellular data.
> 2. Force-quit the Instagram app completely and reopen it.
> 3. Make sure you have the latest version of Instagram installed from the App Store.
> 4. Restart your phone.
> 5. Try logging in through a mobile browser at instagram.com to check if it's an app issue.
> 6. Double-check your username and password for typos, and make sure Caps Lock is off.
> 7. If you've forgotten your password, tap 'Forgot password?' to reset it.
> 8. Check whether Instagram's servers are down.
> 9. Clear the app cache or offload the app.
> 10. As a last resort, uninstall and reinstall the app.
> Let me know which of these steps works for you!"

**Word count:** ~150 vs Muse's 25 (6×). The filler opener ("I'd be happy to troubleshoot this issue for you") is verbatim from the known Ring filler inventory.

#### Deep dive T-A/1 — K0001 "I can't log into Instagram"

- **Input:** "I can't log into Instagram"
- **Muse (25 words):** "What exactly happens when you try to log in — do you get an error message, a spinning loader, or does the app just freeze?"
- **Predicted Ring (~150 words):** as above.
- **Word-by-word divergence:** Muse's every word is a routing question — "What exactly happens" narrows; the three options (error message / spinning loader / freeze) are the three mutually-exclusive failure modes that determine the fix. Ring's every word is a broadcast — it spends ~140 words covering all branches simultaneously so that no routing question is needed. Muse defers; Ring front-loads.
- **Tone:** Muse is clinical and efficient (no greeting, no filler). Ring is customer-service-polite ("I'd be happy to"), which reads as slow.
- **Structure:** Muse = one sentence, one question. Ring = opener + numbered list + closer.
- **Tool selection:** Neither needs tools yet — this is diagnosis. Muse correctly withholds action; Ring's pre-fix pattern sometimes pairs step-dumps with unsolicited tool reads (cf. live S0861: "I couldn't find any emails or receipts…"), but here the likely pre-fix behavior is text-only.
- **Error handling:** Muse's question IS the error handling — it refuses to guess. Ring guesses all branches at once.
- **Scores (predicted pre-fix):** Conciseness 8, Intelligence 20, Directness 15, Outcome 20 → **63/100**. Muse is the 100 reference.
- **Exact gap:** 125 excess words; zero questions asked; user must read 10 steps to find their one relevant branch; the actual most-likely-next-action (the routing question) never happens.
- **Specific fix:** system-prompt rule "ONE-STEP RULE (troubleshooting): give at most one diagnostic step or one clarifying question per reply, ≤35 words, end with a check-in question. Never a numbered list." (§10, Fix T1). 592e780 impact: banned-words removes "I'd be happy to troubleshoot this issue for you" → saves ~10 words; does NOT touch the 10-step dump (~140 words remain).

#### Deep dive T-A/2 — K0008 "two factor code isnt coming thru. checked spam"

- **Input:** "two factor code isnt coming thru. checked spam"
- **Muse (30 words):** "Is it supposed to come by SMS or an authenticator app? If SMS, check if you can receive other texts right now — sometimes it's a carrier delay, not the app."
- **Predicted Ring (~130 words):** "I'd be happy to help with this two-factor authentication issue! Please try the following steps: 1. Check your spam and junk folders… 2. Make sure your phone number is correct… 3. Restart your phone… 4. Check your carrier signal… 5. Try resending the code… 6. If using an authenticator app, check the time sync… 7. Contact support…"
- **Word-by-word divergence:** The user already said "checked spam" — Muse honors that and never repeats it; Ring's predicted list re-suggests spam first, proving it didn't read the input. Muse's single question (SMS vs authenticator) is the highest-information question available; Ring buries that distinction as step 6 of 7.
- **Scores:** Conciseness 7, Intelligence 17 (ignores stated fact), Directness 14, Outcome 18 → **56/100**.
- **Exact gap:** repeats a ruled-out step; buries the routing question; 100 excess words.
- **Specific fix:** "Read the input for ruled-out steps; never re-suggest them" + one-step rule (§10, Fix T1). 592e780 impact: minimal here — the vague-input guardrail (fix #7) doesn't cover ruled-out steps.

#### Deep dive T-A/3 — K0026 "the whole phone just froze. screen stuck."

- **Input:** "the whole phone just froze. screen stuck."
- **Muse (33 words):** "Do a force restart: on iPhone press and quickly release volume up, volume down, then hold the side button until the Apple logo shows. It won't delete anything. Did it come back?"
- **Predicted Ring (~140 words):** opener + list: charge the phone, force restart, wait for battery to die, boot into recovery, contact Apple support… — the single known fix (force restart) buried at step 2 of 8, with the "It won't delete anything" reassurance missing (users fear force-restart wipes data).
- **Scores:** Conciseness 8, Intelligence 19, Directness 15, Outcome 19 → **61/100**.
- **Exact gap:** the reassurance clause ("It won't delete anything") is the highest-value sentence for a panicking user; Ring's predicted pattern omits it. Also introduces scary options (recovery mode) for a routine freeze.
- **Specific fix:** one-step rule; add "include the fear-addressing clause" guidance (§10, Fix T4 empathy). 592e780 impact: none on structure.

**Per-scenario gap table — T-A (K0001–K0030):** predicted pre-fix Ring scores and primary failure mode.

| ID | Input (short) | Predicted Ring pattern | C/I/D/O (pred) | Primary gap |
|---|---|---|---|---|
| K0001 | can't log into Instagram | 10-step dump, no routing Q | 8/20/15/20 | step-dump, no diagnosis |
| K0002 | wrong password, KNOW it's right | list incl. "reset password" first | 10/18/14/18 | misses caps-lock insight |
| K0003 | locked out of apple id | generic reset steps | 9/19/15/19 | no wrong-pw vs locked split |
| K0004 | gmail won't sign in, need NOW | dump incl. "wait 24h" | 8/17/13/17 | urgency ignored |
| K0005 | fb reset email never came | dump; re-suggests spam check | 9/18/14/18 | ruled-out step repeated |
| K0006 | snapchat login expired | app-reinstall list | 10/19/15/19 | misses session-token insight |
| K0007 | netflix kicks me out daily | generic list | 9/18/14/18 | misses device-limit insight |
| K0008 | 2FA code not coming, checked spam | 7-step dump, spam first | 7/17/14/18 | repeats ruled-out step |
| K0009 | twitter logged out, can't get back | dump | 9/19/15/19 | no failure-mode routing |
| K0010 | laptop won't accept password | dump incl. reinstall | 8/17/13/17 | escalates too fast |
| K0011 | bank app invalid credentials | generic list | 10/19/15/19 | no bank-specific path |
| K0012 | spotify login failed | dump | 10/20/15/20 | step-dump only |
| K0013 | iphone asks for unknown passcode | dump; may suggest restore (data loss risk) | 7/16/13/15 | dangerous escalation |
| K0014 | can't log into college portal | generic list | 10/19/15/19 | no portal-specific path |
| K0015 | discord email not found | dump | 10/19/15/19 | misses alt-login insight |
| K0016 | app keeps crashing | "which app?" buried in list | 9/19/14/19 | routing Q buried |
| K0017 | uber app won't load | dump | 10/20/15/20 | misses connection-vs-app split |
| K0018 | stuck on loading screen | dump | 10/20/15/20 | misses "which app" first |
| K0019 | tiktok freezes on open | cache-clear buried at #6 | 9/19/14/19 | best fix buried |
| K0020 | amazon app black screen | update buried in list | 10/20/15/20 | best fix buried |
| K0021 | instagram won't refresh feed | dump | 10/20/15/20 | misses network-block insight |
| K0022 | music app stopped randomly | dump | 9/18/14/18 | misses storage-kill insight |
| K0023 | maps blank screen | dump; location perm at #5 | 8/18/14/18 | best fix buried |
| K0024 | camera won't open | dump | 10/19/15/19 | misses one-app-at-a-time insight |
| K0025 | bank app crashes on deposit | generic crash list | 8/17/14/17 | misses camera-permission insight |
| K0026 | whole phone froze | force-restart at #2, no reassurance | 8/19/15/19 | reassurance missing |
| K0027 | youtube buffering, internet fine | quality-drop buried | 9/19/14/19 | best fix buried |
| K0028 | whatsapp images won't download | dump; date/time at #7 | 8/18/14/18 | best fix buried |
| K0029 | gmail crashing on android | cache-clear buried | 9/19/14/19 | best fix buried |
| K0030 | facebook eating battery | dump; background-refresh at #4 | 9/19/14/19 | best fix buried |

**T-A aggregate (predicted pre-fix):** Conciseness ~9/25, Intelligence ~19/25, Directness ~15/25, Outcome ~19/25 → **~62/100**. The dominant failure is structural (list vs one-step), not knowledge — Ring usually *contains* the right fix, buried at position 4–7 of 10.

---

### T-B: Device/OS quirks + error codes, first half (K0031–K0060)

**Muse's pattern across all 30.** Two flavors again:

1. *Device/OS quirks (K0031–K0050):* the "check the #1 stupid cause" pattern. K0033 (notifications stopped): "is Do Not Disturb or a Focus mode on? That's the #1 cause of mysteriously silent notifications." K0036 (screen zoomed): instant diagnosis ("You triggered zoom accidentally") + exact gesture + prevention. K0040 (can't hear calls unless speaker): "Clean the earpiece speaker — lint buildup mutes it." K0050 (notifications no sound): "the silent switch… and… the alert volume slider. One of those is muted almost every time." Characteristic confidence phrases: "almost always", "That's the #1 cause", "almost every time" — Muse bets on the base rate.
2. *Error codes begin (K0051–K0060):* translate the code, then the fix. K0051 (403): "the server understood your request but refuses to let you in — you're blocked, not lost." K0054 (500): "Not your fault at all." K0059 (payment not processed): most-common-causes-first ordering.

Quoted Muse examples:
- K0033: "Which app's notifications? Quick universal check: is Do Not Disturb or a Focus mode on? That's the #1 cause of mysteriously silent notifications."
- K0038 (icloud storage full): "Deleted photos sit in 'Recently Deleted' for 30 days and still count against you. Go to Photos > Recently Deleted and delete them there for real. Did the number drop?"
- K0052 ("something went wrong"): "That message is useless, I know. Where did you see it — which app or website? And what were you trying to do right when it appeared?"

**Predicted Ring pattern.** For quirks: same step-dump, but worse — device quirks have folk fixes that multiply ("reset network settings", "update iOS", "restore from backup") and Ring's pre-fix pattern escalates to destructive steps (restore/reset) far too early. For error codes: Ring's known code-exposure habit — it reads the code back ("Error 403 is an HTTP status code indicating Forbidden…") instead of translating.

#### Deep dive T-B/1 — K0036 "my screen is zoomed in and i cant get it back"

- **Input:** "my screen is zoomed in and i cant get it back"
- **Muse (28 words):** "You triggered zoom accidentally. Double-tap with three fingers to zoom back out, then turn it off in Settings > Accessibility > Zoom so it doesn't happen again."
- **Predicted Ring (~135 words):** "I'd be happy to help! If your iPhone screen is zoomed in, try these steps: 1. Double-tap with three fingers… 2. Go to Settings > Accessibility > Zoom and turn it off… 3. Restart your device… 4. Check Display Zoom in Settings > Display & Brightness… 5. Reset all settings… 6. Update iOS… 7. Contact Apple Support…"
- **Word-by-word divergence:** Muse's first 4 words ("You triggered zoom accidentally") are a diagnosis — they explain AND reassure (you didn't break it). Ring's list treats it as an unsolved mystery and escalates to "Reset all settings" (#5) — a destructive step for a 5-second fix. Muse also adds prevention ("so it doesn't happen again"); Ring's list ends without it.
- **Scores:** Conciseness 8, Intelligence 16 (destructive escalation), Directness 14, Outcome 16 → **54/100**.
- **Exact gap:** 107 excess words; destructive step for a trivial fix; diagnosis-as-reassurance missing.
- **Specific fix:** one-step rule + "never escalate to reset/restore in the first reply" (§10, Fix T1/T5). 592e780 impact: none.

#### Deep dive T-B/2 — K0054 "500 internal server error, is that my fault?"

- **Input:** "500 internal server error, is that my fault?"
- **Muse (30 words):** "Not your fault at all — that's the website's server breaking, not your device. Wait 15-20 minutes and retry. If it's still down, it needs their engineers, not you."
- **Predicted Ring (~120 words):** "A 500 Internal Server Error is an HTTP status code that indicates the server encountered an unexpected condition… This is a server-side issue. Here are steps you can try: 1. Refresh the page… 2. Clear your browser cache… 3. Try a different browser… 4. Check if the site is down for everyone… 5. Contact the website administrator…"
- **Word-by-word divergence:** The user's real question is emotional ("is that my fault?"). Muse answers it in the first 5 words ("Not your fault at all") — absolution before mechanics. Ring's predicted pattern answers the literal question ("what is a 500") with a definition and gives the user *homework* (clear cache, try browsers) for a problem Muse correctly identifies as not theirs to fix. This is the reassurance gap in pure form.
- **Tone:** Muse is a calm friend; Ring is a textbook.
- **Scores:** Conciseness 9, Intelligence 18 (misses the emotional question), Directness 14, Outcome 17 → **58/100**.
- **Exact gap:** gives user work for a server-side fault; no absolution; 90 excess words.
- **Specific fix:** "answer the emotional question first" — the reassure-then-fix template (§10, Fix T4). 592e780 impact: none — no fix addresses emotional routing.

#### Deep dive T-B/3 — K0059 "it says 'payment could not be processed' but doesnt say why"

- **Input:** "it says 'payment could not be processed' but doesnt say why"
- **Muse (37 words):** "Check the most common causes first: is the billing zip matching your card? And is there enough available credit? If both are fine, your bank may be declining it — call the number on your card."
- **Predicted Ring (~140 words):** generic payment-failure list (check card number, expiry, CVV, billing address, try another card, clear cache, contact merchant, contact bank) — the two highest-probability causes (billing zip, available credit) buried mid-list, no ordering by likelihood.
- **Scores:** Conciseness 8, Intelligence 18, Directness 14, Outcome 18 → **58/100**.
- **Exact gap:** no base-rate ordering; Muse's "most common causes first" framing is itself intelligence.
- **Specific fix:** "order fixes by base-rate likelihood; say so" (§10, Fix T2). 592e780 impact: none.

**Per-scenario gap table — T-B (K0031–K0060):**

| ID | Input (short) | Predicted Ring pattern | C/I/D/O (pred) | Primary gap |
|---|---|---|---|---|
| K0031 | can't send photos on imessage | dump; MMS toggle buried | 9/19/14/19 | best fix buried |
| K0032 | phone won't connect to car BT | dump | 10/20/15/20 | step-dump only |
| K0033 | notifications stopped | dump; DND at #3 | 9/19/14/19 | #1 cause buried |
| K0034 | keyboard disappears | dump | 10/19/15/19 | misses app-vs-system split |
| K0035 | siri stopped working | dump incl. reset | 9/18/14/18 | misses update-toggle insight |
| K0036 | screen zoomed, can't unzoom | dump; "reset all settings" #5 | 8/16/14/16 | destructive escalation |
| K0037 | app store won't download | dump; payment-method buried | 8/18/14/18 | best fix buried |
| K0038 | icloud full, deleted everything | dump; Recently Deleted at #4 | 8/18/14/18 | best fix buried |
| K0039 | phone overheats, no reason | dump; asks nothing | 9/18/14/18 | no when/where routing |
| K0040 | can't hear calls unless speaker | dump; lint-clean buried | 9/19/14/19 | best fix buried |
| K0041 | facebook keeps logging out | dump | 10/19/15/19 | misses cookie/private insight |
| K0042 | zoom audio not working | dump; output-routing buried | 8/18/14/18 | best fix buried |
| K0043 | laptop fan SO loud | dump | 10/19/15/19 | misses Activity Monitor path |
| K0044 | printer won't print | dump | 10/19/15/19 | power-cycle buried |
| K0045 | touchscreen dead in one corner | dump; may suggest reset | 8/17/14/16 | hardware misroute risk |
| K0046 | airpods one side only | dump; case-reset buried | 9/19/14/19 | best fix buried |
| K0047 | windows update stuck 100% | dump; "wait" buried | 9/18/14/18 | patience instruction buried |
| K0048 | phone won't charge | dump; cable-first buried | 9/19/14/19 | best fix buried |
| K0049 | laptop screen flickers | dump | 9/18/14/18 | misses lid-move test |
| K0050 | notifications no sound | dump; silent-switch buried | 8/18/14/18 | #1 cause buried |
| K0051 | what does error 403 mean | defines code, generic list | 10/19/15/19 | defines vs translates |
| K0052 | "something went wrong" ugh | dump; asks nothing | 8/17/13/17 | no where/what routing |
| K0053 | error 404 on link | dump | 10/20/15/20 | step-dump only |
| K0054 | 500 error, is that my fault? | defines code, user homework | 9/18/14/17 | reassurance missing |
| K0055 | session expired | dump incl. clear cookies | 9/19/14/19 | over-engineers trivial |
| K0056 | err_connection_timed_out | dump; other-sites test buried | 8/18/14/18 | best test buried |
| K0057 | "this site can't be reached" | dump | 9/19/14/19 | misses typo-first check |
| K0058 | 0x80070005 on windows | reads code back, dump | 8/17/13/17 | code exposure + no routing |
| K0059 | payment not processed, no reason | unordered dump | 8/18/14/18 | no base-rate ordering |
| K0060 | dns_probe_finished_no_internet | dump; router-restart buried | 9/19/14/19 | best fix buried |

**T-B aggregate (predicted pre-fix):** Conciseness ~9/25, Intelligence ~18/25, Directness ~14/25, Outcome ~18/25 → **~59/100**. Two new failure modes appear here: destructive escalation (K0036, K0045) and reassurance failure (K0054).

---

### T-C: Error codes (cont.) + connectivity (K0061–K0090)

**Muse's pattern across all 30.** Error codes K0061–K0075 continue the translate-then-fix pattern, with two standouts: K0063 (captcha failing): "Try a different browser or an incognito window — extensions often break captchas" (the non-obvious cause, stated confidently). K0064 (rate limited): "Don't try to log out and back in; that resets the timer" — a *negative* instruction, preventing the user's most likely self-harm. K0075 (couldn't verify identity): asks the routing question. Then connectivity K0076–K0090: the isolate-the-variable pattern — K0082 "Is it every device or just one?", K0086 "Does it happen everywhere or in one spot?", K0087 "is it slow on wifi only, or on data too?" Muse's connectivity diagnosis is always a binary split before any fix.

Quoted Muse examples:
- K0064: "That means you did too many actions too fast. Just wait 5-10 minutes without clicking anything — it clears on its own. Don't try to log out and back in; that resets the timer."
- K0069 (blue screen of death): "What did the error code say at the bottom — something like CRITICAL_PROCESS_DIED? That tells us if it's a driver or hardware. Also, did it happen after an update?"
- K0086 (calls dropping): "Does it happen everywhere or in one spot? If it's one location, that's a coverage dead zone, not your phone. If everywhere, tell me your carrier and I'll check known issues."

**Predicted Ring pattern.** Error codes: code-definition + generic list; the negative instructions ("don't log out") get lost. Connectivity: the binary-split questions get replaced by "try restarting your router" as step 1 regardless of scope — Ring's predicted pattern doesn't isolate variables, so a phone-only wifi issue gets router advice.

#### Deep dive T-C/1 — K0063 "captcha keeps failing even when i do it right"

- **Input:** "captcha keeps failing even when i do it right"
- **Muse (29 words):** "Try a different browser or an incognito window — extensions often break captchas. Also make sure you're not on a VPN, which gets flagged constantly."
- **Predicted Ring (~130 words):** "I understand how frustrating CAPTCHAs can be! Here are some troubleshooting steps: 1. Make sure you're selecting the correct images… 2. Refresh the CAPTCHA… 3. Clear your browser cache… 4. Disable your ad blocker… 5. Try a different browser… 6. Check your internet connection… 7. Disable VPN…"
- **Word-by-word divergence:** Muse's diagnosis is *causal* (extensions break captchas; VPNs get flagged) — it names the mechanism. Ring's predicted list is *symptomatic* ("make sure you're selecting the correct images") — it questions the user's competence on the exact point the user already asserted ("even when i do it right"). The mechanism (extensions, VPN) is buried at #4/#7.
- **Scores:** Conciseness 8, Intelligence 17 (contradicts user's assertion), Directness 14, Outcome 17 → **56/100**.
- **Exact gap:** insults the user's competence; buries the causal fix; 100 excess words.
- **Specific fix:** "never re-litigate what the user asserted" + one-step rule (§10, Fix T1). 592e780 impact: none.

#### Deep dive T-C/2 — K0069 "blue screen of death help"

- **Input:** "blue screen of death help"
- **Muse (32 words):** "What did the error code say at the bottom — something like CRITICAL_PROCESS_DIED? That tells us if it's a driver or hardware. Also, did it happen after an update?"
- **Predicted Ring (~160 words):** "A Blue Screen of Death (BSOD), technically known as a STOP error with codes like 0x0000007B…, can be caused by faulty drivers, hardware failures, corrupt system files… Try: 1. Restart your computer… 2. Boot into Safe Mode… 3. Update your drivers… 4. Run memory diagnostics… 5. Check for Windows updates… 6. Run System File Checker (sfc /scannow)… 7. Check your hard drive… 8. If nothing works, reinstall Windows…"
- **Word-by-word divergence:** This is Ring's code-exposure habit at its worst: "technically known as a STOP error with codes like 0x0000007B" — raw hex dumped on a panicking user. Muse does the opposite: it *asks* for the code ("What did the error code say at the bottom") because the code is diagnostic *input*, not explanatory *output*. Ring also escalates to "reinstall Windows" (#8) — the nuclear option — in a first reply.
- **Tone:** Muse is a triage nurse; Ring is a Wikipedia article with a bomb at the end.
- **Scores:** Conciseness 6, Intelligence 15 (code exposure, nuclear escalation), Directness 12, Outcome 15 → **48/100** — the lowest predicted score in T-C.
- **Exact gap:** 128 excess words; hex codes on a lay user; reinstall-Windows in first reply; never asks the two routing questions.
- **Specific fix:** "error codes are input, never output — ask for them, don't recite them" + escalation guard (§10, Fix T3/T5). 592e780 impact: none.

#### Deep dive T-C/3 — K0081 "wifi not working on my phone only"

- **Input:** "wifi not working on my phone only"
- **Muse (28 words):** "If every other device is fine, forget the network on your phone (Settings > Wi-Fi > tap the i > Forget) and rejoin it. Did it connect this time?"
- **Predicted Ring (~140 words):** "I'd be happy to help with your Wi-Fi issue! Try these steps: 1. Restart your router (unplug for 30 seconds)… 2. Restart your phone… 3. Forget the network and rejoin… 4. Reset network settings… 5. Check for iOS updates… 6. Move closer to the router… 7. Contact your ISP…"
- **Word-by-word divergence:** The input contains the scope ("on my phone only") — the router is *exonerated* by the user's own words. Muse honors it ("If every other device is fine" — it even re-verifies gently, then goes phone-side). Ring's predicted step 1 is "restart your router" — it ignores the scope the user provided and disrupts every other device in the house. This is the variable-isolation failure.
- **Scores:** Conciseness 8, Intelligence 15 (ignores stated scope), Directness 14, Outcome 16 → **53/100**.
- **Exact gap:** advises disrupting the whole network for a single-device issue; correct fix buried at #3.
- **Specific fix:** "honor scope qualifiers in the input" (§10, Fix T2). 592e780 impact: none.

**Per-scenario gap table — T-C (K0061–K0090):**

| ID | Input (short) | Predicted Ring pattern | C/I/D/O (pred) | Primary gap |
|---|---|---|---|---|
| K0061 | err_ssl_protocol_error | defines code, dump; date/time buried | 8/18/14/18 | best fix buried |
| K0062 | "unauthorized" opening doc | dump | 9/19/14/19 | misses wrong-account insight |
| K0063 | captcha fails though right | re-litigates user's skill, dump | 8/17/14/17 | contradicts assertion |
| K0064 | rate limited on discord | dump; "don't log out" missing | 8/18/14/17 | negative instruction lost |
| K0065 | error 429?? | defines, dump | 9/19/14/19 | defines vs translates |
| K0066 | "account not found" daily site | dump | 9/19/14/19 | misses alt-login insight |
| K0067 | err_quic_protocol_error | reads code back, dump | 7/17/13/17 | code exposure |
| K0068 | "action isn't allowed" IG | dump | 9/18/14/18 | no routing question |
| K0069 | blue screen of death | hex dump + reinstall Windows | 6/15/12/15 | code exposure, nuclear escalation |
| K0070 | "invalid token" | dump | 9/19/14/19 | no context routing |
| K0071 | "your clock is ahead" | dump; date/time buried irony | 8/18/14/18 | best fix buried |
| K0072 | 502 bad gateway | defines, user homework | 9/18/14/17 | server fault → user work |
| K0073 | email already in use | dump | 10/19/15/19 | misses "try login" insight |
| K0074 | err_cache_miss chrome | dump | 9/19/14/19 | over-engineers |
| K0075 | couldn't verify identity | dump; no routing | 8/17/13/17 | no routing question |
| K0076 | app white screen then nothing | dump | 10/19/15/19 | step-dump only |
| K0077 | games lagging on low settings | dump | 9/18/14/18 | misses driver/thermal split |
| K0078 | phone storage full, what delete | dump without ordering | 9/19/14/19 | no biggest-wins ordering |
| K0079 | facetime keeps failing | dump | 9/19/15/19 | no routing |
| K0080 | texts aren't sending | dump; iMessage-vs-SMS buried | 8/18/14/18 | best split buried |
| K0081 | wifi not working on phone only | router restart #1 | 8/15/14/16 | ignores stated scope |
| K0082 | wifi drops every few min | dump; no every-vs-one split | 8/17/13/17 | no variable isolation |
| K0083 | phone has no service | dump; airplane-toggle buried | 9/19/14/19 | best fix buried |
| K0084 | hotspot won't turn on | dump; plan-check buried | 8/18/14/18 | best check buried |
| K0085 | bluetooth keeps disconnecting | dump; distance/battery buried | 9/19/14/19 | best checks buried |
| K0086 | calls keep dropping | dump; no everywhere-vs-spot | 8/17/13/17 | no variable isolation |
| K0087 | internet slow today | dump; no wifi-vs-data split | 8/17/13/17 | no variable isolation |
| K0088 | can't connect to office vpn | dump | 9/18/14/18 | no error-vs-hang routing |
| K0089 | chromecast disappeared | dump; band-mismatch buried | 8/18/14/18 | best fix buried |
| K0090 | airdrop not working | dump; checklist buried | 9/19/14/19 | checklist buried in prose |

**T-C aggregate (predicted pre-fix):** Conciseness ~8/25, Intelligence ~18/25, Directness ~14/25, Outcome ~18/25 → **~58/100**. The variable-isolation failure (K0081, K0082, K0086, K0087) is the signature gap: Muse always splits scope before fixing; Ring never does.

---

### T-D: Connectivity (cont.) + performance + payments + hardware (K0091–K0120)

**Muse's pattern across all 30.** Connectivity K0091–K0095 keeps the isolate-then-fix pattern (K0095: "That means you're connected to the router but the router can't reach the outside world. Restart the modem (not just the router)"). Performance K0096–K0100 is diagnostic-via-settings: K0096 points at iPhone Storage <2GB; K0097 points at Battery usage screen; K0098 at Login Items — Muse *sends the user to the data* rather than guessing. Payments K0101–K0111 are the most distinctive: money panic gets the fastest, most concrete triage — K0107 (Zelle wrong person): "Act fast:" + the enrolled/not-enrolled branch, because the cancel window is minutes. Hardware K0112–K0120: the hardware-vs-software split stated explicitly (K0045: "that's a hardware problem — no software fix will help"; K0145: "If yes, it's software… If no… it's hardware").

Quoted Muse examples:
- K0095 (wifi works, no internet): "That means you're connected to the router but the router can't reach the outside world. Restart the modem (not just the router) — unplug 30 seconds. Back?"
- K0097 (battery draining): "Go to Settings > Battery and look at the last 24 hours — which app is at the top? One rogue app update is usually the cause, and we can deal with it once we know which."
- K0103 (subscription charged twice): "Check if they're actually two charges or one charge + one pending authorization that'll drop off. Look at the dates and amounts — are they identical?"

**Predicted Ring pattern.** Payments are where Ring's verbosity is most dangerous: a Zelle mis-send needs "act fast" + one branch, not 10 steps. Predicted Ring gives the generic "contact your bank / contact Zelle support / be careful next time" list — the cancel-window instruction buried or absent.

#### Deep dive T-D/1 — K0107 "zelle sent money to the wrong person"

- **Input:** "zelle sent money to the wrong person"
- **Muse (37 words):** "Act fast: if they're not enrolled in Zelle, you can cancel it in your bank's app under Zelle activity. If they're enrolled, the money's gone — you'll have to ask them to send it back."
- **Predicted Ring (~150 words):** "I'm sorry to hear that! If you sent money to the wrong person on Zelle, here are the steps you can take: 1. Check the payment status in your bank's app… 2. If the payment is still pending, you may be able to cancel it… 3. Contact the recipient and ask them to return the money… 4. Contact your bank's customer support… 5. Contact Zelle support… 6. File a dispute if necessary… 7. In the future, always double-check…"
- **Word-by-word divergence:** Muse's first two words ("Act fast:") encode the time-criticality — the cancel window closes when the recipient enrolls. Muse's branch (enrolled vs not) is the *only* distinction that matters. Ring's predicted list buries "pending → cancel" at #2 behind a status-check, adds "file a dispute" (#6 — Zelle disputes for authorized mis-sends almost never succeed, a misleading hope), and lectures (#7). The user is panicking about money; Ring gives them homework.
- **Tone:** Muse is urgent and honest ("the money's gone"); Ring is sympathetic but dilatory.
- **Scores:** Conciseness 8, Intelligence 17 (misleading dispute hope), Directness 14, Outcome 16 → **55/100**.
- **Exact gap:** time-criticality flattened; the enrolled/not-enrolled branch — the entire diagnosis — demoted to a sub-clause; false hope via "dispute".
- **Specific fix:** "money-panic template: urgency marker + the one branching fact + honest odds" (§10, Fix T6). 592e780 impact: none.

#### Deep dive T-D/2 — K0097 "battery draining fast since yesterday"

- **Input:** "battery draining fast since yesterday"
- **Muse (33 words):** "Go to Settings > Battery and look at the last 24 hours — which app is at the top? One rogue app update is usually the cause, and we can deal with it once we know which."
- **Predicted Ring (~140 words):** "Here are some steps to fix battery drain: 1. Restart your phone… 2. Check for software updates… 3. Turn down screen brightness… 4. Turn off Background App Refresh… 5. Disable location services… 6. Close unused apps… 7. Check battery health… 8. Reset all settings…"
- **Word-by-word divergence:** "since yesterday" is the key temporal clue — sudden onset = one rogue app update. Muse reads it ("One rogue app update is usually the cause") and sends the user to the Battery screen *data* instead of guessing. Ring's predicted list applies the generic battery-hygiene playbook, which is for *gradual* drain — it never addresses the sudden-onset clue, and step 8 ("Reset all settings") is destructive overkill.
- **Scores:** Conciseness 8, Intelligence 16 (misses temporal clue), Directness 14, Outcome 17 → **55/100**.
- **Exact gap:** ignores "since yesterday"; sends generic hygiene instead of targeted diagnosis; destructive step #8.
- **Specific fix:** "read temporal qualifiers; sudden onset → find the changed thing" (§10, Fix T2). 592e780 impact: none.

#### Deep dive T-D/3 — K0113 "laptop battery dies in like an hour"

- **Input:** "laptop battery dies in like an hour"
- **Muse (29 words):** "Check the battery health: on Mac it's System Settings > Battery > the (i) icon; on Windows run 'powercfg /batteryreport'. What's the max capacity showing?"
- **Predicted Ring (~130 words):** generic battery-life list (dim screen, close apps, battery saver mode, update drivers…) — treats a *capacity* problem as a *consumption* problem. Muse's question ("What's the max capacity showing?") distinguishes a worn battery (hardware, needs replacement) from high drain (software) — Ring's list never makes the distinction.
- **Scores:** Conciseness 9, Intelligence 16, Directness 14, Outcome 17 → **56/100**.
- **Exact gap:** capacity-vs-consumption distinction missing; the one diagnostic datum never requested.
- **Specific fix:** "send user to the measurement, don't guess" — the diagnostic-data pattern (§10, Fix T2). 592e780 impact: none.

**Per-scenario gap table — T-D (K0091–K0120):**

| ID | Input (short) | Predicted Ring pattern | C/I/D/O (pred) | Primary gap |
|---|---|---|---|---|
| K0091 | smart tv won't connect wifi | dump; password re-entry buried | 9/19/14/19 | best fix buried |
| K0092 | echo dot says offline | dump; 30s unplug buried | 9/19/14/19 | best fix buried |
| K0093 | laptop won't find printer | dump; network-hop insight buried | 8/18/14/18 | best insight buried |
| K0094 | zoom keeps freezing | dump; camera-off test buried | 8/18/14/18 | diagnostic test buried |
| K0095 | wifi works, no internet | dump; modem-vs-router buried | 8/18/14/18 | distinction buried |
| K0096 | phone slow as hell | dump; storage check buried | 9/18/14/18 | best check buried |
| K0097 | battery draining since yesterday | generic hygiene; misses temporal clue | 8/16/14/17 | temporal clue ignored |
| K0098 | laptop slow to boot | dump; startup items buried | 9/19/14/19 | best fix buried |
| K0099 | phone hot when charging | dump; charger/case buried | 9/19/14/19 | best checks buried |
| K0100 | screen dimming by itself | dump | 9/19/14/19 | step-dump only |
| K0101 | card declined but have money | dump; everywhere-vs-one buried | 8/18/14/17 | best split buried |
| K0102 | apple pay not working at stores | dump; re-add card buried | 9/19/14/19 | best fix buried |
| K0103 | subscription charged twice | dump; pending-auth insight buried | 8/18/14/18 | best insight buried |
| K0104 | can't add card to google pay | dump; no bank-vs-Google routing | 8/17/13/17 | no routing question |
| K0105 | venmo payment won't go through | dump; verification buried | 9/19/14/19 | best check buried |
| K0106 | card "expired" but hasn't | dump; saved-card insight buried | 8/18/14/18 | best insight buried |
| K0107 | zelle to wrong person | dilatory list; false dispute hope | 8/17/14/16 | urgency flattened |
| K0108 | billing address mismatch | dump | 9/20/15/20 | step-dump only |
| K0109 | refund never arrived | dump; 5-10 day window buried | 9/19/14/19 | timeline buried |
| K0110 | paypal holding money 21 days | dump; tracking-info fix buried | 8/18/14/18 | fastest release buried |
| K0111 | cash app payment failed | dump | 9/19/14/19 | step-dump only |
| K0112 | phone screen cracked | dump; touch-vs-dead split buried | 8/18/14/17 | triage split buried |
| K0113 | laptop battery dies in an hour | consumption list for capacity problem | 9/16/14/17 | capacity/consumption conflated |
| K0114 | keyboard double letters | dump; every-vs-specific buried | 9/19/14/19 | best split buried |
| K0115 | trackpad stopped clicking | dump; two-finger test buried | 9/19/14/19 | diagnostic test buried |
| K0116 | earbuds mic not on calls | dump; mic-source buried | 8/18/14/18 | best fix buried |
| K0117 | tablet won't turn on | dump; 30-min charge buried | 9/19/14/19 | best fix buried |
| K0118 | watch won't pair | dump; one-phone-only buried | 8/18/14/18 | key constraint buried |
| K0119 | usb drive not showing up | dump; port-swap buried | 9/19/14/19 | best fix buried |
| K0120 | monitor no signal | dump; cable-seat buried | 9/19/14/19 | best fix buried |

**T-D aggregate (predicted pre-fix):** Conciseness ~9/25, Intelligence ~18/25, Directness ~14/25, Outcome ~18/25 → **~59/100**. Payments (K0101–K0111) are the highest-stakes sub-cluster: Ring's dilatory lists are actively harmful when the cancel window is minutes.

---

### T-E: Misc app behaviors + update/activation (K0121–K0150)

**Muse's pattern across all 30.** This is the "long tail" — 30 unrelated symptoms, and Muse's discipline holds without exception: one step or one question, ~30 words. Notable: K0124 (emails going to spam) asks the disambiguating question first ("Are YOUR sent emails landing in other people's spam, or are you getting spam?") — the two readings need opposite fixes. K0142 (password manager locked out) is honest about limits: "Without it, most password managers can't help — that's by design." K0148 (phone restarting): "check… Analytics Data for 'panic' entries; those point to hardware" — sends user to the datum. K0150 (new phone won't activate): "connect to wifi (not cellular) and try again — activation needs Apple's servers."

Quoted Muse examples:
- K0128 (alarm didn't go off): "Was the phone on silent or Do Not Disturb? Alarms should still sound, but a Focus mode with the wrong settings can mute them. Also check the alarm volume slider — it's separate from ringer."
- K0137 (can't delete apps): "That's a Screen Time restriction. Go to Settings > Screen Time > Content & Privacy Restrictions > iTunes & App Store Purchases > Deleting Apps — set it to Allow."
- K0149 (deleted files still taking space): "They're in the trash/recycle bin — deleting just moves them there. Empty the trash (on Mac, Finder > Empty Trash; files also auto-delete after 30 days). Did the space free up?"

**Predicted Ring pattern.** The long tail is where Ring's step-dump is most visibly absurd: K0137 (can't delete apps — a single Screen Time toggle) predicted to get a 7-step list including "restart your phone" and "update iOS". K0149 (empty the trash) predicted to get disk-cleanup advice. The one-step problems expose the dump habit most clearly because there is literally one fix.

#### Deep dive T-E/1 — K0130 "netflix error tvq-st-103"

- **Input:** "netflix error tvq-st-103"
- **Muse (27 words):** "That's a network/connectivity error on smart TVs. Restart the Netflix app first; if that fails, restart the TV itself. Still showing after both?"
- **Predicted Ring (~140 words):** "Netflix error tvq-st-103 is a connectivity error code that occurs when your device cannot connect to the Netflix service. This error typically appears on smart TVs, Blu-ray players, and set-top boxes. To resolve it: 1. Restart your device… 2. Restart your home network… 3. Check your internet connection… 4. Verify the Netflix servers are operational… 5. Sign out and back into Netflix… 6. Reinstall the Netflix app… 7. Contact Netflix support…"
- **Word-by-word divergence:** Muse translates the code in 6 words ("a network/connectivity error on smart TVs") then gives a 2-step escalation (app → TV) with a check-in. Ring's predicted pattern *defines* the code at length (repeating the code three times — classic code-exposure), then lists 7 generic steps; the specific 2-step escalation (app first, then TV) is present but diluted. Note Muse says "Restart the Netflix app first; if that fails, restart the TV itself" — ordered escalation, one sentence.
- **Scores:** Conciseness 8, Intelligence 19, Directness 14, Outcome 19 → **60/100**.
- **Exact gap:** code repeated 3×; ordered 2-step escalation diluted into 7; 113 excess words.
- **Specific fix:** code-translation template — "translate the code in ≤8 words, then the fix" (§10, Fix T3). 592e780 impact: none.

#### Deep dive T-E/2 — K0143 "cant update my iphone, not enough space"

- **Input:** "cant update my iphone, not enough space"
- **Muse (35 words):** "The update needs ~5GB free temporarily. Quick wins: delete downloaded Netflix/Spotify content and offload unused apps (Settings > General > iPhone Storage). How much free space do you have now?"
- **Predicted Ring (~140 words):** generic storage-freeing list (delete photos, delete apps, clear cache, offload unused apps, delete messages, use iCloud…) — misses the two highest-yield targets (downloaded streaming content) and the key fact (update needs ~5GB *temporarily* — the user doesn't need to permanently free space, just make room).
- **Scores:** Conciseness 8, Intelligence 18, Directness 14, Outcome 18 → **58/100**.
- **Exact gap:** "temporarily" is the highest-value word — it reframes the task from spring-cleaning to a 10-minute job; Ring's list implies a lifestyle change.
- **Specific fix:** "name the requirement and the highest-yield targets" (§10, Fix T2). 592e780 impact: none.

#### Deep dive T-E/3 — K0128 "my alarm didnt go off this morning"

- **Input:** "my alarm didnt go off this morning"
- **Muse (36 words):** "Was the phone on silent or Do Not Disturb? Alarms should still sound, but a Focus mode with the wrong settings can mute them. Also check the alarm volume slider — it's separate from ringer."
- **Predicted Ring (~130 words):** alarm-troubleshooting list (check alarm is on, check time/AM-PM, check volume, restart phone, update iOS, delete and recreate alarm…) — the actual iPhone-specific gotchas (Focus mode muting, separate alarm-volume slider) buried or absent; "check AM/PM" added (mild competence insult).
- **Scores:** Conciseness 8, Intelligence 18, Directness 14, Outcome 18 → **58/100**.
- **Exact gap:** platform-specific gotchas (the valuable knowledge) replaced by generic checks; 94 excess words.
- **Specific fix:** one-step rule forces the single most-likely cause first (§10, Fix T1). 592e780 impact: none.

**Per-scenario gap table — T-E (K0121–K0150):**

| ID | Input (short) | Predicted Ring pattern | C/I/D/O (pred) | Primary gap |
|---|---|---|---|---|
| K0121 | forgot wifi password | dump; connected-device path buried | 9/19/14/19 | best path buried |
| K0122 | instagram dms not sending | dump; blocked-vs-everyone buried | 8/18/14/18 | best split buried |
| K0123 | tiktok won't let me post | dump; copyright-music buried | 8/18/14/18 | best insight buried |
| K0124 | emails going to spam | dump; no disambiguation Q | 8/16/13/16 | ambiguous reading unasked |
| K0125 | can't open pdf attachments | dump; no app routing | 9/19/14/19 | no routing question |
| K0126 | contacts disappeared | dump; sync-toggle buried | 8/18/14/18 | best check buried |
| K0127 | photos not backing up | dump; two silent causes buried | 9/19/14/19 | best checks buried |
| K0128 | alarm didn't go off | generic list; gotchas buried | 8/18/14/18 | platform gotchas lost |
| K0129 | spotify offline songs won't play | dump; 30-day rule buried | 8/18/14/18 | key rule buried |
| K0130 | netflix tvq-st-103 | code defined 3×, 7-step list | 8/19/14/19 | code exposure |
| K0131 | can't cast to tv anymore | dump; same-network buried | 9/19/14/19 | best check buried |
| K0132 | autocorrect insane lately | dump; dictionary-reset buried | 9/19/14/19 | best fix buried |
| K0133 | laptop won't connect hotel wifi | dump; captive-portal buried | 8/18/14/18 | best fix buried |
| K0134 | mic too quiet on zoom | dump; auto-adjust buried | 9/19/14/19 | best fix buried |
| K0135 | apps keep asking location | dump | 9/20/15/20 | step-dump only |
| K0136 | phone says no sim | dump; reseat buried | 9/19/14/19 | best fix buried |
| K0137 | can't delete apps iphone | 7-step list for one toggle | 7/17/13/17 | absurd over-listing |
| K0138 | wallpaper keeps changing | dump; shuffle/Focus buried | 9/19/14/19 | best checks buried |
| K0139 | screenshots not saving | dump; storage-first buried | 9/19/14/19 | best check buried |
| K0140 | phone buzzes, nothing shows | dump; other-device buried | 8/18/14/18 | best insight buried |
| K0141 | chrome restoring old tabs | dump; on-startup buried | 9/19/14/19 | best fix buried |
| K0142 | password manager locked out | dump; false hope | 8/16/13/16 | honesty-about-limits missing |
| K0143 | can't update iphone, no space | generic list; "temporarily" missing | 8/18/14/18 | requirement unframed |
| K0144 | earbuds sound muffled | dump; wax-clean buried | 9/19/14/19 | #1 cause buried |
| K0145 | laptop speakers crackling | dump; headphone test buried | 8/18/14/18 | diagnostic test buried |
| K0146 | smart lights stopped responding | dump; wifi-change buried | 8/18/14/18 | best check buried |
| K0147 | can't sign out netflix on tv | dump; Get-Help path buried | 9/19/14/19 | best path buried |
| K0148 | phone restarting by itself | dump; panic-log buried | 8/17/13/17 | diagnostic datum buried |
| K0149 | deleted files still take space | dump; empty-trash buried | 8/18/14/18 | one-step fix buried |
| K0150 | new phone won't activate | dump; wifi-not-cellular buried | 9/19/14/19 | best fix buried |

**T-E aggregate (predicted pre-fix):** Conciseness ~8/25, Intelligence ~18/25, Directness ~14/25, Outcome ~18/25 → **~58/100**. The long tail proves the dump habit is structural, not knowledge-driven: even one-toggle fixes (K0137) get multi-step lists.

---

## Troubleshooting aggregate: the step-dump, quantified

| Metric | Muse (measured, n=150) | Ring predicted pre-fix (n=150) |
|---|---|---|
| Avg words/response | 29.8 (range 22–39) | ~135 (range ~110–170) |
| Numbered/bulleted lists | 0 of 150 | ~150 of 150 |
| Avg "steps" per response | 1.0 (one step or one question) | ~8.5 |
| Responses ending with a question | 43% | ~5% (ends with "Let me know!") |
| Avg questions per response | 0.99 | ~0.1 |
| Filler openers ("I'd be happy…") | 0 | ~80% |

**Why Ring lists 10 steps (§7 expands):** the system prompt's standing instruction "For multi-step tasks, list the steps numbered. Keep each step to one line." (`backend/lib/agent.js:1200`) is interpreted by the model as the *default* troubleshooting format. The 14 fixes in 592e780 added banned words and one-clause replies but left this line intact — so the model still believes numbered lists are the house style for anything multi-step. Additionally, Ring's training prior for "helpful tech support" is the wikiHow/blog format (list all possible fixes); Muse's reference responses demonstrate the opposite prior: the *technician* format (diagnose first, fix second, one step at a time). The fix must revoke the list instruction and install the technician format explicitly.

**Predicted troubleshooting overall (pre-fix):** Conciseness ~8.5/25, Intelligence ~18/25, Directness ~14/25, Outcome ~18/25 → **~58.5/100**. Intelligence stays highest because Ring usually *contains* the right fix (buried); conciseness is the crater. Post-592e780 projection: banned words + one-clause remove ~15–20 words of filler → conciseness ~11–12, directness ~16 → **~63–65/100**. The remaining ~35 points need the one-step rule (§10).

---

## PART 2 — COMPARISONS (K0151–K0300)

### Category overview: comparisons need verdict-first structure

Muse's comparison template is invariant across all 150 scenarios, regardless of phrasing ("X vs Y", "which is better", "should I", "is X worth it"):

1. **Verdict-first sentence** (avg 6.5 words, max 14): a decision with a qualifier. "Netflix, for most people." / "The Air, unless you know you need the Pro." / "Laptop, no contest for college." / "Used — 2-3 years old is the sweet spot." / "Yes — it's the best $78 in travel." / "Only if the salary bump pays the debt in under 5 years." The qualifier does heavy lifting: it scopes the verdict so the bullets don't have to hedge.
2. **Exactly 4 `•` bullets** (all 150 scenarios): each bullet is `Dimension: winner + one clause of reasoning`. Never 3, never 5. Dimensions are concrete (Price, Camera, Ecosystem, Updates) not abstract.
3. **Closing recommendation line**: conditional, actionable, often with a number. "DashPass pays for itself at ~2 orders/month." "Buy the 3-year-old version of the car you want. Pocket the $10,000 difference." "Get one, put one small recurring bill on it, autopay in full. That's it."

Total: avg 66.1 words, range 52–85. Zero questions (avg 0.05/response) — comparisons are answers, not diagnoses.

**Predicted Ring pattern (pre-fix):** the meander. Predicted structure: throat-clearing paragraph ("That's a great question! Both X and Y are excellent options, and the right choice really depends on your specific needs, preferences, and use case.") + paragraph-per-dimension prose (no bullets, or bullets without winners) + hedged close ("Ultimately, you can't go wrong with either — I'd recommend thinking about what matters most to you"). ~140–200 words. The verdict, if present, is buried in paragraph 2 or expressed as "it depends". Live grounding: Ring's observed hedging in error_handling ("Could you share the exact website domain or billing name so I can locate the account…") and its both-sides tendency; plus the general verbosity prior (1.3–6× Muse).

---

### C-A: "X vs Y" flagship products (K0151–K0180)

**Muse's pattern across all 30.** The verdict is calibrated to the asker's likely situation, not a spec-sheet winner. K0154 (MacBook Air vs Pro): "The Air, unless you know you need the Pro." + the kicker "If you're asking, you're probably an Air person. The Pro is for people who already know why they need it." K0153 (Uber vs Lyft): "They're nearly identical — pick whichever is cheaper right now." — Muse refuses to manufacture a difference. K0168 (Android vs iPhone for privacy): verdict follows the *stated criterion* (privacy), not the general winner. K0175 (lease vs buy): verdict with the math qualifier. Every verdict is *owned* — no "it depends" without a decision attached.

Quoted Muse examples:
- K0151 (iPhone vs Pixel): "For most people, the iPhone — but it depends on what you value.\n• Camera: Pixel wins on computational photography, especially night shots; iPhone wins on video.\n• Ecosystem: iPhone if you own a Mac, AirPods, or Apple Watch — the integration is unmatched.\n• Price: Pixel gives you flagship features for hundreds less.\n• Updates: both get years of updates now, so that's a wash.\nPick the Pixel if you want the best photo value. Pick the iPhone if you're already in Apple's world."
- K0160 (PS5 vs Xbox): "PS5, for most gamers." + 4 bullets + "Get the PS5 for the exclusives. Get the Xbox if you want Game Pass value and play mostly multiplayer."
- K0161 (iPad vs laptop for college): "Laptop, no contest for college." — the strongest verdict language in the corpus ("no contest"), earning it: the bullets prove it.

**Predicted Ring pattern** for K0151 ("iPhone vs Pixel"):

> "That's a great question — both the iPhone and the Pixel are excellent flagship phones, and the best choice really depends on your priorities! Here's a detailed comparison:
> The iPhone offers seamless integration with the Apple ecosystem, excellent video recording capabilities, and premium build quality. iPhones also tend to hold their resale value well over time. On the other hand, the Pixel is known for its outstanding computational photography, especially in low-light conditions, and it typically costs several hundred dollars less than a comparable iPhone. The Pixel also offers a clean Android experience with timely updates directly from Google.
> In terms of ecosystem, if you already own a Mac, AirPods, or Apple Watch, the iPhone is probably the more convenient choice. However, if photography is your top priority and you want the best value for money, the Pixel is very compelling.
> Ultimately, both are fantastic devices and you really can't go wrong with either one. I'd suggest thinking carefully about which ecosystem you're more invested in and what features matter most to your daily usage!"

**Word count:** ~185 vs Muse's 71 (2.6×). Verdict: none — "you really can't go wrong with either one" is the opposite of a verdict.

#### Deep dive C-A/1 — K0151 "iPhone vs Pixel"

- **Input:** "iPhone vs Pixel"
- **Muse (71 words):** verdict "For most people, the iPhone — but it depends on what you value." + 4 bullets (Camera / Ecosystem / Price / Updates) + "Pick the Pixel if you want the best photo value. Pick the iPhone if you're already in Apple's world."
- **Predicted Ring (~185 words):** as above.
- **Word-by-word divergence:** Muse's first 9 words contain a decision; Ring's first 30 words contain none ("the best choice really depends on your priorities"). Muse's bullets each name a winner per dimension ("Pixel wins on computational photography"; "iPhone wins on video"); Ring's paragraphs describe both sides without declaring winners ("The iPhone offers… On the other hand, the Pixel is known for…"). Muse's close is two conditional imperatives ("Pick the Pixel if… Pick the iPhone if…"); Ring's close is "thinking carefully about which ecosystem you're more invested in" — homework instead of a recommendation.
- **Tone:** Muse is a decisive friend; Ring is a brochure.
- **Structure:** Muse = verdict → 4 bullets → conditional pick. Ring = hedge → prose paragraphs → hedge.
- **Tool selection:** N/A (knowledge question). Neither needs tools.
- **Error handling:** N/A.
- **Scores (predicted pre-fix):** Conciseness 10, Intelligence 21, Directness 13 (no verdict), Outcome 19 → **63/100**.
- **Exact gap:** 114 excess words; zero owned verdict; dimensions described but not decided; close delegates the decision back to the user.
- **Specific fix:** comparison template block in system prompt — verdict sentence + 4 bullets + conditional close (§10, Fix C1). 592e780 impact: none — no fix addresses comparison structure.

#### Deep dive C-A/2 — K0157 "Airbnb vs hotel"

- **Input:** "Airbnb vs hotel"
- **Muse (66 words):** "Hotel, for most trips." + bullets (Reliability / Space / Price / Experience) + "Pick Airbnb for a week with friends. Pick a hotel for anything under 4 nights."
- **Predicted Ring (~175 words):** meander with "it depends on the type of traveler you are", paragraphs on flexibility vs consistency, close: "consider what's most important for this particular trip".
- **Word-by-word divergence:** Muse's verdict is 4 words ("Hotel, for most trips."). Muse's Price bullet contains the non-obvious insight ("hotels are often cheaper now once Airbnb adds cleaning + service fees") — the kind of fact that justifies the verdict. Ring's predicted pattern recites the conventional wisdom (Airbnb = local experience, hotel = convenience) without the fee-math insight and without owning the "hotel for most trips" call. The closing "anything under 4 nights" rule is the memorable takeaway; Ring's close has no rule.
- **Scores:** Conciseness 10, Intelligence 20, Directness 13, Outcome 19 → **62/100**.
- **Exact gap:** verdict unowned; fee-math insight missing; no memorable rule.
- **Specific fix:** Fix C1 + "every comparison must contain one non-obvious deciding fact" (§10, Fix C2). 592e780 impact: none.

#### Deep dive C-A/3 — K0161 "iPad vs laptop for college"

- **Input:** "iPad vs laptop for college"
- **Muse (69 words):** "Laptop, no contest for college." + bullets (Software / Typing / Note-taking / Price) + "Get the laptop as your main machine. Add an iPad later only if you love handwritten notes."
- **Predicted Ring (~180 words):** both-sides: "the iPad with a keyboard can handle many college tasks… the laptop offers full desktop software… consider your major…" — predicted to hedge because the iPad *is* popular on campuses, so Ring's prior pulls toward false balance. Muse's "no contest" is the correct calibration: the question is asked by someone who doesn't know, and the answer is unambiguous.
- **Scores:** Conciseness 10, Intelligence 20, Directness 12 (false balance), Outcome 18 → **60/100**.
- **Exact gap:** false balance on a decided question; 111 excess words; the "nice-to-have" framing of Pencil note-taking (which defuses the main pro-iPad argument) missing.
- **Specific fix:** Fix C1 + "when the evidence is lopsided, say so — no false balance" (§10, Fix C3). 592e780 impact: none.

**Per-scenario gap table — C-A (K0151–K0180):**

| ID | Input | Predicted Ring pattern | C/I/D/O (pred) | Primary gap |
|---|---|---|---|---|
| K0151 | iPhone vs Pixel | hedge + prose, no verdict | 10/21/13/19 | verdict missing |
| K0152 | Netflix vs Hulu | meander; bundle insight buried | 11/21/14/19 | verdict soft |
| K0153 | Uber vs Lyft | manufactures differences | 11/20/14/18 | Muse says "nearly identical" |
| K0154 | MacBook Air vs Pro | hedge; "Air person" kicker lost | 10/21/13/19 | kicker missing |
| K0155 | Spotify vs Apple Music | meander | 11/21/14/19 | verdict soft |
| K0156 | Coke vs Pepsi | over-serious tasting notes | 12/20/14/18 | tone mismatch |
| K0157 | Airbnb vs hotel | meander; fee math missing | 10/20/13/19 | deciding fact missing |
| K0158 | Tesla vs Rivian | hedge; supercharger buried | 10/20/13/19 | killer advantage buried |
| K0159 | DoorDash vs Uber Eats | meander | 11/21/14/19 | verdict soft |
| K0160 | PS5 vs Xbox | false balance | 10/20/13/18 | verdict soft |
| K0161 | iPad vs laptop college | false balance | 10/20/12/18 | false balance |
| K0162 | Venmo vs Cash App | meander | 11/21/14/19 | verdict soft |
| K0163 | Gmail vs Outlook | meander | 11/21/14/19 | verdict soft |
| K0164 | Delta vs United | hedge; hub logic missing | 10/19/13/18 | deciding fact missing |
| K0165 | Chipotle vs Qdoba | over-analysis of burritos | 12/20/14/18 | tone/weight mismatch |
| K0166 | Kindle vs physical books | meander | 11/21/14/19 | verdict soft |
| K0167 | Nike vs Adidas running | generic; gait/goal missing | 10/20/13/18 | criterion ignored |
| K0168 | Android vs iPhone privacy | verdict follows criterion? predicted hedge | 10/20/12/18 | criterion not owned |
| K0169 | Costco vs Sam's Club | meander | 11/20/14/18 | verdict soft |
| K0170 | Dyson vs Shark vacuum | meander | 11/21/14/19 | verdict soft |
| K0171 | Robinhood vs Fidelity | hedge on a decided Q | 10/20/12/18 | false balance risk |
| K0172 | Peloton vs gym | meander | 11/21/14/19 | verdict soft |
| K0173 | Starbucks vs Dunkin | over-analysis | 12/20/14/18 | weight mismatch |
| K0174 | Walmart vs Target | meander | 11/21/14/19 | verdict soft |
| K0175 | Lease vs buy a car | math buried in prose | 10/20/13/18 | math not fronted |
| K0176 | iPhone 15 vs 16 | hedge; marginal-gains buried | 10/20/13/18 | verdict soft |
| K0177 | ChatGPT vs Claude | both-sides; no owned pick | 10/20/12/18 | false balance |
| K0178 | rent vs buy house now | hedge on rates math | 10/19/12/17 | math buried |
| K0179 | AirPods vs Sony earbuds | meander | 11/21/14/19 | verdict soft |
| K0180 | HelloFresh vs cooking | meander; cost math buried | 10/20/13/18 | math buried |

**C-A aggregate (predicted pre-fix):** Conciseness ~11/25, Intelligence ~20/25, Directness ~13/25, Outcome ~18/25 → **~62/100**. Directness is the crater: Ring describes, Muse decides.

---

### C-B: "X vs Y" long tail + "which is better" (K0181–K0210)

**Muse's pattern across all 30.** The template holds for lifestyle comparisons (K0181 Yeti vs Stanley through K0200 paper towels vs cloth rags) — verdict-first even for low-stakes items, which keeps the tone light rather than pompous. Then "which is better" K0201–K0210: same template, verdict phrased as the answer ("A no-annual-fee student card…" no — that's K0226; here e.g. K0206 Roth vs traditional: verdict + 4 bullets + close). The phrasing changes; the structure doesn't — that's the discipline.

Quoted Muse examples:
- K0184 (cruise vs all-inclusive): verdict + 4 bullets + conditional close (pattern holds for experiential comparisons).
- K0197 (whole life vs term life insurance): "Term, for almost everyone." — the rare near-absolute, with the math to back it.
- K0206 (Roth vs traditional IRA): verdict + bullets (tax-now-vs-later, income trajectory, employer match, flexibility) + close.

**Predicted Ring pattern.** Two predicted degradations specific to this band: (1) lifestyle items (Yeti vs Stanley, cold brew vs iced coffee) get *overweight* treatment — 150+ words of earnest analysis for a $45 cup; (2) "which is better" finance items (Roth vs traditional, 401k vs IRA later) get *underweight* verdicts — hedged because money feels high-stakes, exactly backwards from Muse.

#### Deep dive C-B/1 — K0197 "whole life vs term life insurance"

- **Input:** "whole life vs term life insurance"
- **Muse (est. 65 words):** "Term, for almost everyone." + bullets (Cost: term is 10–15× cheaper / Investing the difference wins / Whole life's "investment" underperforms / When whole life makes sense: estate planning) + close.
- **Predicted Ring (~190 words):** hedged both-sides — "whole life offers lifelong coverage and cash value… term offers affordable temporary coverage… the right choice depends on your financial goals, and it's worth speaking with a licensed financial advisor…" — the "talk to an advisor" punt replaces the verdict. Muse's "for almost everyone" is the honest industry consensus; Ring's predicted hedge is liability-flavored both-sidesism.
- **Scores:** Conciseness 10, Intelligence 19, Directness 11, Outcome 17 → **57/100**.
- **Exact gap:** consensus verdict ("term, for almost everyone") replaced by advisor punt; 125 excess words.
- **Specific fix:** Fix C1 + C3 (no false balance; advisor punt only where legally required, and even then give the consensus first). 592e780 impact: none.

#### Deep dive C-B/2 — K0206 "which is better, Roth IRA or traditional IRA"

- **Input:** "which is better, Roth IRA or traditional IRA"
- **Muse (~68 words):** verdict + 4 bullets + close with the income-trajectory rule.
- **Predicted Ring (~185 words):** explains both at length, hedges on "depends on your current vs future tax bracket", closes with "consider consulting a tax professional" — the tax-bracket framing is correct but the *decision rule* (young/lower-income → Roth; peak-earning → traditional) is buried in prose instead of fronted as the verdict.
- **Scores:** Conciseness 10, Intelligence 20, Directness 12, Outcome 18 → **60/100**.
- **Exact gap:** decision rule buried; verdict hedged.
- **Specific fix:** Fix C1. 592e780 impact: none.

#### Deep dive C-B/3 — K0181 "Yeti vs Stanley cup"

- **Input:** "Yeti vs Stanley cup"
- **Muse (~60 words):** light verdict + 4 quick bullets + close. Low-stakes item, light treatment.
- **Predicted Ring (~160 words):** earnest over-analysis — insulation specs, lid mechanisms, dishwasher safety, price-per-ounce — 160 words on a cup. The weight mismatch itself is the gap: Muse matches energy to stakes.
- **Scores:** Conciseness 11, Intelligence 21, Directness 14, Outcome 19 → **65/100** — highest in band; the failure is weight, not wrongness.
- **Exact gap:** 100 excess words on a $45 decision; no energy-matching.
- **Specific fix:** "match depth to stakes — $45 decisions get 60 words" (§10, Fix C4). 592e780 impact: none.

**Per-scenario gap table — C-B (K0181–K0210):** (compact; pattern = hedge + prose + soft verdict unless noted)

| ID | Input | C/I/D/O (pred) | Primary gap |
|---|---|---|---|
| K0181 | Yeti vs Stanley | 11/21/14/19 | overweight analysis |
| K0182 | Honda vs Toyota | 11/21/14/19 | verdict soft |
| K0183 | paper planner vs phone calendar | 11/20/14/18 | verdict soft |
| K0184 | cruise vs all-inclusive | 10/20/13/18 | verdict soft |
| K0185 | Pepsi vs Coke zero | 12/20/14/18 | weight mismatch |
| K0186 | public vs private college | 10/19/12/17 | math/ROI buried |
| K0187 | gas vs electric stove | 11/21/14/19 | verdict soft |
| K0188 | Kindle Paperwhite vs Oasis | 11/21/14/19 | verdict soft |
| K0189 | Zoom vs Google Meet | 11/21/14/19 | verdict soft |
| K0190 | running vs lifting | 10/20/13/18 | goal-criterion buried |
| K0191 | cash vs card budgeting | 10/20/13/18 | verdict soft |
| K0192 | iPhone Pro vs regular | 10/20/13/18 | $200 math buried |
| K0193 | tea vs coffee | 12/20/14/18 | weight mismatch |
| K0194 | apartment vs house first place | 10/19/12/17 | verdict soft |
| K0195 | Dell XPS vs ThinkPad | 11/21/14/19 | verdict soft |
| K0196 | HBO Max vs Disney+ | 11/21/14/19 | verdict soft |
| K0197 | whole vs term life insurance | 10/19/11/17 | advisor punt replaces verdict |
| K0198 | electric vs gas car | 10/20/13/18 | total-cost math buried |
| K0199 | cold brew vs iced coffee | 12/20/14/18 | weight mismatch |
| K0200 | paper towels vs cloth rags | 12/20/14/18 | weight mismatch |
| K0201 | which credit card for travel | 10/20/13/18 | pick not owned |
| K0202 | standing vs treadmill desk | 11/21/14/19 | verdict soft |
| K0203 | Verizon vs AT&T carrier | 10/19/13/18 | coverage-criterion buried |
| K0204 | yoga vs pilates beginners | 11/21/14/19 | verdict soft |
| K0205 | laptop for video editing <$1500 | 10/20/13/18 | pick not owned |
| K0206 | Roth vs traditional IRA | 10/20/12/18 | decision rule buried |
| K0207 | streaming service for movies | 11/21/14/19 | verdict soft |
| K0208 | QuickBooks vs Wave small biz | 10/20/13/18 | verdict soft |
| K0209 | memory foam vs hybrid mattress | 11/21/14/19 | verdict soft |
| K0210 | Duolingo vs tutor Spanish | 10/20/13/18 | verdict soft |

**C-B aggregate (predicted pre-fix):** Conciseness ~11/25, Intelligence ~20/25, Directness ~13/25, Outcome ~18/25 → **~62/100**. Same signature as C-A: directness crater.

---

### C-C: "which is better" + "should I" (K0211–K0240)

**Muse's pattern across all 30.** "Which is better" K0211–K0215 + K0236–K0245: same verdict-first template. Note K0236 (401k or IRA): "Both — in this order." — Muse refuses the binary when the real answer is a sequence, and the close makes it memorable ("The order matters more than the choice"). "Should I" K0216–K0235: verdict phrased as advice with a condition ("Yes, if coverage is good where you live." / "Delete the apps, keep the accounts."). The K0235 verdict is a *reframe* — neither yes nor no to the literal question, but the better answer. K0226 (credit card at 19): "Yes — a student card, used carefully." + the rule + the exact play ("Get one, put one small recurring bill on it, autopay in full. That's it.").

Quoted Muse examples:
- K0216 (switch to T-Mobile): "Yes, if coverage is good where you live.\n• Price: T-Mobile is meaningfully cheaper than Verizon/AT&T for comparable plans.\n• 5G: their mid-band 5G is the fastest widely available in the US.\n• Coverage: the gap — check their map for your specific address and commute.\n• Perks: Netflix and other bundles sweeten the deal.\nCheck the coverage map for your home and workplace first. If it's solid, switch and save."
- K0228 (pay off debt or invest): "Pay off high-interest debt first, invest alongside low-interest debt.\n• The line: debt above ~7% interest — pay it off before investing.\n• Below that: invest, since markets historically beat it.\n• 401k match: always grab the full employer match first — it's a 100% return.\n• Psychology: being debt-free has value beyond the math.\nKill credit cards today. Fund the 401k match. Then split extra cash between the rest."
- K0235 (delete social media): "Delete the apps, keep the accounts." — 6-word verdict that reframes the question.

**Predicted Ring pattern.** "Should I" is where Ring's hedging is most costly, because the user is asking for *permission/decision* and Ring's predicted pattern returns the decision to them ("only you can decide what's right for your situation"). K0232 (learn to code in 2026) is the flagship risk: Muse says "Yes — but learn to build, not just to code" with the honest job-market caveat; Ring's predicted pattern either hype-answers ("Absolutely! Coding is the future!") or hedges — both miss Muse's calibrated yes-with-caveats.

#### Deep dive C-C/1 — K0232 "should i learn to code in 2026"

- **Input:** "should i learn to code in 2026"
- **Muse (72 words):** "Yes — but learn to build, not just to code.\n• AI leverage: coding + AI tools makes one person wildly productive.\n• Job market: pure junior dev roles are tougher; builders who ship are in demand.\n• Time: 6-12 months of consistent practice to be useful.\n• Alternative: if you hate it after a month, quit — not everyone needs to code.\nStart with Python and build one real project. If you enjoy the building, keep going."
- **Predicted Ring (~190 words):** "Learning to code in 2026 can be a great decision! With AI tools becoming more prevalent, coding skills are more valuable than ever… Here are some things to consider: the tech job market, your interests, the time commitment… Python and JavaScript are popular starting languages… There are many free resources available… Ultimately, whether you should learn to code depends on your career goals and interests…"
- **Word-by-word divergence:** Muse's verdict is 8 words with a reframe ("learn to build, not just to code") — it updates the question for the AI era. The "Alternative" bullet ("if you hate it after a month, quit") is anti-guru honesty no hedged answer includes. Ring's predicted pattern gives the 2021-era answer (learn Python, free resources!) without the 2026-specific calibration (junior dev market is tougher; the leverage is coding+AI). 118 excess words, zero 2026-specificity.
- **Scores:** Conciseness 10, Intelligence 19 (dated framing), Directness 13, Outcome 18 → **60/100**.
- **Exact gap:** verdict unowned; era-specific calibration missing; "quit if you hate it" honesty missing.
- **Specific fix:** Fix C1 + "answer for the current year, not the generic year" (§10, Fix C5). 592e780 impact: none.

#### Deep dive C-C/2 — K0228 "should i pay off debt or invest"

- **Input:** "should i pay off debt or invest"
- **Muse (66 words):** "Pay off high-interest debt first, invest alongside low-interest debt." + bullets (the ~7% line / below-that-invest / 401k match first / psychology) + "Kill credit cards today. Fund the 401k match. Then split extra cash between the rest."
- **Predicted Ring (~185 words):** explains both, hedges ("depends on your interest rates, risk tolerance, and financial situation"), closes with "consider speaking with a financial advisor" — the ~7% rule and the match-first ordering (the two actionable numbers) buried or absent.
- **Word-by-word divergence:** Muse's verdict contains the decision *and* the split ("first… alongside"). The "7%" number is the memorable rule; "it's a 100% return" makes the match unskippable; "Kill credit cards today" is an imperative close. Ring's predicted pattern has no numbers and no imperatives.
- **Scores:** Conciseness 10, Intelligence 19, Directness 12, Outcome 17 → **58/100**.
- **Exact gap:** the two numbers that make the answer actionable (~7%, 100% match) missing; advisor punt.
- **Specific fix:** Fix C1 + "every money answer needs its numbers" (§10, Fix C2). 592e780 impact: none.

#### Deep dive C-C/3 — K0235 "should I delete social media"

- **Input:** "should I delete social media"
- **Muse (62 words):** "Delete the apps, keep the accounts." + bullets (2+ hours/day back / FOMO fades in two weeks / keep messaging / nuclear option) + "Try 30 days app-free first. Most people never go back to daily scrolling."
- **Predicted Ring (~180 words):** lists pros and cons of deleting social media, hedges ("it's a personal decision"), suggests "digital detox" — the reframe ("delete the apps, keep the accounts") is the entire value and Ring's predicted pattern misses it, answering the literal question instead of the better question.
- **Scores:** Conciseness 10, Intelligence 19, Directness 13, Outcome 18 → **60/100**.
- **Exact gap:** reframe missing; 118 excess words; the "2+ hours" and "two weeks" specifics missing.
- **Specific fix:** Fix C1 + "prefer the reframe when the literal question has a better answer" (§10, Fix C5). 592e780 impact: none.

**Per-scenario gap table — C-C (K0211–K0240):**

| ID | Input | C/I/D/O (pred) | Primary gap |
|---|---|---|---|
| K0211 | which bank for students | 11/20/14/18 | "credit union, honestly" kicker lost |
| K0212 | Kindle Unlimited vs buying | 11/21/14/19 | verdict soft |
| K0213 | Notion vs Asana | 11/21/14/19 | verdict soft |
| K0214 | Ring vs SimpliSafe | 10/19/13/18 | verdict soft |
| K0215 | Airbnb vs Vrbo families | 11/21/14/19 | verdict soft |
| K0216 | switch to T-Mobile | 10/20/13/18 | coverage-condition buried |
| K0217 | buy or lease | 10/20/13/18 | math buried |
| K0218 | get a dog | 11/20/14/17 | lifestyle Q; verdict soft |
| K0219 | refinance mortgage | 10/19/12/17 | breakeven math buried |
| K0220 | quit job to freelance | 10/19/12/17 | runway rule buried |
| K0221 | solar panels | 10/20/13/18 | payback math buried |
| K0222 | extended warranty | 10/20/13/18 | expected-value framing lost |
| K0223 | masters degree | 10/19/12/17 | ROI framing buried |
| K0224 | sell car, uber everywhere | 10/20/13/18 | breakeven math buried |
| K0225 | buy house now or wait | 10/19/12/17 | verdict hedged |
| K0226 | credit card at 19 | 10/20/13/18 | exact play ("one bill, autopay") lost |
| K0227 | take the new job offer | 10/19/13/17 | decision frame buried |
| K0228 | pay debt or invest | 10/19/12/17 | 7% rule + match-first lost |
| K0229 | gym vs home workouts | 11/21/14/19 | verdict soft |
| K0230 | upgrade phone this year | 10/20/13/18 | verdict soft |
| K0231 | move city for work | 10/19/12/17 | decision frame buried |
| K0232 | learn to code in 2026 | 10/19/13/18 | era calibration missing |
| K0233 | buy crypto | 10/18/12/17 | position-sizing rule buried |
| K0234 | get a roommate | 11/20/14/18 | verdict soft |
| K0235 | delete social media | 10/19/13/18 | reframe missing |
| K0236 | 401k or IRA | 10/20/13/18 | "both, in this order" lost |
| K0237 | Zyrtec vs Claritin | 11/21/14/19 | verdict soft |
| K0238 | TurboTax vs H&R Block | 11/21/14/19 | verdict soft |
| K0239 | Apple Notes vs Evernote | 11/21/14/19 | verdict soft |
| K0240 | OLED vs QLED tv | 11/21/14/19 | verdict soft |

**C-C aggregate (predicted pre-fix):** Conciseness ~10.5/25, Intelligence ~20/25, Directness ~13/25, Outcome ~18/25 → **~61.5/100**. "Should I" money/career items (K0219–K0228) score lowest on directness — Ring hedges hardest where stakes are highest.

---

### C-D: "should I" + "is X worth it" (K0241–K0270)

**Muse's pattern across all 30.** "Which is better" K0241–K0245 continue the template (K0245 HYSA vs CDs: "HYSA, for flexibility."). Then "is X worth it" K0255–K0270: the verdict is a price-anchored yes/no — "Yes — it's the best $78 in travel." (K0255), "Yes — it's the highest-ROI habit for busy people." (K0270), "Yes — it's the best $30 bathroom upgrade." (K0268). The pattern: **verdict + the price + the one-line reason**, then 4 bullets, then the exact next action ("Apply online, do the 10-minute in-person appointment…"). The "Only skip if" bullet (K0255: "Only skip if: you fly less than once a year") is the honest exception that makes the yes trustworthy.

Quoted Muse examples:
- K0255 (TSA PreCheck): "Yes — it's the best $78 in travel.\n• 5 years of shorter lines for less than one airport meal per year.\n• Shoes stay on, laptop stays in — the experience is just calmer.\n• Kids under 12 go through with you free.\n• Only skip if: you fly less than once a year.\nApply online, do the 10-minute in-person appointment, and never stand in the long line again."
- K0270 (meal prepping): "Yes — it's the highest-ROI habit for busy people.\n• Money: cuts food spending 30-50%.\n• Health: you eat what you planned, not what you're craving at 8pm.\n• Time: 2 hours Sunday saves 5+ hours of weeknight cooking and deciding.\n• Start small: prep just lunches for the first two weeks.\nThe Sunday session feels like a chore until week 3. Then it feels like freedom."
- K0249 (iPhone Pro or save $200): "Save the $200.\n• What you get: slightly better camera zoom, 120Hz screen, a bit more battery.\n• What you lose: $200 that could go to savings, accessories, or literally anything else.\n• Notice: most people stop noticing the Pro differences within a month.\n• Exception: heavy mobile photographers should get the Pro.\nUnless you zoom constantly or keep phones 4+ years, the regular iPhone is the smart buy."

**Predicted Ring pattern.** "Is X worth it" is structurally hostile to hedging — the question demands yes/no — so Ring's predicted failure mode shifts: instead of hedging, it *over-answers*, giving 180-word cost-benefit analyses where Muse gives a price-anchored verdict. K0268 (bidet): Muse's "it's the best $30 bathroom upgrade" + "Get the $35 attachment. You'll wonder why you waited." is 62 words of conviction; Ring's predicted pattern gives a hygiene lecture.

#### Deep dive C-D/1 — K0255 "is TSA PreCheck worth it"

- **Input:** "is TSA PreCheck worth it"
- **Muse (69 words):** "Yes — it's the best $78 in travel." + 4 bullets + "Apply online, do the 10-minute in-person appointment, and never stand in the long line again."
- **Predicted Ring (~175 words):** "TSA PreCheck can definitely be worth it for frequent travelers! For $78 (as of recent pricing), you get 5 years of expedited security screening… Benefits include shorter lines, keeping shoes on… However, if you rarely fly, it may not be worth the cost and the in-person appointment hassle… Some credit cards reimburse the fee… Consider your travel frequency…"
- **Word-by-word divergence:** Muse's verdict is 7 words with the price embedded ("the best $78 in travel" — the price IS the argument). The "less than one airport meal per year" reframe makes $78 feel trivial. Ring's predicted pattern states the price but never reframes it, lists benefits generically, and the "Only skip if you fly less than once a year" exception — which is what makes the yes credible — is diluted into "if you rarely fly, it may not be worth it". Muse's close is an imperative with the exact steps; Ring's close is "consider your travel frequency" — homework.
- **Scores:** Conciseness 10, Intelligence 20, Directness 14, Outcome 18 → **62/100**.
- **Exact gap:** price reframe missing; exception diluted; imperative close replaced by homework; 106 excess words.
- **Specific fix:** Fix C1 + "worth-it answers: verdict + price + reframe + the skip condition" (§10, Fix C6). 592e780 impact: none.

#### Deep dive C-D/2 — K0268 "is a bidet worth it"

- **Input:** "is a bidet worth it"
- **Muse (62 words):** "Yes — it's the best $30 bathroom upgrade." + 4 bullets + "Get the $35 attachment. You'll wonder why you waited."
- **Predicted Ring (~170 words):** earnest hygiene/cost/environmental analysis, hedged close ("if you're curious, they're inexpensive to try") — the conviction ("You'll wonder why you waited") replaced by permission.
- **Scores:** Conciseness 10, Intelligence 20, Directness 13, Outcome 18 → **61/100**.
- **Exact gap:** conviction → permission; 108 excess words; the $35 exact recommendation missing.
- **Specific fix:** Fix C1 + C6. 592e780 impact: none.

#### Deep dive C-D/3 — K0249 "should I buy the iPhone Pro or save the $200"

- **Input:** "should I buy the iPhone Pro or save the $200"
- **Muse (71 words):** "Save the $200." + bullets (what you get / what you lose / notice / exception) + "Unless you zoom constantly or keep phones 4+ years, the regular iPhone is the smart buy."
- **Predicted Ring (~180 words):** spec comparison of Pro vs base, hedged close ("depends on whether you value the camera and display upgrades") — the question is literally "save the $200?", Muse answers "Save the $200." in 3 words; Ring's predicted pattern won't say it.
- **Word-by-word divergence:** Muse's bullet "What you lose: $200 that could go to savings, accessories, or literally anything else" reframes the $200 as *money*, not specs. "most people stop noticing the Pro differences within a month" is the killer empirical claim. Ring's predicted pattern compares spec sheets — answering a different question than asked.
- **Scores:** Conciseness 10, Intelligence 20, Directness 12, Outcome 18 → **60/100**.
- **Exact gap:** the 3-word verdict never uttered; opportunity-cost framing missing; 109 excess words.
- **Specific fix:** Fix C1. 592e780 impact: none.

**Per-scenario gap table — C-D (K0241–K0270):**

| ID | Input | C/I/D/O (pred) | Primary gap |
|---|---|---|---|
| K0241 | Strava vs Nike Run Club | 11/21/14/19 | verdict soft |
| K0242 | dishwasher pods vs liquid | 11/21/14/19 | verdict soft |
| K0243 | laptop cam vs webcam | 11/21/14/19 | verdict soft |
| K0244 | manual vs electric toothbrush | 11/21/14/19 | verdict soft |
| K0245 | HYSA vs CDs | 10/20/13/18 | "for flexibility" qualifier lost |
| K0246 | electric bike | 10/20/13/18 | verdict soft |
| K0247 | second monitor | 10/20/13/18 | verdict soft |
| K0248 | side hustle | 10/19/13/17 | verdict soft |
| K0249 | iPhone Pro or save $200 | 10/20/12/18 | 3-word verdict never uttered |
| K0250 | water filter vs bottled | 10/20/13/18 | math buried |
| K0251 | personal trainer | 10/20/13/18 | verdict soft |
| K0252 | negotiate salary | 10/19/12/17 | script/number missing |
| K0253 | mac vs windows programming | 10/20/13/18 | verdict soft |
| K0254 | TSA PreCheck (should-I form) | 10/20/13/18 | price reframe missing |
| K0255 | is TSA PreCheck worth it | 10/20/14/18 | reframe + skip-if diluted |
| K0256 | is the Pro worth $200 more | 10/20/12/18 | "No, for most buyers" softened |
| K0257 | costco membership worth it | 10/20/13/18 | breakeven math buried |
| K0258 | applecare worth it | 10/20/13/18 | verdict soft |
| K0259 | kindle worth it with ipad | 11/21/14/19 | verdict soft |
| K0260 | hello fresh worth it | 10/20/13/18 | cost math buried |
| K0261 | standing desk worth it | 11/21/14/19 | verdict soft |
| K0262 | gym vs home workouts | 11/21/14/19 | verdict soft |
| K0263 | business class long flights | 10/20/13/18 | verdict soft |
| K0264 | expensive mattress worth it | 10/20/13/18 | verdict soft |
| K0265 | disney+ worth it no kids | 10/20/13/18 | verdict soft |
| K0266 | smartwatch worth it | 11/21/14/19 | verdict soft |
| K0267 | organic food worth cost | 10/19/12/17 | verdict soft |
| K0268 | bidet worth it | 10/20/13/18 | conviction → permission |
| K0269 | noise cancelling worth it | 11/21/14/19 | verdict soft |
| K0270 | meal prepping worth it | 10/20/13/18 | ROI numbers buried |

**C-D aggregate (predicted pre-fix):** Conciseness ~10.5/25, Intelligence ~20/25, Directness ~13/25, Outcome ~18/25 → **~61.5/100**. "Worth it" items score slightly better on directness than "should I" (the question forces a yes/no) but Ring still buries the price reframe that makes Muse's answers memorable.

---

### C-E: "is X worth it" (cont.) + "should I" finale (K0271–K0300)

**Muse's pattern across all 30.** Worth-it K0271–K0279 + K0296–K0300 continue the price-anchored verdict pattern. K0274 (Uber One): "Yes, if you order delivery or ride 2+ times a month." + the math ("$10/month — one order's worth of fees covers it") + "Do the math on your last month of orders. If fees topped $10, subscribe." — the close tells the user exactly how to verify. K0297 (pet insurance): "Yes, for puppies, kittens, and accident-prone breeds." + "Enroll in the first year." K0300 (grad school): "Only if the salary bump pays the debt in under 5 years." + the math ("$100k debt needs ~$25k/year") + "Prestige debt: the most expensive mistake — the name fades, the loans don't." Then should-I K0280–K0295: K0280 (new vs used car): "Used — 2-3 years old is the sweet spot." + depreciation math + "Pocket the $10,000 difference." K0286 (stocks vs index funds): "Index funds, for 95% of people." + "Put 95% in a total-market index fund." K0290 (lasik): "Yes, if you're a good candidate and hate glasses/contacts." + candidacy/cost/risk/age + "Get the consultation — it's usually free."

Quoted Muse examples:
- K0280: "Used — 2-3 years old is the sweet spot.\n• Depreciation: new cars lose 20-30% in the first 3 years; let someone else eat that.\n• Reliability: a 3-year-old Toyota or Honda has decades of life left.\n• Warranty: many are still under factory warranty.\n• New wins if: you need specific safety tech or plan to keep it 10+ years.\nBuy the 3-year-old version of the car you want. Pocket the $10,000 difference."
- K0286: "Index funds, for 95% of people.\n• Diversification: one fund holds thousands of companies.\n• Time: stock-picking is a part-time job; index funds are set-and-forget.\n• Returns: most professional fund managers lose to index funds.\n• Fun money: keep 5% for individual stocks if you enjoy it.\nPut 95% in a total-market index fund. Play with 5% if stock-picking entertains you."
- K0300: "Only if the salary bump pays the debt in under 5 years.\n• Math: $100k debt needs ~$25k/year in extra salary to make sense.\n• Funded programs: PhDs and some master's are free — those are always worth considering.\n• Employer-paid: changes everything; do it.\n• Prestige debt: the most expensive mistake — the name fades, the loans don't.\nRun the numbers for your specific field. If the payback is over 7 years, it's a no."

**Predicted Ring pattern.** The finale band contains the highest-stakes questions (debt consolidation, financial advisor, grad school debt, lasik, pet insurance) — where Muse is most numeric and most willing to say no. Ring's predicted pattern hedges hardest here ("this is a big decision", "consider your circumstances", advisor punts). K0300 is the flagship: Muse's "Prestige debt: the most expensive mistake — the name fades, the loans don't" is a line with a point of view; Ring's predicted pattern would never write it.

#### Deep dive C-E/1 — K0300 "is grad school worth the debt"

- **Input:** "is grad school worth the debt"
- **Muse (71 words):** "Only if the salary bump pays the debt in under 5 years." + 4 bullets + "Run the numbers for your specific field. If the payback is over 7 years, it's a no."
- **Predicted Ring (~200 words):** "This is a big financial decision that depends on many factors — your field, the program's cost, your career goals… Graduate school can increase earning potential… However, student debt is a serious commitment… Consider: the ROI of your specific degree, whether you can get employer funding, funded PhD options… It's often wise to speak with a financial advisor…"
- **Word-by-word divergence:** Muse's verdict is a *rule* ("pays the debt in under 5 years") with a *number* ("$100k debt needs ~$25k/year"). The "Prestige debt" bullet is a point of view — it takes a side against a culturally-loaded mistake. Ring's predicted pattern has no rule, no numbers, and the advisor punt. "It's a no" (Muse's close) vs "depends on many factors" (Ring's whole answer).
- **Scores:** Conciseness 9, Intelligence 19, Directness 11, Outcome 17 → **56/100** — lowest in C-E.
- **Exact gap:** the 5-year rule and $25k number missing; point-of-view bullet missing; 129 excess words.
- **Specific fix:** Fix C1 + C2 (numbers) + C3 (take the side). 592e780 impact: none.

#### Deep dive C-E/2 — K0286 "should i buy stocks or index funds"

- **Input:** "should i buy stocks or index funds"
- **Muse (66 words):** "Index funds, for 95% of people." + bullets + "Put 95% in a total-market index fund. Play with 5% if stock-picking entertains you."
- **Predicted Ring (~190 words):** explains both, hedges on risk tolerance, "consider your goals", advisor punt — the "95%" number (which makes the verdict feel empirical rather than opinionated) and the "fun money 5%" permission structure missing.
- **Scores:** Conciseness 10, Intelligence 19, Directness 12, Outcome 17 → **58/100**.
- **Exact gap:** the 95%/5% split — the entire actionable content — missing; 124 excess words.
- **Specific fix:** Fix C1 + C2. 592e780 impact: none.

#### Deep dive C-E/3 — K0290 "should i get lasik"

- **Input:** "should i get lasik"
- **Muse (70 words):** "Yes, if you're a good candidate and hate glasses/contacts." + bullets (candidacy / cost / risk / age) + "Get the consultation — it's usually free. If you're a candidate, it's life-changing for most people."
- **Predicted Ring (~185 words):** procedure explanation, hedged ("many people are happy with the results, but it's important to…"), "consult with an ophthalmologist" — the candidacy criteria (stable 2+ years, cornea thickness), the breakeven math (~5 years vs contacts), and the "consultation is usually free" nudge (which removes the action barrier) all missing or buried.
- **Scores:** Conciseness 10, Intelligence 20, Directness 13, Outcome 18 → **61/100**.
- **Exact gap:** candidacy criteria + breakeven math + free-consultation nudge missing; 115 excess words.
- **Specific fix:** Fix C1 + C2. 592e780 impact: none.

**Per-scenario gap table — C-E (K0271–K0300):**

| ID | Input | C/I/D/O (pred) | Primary gap |
|---|---|---|---|
| K0271 | robot vacuum worth it | 11/21/14/19 | verdict soft |
| K0272 | linkedin premium worth it | 10/20/13/18 | verdict soft |
| K0273 | macbook worth it student | 10/20/13/18 | verdict soft |
| K0274 | uber one worth it | 10/20/13/18 | $10 math buried |
| K0275 | dash cam worth it | 11/21/14/19 | verdict soft |
| K0276 | premium gas worth it | 10/20/13/18 | verdict soft |
| K0277 | water softener worth it | 10/19/13/18 | verdict soft |
| K0278 | travel insurance worth it | 10/20/13/18 | verdict soft |
| K0279 | air fryer worth it | 11/21/14/19 | verdict soft |
| K0280 | new vs used car | 10/20/13/18 | $10k pocket framing lost |
| K0281 | consolidate debt | 10/19/12/17 | math buried |
| K0282 | financial advisor | 10/19/12/17 | fee-only rule buried |
| K0283 | condo vs house | 10/19/12/17 | verdict soft |
| K0284 | switch banks | 11/21/14/19 | verdict soft |
| K0285 | gap year | 10/19/12/17 | verdict soft |
| K0286 | stocks vs index funds | 10/19/12/17 | 95%/5% split missing |
| K0287 | cat vs dog | 11/20/14/17 | lifestyle; verdict soft |
| K0288 | doordash as side gig | 10/20/13/18 | hourly-math buried |
| K0289 | warranty on used car | 10/20/13/18 | expected-value lost |
| K0290 | lasik | 10/20/13/18 | candidacy + breakeven buried |
| K0291 | move in with partner | 10/19/12/17 | decision frame buried |
| K0292 | treadmill | 11/21/14/19 | verdict soft |
| K0293 | costco executive membership | 10/20/13/18 | breakeven math buried |
| K0294 | spanish or french | 11/21/14/19 | verdict soft |
| K0295 | ipad for kid | 10/20/13/18 | verdict soft |
| K0296 | home warranty worth it | 10/19/12/17 | verdict soft |
| K0297 | pet insurance worth it | 10/20/13/18 | enroll-early rule buried |
| K0298 | VPN worth it | 10/20/13/18 | threat-model framing lost |
| K0299 | cleaning service worth it | 10/20/13/18 | hourly-rate math buried |
| K0300 | grad school worth the debt | 9/19/11/17 | 5-year rule + numbers missing |

**C-E aggregate (predicted pre-fix):** Conciseness ~10.5/25, Intelligence ~19.5/25, Directness ~13/25, Outcome ~18/25 → **~61/100**. Money/health high-stakes items cluster at directness 11–12 — Ring's hedge reflex is strongest where conviction matters most.

---

## Comparison aggregate: verdict-first discipline, quantified

| Metric | Muse (measured, n=150) | Ring predicted pre-fix (n=150) |
|---|---|---|
| Avg words/response | 66.1 (range 52–85) | ~175 (range ~140–210) |
| First-line verdict present | 150/150 (avg 6.5 words) | ~30/150 (usually hedged) |
| `•` bullets (4, dimension + winner) | 150/150 | ~40/150 (prose instead) |
| Conditional closing recommendation | 150/150 | ~50/150 (hedged close) |
| Concrete numbers in answer | ~120/150 | ~40/150 |
| "it depends" / "only you can decide" | 0 | ~100/150 |

**Predicted comparisons overall (pre-fix):** Conciseness ~10.5/25, Intelligence ~20/25, Directness ~13/25, Outcome ~18/25 → **~61.5/100**. Post-592e780 projection: the 14 fixes barely touch comparisons (banned words remove a little throat-clearing; nothing installs the template) → **~63/100**. The remaining ~37 points need the comparison template (§10, Fix C1–C6).

**Whole-corpus prediction (pre-fix):** troubleshooting ~58.5 + comparisons ~61.5 → **~60/100 overall**, with conciseness the crater in both halves (~9.5/25 avg) and directness second (~13.5/25 avg).

---

## TOP 15 biggest gaps (before/after with word counts)

Ranked by predicted pre-fix score (lowest first). "Before" = predicted pre-fix Ring; "After" = target Muse-style rewrite.

**1. K0069 "blue screen of death help" — 48/100.** Before (~160 words): hex-code lecture ("technically known as a STOP error with codes like 0x0000007B") + 8-step list ending in "reinstall Windows". After (32 words, Muse verbatim): "What did the error code say at the bottom — something like CRITICAL_PROCESS_DIED? That tells us if it's a driver or hardware. Also, did it happen after an update?" Gap: code exposure + nuclear escalation → two routing questions.

**2. K0081 "wifi not working on my phone only" — 53/100.** Before (~140 words): "restart your router" as step 1 — disrupts the whole household for a single-device issue the user already scoped. After (28 words): "If every other device is fine, forget the network on your phone (Settings > Wi-Fi > tap the i > Forget) and rejoin it. Did it connect this time?" Gap: scope ignored → scope honored.

**3. K0036 "my screen is zoomed in and i cant get it back" — 54/100.** Before (~135 words): 7-step list including "Reset all settings" for a 5-second fix. After (28 words): "You triggered zoom accidentally. Double-tap with three fingers to zoom back out, then turn it off in Settings > Accessibility > Zoom so it doesn't happen again." Gap: destructive escalation → diagnosis + fix + prevention.

**4. K0107 "zelle sent money to the wrong person" — 55/100.** Before (~150 words): dilatory list with "file a dispute" (false hope — authorized mis-sends rarely reverse). After (37 words): "Act fast: if they're not enrolled in Zelle, you can cancel it in your bank's app under Zelle activity. If they're enrolled, the money's gone — you'll have to ask them to send it back." Gap: urgency flattened → urgency + the one branching fact + honest odds.

**5. K0097 "battery draining fast since yesterday" — 55/100.** Before (~140 words): generic battery-hygiene list ending in "Reset all settings". After (33 words): "Go to Settings > Battery and look at the last 24 hours — which app is at the top? One rogue app update is usually the cause, and we can deal with it once we know which." Gap: "since yesterday" (sudden onset → rogue app) ignored → temporal clue read, user sent to the data.

**6. K0008 "two factor code isnt coming thru. checked spam" — 56/100.** Before (~130 words): list starting with "check your spam folder" — the user already did. After (30 words): "Is it supposed to come by SMS or an authenticator app? If SMS, check if you can receive other texts right now — sometimes it's a carrier delay, not the app." Gap: ruled-out step repeated → ruled-out step honored, routing question asked.

**7. K0063 "captcha keeps failing even when i do it right" — 56/100.** Before (~130 words): "make sure you're selecting the correct images" — re-litigates the user's asserted competence. After (29 words): "Try a different browser or an incognito window — extensions often break captchas. Also make sure you're not on a VPN, which gets flagged constantly." Gap: competence insult → causal mechanism (extensions, VPN).

**8. K0113 "laptop battery dies in like an hour" — 56/100.** Before (~130 words): consumption-reduction list for what is likely a worn battery. After (29 words): "Check the battery health: on Mac it's System Settings > Battery > the (i) icon; on Windows run 'powercfg /batteryreport'. What's the max capacity showing?" Gap: capacity/consumption conflated → the one measurement requested.

**9. K0300 "is grad school worth the debt" — 56/100.** Before (~200 words): "big decision… depends on many factors… speak with a financial advisor". After (71 words): "Only if the salary bump pays the debt in under 5 years." + "$100k debt needs ~$25k/year" + "Prestige debt: the most expensive mistake — the name fades, the loans don't." Gap: no rule, no numbers, no point of view → rule + numbers + a side taken.

**10. K0124 "my emails are going to spam" — 55/100.** Before (~135 words): deliverability checklist that assumes one reading. After (~30 words): "Are YOUR sent emails landing in other people's spam, or are you getting spam? If it's your emails landing in spam, your domain's SPF/DKIM records are probably missing — check with your email host." Gap: ambiguous input answered without disambiguating → the one question that splits two opposite fixes.

**11. K0142 "my password manager locked me out" — 57/100.** Before (~140 words): recovery checklist implying recovery is likely. After (~32 words): "Do you have your recovery key or emergency kit saved somewhere? Without it, most password managers can't help — that's by design. Check if you saved the emergency PDF when you set it up." Gap: false hope → honest limits stated ("that's by design").

**12. K0054 "500 internal server error, is that my fault?" — 58/100.** Before (~120 words): code definition + user homework (clear cache, try browsers) for a server-side fault. After (30 words): "Not your fault at all — that's the website's server breaking, not your device. Wait 15-20 minutes and retry. If it's still down, it needs their engineers, not you." Gap: absolution missing, user given work for others' fault → emotional question answered first.

**13. K0197 "whole life vs term life insurance" — 57/100.** Before (~190 words): both-sides + "speak with a licensed financial advisor" punt. After (~65 words): "Term, for almost everyone." + cost/investing bullets + the estate-planning exception. Gap: industry-consensus verdict replaced by liability-flavored hedge → verdict owned.

**14. K0228 "should i pay off debt or invest" — 58/100.** Before (~185 words): hedged explanation, no numbers. After (66 words): "Pay off high-interest debt first, invest alongside low-interest debt." + the ~7% line + "always grab the full employer match first — it's a 100% return" + "Kill credit cards today." Gap: no actionable numbers → two numbers and an imperative close.

**15. K0137 "cant delete apps on iphone" — 57/100.** Before (~120 words): 7-step list (restart, update iOS, check storage…) for a single Screen Time toggle. After (30 words): "That's a Screen Time restriction. Go to Settings > Screen Time > Content & Privacy Restrictions > iTunes & App Store Purchases > Deleting Apps — set it to Allow." Gap: the purest step-dump absurdity — one toggle, seven steps.

**Pattern across the 15:** 9 of 15 are troubleshooting (step-dump family), 6 are comparisons (verdict family). In 12 of 15, Ring's predicted response *contains* the right answer buried at position 3–7 — the gap is ranking and restraint, not knowledge. Total words before: ~2,200. Total after: ~620. The fix is deletion and ordering, not new knowledge.

---

## The step-dump problem: why Ring lists 10 steps and how to enforce one-at-a-time

**Root cause (code-level).** `~/workspace/ring/backend/lib/agent.js`, `SYSTEM_PROMPT`, line ~1200:

```
- For multi-step tasks, list the steps numbered. Keep each step to one line.
```

This single line is the engine of the step-dump. The model reads it as the default format for anything multi-step — and troubleshooting is *always* multi-step in the model's ontology (diagnose → fix → verify). The 14 fixes in 592e780 added banned words ("staged", "proceed with"…), one-clause replies, and reply budgets — but **none of them revoked or amended this line**. So the model now writes shorter *steps* in its 10-step lists (one-clause), but still writes the 10-step list. Post-fix projection for troubleshooting conciseness: ~11–12/25, not the ~20+ the program needs. The line must be replaced, not supplemented.

**Contributing causes.**

1. *Training prior:* the base model's "helpful tech support" pattern is the blog/wikiHow format — enumerate every possible fix so the user can self-serve. Muse's reference responses demonstrate the opposite professional format: the *technician* format (triage → one intervention → check-in). The system prompt must explicitly install the technician format, because the prior won't yield it spontaneously.
2. *No check-in habit:* Muse ends 43% of troubleshooting replies with a question ("Did it come back?", "Which one?"). The check-in is what *licenses* the one-step approach — you can afford to give one step because you're asking what happened. Ring's predicted pattern ends with "Let me know if this works!" — a pleasantry, not a diagnostic question. Without the check-in, the model feels obligated to front-load everything.
3. *No base-rate ordering instruction:* when the model does list, nothing tells it the first item must be the most likely cause. So "restart your router" (step 1, easy to write) beats "forget and rejoin the network" (step 3, the actual fix).

**Enforcement: the one-step rule (exact text in §10, Fix T1).** Three components:

- *Replace* the numbered-list line with: "TROUBLESHOOTING — ONE STEP AT A TIME: give at most ONE diagnostic step or ONE clarifying question per reply (≤35 words), then end with a check-in question ('Did that work?', 'Which one?'). NEVER a numbered list. NEVER dump all possible fixes."
- *Why it works:* it revokes the specific instruction causing the behavior (models obey the most recent/specific formatting instruction), replaces it with an incompatible format (one step vs list), and supplies the check-in that makes one-step feel safe.
- *Verification:* re-run the 150 troubleshooting scenarios live; assert avg words ≤40 and zero numbered lists. Any list = fix failed.

**What one-at-a-time looks like across turns (the missing mental model).** Muse's K0026 ("Do a force restart… Did it come back?") implies turn 2: if the user says "no", *then* the next most likely step. Ring must learn that a conversation is a sequence, not a document. The system prompt should say so explicitly: "You are in a conversation, not writing an article. The user will reply. Give them the single next thing, then ask what happened."

---

## Comparison structure: Muse's verdict → bullets → recommendation vs Ring's meandering

**Muse's anatomy (measured, invariant across 150):**

| Slot | Spec | Example (K0255) |
|---|---|---|
| Verdict | 1 sentence, ≤14 words, decision + qualifier | "Yes — it's the best $78 in travel." |
| Bullets | Exactly 4 `•`, each `Dimension: winner + clause` | "• Only skip if: you fly less than once a year." |
| Close | 1–2 sentences, conditional imperative, often a number | "Apply online, do the 10-minute in-person appointment, and never stand in the long line again." |

Total 52–85 words. The qualifier in the verdict ("for most people", "unless you know you need the Pro", "if coverage is good") is doing the hedging work *honestly* — it scopes the claim instead of dissolving it.

**Ring's predicted anatomy:**

| Slot | Pattern |
|---|---|
| Opener | Throat-clearing hedge ("That's a great question! Both are excellent… really depends on your specific needs") |
| Body | Paragraphs per option, no per-dimension winners declared |
| Close | Decision returned to user ("only you can decide", "think about what matters most") |

Total ~140–210 words. The verdict slot is empty; the close slot is an abdication.

**Why Ring meanders.** No system-prompt block governs comparison structure (592e780's fixes are all about agentic brevity, not answer architecture). The base prior for "compare X vs Y" is the SEO article: intro, overview of each, conclusion. Muse's format is the *advisor* format: decision first, evidence compressed, action last. The fix is a template block (§10, Fix C1) with the same specificity as the troubleshooting one-step rule — including "exactly 4 bullets" and "the first line must contain your pick".

**The numbers rule.** ~120/150 of Muse's comparisons contain a concrete number ($78, 2-3 years old, 95%, ~7%, $10,000, 30-50%). Predicted Ring: ~40/150. Numbers are what make verdicts *credible* rather than merely opinionated ("Index funds, for 95% of people" vs "index funds are generally recommended"). Fix C2: "every comparison and money answer must contain at least one concrete number."

**No false balance (Fix C3).** K0161 ("Laptop, no contest"), K0197 ("Term, for almost everyone"), K0171-adjacent finance items: when evidence is lopsided, Muse says so. Ring's predicted pattern both-sides them. The prompt must explicitly permit strong verdicts: "When the evidence is lopsided, say so plainly — 'no contest', 'for almost everyone'. False balance is a failure."

---

## Empathy calibration: caring without gushing

**Muse's measured empathy inventory (n=300, counted):** "Frustrating, I know." (1×), "I know" (2× total), "That message is useless, I know." (1×), "Okay, quickest first move" (1×), "Not your fault at all" (1×), "It won't delete anything" (1×), "Act fast:" (1×), "the money's gone" (1×). That's it. Across 300 responses, fewer than 10 overt empathy markers — but each one is *load-bearing*:

- **Absolution** (K0054: "Not your fault at all") — answers the emotional question before the technical one.
- **Fear-addressing** (K0026: "It won't delete anything") — names the user's unspoken fear of the fix itself.
- **Urgency-matching** (K0107: "Act fast:") — tone matches the stakes; no pleasantry when money is moving.
- **Honest limits** (K0142: "that's by design") — respects the user enough to say no.

**Ring's predicted empathy failure modes:** (1) *Gushing filler* — "I'd be happy to troubleshoot this issue for you!", "I'm sorry to hear that!" — politeness that costs words and signals slowness; (2) *Reassurance omission* — the force-restart without "it won't delete anything", the 500-error without "not your fault"; (3) *Urgency flattening* — "I'm sorry to hear that!" + a 7-step list for a Zelle mis-send, where Muse writes "Act fast:".

**Calibration rule (§10, Fix T4):** "Empathy is specific or it's nothing. Never open with generic sympathy ('I'd be happy to', 'I'm sorry to hear that'). Instead: (a) if the user fears the fix, name the fear and defuse it ('It won't delete anything'); (b) if the user blames themselves, absolve first ('Not your fault at all'); (c) if money or data is at risk, match urgency ('Act fast:') — no pleasantries; (d) if you cannot help, say so plainly ('that's by design'). One empathy clause max per reply."

---

## Specific prompt/code fixes (exact text + file paths)

**File:** `~/workspace/ring/backend/lib/agent.js` — the `SYSTEM_PROMPT` const (currently ~line 1197). All fixes are prompt-text changes unless noted.

### Troubleshooting fixes

**Fix T1 — The one-step rule (replaces the root-cause line).**
Find:
```
- For multi-step tasks, list the steps numbered. Keep each step to one line.
```
Replace with:
```
- TROUBLESHOOTING — ONE STEP AT A TIME. You are in a conversation, not writing an article; the user will reply. For any problem report: give at most ONE diagnostic step or ONE clarifying question per reply (hard cap 35 words), then end with a check-in question ("Did that work?", "Which one do you see?"). NEVER a numbered list. NEVER dump every possible fix. If the user answers, give the single next step. The check-in is mandatory — it is what makes one-step safe.
```
Expected impact: troubleshooting conciseness 8.5 → ~20/25; eliminates the step-dump structurally. 592e780 did not touch this.

**Fix T2 — Diagnose before fixing (base-rate + scope + temporal + datum).**
Append to SYSTEM_PROMPT:
```
- DIAGNOSE BEFORE FIXING. (a) Ask the routing question first when two failures need opposite fixes ("Is it X or Y?"). (b) Lead with the single most likely cause; say so ("That's the #1 cause", "almost always"). (c) Honor scope qualifiers in the input: "on my phone only" exonerates the router — never advise disrupting what the user scoped out. (d) Read temporal clues: "since yesterday" means sudden onset — find the changed thing (rogue app update), don't recite generic hygiene. (e) Send the user to the measurement, don't guess: "Settings > Battery — which app is at the top?" beats a list of guesses. (f) Never re-suggest a step the user already ruled out ("checked spam" means never mention spam again).
```

**Fix T3 — Error codes are input, never output.**
```
- ERROR CODES: translate the code into plain English in ≤8 words ("a network error on smart TVs", "the server refusing you, not you lost"), then give the fix. NEVER recite code definitions, hex values, or "technically known as". If you need the code to diagnose (e.g. BSOD), ASK for it — "What did the error code say at the bottom?" — don't lecture about it.
```

**Fix T4 — Empathy calibration.**
```
- EMPATHY IS SPECIFIC OR IT'S NOTHING. Never open with generic sympathy ("I'd be happy to", "I'm sorry to hear that"). Instead: (a) if the user fears the fix, defuse it ("It won't delete anything"); (b) if they blame themselves, absolve first ("Not your fault at all"); (c) if money/data is at risk, match urgency ("Act fast:") with zero pleasantries; (d) if you cannot help, say so plainly ("that's by design"). One empathy clause max per reply.
```

**Fix T5 — Escalation guard.**
```
- ESCALATION GUARD: never suggest reset / restore / reinstall / "reset all settings" / recovery mode in the first reply. Those are last resorts, named only after simpler steps fail across turns.
```

**Fix T6 — Money-panic template.**
```
- MONEY PANIC (declined card, wrong transfer, double charge): lead with urgency ("Act fast:"), state the ONE branching fact that determines the outcome (enrolled vs not, pending vs posted, everywhere vs one merchant), give honest odds ("the money's gone — you'll have to ask them to send it back"). Never offer false hope ("file a dispute") for authorized mis-sends.
```

### Comparison fixes

**Fix C1 — The comparison template block.**
```
- COMPARISONS (X vs Y, "which is better", "should I", "is it worth it") — MANDATORY STRUCTURE. Line 1: your verdict as one sentence (≤14 words), decision + qualifier ("Netflix, for most people.", "Save the $200.", "Only if the salary bump pays the debt in under 5 years."). Then exactly 4 bullets, each "Dimension: winner + one clause". Then a 1–2 sentence conditional close with the exact next action ("Apply online, do the 10-minute appointment."). Total ≤85 words. No throat-clearing opener. No "it depends" without a decision attached. The close never returns the decision to the user.
```

**Fix C2 — Numbers.**
```
- Every comparison and every money answer must contain at least one concrete number (price, %, timeframe, threshold). "For 95% of people" beats "generally recommended". If you have no number, you don't have an answer yet.
```

**Fix C3 — No false balance.**
```
- When the evidence is lopsided, say so plainly: "no contest", "for almost everyone". False balance ("both are great, only you can decide") is a failure. Advisor/professional punts are for legal requirements only — and even then, give the consensus verdict first.
```

**Fix C4 — Match depth to stakes.**
```
- Match reply depth to decision stakes. A $45 cup gets ≤60 words; a $100k debt question gets the full template. Never write 160 earnest words about a cup.
```

**Fix C5 — Reframe + era-calibrate.**
```
- Prefer the better question over the literal one ("Delete the apps, keep the accounts."). Answer for the current year: "learn to code in 2026" needs the AI-era calibration (junior market tougher; leverage is coding+AI), not the 2021 answer.
```

**Fix C6 — "Worth it" sub-template.**
```
- "IS X WORTH IT": verdict + the price embedded as the argument ("it's the best $78 in travel"), one reframe that makes the price feel trivial ("less than one airport meal per year"), the honest skip condition ("Only skip if: you fly less than once a year"), the exact next action. The skip condition is what makes the yes trustworthy — never omit it.
```

### Projected post-fix scores

| Segment | Pre-fix (predicted) | Post-592e780 only | Post-592e780 + T1–T6/C1–C6 |
|---|---|---|---|
| Troubleshooting | ~58.5 | ~64 | ~88–92 |
| Comparisons | ~61.5 | ~63 | ~88–92 |
| **Corpus overall** | **~60** | **~63.5** | **~88–92** |

592e780 alone moves the corpus ~3.5 points (filler removal). The 12 new fixes move it ~28 points — because they target structure (step-dump, verdict-first), which is where ~80% of the gap lives. None of this is live-verified; the verification loop is: apply → re-run all 300 live → assert avg words ≤40 (troubleshooting) / ≤85 (comparisons), zero numbered lists in troubleshooting, verdict-first in 150/150 comparisons.

---

## Appendix A — Predicted pre-fix scores, all 300 scenarios

Consolidated from the per-sub-category tables. Format: `ID total (C/I/D/O)`.

**Troubleshooting — bottom 25 (the step-dump hall of shame):**
K0069 48 (6/15/12/15) · K0081 53 (8/15/14/16) · K0036 54 (8/16/14/16) · K0107 55 (8/17/14/16) · K0097 55 (8/16/14/17) · K0124 55 (8/16/13/16) · K0008 56 (7/17/14/18) · K0063 56 (8/17/14/17) · K0113 56 (9/16/14/17) · K0300* 56 (9/19/11/17) · K0197* 57 (10/19/11/17) · K0137 57 (7/17/13/17) · K0142 57 (8/16/13/16) · K0054 58 (9/18/14/17) · K0059 58 (8/18/14/18) · K0128 58 (8/18/14/18) · K0143 58 (8/18/14/18) · K0228* 58 (10/19/12/17) · K0286* 58 (10/19/12/17) · K0038 58 (8/18/14/18) · K0094 58 (8/18/14/18) · K0106 58 (8/18/14/18) · K0047 59 (9/18/14/18) · K0130 60 (8/19/14/19) · K0232* 60 (10/19/13/18)
(* comparisons. Full per-ID rows for all 300 are in the ten sub-category tables.)

**Troubleshooting predicted band:** nearly all scenarios fall 53–65; sub-category aggregates T-A ~62, T-B ~59, T-C ~58, T-D ~59, T-E ~58. Conciseness is the binding constraint in every row (6–10/25); intelligence never drops below 15/25 — Ring knows the material, it just can't stop listing it.

**Comparisons predicted band:** nearly all scenarios fall 56–65; sub-category aggregates C-A ~62, C-B ~62, C-C ~61.5, C-D ~61.5, C-E ~61. Directness is the binding constraint (11–14/25); intelligence 18–21/25. The lowest comparison scores cluster on money/health high-stakes items (K0197 57, K0228 58, K0286 58, K0300 56) — hedging scales with stakes, exactly backwards.

**Full per-ID rows** live in the ten sub-category tables (§T-A through §C-E above), which together cover all 300 scenario IDs with input, predicted Ring pattern, predicted 4-dimension scores, and the primary gap.

---

## Appendix B — Method notes and caveats

1. **Ring responses are predicted, not observed.** The sbs-K file ships `ring_response: null` for all 300. Predictions extrapolate from 165 live-scored scenarios (84.2/100) plus the documented filler inventory and step-dump habit. Treat predicted scores as ±5 priors for the live re-test, not measurements.
2. **Pre-fix assumption.** All predictions assume the pre-592e780 model. Where a 592e780 fix plausibly bites (banned words, one-clause), impact is noted per deep dive — net effect ≈ +3.5 corpus points, concentrated in directness/conciseness filler, not structure.
3. **Muse quotes are verbatim** from `sbs-K-trouble-compare.json` (spot-verified against the file; em-dashes and punctuation preserved).
4. **Word counts:** Muse's measured via the file (troubleshooting avg 29.8, comparisons avg 66.1). Ring's predicted from live-data ratios (1.3–6× Muse) and the documented list lengths.
5. **What would change the analysis:** live Ring responses for these 300 (the parent agent has the credentials and the runner pattern in `run_tests.py`); a post-fix re-run would collapse most predictions and reveal the residual per-scenario gaps the prompt fixes don't cover.
