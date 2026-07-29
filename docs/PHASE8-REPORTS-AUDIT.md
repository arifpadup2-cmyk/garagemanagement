# Phase 8 — Reports & Analytics · ERP Audit & Remediation

**System:** VIWO Garage Management (Tecido)
**Scope:** Operational · Workshop · Inventory · Purchase · Sales · Finance reports · KPI dashboards · Management reports — accuracy, filters, export, performance
**Date:** 2026-07-29

---

## 1. Findings

| # | Severity | Finding |
|---|---|---|
| R1 | **Critical** | The Trial Balance, P&L and Balance Sheet screens still rendered from the **old derived helpers** (`arBalanceAsAt`, `accrualRevenue`, `openingBalanceEquity`) even after Phase 7 built the ledger. The books and the reports were two different answers. |
| R2 | **High** | Reports aggregated **in the browser** over whole collections. Slow, and the answer differed per device depending on what had finished loading. |
| R3 | **High** | No inventory valuation report at all — the largest single asset on the balance sheet had no supporting schedule. |
| R4 | **High** | Sales reports showed revenue but never cost, so "margin" was selling price minus an estimate rather than the real figure. |
| R5 | **Medium** | No general-ledger extract with an opening balance — a period extract was a floating list of numbers. |
| R6 | **Medium** | No workshop throughput or turnaround measurement. |
| R7 | **Medium** | No CSV export from the new reports. |

### Found during the build — and it was a real design flaw

| # | Finding | Resolution |
|---|---|---|
| **R8** | **Cost of sales posted at invoicing, but stock physically leaves when a part is issued to a job card.** Between issue and invoice — which for a workshop is the whole duration of the job — ledger inventory and the quantity on the shelf disagreed. The valuation report and the balance sheet would reconcile only for jobs that happened to be invoiced the same day. | COGS now posts **where the goods actually move**: on `POST /jobCards/:id/parts` (Dr COGS, Cr Inventory) and reversed on part return. The sales journal no longer touches inventory. Ledger inventory now tracks real stock at every moment. |

R8 is the kind of thing that only shows up when a report is asked to agree with
the ledger. The trial balance balanced perfectly *both* ways — it was internally
consistent and still wrong about when cost was incurred.

---

## 2. What Was Built

### Statements repointed at the ledger
Trial Balance, P&L and Balance Sheet now call `/api/reports/trial-balance`,
`/pl` and `/balance-sheet` — all `SUM` over `journal_lines`. Each screen shows an
explicit **✓ In balance** or **⚠ Out by X**, so a discrepancy is visible rather
than silently absorbed.

### General ledger extract — `/api/reports/ledger`
Opening balance, every posting in the window with a running balance, and a
closing balance that must equal the last running figure.

### Inventory valuation — `/api/reports/inventory-valuation`
Value by item and by category, share of total, and a **negative stock** count —
the number that says the ledger is about to be wrong.

### Sales summary — `/api/reports/sales-summary`
Gross, tax, discounts, credits, net revenue, collected, outstanding, and
**cost of sales read from the ledger**, so gross margin and margin % are the
real ones. Daily revenue bars and top customers.

### Workshop performance — `/api/reports/workshop`
Job cards by status, labour value, QC failures, technician output, and
**average turnaround measured check-in to delivery** — the number a customer
actually feels.

### Export
CSV export on valuation, daily sales and technician output, quoted correctly for
commas, quotes and newlines.

---

## 3. Test Cases

| # | Test | Result |
|---|---|---|
| 1 | Buy 10 @ 40, issue 5 to a job card, invoice 5 @ 120 | ✅ |
| 2 | Trial balance screen renders from the ledger and reports **in balance** | ✅ |
| 3 | Balance sheet screen reports **balanced** | ✅ |
| 4 | P&L screen renders a net profit/loss for a period | ✅ |
| 5 | Inventory valuation values the remaining **5 units at 40 = 200** | ✅ |
| 6 | Sales summary takes COGS from the ledger; margin = revenue − COGS | ✅ |
| 7 | Workshop report aggregates in Postgres | ✅ |
| 8 | General ledger extract carries an opening balance and a running balance that ends at the closing figure | ✅ |
| 9–11 | All three new screens render cleanly | ✅ |
| 12 | CSV export produces rows | ✅ |

---

## 4. Remaining Work

1. **The older report screens** (Sales Reports, Job Card Reports, Customer
   Reports, Technician Reports) still aggregate client-side. They work; they
   should move to server aggregation for consistency and scale.
2. **Scheduled/emailed management reports** — nothing runs on a timer.
3. **Dashboard KPIs** still read loaded collections rather than the new endpoints.
4. **Charting** is a hand-rolled bar strip; a proper axis and tooltip layer would
   make the daily revenue view readable at a glance.
