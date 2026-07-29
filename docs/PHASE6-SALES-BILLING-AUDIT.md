# Phase 6 — Sales & Billing · ERP Audit & Remediation

**System:** VIWO Garage Management (Tecido)
**Scope:** Estimate Conversion · Sales Invoice · Labour Charges · Parts Charges · Discounts · Taxes · Payments · Split Payments · Credit Sales · Refunds · Credit Notes
**Date:** 2026-07-29

---

## 1. Coverage Before This Phase

| Item | State |
|---|---|
| Estimate conversion | ✅ approve → job card → invoice |
| Sales invoice | ✅ totals recomputed server-side from lines |
| Labour charges | ✅ Service Master priced (Phase 1) |
| Parts charges | ✅ issued from stock (Phases 2–3) |
| Discounts | ✅ header, amount or percent |
| Taxes | ✅ VAT + per-item tax codes (Phase 1) |
| Payments | ✅ atomic, row-locked, overpay rejected |
| Split payments | ✅ already an array of tenders in one call |
| Credit sales | ✅ limits and terms enforced (Phase 4) |
| **Refunds** | ❌ **absent** |
| **Credit notes** | ❌ **absent** |
| **Invoice void** | ❌ **absent** |

The billing engine was sound. What was missing was the entire correction path:
there was no way to reverse a sale.

---

## 2. Business Analysis

An invoice is evidence handed to a customer and posted to the ledger. Once it
exists, the only correct way to change it is **forwards** — with a document that
reverses it and stays on the record next to it. Editing or deleting the original
destroys the audit trail and desynchronises revenue from what the customer
actually holds.

Without any correction path, three ordinary situations had no clean answer:

- Two parts came back unused → stock was wrong, or someone silently edited the
  invoice.
- A job was billed and then cancelled → the receivable stayed on the books.
- An invoice was raised against the wrong customer → nothing could undo it.

---

## 3. What Was Built

### Credit note — `POST /api/creditNotes`
Reverses value against a specific invoice. In one transaction it:

- validates the credit against **everything already credited** on that invoice,
  so the sum of credit notes can never exceed what was invoiced;
- optionally **restocks** the returned goods, using the same row-locking and
  movement-ledger discipline as any other stock change;
- optionally **refunds cash**, capped at what has actually been collected, and
  writes the cash-book entry in the same transaction;
- stamps `creditedTotal` and `fullyCredited` onto the invoice so every
  receivable figure nets it off without a join.

A reason is mandatory — the customer and the auditor will both ask.

### Invoice void — `POST /api/invoices/:id/cancel`
Only before anything has moved. Refused if the invoice has payments, already has
a credit note, or its vehicle has been delivered. In each case the message
points at the credit note as the correct instrument.

`creditNotes` is in `DEDICATED_WRITE`: they cannot be created or edited through
generic CRUD, so a credit note that moved no stock and refunded no cash is
unrepresentable.

---

## 4. Test Cases

| # | Test | Result |
|---|---|---|
| 1 | Customer, part with 10 in stock, invoice for 1,000 | ✅ |
| 2 | **Split payment** — 400 cash + 600 card in one call | ✅ |
| 3 | Paying beyond the total refused | ✅ |
| 4 | **Cancelling a paid invoice refused**, pointing at credit notes | ✅ |
| 5 | An unpaid invoice can be cancelled, with its reason stored | ✅ |
| 6 | **A credit note without a reason is refused** | ✅ |
| 7 | Credit 200 with restock of 2 units and a 200 cash refund — stock rises, refund posts, `creditedTotal` set | ✅ |
| 8 | **Crediting more than the invoice is refused** | ✅ |
| 9 | **Refunding more than was collected is refused** | ✅ |
| 10 | The remaining 800 credits cleanly → `fullyCredited` | ✅ |
| 11 | **A credit note cannot be edited through generic CRUD** | ✅ |

---

## 5. Remaining Work

1. **The credit note does not yet post a reversing journal.** It adjusts the
   receivable figure and the cash book; the double-entry reversal belongs with
   Phase 7, alongside the same gap on purchase returns.
2. **Per-line tax on sales invoices** — tax codes exist per item and per service,
   but a sales invoice still applies one header rate. Mixed standard/exempt
   invoices need the line-level path.
3. **Proforma invoices** and deposits/advance payments against a job.
