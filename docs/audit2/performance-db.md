# Performance & Database Architecture Audit — Tecido Garage Management

**Date:** 2026-07-26
**Scope:** `server.js`, `db.js`, `public/gms-backend.js`, `public/index.html`
**Method:** Static code analysis + Big-O/row-count reasoning. No load was written to the live Neon DB.
**Question asked:** does this architecture survive 10 years of real multi-branch usage?

**Short answer: no.** The app is built on a single load-bearing assumption — "collections are small enough
to fetch in full, on every screen, forever" — borrowed directly from the Firestore original. That
assumption is false past roughly Year 1–2 of real usage. Nothing in the stack (client, API, schema)
puts a ceiling on document count, document size, or DOM size, so every one of those dimensions grows
without bound for the life of the business.

---

## 0. How the app loads data (the root cause, in one picture)

`public/gms-backend.js` reimplements the Firestore compat API on top of plain REST:

- `onSnapshot()` (`gms-backend.js:163-167`) → **fetches the entire collection once**, no query params,
  no `LIMIT`, no cursor. `server.js:193-200` backs it with `SELECT id, data FROM <table> ORDER BY <col>`
  — literally every row, every time.
- Every mutation (`DocRef.set/update/delete`, `CollRef.add`, `Batch.commit` — `gms-backend.js:121-183`)
  calls `refreshColl(name)` (`gms-backend.js:86-92`) afterwards, which **re-fetches the whole collection
  again** to re-render.
- `window.gmsApi.pay()` and `.adjustStock()` (`gms-backend.js:234-249`) each refresh **two** full
  collections per call (`invoices`+`transactions`, or `parts`).
- The SPA (`public/index.html:2650-2710`) subscribes to all 10 collections on login via `initFirestore()`.

So: **cost per write = O(size of every collection touched)**, forever, and this cost is paid by the
browser doing the write (fetch, parse, re-render) as well as by Neon (read the whole table) and Render
(serialize/transfer the whole table) on every single click that changes data. There is no pagination,
no filtering, no field projection, and no caching anywhere in the stack — confirmed by grep: zero hits
for `LIMIT`, `OFFSET`, `pagination`, `virtualiz`, `debounce` across `server.js`, `db.js`, and
`public/index.html` (525 KB, 190 `.filter(`, 90 `.reduce(` call sites).

Everything below is a consequence of this one design decision.

---

## 1. Data-loading model

### P1 — Full-collection fetch on every login and every mutation (write amplification = O(N) per write)
**Severity:** Critical
**Business impact:** As data accumulates, every click that saves anything (a job card, a payment, a
stock movement) gets slower, and it gets slower for *everyone*, not just the user who made the change,
because the *next* screen render for any user re-pulls the full table. At scale this turns a "save
invoice" click into a multi-second, multi-megabyte operation.

**Evidence:**
- `public/gms-backend.js:86-92` `refreshColl()` — full `GET /:name` after every write.
- `public/gms-backend.js:121,129,133,157,182` — `.update`, `.set`, `.delete`, `.add`, `Batch.commit` all call it.
- `server.js:193-200` — `GET /api/:coll` → `SELECT id, data FROM <table> ORDER BY <col>` — no `WHERE`, no `LIMIT`.
- `public/index.html:2650-2710` `initFirestore()` — 10 `onSnapshot` subscriptions fired at login.

**Root cause:** the Firestore-compat shim was built to preserve the *original app's* reactive
programming model (`onSnapshot` → re-render) but backed it with a REST endpoint that has no concept
of incremental sync, unlike real Firestore listeners which only ship deltas.

**Fix:**
1. Add server-side pagination + delta sync: `GET /api/:coll?since=<createdAt|updatedAt>&limit=200&cursor=...`.
2. Change `refreshColl` to merge the mutated document into the client-side array in place instead of
   re-fetching (the server already returns the full saved doc from POST/PUT — use it):
   ```js
   // gms-backend.js — instead of refreshColl(self._name) after set/update:
   DocRef.prototype.update = function (data) {
     var self = this;
     return req('PUT', url, data).then(function (r) {
       upsertLocal(self._name, r);      // patch in place, no re-fetch
       notifyListeners(self._name);
       return r;
     });
   };
   ```
3. For genuinely shared state (e.g. another terminal changed a job card), poll a cheap
   `GET /api/:coll/changes?since=ts` endpoint on an interval instead of re-fetching everything.

**DB changes:** add `updated_at bigint` to every JSONB table (currently only `created_at` exists) so
"what changed since ts" is queryable with an index.

**Regression/load test:** synthetic seed of 50k job cards (throwaway, deleted after) + Playwright script
that times `db.collection('jobCards').doc(id).update(...)` end-to-end; assert it stays O(1) (flat latency
regardless of collection size) instead of growing linearly with row count.

**Risk if unfixed:** every screen gets slower every year; eventually (see §7) the "save" click itself
times out or crashes the tab, i.e. the app becomes unusable at exactly the scale (multi-branch, 10 years)
this audit was asked to project.

---

### P2 — `parts.movements[]` refetch-on-every-adjustment is quadratic over the table's lifetime
**Severity:** Critical
**Business impact:** stock adjustments (the single most frequent inventory action in a busy garage) get
slower and slower, forever, in proportion to the *entire history of every part ever stocked* — not just
the part being adjusted.

**Evidence:**
- `server.js:322-354` `POST /api/parts/:id/adjust` appends one `movement` object to `p.movements` and
  rewrites the **entire JSONB document** (`UPDATE parts SET data = $2 WHERE id = $1`).
- `public/gms-backend.js:244-248` — after every single adjustment, `refreshColl('parts')` re-fetches
  **every part and every part's full movement history**, not just the changed row.
- `public/index.html:3696` `renderPart()` sorts/renders `p.movements` client-side, unbounded.

**Root cause:** `movements[]` is an unbounded embedded array (classic MongoDB/Firestore anti-pattern
carried into JSONB), and the refresh strategy re-fetches unrelated documents' full history on every write.

**Big-O / row-count reasoning:** with `M` parts and `K` average movements per part, one stock adjustment
costs `O(M·K)` bytes over the wire (whole `parts` table, movements included) even though the adjustment
itself only changed `O(1)` data. At the brief's own benchmark scale (500,000 stock movements spread over,
say, 1,000–2,000 active parts ≈ 250–500 movements/part × ~140 bytes/movement ≈ 35–70 KB per part row),
the `parts` collection payload is **35–140 MB**, refetched in full on *every single* "Adjust Stock" click,
system-wide, forever.

**Fix:**
1. Move `movements` to its own table:
   ```sql
   CREATE TABLE part_movements (
     id bigserial PRIMARY KEY,
     part_id text NOT NULL REFERENCES parts(id),
     type text NOT NULL, qty numeric NOT NULL, from_qty numeric, to_qty numeric,
     note text, by text, at bigint NOT NULL
   );
   CREATE INDEX idx_part_movements_part_at ON part_movements(part_id, at DESC);
   ```
2. `POST /api/parts/:id/adjust` inserts one row into `part_movements` and updates only `parts.stock`
   (a small, fixed-size UPDATE) — no more read-modify-write of a growing blob.
3. `GET /api/parts/:id/movements?limit=50&cursor=...` for the movement history panel; the parts
   *list* fetch never carries movement history at all.
4. Client refresh after adjust: patch the single part's `stock` locally; do not refetch the collection.

**DB changes:** new `part_movements` table + index above; drop `movements` key from `parts.data` going
forward (keep for read-compat during migration, backfill into the new table once, then stop writing it).

**Regression/load test:** seed 1 part with 5,000 movements (throwaway), time
`POST /parts/:id/adjust` before/after the fix; assert latency and response size become independent of
existing movement count.

**Risk if unfixed:** stock-taking (a daily, high-frequency workflow) becomes the single heaviest
operation in the app and keeps getting heavier every day the business operates — a slow, silent decline
rather than a single outage, which makes it easy to miss until it's already painful.

---

### P3 — Same pattern on `invoices.payments[]`
**Severity:** High
**Business impact:** recording a payment re-fetches every invoice's full payment history plus the
entire transactions table, on every payment, forever.

**Evidence:** `server.js:273-320` `POST /api/invoices/:id/pay` — row-locked read-modify-write of the
*whole invoice document* to append to `payments[]`; `gms-backend.js:237-242` then calls
`refreshColl('invoices')` **and** `refreshColl('transactions')`.
Also note the endpoint loops `for (const t of transactions) { await client.query(INSERT...) }`
(`server.js:301-310`) — N sequential round-trips to Neon *while holding the invoice's row lock*
(`FOR UPDATE`, line 282), so a multi-tender payment (cash + card + cheque) serializes N network
round-trips inside one transaction, extending lock hold time.

**Fix:** same shape as P2 — `payments` becomes its own table (`invoice_payments`), invoice row only
holds `total_paid`/`status`; batch-insert the cash-book transaction rows with a single multi-row
`INSERT ... VALUES ($1,$2,...),($3,$4,...)` instead of a loop; client patches the single invoice + appends
the new transactions locally instead of refetching both collections.

```sql
CREATE TABLE invoice_payments (
  id bigserial PRIMARY KEY,
  invoice_id text NOT NULL REFERENCES invoices(id),
  method text, amount numeric NOT NULL, paid_at bigint NOT NULL, meta jsonb
);
CREATE INDEX idx_invoice_payments_invoice ON invoice_payments(invoice_id);
```

**Regression/load test:** seed an invoice with 200 prior payments (throwaway), assert `/pay` latency
is flat and the row lock is held for < the loop's cumulative round-trip time (i.e. bulk insert, not N inserts).

**Risk if unfixed:** cashier-facing "Record Payment" flow — the highest-frequency money-touching action
in the app — degrades the same way stock adjustment does.

---

### P4 — Dashboard renders recompute over the *entire* unfiltered arrays on every paint
**Severity:** High
**Business impact:** the dashboard (the screen every user lands on, and the one re-rendered most often —
after every job-card write, invoice write, technician write, or period-button click) does multiple full
scans of the largest collections in the app, some of them nested.

**Evidence — `public/index.html:2771-2918` `renderDashboard()`:**
- Line 2782: `jobCards.filter(...)` over the full array even for period ≠ "all".
- Lines 2829-2831: for **each technician**, `jobCards.reduce(...)` scans the **full, unfiltered**
  `jobCards` array to count active tasks — `O(technicians × jobCards × avg works-per-card)`. At 20
  technicians × 50,000 job cards × 3 works/card ≈ **3,000,000 element visits per dashboard paint.**
- Lines 2857-2870: the 7-day cash-flow mini-chart does `transactions.filter(...)` **twice per day, for
  7 days** = 14 full scans of the entire `transactions` array on every dashboard render
  (`O(14 × 200,000)` ≈ 2.8M comparisons at the benchmark scale).
- This isn't gated: `renderDashboard()` re-runs on every `jobCards`/`invoices`/`customers`/`technicians`
  `onSnapshot` fire (`index.html:2655,2667,2675,2697`), i.e. after *any* write anywhere by any user.

**Root cause:** no memoized/pre-aggregated summary — every KPI is recomputed from raw arrays on demand.

**Fix:**
1. Server-side dashboard summary endpoint that does the aggregation in SQL (see §8, materialized
   summaries) instead of shipping raw rows to the browser to reduce.
2. Client-side: compute `activeTasksByTech` once per `jobCards` update (a single `O(jobCards)` pass
   building a map keyed by technicianId), not once per technician per render.
3. Debounce dashboard re-render (see P5) so a burst of writes doesn't trigger N full recomputes.

**Regression/load test:** seed 50k job cards / 20 technicians / 200k transactions (throwaway), measure
`renderDashboard()` wall time with `performance.now()`; assert < 100 ms budget, and assert it's
independent of technician count after the fix (currently `O(T)` multiplier).

**Risk if unfixed:** the landing screen — the one page every single user, every single login, sees first —
becomes the slowest page in the app as the business grows, which is exactly backwards.

---

### P5 — No debounce on live search; full-array filter + full-table innerHTML re-render on every keystroke
**Severity:** Medium-High
**Business impact:** typing in the Job Cards search box re-filters and re-renders the *entire* result
table on every keystroke with no debounce.

**Evidence:**
- `public/index.html:1176` — `<input id="jc-search" oninput="renderJobCards()">` (no debounce).
- `public/index.html:3393-3419` — `renderJobCards()` does `jobCards.filter(...)` over the full array,
  then `list.map(...)` building one `<tr>` per row, then a single `el.innerHTML = ...` replacing the
  whole table body — for every keystroke.

**Root cause:** no debounce utility exists anywhere in the codebase (confirmed by grep), and there's no
virtualized table component — every list view builds and injects a full HTML string for every visible row.

**Fix:**
```js
var jcSearchDebounced = debounce(renderJobCards, 150);
// <input ... oninput="jcSearchDebounced()">
function debounce(fn, ms){ var t; return function(){ clearTimeout(t); var a=arguments; t=setTimeout(function(){fn.apply(null,a);}, ms); }; }
```
Combine with server-side search (`GET /api/jobCards?q=...&limit=50`) once collections are paginated (P1),
so the browser is filtering a page, not 50,000 rows, per keystroke.

**Regression/load test:** seed 50k job cards; script 10 rapid keystrokes into `#jc-search`; assert
`renderJobCards` fires at most once (debounced) and completes in < 100 ms against a *paginated* result set.

**Risk if unfixed:** the job-card list — the screen a service advisor uses dozens of times a shift —
becomes the most visibly janky screen in the app as job-card count grows; typing itself starts to lag.

---

### P6 — Kanban board and job-card list render unbounded, never-archived history
**Severity:** High
**Business impact:** the Workshop kanban board (`renderWorkshop`, `index.html:3449-3459`) groups
`jobCards` into 5 columns including **`delivered`**, with no date filter and no cap. Delivered jobs never
leave the board — they just accumulate in that column forever.

**Evidence:** `WB_STAGES` (`index.html:3423-3429`) includes a `delivered` stage matched with no time
bound; `renderWorkshop()` renders `cards.map(wbCard).join('')` for the *entire* matching set, every time.
Similarly `renderJobCards()` (`index.html:3400-3419`) has an "All" filter that renders every job card
ever created as one `<table>` with no pagination — at 50,000 job cards that's 50,000 `<tr>` elements
built into one HTML string and assigned via `innerHTML` in one synchronous operation.

**Root cause:** no data lifecycle/archiving concept exists in the schema or UI — "closed" business
records (delivered job cards, paid invoices from years ago) are never distinguished from "live" ones at
the query level, only via a client-side status field that's still fetched and rendered every time.

**Fix:**
1. Workshop board should default to "active" statuses only (`pending`/`in_progress`/`completed`/
   `invoiced`) with `delivered` shown only via an explicit, date-bounded, paginated "Delivered" view —
   not as a permanent kanban column.
2. Job Cards list needs a default date-range filter (e.g. "last 90 days") plus pagination, matching how
   every real-world garage/ERP list screen works.
3. Server-side: `GET /api/jobCards?status=pending,in_progress,completed,invoiced&limit=200`.

**Regression/load test:** seed 100k delivered job cards (throwaway) + 50 active ones; assert Workshop
board render time and DOM node count depend only on the *active* count, not the historical total.

**Risk if unfixed:** the operational screens staff use all day (kanban, job list) become the *first*
screens to visibly break as the business accumulates history — ironically punishing the business for
staying in operation longer.

---

## 2. Indexes

`db.js:20-42` creates exactly 5 indexes: `job_cards(created_at)`, the `invoices(jobCardId)` unique
expression index, `invoices(created_at)`, `transactions(txn_date)`, `appointments(appt_date)`.

### P7 — Six of ten tables sort on an unindexed column — every list fetch forces a Sort node
**Severity:** Medium (High at scale)
**Evidence — compare `COLL` ordering (`server.js:38-49`) against the index list (`db.js:35-41`):**

| Table | `ORDER BY` used by `GET /api/:coll` | Index on that column? |
|---|---|---|
| customers | `created_at DESC NULLS LAST` | **No** |
| vehicles | `created_at DESC NULLS LAST` | **No** |
| job_cards | `created_at DESC NULLS LAST` | Yes (`idx_jobcards_created`) |
| invoices | `created_at DESC NULLS LAST` | Yes (`idx_invoices_created`) |
| transactions | `txn_date DESC NULLS LAST` | Yes (`idx_txn_date`) |
| fin_accounts | `created_at ASC NULLS LAST` | **No** |
| technicians | `name ASC NULLS LAST` | **No** |
| advisors | `name ASC NULLS LAST` | **No** |
| appointments | `appt_date ASC NULLS LAST` | Yes (`idx_appt_date`) |
| parts | `created_at DESC NULLS LAST` | **No** |

**Business impact:** every `GET /api/customers`, `/vehicles`, `/finAccounts`, `/technicians`, `/advisors`,
`/parts` (6 of 10 collections — and remember, every one of these is re-fetched in full after every
mutation, per P1) forces Postgres to `Seq Scan` + explicit `Sort` instead of walking an index in order.
At small row counts this is invisible; at 10k+ customers/vehicles/parts it's a real, avoidable CPU/IO cost
on Neon paid per every write-triggered refetch.

**Fix:**
```sql
CREATE INDEX IF NOT EXISTS idx_customers_created   ON customers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicles_created    ON vehicles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_finaccounts_created ON fin_accounts(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_technicians_name    ON technicians(name ASC);
CREATE INDEX IF NOT EXISTS idx_advisors_name       ON advisors(name ASC);
CREATE INDEX IF NOT EXISTS idx_parts_created       ON parts(created_at DESC);
```
Add these to `db.js`'s `SCHEMA` string (it already uses `CREATE INDEX IF NOT EXISTS`, so this is a
zero-downtime, idempotent addition on next deploy).

**Regression/load test:** `EXPLAIN (ANALYZE, BUFFERS) SELECT id, data FROM parts ORDER BY created_at DESC`
against a throwaway-seeded 20k-row table; assert plan uses `Index Scan`, not `Seq Scan` + `Sort`, after
the fix.

**Risk if unfixed:** slow, compounding query cost on 6 of 10 tables, worst on `parts` (already the
heaviest table per P2) and `customers`/`vehicles` (the tables that grow fastest — one row per customer
interaction, forever).

---

### P8 — JSONB has no field indexes; any future server-side filter/search will seq-scan
**Severity:** Medium (structural — blocks the fix for P1/P5)
**Business impact:** none of the app's actual query patterns (search by plate number, filter by
customer, filter by status, filter by date range within a field inside `data`) are index-backed, because
literally everything except the 5 extracted columns lives inside an un-indexed `jsonb` blob. This is
fine *today* because filtering happens client-side on the full fetched array — but that's exactly the
pattern P1/P5/P6 need to kill. The DB isn't ready to take over that filtering work yet.

**Evidence:** `db.js` schema has no `GIN` index on any `data` column; `server.js` never issues a
`WHERE data->>'x' = $1` query anywhere except the one-off `uq_invoices_jobcard` expression index.

**Fix — add targeted indexes for the filters the UI actually needs**, ahead of moving those filters
server-side (P1/P5/P6):
```sql
-- Job card status (kanban/list filters) + vehicle plate search
CREATE INDEX IF NOT EXISTS idx_jobcards_status ON job_cards ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_jobcards_veh    ON job_cards ((lower(data->>'vehicleReg')));
-- Invoice status (aged receivables / customer ledger) + customer linkage
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_invoices_cust   ON invoices ((data->>'customerId'));
-- Transactions by account (trial balance's per-account filter, see P9)
CREATE INDEX IF NOT EXISTS idx_txn_account     ON transactions ((data->>'accountId'));
-- General full-text-ish search fallback
CREATE INDEX IF NOT EXISTS idx_jobcards_gin ON job_cards USING gin (data jsonb_path_ops);
```
Expression (btree) indexes for the handful of fields that are actually filtered on beat a blanket `GIN`
index for this workload — cheaper to write, and the query patterns here are equality/prefix, not
arbitrary containment.

**Regression/load test:** same `EXPLAIN ANALYZE` pattern as P7, against `WHERE data->>'status' = 'pending'`
on a throwaway 50k-row `job_cards` table.

**Risk if unfixed:** P1/P5/P6's fixes (moving filtering server-side) will just move the seq-scan from the
browser to Neon instead of eliminating it — the DB needs these indexes *before* that migration, not after.

---

## 3. Numbering under load (`jobCards`/`invoices` sequence assignment)

### P9 — `MAX(seq)+1` under a global advisory lock: O(N) cost per create, serialized company-wide
**Severity:** Critical (the sharpest, most concrete throughput ceiling in the whole system)

**Evidence — `server.js:226-246`:**
```js
await client.query('SELECT pg_advisory_xact_lock($1)', [cfg.lock]);   // lock 1001 (jobCards) or 1002 (invoices)
...
const r = await client.query(
  `INSERT INTO seqs (coll, last)
   VALUES ($1, (SELECT COALESCE(MAX(seq),0) FROM ${cfg.table}) + 1)
   ON CONFLICT (coll) DO UPDATE
     SET last = GREATEST(seqs.last, (SELECT COALESCE(MAX(seq),0) FROM ${cfg.table})) + 1
   RETURNING last`,
  [req.params.coll]
);
```

**Root cause / Big-O reasoning:**
1. `pg_advisory_xact_lock(1001)` is a single, **global, non-partitioned** lock key for the *entire*
   `job_cards` table — every branch, every terminal, every technician creating a job card anywhere in
   the company waits on this **one** lock. (Same for `1002` / invoices.) This directly answers "lock
   contention": under the brief's own multi-branch scenario, N branches all creating job cards
   concurrently serialize to **one creator at a time, system-wide**, regardless of branch.
2. `SELECT COALESCE(MAX(seq),0) FROM job_cards` has **no index on `seq`** (confirmed: `db.js`'s index
   list has no `idx_jobcards_seq`/`idx_invoices_seq`). Postgres must `Seq Scan` the *entire table* to
   find the max on every single insert. This is `O(N)` work per create, and it happens **while holding
   the exclusive lock**, so it isn't just this insert that's slow — it's every other job-card creation
   in the company queued behind it.
3. Combined: throughput for job-card creation is not O(1) per create as the table grows — it degrades
   towards `O(N)` per create as `N` (existing job card count) grows, and it's fully serialized, so total
   company-wide job-card creation throughput approaches `1 / (scan time at current N)` creates/second.
   At 500,000 job cards, a multi-hundred-thousand-row sequential scan (even a fast one, tens of ms) run
   **on every single new job card, blocking every other branch**, turns "create job card" from an
   instant action into a queued, multi-branch-wide bottleneck during busy hours.

**Fix:**
1. Index `seq` so `MAX(seq)` is an index-only scan, not a table scan (cheap, immediate win):
   ```sql
   CREATE INDEX IF NOT EXISTS idx_jobcards_seq ON job_cards(seq);
   CREATE INDEX IF NOT EXISTS idx_invoices_seq ON invoices(seq);
   ```
2. Better: stop deriving the number from `MAX(data)` at all — `seqs.last` is already the authoritative
   monotonic counter (that's the whole point of the table's docstring: "so a deleted document's number
   is never reissued"). Drop the `MAX(seq)` subquery entirely and just do:
   ```sql
   INSERT INTO seqs (coll, last) VALUES ($1, 1)
   ON CONFLICT (coll) DO UPDATE SET last = seqs.last + 1
   RETURNING last
   ```
   This is `O(1)` regardless of table size — the `MAX(seq)` re-derivation only exists today as a
   defensive measure in case `seqs` and the table ever drift, which a correct, exclusively-locked
   `seqs`-only counter never should. (If drift protection is wanted, reconcile it in a one-off admin
   script, not on every hot-path insert.)
3. If cross-branch contention remains a problem after (2) (it likely won't — an `O(1)` UPDATE under an
   advisory lock is sub-millisecond), consider per-branch numbering sequences (`lock key = hash(branchId, collection)`)
   so branches stop serializing against each other entirely. Not needed unless (2) alone proves
   insufficient under real load testing.

**DB changes:** the two indexes above; optionally simplify the `INSERT ... SELECT COALESCE(MAX...)` query
per (2) once confidence in `seqs` integrity is established.

**Regression/load test:** seed `job_cards` to 500k rows (throwaway, deleted after), then time 100
sequential `POST /api/jobCards` calls; assert p50/p99 latency is flat vs. a 500-row baseline (currently
it will visibly grow with table size — that's the bug). Add a k6/autocannon script issuing concurrent
creates from N simulated "branches" and assert lock wait time doesn't compound with `N`.

**Risk if unfixed:** this is the one finding in the whole audit with a **hard, measurable, guaranteed**
failure mode — "create job card" (the single most frequent write in the entire app) gets provably slower
every single day the business operates, and during any moment of multi-branch concurrent load, every
branch queues behind the slowest one. This is the finding most likely to produce an actual support
ticket ("the system is slow at 9am") within the first 1-2 years, not a hypothetical 10-year-out risk.

---

## 4. Connection pool

### P10 — `pg.Pool({ max: 8 })`, no `connectionTimeoutMillis`, no pooler — hard ceiling on concurrent requests
**Severity:** High (grows with concurrent staff, not with data volume)

**Evidence:** `db.js:9-14`:
```js
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 8,
  idleTimeoutMillis: 30000,
});
```
No `connectionTimeoutMillis` is set, so a request that can't get a client from the pool **waits
indefinitely** rather than failing fast. `.env.example`'s `DATABASE_URL` template has no `-pooler`
hostname convention or PgBouncer parameters — nothing in the codebase indicates Neon's pooled endpoint
is in use; this is a direct-to-Postgres connection string.

**Reasoning at 500 / 1000 / 5000 concurrent users:**
- Every `POST`/`PUT`/`/pay`/`/adjust` request does `await pool.connect()` and holds that client for the
  full length of a multi-statement transaction (`BEGIN` ... several queries ... `COMMIT`). Every `GET`
  request also checks out a client via `pool.query()` internally. With `max: 8`, **only 8 database
  operations can be in flight at once**, system-wide, from this one Render instance.
- At even **modest** concurrency (a few dozen staff across branches clicking "save" within the same
  second — completely normal for open/close-of-day rushes), requests queue for a client. Because
  `connectionTimeoutMillis` is unset, they queue **without a timeout**, so Express's own request queue
  grows unbounded behind them.
- At 500 concurrent users, this isn't a "some requests are slow" problem — it's "everything past the
  first 8 in-flight requests forms a strict FIFO queue," and combined with P1 (every write triggers 1-2
  more full-collection GETs), each user-visible action can itself require 2-3 pool checkouts. Practical
  effect: response latency degrades in *steps* as concurrency crosses multiples of 8, and past a few
  hundred concurrent actions, Render's own request/idle timeout (proxy-level, typically tens of seconds
  on Render's free/starter tiers) will start returning `502`s before the queued request ever reaches Neon.
- At 1000-5000 concurrent users, the app has no chance — `max: 8` was clearly chosen for "a handful of
  garage staff on one branch," not "multi-branch, hundreds of concurrent sessions."
- **Neon-specific:** direct (non-pooled) Postgres connections on Neon have a compute-size-dependent cap
  well below what PgBouncer-pooled connections support (Neon's pooled endpoint, `-pooler` in the
  hostname, is designed for exactly this "many short-lived app connections" pattern and supports far
  higher concurrency by multiplexing many logical app connections over few physical Postgres backends).
  Nothing here indicates the pooled endpoint is used — this is worth confirming/fixing regardless of
  `max: 8`, because horizontally scaling Render instances (the obvious next step once one instance's `max:8`
  is the bottleneck) multiplies direct connections linearly and risks hitting Neon's compute-level cap.

**Fix:**
1. Set `connectionTimeoutMillis` (e.g. 5000) so pool exhaustion fails fast with a clear 503 instead of
   hanging requests indefinitely:
   ```js
   const pool = new Pool({
     connectionString: process.env.DATABASE_URL,
     ssl: { rejectUnauthorized: false },
     max: Number(process.env.PG_POOL_MAX) || 20,
     idleTimeoutMillis: 30000,
     connectionTimeoutMillis: 5000,
   });
   ```
2. Point `DATABASE_URL` at Neon's pooled (PgBouncer) endpoint for the app's normal traffic; reserve a
   direct connection string only for schema migrations / advisory-lock-heavy paths if PgBouncer's
   transaction-pooling mode conflicts with `pg_advisory_xact_lock` semantics (verify — PgBouncer
   transaction mode can break session-scoped advisory locks; `pg_advisory_xact_lock` is
   transaction-scoped so it should be fine, but confirm against Neon's specific PgBouncer config before
   flipping in production).
3. Raise `max` moderately (e.g. 20-30) once on the pooled endpoint, and treat "requests queued behind
   pool exhaustion" as a monitored metric (`pool.waitingCount`), not a silent hang.
4. Reduce the *number* of pool checkouts per user action by fixing P1 (fewer, smaller queries per write
   instead of full-collection refetches) — this matters more than raising `max`.

**DB changes:** none (Neon's pooler is a connection-routing feature, not a schema change) — just an
environment/connection-string change plus a Neon dashboard check that the pooled endpoint is enabled.

**Regression/load test:** k6/autocannon script simulating 50/200/1000 concurrent `POST /api/jobCards`;
assert p99 latency stays bounded and requests fail fast (503) rather than hang once the pool is saturated;
compare direct vs. pooled endpoint under the same load.

**Risk if unfixed:** this is the finding most sensitive to *concurrent users* rather than *data volume* —
it can bite well before 10 years of data accumulates, the first time enough staff across enough branches
are using the system at the same moment (e.g. Monday morning across an 8-branch chain).

---

## 5. Payments/stock atomic endpoints — cost of whole-document read-modify-write

Already covered in depth as P2 (`parts.movements[]`) and P3 (`invoices.payments[]`) above — both are
row-locked (`FOR UPDATE`) read-modify-write of an ever-growing JSONB document, so:
- **Correctness is fine** (the row lock genuinely prevents lost updates — this is the one place the app
  got concurrency *right*).
- **Cost is not** — `UPDATE parts SET data = $2` / `UPDATE invoices SET data = $2` serializes the entire
  document (including its full historical array) to JSON, transmits it, and rewrites it, every time,
  for a change that only conceptually adds one small record. The fix (P2/P3: move `movements`/`payments`
  to child tables) turns this into a genuine `O(1)` `INSERT` + small `UPDATE` instead of an `O(document
  size)` rewrite, and — because the row lock is held for less time — also reduces contention on hot
  parts/invoices (e.g. a popular consumable part everyone adjusts stock on, or a large corporate
  customer's invoice that gets touched by multiple cashiers).

---

## 6. Memory: unbounded client arrays, no pagination/virtualization anywhere

**Severity:** Critical (this is the finding that answers "where does the browser fall over")

**Evidence:** all 10 collections load into module-level `var`s (`public/index.html:2161`
`let customers=[],vehicles=[],jobCards=[],technicians=[],advisors=[],invoices=[];` plus
`transactions`/`finAccounts`/`appointments`/`parts` declared nearby) and stay resident in memory for the
life of the tab — nothing is ever evicted, windowed, or paged out. Every render function
(`renderJobCards`, `renderWorkshop`, `renderDashboard`, `buildCustAccData`, `renderTrialBalance`, etc.)
builds full HTML strings from these arrays and assigns them via `innerHTML`, so DOM node count also grows
unbounded with data volume — there is no virtualized list/table component anywhere in the 525 KB SPA.

**Concrete cost model** (stated assumptions shown — these are reasoned estimates, not measurements,
since no data was loaded into the live DB):

| Collection | Benchmark row count (per brief) | Est. avg doc size | Est. full-collection payload |
|---|---|---|---|
| job_cards | 50,000 | ~1.8 KB (works[] w/ 3-5 items) | ~90 MB |
| invoices | 10,000 | ~2.5 KB (items[] + payments[]) | ~25 MB |
| transactions | 200,000 | ~0.35 KB | ~70 MB |
| parts (incl. 500,000 movements) | ~1,000-2,000 parts | ~35-70 KB/part (250-500 movements) | ~35-140 MB |

Summed with the smaller collections (customers/vehicles/technicians/advisors/appointments), a cold
login at this scale plausibly transfers, parses, and renders **250-350+ MB of JSON** into the tab. Even
after gzip in transit (JSON compresses well, roughly 4-6x), the *parsed, in-memory* JS object graph and
the resulting DOM are still full-size — compression only helps the network hop, not the browser's
memory/CPU cost.

**Where it falls over, concretely:**
- **Render jank / "Page Unresponsive":** any table render building 10,000+ `<tr>` elements in one
  `innerHTML` assignment (job cards "All" filter at 50k rows; transactions-heavy reports at 200k) blocks
  the main thread for multiple seconds and produces DOM trees well past the practical few-thousand-node
  comfort zone for smooth scrolling/interaction on typical in-shop hardware (older desktops, budget
  tablets at a service counter).
- **Browser memory pressure / tab crash:** holding 250-350+ MB of live JS objects (arrays of arrays,
  duplicated across the parsed fetch response, the module-level array, and closures capturing them in
  render functions) is well within the range that causes tab discard/crash on memory-constrained devices,
  and is a meaningful fraction of a typical tab's practical ceiling even on capable desktops once you
  add the DOM and browser overhead on top.
- **Fetch/response time:** a `SELECT id, data FROM job_cards ORDER BY created_at DESC` returning 90 MB,
  with no `LIMIT`, run from Neon → Render → browser, adds real serialization/transfer time on every
  login and every write-triggered refresh (P1) — this is also where Render's own proxy timeout and
  Neon's data-transfer characteristics become relevant (see §7).
- **JSON.parse cost:** parsing tens-to-hundreds of MB of JSON is itself a blocking, single-threaded
  operation in the browser — this alone can visibly freeze the UI for a second-plus before any rendering
  even starts.

**Fix:** this is the client-side face of P1/P2/P3/P5/P6 — paginate every list fetch, virtualize every
table/kanban render (render only visible rows; a simple windowing approach is enough, a full library
like `react-window`'s vanilla-JS equivalent isn't required), and stop holding full collections in memory
— hold only "the current page" plus small, purpose-built summary objects for dashboard KPIs (computed
server-side, see §8).

**Regression/load test:** Playwright script that seeds 50k job cards (throwaway), logs in, and asserts
(a) `performance.memory` (or a proxy metric) stays under a fixed budget, (b) the job-card table's DOM
node count stays bounded regardless of collection size (i.e., pagination/virtualization is actually
capping render output), (c) time-to-interactive after login stays under a fixed budget (e.g. 2s) instead
of scaling with row count.

**Risk if unfixed:** this is the finding that most directly matches the brief's framing — "where does
the browser fall over" — and the answer is: well before Year 10, and for staff on the most
budget-constrained devices (which, realistically, is exactly the hardware a service-counter tablet or an
older office PC at a smaller branch will be), possibly well before Year 3-4.

---

## 7. Ten-year projection

**Scenario (stated assumptions):** a busy multi-branch garage chain, 8 branches, 30 job cards/day/branch,
operating 365 days/year for 10 years.

```
Job cards:     30/day/branch × 8 branches × 3,650 days  ≈  876,000
Invoices:      ~85% job-card→invoice conversion          ≈  745,000   (capped ≤ job cards by the
                                                                        uq_invoices_jobcard constraint)
Transactions:  ~2.2 per invoice (payments + splits)
               + standalone expense entries (~20% extra)  ≈  1,900,000 - 2,500,000
Stock movements (embedded, not counted as rows):
               ~3 issues/receipts per job card avg         ≈  2,600,000 movement objects, distributed
                                                                across parts.data->movements[] —
                                                                heavily-used consumable parts (oil,
                                                                filters, brake pads) could individually
                                                                accumulate tens of thousands of embedded
                                                                movement objects in ONE row's JSONB blob.
Customers/vehicles: roughly 1 new customer + 1.2 vehicles per ~3 job cards ≈ 290,000 / 350,000
```

This means **the brief's own benchmark scale (10k invoices / 50k job cards / 200k transactions / 500k
movements) is roughly the Year 2-3 state** of a chain this size, not the 10-year endpoint — the true
Year 10 numbers are **10-15x larger** across the board. Every finding above that's already "Critical" or
"High" at the benchmark scale is materially worse at the true 10-year scale.

**Concrete failure points, ordered by how early they hit:**

| # | Failure | Hits at (row count / time) | Why |
|---|---|---|---|
| 1 | Kanban board render jank (`delivered` column, P6) | **Year 1**, ~87,600 delivered cards already accumulated with zero archiving | No date bound on the `delivered` stage — day-one design flaw, not a scale-in problem |
| 2 | Job-card creation throughput degrades (P9) | **Year 1-2**, tens of thousands of job cards, first genuinely concurrent multi-branch morning rush | `MAX(seq)` seq-scan under a global lock — cost is O(N) per insert from day one, just small enough to not be *felt* until concurrency + N both rise |
| 3 | Dashboard render jank (P4) | **Year 2-3**, ~50k job cards / 200k transactions (benchmark scale) | Nested O(technicians × jobCards) scan + 14x full transactions scan, on every dashboard paint |
| 4 | Search-as-you-type lag (P5) | **Year 2-3**, same scale | No debounce, full re-render per keystroke |
| 5 | Stock-adjust full-collection refetch (P2) | **Year 3-4**, movements accumulate into the hundreds-of-thousands | Refetch cost tracks *total historical movements*, not current stock — grows daily |
| 6 | Login payload / fetch timeout risk (P1, §6) | **Year 4-6**, job_cards + transactions + parts collections cross ~100-200 MB combined | Render proxy timeout and Neon transfer time both become live risks, not just theoretical |
| 7 | Browser tab memory pressure / crash on constrained devices | **Year 5-8** on budget hardware, later on capable desktops | Full in-memory retention of every collection, no eviction |
| 8 | `/api/export` (admin backup) becomes impractical | **Year 6-8** | `server.js:410-421` builds the *entire* multi-table export as one in-memory JS object then `res.json()`s it — no streaming, no `LIMIT` — this is the same unbounded pattern applied to a backup endpoint; at GB-scale this risks OOMing the Node process itself, not just the browser |
| 9 | Neon egress/cost risk | **Ongoing, worsening every year** | Every write triggers 1-3 full-collection refetches (P1); egress volume scales with *usage frequency* far more than with data volume — this is a cost-growth risk independent of which specific row-count milestone is hit, and is worth checking against your specific Neon plan's data-transfer allowance now, before it becomes a surprise line item |

**Bottom line:** nothing in this architecture was built with a row-count ceiling in mind. The failure
mode isn't a single dramatic outage — it's a slow, compounding degradation across almost every screen,
starting with the screens staff use most (kanban board, job-card search, dashboard) within the first 1-3
years, well before the "10 years" horizon the brief asks about, and getting materially worse from there.

---

## 8. Caching / pagination / background jobs — what's needed

**Current state: none of these exist.** Confirmed by grep across `server.js`/`db.js`/`public/index.html`:
zero hits for `LIMIT`, `OFFSET`, `pagination`, `virtualiz`, `debounce`, and no cron/background-job runner
of any kind (`package.json` has exactly two dependencies: `express`, `pg` — no job queue, no cache layer).

**What's needed, concretely:**

1. **Server-side pagination + filtering** (underlies P1/P5/P6):
   `GET /api/:coll?limit=50&cursor=<created_at>&status=pending&q=search`. Requires the field indexes
   from P8 to be cheap. This is the single highest-leverage change in the whole audit — nearly every
   other finding in §1 is a symptom of its absence.

2. **Windowed queries for reports** (trial balance, aged receivables, cash flow, P&L — currently all
   client-side full-array scans, see `_accBal` at `index.html:6484-6490` scanning all `transactions` per
   account per report render): move these to server-side SQL aggregates —
   ```sql
   SELECT (data->>'accountId') AS account_id,
          SUM(CASE WHEN data->>'type'='income'  THEN (data->>'amount')::numeric ELSE 0 END) AS inc,
          SUM(CASE WHEN data->>'type'='expense' THEN (data->>'amount')::numeric ELSE 0 END) AS exp
   FROM transactions
   WHERE txn_date <= $1
   GROUP BY data->>'accountId';
   ```
   backed by `idx_txn_account` (P8) — turns an `O(accounts × transactions)` client-side scan into one
   indexed, grouped query.

3. **Materialized summaries for dashboards** — the dashboard's KPIs (open/in-progress/completed/invoiced
   counts, today's receipts/payments, 7-day chart) don't need to be recomputed from raw rows on every
   paint. A small `dashboard_daily_summary` table (or a Postgres materialized view refreshed on a
   schedule) pre-aggregates by branch/day:
   ```sql
   CREATE TABLE dashboard_daily_summary (
     branch_id text, day date,
     jc_pending int, jc_in_progress int, jc_completed int, jc_invoiced int,
     receipts numeric, payments numeric, invoiced_amount numeric,
     PRIMARY KEY (branch_id, day)
   );
   ```
   Updated incrementally on write (cheap `UPDATE ... SET x = x + 1`), or recomputed nightly — either way,
   `GET /api/dashboard` becomes a handful of indexed row reads instead of a multi-million-element client
   scan (P4).

4. **Move unbounded embedded arrays to their own tables** — `part_movements` (P2) and `invoice_payments`
   (P3) as specified above. This is the schema change with the single biggest long-term payoff, because
   these two arrays are the ones that grow *forever* with no natural cap, unlike job cards/invoices which
   at least grow at a predictable, bounded daily rate.

5. **Background jobs** — none exist today and none are strictly required for correctness, but two are
   worth adding once the app is at real multi-branch scale:
   - A nightly job to refresh `dashboard_daily_summary` (if using batch refresh instead of incremental).
   - A scheduled `/api/export` that streams to object storage instead of building the backup in one
     in-memory `res.json()` call (§7, failure #8) — trivial with `pg-copy-streams` or chunked `res.write()`
     instead of `res.json(out)`.

6. **Caching** — with server-side pagination in place, HTTP caching becomes viable for genuinely static
   or slow-changing data (technician list, chart-of-accounts, company settings) via `ETag`/`Cache-Control`
   on those specific endpoints; it's not a substitute for pagination on the high-write collections
   (job cards, invoices, transactions, parts), where the data is too fresh for caching to help much.

---

## 9. Scores

### Performance Score: **22 / 100**

The app performs adequately *today*, at its current (small) data volume — which is exactly why this
score is low rather than moderate: nothing about the current pleasant experience reflects the
architecture's actual headroom. Every list is unindexed for its own sort order on 6/10 tables (P7),
every write triggers full-collection refetches (P1-P3), the numbering scheme has a built-in O(N)
per-insert cost under a global lock (P9), the dashboard does multi-million-element scans on every paint
(P4), and there is not one instance of pagination, debouncing, or virtualization anywhere in a 525 KB SPA
(P5/P6/§6). Points awarded for: correct use of row locks for true concurrency safety on payments/stock
(P2/P3's *correctness*, if not their *cost*), sensible use of indexed extracted columns for the 4/10
tables that do have them, and money rounding discipline. Points lost heavily for: the complete absence
of any scale-bounding mechanism across the entire stack.

### Enterprise Scalability Score: **15 / 100**

This score specifically asks "does this survive 10 years, multi-branch, real usage" — and per §7, the
honest answer is that several screens visibly degrade within Year 1-3, not Year 10. The architecture has
no concept of: pagination, archiving/data lifecycle, materialized aggregates, connection pooling sized
for multi-branch concurrency (P10), or bounded embedded arrays (P2/P3). The numbering mechanism (P9) is
the single sharpest ceiling — it degrades under the exact conditions ("multi-branch, high volume") the
brief asks about, and does so via a global lock that actively punishes *more* branches with *more*
contention, which is the opposite of what "enterprise" should mean. Points awarded for: the schema is at
least normalized enough (separate tables per entity, proper foreign-key-shaped `id` references even
where not FK-constrained) that the fixes in this report are additive, not a rewrite — nothing here
requires re-architecting the data model, only extending it (new indexes, new child tables, pagination
parameters). That "the fix is additive, not a rewrite" is the main reason this isn't scored even lower.

---

## 10. Performance Optimisation Plan (ordered)

1. **Add the 6 missing sort-column indexes** (P7) — `db.js` `SCHEMA` string, one deploy, zero risk,
   immediate win on every list fetch for customers/vehicles/finAccounts/technicians/advisors/parts.
2. **Fix the numbering hot path** (P9) — add `idx_jobcards_seq`/`idx_invoices_seq`, then simplify the
   `INSERT ... SELECT MAX(seq)` query to rely purely on `seqs.last`. Highest-leverage single fix in the
   report relative to effort — turns the sharpest, earliest-hitting bottleneck into an O(1) operation.
3. **Add `connectionTimeoutMillis` to the pool + move to Neon's pooled endpoint** (P10) — config-only
   change, immediate protection against silent request pile-ups.
4. **Debounce the job-card search input** (P5) — a 10-line fix, immediately reduces render frequency
   under the current architecture even before pagination lands.
5. **Stop refetching full collections after single-document writes** (P1) — patch the client array in
   place using the server's response instead of calling `refreshColl`. This is the biggest behavioral
   change but doesn't require new endpoints — it's a `gms-backend.js`-only fix that immediately cuts
   write-triggered network/render cost from O(collection size) to O(1) for the common "I just edited one
   thing" case.
6. **Move `parts.movements[]` and `invoices.payments[]` into child tables** (P2/P3) — the two genuinely
   unbounded-forever arrays; this is the fix with the largest *long-term* (Year 3+) payoff.
7. **Add server-side pagination + filter params to `GET /api/:coll`** (§8.1) — the structural fix that
   makes every list screen (job cards, sales, inventory, customers) safe at any row count; pairs with
   the field indexes from P8.
8. **Bound and paginate the Workshop kanban board and Job Cards "All" list** (P6) — default to active
   statuses / recent date range; add pagination for the historical view.
9. **Server-side aggregates for dashboard KPIs and financial reports** (P4, §8.2-8.3) — trial balance,
   aged receivables, cash flow, and the dashboard's own numbers move from client-side full-array scans
   to indexed SQL aggregates / a materialized summary table.
10. **Stream `/api/export` instead of building it in memory** (§7 failure #8) — protects the Node process
    itself once total data volume reaches GB scale.

## 11. Database Optimisation Plan (ordered)

1. **Indexes — sort columns** (P7): `customers.created_at`, `vehicles.created_at`, `fin_accounts.created_at`,
   `technicians.name`, `advisors.name`, `parts.created_at`.
2. **Indexes — numbering** (P9): `job_cards.seq`, `invoices.seq`.
3. **Indexes — JSONB filter fields** (P8): `job_cards(status)`, `job_cards(lower(vehicleReg))`,
   `invoices(status)`, `invoices(customerId)`, `transactions(accountId)` — expression btree indexes
   sized to the app's actual filter patterns, not a blanket GIN index.
4. **Schema — `updated_at`** on every JSONB table, to support delta/incremental sync (needed for the
   performance-plan item 5/7 above — "what changed since ts" needs a queryable timestamp).
5. **Schema — extract `part_movements` table** (P2), backfill from existing `parts.data->movements`,
   then stop writing to the embedded array (keep reading it during a transition window only).
6. **Schema — extract `invoice_payments` table** (P3), same backfill-then-cutover approach.
7. **Schema — `dashboard_daily_summary` table** (§8.3), incrementally maintained or nightly-refreshed,
   to back the dashboard and financial reports without full-table scans.
8. **Connection routing — switch to Neon's pooled (PgBouncer) endpoint** (P10) for app traffic; verify
   `pg_advisory_xact_lock`'s transaction-scoped semantics behave correctly under PgBouncer's pooling mode
   before cutting over production traffic (test in staging first — this is the one item in this plan
   that needs verification against Neon's specific PgBouncer configuration, not just a code change).
9. **Numbering query simplification** (P9): drop the `MAX(seq)` subquery once `seqs` integrity is
   trusted (it already should be, given the exclusive advisory lock protecting every write to it).
10. **Data lifecycle** (supports P6): no schema change strictly required, but consider an explicit
    `archived_at` column (or reuse `status='delivered'` + a date filter) so the *query layer* — not just
    the UI — can cheaply exclude old-but-not-deleted records from "active" views as the historical table
    grows across years.

---

*This report reasons from static code analysis and row-count/Big-O projections; no load was written to
the live Neon database. Before implementing the load tests specified per-finding above, seed data in a
disposable branch/database (Neon supports branching for exactly this), never the production database
referenced in `.env`.*
