# Accounting, Tax & Data-Integrity Audit — Tecido Garage Management

**Date:** 2026-07-26
**Auditor role:** Chartered accountant + VAT expert + data-integrity/QA lead
**Scope:** `server.js`, `db.js`, `public/index.html`, `public/gms-backend.js` — money, tax and
data-correctness only (UI/UX and feature-completeness are covered separately in
`docs/ERP-AUDIT-2026-07-26.md`, which this report cross-references but does not duplicate).
**Method:** full read of the four files above (no assumptions), plus live verification against the
dev server at `http://localhost:3010` using throwaway records created via the REST API and deleted
immediately after each test (final DB state confirmed clean — see "Live tests performed" below).

---

## Verdict in one paragraph

The three fixes shipped today are real and independently verified: server-side atomic payments
(`POST /api/invoices/:id/pay`) correctly caps at the outstanding balance including the 0.005
tolerance, correctly resolves the classic `33.33+33.33+33.34` float-dust problem, and correctly
blocks negative stock. But those fixes patch two specific write paths; they do not touch the much
larger surface that was already broken and is **still** broken: there is no general ledger — a
`transactions` row's `accountId` is, in every single code path in the file, restricted to a cash or
bank account, so income, expense, AR, liability and equity accounts can never receive a posting.
The Trial Balance is therefore not "sometimes out of balance" — it is *structurally incapable* of
balancing except in the trivial zero-activity case, and the amount it is out of balance by is always
exactly the sum of all cash/bank account balances. The Balance Sheet mixes an accrual Accounts
Receivable figure with cash-basis Retained Earnings and will not balance whenever any invoice is
outstanding. VAT is computed correctly at invoice creation but is never posted to the VAT Payable
account, so the general ledger permanently understates the business's real tax liability by the
full amount collected. Inventory has a working quantity ledger (movements, no negative stock) but
zero costing discipline — no WAC/FIFO, mutable last-cost, no COGS, no link to job cards or invoices
at all — so gross margin is completely unmeasured. Most seriously for an audit that was asked not to
take fixes on trust: the generic `PUT /api/:coll/:id` route was proven live to accept an invoice
`total`, `status` and `totalPaid` with **no relationship to the invoice's own line items or payment
history whatsoever** (demonstrated: items summing to 20 stored against a total of 5,000; status
forced to `paid` with `totalPaid: 999999`), and Quick Invoice's "pay now" flow — the primary
point-of-sale path — still writes the invoice and its cash-book entry as two independent,
non-atomic REST calls, exactly the class of bug the new `/pay` endpoint was built to eliminate
elsewhere.

---

## Live tests performed (and cleaned up)

All records below were created via the REST API against the running dev server, verified, then
deleted; the database was confirmed back at its original row counts (`customers:6 vehicles:6
jobCards:6 invoices:3 transactions:7`) at the end of the session. No production data was altered.

| # | Test | Result |
|---|------|--------|
| 1 | Split-pay an invoice in `33.33 + 33.33 + 33.34` across two `/pay` calls | Reached `totalPaid: 100`, `status: "paid"` exactly — **rounding fix verified correct** |
| 2 | Pay 60 against a 50.00 invoice via `/pay` | `400 Payment exceeds outstanding balance — 50.00 due.` — **overpay block verified** |
| 3 | Pay 50.01 against a 50.00 invoice via `/pay` (tests the 0.005 tolerance edge) | `400`, correctly rejected — **tolerance verified** |
| 4 | Pay 0.01 against an already-`paid` (0 due) invoice via `/pay` | `400 … 0.00 due.` — **verified** |
| 5 | `POST /api/parts/:id/adjust` to withdraw 10 units from a 5-unit part | `400 Insufficient stock — only 5 on hand.` — **negative-stock block verified** |
| 6 | Withdraw exactly the remaining stock, then withdraw 1 more from 0 | Second call `400` — **verified** |
| 7 | Create two invoices against the same `jobCardId` | Second call `409 An invoice already exists for this job card.` — **unique index verified** |
| 8 | `PUT /api/invoices/:id` with `{total:999999, status:"paid", totalPaid:999999}` on an invoice whose real total is 20 | **Accepted with `200 OK`, values stored verbatim** — see Finding **INV-1** |
| 9 | `POST /api/invoices` with `items` summing to 20 but `subtotal:20, total:5000` | **Accepted with `200 OK`, stored verbatim** — see Finding **INV-2** |
| 10 | `DELETE /api/customers/:id` on a customer with a live vehicle + invoice still pointing at it | **Succeeded (`200`)**, vehicle and invoice rows survived with a dangling `customerId` — see Finding **DI-1** |

---

# 1. Double-entry integrity

### DE-1 — Every transaction posts to a cash/bank leg only; income/expense/AR/liability/equity accounts never receive a posting

**Module:** Accounts / Chart of Accounts / General Ledger
**Severity:** Critical

**Business impact:** The Chart of Accounts, General Ledger, Trial Balance, Profit & Loss (by
account) and Balance Sheet are not derived from a real ledger. The "double entry" fields
(`debitAccountId`/`creditAccountId`) are written but never read by any balance calculation; only
`accountId` is read, and `accountId` is, in every write path, hard-restricted to a cash or bank
account.

**Root cause / evidence:**
- `updateTxnAccountOptions()` (`public/index.html:5638-5653`) populates the account `<select>`
  purely from `TXN_METHOD_ACC_TYPE` (`:5636`, `{cash:'cash',bank_transfer:'bank',card:'bank',
  cheque:'bank'}`) filtered to `finAccounts` of type `cash`/`bank` — an expense or income account can
  never be chosen here.
- Every single place a `transactions` document is built sets `accountId` to the cash/bank leg only:
  - `buildInvoiceTxnDoc()` — `accountId:drAcc?drAcc.id:''` (`:5112`), where `drAcc =
    findDefaultAccount(method)` (`:5095-5098`) is filtered to `TXN_METHOD_ACC_TYPE[method]`, i.e.
    cash or bank.
  - `saveTransaction()` — `accountId:accountId` (`:5875`), taken straight from the `#txn-account`
    `<select>` populated by `updateTxnAccountOptions()` above.
  - `saveGlEntry()` (the General Ledger "+ Receipt"/"+ Payment" modal) — `accountId:cashAcc?
    cashAcc.id:''` (`:6458`), where `cashAcc=isReceipt?drAcc:crAcc` and `drAcc`/`crAcc` for a receipt
    are the cash/bank side and the AR/income/other side respectively (`updateGleAccounts()`,
    `:6382-6401`) — `accountId` is *always* assigned the cash/bank one.
  - A repo-wide `grep -n "accountId:"` returns exactly these three sites — there is no fourth path.
- `_accBal(acc, upTo)` (`:6484-6490`), the single function every statement (`renderTrialBalance`,
  `renderBalanceSheet`, `renderGlAccounts`) uses to compute an account's balance, filters
  `transactions` by `t.accountId===acc.id`. Since `accountId` is never anything but a cash/bank
  account, `_accBal()` returns `0` (plus any manually-typed opening balance) for every income,
  expense, liability, equity and non-AR asset account, for the entire life of the business.

**Reconciliation (illustrative, using the app's own default Chart of Accounts and formulas):**
Suppose one invoice for QAR 1,000 is raised and paid in full by cash, and the business has the
default seeded accounts (`Cash Drawer`, `Labour Revenue`, `Accounts Receivable`, …).
- `buildInvoiceTxnDoc` writes one `transactions` row: `type:'income', amount:1000,
  accountId:<Cash Drawer id>` (the `debitAccountId`/`creditAccountId` fields are also written but,
  per DE-1, are never read).
- `_accBal(<Cash Drawer>)` = `0 (opening) + 1000 (income, this accountId) − 0 = 1000` → Trial Balance
  Debit column shows `1,000.00`.
- `_accBal(<Labour Revenue>)` = `0` (no transaction row has `accountId` equal to Labour Revenue's
  id — none ever will). Trial Balance Credit column shows `—`.
- `_accBal(<Accounts Receivable>)` = `0` for the same reason (see **DE-3** below for why the
  AR safety-net that exists elsewhere in the file does not rescue the Trial Balance here).
- **Total Debit = 1,000.00, Total Credit = 0.00 → "Out of balance by 1,000.00."**

This generalises: because every posting lands on the Dr side of a cash/bank account and nothing
ever lands on a Cr side, **Total Debit − Total Credit on the Trial Balance is, at all times,
exactly equal to Σ(balance of every cash + bank account)** — i.e. the Trial Balance's own
"out of balance" banner (`:6531-6534`) will report a number equal to the business's entire cash
position, every single day, for every tenant that has ever recorded a cash sale.

**Recommended fix:** Introduce a real posting engine. On invoice creation, post
`Dr Accounts Receivable / Cr Revenue (+ Cr VAT Payable)` for the full invoice value; on `/pay`,
post `Dr Cash/Bank / Cr Accounts Receivable`. Concretely: change `_accBal` to sum **both** legs
(`t.debitAccountId===acc.id ? +amount : 0` and `t.creditAccountId===acc.id ? -amount : 0`, or
equivalent), and make `server.js`'s `POST /api/invoices` and `POST /api/invoices/:id/pay` write a
second, structural ledger table (see DB changes) rather than relying on the client to describe a
"transaction" only for the cash leg.

```js
// server.js — sketch: write a real double-entry ledger row alongside the invoice.
// New table: CREATE TABLE ledger_entries (id text PRIMARY KEY, invoice_id text,
//   debit_account_id text NOT NULL, credit_account_id text NOT NULL,
//   amount numeric(12,2) NOT NULL, entry_date date NOT NULL, memo text, created_at bigint);
async function postInvoiceToLedger(client, inv, arAccountId, revenueAccountId, vatPayableAccountId) {
  await client.query(
    `INSERT INTO ledger_entries (id, invoice_id, debit_account_id, credit_account_id, amount, entry_date, memo, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [crypto.randomUUID(), inv.id, arAccountId, revenueAccountId, inv.subtotal, todayISO(), 'Invoice ' + inv.id, Date.now()]
  );
  if (inv.taxAmount > 0) {
    await client.query(
      `INSERT INTO ledger_entries (id, invoice_id, debit_account_id, credit_account_id, amount, entry_date, memo, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [crypto.randomUUID(), inv.id, arAccountId, vatPayableAccountId, inv.taxAmount, todayISO(), 'VAT on invoice ' + inv.id, Date.now()]
    );
  }
}
```

**DB changes:** New `ledger_entries` table (double-sided, immutable, append-only); `fin_accounts`
should gain well-known role columns (`role: 'ar' | 'revenue' | 'vat_payable' | 'cash_default' |
'bank_default'`) so the server — not the client — can resolve which account to post to.

**Regression test:** After posting one QAR 1,000 fully-paid invoice with VAT off, assert
`SELECT SUM(amount) FROM ledger_entries WHERE debit_account_id=<AR>` equals
`SELECT SUM(amount) FROM ledger_entries WHERE credit_account_id=<Revenue>`, and assert the Trial
Balance's `totalDr === totalCr` to the cent.

**Risk if unfixed:** Every financial statement in the product (Trial Balance, Balance Sheet, P&L by
account, General Ledger by account) is decorative. Any user who checks "does this balance"
receives, with certainty, "no," on every business day with any cash activity — this is a
show-stopper for any real bookkeeping use of the module, and would fail a statutory audit instantly.

---

### DE-2 — Nothing is posted to the GL at invoicing time; revenue/AR exist only as re-derived reads of the `invoices` table

**Module:** Invoicing / General Ledger
**Severity:** Critical

**Business impact:** There is no immutable, point-in-time record of "revenue was earned on this
date for this amount." Every statement that needs revenue or AR (P&L via `transactions`, Balance
Sheet AR, Aged Receivables, Customer Accounts) re-scans the *current, live, mutable* `invoices`
table on every render. If an invoice is edited or deleted later (see **DI-1**–**DI-3**), every
historical statement retroactively changes — there is no way to know what last month's P&L or AR
"actually was" at month-end, because there is no ledger row that recorded it at the time.

**Root cause / evidence:** `convertToInvoice()` (`:4857-4883`) and `saveQuickInvoice()`
(`:4816-4854`) call `db.collection('invoices').add(data)` and nothing else touches the accounting
layer — no `transactions` row, no ledger row, is written for the revenue/AR side (only, optionally,
for the cash side if a payment is taken at the same time — see **CC-2**). `server.js`'s
`POST /api/invoices` (`:214-267`) performs zero accounting side-effects; it is a plain
upsert-by-id into the `invoices` JSONB table.

**Recommended fix:** Same as DE-1 — post a `Dr AR / Cr Revenue(+VAT Payable)` ledger row inside the
same DB transaction that creates the invoice, in `server.js`'s `POST /api/:coll` handler when
`req.params.coll === 'invoices'` (or a dedicated `POST /api/invoices` route split out from the
generic upsert, which would also let it validate line-item totals — see **INV-2**).

**DB changes:** Same `ledger_entries` table as DE-1.

**Regression test:** Create an invoice, then independently delete it from `invoices` (simulating a
future edit/void); assert the ledger's revenue/AR rows for that invoice are unaffected until an
explicit reversing/credit-note entry is posted.

**Risk if unfixed:** No period can ever be closed with confidence; "what were April's real sales"
has no fixed answer.

---

### DE-3 — Trial Balance's Accounts-Receivable safety net is silently disabled in the default configuration

**Module:** Trial Balance
**Severity:** High

**Business impact:** In the *default* Chart of Accounts (the one the app ships with a
"seed defaults" button for, `FIN_DEFAULT_ACCOUNTS`, `:5392-5427`, which includes an
`Accounts Receivable` asset account), the Trial Balance's real-AR fallback never fires, so every
outstanding customer invoice is silently invisible to the Trial Balance — not merely under-counted,
literally zero.

**Root cause / evidence:** `renderTrialBalance()` (`:6514-6527`):
```js
var hasARAccount=finAccounts.some(function(a){return a.name==='Accounts Receivable'&&a.isActive!==false;});
if(!hasARAccount){
  var arBal = /* … real balance computed from unpaid invoices … */;
  if(arBal>0){ rows.splice(2,0,{name:'Accounts Receivable',...}); totalDr+=arBal; }
}
```
The invoice-derived AR figure is only computed **`if(!hasARAccount)`** — i.e. only when the tenant
has *not* set up an `Accounts Receivable` ledger account. As soon as one exists (the default,
recommended state — and the state the currently-running dev tenant does *not* happen to be in,
since its live Chart of Accounts only has two seeded accounts, `Cash in Hand` and
`QNB Current Account`, but any tenant that clicks "seed defaults" will hit this), the code falls
through to the normal per-account loop, which calls `_accBal(<AR account>, asAt)` — and per **DE-1**,
that always returns `0`, because no transaction's `accountId` is ever the AR account. The real
outstanding-AR figure is simply dropped.

Contrast with `renderBalanceSheet()` (`:6648-6650`), which uses a *different, more defensive*
condition — `arAccBal>0?arAccBal:arBal` — that falls back to the real invoice-derived figure
whenever the account-based balance happens to be zero, regardless of whether the account exists.
This is why the Balance Sheet's AR line is (for now, given DE-1) usually right while the Trial
Balance's is usually wrong — a second, independent bug on top of DE-1, caused by the two reports
using two different existence-tests for the same fallback.

**Recommended fix:** Make the Trial Balance use the same `>0` condition as the Balance Sheet, and —
properly — fix this at the root via DE-1 so neither fallback is needed.

```js
// public/index.html — renderTrialBalance(), replace the hasARAccount gate:
var arAcc = finAccounts.find(function(a){return a.name==='Accounts Receivable'&&a.isActive!==false;});
var arAccBal = arAcc ? _accBal(arAcc, asAt) : 0;
if (arAccBal <= 0) {           // matches renderBalanceSheet()'s fallback condition
  var arBal = /* same invoice-derived calc */;
  if (arBal > 0) { rows.splice(2,0,{name:'Accounts Receivable',type:'Asset',dr:arBal,cr:0}); totalDr += arBal; }
}
```

**DB changes:** None (pending DE-1).

**Regression test:** Seed the default Chart of Accounts (which includes `Accounts Receivable`),
create one unpaid QAR 500 invoice, open Trial Balance — assert an `Accounts Receivable` row with
`Dr 500.00` is present.

**Risk if unfixed:** Any tenant who follows the product's own "seed default accounts" onboarding
flow gets a strictly worse (more wrong) Trial Balance than one who never sets up a Chart of
Accounts at all.

---

# 2. Accounting basis mismatch

### AB-1 — Profit & Loss is pure cash-basis, computed over `transactions`, not accrual revenue

**Module:** Profit & Loss
**Severity:** High

**Business impact:** "Revenue" on the P&L (`renderPLStatement()`, `:6567-6617`) is
`incTxns.reduce(...)` over `transactions` where `type==='income'` and `t.date` falls in range — i.e.
cash actually received in the period (including non-sales cash like "Advance Payment" and
"Other Income" categories, `:5429`), not revenue earned. A large invoice raised on the last day of
the month and collected the following month contributes **zero** to this month's P&L and the full
amount to next month's, regardless of when the work was actually performed and delivered.

**Root cause / evidence:** `:6574-6588` filters `transactions` (not `invoices`) by `t.date`, sums
`type==='income'` vs `type==='expense'`, and calls the difference "Net Profit." There is no
accrual adjustment anywhere in the file (no unbilled-revenue accrual, no unpaid-invoice add-back).

**Recommended fix:** Either (a) clearly relabel the report "Cash Flow Statement — Receipts vs.
Payments" (it already duplicates `showCashFlow()` almost exactly) rather than "Profit & Loss," or
(b) build a real accrual P&L off the ledger from DE-1 (`Dr AR/Cr Revenue` postings, dated at
invoice date, independent of when cash is collected).

**DB changes:** Depends on DE-1's `ledger_entries` table.

**Regression test:** Raise an invoice on 30 June, collect payment on 2 July. A correct accrual P&L
for June must show the revenue; the current implementation shows QAR 0 for June and the full amount
for July — assert this gap is closed.

**Risk if unfixed:** Management is making margin/profitability decisions off a number that is
timing-shifted by however long customers take to pay — for a workshop running credit terms, this
can be a multi-week to multi-month distortion.

---

### AB-2 — Balance Sheet mixes accrual AR with cash-basis Retained Earnings; will not balance whenever AR > 0

**Module:** Balance Sheet
**Severity:** Critical

**Business impact:** The single most visible promise a balance sheet makes — "Assets = Liabilities
+ Equity" — is broken by construction, not by data entry error, any time there is an unpaid invoice
on the books. The report's own "out of balance" banner (`:6707-6712`) will fire continuously in
normal operation.

**Root cause / evidence:** `renderBalanceSheet()` (`:6627-6718`):
- `totalAR` (asset side) = sum of `(invoice.total − paid-to-date)` for every `unpaid`/`partial`/
  `credit` invoice as at the report date (`:6642-6650`) — **accrual**: it counts revenue the moment
  it's invoiced, before cash changes hands.
- `retainedEarnings` (equity side) = `allIncome − allExpense` summed over `transactions`
  (`:6660-6662`) — **cash-basis**: it only counts revenue once cash is actually received.
- `check = totalAssets − (totalLiabilities + totalEquity)` (`:6665`).

**Worked reconciliation (concrete numbers, using the app's own formulas):**
Take one invoice: QAR 1,000, VAT off, raised today, **unpaid**. No other activity, all opening
balances zero.
- `totalAR` = 1,000 (the invoice counts immediately, per the accrual filter above).
- `cashTotal`/`bankTotal` = 0 (no cash transaction was ever created — nothing was collected).
- `totalAssets` = 0 + 0 + 0(fixed) + 1,000 = **1,000**.
- `retainedEarnings` = `allIncome(0) − allExpense(0)` = **0**, because the P&L/equity side only
  recognises income when a `transactions` row exists, and none does until money is collected.
- `totalLiabilities + totalEquity` = 0 + 0 = **0**.
- `check = 1,000 − 0 = 1,000` → **"Difference of 1,000.00 — check opening balances and transaction
  postings."**

The balance sheet is out of balance by *precisely the invoice's own value*, for every single unpaid
invoice, always, by design — this is not an edge case, it is the normal state of the report for any
workshop that does not collect 100% of every invoice at the point of sale.

**Recommended fix:** Once DE-1's ledger exists, retained earnings must be computed from the same
accrual ledger as AR (`Σ Revenue credits − Σ Expense debits`, both recognised at invoice/bill date,
not cash date). Until the ledger exists, a stop-gap that at least makes the two sides consistent is
to compute a matching accrual "Net Income" figure for the equity side using the *same* invoice-based
method already used for `totalAR`, rather than `transactions`:

```js
// public/index.html — renderBalanceSheet(), stop-gap accrual retained earnings
// (until a real ledger exists per DE-1):
var accruedRevenue = invoices.filter(function(iv){return tsToDs(iv.createdAt)<=asAt;})
  .reduce(function(s,iv){return s+Number(iv.subtotal!=null?iv.subtotal:iv.total);},0);
var cashExpenses = transactions.filter(function(t){return t.type==='expense'&&t.date<=asAt;})
  .reduce(function(s,t){return s+Number(t.amount||0);},0);
var retainedEarnings = accruedRevenue - cashExpenses; // still imperfect (expenses stay cash-basis) but AR now ties out
```
This is a stated stop-gap, not a real fix — a mixed-basis statement can never be made fully correct
without a real ledger; it merely stops the *guaranteed* imbalance for the common all-revenue case.

**DB changes:** Depends on DE-1.

**Regression test:** Raise one QAR 1,000 unpaid invoice with zero other activity; assert
`|totalAssets − (totalLiabilities+totalEquity)| < 0.01` after the fix (currently fails by exactly
1,000.00, reproduced by the worked example above and confirmed against the live code, not just
inspection).

**Risk if unfixed:** No lender, tax authority or investor can be shown this Balance Sheet — it
fails its own internal consistency check in the ordinary course of business, not just in
misconfiguration.

---

# 3. VAT correctness

### VAT-1 — VAT Payable is never posted anywhere; the general ledger permanently understates the tax liability by the full amount collected

**Module:** VAT / Chart of Accounts
**Severity:** High

**Business impact:** `FIN_DEFAULT_ACCOUNTS` seeds a `VAT Payable` liability account
(`:5422`, `"Value Added Tax collected and payable"`), and the VAT Summary report
(`renderVatSummary()`, `:5603-5634`) correctly totals output tax month by month straight from
`invoices[].taxAmount`. But that figure never reaches the Chart of Accounts: per **DE-1**, no
`transactions` row's `accountId` is ever the VAT Payable account, so `_accBal(<VAT Payable>)` is
permanently `0`. A business owner who only trusts the Balance Sheet / Trial Balance (the normal
place to check "what do I owe the tax authority") will see QAR 0 owed, always, no matter how much
VAT has actually been collected from customers and is sitting, unremitted, in the bank.

**Root cause / evidence:** Same universal restriction as DE-1: `buildInvoiceTxnDoc()`
(`:5100-5124`) posts only `Dr Cash/Bank` / `Cr Accounts Receivable` for the **total** payment
amount — it does not split the payment into its net-sales and VAT components, and no code path ever
references the `VAT Payable` account id at all (confirmed by the same `grep -n "accountId:"`
result cited in DE-1 — three sites, none touch VAT Payable).

**Recommended fix:** As part of the DE-1 ledger, split every invoice posting into
`Dr AR / Cr Revenue` (net of tax) and `Dr AR / Cr VAT Payable` (the tax portion) — sketch already
shown in DE-1's `postInvoiceToLedger`. On remittance to the tax authority, a manual/scheduled
`Dr VAT Payable / Cr Bank` entry clears it.

**DB changes:** Same `ledger_entries` table as DE-1, plus a `role:'vat_payable'` marker on the
relevant `fin_accounts` row so the server can resolve it without relying on a name match.

**Regression test:** Enable VAT at 5%, raise a QAR 1,000 (net) invoice (→ 1,050 gross), collect it
in full; assert Trial Balance's `VAT Payable` row shows `Cr 50.00`, matching VAT Summary's figure
for the same period.

**Risk if unfixed:** A business could genuinely misjudge how much cash is actually theirs to spend
versus owed to the state — VAT collected is customer money held in trust, and the books currently
show none of it as a liability.

---

### VAT-2 — A TRN-headed invoice with VAT switched off prints no VAT line at all, which is non-compliant presentation wherever a TRN implies a mandatory tax invoice

**Module:** Invoice printing / Settings
**Severity:** Medium (compliance-dependent — see caveat)

**Business impact:** Settings lets an operator save a `VAT / TRN Number` (`:1973`) completely
independently of the `Charge VAT on invoices` toggle (`:2011-2013`). If a business enters its TRN
(e.g. in anticipation of registration, or because it operates across a UAE/KSA entity as well as a
Qatar one) but leaves the toggle off, every invoice prints the TRN in the header (`:4961`,
`companySettings.vatNumber` shown whenever set) but the VAT breakdown block is only rendered
`iv.taxAmount>0` (`:4989-4991`) — so the invoice displays a registered tax number with **no VAT
rate, no VAT amount, and no subtotal/VAT split at all**, rather than an explicit "VAT: 0.00" or an
exemption/zero-rated statement. Under GCC VAT executive regulations (UAE FTA, KSA ZATCA), a tax
invoice issued under a TRN is required to show the tax rate and tax amount (even if nil, with a
reason) — silently omitting the block, rather than showing zero with a reason, does not meet that
bar.

**Root cause / evidence:** `invTaxTotals()` (`:4586-4594`) returns `taxAmount:0` whenever
`!companySettings.vatEnabled`, and the print template's conditional at `:4989`
(`iv.taxAmount>0?…VAT block…:''`) means the block simply vanishes rather than rendering a nil-rate
statement. There is no validation anywhere that a `vatNumber` and `vatEnabled:false` cannot coexist.

*Caveat:* Qatar (the tenant currently configured — `companySettings.country:"Doha"/"Qatar"`) had no
live VAT law as of this audit, so this is presently dormant risk for this specific tenant; it
becomes live the moment (a) Qatar's GCC VAT framework activates, or (b) the software is used by a
UAE/KSA-registered business, which the generic "VAT Rate (%)" + "VAT/TRN Number" fields suggest is
an intended use case.

**Recommended fix:** Either block saving a `vatNumber` while `vatEnabled` is false (with a clear
explanatory toast), or — safer, since a TRN may legitimately be entered ahead of activation — always
render the VAT block once a TRN is present, showing `VAT (0%): 0.00` explicitly rather than omitting
it.

```js
// public/index.html — renderInvoiceDetail(), around :4989
(companySettings.vatNumber || iv.taxAmount>0 ?
  '<div class="inv-total-row"><span>Subtotal</span><span>'+fmtMoney(iv.subtotal!=null?iv.subtotal:(iv.total-iv.taxAmount))+'</span></div>'+
  '<div class="inv-total-row"><span>VAT ('+(iv.taxRate||0)+'%)</span><span>'+fmtMoney(iv.taxAmount||0)+'</span></div>' : '')+
```

**DB changes:** None.

**Regression test:** Set a TRN with VAT toggle off, print/preview an invoice; assert the VAT line
renders showing `0%` / `0.00` rather than being absent.

**Risk if unfixed:** Invoices that look like formal tax invoices (branded with a TRN) but omit the
statutorily-required tax breakdown, in any jurisdiction where that combination is regulated.

---

### VAT-3 — No multi-rate, zero-rated or exempt-item support; VAT is a single flat percentage applied to the whole invoice subtotal

**Module:** VAT engine
**Severity:** Medium (architectural gap, not a bug)

**Business impact:** `invTaxTotals(subtotal)` (`:4586-4594`) takes one number and applies one global
`companySettings.vatRate` to it. There is no per-line tax code, so a workshop that sells a mix of
standard-rated labour/parts and (in some jurisdictions) zero-rated or exempt items — e.g. certain
export/insurance-related work — has no way to represent that distinction; every item on an invoice
is taxed identically or not at all. This is consistent with **E5** in the companion audit
(`docs/ERP-AUDIT-2026-07-26.md`, "Line qty/unit price/discounts on invoice items" — there is no
per-line data model at all yet, so per-line tax cannot exist until that lands).

**Recommended fix:** Deferred until the line-item model (E5) exists; then add a `taxCode` per line
(`standard`/`zero`/`exempt`) and compute `taxAmount` as `Σ(line.cost × rateForCode(line.taxCode))`.

**DB changes:** None yet (schema-less `items` array already supports adding a field without
migration — `items:[{description,cost,taxCode}]`).

**Regression test:** N/A until implemented — flag for the next VAT-engine iteration.

**Risk if unfixed:** Any business with a genuinely mixed-rate catalogue cannot use the system's tax
figures as-is; they must be manually adjusted outside the software, defeating the point of an
automated VAT Summary.

---

### VAT-4 — Verified correct: VAT rounding, historical-invoice immutability, and the VAT-off banner

For completeness, the following parts of the VAT engine were checked and found **correct**:
- `invTaxTotals()`'s rounding (`Math.round(sub*rate)/100`, `:4592`) is mathematically equivalent to
  rounding `subtotal × rate / 100` to 2 decimal places (verified by hand: `sub*rate` already carries
  two extra implicit decimal places from `rate` being a whole-number percentage, so
  `Math.round(sub*rate)/100 === round2(sub*rate/100)`) — no cent-level drift found in spot checks
  (e.g. `123.45 × 5% = 6.1725 → 6.17`, matches).
- The code comment and behaviour at `:4584-4585` ("VAT is applied at invoice creation… Existing
  invoices are not changed") is accurate: no code path re-applies `invTaxTotals` to a previously
  saved invoice; toggling VAT on/off in Settings only affects invoices created afterwards.
- `renderVatSummary()`'s banner (`:5607`) correctly warns when VAT is currently off, and its
  month-bucket totals (`:5608-5617`) tie out to `Σ invoices[].taxAmount` and
  `Σ invoices[].subtotal` with no double-counting or NaN risk for pre-VAT-engine historical
  invoices lacking a `subtotal` field (falls back to `gross − vat` safely, `:5615`).

No fix required for these three items; recorded here so they are not re-litigated as unverified.

---

# 4. Invoicing / payments

### INV-1 — CRITICAL, live-proven: the generic `PUT /api/:coll/:id` lets any authenticated client overwrite an invoice's `total`, `status`, `totalPaid` and `payments[]` with no validation whatsoever, completely bypassing the new atomic `/pay` endpoint

**Module:** Invoices / server API
**Severity:** Critical

**Business impact:** The `/pay` endpoint's row-lock, balance-cap and rounding (verified good, see
"Live tests performed" #1–4) only protects invoices modified *through that endpoint*. The generic
`PUT /api/invoices/:id` (`server.js:357-383`) is a plain shallow-merge upsert with zero business
validation, and it is reachable by exactly the same bearer token as every other route. This was
**proven live**, not inferred: a `PUT` to a real 20.00-total invoice with body
`{"total":999999,"status":"paid","totalPaid":999999}` returned `200 OK` and stored the values
verbatim (see Live tests performed, #8).

**Root cause / evidence:** `server.js:357-383`:
```js
app.put('/api/:coll/:id', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
  const patch = sanitizeDoc(req.params.coll, { ...req.body });   // only rounds numeric fields
  delete patch.id;
  // … BEGIN; SELECT … FOR UPDATE; merged = {...cur.rows[0].data, ...patch}; UPDATE …; COMMIT …
```
`sanitizeDoc()` (`:63-71`) only rounds money fields to 2dp — it never checks that `total` equals
`subtotal+taxAmount`, that `totalPaid` equals `Σ payments[].amount`, or that `status` is consistent
with `totalPaid` vs `total`. This route is completely generic across all 10 collections by design
(it is what makes `DocRef.prototype.update()` in `gms-backend.js:118-122` work for every
collection), so there is no natural place in the current architecture to add invoice-specific rules
without special-casing it.

Every legitimate UI code path that touches an invoice via `PUT` only ever sends small,
narrowly-scoped patches — `confirmCredit()` sends `{creditDueDate, creditNotes, status?}`
(`:5153-5166`), the job-card status flip after `convertToInvoice()` never touches the invoice
itself. **No current UI feature exploits this hole** — but nothing in the server stops a future
feature, a client-side bug, a compromised admin session, or a direct API call (as demonstrated) from
doing so, and the audit was explicitly asked not to take "atomic payments" on trust: this finding is
exactly why — the atomicity only holds for one specific, narrow route.

**Recommended fix:** Split invoices out of the generic `COLL` upsert/update machinery into
dedicated routes that enforce invariants server-side, mirroring the discipline already applied to
`/pay` and `/adjust`:

```js
// server.js — replace the generic PUT for invoices with a narrow, validating one.
// Remove 'invoices' handling from the generic PUT (or explicitly reject total/status/totalPaid/payments
// fields there), then add:
const INVOICE_CLIENT_EDITABLE = ['creditDueDate', 'creditNotes', 'notes']; // whitelist
app.put('/api/invoices/:id', asyncH(async (req, res) => {
  const patch = {};
  for (const k of INVOICE_CLIENT_EDITABLE) if (k in req.body) patch[k] = req.body[k];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT data FROM invoices WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const merged = { ...cur.rows[0].data, ...patch };
    await client.query(`UPDATE invoices SET data=$2 WHERE id=$1`, [req.params.id, JSON.stringify(merged)]);
    await client.query('COMMIT');
    res.json({ id: req.params.id, ...merged });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
```

**DB changes:** None required for the whitelist fix; a proper fix (recomputing `total` server-side
from `items`, per **INV-2**) needs no schema change either, just server logic.

**Regression test:** `PUT /api/invoices/:id` with `{total:999999}` on a real invoice must either
`400` or silently drop the field; assert the stored `total` is unchanged.

**Risk if unfixed:** Every downstream figure that trusts `invoice.total`/`status`/`totalPaid`
(Aged Receivables, Balance Sheet AR, Customer Accounts, VAT Summary) can be corrupted by a single
malformed request, with no server-side backstop at all.

---

### INV-2 — CRITICAL, live-proven: line items are never reconciled against `subtotal`/`taxAmount`/`total`, at creation or update

**Module:** Invoices / server API
**Severity:** Critical

**Business impact:** An invoice's financial totals are entirely client-computed and client-trusted.
Proven live: `POST /api/invoices` with `items:[{cost:10},{cost:10}]` (sum = 20) but
`subtotal:20, total:5000` was accepted verbatim with `200 OK` (Live tests, #9). This is the same
root problem as **INV-1** but at the creation boundary, and it means even a *correctly-behaving*
client that has a bug in its own `invTaxTotals()` call (or a future feature that forgets to call
it) will silently produce an invoice whose printed total does not match its own line items, with
no server-side safety net to catch it.

**Root cause / evidence:** `server.js`'s `POST /api/:coll` (`:214-267`) — the same generic handler
used for every collection — performs `sanitizeDoc()` (rounding only) and an `INSERT … ON CONFLICT
DO UPDATE`; it never reads `body.items` to cross-check `body.subtotal`/`body.taxAmount`/
`body.total`.

**Recommended fix:** In the same dedicated invoice route proposed in INV-1, recompute
`subtotal`/`taxAmount`/`total` server-side from `items` and the tenant's `companySettings`
(fetched inside the same transaction), ignoring whatever the client sent for those three fields —
the server, not the browser, should be the source of truth for money math.

```js
// server.js — inside the dedicated POST /api/invoices handler:
const settings = (await client.query(`SELECT data FROM settings WHERE id='company'`)).rows[0]?.data || {};
const subtotal = round2((body.items || []).reduce((s, it) => s + (Number(it.cost) || 0), 0));
const vatEnabled = !!settings.vatEnabled && Number(settings.vatRate) > 0;
const taxRate = vatEnabled ? Number(settings.vatRate) : 0;
const taxAmount = vatEnabled ? round2(subtotal * taxRate) / 100 : 0;
body.subtotal = subtotal; body.taxRate = taxRate; body.taxAmount = taxAmount;
body.total = round2(subtotal + taxAmount);
```

**DB changes:** None.

**Regression test:** `POST /api/invoices` with `items` summing to 20 and a claimed `total:5000`;
assert the stored `total` is `20.00`, not `5000`.

**Risk if unfixed:** Financial statements, VAT Summary and customer statements can diverge from the
invoice's own printed line items with no way to detect it except manual reconciliation.

---

### INV-3 — `status` (not `totalPaid` vs `total`) is trusted as the "is this paid" signal in some reports but not others, creating an exploitable inconsistency

**Module:** Aged Receivables / Trial Balance / Balance Sheet vs. Customer Accounts
**Severity:** High (compounds INV-1)

**Business impact:** `isInvPaid(iv)` (`:4595-4601`) returns `true` unconditionally the instant
`iv.status==='paid'`, without checking `totalPaid` against `total` at all:
```js
function isInvPaid(iv){
  if(iv.status==='paid'||(typeof iv.status==='string'&&iv.status.startsWith('paid_')))return true;
  if(iv.status==='delivered')return Number(iv.totalPaid||0)>=Number(iv.total||0)-0.005;
  return false;
}
```
It is used by `renderAgedReceivables()` (`:5579`) to *exclude* an invoice from the aged-debt list.
Combined with **INV-1** (status is directly settable via `PUT` with no relation to `totalPaid`), any
invoice whose `status` field is `'paid'` — whether legitimately or via a bug/exploit/race — vanishes
from collections chasing entirely, regardless of its real outstanding balance. The Trial Balance and
Balance Sheet AR calculations (`:6517-6518`, `:6642-6643`) use a *different* test
(`status==='unpaid'||'partial'||'credit'`, which also implicitly trusts `status` and excludes
`'paid'` unconditionally) — so a corrupted-but-`'paid'`-labelled invoice with real outstanding
balance disappears from AR on the Balance Sheet too. Only `buildCustAccData()` (Customer Accounts,
`:6734-6742`) is immune, because it computes `outstanding = totalInvoiced − totalPaid` directly
from the numbers rather than trusting the label — meaning **Customer Accounts and Aged Receivables
can show different figures for the same customer** if `status` and `totalPaid` ever disagree.

**Root cause:** Two different definitions of "outstanding" coexist in the codebase (`status`-based
vs. `totalPaid`-based) with no single source of truth, and nothing enforces that `status` and
`totalPaid` stay consistent (see INV-1 for how they can diverge).

**Recommended fix:** Standardise on the numeric definition everywhere — replace every `status`-based
"is paid" check with `Number(iv.totalPaid||0) >= Number(iv.total||0) - 0.005`, keeping `status`
purely as a display label, not a business signal.

```js
// public/index.html — replace isInvPaid() body:
function isInvPaid(iv){ return Number(iv.totalPaid||0) >= Number(iv.total||0) - 0.005; }
// and update the Trial Balance / Balance Sheet AR filters from status-list checks to:
invoices.filter(function(iv){ return !isInvPaid(iv) && tsToDs(iv.createdAt)<=asAt; })
```

**DB changes:** None (pairs well with server-side status derivation once INV-1 is fixed, so
`status` can never diverge from `totalPaid` in the first place).

**Regression test:** Force (pre-fix reproduction) an invoice to `status:'paid', totalPaid:0,
total:500` via `PUT`; assert post-fix that Aged Receivables, Trial Balance AR and Customer Accounts
all report the same 500.00 outstanding.

**Risk if unfixed:** Real money owed can be made invisible to two of the three places a business
would look for it, by a single bad write to one field.

---

### INV-4 — Verified correct: rounding, overpayment blocking, one-invoice-per-job-card, `confirmCredit`, and `delivered ≠ paid`

The following claims from today's fix list were independently verified and found **correct**:

- **Rounding fix** — server-rounds every money field on write (`round2()`, `server.js:51`,
  applied in `sanitizeDoc()`, `:63-71`) and the `/pay` endpoint compares
  `already + adding > total + 0.005` (`:289`) rather than exact equality. Live-tested with the
  canonical `33.33+33.33+33.34` failure case (Live tests #1) — reaches `status:"paid"` exactly.
  **Genuinely fixes** the old `B2` finding from the companion audit.
- **Overpayment blocking** — `/pay`'s balance cap (`:289-292`) was live-tested at three edges
  (exact-total, one-cent-over, and re-paying an already-settled invoice) and rejected all three
  correctly with a clear "N.NN due" message (Live tests #2–4). **Genuinely fixes** the old `B3`
  finding.
- **One-invoice-per-job-card** — the partial unique index
  `uq_invoices_jobcard` (`db.js:37-38`, `ON (data->>'jobCardId') WHERE … IS NOT NULL AND … <> ''`)
  was live-tested: a second `POST /api/invoices` for the same `jobCardId` returned `409` (Live
  tests #7). Note it **only protects job-card-originated invoices** — Quick Invoices always have
  `jobCardId:''`, so this index provides no duplicate protection for the busiest invoicing path;
  see **CC-1**.
- **`confirmCredit()`** (`:5153-5166`) correctly preserves `'partial'` status when
  `totalPaid > 0` (`if(!(Number(iv.totalPaid)>0))update.status='credit';`) rather than
  overwriting it — matches the stated intent and the old `B4` half of this finding is fixed.
- **`delivered ≠ paid`** — `isInvPaid()`'s `'delivered'` branch (`:4599`) does check
  `totalPaid>=total-0.005` rather than blindly trusting the status, so the specific `B4` bug (an
  invoice marked "delivered" being treated as fully paid regardless of balance) is fixed *as
  written*. However, a repo-wide search found **no code path that ever sets an invoice's `status`
  to `'delivered'`** any more (`'delivered'` is now exclusively a job-card status,
  `db.collection('jobCards').doc(jc.id).update({status:'delivered',…})` at `:5183`) — so this is
  now defensive dead code rather than a live guard. Harmless, but worth removing for clarity next
  time the file is touched.

No fix required for these five items.

---

# 5. Inventory valuation

### STK-1 — Single mutable last-cost, editable at any time after creation, with no cost captured per movement

**Module:** Inventory / Parts
**Severity:** High

**Business impact:** `p.costPrice` is one scalar field on the part document. It can be changed via
`savePart()`'s edit path at any time (`:3665-3687` — the edit form does not lock `costPrice`, only
`stock` is locked post-creation, `:3656` `"stock changes only via Adjust Stock"`). Every stock
movement (`POST /api/parts/:id/adjust`, `server.js:325-354`) records `{type, qty, from, to, note,
at, by}` — **no cost is captured on the movement itself**. Stock valuation
(`renderInvKpis()`, `:3603`, `s*Number(p.costPrice||0)`) is therefore always
*current stock × current cost*, meaning a cost-price correction today silently re-values every unit
already in stock, including units that were actually bought at a different (older) price — there is
no per-batch or per-movement cost trail to audit against.

**Recommended fix:** Capture `unitCost` on every `'in'` movement (defaulting to the part's current
`costPrice` if not supplied) and compute a running weighted-average cost server-side inside the
existing atomic `/adjust` transaction, rather than trusting a single mutable field.

```js
// server.js — POST /api/parts/:id/adjust, inside the existing transaction (:325-354):
if (type === 'in') {
  const unitCost = Number((req.body||{}).unitCost);
  if (Number.isFinite(unitCost) && unitCost >= 0) {
    const prevValue = from * (Number(p.avgCost) || 0);
    const addValue = qty * unitCost;
    p.avgCost = to > 0 ? round2((prevValue + addValue) / to) : unitCost; // weighted average
  }
  movement.unitCost = unitCost;
}
```

**DB changes:** None (JSONB `data` already accommodates new fields); add `avgCost` alongside the
existing `costPrice` (kept for now as "last purchase price" for reference/reorder decisions).

**Regression test:** Receive 10 units @ cost 5, then 10 more @ cost 7; assert `avgCost = 6.00` and
stock valuation uses it, not whatever `costPrice` was last typed into the Edit Part form.

**Risk if unfixed:** Reported inventory value (and, once COGS exists per STK-3, reported margin) can
swing purely from someone correcting a typo in a cost field, with no way to tell real cost movement
from a data-entry change after the fact.

---

### STK-2 — No FIFO/WAC; last-cost-only valuation

**Module:** Inventory
**Severity:** High (subsumed by / paired with STK-1)

Recorded as a distinct line because it's a distinct accounting requirement, but the fix is the same
weighted-average mechanism proposed in STK-1. Given the size of the current parts catalogue observed
live (~2,000–5,000 rows — see note below), a full FIFO-lot implementation is likely overkill;
weighted-average (WAC) is the pragmatic target for a workshop of this scale.

*(Live observation: the `parts` collection's row count changed between two reads taken minutes apart
during this audit — 2,100 then later 5,006 — with no action by this audit. This was not caused by
any test performed here (the one throwaway test part created and deleted by this audit is confirmed
absent from both counts) and is outside this report's scope, but is noted in case it indicates a
concurrent bulk import worth the team's own attention.)*

---

### STK-3 — No COGS is ever posted; the default "Spare Parts & Inventory" expense and "Spare Parts Sales" income accounts are permanently empty

**Module:** Inventory / P&L
**Severity:** Critical (this is the biggest blind spot in the whole audit)

**Business impact:** Gross margin — revenue minus the cost of the parts and labour that earned it —
is completely unmeasured. The P&L (per **AB-1**) only ever shows cash in/out by category; nothing in
the system ever computes "this invoice earned QAR 1,000 in labour + parts revenue and cost QAR 300
in parts," because:

**Root cause / evidence:**
1. Parts are **never referenced anywhere on a job card or an invoice.** A repo-wide search for
   `partId` across the entire file returns zero hits in any job-card, work-item or invoice-item
   context (only `openPartById()`, `:3688`, an unrelated inventory-detail-page lookup). Invoice
   `items` are free-text `{description, cost}` pairs (`saveQuickInvoice()`, `:4818`;
   `convertToInvoice()`, `:4866`) with no way to select a catalogue part at all.
2. Stock is **never decremented by a job or an invoice** — the only way stock changes is the manual
   "Adjust Stock" modal (`applyStockAdjust()`, `:3737-3744`, calling `POST /api/parts/:id/adjust`).
   A workshop that fits a customer's brake pads from inventory must remember to separately go into
   Inventory and manually record an "out" movement — nothing in the job-card or invoice flow
   prompts or automates this.
3. Consequently, `Spare Parts & Inventory` (expense) and `Spare Parts Sales` (income) — both present
   in `FIN_DEFAULT_ACCOUNTS` (`:5405`, `:5401`) as if they were meant to be populated automatically —
   receive no automatic postings at all; they are purely available as manual categories a
   bookkeeper could hand-type into a General Ledger entry, with no link back to what was actually
   consumed.

**Quantified blind spot (live data):** At the time of this audit the live dev tenant had **6 real
job cards**, **3 real invoices**, and (at one read) **2,100+ parts** in inventory, with **zero**
`partId` references anywhere in any job card or invoice — every part in that catalogue is, from an
accounting perspective, disconnected from every sale ever made. Whatever margin the workshop is
actually earning on parts is invisible to the software; "Spare Parts Sales" and "Spare Parts &
Inventory" will read QAR 0.00 forever, regardless of real activity, unless a bookkeeper manually
re-keys every parts transaction as a General Ledger entry by hand — which defeats the purpose of
having an inventory module at all.

**Recommended fix:** This requires the line-item model already flagged as missing in the companion
audit (`E1`/`E5` in `docs/ERP-AUDIT-2026-07-26.md`) — add an optional `partId` + `qty` to invoice/job
card line items, and when an invoice is created (or a job-card work item is marked done), atomically
decrement the part's stock (reusing the existing `/adjust` row-lock) and post
`Dr COGS / Cr Inventory` at the part's current `avgCost` (from STK-1) alongside
`Dr AR / Cr Parts Revenue` for the sale price.

**DB changes:** `ledger_entries` (from DE-1) needs a COGS posting path; invoice/job-card `items`
gain optional `partId`/`qty` fields (no migration needed, JSONB).

**Regression test:** Fit one part (cost 50, sold at 80) on an invoice; assert stock decrements by 1,
`Dr COGS 50 / Cr Inventory 50` and `Dr AR 80 / Cr Parts Revenue 80` are both posted, and gross margin
(80−50=30) is derivable from the ledger.

**Risk if unfixed:** The business cannot know, from the software, whether it is making money on
parts at all — this is the single largest gap between "workshop operations tool" and "ERP" in the
entire system.

---

### STK-4 — Inventory is entirely absent from the Balance Sheet

**Module:** Balance Sheet / Inventory
**Severity:** Medium (consequence of STK-1–3)

**Business impact:** `renderBalanceSheet()`'s asset list (`:6686-6691`) is
`[Cash on Hand, Bank Accounts, Accounts Receivable, Fixed Assets]` — there is no "Inventory" line at
all, even though the Inventory module separately reports a "Stock Value" KPI
(`renderInvKpis()`, `:3606`, `s*costPrice`) that is never fed into any statement. A workshop holding,
say, QAR 200,000 of parts stock has that entire figure invisible to its own Balance Sheet.

**Recommended fix:** Once STK-1's `avgCost` exists, add an `Inventory` line to the Balance Sheet's
asset section, summed from `parts.reduce((s,p)=>s+p.stock*p.avgCost,0)`.

```js
// public/index.html — renderBalanceSheet(), add alongside the existing asset items:
var inventoryValue = parts.reduce(function(s,p){return s+Number(p.stock||0)*Number(p.avgCost||p.costPrice||0);},0);
// … and include {name:'Inventory',value:inventoryValue} in assetItems, add to totalAssets
```

**DB changes:** None beyond STK-1.

**Regression test:** With QAR 5,000 of stock on hand, assert the Balance Sheet's total assets
include that 5,000.

**Risk if unfixed:** Total business assets are systematically understated by the full value of
inventory held, which misrepresents the company's real net worth to anyone reading the statement.

---

# 6. Data integrity

### DI-1 — CRITICAL, live-proven: hard-deleting a customer orphans every vehicle, job card and invoice that references it, and the API allows it unconditionally

**Module:** server API (generic DELETE) / all collections
**Severity:** Critical

**Business impact:** `DELETE /api/customers/:id` succeeds even when a vehicle and an unpaid invoice
still reference that `customerId` — **proven live** (Live tests #10): after deletion, the vehicle
row (`GET /api/vehicles/:id`) still returned with `customerId` pointing at the now-nonexistent
customer, and the invoice still carried the dead `customerId`. Because `customerName` is denormalised
onto the vehicle/invoice at creation time, most list/detail views degrade gracefully (they show the
frozen `customerName` string rather than crashing), **but** every feature that actually looks the
customer back up by id silently breaks: `showCustAccDetail(customerId)` → `customers.find(...)`
returns `undefined` → `renderCustAccDetail()`'s `if(!c){el.innerHTML='<div class="empty">Customer
not found.</div>';return;}` (`:6800`) — the customer's own outstanding-balance history becomes
permanently inaccessible via Customer Accounts, even though the invoice (and its AR balance) still
counts on the Balance Sheet/Aged Receivables via the orphaned `customerId`/`customerName` fields.

**Root cause / evidence:** `server.js`'s `DELETE /api/:coll/:id` (`:386-391`) is a single
unconditional `DELETE FROM ${cfg.table} WHERE id = $1` for every one of the 10 collections, with no
dependency check. `db.js`'s schema (`:20-42`) defines **no foreign keys at all** between any table —
confirmed by reading the full `SCHEMA` string; there is not a single `REFERENCES` clause in the file.

**Enumerated orphan paths** (each independently confirmed by reading the relevant `.find()`/
`.filter()` call sites):
| Delete this… | …orphans this | Symptom |
|---|---|---|
| Customer | `vehicle.customerId`, `invoice.customerId`, `jobCard.customerId`, `transaction.partyId` | Customer Accounts / GL "Customer" ledger for that person becomes unreachable by id (falls back to name-matching only where the code happens to also match by `customerName`, `:6194`, `:6273`, `:6736`) |
| Vehicle | `jobCard.vehicleId`, `invoice.vehicleId` | "Service History" (`v-veh-history`) for that vehicle is gone; job cards/invoices keep showing the frozen `vehicleReg` string but the link to reopen the vehicle record is dead |
| Job card | `invoice.jobCardId` | The unique index (`uq_invoices_jobcard`) stops protecting that invoice from ever getting a *second* linked job card's worth of duplicate billing since the original job card is gone — and Gate Pass / job-card detail navigation from the invoice 404s |
| Invoice | (nothing else structurally depends on it) | Customer Accounts / Aged Receivables totals silently drop that invoice's history; if it was the *paid* invoice funding a `transactions` row, the cash-book row survives with a dangling `invoiceId` reference (`buildInvoiceTxnDoc`, `:5120`) and the "Payment – INV-xxxx" description on that transaction becomes unresolvable |
| Part | (movements are embedded in the part doc itself, so deleting the part deletes its whole movement history atomically — no separate orphan, but the audit trail is gone) | Stock-value history for that part cannot be reconstructed at all |
| Technician | `jobCard.works[].technicianId`/`technicianName` (name survives, id doesn't); Employee GL ledger (`renderGlEmployee`, `:6332-6350`) matches expense transactions to technicians **by lower-cased name string**, not id | A deleted technician disappears from the Employee dropdown but any historical "salary paid" transactions referencing them by name become permanently unmatchable if the technician is later re-added (new id, same name still resolves by luck; different name breaks silently) |

Note the current UI only exposes a **Delete** button for three collections (Appointments, Advisors,
Fin Accounts — confirmed by grepping every `onclick="delete...()"` call site: `:1234`, `:4455`,
`:1583`) — the other seven collections (customers, vehicles, job cards, invoices, parts,
technicians, transactions) have **no delete button in the UI at all**. That is not a mitigation:
the server route is fully generic and reachable by any bearer-token holder regardless of what
buttons the current UI happens to render (as demonstrated live), and a future UI feature, an admin
using the browser console, or a scripted integration would hit exactly the unguarded behaviour
documented above.

**Recommended fix:** Two layers. (1) Immediate/cheap: add server-side dependency checks mirroring
the one already written for `deleteFinAccount()` (`:6140-6151`, which correctly blocks deleting an
account with linked transactions) — generalise that pattern into the server's generic `DELETE`
handler, keyed per collection. (2) Correct/durable: move to soft-delete (an `archived_at` column)
for every collection except perhaps `appointments`, and stop hard-deleting business records at all;
this is also a prerequisite for the period-lock work in **DI-4**.

```js
// server.js — sketch: dependency map + guard, replacing the unconditional DELETE (:386-391)
const DEPENDENTS = {
  customers: [['vehicles', 'customerId'], ['invoices', 'customerId'], ['job_cards', 'customerId']],
  vehicles:  [['job_cards', 'vehicleId'], ['invoices', 'vehicleId']],
  job_cards: [['invoices', 'jobCardId']],
};
app.delete('/api/:coll/:id', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
  for (const [depTable, key] of (DEPENDENTS[req.params.coll] || [])) {
    const { rows } = await pool.query(
      `SELECT count(*) FROM ${depTable} WHERE data->>'${key}' = $1`, [req.params.id]
    );
    if (Number(rows[0].count) > 0) {
      return res.status(409).json({ error: `Cannot delete — ${rows[0].count} record(s) in ${depTable} still reference this.` });
    }
  }
  await pool.query(`DELETE FROM ${cfg.table} WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));
```

**DB changes:** Add `archived_at bigint` to every table for the soft-delete path; add btree indexes
on the JSONB foreign-key-ish fields used above (`(data->>'customerId')`, `(data->>'vehicleId')`,
`(data->>'jobCardId')`) so the dependency-count queries above stay fast as tables grow.

**Regression test:** Attempt to delete a customer with a live vehicle; assert `409`. Attempt to
delete a customer with no dependents; assert `200`.

**Risk if unfixed:** Any accidental or malicious deletion of a customer/vehicle/job-card silently
corrupts every report that relies on that id, with no error surfaced to the user at the time of
deletion and no way to detect the corruption after the fact except manual data forensics.

---

### DI-2 — No foreign keys anywhere in the schema

**Module:** Database schema
**Severity:** High (root cause of DI-1)

**Evidence:** `db.js:20-42` — the full `SCHEMA` constant defines 13 tables, none with a
`REFERENCES` clause; the only constraints present are the primary keys and the one partial unique
index (`uq_invoices_jobcard`, `:37-38`). This is a deliberate architectural choice (each collection
is a JSONB "Firestore-shaped document," per the file's own header comment, `:18-19`) but it means
the database itself provides zero referential-integrity backstop — every guarantee in this report's
Data Integrity section has to be re-implemented, by hand, in application code, and (per DI-1) mostly
hasn't been.

**Recommended fix:** Given the JSONB-document design is intentional and unlikely to change
wholesale, the pragmatic fix is the application-level dependency checks in DI-1 rather than a
relational rewrite; consider, as a middle ground, Postgres triggers on delete that raise an
exception if `EXISTS` a dependent row, as defense-in-depth below the Express layer (protects against
anyone bypassing `server.js` entirely, e.g. connecting to the DB directly).

**DB changes:** Optional trigger-based defense-in-depth (see above); not required if DI-1's
application-level check is trusted as the sole entry point.

**Regression test:** N/A beyond DI-1's.

**Risk if unfixed:** Same as DI-1, plus: any future direct-DB script, migration, or admin tool that
doesn't go through `server.js` has no protection at all.

---

### DI-3 — Unrestricted backdating of both transaction dates and document `createdAt`; no period lock exists anywhere in the codebase

**Module:** Transactions / all date-bearing collections
**Severity:** High

**Business impact:** Every report that slices by date (P&L, Cash Flow, Trial Balance "as at",
Balance Sheet "as at", VAT Summary, Aged Receivables, General Ledger) reads straight from a
client-supplied date with no floor, ceiling, or lock. A transaction dated last year can be entered
today and it will retroactively change last year's P&L, Cash Flow and Trial Balance the instant the
report is re-rendered — there is no concept of a closed period anywhere in the file.

**Root cause / evidence:**
- The transaction date field (`#txn-date`, `:1501`) is a plain `<input type="date">` with no `min`
  or `max` attribute (confirmed by grepping every `type="date"` input in the file, `:1214-2098` —
  none of the accounting-relevant ones carry a `max`; only the unrelated dashboard custom-range
  picker at `:2759`/`:2763` has `max="today"`, and that's a *report filter*, not a data-entry field).
  `saveTransaction()` (`:5849-5909`) writes `date: document.getElementById('txn-date').value`
  verbatim, with no server-side check either (`server.js`'s generic `POST`/`PUT` never validates
  `date`).
- `extractedColumns()` (`server.js:53-59`) takes `doc.createdAt` from the client
  (`Number.isFinite(doc.createdAt) ? doc.createdAt : Date.now()`) — i.e. the server trusts a
  client-supplied timestamp if present and finite; it only supplies `Date.now()` as a fallback when
  the field is missing. Combined with **INV-1**'s proof that the generic `PUT`/`POST` routes accept
  arbitrary fields, a `createdAt` in the far past or future can be set directly.
- No function named anything like `closePeriod`, `lockPeriod`, `fiscalYearEnd` or similar exists in
  the file (confirmed by search); the companion audit's `E9` finding ("period lock") is corroborated
  independently here from the accounting-integrity angle.

**Recommended fix:** Add a `min` (e.g. the last locked period's end date, once DI-4 exists) to the
transaction date input, and validate server-side that `date` falls within an open period once one
exists; in the interim, add a soft warning when a transaction's date falls in a month whose reports
have already been viewed/exported (a lightweight "you are editing a closed-looking period" nudge,
not a hard block, given no period-close feature exists yet to hard-block against).

**DB changes:** New `period_locks` table (`period_end date PRIMARY KEY, locked_at bigint, locked_by
text`) once a real close workflow is built (tracked as a feature gap, not fixed by this report).

**Regression test:** N/A until a lock mechanism exists; track alongside `E9`.

**Risk if unfixed:** Every historical financial statement this software has ever shown is only ever
as trustworthy as "nobody has entered a backdated transaction since I last looked" — there is no way
to prove a prior period's figures are final.

---

# 7. Disaster / concurrency

### CC-1 — Job-card work items (`jc.works[]`) are still a whole-array-replace race, unlike the (now-fixed) payments and stock movements

**Module:** Job Cards / Technician Portal
**Severity:** High

**Business impact:** The exact class of bug the new `/pay` and `/adjust` endpoints were built to
eliminate (append-under-row-lock instead of read-whole-array/mutate/write-whole-array-back) is
**still present, unfixed, in the technician-facing work-item flow** — the single most concurrency-
prone part of the app, since it is explicitly designed for multiple technicians on multiple devices
working the same job card simultaneously.

**Root cause / evidence:** `updateWorkStatus()` (`:4414-4429`), `techStartWork()`
(`:7812-7828`) and `techCompleteWork()` (`:7830-7853`) all follow the identical pattern:
```js
function techCompleteWork(jcId,workId){
  var jc=jobCards.find(function(j){return j.id===jcId;});          // local, possibly-stale cache
  var works=(jc.works||[]).map(function(w){                        // rebuild the WHOLE array client-side
    if(w.id!==workId)return w;
    return Object.assign({},w,{status:'done',completedAt:now,...});
  });
  var update={works:works};                                        // … and PUT the whole thing back
  db.collection('jobCards').doc(jcId).update(update)...
}
```
`server.js`'s `PUT /api/:coll/:id` (`:357-383`) does lock the row (`SELECT … FOR UPDATE`) and merge
server-side, which prevents the *database* from corrupting concurrent writes to *different* fields —
but because `works` is sent as one complete replacement array, two technicians who each read the job
card **before either write lands** and then each PUT their own updated copy of the *entire* `works`
array will have the second write silently discard the first technician's change, even though each
individual database transaction is internally safe. Example: Technician A starts work item #1 on
Device A (reads `works=[w1,w2]`, PUTs `[w1(in_progress),w2]`); Technician B, on Device B, had already
read the same stale `works=[w1,w2]` moments earlier and marks work item #2 done, PUTing
`[w1(untouched),w2(done)]` — whichever PUT lands second **overwrites** the other technician's
change, because the server has no way to know the PUT was meant to be a partial update to one array
element.

**Recommended fix:** Give job-card work items the same treatment `/pay` and `/adjust` already got —
a dedicated, row-locked, single-element-mutation endpoint, rather than a whole-array `PUT`.

```js
// server.js — new endpoint, mirroring the existing /adjust pattern (:325-354):
app.post('/api/jobCards/:id/work/:workId', asyncH(async (req, res) => {
  const { status, remarks } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT data FROM job_cards WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const jc = cur.rows[0].data;
    const works = (jc.works || []).map(w => w.id === req.params.workId
      ? { ...w, status, techRemarks: remarks || w.techRemarks, ...(status === 'in_progress' ? { startedAt: Date.now() } : {}), ...(status === 'done' ? { completedAt: Date.now() } : {}) }
      : w);
    const merged = { ...jc, works };
    await client.query(`UPDATE job_cards SET data=$2 WHERE id=$1`, [req.params.id, JSON.stringify(merged)]);
    await client.query('COMMIT');
    res.json({ id: req.params.id, ...merged });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
```

**DB changes:** None.

**Regression test:** Simulate two near-simultaneous updates to two different work items on the same
job card (two overlapping `POST`s to the new endpoint, or — pre-fix — two overlapping whole-array
`PUT`s); assert both updates survive post-fix (pre-fix, assert the bug reproduces: one is lost).

**Risk if unfixed:** In a busy workshop with several technicians assigned to the same job card, work
completion/status changes can be silently lost, meaning a customer's vehicle could show as "still in
progress" on a work item that was actually finished (or vice versa) purely due to write-order luck
between two phones/tablets — with no error shown to either technician.

---

### CC-2 — Quick Invoice's "pay now" flow is still two independent, non-atomic writes — the exact pre-fix pattern the new `/pay` endpoint exists to prevent, still live on the busiest checkout path

**Module:** Quick Invoice (point of sale)
**Severity:** Critical

**Business impact:** The audit was asked to verify "is the cash-book txn insert failing after
invoice write truly the same transaction now?" — for `/pay`, yes (verified: `server.js:273-320`
wraps the invoice update and every transaction insert in one `BEGIN…COMMIT`). But **Quick
Invoice — the button literally labelled "✓ Create Invoice & Collect Payment," almost certainly the
single most-used invoicing path in a real workshop's day — does not use `/pay` at all** for its
initial payment:

```js
// public/index.html :4844-4853 — saveQuickInvoice()
db.collection('invoices').add(invData).then(function(ref){       // write #1: invoice, ALREADY
  curInvoice=Object.assign({id:ref.id},invData,ref.serverDoc||{});// marked paid/partial client-side
  if(!isCredit&&amount>0){
    db.collection('transactions').add(buildInvoiceTxnDoc(curInvoice,method,amount,notes)) // write #2
      .catch(function(e){toast('Invoice saved, but the cash entry failed: '+e.message+' — record it in Accounts.','error');});
  }
  showInvoice(curInvoice);
}).catch(...);
```
`invData` already contains `status: isCredit?'credit':(isPaidFull?'paid':'unpaid'), totalPaid:
isCredit?0:amount, payments:[...]` (`:4838-4841`) **before the cash-book transaction is even
attempted** — so if write #2 fails (network blip, server restart, validation error), the invoice is
permanently left in the database showing `status:'paid'`/`totalPaid:<amount>` with **no
corresponding entry in `transactions` at all**. That cash is now invisible to the Trial Balance,
P&L, Cash Flow and VAT Summary (all of which read `transactions`, not `invoices`, for cash
movement) even though the invoice itself — and anything that reads `invoices` directly, like
Customer Accounts and Aged Receivables — believes it was paid.

**Root cause / evidence:** As shown above, `saveQuickInvoice()` never calls `gmsApi.pay()` (the
atomic endpoint) for the payment taken at the moment of invoice creation — it only calls the atomic
endpoint later, for *additional* payments on an already-existing invoice, via `postInvoicePayments()`
(`:5129-5143`). The creation-time payment is bolted on as an unawaited-into-atomicity `.add()` with
only a `.catch()` toast, i.e. exactly the "fails open" pattern the companion audit's old `A10`
finding described and that `/pay` was supposedly built to eliminate — it just wasn't wired into this
particular call site.

Also note: because `invData.status`/`totalPaid` are set purely from the client's own `amount` field
before any server involvement (`saveQuickInvoice()`, `:4831-4841`), the same lack of server-side
balance validation flagged in **INV-2** applies here too — nothing stops a direct API call to
`POST /api/invoices` from claiming `totalPaid` far in excess of `total` at creation time (the
client-side check at `:4826` is JS in the browser, trivially bypassed).

**Recommended fix:** Change `saveQuickInvoice()` to create the invoice **unpaid** first, then
immediately call the existing atomic `gmsApi.pay()` for the initial payment — reusing the same
machinery already proven correct for post-creation payments, rather than duplicating (and
under-protecting) the logic.

```js
// public/index.html — saveQuickInvoice(), replace the payment-at-creation block:
var invData = { /* … same as today, but always */ status:'unpaid', totalPaid:0, payments:[] };
db.collection('invoices').add(invData).then(function(ref){
  curInvoice=Object.assign({id:ref.id},invData,ref.serverDoc||{});
  if(!isCredit&&amount>0){
    gmsApi.pay(curInvoice.id,{payments:[{method:method,amount:amount,paidAt:Date.now(),notes:notes}],
      transactions:[buildInvoiceTxnDoc(curInvoice,method,amount,notes)]})
      .then(function(updated){Object.assign(curInvoice,updated);showInvoice(curInvoice);})
      .catch(function(e){toast('Invoice created but payment failed to record: '+e.message+' — use Record Payment.','error');showInvoice(curInvoice);});
  } else { showInvoice(curInvoice); }
}).catch(...);
```
This makes the invoice-creation write and the payment write two clearly-sequenced steps where the
second step (payment) is *itself* atomic with its cash-book entry (via the existing `/pay`
endpoint) — closing the specific gap of "invoice says paid, no cash-book row exists" even though
invoice-creation and first-payment remain two separate calls (accepable, since an invoice that
briefly exists as "unpaid" before a payment lands is a normal, recoverable state — unlike today's
bug, where the invoice is born already claiming to be paid).

**DB changes:** None.

**Regression test:** Simulate `POST /api/transactions` failing (e.g. temporarily rename the route in
a test harness) immediately after a Quick Invoice payment; assert, post-fix, that the invoice is
left `unpaid` with a visible error (recoverable via "Record Payment"), never silently `paid` with a
missing cash-book entry.

**Risk if unfixed:** This is the single most likely real-world way the books go quietly wrong: a
flaky connection during a busy counter transaction leaves the invoice looking settled while the cash
side of the entry never happened — undetectable until someone manually reconciles cash-in-hand
against the Trial Balance and finds it doesn't match (which, per **DE-1**, it structurally never
does anyway, burying this specific gap even deeper).

---

### CC-3 — Quick Invoice has no duplicate-submission protection (the unique index only covers job-card-linked invoices)

**Module:** Quick Invoice
**Severity:** Medium

**Business impact:** `uq_invoices_jobcard` (`db.js:37-38`) is a **partial** unique index —
`WHERE data->>'jobCardId' IS NOT NULL AND data->>'jobCardId' <> ''`. Every Quick Invoice is created
with `jobCardId:''` (`:4833`), so it falls entirely outside this constraint. `saveQuickInvoice()`
does disable its own button synchronously (`btn.disabled=true`, `:4828`) before the async call,
which mitigates a same-device double-click, but provides no protection against a duplicate
submission from a network retry, a second browser tab, or a second device processing the same
walk-in sale.

**Recommended fix:** Add an idempotency key generated client-side at form-open time and enforced
server-side (a unique constraint on a client-supplied `clientRequestId` field, ignored/looked-up on
conflict rather than erroring), or, more simply, a short server-side dedupe window keyed on
`(customerId, vehicleId, total, floor(createdAt/5000))` for Quick Invoices specifically.

**DB changes:** Optionally add a `client_request_id text` column with a unique index to `invoices`.

**Regression test:** Fire two identical `POST /api/invoices` requests (same idempotency key) within
one second; assert only one invoice is created.

**Risk if unfixed:** Lower likelihood than CC-1/CC-2 but a real possibility at a busy front counter
on a flaky connection — a double-billed customer, caught only by manual reconciliation.

---

### CC-4 — No cross-device realtime; every read is a point-in-time snapshot, which is the underlying enabler of CC-1

**Module:** `gms-backend.js` (Firestore-compat shim)
**Severity:** Medium (context for CC-1, not independently actionable beyond it)

**Evidence:** `gms-backend.js`'s own header comment is explicit about this:
*"There is no cross-device realtime: `onSnapshot` fires once on register and again after any local
mutation to that collection ('simple refresh')"* (`:11-13`). `refreshColl()`/`refreshDoc()`
(`:86-105`) only re-fetch after this device's own writes — a second device's write is invisible
until this device happens to trigger its own refresh. This is a reasonable, documented trade-off for
a small-team app, but it is the direct reason CC-1's races are as easy to hit as they are: two
technician devices can each be looking at a `jobCards` array that is minutes stale relative to each
other, with no signal that a refresh is needed.

**Recommended fix:** Not a standalone fix — addressed by making the specific hot-spots (job-card
work items, per CC-1; invoice payments, already done) use row-locked single-field mutations instead
of whole-document `PUT`s, which makes staleness of the *rest* of the document harmless. A general
polling refresh (e.g. every 15–30s while a job-card or technician-portal view is open) would reduce
the staleness window further without requiring a websocket/realtime rearchitecture.

**DB changes:** None.

**Regression test:** N/A — tracked via CC-1's test.

**Risk if unfixed:** General risk multiplier for every whole-document-replace write pattern in the
app, present and future.

---

# Scores

## Accounting Compliance Score: **24 / 100**

| Component | Weight | Score | Notes |
|---|---|---|---|
| Double-entry / GL posting | 35% | 3/100 | No account other than cash/bank ever receives a posting (DE-1); Trial Balance and Balance Sheet are structurally incapable of balancing in normal operation (DE-1, AB-2) |
| Accrual vs. cash consistency | 20% | 10/100 | P&L is cash-basis, BS mixes bases (AB-1, AB-2) — internally inconsistent by design |
| VAT engine | 20% | 45/100 | Calculation itself is correct and appropriately historical-invoice-safe (VAT-4); but never posted to the ledger (VAT-1), no multi-rate/exempt support (VAT-3), and a TRN+VAT-off combination can print non-compliant invoices (VAT-2) |
| Payment/invoice transactional correctness | 25% | 55/100 | Genuine, verified fixes for rounding, overpayment and duplicate-job-card-invoice protection (INV-4); but the generic `PUT`/`POST` routes accept financially-arbitrary data with zero validation (INV-1, INV-2, live-proven), `status` is trusted over `totalPaid` in some reports (INV-3), and the busiest checkout path (Quick Invoice) still has an unfixed non-atomic cash-book gap (CC-2) |

**Justification:** The money-handling *mechanics* the audit was asked to re-verify are, for the two
narrow endpoints they were built for (`/pay`, `/adjust`), genuinely solid — this is not a
"nothing works" report. But the score is dragged down hard by the fact that the *statutory
reporting layer* (Trial Balance, P&L, Balance Sheet, VAT Payable) sits on top of a data model that
cannot represent a real chart of accounts at all, and by two live-proven holes (INV-1, INV-2, CC-2)
that mean the very "atomicity" and "server-side validation" claims under audit do not hold
everywhere they're needed — only where they were explicitly built.

## Inventory Accuracy Score: **15 / 100**

| Component | Weight | Score | Notes |
|---|---|---|---|
| Quantity tracking | 30% | 70/100 | The `/adjust` endpoint is genuinely atomic, row-locked, negative-stock-blocked, and keeps an append-only movement log (verified live) — quantity on-hand can be trusted |
| Cost/valuation accuracy | 35% | 5/100 | Single mutable last-cost, freely editable after the fact, no per-movement cost capture, no WAC/FIFO (STK-1, STK-2) |
| COGS / margin measurement | 25% | 0/100 | Parts are never linked to a job card or invoice; stock is never decremented by a sale; the P&L's own "Spare Parts Sales"/"Spare Parts & Inventory" accounts are permanently empty (STK-3) — this is a complete blind spot, not a partial one |
| Balance-sheet representation | 10% | 0/100 | Inventory value never appears on the Balance Sheet at all (STK-4) |

**Justification:** The *operational* half of inventory (does the system know how many units are on
the shelf, and can it stop going negative) is solid engineering. The *accounting* half (what is that
stock worth, what did selling it cost, does that show up anywhere in the financials) essentially
does not exist. Since this audit is explicitly scored on accuracy for accounting purposes, the
severe weakness of the costing/COGS/balance-sheet legs dominates the number.

## Data Integrity Assessment: **Weak, and unevenly hardened**

- **Where it's genuinely strong:** the two purpose-built endpoints (`/pay`, `/adjust`) use
  row-level locks (`SELECT … FOR UPDATE`) inside real DB transactions, append rather than replace
  their arrays, and were confirmed live to reject every invalid input tested (overpayment at three
  tolerance edges, negative stock, duplicate job-card invoice).
- **Where it's weak, confirmed live:** the generic `PUT`/`POST` routes that cover every other write
  in the system — including the rest of the *same* `invoices` and `jobCards` collections — have no
  business-rule validation at all (INV-1, INV-2), no referential-integrity backstop at the database
  layer (DI-2), and hard-delete is available, unconditionally, on every collection via the API
  regardless of what the current UI happens to expose a button for (DI-1, live-proven on a
  customer with live dependents).
- **Where it's weak by absence:** no period lock, no restriction on backdating (DI-3); the
  technician-portal's job-card work items still use the exact whole-array-replace pattern the
  `/pay`/`/adjust` rewrite was meant to retire (CC-1); Quick Invoice's own payment-at-creation path
  bypasses the atomic payment endpoint entirely (CC-2).

**Overall read:** two islands of real rigor inside a much larger surface that remains exactly as
exposed as before today's fixes. The islands are well-built and should be used as the template — the
fix for nearly every open finding in this report (INV-1, INV-2, CC-1, CC-2, DI-1) is "apply the same
pattern already proven correct for `/pay` and `/adjust` to the rest of the invoice and job-card
surface," not a new architecture.

---

# Must-fix list (priority order)

1. **CC-2** — Route Quick Invoice's initial payment through the existing atomic `/pay` endpoint
   instead of a bare, unawaited `transactions.add()`. Highest real-world likelihood of silently
   losing cash-book entries on the busiest checkout path, and the fix is a small, mechanical reuse
   of code that already exists and is already proven correct.
2. **INV-1 / INV-2** — Give `invoices` a dedicated, validating `POST`/`PUT` route (whitelist
   client-editable fields; recompute `subtotal`/`taxAmount`/`total` server-side from `items`).
   Live-proven holes; closing them also fixes **INV-3**'s status/totalPaid inconsistency risk at the
   source.
3. **DI-1** — Add dependency checks to the generic `DELETE` route (or move to soft-delete) before
   any further real customer/vehicle/job-card data accumulates in the live tenant. Live-proven.
4. **CC-1** — Give job-card work items the same row-locked, single-element-mutation treatment as
   `/pay`/`/adjust`; this is the technician portal's core interaction and is currently racy by
   construction.
5. **DE-1 / DE-2 / VAT-1 / AB-1 / AB-2** — Build the real double-entry ledger (`ledger_entries`
   table + posting on invoice-create and on `/pay`). This is the largest single piece of work in
   this report but is the root cause of every Trial Balance/Balance Sheet/P&L/VAT-Payable finding
   above; everything else in this section is either a symptom of its absence or a stop-gap pending
   it.
6. **STK-1 → STK-4** — Weighted-average costing captured per movement, then link parts to job-card/
   invoice line items so COGS can post automatically. Large, but this is the single biggest
   business-visibility gap in the product (the workshop cannot currently know if it makes money on
   parts).
