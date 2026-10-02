// Take Over proxy: lets the user interact with a cloud browser session
// through Ring's UI, without needing a Browserbase account.
//
// Frontend sends input events (click, type, etc.) to the backend.
// Backend forwards them to Browserbase via Playwright.
// Backend streams screenshots back via the existing pushFrame mechanism.

const secure = require('./browser_open_secure');

// Handle user input on a browser session
// input: { type: 'click', x, y } | { type: 'type', text } | { type: 'key', key } | { type: 'scroll', dx, dy }
async function handleTakeoverInput(sessionId, input, userId) {
  const session = await secure.getSession(sessionId);
  if (!session) {
    return { ok: false, code: 'session_not_found', note: 'Browser session not found or expired.' };
  }
  // Verify the session belongs to this user
  if (session.userId !== userId) {
    return { ok: false, code: 'forbidden', note: 'Not your session.' };
  }
  const page = session.page;
  if (!page) {
    return { ok: false, code: 'no_page', note: 'Browser page not available.' };
  }

  try {
    switch (input.type) {
      case 'click': {
        // x, y are 0-1000 normalized coordinates; convert to pixels
        const viewport = page.viewportSize() || { width: 1280, height: 720 };
        const x = Math.round((input.x / 1000) * viewport.width);
        const y = Math.round((input.y / 1000) * viewport.height);
        await page.mouse.click(x, y);
        break;
      }
      case 'type': {
        await page.keyboard.type(input.text || '');
        break;
      }
      case 'key': {
        await page.keyboard.press(input.key || 'Enter');
        break;
      }
      case 'scroll': {
        await page.mouse.wheel(input.dx || 0, input.dy || 0);
        break;
      }
      case 'navigate': {
        if (input.url) await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      }
      default:
        return { ok: false, code: 'unknown_input', note: `Unknown input type: ${input.type}` };
    }

    // Take a fresh screenshot after the input and broadcast it
    const { pushFrame } = require('./live_view');
    const threadId = session.threadId;
    if (threadId) {
      await pushFrame({ threadId, page, label: 'Take Over', step: 0, bbSessionId: session.bbSessionId }).catch(() => {});
    }

    return { ok: true, url: page.url() };
  } catch (e) {
    return { ok: false, code: 'input_failed', note: `Input failed: ${e.message}`.slice(0, 200) };
  }
}

module.exports = { handleTakeoverInput };
