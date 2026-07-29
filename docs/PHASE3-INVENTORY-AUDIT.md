# Phase 3 — Inventory & Warehouse · ERP Audit & Remediation

**System:** VIWO Garage Management (Tecido)
**Scope:** Stock Movement · Stock Adjustment · Warehouse · Bin Locations · Transfers · Reserved Stock · Reorder Levels · Physical Stock Count · Tool Inventory
**Date:** 2026-07-29

---

## 1. Current Workflow

### 1.1 Before this phase

Stock was a single number on the item document, with its history kept as a JSON
array inside the same document. There was one location (implicitly "the
garage"), no concept of stock being promised to a job, and no way to count the
shelf against the system.

```
parts.stock  ──  a number
parts.movements[]  ──  an array, rewritten in full on every change
```

### 1.2 After this phase

```
Warehouse ──▶ Bin
    │
    ▼
parts.stock (running balance)
    ▲
    └── stock_movements  ── the ledger that explains the balance
             ▲
   ┌─────────┼──────────┬────────────┬───────────┬──────────┐
  GRN     Adjustment  Issue to job  Transfer  Stock count  Return

Reservations ── stock promised to a job card but not yet moved
Tools ── equipment issued to technicians and returned
```

---

## 2. Business Analysis

Three problems, each with a concrete cost:

- **The embedded movement array was a scale wall.** Every issue rewrote the item's
  entire history. A fast-moving oil filter received 500 times carried 500 records
  that were re-read and re-written on every single transaction. It also made
  "what moved yesterday?" impossible without loading the whole catalogue into the
  browser.
- **No reserved stock.** Two advisors could both plan around the last alternator.
  The second discovered the problem with a car already stripped — the most
  expensive moment to find out.
- **No physical count.** Shrinkage, miscounts and unrecorded usage accumulated
  silently with no mechanism to reconcile the shelf against the system.

---

## 3. Weaknesses Found (pre-remediation)

| # | Severity | Finding |
|---|---|---|
| I1 | **Critical** | Movements embedded in the item document — write amplification proportional to history length, and no cross-item queries. |
| I2 | **Critical** | No reserved-stock concept. Job cards competed for the same physical unit with no protection. |
| I3 | **High** | No warehouse or bin master. `location` was a free-text string on the item, so stock could not be found or counted by place. |
| I4 | **High** | No physical stock count and therefore no shrinkage control at all. |
| I5 | **High** | No stock transfer — moving stock to a van or a second store was invisible. |
| I6 | **Medium** | Reorder levels existed as fields but nothing consumed them. No reorder report, and no awareness of stock already on order. |
| I7 | **Medium** | No tool inventory — workshop equipment lent to technicians was untracked. |
| I8 | **Medium** | Movements carried no source document reference, so a stock change could not be traced back to what caused it. |

### Found during the build (and fixed)

| # | Finding | Resolution |
|---|---|---|
| R1 | `gmsApi.adjustStock` refreshed `parts` but not the new ledger, so the movement list stayed stale after an adjustment until reload. Caught by the verification suite. | Every stock-changing shim method now refreshes `stockMovements` (8 call sites). |
| R2 | The reorder report's SQL referenced `l.data` on a `jsonb_array_elements` alias, which is the JSONB element itself, not a row — a 500 on every call. | Rewritten with an explicit `AS t(li)` alias, computing outstanding-on-order in a single expression. |

---

## 4. ERP Standard Gaps — closed

| ERP standard | Status |
|---|---|
| Stock movement ledger separate from the item record | ✅ `stock_movements`, indexed `(part_id, at DESC)` |
| Every movement carries its source document | ✅ `refType` + `refId` + `refNo` |
| Multi-warehouse | ✅ `warehouses` with type, code, keeper |
| Bin locations within a warehouse | ✅ `bins`, unique code per warehouse |
| Inter-location transfer, both legs recorded | ✅ `stock_transfers` — out-leg and in-leg, on-hand total unchanged |
| Reserved / committed stock | ✅ `reservations`, enforced on issue and transfer |
| Available = on hand − reserved | ✅ everywhere it matters |
| Physical count, blind, with variance posting | ✅ `stock_counts` |
| Reorder report aware of stock on order | ✅ `GET /api/reports/reorder` |
| Tool/asset issue and return | ✅ `tools` + `tool_issues` |
| Lot visibility ordered for FEFO | ✅ `GET /api/parts/:id/availability` returns lots expiry-first |

**Deferred:** automatic FIFO/FEFO *consumption* at issue time (the ordering is
exposed, the picking policy is not yet enforced); per-lot valuation; cycle-count
scheduling; barcode-driven counting.

---

## 5. Database Improvements

```sql
CREATE TABLE stock_movements (id, data jsonb, part_id, at);   -- the ledger
CREATE TABLE warehouses      (id, data jsonb, created_at);
CREATE TABLE bins            (id, data jsonb, warehouse_id, created_at);
CREATE TABLE stock_transfers (id, data jsonb, seq, created_at);
CREATE TABLE stock_counts    (id, data jsonb, seq, created_at);
CREATE TABLE reservations    (id, data jsonb, part_id, created_at);
CREATE TABLE tools           (id, data jsonb, created_at);
CREATE TABLE tool_issues     (id, data jsonb, tool_id, created_at);
```

17 new indexes. Three new unique constraints: warehouse code, bin code per
warehouse, tool code.

**Migration.** `migrateMovements()` lifts the embedded arrays into the ledger at
boot. It is idempotent (marks each item `movementsMigrated`), transactional per
item, and deliberately leaves the original arrays in place so an older cached
client keeps rendering. On the live database it migrated 9 movements across 6
items. The part detail screen reads the ledger and falls back to the array.

---

## 6. API Improvements

| Endpoint | Behaviour |
|---|---|
| `postMovement()` | One helper, called inside the caller's transaction, used by every stock-changing path: receipt, return, adjustment, job-card issue, transfer, count. |
| `POST /api/stockTransfers` | Validates the whole transfer first; refuses to move stock reserved for job cards; writes an out-leg and an in-leg so the ledger reconciles per location; moves the lot's location so batch traceability survives. |
| `POST /api/stockCounts` | Reads the system figure **under lock at posting time**, not whatever the counter's screen showed when they started — otherwise a sale during the count is written off as shrinkage. Can be saved as a draft for review. |
| `POST /api/reservations/reserve` | Refuses to promise stock that is already promised. |
| `POST /api/jobCards/:id/parts` | Now nets off stock reserved for *other* job cards before allowing an issue. |
| `GET /api/reports/reorder` | Computes on-hand, reserved, on-order and a suggested quantity server-side; skips items whose incoming stock already covers the shortfall. |
| `GET /api/parts/:id/availability` | On hand, reserved, available, and lots ordered expiry-first then oldest-first. |
| `POST /api/tools/:id/issue` / `toolIssues/:id/return` | One open issue per tool; a damaged return takes the tool out of service. |

`DEDICATED_WRITE` extended to `stockMovements`, `stockTransfers`, `stockCounts` —
ledger records cannot be created or edited through generic CRUD.

---

## 7. Validation Rules

**Transfer** — source ≠ destination · quantity > 0 · cannot exceed on-hand minus
reserved · items must exist.

**Count** — system figure read under lock · variance value computed at item cost
· period lock respected · posting corrects stock and writes one ledger row per
variance.

**Reservation** — cannot exceed on hand minus what is already reserved · release
is explicit.

**Issue to job card** — cannot exceed on hand minus reservations held by *other*
job cards.

**Tool** — one open issue at a time · returning a damaged tool marks it
out of service.

---

## 8. Test Cases — executed against the live application

| # | Test | Result |
|---|---|---|
| 1 | Two warehouses + item with 20 in stock | ✅ |
| 2 | An adjustment lands in the ledger with the right balance and `refType` | ✅ |
| 3 | Reserve 20 of 25 → 5 free | ✅ |
| 4 | **Reserving another 10 refused** (only 5 free) | ✅ |
| 5 | **Transferring 25 refused** (20 reserved) | ✅ |
| 6 | Transfer 5 writes **both legs**; on-hand total unchanged | ✅ |
| 7 | Count 22 against system 25 → −3 variance, −750 value, stock corrected, one ledger row | ✅ |
| 8 | Reorder report: free 2 (22 − 20 reserved), suggests 28 to reach max 30 | ✅ |
| 9 | Tool issued; **second issue refused**; return puts it back in service | ✅ |
| 10–15 | All six new screens render cleanly | ✅ |

---

## 9. Remaining Work

1. **FIFO/FEFO is exposed but not enforced.** Availability returns lots in the
   right order; consumption does not yet decrement specific lots automatically.
2. **Per-lot valuation.** Costing remains weighted-average at item level.
3. **Cycle counting.** Counts are ad-hoc; no scheduled rotation by category or
   value band.
4. **Bin-level balances.** Movements carry a bin, but there is no per-bin
   quantity view yet.
