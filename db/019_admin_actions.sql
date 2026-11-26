-- Admin permissions per action: "<section>.<action>" (e.g. menu.edit, cafes.board) instead of whole sections.
-- An old whole-section permission becomes every action of that section. Safe to re-run.
update admins a set permissions = coalesce((
  select array_agg(distinct p order by p) from (
    select unnest(case x
      when 'orders' then array['orders.view','orders.phone','orders.csv']
      when 'cafes' then array['cafes.view','cafes.add','cafes.edit','cafes.delete','cafes.board','cafes.logins','cafes.openclose','cafes.order']
      when 'menu' then array['menu.view','menu.add','menu.edit','menu.delete','menu.price','menu.soldout']
      when 'locations' then array['locations.view','locations.add','locations.edit','locations.delete','locations.geo']
      when 'users' then array['users.view','users.phone']
      when 'notifications' then array['notifications.view','notifications.send']
      when 'requests' then array['requests.view','requests.edit']
      when 'reports' then array['reports.view','reports.money']
      when 'admins' then array['admins.view','admins.add','admins.edit','admins.delete']
      else array[x] end) as p
    from unnest(a.permissions) as x
  ) y), '{}')
where exists (select 1 from unnest(a.permissions) x where x not like '%.%');
