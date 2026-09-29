# Uber web ride-request — automation spec (R&D recon 2026-09-29)

Read-only reconnaissance. No phone number, OTP, credential, or ride was
entered or requested. Goal: determine whether Ring can order / track / cancel
an Uber end-to-end via browser automation + reverse-engineered rider web API.

Reference implementation studied: `antojoel/uber-mcp` (MIT, 2026-07-24) —
HAR-verified GraphQL wrappers around the rider web app. Its operation names,
header shapes, and endpoint paths below are taken from its source
(`src/index.ts` @ b80f029); its login approach (real Chromium for the auth
ceremony, plain HTTPS afterwards) is independently confirmed by this recon.

## 0. TL;DR

**YES, this will work** — with a hybrid architecture:

- **Login ceremony: real browser only.** `riders.uber.com` → 302 →
  `auth.uber.com/v2/` renders the real login SPA in automated Chromium with
  **no CAPTCHA and no block** (verified 2026-09-29). Fill phone/email →
  Continue → OTP screen → code → redirect to `m.uber.com/go/home`.
- **Everything after login: plain HTTPS GraphQL.** No browser needed.
  `POST https://m.uber.com/go/graphql` drives search, fares, booking,
  tracking, and cancellation with the session cookies captured at login.
  This is ideal for Ring's serverless backend: only the login phase needs
  Browserbase; phases 2–5 are `fetch()` calls.
- The repo's current `uber.js` deep link (`https://m.uber.com/go/?action=setPickup…`)
  is **stale**: `m.uber.com/go/` returns `404 Not Found` when logged out.
  The live app routes are `/go/home` and `/go/product-selection` (post-login).

## 1. Verified surface map (all observed 2026-09-29)

| Step | URL | Observed |
|---|---|---|
| Entry | `https://riders.uber.com/` | 302 → `auth.uber.com/v2/?breeze_init_req_id=<uuid>&breeze_local_zone=…&next_url=https%3A%2F%2Friders.uber.com%2F&sm_flow_id=…&state=…` |
| Login | `https://auth.uber.com/v2/…` | SPA renders. Title: "Sign up or Log in with Uber". No CAPTCHA, no block, no device-check wall in automated Chromium (mobile UA + relay proxy). |
| curl probe | same URLs via curl | `auth.uber.com/v2/` → 404 "Not Found" (JS SPA; curl can't run it). `www.uber.com/` → **406** (WAF flags non-browser UA). `m.uber.com/go/` → 404 logged-out. **Lesson: only a real browser passes the front door.** |

### 1.1 Login page selectors (verified in DOM)

```
input#PHONE_NUMBER_or_EMAIL_ADDRESS   type="email"  aria-label="Enter phone number or email"
                                      placeholder="Enter phone number or email"
button  text="Continue"               (first <button> on the page)
button  text="Continue with Google"   aria-label="Continue with Google, opens in new window"
button  text="Continue with Apple"    aria-label="Continue with Apple, opens in new window"
```

Behavior notes:
- Clicking **Continue with empty input** → inline validation, no navigation:
  `[role="alert"]` → `"Error:\n\nPlease enter a phone number or email"`.
- Footer consent text: *"You consent to receive a verification code by text
  or Whatsapp. Message and data rates may apply."* → phone login = **SMS/WhatsApp OTP**.
- Page JS contains `PREFILL_OTP` destinations and `verify_login_hint.2fa`
  markers → OTP screen follows Continue; 2FA step possible on some accounts.

### 1.2 Bot defenses present on the auth page (verified in `<script src>`)

- `https://ak04a6qc.uber.com/v2/<id>/api.js` — **Akamai Bot Manager** sensor.
- `https://www.cdn-net.com/et.js`, `https://six.cdn-net.com/6.js`,
  `https://www.cdn-net.com/cc.js?sid=…` — Uber device-fingerprint bundle.
- uber-mcp documents the same stack as **PerimeterX (~40 KB JS fingerprint)
  + Arkose Labs (FunCaptcha)**. Their finding: both pass when driven by a
  **real Chromium** (Playwright), because the sensors see a genuine browser.
  Our recon agrees: no challenge was served to automated Chromium.

## 2. Flow diagrams (text)

### 2.1 LOGIN (browser phase — the only phase that needs Browserbase)

```
[Ring agent] --(1) create Browserbase session--> [Chromium]
[Chromium] --(2) GET riders.uber.com--> 302 --> auth.uber.com/v2/ (login SPA)
[Ring] --(3) fill #PHONE_NUMBER_or_EMAIL_ADDRESS with vaulted phone
          click Continue -->
[Uber] --(4) SMS/WhatsApp OTP to user's phone; OTP screen renders
[Ring] --(5) persist {browserSessionId, phase: AWAIT_OTP} --> return {need_otp: true}
         …user reads code, replies in chat…
[Ring] --(6) resume session, fill OTP, submit -->
[Uber] --(7) 302 --> m.uber.com/go/home  (logged-in app shell)
[Ring] --(8) capture cookies (jwt-session, udi-id, …) + cityId + sessionType + userSub
          persist {cookies…, phase: LOGGED_IN, expiresAt: now+24h}
          close browser session
```

- `breeze_init_req_id` is single-use and bound to the originating request:
  do NOT fabricate it; always start from `GET riders.uber.com/`.
- Email login may ask for **password** instead of OTP — prefer phone/OTP
  (matches the Devin-cancellation OTP-via-chatbox playbook).
- "Continue with Google/Apple" opens a popup window — avoid; phone/OTP is
  the automation-friendly path.

### 2.2 ESTIMATE (API phase — read-only, no approval needed)

```
Products = POST m.uber.com/go/graphql
  1. PudoLocationSearch {query: pickupAddr,  type: PICKUP}  -> placeId
  2. PudoLocationSearch {query: dropoffAddr, type: DROPOFF} -> placeId
  3. PudoResolveLocationPudoFragment {id} x2               -> lat/lng, address
  4. Products {pickup: {lat,lng}, destinations: [{lat,lng}]} ->
       products[] {productId, displayName (UberX/Comfort/…),
                   fare {meta, fareString}, etaStringShort, capacity}
```

`fare.meta` is an opaque JSON string — it must be passed **verbatim** into
`TripRequest`. The agent shows the user: product, upfront fare, ETA, pickup,
dropoff. This output feeds the approval card for phase 2.3.

### 2.3 CONFIRM (API phase — HIGH risk, approval card first)

```
  5. GET https://m.uber.com/api/getPreCheckoutActions?localeCode=en-US
       body: {useCaseKey: "PAYMENTS_HUB", …} -> {data: {actionResults: []}}
       (empty actionResults = nothing else needed)
  6. checkoutActionResult = JSON.stringify({
       checkoutSessionUUID: <uuid>, useCaseKey: "PAYMENTS_HUB",
       actionResults, estimatedPaymentPlan })
  7. mutation TripRequest {
       origin: {latitude, longitude}, destinations: [{…}],
       type: SCHEDULED_ASAP (or reserve), vehicleView: {id: productId},
       payment: {paymentProfileUUID, checkoutActionResult},
       meta: fare.meta (verbatim), attribution: {sourceURL: "https://m.uber.com/home"} }
     -> { uuid, errorCode, errorKey }
```

- **Confirmation artifact = `tripRequest.uuid`.** `errorCode`/`errorKey`
  non-null → booking FAILED, surface the message, never claim success.
- Approval card (rendered from phase 2.2 output) must show: product,
  **exact upfront fare**, pickup, dropoff, payment method, ETA. The tool
  re-fetches Products at confirm time and aborts if the fare moved >5%.

### 2.4 TRACK (API phase — polling)

```
loop:
  query GetStatus($latitude, $longitude) -> status {
    clientStatus, pollingIntervalMs,
    trip { uuid, clientStatus, eta, etaStringShort, fareString, cancelable,
           driver { name, rating, status }, vehicle { licensePlate, make, model,
           coordinate { latitude, longitude } } } }
  sleep(pollingIntervalMs)   # server-directed cadence
```

- `clientStatus` transitions: `FINDING_DRIVER` → `ACCEPTED` (driver assigned)
  → driver en route → `ARRIVED` ("driver is here") → `ON_TRIP` → `COMPLETED`.
- **"Notify me when my Uber is here"** = watch until `trip.clientStatus`
  flips to arrived/arrived-state, then fire `notify.js` (Realtime + Telegram).
  Driver name/plate/ETA come from the same payload — the notification can
  include "Alex is here — silver Camry ABC123".
- `cancelable` tells whether the trip can still be cancelled.

### 2.5 CANCEL (API phase — HIGH risk, own approval)

```
  query CancellationInformation { tripUUID } -> { feeString, freeCancelUntil, … }
  mutation TripCancel($current: true, $uuid) -> tripCancel (bool)
```

- Uber policy (public): **no fee if cancelled within ~2 min of request**;
  Reserve rides free until 60 min before pickup. Always read
  `CancellationInformation` first and show the fee on the cancel approval card.
- The arrival-notification e2e test: request → wait for ACCEPTED → cancel
  inside the free window → assert `tripCancel: true` and no charge on receipt.
  (~$0 if inside the window; small auth hold may appear and drop.)

## 3. Exact request shape (from uber-mcp, HAR-verified)

```
POST https://m.uber.com/go/graphql
Content-Type: application/json
Origin: https://m.uber.com
Referer: https://m.uber.com/go/home
User-Agent: <real Chrome UA, desktop or mobile>
Cookie: jwt-session=…; udi-id=…; …          # captured at login
x-csrf-token: x
x-uber-rv-session-type: <sessionType>        # captured at login
x-uber-rv-initial-load-city-id: <cityId>     # captured at login
Body: { "operationName": "<Op>", "variables": {...}, "query": "<full GraphQL>" }
```

- `getPreCheckoutActions` is REST: `GET/POST https://m.uber.com/api/getPreCheckoutActions`
  with `Origin: https://payments.uber.com`, `Referer: https://m.uber.com/go/product-selection`.
- Riders endpoints (`https://riders.uber.com/graphql`, `x-uber-rv-session-type`
  only) cover activity history/receipts; `www.uber.com` covers upcoming/past
  activities. Booking itself lives on `m.uber.com`.

## 4. OTP handoff design

The login ceremony spans **two agent turns** because the OTP arrives on the
user's phone mid-flow and serverless invocations are short-lived:

```
TURN 1  user: "log into my Uber"
        agent -> web_login_task(site=uber)            [HIGH risk -> approval card]
        on approve: executor phase LOGIN-START
          - Browserbase session -> riders.uber.com -> auth page
          - fill vaulted phone, click Continue
          - detect OTP input (wait for selector on OTP screen, timeout 60s)
          - persist session -> browser_sessions {id, site: uber, phase: AWAIT_OTP,
            bbSessionId, createdAt}
          - return {ok: true, need_otp: true, sessionId}
        agent: "Uber sent a code to your phone — what's the 6-digit code?"
TURN 2  user: "<code>"   (plain chat reply; never stored, used once, dropped)
        agent -> web_login_task(site=uber, otp=<code>, sessionId)
        executor phase LOGIN-FINISH
          - CDP-reconnect to bbSessionId, fill OTP, submit
          - wait for URL m.uber.com/go/home (timeout 60s)
          - capture cookies -> persist {phase: LOGGED_IN, cookies…, expiresAt}
          - close Browserbase session
          - return {ok: true, logged_in: true, account: <masked>}
```

- The OTP is **transient**: held in memory for the single request, never
  written to logs, DB, or tool output.
- If the OTP screen never appears (e.g. email+password account), return
  `need_input` describing what the page asks for; the agent relays it.
- Arkose FunCaptcha **may** appear on high-risk logins — if its iframe is
  detected, pause with `need_input: {type: "captcha"}` and hand the live
  session to the user (or abort honestly). Do not attempt to solve it.

## 5. Chunked-phase design (serverless-safe)

Each phase is an independent executor invocation; resume state lives in the
`browser_sessions` Supabase table (already built on branch
`executor/tier2-core`). No phase needs the browser except LOGIN.

| Phase | Needs browser? | Needs user? | Persisted resume key |
|---|---|---|---|
| LOGIN-START | yes (Browserbase) | approval + phone (vault) | `phase=AWAIT_OTP, bbSessionId` |
| LOGIN-FINISH | yes (reconnect) | OTP code | `phase=LOGGED_IN, cookies…, expiresAt` |
| ESTIMATE | no (fetch) | — | `estimate {products[], fareMeta, ttl: 5min}` |
| CONFIRM | no (fetch) | approval card w/ exact fare | `tripUuid` |
| TRACK | no (fetch loop) | — (or cron for notify) | `tripUuid, lastStatus` |
| CANCEL | no (fetch) | approval card w/ fee | `cancelled: true` |

- Session expiry: **~24 h, no refresh endpoint** (uber-mcp). `LOGGED_IN`
  rows older than 20 h are treated as expired → re-run LOGIN.
- Long TRACK waits exceed serverless limits → TRACK runs as: immediate
  short-poll inside the turn (up to ~50 s) + handoff to the outcomes
  watcher (cron) for the "driver is here" notification.
- Every phase validates its precondition and fails **closed** with
  `{ok: false, code}` — never a claimed outcome without the artifact
  (`tripRequest.uuid` / `tripCancel: true` / observed `clientStatus`).

## 6. Frank assessment

### WILL THIS WORK? — Yes, with one live-test gate.

- **Login in automation: VERIFIED.** Real Chromium renders `auth.uber.com`,
  no challenge, selectors stable. uber-mcp's production experience says
  PerimeterX/Arkose pass on genuine Chrome.
- **Book/track/cancel via API: HIGH CONFIDENCE.** HAR-verified operations,
  full request shapes captured, confirmation artifacts well-defined
  (`tripRequest.uuid`, `tripCancel`). Far more robust than DOM automation.
- **Arrival notification: HIGH CONFIDENCE.** `GetStatus` returns driver,
  plate, ETA, coordinates, and server-directed `pollingIntervalMs`; the
  repo already has `notify.js` (Realtime + Telegram) to fan out.

### Top 3 risks

1. **Datacenter-IP reputation at login (the gate).** Browserbase exits from
   shared cloud IPs; Uber's stack (Akamai + PerimeterX + Arkose) scores
   aggressively there. uber-mcp succeeded with Playwright Chromium, but on
   *their* infra. If `auth.uber.com` serves FunCaptcha or hard-blocks the
   Browserbase IP range, login needs a residential egress or the user's own
   browser session. **Mitigation:** test LOGIN-START/FINISH live with
   Vishnu's real OTP before promising; keep the `need_input(captcha)`
   escape hatch; do not fake a login.
2. **Reverse-engineered GraphQL has no contract.** Uber can rename
   operations, change `fare.meta` semantics, or require new headers without
   notice; `x-uber-rv-*` headers and the `checkoutActionResult` construction
   are HAR-derived, not documented. **Mitigation:** version-pin the query
   strings, add a nightly `GetStatus` auth-probe to detect breakage early,
   keep the DOM fallback (full browser booking) as plan B.
3. **24-hour session, no refresh.** Every day of use costs one OTP login —
   acceptable for a concierge flow but a UX tax; a stale-cookie booking
   attempt fails at `TripRequest` with an auth error, which must degrade to
   "re-login needed", never to a phantom booking. **Mitigation:** pre-flight
   `GetStatus` auth probe before CONFIRM; proactive "Uber session expired"
   nudge when a ride is requested with a dead session.

### What this recon did NOT verify (needs a real logged-in session)

- Post-login DOM of `m.uber.com/go/home` and `/go/product-selection`
  (selectors intentionally taken from the API layer instead — preferred).
- The visual OTP screen (structure inferred from `PREFILL_OTP` markers +
  Uber's documented SMS-code flow).
- Exact `clientStatus` enum strings for arrived/on-trip (taken from
  uber-mcp's `uber_trip_status_watch`; confirm live).
- Whether `m.uber.com/go/?action=setPickup…` deep links still resolve
  in-app (repo's `uber.js` `rideLink()` uses them; web root 404s logged-out).

## 7. Suggested build order for the executor team

1. `sites/uber/login.js` — LOGIN-START/FINISH per §2.1 + §4 (Browserbase CDP).
2. `sites/uber/api.js` — thin GraphQL client per §3 (fetch-only, no browser).
3. Wire phases ESTIMATE→CONFIRM→TRACK→CANCEL into `outcomes.js`
   (`ride_book`, new `ride_estimate`, `ride_cancel`, `ride_status`).
4. Live test with Vishnu: OTP login → estimate → **book → cancel inside the
   free window** → assert `tripCancel: true`, receipt shows no charge.
5. Arrival-notification test: second booking, TRACK until driver-arrived,
   assert the notify fan-out fires, then cancel.
6. Nightly auth-probe cron (`GetStatus` with stored cookies) to catch
   breakage (risk #2).

---
*Recon by subagent 2026-09-29 ~14:40–15:35 CDT. No credentials entered.
Sources: live Chromium recon of riders.uber.com/auth.uber.com;
`antojoel/uber-mcp` (MIT) src/index.ts; uber.com/go public docs.*
