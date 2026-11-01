-- Cafe logo (square) separate from the cover photo (wide, `image_url`). Safe to re-run.
alter table cafes add column if not exists logo_url text;
