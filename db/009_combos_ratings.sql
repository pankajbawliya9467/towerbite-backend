-- Combos (a few menu items together for less) and ratings after delivery. Safe to re-run.

create table if not exists combos (
  id uuid primary key default gen_random_uuid(),
  cafe_id uuid not null references cafes(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  description text not null default '' check (length(description) <= 120),
  price int not null check (price >= 0),
  emoji text not null default '🍱',
  image_url text,
  start_time time,          -- null = all day (India time)
  end_time time,
  days int[] not null default '{1,2,3,4,5,6,7}',  -- ISO weekday, 1 = Monday
  is_active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists combos_cafe_idx on combos (cafe_id, sort);

create table if not exists combo_items (
  combo_id uuid not null references combos(id) on delete cascade,
  menu_item_id uuid not null references menu_items(id) on delete cascade,
  qty int not null check (qty between 1 and 10),
  primary key (combo_id, menu_item_id)
);

-- A combo on an order is one line: its name, price and what is inside (`detail`).
alter table order_items add column if not exists combo_id uuid references combos(id) on delete set null;
alter table order_items add column if not exists detail text;
-- What the customer saved with combos on this order (rupees).
alter table orders add column if not exists savings int not null default 0;

create table if not exists order_ratings (
  order_id uuid primary key references orders(id) on delete cascade,
  user_id uuid not null,
  cafe_id uuid not null references cafes(id) on delete cascade,
  stars int not null check (stars between 1 and 5),
  tags text[] not null default '{}',
  comment text not null default '' check (length(comment) <= 300),
  resolved_at timestamptz,
  sorry_sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists order_ratings_cafe_idx on order_ratings (cafe_id, created_at desc);

create table if not exists rating_items (
  order_id uuid not null references order_ratings(order_id) on delete cascade,
  menu_item_id uuid not null references menu_items(id) on delete cascade,
  liked boolean not null,
  created_at timestamptz not null default now(),
  primary key (order_id, menu_item_id)
);
create index if not exists rating_items_item_idx on rating_items (menu_item_id, created_at desc);

alter table combos enable row level security;
alter table combo_items enable row level security;
alter table order_ratings enable row level security;
alter table rating_items enable row level security;
