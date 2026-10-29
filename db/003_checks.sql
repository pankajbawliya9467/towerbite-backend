-- Extra data checks (safe to re-run).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cafes_eta_order') then
    update cafes set eta_max = eta_min where eta_max < eta_min;
    alter table cafes add constraint cafes_eta_order check (eta_min <= eta_max);
  end if;
end $$;

create index if not exists push_tokens_user_idx on push_tokens (user_id);
