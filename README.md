# Tecido Garage Management (GMS)

Garage / auto-service management system for Tecido.

**Modules:** Dashboard · Job Cards · Sales · Customers · Vehicles · Technicians · Service Advisors · Accounts · Settings

## Branches
- `master` — original app (single-file, **Firebase Firestore + Storage**), as deployed to Firebase Hosting: https://tecido-garage-management.web.app
- `postgres-migration` — **Node + Express + PostgreSQL (Neon)** backend. Same front-end, rewired to a REST API. Photos stored in Postgres.

## Architecture (postgres-migration)
```
public/index.html      Front-end (unchanged UI). Loads gms-backend.js instead of the Firebase SDK.
public/gms-backend.js  Firebase-compat shim — reimplements the Firestore/Storage API the app uses,
                       backed by the REST API. onSnapshot = fetch-on-load + refresh-after-mutation.
server.js              Express app: serves public/ and the REST API.
db.js                  PostgreSQL pool + schema (auto-created on startup).
```
Each collection (customers, vehicles, jobCards, invoices, transactions, finAccounts, technicians,
advisors, settings) is a JSONB-document table; job-card/advisor/technician photos are stored as
`bytea` in the `images` table and served from `/api/image`.

## Run locally
```bash
cp .env.example .env      # then set DATABASE_URL (Neon) and PORT
npm install
npm start                 # http://localhost:3000
```

## Deploy to Render
1. New → **Web Service** → connect this GitHub repo, branch `postgres-migration` (or `master` after merge).
2. Build: `npm install`  ·  Start: `node server.js`
3. Add env var **`DATABASE_URL`** = the Neon connection string.
4. Deploy. The schema is created automatically on first boot.

(`render.yaml` is included for Blueprint deploys — it declares everything except the secret `DATABASE_URL`.)

## Login
- **Admin:** username `arifpadup` (credential currently defined client-side in `index.html`).
- **Technicians:** name + 4-digit PIN (stored per technician in the DB).
