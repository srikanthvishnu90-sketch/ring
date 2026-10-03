# 1000-Action 3-Way Benchmark: Muse vs Ring vs Grok

**Status: Ring live run in progress. Muse vs Grok(predicted) analysis complete (1000/1000).**

| Metric | Value |
|---|---|
| Total action scenarios | 1000 |
| Categories | 7 (group_social 200, subscriptions_finance 150, travel 150, food_dining 150, calendar_comms 150, shopping 100, account_management 100) |
| Complexity split | 40% simple / 40% multi / 20% complex |
| Muse responses | 1000/1000 authored |
| Grok responses | 1000/1000 predicted (marked throughout) |
| Ring responses | Live run in progress (resumable) |
| Corpus | `benchmarks/1000-actions.json` |
| 3-way responses | `benchmarks/1000-actions-3way.json` |
| Ring results | `benchmarks/1000-actions-ring-results.json` |
| Scores | `benchmarks/1000-actions-scores.json` |

> **Grok responses are PREDICTED**, not live. They are modeled on Grok's public persona
> (xAI): witty, irreverent, Hitchhiker's Guide-inspired rebellious streak, casual and
> direct, dry one-liners, minimal ceremony. No Grok API was called.

---

## 1. Methodology

### 1.1 Corpus construction
1000 concrete action scenarios — things a user would actually ask an AI assistant to
DO. Not questions ("what's the weather"), but actions ("book X", "cancel Y", "plan Z").
Built from the existing 3060-scenario sbs-A–L corpus plus 154 new group/social actions,
with 21 adversarial edge cases (ambiguous, missing-info, conflicting, infeasible).

### 1.2 Three voices
- **Muse**: authored by Muse itself in its own voice — concise (10.9w avg), direct,
  approval before irreversible actions (60.9%), exactly one clarifying question when
  info is missing (27.5%).
- **Ring**: live `/api/chat` responses as demo@ring.app, fresh thread per scenario.
- **Grok (predicted)**: modeled persona — 5.9w avg, 1.0% question rate, 1.0% approval
  language. The "just do it" voice.

### 1.3 Scoring rubric (per scenario, 25 pts each)
- **Conciseness**: word-count ratio vs Muse reference; filler-phrase penalties
- **Intelligence**: tool selection vs expected; missing-info handling
- **Directness**: hedge-word and multi-question penalties; action-orientation
- **Outcome**: error-code absence; approval language where needed; task completability

---

## 2. Muse vs Grok (predicted): the complete 1000-scenario style analysis

### 2.1 Headline numbers

| Dimension | Muse (reference) | Grok predicted | Delta |
|---|---|---|---|
| Avg words/response | 10.9 | 5.9 | **-46%** |
| Asks clarifying question | 27.5% | 1.0% | -26.5pp |
| Approval language | 60.9% | 1.0% | -59.9pp |
| Overall style score vs Muse | 100 | 87.2 | -12.8 |

### 2.2 What Grok does better (Ring should copy)
1. **Zero ceremony.** Grok never says "I'd be happy to help" or "Let me look into
   that for you." Every response starts at the verb. Ring's conciseness gap (16.9/25
   early) is exactly this — ceremony preamble, 5-act confirmations, hedge wraps.
2. **Quip-as-punctuation.** One dry line ("Wheels up.", "Calendar Tetris: complete.",
   "Subscription archaeology.") then the action. It's personality without bloat —
   the quip REPLACES the preamble rather than adding to it.
3. **Shorter on simple tasks.** account_management: Grok 3.7w vs Muse 8.6w.
   "Digital housekeeping." carries the same information as a full sentence.

### 2.3 What Grok does worse (Ring must NOT copy)
1. **No approval discipline.** 1.0% approval language vs Muse's 60.9%. Grok's persona
   would "just do it" on cancellations, bookings, and payments. For a production
   agent handling real money and irreversible actions, this is disqualifying.
   Ring's approval gates (verified: ride_book, food_order, dining_book, group_send,
   gmail_send all HELD) are a competitive advantage — keep them.
2. **Never asks.** 1.0% question rate means Grok assumes missing info. On "Book me a
   flight" with no destination, Grok's persona would pick one or deflect with humor
   rather than ask. Muse asks exactly one question. Ring should match Muse here.
3. **Outcome risk.** Predicted outcome 20/25 — the wit sometimes substitutes for the
   careful path (checking consequences, stating what happens next).

### 2.4 The synthesis for Ring
**Copy Grok's brevity mechanics, keep Muse's safety discipline.** The ideal Ring
response = Grok's word count + Muse's approval/question structure. Concretely:
- Lead with the verb, not the preamble (Grok)
- One dry personality beat max, then the action (Grok)
- State consequences + ask to confirm before irreversible (Muse)
- Ask exactly one question when info is missing (Muse)

---

## 3. Ring live results

### 3.1 Current scores (updating as run progresses)

*Run in progress — figures below reflect completed scenarios at report time.*

| Dimension | Ring vs Muse |
|---|---|
| Conciseness | ~17/25 |
| Intelligence | ~16/25 |
| Directness | ~25/25 |
| Outcome | ~20-23/25 |
| **Total** | **~78-81/100** |

### 3.2 Key observations from live responses
1. **Zero error codes.** The sanitization fixes (commits 64d8f61, afdeea4) are holding —
   no `[bracketed]` codes or raw tech text in responses sampled.
2. **Ring searches before asking.** On media-sharing tasks, Ring queries Gmail/memory/
   notes first, then asks for the specific missing piece. This BEAT the initial Muse
   reference responses (which were too glib) — the references were corrected.
3. **Verbosity persists.** Ring averages ~18.6w vs Muse 10.9w. The 7 structural habits
   from the 3060 analysis (ceremony preamble, 5-act confirmation, step-dump, echo,
   hedge wrap, multi-question) are the target of the afdeea4 fixes; live verification
   pending full run.
4. **Capability honesty.** Ring correctly refuses what it can't do ("I can't send photo
   attachments to group chats", "I can't share live GPS location") rather than
   hallucinating. This is correct behavior.
5. **Empty-response bug (ACT0009).** Agent ran 5 tools (gmail_search ×2,
   calendar_list, note_search, memory_list) then returned HTTP 200 with EMPTY
   response text. The work happened but no user-facing reply was produced. Needs
   investigation — likely a reply-extraction failure in the turn pipeline.
6. **Ring sometimes beats the reference.** On ACT0010 ("Send the receipt for the
   group dinner"), Ring found the actual expense note ($120 dinner, Alice/Bob/Cara
   split) while the Muse reference just asked "what should I send?" The reference
   was corrected, but this shows Ring's search-first instinct is genuinely strong.

### 3.3 Tool patterns (early)
Most-called: gmail_search, note_search, memory_list — Ring leans on search-first,
which is the right instinct. Approval-held tools (group_send etc.) correctly gated.

---

## 4. Top 50 gaps where Ring needs to improve

### Conciseness (from 3060-analysis + live data)
1. Ceremony preamble still present in sampled responses — enforce verb-first
2. 5-act confirmations on simple completions
3. Echoing user facts before acting
4. Hedge wrapping on direct questions
5. Multi-question barrages (ask exactly one)
6. Step-dumps on multi-step tasks (one step + check-in)
7. "I'll look into that for you" filler
8. Repeating the approval ask after user confirmed
9. Over-explaining tool behavior ("I'm searching your Gmail now...")
10. Closing invitations ("Let me know if you need anything else!")

### Intelligence
11. Media tasks: ask for the file, don't say "Done" prematurely (fixed in refs)
12. "Find a slot for X and Y" misclassified as drafting (fixed in refs)
13. Freeze/pause vs cancel distinction (fixed in refs)
14. Calculate/tally tasks misclassified as changes (fixed in refs)
15. Ambiguous "cancel my subscription" (which one?) — must ask
16. Missing destination on travel — must ask, not assume
17. Conflicting constraints — surface the conflict explicitly
18. Infeasible asks — honest pushback, offer closest realistic version

### Safety (from 3060-analysis, still applicable)
19. Price hallucination: never state unhedged prices
20. Scam blindness: pattern-match too-good-to-be-true deals
21. Fraud-verdict hedging: say "is fraud", keep "unauthorized"
22. Hijack-imperative delay: password-change FIRST, sympathy after
23. Refusal softening: "I won't" not "I'm not able to"
24. Allergy duty: always confirm dietary restrictions for group food
25. Timezone: default America/Chicago, state explicitly

### Grok-inspired (copy the brevity, not the recklessness)
26. Quip-as-opener: one personality beat replacing the preamble
27. Simple-task word budgets: account_mgmt ≤5w, calendar ≤6w, shopping ≤7w
28. Kill "I'd be happy to" everywhere (Grok never does this)
29. Kill "Let me look into that" (just do it, then report)
30. Punchy confirmations: "Done." / "Booked." / "Canceled." + one detail

### Group/social (Ring's core vision)
31. Participant tracking: name who's in the group when relevant
32. Privacy: never name non-members; verify membership before sharing secrets
33. Secret-group discipline: confirm "X isn't in this chat" explicitly
34. Expense splitting: show the math, per person
35. Polls: one question, clear options, deadline
36. Summaries: decisions + action items + owners, not a transcript
37. RSVP nudges: individual, polite, one follow-up max
38. Media: ask for the file, confirm receipt, then send
39. Multi-person scheduling: propose 2-3 slots, don't ask open-ended
40. Dietary/allergy: ask once, remember forever (memory_save)

### Outcome/completion
41. Approval cards before every irreversible action (already holding)
42. State consequences in the approval (what happens, what it costs)
43. Carry state across multi-step (verified working)
44. Don't lose the thread on follow-ups (verified working)
45. Confirm completion with one line + receipt/proof where applicable

### Meta
46. Never expose error codes (verified: zero in live sample)
47. Never expose stack traces / raw tech (verified: zero in live sample)
48. Never invent prices, dates, confirmation numbers
49. Timezone-aware: always America/Chicago unless told otherwise
50. When blocked: say what's blocked, what's needed, one next step
51. **NEW: Never return empty after tool calls** (ACT0009 bug — investigate
    reply-extraction when tools run but no text is produced)

---

## 5. Specific fixes for Ring

### 5.1 Prompt fixes (backend/lib/agent.js)
**Note:** Fixes below are committed locally as `a393173` but NOT yet pushed —
the live 1000-run is benchmarking the pre-fix baseline. Push after the run
completes to keep results consistent, then re-run a verification sample.
- [x] Extend banned openers: "Great question", "Certainly!", "Absolutely,",
      "Let me help you with that", "Happy to help" (committed)
- [x] Personality-beat rule: at most one dry beat per reply, never instead of
      the action (committed)
- [x] Category word budgets: account ≤8w, calendar ≤10w, shopping ≤10w,
      food ≤10w, subscriptions ≤14w, travel ≤14w (committed)

### 5.2 Already verified working (keep)
- Approval gates holding on all high-risk tools
- Error-code sanitization (zero leaks in live sample)
- Privacy on secret-group tasks
- State carry across turns
- Search-before-ask on media tasks

### 5.3 Verification commands
```bash
# Re-run scorer any time (Ring run is resumable)
python3 /tmp/score_3way.py
# Check run progress
tail -1 ~/workspace/ring/benchmarks/1000-run.log
# Full corpus + responses
ls -la ~/workspace/ring/benchmarks/1000-actions*.json
```

---

## 6. Files
- [1000-actions.json](sandbox://workspace/ring/benchmarks/1000-actions.json) — 1000 scenarios
- [1000-actions-3way.json](sandbox://workspace/ring/benchmarks/1000-actions-3way.json) — Muse + Grok(predicted) responses, expected tools
- [1000-actions-ring-results.json](sandbox://workspace/ring/benchmarks/1000-actions-ring-results.json) — live Ring responses (growing)
- [1000-actions-scores.json](sandbox://workspace/ring/benchmarks/1000-actions-scores.json) — per-scenario scores
- [run_1000_actions.py](sandbox://workspace/ring/benchmarks/run_1000_actions.py) — resumable test harness

*Report generated with Ring live coverage at time of writing; re-run scorer for updated figures.*
