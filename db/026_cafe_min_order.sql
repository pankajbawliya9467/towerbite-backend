-- Minimum order value per cafe (₹, items + combos). 0 = no minimum. The cafe sets it in its panel. Safe to re-run.
alter table cafes add column if not exists min_order int not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cafes_min_order_check') then
    alter table cafes add constraint cafes_min_order_check check (min_order between 0 and 10000);
  end if;
end $$;
