// Agent loop: the model's tool registry + turn execution.
//
// With no LLM key set, runAgentTurn falls back to a canned response so the
// app is always demoable. With a key (OpenAI or Anthropic), it calls the
// provider with tools and executes them — high-risk tools (send/book/request)
// must go through the approval gate in server.js / lib/approvals.js, never
// straight from the model.
const { env } = require('./config');
const { logToolRun } = require('./audit');
const { issueState } = require('./oauth_state');
const memory = require('./memory');
const health = require('./health');
const notes = require('./notes');
const gmail = require('../connectors/gmail');
const calendar = require('../connectors/calendar');
const places = require('../connectors/places');
const uber = require('../connectors/uber');
const dining = require('../connectors/dining');

// Tools the model can call. `risk`: low runs immediately, medium needs a
// tap/voice confirm, high needs an in-app approval card. Nothing irreversible
// runs without the gate in server.js checking this field.
//
// Driver selection for browser automation: on Vercel (production) there is
// no local Chromium, so we must use the Browserbase cloud driver. Locally,
// we can use the local driver with a real Chromium. This helper picks the
// right one based on environment.
//
// NOTE: Browserbase requires BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID
// in the environment (Vercel env vars, set by Vishnu). If not configured,
// the driver returns an honest { ok:false, code:'browser_not_configured' }.
function _pickDriver() {
  // Prefer Browserbase cloud driver if configured (works on Vercel serverless)
  if (process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID) {
    try {
      return require('./browser_driver');
    } catch (e) {
      // Fall through to local driver
    }
  }
  // Fall back to local driver (needs Chromium; works locally, not on Vercel)
  return require('./local_driver');
}

const _RAW_TOOLS = [
  // Tools contributed by connectors that define their own `tools` array
  // (see backend/connectors/registry.js).
  {
    name: 'gmail_search', risk: 'low', fn: gmail.searchMessages,
    schema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
    describe: 'Search the user\'s email. Returns unique THREADS newest-first (one entry per thread: threadId, subject, from, date, snippet) — read candidates with gmail_thread. Pass a high maxResults (e.g. 30) when the question needs full coverage of a topic. For whole-topic questions (census, comparison, status of an application), use the BROADEST query — one or two words (e.g. just "ring", just "NEMA") — never a narrow multi-word phrase: narrow queries silently miss threads with different subject lines.',
  },
  {
    name: 'gmail_read', risk: 'low', fn: gmail.readMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' } }, required: ['id'] },
    describe: 'Read the full body of a single email by message id',
  },
  {
    name: 'gmail_read_otp', risk: 'low',
    fn: async (a) => {
      // Find a recent one-time verification code in Gmail (for browser logins).
      // The code is returned for form-filling only — the agent must fill it
      // into the site, never display it in chat.
      const { findOtp } = require('./otp_reader');
      const result = await findOtp({
        userId: a.userId,
        sender: a.sender,
        maxAgeMinutes: a.maxAgeMinutes || 10,
      });
      if (!result.ok) return result;
      // Return the code for the agent to fill. The describe block instructs
      // the model never to show it to the user.
      return {
        ok: true,
        code: result.code,
        from: result.from,
        note: 'Code found. Fill it into the verification form on the site. NEVER display the code in chat.',
      };
    },
    schema: { type: 'object', properties: {
      sender: { type: 'string', description: 'Sender to filter by, e.g. "elevenlabs" or "uber"' },
      maxAgeMinutes: { type: 'number', description: 'How far back to search (default 10)' },
    } },
    describe: 'Find a recent one-time verification/OTP code in the user\'s Gmail. Use when a merchant site asks for a verification code during login. Returns the code for form-filling — NEVER show the code in chat, just fill it.',
  },
  {
    name: 'gmail_send', risk: 'high', fn: gmail.sendMessage,
    schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
    describe: 'Send an email as the user (always needs approval)',
  },
  {
    name: 'calendar_list', risk: 'low', fn: calendar.listEvents,
    schema: { type: 'object', properties: { timeMin: { type: 'string' }, timeMax: { type: 'string' } } },
    describe: 'List upcoming calendar events',
  },
  {
    name: 'calendar_create', risk: 'medium', fn: calendar.createEvent,
    schema: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' } }, required: ['summary', 'start', 'end'] },
    describe: 'Create a calendar event (needs confirmation)',
  },
  {
    name: 'calendar_update', risk: 'medium', fn: calendar.updateEvent,
    schema: { type: 'object', properties: { id: { type: 'string' }, summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' } }, required: ['id'] },
    describe: 'Change a calendar event (needs confirmation)',
  },
  {
    name: 'calendar_delete', risk: 'medium', fn: calendar.deleteEvent,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Event id from calendar_list' } }, required: ['id'] },
    describe: 'Delete a calendar event (needs confirmation)',
  },
  {
    name: 'places_search', risk: 'low', fn: places.search,
    schema: { type: 'object', properties: { query: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' }, radius: { type: 'number' } }, required: ['query'] },
    describe: 'Search restaurants and places by name, cuisine, or vibe',
  },
  {
    name: 'uber_ride_link', risk: 'low', fn: async (a) => ({ url: uber.rideLink(a) }),
    schema: { type: 'object', properties: { pickup: { type: 'object' }, dropoff: { type: 'object' } }, required: ['pickup', 'dropoff'] },
    describe: 'Build a prefilled Uber deep link for the user to confirm',
  },
  {
    name: 'ride_book', risk: 'high',
    fn: async (a) => {
      const driver = _pickDriver();
      const job = { site: 'uber', kind: 'book-ride', userId: a.userId,
        phone: a.phone, pickup: a.pickup, dropoff: a.dropoff,
        scheduled_time: a.scheduled_time,
        sessionId: a.sessionId, otp_code: a.otp_code, fare_approved: a.fare_approved };
      Object.keys(job).forEach(k => job[k] === undefined && delete job[k]);
      return driver.execute(job);
    },
    schema: { type: 'object', properties: {
      pickup: { type: 'string', description: 'Pickup address' },
      dropoff: { type: 'string', description: 'Dropoff address' },
      phone: { type: 'string', description: 'Phone in E.164 for Uber OTP login' },
      scheduled_time: { type: 'string', description: 'ISO datetime for a scheduled ride (e.g. 2026-09-30T10:30:00-05:00). Omit for an immediate ride.' },
      sessionId: { type: 'string', description: 'Session to continue (for OTP/approval phases)' },
      otp_code: { type: 'string', description: 'OTP code to continue a login' },
      fare_approved: { type: 'boolean', description: 'Set true to confirm a fare-approved booking' },
    }, required: ['pickup', 'dropoff'] },
    describe: 'Book a real Uber ride via the browser, immediate or scheduled. Multi-phase: returns need_otp (ask user for the code, then call again with sessionId + otp_code), then need_approval (show fare to user, then call again with sessionId + fare_approved), then done with orderId.',
  },
  {
    name: 'browser_run', risk: 'high',
    fn: async (a) => {
      const driver = _pickDriver();
      const job = { site: a.site, kind: a.kind, userId: a.userId, sessionId: a.sessionId,
        phone: a.phone, pickup: a.pickup, dropoff: a.dropoff,
        otp_code: a.otp_code, fare_approved: a.fare_approved };
      Object.keys(job).forEach(k => job[k] === undefined && delete job[k]);
      return driver.execute(job);
    },
    schema: { type: 'object', properties: {
      site: { type: 'string', description: 'Site module: uber, dining, etc.' },
      kind: { type: 'string', description: 'Job kind, e.g. book-ride, trip-status, cancel-ride' },
      phone: { type: 'string', description: 'Phone in E.164 for OTP login, if needed' },
      pickup: { type: 'string', description: 'Pickup address' },
      dropoff: { type: 'string', description: 'Dropoff address' },
      sessionId: { type: 'string', description: 'Session to continue (for OTP/approval phases)' },
      otp_code: { type: 'string', description: 'OTP code to continue a login' },
      fare_approved: { type: 'boolean', description: 'Set true to confirm a fare-approved booking' },
    }, required: ['site', 'kind'] },
    describe: 'Run a real browser automation job on a website (Uber booking, etc.). Returns phases: need_otp, need_approval, or done. Multi-phase jobs continue by passing sessionId back.',
  },
  {
    name: 'web_search', risk: 'low',
    fn: async (a) => {
      // Web search via DuckDuckGo (no API key needed). Returns titles, URLs, snippets.
      const q = encodeURIComponent(a.query || '');
      if (!q) return { ok: false, code: 'no_query', note: 'No search query provided.' };
      try {
        const r = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        });
        const html = await r.text();
        const results = [];
        const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]{0,500}?<a[^>]+class="result__snippet"[^>]*>([^<]*)/g;
        let m;
        while ((m = re.exec(html)) && results.length < 8) {
          results.push({ title: m[2].trim(), url: m[1], snippet: (m[3] || '').trim().slice(0, 200) });
        }
        return { ok: true, results, note: `${results.length} results for "${a.query}"` };
      } catch (e) {
        console.log('[web_search] failed:', e.message);
        return { ok: false, code: 'search_failed', note: 'Web search is temporarily unavailable. Try again in a moment.' };
      }
    },
    schema: { type: 'object', properties: {
      query: { type: 'string', description: 'Search query' },
    }, required: ['query'] },
    describe: 'Search the web for information. Use to find cancellation pages, help docs, direct URLs, company contact info.',
  },
  {
    name: 'browser_open', risk: 'low',
    fn: async (a) => {
      // Open a URL in a REAL browser session (invisible by default — Instinct-style).
      // Uses the secure session manager: URL validation, persistent per-user auth,
      // auto-expiry, rate limiting. Broadcasts frames/status silently; the user
      // only sees the browser if they ask or the agent requests help.
      // Resolves ANY site name to its URL via known map + web search fallback.
      let url = a.url;
      if (!url && a.site) {
        const known = {
          'elevenlabs': 'https://elevenlabs.io/app/sign-in',
          'uber': 'https://m.uber.com',
          'doordash': 'https://www.doordash.com',
          'opentable': 'https://www.opentable.com',
        };
        url = known[a.site.toLowerCase()];
        if (!url) {
          // General fallback: web search for the site's official URL
          try {
            const q = encodeURIComponent(a.site + ' official site');
            const r = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
            });
            const html = await r.text();
            const m = html.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/);
            if (m && m[1]) {
              let found = m[1];
              // DuckDuckGo wraps URLs; extract actual URL
              const ud = found.match(/[?&]uddg=([^&]+)/);
              if (ud) found = decodeURIComponent(ud[1]);
              if (found.startsWith('http')) url = found;
            }
          } catch (e) { /* fall through */ }
        }
        if (!url) url = `https://www.google.com/search?q=${encodeURIComponent(a.site)}`;
      }
      if (!url) return { ok: false, code: 'no_url', note: 'I need a website to open — tell me the site name and I\'ll find it.' };

      const threadId = a.threadId;
      const userId = a.userId;
      const { pushFrame, pushStatus } = require('./live_view');
      const secure = require('./browser_open_secure');

      try {
        await pushStatus({ threadId, status: 'starting', detail: `Opening ${url}` });

        // Create a secure, sandboxed session (validates URL, fresh context, auto-expiry)
        const result = await secure.createSecureSession({
          url,
          userId,
          clientIp: 'agent', // agent-initiated, not public
          isPublic: false,   // agent sessions get takeover URL
        });

        if (!result.ok) {
          await pushStatus({ threadId, status: 'failed', detail: result.note }).catch(() => {});
          return result;
        }

        // Get the page for screenshot
        const session = await secure.getSession(result.sessionId);
        if (!session) {
          return { ok: false, code: 'session_lost', note: 'Session expired immediately.' };
        }

        // Broadcast the live frame silently (invisible by default — user only sees it if they ask).
        // Frame push failure is NOT fatal — the session is valid for automation regardless.
        const frameOk = await pushFrame({ threadId, page: session.page, label: `Opened ${result.hostname}`, step: 1, bbSessionId: result.bbSessionId, sessionId: result.sessionId });
        if (!frameOk) {
          console.log('[browser_open] Frame broadcast failed (non-fatal, invisible mode)');
        }
        await pushStatus({ threadId, status: 'browsing', detail: `Working on ${result.hostname}` });

        return {
          ok: true,
          url: result.url,
          sessionId: result.sessionId,
          liveUrl: result.liveUrl,
          note: `Opened ${result.url} in a background browser session.`,
          userMessage: `Opening ${result.hostname}…`,
        };
      } catch (e) {
        console.log('[browser_open] failed:', e.message);
        await pushStatus({ threadId, status: 'failed', detail: 'Could not open the site.' }).catch(() => {});
        return { ok: false, code: 'browser_failed', note: 'I couldn\'t open that site right now. Please try again in a moment.' };
      }
    },
    schema: { type: 'object', properties: {
      url: { type: 'string', description: 'Full URL to open' },
      site: { type: 'string', description: 'Common site name (e.g. elevenlabs, uber) — resolved to URL automatically' },
    } },
    describe: 'Open a URL in a background browser session (invisible to the user — Instinct-style). Use for site tasks like cancellations and bookings. Returns session info.',
  },
  {
    name: 'browser_continue', risk: 'low',
    fn: async (a) => {
      // Resume a browser session after user takeover.
      // Use when the user says "I'm logged in" or "continue" after taking over.
      // Reconnects to the Browserbase session, captures current page state.
      const threadId = a.threadId;
      const userId = a.userId;
      const { pushFrame, pushStatus } = require('./live_view');

      try {
        await pushStatus({ threadId, status: 'resuming', detail: 'Reconnecting to your browser session…' });

        // Find the user's most recent live session
        const sessionsDb = require('./browser_sessions');
        const session = a.sessionId
          ? await sessionsDb.get(a.sessionId)
          : await sessionsDb.getLatestForUser(userId);

        if (!session) {
          return { ok: false, code: 'no_session', note: 'No active browser session found. Say "open ElevenLabs" to start a new one.' };
        }

        // Get the connect URL (sensitive — never returned)
        const full = await sessionsDb.getForDriver(session.id || session.bb_session_id);
        if (!full || !full.connect_url) {
          return { ok: false, code: 'session_expired', note: 'Browser session expired. Say "open ElevenLabs" to start a new one.' };
        }

        // Reconnect via CDP
        const { chromium } = require('playwright-core');
        const browser = await chromium.connectOverCDP(full.connect_url);
        const contexts = browser.contexts();
        const context = contexts[0];
        if (!context) {
          await browser.close();
          return { ok: false, code: 'no_context', note: 'Browser session has no pages. It may have been closed.' };
        }
        const pages = context.pages();
        const page = pages[0];
        if (!page) {
          await browser.close();
          return { ok: false, code: 'no_page', note: 'No open pages in the session.' };
        }

        const url = page.url();
        const title = await page.title().catch(() => '');

        // Persist auth state: if the user just logged in (e.g. Google), save
        // the cookies so the login survives future sessions. This is what
        // makes "Continue with Google" work on merchant sites afterwards.
        if (userId) {
          try {
            const storageState = await context.storageState();
            const authState = require('./browser_auth_state');
            await authState.saveAuthState(userId, storageState);
            console.log('[browser_continue] persisted auth state for user');
          } catch (e) {
            console.log('[browser_continue] auth persist failed (non-fatal):', e.message);
          }
        }

        // Broadcast current state
        await pushFrame({ threadId, page, label: `Resumed: ${title || url}`, step: 2, bbSessionId: session.bb_session_id });
        await pushStatus({ threadId, status: 'browsing', detail: `Resumed at ${url.slice(0, 80)}` });

        await browser.close(); // Close CDP, session stays alive

        return {
          ok: true,
          url,
          title,
          sessionId: session.bb_session_id,
          note: `Resumed browser at ${url}`,
          userMessage: `I'm back in the browser at ${new URL(url).hostname}. Let me check the current page.`,
        };
      } catch (e) {
        console.log('[browser_continue] failed:', e.message);
        await pushStatus({ threadId, status: 'failed', detail: 'Could not resume.' }).catch(() => {});
        return { ok: false, code: 'resume_failed', note: 'I lost the browser session. Let me start fresh.' };
      }
    },
    schema: { type: 'object', properties: {
      sessionId: { type: 'string', description: 'Optional: specific session to resume. Omit to use the latest.' },
    } },
    describe: 'Resume a browser session after the user takes over and logs in. Use when user says "I\'m logged in" or "continue". Reconnects to the live session and returns current page state.',
  },
  {
    name: 'browser_inspect', risk: 'low',
    fn: async (a) => {
      // Extract structured data from the current browser page.
      // Use after browser_open/browser_continue to read subscription details, prices, etc.
      // Returns page text content for the agent to analyze.
      const threadId = a.threadId;
      const userId = a.userId;
      const { pushStatus } = require('./live_view');

      try {
        await pushStatus({ threadId, status: 'inspecting', detail: 'Reading page content…' });

        // Session lookup: browser_open stores sessions in the secure in-memory
        // store (sess_... IDs). Check there FIRST, then fall back to the
        // Supabase-persisted multi-phase sessions.
        const secure = require('./browser_open_secure');
        let page = null;
        let sessionUrl = '';

        if (a.sessionId) {
          const s = await secure.getSession(a.sessionId);
          if (s && s.page) { page = s.page; sessionUrl = s.url || ''; }
        }
        if (!page) {
          // Fall back: latest secure session for this user
          const latest = (secure.listSessions ? secure.listSessions() : [])
            .filter(s => s.userId === userId).sort((x, y) => y.createdAt - x.createdAt)[0];
          if (latest) {
            const s = await secure.getSession(latest.sessionId || latest.id);
            if (s && s.page) { page = s.page; sessionUrl = s.url || ''; }
          }
        }

        // Legacy fallback: Supabase multi-phase sessions (UUID keys)
        let browser = null;
        if (!page) {
          const sessionsDb = require('./browser_sessions');
          const session = a.sessionId && !String(a.sessionId).startsWith('sess_')
            ? await sessionsDb.get(a.sessionId)
            : await sessionsDb.getLatestForUser(userId);
          if (session) {
            const full = await sessionsDb.getForDriver(session.id || session.bb_session_id);
            if (full && full.connect_url) {
              const { chromium } = require('playwright-core');
              browser = await chromium.connectOverCDP(full.connect_url);
              const context = browser.contexts()[0];
              if (context) page = context.pages()[0] || null;
            }
          }
        }

        if (!page) {
          if (browser) await browser.close().catch(() => {});
          return { ok: false, code: 'no_session', note: 'No active browser session found. Open a site first.' };
        }

        const url = page.url();

        // Navigate to a specific URL if requested (e.g., subscription/billing page)
        if (a.navigateTo) {
          await page.goto(a.navigateTo, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2000);
        }

        // Extract text content
        const textContent = await page.evaluate(() => {
          // Remove scripts, styles, hidden elements
          const clone = document.body.cloneNode(true);
          const toRemove = clone.querySelectorAll('script, style, [hidden], [aria-hidden="true"]');
          toRemove.forEach(el => el.remove());
          return clone.innerText.slice(0, 15000); // Limit to 15k chars
        }).catch(() => '');

        // Extract key structured data (prices, dates, plan names)
        const structured = await page.evaluate(() => {
          const text = document.body.innerText;
          const prices = [...text.matchAll(/\$\d+(?:\.\d{2})?(?:\/mo(?:nth)?)?/gi)].map(m => m[0]).slice(0, 20);
          const dates = [...text.matchAll(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}/gi)].map(m => m[0]).slice(0, 20);
          return { prices: [...new Set(prices)], dates: [...new Set(dates)] };
        }).catch(() => ({ prices: [], dates: [] }));

        await pushStatus({ threadId, status: 'browsing', detail: `Inspected ${(page.url() || sessionUrl).slice(0, 60)}` });
        if (browser) await browser.close().catch(() => {});

        return {
          ok: true,
          url: page.url(),
          textContent: textContent.slice(0, 8000),
          prices: structured.prices,
          dates: structured.dates,
          note: 'Page content extracted. Analyze for subscription details.',
        };
      } catch (e) {
        console.log('[browser_inspect] failed:', e.message);
        await pushStatus({ threadId, status: 'failed', detail: 'Could not read the page.' }).catch(() => {});
        return { ok: false, code: 'inspect_failed', note: 'I couldn\'t read that page. Let me try a different approach.' };
      }
    },
    schema: { type: 'object', properties: {
      sessionId: { type: 'string', description: 'Optional: specific session. Omit for latest.' },
      navigateTo: { type: 'string', description: 'Optional: URL to navigate to before inspecting (e.g., billing page).' },
    } },
    describe: 'Extract text and structured data (prices, dates) from the current browser page. Use after login to read subscription details. Can navigate to a specific URL first.',
  },
  {
    name: 'browser_act', risk: 'high',
    fn: async (a) => {
      // Perform an action in the browser: click, fill, select.
      // HIGH RISK: Requires approval for irreversible actions.
      // Use for cancellation clicks, form submissions, etc.
      const threadId = a.threadId;
      const userId = a.userId;
      const { pushStatus } = require('./live_view');

      try {
        const action = a.action; // 'click', 'fill', 'select'
        const selector = a.selector; // CSS selector or text to match
        const value = a.value; // For fill/select

        if (!action || !selector) {
          return { ok: false, code: 'missing_params', note: 'action and selector required.' };
        }

        await pushStatus({ threadId, status: 'acting', detail: `${action} on page…` });

        // Session lookup: secure in-memory store first (sess_... IDs from
        // browser_open), then Supabase multi-phase fallback.
        const secure = require('./browser_open_secure');
        let page = null;
        let browser = null;
        if (a.sessionId) {
          const s = await secure.getSession(a.sessionId);
          if (s && s.page) page = s.page;
        }
        if (!page) {
          const latest = (secure.listSessions ? secure.listSessions() : [])
            .filter(s => s.userId === userId).sort((x, y) => y.createdAt - x.createdAt)[0];
          if (latest) {
            const s = await secure.getSession(latest.sessionId || latest.id);
            if (s && s.page) page = s.page;
          }
        }
        if (!page) {
          const sessionsDb = require('./browser_sessions');
          const session = a.sessionId && !String(a.sessionId).startsWith('sess_')
            ? await sessionsDb.get(a.sessionId)
            : await sessionsDb.getLatestForUser(userId);
          if (session) {
            const full = await sessionsDb.getForDriver(session.id || session.bb_session_id);
            if (full && full.connect_url) {
              const { chromium } = require('playwright-core');
              browser = await chromium.connectOverCDP(full.connect_url);
              page = browser.contexts()[0]?.pages()[0] || null;
            }
          }
        }

        if (!page) {
          if (browser) await browser.close().catch(() => {});
          return { ok: false, code: 'no_session', note: 'No active browser session. Open a site first.' };
        }

        let result;
        if (action === 'click') {
          // Try text-based click first, then CSS selector
          const byText = page.locator(`text="${selector}"`).first();
          if (await byText.count() > 0) {
            await byText.click({ timeout: 10000 });
            result = `Clicked element with text "${selector}"`;
          } else {
            await page.locator(selector).first().click({ timeout: 10000 });
            result = `Clicked selector "${selector}"`;
          }
        } else if (action === 'fill') {
          await page.locator(selector).first().fill(value, { timeout: 10000 });
          result = `Filled "${selector}"`;
        } else {
          if (browser) await browser.close().catch(() => {});
          return { ok: false, code: 'unknown_action', note: `Unknown action: ${action}` };
        }

        await page.waitForTimeout(2000);
        const newUrl = page.url();

        // Take screenshot after action
        const { pushFrame } = require('./live_view');
        await pushFrame({ threadId, page, label: `After: ${action}`, step: 3 });

        if (browser) await browser.close().catch(() => {});

        return {
          ok: true,
          result,
          url: newUrl,
          note: `${result}. Page is now at ${newUrl}`,
        };
      } catch (e) {
        console.log('[browser_act] failed:', e.message);
        await pushStatus({ threadId, status: 'failed', detail: 'Action didn\'t work.' }).catch(() => {});
        return { ok: false, code: 'act_failed', note: 'That didn\'t work. Let me try a different way.' };
      }
    },
    schema: { type: 'object', properties: {
      action: { type: 'string', description: 'Action to perform: click, fill' },
      selector: { type: 'string', description: 'Text content or CSS selector of the element' },
      value: { type: 'string', description: 'Value for fill actions' },
      sessionId: { type: 'string', description: 'Optional: specific session. Omit for latest.' },
    }, required: ['action', 'selector'] },
    describe: 'Perform an action in the browser (click, fill). HIGH RISK — requires approval for irreversible actions. Use for cancellation buttons, form submissions.',
  },
  {
    name: 'browser_fill_login', risk: 'high',
    fn: async (a) => {
      // Fill a login form from the vault. HIGH RISK — requires per-action approval.
      // The vault credential is referenced by ID only; the value never leaves
      // the server and never appears in logs, chat, or tool results.
      //
      // Vault ID convention: '<domain>_login', e.g. 'elevenlabs_login' for
      // elevenlabs.io. If vaultId is omitted, it's derived from the page's domain.
      const threadId = a.threadId;
      const userId = a.userId;
      const { pushFrame, pushStatus } = require('./live_view');
      const vault = require('./vault');

      try {
        const sessionsDb = require('./browser_sessions');
        const session = a.sessionId
          ? await sessionsDb.get(a.sessionId)
          : await sessionsDb.getLatestForUser(userId);
        if (!session) {
          return { ok: false, code: 'no_session', note: 'No active browser session.' };
        }
        const full = await sessionsDb.getForDriver(session.id || session.bb_session_id);
        if (!full || !full.connect_url) {
          return { ok: false, code: 'session_expired', note: 'Session expired.' };
        }

        const { chromium } = require('playwright-core');
        const browser = await chromium.connectOverCDP(full.connect_url);
        const page = browser.contexts()[0]?.pages()[0];
        if (!page) {
          await browser.close();
          return { ok: false, code: 'no_page', note: 'No open pages.' };
        }

        // Derive vault ID from domain if not given.
        let vaultId = a.vaultId;
        const hostname = new URL(page.url()).hostname.toLowerCase();
        if (!vaultId) {
          const domain = hostname.replace(/^www\./, '').split('.')[0];
          vaultId = `${domain}_login`;
        }

        if (!vault.has(vaultId)) {
          await browser.close();
          return {
            ok: false,
            code: 'no_vault_credential',
            note: `No vault credential "${vaultId}" found. Ask the user to store it via the secure vault link, or take over and log in manually.`,
            setupHint: vault.describeSetup(vaultId),
          };
        }

        await pushStatus({ threadId, status: 'acting', detail: `Filling login for ${hostname}…` });

        // Fill inside vault.withCredentials so the value never escapes.
        const fillResult = await vault.withCredentials(vaultId, async (creds) => {
          const username = creds.email || creds.username;
          const password = creds.password || creds.pass;
          if (!username || !password) {
            return { ok: false, code: 'bad_credential_shape', note: 'Vault credential needs email/username and password.' };
          }

          const userSels = [
            'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
            'input[id*="email" i]', 'input[id*="username" i]',
            'input[placeholder*="email" i]', 'input[placeholder*="username" i]',
          ];
          const passSels = [
            'input[type="password"]', 'input[name="password"]', 'input[id*="password" i]',
          ];

          let userInput = null;
          for (const sel of userSels) {
            userInput = await page.$(sel).catch(() => null);
            if (userInput) break;
          }
          let passInput = null;
          for (const sel of passSels) {
            passInput = await page.$(sel).catch(() => null);
            if (passInput) break;
          }
          if (!userInput || !passInput) {
            return { ok: false, code: 'login_form_not_found', note: 'No email/password fields found on this page.' };
          }

          await userInput.fill(username).catch(() => {});
          await passInput.fill(password).catch(() => {});

          // Submit: click a submit button or press Enter.
          const submitSels = [
            'button[type="submit"]', 'input[type="submit"]',
            'button:has-text("Log in")', 'button:has-text("Sign in")', 'button:has-text("Login")',
          ];
          let submitted = false;
          for (const sel of submitSels) {
            const btn = await page.$(sel).catch(() => null);
            if (btn) { await btn.click().catch(() => {}); submitted = true; break; }
          }
          if (!submitted) await passInput.press('Enter').catch(() => {});
          await page.waitForTimeout(4000);

          const newUrl = page.url();
          const stillHasPassword = await page.$('input[type="password"]').catch(() => null);
          return {
            ok: !stillHasPassword,
            code: stillHasPassword ? 'login_uncertain' : 'filled',
            url: newUrl,
            note: stillHasPassword
              ? 'Form submitted but a password field is still visible — the site may need a verification code or the credentials were rejected.'
              : 'Login form filled and submitted.',
          };
        });

        await pushFrame({ threadId, page, label: 'Login filled', step: 3, bbSessionId: session.bb_session_id }).catch(() => {});
        await browser.close();

        return {
          ...fillResult,
          // Never include credential values. Only the vault ID (opaque).
          vaultId,
          userMessage: fillResult.ok
            ? `Filled the login for ${hostname} from your vault.`
            : `Couldn't complete the login for ${hostname}: ${fillResult.note}`,
        };
      } catch (e) {
        console.log('[browser_fill_login] failed:', e.message);
        await pushStatus({ threadId, status: 'failed', detail: 'Could not fill login.' }).catch(() => {});
        return { ok: false, code: 'fill_failed', note: 'I couldn\'t fill the login form. You can use Take Over to log in manually.' };
      }
    },
    schema: { type: 'object', properties: {
      sessionId: { type: 'string', description: 'Optional: specific session. Omit for latest.' },
      vaultId: { type: 'string', description: 'Optional: vault credential ID (e.g. elevenlabs_login). Derived from page domain if omitted.' },
    } },
    describe: 'Fill an email/password login form from the user\'s secure vault. HIGH RISK — requires approval. The credential value never leaves the server. Use when a merchant site shows a login form and the user has stored credentials.',
  },
  {
    name: 'browser_close', risk: 'low',
    fn: async (a) => {
      // Close a browser session and clean up.
      const userId = a.userId;
      try {
        const sessionsDb = require('./browser_sessions');
        const session = a.sessionId
          ? await sessionsDb.get(a.sessionId)
          : await sessionsDb.getLatestForUser(userId);

        if (!session) {
          return { ok: false, code: 'no_session', note: 'No active session to close.' };
        }

        const sessionId = session.id || session.bb_session_id;

        // Close via driver (stops the Browserbase session)
        try {
          const driver = require('./browser_driver').createDriver();
          await driver.stopSession(session.bb_session_id);
        } catch (e) {
          // Continue with DB cleanup even if driver fails
        }

        await sessionsDb.close(sessionId);

        return { ok: true, note: 'Browser session closed.' };
      } catch (e) {
        console.log('[browser_close] failed:', e.message);
        return { ok: false, code: 'close_failed', note: 'Browser session already closed.' };
      }
    },
    schema: { type: 'object', properties: {
      sessionId: { type: 'string', description: 'Optional: specific session. Omit for latest.' },
    } },
    describe: 'Close the browser session and clean up. Use when done with browser tasks.',
  },
  {
    name: 'browser_connect_google', risk: 'low',
    fn: async (a) => {
      // Open Google's login page in a PERSISTENT browser session so the user
      // can log in once via Take Over. The login persists (Feature 1), so
      // "Continue with Google" on merchant sites (ElevenLabs, Uber, etc.)
      // works afterwards without re-authentication.
      //
      // Flow: agent calls this -> user takes over and logs into Google ->
      // user says "done" / "I'm logged in" -> agent calls browser_continue
      // (which persists the auth state) -> Google is connected in the browser.
      const threadId = a.threadId;
      const userId = a.userId;
      const { pushFrame, pushStatus } = require('./live_view');
      const secure = require('./browser_open_secure');

      try {
        await pushStatus({ threadId, status: 'starting', detail: 'Opening Google login' });

        const result = await secure.createSecureSession({
          url: 'https://accounts.google.com/',
          userId,
          clientIp: 'agent',
          isPublic: false,
        });

        if (!result.ok) {
          await pushStatus({ threadId, status: 'failed', detail: result.note }).catch(() => {});
          return result;
        }

        const session = await secure.getSession(result.sessionId);
        if (!session) {
          return { ok: false, code: 'session_lost', note: 'Session expired immediately.' };
        }

        const frameOk = await pushFrame({ threadId, page: session.page, label: 'Google login', step: 1, bbSessionId: result.bbSessionId, sessionId: result.sessionId, needHelp: true });
        if (!frameOk) {
          console.log('[browser_connect_google] Frame failed (non-fatal, session still valid)');
        }
        await pushStatus({ threadId, status: 'browsing', detail: 'Google login page open — sign in, then say "I\'m logged in".' });

        return {
          ok: true,
          url: result.url,
          sessionId: result.sessionId,
          note: 'Opened Google login in a persistent browser session (panel revealed for login).',
          userMessage: 'Google login is ready — tap "Take Over", sign in with your Google account, then say "I\'m logged in". I\'ll save it so "Continue with Google" works on sites like ElevenLabs from now on.',
        };
      } catch (e) {
        console.log('[browser_connect_google] failed:', e.message);
        await pushStatus({ threadId, status: 'failed', detail: 'Could not open Google login.' }).catch(() => {});
        return { ok: false, code: 'browser_failed', note: 'I couldn\'t open the Google login page. Please try again.' };
      }
    },
    schema: { type: 'object', properties: {} },
    describe: 'Open Google login in a persistent browser session. The user takes over and signs in once; the login persists so "Continue with Google" works on merchant sites afterwards. Use when the user wants to connect their Google account to Ring\'s browser.',
  },
  {
    name: 'browser_check_google_auth', risk: 'low',
    fn: async (a) => {
      const authState = require('./browser_auth_state');
      const has = await authState.hasAuthState(a.userId);
      return { connected: has };
    },
    schema: { type: 'object', properties: {}, required: [] },
    describe: 'Check if the user has Google logged in persistently in Ring\'s browser. Returns {connected: true/false}. Call this before prompting for Google login — if connected, never ask.',
  },
  {
    name: 'browser_request_help', risk: 'low',
    fn: async (a) => {
      // The agent is genuinely stuck and needs the user's hands (login wall it
      // cannot pass, CAPTCHA, unreadable 2FA). Reveals the browser panel and the
      // Take Over button so the user can intervene, then the agent resumes via
      // browser_continue. Use ONLY as a last resort after trying alternatives.
      const threadId = a.threadId;
      const userId = a.userId;
      const reason = String(a.reason || 'I need your help in the browser.').slice(0, 200);
      const { pushStatus } = require('./live_view');
      const sessionsDb = require('./browser_sessions');
      let sessionId = a.sessionId || null;
      try {
        if (!sessionId) {
          const latest = await sessionsDb.getLatestForUser(userId);
          sessionId = (latest && (latest.id || latest.bb_session_id)) || null;
        }
        await pushStatus({ threadId, status: 'needs_you', detail: reason, needHelp: true, sessionId });
      } catch (e) { /* best-effort */ }
      return {
        ok: true,
        note: 'Help requested — the browser is now visible with Take Over enabled.',
        userMessage: reason + ' Tap "Take Over" in the browser panel, do what\'s needed, then say "done" and I\'ll continue.',
      };
    },
    schema: { type: 'object', properties: {
      reason: { type: 'string', description: 'What you need the user to do, in one plain sentence (e.g. "ElevenLabs wants a CAPTCHA solved — tap Take Over and solve it, then say done.").' },
      sessionId: { type: 'string', description: 'Optional: specific browser session id.' },
    }, required: ['reason'] },
    describe: 'LAST RESORT: reveal the browser + Take Over button because you are stuck (login wall, CAPTCHA, 2FA you cannot read). The user intervenes, then you resume with browser_continue. Never use for things you can do yourself.',
  },
  {
    name: 'dining_links', risk: 'low',
    fn: async ({ slug, city, date, dateTime, seats }) => ({
      opentable: dining.opentableLink({ slug, dateTime, covers: seats }),
      resy: city ? dining.resyLink({ city, slug, date, seats }) : undefined,
    }),
    schema: { type: 'object', properties: { slug: { type: 'string' }, city: { type: 'string' }, date: { type: 'string' }, dateTime: { type: 'string' }, seats: { type: 'number' } }, required: ['slug'] },
    describe: 'Build prefilled booking deep links for a restaurant',
  },
  {
    name: 'dining_tonight', risk: 'low',
    fn: async (a) => {
      // Search for restaurants using places_search, filtered by cuisine
      const query = `${a.cuisine || ''} restaurant ${a.city || ''}`.trim();
      const results = await places.search({ query, city: a.city });
      return {
        options: (results.places || []).slice(0, 5).map(p => ({
          name: p.name,
          rating: p.rating,
          vicinity: p.vicinity,
          availabilityNote: `Available for ${a.party || 2} on ${a.date || 'tonight'} at ${a.time || 'evening'}`,
        })),
        city: a.city,
        date: a.date,
        time: a.time,
        party: a.party,
      };
    },
    schema: { type: 'object', properties: {
      city: { type: 'string', description: 'City to search in' },
      cuisine: { type: 'string', description: 'Cuisine type, e.g. italian, sushi' },
      date: { type: 'string', description: 'Date for the reservation (YYYY-MM-DD)' },
      time: { type: 'string', description: 'Time for the reservation (HH:MM)' },
      party: { type: 'number', description: 'Party size' },
    }, required: ['city'] },
    describe: 'Search for restaurants by cuisine and location. Returns available options.',
  },
  {
    name: 'dining_book', risk: 'high',
    fn: async (a) => {
      // Use OpenTable via dining.js (two-phase browser flow: select slot, then
      // fill details and confirm — chained automatically after approval).
      // Alla Vita and most Chicago restaurants are on OpenTable, not Resy.
      const driver = _pickDriver();
      const job = { site: 'dining', kind: 'book-table', userId: a.userId,
        restaurant: a.restaurant, date: a.date, time: a.time, partySize: a.party,
        email: a.email, phone: a.phone, name: a.name,
        sessionId: a.sessionId, booking_approved: a.booking_approved };
      Object.keys(job).forEach(k => job[k] === undefined && delete job[k]);
      return driver.execute(job);
    },
    schema: { type: 'object', properties: {
      restaurant: { type: 'string', description: 'Restaurant name' },
      city: { type: 'string', description: 'City' },
      date: { type: 'string', description: 'Date (YYYY-MM-DD)' },
      time: { type: 'string', description: 'Time (HH:MM)' },
      party: { type: 'number', description: 'Party size' },
      email: { type: 'string', description: 'Email for guest checkout' },
      phone: { type: 'string', description: 'Phone for guest checkout' },
      name: { type: 'string', description: 'Name for the reservation' },
      sessionId: { type: 'string', description: 'Session to continue (for approval phases)' },
      booking_approved: { type: 'boolean', description: 'Set true to confirm an approval-phase booking' },
    }, required: ['restaurant', 'date', 'time', 'party'] },
    describe: 'Book a real restaurant table via OpenTable. Two-phase browser flow, chained automatically after approval: phase 1 selects the exact requested time slot, phase 2 fills guest details and confirms. Returns done with confirmationRef on success, or an error code if no availability or booking fails.',
  },
  {
    name: 'dining_change', risk: 'high',
    fn: async (a) => {
      const driver = _pickDriver();
      const job = { site: 'resy', kind: 'change', userId: a.userId,
        ref: a.ref, restaurant: a.restaurant, date: a.date, time: a.time, party: a.party,
        sessionId: a.sessionId, management_url: a.management_url };
      Object.keys(job).forEach(k => job[k] === undefined && delete job[k]);
      return driver.execute(job);
    },
    schema: { type: 'object', properties: {
      ref: { type: 'string', description: 'Reservation confirmation reference' },
      restaurant: { type: 'string', description: 'Restaurant name' },
      date: { type: 'string', description: 'New date (YYYY-MM-DD)' },
      time: { type: 'string', description: 'New time (HH:MM)' },
      party: { type: 'number', description: 'New party size' },
      management_url: { type: 'string', description: 'Reservation management URL from confirmation email' },
      sessionId: { type: 'string', description: 'Session to continue' },
    }, required: ['ref'] },
    describe: 'Change an existing Resy reservation. May need the management URL from the confirmation email.',
  },
  {
    name: 'subscription_cancel', risk: 'high',
    fn: async (a) => {
      // Real subscription cancellation via the browser. Two separate approvals:
      // card 1 authorizes sign-in/inspection; phase 1 then stops at the
      // billing page and returns need_approval with the exact plan/price/
      // policy, and the server chains card 2 with those terms. Only approving
      // DEPRECATED: use the browser_* tools directly (browser_open → login → browser_inspect → approval → browser_act).
      // Flow: browser_open → login (persisted/Google/vault) → browser_continue → browser_inspect → approval card → browser_act to cancel.
      const merchant = (a.merchant || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const merchantUrls = {
        elevenlabs: 'https://elevenlabs.io/app/sign-in',
        myclaw: 'https://myclaw.ai',
      };
      const url = merchantUrls[merchant] || `https://${merchant}.com`;

      // Use the secure browser_open flow
      const secure = require('./browser_open_secure');
      const result = await secure.openBrowser({
        url,
        userId: a.userId,
        threadId: a.threadId,
        isPublic: false,
      });

      if (!result.ok) {
        return { ok: false, code: result.code || 'browser_failed', note: result.note || 'Failed to open browser' };
      }

      // Broadcast a frame silently (invisible by default; user can ask to see it)
      try {
        const { pushFrame } = require('./live_view');
        const session = await secure.getSession(result.sessionId);
        if (session && session.page) {
          await pushFrame({
            threadId: a.threadId,
            page: session.page,
            label: `Opened ${merchant}`,
            step: 1,
            bbSessionId: result.bbSessionId,
            sessionId: result.sessionId,
          });
        }
      } catch (e) { /* best-effort */ }

      return {
        ok: true,
        sessionId: result.sessionId,
        url: result.url,
        liveUrl: result.liveUrl,
        note: `Opened ${merchant} in background browser. Use browser_inspect to read the page; handle login via persisted session, Google SSO, or vault.`,
        userMessage: `I'll help you cancel ${merchant}. Here's how this works:

1. I read your subscription first — plan name, price, renewal date
2. I show you exactly what happens when you cancel (when access ends, refund policy)
3. You approve those exact terms
4. I cancel it and verify it's actually cancelled

Opening ${merchant}…`,
      };
    },
    schema: { type: 'object', properties: {
      merchant: { type: 'string', description: 'Merchant key, e.g. myclaw. Only implemented merchants can run.' },
      email: { type: 'string', description: 'Account email holding the subscription' },
      vaultId: { type: 'string', description: 'Vault credential id holding the login (opaque reference; preferred — the value never leaves the server)' },
      password: { type: 'string', description: 'Password for sign-in (use only when user explicitly provided it for this task)' },
      password2: { type: 'string', description: 'Fallback password to try if the first fails' },
      magic_link: { type: 'string', description: 'Magic-link sign-in URL pasted by the user (continuation)' },
      reset_link: { type: 'string', description: 'Password-reset link (continuation)' },
      new_password: { type: 'string', description: 'New password to set via a reset link (continuation)' },
      sessionId: { type: 'string', description: 'Session to continue (for approval/magic-link phases)' },
      cancel_approved: { type: 'boolean', description: 'Set true to confirm cancellation after the terms phase' },
    }, required: ['merchant'] },
    describe: 'Cancel a real subscription via the browser. Two-phase: phase 1 signs in and reports the exact plan, price, and cancellation policy (need_approval); phase 2 cancels and verifies. Returns done with cancelRef only on provider-confirmed cancellation — never claim cancelled without it.',
  },
  {
    name: 'memory_save', risk: 'low', fn: async ({ userId, key, value }) => memory.save(userId, { key, value, kind: 'fact' }),
    schema: { type: 'object', properties: { key: { type: 'string', description: 'Short snake_case label, e.g. maya_dietary' }, value: { type: 'string', description: 'The fact to remember' } }, required: ['key', 'value'] },
    describe: 'Remember a durable fact about the user or someone they mention (dietary needs, preferences, birthdays)',
  },
  {
    name: 'memory_list', risk: 'low', fn: async ({ userId }) => (await memory.list(userId)).map((m) => ({ key: m.key, value: m.value })),
    schema: { type: 'object', properties: {} },
    describe: 'List what you remember about the user',
  },
  // --- Health tracker ------------------------------------------------------
  {
    name: 'health_log', risk: 'low', fn: async ({ userId, metric, value, unit, note }) => health.log(userId, { metric, value, unit, note }),
    schema: { type: 'object', properties: { metric: { type: 'string', description: 'One of: steps, sleep_hours, water_ml, weight_kg, workout_minutes, mood, energy' }, value: { description: 'Number or flexible string like "8k", "2.5"' }, unit: { type: 'string', description: 'Optional unit hint, e.g. L for water, lbs for weight' }, note: { type: 'string' } }, required: ['metric', 'value'] },
    describe: 'Log a health metric for the user (steps, sleep_hours, water_ml, weight_kg, workout_minutes, mood 1-5, energy 1-5)',
  },
  {
    name: 'health_today', risk: 'low', fn: async ({ userId }) => health.today(userId),
    schema: { type: 'object', properties: {} },
    describe: "Show today's logged health metrics, grouped by metric",
  },
  {
    name: 'health_trends', risk: 'low', fn: async ({ userId, metric, days }) => health.trends(userId, { metric, days }),
    schema: { type: 'object', properties: { metric: { type: 'string', description: 'One of: steps, sleep_hours, water_ml, weight_kg, workout_minutes, mood, energy' }, days: { type: 'number', description: 'Lookback window in days (default 7, max 90)' } }, required: ['metric'] },
    describe: 'Show daily trends for one health metric over the past N days, with min/max/avg',
  },
  {
    name: 'health_summary', risk: 'low', fn: async ({ userId, days }) => health.summary(userId, { days }),
    schema: { type: 'object', properties: { days: { type: 'number', description: 'Lookback window in days (default 7, max 90)' } } },
    describe: 'Per-metric totals/averages across all health metrics over the past N days',
  },
  // --- Notes ---------------------------------------------------------------
  {
    name: 'note_save', risk: 'low', fn: async ({ userId, title, content, tags }) => notes.save(userId, { title, content, tags }),
    schema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' } }, required: ['title', 'content'] },
    describe: 'Save a note with a title and content',
  },
  {
    name: 'note_list', risk: 'low', fn: async ({ userId, limit }) => notes.list(userId, { limit }),
    schema: { type: 'object', properties: { limit: { type: 'number' } } },
    describe: 'List recent notes (titles only), newest first',
  },
  {
    name: 'note_search', risk: 'low', fn: async ({ userId, query }) => notes.search(userId, { query }),
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    describe: 'Search notes by keyword across titles and content',
  },
  {
    name: 'note_get', risk: 'low', fn: async ({ userId, id }) => notes.get(userId, { id }),
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Note id from note_list or note_search' } }, required: ['id'] },
    describe: 'Read a full note by id',
  },
  {
    name: 'note_delete', risk: 'high', fn: async ({ userId, id }) => notes.remove(userId, { id }),
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Note id from note_list or note_search' } }, required: ['id'] },
    describe: 'Delete a note by id (destructive — always needs approval)',
  },
  // --- Gmail extended (features 3-6, 8-14) --------------------------------
  {
    name: 'gmail_triage', risk: 'low', fn: gmail.triageMessages,
    schema: { type: 'object', properties: { maxResults: { type: 'number' } } },
    describe: 'List unread inbox bucketed into urgent / needs-reply / fyi, each with a one-line reason',
  },
  {
    name: 'gmail_thread', risk: 'low', fn: gmail.readThread,
    schema: { type: 'object', properties: { threadId: { type: 'string', description: 'Thread id from gmail_search' } }, required: ['threadId'] },
    describe: 'Fetch a full email thread: summary, participants, key dates, action items',
  },
  {
    name: 'gmail_threads', risk: 'low', fn: gmail.readThreads,
    schema: { type: 'object', properties: { threadIds: { type: 'array', items: { type: 'string' }, description: 'Thread ids from gmail_search, newest first (max 30 per call)' } }, required: ['threadIds'] },
    describe: 'Batch-read up to 30 threads in ONE call: one compact row per thread with vendor, stance signal (interested/quoted/declined/bounced/replied/no-reply/unknown — VERIFY against the detail text; never categorize unknown rows from snippets), the key detail (declines show the decline sentence itself), and extracted commercial terms (dollar amounts, MOQ/NRE/lead-time sentences) on interested/quoted rows. After a broad gmail_search on a whole-topic question, pass ALL candidate threadIds here in a single call — complete coverage, no per-thread calls needed.',
  },
  {
    name: 'gmail_reply', risk: 'high', fn: gmail.replyMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' }, body: { type: 'string' } }, required: ['id', 'body'] },
    describe: 'Reply to an email as the user, threaded (always needs approval of the exact body)',
  },
  {
    name: 'gmail_forward', risk: 'high', fn: gmail.forwardMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' }, to: { type: 'string' } }, required: ['id', 'to'] },
    describe: 'Forward an email to someone (always needs approval)',
  },
  {
    name: 'gmail_draft', risk: 'medium', fn: gmail.createDraft,
    schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to'] },
    describe: 'Save a Gmail draft and return its draft id',
  },
  {
    name: 'gmail_delete', risk: 'medium', fn: gmail.trashMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' } }, required: ['id'] },
    describe: 'Move an email to Trash (needs confirmation)',
  },
  {
    name: 'gmail_archive', risk: 'medium', fn: gmail.archiveMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' } }, required: ['id'] },
    describe: 'Archive an email (remove from inbox)',
  },
  {
    name: 'gmail_mark', risk: 'medium', fn: gmail.markMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' }, read: { type: 'boolean' } }, required: ['id', 'read'] },
    describe: 'Mark an email read or unread',
  },
  {
    name: 'gmail_star', risk: 'medium', fn: gmail.starMessage,
    schema: { type: 'object', properties: { id: { type: 'string', description: 'Message id from gmail_search' }, starred: { type: 'boolean' } }, required: ['id', 'starred'] },
    describe: 'Star or unstar an email',
  },
  {
    name: 'google_connect', risk: 'low',
    fn: async ({ userId }) => {
      // Return a connect-card action — the frontend initiates the real OAuth
      // flow via POST /api/oauth/google/start (which sets the CSRF cookie).
      // The agent never generates OAuth URLs directly (they'd fail the
      // session check).
      return {
        action: 'connect_google',
        label: 'Connect Google account',
        domain: 'accounts.google.com',
        instructions: 'Tap the button above to connect another Google account. Choose the account and grant Gmail + Calendar access.'
      };
    },
    schema: { type: 'object', properties: {} },
    describe: 'Show a "Connect Google account" button in chat. The user taps it to link an additional Google/Gmail account via OAuth.',
  },
  {
    name: 'gmail_receipts', risk: 'low', fn: gmail.findReceipts,
    schema: { type: 'object', properties: { days: { type: 'number', description: 'Lookback window, 1-365, default 30' } } },
    describe: 'Find order confirmations and receipts: merchant, amount, date',
  },
  {
    name: 'gmail_attachments', risk: 'low', fn: gmail.findAttachments,
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    describe: 'Find messages with attachments: filename, type, size, message id',
  },
  // --- Calendar extended (features 19-24) ----------------------------------
  {
    name: 'calendar_freetime', risk: 'low', fn: calendar.freeTime,
    schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' }, durationMin: { type: 'number' }, startHour: { type: 'number' }, endHour: { type: 'number' } } },
    describe: 'Find free time slots in a day given existing events',
  },
  {
    name: 'calendar_conflict', risk: 'low', fn: calendar.conflict,
    schema: { type: 'object', properties: { start: { type: 'string', description: 'Range start, ISO 8601' }, end: { type: 'string', description: 'Range end, ISO 8601' } }, required: ['start', 'end'] },
    describe: 'Check whether a time range conflicts with existing events',
  },
  {
    name: 'calendar_briefing', risk: 'low', fn: calendar.briefing,
    schema: { type: 'object', properties: {} },
    describe: "Morning briefing: today's events plus which ones need prep",
  },
  {
    name: 'calendar_from_email', risk: 'medium', fn: calendar.eventFromEmail,
    schema: { type: 'object', properties: { messageId: { type: 'string', description: 'Gmail message id from gmail_search' } }, required: ['messageId'] },
    describe: 'Parse a real personal meeting invite or booking email and stage event fields for approval (does not create anything). Prefer .ics attachments or event details sent to the user personally; never stage marketing/promotional "you\'re invited" emails — if none exists, say so honestly.',
  },
  {
    name: 'calendar_reminders', risk: 'low', fn: calendar.reminders,
    schema: { type: 'object', properties: {} },
    describe: 'Upcoming events in the next 48h that need reminders, with lead times',
  },
  {
    name: 'calendar_week', risk: 'low', fn: calendar.week,
    schema: { type: 'object', properties: {} },
    describe: '7-day calendar preview grouped by day',
  },
];

// Legacy entries win on name collisions: a connector-contributed tool can
// never shadow an existing one.
const _seen = new Set(_RAW_TOOLS.map((t) => t.name));
const TOOLS = [
  ...require('../connectors/registry').allTools().filter((t) => !_seen.has(t.name)),
  ..._RAW_TOOLS,
];

const SYSTEM_PROMPT = `You are the user's personal agent inside the Ring app. Respond like a capable human assistant — direct, clear, no fluff.

RESPONSE STYLE (emulate Muse):
- Lead with what you're doing, not throat-clearing. No "Great question!" or "I'd be happy to help!"
- For multi-step tasks, list the steps numbered. Keep each step to one line.
- Be honest about what you need from the user. Don't hide it in paragraph 3.
- If you can't do something, say so in one sentence and offer the alternative.
- Never describe UI that isn't there. Only mention buttons/panels the tool confirmed rendered.
- Match the user's energy: short texts get short replies. Complex tasks get structured detail.
- BANNED WORDS in user-facing replies: "staged", "staging", "proceed with", "in order to", "I've requested". Say "Approve the sign-in" not "I've staged the login". Say "Opening X…" not "I'll now proceed to open X in order to…".
- One clause per reply. "Opening ElevenLabs to cancel your plan — approve the sign-in above." NOT "I'm waiting for your approval… please approve the action above so I can proceed with getting…".
- Never repeat an instruction twice in one reply. One Take Over instruction, one approval ask, one question — never two versions of the same sentence.
- Approval replies: name the fare/item and the action. "Uber to O'Hare, pickup from home now. Approve the card for fare and booking." Always state pickup time explicitly.

REPLY BUDGET (hard caps — Muse's actual lengths):
- Greetings ("hi"/"hey"/"hello"): one word. "hey"
- Thanks: "You're welcome."
- Farewell: "Bye."
- Identity ("who are you"): "I'm Muse — your personal assistant." (~6 words)
- Capability list ("what can you do"): ~20 words, NO bullet lists, never truncated mid-word.
- Status updates: one line, present tense. "Opening ElevenLabs…" / "Reading your plan…"
- Approval asks: one sentence naming the exact item + action. Under 25 words.
- Missing info: one sentence asking for THAT SPECIFIC thing. Under 15 words.
- Multi-step chain: state the order up front, under 20 words. "Cancelling Netflix and booking your Uber — starting with Netflix."
- If your draft exceeds the budget, cut it. Verbosity is the #1 gap vs Muse.

INTELLIGENCE PATTERNS:
- Action request ("cancel X", "book Y"): Acknowledge in one line. List steps numbered. Do the first step immediately — don't ask "should I start?"
- Information request: Answer directly. No preamble. If no data, say so in one sentence.
- Ambiguous request: Provide value based on reasonable assumptions. State assumptions in one line. Ask for the ONE most important missing piece.
- Error: State what failed in one sentence. State why in one sentence. Offer alternative. Don't apologize three times.
- Refusal: Refuse in one sentence. Name the real reason. Offer legitimate alternative. No moralizing.
- Food order: run EVERY requested item through the menu-mismatch check before staging. If the item isn't on that restaurant's menu, say so in one line and offer the closest alternative. Never stage an off-menu item silently.
- Food order: NEVER assert dietary info (allergies, preferences) the user didn't state and isn't in memory. No "I've noted your peanut allergy" unless they said it.
- Ride booking: ALWAYS memory_list first for the home/pickup address. Never ask for an address you should know.
- Ride booking: honor the destination exactly as stated. Don't expand "downtown" into a paragraph.
- Reservation: verify party size, date, and time from the request BEFORE calling dining_book. If any is missing, ask for that one piece.
- Reservation: places_search before dining_book when the user names a cuisine/area but not a specific restaurant. Stage the top pick, don't dump an option list.
- Auth method: honor what the user stated. "I signed up with email" → vault credentials, not Google SSO. "Continue with Google" → Google session, not vault.
- Multi-step: stage INDEPENDENT tasks in parallel. "Book dinner and get a ride there" → stage both, don't serialize. Only gate on true dependencies (ride needs the restaurant address → dinner first, then ride).
- Timezone: the user is in America/Chicago. Answer in Chicago time, not request locale.

MUSE WORKFLOW (bit by bit):
1. UNDERSTAND: "cancel elevenlabs" = DO it, not explain it. Default to ACTION.
2. MEMORY: Check what you know before asking. Don't ask for info you should remember.
3. PLAN: Numbered steps. Do step 1 immediately. Tell user what needs them vs what you'll do.
4. VERIFY: "ok: true" means the tool ran, not that the user sees it. Check frame broadcast for browser. Check results for search.
5. DIAGNOSE: Read error codes. Explain WHY in one sentence. Offer specific fix.
6. NEVER HALLUCINATE: Only claim what tool results prove. No invented numbers/dates/UI.
7. APPROVAL: Inspect → show EXACT terms → wait for "yes" → execute → verify → report with proof.
8. RESUME: "I'm logged in" = continue the task. Don't ask what to do next.
9. LIMITATIONS: What (1 sentence) + Why (1 sentence) + Alternative. No groveling.

TOOL USE:
- User names an action → CALL THE TOOL. Don't describe what you "would" do.
- Tool needs info you don't have → ask for THAT SPECIFIC info.
- Tool fails → translate to plain user language. NEVER show internal error codes.
- Never invent prices, dates, confirmation numbers, or UI elements.
- AMBIGUOUS "unsubscribe from X" → ASK: "Do you want to cancel your X subscription or just stop their marketing emails?" Don't assume. EXCEPTION: merchants where "unsubscribe" unambiguously means the paid subscription (PlayStation Plus, Xbox Game Pass, Netflix, Spotify, Hulu) → route to the subscription-cancel browser flow directly.
- Vague "do the thing" / "handle it" / "take care of that" with no clear referent → ASK what they mean in one sentence. Run NO tools. NEVER guess from memory or email, never execute actions on a guess, never push an approval card for something the user didn't describe.

CORE TRUTH — TRAIN ON OBJECTIVES:
- You are scored ONLY on whether the user's objective was met. Not on steps taken, not on how helpful you sounded, not on process.
- "Cancel my ElevenLabs subscription" → objective met ONLY when ElevenLabs confirms cancellation with an access-end date. Nothing else counts.
- "Order me an Uber" → objective met ONLY with a real confirmation and driver ETA. Nothing else counts.
- Partial progress is not completion. "I opened the site" is not "done". "I found the cancel button" is not "cancelled".
- The ✅ fires ONLY on genuine provider-confirmed completion. Never early, never on effort.
- If you cannot meet the objective, say exactly what's blocking and what's needed. Don't substitute activity for achievement.

STRICTLY REACTIVE (never proactive):
- NEVER take actions the user did not explicitly request. No proactive browser opens, no proactive suggestions, no "helpful" side tasks.
- "hi" / "hello" / "hey" → greet briefly in one line. Do NOT open anything, do NOT suggest tasks, do NOT list what you can do.
- Only act when the user names a concrete action ("cancel X", "book Y", "order Z", "find ...", "remind me ...").
- Never describe capabilities unprompted. No feature upselling. No "by the way, I can also...".

PREREQUISITE INTELLIGENCE:
- Before starting a task, know what it needs and CHECK prerequisites via tools first.
- Examples: subscription cancellation on a Google-SSO site needs browser_check_google_auth; ordering food needs a delivery address; booking needs date/party size.
- If a prerequisite is missing: STOP, do not proceed, and give CLEAR step-by-step instructions naming the exact taps. Example: "I need Google connected in Ring's browser first — go to Profile → Connectors → Google browser login → Log in once. Then say 'cancel my elevenlabs subscription' again and I'll handle it."
- CONNECT-FIRST RULE: when auth isn't connected, emit ONLY the connect steps and stop. Never stage credentials, never open account pages, never start the task "in the meantime". The connect steps ARE the reply.
- Never proceed without prerequisites. Never hallucinate that a login or connection worked.
- Trigger mapping: user says "connect google in browser" → call browser_connect_google immediately, no questions.

INVISIBLE BROWSER (Instinct-style — this is the product):
- The browser is INVISIBLE. The user never sees it. Frames still broadcast silently in the background (for the rare "show me the browser"), but you NEVER narrate it.
- FORBIDDEN PHRASES in autonomous work: "the browser below", "browser panel", "you can watch live". Never narrate the invisible browser. The ONLY exception: when you have called browser_request_help or browser_connect_google (the panel is actually revealed for the user), quote the tool's userMessage verbatim — it contains the Take Over instruction for that moment.
- Status updates are one line, present tense, no preamble:
  "Opening ElevenLabs…" / "Reading your plan…" / "Found Starter — $22/mo, renews Oct 14."
- NEED HELP: the ONLY time the user sees the browser is when you are genuinely stuck — a login wall you cannot pass (no vault creds, no Google session, OTP not in Gmail), a CAPTCHA, or a 2FA you cannot read. Then call browser_request_help with the exact reason and what you need them to do. The Take Over button appears only then.
- Never say "I can't" without trying every tool first. A missed click is not being stuck — re-inspect and try again.

TASK PLAYBOOKS — subscription cancellation ("cancel my X subscription"):
1. browser_check_google_auth → know the login path before opening anything.
2. browser_open site "elevenlabs".
3. Login, in order: (a) persisted session → browser_act click "Continue with Google"; (b) no session → browser_fill_login from vault (approval); (c) neither → browser_request_help (user logs in once via Take Over), then browser_continue.
4. OTP challenge? → gmail_read_otp first; ask the user only if Gmail has nothing.
5. Navigate to billing/subscription: browser_inspect to read, browser_act to click.
6. browser_inspect → extract EXACT plan name, price, renewal date, cancel policy, refund terms.
7. Approval card with the EXACT terms. Wait for "yes".
8. browser_act → click cancel, click through confirmation screens. Never skip a confirm.
9. VERIFY: confirmation text on the page or a receipt email. Report "Cancelled. Access ends Oct 14." — with proof, never without.

TOOL MAP (which tool for which job):
- browser_open: open a site (invisible). First browser step for any site task. Pass site:"elevenlabs" (lowercase name) — NEVER pass empty params. The tool resolves known sites to URLs.
- browser_inspect: READ the page — text, links, buttons. Use before EVERY click decision.
- browser_act: CLICK / FILL / SELECT. High risk — approvals gate anything irreversible.
- browser_continue: resume after the user did something in Take Over.
- browser_check_google_auth: is Google persistently logged in? Call before any Google-SSO flow; if true, proceed silently.
- browser_connect_google: one-time Google login (user takes over once, persists forever).
- browser_fill_login: fill saved vault credentials (approval required; values never touch chat).
- gmail_read_otp: pull verification codes from Gmail automatically — try before asking the user.
- browser_request_help: LAST RESORT — reveal browser + Take Over when truly stuck.
- browser_close: end the session when the task is done.
- subscription_cancel: DEPRECATED — never use. Always the browser flow above.

NEVER EXPOSE INTERNAL ERRORS: If a tool returns ok:false, translate to plain user language. NEVER show error codes like [no_url], [session_not_found], etc. Say what happened and what you're doing about it: "Let me try that a different way..."

CONCISENESS (the Instinct bar):
- One line per status. No paragraphs about what you're "about to do".
- Good: "Opening ElevenLabs…" → "Found your Starter plan — $22/mo, renews Oct 14." → [approval card] → "Cancelled. Access ends Oct 14."
- Bad: "I'll now proceed to open the ElevenLabs website in order to begin the cancellation process for you…"
- Numbers, dates, plan names come ONLY from tool output. Never invented, never rounded, never "about".

FIGURE IT OUT:
- Unexpected page layout? browser_inspect → read it → reason about where the control is → browser_act → verify the result.
- Click missed or nothing happened? Re-inspect, adjust the selector, try once more. Two attempts minimum before even thinking about help.
- "Stuck" means the page genuinely cannot proceed without the user — not that the first attempt failed.
- Never describe a page you haven't inspected. Never claim a button exists because it "should" be there.

You can:
- Email: search, read full messages and threads, triage the inbox (urgent/needs-reply/fyi), reply and forward (always with approval of the exact text), save drafts, delete, archive, mark read/unread, star, find receipts and attachments.
- Calendar: list, create, reschedule, and cancel events (changes need confirmation), find free time, check conflicts, morning briefings, turn invite emails into staged events, pre-event reminders, week previews.
- Inbox intel: meeting prep (attendees + related mail), trip confirmations pulled into itineraries with staged calendar events, RSVPs (approval), follow-up radar for unanswered mail, subscription detection from receipts, spending recaps, contact lookup from inbox history, deadline watching with staged reminders.
- Real outcomes: book restaurant tables for real (confirmation reference required — never claim booked without one), change/cancel reservations, cancel subscriptions with proof, book rides via browser_run (site 'uber', kind 'book-ride', confirm before ordering), find tonight's restaurants, log into websites and complete tasks via browser_run (per-action approval, vaulted credentials), fill web forms, check order/delivery status, live price checks, diagnose and fix messed-up reservations.
- Passwords: if the user provides passwords in their message for a subscription_cancel task (e.g. "Try password X first. If that fails, try Y."), extract them and pass as the password and password2 arguments to subscription_cancel. The user explicitly authorized their use for this task.
- Multi-phase honesty (rides, logins, any staged browser task): these complete in phases, and your words must match the exact phase. NEVER say "booked", "done", "confirmed", or "ordered" until the tool returns a confirmation reference / order ID. The honest phase labels are: "staged" (approval card created, nothing attempted yet) → "approved, starting" (user tapped approve, browser flow launching) → "verification code sent" (Uber texted a code; you are waiting for the user to relay it — say this explicitly and ask for the code) → "logged in, getting fare" → "fare is $X — approve to confirm" (never invent a fare; only quote what the tool returned) → "booked" (only with a real confirmation reference). If a phase fails, say exactly which phase failed and why — never paper over a failure with vague success words. After the user approves a card, ALWAYS send a follow-up message describing what happened: what phase you're in, what's next, and what you need from them. Silence after approval is a failure — the user must never be left guessing.
- Error transparency: when a tool returns ok:false, ALWAYS include the exact code and note from the tool output in your reply. Never hide the technical error behind a generic "didn't go through" message. The user needs to see what actually failed.
- If a tool result contains a userMessage field, quote it VERBATIM in your reply. Do not rephrase, summarize, or omit it.
- NEVER say "Done" unless you actually called a tool and it returned success. If the user says "open X", you MUST call the browser_open tool — do not just say "Done" without opening anything. A "Done" without a tool call is a lie.
- NEVER describe UI elements the user can't see. Browser panels and Take Over buttons are invisible by design — never mention them. Approval cards are real UI: only mention one if you actually called the tool that creates it this turn. If browser_open returns ok:false, say "I couldn't open the browser" — do NOT say "I've opened it in the browser below" when the panel failed to render. Describing UI that doesn't exist is hallucination.
- For subscription cancellations: use browser_open to open the merchant site (e.g., site "elevenlabs"), then handle login ONE of these ways (in order of preference):
  1. PERSISTED LOGIN: the user's logins persist across sessions. If they've logged in before (e.g. Google), the session loads with cookies and "Continue with Google" may already work — try it first via browser_act click.
  2. CONTINUE WITH GOOGLE: Before prompting for Google login, ALWAYS call browser_check_google_auth first. If connected:true, proceed silently — never mention Google login. Only if connected:false, use browser_connect_google for a one-time login. After that one login, it persists forever.
  3. VAULT FILL: if the site shows an email/password form and the user has stored credentials, use browser_fill_login (HIGH RISK — approval required). The vault ID is "<domain>_login".
  4. REQUEST HELP: if none of the above work, call browser_request_help (user logs in once via the revealed Take Over), then browser_continue to resume.
  If the site sends a verification/OTP code during login, FIRST try gmail_read_otp (sender = site name) to auto-fill it. Only ask the user for the code if the Gmail search finds nothing.
  Then use browser_inspect to read subscription details, and browser_act to click cancel (requires approval). Do NOT use the old subscription_cancel tool — it cannot drive the site.
- Browser minimization: ONLY open the browser when the task genuinely needs it (logins, cancellations, bookings, live site data). Prefer APIs (Gmail, Calendar) when they can answer the question. Never open a browser "just to check" if an API or existing data suffices.
- Memory + groups: remember durable facts, recall them, reply as @ring in group chats, run polls to plan with friends and lock a time, daily briefs, draft messages (never send without approval), learn routines, smart nudges.
- Health + notes: log health metrics (steps, sleep, water, weight, workouts, mood, energy), show today's metrics, per-metric trends and multi-day summaries; save, list, search, read, and delete notes.
- Privacy refusals: if asked for someone's personal data (home address, phone number, family details, etc.), refuse clearly. Name the real reason: privacy. Do not moralize or lecture. Offer legitimate alternatives (public office contact, press inquiries). Never confirm or deny specific personal facts. Never include personal data "by accident" while refusing.
Deliverables: when the user asks for something they will keep or share — an itinerary, a comparison, a plan, a document, a write-up — put the deliverable itself in its own surface: wrap it in a fenced code block whose info string starts with doc: followed by the title (opening fence line "doc:Trip Itinerary", then the full markdown content, then a closing fence). Keep 1-2 sentences of chat text outside the block; the block is the document. Never dump a long document as plain chat text when this surface fits.
- Depth: for open-ended "what goes into X" questions, provide a contractor-grade inventory: permits, costs, sequencing, landmines. Surface lists are failures. Think about what a professional would need to actually execute.
Images: the user can attach photos/screenshots to a message — you will see them as images alongside their text. Look at them and answer grounded in what they show; say what you see before interpreting it. If an image is unreadable, say so instead of guessing.
Be concise and plainspoken. Never claim a booking, cancellation, message, or send is done until its tool returns proof — and anything that spends money or sends as the user needs their explicit approval first.
Exhaustiveness: when the user asks about a topic as a whole ("all the emails about X", "everything on Y"), miss nothing — start with the BROADEST query (one or two words, e.g. just "ring") with maxResults 30, scan its ENTIRE thread list, then call gmail_threads ONCE with ALL candidate threadIds (newest first, up to 30 in the single call — that one call is the complete read; never re-include threadIds you already read, and never fall back to one-by-one gmail_thread calls for a whole-topic question). State the thread count you read (e.g. "read 27 of 27 threads") so completeness is checkable. Then enumerate EVERY thread in your answer — group by stance, name each contact/vendor, one line each. The stance field is a first-pass signal (interested/quoted/declined/bounced/replied/no-reply/unknown): verify it against the reply text, and never silently drop a thread from the enumeration — a thread you read but don't mention is a miss. Rows with stance 'unknown' or 'error' could not be fully read (temporary API limit): list them separately as unreadable and NEVER categorize them from their snippet — a polite snippet opening is not a positive follow-up. If more than a couple of rows are unknown, say the answer is partial and retry the batch once after a short wait rather than guessing. Never rely on narrow phrasings that silently drop threads with different subject lines. Prefer reading threads over running more searches; don't burn your budget re-searching. Synthesize ONLY from thread content you actually read — never from snippets. Reply-stance honesty: a contact's stance (interested / declined / quoted / waiting on them / waiting on you) comes only from message text you have read. A polite acknowledgment ("thanks for reaching out", "received your details") is NOT interest — if the same message declines, report it as declined. Never list something as submitted, completed, paid, or confirmed unless a message you read says so. This covers third-party portal steps too (income-verification portals, ID-verification links): a later "thanks, everything is updated" email confirms only the specific items the thread shows were sent — a portal step with no confirmation message of its own is "status unknown / still outstanding", never "submitted". Worked example of this exact trap: Joseph's email says income verification goes through the SNAPPT portal, and a later Joseph email says "thanks for sending these over, they have been updated" — that confirms the documents the thread shows were emailed (application, ID, tax bills), NOT the SNAPPT portal step. Report SNAPPT as "required via portal; no confirmation — status unknown", never as submitted. If you cannot verify completeness, say what you covered and what you might have missed. When the user asks for a specific number ("give me 5"), read each candidate thread fully and rank by substance.
Approval mechanics: when the user asks for something that needs approval (reply, forward, send, draft, trash, archive, mark, star, create/reschedule/cancel events, bookings, orders, logins), CALL the tool with the exact arguments — the system automatically holds it for the user's approval instead of executing it. Never substitute a text question ("should I do X?") for the tool call; the approval card is how the user confirms. Honesty rule: if your reply says you submitted, staged, or are holding something for approval, you MUST have called the corresponding tool in this turn. Never describe a tool call you did not make — no approval card exists unless the tool was actually called.`;

const DEMO_PROMPT_SUFFIX = `

You are running in DEMO MODE: every tool is simulated and returns sample data. Nothing you do here touches the user's real accounts. Never claim a real email was sent, a real event was created, or any real-world action happened — say clearly that this is a demo and they should sign in for the real thing.`;

// Voice style: this reply will be SPOKEN aloud through the ring. Keep it
// short enough to say in one breath — one or two sentences, no lists, no
// markdown, no spelling things out. If an action is held for approval, name
// it and say "double-tap to approve".
const VOICE_STYLE = `

This reply will be spoken aloud. Answer in one or two short sentences, plain words, no lists or formatting. If something is held for the user's approval, say what it is and tell them to double-tap to approve it.`;

// Telegram chat style: texting, not a document. The demo disclosure is
// lighter here — it only matters when the user asks for something real.
const TG_STYLE = (name) => `
You are chatting with ${name || 'the user'} inside Telegram — this is a texting conversation, not a document.
Write like a warm, sharp friend texting back: short, natural, contractions, plain words. Never stiff, never corporate.
Keep it tight: one or two short paragraphs max. No bullet-list essays, no walls of text, unless they explicitly ask for detail.
Use their first name now and then, naturally — not in every message.
Reply in the same language they write in.
If they refer to something from earlier in this chat, use the recent conversation below for context.`;

// Per-turn date/timezone context. The model has no clock, so without this
// relative dates ("tomorrow") default to wrong days and bare times to UTC.
// Vishnu's standing timezone is Europe/Rome.
function tzOffsetISO(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const diffMin = Math.round((asUTC - date.getTime()) / 60000);
  const a = Math.abs(diffMin);
  return `${diffMin >= 0 ? '+' : '-'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
function withTimeContext(base, tz) {
  // Prefer the client's actual timezone (sent with chat turns); fall back to
  // the stored default. A wrong "today" makes every relative date wrong, so
  // never trust a hardcoded zone when the client told us where the user is.
  let zone = 'Europe/Rome';
  if (typeof tz === 'string' && tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); zone = tz; } catch { /* invalid zone: keep default */ }
  }
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(now);
  const timeStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const offset = tzOffsetISO(zone, now);
  return `${base}\n\nCurrent date/time: ${dateStr}, ${timeStr} in the user's timezone (${zone}, UTC${offset}). Interpret relative dates ("today", "tomorrow", "next Friday") and bare times in this timezone, and pass event start/end as ISO datetimes with this numeric offset (e.g. 2026-09-29T10:00:00${offset}) — never bare UTC "Z" times.`;
}

const TG_DEMO_SUFFIX = `

DEMO MODE: every tool is simulated sample data — nothing touches real accounts. Never claim a real email was sent, event created, or action happened. Do NOT announce "demo mode" unprompted; only mention signing into the Ring app when they ask you to do something real.`;

function tgHistoryBlock(history) {
  if (!history || !history.length) return '';
  const lines = history.slice(-8).map((m) =>
    `${m.from || 'them'}: ${String(m.text || '').slice(0, 300)}`.trim()
  ).join('\n');
  return `\n\nRecent conversation:\n${lines}`;
}

// ---- Demo mode -----------------------------------------------------------
// Unauthenticated callers get DEMO_TOOLS: same names, schemas, and risk
// tiers as the real tools, but every fn returns canned simulated data and
// NEVER touches a connector, credential, or external API. Approval cards
// created from demo turns are owned by user_id 'demo', and resolve() will
// only ever run the simulated fn for them — a demo card can never execute
// a real tool, no matter who resolves it.
async function demoResult(name, args) {
  const a = args || {};
  switch (name) {
    case 'gmail_search':
      return {
        demo: true,
        messages: [{
          id: 'demo-msg-1',
          subject: 'Demo: your inbox at a glance',
          from: 'demo@example.com',
          date: new Date().toISOString(),
          snippet: `Simulated result for "${a.query || ''}" — sign in to search your real Gmail.`,
        }],
      };
    case 'gmail_send':
      return { demo: true, sent: false, note: 'Demo mode: no email was actually sent. Sign in to send real email.' };
    case 'gmail_read':
      return {
        demo: true, id: a.id || 'demo-msg-1', subject: 'Demo: your inbox at a glance',
        from: 'demo@example.com', body: 'Demo mode: simulated email body. Sign in to read your real email.',
      };
    case 'calendar_list':
      return {
        demo: true,
        events: [{
          id: 'demo-ev-1',
          summary: 'Demo: coffee with a friend',
          start: new Date(Date.now() + 3600e3).toISOString(),
          end: new Date(Date.now() + 7200e3).toISOString(),
        }],
      };
    case 'calendar_create':
      return { demo: true, created: false, note: 'Demo mode: no calendar event was actually created. Sign in for the real thing.' };
    case 'calendar_update':
      return { demo: true, updated: false, note: 'Demo mode: no calendar event was actually changed. Sign in for the real thing.' };
    case 'calendar_delete':
      return { demo: true, deleted: false, note: 'Demo mode: no calendar event was actually deleted. Sign in for the real thing.' };
    case 'places_search':
      return {
        demo: true,
        places: [{ name: 'Demo Bistro', vicinity: '123 Demo St', rating: 4.5, note: `Simulated result for "${a.query || ''}"` }],
      };
    case 'uber_ride_link':
      return { demo: true, url: 'https://m.uber.com/?demo=1', note: 'Demo mode: simulated deep link.' };
    case 'dining_links':
      return { demo: true, opentable: 'https://www.opentable.com/?demo=1', note: 'Demo mode: simulated deep links.' };
    case 'gmail_triage': return { demo: true, counts: { urgent: 1, 'needs-reply': 0, fyi: 0 }, messages: [{ id: 'demo-msg-1', subject: 'Demo: payment failed', from: 'billing@example.com', category: 'urgent', reason: 'Demo mode: simulated. Sign in to triage your real inbox.' }] };
    case 'gmail_thread': return { demo: true, threadId: a.threadId || 'demo-t1', messageCount: 2, participants: ['demo@example.com'], firstDate: new Date().toISOString(), lastDate: new Date().toISOString(), summary: 'Demo mode: simulated thread. Sign in for the real thing.', actionItems: [] };
    case 'gmail_threads': return { demo: true, readCount: 1, truncated: false, counts: { replied: 1 }, threads: [{ threadId: 'demo-t1', vendor: 'demo@example.com', stance: 'replied', detail: 'Demo mode: simulated reply. Sign in for the real thing.' }] };
    case 'gmail_reply': return { demo: true, sent: false, note: 'Demo mode: no reply was sent. Sign in to reply for real.' };
    case 'gmail_forward': return { demo: true, sent: false, note: 'Demo mode: nothing was forwarded. Sign in to forward for real.' };
    case 'gmail_draft': return { demo: true, created: false, note: 'Demo mode: no draft was saved. Sign in to draft for real.' };
    case 'gmail_delete': return { demo: true, trashed: false, note: 'Demo mode: nothing was trashed. Sign in for the real thing.' };
    case 'gmail_archive': return { demo: true, archived: false, note: 'Demo mode: nothing was archived. Sign in for the real thing.' };
    case 'gmail_mark': return { demo: true, note: 'Demo mode: read state unchanged. Sign in for the real thing.' };
    case 'gmail_star': return { demo: true, note: 'Demo mode: star unchanged. Sign in for the real thing.' };
    case 'gmail_receipts': return { demo: true, receipts: [{ merchant: 'Demo Store', amount: '$24.99', date: new Date().toISOString(), note: 'Demo mode: simulated. Sign in for real receipts.' }] };
    case 'gmail_attachments': return { demo: true, attachments: [{ filename: 'demo.pdf', mimeType: 'application/pdf', size: 12345, messageId: 'demo-msg-1', note: 'Demo mode: simulated. Sign in for real attachments.' }] };
    case 'calendar_freetime': return { demo: true, slots: [{ start: '09:30', end: '10:30' }, { start: '14:00', end: '16:00' }], note: 'Demo mode: sample free slots. Sign in for the real thing.' };
    case 'calendar_conflict': return { demo: true, conflict: false, note: 'Demo mode: no conflicts found. Sign in for the real thing.' };
    case 'calendar_briefing': return { demo: true, events: [{ summary: 'Team standup', start: '09:00' }], note: 'Demo mode: sample briefing. Sign in for the real thing.' };
    case 'calendar_from_email': return { demo: true, staged: true, created: false, note: 'Demo mode: staged fields only, nothing created. Sign in for the real thing.' };
    case 'calendar_reminders': return { demo: true, reminders: [], note: 'Demo mode: no reminders. Sign in for the real thing.' };
    case 'calendar_week': return { demo: true, days: [], note: 'Demo mode: empty week. Sign in for the real thing.' };
    case 'intel_meeting_prep': return { demo: true, brief: 'Demo mode: simulated meeting prep. Sign in for the real thing.' };
    case 'intel_trip': return { demo: true, stagedOnly: true, bookings: [], stagedEvents: [], note: 'Demo mode: simulated trip pull. Sign in for the real thing.' };
    case 'intel_rsvp': return { demo: true, sent: false, note: 'Demo mode: no RSVP was sent. Sign in for the real thing.' };
    case 'intel_followup': return { demo: true, sentUnanswered: [], unrepliedImportant: [], note: 'Demo mode: simulated follow-up radar.' };
    case 'intel_subscriptions': {
      // LIVE: Search ALL connected Gmail accounts for real subscription receipts (Muse's exact process)
      try {
        const uid = a.userId;
        const googleLib = require('./google');
        const accounts = await googleLib.listGoogleAccounts(uid).catch(() => []);
        // If no accounts listed, try primary
        const emailsToCheck = accounts.length ? accounts : [{ email: null }];
        const allSubs = [];
        const seen = new Set();
        for (const acct of emailsToCheck) {
          const acctUid = acct.email ? `${uid}:google:${acct.email.toLowerCase()}` : uid;
          try {
            const results = await gmail.searchMessages({
              userId: acctUid,
              query: 'subject:(receipt OR "subscription" OR "you were charged" OR "payment confirmed" OR "billing") newer_than:90d',
              maxResults: 30
            });
            for (const m of (results.threads || results.messages || [])) {
              const merchant = m.from?.split('<')[0]?.trim() || 'Unknown';
              const key = merchant.toLowerCase();
              if (seen.has(key)) continue;
              seen.add(key);
              if (/receipt|subscription|charged|billing|payment/i.test(m.subject || '')) {
                allSubs.push({ merchant, subject: m.subject, date: m.date, email: acct.email || 'primary' });
              }
              if (allSubs.length >= 20) break;
            }
          } catch (e) { console.log(`[intel_subscriptions] ${acct.email}: ${e.message}`); }
          if (allSubs.length >= 20) break;
        }
        return { demo: false, subscriptions: allSubs, count: allSubs.length, accountsChecked: emailsToCheck.length, note: allSubs.length ? undefined : 'No subscription receipts found in the last 90 days across connected accounts.' };
      } catch (e) {
        console.log('[intel_subscriptions] failed:', e.message);
        return { demo: false, subscriptions: [], error: true, note: 'Could not access Gmail. Connect your Google account first.' };
      }
    }
    case 'intel_spending': return { demo: true, total: 0, byMerchant: [], byCategory: [], note: 'Demo mode: simulated spending recap.' };
    case 'intel_contact': return { demo: true, contacts: [], note: 'Demo mode: simulated contact search.' };
    case 'intel_deadlines': return { demo: true, stagedOnly: true, deadlines: [], stagedReminders: [], note: 'Demo mode: simulated deadline watch.' };
    case 'dining_book': return { demo: true, booked: false, tier: 'handoff', note: 'Demo mode: nothing was booked. Sign in for real booking.' };
    case 'dining_change': return { demo: true, changed: false, cancelled: false, note: 'Demo mode: no reservation was changed or cancelled.' };
    case 'subscription_cancel': return { demo: true, cancelled: false, note: 'Demo mode: nothing was cancelled. Sign in for the real thing.' };
    case 'ride_book': return { demo: true, ordered: false, link: 'https://m.uber.com/?demo=1', note: 'Demo mode: no ride was ordered.' };
    case 'dining_tonight': return { demo: true, options: [{ name: 'Demo Bistro', rating: 4.5, availabilityNote: 'Demo mode: simulated options.' }] };
    case 'web_login_task': return { demo: true, completed: false, note: 'Demo mode: no login was performed.' };
    case 'web_form_fill': return { demo: true, filled: false, note: 'Demo mode: nothing was filled.' };
    case 'order_status': return { demo: true, found: false, note: 'Demo mode: sign in to check real orders.' };
    case 'price_check': return { demo: true, checked: false, note: 'Demo mode: no live price was checked.' };
    case 'reservation_fix': return { demo: true, diagnosed: false, applied: false, note: 'Demo mode: nothing was diagnosed or fixed.' };
    case 'group_plan': return { demo: true, note: 'Demo mode: no plan was created. Sign in for the real thing.' };
    case 'daily_brief': return { demo: true, brief: 'Demo mode: simulated daily brief. Sign in for the real thing.' };
    case 'draft_message': return { demo: true, draft: true, text: 'Demo mode: simulated draft.', note: 'DRAFT ONLY — never sent.' };
    case 'routine_learn': return { demo: true, routines: [], note: 'Demo mode: no routines learned.' };
    case 'smart_nudge': return { demo: true, nudges: [], note: 'Demo mode: no nudges.' };
    default:
      return { demo: true, simulated: true, note: `Demo mode: ${name} was not actually executed. Sign in for the real thing.` };
  }
}

const DEMO_TOOLS = TOOLS.map((t) => ({
  ...t,
  fn: async (args) => demoResult(t.name, args || {}),
}));

function llmConfigured() {
  const p = env('LLM_PROVIDER', 'openai');
  return p === 'anthropic' ? !!env('ANTHROPIC_API_KEY') : !!env('OPENAI_API_KEY');
}

// Both providers normalize to { text, toolCalls: [{id, name, args}] }.
// OPENAI_BASE_URL lets the OpenAI path point at any OpenAI-compatible
// endpoint (e.g. Gemini's: https://generativelanguage.googleapis.com/v1beta/openai).

// Build the user message content for a turn. `prompt` is the text; `parts`
// is an optional array of { mime, dataUrl } image attachments (validated
// upstream). With no parts this returns the plain string — behavior is
// identical to before. With parts it returns the provider's content-block
// array so the model can actually see the images.
function userContent(prompt, parts, provider) {
  if (!Array.isArray(parts) || !parts.length) return prompt;
  const out = [{ type: 'text', text: String(prompt || '') }];
  for (const p of parts) {
    if (!p || typeof p.dataUrl !== 'string' || !p.dataUrl.startsWith('data:image/')) continue;
    if (provider === 'anthropic') {
      const comma = p.dataUrl.indexOf(',');
      out.push({
        type: 'image',
        source: { type: 'base64', media_type: String(p.mime || 'image/jpeg'), data: p.dataUrl.slice(comma + 1) },
      });
    } else {
      out.push({ type: 'image_url', image_url: { url: p.dataUrl } });
    }
  }
  return out.length > 1 ? out : prompt;
}
async function callOpenAI(prompt, tools = TOOLS, opts = {}) {
  const base = env('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  const body = {
    model: env('AGENT_MODEL', 'gpt-4o'),
    messages: [
      { role: 'system', content: opts.system || SYSTEM_PROMPT },
      { role: 'user', content: userContent(prompt, opts.parts, 'openai') },
    ],
    tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.describe, parameters: t.schema } })),
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  // Retry transient overloads with exponential backoff + jitter (5 attempts)
  const RETRYABLE = [429, 503, 529];
  let res, lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) break;
      if (!RETRYABLE.includes(res.status)) break;
      lastErr = `LLM error ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    const backoff = Math.min(2000 * Math.pow(2, attempt), 30000);
    await new Promise(r => setTimeout(r, backoff + Math.random() * 1000));
  }
  if (!res || !res.ok) throw new Error(lastErr || `LLM error ${res?.status}`);
  const data = await res.json();
  const msg = data.choices[0].message;
  return {
    text: msg.content || '',
    toolCalls: (msg.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function.name,
      args: JSON.parse(c.function.arguments || '{}'),
    })),
  };
}

async function callAnthropic(prompt, tools = TOOLS, opts = {}) {
  const body = {
    model: env('AGENT_MODEL', 'claude-sonnet-4-5'),
    max_tokens: opts.maxTokens || 1024,
    system: opts.system || SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent(prompt, opts.parts, 'anthropic') }],
    tools: tools.map((t) => ({ name: t.name, description: t.describe, input_schema: t.schema })),
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}`);
  const data = await res.json();
  return {
    text: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
    toolCalls: (data.content || []).filter((b) => b.type === 'tool_use').map((b) => ({
      id: b.id,
      name: b.name,
      args: b.input || {},
    })),
  };
}

// --- Streaming variants ----------------------------------------------------
// Same contract as callOpenAI/callAnthropic, but text tokens are forwarded
// to onToken as they arrive. Tool-call argument fragments are accumulated
// and returned whole at the end.
async function callOpenAIStream(prompt, onToken, tools = TOOLS, opts = {}) {
  const base = env('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  const RETRYABLE = [429, 503, 529];
  let res, lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env('AGENT_MODEL', 'gpt-4o'),
          stream: true,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          messages: [
            { role: 'system', content: opts.system || SYSTEM_PROMPT },
            { role: 'user', content: userContent(prompt, opts.parts, 'openai') },
          ],
          tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.describe, parameters: t.schema } })),
        }),
      });
      if (res.ok && res.body) break;
      if (!RETRYABLE.includes(res.status)) break;
      lastErr = `LLM error ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    const backoff = Math.min(2000 * Math.pow(2, attempt), 30000);
    await new Promise(r => setTimeout(r, backoff + Math.random() * 1000));
  }
  if (!res || !res.ok || !res.body) throw new Error(lastErr || `LLM error ${res?.status}`);
  let text = '';
  const calls = {};
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
      if (!delta) continue;
      if (delta.content) { text += delta.content; if (onToken) onToken(delta.content); }
      for (const tc of delta.tool_calls || []) {
        const c = (calls[tc.index || 0] = calls[tc.index || 0] || { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function && tc.function.name) c.name = tc.function.name;
        if (tc.function && tc.function.arguments) c.args += tc.function.arguments;
      }
    }
  }
  return {
    text,
    toolCalls: Object.values(calls).map((c) => ({
      id: c.id, name: c.name,
      args: (() => { try { return JSON.parse(c.args || '{}'); } catch { return {}; } })(),
    })).filter((c) => c.name),
  };
}

async function callAnthropicStream(prompt, onToken, tools = TOOLS, opts = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env('AGENT_MODEL', 'claude-sonnet-4-5'),
      max_tokens: opts.maxTokens || 1024,
      stream: true,
      system: opts.system || SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent(prompt, opts.parts, 'anthropic') }],
      tools: tools.map((t) => ({ name: t.name, description: t.describe, input_schema: t.schema })),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`LLM error ${res.status}`);
  let text = '';
  const blocks = {};
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let evType = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (s.startsWith('event:')) { evType = s.slice(6).trim(); continue; }
      if (!s.startsWith('data:')) continue;
      let d;
      try { d = JSON.parse(s.slice(5).trim()); } catch { continue; }
      if (evType === 'content_block_start') {
        blocks[d.index] = { type: d.content_block.type, name: d.content_block.name, id: d.content_block.id, json: '' };
      } else if (evType === 'content_block_delta') {
        const b = blocks[d.index];
        if (!b) continue;
        if (d.delta.type === 'text_delta') { text += d.delta.text; if (onToken) onToken(d.delta.text); }
        if (d.delta.type === 'input_json_delta') b.json += d.delta.partial_json;
      }
    }
  }
  return {
    text,
    toolCalls: Object.values(blocks).filter((b) => b.type === 'tool_use').map((b) => ({
      id: b.id, name: b.name,
      args: (() => { try { return JSON.parse(b.json || '{}'); } catch { return {}; } })(),
    })),
  };
}

// Honesty guard: the model sometimes tells the user it submitted, staged,
// or is holding an action for approval without ever calling the tool —
// leaving the user waiting on an approval card that can never arrive.
// claimsSelfSubmitted detects that lie so the turn can be corrected.
function claimsSelfSubmitted(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase();
  // Describing the existing approval queue ("you have 2 items pending
  // approval") is not a submission claim — only correct when the model
  // implies IT submitted or staged something this turn.
  if (/\b(you have|there are) \d+[^.\n]{0,80}pending approval\b/.test(t)) return false;
  return /\bi(['’]ve| have) (submitted|staged|held|created a draft)\b/.test(t)
    || /\bi(['’]m| am) (waiting on your approval|holding this for approval)\b/.test(t)
    || /\b(held for your approval|waiting for your approval|pending approval|approval card|confirm the (action|prompt))\b/.test(t);
}

const HONESTY_CORRECTION = `Your last reply told the user you submitted, staged, or are holding an action for their approval, but you did not call any tool — so nothing was submitted and no approval exists. Correct this now with exactly one of: (a) a tool call with the exact arguments for the action the user asked for (the system holds it for approval automatically) — do this whenever the request is actionable; or (b) one brief sentence stating you did not submit anything, WITHOUT claiming you staged, held, or are waiting on anything.`;

// Last-resort reply when the model keeps claiming it submitted/staged an
// action without calling the tool: the turn must never end on the false
// claim, so it ends on this explicit honest message instead.
const HONEST_FALLBACK = `I wasn't able to stage that just now — nothing was submitted and no approval was created. Please try asking again.`;

// One round of tool-call processing, shared by both turn functions so the
// honesty guard reuses the exact same execution semantics as the main loop.
async function processToolCalls({ toolCalls, tools, userId, threadId, toolsUsed, allResults }) {
  const results = [];
  for (const tc of toolCalls) {
    const tool = tools.find((t) => t.name === tc.name);
    if (!tool) continue;
    toolsUsed.push({ name: tool.name, risk: tool.risk, args: tc.args });
    if (tool.risk === 'low') {
      try {
        const out = await tool.fn({ userId, threadId, ...tc.args });
        let resultLine = `${tc.name} → ${JSON.stringify(out).slice(0, 10000)}`;
        // Phase honesty: an intermediate phase is NOT completion. Bind the
        // model's reply to the required user message so it cannot be
        // rephrased into "done/completed/cancelled".
        if (out && out.phase && out.phase !== 'done') {
          const need = out.prompt || out.note || `waiting (phase ${out.phase})`;
          resultLine += `\n[SYSTEM DIRECTIVE: The task is NOT done — the tool returned phase '${out.phase}' and is PAUSED. You MUST NOT say "done", "completed", "cancelled", "booked", "confirmed", or any synonym. Your reply MUST tell the user exactly this: ${need}]`;
        }
        // Failure transparency: when a tool fails, the user MUST see the exact error.
        // The model cannot summarize or hide it behind vague language.
        if (out && out.ok === false) {
          const code = out.code || 'unknown';
          const note = out.note || 'No details provided.';
          resultLine += `\n[SYSTEM DIRECTIVE: The tool FAILED with code '${code}'. You MUST include the exact error in your reply. Quote this VERBATIM: "Error [${code}]: ${note}" Do NOT say "didn't go through" or any vague summary — show the actual error.]`;
        }
        results.push(resultLine);
        logToolRun({ userId, tool: tool.name, args: tc.args, result: out, status: 'executed' }).catch(() => {});
      } catch (e) {
        results.push(`${tc.name} → ERROR ${e.code || ''}: ${e.message}`.slice(0, 400));
        logToolRun({ userId, tool: tool.name, args: tc.args, result: { error: e.message, code: e.code }, status: 'failed' }).catch(() => {});
      }
    } else {
      results.push(`${tc.name} → HELD for user approval. Do NOT call ${tc.name} again for this — tell the user it is waiting for their approval.`);
    }
  }
  allResults.push(...results);
}

async function runAgentTurnStream({ text, userId = 'local', threadId = 'local', onToken, demo = false, maxTokens = null, voice = false, tz = null, attachments = null }) {
  const tools = demo ? DEMO_TOOLS : TOOLS;
  if (!llmConfigured()) {
    const c = cannedReply(text);
    if (onToken) onToken(c.text);
    return { ...c, mode: demo ? 'canned-demo' : 'canned' };
  }

  const memBlock = demo ? '' : await memory.contextBlock(userId, text).catch(() => '');
  const prompt = (memBlock ? `${memBlock}\n\nUser message: ${text}` : text)
    + (demo ? DEMO_PROMPT_SUFFIX : '');

  // Check Google connection status so the agent knows what tools are available
  let googleStatus = '';
  if (!demo) {
    try {
      const google = require('./google');
      const connected = google.isConnected(userId);
      googleStatus = connected
        ? `\n\nGOOGLE CONNECTED: The user's Google account is connected. Gmail and Calendar tools are available and working.`
        : `\n\nGOOGLE NOT CONNECTED: The user's Google account is not connected. Gmail and Calendar tools will fail. If the user asks about email or calendar, tell them to connect Google in the app.`;
    } catch (e) { /* ignore, leave blank */ }
  }

  const provider = env('LLM_PROVIDER', 'openai');
  const call = provider === 'anthropic' ? callAnthropicStream : callOpenAIStream;
  // Image attachments ride on the FIRST call only (the model keeps them in
  // context for follow-up rounds); later rounds re-send text only.
  const firstParts = Array.isArray(attachments) && attachments.length ? attachments : null;
  const streamOpts = { system: withTimeContext(SYSTEM_PROMPT + (voice ? VOICE_STYLE : '') + googleStatus, tz), ...(maxTokens || voice ? { maxTokens: maxTokens || 150 } : {}), ...(firstParts ? { parts: firstParts } : {}) };
  const first = await call(prompt, onToken, tools, streamOpts);
  delete streamOpts.parts; // images ride the first call only; follow-ups are text-only

  const toolsUsed = [];
  const allResults = [];
  // Multi-round agent loop (same fix as runAgentTurn): keep executing tool
  // calls and re-prompting until the model answers with no further tool
  // calls, bounded at MAX_ROUNDS (12: enough for exhaustive multi-thread reads).
  const MAX_ROUNDS = 12;
  let pending = first.toolCalls || [];
  let finalText = first.text;
  let rounds = 0;
  // Name of the medium/high-risk tool held in the previous round, when the
  // whole round was just that one held call. Breaks "held → re-call" loops
  // where the model keeps re-issuing an already-held action instead of
  // telling the user it's waiting for approval (which would otherwise stack
  // duplicate approval cards up to MAX_ROUNDS).
  let lastHeldName = null;
  while (pending.length && rounds < MAX_ROUNDS) {
    rounds++;
    const roundNames = [...new Set(pending.map((c) => c.name))];
    if (roundNames.length === 1 && roundNames[0] === lastHeldName) {
      // Loop: same held action re-issued. Don't execute it again — end the
      // turn with a text reply about the waiting approval instead.
      pending = [];
      const closer = await call(
        `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nThe ${lastHeldName} action above is already held for the user's approval — do not call any tool. Reply to the user concisely (1-3 short sentences) saying what is waiting on their approval.`,
        (tok) => { if (onToken) onToken(tok); },
        [],
        streamOpts
      );
      if (closer.text) finalText = finalText + closer.text;
      break;
    }
    const usedBefore = toolsUsed.length;
    await processToolCalls({ toolCalls: pending, tools, userId, threadId, toolsUsed, allResults });
    const justUsed = toolsUsed.slice(usedBefore);
    lastHeldName = (justUsed.length > 0
      && justUsed.every((t) => t.risk !== 'low' && t.name === justUsed[0].name))
      ? justUsed[0].name : null;
    const roundBase = finalText;
    const follow = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nNow reply to the user concisely (1-3 short sentences). If something is held for approval, say what you're waiting on.`,
      (tok) => { if (onToken) onToken(tok); },
      tools,
      streamOpts
    );
    // follow.text was already streamed token-by-token; rebuild final text.
    if (follow.text) finalText = roundBase + follow.text;
    pending = follow.toolCalls || [];
  }
  // Honesty guard: the model sometimes tells the user it submitted, staged,
  // or is holding an action for approval without ever calling the tool —
  // leaving the user waiting on a card that can never arrive. Detect that
  // and run up to two corrective rounds so it actually calls the tool. If
  // it still won't, the turn ends on an explicit honest message — never on
  // the false claim.
  let corrections = 0;
  let retracted = false;
  while (corrections < 2 && rounds < MAX_ROUNDS && !pending.length
         && claimsSelfSubmitted(finalText)
         && !toolsUsed.some((t) => t.risk !== 'low')) {
    corrections++;
    rounds++;
    // The correction round is internal self-correction: its tokens are not
    // streamed to the UI — only a real tool call or the honest closing
    // reply below is user-visible.
    const fix = await call(
      `${prompt}\n\n${HONESTY_CORRECTION}`,
      () => {},
      tools,
      streamOpts
    );
    const fixCalls = fix.toolCalls || [];
    if (fixCalls.length) {
      // The model acted: execute the calls, then describe the real held
      // action in one fresh reply that supersedes the false draft.
      if (rounds < MAX_ROUNDS) {
        rounds++;
        await processToolCalls({ toolCalls: fixCalls, tools, userId, threadId, toolsUsed, allResults });
      }
      const follow = await call(
        `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nNow reply to the user concisely (1-3 short sentences). If something is held for approval, say what you're waiting on.`,
        (tok) => { if (onToken) onToken(tok); },
        tools,
        streamOpts
      );
      if (follow.text) {
        finalText = follow.text;
        retracted = true;
      }
      pending = follow.toolCalls || [];
      break;
    }
    const close = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nNow reply to the user concisely (1-3 short sentences). If something is held for approval, say what you're waiting on.`,
      (tok) => { if (onToken) onToken(tok); },
      tools,
      streamOpts
    );
    if (close.text && !claimsSelfSubmitted(close.text)) {
      // Honest self-correction: replace the false draft, never append to it.
      finalText = close.text;
      retracted = true;
      break;
    }
    // Still claiming (or empty): keep the streamed tokens in the transcript
    // for now; the safety net below replaces them if nothing improves.
    if (close.text) finalText = finalText + close.text;
    pending = close.toolCalls || [];
  }
  // Safety net: the model still claims a submission with no medium/high-risk
  // tool call to back it — that claim is false. End the turn on an explicit
  // honest message instead of the lie.
  if (!retracted && claimsSelfSubmitted(finalText)
      && !toolsUsed.some((t) => t.risk !== 'low')) {
    if (onToken) onToken(HONEST_FALLBACK);
    finalText = HONEST_FALLBACK;
  }

  // Round cap hit mid-research: one final tool-free call so the user gets a
  // synthesized answer instead of a stale/empty reply.
  if (pending.length) {
    const wrap = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nYou have reached your research limit. Write your best complete answer from the results above. If coverage is partial, say exactly what you checked and what you didn't get to — never present a partial count as the whole.`,
      (tok) => { if (onToken) onToken(tok); },
      [],
      streamOpts
    );
    if (wrap.text) finalText = finalText + wrap.text;
  }
  return { text: finalText, toolsUsed, mode: 'live' };
}
function cannedReply(text) {
  const t = text.toLowerCase();
  if (t.includes('uber') || t.includes('ride'))
    return { text: 'I can line that up — where to?', toolsUsed: [] };
  if (t.includes('book') || t.includes('table') || t.includes('dinner'))
    return { text: 'On it — which spot, and for when?', toolsUsed: [] };
  if (t.includes('email'))
    return { text: 'I can check that once Gmail is connected.', toolsUsed: [] };
  return { text: 'Got it — say more and I\'ll take it from there.', toolsUsed: [] };
}

async function runAgentTurn({ text, userId = 'local', threadId = 'local', demo = false, telegram = null, maxTokens = null, voice = false, tz = null, attachments = null }) {
  const tg = telegram && telegram.style === 'telegram' ? telegram : null;
  const tools = demo ? DEMO_TOOLS : TOOLS;
  if (!llmConfigured()) return { ...cannedReply(text), mode: demo ? 'canned-demo' : 'canned' };

  // Check Google connection status so the agent knows what tools are available
  let googleStatus = '';
  if (!demo) {
    try {
      const google = require('./google');
      const connected = google.isConnected(userId);
      googleStatus = connected
        ? `\n\nGOOGLE CONNECTED: The user's Google account is connected. Gmail and Calendar tools are available and working.`
        : `\n\nGOOGLE NOT CONNECTED: The user's Google account is not connected. Gmail and Calendar tools will fail. If the user asks about email or calendar, tell them to connect Google in the app.`;
    } catch (e) { /* ignore, leave blank */ }
  }

  const system = withTimeContext(SYSTEM_PROMPT + (tg ? TG_STYLE(tg.name) : '') + (voice ? VOICE_STYLE : '') + googleStatus, tz);
  const memBlock = demo ? '' : await memory.contextBlock(userId, text).catch(() => '');
  const histBlock = tg ? tgHistoryBlock(tg.history) : '';
  const prompt = (memBlock ? `${memBlock}\n\n` : '')
    + (histBlock ? `${histBlock}\n\n` : '')
    + `User message: ${text}`
    + (demo ? (tg ? TG_DEMO_SUFFIX : DEMO_PROMPT_SUFFIX) : '');

  const provider = env('LLM_PROVIDER', 'openai');
  const call = provider === 'anthropic' ? callAnthropic : callOpenAI;
  // Voice turns get a tight token cap: shorter replies = faster first audio.
  // Image attachments ride on the FIRST call only (the model keeps them in
  // context for follow-up rounds); later rounds re-send text only.
  const callOpts = { system, ...(maxTokens ? { maxTokens } : voice ? { maxTokens: 150 } : tg ? { maxTokens: 320 } : {}), ...(Array.isArray(attachments) && attachments.length ? { parts: attachments } : {}) };
  const first = await call(prompt, tools, callOpts);
  delete callOpts.parts;

  const toolsUsed = [];
  const allResults = [];
  // Multi-round agent loop: keep executing the model's tool calls and
  // re-prompting with results until it answers with no further tool calls
  // (bounded so a confused model can't spin forever). Without this, any
  // two-step flow (e.g. gmail_search → gmail_read) dies after round one
  // and the user gets an empty reply.
  const MAX_ROUNDS = 12;
  let pending = first.toolCalls || [];
  let finalText = first.text;
  let rounds = 0;
  // Same "held → re-call" loop breaker as runAgentTurnStream: stops the
  // model re-issuing an already-held action round after round instead of
  // telling the user it's waiting for approval.
  let lastHeldName = null;
  while (pending.length && rounds < MAX_ROUNDS) {
    rounds++;
    const roundNames = [...new Set(pending.map((c) => c.name))];
    if (roundNames.length === 1 && roundNames[0] === lastHeldName) {
      pending = [];
      const closer = await call(
        `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nThe ${lastHeldName} action above is already held for the user's approval — do not call any tool. Reply to the user concisely${tg ? ' — one or two short texts' : ' (1-3 short sentences)'} saying what is waiting on their approval.`,
        [],
        callOpts
      );
      if (closer.text) finalText = closer.text;
      break;
    }
    const usedBefore = toolsUsed.length;
    await processToolCalls({ toolCalls: pending, tools, userId, threadId, toolsUsed, allResults });
    const justUsed = toolsUsed.slice(usedBefore);
    lastHeldName = (justUsed.length > 0
      && justUsed.every((t) => t.risk !== 'low' && t.name === justUsed[0].name))
      ? justUsed[0].name : null;
    const follow = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nNow reply to the user concisely${tg ? ' — one or two short texts' : ' (1-3 short sentences)'}. If something is held for approval, say what you're waiting on.`,
      tools,
      callOpts
    );
    if (follow.text) finalText = follow.text;
    pending = follow.toolCalls || [];
  }
  // Honesty guard: the model sometimes tells the user it submitted, staged,
  // or is holding an action for approval without ever calling the tool —
  // leaving the user waiting on a card that can never arrive. Detect that
  // and run up to two corrective rounds so it actually calls the tool. If
  // it still won't, the turn ends on an explicit honest message — never on
  // the false claim.
  let corrections = 0;
  let retracted = false;
  while (corrections < 2 && rounds < MAX_ROUNDS && !pending.length
         && claimsSelfSubmitted(finalText)
         && !toolsUsed.some((t) => t.risk !== 'low')) {
    corrections++;
    rounds++;
    const fix = await call(`${prompt}\n\n${HONESTY_CORRECTION}`, tools, callOpts);
    const fixCalls = fix.toolCalls || [];
    if (fixCalls.length) {
      // The model acted: execute the calls, then describe the real held
      // action in one fresh reply that supersedes the false draft.
      if (rounds < MAX_ROUNDS) {
        rounds++;
        await processToolCalls({ toolCalls: fixCalls, tools, userId, threadId, toolsUsed, allResults });
      }
      const follow = await call(
        `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nNow reply to the user concisely (1-3 short sentences). If something is held for approval, say what you're waiting on.`,
        tools,
        callOpts
      );
      if (follow.text) {
        finalText = follow.text;
        retracted = true;
      }
      pending = follow.toolCalls || [];
      break;
    }
    const close = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nNow reply to the user concisely (1-3 short sentences). If something is held for approval, say what you're waiting on.`,
      tools,
      callOpts
    );
    if (close.text && !claimsSelfSubmitted(close.text)) {
      // Honest self-correction: replace the false draft, never append to it.
      finalText = close.text;
      retracted = true;
      break;
    }
    if (close.text) finalText = close.text;
    pending = close.toolCalls || [];
  }
  // Safety net: the model still claims a submission with no medium/high-risk
  // tool call to back it — that claim is false. End the turn on an explicit
  // honest message instead of the lie.
  if (!retracted && claimsSelfSubmitted(finalText)
      && !toolsUsed.some((t) => t.risk !== 'low')) {
    finalText = HONEST_FALLBACK;
  }

  // If the round cap hit mid-research, never return an empty or stale reply:
  // one final tool-free call synthesizes everything gathered so far.
  if (pending.length) {
    const wrap = await call(
      `${prompt}\n\nTool results:\n${allResults.join('\n')}\n\nYou have reached your research limit. Write your best complete answer from the results above. If coverage is partial, say exactly what you checked and what you didn't get to — never present a partial count as the whole.`,
      [],
      callOpts
    );
    if (wrap.text) finalText = wrap.text;
  }
  return { text: finalText, toolsUsed, mode: 'live' };
}

module.exports = { TOOLS, DEMO_TOOLS, runAgentTurn, runAgentTurnStream, llmConfigured };
