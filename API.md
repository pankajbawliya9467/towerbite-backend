# TowerBites API (backend)

Base URL (local): `http://localhost:4000`. All JSON, camelCase. Money is whole rupees (int).
Errors: `{ "error": "message shown to the user" }` with 400/401/403/404/409.

## Auth
Send `Authorization: Bearer <Supabase access token>`.

| Who | How they log in (in the apps) |
|---|---|
| Employee | Supabase **phone OTP**: `supabase.auth.signInWithOtp({ phone: '+91…' })` → `verifyOtp({ phone, token, type: 'sms' })` (6 digits) |
| Cafe staff / admin | Supabase **email + password**: `supabase.auth.signInWithPassword({ email, password })` |

**Dev mode** (no Supabase yet): when the app env `*_DEV_AUTH=true` and the API has `DEV_AUTH=true`, skip Supabase and use the token
`dev:<phone or email>`, e.g. `dev:+919876541207`, `dev:cafe@towerbites.dev` (Krunchy Kafe staff), `dev:admin@towerbites.dev` (super admin).
In dev mode the OTP screen accepts `123456`, and staff login accepts any password.

## Live updates (Supabase Realtime broadcast)
The API pings, the app re-fetches from the API. Always also poll as a fallback (cafe board 10s, tracking 15s).
- `cafe:<cafeId>` event `order` payload `{ orderId, status }` → cafe board refetches `/v1/cafe/orders`
- `order:<orderId>` event `status` payload `{ status }` → tracking screen refetches `/v1/orders/:id`
```ts
supabase.channel(`cafe:${cafeId}`).on('broadcast', { event: 'order' }, refetch).subscribe()
```

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
- `GET /v1/admin/staff` → `[{ userId, role, cafeId, cafeName, name, email, createdAt }]`
- `POST /v1/admin/staff` `{ name, email, password, role, cafeId }` creates a Supabase login · `DELETE /v1/admin/staff/:userId`
- `GET /v1/admin/orders?locationId=&cafeId=&status=&limit=` → `Order[]`
- `GET /v1/admin/users` → `[{ id, name, phone, email, company, tower, floor, desk, locationName, orderCount, spent, createdAt }]`
- `GET /v1/admin/stats` → `{ ordersToday, salesToday, activeOrders, users, cafes, locations, byCafe: [{ id, name, emoji, locationName, orders, sales }] }`
- `POST /v1/admin/upload` multipart `file` (+ optional field `folder`, e.g. `cafes` or `menu`) → `{ url, path }` (Supabase Storage, public bucket)
