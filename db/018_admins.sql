-- People who run TowerBites (the admin panel) get their own table, separate from cafe logins (staff) and
-- customers (profiles). Each admin has a list of sections they may manage; super admins manage everything.
-- Existing super admins are moved here with their password. Safe to re-run.
create table if not exists admins (
  id uuid primary key,
  name text not null default '',
  email text not null,
  password_hash text,
  password_set_at timestamptz,
  is_super boolean not null default false,
  permissions text[] not null default '{}',
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists admins_email_idx on admins (lower(email));
alter table admins enable row level security;

insert into admins (id, name, email, password_hash, password_set_at, is_super, created_at)
select s.user_id, s.name, coalesce(s.email, ''), s.password_hash, s.password_set_at, true, s.created_at
from staff s where s.role = 'super_admin'
on conflict (id) do nothing;
delete from staff s where s.role = 'super_admin' and exists (select 1 from admins a where a.id = s.user_id);
