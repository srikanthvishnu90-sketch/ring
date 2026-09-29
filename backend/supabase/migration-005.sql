-- Browser automation sessions for the tier-2 outcomes executor.
-- Each row tracks one Browserbase session so multi-phase jobs (OTP login,
-- estimate -> approval -> book) can resume the same live browser across
-- separate serverless invocations. connect_url is sensitive: RLS enabled with
-- no public policies (service_role only); it must NEVER appear in tool output.
-- Applied to Supabase project "ring" (kjwvqwkuprfhftmfflnu).

create table if not exists browser_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  site text not null,
  bb_session_id text not null,
  connect_url text not null,
  status text not null default 'live', -- live | closed | expired
  purpose text,                        -- job kind, e.g. 'book-ride' (audit)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists browser_sessions_user_idx on browser_sessions (user_id);
create index if not exists browser_sessions_status_idx on browser_sessions (status);
create index if not exists browser_sessions_bb_idx on browser_sessions (bb_session_id);

alter table browser_sessions enable row level security;

notify pgrst, 'reload schema';
