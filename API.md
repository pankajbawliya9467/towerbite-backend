# TowerBites API (backend)

Base URL (local): `http://localhost:4000`. All JSON, camelCase. Money is whole rupees (int).
Errors: `{ "error": "message shown to the user" }` with 400/401/403/404/409.

## Auth
Send `Authorization: Bearer <session token>` (our own `tbs_…` token from a login below).

| Who | How they log in |
|---|---|
| Employee | **Phone OTP**: `POST /v1/auth/otp/send { phone }` → `POST /v1/auth/otp/verify { phone, code }` → `{ token, expiresAt }` |
| Cafe login / admin | **Email + password**: `POST /v1/auth/staff/login { email, password }` → `{ token, expiresAt }` |
| Anyone (CRM) | Change own password: `POST /v1/auth/password { current, next }`; this device stays in, other devices are logged out |

**Dev mode**: when the app env `*_DEV_AUTH=true` and the API has `DEV_AUTH=true`, use the token
`dev:<phone or email>`, e.g. `dev:+919876541207`, `dev:cafe@towerbites.dev` (Krunchy Kafe staff), `dev:admin@towerbites.dev` (super admin).
In dev mode the OTP screen accepts `123456`, and staff login accepts any password.

## Live updates (WebSocket `/v1/live`)
The API pings, the app re-fetches from the API. Always also poll as a fallback (cafe board 10s, tracking 15s).
- `cafe:<cafeId>` event `order` payload `{ orderId, status }` → cafe board refetches `/v1/cafe/orders`
- `order:<orderId>` event `status` payload `{ status }` → tracking screen refetches `/v1/orders/:id`
Connect to `wss://<api>/v1/live`, send `{ type: 'auth', token }`, then `{ type: 'sub', topic: 'cafe:<id>' }`.

## Public (no login)
- `GET /v1/locations` → `[{ id, slug, name, area, city, cafeCount }]`
- `GET /v1/locations/:slug` → `{ id, slug, name, area, city, towers: [{ id, name }] }`
- `GET /v1/locations/:slug/cafes?tag=coffee|snacks|meals|healthy&search=` → `Cafe[]`
- `GET /v1/locations/:slug/popular` → `(MenuItem & { cafe: { id, slug, name } })[]`
- `GET /v1/locations/:slug/cafes/:cafeSlug` → `CafeWithMenu`
- `GET /v1/cafes/:id` → `CafeWithMenu`

`Cafe = { id, locationId, slug, name, cuisines, place, emoji, coverColor, imageUrl, phone, rating, ratingCount, etaMin, etaMax, isOpen, acceptingOrders, tags, sort }`
`CafeWithMenu = Cafe & { categories: [{ id, name, sort }], items: MenuItem[] }`
`MenuItem = { id, cafeId, categoryId, name, description, price, isVeg, emoji, imageUrl, isAvailable, isPopular, sort }`
Show `imageUrl` when set, otherwise the `emoji` on `coverColor` (that is how the mockups look).
"Popular" tab in a cafe menu = items with `isPopular`.

## Employee (logged in)
- `GET /v1/me` → `Profile` (created on first call). `name` empty = new user → ask name.
- `PUT /v1/me` body any of `{ name, locationId, company, tower, floor, desk }` → `Profile`
- `POST /v1/me/push-token` `{ token, platform }` (Expo push token)
- `DELETE /v1/me/push-token` `{ token }` (call on sign-out)
- `POST /v1/orders` body
  `{ cafeId, items: [{ menuItemId, qty }], address: { tower, floor, company, desk }, name?, phone?, note? }` → `201 Order`
  (server prices everything and saves the address to the profile for next time)
- `GET /v1/orders?status=active|past` → `Order[]`
- `GET /v1/orders/:id` → `Order`
- `POST /v1/orders/:id/cancel` (only while `placed`) → `Order`

`Profile = { id, name, phone, email, locationId, company, tower, floor, desk, location: { id, slug, name, area } | null, staff: Staff | null }`
`Staff = { userId, role: 'cafe_staff' | 'super_admin', cafeId, name }`

`Order = { id, orderNo, status, userId, itemsTotal, deliveryFee, total, paymentMethod: 'cod', codCollected,
  customerName, customerPhone, address: { tower, floor, company, desk }, note, riderName, rejectReason,
  createdAt, acceptedAt, outAt, deliveredAt, cancelledAt, rejectedAt,
  cafe: { id, slug, name, emoji, coverColor, place, phone, etaMin, etaMax }, location: { id, slug, name },
  items: [{ id, menuItemId, name, emoji, price, qty }] }`

Status flow: `placed` (New) → `preparing` (accepted) → `out_for_delivery` → `delivered`. Also `rejected` (by cafe, from placed) and `cancelled` (by employee, from placed).
Tracking screen steps: Accepted by cafe (acceptedAt) · Being prepared · On the way (outAt, riderName) · Delivered.

## Cafe staff (`role = cafe_staff`; a super admin passes header `x-cafe-id: <cafeId>`)
- `GET /v1/cafe` → `CafeWithMenu & { staff }`
- `PATCH /v1/cafe` `{ acceptingOrders?, isOpen? }`
- `GET /v1/cafe/orders` → active orders oldest first (New / Preparing / Out for delivery board)
- `GET /v1/cafe/orders?status=history&date=YYYY-MM-DD` → all orders of that day (default today, IST)
- `GET /v1/cafe/stats` → `{ orders, delivered, sales, codCollected, active }` for today
- `POST /v1/cafe/orders/:id/accept` · `/reject { reason }` · `/dispatch { riderName }` · `/deliver` → `Order`
  (409 if it was already moved: refetch)
- `GET /v1/cafe/menu` → `CafeWithMenu`
- `PATCH /v1/cafe/menu-items/:id` `{ isAvailable }`

## Super admin (`role = super_admin`)
CRUD: `GET/POST /v1/admin/<r>`, `GET/PATCH/DELETE /v1/admin/<r>/:id` for
- `locations` `{ slug, name, area, city, isActive }`
- `towers` `{ locationId, name, sort }` (filter `?locationId=`)
- `cafes` `{ locationId, slug, name, cuisines, place, emoji, coverColor, imageUrl, phone, rating, ratingCount, etaMin, etaMax, isOpen, acceptingOrders, tags, sort }` (filter `?locationId=`)
- `categories` `{ cafeId, name, sort }` (filter `?cafeId=`)
- `menu-items` `{ cafeId, categoryId, name, description, price, isVeg, emoji, imageUrl, isAvailable, isPopular, sort }` (filter `?cafeId=&categoryId=`)

Other:
Every admin route needs a section (`orders, cafes, menu, locations, users, notifications, requests, reports, admins`);
super admins have all. Lists of locations/towers/cafes/categories/menu items are readable by any admin.
- Cafe logins (section `cafes`): `GET /v1/admin/staff` → `[{ userId, cafeId, cafeName, name, email, passwordSetAt, activeLogins }]` ·
  `POST /v1/admin/staff` `{ name, email, password, cafeId }` · `PATCH /v1/admin/staff/:userId` `{ name?, email? }` (new email logs them out) ·
  `POST /v1/admin/staff/:userId/password` `{ password }` · `DELETE /v1/admin/staff/:userId`
- Admins (section `admins`): `GET /v1/admin/admins` · `POST /v1/admin/admins` `{ name, email, password, isSuper?, permissions[] }` ·
  `PATCH /v1/admin/admins/:id` `{ name?, email?, isSuper?, permissions?, isActive? }` · `POST /v1/admin/admins/:id/password` `{ password }`.
  Only a super admin can make or change a super admin; nobody can give access they don't have, or change their own access.
- `GET /v1/admin/orders?locationId=&cafeId=&status=&limit=` → `Order[]`
- `GET /v1/admin/users` → `[{ id, name, phone, email, company, tower, floor, desk, locationName, orderCount, spent, createdAt }]`
- `GET /v1/admin/stats` → `{ ordersToday, salesToday, activeOrders, users, cafes, locations, byCafe: [{ id, name, emoji, locationName, orders, sales }] }`
- `POST /v1/admin/upload` multipart `file` (+ optional field `folder`, e.g. `cafes` or `menu`) → `{ url, path }` (public image bucket)

## Global categories (Admin → Categories)
One list of categories for every cafe: main categories (`parentId: null`) and one level of sub-categories.
Products point to it with `catalogCategoryId`. A product sits in a **leaf**: a sub-category, or a main category
without sub-categories. Permissions: `catalog.view | add | edit | delete`; the switch is super admin only.

- `GET /v1/admin/catalog` (any admin) → `{ enabled, categories: [{ id, parentId, name, slug, emoji, aliases, keywords, sort, isActive, products, cafes }], unassigned, totalProducts }`
- `POST /v1/admin/catalog` `{ name, parentId?, emoji?, aliases?, keywords?, sort? }` · `PATCH /v1/admin/catalog/:id` (same fields + `isActive`) · `DELETE /v1/admin/catalog/:id` (only empty ones)
- `PUT /v1/admin/catalog/order` `{ parentId | null, ids[] }` · `POST /v1/admin/catalog/merge` `{ fromId, toId }` (moves products, turns `fromId` off, keeps its name as an alias)
- `PUT /v1/admin/catalog/switch` `{ on }` — menus everywhere use the global categories (on) or each cafe's own (off)
- Moving the old per-cafe categories (grouped by name, `key` = `"parent › name"` or `"name"`):
  `GET /v1/admin/catalog/mapping` · `POST /v1/admin/catalog/mapping/suggest` · `PUT /v1/admin/catalog/mapping` `{ key, action: map|popular|skip, catalogCategoryId, useKeywords, approved }` ·
  `GET /v1/admin/catalog/mapping/preview?key=` · `POST /v1/admin/catalog/mapping/apply` `{ overwrite? }`
- `GET /v1/admin/catalog/products?category=<id>|none&cafeId=&search=&page=` · `POST /v1/admin/catalog/assign` `{ itemIds[], catalogCategoryId }`
- `GET /v1/admin/catalog/export` · `POST /v1/admin/catalog/import` (the export file; categories by slug, mapping by name, products by id). Starting list: `db/catalog/towerbites-catalog.json`.

When the switch is on, `CafeWithMenu.categories` comes from the global list (only categories the cafe has
products in, plus their main categories) and `MenuItem.categoryId` is the global category. The apps don't change.
A product without a global category gets `categoryId = 00000000-0000-4000-8000-00000000c0de` ("More"), so it
never disappears from a menu.

## Products from Excel (one cafe per file)
- `GET /v1/admin/menu-items/template.xlsx?cafeId=` (`menu.view`) → `.xlsx` with sheets **Products** (this cafe's products), **Categories** (valid Category / Sub-category pairs, dropdown source) and **How to**.
- `POST /v1/admin/menu-items/import?cafeId=&commit=0|1` multipart `file` (any of `menu.add | menu.edit | menu.price`).
  Columns by header (any order): `Product name*`, `Price*` (whole ₹), `Category*`, `Sub-category` (empty when the category has none), `Veg`, `Description`, `In stock`, `Popular` (Yes/No); optional `Emoji` (new products get none: add photos later).
  Matched by product name inside the cafe: known → update, new → add, nothing deleted. Blank optional cells keep the current value.
  Answer `{ saved, summary: { new, update, same, error }, rows: [{ row, name, status, errors[], changes[], categoryPath }], switchOff }`.
  `commit=0` = preview only; `commit=1` saves every row without errors in one transaction. New rows need `menu.add`, price changes `menu.price`, stock `menu.soldout`, other changes `menu.edit`.
  A sample file is in the CRM: `crm-admin/public/templates/towerbites-products-sample.xlsx`.
