-- Admin 2-step login (authenticator app codes). Safe to re-run.

-- Admin logins made before 2-step login existed are ended once (only the first time this file runs),
-- so every admin goes through the new code step.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'admins' and column_name = 'totp_secret') then
    delete from sessions where kind = 'admin';
  end if;
end $$;

-- The authenticator secret is stored encrypted with the server's TOTP_KEY (never in plain text).
alter table admins add column if not exists totp_secret text;
alter table admins add column if not exists totp_enabled_at timestamptz;
-- The last 30-second step a code was accepted for: the same code can't be used twice.
alter table admins add column if not exists totp_last_step bigint not null default 0;

-- One-time backup codes (only a hash is stored). Used when the phone with the authenticator is lost.
create table if not exists admin_backup_codes (
  admin_id uuid not null references admins(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (admin_id, code_hash)
);
alter table admin_backup_codes enable row level security;

-- Password was right, waiting for the code (5 minutes, 5 tries). Only a hash of the token is stored.
create table if not exists login_challenges (
  token_hash text primary key,
  admin_id uuid not null references admins(id) on delete cascade,
  purpose text not null check (purpose in ('code', 'setup')),
  pending_secret text,
  attempts int not null default 0,
  user_agent text not null default '',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists login_challenges_admin_idx on login_challenges (admin_id);
create index if not exists login_challenges_expiry_idx on login_challenges (expires_at);
alter table login_challenges enable row level security;

-- Wrong codes, kept in the database so a restart or deploy doesn't reset the lock.
create table if not exists auth_fails (
  id bigserial primary key,
  key text not null,
  created_at timestamptz not null default now()
);
create index if not exists auth_fails_key_idx on auth_fails (key, created_at);
alter table auth_fails enable row level security;
