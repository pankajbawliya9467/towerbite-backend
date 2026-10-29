-- Private live-update channels (Supabase Realtime Authorization).
-- Only the employee who placed an order can listen to `order:<id>`,
-- only that employee can listen to `user:<their id>` (their order list),
-- only that cafe's staff (or a super admin) can listen to `cafe:<id>`,
-- and any logged-in user can listen to `location:<id>` (cafe open/close and menu changes; public info anyway).
-- Nobody but the backend (service role) can send messages on them.
-- Skipped automatically on plain Postgres (no `realtime` schema).
do $$
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'No Supabase Realtime here, skipping channel security';
    return;
  end if;

  create or replace function public.tb_can_listen(topic text) returns boolean
  language plpgsql stable security definer set search_path = public as $fn$
  declare
    uid uuid := auth.uid();
    kind text := split_part(topic, ':', 1);
    ref text := split_part(topic, ':', 2);
  begin
    if uid is null or ref !~ '^[0-9a-f-]{36}$' then
      return false;
    end if;
    if kind = 'order' then
      return exists (select 1 from orders o where o.id = ref::uuid and o.user_id = uid);
    elsif kind = 'user' then
      return ref::uuid = uid;
    elsif kind = 'location' then
      return exists (select 1 from locations l where l.id = ref::uuid);
    elsif kind = 'cafe' then
      return exists (select 1 from staff s where s.user_id = uid
                     and (s.role = 'super_admin' or s.cafe_id = ref::uuid));
    end if;
    return false;
  end $fn$;

  revoke all on function public.tb_can_listen(text) from public, anon;
  grant execute on function public.tb_can_listen(text) to authenticated;

  drop policy if exists "towerbites listen" on realtime.messages;
  create policy "towerbites listen" on realtime.messages
    for select to authenticated
    using (realtime.messages.extension = 'broadcast' and public.tb_can_listen(realtime.topic()));
  -- No insert policy on purpose: apps cannot send or fake live updates.
end $$;
