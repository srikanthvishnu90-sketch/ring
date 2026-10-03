/* ==========================================================================
   Ring Message Components — messages.js
   Self-contained render library (no dependencies on index.html globals).
   Usage: RMsg.<component>(props) -> HTML string.
   Every component documents its states: loading / success / error / empty.
   Design rules live in README.md (word caps, tone, when-to-use).
   Wire-up: index.html msgHTML() dispatches new message roles to these
   renderers; bindCommon() binds [data-rqr],[data-rsub],[data-rbook],
   [data-rretry],[data-ralt] to send().
   ========================================================================== */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(v, cur) {
    if (v == null || v === '') return '—';
    if (typeof v === 'string' && /[$€£¥]/.test(v)) return v;
    const n = Number(v);
    if (isNaN(n)) return String(v);
    return (cur || '$') + n.toFixed(2);
  }
  function initials(name) {
    const p = String(name || '?').trim().split(/\s+/);
    return ((p[0] || '?')[0] + ((p[1] || '')[0] || '')).toUpperCase();
  }
  // Deterministic pastel avatar hue from a name (stable across renders).
  function hue(name) {
    let h = 0; const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  /* ------------------------------------------------------------------ *
   * 1. APPROVAL FIELD ROWS — rich detail for known tool approvals.
   *    Called from msgHTML's approval branch: RMsg.approvalFields(m).
   *    m = {tool, args}. Returns '' for unknown tools (falls back to the
   *    single-line describeApproval label — never renders nothing).
   * ------------------------------------------------------------------ */
  function field(k, v, cls) {
    if (v == null || v === '') return '';
    return '<div class="rm-field"><span class="k">' + esc(k) +
      '</span><span class="v' + (cls ? ' ' + cls : '') + '">' + esc(v) + '</span></div>';
  }
  function conseq(t) {
    if (!t) return '';
    return '<div class="rm-conseq">' + esc(t) + '</div>';
  }

  function approvalFields(m) {
    const a = (m && m.args) || {};
    const t = m.tool || '';
    let rows = '', tail = '';

    if (t === 'subscription_cancel' && a.cancel_approved && a.terms) {
      // Phase-2 card: EXACT terms from the billing page. Approving runs it.
      const tm = a.terms || {};
      rows =
        field('Service', tm.merchant || a.merchant) +
        field('Plan', tm.plan) +
        field('Price', tm.price, 'strong') +
        field('Renews', tm.renews) +
        field('Account', tm.account || a.email) +
        field('Access until', tm.accessUntil || tm.access_until, 'good');
      if (tm.refund) rows += field('Refund', tm.refund, 'good');
      tail = conseq('Approving cancels now. Your access ends ' +
        (tm.accessUntil || tm.access_until || 'at the end of the billing period') +
        '. Declining keeps the subscription as-is.');
      if (tm.tempPassword && tm.tempPassword !== '[redacted]')
        tail += conseq('Temporary sign-in password (save it in case you need to log back in): ' + tm.tempPassword);
    } else if (t === 'subscription_cancel') {
      // Phase-1 card: authorizes starting the sign-in/inspection flow only.
      rows =
        field('Service', a.merchant) +
        field('Account', a.email);
      tail = conseq('This only starts the secure sign-in so the exact plan, price, renewal date and cancellation terms can be inspected. Nothing is cancelled until you approve the second card.');
    } else if (t === 'ride_book') {
      rows =
        field('Pickup', a.pickup || a.from) +
        field('Destination', a.destination || a.to) +
        field('Fare estimate', a.fare || a.fareEstimate, 'strong') +
        field('Pickup in', a.eta);
      if (a.roundTrip) rows += field('Return', a.returnTime || 'Scheduled', 'good');
    } else if (t === 'food_order' || t === 'food_pickup') {
      const items = Array.isArray(a.items) ? a.items : [];
      rows =
        field('Restaurant', a.restaurant || a.merchant) +
        field('Items', items.length ? items.map(function (i) {
          return typeof i === 'string' ? i : (i.name + (i.qty > 1 ? ' ×' + i.qty : ''));
        }).join(', ') : a.itemSummary) +
        field('Total', money(a.total, a.currency), 'strong') +
        field(a.pickup ? 'Pickup in' : 'Arrives in', a.eta);
      if (a.tip) rows += field('Tip', money(a.tip, a.currency));
    } else if (t === 'dining_book') {
      rows =
        field('Restaurant', a.restaurant) +
        field('Date', a.date) +
        field('Time', a.time, 'strong') +
        field('Party', a.party || a.partySize);
      if (a.confirmationRef) rows += field('Confirmation', a.confirmationRef, 'good');
    } else if (t === 'gmail_send') {
      rows = field('To', a.to) + field('Subject', a.subject);
      if (a.bodyPreview) rows += field('Message', String(a.bodyPreview).slice(0, 120));
    } else if (t === 'calendar_create') {
      rows = field('Event', a.summary) + field('Date', a.date) + field('Time', a.time);
      if (a.attendees) rows += field('With', a.attendees);
    } else if (t === 'calendar_delete') {
      rows = field('Event', a.summary || a.id);
      tail = conseq('This permanently removes the event from your calendar.');
    } else if (t === 'group_send' || t === 'message_send' || t.indexOf('imessage') === 0 || t.indexOf('sms') === 0) {
      rows = field('To', a.to || a.group || a.thread) + field('Message', a.text ? String(a.text).slice(0, 140) : '');
    } else {
      // Generic: first 4 meaningful args as rows. Never invent keys.
      const skip = { userId: 1, idempotencyKey: 1, threadId: 1, sessionId: 1 };
      Object.keys(a).filter(function (k) { return !skip[k] && a[k] != null && a[k] !== ''; })
        .slice(0, 4).forEach(function (k) {
          const v = typeof a[k] === 'object' ? JSON.stringify(a[k]).slice(0, 80) : String(a[k]);
          rows += field(k.replace(/([A-Z])/g, ' $1').replace(/^./, function (c) { return c.toUpperCase(); }), v);
        });
    }

    if (!rows && !tail) return '';
    return '<div class="rm-fields">' + rows + '</div>' + tail;
  }

  /* ------------------------------------------------------------------ *
   * 2. QUICK REPLIES — contextual pills under an agent message.
   *    {role:'quickreplies', options:[{label, send?} | 'label']}
   *    Clicking sends the label (or option.send) via data-rqr binding.
   * ------------------------------------------------------------------ */
  function quickReplies(m) {
    const opts = (m.options || []).slice(0, 6); // max 6 — never a wall of chips
    if (!opts.length) return '';
    return '<div class="msg-in"><div class="rm-qr" role="group" aria-label="Suggested replies">' +
      opts.map(function (o) {
        const label = typeof o === 'string' ? o : o.label;
        const send = typeof o === 'string' ? o : (o.send || o.label);
        return '<button class="chip" data-rqr="' + esc(send) + '">' + esc(label) + '</button>';
      }).join('') + '</div></div>';
  }

  /* ------------------------------------------------------------------ *
   * 3. PROGRESS — Muse-style working line. Text, never a spinner.
   *    {role:'progress', label, state:'working'|'done'|'error', detail?}
   * ------------------------------------------------------------------ */
  var PROGRESS_LABELS = {
    email: 'Searching your emails', subscription: 'Finding your subscription',
    booking: 'Booking your table', ride: 'Getting your ride',
    food: 'Placing your order', browser: 'Working on it', page: 'Reading the page'
  };
  function progress(m) {
    const state = m.state || 'working';
    const label = m.label || PROGRESS_LABELS[m.kind || 'browser'];
    if (state === 'done')
      return '<div class="msg-in"><div class="rm-prog done"><span class="rm-ck">✓</span> ' +
        esc(m.detail || label) + '</div></div>';
    if (state === 'error')
      return '<div class="msg-in"><div class="rm-prog err">' + esc(m.detail || 'Something didn\'t work.') + '</div></div>';
    return '<div class="msg-in"><div class="rm-prog"><span class="dots">' +
      esc(label) + '</span></div></div>';
  }

  /* ------------------------------------------------------------------ *
   * 4. RESULT CARDS — {role:'results', kind, items, state, ...}
   *    kinds: subscriptions | restaurants | search | places
   *    states: loading | ready | empty | error
   * ------------------------------------------------------------------ */
  function skeleton() {
    return '<div class="msg-in"><div class="rm-res"><div class="rm-skel" aria-label="Loading">' +
      '<i class="w60"></i><i class="w80"></i><i class="w40"></i></div></div></div>';
  }
  function emptyState(text) {
    return '<div class="msg-in"><div class="rm-empty">' + esc(text || 'Nothing found.') + '</div></div>';
  }

  function subscriptionCard(s) {
    // s: {merchant, amount, currency, cadence, renews, email}
    return '<div class="rm-card"><div class="rm-top"><span class="rm-name">' + esc(s.merchant) +
      '</span><span class="rm-amt">' + esc(money(s.amount, s.currency)) + '</span></div>' +
      '<div class="rm-sub">' + esc([s.cadence, s.renews ? 'renews ' + s.renews : '', s.email ? '· ' + s.email : '']
        .filter(Boolean).join(' ')) + '</div>' +
      '<div class="rm-actions"><button class="rm-btn danger" data-rsub="' + esc(s.merchant) +
      '">Cancel</button></div></div>';
  }
  function restaurantCard(r) {
    // r: {name, cuisine, rating, distance, price, open}
    const stars = r.rating ? '<span class="rm-stars">' + '★'.repeat(Math.round(r.rating)) + '</span> ' : '';
    return '<div class="rm-card"><div class="rm-top"><span class="rm-name">' + esc(r.name) + '</span>' +
      (r.distance ? '<span class="rm-amt" style="font-weight:500;font-size:14px">' + esc(r.distance) + '</span>' : '') + '</div>' +
      '<div class="rm-row">' + stars + '<span>' + esc([r.cuisine, r.price].filter(Boolean).join(' · ')) + '</span></div>' +
      (r.open ? '<div class="rm-sub">' + esc(r.open) + '</div>' : '') +
      '<div class="rm-actions"><button class="rm-btn primary" data-rbook="' + esc(r.name) +
      '">Book</button><button class="rm-btn" data-rqr="order an uber to ' + esc(r.name) +
      '">Get a ride</button></div></div>';
  }
  function searchCard(s) {
    // s: {title, snippet, url}
    return '<div class="rm-card"><div class="rm-top"><span class="rm-name" style="font-size:15px">' +
      esc(s.title) + '</span></div>' +
      (s.snippet ? '<div class="rm-sub">' + esc(s.snippet) + '</div>' : '') +
      (s.url ? '<a class="rm-link" href="' + esc(s.url) + '" target="_blank" rel="noopener">' +
        esc(s.url.replace(/^https?:\/\//, '').split('/')[0]) + ' ↗</a>' : '') + '</div>';
  }

  var RESULT_TITLES = {
    subscriptions: 'Subscriptions found', restaurants: 'Top picks',
    search: 'Results', places: 'Nearby'
  };
  function results(m) {
    const state = m.state || 'ready';
    if (state === 'loading') return skeleton();
    if (state === 'error')
      return notice({ tone: 'error', title: 'Couldn\'t load that', body: m.errorText || 'Something went wrong fetching the results.', retryText: m.retryText || 'Try again' });
    const items = m.items || [];
    if (!items.length)
      return emptyState(m.emptyText || 'Nothing found. Try widening the search.');
    const kind = m.kind || 'search';
    const card = kind === 'subscriptions' ? subscriptionCard :
      kind === 'restaurants' || kind === 'places' ? restaurantCard : searchCard;
    return '<div class="msg-in"><div class="rm-res">' +
      '<div class="rm-res-title">' + esc(m.title || RESULT_TITLES[kind] || 'Results') + '</div>' +
      items.slice(0, 8).map(card).join('') + // max 8 — never an endless list
      '</div></div>';
  }

  /* ------------------------------------------------------------------ *
   * 5. NOTICE — error / info / warn with retry + alternative.
   *    {role:'notice', tone, title, body, retryText, altText}
   *    RULE: never an error code, never a stack trace, never "Error [x]".
   * ------------------------------------------------------------------ */
  function notice(m) {
    const tone = m.tone || 'info';
    return '<div class="msg-in"><div class="rm-notice ' + tone + '" role="alert">' +
      (m.title ? '<div class="rm-nt">' + esc(m.title) + '</div>' : '') +
      (m.body ? '<div class="rm-nb">' + esc(m.body) + '</div>' : '') +
      ((m.retryText || m.altText) ? '<div class="rm-actions">' +
        (m.retryText ? '<button class="rm-btn" data-rretry="' + esc(m.retryTextSend || m.retryText) + '">' + esc(m.retryText) + '</button>' : '') +
        (m.altText ? '<button class="rm-btn" data-ralt="' + esc(m.altTextSend || m.altText) + '">' + esc(m.altText) + '</button>' : '') +
        '</div>' : '') +
      '</div></div>';
  }
  // Convenience constructors for the common error states (plain language).
  var ERRORS = {
    site: function () { return notice({ tone: 'error', title: "Couldn't open that site", body: 'The page didn\'t load. It might be down or blocking automated browsers.', retryText: 'Try again', altText: 'Try a different way' }); },
    session: function () { return notice({ tone: 'error', title: 'Lost the browser session', body: 'The page closed unexpectedly. Nothing was changed.', retryText: 'Start over' }); },
    auth: function () { return notice({ tone: 'warn', title: 'Sign-in needed', body: 'That site needs you to sign in first. It takes about 30 seconds.', retryText: 'Show me how' }); },
    offline: function () { return notice({ tone: 'error', title: "You're offline", body: 'Check your connection and try again.', retryText: 'Retry' }); }
  };

  /* ------------------------------------------------------------------ *
   * 6. STEPS — max 4 numbered steps. {role:'steps', title?, items:[{t,done}]}
   * ------------------------------------------------------------------ */
  function steps(m) {
    const items = (m.items || []).slice(0, 4); // HARD MAX 4 — never a 10-step dump
    if (!items.length) return '';
    return '<div class="msg-in"><div class="rm-steps" aria-label="' + esc(m.title || 'Steps') + '">' +
      items.map(function (s, i) {
        const t = typeof s === 'string' ? s : s.t;
        const done = typeof s === 'object' && s.done;
        return '<div class="rm-step' + (done ? ' done' : '') + '"><span class="n">' +
          (done ? '✓' : (i + 1)) + '</span><span class="t">' + esc(t) + '</span></div>';
      }).join('') + '</div></div>';
  }

  /* ------------------------------------------------------------------ *
   * 7. GROUP — participant header, sent indicator, privacy badge.
   * ------------------------------------------------------------------ */
  function groupHeader(m) {
    // m: {members:[names], secret?:bool}
    const members = m.members || [];
    if (!members.length && !m.secret) return '';
    const shown = members.slice(0, 5);
    const extra = members.length - shown.length;
    return '<div class="rm-ghead"><div class="rm-avatars">' +
      shown.map(function (n) {
        return '<span class="rm-avatar" style="background:hsl(' + hue(n) + ',45%,72%)" title="' +
          esc(n) + '">' + esc(initials(n)) + '</span>';
      }).join('') + '</div><span class="rm-gnames">' +
      esc(shown.join(', ')) + (extra > 0 ? ' +' + extra + ' more' : '') + '</span></div>' +
      (m.secret ? '<span class="rm-privacy">🔒 Secret · only members see this</span>' : '');
  }
  function sentIndicator(m) {
    // m: {sentTo:[names] | count}
    const n = Array.isArray(m.sentTo) ? m.sentTo.length : (m.sentTo || 0);
    if (!n) return '';
    const names = Array.isArray(m.sentTo) ? m.sentTo.slice(0, 3).join(', ') +
      (m.sentTo.length > 3 ? ' +' + (m.sentTo.length - 3) + ' more' : '') : '';
    return '<div class="rm-sent"><span class="ok">✓</span> Sent to ' + n +
      ' ' + (n === 1 ? 'person' : 'people') + (names ? ' · ' + esc(names) : '') + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * 8. MARKDOWN BUILDERS — well-formed agent text (feeds mdHTML).
   *    Rules: bullets flat (no nesting), steps ≤4, bold sparing, links real.
   * ------------------------------------------------------------------ */
  var md = {
    bullets: function (items) {
      return (items || []).slice(0, 8).map(function (i) { return '• ' + i; }).join('\n');
    },
    steps: function (items) {
      return (items || []).slice(0, 4).map(function (s, i) { return (i + 1) + '. ' + s; }).join('\n');
    },
    kv: function (k, v) { return '**' + k + ':** ' + v; },
    link: function (text, url) { return '[' + text + '](' + url + ')'; },
    // Compact subscription summary line (Muse-style single sentence).
    subSummary: function (subs) {
      if (!subs || !subs.length) return 'No active subscriptions found in the last 90 days.';
      const parts = subs.slice(0, 6).map(function (s) {
        return s.merchant + ' (' + money(s.amount, s.currency) +
          (s.cadence ? '/' + s.cadence.replace('ly', '') : '') + ')';
      });
      return 'You have ' + subs.length + ' active subscription' +
        (subs.length === 1 ? '' : 's') + ': ' + parts.join(', ') +
        (subs.length > 6 ? ', and ' + (subs.length - 6) + ' more' : '') + '.';
    }
  };

  /* ------------------------------------------------------------------ *
   * 9. STATUS TAG — inline pill for agent text: <span class="rm-tag ok">
   * ------------------------------------------------------------------ */
  function tag(text, kind) {
    return '<span class="rm-tag ' + (kind || 'ok') + '">' + esc(text) + '</span>';
  }

  /* ------------------------------------------------------------------ *
   * DISPATCH — render(m) routes a message object to the right renderer.
   * ------------------------------------------------------------------ */
  function render(m) {
    if (!m || !m.role) return '';
    switch (m.role) {
      case 'quickreplies': return quickReplies(m);
      case 'progress': return progress(m);
      case 'results': return results(m);
      case 'notice': return notice(m);
      case 'steps': return steps(m);
      default: return '';
    }
  }

  global.RMsg = {
    approvalFields: approvalFields,
    quickReplies: quickReplies, progress: progress, results: results,
    notice: notice, errors: ERRORS, steps: steps,
    groupHeader: groupHeader, sentIndicator: sentIndicator,
    md: md, tag: tag, render: render,
    // exposed for tests
    _esc: esc, _money: money
  };
})(typeof window !== 'undefined' ? window : globalThis);
