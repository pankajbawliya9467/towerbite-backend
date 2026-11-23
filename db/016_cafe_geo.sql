-- Where each cafe is, so an order can be checked to come from inside its building. Safe to re-run.
-- geo_check is off by default: nothing changes for a cafe until an admin turns it on in the CRM.
alter table cafes add column if not exists lat double precision;
alter table cafes add column if not exists lng double precision;
alter table cafes add column if not exists geo_radius_m int not null default 300;
alter table cafes add column if not exists geo_check boolean not null default false;
