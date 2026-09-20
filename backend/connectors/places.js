// Places connector — restaurant discovery via Google Places API (New).
// Needs: GOOGLE_PLACES_API_KEY (same Google Cloud project as Gmail).
// Powers "find a dinner spot" — search, details, photos, geocoding.
const { env, missing, NotConfigured } = require('../lib/config');

const requiredEnv = ['GOOGLE_PLACES_API_KEY'];

function status() {
  const m = missing(requiredEnv);
  return { ok: m.length === 0, missing: m };
}

function guard() {
  const m = missing(requiredEnv);
  if (m.length) throw new NotConfigured('Places', m);
}

async function search({ query, lat, lng, radius = 2500, maxResults = 8 }) {
  guard();
  const body = { textQuery: query, maxResultCount: maxResults };
  if (lat != null && lng != null) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius } };
  }
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env('GOOGLE_PLACES_API_KEY'),
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.formattedAddress,places.rating,places.priceLevel,places.currentOpeningHours.openNow,places.location',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Places API ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return (data.places || []).map((p) => ({
    id: p.id,
    name: p.displayName?.text,
    address: p.formattedAddress,
    rating: p.rating,
    priceLevel: p.priceLevel,
    openNow: p.currentOpeningHours?.openNow,
    lat: p.location?.latitude,
    lng: p.location?.longitude,
  }));
}

async function geocode({ address }) {
  guard();
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env('GOOGLE_PLACES_API_KEY'),
      'X-Goog-FieldMask': 'places.displayName,places.location',
    },
    body: JSON.stringify({ textQuery: address, maxResultCount: 1 }),
  });
  const data = await r.json().catch(() => ({}));
  const p = (data.places || [])[0];
  if (!p) throw new Error('no match for address: ' + address);
  return { name: p.displayName?.text, lat: p.location?.latitude, lng: p.location?.longitude };
}

module.exports = { requiredEnv, status, search, geocode };
