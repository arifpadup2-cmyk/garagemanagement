# Branch / Company Access — Design

**Status:** Design agreed, **not implemented**.
**Why this document exists:** branch scoping touches every list query in the
system. The failure mode is not a visible bug — it is one branch silently seeing
another's customers, stock and money. A half-scoped system, where some queries
filter and some do not, is more dangerous than an unscoped one, because it looks
safe. These decisions belong on paper before any code is written.

---

## 1. The four questions that must be answered first

### 1.1 What is scoped, and what is shared?

Three tiers, decided per collection:

| Tier | Behaviour | Collections |
|---|---|---|
| **Shared** | One copy for the whole company. Every branch reads the same rows. | `masters`, `services`, `roles`, `settings` |
| **Branch-owned** | Belongs to exactly one branch. Invisible to others. | `jobCards`, `estimates`, `invoices`, `creditNotes`, `purchaseOrders`, `purchaseRequests`, `rfqs`, `goodsReceipts`, `purchaseInvoices`, `purchaseReturns`, `stockTransfers`, `stockCounts`, `bankRecs`, `journalEntries`, `journalLines`, `stockMovements`, `reservations`, `toolIssues` |
| **Company-wide with a home branch** | Visible everywhere, but *belongs* somewhere for reporting. | `customers`, `vehicles`, `suppliers`, `parts`, `technicians`, `advisors`, `tools`, `warehouses`, `bays`, `finAccounts` |

The third tier is the one that needs judgement. A customer who visits two
branches must not become two customers — that splits their history and their
credit limit, which is exactly what Phase 4 set out to prevent. So customers,
vehicles and suppliers stay company-wide, carrying `homeBranchId` for reporting
only.

**Parts are the hard case.** The item *master* is company-wide — one part number,
one description, one cost basis. The *stock* is per branch. That means:

- `parts.stock` and `parts.costPrice` must move OUT of the part document into a
  per-branch balance, or every branch overwrites the others' quantity.
- Proposal: a `part_branch_stock` table keyed `(part_id, branch_id)` holding
  `stock`, `costPrice`, `reorderLevel`, `minStock`, `maxStock`, `location`.
- `stock_lots` already carries `warehouseId`; a warehouse belongs to a branch, so
  lots are scoped through their warehouse rather than needing their own column.

This is the single largest piece of work in the change and should be done and
verified on its own, before any query filtering is added.

### 1.2 What does a user with access to two branches see?

`users.branchIds` is an array. Three access shapes:

- **One branch** — everything is filtered to it, and the branch is implicit. No
  branch selector is shown.
- **Several branches** — a branch selector in the top bar sets the *working*
  branch. Documents are created against it. Lists show that branch only.
- **All branches** (`branchIds: []` meaning unrestricted, held by an owner) —
  the selector gains an "All branches" option. Lists show everything with a
  branch column. **Creating a document is still impossible without picking one**,
  because a document with no branch cannot be reported on.

Reports follow the selector, not the permission: an owner viewing one branch
sees that branch's P&L. "All branches" consolidates.

### 1.3 How does existing data get assigned?

Everything currently in the database belongs to one branch by definition — there
has only ever been one. Migration:

1. Create a default branch from the existing company settings.
2. Stamp `branchId` onto every branch-owned row, and `homeBranchId` onto every
   company-wide row, in one transaction.
3. Move `parts.stock`/`costPrice` into `part_branch_stock` for that branch.
4. Assign every existing user `branchIds: []` (unrestricted) so nobody is locked
   out by the migration itself.

The migration must be idempotent and must refuse to run twice, like
`migrateMovements()` and the opening-balance guard already do.

### 1.4 Is document numbering per branch?

**Yes, and this is not optional.** Two branches both issuing `INV-0001` makes
the number useless as a reference and breaks the one-invoice-per-job-card index.

- `seqs` becomes keyed `(coll, branch_id)`.
- `docNo()` takes a branch prefix: `MAIN/INV-0001`, `WKP/INV-0001`.
- `allocSeq()` locks per branch, so two branches never contend.
- The existing `uq_invoices_jobcard` index is unaffected (a job card belongs to
  one branch), but **every uniqueness index on a branch-owned collection must be
  re-examined** — supplier invoice numbers, for instance, are unique per
  supplier *per branch*, not globally.

---

## 2. Enforcement design

Scoping must be enforced in **one place**, not sprinkled through handlers — the
same reasoning that made `postJournal()` the only way into the ledger.

```
BRANCH_SCOPE = { collection -> 'shared' | 'owned' | 'home' }

GET  /api/:coll   → owned collections get "AND branch_id = $n" appended
                    unless the caller is unrestricted AND has selected "all"
POST /api/:coll   → owned collections are stamped with the working branch;
                    a request with no working branch is REFUSED
PUT  /api/:coll   → refuse if the row's branch differs from the working branch
DELETE            → same check as PUT
```

Add `branch_id` as an extracted column (not a JSONB field) on every branch-owned
table, so the filter is indexed.

**The test that matters** is not "does branch A see its own data" — it is
"create data in branch B, sign in as a branch-A-only user, and assert every list
endpoint returns nothing from B". That assertion should be written **per
collection**, generated from `BRANCH_SCOPE`, so a new collection added later
without scoping fails the suite rather than leaking quietly.

---

## 3. Order of work

1. `branches` table + migration creating the default branch and stamping rows.
2. `part_branch_stock` — move stock off the item master, verify valuation and
   the ledger still reconcile.
3. `branchIds` on users, branch selector, working-branch resolution.
4. Per-branch numbering.
5. Scope enforcement in the generic CRUD layer.
6. The generated cross-branch leak suite.
7. Reports: branch filter, and consolidation for unrestricted users.

Steps 1–2 are safe to ship alone. **Step 5 must not ship before step 6** — that
is the step where a mistake stops being visible.

---

## 4. What this changes elsewhere

- **Phase 7 ledger:** journals become branch-owned. A consolidated trial balance
  is the sum across branches; a per-branch one must still balance on its own,
  which means inter-branch transfers need a due-to/due-from account pair.
- **Phase 3 transfers:** a transfer between branches is no longer a simple
  two-leg stock move — it is a sale from one branch to another, or an
  inter-branch clearing entry.
- **Phase 9 permissions:** unchanged in shape. `branchIds` sits alongside the
  role; permission answers *what*, branch answers *where*.

The inter-branch ledger question is genuinely the hardest part and is not solved
by this document. It should be decided before step 5.

---

## 5. Step 2 cutover checklist — `part_branch_stock`

Derived by reading `server.js`, not by inference. Line numbers are as at commit
`eb78c81`.

### 5.1 Why a mirror table must NOT be created first

The obvious-looking safe increment — create `part_branch_stock`, backfill it, and
change nothing else — is **worse than doing nothing**. Fifteen paths write
`parts.stock` directly. A mirror that none of them update starts drifting on the
first goods receipt and becomes stale data that looks authoritative. The table
and the cutover have to land together.

### 5.2 Every path that WRITES stock or cost

| Line | Path | Writes |
|---|---|---|
| 1394–1397 | quick invoice — counter-sale deduction | `stock` |
| 1494–1500 | legacy `POST /purchaseOrders/:id/receive` | `stock`, `costPrice` (WAC) |
| 1617–1625 | goods receipt engine | `stock`, `costPrice` (WAC) |
| ~1821 | purchase-invoice posting — landed-cost re-costing | `costPrice` |
| 1971–1998 | purchase return | `stock` |
| — | `POST /parts/:id/adjust` | `stock` |
| — | job-card part issue | `stock` |
| — | job-card part return | `stock` |
| — | credit-note restock | `stock` |
| — | stock count posting | `stock` |

### 5.3 Every path that READS it

Reorder report · inventory valuation · `/parts/:id/availability` · opening
balances (stock at cost) · COGS on issue and its reversal · `deleteBlocker` for
parts · `validateDoc` min/max check · transfer availability · reservation
availability · sales analysis (indirectly, via cost).

### 5.4 Order for the cutover, and why

1. **Create the table and a `partStock(client, partId, branchId)` accessor that
   reads through to `parts.stock` when no branch row exists.** Read-through means
   every existing read keeps returning the right answer from the first commit.
2. **Convert the WRITE paths one at a time**, each with its own verification run.
   A write path converted while its reads still use `parts.stock` is the only
   genuinely dangerous window, so each conversion must land with its reads.
3. **Backfill** once all writers are converted, then drop the read-through.
4. **Remove `stock`/`costPrice` from the item master** only after a full cycle
   passes with the read-through disabled.

### 5.5 Invariants a test suite must assert

- Sum of `part_branch_stock.stock` for a part equals what `parts.stock` held
  before the migration, for every part.
- Weighted-average cost is computed **per branch**: receiving 10 @ 50 in branch A
  must not move branch B's cost.
- The Inventory ledger account equals the sum of (stock × cost) across all
  branches, after every posting.
- A goods receipt in branch A leaves branch B's quantity untouched.
- The full enterprise simulation still passes 23/23 after each step.

### 5.6 Open question this raises

Weighted-average cost becomes per branch, but the ledger has **one** Inventory
account. Either the account is per branch too (which needs the inter-branch
due-to/due-from pair from §4), or inventory value is consolidated while cost is
branch-local — and those two give different COGS for the same part sold in
different branches. **Decide this before writing step 2**, not during.

---

## 6. Known limit: connection pool under heavy contention

Found while testing the lock-ordering fixes, and **not fixed** — recorded so it
is not rediscovered as a surprise.

`db.js` sets `max: 8` with `connectionTimeoutMillis: 10000`. Each write holds a
connection for the whole of its transaction, including the time it spends
waiting on a row lock. Firing ~24 simultaneous writes that all contend on **one
part row** exhausts the pool: the requests queue, the 10-second connect timeout
expires, and callers see `timeout exceeded when trying to connect` — a 500, not
a deadlock.

At 12 concurrent writes on the same row it is comfortable. A garage will not
have twenty-four people issuing the same part at the same instant, so this is
not urgent — but it is the ceiling, and it will be reached sooner once branches
multiply the write traffic.

Options, roughly in order of value:
1. Raise `max` toward Neon's connection ceiling (check the plan's limit first;
   Neon pooled endpoints behave differently from direct ones).
2. Shorten lock hold time — take row locks as late in each transaction as
   possible, and allocate document numbers immediately before insert rather than
   at the top of the handler.
3. Return a clear 503 with a retry hint instead of a generic 500 when the pool
   times out, so the client can back off rather than surfacing "server error".
