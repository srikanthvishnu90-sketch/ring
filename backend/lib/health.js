// Basic health tracker: per-user metric logs. Supabase (ring_health_logs)
// when configured, in-memory otherwise. Follows the lib/memory.js pattern.
//
// NOTE: does not require ./agent — keep it free of the agent dependency to
// avoid a require cycle.
const { ENABLED, sbRequest, eq } = require('./supabase');

const TBL = 'ring_health_logs';
const FETCH_CAP = 500;

// Canonical metric definitions: unit + how daily values aggregate.
const METRICS = {
  steps:           { unit: 'steps',   agg: 'sum', label: 'Steps' },
  sleep_hours:     { unit: 'hours',   agg: 'sum', label: 'Sleep' },
  water_ml:        { unit: 'ml',      agg: 'sum', label: 'Water' },
  weight_kg:       { unit: 'kg',      agg: 'avg', label: 'Weight' },
  workout_minutes: { unit: 'minutes', agg: 'sum', label: 'Workouts' },
  mood:            { unit: '1-5',     agg: 'avg', label: 'Mood' },
  energy:          { unit: '1-5',     agg: 'avg', label: 'Energy' },
};

// Aliases the model might use.
const ALIASES = {
  step: 'steps', sleep: 'sleep_hours', water: 'water_ml', weight: 'weight_kg',
  workout: 'workout_minutes', exercise: 'workout_minutes', exercise_minutes: 'workout_minutes',
};

const nowIso = () => new Date().toISOString();
let seq = 1;
const newId = () => 'hl_' + Date.now().toString(36) + (seq++).toString(36);

// ---- in-memory fallback (local dev) ----
const mem = []; // [{ id, userId, metric, value, unit, note, loggedAt, createdAt }]

// Parse flexible value input: numbers, "8k", "8,000", "2.5".
// Unit hints convert to the canonical unit: L->ml, lbs->kg, hrs->hours.
function parseValue(metric, value, unit) {
  let s = String(value == null ? '' : value).trim().toLowerCase().replace(/,/g, '');
  if (!s) throw new Error('value is required');
  let mult = 1;
  const k = s.match(/^([\d.]+)\s*k$/);
  if (k) { s = k[1]; mult = 1000; }
  const num = Number(s);
  if (!Number.isFinite(num)) throw new Error(`could not parse a number from "${value}"`);
  let v = num * mult;
  const u = String(unit || '').trim().toLowerCase();
  if (metric === 'water_ml' && (u === 'l' || u === 'liter' || u === 'liters' || u === 'litre' || u === 'litres')) v *= 1000;
  if (metric === 'weight_kg' && (u === 'lb' || u === 'lbs' || u === 'pound' || u === 'pounds')) v *= 0.453592;
  if (metric === 'sleep_hours' && (u === 'm' || u === 'min' || u === 'mins' || u === 'minutes')) v /= 60;
  if ((metric === 'mood' || metric === 'energy') && (v < 1 || v > 5)) {
    throw new Error(`${metric} must be between 1 and 5`);
  }
  if (v < 0) throw new Error('value must not be negative');
  return Math.round(v * 100) / 100;
}

function canonMetric(m) {
  const key = String(m || '').trim().toLowerCase();
  return METRICS[key] ? key : ALIASES[key] || null;
}

function toRec(row) {
  return {
    id: row.id,
    userId: row.user_id,
    metric: row.metric,
    value: Number(row.value),
    unit: row.unit,
    note: row.note || null,
    loggedAt: row.logged_at,
    createdAt: row.created_at,
  };
}

// UTC start/end ISO bounds for "today" in the given IANA timezone.
function todayBounds(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  const offsetMs = asUtc - now.getTime();
  const startMs = Date.UTC(get('year'), get('month') - 1, get('day')) - offsetMs;
  return { start: new Date(startMs).toISOString(), end: new Date(startMs + 86400000).toISOString() };
}

function dayKey(iso, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

// 1. Log a metric. Returns the record.
async function log(userId, { metric, value, unit, note, loggedAt }) {
  const m = canonMetric(metric);
  if (!m) throw new Error(`unknown metric "${metric}" — use one of: ${Object.keys(METRICS).join(', ')}`);
  const v = parseValue(m, value, unit);
  const rec = {
    id: newId(),
    user_id: userId,
    metric: m,
    value: v,
    unit: METRICS[m].unit,
    note: note || null,
    logged_at: loggedAt || nowIso(),
    created_at: nowIso(),
  };
  if (ENABLED) {
    const rows = await sbRequest(`/${TBL}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(rec),
    });
    return toRec(rows[0]);
  }
  const stored = { id: rec.id, userId, metric: m, value: v, unit: METRICS[m].unit, note: note || null, loggedAt: rec.logged_at, createdAt: rec.created_at };
  mem.push(stored);
  return stored;
}

// 2. Today's logs, grouped by metric. tz defaults to the user's timezone.
async function today(userId, { tz = 'Europe/Rome' } = {}) {
  const { start, end } = todayBounds(tz);
  let rows;
  if (ENABLED) {
    rows = await sbRequest(
      `/${TBL}?select=*&user_id=eq.${eq(userId)}&logged_at=gte.${eq(start)}&logged_at=lt.${eq(end)}&order=logged_at.asc&limit=${FETCH_CAP}`
    );
    rows = (rows || []).map(toRec);
  } else {
    rows = mem.filter((r) => r.userId === userId && r.loggedAt >= start && r.loggedAt < end)
      .sort((a, b) => (a.loggedAt < b.loggedAt ? -1 : 1));
  }
  const grouped = {};
  for (const r of rows) {
    (grouped[r.metric] = grouped[r.metric] || []).push(r);
  }
  return { date: dayKey(start, tz), timezone: tz, metrics: grouped };
}

// Fetch raw logs in a window (shared by trends/summary).
async function windowLogs(userId, startIso, endIso) {
  if (ENABLED) {
    const rows = await sbRequest(
      `/${TBL}?select=*&user_id=eq.${eq(userId)}&logged_at=gte.${eq(startIso)}&logged_at=lt.${eq(endIso)}&order=logged_at.asc&limit=${FETCH_CAP}`
    );
    return (rows || []).map(toRec);
  }
  return mem.filter((r) => r.userId === userId && r.loggedAt >= startIso && r.loggedAt < endIso)
    .sort((a, b) => (a.loggedAt < b.loggedAt ? -1 : 1));
}

function aggregate(metric, values) {
  if (!values.length) return null;
  const agg = METRICS[metric].agg;
  const v = agg === 'sum'
    ? values.reduce((a, b) => a + b, 0)
    : values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(v * 100) / 100;
}

// 3. Daily aggregates for one metric over the last N days + min/max/avg.
async function trends(userId, { metric, days = 7, tz = 'Europe/Rome' } = {}) {
  const m = canonMetric(metric);
  if (!m) throw new Error(`unknown metric "${metric}" — use one of: ${Object.keys(METRICS).join(', ')}`);
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const { start } = todayBounds(tz);
  const startMs = new Date(start).getTime() - (n - 1) * 86400000;
  const startIso = new Date(startMs).toISOString();
  const rows = (await windowLogs(userId, startIso, new Date(new Date(start).getTime() + 86400000).toISOString()))
    .filter((r) => r.metric === m);
  const byDay = {};
  for (const r of rows) {
    const d = dayKey(r.loggedAt, tz);
    (byDay[d] = byDay[d] || []).push(r.value);
  }
  const daily = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = dayKey(new Date(startMs + (n - 1 - i) * 86400000).toISOString(), tz);
    const vals = byDay[d] || [];
    daily.push({ date: d, value: aggregate(m, vals), entries: vals.length });
  }
  const vals = daily.map((d) => d.value).filter((v) => v != null);
  return {
    metric: m, label: METRICS[m].label, unit: METRICS[m].unit, days: n,
    daily,
    min: vals.length ? Math.min(...vals) : null,
    max: vals.length ? Math.max(...vals) : null,
    avg: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 100) / 100 : null,
  };
}

// 4. Per-metric aggregates over the last N days.
async function summary(userId, { days = 7, tz = 'Europe/Rome' } = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const { start } = todayBounds(tz);
  const startMs = new Date(start).getTime() - (n - 1) * 86400000;
  const rows = await windowLogs(userId, new Date(startMs).toISOString(), new Date(new Date(start).getTime() + 86400000).toISOString());
  const byMetric = {};
  for (const r of rows) {
    (byMetric[r.metric] = byMetric[r.metric] || []).push(r.value);
  }
  const metrics = {};
  for (const [m, vals] of Object.entries(byMetric)) {
    metrics[m] = {
      label: METRICS[m].label, unit: METRICS[m].unit,
      [METRICS[m].agg === 'sum' ? 'total' : 'average']: aggregate(m, vals),
      entries: vals.length,
    };
  }
  return { days: n, metrics };
}

module.exports = { log, today, trends, summary, METRICS };
