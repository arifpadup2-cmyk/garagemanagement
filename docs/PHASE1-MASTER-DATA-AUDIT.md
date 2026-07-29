# Phase 1 — Master Data · ERP Audit & Remediation

**System:** VIWO Garage Management (Tecido)
**Scope:** Item Master · Service Master · Categories · Brands · Units of Measure · Tax Setup · Labour Types · Vehicle Makes · Vehicle Models · Fuel Types · Customer Groups · Supplier Groups
**Date:** 2026-07-29
**Status:** ✅ Remediated and verified — **score 98/100**

> Phase 1 only. Purchasing, inventory movement, workshop, billing, finance,
> reporting and security are explicitly **out of scope** and were not modified
> beyond the master-data links each one now reads.

---

## 1. Current Workflow

### 1.1 Before this phase

Master data did not exist as a concept. Every "list" in the system was either
typed free-hand on each transaction or hard-coded in the page markup.

| Entity | State before | Evidence |
|---|---|---|
| Item Master | Existed (`parts`) but weak | `#v-add-part` form |
| Service Master | **Absent** | labour typed per job card as `description` + `cost` |
| Categories | Free text + datalist of prior values | `pt-category` was an `<input list="pt-cat-list">` |
| Brands | Free text | `pt-brand` was an `<input>` |
| Units of Measure | **Absent** | part detail read `p.unit` which was **never written** |
| Tax Setup | Partial | single global `vatEnabled`/`vatRate` in Settings |
| Labour Types | **Absent** | — |
| Vehicle Makes | Free text | `v-make` was an `<input>` |
| Vehicle Models | Free text | `v-model` was an `<input>` |
| Fuel Types | Hard-coded 4 `<option>`s in markup | `<select id="v-fuel">` |
| Customer Groups | **Absent** | — |
| Supplier Groups | **Absent** | — |

The workflow was therefore: *operator types a value → value is stored as a
string on the transaction → nothing validates, reconciles or reuses it.*

### 1.2 After this phase

```
Master Data ─┬─ Setup Lists (10 controlled vocabularies)
             └─ Service Master (priced labour catalogue)
                        │
                        ▼
   ┌────────────────────┴─────────────────────┐
   │  every transactional form selects, not types  │
   └────────────────────┬─────────────────────┘
                        ▼
 Item Master · Vehicles · Customers · Suppliers · Job Cards · Estimates
```

Each transaction now stores **both** the master `…Id` (the durable link) and the
name snapshot (what the document said at the time). Sales documents in real ERPs
must not change retrospectively when someone renames a category — the snapshot
guarantees that, while the id keeps the record joined for reporting.

---

## 2. Business Analysis

A garage's master data is the vocabulary its whole P&L is expressed in. When it
is free text:

- **Reporting is impossible.** `Brakes`, `brakes`, `Brake ` and `Braks` are four
  categories. Any "revenue by category" report is fiction.
- **Pricing drifts.** Two advisors quote 250 and 400 for the same brake job
  because there is no catalogue — the customer notices before the owner does.
- **Stock cannot reconcile.** Without a unit of measure, 5 litres of oil and
  5 pieces of oil are the same number.
- **Purchasing has no leverage.** Without brands and supplier groups you cannot
  see that you buy the same filter from three vendors at three prices.
- **Data entry is slow and inconsistent**, which is what actually makes staff
  abandon an ERP.

Phase 1 converts the vocabulary from *typed* to *governed*.

---

## 3. Weaknesses Found (pre-remediation)

| # | Severity | Finding |
|---|---|---|
| W1 | **Critical** | No Service Master. Labour was retyped and repriced on every job card — the single largest source of pricing inconsistency and margin leakage. |
| W2 | **Critical** | Categories/brands free text → category-level reporting structurally impossible. |
| W3 | **Critical** | No Units of Measure. `parts.unit` was *read* by the part detail screen but never written by any form — it always displayed the hard-coded fallback `pcs`. |
| W4 | **High** | Vehicle make/model free text, unlinked. "Landcruiser", "Land Cruiser", "LC" are three vehicles to the system. No make→model relationship. |
| W5 | **High** | No duplicate protection anywhere: two parts could share a part number, two vehicles could share a plate, two suppliers could share a name. |
| W6 | **High** | Tax was one global rate. No tax code per item, so a mixed standard/exempt catalogue could not be represented. |
| W7 | **High** | Supplier on a part was a **typed name**, not a link to the suppliers register. Renaming a supplier orphaned every part. |
| W8 | **Medium** | Fuel types hard-coded in markup — LPG or CNG required a developer. |
| W9 | **Medium** | No customer or supplier segmentation → no fleet vs retail analysis, no vendor category spend. |
| W10 | **Medium** | No labour-type/skill banding → no basis for differential labour rates. |
| W11 | **Medium** | Item Master had no `active` flag, no min/max stock, no margin feedback at entry. |
| W12 | **Medium** | An item could be hard-deleted while holding stock or carrying movement history — destroying balance-sheet evidence. |
| W13 | **Low** | A second, hidden vehicle-creation form inside the job-card flow (`renderModalVehicleForm`) wrote free-text make/model, bypassing any control the main form imposed. |

---

## 4. ERP Standard Gaps — closed

| ERP standard | Status |
|---|---|
| Central master-data register with a single CRUD/permission/audit surface | ✅ `masters` collection, kind-discriminated |
| Coded master records (code + name) | ✅ optional code, unique per list, auto-upper-cased |
| Hierarchical masters (parent → child) | ✅ `vehicleModel.parentId → vehicleMake` |
| Active/inactive lifecycle instead of deletion | ✅ `active` flag; retiring an in-use value is blocked |
| Referential integrity on master values | ✅ `masterInUse()` blocks delete **and** deactivation |
| Uniqueness enforced by the database, not the UI | ✅ 5 unique indexes |
| Service/labour catalogue with standard hours × rate | ✅ Service Master with derived price + explicit override |
| Tax codes as master data | ✅ `taxCode` list with rate, assignable per item and per service |
| Unit of measure per item | ✅ `uom` list, written by the part form |
| Party segmentation (customer/supplier groups) | ✅ both |
| Master data seeded with sensible defaults | ✅ idempotent seeder, 154 entries + 24 services |
| Inline master creation from a transaction form | ✅ "+" on every picker |

**Deliberately deferred** (correctly belongs to a later phase, not a gap in Phase 1):
serialised/batch/expiry attributes on items (Phase 2 — purchasing), warehouse/bin
masters (Phase 3), item-level costing method (Phase 3), price lists and
customer-specific pricing (Phase 6).

---

## 5. UI/UX Improvements Delivered

1. **Master Data section** in the sidebar → *Service Master* and *Setup Lists*.
2. **Setup Lists hub** — 10 tiles grouped *Items & Services · Vehicles ·
   Partners*, each showing its live entry count, so an empty list is visible at a
   glance rather than discovered mid-transaction.
3. **Generic list screen** with search, an **In use** count per row, and status.
   The count is the honest preview of whether Delete will be offered.
4. **Entry dialog** reusing the app's own `.dlg-*` primitives, with inline
   validation, parent selector for hierarchical lists, and a rate field for tax
   codes.
5. **Inline "+" on every picker** — the escape hatch that stops a missing
   category from derailing a part being created. Returns to the field with the
   new value already selected, so the user never loses their place.
6. **Make → model cascade.** Choosing Nissan can only offer Nissan models; with
   no make chosen the model list is empty rather than showing everything.
7. **Live margin hint** on the part form, in red when selling below cost.
8. **Service picker on job-card and estimate lines**, showing the catalogue price
   in the option text and filling description + price on selection — while
   respecting anything already typed.
9. **Empty states** that name the next action with a concrete example.
10. `autocomplete="off"` on the short generic dialog fields, which the browser
    was otherwise pre-filling and making a "New" dialog look populated.
11. Retired values still render on records that already carry them (suffixed
    *(inactive)*), so editing an old record never silently re-points it.

---

## 6. Database Improvements

```sql
CREATE TABLE masters  (id text PRIMARY KEY, data jsonb NOT NULL,
                       kind text, name text, created_at bigint);
CREATE TABLE services (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);

CREATE INDEX idx_masters_kind     ON masters(kind, name);
CREATE INDEX idx_masters_parent   ON masters ((data->>'parentId'));
CREATE INDEX idx_services_created ON services(created_at DESC);
CREATE INDEX idx_services_cat     ON services ((data->>'categoryId'));
```

**Uniqueness (5 indexes, created non-fatally):**

| Index | Guarantees |
|---|---|
| `uq_masters_kind_name` | one value per (kind, parent, case-insensitive name) |
| `uq_masters_kind_code` | one code per list |
| `uq_services_code` | one service per code |
| `uq_parts_number` | one item per part number |
| `uq_parts_barcode` | one item per barcode |

These are created **outside** the main schema transaction, each in its own
`try/catch`. A database already holding duplicates logs precisely which list to
clean up and boots normally, instead of a failed `CREATE UNIQUE INDEX` taking the
server down. All five created cleanly on the live Neon database.

---

## 7. API Improvements

| Change | Effect |
|---|---|
| `masters` + `services` in the `COLL` registry | full CRUD via the existing shim, no client special-casing |
| `FILTERABLE.masters = ['kind','parentId']`, `services = ['categoryId','active']` | indexed server-side filtering |
| `TECH_READ` extended with `masters`, `services` | shop floor reads the catalogue; **writes remain admin-only (403)** |
| `sanitizeDoc()` for both collections | trims and collapses whitespace in names, upper-cases codes, rounds money, defaults `active` |
| Service price derived server-side | `price = hours × rate` unless `priceOverride` — the catalogue cannot quote a figure its own inputs don't support |
| `validateDoc()` on **POST and PUT** | unknown `kind` rejected; name required and ≤80 chars; parent must exist and be of the right kind; tax rate 0–100; no negative prices/hours; `minStock ≤ maxStock` |
| PUT re-validates the **merged** document | a partial patch cannot slip past a rule the whole document would fail |
| `masterInUse()` | blocks delete **and** deactivation of a referenced value |
| `deleteBlocker()` extended to `parts` | an item with stock, movement history, job-card issues or PO lines cannot be hard-deleted |
| Unique-violation (`23505`) mapped to **409** with a specific message | a race that beats the UI check still reads as a clear user error, not "server error" |

---

## 8. Validation Rules (enforced server-side)

**Masters** — kind ∈ 10 known lists · name required, ≤80 chars, trimmed,
whitespace-collapsed · unique per (kind, parent, lower(name)) · code optional,
upper-cased, unique per kind · `vehicleModel` requires a parent that exists and
is a `vehicleMake` · `taxCode` rate 0–100 · cannot deactivate or delete while in use.

**Services** — name required · unique name and code · hours ≥ 0 · rate ≥ 0 ·
price ≥ 0 · price derived unless overridden · cannot delete while used on a job
card or estimate.

**Parts** — name required · part number unique · barcode unique · cost ≥ 0 ·
selling ≥ 0 · `minStock ≤ maxStock` · cannot delete with stock, movement history,
job-card issues or PO lines.

**Vehicles** — make required (must be a master) · **plate unique** across the
register, enforced on both creation paths.

**Suppliers** — name unique.

---

## 9. Missing Features Added

| Feature | Detail |
|---|---|
| Service Master | 24 seeded services with standard hours × rate |
| 10 master lists | 154 seeded entries across all 10 lists |
| Make → model hierarchy | 15 makes, 84 models |
| Tax codes | Standard / Zero Rated / Exempt, all 0% (correct for Qatar today) |
| Inline master creation | "+" on every picker |
| Item Master fields | UoM, tax code, supplier **link**, min/max stock, active flag, live margin |
| Party segmentation | customer + supplier groups |
| Idempotent seeder | `node scripts/seed-masters.js` — safe to re-run, never overwrites |

---

## 10. Business Risks — before vs after

| Risk | Before | After |
|---|---|---|
| Revenue by category is unreportable | Certain | Removed — categories are ids |
| Same job quoted at different prices | Routine | Catalogue price defaults every line |
| Duplicate item numbers corrupt stock | Unprotected | DB-enforced unique |
| Two records for one vehicle split its history | Unprotected | Plate unique on both paths |
| Renaming a supplier orphans parts | Certain | Parts hold `supplierId` |
| Deleting a category blanks historical documents | Possible | Blocked; snapshots retained regardless |
| Deleting an item destroys stock/COGS evidence | Possible | Blocked |
| Adding a fuel type needs a developer | Yes | Self-service |

---

## 11. Test Cases — all executed against the live application

Headless Chrome (`playwright-core`, `channel: 'chrome'`) driving the real UI on
`localhost:3010`, against the live Neon database. Both suites are self-cleaning.

### Suite A — master data core
| # | Test | Result |
|---|---|---|
| A1 | Setup Lists hub renders all 10 tiles | ✅ |
| A2 | Opening a tile shows that list | ✅ |
| A3 | Create an entry; code upper-cased server-side | ✅ |
| A4 | Duplicate name in different casing rejected inline | ✅ |
| A5 | Service Master renders with KPIs | ✅ |
| A6 | Service price auto-derives (1.5 h × 80 = 120) | ✅ |

### Suite B — wired forms and guards
| # | Test | Result |
|---|---|---|
| B1 | 154 masters + 24 services reach the client | ✅ |
| B2 | Part form: category/brand/UoM/tax are master-backed `<select>`s | ✅ |
| B3 | Margin hint turns red when selling below cost | ✅ |
| B4 | Saved part stores `categoryId` **and** `category`/`unit` snapshots | ✅ |
| B5 | Duplicate part number blocked inline | ✅ |
| B6 | Model list empty until a make is chosen | ✅ |
| B7 | Toyota shows Land Cruiser, never Patrol; switching make drops stale model | ✅ |
| B8 | Fuel type master-backed | ✅ |
| B9 | Customer group picker populated | ✅ |
| B10 | Supplier group picker populated | ✅ |
| B11 | Job-card work line offers the catalogue | ✅ |
| B12 | Picking "Wheel Alignment" fills description and 70.00, links `serviceId` | ✅ |
| B13 | Estimate line offers the catalogue | ✅ |
| B14 | In-use category cannot be deleted (409) | ✅ |
| B15 | Part with stock/movements cannot be deleted | ✅ |

**Console errors across both suites: zero.**

---

## 12. Regression Tests

| Area | Check | Result |
|---|---|---|
| Existing parts | Records without `categoryId` still list and open | ✅ name snapshots unchanged |
| Existing vehicles | Records with free-text make/model still display | ✅ display reads the snapshot |
| Inventory category filter | Still filters (reads `category` name) | ✅ unchanged |
| Job-card technician select | Still restores after adding the service column | ✅ index corrected 0 → 1 |
| Invoice totals | Untouched by this phase | ✅ no change to `sanitizeDoc('invoices')` |
| Seeder | Re-run adds nothing | ✅ `0 added, 154 already present` |
| Schema boot | Restart applies cleanly | ✅ `Schema ready.`, no uniqueness warnings |

---

## 13. ERP Compliance Score — 98/100

| Dimension | Weight | Score |
|---|---|---|
| Master-data coverage (12/12 entities) | 20 | 20 |
| Data integrity (uniqueness, FK guards, lifecycle) | 20 | 20 |
| API correctness (validation on both write paths, RBAC, 409s) | 15 | 15 |
| Database design (indexes, non-fatal constraint creation) | 15 | 15 |
| UI/UX (hub, cascade, inline add, empty states, a11y) | 15 | 14 |
| Reporting readiness (ids everywhere, snapshots retained) | 10 | 10 |
| Seed & operability (idempotent defaults) | 5 | 4 |
| **Total** | **100** | **98** |

**The 2 points not awarded**

- **UI (−1)** — the Setup Lists screens have no bulk import. A garage migrating
  from an existing system will want CSV import of makes/models and the service
  catalogue. Worth doing, but it is a migration tool rather than a master-data
  correctness gap.
- **Operability (−1)** — the seeder must be run from a shell. An admin-facing
  "Load standard workshop defaults" button in Settings would remove the last
  developer dependency from Phase 1.

Both are additive and neither blocks Phase 2.

---

## 14. Phase 2 Handover — Supplier & Purchasing

Ready to build on:

- `suppliers` now carries `groupId`/`group`.
- `parts` now carries `supplierId` (a real link), `uomId`, `taxCodeId`,
  `minStock`, `maxStock`, `active`.
- `masters` accepts new kinds by adding one entry to `MD_KINDS` (client) and one
  to `MASTER_KINDS` (server) — the CRUD, permissions, audit and uniqueness come free.

Phase 2 will need to add: purchase requests, RFQ, landed cost, and batch/expiry/
serial attributes on items. Item-level batch and serial tracking should be added
as **item flags** (`trackBatch`, `trackSerial`, `trackExpiry`) on the Item Master
before the GRN work begins.
