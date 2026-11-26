-- Every admin report download is logged: who, which report, with which filters, how many rows. Safe to re-run.
create table if not exists report_downloads (
  id bigserial primary key,
  admin_id uuid,
  report text not null,
  filters jsonb not null default '{}',
  rows int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists report_downloads_created_idx on report_downloads (created_at desc);
alter table report_downloads enable row level security;
