-- Ring prod persistence, part 2: approvals, threads, messages.
-- Applied 2026-09-20 to Supabase project "ring" (kjwvqwkuprfhftmfflnu).
-- RLS enabled with no public policies: service_role only.

create table if not exists ring_approvals (
  id text primary key,
  tool text not null,
  risk text not null,
  describe text,
  args jsonb not null default '{}',
  user_id text not null default 'local',
  thread_id text,
  idempotency_key text,
  status text not null default 'pending',
  result jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists ring_approvals_status_idx on ring_approvals (status, user_id);

create table if not exists ring_threads (
  id text primary key,
  name text not null default 'New group',
  members jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists ring_messages (
  id text primary key,
  thread_id text not null references ring_threads(id) on delete cascade,
  sender text not null,
  text text not null,
  pending_approvals jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ring_messages_thread_idx on ring_messages (thread_id, created_at);

alter table ring_approvals enable row level security;
alter table ring_threads enable row level security;
alter table ring_messages enable row level security;

notify pgrst, 'reload schema';
