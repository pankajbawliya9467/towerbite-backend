-- Cafes are made inactive instead of deleted (orders, ratings and reports keep their cafe).
-- An inactive cafe is hidden from the app and website and takes no orders. Safe to re-run.
alter table cafes add column if not exists is_active boolean not null default true;
