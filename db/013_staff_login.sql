-- CRM staff log in through our API (email + password), not straight to Supabase. Safe to re-run.
-- password_hash is filled when the login is created, when an admin sets a new password, or on the first
-- successful login after this change (the password is then checked once against Supabase and copied here).
alter table staff add column if not exists password_hash text;
alter table staff add column if not exists password_set_at timestamptz;
create index if not exists staff_email_idx on staff (lower(email));
alter table sessions add column if not exists email text;
