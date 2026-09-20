// Dining connector — restaurant booking across OpenTable, Resy, Tock.
//
// REALITY: none of these offer a self-serve consumer booking API.
//   - OpenTable: partner-only API (apply: dev.opentable.com/partner-portal).
//   - Resy: no public API, partner-only. The reverse-engineered api.resy.com
//     path exists but is fragile — kept as explicit opt-in, never default.
//   - Tock: no public API.
// So: deep links work TODAY (slot prefilled, user confirms in the app);
// direct methods throw PARTNERSHIP_REQUIRED until the business track lands.
const { missing, PartnershipRequired } = require('../lib/config');

const requiredEnv = []; // deep links need no key
const partnerEnv = ['OPENTABLE_PARTNER_ID', 'OPENTABLE_API_KEY'];

function status() {
  const m = missing(partnerEnv);
  return {
    ok: true,
    missing: [],
    mode: 'deep-link',
    directBooking: m.length === 0 ? 'partner-keys-present' : 'partnership-required',
  };
}

// --- Deep links (work today) -------------------------------------------
function opentableLink({ slug, dateTime, covers = 2 }) {
  const q = new URLSearchParams({ dateTime, covers: String(covers) });
  return `https://www.opentable.com/r/${slug}?${q.toString()}`;
}

function resyLink({ city, slug, date, seats = 2 }) {
  const q = new URLSearchParams({ date, seats: String(seats) });
  return `https://resy.com/cities/${city}/${slug}?${q.toString()}`;
}

function tockLink({ slug }) {
  return `https://www.exploretock.com/${slug}`;
}

// --- Direct booking (partnership track) ---------------------------------
function findSlots() {
  throw new PartnershipRequired(
    'OpenTable direct availability',
    'partner API required — apply at dev.opentable.com/partner-portal; use deep links for now'
  );
}

function bookTable() {
  throw new PartnershipRequired(
    'Direct table booking',
    'no self-serve booking API on OpenTable/Resy/Tock — use deep links for now'
  );
}

// Unofficial Resy web-API path (api.resy.com). Opt-in only: set
// RESY_API_KEY + RESY_AUTH_TOKEN. Undocumented, can break without notice.
// Flow (from the community's reverse-engineering): GET /4/find → slots with
// config tokens, POST /3/details → book token, POST /3/book → reservation.
const { env: env2 } = require('../lib/config');
async function resyFetch(path, { method = 'GET', body } = {}) {
  const r = await fetch(`https://api.resy.com${path}`, {
    method,
    headers: {
      Authorization: `ResyAPI api_key="${env2('RESY_API_KEY')}"`,
      'X-Resy-Auth-Token': env2('RESY_AUTH_TOKEN'),
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resy API ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function resyFindSlots({ venueId, date, partySize = 2 }) {
  const m = missing(['RESY_API_KEY', 'RESY_AUTH_TOKEN']);
  if (m.length) {
    throw new PartnershipRequired(
      'Resy unofficial availability',
      'opt-in path needs RESY_API_KEY + RESY_AUTH_TOKEN — see docs/keys-and-access.md'
    );
  }
  const q = new URLSearchParams({ lat: '0', long: '0', day: date, party_size: String(partySize), venue_id: String(venueId) });
  const data = await resyFetch(`/4/find?${q}`);
  const venue = data.results?.venues?.[0];
  return (venue?.slots || []).map((s) => ({
    time: s.date?.start,
    end: s.date?.end,
    token: s.config?.token,
    type: s.config?.type,
  }));
}

async function resyBookUnofficial({ slotToken, date, partySize = 2 }) {
  const m = missing(['RESY_API_KEY', 'RESY_AUTH_TOKEN']);
  if (m.length) {
    throw new PartnershipRequired(
      'Resy unofficial booking',
      'opt-in path needs RESY_API_KEY + RESY_AUTH_TOKEN — see docs/keys-and-access.md'
    );
  }
  const details = await resyFetch('/3/details', { method: 'POST', body: { config_id: slotToken, day: date, party_size: partySize } });
  const bookToken = details?.book_token?.value;
  if (!bookToken) throw new Error('Resy did not return a book token');
  const booked = await resyFetch('/3/book', { method: 'POST', body: { book_token: bookToken } });
  return { reservationId: booked?.resy_token || booked?.id, raw: booked };
}

module.exports = {
  requiredEnv,
  status,
  opentableLink,
  resyLink,
  tockLink,
  findSlots,
  bookTable,
  resyFindSlots,
  resyBookUnofficial,
};
