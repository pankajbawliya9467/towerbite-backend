-- Our own login sessions (the app logs in through the API, not straight to Supabase). Only a hash of each
-- token is stored. Safe to re-run.
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null,
  phone text,
  user_agent text not null default '',
  -- logged in with the test code: ends as soon as the number stops being a test number
  via_test boolean not null default false,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_expiry_idx on sessions (expires_at);
alter table sessions enable row level security;
create index if not exists profiles_phone_idx on profiles (phone);
