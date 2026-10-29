-- TowerBites schema
-- Run with `npm run db:migrate` (uses DATABASE_URL) or paste into the Supabase SQL editor.
-- All tables have Row Level Security ON with no policies: apps never read tables directly,
-- everything goes through the backend API, which connects with the database password.

create extension if not exists pgcrypto;

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  area text not null default '',
  city text not null default 'Gurugram',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists towers (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  name text not null,
  sort int not null default 0
);

create table if not exists cafes (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  slug text not null,
  name text not null,
  cuisines text not null default '',          -- "Coffee · Sandwiches"
  place text not null default '',             -- "Tower B, Ground floor"
  emoji text not null default '☕',
  cover_color text not null default '#FDEBDD',
  image_url text,
  phone text,
  rating numeric(2,1) not null default 4.5,
  rating_count int not null default 0,
  eta_min int not null default 10,
  eta_max int not null default 15,
  is_open boolean not null default true,
  accepting_orders boolean not null default true,
  tags text[] not null default '{}',          -- filters: coffee, snacks, meals, healthy
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (location_id, slug)
);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  cafe_id uuid not null references cafes(id) on delete cascade,
  name text not null,
  sort int not null default 0
);

create table if not exists menu_items (
  id uuid primary key default gen_random_uuid(),
  cafe_id uuid not null references cafes(id) on delete cascade,
  category_id uuid references categories(id) on delete set null,
  name text not null,
  description text not null default '',
  price int not null check (price >= 0),      -- rupees
  is_veg boolean not null default true,
  emoji text not null default '🍽️',
  image_url text,
  is_available boolean not null default true,
  is_popular boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

-- One row per signed-in user (id = Supabase auth user id)
create table if not exists profiles (
  id uuid primary key,
  name text not null default '',
  phone text,
  email text,
  location_id uuid references locations(id) on delete set null,
  company text not null default '',
  tower text not null default '',
  floor text not null default '',
  desk text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Cafe staff and super admins
create table if not exists staff (
  user_id uuid primary key,
  role text not null check (role in ('cafe_staff', 'super_admin')),
  cafe_id uuid references cafes(id) on delete cascade,
  name text not null default '',
  email text,
  created_at timestamptz not null default now(),
  check (role = 'super_admin' or cafe_id is not null)
);

create sequence if not exists order_no_seq start 2001;

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_no int not null unique default nextval('order_no_seq'),
  user_id uuid not null,
  cafe_id uuid not null references cafes(id),
  location_id uuid not null references locations(id),
  status text not null default 'placed'
    check (status in ('placed', 'preparing', 'out_for_delivery', 'delivered', 'rejected', 'cancelled')),
  items_total int not null,
  delivery_fee int not null default 0,
  total int not null,
  payment_method text not null default 'cod' check (payment_method in ('cod')),
  cod_collected boolean not null default false,
  customer_name text not null default '',
  customer_phone text,
  tower text not null,
  floor text not null,
  company text not null default '',
  desk text not null,
  note text,
  rider_name text,
  reject_reason text,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  out_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  rejected_at timestamptz
);
create index if not exists orders_user_idx on orders (user_id, created_at desc);
create index if not exists orders_cafe_idx on orders (cafe_id, created_at desc);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  menu_item_id uuid references menu_items(id) on delete set null,
  name text not null,
  emoji text not null default '',
  price int not null,
  qty int not null check (qty > 0)
);
-- keeps lines in the order the employee added them
alter table order_items add column if not exists line_no int not null default 0;
create index if not exists order_items_order_idx on order_items (order_id);

create table if not exists push_tokens (
  token text primary key,
  user_id uuid not null,
  platform text not null default 'expo',
  created_at timestamptz not null default now()
);

alter table locations enable row level security;
alter table towers enable row level security;
alter table cafes enable row level security;
alter table categories enable row level security;
alter table menu_items enable row level security;
alter table profiles enable row level security;
alter table staff enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table push_tokens enable row level security;
