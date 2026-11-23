-- A photo for each lunch (shown in the app and website). Safe to re-run.
alter table lunch_menus add column if not exists image_url text;
