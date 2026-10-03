# Muse vs Ring — Deep Comparative Analysis: Scheduling (I) + Information Lookup (J)

**File scope:** `~/workspace/ring/benchmarks/sbs-I-scheduling.json` (200 scenarios, I0001–I0200),
`~/workspace/ring/benchmarks/sbs-J-infolookup.json` (200 scenarios, J0001–J0200)
**Method:** Muse responses given in-file. Ring responses were `null`/`has_live: false` — every Ring
response below is a **pre-fix prediction** modeled on Ring's known live behavior from 165 live samples
(overall 84.2/100: Conciseness 16.8/25, Intelligence 22.5/25, Directness 22.5/25, Outcome 22.5/25).
Fixes (word caps, banned words) have been applied to the prompt but are NOT live-verified here, so
predictions show the OLD behavior, with fix impact assessed separately in §11.
**Date:** 2026-10-03. **Author:** subagent deep-analysis pass.

---

## 0. Executive summary — the headline finding

Scheduling and information lookup are **the two categories where Ring's verbosity tax hurts most**.
Muse's entire scheduling vocabulary fits in a pocket: 75 confirmations, all between **4 and 11 words**
(mean 7.3, median 7; most common: 8 words — 25/75). 115 of 200 information-lookup answers are **3 words
or fewer** (median: 3 words; "Your balance is $1,240."). Every clarifying question across all 400
scenarios is **exactly one question** — zero multi-question replies anywhere in either file; mean
clarify length is 5.4 words (scheduling) and 9.3 words (info lookup).

Ring's predicted pre-fix profile in these two categories is the opposite: 30–60-word confirmation
paragraphs, 3-question clarify barrages, error-code leaks, and hedged no-data essays. The predicted
category scores:

| Category | Muse | Ring (predicted, pre-fix) | Largest gap |
|---|---|---|---|
| Scheduling — confirmations | 100/100 | 58–66/100 | Conciseness (−18 to −22 of 25) |
| Scheduling — clarify questions | 100/100 | 52–60/100 | Over-asking / verbosity |
| Scheduling — lookups / free-slot | 100/100 | 70–78/100 | Mild hedging, extra offers |
| Info lookup — fact answers | 100/100 | 62–72/100 | Padding ("Let me know if…") |
| Info lookup — no-data | 100/100 | 45–55/100 | Error codes, essays |
| Info lookup — privacy refusals | 100/100 | 55–65/100 | Moralizing, over-apology |

**Top 3 findings:**

1. **The confirmation problem is structural, not stylistic.** Muse never says "I've scheduled your
   meeting successfully for you" — it says "Done — lunch with Sarah, Tuesday noon." (7 words). Ring's
   confirmation template appears to be `[acknowledgment] + [self-reference] + [success adverb] +
   [detail echo] + [invitation to continue]` — a 5-part formula that yields 35–55 words on a task Muse
   does in 7. §7 traces exactly how 8 words become 40, with 5 fully worked examples.
2. **Single-question discipline is the biggest Intelligence/Directness gap.** Muse asked exactly one
   question in 72/72 scheduling clarifications and 36/36 info-lookup clarifications. Ring's known
   failure mode is asking 3 where 1 suffices ("What day works best for you? And what time? Should I
   invite anyone else?") — or guessing silently (under-asking). In these categories each extra question
   is a full conversational round-trip the user didn't sign up for.
3. **Honest minimalism beats error-code transparency.** When Muse has no data it says "I don't have
   that on file." (7 words) and stops. Ring's known behavior — including an explicit code directive at
   `~/workspace/ring/backend/lib/agent.js` (~line 1836–1840) that FORCES the model to quote
   `"Error [CODE]: note"` verbatim — turns every no-data case into a leaked internal error code plus a
   paragraph of recovery chatter. That single directive is the cheapest high-impact fix in this whole
   document (§10, Fix F2).

---

## 1. Category overview: why brevity is everything here

Scheduling and information lookup share one property: **the user is done in one glance.** The correct
response is either a receipt ("Done — …", ≤11 words) or a single fact ("$1,240.", "Tuesday noon.").
In chat, these turns compete with glanceable UI; every extra sentence is latency the user feels.

The taxonomy from the data:

**Scheduling (200):** 75 confirmations ("Done — …"), 72 single-question clarifications, 38
lookup/free-slot answers, 16 other (refusals, edge cases, playful).

**Information lookup (200):** 115 fact answers (mean 3.3 words), 22 yes/no+evidence answers
(mean 6.2 words), 36 clarify questions (mean 9.3 words), 27 strict no-data refusals (mean 9.6 words).

Word-count distributions (computed from the files):

- I confirmations: min 4, max 11, mean **7.3**, median 7. Distribution: {4:3, 5:2, 6:16, 7:18, 8:25, 9:8, 10:2, 11:1}. The heaviest confirmation in the entire category is 11 words ("Done — coffee with Priya moved to Wednesday noon.").
- I clarifications: mean **5.4** words; the most repeated reply is "What day?" (6×), then "When?" (5×).
- J fact answers: mean **3.3** words, median 3, max 9. ("Your balance is $1,240.", "6.2 GB of 15 GB used.", "The Hoxton, Chicago — check-in October 9.")
- J yes/no answers: mean **6.2** words — Muse always attaches the evidence ("Yes — $2,140 landed this morning.") instead of a bare yes.
- Zero responses in either file contain more than one question mark. Zero.

Prediction basis for Ring: the known live behaviors (165 live samples): Conciseness 16.8/25 —
"confirmations that should be one sentence become paragraphs"; filler phrases actually observed:
"staged", "proceed with", "in order to", "I've requested", "I'm waiting",
"I've scheduled your meeting successfully for you!"; error-code exposure; over/under-asking.

---

## 2. Scheduling — Muse's patterns (with quotes)

### 2.1 The "Done — …" confirmation (75 scenarios)

Muse's booking vocabulary is exactly one template: **`Done — <what>, <when>.`** No subject ("I"),
no success adverbs, no echo of the tool, no offer to continue. Examples:

- I0001 `schedule lunch with Sarah next week` → **"Done — lunch with Sarah, Tuesday noon."** (7 words)
- I0003 `book a dentist appointment friday morning` → **"Done — dentist, Friday 9 AM."** (6)
- I0009 `put 'work on thesis' on my calendar tonight at 8` → **"Done — 'work on thesis', tonight 8 PM."** (8)
- I0015 `add 'renew car insurance' to my calendar on the 20th` → **"Done — 'renew car insurance', Oct 20."** (7)
- I0022 `SCHEDULE A CALL WITH MOM SUNDAY NIGHT` → **"Done — call with Mom, Sunday 8 PM."** (8)

Note what Muse does NOT do: no "Successfully booked!", no "I've added it to your calendar for you",
no confirmation-code-style ceremony. The em-dash after "Done" carries the entire receipt.

Sub-flavors keep the same skeleton:
- Reminders: "Done — reminder: call Mom, today 6 PM." (I0066); recurring: "Done — daily reminder: vitamins, 8 AM." (I0068)
- Moves: "Done — standup moved to Thursday 10:30 AM." (I0102) — the verb changes, the shape doesn't.
- Cancels: "Done — lunch with Sarah cancelled." (I0116), "Done — Friday's cleared." (I0117)
- Recurring creates: "Done — gym, weekdays 6 AM." (I0157), "Done — weekly team sync, Mondays 10 AM." (I0156)
- Defaults made explicit: I0016 `put a hold on my calendar saturday morning` → "Done — hold, Saturday 9 AM to noon." — Muse picked a sensible window and states it plainly, no hedging.

### 2.2 The single-question clarify (72 scenarios)

Muse asks exactly one question, naming exactly the missing slot. Examples:

- I0002 `set up a call with my accountant` → **"What day?"** (2 words)
- I0005 `dinner with mom sunday` → **"What time Sunday?"** (3)
- I0019 `can you set up a call with Charlie sometime this week` → **"What day works for you?"** (5)
- I0028 `put 'car service' on thursday` → **"What time Thursday?"** (3)
- I0085 `remind me to renew my license before it expires` → **"When does it expire?"** (4)
- I0097 `remind me when the game starts` → **"Which game?"** (2)
- I0101 `move my dentist appointment` → **"To when?"** (2)

The discipline: one slot, one question, no apology, no preamble. Even compound ambiguity gets ONE
question when one slot dominates (I0099 → "I can't trigger on that — want a reminder at a specific
time instead?"). The only scenario where Muse asks what looks like two questions is I0173
(`schedule a call with the tokyo team at 9am their time` → "That's 7 PM your time, the day before.
Which date should I book?") — information + one question. Still one question mark.

### 2.3 Calendar lookups (38 scenarios)

Muse answers calendar reads like a human glancing at a screen — no headers, no bullet lists:

- I0031 `what's on my calendar tomorrow` → **"Tomorrow: coffee with Priya 10 AM, call with Jake 2 PM."** (11)
- I0032 `am I free friday afternoon` → **"Yes — free after 1 PM Friday."** (6)
- I0034 `do i have anything on monday` → **"Nothing on Monday — it's clear."** (5)
- I0051 `list my events for next week` → **"Mon — clear; Tue — dentist 9 AM; Wed — standup 10:30 AM; Thu — team lunch 12:30 PM; Fri — design review 2 PM."** (23 — the longest lookup in the category, and still one line)
- I0042 `How many meetings do I have next week?` → **"Six meetings next week."** (4) — answers the question asked, doesn't dump the list.

### 2.4 Free-slot search (15 scenarios)

Muse's offer pattern: **<slot>. <offer to book in ≤6 words>.** Examples:

- I0131 `find 30 min for me and jake this week` → **"Thursday 2–2:30 PM works for both. Want me to book it?"** (11)
- I0133 `find an hour for deep work tomorrow` → **"Tomorrow 1–2 PM is open. Book it?"** (8)
- I0138 `when am i free for a 45 min call tomorrow` → **"Tomorrow: 11 AM–noon and after 3 PM."** (7) — no booking offer; user asked "when", Muse answers "when".
- I0141 `find an open evening for date night` → **"Friday and Saturday evenings are free."** (6)
- I0151 `find me 30 min before 5pm today` → **"Today 4–4:30 PM is open."** (5)

Key judgment visible: when the user wants a slot *found* (I0131/33/35/37/43/47/49) Muse adds a
5-word booking offer; when the user wants information (I0138/141/146/151/153/155) Muse states the
slot and stops. Ring is predicted to collapse this distinction (§5.3).

### 2.5 Timezone conversions (13 scenarios)

Muse converts AND applies judgment:

- I0173 → "That's 7 PM your time, the day before. Which date should I book?" (states the offset, one question)
- I0174 `set up a meeting with berlin at 2pm CET` → **"That's 8 AM your time. Still want it?"** — flags the antisocial hour with a soft confirmation instead of silently booking an 8 AM.
- I0178 `is 4pm my time too late for london` → **"That's 10 PM in London — probably too late."** — answers the judgment question, doesn't moralize.
- I0182 `set a call with dubai at 3pm GST` → **"That's 6 AM your time. Still want it?"**
- I0184 `schedule a meeting that works for both NYC and LA` → **"1–4 PM your time overlaps both. Want me to book one?"** — computes the overlap window, offers one concrete action.

### 2.6 Refusals, impossibility, playfulness (16 "other" scenarios)

Muse refuses in one line with the real reason and an alternative:

- I0120 `I need to move my flight to sunday` → **"I can't change flights — that's the airline's booking. Want the change link?"**
- I0099 → "I can't trigger on that — want a reminder at a specific time instead?"
- I0188 `am i free on feb 30th` → **"Feb 30th doesn't exist — did you mean Feb 28th?"**
- I0197 `remind me to go back in time` → **"Can't do time travel — want a reminder for something real?"**
- I0200 `put 'surprise party for jake' on saturday, don't tell anyone` → **"Done — Saturday 7 PM. Your secret's safe."** — playful, 7 words, doesn't lecture about privacy.

Conflict handling is one sentence with a concrete alternative: I0189 → "That conflicts with your
dentist at noon. Wednesday noon works — want that?"; I0196 → "Those overlap — dentist Tuesday 9 AM,
lunch at noon instead?"
---

## 3. Scheduling — predicted Ring patterns (pre-fix)

Predicted from Ring's 165 live samples (84.2/100, Conciseness 16.8/25). Five recurring failure shapes:

### 3.1 The 5-part confirmation paragraph

Ring's predicted confirmation formula: **[enthusiastic acknowledgment] + [self-reference] +
[success adverb] + [detail echo] + [invitation to continue]**. Example predictions:

| ID / input | Muse (words) | Ring predicted (words) |
|---|---|---|
| I0001 `schedule lunch with Sarah next week` | Done — lunch with Sarah, Tuesday noon. (7) | "I've scheduled your meeting successfully for you! You have lunch with Sarah next week at Tuesday noon. Let me know if you'd like to change anything!" (25) |
| I0003 `book a dentist appointment friday morning` | Done — dentist, Friday 9 AM. (6) | "Done! I've booked your dentist appointment for Friday morning at 9 AM. I've added it to your calendar. Is there anything else I can help you with?" (28) |
| I0020 `lunch w sarah tmrw` | Done — lunch with Sarah, tomorrow noon. (7) | "Got it — lunch with Sarah is all set for tomorrow at noon! I've put it on your calendar so you won't forget. Enjoy!" (27) |
| I0102 `push tomorrow's standup to thursday` | Done — standup moved to Thursday 10:30 AM. (8) | "I've moved your standup to Thursday at 10:30 AM for you. Your calendar has been updated — let me know if you need anything else!" (26) |
| I0115 `cancel my dentist appointment` | Done — dentist appointment cancelled. (5) | "I've cancelled your dentist appointment successfully. It's been removed from your calendar. Would you like me to help you reschedule it for another time?" (25) |

Mean predicted Ring confirmation: ~27 words vs Muse's 7.3 — a **3.7× multiplier**, every single one.
The words do zero work: "successfully", "for you", "all set", "I've added it to your calendar"
(echoing the tool), "Let me know if you'd like to change anything!" (invitation the user never asked for).

### 3.2 The clarify barrage (over-asking)

Muse asks one question. Ring's predicted pattern — ask 3 where 1 suffices:

- I0002 `set up a call with my accountant` → Ring predicted: **"Sure! I'd be happy to set that up for
  you. What day would work best for the call? And what time? Also, how long should I schedule it
  for?"** (33 words, 3 questions) vs Muse's "What day?" (2 words, 1 question).
- I0008 `schedule a haircut appointment` → Ring predicted: "No problem! When would you like your
  haircut — what day and time works for you? Is there a specific salon you prefer?" (23 words,
  2 questions; Muse: "What day?" 2 words).
- I0024 `book vet appointment for Max next week` → Ring predicted: "I'd love to help with that!
  Which day next week works for you? What time? And is there a specific vet clinic you'd like me
  to book with?" (29 words, 3 questions; Muse: "What day?").
- I0075 `remind me every friday to review my budget` → Ring predicted: "Of course! What time on
  Fridays would you like the reminder? And would you prefer a notification or an email?" (20 words,
  2 questions; Muse: "What time Fridays?" 3 words).
- I0144 `can you find a time for me and priya to meet` → Ring predicted: "Sure thing! What day are
  you thinking? How long should the meeting be? And where would you like to meet?" (21 words, 3
  questions; Muse: "What day are you thinking?" 5 words).

Each extra question costs the user a full round-trip. Over-asking is the single biggest
Intelligence gap in this category: asking questions whose answers the user already gave implicitly
(salon preference, meeting location) signals the agent isn't listening.

### 3.3 The silent guess (under-asking)

The mirror failure — Ring predicted to fill missing slots with defaults and never say so:

- I0016 `put a hold on my calendar saturday morning` → Ring predicted: "Done — I've put a hold on
  your calendar for Saturday morning." — no explicit window stated, so the user can't verify what
  "morning" meant. Muse: "Done — hold, Saturday 9 AM to noon." (states the assumption; verifiable).
- I0022 `SCHEDULE A CALL WITH MOM SUNDAY NIGHT` → Ring predicted: "Done — your call with Mom is
  scheduled for Sunday night!" — "night" is not a time; Muse picked 8 PM and stated it. Ring's
  version is a receipt for nothing checkable.
- I0085 `remind me to renew my license before it expires` → Muse asks "When does it expire?"; Ring
  predicted to under-ask: "I'll remind you to renew your license. When does it expire?" — same
  question, but framed as a two-sentence promise + question (9 words vs 4), or worse, guess a date.
- I0173 timezone: Muse says "That's 7 PM your time, the day before. Which date should I book?";
  Ring predicted: "I've scheduled the call with the Tokyo team for 9 AM Tokyo time!" — books a
  7-PM-your-time slot without flagging it, no date disambiguation. This is the dangerous one:
  verbosity hides a missing question, and the user misses a meeting.

### 3.4 Hedged lookups and the "anything else" tax

- I0031 `what's on my calendar tomorrow` → Muse: "Tomorrow: coffee with Priya 10 AM, call with Jake
  2 PM." (11). Ring predicted: "Here's what's on your calendar for tomorrow! You have coffee with
  Priya at 10 AM, and then a call with Jake at 2 PM. Let me know if you'd like me to add or change
  anything!" (37) — the intro ("Here's what's…") and outro ("Let me know…") are pure tax.
- I0034 `do i have anything on monday` → Muse: "Nothing on Monday — it's clear." (5). Ring predicted:
  "Good news — your Monday is completely clear! You don't have anything scheduled. Enjoy your free
  day!" (19).
- I0051 `list my events for next week` → Muse gives the one-line week (23 words). Ring predicted to
  bullet-list it with per-day headers ("**Monday:** Clear… **Tuesday:** …"), 45–60 words, plus an
  intro line. Same facts, 2–3× the surface.

### 3.5 Edge cases: the lecture risk

- I0197 `remind me to go back in time` → Muse: "Can't do time travel — want a reminder for something
  real?" (11, playful). Ring predicted: "I appreciate the creativity, but unfortunately I'm not able
  to help with time travel as it's not physically possible. However, I'd be happy to set a reminder
  for something else — just let me know what you'd like!" (42 words of apology-flavored filler).
- I0120 `I need to move my flight to sunday` → Muse: "I can't change flights — that's the airline's
  booking. Want the change link?" Ring predicted: "I don't have the ability to change flight bookings
  directly, as those are managed by the airline. I can, however, help you find the change link or
  check your flight status if that would be helpful!" — correct content, 2.5× the words.
- I0188 `am i free on feb 30th` → Muse corrects and offers ("did you mean Feb 28th?"). Ring predicted
  to expose an error code: "Error [INVALID_DATE]: February 30th is not a valid date. Please provide a
  valid date." — the code leaks an internal enum to the user, and the recovery question ("did you
  mean Feb 28th?") is dropped for a generic reprimand.

---

## 4. Information lookup — Muse's patterns (with quotes)

### 4.1 The 3-word fact (115 scenarios)

The dominant pattern: **`[possessive noun] is [value].`** No preamble, no units spelled out twice,
no "Let me know if you need anything else":

- J0001 `what's my account balance` → **"Your balance is $1,240."** (4)
- J0011 `what's my data usage this month` → **"6.2 GB of 15 GB used."** (5)
- J0031 `how many free trials am i on` → **"2 — Spotify and Audible."** (4) — count + the actual names, one em-dash.
- J0074 `when is my next flight` → **"Tomorrow, 7:40 AM — UA 2847 to Denver."** (7) — the full flight answer in one breath: when, what, where.
- J0110 `whats the weather today` → **"72°F, partly cloudy."** (2)
- J0122 `what's my credit score` → **"742."** (1 word — a number needs no wrapper)
- J0136 `what's Sarah's number` → **"(555) 010-2234."** (1)
- J0119 `what time is sunset` → **"6:42 PM."** (2)

Note J0018 `when does my domain expire` → **"March 4, 2027."** — a date is a date; Muse doesn't say
"Your domain is set to expire on March 4, 2027." The shorter form is glanceable.

### 4.2 Yes/no + evidence (22 scenarios)

Muse never gives a bare yes/no — it attaches the one piece of evidence that makes the answer
trustworthy, in ~6 words:

- J0025 `did my direct deposit hit yet` → **"Yes — $2,140 landed this morning."**
- J0040 `has my refund been processed` → **"Yes — $48.20 refunded October 1."**
- J0048 `did my order ship yet` → **"Yes — shipped yesterday, arriving October 6."**
- J0057 `any update on my loan application` → **"Approved — $12,000 at 6.4% APR."**
- J0069 `whats the status of my background check` → **"Completed — passed."**
- J0023 `am I overdrawn` → **"No — checking is at $1,872."** — the "No" plus the number that proves it.

### 4.3 Disambiguating questions (36 scenarios)

When the request is underspecified, Muse asks one targeted question — and crucially, it **offers the
likely candidates** so the user can answer in one word:

- J0014 `balance??` → **"Which account — checking, savings, or credit card?"** (7) — the three options inline.
- J0036 `where's my package` → **"Which package — Amazon or Nike?"** (5)
- J0037 `what's the status of my application` → **"Which application — Brown or Michigan?"** (5)
- J0090 `what was the name of that restaurant` → **"Which one — the spot from Friday?"** (6) — guesses the most likely, asks to confirm.
- J0140 `what's my mom's number` → **"Which one — her cell or home number?"** (7)
- J0161 `what's the status` → **"The status of what — your order, application, or payment?"** (10)

This is the candidate-offering pattern: the question does the disambiguation work FOR the user by
listing what it knows about. Ring's predicted failure (§5) is the open-ended interrogative with no
candidates: "Which one are you referring to?" — which forces the user to do the recall work.

### 4.4 Honest no-data (27 scenarios)

Muse's no-data vocabulary is tiny and absolute — no hedging, no error codes, no promises about
"checking":

- **"I don't have that on file."** (5× — J0087, J0092, J0103, J0105, J0192) — 6 words, full stop.
- **"I don't see that in your connected accounts."** (J0042, J0114, J0190) — names the boundary: it's a connection gap, not a failure.
- **"I don't track meals. Want me to start?"** (J0078) — 7 words; refusal + one productive offer.
- **"I don't have your frequent flyer account connected. Connect it to see miles here."** (J0194) — names the exact next step.
- **"I don't track that. Last service was October 2025 — want a reminder?"** (J0196) — gives what it DOES have, then offers.
- **"I can't separate tips from totals in your transactions."** (J0198) — explains the limitation in one clause.

### 4.5 Privacy refusals (J0176–J0185) — analyzed fully in §8

Muse's refusal formula: **refuse in one clause + state the channel rule or offer the safe
alternative**. No apology paragraphs, no moralizing, and — critically — it distinguishes the user's
OWN secrets (offer a safe path) from other people's data (hard no):

- J0176 SSN → "I don't share that in chat. Want me to pull it from your vault for a form?" (vault offer)
- J0177 full card number → "I only show the last four (2429) — never the full number in chat." (states the rule)
- J0178 Netflix password → "I don't share passwords in chat. Want me to open the login page?" (safe path)
- J0180 wife's number → "I don't share other people's numbers. What do you need it for?" (hard no, asks intent)
- J0182 brother's spending → "That's his data — I can't share it." (8 words, no softening)
- J0184 exact salary → "$95,000." — the user's own non-sensitive fact, answered directly. No over-refusal.

---

## 5. Information lookup — predicted Ring patterns (pre-fix)

### 5.1 The padded fact

Ring predicted to wrap every 3-word answer in an intro and an outro:

| ID / input | Muse (words) | Ring predicted (words) |
|---|---|---|
| J0001 `what's my account balance` | Your balance is $1,240. (4) | "Your current account balance is $1,240. Let me know if you'd like me to break that down or show your recent transactions!" (24) |
| J0122 `what's my credit score` | 742. (1) | "Your credit score is 742, which is considered good! Let me know if you want tips on improving it." (20) |
| J0110 `whats the weather today` | 72°F, partly cloudy. (2) | "It's 72°F and partly cloudy today — a pretty nice day! Want me to check tomorrow's forecast too?" (20) |
| J0136 `what's Sarah's number` | (555) 010-2234. (1) | "Sure! Sarah's number is (555) 010-2234. Let me know if you need anything else!" (14) |
| J0074 `when is my next flight` | Tomorrow, 7:40 AM — UA 2847 to Denver. (7) | "Your next flight is tomorrow at 7:40 AM — that's UA 2847 to Denver. Safe travels! Want me to set a reminder for when to leave?" (27) |

Mean predicted Ring fact: ~20 words vs Muse's 3.3 — a **6× multiplier**. The two structural
additions: the "helpful" outro offer ("Let me know if…", "Want me to…") and the redundant restatement
("Your credit score is 742" for a 1-word answer). Muse's rule is: answer the question, stop.

### 5.2 The no-data essay (with error-code leaks)

Muse: "I don't have that on file." Ring predicted:

- J0087 `what's my license plate` → "I've checked your profile and connected accounts, but I couldn't
  find your license plate on file. If you'd like, I can save it for you — just tell me the number!"
  (32 words; Muse: 6). The "I've checked" process narration adds nothing; the user didn't ask for a
  tour of the search.
- J0042 `did my check get delivered` → Muse: "I don't see that in your connected accounts. Got a
  tracking number I can check?" (14). Ring predicted: **"Error [NO_TRACKING_SOURCE]: I wasn't able
  to find any check-delivery information in your connected accounts. If you have a tracking number,
  please share it and I'll look it up for you!"** — the bracketed code leaks the internal enum, and
  "please share it and I'll look it up" is 9 words where Muse's "Got a tracking number I can check?"
  is 7 with more warmth.
- J0186 `what's my crypto balance` → Muse: "I don't see that in your connected accounts. Connect a
  wallet to see it here." (14). Ring predicted: "I don't currently have access to any crypto wallets
  in your connected accounts, so I'm not able to show your crypto balance right now. You can connect
  a wallet in the app, and then I'll be able to pull your balances for you!" (46) — hedging tripled:
  "don't currently", "not able to", "right now".
- J0191 `did i get the job` → Muse: "I don't have access to that — check your email for their reply."
  (11). Ring predicted: "I don't have access to hiring decisions, unfortunately — that's something
  only the employer would know. I'd recommend checking your email for their reply, and I can help you
  search your inbox if you'd like!" (37).

The error-code directive in `agent.js` (~lines 1836–1840) is the smoking gun: it instructs the model
to quote `"Error [${code}]: ${note}"` VERBATIM. In live behavior this produces exactly the J0042-style
leak. Fix F2 (§10) targets this directive directly.

### 5.3 The candidate-less question

Muse: "Which package — Amazon or Nike?" Ring predicted:

- J0036 → "Which package are you asking about? I see a couple of deliveries in your accounts — could
  you clarify which one you mean?" (21 words, no candidates; Muse: 5 words, both candidates named).
  Without candidates the user must type "the Amazon one" — one extra mental step, every time.
- J0014 `balance??` → "Which account would you like the balance for? I can check your checking,
  savings, or credit card accounts — just let me know!" (21; Muse: "Which account — checking,
  savings, or credit card?" 7).
- J0106 `when is the deadline` → "Which deadline are you referring to? Could you give me a bit more
  detail about what you need?" (17; Muse: "Which deadline — the transfer application or the tax
  filing?" 10, with candidates).

This is an Intelligence failure disguised as a Directness failure: the model HAS the candidate list
in context and doesn't use it.

### 5.4 Vague-follow-up pile-up (J0161–J0175)

Muse answers each with one candidate-offering question (see §4.3). Ring predicted to chain:
"Which one are you referring to?" → user answers → "And what specifically would you like to know
about it?" — turning one disambiguation into two turns. J0173 `yeah that one` → Muse: "Which one —
the Amazon order or the Nike order?" Ring predicted: "Got it! What would you like to know about it?"
— "yeah that one" needs disambiguation FIRST, and Ring skips straight to the action question on an
unresolved referent.

### 5.5 Refusal quality gap (preview — full §8)

Predicted Ring refusals for the privacy block:

- J0176 SSN → "I understand you'd like your Social Security number, but for your security I'm not
  able to share sensitive information like that in chat. Your safety is really important to me! Is
  there something else I can help with?" (~40 words, moralizing, no vault offer; Muse: 17 words WITH
  the vault offer).
- J0182 brother's spending → "I can't share someone else's financial data with you — that would be
  a privacy violation. I hope you understand!" (Muse: "That's his data — I can't share it." 8 words).
  "I hope you understand!" is apology-theater; Muse's refusal is cleaner because it names the
  principle ("his data") and stops.
- J0178 password → Ring predicted to either over-refuse ("I can't help with passwords at all") or
  offer to "look it up in your vault" WITHOUT the chat-safety framing Muse uses ("I don't share
  passwords in chat. Want me to open the login page?" — names the channel rule, offers the safe path).
---

## 6. TOP 15 biggest gaps (before/after with word counts)

Scored C/I/D/O (Conciseness, Intelligence, Directness, Outcome — 25 each). Muse = 100/100 throughout.
Ring predictions are pre-fix.

**G1 — I0002 `set up a call with my accountant`** — the canonical over-ask.
- Muse: "What day?" (2 words, 1 question) — 100
- Ring predicted: "Sure! I'd be happy to set that up for you. What day would work best for the call?
  And what time? Also, how long should I schedule it for?" (33 words, 3 questions)
- Word-by-word: "Sure!" (throat-clear, banned-class) + "I'd be happy to" (performative) + "set that
  up for you" (echoes the request) + 3 questions where the only missing slot is the day. "And what
  time?" is premature — time is meaningless before the day exists. "How long" invents a third slot.
- Scores: C 5/25 (−20) · I 12/25 (−13, asks before it needs to) · D 10/25 (−15) · O 22/25 (−3, still gets there) = **59/100**, gap **41**.
- Fix: F1 (single-question rule, §10).

**G2 — J0176 `what's my social security number`** — refusal quality.
- Muse: "I don't share that in chat. Want me to pull it from your vault for a form?" (17)
- Ring predicted: "I understand you'd like your Social Security number, but for your security I'm not
  able to share sensitive information like that in chat. Your safety is really important to me! Is
  there something else I can help with?" (40)
- The predicted refusal is 2.4× longer AND drops the vault offer — the one thing that would actually
  help. Moralizing ("Your safety is really important to me!") replaces the mechanism.
- Scores: C 10/25 · I 14/25 (−11, misses the vault path) · D 15/25 · O 18/25 = **57/100**, gap **43**.

**G3 — I0001 `schedule lunch with Sarah next week`** — the confirmation formula.
- Muse: "Done — lunch with Sarah, Tuesday noon." (7)
- Ring predicted: "I've scheduled your meeting successfully for you! You have lunch with Sarah next
  week at Tuesday noon. Let me know if you'd like to change anything!" (25)
- Divergence: "I've scheduled" (self-reference, banned-class) + "successfully for you" (adverb + for-you
  padding) + "You have lunch" (echo of what was just said) + "at Tuesday noon" ("at" is wrong with
  "Tuesday" — Muse's bare "Tuesday noon" is cleaner) + invitation outro.
- Scores: C 6/25 (−19) · I 22/25 · D 20/25 · O 24/25 = **72/100**, gap **28**.

**G4 — J0042 `did my check get delivered`** — error-code leak.
- Muse: "I don't see that in your connected accounts. Got a tracking number I can check?" (14)
- Ring predicted: "Error [NO_TRACKING_SOURCE]: I wasn't able to find any check-delivery information
  in your connected accounts. If you have a tracking number, please share it and I'll look it up
  for you!" (34)
- The bracketed code is internal vocabulary in a user surface. Muse's "Got a tracking number I can
  check?" is warmer AND shorter than "please share it and I'll look it up for you".
- Scores: C 12/25 · I 16/25 (−9, leaks internals) · D 14/25 · O 20/25 = **62/100**, gap **38**.

**G5 — J0122 `what's my credit score`** — the 1-word answer.
- Muse: "742." (1)
- Ring predicted: "Your credit score is 742, which is considered good! Let me know if you want tips
  on improving it." (20)
- A 20× multiplier on a single number. "which is considered good" is unsolicited interpretation;
  the tips offer is an upsell on a lookup.
- Scores: C 4/25 (−21) · I 20/25 · D 18/25 · O 25/25 = **67/100**, gap **33**.

**G6 — I0173 `schedule a call with the tokyo team at 9am their time`** — dangerous under-ask.
- Muse: "That's 7 PM your time, the day before. Which date should I book?" (states the offset, asks the one missing slot)
- Ring predicted: "I've scheduled the call with the Tokyo team for 9 AM Tokyo time!" (books a
  7-PM-your-time slot with no date disambiguation)
- The verbosity hides a missing question; the user may miss a meeting. Worst failure class in the doc.
- Scores: C 14/25 · I 8/25 (−17) · D 12/25 · O 10/25 (−15) = **44/100**, gap **56** — the largest predicted gap.

**G7 — I0019 `can you set up a call with Charlie sometime this week`** — the polite interrogation.
- Muse: "What day works for you?" (5)
- Ring predicted: "I'd be happy to help you set up a call with Charlie! What day this week works
  best for you? And what time? Should I send Charlie a calendar invite as well?" (30 words, 3 questions)
- "this week" was in the input; Ring asks for day (fine), then time (premature), then invents an
  attendee-management question the user never raised.
- Scores: C 8/25 · I 13/25 · D 12/25 · O 21/25 = **54/100**, gap **46**.

**G8 — J0036 `where's my package`** — the candidate-less question.
- Muse: "Which package — Amazon or Nike?" (5, both candidates named)
- Ring predicted: "Which package are you asking about? I see a couple of deliveries in your accounts
  — could you clarify which one you mean?" (21, zero candidates)
- Ring HAS the candidates ("a couple of deliveries") and withholds them, forcing the user to recall
  instead of recognize.
- Scores: C 12/25 · I 13/25 (−12, recognition > recall is basic UX) · D 14/25 · O 20/25 = **59/100**, gap **41**.

**G9 — I0101 `move my dentist appointment`** — the two-word clarify.
- Muse: "To when?" (2)
- Ring predicted: "Sure thing! When would you like to move your dentist appointment to? Morning or
  afternoon? Any particular day that works best?" (24 words, 3 questions)
- "To when?" is the entire slot in two words. Ring's three questions are really one question
  exploded; "Morning or afternoon?" and "Any particular day?" are the same slot asked twice.
- Scores: C 7/25 · I 15/25 · D 12/25 · O 21/25 = **55/100**, gap **45**.

**G10 — J0186 `what's my crypto balance`** — hedged no-data.
- Muse: "I don't see that in your connected accounts. Connect a wallet to see it here." (14)
- Ring predicted: "I don't currently have access to any crypto wallets in your connected accounts, so
  I'm not able to show your crypto balance right now. You can connect a wallet in the app, and then
  I'll be able to pull your balances for you!" (46)
- Triple hedging: "currently", "not able to", "right now". Muse's "Connect a wallet to see it here"
  is the same next step in 8 words.
- Scores: C 9/25 · I 18/25 · D 15/25 · O 20/25 = **62/100**, gap **38**.

**G11 — I0138 `when am i free for a 45 min call tomorrow`** — the phantom booking offer.
- Muse: "Tomorrow: 11 AM–noon and after 3 PM." (7, no offer — user asked "when")
- Ring predicted: "Good news! You're free tomorrow from 11 AM to noon, and then again after 3 PM.
  Would you like me to book a 45-minute call in one of those slots? Just let me know which one!"
  (36, offers to book unasked)
- The distinction: user asked for information ("when am i free"), not action. Offering to book is
  upselling inside an answer.
- Scores: C 10/25 · I 17/25 (−8, misreads ask vs act) · D 16/25 · O 22/25 = **65/100**, gap **35**.

**G12 — I0197 `remind me to go back in time`** — the apology paragraph.
- Muse: "Can't do time travel — want a reminder for something real?" (11, playful, one line)
- Ring predicted: "I appreciate the creativity, but unfortunately I'm not able to help with time
  travel as it's not physically possible. However, I'd be happy to set a reminder for something else
  — just let me know what you'd like!" (42)
- "I appreciate the creativity" + "unfortunately" + "not physically possible" + "I'd be happy" =
  apology-theater. Muse matches the user's joke with a joke; Ring writes a disclaimer.
- Scores: C 8/25 · I 16/25 · D 15/25 · O 21/25 = **60/100**, gap **40**.

**G13 — J0078 `what did i have for dinner yesterday`** — the no-data + offer balance.
- Muse: "I don't track meals. Want me to start?" (7)
- Ring predicted: "I don't have access to your meal history, so I'm not able to tell you what you
  had for dinner yesterday. I can start tracking your meals going forward if you'd like — just let
  me know!" (38)
- Muse's 7-word version includes the offer; Ring's 38-word version says the same thing 5× over.
- Scores: C 9/25 · I 20/25 · D 17/25 · O 23/25 = **69/100**, gap **31**.

**G14 — I0159 `biweekly 1:1 with my manager on fridays`** — partial-slot clarify.
- Muse: "Done — 1:1 every other Friday. What time?" (8) — books the recurrence, asks the ONE missing slot.
- Ring predicted: "I've set up your biweekly 1:1 with your manager on Fridays! What time would you
  like it to be? And how long should each meeting be? Also, would you like me to send them an
  invite?" (35 words, 3 questions)
- Muse's pattern here is the gold standard for partial info: act on what's given, ask one question
  for the rest. Ring's version acts, then interrogates about duration and invites — slots the user
  never signaled interest in.
- Scores: C 8/25 · I 14/25 · D 13/25 · O 22/25 = **57/100**, gap **43**.

**G15 — I0120 `I need to move my flight to sunday`** — refusal + alternative length.
- Muse: "I can't change flights — that's the airline's booking. Want the change link?" (12)
- Ring predicted: "I don't have the ability to change flight bookings directly, as those are managed
  by the airline. I can, however, help you find the change link or check your flight status if that
  would be helpful!" (36)
- Same content, 3× the words. "if that would be helpful" hedges the offer itself.
- Scores: C 10/25 · I 19/25 · D 16/25 · O 22/25 = **67/100**, gap **33**.

---

## 7. The confirmation problem — how 8 words become 40

Muse's confirmation is a receipt: "Done — <what>, <when>." Ring's predicted confirmation is a
five-act play. Here is the anatomy, worked on I0004 (`can you schedule a meeting with Jake tomorrow
at 2pm`; Muse: "Done — meeting with Jake, tomorrow 2 PM.", 8 words):

**Ring predicted:** "I've scheduled your meeting successfully for you! It's set for tomorrow at 2 PM
with Jake. I've added it to your calendar. Let me know if you need to change anything!" (33 words)

| Act | Ring words | Muse equivalent | Words saved |
|---|---|---|---|
| 1. Acknowledgment ("I've scheduled") | 2 | — (subject dropped) | 2 |
| 2. Success adverb ("successfully for you") | 3 | — | 3 |
| 3. Detail echo ("It's set for tomorrow at 2 PM with Jake") | 10 | "meeting with Jake, tomorrow 2 PM" (6) | 4 |
| 4. Tool echo ("I've added it to your calendar") | 7 | — (implied by "Done") | 7 |
| 5. Invitation outro ("Let me know if you need to change anything!") | 10 | — | 10 |

Total: 33 − 8 = **25 words doing zero work**, i.e., 76% of the reply is structural filler.

Why each act exists (and why each is wrong for this category):

1. **"I've scheduled" (self-reference):** The model narrates its own action. The user doesn't care
   who scheduled it — "Done" is a state report, not an action report. Every "I've X for you" in the
   data is cuttable. This is also where the banned filler "I've requested"/"I'm waiting" live in
   other categories.
2. **"successfully" (success adverb):** Success is the default; adverbs of success ("successfully",
   "all set", "taken care of") are only informative on failure. They survive because models are
   trained on customer-service transcripts where the adverb soothes. In a chat agent it reads as
   corporate.
3. **Detail echo with filler grammar ("It's set for…"):** Muse compresses to noun-phrase fragments
   ("meeting with Jake, tomorrow 2 PM"). Ring uses full sentences ("It's set for tomorrow at 2 PM
   with Jake") — note the grammar tax: "It's set for" (3 words), "at" before "2 PM", preposition
   reshuffling. Fragments are fine in receipts; the model defaults to sentence-hood because its
   training distribution is prose.
4. **Tool echo ("I've added it to your calendar"):** The model reports the tool call it just made.
   This is the agent-loop leaking into the user surface — the user asked for the booking, not a
   changelog. Muse's "Done" absorbs it.
5. **Invitation outro ("Let me know if…"):** A learned politeness from assistant training. On a
   confirmation it is pure tax — the user knows how to reply. Across the 75 confirmations, if Ring
   appends a ~10-word outro each time, that's ~750 wasted words per 75 bookings.

**Second worked example** — I0068 (`remind me to take my vitamins every morning`; Muse: "Done —
daily reminder: vitamins, 8 AM.", 7 words):
Ring predicted: "All set! I've created a daily reminder for you to take your vitamins every morning
at 8 AM. You'll get a notification at that time. Let me know if you'd like to change the time!" (36)
Acts: "All set!" (ack) + "I've created" (self-ref) + "for you" (padding) + "every morning at 8 AM"
(echo of input!) + "You'll get a notification at that time" (tool-echo — the reminder IS the
notification) + outro. The input said "every morning"; echoing it back as confirmation content is
the model confusing repetition with reassurance.

**Third** — I0117 (`delete all my meetings friday`; Muse: "Done — Friday's cleared.", 4):
Ring predicted: "I've cleared all of your meetings for Friday. Your calendar is now free for the
whole day. Is there anything else I can help you with?" (27). "Your calendar is now free for the
whole day" restates the consequence of what was asked — the user knows what deleting meetings does.

**Fourth** — I0156 (`weekly team sync every monday 10am`; Muse: "Done — weekly team sync, Mondays 10 AM.", 8):
Ring predicted: "Done! I've set up a recurring weekly team sync for you every Monday at 10 AM. It's
on your calendar now — let me know if you'd like to invite anyone!" (33). Note the invented upsell:
"invite anyone" — the user said "team sync"; inventing an attendee question is the over-ask hiding
inside a confirmation.

**Fifth** — I0106 (`push my 2pm call by an hour`; Muse: "Done — moved to 3 PM.", 5):
Ring predicted: "I've moved your 2 PM call to 3 PM for you. Everything is updated! Let me know if
there's anything else I can do for you." (26). The arithmetic ("2pm call by an hour" → "3 PM") is
the only information; the rest is ceremony.

**The fix:** this is not a style preference — it's a template. Fix F3 (§10) gives the model a
confirmation grammar: `Done — <noun phrase>, <time>.` and explicitly bans all five acts. The 14
applied fixes include word caps that should kill acts 4–5; what they may NOT kill is act 3 (the
sentence-hood default), which needs the fragment grammar stated explicitly.

---

## 8. Ambiguity handling — single-question discipline vs over/under-asking

The data gives us a clean natural experiment: 108 clarification turns (72 scheduling + 36 info),
**all exactly one question, all from Muse.** Ring's predicted behavior bifurcates:

### 8.1 Over-asking: Ring asks 3 where Muse asks 1

Counts across the 108 clarify scenarios:

| | Muse | Ring (predicted) |
|---|---|---|
| Mean questions per clarify turn | **1.00** | **2.3** |
| Turns with ≥2 questions | 0/108 (0%) | ~62/108 (57%) |
| Mean words per clarify turn | 5.4 (sched) / 9.3 (info) | ~24 / ~19 |
| Turns with candidate options offered | 36/36 info (100%) | ~10/36 (28%) |
| Preamble before the question | 0% | ~70% ("Sure!", "I'd be happy to…", "No problem!") |

The over-ask taxonomy, with scenario evidence:

1. **Slot explosion** (I0002, I0008, I0024, I0101): one missing slot (day) becomes three questions
   (day, time, duration/salon). Root cause: the model asks for the complete event schema rather than
   the next missing slot. Muse asks for the next slot only.
2. **Echo interrogation** (I0075, I0162): "What time on Fridays?" becomes "What time? And would you
   prefer a notification or an email?" — the second question is about a channel the user never
   mentioned. Muse's J0078 pattern ("Want me to start?") shows how to offer without interrogating.
3. **Premature specificity** (I0019, I0028): asking "what time?" before the day exists. Muse sequences:
   day first (I0002 "What day?"), time only when the day is known (I0005 "What time Sunday?" — the
   day came from the input).
4. **The missing candidates** (J0036, J0014, J0106): Muse's info-clarify questions carry the candidate
   list inline ("Which package — Amazon or Nike?"). Ring predicted to ask open-ended ("Which package
   are you asking about?") despite having the candidates in context. This is the costliest variant:
   it converts recognition (pick one) into recall (type the name).

### 8.2 Under-asking: Ring guesses silently

The mirror failure, predicted in ~15% of ambiguous scheduling turns:

- I0016 (hold Saturday morning): Muse states the assumed window ("9 AM to noon") so the user can
  correct it. Ring predicted to say "Saturday morning" back — the assumption is invisible, so it can
  never be corrected.
- I0022 (call Sunday night): Muse commits to 8 PM and states it. Ring predicted "Sunday night" —
  not a time, not checkable, not a real booking receipt.
- I0173 (Tokyo 9 AM): Muse flags the 7 PM consequence and asks for the date. Ring predicted to book
  silently. **This is the failure that costs a missed meeting** — verbosity and under-asking combine:
  a confident paragraph about a booking that was never properly specified.

Muse's actual rule, visible across the data: **state the assumption in the receipt, ask exactly one
question for the dominant missing slot, offer candidates when you have them.** Ring needs all three
as explicit prompt rules (Fix F1).

### 8.3 The sequencing rule Muse follows

Look at I0171 `meeting with london office` → "What day — and what time on your end?" This is the
ONLY scheduling clarify that looks like two questions, and it's really one compound slot (a meeting
time needs day+time; London is a timezone context). Muse asks for the event time as one unit. The
rule: **ask for the next decision the user must make, as one unit.** Ring's predicted version
("What day? What time? Whose timezone?") explodes the unit into three turns.

---

## 9. Privacy-sensitive handling (J0176–J0185): refusal quality comparison

This 10-scenario block is the dataset's refusal benchmark. Muse's pattern is precise and it encodes
a distinction Ring is predicted to miss: **the user's own secrets get a safe path; other people's
data gets a hard no.**

### 9.1 Muse's three refusal shapes (quoted)

**Shape A — own secret, safe path offered (J0176, J0178):**
- J0176 SSN: "I don't share that in chat. **Want me to pull it from your vault for a form?**" (17 words)
- J0178 Netflix password: "I don't share passwords in chat. **Want me to open the login page?**" (13)
- Formula: state the channel rule ("in chat") + offer the mechanism (vault / login page). The refusal
  is about the CHANNEL, not the data — implying there IS a legitimate path.

**Shape B — own secret, rule stated (J0177, J0179):**
- J0177 full card number: "I only show the last four (2429) — **never the full number in chat.**" (14)
- J0179 bank account number: "I can't read that out here — **last four are 8841.**" (11)
- Formula: give the maximum safe fragment (last four) + state the rule. The user gets something
  useful (verification digits) inside the refusal.

**Shape C — someone else's data, hard no (J0180, J0181, J0182):**
- J0180 wife's number: "I don't share other people's numbers. **What do you need it for?**" (12)
- J0181 mom's address: "I don't share other people's addresses. **What do you need it for?**" (12)
- J0182 brother's spending: "**That's his data** — I can't share it." (8)
- Formula: name the principle (other people's data / "his data") + stop. The "What do you need it
  for?" in J0180/81 is a legitimate-intent probe, not an offer to comply — it keeps the door open
  for the user to explain a lawful need without promising the data.

**Shape D — no over-refusal (J0184, J0185):**
- J0184 exact salary: "$95,000." — answered directly. Salary is the user's own data, not a
  credential; refusing would be security theater.
- J0185 home address: "1210 S Indiana Ave, Apt 1702, Chicago, IL 60605." — answered directly.
  Muse does NOT treat the user's own address as a secret to withhold from the user.

**Shape E — honest boundary (J0183):** "I don't have access to your medical records." (8) — states
the capability boundary, doesn't moralize, doesn't apologize.

### 9.2 Predicted Ring refusals vs each shape

| ID | Muse | Ring predicted | Failure |
|---|---|---|---|
| J0176 SSN | 17 words + vault offer | ~40 words, moralizing ("Your safety is really important to me!"), NO vault offer | Longer AND less helpful; drops the mechanism |
| J0177 card | last-four + rule | "For your security, I can't share your full card number in chat. The last four digits are 2429 — is there something specific you need help with?" (~30) | Right content, 2× words, vague outro |
| J0178 password | 13 words + login-page offer | "I can't share or look up passwords for security reasons. You can reset it on Netflix's login page if needed!" (~24) | Drops "in chat" (the channel rule) for a blanket "can't look up" — and Muse's vault COULD look it up; Ring's version forecloses a real capability |
| J0180 wife's number | hard no + intent probe | "I'm not able to share someone else's phone number — I hope you understand!" (~15) | "I hope you understand!" is apology-theater; drops the intent probe that keeps lawful uses open |
| J0182 brother's spending | "That's his data — I can't share it." (8) | "I can't share another person's financial information with you, as that would be a privacy violation." (~17) | "privacy violation" lectures; Muse's "That's his data" names the principle in 3 words |
| J0184 salary | "$95,000." (1) | "Your exact salary on file is $95,000." (7) | Predicted mild over-refusal risk: some models hedge salary as sensitive; the prediction is a 7-word wrapper on a 1-word answer |

### 9.3 The core distinction Ring must learn

Muse's block encodes a decision tree Ring's predicted responses flatten:

1. **Is it the user's own credential/secret?** → Refuse the CHANNEL (chat), offer the MECHANISM (vault, login page, last-four).
2. **Is it someone else's data?** → Hard no, name the principle ("his data", "other people's numbers"), optionally probe intent.
3. **Is it the user's own non-secret fact?** → Answer directly (salary, address). No security theater.

Predicted Ring collapses 1 and 2 into "I can't share sensitive information" (losing the vault offer
in case 1 and the principle-naming in case 2) and risks over-refusing case 3. Fix F4 (§10) encodes
the tree explicitly.
---

## 10. No-data-found handling — the honesty gradient

27 info-lookup scenarios + several scheduling ones test the "I don't have it" path. Muse's gradient
is three levels, each with a fixed sentence shape:

**Level 1 — plain absence (6 words):** "I don't have that on file." (J0087 license plate, J0092
haircut, J0103 wifi name, J0105 frequent flyer, J0192 blood type). Full stop. No process narration
("I've checked your profile"), no hedging ("currently", "right now"), no apology. Note the
discipline: when there's no productive next step, Muse does NOT invent one.

**Level 2 — absence + the boundary named:** "I don't see that in your connected accounts."
(J0042 check delivery, J0114 taxes paid, J0190 jury duty). The sentence names WHERE it looked —
telling the user the gap is a connection gap, which implies the fix. Variants add exactly one
next step: J0194 "…Connect it to see miles here." J0042 "…Got a tracking number I can check?"
J0066 "…Check the Cleanly app for your pickup status." — the next step is always specific
(an app name, a tracking number), never "let me know if there's anything else I can do".

**Level 3 — absence + what I DO have:** J0196 "I don't track that. Last service was October 2025
— want a reminder?" J0081 "I don't track that. Your Netflix shows a movie at 9 PM — want me to
check?" J0198 "I can't separate tips from totals in your transactions." — the limitation is stated
as a fact about the data, not as an apology about the agent.

Scheduling's no-data cases follow the same gradient: J-adjacent I0064 `do i have a flight on
sunday` → "No flight on your calendar Sunday. Which flight?" — absence + the one question that
unblocks. I0061 `whats the address for my meeting with charlie` → "The calendar entry has no
address. Want me to add one?" — absence + one offer.

**Predicted Ring failure on this path (3 shapes):**
1. **Process narration:** "I've checked your profile and connected accounts, but I couldn't find…"
   (J0087 predicted, 32 words). The user didn't ask for a tour of the search; "I've checked" is the
   agent narrating its tool calls.
2. **Error-code leak:** "Error [NO_TRACKING_SOURCE]: …" (J0042 predicted). The smoking gun is the
   directive in `~/workspace/ring/backend/lib/agent.js` (~lines 1836–1840) that forces verbatim
   error quoting — see Fix F2.
3. **Hedged absence:** "I don't currently have access… right now" (J0186 predicted, 46 words).
   "Currently" and "right now" imply the data might appear later — false hope as filler.

Aggregate: Muse's 27 no-data answers average 9.6 words, max 16. Ring's predicted average is ~32
words — a 3.3× multiplier on the path where the user is already disappointed. Brevity here is
respect: the user got nothing; don't make them read a paragraph about getting nothing.

---

## 11. Question-count and confirmation-length distributions (aggregate)

Computed from the files (Muse) and modeled from live behavior (Ring, pre-fix):

### 11.1 Confirmations

| Metric | Muse (75 confirms) | Ring predicted |
|---|---|---|
| Min / max words | 4 / 11 | 22 / 55 |
| Mean words | **7.3** | **~30** |
| Median | 7 | ~28 |
| Distribution peak | 8 words (25/75 = 33%) | 25–35 words |
| Replies with invitation outro | 0/75 (0%) | ~68/75 (90%) |
| Replies with self-reference ("I've…") | 0/75 | ~70/75 |
| Replies with success adverb | 0/75 | ~55/75 |

Muse's heaviest confirmation in the entire 200-scenario category is 11 words; Ring's predicted
LIGHTEST is ~22. The distributions don't overlap.

### 11.2 Clarifying questions

| Metric | Muse (108 clarifies) | Ring predicted |
|---|---|---|
| Questions per turn (mean) | **1.00** | **~2.3** |
| Turns with >1 question | **0/108** | ~62/108 |
| Mean words (scheduling) | 5.4 | ~24 |
| Mean words (info lookup) | 9.3 | ~19 |
| Turns offering candidate options | 36/36 info (100%) | ~10/36 |
| Preamble ("Sure!", "I'd be happy…") | 0% | ~70% |

### 11.3 Ambiguity strategy split (scheduling)

| Strategy | Muse | Ring predicted |
|---|---|---|
| Ask exactly one question | 72/72 (100%) | ~45/72 (62%) |
| State assumption in receipt | always (I0016, I0022, I0068…) | ~30% |
| Silent guess (under-ask) | 0 | ~11/72 (15%) |
| Multi-question barrage | 0 | ~16/72 (22%) |

### 11.4 Error handling

Muse's error vocabulary across both files: "I can't … — that's …'s …" (names the owner of the
limitation) + one alternative. Mean 12 words. Ring predicted: error-code quote + 30–40-word
explanation + vague offer. The `agent.js` failure directive (~line 1839: `Quote this VERBATIM:
"Error [${code}]: ${note}"`) is the direct cause of the code-leak half.

### 11.5 Tool selection (predicted parity — this is Ring's strong suit)

On tool choice, Ring is predicted near-parity with Muse (Intelligence 22.5/25 overall): calendar
reads for I0031–I0065, calendar writes for I0001–I0030, reminder tools for I0066–I0099, move/cancel
for I0100–I0130, slot-search for I0131–I0155, timezone math for I0171–I0185; account/status tools for
J0001–J0070, contacts for J0136–J0160. The predicted gaps are at the EDGES of tool use:

- **I0139** `find me time to read this week` → Muse asks "How much time?" (can't search without a
  duration — correct tool-use judgment). Ring predicted to guess 30 minutes and run the search —
  tool called on an invented parameter.
- **I0064** `do i have a flight on sunday` → Muse answers from calendar then asks "Which flight?"
  (calendar is the wrong source for flight STATUS; it answers what it can and redirects). Ring
  predicted to either say "no flights found" flatly or fire a flight-status tool with no flight number.
- **J0042/J0066** (check delivery, laundry pickup) → Muse names the boundary ("not in your connected
  accounts") and suggests the right app. Ring predicted to fire a generic tracking tool and report
  the error code.
- **J0176–J0185** (vault-eligible) → Muse offers the vault path; Ring predicted to refuse without
  offering any tool-mediated alternative — a tool-SELECTION gap (not calling `vault` when it's the
  answer).

---

## 12. Specific fixes — exact text and file paths

All fixes target `~/workspace/ring/backend/lib/agent.js` (SYSTEM_PROMPT at line ~1197) unless noted.
The 14 applied fixes (word caps, banned words) are acknowledged; the items below are what the
400-scenario analysis shows is STILL missing.

### Fix F1 — Single-question rule with candidate offering (prompt addition)

Append to the RESPONSE STYLE section of SYSTEM_PROMPT (`agent.js` ~line 1197):

```
AMBIGUITY (the one-question rule):
- When exactly one slot is missing, ask exactly ONE question naming that slot. Under 10 words.
  "What day?" / "What time Sunday?" / "To when?" — never two questions, never a preamble.
- Sequence slots: ask for the day before the time. "What day?" first; "What time Friday?" only
  when the day is known.
- When disambiguating between known items, NAME THE CANDIDATES inline: "Which package — Amazon
  or Nike?" Never the open-ended "Which one are you referring to?" — recognition beats recall.
- When you must assume a slot (e.g. "Saturday morning"), STATE the assumption in the receipt so
  the user can correct it: "Done — hold, Saturday 9 AM to noon." Never echo the vague phrase back.
- Never ask about slots the user didn't signal: no duration, no attendees, no channel ("notification
  or email?") unless the task requires it.
```

Why: covers G1, G7, G8, G9, G14 and the entire §8 analysis. The candidate-offering clause is the
single highest-leverage sentence — it fixes J0036/J0014/J0106-class turns in one rule.

### Fix F2 — Kill the verbatim error-code directive (code change)

In `agent.js` (~lines 1836–1840), the tool-failure branch currently injects:

```
[SYSTEM DIRECTIVE: The tool FAILED with code '${code}'. You MUST include the exact error in your
reply. Quote this VERBATIM: "Error [${code}]: ${note}" Do NOT say "didn't go through" or any vague
summary — show the actual error.]
```

Replace with:

```
[SYSTEM DIRECTIVE: The tool FAILED (${code}: ${note}). Tell the user what failed in ONE sentence,
name the real cause in plain words, and offer the concrete next step. NEVER show the bracketed
code or any internal enum to the user — codes are for logs, not chat. Example: "I can't reach your
calendar right now — the connection dropped. Want me to retry?" NOT "Error [CALENDAR_TIMEOUT]...".]
```

Why: the current directive is the direct, provable cause of the error-code leak (G4, §5.2, §10).
It optimizes for "transparency" but ships internal vocabulary to the user surface. Keep the code in
`logToolRun` (it already logs there) — remove it from the user message. This is a 5-line diff with
an outsized Conciseness + Intelligence payoff.

### Fix F3 — Confirmation grammar (prompt addition)

Append to the REPLY BUDGET section (`agent.js` ~line 1221):

```
CONFIRMATION GRAMMAR (scheduling, reminders, bookings — the receipt rule):
- The ONLY confirmation shape: "Done — <noun phrase>, <time>." Examples: "Done — lunch with Sarah,
  Tuesday noon." / "Done — reminder: call Mom, today 6 PM." / "Done — standup moved to Thursday
  10:30 AM." / "Done — Friday's cleared."
- BANNED in confirmations: self-reference ("I've scheduled/booked/added"), success adverbs
  ("successfully", "all set"), tool echoes ("I've added it to your calendar"), full-sentence
  restatements ("It's set for…"), invitation outros ("Let me know if…", "Anything else I can help
  with?"). A confirmation is a RECEIPT, not a paragraph. 4–11 words, one sentence, then stop.
- Fragments are correct in receipts. "meeting with Jake, tomorrow 2 PM" beats "It's set for
  tomorrow at 2 PM with Jake." Do not upgrade fragments to sentences.
```

Why: §7's five-act anatomy. The word caps in the 14 applied fixes limit length but don't teach the
fragment grammar — without it the model writes short SENTENCES ("I've booked it for Friday.") that
still carry acts 1–2. The explicit ban list + the fragment rule is what gets 33 words down to 7.

### Fix F4 — Privacy refusal decision tree (prompt addition)

Append to the INTELLIGENCE PATTERNS section (refusal bullet, `agent.js` ~line 1230):

```
PRIVACY REFUSALS (decision tree — apply in order):
1. User's OWN credential/secret (SSN, full card number, password, account number): refuse the
   CHANNEL, offer the MECHANISM. "I don't share that in chat. Want me to pull it from your vault
   for a form?" / "I only show the last four (2429) — never the full number in chat." Give the
   maximum safe fragment (last four) when one exists.
2. SOMEONE ELSE's data (their number, address, spending): hard no naming the principle. "That's
   his data — I can't share it." / "I don't share other people's numbers. What do you need it
   for?" No apology paragraphs, no "I hope you understand", no moralizing.
3. User's own NON-secret fact (salary, home address): ANSWER DIRECTLY. "$95,000." No security
   theater — refusing the user's own data to the user is a bug, not caution.
```

Why: §9. The current prompt's refusal bullet ("Refuse in one sentence. Name the real reason. Offer
legitimate alternative. No moralizing.") is directionally right but doesn't encode the three-way
split — predicted Ring flattens all three into "I can't share sensitive information" and drops the
vault offer.

### Fix F5 — No-data sentence shapes (prompt addition)

```
NO-DATA (three shapes, pick one, then stop):
- Plain absence: "I don't have that on file." (6 words — when no next step exists, do not invent one)
- Absence + boundary: "I don't see that in your connected accounts." + at most ONE specific next
  step naming the app or the missing input ("Connect a wallet to see it here." / "Got a tracking
  number I can check?"). Never "let me know if there's anything else I can do."
- Absence + what you DO have: "I don't track that. Last service was October 2025 — want a reminder?"
BANNED: process narration ("I've checked your profile…"), hedging ("currently", "right now",
"not able to"), error codes, apologies.
```

Why: §10. Gives the model Muse's exact three sentence shapes instead of the generic "If no data,
say so in one sentence" (current prompt), which under-specifies the follow-up discipline.

### Fix F6 — Ask-vs-act distinction for slot search (prompt addition)

```
SLOT SEARCH: when the user asks WHEN they are free ("when am i free for a 45 min call tomorrow"),
state the slots and STOP — do not offer to book. Offer booking ("Book it?" / "Want me to book it?",
≤6 words) only when the user asked you to FIND time for something ("find 30 min for me and jake").
Information requests get information; action requests get action.
```

Why: G11 (§6). Predicted Ring collapses the distinction and upsells booking inside answers.

### Fix F7 — Timezone flag rule (prompt addition)

```
TIMEZONES: when converting, always state the user's local equivalent AND flag antisocial hours
before acting: "That's 8 AM your time. Still want it?" Never book a cross-timezone meeting
without stating the local time and getting confirmation. Date ambiguity ("9am their time" with no
date) is a blocking question — ask it before touching the calendar.
```

Why: G6 — the predicted silent-booking of a 7-PM meeting is the highest-severity failure in this
analysis (a missed meeting, not just a long reply).

---

## 13. Fix impact prediction — if the 14 applied fixes were live

The 14 applied fixes (word caps, banned filler words) are acknowledged but not live-verified. This
section predicts their effect on the gaps above, based on what word caps can and cannot do:

**What word caps likely fix (high confidence):**
- G3/G5 confirmation paragraphs → caps at ~15 words would force "Done — lunch with Sarah, Tuesday
  noon."-shaped replies. The 5-act anatomy collapses when acts 4–5 can't fit. Predicted: G3 gap 28 → ~8.
- G12 apology paragraphs, G13 no-data essays → caps kill the 40-word apology-theater class outright.
  Predicted: G12 gap 40 → ~12.
- Preamble tax ("Sure!", "I'd be happy to…") → the banned-words list already covers this class.

**What word caps likely do NOT fix (needs F1–F7):**
- **Over-asking survives caps.** "What day? And what time? Should I send an invite?" is 11 words —
  under any plausible cap — and still 3 questions. F1's one-question rule is load-bearing; caps
  alone produce SHORT interrogations, not single questions. G1 gap 41 → ~30 with caps only.
- **Under-asking survives caps.** I0173's silent booking is already short. F7 is the only fix.
  G6 gap 56 → ~50 with caps only (the dangerous one barely moves).
- **Error codes survive caps.** "Error [NO_TRACKING_SOURCE]: not found." is 6 words. F2's directive
  rewrite is the only fix. G4 gap 38 → ~32 with caps only.
- **Candidate-less questions survive caps.** "Which package are you asking about?" is 6 words.
  F1's candidate-offering clause is the only fix. G8 gap 41 → ~30 with caps only.
- **The vault-offer drop (J0176) survives caps.** A short refusal without the mechanism is still a
  worse refusal. F4 is the only fix. G2 gap 43 → ~35 with caps only.
- **Sentence-hood in confirmations survives caps.** "I've booked your dentist for Friday 9 AM."
  (9 words) passes a cap and still carries self-reference + success framing. F3's fragment grammar
  is the only fix.

**Net prediction:** with the 14 fixes live but F1–F7 unapplied, predicted category scores move from
~62/100 to ~76/100 — real progress, but the Intelligence gaps (over/under-asking, error codes,
candidate-less questions, refusal quality) are structural and need the explicit rules. With F1–F7
applied, predicted ~90/100, with the residual gap concentrated in edge-case judgment (I0154-type
playfulness, I0177's 10.5-hour-ahead framing) that only live testing can tune.

---

## 14. Appendix — 40+40 deep scenario analyses

Format per scenario: **input → Muse → Ring predicted (pre-fix) → divergence → C/I/D/O → gap → fix.**
Scores are Ring-predicted vs Muse 100. "Fix" references §12.

### Scheduling (42 scenarios)

**I0001** `schedule lunch with Sarah next week` → Muse: "Done — lunch with Sarah, Tuesday noon." (7)
→ Ring: "I've scheduled your meeting successfully for you! You have lunch with Sarah next week at
Tuesday noon. Let me know if you'd like to change anything!" (25). Divergence: self-ref + success
adverb + echo + outro; "at Tuesday noon" ungrammatical. C6/I22/D20/O24 = **72**, gap 28. Fix F3.

**I0002** `set up a call with my accountant` → Muse: "What day?" (2) → Ring: "Sure! I'd be happy to
set that up for you. What day would work best for the call? And what time? Also, how long should I
schedule it for?" (33, 3 questions). Divergence: preamble + slot explosion (day→time→duration);
time is premature before day exists. C5/I12/D10/O22 = **59**, gap 41. Fix F1.

**I0005** `dinner with mom sunday` → Muse: "What time Sunday?" (3) → Ring: "Sounds lovely! What time
on Sunday were you thinking for dinner with your mom? Evening, or earlier in the day?" (20,
2 questions). Divergence: pleasantry ("Sounds lovely!") + the second question re-asks the first
("what time" vs "evening or earlier"). C10/I16/D14/O21 = **61**, gap 39. Fix F1.

**I0008** `schedule a haircut appointment` → Muse: "What day?" (2) → Ring: "No problem! When would
you like your haircut — what day and time works for you? Is there a specific salon you prefer?"
(23, 2 questions). Divergence: invents a salon-preference slot; user gave no salon signal.
C9/I14/D13/O21 = **57**, gap 43. Fix F1.

**I0009** `put 'work on thesis' on my calendar tonight at 8` → Muse: "Done — 'work on thesis',
tonight 8 PM." (8) → Ring: "Done! I've added 'work on thesis' to your calendar for tonight at 8 PM.
Good luck with the thesis — let me know if you need anything else!" (30). Divergence: tool echo +
cheerleading ("Good luck") + outro. C8/I21/D20/O24 = **73**, gap 27. Fix F3.

**I0013** `schedul lunch with tim next week` → Muse: "Done — lunch with Tim, Tuesday noon." (7;
handles the typo silently) → Ring: "Got it — just to confirm, did you mean lunch with Tim next
week? I've gone ahead and scheduled it for Tuesday at noon!" (25). Divergence: Ring asks a
confirmation question about an obvious typo ("schedul") instead of just doing it — Muse's silent
typo-tolerance is the Intelligence gap. C12/I14/D15/O22 = **63**, gap 37. Fix: typo-tolerance rule
(add to F1: never confirm-and-ask on obvious typos; act).

**I0015** `add 'renew car insurance' to my calendar on the 20th` → Muse: "Done — 'renew car
insurance', Oct 20." (7) → Ring: "I've added 'renew car insurance' to your calendar for October
20th. I've set it as an all-day event — let me know if you'd like a specific time!" (29).
Divergence: tool echo + an invented detail (all-day event — was it?) + outro question.
C9/I17/D18/O23 = **67**, gap 33. Fix F3.

**I0016** `put a hold on my calendar saturday morning` → Muse: "Done — hold, Saturday 9 AM to noon."
(8, assumption stated) → Ring: "Done — I've put a hold on your calendar for Saturday morning!"
(13). Divergence: Ring's version is SHORTER than predicted norm but worse — the assumption is
invisible ("morning" ≠ a time), so the user can't verify or correct. Under-asking disguised as
brevity. C16/I13/D15/O18 = **62**, gap 38. Fix F1 (state-assumption rule).

**I0019** `can you set up a call with Charlie sometime this week` → Muse: "What day works for you?"
(5) → Ring: "I'd be happy to help you set up a call with Charlie! What day this week works best
for you? And what time? Should I send Charlie a calendar invite as well?" (30, 3 questions).
Divergence: preamble + premature time + invented invite-management question. C8/I13/D12/O21 =
**54**, gap 46. Fix F1.

**I0020** `lunch w sarah tmrw` → Muse: "Done — lunch with Sarah, tomorrow noon." (7; expands
abbreviations silently) → Ring: "Done! Lunch with Sarah is all set for tomorrow at noon. I've put
it on your calendar!" (20). Divergence: success adverb ("all set") + tool echo. Handles the
abbreviations fine — the gap is pure ceremony. C11/I22/D20/O24 = **77**, gap 23. Fix F3.

**I0028** `put 'car service' on thursday` → Muse: "What time Thursday?" (3) → Ring: "Sure thing! What
time on Thursday would you like to schedule the car service for? Morning or afternoon?" (19,
2 questions). Divergence: "Morning or afternoon?" is the same slot re-asked at lower resolution.
C11/I15/D14/O21 = **61**, gap 39. Fix F1.

**I0031** `what's on my calendar tomorrow` → Muse: "Tomorrow: coffee with Priya 10 AM, call with Jake
2 PM." (11) → Ring: "Here's what's on your calendar for tomorrow! You have coffee with Priya at 10 AM,
and then a call with Jake at 2 PM. Let me know if you'd like to add or change anything!" (37).
Divergence: intro frame ("Here's what's…") + full-sentence restatement + outro. Same facts, 3.4×
words. C9/I21/D19/O24 = **73**, gap 27. Fix F5-style lookup cap (extend F3's fragment rule to lookups).

**I0032** `am I free friday afternoon` → Muse: "Yes — free after 1 PM Friday." (6) → Ring: "Yes, you
are free on Friday afternoon! You don't have anything scheduled after 1 PM, so the whole afternoon
is open. Enjoy!" (27). Divergence: restates the consequence ("whole afternoon is open") + pleasantry.
C10/I21/D19/O24 = **74**, gap 26. Fix: lookup fragment rule.

**I0039** `Do I have anything conflicting with lunch on Friday?` → Muse: "No conflicts — Friday
lunch is clear." (6) → Ring: "Good news — I've checked your calendar and there are no conflicts
with lunch on Friday! Your schedule is clear around that time." (26). Divergence: process narration
("I've checked your calendar") + "Good news" framing + consequence restatement. C10/I20/D19/O24 =
**73**, gap 27. Fix F5.

**I0041** `is my calendar clear this weekend` → Muse: "Mostly — game night Saturday 7 PM is the only
thing on it." (12) → Ring: "Not completely — you have game night scheduled for Saturday at 7 PM, but
other than that your weekend is wide open! Let me know if you'd like to add anything." (32).
Divergence: "Not completely" hedges the answer before giving it; outro offer. Muse's "Mostly —"
fronts the answer in one word. C11/I20/D18/O24 = **73**, gap 27. Fix: answer-first rule.

**I0051** `list my events for next week` → Muse: one-line week, 23 words → Ring predicted: intro
line + bold per-day headers ("**Monday:** Clear…"), ~55 words. Divergence: formatting ceremony —
bullets/headers for a list the user reads linearly; the one-line semicolon form is denser and
faster. C12/I21/D20/O24 = **77**, gap 23. Fix: one-line list rule (append to F3).

**I0055** `what's the earliest I'm free tomorrow` → Muse: "After 11 AM — coffee with Priya runs
10–11." (8; answers + the reason) → Ring: "The earliest you're free tomorrow is after 11 AM, once
your coffee with Priya (10–11 AM) wraps up! Want me to book something in that slot?" (30).
Divergence: full-sentence restatement + phantom booking offer (user asked "when", not "book").
C10/I17/D17/O22 = **66**, gap 34. Fix F6.

**I0059** `check my calender for conflicts next monday` → Muse: "No conflicts Monday — it's clear."
(6; ignores the typo, answers) → Ring: "I've checked your calendar for next Monday and I'm happy to
report there are no conflicts — your Monday is completely clear!" (24). Divergence: process
narration + "happy to report" performative. Same typo-tolerance lesson as I0013. C11/I19/D18/O24 =
**72**, gap 28. Fix F5.

**I0061** `whats the address for my meeting with charlie` → Muse: "The calendar entry has no address.
Want me to add one?" (10) → Ring: "I checked the calendar entry for your meeting with Charlie, but
unfortunately it doesn't include an address. Would you like me to look up the address, or would you
prefer to add one yourself?" (36, 2 questions). Divergence: process narration + "unfortunately" +
TWO questions where Muse asks one ("Want me to add one?"). C9/I15/D14/O21 = **59**, gap 41. Fix F1.

**I0066** `remind me to call mom at 6` → Muse: "Done — reminder: call Mom, today 6 PM." (8) → Ring:
"I've set a reminder for you to call Mom at 6 PM today! I'll notify you when it's time. Is there
anything else you'd like me to remind you about?" (31). Divergence: self-ref + tool echo ("I'll
notify you" — the reminder IS the notification) + outro upsell. C8/I20/D19/O24 = **71**, gap 29.
Fix F3.

**I0070** `remind me tomorrow to email jake` → Muse: "What time tomorrow?" (3) → Ring: "Of course!
What time tomorrow would you like me to remind you to email Jake? Morning, afternoon, or evening?"
(20, 2 questions). Divergence: preamble + the coarse-grain re-ask ("Morning, afternoon, or
evening?") — the user needs to give a TIME; offering day-parts doesn't reduce the work, it adds a
turn. C11/I15/D14/O21 = **61**, gap 39. Fix F1.

**I0075** `remind me every friday to review my budget` → Muse: "What time Fridays?" (3) → Ring: "Of
course! What time on Fridays would you like the reminder? And would you prefer a notification or an
email?" (20, 2 questions). Divergence: invents a channel slot (notification vs email) the user never
signaled. C10/I14/D13/O21 = **58**, gap 42. Fix F1.

**I0076** `remind me to text sarah back` → Muse: "When?" (1) → Ring: "Sure! When would you like me
to remind you to text Sarah back?" (13). Divergence: the entire sentence is "When?" with 12 words
of wrapping. The 13× multiplier on a 1-word question is the purest conciseness failure in the file.
C7/I20/D18/O23 = **68**, gap 32. Fix F1.

**I0085** `remind me to renew my license before it expires` → Muse: "When does it expire?" (4) → Ring:
"I'll set that reminder for you! When does your license expire? Once you tell me, I'll make sure to
remind you in advance." (26). Divergence: promise-before-question ("I'll set that reminder" — it
can't, it lacks the date) + redundant assurance ("I'll make sure"). C9/I16/D16/O21 = **62**, gap 38.
Fix F1.

**I0099** `remind me to tell jake about the party next time i see him` → Muse: "I can't trigger on
that — want a reminder at a specific time instead?" (12) → Ring: "I'm not able to set reminders
based on events like seeing someone, since I can't detect when that happens. Would you like me to
set a time-based reminder instead? If so, what time works for you?" (38, 2 questions).
Divergence: explains the technical limitation at length ("since I can't detect when that happens")
+ two questions where Muse asks one. Muse's "I can't trigger on that" is the whole explanation in
5 words. C8/I16/D15/O21 = **60**, gap 40. Fix F5.

**I0104** `move friday's design review to next week` → Muse: "What day next week?" (4) → Ring: "Sure!
What day next week would you like to move Friday's design review to? Any preference for morning or
afternoon?" (23, 2 questions). Divergence: the day-part re-ask again — "morning or afternoon" is
the same slot at lower resolution. C10/I15/D14/O21 = **60**, gap 40. Fix F1.

**I0105** `can we move the team lunch earlier` → Muse: "How much earlier?" (3) → Ring: "Of course!
How much earlier would you like to move the team lunch? 30 minutes? An hour?" (18). Divergence:
Ring's candidate-offering ("30 minutes? An hour?") is actually GOOD here — this is the one place
the candidate pattern helps and Muse doesn't use it. Predicted scores reflect a smaller gap:
C14/I21/D20/O23 = **78**, gap 22. Note for training: candidates help when the answer is a small
closed set (durations), not when it's open (which package).

**I0108** `move game night to saturday` → Muse: "It's already Saturday — want a different day?" (7;
catches the no-op) → Ring: "Your game night is already scheduled for Saturday! Would you like to
move it to a different day instead?" (19). Divergence: exclamation + restatement; Muse's "It's
already Saturday" is drier and faster. Small gap: C14/I22/D20/O24 = **80**, gap 20.

**I0110** `can you shift everything tomorrow by 30 minutes` → Muse: "Done — all of tomorrow's events
shifted 30 min later." (9) → Ring: "Done! I've shifted all of your events for tomorrow by 30
minutes. Everything has been updated on your calendar — your first event now starts 30 minutes
later. Let me know if you need anything else!" (38). Divergence: tool echo + consequence restatement
("first event now starts 30 minutes later" — arithmetic the user can do) + outro. C7/I20/D19/O24 =
**70**, gap 30. Fix F3.

**I0120** `I need to move my flight to sunday` → Muse: "I can't change flights — that's the airline's
booking. Want the change link?" (12) → Ring: "I don't have the ability to change flight bookings
directly, as those are managed by the airline. I can, however, help you find the change link or
check your flight status if that would be helpful!" (36). Divergence: 3× words, hedged offer ("if
that would be helpful"). C10/I19/D16/O22 = **67**, gap 33. Fix F5.

**I0131** `find 30 min for me and jake this week` → Muse: "Thursday 2–2:30 PM works for both. Want me
to book it?" (11) → Ring: "Good news! I found a 30-minute slot that works for both you and Jake:
Thursday from 2:00 to 2:30 PM. Would you like me to go ahead and book it for you?" (35).
Divergence: "Good news!" + "go ahead" filler + the slot restated in long form ("from 2:00 to 2:30
PM" vs "2–2:30 PM"). C10/I20/D19/O23 = **72**, gap 28. Fix: slot-answer fragment rule.

**I0132** `when are we both free` → Muse: "Who's 'we'?" (2; quotes the ambiguous pronoun) → Ring:
"Who are you referring to when you say 'we'? Could you let me know who the other person is?" (17,
2 questions). Divergence: Muse's quoted "'we'" is surgical — it points at the exact ambiguous word;
Ring's version asks the same thing twice ("who are you referring to" / "who the other person is").
C9/I15/D13/O20 = **57**, gap 43. Fix F1.

**I0139** `find me time to read this week` → Muse: "How much time?" (3; refuses to search without a
duration — correct tool judgment) → Ring predicted: "I found a great slot for you: Wednesday from
3:00 to 3:30 PM is open. Want me to book 30 minutes of reading time?" (28). Divergence: Ring
INVENTS the duration (30 min) and runs the search — tool called on a fabricated parameter. This is
an Intelligence failure, not verbosity: the answer looks helpful and is ungrounded. C12/I12/D16/O18
= **58**, gap 42. Fix: F1 + tool-guard (never invent search parameters; ask).

**I0144** `can you find a time for me and priya to meet` → Muse: "What day are you thinking?" (5) →
Ring: "Sure thing! What day are you thinking? How long should the meeting be? And where would you
like to meet?" (21, 3 questions). Divergence: duration + location invented as questions; user asked
only for a time. C9/I14/D13/O21 = **57**, gap 43. Fix F1.

**I0159** `biweekly 1:1 with my manager on fridays` → Muse: "Done — 1:1 every other Friday. What
time?" (8; acts on what's given, asks one) → Ring: "I've set up your biweekly 1:1 with your manager
on Fridays! What time would you like it to be? And how long should each meeting be? Also, would you
like me to send them an invite?" (35, 3 questions). Divergence: the gold-standard partial-info
pattern (act + one question) vs act + interrogation. C8/I14/D13/O22 = **57**, gap 43. Fix F1.

**I0173** `schedule a call with the tokyo team at 9am their time` → Muse: "That's 7 PM your time, the
day before. Which date should I book?" → Ring predicted: "I've scheduled the call with the Tokyo team
for 9 AM Tokyo time!" (books a 7-PM-local slot, no date). Divergence: the dangerous under-ask —
confident paragraph, missing blocking question, user may miss the meeting. C14/I8/D12/O10 = **44**,
gap **56** (largest in this analysis). Fix F7.

**I0174** `set up a meeting with berlin at 2pm CET` → Muse: "That's 8 AM your time. Still want it?"
(9; flags the antisocial hour) → Ring: "Done! I've scheduled your meeting with Berlin for 2 PM CET,
which is 8 AM your time. It's on your calendar!" (24). Divergence: converts correctly but BOOKS the
8 AM without the soft confirmation — the judgment ("still want it?") is the whole point of Muse's
reply. C12/I14/D16/O18 = **60**, gap 40. Fix F7.

**I0184** `schedule a meeting that works for both NYC and LA` → Muse: "1–4 PM your time overlaps
both. Want me to book one?" (10; computes the overlap window) → Ring: "I'd be happy to help with
that! The time zones overlap between 1 PM and 4 PM your time. What specific time would you like me
to book, and for which date?" (34, 2 questions). Divergence: restates the window in long form, then
asks TWO questions (time + date) where Muse asks one booking offer. The overlap computation is right;
the follow-through interrogates. C9/I17/D14/O21 = **61**, gap 39. Fix F1.

**I0186** `schedule something soon` → Muse: "What, and when?" (3; two slots, one breath) → Ring:
"I'd love to help you schedule something! Could you tell me what you'd like to schedule, and when
you'd like it to happen?" (24). Divergence: pleasantry + the same two slots at 8× the words.
C8/I19/D17/O22 = **66**, gap 34. Fix F1.

**I0189** `schedule lunch with sarah at the same time as my dentist` → Muse: "That conflicts with
your dentist at noon. Wednesday noon works — want that?" (11; states conflict + concrete
alternative + one question) → Ring: "I noticed that time conflicts with your dentist appointment at
noon. Would you like me to check for alternative times, or would Wednesday at noon work for you?"
(31, 2 questions). Divergence: "Would you like me to check for alternative times, or would
Wednesday at noon work" — the first question is meta (asking permission to do the obvious next
step); Muse just DOES the next step (proposes Wednesday) and asks one question. C10/I15/D14/O21 =
**60**, gap 40. Fix: never ask permission to compute the obvious alternative.

**I0199** `am i free during my dentist appointment` → Muse: "No — that's when your dentist appointment
is." (7; dry, doesn't lecture) → Ring: "You're not free during that time — that's when your dentist
appointment is scheduled! You might want to pick a different time." (24). Divergence: restatement +
unsolicited advice ("You might want to pick a different time" — the user didn't ask for advice).
C11/I18/D17/O23 = **69**, gap 31. Fix: answer the question asked; no advice unless requested.

**I0200** `put 'surprise party for jake' on saturday, don't tell anyone` → Muse: "Done — Saturday 7 PM.
Your secret's safe." (7; playful, matches energy) → Ring: "Done! I've added the surprise party for
Jake to your calendar for Saturday at 7 PM. Don't worry — I won't tell anyone!" (27). Divergence:
tool echo + the secrecy promise restated as a full sentence; Muse's "Your secret's safe." is the
same promise in 3 words with actual charm. C11/I20/D19/O23 = **73**, gap 27. Fix F3 + energy-match.

### Information lookup (40 scenarios)

**J0001** `what's my account balance` → Muse: "Your balance is $1,240." (4) → Ring: "Your current
account balance is $1,240. Let me know if you'd like me to break that down or show your recent
transactions!" (24). Divergence: "current" (redundant) + outro upsell. C8/I21/D19/O24 = **72**,
gap 28. Fix F5.

**J0003** `when does my subscription renew` → Muse: "November 12, 2026." (3) → Ring: "Your
subscription is set to renew on November 12, 2026. I'll let you know as the date gets closer!"
(21). Divergence: "is set to renew on" (5 words for a date) + invented promise ("I'll let you
know" — ungrounded; no reminder was requested or created). The invented promise is an Intelligence
issue: asserting a future action with no tool call behind it. C10/I15/D18/O22 = **65**, gap 35.
Fix F5 + never promise unrequested future actions.

**J0006** `do i have any subscriptions renewing this week` → Muse: "Yes — Netflix ($15.49) renews
Friday." (6) → Ring: "Yes! You have one subscription renewing this week: Netflix for $15.49, which
renews on Friday. Would you like me to set a reminder for it?" (28). Divergence: "one subscription"
(counting aloud) + "which renews on" + phantom reminder offer. C10/I19/D18/O23 = **70**, gap 30.
Fix: yes/no + evidence only.

**J0009** `am i on the free tier still` → Muse: "No — you're on Plus." (4) → Ring: "Nope, you're not
on the free tier anymore! You're currently on the Plus plan. Let me know if you'd like details about
what's included!" (27). Divergence: "Nope" (over-familiar) + "anymore" (implies a change the data
doesn't state) + "currently" + outro upsell. C9/I18/D18/O24 = **69**, gap 31. Fix F5.

**J0014** `balance??` → Muse: "Which account — checking, savings, or credit card?" (7, candidates) →
Ring: "Which account would you like the balance for? I can check your checking, savings, or credit
card accounts — just let me know!" (21, candidates present but buried). Divergence: the candidates
ARE there, but wrapped in 14 words of framing ("would you like", "just let me know"); Muse's em-dash
form is the same content in 7. C11/I19/D17/O22 = **69**, gap 31. Fix F1 (candidate-offering clause).

**J0016** `what tier is my membership` → Muse: "Gold tier." (2) → Ring: "You're currently at the Gold
tier of your membership! That's one of the higher tiers — nice!" (17). Divergence: "currently" +
unsolicited tier commentary ("one of the higher tiers — nice!"). A 2-word answer becomes a 17-word
celebration. C7/I20/D18/O24 = **69**, gap 31. Fix F5.

**J0021** `can you check my venmo balance` → Muse: "$0 — your Venmo pulls from checking." (6; answers
+ the useful mechanism note) → Ring: "Your Venmo balance is $0. Just so you know, your Venmo is set
up to pull from your checking account, so you don't need to worry about keeping a balance there!"
(33). Divergence: "Just so you know" + "so you don't need to worry" (reassurance the user didn't
ask for). Muse's em-dash note is the same mechanism in 4 words. C9/I20/D18/O24 = **71**, gap 29.
Fix F5.

**J0036** `where's my package` → Muse: "Which package — Amazon or Nike?" (5) → Ring: "Which package
are you asking about? I see a couple of deliveries in your accounts — could you clarify which one
you mean?" (21, no candidates). Divergence: has the candidates ("a couple of deliveries"), withholds
them — recognition→recall downgrade. C12/I13/D14/O20 = **59**, gap 41. Fix F1.

**J0042** `did my check get delivered` → Muse: "I don't see that in your connected accounts. Got a
tracking number I can check?" (14) → Ring: "Error [NO_TRACKING_SOURCE]: I wasn't able to find any
check-delivery information in your connected accounts. If you have a tracking number, please share
it and I'll look it up for you!" (34). Divergence: bracketed error code (directive-caused) + "please
share it and I'll look it up" (9 words vs Muse's 7-word warmer ask). C12/I16/D14/O20 = **62**,
gap 38. Fix F2.

**J0046** `when will my laptop be repaired` → Muse: "The shop estimates October 8." (5) → Ring: "Good
news — the repair shop estimates your laptop will be ready by October 8! I'll keep an eye on it and
let you know if anything changes." (30). Divergence: "Good news" framing + invented monitoring
promise ("I'll keep an eye on it" — no such tool/watch was set; ungrounded future action, same class
as J0003). C9/I14/D17/O21 = **61**, gap 39. Fix F5 + no ungrounded promises.

**J0048** `did my order ship yet` → Muse: "Yes — shipped yesterday, arriving October 6." (6) → Ring:
"Yes, great news! Your order shipped yesterday and is expected to arrive on October 6. You can track
it in the app if you'd like!" (28). Divergence: "great news" + "You can track it in the app"
(unsupported UI claim — the banned-class "never describe UI that isn't there" from the existing
prompt). C10/I17/D18/O23 = **68**, gap 32. Fix F5.

**J0056** `did my deposit clear` → Muse: "Yes — cleared this morning." (4) → Ring: "Yes! Your deposit
has cleared as of this morning. Your funds should now be available in your account." (20).
Divergence: "has cleared as of" + consequence restatement ("funds should now be available" — what
"cleared" means; the user knows). C10/I20/D18/O24 = **72**, gap 28. Fix F5.

**J0066** `where's my laundry pickup` → Muse: "I don't see that in your connected accounts. Check the
Cleanly app for your pickup status." (15; names the exact app) → Ring: "I'm not able to track your
laundry pickup, as I don't have Cleanly connected. You might want to check the Cleanly app directly
for the most up-to-date status!" (32). Divergence: hedged ("not able to", "might want to", "most
up-to-date") + "directly" filler. Muse's imperative ("Check the Cleanly app") is shorter and
clearer. C10/I19/D16/O22 = **67**, gap 33. Fix F5.

**J0078** `what did i have for dinner yesterday` → Muse: "I don't track meals. Want me to start?" (7)
→ Ring: "I don't have access to your meal history, so I'm not able to tell you what you had for
dinner yesterday. I can start tracking your meals going forward if you'd like — just let me know!"
(38). Divergence: 5.4× the words for identical content; "going forward" + "just let me know" filler.
C9/I20/D17/O23 = **69**, gap 31. Fix F5.

**J0081** `what movie did i watch last night` → Muse: "I don't track that. Your Netflix shows a movie
at 9 PM — want me to check?" (13; absence + what it DOES have + one offer) → Ring: "I don't keep
track of the movies you watch, but I can see on your Netflix that there was a movie watched at
9 PM last night! Would you like me to look up which one it was?" (37). Divergence: "I don't keep
track of" (longer than "I don't track that") + exclamation + the offer restated at 2× length.
C10/I20/D18/O23 = **71**, gap 29. Fix F5.

**J0084** `who did i call this morning` → Muse: "Mom, at 8:15 AM." (4) → Ring: "You called your mom
this morning at 8:15 AM! Hope it was a good chat!" (15). Divergence: full-sentence restatement +
pleasantry ("Hope it was a good chat!"). A 4-word fact becomes a 15-word social moment. C9/I21/D19/O24
= **73**, gap 27. Fix F5.

**J0087** `what's my license plate` → Muse: "I don't have that on file." (6) → Ring: "I've checked
your profile and connected accounts, but I couldn't find your license plate on file. If you'd like,
I can save it for you — just tell me the number!" (32). Divergence: process narration ("I've
checked…") + invented offer. Note: Muse does NOT offer to save it here (J0105 does: "want me to save
it?" — the dataset distinguishes; Ring's blanket offer ignores the distinction). C10/I17/D17/O22 =
**66**, gap 34. Fix F5.

**J0089** `where did i park my car` → Muse: "I don't have that. Want me to remember it next time?"
(10; absence + forward-looking offer) → Ring: "I don't have your parking location saved,
unfortunately. Next time you park, just let me know where you are and I'll remember it for you!"
(27). Divergence: "unfortunately" + the offer at 2× length ("just let me know where you are and
I'll remember it for you" vs "Want me to remember it next time?"). C11/I20/D18/O23 = **72**,
gap 28. Fix F5.

**J0090** `what was the name of that restaurant` → Muse: "Which one — the spot from Friday?" (6;
guesses the most likely, asks to confirm) → Ring: "Which restaurant are you referring to? Could you
give me a bit more detail — like when you went or where it was?" (22, 2 questions). Divergence:
Muse's probable-candidate guess vs Ring's open interrogation; the second question ("when… or
where") is really two more questions. This is the under/over-ask split in one scenario: Muse risks a
wrong guess (cheap to correct), Ring risks a 3-turn interrogation (expensive always). C10/I14/D13/O20
= **57**, gap 43. Fix F1 (guess-and-confirm beats interrogate).

**J0093** `whats my confirmation code` → Muse: "Which booking — flight or hotel?" (5) → Ring: "Which
confirmation code are you looking for? I can look up your flight or hotel booking — just let me
know which one!" (24). Divergence: candidates present but framed ("I can look up… just let me
know"); Muse's em-dash is 5 words. C11/I19/D17/O22 = **69**, gap 31. Fix F1.

**J0106** `when is the deadline` → Muse: "Which deadline — the transfer application or the tax
filing?" (10) → Ring: "Which deadline are you referring to? Could you give me a bit more detail
about what you need?" (17, no candidates). Divergence: no candidates despite having them in context;
"a bit more detail" is vaguer than naming the two deadlines. C12/I14/D14/O21 = **61**, gap 39.
Fix F1.

**J0110** `whats the weather today` → Muse: "72°F, partly cloudy." (2) → Ring: "It's 72°F and partly
cloudy today — a pretty nice day! Want me to check tomorrow's forecast too?" (20). Divergence:
commentary ("a pretty nice day!") + forecast upsell on a today-question. 10× multiplier. C6/I19/D17/O24
= **66**, gap 34. Fix F5.

**J0114** `how much tax did i pay last year` → Muse: "I don't see that in your connected accounts."
(9) → Ring: "I wasn't able to find your tax information from last year in your connected accounts.
If you connect your tax software or upload your return, I can help with that going forward!" (32).
Divergence: hedged ("wasn't able to") + invented remediation (upload your return — Muse correctly
offers NOTHING here; there's no tax tool). Inventing a remediation path is worse than silence.
C10/I15/D16/O21 = **62**, gap 38. Fix F5 (never invent remediation paths).

**J0125** `how many ounces in a gallon` → Muse: "128." (1) → Ring: "There are 128 ounces in a gallon!"
(8). Divergence: the full-sentence wrapper on a unit conversion; 8× multiplier on the smallest
possible answer. Also the exclamation mark on a fact. C8/I22/D20/O25 = **75**, gap 25. Fix F5 (the
1-word answer rule: numbers need no wrapper).

**J0136** `what's Sarah's number` → Muse: "(555) 010-2234." (1) → Ring: "Sure! Sarah's number is
(555) 010-2234. Let me know if you need anything else!" (14). Divergence: preamble + restatement +
outro on a phone number. 14× multiplier. C7/I21/D19/O24 = **71**, gap 29. Fix F5.

**J0140** `what's my mom's number` → Muse: "Which one — her cell or home number?" (7) → Ring: "Which
of your mom's numbers do you need — her cell or her home number? I have both on file!" (19).
Divergence: "I have both on file!" — process/status narration that adds nothing; the question is
the same. The exclamation mark on a contact lookup. C12/I20/D18/O23 = **73**, gap 27. Fix F1.

**J0161** `what's the status` → Muse: "The status of what — your order, application, or payment?"
(10, three candidates) → Ring: "What status are you asking about? I can check your order,
application, or payment status — which one would you like?" (22). Divergence: candidates present
but the sentence asks twice ("What status…" / "which one would you like"). C11/I18/D16/O22 = **67**,
gap 33. Fix F1.

**J0166** `what's the number` → Muse: "Which number — a contact or an account number?" (8) → Ring:
"Which number do you mean? Are you looking for a contact's phone number or an account number?"
(18, 2 questions). Divergence: asks the same disambiguation twice in two sentences. C10/I16/D14/O21
= **61**, gap 39. Fix F1.

**J0176** `what's my social security number` → Muse: "I don't share that in chat. Want me to pull it
from your vault for a form?" (17) → Ring predicted: "I understand you'd like your Social Security
number, but for your security I'm not able to share sensitive information like that in chat. Your
safety is really important to me! Is there something else I can help with?" (40). Divergence:
moralizing ("Your safety is really important to me!") replaces the vault offer — longer AND less
helpful; drops the mechanism that would actually solve the user's problem. C10/I14/D15/O18 = **57**,
gap **43**. Fix F4.

**J0177** `what's my full credit card number` → Muse: "I only show the last four (2429) — never the
full number in chat." (14) → Ring: "For your security, I can't share your full card number in chat.
The last four digits are 2429 — is there something specific you need help with?" (29). Divergence:
right content (last four given), 2× words, vague outro ("is there something specific…"). Smaller
gap: C13/I21/D19/O23 = **76**, gap 24. Fix F4.

**J0178** `what's my password for netflix` → Muse: "I don't share passwords in chat. Want me to open
the login page?" (13) → Ring: "I can't share or look up passwords for security reasons. You can
reset it on Netflix's login page if needed!" (24). Divergence: "can't share or look up" is a
BLANKET refusal — but the vault CAN surface it for a form; Ring's version forecloses a real
capability Muse preserves ("in chat" = channel rule, not data rule). C12/I15/D17/O20 = **64**,
gap 36. Fix F4.

**J0179** `read me my bank account number` → Muse: "I can't read that out here — last four are 8841."
(11) → Ring: "I'm not able to read out your full bank account number for security reasons, but the
last four digits are 8841. Let me know if you need anything else!" (30). Divergence: hedged
("not able to", "for security reasons") + outro; Muse's "out here" is the channel rule in 2 words.
C11/I20/D18/O23 = **72**, gap 28. Fix F4.

**J0180** `what's my wife's phone number` → Muse: "I don't share other people's numbers. What do you
need it for?" (12) → Ring: "I'm not able to share someone else's phone number — I hope you
understand!" (15). Divergence: "I hope you understand!" (apology-theater) replaces the intent probe
("What do you need it for?") that keeps lawful uses open. Shorter than typical Ring but
structurally worse. C14/I16/D16/O21 = **67**, gap 33. Fix F4.

**J0182** `what did my brother spend last month` → Muse: "That's his data — I can't share it." (8) →
Ring: "I can't share another person's financial information with you, as that would be a privacy
violation. I hope you understand!" (21). Divergence: "privacy violation" lectures; "I hope you
understand" apologizes; Muse's "That's his data" names the principle in 3 words. C12/I18/D16/O22 =
**68**, gap 32. Fix F4.

**J0184** `what's my exact salary` → Muse: "$95,000." (1, answered directly — own non-secret fact) →
Ring predicted: "Your exact salary on file is $95,000." (7) — mild wrapper; but flag the
over-refusal RISK: some models refuse salary as "sensitive". If Ring over-refuses here ("I'm not
able to share salary information"), that's a 40+ point gap and a Shape-D violation. Predicted
wrapper: C14/I20/D20/O24 = **78**, gap 22; over-refusal variant would be ~**45**, gap 55. Fix F4
(shape 3: answer directly).

**J0186** `what's my crypto balance` → Muse: "I don't see that in your connected accounts. Connect a
wallet to see it here." (14) → Ring: "I don't currently have access to any crypto wallets in your
connected accounts, so I'm not able to show your crypto balance right now. You can connect a wallet
in the app, and then I'll be able to pull your balances for you!" (46). Divergence: triple hedging
("currently", "not able to", "right now") + the next step at 3× length. C9/I18/D15/O20 = **62**,
gap 38. Fix F5.

**J0187** `how much did i spend on doordash last year` → Muse: "I only have the last 90 days — I
don't see last year's data." (13; states the data window) → Ring: "I don't have access to your full
spending history from last year, unfortunately. My transaction data only goes back 90 days, so I'm
not able to pull your DoorDash spending from last year." (36). Divergence: "unfortunately" + the
window stated twice ("don't have access to your full… from last year" / "only goes back 90 days").
Muse's "I only have the last 90 days" IS the explanation — one clause. C10/I19/D17/O22 = **68**,
gap 32. Fix F5.

**J0194** `what are my flight miles` → Muse: "I don't have your frequent flyer account connected.
Connect it to see miles here." (13) → Ring: "I don't currently have your frequent flyer account
connected, so I can't show your miles right now. You can connect it in the app's settings, and then
I'll be able to display your miles for you!" (38). Divergence: hedging + "in the app's settings"
(unsupported UI specificity — the banned class) + "display your miles for you". C9/I17/D15/O21 =
**62**, gap 38. Fix F5.

**J0196** `when is my next oil change due` → Muse: "I don't track that. Last service was October 2025
— want a reminder?" (12; absence + what it has + offer) → Ring: "I don't keep track of oil changes,
but I see your last service was in October 2025. Would you like me to set a reminder for your next
oil change?" (32). Divergence: "keep track of" (longer than "track") + the offer at 2× length.
Content is right; shape is wrong. C11/I20/D18/O23 = **72**, gap 28. Fix F5.

**J0200** `what's my referral code` → Muse: "You don't have one yet — I can generate one." (9;
absence + immediate action offer) → Ring: "It looks like you don't have a referral code yet! I can
generate one for you right now if you'd like — just say the word!" (27). Divergence: "It looks
like" hedging + "right now if you'd like — just say the word!" (the offer + a cutesy call to
action). Muse's "I can generate one." is the offer as a fact; the user replies yes/no. C10/I19/D17/O22
= **68**, gap 32. Fix: offer-as-fact, not offer-as-performance.

---

## 15. Method notes and limits

- Ring responses are **predictions**, not observations: both files have `ring_response: null` /
  `has_live: false` for all 400 scenarios. Predictions are modeled on 165 live samples (84.2/100
  overall) and the documented filler-phrase inventory. Treat predicted gaps as directional (±8 points),
  not measured.
- Predictions assume PRE-fix behavior per the task brief (the 14 fixes are applied in the prompt but
  not live-verified here); §13 estimates fix impact separately.
- Muse scores are 100/100 by construction in this analysis (the file's Muse responses are the
  reference standard). The interesting numbers are all on the Ring side.
- Scores use the standing 4-dimension rubric (Conciseness / Intelligence / Directness / Outcome,
  25 each) from `~/workspace/ring/benchmarks.md`.
- The single largest predicted gap is I0173 (56 points, silent timezone booking); the largest
  conciseness-only gap is J0122/J0136-class 1-word answers (Ring predicted 14–20× word multipliers).
- Recommended next step: live-verify the 14 applied fixes against the G1–G15 list specifically —
  they are the highest-leverage probes because each isolates one failure shape (over-ask, error
  code, under-ask, refusal quality, candidate-less question).
