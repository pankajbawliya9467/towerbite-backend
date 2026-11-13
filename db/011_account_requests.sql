-- "Delete my account / data" requests from the website (needed for Play Store). An admin works through
-- them in the CRM (Admin → Account requests). Safe to re-run.
create table if not exists account_requests (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  name text not null default '',
  kind text not null default 'delete_account' check (kind in ('delete_account', 'delete_data')),
  reason text not null default '' check (length(reason) <= 500),
  status text not null default 'pending' check (status in ('pending', 'done', 'rejected')),
  note text not null default '',
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
create index if not exists account_requests_status_idx on account_requests (status, created_at desc);
alter table account_requests enable row level security;
