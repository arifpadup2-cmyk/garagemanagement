# Phase 4 — Customer & Vehicle Management · ERP Audit & Remediation

**System:** VIWO Garage Management (Tecido)
**Scope:** Customer Creation · Vehicle Registration · Fleet Customers · Insurance Information · Service History · Documents · Customer Credit
**Date:** 2026-07-29

---

## 1. Current Workflow

### 1.1 Before this phase

A customer was five fields — name, phone, WhatsApp, email, address (plus the
group added in Phase 1). A vehicle was plate, VIN, make, model, year, colour,
mileage, fuel and a next-service reminder.

There was no distinction between a walk-in and a fleet account, no credit
control of any kind, and nothing recorded about insurance or registration.

### 1.2 After this phase

```
Customer ── individual │ company/fleet (company name, TRN, contact person)
    │
    ├── Credit control: limit · terms · hold  ──▶ enforced at invoicing
    └── Vehicles
          ├── identity: plate (unique), VIN, engine no., transmission
          ├── compliance: insurance co./policy/expiry · Istimara expiry
          │              warranty expiry + mileage
          └── service history (job cards) + next-service reminder
```

---

## 2. Business Analysis

- **Credit was completely uncontrolled.** Any customer could be invoiced on
  credit indefinitely. There was no limit, no terms, no hold, and no way to see
  what an account already owed before extending more. This is the single largest
  bad-debt exposure a garage carries.
- **Fleet customers were indistinguishable from walk-ins.** A company account is
  billed to an entity with a TRN and a contact person; without those fields the
  invoice cannot satisfy a corporate accounts-payable department.
- **Insurance and Istimara expiry were not recorded.** In Qatar an expired
  Istimara is an immediate fine, and an accident-repair job on a lapsed policy
  cannot be billed to the insurer. Both lapse silently.
- **Duplicate customers split history.** Nothing stopped the same phone number
  being registered twice, which halves the visible service history of the person
  standing at the counter.

---

## 3. Weaknesses Found

| # | Severity | Finding |
|---|---|---|
| C1 | **Critical** | No credit limit, no payment terms, no credit hold. Credit sales were unbounded. |
| C2 | **High** | No customer type. Fleet/company accounts had nowhere to record company name, TRN or contact person. |
| C3 | **High** | Insurance company, policy number and expiry were not recorded at all. |
| C4 | **High** | Vehicle registration (Istimara) expiry not recorded — a silent, fineable lapse. |
| C5 | **High** | Duplicate customers by phone were unprevented; duplicate plates were fixed in Phase 1. |
| C6 | **Medium** | No warranty expiry or warranty mileage, so warranty work could not be identified. |
| C7 | **Medium** | No engine number or transmission — both needed when ordering parts. |
| C8 | **Medium** | No validation on model year or mileage; a typo of `1899` or a negative mileage was accepted. |

### Found during the build (and fixed)

| # | Finding | Resolution |
|---|---|---|
| R1 | The credit check was inserted before `isNew` was declared, so **every invoice POST returned a 500** — including cash sales. Caught immediately by the verification suite. | Moved the check below the declaration, next to the other validations. |

---

## 4. What Was Built

### Credit control
`creditStatus(customerId)` computes, in one place: outstanding across every open
invoice, the limit, what remains available, the number of open invoices, the age
of the **oldest unpaid invoice**, and whether the account is blocked.

An account is blocked when it is on hold, at or over its limit, or past its
agreed terms. `GET /api/customers/:id/credit` exposes it, and invoice creation
enforces it.

Two deliberate design decisions:

- **A limit of zero means "no credit account", not "unlimited".** The opposite
  reading is how an unlimited account gets created by leaving a field blank.
- **Only credit sales are blocked.** Cash and card sales to the same customer
  continue to work — the control is about lending money, not about selling.

An explicit `creditOverride` flag exists for the case where a manager decides to
extend anyway, so the block is a control rather than a wall.

### Customer master
Account type (individual / company), company name, TRN, contact person, credit
limit, payment terms, credit hold. Company accounts require a company name. The
form shows the customer's live credit position while the limit is being edited,
so the number is not set blind.

### Vehicle master
Engine number, transmission, insurance company/policy/expiry, Istimara expiry,
warranty expiry and warranty mileage. Model year validated to a real range;
mileage cannot be negative.

### Alerts
`vehExpiryAlerts()` flags insurance, registration and warranty that have expired
or expire within 30 days. The notification centre now carries:
- vehicles with insurance expired/expiring,
- vehicles with registration expired/expiring,
- customers at their credit limit or on hold.

---

## 5. Validation Rules (server-enforced)

**Customer** — name required · credit limit ≥ 0 · payment terms ≥ 0 · a company
account must carry a company name · duplicate phone blocked in the UI.

**Vehicle** — registration number required · model year between 1950 and two
years ahead · mileage ≥ 0 · plate unique (Phase 1).

**Invoicing** — a credit or unpaid invoice to a blocked customer is refused with
a 409 that says which of the three reasons applied.

---

## 6. Test Cases

| # | Test | Result |
|---|---|---|
| 1 | Company account with no company name refused | ✅ |
| 2 | Fleet customer created with a 1,000 limit and 30-day terms | ✅ |
| 3 | Credit status reports 0 owed, 1,000 available, not blocked | ✅ |
| 4 | Credit invoice of 600 within the limit allowed | ✅ |
| 5 | Further credit taking the account to/over 1,000 flips `blocked` | ✅ |
| 6 | **The next credit invoice is refused** with the reason | ✅ |
| 7 | **A cash sale to the same customer still works** | ✅ |
| 8 | **Credit hold refuses even well within the limit** | ✅ |
| 9 | Duplicate phone number refused inline | ✅ |
| 10 | Vehicle stores insurance/Istimara/warranty; expired insurance raises an alert | ✅ |
| 11 | Model year 1899 refused | ✅ |
| 12 | Expiry and credit alerts appear in the notification centre | ✅ |

---

## 7. Remaining Work

1. **Document attachments** on customers and vehicles (ID, trade licence,
   Istimara scan) — the `images` table exists and job cards already use it; the
   customer/vehicle attachment UI is not built.
2. **Vehicle ownership transfer** between customers, preserving service history
   against the vehicle rather than the owner.
3. **Insurance-billed jobs** — marking a job card as an insurance claim and
   billing the insurer rather than the driver. This belongs with Phase 6.
4. **Credit override audit** — the flag exists but there is no approval trail
   around who used it.
