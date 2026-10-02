// backend/lib/otp_reader.js — Find one-time verification codes in Gmail.
//
// Instinct-parity: when a merchant site sends a verification/OTP code during
// a browser login, Ring reads it from the user's connected Gmail automatically
// instead of asking the user to relay it.
//
// Security: the code is returned to the agent for form-filling only. Codes
// are short-lived and low-sensitivity, but we still never log the code value.

const gmail = require('../connectors/gmail');

// Extract 4-8 digit codes from text. Prefers codes near keywords like
// "code", "verify", "verification", "OTP", "one-time".
function extractCodes(text) {
  if (!text) return [];
  const codes = new Set();
  // Keyword-adjacent codes first (higher confidence)
  const keywordRe = /(?:code|verify|verification|OTP|one[\s-]?time|passcode)[^\d]{0,40}(\d{4,8})/gi;
  let m;
  while ((m = keywordRe.exec(text)) !== null) {
    codes.add(m[1]);
  }
  // Fallback: any standalone 4-8 digit number
  const bareRe = /(?:^|[^\d])(\d{4,8})(?:[^\d]|$)/g;
  while ((m = bareRe.exec(text)) !== null) {
    // Skip years and obvious non-codes
    const n = m[1];
    if (/^(19|20)\d{2}$/.test(n)) continue;
    codes.add(n);
  }
  return [...codes];
}

// Search Gmail for a recent OTP code.
// opts: { userId, sender (e.g. 'elevenlabs' or 'noreply@elevenlabs.io'), maxAgeMinutes }
// Returns { ok, code, from, subject, ageMinutes } or { ok: false, code: 'not_found' }.
async function findOtp({ userId, sender, maxAgeMinutes = 10 }) {
  // Build a Gmail search query: recent mail mentioning verification/code.
  // Gmail search supports newer_than:10m.
  const senderQ = sender ? `from:${sender} ` : '';
  const query = `${senderQ}(verification OR verify OR "one-time" OR OTP OR code) newer_than:${maxAgeMinutes}m`;

  let threads;
  try {
    const res = await gmail.searchMessages({ userId, query, maxResults: 5 });
    threads = res.threads || res.messages || [];
  } catch (e) {
    return { ok: false, code: 'gmail_error', note: `Gmail search failed: ${e.message}`.slice(0, 150) };
  }

  if (!threads.length) {
    return { ok: false, code: 'not_found', note: 'No recent verification emails found.' };
  }

  // Read the newest thread's messages and extract codes.
  for (const t of threads) {
    let body = '';
    try {
      const msg = await gmail.readMessage({ userId, id: t.id || t.threadId });
      body = `${msg.subject || ''}\n${msg.snippet || ''}\n${msg.body || ''}`;
    } catch {
      body = `${t.subject || ''}\n${t.snippet || ''}`;
    }
    const codes = extractCodes(body);
    if (codes.length) {
      return {
        ok: true,
        code: codes[0], // the code value — used for form fill only, never logged
        from: t.from || '',
        subject: t.subject || '',
        // Don't include the code in any user-facing note.
        note: 'Found a recent verification code.',
      };
    }
  }

  return { ok: false, code: 'not_found', note: 'Found verification emails but could not extract a code.' };
}

module.exports = { findOtp, extractCodes };
