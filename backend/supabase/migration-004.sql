-- Ring device registry for hardware integration.
-- Applied 2026-09-21 to Supabase project "ring" (kjwvqwkuprfhftmfflnu).
-- RLS enabled with no public policies: service_role only (backend enforces ownership).

create table if not exists ring_devices (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  ble_id text not null unique,
  name text,
  battery int,
  firmware text,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists ring_devices_user_idx on ring_devices (user_id);

alter table ring_devices enable row level security;

notify pgrst, 'reload schema';
