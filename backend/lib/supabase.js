// Shared Supabase (PostgREST) helper. When SUPABASE_URL + SUPABASE_SERVICE_KEY
// are set, modules persist to Postgres; otherwise they fall back to in-memory
// storage (local dev). Tables live in the "ring" Supabase project; RLS is
// enabled with no public policies, so only the service_role key can read/write.
const { env } = require('./config');

const SB_URL = env('SUPABASE_URL');
const SB_KEY = env('SUPABASE_SERVICE_KEY');
const ENABLED = !!(SB_URL && SB_KEY);

async function sbRequest(pathname, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${pathname}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const eq = encodeURIComponent;

module.exports = { ENABLED, sbRequest, eq };
