-- A cafe's delivery staff, so "Send out" is one tap with a saved name (and phone for the customer). Safe to re-run.
create table if not exists cafe_riders (
  id uuid primary key default gen_random_uuid(),
  cafe_id uuid not null references cafes(id) on delete cascade,
  name text not null check (length(name) between 1 and 40),
  phone text check (phone is null or phone ~ '^\+?[0-9 ]{6,16}$'),
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists cafe_riders_cafe_idx on cafe_riders (cafe_id, sort);
alter table cafe_riders enable row level security;

alter table orders add column if not exists rider_phone text;
