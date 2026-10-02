-- migration-006.sql — browser_auth_states: per-user persistent browser auth state.
--
-- One row per user. encrypted_state holds the AES-256-GCM encrypted Playwright
-- storageState (cookies + localStorage) so logins (e.g. Google) persist across
-- browser sessions. The plaintext NEVER touches this table — only ciphertext.
--
-- RLS: service_role only (same as other ring tables). The backend uses the
-- service key; no anon access.

create table if not exists browser_auth_states (
  user_id text primary key,
  encrypted_state text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Service-role-only: no policies for anon/authenticated (deny by default with RLS on).
alter table browser_auth_states enable row level security;
