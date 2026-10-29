# TowerBites backend (Node.js + TypeScript + Supabase)

Fastify API used by the mobile app, the website and the cafe CRM/admin. Data lives in Supabase Postgres, images in Supabase Storage, logins in Supabase Auth. API reference: [API.md](API.md).

## 1. Create the Supabase project (once)
1. supabase.com → New project → region **Mumbai (ap-south-1)**.
2. Project Settings → API: copy **Project URL**, **anon key** (for the apps) and **service_role key** (backend only, keep secret).
3. Connect → **Session pooler** connection string (port 5432) → that is `DATABASE_URL` (put your DB password in it).
4. Authentication → Sign In / Providers:
   - **Phone**: enable it. To test without SMS cost, add test numbers under "Phone numbers for testing" (e.g. `919876541207=123456`). For real SMS connect Twilio / MessageBird / Vonage / Textlocal there.
   - **Email**: keep enabled (cafe staff and admins log in with email + password).

## 2. Run
```bash
npm install
cp .env.example .env      # fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
npm run db:seed           # creates tables + storage bucket + Spaze Tech Park sample data
npm run make-admin -- you@company.com "StrongPassword123" "Your Name"
npm run db:demo           # optional: sample orders so the cafe board is not empty
npm run dev               # http://localhost:4000/v1/health
```
`npm run db:migrate` creates tables only (no sample data). Both are safe to run again.

Without Supabase (quick local try): set `DEV_AUTH=true` and point `DATABASE_URL` at any Postgres. Then `dev:<phone or email>` tokens work, and `db:seed` also creates the dev logins `admin@towerbites.dev` and `cafe@towerbites.dev`. Never turn `DEV_AUTH` on in production: `npm start` (and `NODE_ENV=production`) refuses to start when it is on.

## 3. Test / build / deploy
```bash
npm test          # full order flow against the database in DATABASE_URL (needs DEV_AUTH=true + seed)
npm run build && npm start
```
Deploy on Render / Railway / any Node 20+ host: build `npm install && npm run build`, start `npm start`, set the same env vars plus `NODE_ENV=production`, `CORS_ORIGINS` with your website and CRM URLs, and `TRUST_PROXY` (1 on Render/Railway). See `../DEPLOY.md`.

## How it works
- Apps log in with Supabase and send the access token; the API verifies it with Supabase and checks roles from the `staff` table (`cafe_staff`, `super_admin`).
- Every table has Row Level Security on with no policies, so the public anon key cannot read data directly. All reads and writes go through this API.
- On every order change the API sends Supabase Realtime pings (`cafe:<id>`, `order:<id>`, `user:<id>`) and an Expo push notification to the employee. When a cafe opens/closes or a menu/price changes it pings `location:<id>`, so open apps and websites refresh straight away.
- Order flow: placed → preparing → out_for_delivery → delivered (cash collected). Cafes can reject new orders; employees can cancel until the cafe accepts.
