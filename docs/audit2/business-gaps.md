# Tecido Garage Management — Business & Workflow Gap Audit

**Auditor role:** Garage/automotive-service ERP consultant (workflow, parts, accounts) — 25+ years domain experience.
**Date:** 2026-07-26
**Scope:** `public/index.html` (8,037 lines, the entire SPA), `server.js` (454 lines, REST API), `db.js` (schema).
**Method:** Read the actual code (functions, forms, DB schema, API routes) — no feature is claimed present or absent
without a file:line citation. A prior audit (`docs/ERP-AUDIT-2026-07-26.md`) covered code-hygiene/UI-consistency
defects; this report is the **business/domain** audit — real garage lifecycle, competitive feature parity, and
data-model completeness — commissioned separately and cross-checked against that prior work where the two overlap.

---

## Verdict in one paragraph

Tecido GMS is a **capable job-card-and-invoicing tool** with genuinely good bones: atomic server-side payments and
stock adjustments, a technician PWA with live work timers, a real workshop kanban, VAT-aware invoicing, and a
maturing Finance module (GL, trial balance, aged receivables, cash flow). But walk the actual customer journey —
phone rings → car arrives → advisor inspects → quote is given → customer says yes → mechanic fixes it with parts
off the shelf → car is quality-checked → customer pays → car leaves → garage follows up — and the software falls
through the floor at **six of those ten steps**. Most damaging: **a part can be defined, priced, and stocked in
Inventory, but there is no code path anywhere in the application that lets a part be added to a job card or an
invoice.** Every part sale today happens off-book. That single gap alone means stock counts, COGS, and gross
margin are fiction the day the system goes live with real parts sales.

---

## Scores

### Workshop Operations Score: **58 / 100**

| Dimension | Score | Why |
|---|---|---|
| Vehicle intake & job card | 14/20 | Fast plate/VIN search, photos, complaints capture — but no VHC checklist, no estimate/approval gate before work starts |
| Technician execution | 13/20 | Real PWA, PIN login, live start/stop timers (`w.startedAt`/`w.timeTaken`, index.html:7812-7838) — but no QC/road-test gate, no parts consumption, no time-vs-estimate variance surfaced |
| Parts & inventory | 4/20 | Stock ledger with movements exists (server.js:325-354) but is **structurally disconnected** from job cards and invoices — nothing ever deducts it except a manual "Adjust Stock" screen |
| Scheduling | 6/15 | Week-view calendar for appointments (index.html:3494-3524) exists but does not convert to a job card, has no bay/resource concept, no reminders |
| Delivery & handover | 8/15 | Gate pass document exists and prints (index.html:5191-5271) but "signature" is a blank printed line, not a captured e-signature or approval record |
| Workshop visibility (kanban, dashboards) | 13/15 | Genuinely strong — kanban board, per-tech status, live dashboards |

### Business Readiness Score: **34 / 100**

| Dimension | Score | Why |
|---|---|---|
| Revenue integrity (quote→approval→bill audit trail) | 3/20 | No estimate stage, no customer approval capture, no line-item qty/unit price, no void/credit-note — a wrong invoice cannot be corrected, only paid |
| Inventory/COGS accuracy | 2/15 | Parts never touch a sale; margin cannot be computed; stock value on the Inventory KPI card (index.html:3606) is disconnected from what actually leaves the shelf |
| Procurement | 0/15 | No supplier master (free-text field only, index.html:1281), no PO, no GRN, no supplier bill/payment matching |
| Customer/commercial controls | 3/15 | No fleet/corporate accounts, no credit limit, no blacklist, no TRN-on-invoice for B2B VAT compliance |
| Governance (roles, audit trail) | 2/10 | One shared admin login (server.js:130-141) and PIN-only techs; advisors never log in; no per-user audit trail |
| Customer engagement (approvals, reminders, feedback) | 0/10 | Zero — no SMS/email, no service-due reminders, no feedback capture; WhatsApp is a static `wa.me` deep link (index.html:3186), not integrated messaging |
| Reporting for decision-making | 12/15 | Genuinely good — P&L, balance sheet, trial balance, aged receivables, cash flow, VAT summary, technician/customer/sales reports all exist and render |
| Multi-branch / scale readiness | 0/5 | Single-tenant, single-location; no `branch`/`outlet` concept anywhere in schema or UI |

**Reading the gap between the two scores:** the app is a decent *shop-floor* tool (58) but a weak *business system*
(34) — it will track today's work well and lose money on parts, procurement, and correction handling the moment
volume goes up.

---

## A. Workflow-Gap Audit — the real garage lifecycle

Lifecycle walked: **enquiry → appointment → check-in/inspection (VHC) → estimate/approval → job card → parts
issue → labour tracking → QC/road test → invoice → payment → gate pass → delivery → history → feedback/reminders.**

| ID | Stage | Status | Severity | Business impact |
|---|---|---|---|---|
| W1 | Enquiry (phone/walk-in, pre-booking) | Missing | Low | No lead capture; not core to a single-shop workshop, acceptable to skip for now |
| W2 | Appointment booking | Present (partial) | — | Works as a diary; see W3 for the break |
| W3 | Appointment → check-in / Job Card | **Broken** | **Critical** | Every booked appointment must be manually re-typed into a new job card |
| W4 | Check-in inspection / VHC with photos | Missing | **High** | No structured multi-point inspection; only a free-text "complaints" box |
| W5 | Estimate/quotation + customer approval | Missing | **Critical** | Work starts and is billed with no pre-agreed, approved price |
| W6 | Job card creation | Present | — | Solid: plate/VIN search, photos, works list |
| W7 | Parts issue from stock on the job | **Broken** | **Critical** | Parts stock is entirely disconnected from job cards/invoices |
| W8 | Labour tracking | Present (partial) | Medium | Timer data captured but not surfaced in costing/efficiency |
| W9 | QC / road test sign-off | Missing | **High** | No gate between "work done" and "invoice" |
| W10 | Invoice generation | Present (partial) | Medium | No qty/unit price, no parts lines, no void/credit note |
| W11 | Payment collection | Present | — | Atomic, race-safe (server.js:273-320) — a real strength |
| W12 | Gate pass | Present (partial) | Medium | Document exists; signature is unrecorded ink-on-paper only |
| W13 | Delivery | Present (thin) | Low | Status field flips to `delivered`; no delivery checklist/odometer-out capture |
| W14 | Service history | Present | — | `openVehHistory` (index.html:7046) gives a real per-vehicle timeline |
| W15 | Feedback / service reminders | Missing | **High** | No due-date tracking, no reminder queue, no satisfaction capture |

### Detailed findings

---

**W3 — Appointments never convert to a Job Card (Critical, complexity M)**

- **Evidence:** `saveAppointment()` (index.html:3560-3588) writes only to the `appointments` collection. `showAddAppointment()` (index.html:3531-3559) has no button or handler that opens the New Job Card screen pre-filled from the appointment. `renderAppointments()` (index.html:3494-3524) — clicking a calendar entry only re-opens the *edit appointment* form, never a job card.
- **What's needed vs what exists:** Exists: a week calendar keyed by `date`/`customerId`/`vehicleId`. Needed: a "Check In" action on an arrived appointment that pre-populates `jc-veh-search`, `jc-datein`, `jc-complaints` from the appointment record and marks the appointment `status:'arrived'`→ later `'completed'` once the job card exists.
- **Recommended design:** Add `checkInAppointment(id)` that opens `v-add-jobcard` with vehicle/customer pre-selected via the existing `jcModalCallback` pattern already used elsewhere (index.html:4750), and stamps `appointmentId` on the resulting job card for traceability.
- **Complexity:** M (reuses existing job-card-creation plumbing).

---

**W5 — No estimate/quotation stage or customer-approval capture (Critical, complexity M)**

- **Evidence:** Repository-wide search for "quotation"/"estimate" returns zero matches in `public/index.html`. `JC_STATUS` (index.html:2178-2185) goes straight from `pending` → `in_progress` → `completed` → `invoiced` → `delivered` — there is no `estimate_sent`/`approved` state. The only "signature" anywhere in the app is a printed blank line on the gate pass (index.html:5259-5266) — never a captured approval, timestamp, or method (SMS link / in-person / phone).
- **Business impact:** A technician can start (and be billed for) work the customer never agreed to the price of — the single most common source of "why is my bill higher than I expected" disputes in a garage, and a common source of unauthorized-repair legal exposure.
- **Recommended design:** New `estimates` collection: `{jobCardId, items:[{description,qty,unitPrice}], total, status: draft|sent|approved|rejected, approvedBy, approvedAt, approvalMethod}`. Job card cannot move to `in_progress` unless the linked estimate is `approved` (soft gate, overridable by admin with a logged reason). Approval capture: a signature-pad `<canvas>` (data-URL to the existing `images` bytea table, server.js:423-436 already supports arbitrary image storage) or an SMS/WhatsApp link the customer taps.
- **Complexity:** M — data model and gate are small; a good signature-pad UI and (optionally) an SMS/email approval-link channel is the larger piece.

---

**W7 — Parts never touch a job card or invoice (Critical, complexity L)** — *the single biggest structural gap*

- **Evidence, exhaustively:**
  - Job card work items only carry `{id, description, technicianId, technicianName, cost, status}` — `addWorkRow()` (index.html:4073-4076), `renderWorksEditor()` (index.html:4035-4071). No `partId`/`qty`/`partCost` field exists anywhere in the object.
  - `convertToInvoice()` (index.html:4857-4883) builds invoice `items` **only** from `jc.works` — `items:(jc.works||[]).map(function(w){return{description:w.description||'',cost:Number(w.cost)||0};})` (index.html:4866). A part can never appear on an invoice this way.
  - `saveQuickInvoice()` — the walk-in/counter-sale path (index.html:4816-4854) — has the **same limitation**: `qiWorkItems` only ever holds description+technician+cost. There is no UI anywhere in the app to sell a spare part over the counter (e.g., a customer who just wants an air filter) without inventing a fake "service" line and losing the stock deduction entirely.
  - The only place `parts[].stock` ever changes is the manual "Adjust Stock" dialog, `openStockAdjust()` (index.html:3718) → `POST /api/parts/:id/adjust` (server.js:325-354). That endpoint is well-built (row-locked, movement-logged, cannot go negative) — it's just never called by any billing flow.
  - `renderInvKpis()` (index.html:3601-3608) computes "Stock Value" from `stock × costPrice` — a number that will silently drift from reality the moment the shop actually sells parts, because nothing ever decrements `stock` on a sale.
- **Business impact:** Every part used or sold is invisible to inventory. Reorder alerts (`partLow()`, index.html:3599) will never fire correctly because stock never depletes through real usage. Gross margin (parts cost vs. parts billed) cannot be computed — the P&L will show labour-only revenue. This is normally the #1 leakage point in a garage (parts "walking out the back door" unbilled) and the software currently provides zero defense against it.
- **Recommended design:** Extend job-card work items to a proper line-item model — split `works` into `labourItems` (existing shape, kept) and a new `partsUsed:[{partId, name, qty, unitCost, unitPrice}]`. On job-card save, when a part line is added/increased, call the existing `/api/parts/:id/adjust` (`type:'out'`) inside the same save flow (ideally server-side, atomically, alongside the job-card write — today's endpoint already has the locking primitive, it just needs a combined transaction). `convertToInvoice()` and `saveQuickInvoice()` both need to fold `partsUsed` into invoice `items` with qty × unit price, not just `description/cost`. Reversing a part line (job card edited, part removed) must reverse the stock movement, not just delete the line silently.
- **Complexity:** L — touches job-card data model, invoice data model, two save paths, and ideally a new atomic server endpoint (`POST /api/jobCards/:id/parts` that does job-card update + stock deduction in one DB transaction, mirroring the pattern already proven in server.js:273-320 and 325-354).

---

**W4 — No Vehicle Health Check / inspection checklist (High, complexity M)**

- **Evidence:** Job card intake has exactly one field for condition capture: `jc-complaints` (free-text `<textarea>`, index.html:1330) plus photo attachments (`jc-img-input`, index.html:1334-1341). There is no structured checklist (brakes/tyres/fluids/lights/battery pass-fail-advise grid) anywhere in the schema or UI, and no way to attach an inspection photo to a *specific* checklist item (only to the job card as a whole).
- **Business impact:** VHC is the primary upsell mechanism in every competitor product (Tekmetric, AutoLeap, Shop-Ware) — a structured "we noticed your rear pads are at 20%" report, ideally photo-backed per item, is what turns a routine oil change into an approved brake job. Tecido has the photo infrastructure already (`compressImage`, `uploadJcImages` — index.html:4289 onward) but no checklist scaffolding to hang it on.
- **Recommended design:** A `vhc` sub-object on the job card: `{templateId, items:[{label, status: ok|advise|urgent|na, note, photoUrls[]}]}`, with a small set of default templates (general service, brake job, AC service) editable in Settings. Render as a traffic-light checklist in the job card and on the printed/PDF estimate.
- **Complexity:** M — mostly UI + a template list; reuses existing image upload plumbing.

---

**W9 — No QC / road-test gate before invoicing (High, complexity S)**

- **Evidence:** `calcJcStatus()` (index.html:4403-4412) moves a job card to `completed` the instant every work item's status is `done` — there is no intermediate `qc_pending`/`road_test` state, and no field to record who quality-checked the vehicle or what was verified.
- **Business impact:** Comebacks (customer returns because the fix didn't hold) are the costliest failure mode in a workshop; a mandatory second-set-of-eyes gate before the car leaves the bay is standard practice in every competitor product referenced below.
- **Recommended design:** Insert a `qc_pending` status between `completed` and `invoiced`; a lightweight checklist ("road test done", "no warning lights", "torque checked") plus `qcBy`/`qcAt`, gating the `→ Invoice` button (index.html:4184-4185) until cleared.
- **Complexity:** S.

---

**W10 — Invoice line items lack qty/unit price; no void/credit note (High, complexity M)**

- **Evidence:** Invoice items are `{description, cost}` only — see `convertToInvoice()` (index.html:4866) and `saveQuickInvoice()` (index.html:4818). "4 × brake pad @ QAR 75" cannot be represented; only a single lump `cost` per line. Credit adjustment exists only as a free-text note field (`creditNotes`, index.html:4948, 5159) — not a numbered, GL-postable document. No `voidInvoice()`/`cancelInvoice()` function exists anywhere in the file (confirmed by exhaustive grep).
- **Business impact:** Combined with W7, this means the invoice can never itemize a part sold with its own quantity and price — it's structurally a labour-only invoice today. And when a bill is wrong, staff have no correction path except manually adjusting cash entries in Finance, which breaks the invoice/GL tie-out the rest of the app works hard to maintain (server.js:273-320's atomicity is undermined by an out-of-band fix).
- **Recommended design:** `items:[{description, qty, unitPrice, lineTotal}]`; a `creditNotes` collection mirroring `invoices` (own sequence, own print template, negative GL posting); a `voidInvoice()` action (admin-only) that flips status to `void` and reverses any posted GL/stock effects.
- **Complexity:** M.

---

**W15 — No service reminders or feedback capture (High, complexity S/M)**

- **Evidence:** Exhaustive grep for "reminder", "next service", "feedback", "rating", "review" in `public/index.html` returns no functional matches (only cosmetic CSS class names). Vehicles have no `nextServiceDue` (date or mileage) field (see vehicle form, index.html:1119-1141) and there is no scheduled job/notification mechanism client- or server-side.
- **Business impact:** Reminders are one of the highest-ROI, lowest-effort retention features in this category — every competitor listed below ships them. Zero implementation cost is being left on the table given WhatsApp deep-linking already exists for ad-hoc contact (index.html:3186).
- **Recommended design:** Add `nextServiceDueDate`/`nextServiceDueKm` to the vehicle record (auto-computed from job-card completion + a configurable interval), a "Due this week" dashboard widget, and a manual "Send Reminder" action reusing the existing `wa.me` pattern before investing in a real messaging API (see B-table below for the fuller two-way SMS/WhatsApp recommendation).
- **Complexity:** S for the due-date + dashboard list; M if wired to outbound WhatsApp/SMS automatically.

---

**W12 — Gate pass signature is unrecorded (Medium, complexity S)**

- **Evidence:** `renderGatePass()` (index.html:5191-5271) prints `'Signature: ___________________'` (index.html:5259-5266) as static text — there is no signature-capture widget and nothing is persisted about who released or received the vehicle.
- **Recommended design:** Same signature-pad component recommended for W5 (estimate approval), reused here; store `releasedBy`/`receivedBy` + signature image URL on the job card.
- **Complexity:** S (once the signature-pad component exists for W5).

---

## B. Competitor Gap Analysis

Benchmarked against Tekmetric, AutoLeap, Shop-Ware, Mitchell 1, GaragePlug, Torque360, Odoo Automotive, and
ERPNext — the products that define "table stakes" for a modern garage ERP in 2026.

| Feature | Present? | Priority | Business impact | Recommended implementation | Complexity |
|---|---|---|---|---|---|
| Digital Vehicle Inspection (DVI) with photo-tagged checklist | **No** — only free-text complaints + untagged photos (index.html:1330-1341) | **P0** | Lost upsell revenue; no defensible record of pre-existing damage | See W4 above | M |
| Estimate/quotation with customer e-approval | **No** | **P0** | Billing disputes, unauthorized-repair risk | See W5 above | M |
| Parts on job card with automatic stock deduction & COGS | **No** — confirmed structural gap (W7) | **P0** | Margin invisible; stock walks out the door unbilled | See W7 above | L |
| Labour-time / standard-operations catalogue (flat-rate guide) | **No** — every work description is free-typed each time (index.html:4047) | **P1** | Slower job-card entry, inconsistent pricing/quoting across advisors | A reusable `serviceCatalogue` collection (`{name, defaultLabourHrs, defaultPrice, category}`) with a searchable picker replacing the free-text `description` input | M |
| Parts catalogue / supplier price-list integration | **No** — `supplier` is a free-text string per part (index.html:1281); no supplier entity | **P1** | No PO automation, no price comparison, typo'd supplier names fragment the GL supplier report (`renderGlSupplier`, index.html:6306) | `suppliers` master table + FK from `parts.supplierId`; defer live catalogue/EDI integration | M |
| Customer approvals via SMS/link | **No** | **P0** | See W5 | SMS gateway (e.g., Twilio) sending an approval link that hits a public, token-scoped estimate-approval endpoint | M |
| Two-way SMS/WhatsApp | **No** — WhatsApp is a one-way `wa.me` deep link only (index.html:3186), not an integrated channel; no SMS at all | **P1** | Manual phone tag for every status update; no automated "your car is ready" | WhatsApp Cloud API or Twilio integration for outbound status + inbound webhook for replies | L |
| Appointment scheduling with bay/resource assignment | **Partial** — week calendar exists (index.html:3494-3524) but no bay, lift, or technician-capacity concept; double-booking is possible | **P1** | No way to see workshop capacity before promising a slot | Add `bayId`/`estimatedDurationMin` to appointments; render a per-bay timeline, not just a per-day list | M |
| Technician efficiency / productivity reporting | **Partial** — job count + revenue per tech exists (`renderTechReport`, index.html:7492-7535); actual time-per-job (`w.timeTaken`, captured at index.html:7830-7838) is **never surfaced** in any report | **P1** | Cannot identify slow/fast technicians, cannot benchmark billed-hours vs actual-hours, cannot support commission/incentive schemes | Add `estimatedHours` to work items; compute actual-vs-estimated variance and utilization % into the existing technician report | S–M |
| Fleet/corporate accounts & credit limits | **No** — customer record has only name/phone/WhatsApp/email/address (index.html:1104-1111) | **P0** | Cannot safely extend credit to a taxi/logistics fleet — the single highest-value repeat-customer segment for most garages | Add `accountType: individual|corporate`, `creditLimit`, `paymentTermsDays`, block/warn on new job cards once `outstandingBalance > creditLimit` (aged-receivables data already exists, index.html:5573-5605, to compute this) | M |
| Warranty & service-plan tracking | **No** | **P2** | No way to flag "this repeat repair is under warranty, don't bill it" or track AMC/service-plan entitlements | `warranties` sub-collection on job card/part with expiry + coverage terms | M |
| Tyre/battery detail (brand, size, DOT/warranty date) | **No** — vehicle record has no tyre or battery fields at all (index.html:1119-1141) | **P1** | Common high-margin, high-recall-risk items (batteries especially) have no structured record for warranty claims | Add a small `tyres`/`battery` block to the vehicle record | S |
| Insurance-job workflow (approval, excess, insurer billing) | **No** | **P2** | Insurance work is a distinct billing party/approval workflow in most markets; currently indistinguishable from a normal cash job | New `payerType: customer|insurance` on job card/invoice with insurer name, claim/policy no., approval reference, excess amount | M |
| Multi-branch / multi-location | **No** — confirmed no `branch`/`outlet` concept anywhere in schema or UI | **P2** (P0 if a second location is planned) | Blocks any expansion beyond the single Tecido location as-is | Add `branchId` to every collection + branch-scoped auth; substantial, defer until expansion is concrete | L |
| Payroll / commission / incentives | **No** | **P2** | Technician revenue is visible (tech report) but nothing computes commission payable | Commission-rule engine on top of the existing tech-report revenue numbers | M |
| Loyalty programme | **No** | **P2** | Low urgency for a single-location workshop; higher value once reminders (W15) exist | Points/visit-count on customer record, redeemable as invoice discount | M |
| Review/reputation management (post-service review request) | **No** | **P2** | Missed opportunity to systematically collect Google reviews after a good delivery experience | Auto-send review link on `delivered` status via the same messaging channel as W15/reminders | S (once messaging exists) |
| Accounting-package integration (QuickBooks/Xero/Zoho Books export) | **No** — the in-app Finance module is the only ledger; `downloadBackup()` (index.html:5928-5939) exports raw JSON, not an accounting-import format | **P1** | Most garage owners still hand data to an external accountant; JSON export is not usable by them | CSV export matching QuickBooks/Xero journal-import schema for GL entries and invoices | S |
| Roles & permissions (advisor/manager/technician tiers) | **No** — one shared admin login (server.js:130-141) plus PIN-only technicians; advisors never authenticate at all | **P0** | No accountability for who approved a discount, voided an invoice (once it exists), or adjusted stock; single admin password is also a security exposure already flagged in the prior audit (A1/A12) | Introduce a `users` table with role (`owner/manager/advisor/technician`) and per-route permission checks in `server.js`'s `requireAuth` middleware | L |

---

## C. Garage-Domain Data Gaps

### Vehicle record (index.html:1119-1141, `v-add-vehicle` form)

| Field | Present? | Notes |
|---|---|---|
| Registration/plate | Yes | `v-reg` |
| VIN / Chassis | Yes | `v-vin` — **combined** field, no separate structured VIN |
| Make / Model | Yes | |
| Year / Color | Yes | |
| Current mileage | Yes | `v-mileage` |
| Fuel type | Yes | Petrol/Diesel/Electric/Hybrid dropdown |
| **Engine number** | **No** | Frequently required for insurance/registration paperwork in GCC markets |
| **Variant/trim** | **No** | Needed for correct parts lookup (e.g., Camry LE vs. SE have different parts) |
| **Tyre size/spec** | **No** | See B-table |
| **Battery details** | **No** | See B-table |
| **Insurance expiry / policy no.** | **No** | Common competitor field, drives renewal-reminder revenue |
| **Registration (Istimara) expiry** | **No** | High relevance in Qatar market specifically |
| **Next service due (date/km)** | **No** | Blocks W15 (reminders) entirely |
| Notes | Yes | Free text |

### Customer record (index.html:1104-1111, `v-add-customer` form)

| Field | Present? | Notes |
|---|---|---|
| Name / Phone | Yes | |
| WhatsApp / Email | Yes | |
| Address | Yes | Single free-text line, no structured area/city |
| **Fleet/corporate flag** | **No** | See B-table |
| **Credit limit / payment terms** | **No** | See B-table |
| **Blacklist / do-not-service flag** | **No** | No way to flag a chronic bad-debt customer at intake |
| **ID/trade-license documents** | **No** | No attachment slot for QID/CR copy — relevant for credit accounts and VAT-compliant B2B invoicing |
| **Tax registration number (customer TRN)** | **No** | Company settings capture *the garage's* VAT number (`set-vat`, index.html:5930) but nothing captures a B2B customer's TRN for a compliant tax invoice |

### Job card (index.html:4085-4141, `saveJobCard()`, and the work-item shape at index.html:4073-4076)

| Field | Present? | Notes |
|---|---|---|
| Vehicle/customer link, date in/out, mileage in, advisor | Yes | |
| Complaints (free text) + photos | Yes | Not tagged to specific checklist items |
| **Inspection checklist (VHC)** | **No** | See W4 |
| **Estimate/approval record** | **No** | See W5 |
| **Digital signature (customer or advisor)** | **No** | Printed blank line only, see W5/W12 |
| **Parts used** | **No** | See W7 — the single most damaging gap in the whole audit |
| Labour per work item: description, technician, status, cost | Yes | |
| **Labour hours: estimated vs. actual** | **Partial** | `w.startedAt`/`w.timeTaken` are captured by the technician portal (index.html:7812-7838) but never shown on the job card, invoice, or any report — the data exists and is simply thrown away downstream |
| **QC/road-test sign-off** | **No** | See W9 |
| Mileage out / delivery checklist | **No** | Only a `deliveredAt` timestamp implied via gate pass; no odometer-out or fluid-top-up checklist |

---

## Priority Summary (for planning)

**P0 — do first (structural, revenue-integrity, or safety-critical):**
1. Parts-on-job-card with atomic stock deduction (W7)
2. Estimate/quotation + customer approval capture (W5)
3. Appointment → Job Card conversion (W3)
4. Fleet/corporate accounts with credit limits
5. Roles & permissions (currently one shared admin login for the entire business)

**P1 — next (materially improves margin visibility and customer experience):**
6. QC/road-test gate (W9)
7. Invoice line qty/unit price + void/credit-note documents (W10)
8. VHC/inspection checklist (W4)
9. Service reminders (W15)
10. Technician time-vs-estimate reporting (data already captured, just needs surfacing)
11. Supplier master + basic PO/GRN
12. Labour/ops catalogue for consistent quoting
13. Accounting-package (QuickBooks/Xero) CSV export

**P2 — later (valuable but not blocking current single-location operations):**
14. Two-way SMS/WhatsApp integration
15. Bay/resource scheduling
16. Warranty/service-plan tracking, tyre/battery detail
17. Insurance-job workflow
18. Multi-branch
19. Payroll/commission engine, loyalty, reputation management

---

## Evidence index (key file:line references cited above)

- `server.js:38-49` — collection registry (no `suppliers`, `purchaseOrders`, `estimates`, `creditNotes` tables)
- `server.js:130-141` — single shared admin login (no per-user accounts)
- `server.js:273-320` — atomic payment recording (proven pattern to replicate for parts-on-invoice)
- `server.js:325-354` — atomic stock adjust (proven pattern, currently only reachable from the manual Adjust Stock screen)
- `db.js:20-42` — full schema (confirms absence of supplier/PO/estimate/credit-note tables)
- `public/index.html:1104-1111` — customer form (no fleet/credit-limit/blacklist/TRN fields)
- `public/index.html:1119-1141` — vehicle form (no engine no./variant/tyre/battery/insurance/next-service-due)
- `public/index.html:1281` — parts "Supplier" is free text, not a linked entity
- `public/index.html:2178-2185` — `JC_STATUS` (no estimate/QC stages)
- `public/index.html:3480-3596` — Appointments module (no conversion to job card)
- `public/index.html:3601-3608` — Inventory KPI card (stock value figure structurally unreliable given W7)
- `public/index.html:3718` — `openStockAdjust()`, the only place stock ever moves
- `public/index.html:4035-4084` — job-card work-item editor (labour only, no parts)
- `public/index.html:4085-4141` — `saveJobCard()`
- `public/index.html:4403-4412` — `calcJcStatus()`
- `public/index.html:4816-4854` — `saveQuickInvoice()` (counter-sale path, also labour-only)
- `public/index.html:4857-4883` — `convertToInvoice()` (items built from `jc.works` only)
- `public/index.html:4948, 5159` — `creditNotes` is a text note field, not a real document
- `public/index.html:5191-5271` — `renderGatePass()` (signature = printed blank line)
- `public/index.html:5912-5991` — Settings/company profile & VAT toggle
- `public/index.html:7492-7535` — `renderTechReport()` (no time-based efficiency despite data existing)
- `public/index.html:7677-7838` — technician portal work timer (`startedAt`/`timeTaken` captured, unused downstream)
