// Uber connector.
//
// REALITY: Uber has no public self-serve ride-request API (requesting a ride
// was partner-whitelist only). So this connector has two modes:
//   - rideLink(): WORKS TODAY — builds a universal link that opens the Uber
//     app with pickup/dropoff prefilled. The user confirms and pays in Uber,
//     which is also the right approval UX for a paid ride.
//   - requestRide(): partnership track — throws PARTNERSHIP_REQUIRED until
//     an Uber partnership / Uber for Business agreement is signed, at which
//     point UBER_CLIENT_ID / UBER_CLIENT_SECRET activate it.
const { PartnershipRequired } = require('../lib/config');

const requiredEnv = []; // deep links need no key

function status() {
  return { ok: true, missing: [], mode: 'deep-link', directBooking: 'partnership-required' };
}

// Universal link format: https://m.uber.com/go/?action=setPickup&pickup[latitude]=..&...
function rideLink({ pickup, dropoff }) {
  const q = new URLSearchParams({ action: 'setPickup' });
  if (pickup) {
    q.set('pickup[latitude]', String(pickup.lat));
    q.set('pickup[longitude]', String(pickup.lng));
    if (pickup.label) q.set('pickup[nickname]', pickup.label);
  }
  if (dropoff) {
    q.set('dropoff[latitude]', String(dropoff.lat));
    q.set('dropoff[longitude]', String(dropoff.lng));
    if (dropoff.label) q.set('dropoff[nickname]', dropoff.label);
  }
  return `https://m.uber.com/go/?${q.toString()}`;
}

function requestRide() {
  throw new PartnershipRequired(
    'Uber direct booking',
    'no public ride-request API — needs an Uber partnership; use rideLink() for now'
  );
}

module.exports = { requiredEnv, status, rideLink, requestRide };
