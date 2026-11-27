-- Global categories (2026-11-27). One list for every cafe: a main category (Beverages) with sub-categories
-- (Tea & chai). Products point to it with menu_items.catalog_category_id. The old per-cafe `categories` table
-- stays untouched until the switch in Admin → Categories is turned on and everything is checked.
-- Safe to re-run.

create table if not exists catalog_categories (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references catalog_categories(id) on delete restrict,   -- null = main category
  name text not null check (length(name) between 1 and 40),
  slug text not null unique,
  emoji text not null default '',
  -- old per-cafe category names that belong here ("cold drinks", or "chinese › main course" with its parent)
  aliases text[] not null default '{}',
  -- words in a product name that point here ("mojito", "soup"), used when a mixed old category is split
  keywords text[] not null default '{}',
  sort int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The same name only once inside one parent (or once among the main categories).
create unique index if not exists catalog_categories_name_idx
  on catalog_categories (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index if not exists catalog_categories_parent_idx on catalog_categories (parent_id, sort);
alter table catalog_categories enable row level security;

-- A category with products can't be deleted (restrict): merge it into another one first.
alter table menu_items add column if not exists catalog_category_id uuid references catalog_categories(id) on delete restrict;
create index if not exists menu_items_catalog_idx on menu_items (catalog_category_id);
create index if not exists menu_items_cafe_catalog_idx on menu_items (cafe_id, catalog_category_id);

-- Where each old per-cafe category goes. Filled by "Suggest", checked and approved by an admin, then applied.
create table if not exists category_map (
  old_category_id uuid primary key references categories(id) on delete cascade,
  catalog_category_id uuid references catalog_categories(id) on delete set null,
  -- map: products go to catalog_category_id; popular: products get the ★ flag (and still need a category);
  -- skip: nothing (empty or parent-only categories)
  action text not null default 'map' check (action in ('map', 'popular', 'skip')),
  -- mixed old category: a product whose name matches another category's keyword goes there instead
  use_keywords boolean not null default false,
  approved boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table category_map enable row level security;
