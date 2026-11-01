-- Lunch pre-booking and team orders (safe to re-run).

-- A cafe's lunch for one day. Employees book plates in advance until `closes_at` (India time) that day.
create table if not exists lunch_menus (
  id uuid primary key default gen_random_uuid(),
  cafe_id uuid not null references cafes(id) on delete cascade,
  day date not null,
  name text not null,
  items text not null default '',              -- "Dal makhani, Paneer masala, Jeera rice, 3 roti"
  price int not null check (price >= 0),
  is_veg boolean not null default true,
  plates int not null check (plates > 0),
  closes_at time not null default '11:30',     -- last time to book, on `day`
  cancel_until time not null default '10:30',  -- free cancel until, on `day`
  slots text[] not null default '{12:30-13:00,13:00-13:30,13:30-14:00}',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists lunch_menus_cafe_day_idx on lunch_menus (cafe_id, day);

create sequence if not exists lunch_no_seq start 1001;

create table if not exists lunch_bookings (
  id uuid primary key default gen_random_uuid(),
  booking_no int not null unique default nextval('lunch_no_seq'),
  lunch_id uuid not null references lunch_menus(id) on delete cascade,
  cafe_id uuid not null references cafes(id) on delete cascade,
  user_id uuid not null,
  day date not null,
  slot text not null,
  qty int not null check (qty between 1 and 5),
  price int not null,
  total int not null,
  status text not null default 'booked' check (status in ('booked', 'out', 'delivered', 'cancelled')),
  customer_name text not null default '',
  customer_phone text,
  tower text not null,
  floor text not null,
  company text not null default '',
  desk text not null,
  note text,
  created_at timestamptz not null default now(),
  out_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz
);
-- One live booking per person per lunch (they change it instead of booking twice).
create unique index if not exists lunch_bookings_one_per_user on lunch_bookings (lunch_id, user_id) where status <> 'cancelled';
create index if not exists lunch_bookings_cafe_day_idx on lunch_bookings (cafe_id, day);
create index if not exists lunch_bookings_user_idx on lunch_bookings (user_id, day desc);

-- Team order: one shared link, everyone adds their items, the host places one order.
create table if not exists team_orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_id uuid not null,
  cafe_id uuid not null references cafes(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  name text not null,
  deliver_to text not null,                    -- "Meeting room B"
  deliver_at time,                             -- India time, today
  closes_at timestamptz not null,              -- teammates can add until then
  pay_mode text not null default 'split' check (pay_mode in ('split', 'host')),
  host_upi text,
  tower text not null,
  floor text not null,
  company text not null default '',
  status text not null default 'open' check (status in ('open', 'placed', 'cancelled')),
  order_id uuid references orders(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists team_orders_host_idx on team_orders (host_id, created_at desc);
create index if not exists team_orders_order_idx on team_orders (order_id);

create table if not exists team_members (
  team_id uuid not null references team_orders(id) on delete cascade,
  user_id uuid not null,
  name text not null default '',
  note text,
  joined_at timestamptz not null default now(),
  paid_at timestamptz,
  reminded_at timestamptz,
  primary key (team_id, user_id)
);
create index if not exists team_members_user_idx on team_members (user_id);

create table if not exists team_items (
  team_id uuid not null references team_orders(id) on delete cascade,
  user_id uuid not null,
  menu_item_id uuid not null references menu_items(id) on delete cascade,
  qty int not null check (qty between 1 and 10),
  added_at timestamptz not null default now(),
  primary key (team_id, user_id, menu_item_id)
);

alter table lunch_menus enable row level security;
alter table lunch_bookings enable row level security;
alter table team_orders enable row level security;
alter table team_members enable row level security;
alter table team_items enable row level security;
