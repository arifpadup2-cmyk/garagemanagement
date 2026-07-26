# Performance & Database Architecture Audit — Tecido Garage Management

**Auditor role:** Performance Engineer + Database Architect
**Date:** 2026-07-26
**Target scale assessed:** multi-branch company, thousands of vehicles/day, 10 years of data retention
**Stack audited:** `public/index.html` (8,037-line single-file vanilla-JS frontend), `server.js` (454 lines, Express generic JSONB CRUD), `db.js` (49 lines, Neon Postgres, pool max 8), `public/gms-backend.js` (259-line Firestore-compat shim)

**Safety compliance:** No DDL, no schema changes, no TRUNCATE, no deletion of pre-existing rows. Test rows were inserted ONLY into `parts` via `POST /api/parts`, every doc carried `"_perfTest": true` and a `ZZPERF-` name prefix, capped at 5,000, and all were deleted afterwards.

Row counts verified **before and after** the audit (identical):

| collection | before | after |
|---|---|---|
| customers | 6 | 6 |
| vehicles | 6 | 6 |
| jobCards | 6 | 6 |
| invoices | 3 | 3 |
| transactions | 7 | 7 |
| parts | 6 | **6** (5,000 ZZPERF rows deleted, 0 leftovers, names verified) |
| appointments | 5 | 5 |
| technicians | 4 | 4 |

---

## 1. Executive summary

The system is a faithful port of a Firestore prototype: **every collection is downloaded in full into browser arrays on login, every mutation re-downloads the whole affected collection, and every report/table is computed with `Array.filter`/`.find` over those arrays.** The server has **zero** support for pagination, filtering, date ranges, or aggregation (`server.js:193-200` is the only list route: `SELECT id, data FROM <table> ORDER BY ...` with no `WHERE`, no `LIMIT`).

Measured on the live system: payload, API latency, and render time all scale **linearly with row count** (verified 6 → 106 → 1,006 → 5,006 rows in `parts`), and several report paths are **O(customers × invoices)** quadratic.

**Verdict:** the app performs beautifully at demo size (18 KB total data, ~125 ms API calls, ~1 ms renders) and hits its first hard wall within **roughly 6–12 months** of busy single-branch operation. At 10 years of busy single-branch data the login payload is an estimated **300–450 MB**; at the stated multi-branch "thousands of vehicles/day" target it is **gigabytes**. The architecture cannot reach the target scale without server-side pagination, filtering, and aggregation. The good news: the server's atomic endpoints (`/pay`, `/adjust`, seq allocation) are well designed, and the remediation path is incremental — no rewrite required.

**Scores:** Performance **38/100** · Database Quality **31/100** · Enterprise Scalability **12/100** (justifications in §9).

---

## 2. Client-side scalability wall (PERF-01)

### 2.1 How data enters the browser

`initFirestore()` (`public/index.html:2650-2710`) plus `initAccountsFirestore()` (`index.html:5438-5450`) register `onSnapshot` on **10 collections + settings**. In the shim, `onSnapshot` → `refreshColl` → `fetchList` → `GET /api/<coll>` returning the **entire table** (`gms-backend.js:57`, `86-92`, `163-167`; `server.js:196`). Results are materialised as global arrays (`customers`, `vehicles`, `jobCards`, `invoices`, `transactions`, `parts`, …). Every screen renders by scanning these arrays.

Additionally, **every mutation re-downloads the whole collection**: `DocRef.update/set/delete` and `CollRef.add` all call `refreshColl(name)` (`gms-backend.js:121, 126, 129, 133, 151`), and `gmsApi.pay` refreshes **two** full collections — invoices and transactions (`gms-backend.js:237-242`). At 5,006 parts (measured), a single stock adjustment costs an extra **1.66 MB / 1.34 s** re-download.

### 2.2 Measured per-document sizes (live API, demo data)

| collection | payload | docs | bytes/doc |
|---|---|---|---|
| customers | 1,157 B | 6 | 193 |
| vehicles | 1,760 B | 6 | 293 |
| jobCards | 4,752 B | 6 | 792 |
| invoices | 1,777 B | 3 | 592 |
| transactions | 3,706 B | 7 | 529 |
| parts | 2,246 B | 6 | 374 (332 B/doc measured at 5,006 rows) |
| appointments | 1,197 B | 5 | 239 |
| technicians/advisors/finAccounts | 1,465 B | 8 | — |

**Total single page-load today: ≈ 18.1 KB across 11 API requests.** (No HTTP compression is configured — `package.json` deps are only `express` and `pg`; measured `size_download` equals raw JSON size.)

Note: demo jobCards are skeletal. A production job card with a 5–10 item `works` array, image path lists and notes is realistically **1.5–2.5 KB**; invoices with `payments` arrays 0.8–1.2 KB.

### 2.3 Realistic 10-year volumes and payloads

**Busy single branch** (30 job cards/day × 312 working days):

| collection | 10-yr rows | bytes/doc | payload per login |
|---|---|---|---|
| jobCards | ~93,600 | 800–2,000 | **75–187 MB** |
| invoices | ~90,000 | 600–1,200 | **54–108 MB** |
| transactions (≈3/invoice + expenses) | ~280,000 | 530 | **149 MB** |
| customers | ~15,000 | 193 | 2.9 MB |
| vehicles | ~20,000 | 293 | 5.9 MB |
| parts (8,000 SKUs, movements embedded — see DB-01) | 8,000 | 330 B + ~120 B/movement | 2.6 MB → **up to 100s of MB** |
| appointments | ~45,000 | 239 | 10.8 MB |
| **Total per login** | ~550,000 docs | | **≈ 300–450 MB** |

At measured server throughput (~1.2 MB/s for JSONB list serialization, §3), that is a **4–6 minute login**, followed by `JSON.parse` of hundreds of MB (browser heap 2–3× the JSON size → **0.6–1.3 GB**, i.e. tab crash territory).

**Stated multi-branch target** (2,000 vehicles/day): ~6.2M job cards in 10 years → multi-GB payloads. **Not reachable by this architecture under any tuning.**

### 2.4 When does each screen die? (from measured scaling, §3)

Using measured linear coefficients (render ≈ 0.085 ms/row for table screens; in-browser fetch ≈ 0.27 ms/row + ~60 ms base):

| screen | mechanism | janky (>100 ms/interaction) | unusable (>1 s) |
|---|---|---|---|
| Inventory / Job Cards / Customers tables | full innerHTML rebuild **on every search keystroke** (`index.html:1176`, `1249`) | ~1,200 rows | ~12,000 rows |
| Workshop kanban | 5 × `jobCards.filter` + full board rebuild (`index.html:3453-3459`) | ~1,500 open+historic cards | ~12,000 |
| Customer Accounts | `buildCustAccData` O(customers × invoices) (`index.html:6734-6743`) | ~1k × 10k | 15k customers × 90k invoices = **1.35 × 10⁹ comparisons → multi-second freeze** |
| GL – Customer ledger | `customers.filter(c => invoices.some(...))` then per-customer `invoices.filter` — **double O(c × i)** (`index.html:6272-6278`) | same | same |
| Trial Balance / Balance Sheet | `_accBal` filters **all** transactions 3× per account (`index.html:6484-6490`, called at `6505`, `6634`, `6649`, `6695`, `6702`) | 20 accounts × 100k txns = 6M ops | dies on the 149 MB transactions download first |
| Cash Flow | 12 months × 3 passes over all transactions = 36 full scans (`index.html:5552-5556`) | CPU fine; dies on payload |
| Aged Receivables | single pass over invoices (`index.html:5573-5601`) — CPU fine; dies on 54–108 MB invoice payload |
| Tech dashboard | `technicians.find` **twice inside a map over technicians** — O(n²) (`index.html:3070`) | harmless (n small) | — |

**The first wall is the payload wall**, not CPU: at ~25,000 total documents (≈ 6–12 months of busy operation, ≈ 15–25 MB per login over typical garage Wi-Fi/4G) logins take 5–15 s and every mutation's refresh becomes a visible multi-second stall. The render wall (~10–12k rows per table) follows in year 2–3; the quadratic report wall (customers × invoices) by year 2–4.

### 2.5 Representative O(n)/O(n²) citations

- `index.html:6734-6743` — `buildCustAccData`: `customers.map(...)` with `invoices.filter(...)` inside → O(c×i).
- `index.html:6272-6273` — `customers.filter(function(c){return invoices.some(...)})` → O(c×i); `6278` repeats the filter per customer.
- `index.html:6484-6490` — `_accBal` scans all transactions 3× per account per report row.
- `index.html:5552-5556` — cash flow: 36 full passes over `transactions`.
- `index.html:4697`, `3826` — `customers.find` inside a `.map` over vehicle search results.
- `index.html:3070` — `technicians.find` called twice inside a map over `technicians`.
- 122 total cross-collection `.find`/`.filter` sites over the global arrays (grep count).

---

## 3. Measured evidence — row-count scaling experiment

Method: inserted ZZPERF marker docs into `parts` via the public API (16-way concurrent POSTs), measured `GET /api/parts` with curl (3 runs each) and browser-side numbers with playwright-core (channel `chrome`, headless; real login flow; `performance.now()` around `renderInventory()`, 5 repetitions; in-browser fetch measured around `firebase.firestore().collection('parts').get()`).

| parts rows | payload bytes | API GET (curl total, best–worst) | in-browser fetch ms | renderInventory() ms (median of 5) | JS heap MB |
|---|---|---|---|---|---|
| 6 (baseline) | 2,246 | 125–128 ms | 134 | **1.2** | 3.8 |
| 106 | 35,316 | 132–377 ms | 253 | **11.9** | 5.3 |
| 1,006 | 333,826 | 259–650 ms | 282 | **91** | 3.2 |
| 5,006 | 1,663,916 | 776–1,467 ms | 1,337 | **426** | 4.4 |

Observations:
- **Perfectly linear**: ~332 B/row payload, ~0.085 ms/row render, ~0.27 ms/row server+network. No cliff — just a straight line to unusability.
- Render at 5k rows (426 ms) runs **on every keystroke** in the inventory search box (`index.html:1249 oninput="renderInventory()"`).
- Insert throughput via the API: 100 rows in 5.0 s, 900 in 44 s, 4,000 in 194 s (~20 docs/s at 16-way concurrency) — the per-doc transaction + advisory-lock-free path costs ~50 ms/doc against remote Neon. Bulk imports (e.g. opening-stock migration of 8,000 SKUs) would take ~7 minutes.
- Write amplification: each POST to `parts` in the real UI additionally triggers a full-collection refetch (`gms-backend.js:151`) — at 5k rows that is +1.66 MB per write.

Cleanup verified: 5,000 deletions, 0 errors, `parts` back to exactly 6 rows with 0 `_perfTest`/ZZPERF leftovers; remaining names are the 6 original demo parts.

---

## 4. Concurrency & connection pool (PERF-06)

`db.js:9-14`: `Pool({ max: 8, idleTimeoutMillis: 30000 })` — no `connectionTimeoutMillis`, no `statement_timeout`.

Read-only load test (parallel `GET`s, Node fetch, local server → remote Neon):

| test | n parallel | wall time | errors | p50 | p90 | p99 | max |
|---|---|---|---|---|---|---|---|
| /api/customers (1.1 KB) | 50 | 1.76 s | 0 | 1,337 ms | 1,587 | 1,709 | 1,709 |
| /api/customers | 200 | 3.25 s | 0 | 1,666 ms | 2,914 | 3,164 | 3,167 |
| /api/customers | 500 | 8.13 s | 0 | 4,114 ms | 7,238 | 7,893 | 8,001 |
| /api/parts @5,006 rows (1.66 MB) | 50 | 8.38 s | 0 | 5,213 ms | 8,230 | 8,329 | 8,329 |

Analysis:
- **No errors even at 500 parallel** — Node happily queues; nothing times out because no timeouts are configured. Users would instead see 4–8 s hangs.
- Single-request latency is ~126 ms, so 50-parallel p50 of 1,337 ms is a **10× queueing degradation** — requests serialize behind 8 pool connections (and Node's single thread for JSON serialization of `rows.map(...)` at `server.js:197`).
- Large payloads amplify: at 5k parts, 50 parallel readers → p50 **5.2 s**. Pool connections are held for the full query+fetch; 8 × 1.66 MB in flight also pressures the 512 MB Render instance.
- **Is max 8 right?** For Render free/starter (0.5 CPU, 512 MB) it is a sane per-instance cap — Node's CPU is the co-bottleneck, and Neon's free-tier direct connection limit (~112 for 0.25 CU) leaves headroom for a few instances. Raising to 15–20 via Neon's **pooled endpoint** (`-pooler`, PgBouncer) would roughly double burst read throughput today, but it does not change the O(table) query shape. Fix the queries, not the pool.
- **500 concurrent users at login:** today each login pulls ~18 KB × 11 requests → 500 logins = ~9 MB + 5,500 requests → survivable but slow (each user's 11 requests queue; measured p50 suggests 15–30 s login storms). At 10-year single-branch scale each login pulls **300–450 MB** → 500 users = **150–225 GB** transfer; the platform is dead long before that (Neon egress, Render bandwidth, browser heap).

---

## 5. Database quality (DB-01 … DB-07)

### 5.1 Indexes defined (`db.js:35-41`) vs. actual query patterns

| index | used by |
|---|---|
| `idx_jobcards_created (created_at DESC)` | only the `ORDER BY` of the full-table list (`server.js:196`) — Postgres may use it to avoid a sort, but every row is returned anyway; and `MAX(seq)` in seq allocation does a full scan (no index on `seq`) |
| `uq_invoices_jobcard` (unique expression on `data->>'jobCardId'`) | **excellent** — real integrity constraint enforcing one invoice per job card (`server.js:262` handles 23505) |
| `idx_invoices_created`, `idx_txn_date`, `idx_appt_date` | ordering only, same caveat |
| technicians/advisors `name` helper columns | `ORDER BY name` (`server.js:145-146`) — unindexed, but tables are tiny |

**Effectively, only the unique constraint earns its keep.** Every list query is a full-table scan **by design** — there is no `WHERE` clause anywhere in the read path:

- `server.js:193-200` — the only list route: `SELECT id, data FROM ${cfg.table} ORDER BY ${cfg.order}`. **No `limit`, `offset`, `since`, `from/to`, `status`, or `q` parameter exists; `req.query` is never read.**
- `server.js:410-421` — `/api/export` loads **every row of every table** into a single in-memory JS object, then `res.json` — at 10-year scale this is a 300+ MB string built on a 512 MB Render instance → OOM (PERF-07).

All domain filtering happens client-side (§2), so **no conceivable JSONB index can ever be used** — the server never expresses a predicate. Indexes on `data->>'status'`, `data->>'customerId'` etc. are unusable until server-side filtering exists (DB-04 lists the ones to add *with* that work).

### 5.2 JSONB-document design consequences

- **No foreign keys**: `invoices.data->>'customerId'`, `vehicles.data->>'customerId'`, `jobCards.data->>'vehicleId'` are unconstrained strings. Deleting a customer leaves orphaned vehicles/invoices; nothing in `server.js` prevents it (`DELETE /api/:coll/:id` is unconditional, `server.js:386-391`).
- **No NOT NULL / CHECK / typed money**: `total`, `amount` are JSON numbers; the server compensates with `round2` (`server.js:51, 63-71`) — good hygiene, but nothing stops a client writing `total: "abc"`.
- **Denormalized names drift**: `customerName` is copied into invoices/jobCards; the GL customer ledger matches by `customerId===c.id || customerName===c.name` (`index.html:6273`) — a rename silently splits a customer's ledger.
- **Unbounded embedded arrays (DB-01, Critical)**: `parts.data.movements` is appended on **every** stock adjustment (`server.js:343-345`) and the **entire document is rewritten** each time. A fast-moving part (20 movements/day) reaches ~73,000 movements ≈ **8.7 MB in a single JSONB doc** in 10 years; every adjustment rewrites all of it under `FOR UPDATE`, and every parts list ships it to every browser. Same pattern, lower risk: `invoices.data.payments` (bounded small).
- **No SQL aggregation possible today** because nothing aggregates server-side — but it *is* possible with jsonb operators (§7 gives working SQL); the schema is salvageable without migration.
- **Images as bytea in the primary DB** (`db.js:32`, `server.js:425-437`, 8 MB cap, 15 MB JSON body limit at `server.js:34`): job-card photos will dominate Neon storage within months (30 jobs/day × 4 photos × 1 MB ≈ 3.6 GB/month) and image serving occupies pool connections.

### 5.3 Will the browser-side aggregate reports survive 10 years?

**No.** P&L, trial balance, cash flow, balance sheet, VAT, and aged receivables all iterate the full `transactions` (est. 280k rows / 149 MB) and `invoices` (90k / 54–108 MB) arrays (`index.html:6567-6617`, `6492-6555`, `5545-5569`, `5573-5601`, `5605-5634`). They fail on payload (download + parse) years before CPU matters, and the quadratic customer-ledger paths (§2.4) fail on CPU too. Every one of these reports is a 5–30 line GROUP BY in Postgres (§7).

---

## 6. Memory & long-session stability (PERF-08)

Code review:
- The shim's unsubscribe is a **no-op** — `return function(){}` (`gms-backend.js:139`, `167`), and `collListeners`/`docListeners` (`gms-backend.js:54-55`) only ever grow.
- However, registration happens **once per page life**: `showApp` and `showTechPortal` guard with `if(!firestoreReady){firestoreReady=true;initFirestore();}` (`index.html:2603`, `7607`), so repeated navigation/re-login does **not** stack duplicate listeners or multiply fetches.
- `doLogout` (`index.html:2570-2574`) merely hides the app div: **listeners stay armed and all business data (customer PII, invoices) stays in the global arrays** after logout — a privacy issue on shared workshop PCs, and any later background `refreshColl` fires with a cleared token → 401 → forced reload (`gms-backend.js:27-34`).
- Timers: the only `setInterval` is the tech-portal elapsed timer (`index.html:7618`), correctly cleared at `7617`/`7624`. Clean.

Measured (playwright, 100 view transitions across 10 screens at 5,006 parts, heap sampled every 10 navs):

`9.2 → 5.1 → 5.1 → 12.4 → 17.2 → 17.1 → 17.2 → … → 17.2 MB → 4.7 MB after 3 s idle`

Plus: **0 network fetches during 20 navigations** (views render purely from the in-memory arrays).

**Verdict: no unbounded leak today.** Heap plateaus at ~17 MB and GC fully recovers. The risks are structural (no-op unsubscribe would leak if any code ever registered listeners per-navigation) and the logout data-retention issue. At 10-year data volumes the *baseline* arrays themselves (hundreds of MB) are the memory problem, not leakage.

---

## 7. Ranked remediation plan

Ordered by (mandatory-by threshold, impact/effort). "Mandatory at" = total docs in the affected collection.

### R1 — Server-side pagination + filtering on `GET /api/:coll` (Critical; mandatory at ~5,000 docs/collection; **3–5 days**)

Add keyset pagination and whitelisted filters to the list route (`server.js:193-200`):

```js
// GET /api/:coll?limit=100&before=<created_at>&from=YYYY-MM-DD&to=YYYY-MM-DD&status=...&q=...
const lim = Math.min(Number(req.query.limit) || 200, 500);
const conds = [], vals = [];
if (req.query.before) { vals.push(Number(req.query.before)); conds.push(`created_at < $${vals.length}`); }
if (cfg.extra && cfg.extra.txn_date && req.query.from) { vals.push(req.query.from); conds.push(`txn_date >= $${vals.length}`); }
if (req.query.status) { vals.push(req.query.status); conds.push(`data->>'status' = $${vals.length}`); }
vals.push(lim);
const { rows } = await pool.query(
  `SELECT id, data FROM ${cfg.table}
   ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
   ORDER BY ${cfg.order} LIMIT $${vals.length}`, vals);
```

Client side: `CollRef.where()` is already a stub (`gms-backend.js:145`) — implement it to accumulate `{field,op,value}` and have `fetchList` translate to query params; `refreshColl` re-runs the listener's *own* window instead of the whole table. Renderers then request `?limit=200` for tables and `?from&to` for reports. Keep an unpaged fallback behind `?limit=all` for the six small collections (technicians, advisors, finAccounts, settings) so most screens need no change on day one. Big screens (Job Cards, Sales, Inventory, Transactions) get a "Load more" keyset cursor.

### R2 — Server-side aggregation endpoints for all reports (Critical; mandatory at ~20,000 transactions; **3–4 days**)

P&L (uses existing `idx_txn_date`):

```sql
SELECT data->>'type' AS type, COALESCE(data->>'category','Uncategorised') AS category,
       SUM((data->>'amount')::numeric) AS amount
FROM transactions
WHERE txn_date >= $1 AND txn_date <= $2
GROUP BY 1, 2 ORDER BY 1, 2;
```

Aged receivables:

```sql
WITH open_inv AS (
  SELECT data->>'customerId' AS customer_id,
         MAX(data->>'customerName') AS customer_name,
         (data->>'total')::numeric - COALESCE((data->>'totalPaid')::numeric, 0) AS balance,
         (CURRENT_DATE - COALESCE((data->>'creditDueDate')::date,
             to_timestamp(((data->>'createdAt')::bigint)/1000)::date)) AS age_days
  FROM invoices
  WHERE data->>'status' IN ('unpaid','partial','credit')
  GROUP BY id, data
)
SELECT customer_id, MAX(customer_name) AS name,
       SUM(balance) FILTER (WHERE age_days <= 30)                  AS b_0_30,
       SUM(balance) FILTER (WHERE age_days BETWEEN 31 AND 60)      AS b_31_60,
       SUM(balance) FILTER (WHERE age_days BETWEEN 61 AND 90)      AS b_61_90,
       SUM(balance) FILTER (WHERE age_days > 90)                   AS b_90_plus,
       SUM(balance)                                                AS total_due
FROM open_inv
WHERE balance > 0.005
GROUP BY customer_id
ORDER BY total_due DESC;
```

Same pattern for trial balance (`SUM ... FILTER (WHERE data->>'type'='income')` grouped by `data->>'accountId'`), cash flow (`GROUP BY substr(txn_date,1,7)`), VAT (`GROUP BY month, SUM((data->>'taxAmount')::numeric)`), customer statement (`WHERE data->>'customerId' = $1`), and dashboard KPIs. Each endpoint returns a few hundred bytes instead of shipping 100+ MB to the browser. Kills the O(c×i) paths (`index.html:6272`, `6734`) outright.

### R3 — Partial/expression indexes to support R1/R2 (Critical, ships with R1/R2; **half a day**, `CREATE INDEX CONCURRENTLY` in a maintenance window):

```sql
CREATE INDEX CONCURRENTLY idx_invoices_open
  ON invoices ((data->>'customerId'))
  WHERE data->>'status' IN ('unpaid','partial','credit');          -- aged AR, customer accounts
CREATE INDEX CONCURRENTLY idx_invoices_customer ON invoices ((data->>'customerId'));
CREATE INDEX CONCURRENTLY idx_jobcards_status   ON job_cards ((data->>'status'), created_at DESC); -- workshop board
CREATE INDEX CONCURRENTLY idx_txn_acct_date     ON transactions ((data->>'accountId'), txn_date);  -- ledgers, _accBal
CREATE INDEX CONCURRENTLY idx_txn_type_date     ON transactions ((data->>'type'), txn_date);       -- P&L, cash flow
CREATE INDEX CONCURRENTLY idx_vehicles_customer ON vehicles ((data->>'customerId'));
CREATE INDEX CONCURRENTLY idx_vehicles_reg      ON vehicles ((lower(data->>'registrationNo')));    -- plate lookup
CREATE INDEX CONCURRENTLY idx_jobcards_seq      ON job_cards (seq);                                 -- MAX(seq) in seq allocator (server.js:238)
CREATE INDEX CONCURRENTLY idx_invoices_seq      ON invoices (seq);
-- optional, for search-as-you-type: CREATE EXTENSION pg_trgm;
CREATE INDEX CONCURRENTLY idx_parts_name_trgm   ON parts USING gin ((data->>'name') gin_trgm_ops);
```

### R4 — Move `parts.movements` out of the part document (High; mandatory at ~1,000 movements on any single part; **1–2 days**). New `part_movements` collection table (same JSONB pattern is fine: `(id, data jsonb, part_id text, created_at)`); `POST /api/parts/:id/adjust` (`server.js:325-354`) writes a movement row + updates only `stock` in the part doc; movement history endpoint is paged. Prevents the 8.7 MB single-doc scenario and the full-doc rewrite per adjustment.

### R5 — HTTP compression + payload trimming (High; helps immediately; **half a day**). `app.use(require('compression')())` — measured 1.66 MB parts payload is repetitive JSON, gzip typically cuts 80–90% → the 10-year interim pain drops ~7×. Also add a `?fields=` projection (e.g. list views don't need `movements`, `payments`, `works` bodies: `SELECT id, data - 'movements' FROM parts`).

### R6 — Pool & timeouts (Medium; **1 hour**). Keep `max: 8` per instance on the starter tier but (a) point `DATABASE_URL` at Neon's pooled `-pooler` endpoint, (b) add `connectionTimeoutMillis: 5000` and `options: '-c statement_timeout=15000'` so a stuck query can't wedge all 8 connections forever, (c) raise `max` to 15–20 only after R1 shrinks per-query work. 500-user concurrency is solved by R1/R2 (tiny fast queries), not by pool size.

### R7 — Caching (Medium; after R1; **1 day**). ETag/`If-None-Match` on list endpoints (hash of `MAX(created_at)||COUNT(*)`) so the shim's refresh-after-mutation becomes a cheap 304 for unchanged collections; 60 s in-memory server cache for settings/technicians/advisors. Optional: replace refresh-after-mutation with the mutation response itself (the server already returns the full merged doc — `server.js:259, 313, 347, 376` — the shim can patch its array in place instead of refetching; `gms-backend.js:86-92`).

### R8 — Move images to object storage (Medium; mandatory before photo volume > ~5 GB; **1–2 days**). S3-compatible bucket (Cloudflare R2 free tier) with signed upload URLs; keep `images` table as a path index only. Frees Neon storage and pool connections.

### R9 — Logout hygiene + shim teardown (Low; **half a day**). `doLogout` should clear the global arrays and `location.reload()`; implement real unsubscribe in the shim (remove from `collListeners`) so future per-view listeners can't leak.

### R10 — Streaming export (Low; mandatory at ~50 MB dataset; **half a day**). Stream `/api/export` per-collection with cursors instead of building one object in RAM (`server.js:410-421`).

---

## 8. Findings register

Severity legend: Critical = blocks target scale / data-loss-grade UX; High = user-visible degradation within 1–2 years; Medium = operational risk; Low = hygiene.

---

**PERF-01 — Full-collection fetch of every collection on every login; no pagination anywhere**
- Module: API + shim + all screens · Severity: **Critical**
- Business impact: login time and bandwidth grow linearly forever; ~300–450 MB/login at 10-year busy-branch scale (4–6 min + browser crash); multi-branch target unreachable.
- Repro: log in; observe 11 `GET /api/<coll>` requests each returning the whole table.
- Root cause: `server.js:196` `SELECT id, data FROM ${cfg.table} ORDER BY ...` with no WHERE/LIMIT; `req.query` never read. Shim `fetchList` (`gms-backend.js:57`) has no windowing; `initFirestore` (`index.html:2650`) subscribes to everything upfront.
- Evidence: measured 332 B/row × linear payload table (§3); 18.1 KB today → extrapolation §2.3.
- Fix: R1 (+R3). Regression tests: paged list returns ≤ limit rows, keyset cursor stable under concurrent inserts, legacy `?limit=all` path byte-identical for small collections.
- Risk if not fixed: app unusable within ~1 year of busy operation. Priority: **P0** · Est: 3–5 days.

**PERF-02 — Refresh-after-mutation re-downloads the entire collection (write amplification)**
- Module: shim · Severity: **Critical** (compound of PERF-01)
- Repro: at 5,006 parts, one stock adjust triggers `GET /api/parts` = **1.66 MB / 1.34 s** (measured); `gmsApi.pay` refreshes invoices **and** transactions (`gms-backend.js:239-241`).
- Root cause: `refreshColl` (`gms-backend.js:86-92`) called from every mutation path (`121, 126, 129, 133, 151, 182, 239-241, 246`).
- Fix: patch-in-place from the mutation response (already returned complete: `server.js:259/313/347/376`) or R7 ETag/304. Regression: after add/update/delete/pay/adjust, the visible row matches server state without a full list GET.
- Priority: **P0** (ships with R1/R7) · Est: 1–2 days.

**PERF-03 — Quadratic O(customers × invoices) report paths in the browser**
- Module: Customer Accounts, GL customer ledger · Severity: **High**
- Root cause/Evidence: `buildCustAccData` `index.html:6734-6743` (`customers.map` → `invoices.filter` inside); `renderGlCustomer` `index.html:6272-6278` (`customers.filter(c => invoices.some(...))` then `invoices.filter` per customer); `_accBal` `index.html:6484-6490` (3 full transaction scans per account, call sites 6505/6634/6649/6695/6702).
- Impact: 15k customers × 90k invoices = 1.35 × 10⁹ comparisons → multi-second/minute UI freezes (browser main thread).
- Fix: R2 SQL (aged AR + customer statement queries in §7). Regression: report totals match legacy browser computation on a snapshot dataset to the cent.
- Priority: **P1** · Est: included in R2's 3–4 days.

**PERF-04 — Full table re-render on every search keystroke**
- Module: Inventory, Job Cards (and pattern repeats on other tables) · Severity: **High**
- Evidence: `index.html:1249` `oninput="renderInventory()"`, `index.html:1176` `oninput="renderJobCards()"`; measured `renderInventory` = 426 ms at 5,006 rows → 400+ ms of jank **per keystroke**.
- Fix: 200 ms debounce (10 lines) now; server-side `?q=` (R1) + row cap later. Regression: typing 10 chars fires ≤ 2 renders.
- Priority: **P1** · Est: 1 hour (debounce), then covered by R1.

**PERF-05 — No HTTP compression**
- Module: server · Severity: **Medium** · Evidence: deps = express+pg only (`package.json:14-17`); measured `size_download` = raw JSON (1,663,916 B at 5k parts).
- Fix: R5 `compression()` (~80–90% cut on this data). Priority: **P1** · Est: 0.5 day incl. verification.

**PERF-06 — Concurrency collapse behind 8-connection pool + single-threaded serialization**
- Module: db.js/server · Severity: **Medium** today, High at scale
- Evidence: measured §4 — 50 parallel 1.1 KB GETs: p50 1,337 ms (10× single-request); 500 parallel: p50 4,114 / p99 7,893 ms; 50 parallel 1.66 MB GETs: p50 5,213 ms. Zero errors — and zero timeouts configured (`db.js:9-14`).
- Fix: R6 (pooler endpoint, statement/connect timeouts, modest max raise) — but real cure is R1/R2 shrinking per-request work. Regression: 200-parallel p95 < 500 ms post-R1.
- Priority: **P2** · Est: 1 hour + retest.

**PERF-07 — `/api/export` builds the entire database in RAM**
- Module: server backup path · Severity: **Medium** (becomes Critical as data grows)
- Evidence: `server.js:410-421` — loops every table with unbounded `SELECT`, accumulates one object, `res.json`. At 300+ MB dataset on a 512 MB Render instance → OOM = **backups silently stop working exactly when they matter**.
- Fix: R10 streaming export. Regression: export of a 1 GB synthetic dataset completes with < 150 MB RSS growth.
- Priority: **P2** · Est: 0.5 day.

**PERF-08 — Long-session/leak posture: structurally leak-prone shim, but measured-bounded today; logout retains data + live listeners**
- Module: shim + auth UX · Severity: **Low** (privacy aspect: Medium on shared PCs)
- Evidence: no-op unsubscribe `gms-backend.js:139,167`; single-registration guards `index.html:2603, 7607`; `doLogout` only hides divs (`index.html:2570-2574`); measured 100-nav heap plateau 17.2 MB → 4.7 MB after GC, 0 fetches during 20 navs; only `setInterval` is properly cleared (`index.html:7617-7624`).
- Fix: R9. Regression: after logout, globals empty and no API call fires; heap after 500 navs within 2× post-login baseline.
- Priority: **P3** · Est: 0.5 day.

**DB-01 — Unbounded embedded `movements` array rewritten on every stock adjustment**
- Module: parts/inventory · Severity: **Critical** (data-growth time bomb)
- Evidence: `server.js:343-345` appends to `data.movements` and rewrites the whole doc under `FOR UPDATE`; doc grows ~120 B/movement forever; fast-moving part ≈ 8.7 MB doc in 10 years, shipped in every parts list and rewritten per adjust.
- Fix: R4 `part_movements` table + paged history endpoint. DB changes: new table only (additive — allowed pattern). Regression: adjust still atomic & non-negative; part doc size constant; history paging correct.
- Priority: **P0** · Est: 1–2 days.

**DB-02 — No server-side filtering parameters at all (indexes cannot ever be used)**
- Module: API/DB · Severity: **Critical** · Evidence: `server.js:193-200` (no `req.query` usage in read path); consequently the JSONB fields filtered client-side (status, customerId, date, type — 122 grep hits in index.html) can use **no index whatsoever**.
- Fix: R1 + R3 (whitelisted param → predicate mapping; never interpolate field names from user input). Priority: **P0** · Est: within R1.

**DB-03 — All financial aggregates computed in the browser over full collections**
- Module: P&L, Trial Balance, Balance Sheet, Cash Flow, VAT, Aged AR · Severity: **High**
- Evidence: `index.html:6567-6617` (P&L over full `transactions`), `6492-6555` + `6484-6490` (trial balance, 3 scans/account), `5545-5569` (36 scans), `5573-5601` (aged AR), `5605-5634` (VAT). Requires the 149 MB 10-year transactions download to render one 12-row table.
- Fix: R2 endpoints (SQL in §7). Verdict on 10-year survival: **will not survive year 2–3**. Priority: **P1** · Est: 3–4 days.

**DB-04 — Index inventory misaligned with future access paths; seq allocator scans**
- Module: db.js · Severity: **High** (post-R1) · Evidence: `db.js:35-41` — 4 ordering indexes + 1 unique constraint; no index on `seq` yet `MAX(seq)` runs on every job-card/invoice create (`server.js:238-240`); no `(data->>'status')`, `(data->>'customerId')`, `(data->>'accountId')` support.
- Fix: R3 statements. Priority: **P1** · Est: 0.5 day (CONCURRENTLY).

**DB-05 — JSONB design: no FKs, no constraints, denormalized name drift, unconditional deletes**
- Module: schema-wide · Severity: **Medium**
- Evidence: `db.js:20-33` (all tables `(id, data)`); `server.js:386-391` (delete without referential checks); `index.html:6273` (ledger matches by `customerName` fallback — rename splits ledgers).
- Fix: application-level referential checks on DELETE (block deleting a customer with vehicles/invoices — 409 with count); backfill `customerId` on legacy invoices; longer term promote hot columns (`status`, `customerId`, `total`) to real typed columns via additive migration. Regression: delete of referenced customer returns 409; ledger by id only.
- Priority: **P2** · Est: 1–2 days.

**DB-06 — Images stored as bytea in the primary database**
- Module: storage · Severity: **Medium** · Evidence: `db.js:32`, `server.js:424-442` (8 MB/image, 15 MB JSON body limit at `server.js:34`); job-card photos → est. 3.6 GB/month at 30 jobs/day × 4 photos.
- Fix: R8 object storage. Priority: **P2** · Est: 1–2 days.

**DB-07 — Pool has no connect/statement timeouts**
- Module: db.js · Severity: **Low** · Evidence: `db.js:9-14`. One wedged query (e.g. a future unindexed report) holds a connection forever; 8 wedges = total outage with zero errors surfaced (matches §4 observation that nothing ever times out).
- Fix: R6 config. Priority: **P2** · Est: 1 hour.

---

## 9. Scores (justified by measurements)

**Performance: 38/100.** At demo size the app is genuinely fast (125 ms API, 1.2 ms renders — full marks there), and there is no memory leak (measured plateau + full GC recovery). But every scaling coefficient is linear-with-no-ceiling (332 B/row payload, 0.085 ms/row keystroke-render, 0.27 ms/row fetch — §3), mutations cost O(collection) (1.66 MB per stock adjust at 5k parts), 50 concurrent readers already see 10× latency (§4), and there is no compression, no cache, no debounce. The measured curves cross "unusable" within the first 1–2 years of the stated workload.

**Database Quality: 31/100.** Genuine strengths: atomic, row-locked money paths (`/pay`), race-free monotonic sequence numbers with advisory locks, a real unique constraint on invoice-per-jobcard, parameterized SQL throughout, server-side rounding. But: zero usable indexes for any domain predicate (none can exist — the server never filters, `server.js:196`), no FKs/constraints/types on any business field, an unbounded embedded array rewritten per write (DB-01), images in the primary DB, `MAX(seq)` scans per create, and no timeouts. It is a well-guarded document store, not an enterprise database.

**Enterprise Scalability: 12/100.** The defining requirement — thousands of vehicles/day, 10 years, multi-branch — is unreachable: estimated 300–450 MB per login at *single*-branch scale (§2.3), quadratic reports at 1.35 × 10⁹ operations (§2.4), a backup endpoint that OOMs before the dataset matters (PERF-07), and no concept of branch/tenant anywhere in the schema. The points awarded reflect that the server's CRUD core, the JSONB tables, and the shim's seam (`where()` stub, single list route) make the remediation plan (§7, ~2–3 weeks of P0/P1 work) incremental rather than a rewrite.

---

## Appendix — measurement environment

Local server `http://localhost:3010` → remote shared Neon Postgres (as deployed). curl timings include TLS-less localhost hop + Neon round trip. Browser: headless Chrome via playwright-core (project's own dependency). All test scripts ran from the session scratchpad; no project files modified other than this report. Test-data lifecycle: 5,000 ZZPERF parts inserted via `POST /api/parts` (100 → 1,000 → 5,000), deleted via `DELETE /api/parts/:id`, final state verified equal to baseline (§ top table).
