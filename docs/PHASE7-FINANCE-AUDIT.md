# Phase 7 — Finance & Accounting · ERP Audit & Remediation

**System:** VIWO Garage Management (Tecido)
**Scope:** Chart of Accounts · Journal Entries · Cash · Bank · Receivables · Payables · VAT · General Ledger · Trial Balance · Profit & Loss · Balance Sheet
**Date:** 2026-07-29

---

## 1. The Finding

There was **no general ledger**. The trial balance, P&L and balance sheet were
*derived in the browser* from invoices and cash transactions by helper functions
(`arBalanceAsAt`, `accrualRevenue`, `openingBalanceEquity`).

That approach cannot balance, and not because of a bug. **Selling stock relieved
no inventory and recorded no cost of sales.** Goods left the shelf and nothing in
the books said so. An `Opening Balance Equity` plug had been added to absorb the
resulting gap — a symptom, not a fix.

Three earlier phases deferred work here, all for the same reason:
- Phase 2: purchase returns credited no payable.
- Phase 3: inventory and COGS were not posted as journals.
- Phase 6: credit notes posted no reversing entry.

---

## 2. What Was Built

### The ledger
```sql
CREATE TABLE journal_entries (id, data jsonb, seq, entry_date, created_at);
CREATE TABLE journal_lines   (id, entry_id, account_id, debit, credit, entry_date, data);
```

`postJournal()` is the only path into it, and it **refuses to write an entry
whose debits and credits differ**. That single check is what makes the trial
balance an arithmetic certainty rather than a hope: an unbalanced business event
throws, and its whole transaction rolls back rather than being half-recorded.

`journalEntries` is in `DEDICATED_WRITE`, so nothing can be posted through
generic CRUD.

### System accounts
Thirteen accounts resolved **by role, not by name** (`ar`, `ap`, `cash`, `bank`,
`inventory`, `grni`, `sales`, `cogs`, `vatOut`, `vatIn`, `discount`, `adjust`,
`opening`), auto-created on first use and cached. A garage can rename any of
them without breaking a posting.

### Postings wired

| Event | Journal |
|---|---|
| Goods receipt | Dr Inventory · Cr **GRNI** |
| Purchase invoice posted | Dr GRNI · Dr Inventory (landed) · Dr Input VAT · Cr Payables |
| Supplier payment | Dr Payables · Cr Cash/Bank |
| Purchase return | Dr Payables · Cr Inventory |
| Sales invoice | Dr Receivables · Cr Sales · Dr Discount · Cr Output VAT · **Dr COGS · Cr Inventory** |
| Customer payment | Dr Cash/Bank · Cr Receivables |
| Credit note | Dr Sales · Dr Output VAT · Cr Receivables (+ Dr Inventory · Cr COGS if restocked, + refund legs) |
| Stock count variance | Dr/Cr Inventory · Cr/Dr Stock Adjustments |

**GRNI** (Goods Received Not Invoiced) is the account that makes purchasing
honest: receiving goods creates the liability immediately, and the supplier
invoice merely converts it. Without it, stock arrives owned by nobody.

### Statements read from the ledger
`GET /api/reports/trial-balance`, `/pl`, `/balance-sheet` are all `SUM` over
`journal_lines`. Each returns a `balanced` flag and the exact `difference`, so
the reports cannot silently disagree with the books.

---

## 3. Test Cases — a full purchase-to-sale cycle

| # | Test | Result |
|---|---|---|
| 1 | Ledger balances at baseline | ✅ |
| 2 | Approve PO, receive 10 filters at 50 → Inventory Dr 500, TB balanced | ✅ |
| 3 | Post supplier invoice and pay it → **GRNI cleared to zero**, TB balanced | ✅ |
| 4 | Invoice 4 filters at 100 → **Sales Cr 400 and COGS Dr 200** (gross margin 200), TB balanced | ✅ |
| 5 | Collect 400 → receivable relieved, TB balanced | ✅ |
| 6 | Credit 1 filter with restock → **COGS falls by 50**, TB balanced | ✅ |
| 7 | Stock count shortage → posts to Stock Adjustments expense, TB balanced | ✅ |
| 8 | **BALANCE SHEET balances**: assets = liabilities + equity | ✅ |
| 9 | P&L reports the margin the cycle produced | ✅ |
| 10 | **An unbalanced journal cannot be written** through generic CRUD | ✅ |

---

## 4. Remaining Work

1. **The client statements still use the old derived helpers.** The ledger-backed
   endpoints exist and are proven; repointing the Trial Balance, P&L and Balance
   Sheet screens at them is the next step.
2. **Opening balances.** A garage migrating in needs an opening journal; the
   `opening` equity account exists for it but there is no import screen.
3. **Bank reconciliation** — statement import and matching.
4. **Period close** beyond the existing date lock: no year-end roll-forward of
   retained earnings into equity yet.
