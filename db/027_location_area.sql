-- Each location (tech park) gets an area drawn on the map in the CRM: a list of [lat, lng] corners.
-- Customers are matched to the location they are standing in, and orders are checked against it.
-- Safe to re-run.
alter table locations add column if not exists area_geo jsonb;
-- false (default): orders only from inside the area. true: customers outside it can order too.
alter table locations add column if not exists outside_allowed boolean not null default false;
