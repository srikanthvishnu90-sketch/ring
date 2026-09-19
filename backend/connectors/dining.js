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
async function resyBookUnofficial({ venueId, date, time, partySize }) {
  const m = missing(['RESY_API_KEY', 'RESY_AUTH_TOKEN']);
  if (m.length) {
    throw new PartnershipRequired(
      'Resy unofficial booking',
      'opt-in path needs RESY_API_KEY + RESY_AUTH_TOKEN — see docs/keys-and-access.md'
    );
  }
  // Flow: GET /4/find → POST /3/details (configId → bookToken) → POST /3/book
  throw new Error('TODO: implement find → details → book against api.resy.com');
}

module.exports = {
  requiredEnv,
  status,
  opentableLink,
  resyLink,
  tockLink,
  findSlots,
  bookTable,
  resyBookUnofficial,
};
