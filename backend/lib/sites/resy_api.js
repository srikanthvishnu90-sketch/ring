// backend/lib/sites/resy_api.js — Restaurant booking via Resy REST API.
//
// Reliable API-based approach (not fragile browser automation).
// Endpoints documented from resyctl and community API docs.
//
//   POST /3/auth/password       - email+password → JWT token
//   POST /3/venuesearch/search  - search venues by query
//   GET  /3/venue               - venue details by slug or id
//   GET  /4/find                - availability slots
//   GET  /3/details             - slot details → book_token
//   POST /3/book                - complete booking

const RESY_API_KEY = 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5';
const API_BASE = 'https://api.resy.com';

function headers(token, contentType = 'application/json') {
  const h = {
    'Authorization': `ResyAPI api_key="${RESY_API_KEY}"`,
    'x-origin': 'https://resy.com',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  };
  if (contentType) h['Content-Type'] = contentType;
  if (token) h['X-Resy-Auth-Token'] = token;
  return h;
}

async function apiGet(path, { token = null, params = null } = {}) {
  let url = `${API_BASE}${path}`;
  if (params) url += '?' + new URLSearchParams(params).toString();
  const res = await fetch(url, { headers: headers(token, null) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resy GET ${path}: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function apiPost(path, { token = null, body = null, form = false } = {}) {
  const h = headers(token, form ? 'application/x-www-form-urlencoded' : 'application/json');
  const opts = { method: 'POST', headers: h };
  if (body) opts.body = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resy POST ${path}: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// Authenticate → JWT token (valid ~12h)
async function getAuthToken(email, password) {
  const data = await apiPost('/3/auth/password', {
    form: true,
    body: { email, password },
  });
  if (!data.token) throw new Error('Resy auth failed: no token returned');
  return data.token;
}

// Search venues by name. Returns [{ venue_id, name, ... }]
async function searchVenues(query, { lat = 41.8781, lng = -87.6298 } = {}) {
  const data = await apiPost('/3/venuesearch/search', {
    body: {
      query,
      types: ['venue'],
      page: 1,
      per_page: 20,
      geo: { latitude: lat, longitude: lng, radius: 50000 },
    },
  });
  const hits = data.search?.hits || data.hits || [];
  return hits.map(h => ({
    venue_id: h.id?.resy || h.venue_id || h.id,
    name: h.name,
    locality: h.locality,
    url_slug: h.url_slug,
    _raw: h,
  }));
}

// Resolve venue details (numeric id) by slug+city
async function getVenueBySlug(slug, citySlug, token = null) {
  const data = await apiGet('/3/venue', {
    token,
    params: { url_slug: slug, location: citySlug },
  });
  return data.venue;
}

// Availability slots for venue+date+party
async function getAvailability(venueId, date, partySize, { lat = 41.8781, lng = -87.6298, token = null } = {}) {
  const data = await apiGet('/4/find', {
    token,
    params: { lat, long: lng, day: date, party_size: partySize, venue_id: venueId },
  });
  const venues = data.results?.venues || [];
  const slots = venues[0]?.slots || [];
  return slots.map(s => ({
    slot_id: s.config?.token,
    start: s.date?.start, // "2026-10-03 19:30:00"
    type: s.config?.type,
    _raw: s,
  })).filter(s => s.slot_id && s.start);
}

// Get book token for a slot
async function getSlotDetails(slotId, date, partySize, venueId, token) {
  const data = await apiGet('/3/details', {
    token,
    params: {
      config_id: slotId,
      day: date,
      party_size: partySize,
      venue_id: venueId,
    },
  });
  return data;
}

// Complete the booking
async function bookReservation({ token, bookToken, firstName, lastName, email, phone }) {
  const data = await apiPost('/3/book', {
    token,
    body: {
      book_token: bookToken,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
    },
  });
  return data;
}

module.exports = {
  getAuthToken,
  searchVenues,
  getVenueBySlug,
  getAvailability,
  getSlotDetails,
  bookReservation,
  apiGet,
  apiPost,
};
