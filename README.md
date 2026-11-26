# TowerBites backend (Node.js + TypeScript + PostgreSQL)

Fastify API used by the mobile app, the website and the cafe CRM/admin. It is the only thing that talks to the
database, the SMS service and image storage; the apps only talk to this API. API reference: [API.md](API.md).

- **Database:** any PostgreSQL 14+ (hosted, or your own server). Tables are created by the files in `db/`.
- **Logins:** our own. Employees: phone + SMS code (2Factor). Cafes and admins: email + password (scrypt hash in
  our tables). Every login gets our own session token `tbs_…` (only its SHA-256 is stored).
- **Live updates:** our own WebSocket `/v1/live`.
- **Images:** a storage bucket, used only from here (`STORAGE_*` env).

## 1. Run locally
```bash
npm install
cp .env.example .env      # set DATABASE_URL; DEV_AUTH=true for a quick local try
npm run db:seed           # tables + Spaze Tech Park sample data (+ dev logins when DEV_AUTH=true)
npm run make-admin -- you@company.com "StrongPassword123" "Your Name"
npm run db:demo           # optional: sample orders so the cafe board is not empty
npm run dev               # http://localhost:4000/v1/health
```
`npm run db:migrate` creates tables only (no sample data). Both are safe to run again; the server also runs new
migrations itself when it starts.

With `DEV_AUTH=true`, `dev:<phone or email>` tokens work, and `db:seed` creates the dev logins `admin@towerbites.dev`
(super admin) and `cafe@towerbites.dev` (Krunchy Kafe). Never turn `DEV_AUTH` on in production: `npm start` (and
`NODE_ENV=production`) refuses to start when it is on.

## 2. Test / build / deploy
```bash
npm test          # all flows against the database in DATABASE_URL (needs DEV_AUTH=true + seed)
npm run build && npm start
```
Deploy on Render / Railway / any Node 20+ host: build `npm install && npm run build`, start `npm start`, set the env
vars plus `NODE_ENV=production`, `CORS_ORIGINS` with your website and CRM URLs, and `TRUST_PROXY` (1 on
Render/Railway). See `../DEPLOY.md`.

## Moving to another PostgreSQL
Dump and restore (`pg_dump` → `psql`), point `DATABASE_URL` at the new server (and `DATABASE_CA_CERT`, or
`DATABASE_SSL=false` on a private network without SSL). Nothing else changes: the apps never see the database.

## How it works
- **Who is who:** customers are in `profiles`; cafe logins in `staff` (one cafe each); admins in `admins`, each with a
  list of sections they may manage (`orders, cafes, menu, locations, users, notifications, requests, reports,
  admins`) or `is_super` for everything. Every admin route checks its section on the server.
- Every table has Row Level Security on with no policies, so nobody can read the database except through this API.
- On every order change the API pings live topics (`cafe:<id>`, `order:<id>`, `user:<id>`, `location:<id>`) on
  `/v1/live` and sends an Expo push notification to the employee.
- Order flow: placed → preparing → out_for_delivery → delivered (cash collected). Cafes can reject new orders;
  employees can cancel until the cafe accepts.
