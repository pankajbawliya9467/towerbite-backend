-- Sub-categories: a category can sit under another one (one level only), e.g. Snacks › Burgers.
-- Deleting the parent keeps its sub-categories as normal categories. Safe to re-run.
alter table categories add column if not exists parent_id uuid references categories(id) on delete set null;
create index if not exists categories_cafe_idx on categories (cafe_id, parent_id);
create index if not exists menu_items_cafe_idx on menu_items (cafe_id, category_id);
