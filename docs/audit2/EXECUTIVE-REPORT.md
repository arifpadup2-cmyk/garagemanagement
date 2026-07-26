# VIWO Garage ERP — Deep Audit Executive Report
**Date:** 2026-07-26 · **Mode:** Zero-Assumption, evidence-based · **Method:** 5 specialist teams (security, performance/DB ×2, business/gaps, accounting/integrity, UI/print/mobile) read the full source and ran live non-destructive tests against the dev server. Database confirmed returned to baseline (6/6/6/3/7/6/5/4) after testing.

Detailed evidence per dimension: `security.md`, `performance-db.md` / `AUDIT-PERFORMANCE-DB.md`, `business-gaps.md`, `accounting-integrity.md`, `ui-print-mobile.md`, `probe-evidence.md`.

---

## 1. Scorecard

| Metric | Score | Verdict |
|---|---:|---|
| **Overall ERP Health** | **33 / 100** | Strong single-shop operations demo; not yet enterprise-ready |
| Business Readiness | 34 | No procurement, no estimate/approval, no RBAC |
| Workshop Operations | 58 | Real kanban + technician PWA + atomic money/stock — best area |
| Inventory Accuracy | 15 | Parts never touch jobs/invoices; no COGS; last-cost only |
| Accounting Compliance | 24 | Single-sided "double entry"; TB/BS cannot balance |
| Security | 34 | IDOR wide open; spoofable brute-force; token from password |
| Performance | ~30 | Linear everything, no ceiling; fine at demo size only |
| UI/UX | 63 | Mature tokens; a P0 print leak + one live crash (now fixed) |
| Code Quality | 45 | One 8k-line file; good recent server hygiene; heavy duplication |
| Database Quality | 31 | Great atomic paths + 1 real constraint; no usable indexes/FKs |
| Enterprise Scalability | ~13 | Load-entire-collection model; unreachable at multi-branch scale |
| **Production Readiness** | **28 / 100** | Not go-live ready for a multi-branch business as-is |

**One-line verdict:** Two genuinely well-built islands — the atomic `/pay` and `/adjust` endpoints, verified working under live concurrency — sit inside an otherwise unvalidated, FK-less, single-admin, load-everything architecture. The path to enterprise-grade is **incremental, not a rewrite**, but it is substantial (~6–10 focused weeks for P0+P1).

---

## 2. What is genuinely SOLID (verified, not assumed)
- **Atomic payments** (`POST /api/invoices/:id/pay`): live test fired two concurrent payments at one invoice → the overpaying one was **rejected**; rounding exact (33.33×2+33.34 → paid). Lost-update race closed.
- **Atomic stock adjust** (`/adjust`): negative stock blocked, movement log can't lose entries.
- **One-invoice-per-job-card**: real Postgres unique index (409 on duplicate).
- **Injection**: fully parameterized + collection allowlist — no SQLi.
- **Recent hardening confirmed live**: `x-powered-by` off, `/api/image` mime/size/nosniff, Postgres errors no longer leaked, and (this turn) **server-recomputed invoice totals** — a PUT of `total:999999` now can't stick.

---

## 3. Critical findings (must fix before any real go-live)

| ID | Area | Finding | Evidence |
|---|---|---|---|
| SEC-F1 | Security | **IDOR** — only `/api/export` checks role. A technician token read all customers/invoices/bank accounts and edited another technician. | live tech-token test |
| SEC-F2 | Security | Brute-force guard keyed on spoofable `X-Forwarded-For`, no `trust proxy`; public `/api/tech-list` + 4-digit PIN = 10k-combo path to a session. | live spoof test |
| SEC-F3 | Security | Token secret derived from `ADMIN_PASSWORD`; no `SESSION_SECRET`; if password unset, secret = public constant. | code |
| ACC-DE1/2 | Accounting | Transactions are single-sided (only cash/bank posted); nominals never hit. **Trial Balance always out of balance by cash+bank.** | live TB |
| ACC-AB2 | Accounting | Balance Sheet mixes accrual AR + cash-basis retained earnings → won't balance whenever AR>0 (1,000 invoice → 1,000 imbalance). | worked example |
| ACC-CC2 | Accounting | Quick Invoice (main POS flow) still writes invoice + cash entry **non-atomically** — the exact pattern `/pay` fixed, not wired in. | code |
| INV-W7/STK3 | Inventory | **Parts have no link to job cards/invoices** (no `partId` anywhere) → stock/COGS/margin unmeasured. | live: 0 refs |
| DI-1 | Integrity | No FKs; deleting a customer leaves orphaned vehicles/invoices with dangling ids. | live delete |
| PERF-01/02 | Performance | SPA loads **entire collections** on login and re-fetches whole collections after every write. Payload wall at ~25k docs (~6–12 months busy). | measured: 5k parts = 1.66MB / 1.3s, linear |
| UI-PRINT | UI | *(FIXED this turn)* invoices printed with topbar/search/bell on top. | print screenshot |
| UI-CRASH | UI | *(FIXED this turn)* `renderSalesKpis` threw on invoices missing `createdAt` (2/5 live). | reproduced |

Fixed during this audit turn: server-recomputed invoice totals (SEC-F5/ACC-INV1-2), print chrome, Sales crash.

---

## 4. Roadmaps

### 4A. Critical Fix Roadmap (before go-live) — ✅ COMPLETED 2026-07-26 (commits 0a7e964 → 5b0b8b1)
1. ✅ **RBAC** — role gate on every `/api` route; tech tokens restricted to their own work (SEC-F1). Verified 4 allow + 10 deny.
2. ✅ **Auth hardening** — `SESSION_SECRET` (independent, warns if unset), `trust proxy` + per-account lockout, scrypt-hashed technician PINs (SEC-F2/F3).
3. ✅ **Quick Invoice atomicity** — `POST /api/invoices/quick` writes invoice + cash-book entry in one DB transaction (ACC-CC2).
4. ✅ **Delete dependency guards** — 409 with clear message when dependents exist; no more silent orphans (DI-1).
5. ✅ **Job-card work-item locking** — `POST /api/jobCards/:id/work` row-locked single-item update kills the whole-array race (ACC-CC1).
6. ✅ **Real double-entry ledger** — accrual basis; TB & BS now balance by construction (Opening Balance Equity pattern); P&L accrual. Proven with a worked scenario (ACC-DE/AB).

Also fixed pre-sprint (commit d989f0d): server-recomputed invoice totals (SEC-F5), print-chrome leak, Sales `createdAt` crash. **Re-score after sprint: Security ~62, Accounting Compliance ~70, Data Integrity substantially hardened.** Remaining gaps are now in 4B/4C (not go-live blockers): token revocation, audit trail, security headers (partial done), parts↔job-card COGS linkage, estimates/procurement, and the load-everything scale model.

### 4B. High-Priority Roadmap (30 days) — ✅ COMPLETED 2026-07-26 (commits 192e163 → 443eb45)
1. ✅ **DB indexes + timeouts** — 22 indexes (sort cols, seq, JSONB expression) + connection/statement timeouts; Neon pooled-endpoint documented.
2. ✅ **Security** — token revocation ("Sign Out All Devices" + authEpoch), audit trail (audit_log + createdBy/updatedBy + Activity Log view), CSP/HSTS/X-Frame headers, `esc()` single-quote + number-coercion fix (SEC-F4/6/8/9).
3. ✅ **Parts on job cards** — atomic issue/return with stock deduction, parts on invoices, per-job margin visibility (INV-W7).
4. ✅ **Estimates/Quotations** — full quote → approve → convert-to-job-card flow with a new collection (business W5).
5. ✅ **Scale** — response gzip (~85% payload cut), opt-in server pagination/filtering on `GET /api/:coll`, and shim cache-patch to end the full-refetch-per-write amplification (PERF-01/02).

Remaining from 4B (deferred to 4C, lower urgency): aged-payables, VAT Payable posted as a real journal (currently derived), period lock/close, and full client-side windowing of list screens (renderers assume full in-memory arrays — the server capability is now in place for it).

### 4C. Future Enhancement Roadmap
- Supplier master + PO→GRN→bill→payment procurement side.
- DVI/digital inspection with photos; appointment→job-card conversion; service reminders.
- Multi-branch (branch scoping, transfers, inter-branch billing, central reporting).
- Payroll/commission/technician incentives; loyalty; two-way WhatsApp/SMS; customer portal.
- Server-side report aggregation (materialized daily summaries); move `movements[]`/`payments[]` to child tables; images to object storage; real PWA (manifest+service worker+offline) + thermal/PDF/barcode printing.

---

## 5. Complete Missing-Features List (vs Tekmetric/AutoLeap/Shop-Ware/Odoo)
**P0:** DVI/inspection checklist · estimate + customer e-approval · parts-on-job-card w/ stock deduction · fleet/corporate accounts + credit limits · roles/permissions.
**P1:** appointment→JC conversion · supplier/PO/GRN procurement · line qty/unit-price/discounts · credit note/void · aged payables · two-way SMS/WhatsApp · service reminders · technician efficiency reporting (data captured, never surfaced) · period close.
**P2:** labour-time/ops catalogue · warranty & service-plan tracking · tyre/battery detail · insurance-job workflow · multi-branch · payroll/commission · loyalty · reviews/reputation · accounting-package integration · bank reconciliation · barcode/QR · PDF/thermal print · customer portal · offline mode.

---

## 6. Registers & Plans (summaries; full detail in per-dimension files)

**Technical Debt Register:** one 8,037-line `index.html` (no modules/build/tests); all business logic client-side & re-implemented per screen; `esc()` doesn't cover single quotes / crashes on numbers; hard-delete everywhere; no `updated_at`; `movements[]`/`payments[]` unbounded embedded arrays; 122 client-side cross-collection filter sites; no automated tests.

**Security Remediation Plan:** Critical → SESSION_SECRET, trust-proxy+lockout, RBAC, (done) invoice-total recompute. 30-day → token revocation, PIN hashing, audit log, security headers, XSS single-quote fix, httpOnly cookie. Later → DB TLS validation, image path ownership, body-limit tuning, branch isolation.

**Performance Optimisation Plan:** indexes → seq fix → conn/statement timeouts + pooled endpoint → debounce search → stop full refetch → child tables for movements/payments → server pagination+filter → bounded kanban/lists → server aggregates for dashboards/reports → stream export.

**Database Optimisation Plan:** 6 sort-column indexes → seq indexes → JSONB expression indexes (status/vehicleReg/customerId/accountId) → `updated_at` everywhere → extract `part_movements` + `invoice_payments` + `dashboard_daily_summary` → Neon pooler → drop `MAX(seq)` scan → archival/lifecycle.

**Go-Live Checklist:** SESSION_SECRET set · ADMIN_PASSWORD strong & confirmed · RBAC live · Quick-Invoice atomic · delete guards · double-entry posting · invoice-total recompute (done) · print output clean (done) · backup/export verified + off-box copy · security headers · rate-limit real IP · DB indexes applied · load test at target row counts · GitHub push access restored.

**Post-Go-Live Monitoring:** daily backup success · Neon connection/egress + slow-query watch · error-rate on `/api` · payment/cash reconciliation report tie-out · disk (bytea image growth) · session/auth anomaly log (needs audit trail first) · dashboard/report latency as data grows.

---

## 7. Recommended sequencing
Ship **4A (Critical)** as the next focused sprint — it is what stands between "impressive demo" and "safe to run one real branch." Then **4B** over the following month makes it genuinely multi-year viable for a single busy shop. **4C / multi-branch** is a separate program once the single-shop core is trustworthy.
