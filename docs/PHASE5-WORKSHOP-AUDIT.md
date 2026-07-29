# Phase 5 — Workshop Operations · ERP Audit & Remediation

**System:** VIWO Garage Management (Tecido)
**Scope:** Appointment · Vehicle Check-In · Inspection Checklist · Estimate · Customer Approval · Job Card · Bay Allocation · Technician Assignment · Labour Entry · Parts Request · Workshop Progress · Quality Check · Vehicle Wash · Delivery Checklist
**Date:** 2026-07-29

---

## 1. Coverage Before This Phase

| Stage | State |
|---|---|
| Appointment | ✅ calendar, convert to job card |
| Vehicle check-in | ❌ **absent** |
| Inspection checklist (VHC) | ✅ 27 items, 4 groups |
| Estimate + customer approval | ✅ approve → convert |
| Job card | ✅ |
| **Bay allocation** | ❌ **absent** |
| Technician assignment | ✅ per work line |
| Labour entry | ✅ (Service Master since Phase 1) |
| Parts request | ✅ (issue + reservations, Phases 2–3) |
| Workshop progress | ✅ kanban |
| **Quality check** | ❌ **absent** |
| **Vehicle wash** | ❌ **absent** |
| **Delivery checklist** | ❌ **absent** |

The gap was the whole back half: nothing recorded the car's condition on
arrival, nothing tracked where it was being worked on, and nothing stood between
"a technician says it's done" and the customer driving away.

---

## 2. Business Analysis

- **No check-in record.** A dispute about a scratch after the fact has no
  evidence on either side. Fuel level and belongings are the same problem.
- **No bay allocation.** "Is the workshop full?" was a matter of opinion, and
  two cars could be scheduled into one ramp.
- **No quality gate.** The single most damaging workshop failure is a car
  released with the work not actually right — it returns as a comeback, costs
  the labour twice, and costs the relationship once.
- **No delivery control.** Cars could leave uninvoiced or unpaid, which is how
  receivables quietly become bad debts.

---

## 3. What Was Built

### Bay allocation — `POST /api/jobCards/:id/bay`
Row-locked. A bay holds one job that has not been delivered; a second
assignment is refused naming the job that has it. Delivering frees the bay
automatically.

### Vehicle check-in — `POST /api/jobCards/:id/checkin`
Mileage, fuel level, damage notes, customer belongings, whether the customer was
present, and photos. **Recorded once and not editable** — its entire value is
being the state before work began. Mileage syncs to the job card.

### Quality check — `POST /api/jobCards/:id/qc`
Refuses to run while any work item is unfinished, because checking the quality
of unfinished work is meaningless. Captures a per-item pass/fail plus road-test
and wash flags. **A failed check sets the job back to `in_progress`** — it
returns to the floor rather than moving forward.

### Delivery — `POST /api/jobCards/:id/deliver`
The last gate. Refused unless all three hold:
1. every work item is done,
2. the quality check passed,
3. an invoice exists and is settled — **credit-terms invoices are exempt**,
   because that customer has an approved account.

Captures who received the car, mileage out, and a delivery checklist. An
`override` is permitted for the manager who decides to release anyway, but it is
stored as `overridden` with a reason and written to the audit log.

---

## 4. Test Cases

| # | Test | Result |
|---|---|---|
| 1 | Customer, vehicle, two bays, two job cards created | ✅ |
| 2 | Check-in records mileage, fuel, damage; syncs `mileageIn` | ✅ |
| 3 | **Checking in twice is refused** | ✅ |
| 4 | Bay A assigned to job 1 | ✅ |
| 5 | **The same bay to job 2 is refused**, naming the occupying job | ✅ |
| 6 | A different bay is accepted | ✅ |
| 7 | **QC on unfinished work is refused** | ✅ |
| 8 | **A failed QC returns the job to `in_progress`** | ✅ |
| 9 | **Delivery refused** — QC not passed and not invoiced | ✅ |
| 10 | **Delivery still refused** with QC passed but 300.00 unpaid | ✅ |
| 11 | Invoice settled → delivery succeeds and **frees the bay** | ✅ |
| 12 | An override is permitted but **recorded with its reason** | ✅ |

Zero console errors. All checks passed on the first run.

---

## 5. Remaining Work

1. **Bay UI.** The allocation is enforced server-side and exposed via the API;
   a bay board (which ramp holds which car) is not yet drawn.
2. **QC checklist template** is free-form per call; a configurable master
   template like the VHC would make it consistent between advisors.
3. **Customer signature** on check-in and delivery — currently a typed name.
4. **Wash as a scheduled step** rather than a flag on the quality check.
