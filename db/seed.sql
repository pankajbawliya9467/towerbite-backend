-- Demo data: Spaze Tech Park with 6 cafes, plus two more locations.
-- Safe to run more than once (skips if Spaze Tech Park already exists).
do $$
declare
  spaze uuid; cyber uuid; unitech uuid;
  c uuid; cat_pop uuid; cat_hot uuid; cat_cold uuid; cat_snk uuid; cat_snd uuid;
begin
  if exists (select 1 from locations where slug = 'spaze-tech-park') then
    raise notice 'Seed already applied';
    return;
  end if;

  insert into locations (slug, name, area) values ('spaze-tech-park', 'Spaze Tech Park', 'Sohna Road') returning id into spaze;
  insert into locations (slug, name, area) values ('dlf-cyber-city', 'DLF Cyber City', 'DLF Phase 2') returning id into cyber;
  insert into locations (slug, name, area) values ('unitech-cyber-park', 'Unitech Cyber Park', 'Sector 39') returning id into unitech;

  insert into towers (location_id, name, sort) values
    (spaze, 'Tower A', 1), (spaze, 'Tower B', 2), (spaze, 'Tower C', 3),
    (cyber, 'Building 5', 1), (cyber, 'Building 8', 2), (cyber, 'Building 10', 3),
    (unitech, 'Tower A', 1), (unitech, 'Tower B', 2);

  -- Krunchy Kafe
  insert into cafes (location_id, slug, name, cuisines, place, emoji, cover_color, rating, rating_count, eta_min, eta_max, tags, sort, phone)
  values (spaze, 'krunchy-kafe', 'Krunchy Kafe', 'Coffee · Sandwiches', 'Tower B, Ground floor', '☕', '#FDEBDD', 4.5, 320, 10, 15, '{coffee,snacks}', 1, '+91 98100 11001')
  returning id into c;
  insert into categories (cafe_id, name, sort) values (c, 'Popular', 1) returning id into cat_pop;
  insert into categories (cafe_id, name, sort) values (c, 'Hot drinks', 2) returning id into cat_hot;
  insert into categories (cafe_id, name, sort) values (c, 'Cold drinks', 3) returning id into cat_cold;
  insert into categories (cafe_id, name, sort) values (c, 'Snacks', 4) returning id into cat_snk;
  insert into categories (cafe_id, name, sort) values (c, 'Sandwiches', 5) returning id into cat_snd;
  insert into menu_items (cafe_id, category_id, name, description, price, emoji, is_popular, sort) values
    (c, cat_pop, 'Masala Chai', 'Ginger and cardamom', 25, '🍵', true, 1),
    (c, cat_pop, 'Samosa (2 pcs)', 'With green chutney', 40, '🥟', true, 2),
    (c, cat_pop, 'Cold Coffee', 'Less sugar available', 90, '🧋', true, 3),
    (c, cat_pop, 'Grilled Sandwich', 'Ready in 8 min', 110, '🥪', true, 4),
    (c, cat_hot, 'Cappuccino', 'Freshly ground beans', 120, '☕', false, 5),
    (c, cat_hot, 'Filter Coffee', 'South Indian style', 50, '☕', false, 6),
    (c, cat_cold, 'Iced Lemon Tea', 'Fresh mint', 80, '🧊', false, 7),
    (c, cat_snk, 'Veg Puff', 'Flaky pastry', 35, '🥐', false, 8),
    (c, cat_snd, 'Paneer Tikka Sandwich', 'Grilled, with mint mayo', 140, '🥪', false, 9);

  -- Green Bowl
  insert into cafes (location_id, slug, name, cuisines, place, emoji, cover_color, rating, rating_count, eta_min, eta_max, tags, sort, phone)
  values (spaze, 'green-bowl', 'Green Bowl', 'Salads · Wraps · Juices', 'Tower A, Ground floor', '🥗', '#E6F4EA', 4.3, 210, 15, 20, '{healthy,meals}', 2, '+91 98100 11002')
  returning id into c;
  insert into categories (cafe_id, name, sort) values (c, 'Popular', 1) returning id into cat_pop;
  insert into categories (cafe_id, name, sort) values (c, 'Juices', 2) returning id into cat_cold;
  insert into menu_items (cafe_id, category_id, name, description, price, emoji, is_popular, sort) values
    (c, cat_pop, 'Paneer Wrap', 'Whole wheat, mint chutney', 150, '🌯', true, 1),
    (c, cat_pop, 'Greek Salad', 'Feta, olives, cucumber', 180, '🥗', true, 2),
    (c, cat_pop, 'Chicken Caesar Wrap', 'Grilled chicken, romaine', 190, '🌯', false, 3),
    (c, cat_cold, 'Orange Juice', 'Freshly squeezed', 60, '🍊', true, 4),
    (c, cat_cold, 'Watermelon Juice', 'No added sugar', 70, '🍉', false, 5);
  update menu_items set is_veg = false where cafe_id = c and name like 'Chicken%';

  -- Desi Tiffin
  insert into cafes (location_id, slug, name, cuisines, place, emoji, cover_color, rating, rating_count, eta_min, eta_max, tags, sort, phone)
  values (spaze, 'desi-tiffin', 'Desi Tiffin', 'North Indian · Thali', 'Food court', '🍛', '#FBE4E4', 4.4, 410, 20, 25, '{meals}', 3, '+91 98100 11003')
  returning id into c;
  insert into categories (cafe_id, name, sort) values (c, 'Popular', 1) returning id into cat_pop;
  insert into categories (cafe_id, name, sort) values (c, 'Drinks', 2) returning id into cat_cold;
  insert into menu_items (cafe_id, category_id, name, description, price, emoji, is_popular, sort) values
    (c, cat_pop, 'Rajma Chawal', 'With salad and pickle', 140, '🍛', true, 1),
    (c, cat_pop, 'Veg Thali', '2 sabzi, dal, rice, 3 roti', 180, '🍱', true, 2),
    (c, cat_pop, 'Chole Bhature', 'Served with onion and pickle', 130, '🫓', false, 3),
    (c, cat_cold, 'Sweet Lassi', 'Thick and chilled', 60, '🥛', false, 4);

  -- Tapri Chai
  insert into cafes (location_id, slug, name, cuisines, place, emoji, cover_color, rating, rating_count, eta_min, eta_max, tags, sort, phone)
  values (spaze, 'tapri-chai', 'Tapri Chai', 'Chai · Maggi · Snacks', 'Tower C, Ground floor', '🫖', '#FEF3D7', 4.6, 530, 10, 15, '{coffee,snacks}', 4, '+91 98100 11004')
  returning id into c;
  insert into categories (cafe_id, name, sort) values (c, 'Popular', 1) returning id into cat_pop;
  insert into menu_items (cafe_id, category_id, name, description, price, emoji, is_popular, sort) values
    (c, cat_pop, 'Kulhad Chai', 'Served hot', 30, '🍵', true, 1),
    (c, cat_pop, 'Masala Maggi', 'With veggies', 70, '🍜', true, 2),
    (c, cat_pop, 'Bun Maska', 'Soft bun, butter', 40, '🍞', false, 3),
    (c, cat_pop, 'Vada Pav', 'Spicy chutney', 45, '🍔', false, 4);

  -- Bake House
  insert into cafes (location_id, slug, name, cuisines, place, emoji, cover_color, rating, rating_count, eta_min, eta_max, tags, sort, phone)
  values (spaze, 'bake-house', 'Bake House', 'Bakery · Desserts', 'Tower A, 1st floor', '🥐', '#F3E8FF', 4.2, 150, 10, 15, '{snacks}', 5, '+91 98100 11005')
  returning id into c;
  insert into categories (cafe_id, name, sort) values (c, 'Popular', 1) returning id into cat_pop;
  insert into menu_items (cafe_id, category_id, name, description, price, emoji, is_popular, sort) values
    (c, cat_pop, 'Chocolate Brownie', 'Warm, fudgy', 90, '🍫', true, 1),
    (c, cat_pop, 'Butter Croissant', 'Baked this morning', 80, '🥐', false, 2),
    (c, cat_pop, 'Blueberry Muffin', 'Soft and fresh', 70, '🧁', false, 3);

  -- South Spice
  insert into cafes (location_id, slug, name, cuisines, place, emoji, cover_color, rating, rating_count, eta_min, eta_max, tags, sort, phone)
  values (spaze, 'south-spice', 'South Spice', 'Dosa · Idli · Meals', 'Food court', '🥞', '#E0F2FE', 4.3, 260, 15, 20, '{meals,healthy}', 6, '+91 98100 11006')
  returning id into c;
  insert into categories (cafe_id, name, sort) values (c, 'Popular', 1) returning id into cat_pop;
  insert into menu_items (cafe_id, category_id, name, description, price, emoji, is_popular, sort) values
    (c, cat_pop, 'Masala Dosa', 'Sambar and chutney', 110, '🥞', true, 1),
    (c, cat_pop, 'Idli Sambar (3 pcs)', 'Soft steamed idli', 70, '🍚', false, 2),
    (c, cat_pop, 'Curd Rice', 'Tempered with curry leaves', 90, '🍚', false, 3);

  -- A couple of cafes for the other locations
  insert into cafes (location_id, slug, name, cuisines, place, emoji, cover_color, tags, sort)
  values (cyber, 'cyber-brew', 'Cyber Brew', 'Coffee · Bakery', 'Building 8, Ground floor', '☕', '#FDEBDD', '{coffee}', 1)
  returning id into c;
  insert into menu_items (cafe_id, name, description, price, emoji, is_popular) values
    (c, 'Latte', 'Double shot', 140, '☕', true), (c, 'Banana Bread', 'Homemade', 90, '🍞', false);

  insert into cafes (location_id, slug, name, cuisines, place, emoji, cover_color, tags, sort)
  values (unitech, 'park-canteen', 'Park Canteen', 'North Indian · Snacks', 'Tower A, Basement', '🍛', '#FBE4E4', '{meals}', 1)
  returning id into c;
  insert into menu_items (cafe_id, name, description, price, emoji, is_popular) values
    (c, 'Aloo Paratha', 'With curd', 80, '🫓', true), (c, 'Masala Chai', 'Ginger and cardamom', 20, '🍵', false);
end $$;
