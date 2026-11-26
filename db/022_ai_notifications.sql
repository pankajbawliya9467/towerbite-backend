-- AI notification ideas (2026-11-26). Safe to re-run.

-- Server-only settings (e.g. the OpenAI key, stored encrypted). Never sent to an app or the CRM.
create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;

-- Each "Generate" press (daily limit and cost control).
create table if not exists ai_generations (
  id bigserial primary key,
  admin_id uuid not null,
  location_id uuid,
  ok boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists ai_generations_time_idx on ai_generations (created_at);
alter table ai_generations enable row level security;

-- What a notification opens when tapped, where it came from, and who was skipped.
alter table admin_notifications add column if not exists source text not null default 'manual';
alter table admin_notifications add column if not exists angle text;
alter table admin_notifications add column if not exists target jsonb;
alter table admin_notifications add column if not exists skipped int not null default 0;

-- Who got each notification (1 promo a day per person; orders within 2 hours are counted as results).
create table if not exists notification_recipients (
  notification_id uuid not null references admin_notifications(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);
create index if not exists notification_recipients_user_idx on notification_recipients (user_id, created_at);
alter table notification_recipients enable row level security;

-- Who tapped it.
create table if not exists notification_taps (
  notification_id uuid not null references admin_notifications(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);
alter table notification_taps enable row level security;
