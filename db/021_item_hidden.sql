-- A cafe (or admin) can hide a product from customers without deleting it (seasonal items, paused dishes).
-- Hidden products don't show in the app/website menu, search, popular or combos, and can't be ordered.
-- Old orders, reports and ratings keep pointing to them. Safe to re-run.
alter table menu_items add column if not exists is_active boolean not null default true;
