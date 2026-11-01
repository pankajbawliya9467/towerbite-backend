-- Announcements the TowerBites owner sends from the admin panel (safe to re-run).
create table if not exists admin_notifications (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  audience jsonb not null,           -- {"type":"location","locationId":"…"} etc.
  audience_label text not null default '',
  users int not null default 0,
  devices int not null default 0,
  sent_by uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_notifications_created_idx on admin_notifications (created_at desc);
alter table admin_notifications enable row level security;
