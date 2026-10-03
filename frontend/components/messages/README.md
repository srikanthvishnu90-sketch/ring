# Ring Message Components

The complete UI layer for every message Ring sends. Each component encodes
hundreds of micro-decisions — word caps, tone, when-to-use, state handling —
so every AI message feels Muse-quality without the agent having to think
about presentation.

**Files**
- `messages.js` — `RMsg` namespace, zero dependencies, returns HTML strings.
- `messages.css` — styles on top of `index.html` design tokens. All classes
  prefixed `rm-` (Ring Message).

**Wiring** (`index.html`)
- `<link rel="stylesheet" href="frontend/components/messages/messages.css">`
- `<script src="frontend/components/messages/messages.js"></script>` (before inline script)
- `msgHTML()` dispatches new roles → `RMsg.render(m)`; approval branch injects
  `RMsg.approvalFields(m)`.
- `bindCommon()` binds `[data-rqr]`, `[data-rsub]`, `[data-rbook]`, `[data-rretry]`, `[data-ralt]`.

---

## Global design rules (apply to ALL components)

1. **Conciseness budget.** Simple replies ≤ 25 words. Confirmations ≤ 15.
   Lists ≤ 8 items. Steps ≤ 4. Quick replies ≤ 6 pills.
2. **No preamble.** Never "I'd be happy to help…", "Great question!",
   "Sure thing!". Start with the answer.
3. **No internals.** Never `[error_code]`, never stack traces, never
   "Error [x]:". Plain language + what happens next.
4. **Bold sparingly.** Key terms only (amounts, names, dates). Never whole sentences.
5. **Links are tappable**, never raw URLs. Show the domain, not the path.
6. **One question per turn.** Never a barrage.
7. **Hedge prices, state facts.** "around $42" not "$42.00" unless from a receipt.
8. **Dark-first.** All components render in dark theme; light overrides at the
   bottom of `messages.css`.

---

## 1. Approval cards

**What:** The card shown before any irreversible action. One card = one tool
call = one Approve/Decline pair. Never bundles two actions.

**Existing integration:** `msgHTML` role `'approval'` already renders the
card shell (`.card-silver.approval`, Approve/Decline buttons bound to
`data-approve`/`data-decline`). `RMsg.approvalFields(m)` injects the rich
detail rows between the label and the buttons.

**API**
```js
RMsg.approvalFields({ tool: 'subscription_cancel', args: {
  cancel_approved: true,
  terms: { merchant:'ElevenLabs', plan:'Starter', price:'$22/mo',
           renews:'Oct 14, 2026', account:'you@gmail.com',
           accessUntil:'Nov 14, 2026', refund:'Prorated' }
}})
```
Renders field rows: Service / Plan / Price / Renews / Account / Access until /
Refund, plus a consequence line ("Approving cancels now…").

**Per-tool field maps**

| Tool | Rows shown |
|---|---|
| `subscription_cancel` (phase 2, terms present) | Service, Plan, Price, Renews, Account, Access until, Refund?, consequence line, temp-password note if present |
| `subscription_cancel` (phase 1) | Service, Account, consequence: "only starts sign-in…" |
| `ride_book` | Pickup, Destination, Fare estimate, Pickup in, Return? |
| `food_order` / `food_pickup` | Restaurant, Items, Total, Arrives/Pickup in, Tip? |
| `dining_book` | Restaurant, Date, Time, Party, Confirmation? |
| `gmail_send` | To, Subject, Message (120-char preview) |
| `calendar_create` | Event, Date, Time, With? |
| `calendar_delete` | Event + "permanently removes" consequence |
| `group_send` / `message_send` / `imessage*` / `sms*` | To, Message (140-char preview) |
| anything else | First 4 meaningful args as labeled rows (skips userId, ids) |

**States**
- `pending` → "Needs your OK" + Approve/Decline (default).
- `working` → "Working…" (no buttons).
- `waiting` → "Waiting" + outcome text (intermediate phase: need_input/need_otp).
- `done` → "Done" + sage styling + outcome text (only with real provider proof).

**Rules**
- The phase-2 cancel card is the ONLY card that runs a cancellation.
- Never claim "Done" without `confirmationRef` / provider proof.
- Consequence lines are 1 sentence, plain language.

**Example message object**
```js
{ role:'approval', backend:true, tool:'dining_book', status:'pending',
  args:{ restaurant:'Alla Vita', date:'Fri, Oct 10', time:'7:00 PM', party:'4' } }
```

---

## 2. Quick reply pills

**What:** Contextual suggestion chips under an agent message. One tap sends.

**API**
```js
{ role:'quickreplies', options:['Italian','Sushi','Mexican','Surprise me'] }
// or with custom send text:
{ role:'quickreplies', options:[{label:'Yes, book it', send:'yes book the 7pm table'}] }
```

**Rules**
- Max 6 pills. 1–4 is ideal.
- Labels ≤ 3 words each.
- Appear only when the agent genuinely needs a choice; never decorative.
- Bound via `[data-rqr]` → `send()`.

**Example flow**
```
Agent: "What kind of food are you in the mood for?"
[Italian] [Sushi] [Mexican] [Surprise me]
```

---

## 3. Progress indicators

**What:** Muse-style working line. **Text, never a spinner.**

**API**
```js
{ role:'progress', kind:'email', state:'working' }
// kinds: email|subscription|booking|ride|food|browser|page
// states: working | done | error
{ role:'progress', state:'done', detail:'Found 3 subscriptions' }
{ role:'progress', state:'error', detail:"Couldn't reach the site." }
```

**Built-in labels**

| kind | working label |
|---|---|
| `email` | Searching your emails… |
| `subscription` | Finding your subscription… |
| `booking` | Booking your table… |
| `ride` | Getting your ride… |
| `food` | Placing your order… |
| `browser` / `page` | Working on it… / Reading the page… |

**Rules**
- Subtle italic muted text with animated ellipsis (CSS, no JS timers).
- `done` → sage check + one-line result. `error` → plain red sentence.
- Replace the working line in place; don't stack multiples.

---

## 4. Result cards

**What:** Structured lists with per-item actions. `{role:'results', kind, items, state}`.

**States:** `loading` (skeleton) · `ready` · `empty` (dashed box + helpful text) ·
`error` (delegates to `RMsg.notice` error).

**Kinds**

### subscriptions
```js
{ role:'results', kind:'subscriptions', title:'Subscriptions found', items:[
  { merchant:'ElevenLabs', amount:22, currency:'$', cadence:'monthly',
    renews:'Oct 14', email:'you@gmail.com' }
]}
```
Per-item: merchant + amount, cadence/renewal/email subline, red **Cancel**
button (`[data-rsub]` → sends "cancel my X subscription"). Max 8 shown.

### restaurants / places
```js
{ role:'results', kind:'restaurants', items:[
  { name:'Alla Vita', cuisine:'Italian', rating:4.5, distance:'0.4 mi',
    price:'$$', open:'Open until 11 PM' }
]}
```
Per-item: name + distance, ★★★★ + cuisine subline, **Book** (primary,
`[data-rbook]`) + **Get a ride** (`[data-rqr]` → "order an uber to X").

### search
```js
{ role:'results', kind:'search', items:[
  { title:'…', snippet:'…', url:'https://…' }
]}
```
Title, snippet, domain-only tappable link (`example.com ↗`).

**Rules**
- Empty: "Nothing found. Try widening the search." — never a blank card.
- Never more than 8 items. Paginate or summarize beyond that.
- Amounts use `RMsg._money` — `$22.00`, never `22`.

---

## 5. Formatted responses

**What:** Helpers that build well-formed agent text (fed to `mdHTML`).

```js
RMsg.md.bullets(['Item one','Item two'])   // • flat, max 8, no nesting
RMsg.md.steps(['Do X','Then Y'])           // 1. numbered, max 4
RMsg.md.kv('Total', '$42')                 // **Total:** $42
RMsg.md.link('OpenTable', 'https://…')     // tappable, not raw
RMsg.md.subSummary(subs)                   // "You have 3 active subscriptions:
                                           //  ElevenLabs ($22/mo), …."
```

**Rules**
- Bullets flat — no sub-bullets, ever.
- Steps ≤ 4. If a task needs more, group or link out.
- Bold for key terms only (amounts, names, dates).
- `RMsg.tag('Active','ok')` → inline status pill (ok/wait/err).

---

## 6. Error states

**What:** `{role:'notice', tone, title, body, retryText, altText}`.
Tones: `error` (red title) · `warn` (amber) · `info` (neutral).

```js
{ role:'notice', tone:'error', title:"Couldn't open that site",
  body:"The page didn't load. It might be down or blocking automated browsers.",
  retryText:'Try again', altText:'Try a different way' }
```
`[data-rretry]` / `[data-ralt]` send the retry/alt text back through chat.

**Prebuilt:** `RMsg.errors.site()`, `.session()`, `.auth()`, `.offline()`.

**Rules — the important ones**
- NEVER an error code. NEVER "Error [live_view_failed]". NEVER a stack trace.
- Title ≤ 6 words. Body ≤ 2 sentences: what happened + what it means.
- Always offer a next step: retry button, alternative, or "want me to…?".
- Technical detail goes to `console.log`, never the chat.

---

## 7. Group message components

**What:** Participant context, delivery receipts, privacy — the multiplayer layer.

```js
RMsg.groupHeader({ members:['Alice','Bob','Cara'], secret:true })
// → avatar stack (initials, stable hues) + "Alice, Bob, Cara" + 🔒 Secret badge
RMsg.sentIndicator({ sentTo:['Alice','Bob','Cara','Dan','Eve'] })
// → "✓ Sent to 5 people · Alice, Bob, Cara +2 more"
```

**Rules**
- Avatars: initials, deterministic hue per name (stable across renders).
- Show max 5 avatars/names, then "+N more".
- Secret badge on every message in a secret group — privacy must be visible.
- Sent indicator only after confirmed delivery, never optimistically.
- In secret groups, the agent never names non-members ("Sam isn't in this
  chat — only you, Alice, and Bob are here.").

---

## 8. Steps component (visual)

`{role:'steps', title?, items:[{t, done?} | 'text']}` — numbered, max 4,
done steps get ✓ + strikethrough. For in-progress multi-step tasks.

---

## Component checklist (before shipping a new one)

- [ ] loading state (skeleton or working line)
- [ ] success state
- [ ] error state (plain language, retry)
- [ ] empty state (helpful, not blank)
- [ ] dark + light theme
- [ ] ≤ the word/item caps above
- [ ] bound actions work (`data-*` → handler)
- [ ] aria-labels on interactive elements
- [ ] no heavy borders, no placeholder text, no UUIDs, no error codes
