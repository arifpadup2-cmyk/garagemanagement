# Phase 10 — Enterprise Validation · End-to-End Business Simulation

**System:** VIWO Garage Management (Tecido)
**Date:** 2026-07-29
**Method:** One fleet van, driven through every module in a single continuous
flow against the live database, asserting the ledger balances at each money
event.

---

## The Simulation

```
Customer enquiry      fleet account, 5,000 credit limit, 30-day terms
        ↓
Vehicle arrival       Toyota Hiace, insurance + Istimara recorded
        ↓
Check-in              120,450 km, ¼ fuel, scuff noted, toolbox logged
        ↓
Inspection            27-point VHC — front pads FAIL, fluid ATTENTION
        ↓
Estimate → Approval   450 labour, approved by the customer
        ↓
Purchase              pads not in stock → PO raised, submitted, APPROVED
        ↓
Goods receipt         4 sets @ 90 → Inventory Dr 360, GRNI Cr 360
        ↓
Supplier invoice      GRNI cleared → Payables; paid 360 by transfer
        ↓
Reservation           2 sets promised to this job (2 free remain)
        ↓
Bay allocation        one job per bay, row-locked
        ↓
Parts issued          stock 4→2, COGS Dr 180, Inventory Cr 180
        ↓
Quality check         FAILED first → back to the floor → passed, washed
        ↓
Invoice               810 on credit (450 labour + 360 parts)
        ↓
Delivery              allowed on an approved credit account; bay released
        ↓
Payment               810 by bank transfer; credit restored to 5,000
        ↓
Accounting            TB Dr 2,880 = Cr 2,880 · BS assets 630 = equity 630
        ↓                P&L income 810 − expense 180 = net 630
Reports               valuation 2 @ 90 = 180 · margin from the ledger
        ↓
Dashboard             renders clean
```

---

## Result — 23 of 23 stages passed

Every module integrated. The numbers reconcile end to end:

| Check | Expected | Actual |
|---|---|---|
| Weighted-average cost after receipt | 90 | **90** |
| Stock after issuing 2 of 4 | 2 | **2** |
| Cost of sales on 2 sets @ 90 | 180 | **180** |
| Invoice total (450 + 360) | 810 | **810** |
| Net profit (810 − 180) | 630 | **630** |
| Balance sheet | assets = liabilities + equity | **630 = 0 + 630** |
| Trial balance | debits = credits | **2,880 = 2,880** |
| Remaining stock value (2 @ 90) | 180 | **180** |
| Credit available after settlement | 5,000 | **5,000** |

The ledger was asserted balanced after **every** money event — goods receipt,
supplier payment, part issue, invoicing and collection — not only at the end.

### Controls proven under load
- Receiving refused against an unapproved order.
- Reservation held stock back from other jobs.
- One job per bay.
- A failed quality check returned the vehicle to the floor.
- Delivery released the bay automatically.
- A credit customer passed the money gate; a cash customer would not have.

---

## Honest Assessment

**What is production-ready:** the transactional core. Master data, procure-to-pay,
inventory with batch/serial traceability, workshop gating, sales with
corrections, and a double-entry ledger that cannot record an unbalanced entry.
Every guard is enforced server-side inside a transaction, so a tampered or buggy
client cannot get around one.

**What is not yet done** (each documented in its own phase audit):

1. **Branch / company access** — the system is single-branch. Multi-branch means
   scoping every list query and belongs in its own piece of work.
2. **The login screen still uses the bootstrap admin.** User accounts, roles and
   permissions are built and proven at the API; the front end has not been
   switched over.
3. **Some older report screens** still aggregate in the browser.
4. **Opening balances and bank reconciliation** have no import path.
5. **FIFO/FEFO consumption** — lot ordering is exposed, picking is not enforced.
6. **Backup is export-only** — no restore, no schedule.

**One number to distrust:** average turnaround read 0 hours, because the
simulation ran check-in to delivery in seconds. The measurement is correct; the
sample is artificial.
