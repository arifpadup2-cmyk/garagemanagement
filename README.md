# Tecido Garage Management (GMS)

Garage / auto-service management system for Tecido.

## Modules
Dashboard · Job Cards · Sales · Customers · Vehicles · Technicians · Service Advisors · Accounts · Settings

## Branches
- `master` — **current production app** (single-file, Firebase Firestore + Storage), deployed to Firebase Hosting: https://tecido-garage-management.web.app
- `postgres-migration` — in progress: Node + Express + PostgreSQL (Neon) backend, front-end rewired to a REST API. Photos stored in Postgres.

## Current app (master)
`public/index.html` — self-contained HTML/CSS/JS talking directly to Firestore.
