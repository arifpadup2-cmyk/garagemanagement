# Phase 2 — Supplier & Purchasing · ERP Audit & Remediation

**System:** VIWO Garage Management (Tecido)
**Scope:** Supplier Creation · Purchase Request · RFQ · Purchase Order · Goods Receipt · Purchase Invoice · Purchase Return · Landed Cost · Batch · Expiry · Serial Numbers
**Date:** 2026-07-29
**Status:** ✅ Remediated and verified

> Phase 2 only. Inventory/warehouse (Phase 3), workshop (Phase 5), billing
> (Phase 6) and finance (Phase 7) were touched only where purchasing must reach
> them: item cost, stock movement, and the payables figure.

---

## 1. Current Workflow

### 1.1 Before this phase

```
Purchase Order (draft) ──[Receive to Stock]──▶ received ──[Mark Paid]──▶ paid
```

Two statuses, one irreversible button, and a payment that invented an expense
out of nothing. There was no request, no quotation, no receipt document, no
supplier bill, no return, no landed cost and no batch/serial/expiry anywhere.

### 1.2 After this phase

```
Purchase Request ──▶ RFQ (quotes compared) ──▶ Purchase Order
                                                   │  draft → submitted → approved
                                                   ▼
                              Goods Receipt (GRN)  ── partial deliveries, each its own
                                   │                  document, batch/serial/expiry captured
                                   │                  into stock lots
                                   ├──▶ Purchase Return  (out of specific lots)
                                   ▼
                          Purchase Invoice  ── AP liability + landed cost onto item cost
                                   │
                                   ▼
                          Payments ──▶ Aged Payables
```

---

## 2. Business Analysis

Purchasing is where a garage's money leaves and its stock value is set. The old
model failed at three specific moments a workshop meets every week:

- **The delivery arrives short.** A van brings 4 of the 10 pads ordered. The old
  system could only mark the whole order received — so stock said 10, the shelf
  had 4, and the difference surfaced weeks later as an unexplained shortage.
- **The supplier's invoice disagrees with the delivery.** With no bill document,
  there was nothing to compare the delivery against, and no liability recorded
  between receiving goods and paying for them.
- **Freight arrives on a separate line.** 200 of freight on a 1,120 consignment
  is roughly 18% of cost. Without landed costing, every margin report on those
  parts read ~18% high.

Add the traceability gap: an oil or coolant with no batch or expiry cannot be
recalled, and a serialised part cannot be warranted.

---

## 3. Weaknesses Found (pre-remediation)

| # | Severity | Finding |
|---|---|---|
| P1 | **Critical** | Receiving was not a document. `POST /receive` marked the whole PO received in one shot — no partial delivery, no receipt history, no over-receipt control. |
| P2 | **Critical** | No purchase invoice and therefore **no accounts payable**. "Mark Paid" posted a cash expense at payment time, so purchases were cash-basis while sales are accrual — the two halves of the P&L were computed on different bases. |
| P3 | **Critical** | No batch, expiry or serial tracking anywhere, and no item flags to demand them. |
| P4 | **High** | No purchase return. Once received, stock could only be corrected with a manual adjustment, which loses the supplier link entirely. |
| P5 | **High** | No landed cost. Freight, customs and clearing never reached item cost, so COGS was understated and margin overstated on every imported part. |
| P6 | **High** | No purchase request and no RFQ — no demand origin, no approval, no price comparison between suppliers. |
| P7 | **High** | **No approval step at all.** Any user could create an order and stock it in immediately. No expected delivery date either. |
| P8 | **Medium** | PO carried no tax and no discount; total was strictly qty × cost, so most real supplier invoices could not be represented. |
| P9 | **Medium** | No delete guard on purchase orders — a received PO (which had moved stock) could be hard-deleted, orphaning the movements. |
| P10 | **Medium** | Aged Payables was a *proxy*: it read "received purchase orders not marked paid", which is not a liability ledger. |
| P11 | **Medium** | Supplier delete was unguarded despite POs and parts pointing at suppliers. |
| P12 | **Low** | The receive endpoint silently skipped lines whose item had been deleted (`if (!p) continue`), so a PO could report received with stock never moved. |

### Found during the build (and fixed)

| # | Severity | Finding | Resolution |
|---|---|---|---|
| R1 | **Critical** | The generic `POST /api/:coll` route matched `/api/goodsReceipts` first, so the receipt engine never ran — a raw document was created and **no stock moved**, while the caller saw success. Caught by the verification suite, not by inspection. | `DEDICATED_WRITE` set: the generic create hands these collections to the engine that owns them, and raw `PUT` on them is refused outright. This also closes the hole where a client could fabricate a receipt that moved no stock. |

---

## 4. ERP Standard Gaps — closed

| ERP standard | Status |
|---|---|
| Requisition → quotation → order → receipt → invoice chain, each a numbered document | ✅ PR / RFQ / PO / GRN / PINV / PRTN |
| Order approval before commitment | ✅ draft → submitted → approved, enforced server-side |
| Receiving as its own document, with partial deliveries | ✅ GRN, many per PO |
| Over-receipt control with a configurable tolerance | ✅ per-order `overReceiptPct`, default 0 |
| Three-way matching inputs (order / receipt / invoice) | ✅ all three exist and link; invoice pre-fills from received quantities |
| Weighted-average costing on receipt | ✅ retained and now per-GRN |
| Landed cost allocation onto item cost | ✅ by value or by quantity, remainder-balanced |
| Supplier liability recognised on invoice, not payment | ✅ accrual, matching sales |
| Part payments against a supplier invoice | ✅ atomic, overpay rejected |
| Purchase returns against a specific receipt and lot | ✅ |
| Batch / lot numbers | ✅ demanded when the item master says so |
| Expiry dates | ✅ |
| Serial numbers (one per unit, unique while in stock) | ✅ DB-enforced |
| Aged payables from real liabilities | ✅ reworked onto purchase invoices |

**Deliberately deferred to their own phases:** warehouse/bin location on receipt
(Phase 3), FIFO/FEFO issue policy against lots (Phase 3), inventory and COGS as
posted double-entry journals (Phase 7), supplier statement reconciliation (Phase 7).

---

## 5. UI/UX Improvements Delivered

1. **Purchasing section** in the sidebar: Purchase Requests · RFQs · Purchase
   Orders · Goods Receipts · Purchase Invoices · Purchase Returns · Suppliers.
2. **RFQ comparison grid** — one row per item, one column per supplier, the
   cheapest quote per line ticked, quoted totals underneath, and Award raising a
   pre-filled purchase order.
3. **Receiving screen** showing, per line, *ordered · already received ·
   outstanding*, defaulting to the outstanding quantity — the number the person
   holding the delivery note actually needs.
4. **Batch/serial capture inline on the receiving screen**, appearing only for
   items the Item Master marks as traced, with a live "batches total X — must be
   Y" check. Serial rows are created and removed automatically to match quantity.
5. **PO detail shows ordered / received / outstanding per line**, plus every
   delivery made against the order.
6. **Purchase invoice pre-fills from what was received**, not what was ordered.
7. **Landed cost editor** with allocation basis, and the posted invoice shows the
   freight share and landed unit cost per line.
8. **Item Master traceability block**, locked once stock exists — because the
   units already on the shelf carry no batch or serial.
9. **Live totals on the invoice form** computed with the same arithmetic as the
   server, so the figure on screen is the figure that gets stored.

---

## 6. Database Improvements

```sql
CREATE TABLE purchase_requests (id, data jsonb, seq, created_at);
CREATE TABLE rfqs              (id, data jsonb, seq, created_at);
CREATE TABLE goods_receipts    (id, data jsonb, seq, created_at);
CREATE TABLE purchase_invoices (id, data jsonb, seq, created_at);
CREATE TABLE purchase_returns  (id, data jsonb, seq, created_at);
CREATE TABLE stock_lots        (id, data jsonb, part_id, created_at);
```

15 indexes covering document lists, upstream-document lookups, and lot access by
part (`part_id, created_at ASC` — the order FIFO/FEFO issue will need).

**Two new uniqueness guarantees:**

| Index | Guarantees |
|---|---|
| `uq_lots_serial` | one live unit per serial number per item — partial on `status='available'`, so a serial may legitimately reappear after the first was returned |
| `uq_pinv_supplier_no` | one invoice number per supplier — makes paying the same bill twice impossible to record |

---

## 7. API Improvements

| Endpoint | Behaviour |
|---|---|
| `POST /api/goodsReceipts` | The receipt engine. Validates the entire delivery *before* touching stock; locks affected parts in id order (no deadlock); enforces approval, over-receipt ceiling and traceability; writes GRN + movements + lots + per-line `qtyReceived` + PO status in one transaction. |
| `POST /api/purchaseOrders/:id/status` | Explicit state machine. Cancelling an order with receipts against it is refused with a pointer to purchase returns. |
| `POST /api/purchaseInvoices/:id/post` | Allocates landed cost (value or qty, last line absorbs the rounding remainder so allocation sums exactly), re-costs affected items, turns the draft into a payable. |
| `POST /api/purchaseInvoices/:id/pay` | Row-locked, overpay rejected, cash-book row written in the same transaction. Mirrors the customer-payment endpoint. |
| `POST /api/purchaseReturns` | Validates the whole return first, then reduces stock out of the nominated lots and marks them returned. |
| Generic `POST`/`PUT` | `DEDICATED_WRITE` collections cannot be created or edited through generic CRUD — a receipt that moved no stock is now unrepresentable. |
| `sanitizeDoc` | Purchase documents costed server-side from their own lines: line discount → line total → header discount → tax on the discounted base → landed cost. |
| `deleteBlocker` | Extended to purchase orders (receipts/invoices), goods receipts and returns (never deletable), purchase invoices (posted or paid), suppliers (orders/invoices/items), stock lots, and items with received batches. |

---

## 8. Validation Rules (server-enforced)

**Purchase order** — supplier required · quantities and costs ≥ 0 · line discount
0–100% · tax 0–100% · over-receipt tolerance 0–100% · ordered quantity may not be
reduced below what has already been received · only draft/submitted are editable.

**Goods receipt** — PO must be approved or partial · every line must match a PO
line · received + already-received may not exceed ordered × (1 + tolerance) · an
item that no longer exists **stops** the receipt rather than being skipped · a
batch-tracked item needs a batch number on every line, expiry-tracked needs a
date, serial-tracked needs one serial per unit and quantity exactly 1 · lot
quantities must sum to the received quantity · period lock respected.

**Purchase invoice** — supplier required · unique invoice number per supplier ·
posts once · landed costs ≥ 0 · payments cannot exceed the outstanding balance ·
period lock respected on both posting and payment.

**Purchase return** — quantity > 0 · cannot exceed stock on hand · cannot exceed
the nominated lot's remaining quantity · reason required (UI).

**Item master** — batch and serial tracking are mutually exclusive · traceability
locked once stock exists.

---

## 9. Business Risks — before vs after

| Risk | Before | After |
|---|---|---|
| Stock says 10, shelf has 4 | Certain on any part delivery | Impossible — receipts record actual quantities |
| Paying a supplier bill twice | Unprotected | DB-enforced unique invoice number |
| Buying without authorisation | No approval existed | Receiving requires an approved order |
| Margins overstated by freight | Certain on imports | Landed cost reaches item cost |
| Cannot recall a bad batch | No batch data at all | Batch + expiry captured and queryable |
| Liability invisible between receipt and payment | Certain | Posted invoice is a real payable |
| Returned goods lose the supplier link | Certain | Return document, out of the specific lot |
| Deleting a PO orphans stock movements | Possible | Blocked |

---

## 10. Test Cases — executed against the live application

Headless Chrome driving the real UI and API on `localhost:3010` against the live
Neon database.

| # | Test | Result |
|---|---|---|
| 1 | Supplier + two items created (one batch+expiry tracked) | ✅ |
| 2 | Draft PO created for 10 + 6 | ✅ |
| 3 | **Receiving a draft (unapproved) order is refused** | ✅ |
| 4 | Submit → approve | ✅ |
| 5 | **Batch-tracked line with no batch number is refused** | ✅ |
| 6 | Partial receipt: 4 of 10, plus 6 coolant in two batches → PO becomes `partial` | ✅ |
| 7 | Stock 4 / 6; weighted-average cost 110 | ✅ |
| 8 | Two stock lots created with batch numbers and expiry dates | ✅ |
| 9 | **Over-receipt (99 against 6 outstanding) is refused** | ✅ |
| 10 | Receive remaining 6 → PO becomes `received` | ✅ |
| 11 | Weighted average blends 4@110 + 6@90 → **98.00** | ✅ |
| 12 | Invoice posted with 200 freight by value → total 1,320; freight split 178.57 / 21.43 (sums to exactly 200) | ✅ |
| 13 | **Duplicate supplier invoice number is refused** | ✅ |
| 14 | **Overpayment is refused** | ✅ |
| 15 | Part payment 320 → `partial`, then 1,000 → `paid` | ✅ |
| 16 | Two cash-book expense rows written | ✅ |
| 17 | Return 2 coolant from batch B-001 → stock 6→4, lot remaining 2 | ✅ |
| 18 | **Returning more than on hand is refused** | ✅ |
| 19 | **A PO with receipts cannot be deleted** | ✅ |
| 20 | **A fully received PO cannot be cancelled** (state machine) | ✅ |
| 21 | **A partly received PO is refused by the receipts guard**, pointing at purchase returns | ✅ |
| 22 | Aged Payables renders from posted invoices | ✅ |

---

## 11. Regression Tests

| Area | Check | Result |
|---|---|---|
| Phase 1 master data | 154 masters + 24 services still load; pickers unaffected | ✅ |
| Item Master | Existing items without tracking flags behave exactly as before | ✅ |
| Existing POs | Old orders (no `qtyReceived`) still list and open | ✅ |
| Stock adjustment | `/parts/:id/adjust` untouched, still blocks negative stock | ✅ |
| Job-card part issue | Untouched by this phase | ✅ |
| Invoice totals | Sales `sanitizeDoc` path unchanged | ✅ |
| Schema boot | Restart applies cleanly, all unique indexes created | ✅ |

---

## 12. Remaining Work

Honest list of what Phase 2 does **not** yet do:

1. **Three-way match is possible but not enforced.** The invoice pre-fills from
   received quantities, but nothing blocks posting an invoice whose quantities
   exceed what was received. A hard match tolerance is the obvious next control.
2. **Purchase returns do not yet reduce the payable.** The return document and
   the stock movement are correct; crediting an existing posted invoice needs the
   debit-note posting that belongs with Phase 7's ledger work.
3. **Landed cost re-costs on-hand units, not the specific lots.** Correct in
   aggregate for the common case; true per-lot landed costing needs the Phase 3
   lot-costing model.
4. **PR/RFQ have no email-out.** Suppliers are marked as invited; sending is manual.
