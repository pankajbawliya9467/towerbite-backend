-- Security fixes (2026-11-26 review). Safe to re-run.

-- Sessions know who they belong to, so admin logins can be short and customer logins long.
alter table sessions add column if not exists kind text not null default 'user';
update sessions s set kind = 'admin' where kind = 'user' and exists (select 1 from admins a where a.id = s.user_id);
update sessions s set kind = 'cafe' where kind = 'user' and exists (select 1 from staff x where x.user_id = s.user_id);
-- Existing admin logins get the new short limits straight away.
update sessions set expires_at = least(expires_at, now() + interval '12 hours') where kind = 'admin';

-- Every login SMS sent, so daily limits survive restarts and work across servers (SMS cost protection).
create table if not exists sms_sends (
  id bigserial primary key,
  phone text not null,
  created_at timestamptz not null default now()
);
create index if not exists sms_sends_time_idx on sms_sends (created_at);
create index if not exists sms_sends_phone_idx on sms_sends (phone, created_at);
alter table sms_sends enable row level security;

-- Deletion requests: was the number proven (logged in with it) when the request was made?
alter table account_requests add column if not exists verified boolean not null default false;
