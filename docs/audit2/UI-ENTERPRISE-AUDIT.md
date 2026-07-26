# Enterprise UI/UX Audit & Improvement — VIWO Garage ERP
**Date:** 2026-07-26 · **Benchmark:** SAP Fiori · Dynamics 365 · Oracle Fusion · Odoo Enterprise · Tekmetric · AutoLeap · GaragePlug
**Method:** live audit in headless Chrome across all screens; issues fixed and re-tested in place (Find → Fix → Re-test).

## Executive summary
The app entered this pass already well above typical CRUD quality — a mature design-token system, an enterprise `.data-table` primitive, skeleton loading, breadcrumbs, a ⌘K command palette, consistent brand theme, and rich list screens (KPI cards + filter pills + status chips + progress bars). This pass closed the specific enterprise-table interactivity and accessibility gaps that separated it from SAP-Fiori-class software, and added data export.

**Overall UI maturity: 82/100** (was ~72 pre-pass). Remaining gaps are advanced-grid (column chooser/freeze/inline-edit) and density options — nice-to-have, not blockers.

---

## Improvements implemented this pass (shipped + verified)

### 1. Enterprise data tables (app-wide, commit 4068985)
Every `.data-table` in the app — 30+ list and report screens — upgraded via ONE delegated behaviour layer, no per-renderer changes:
- **Click-to-sort columns** with asc/desc toggle, a directional indicator, and the active column highlighted in the brand accent. Numeric-aware: reads leading numbers/money even behind a status badge ("0 Out", "3 Low") while codes (INV-0001, 5W-30) sort as text. Verified: Stock → 0,3,6,15,24,30 and reverses; Part → alphabetical.
- **Sticky headers** within a viewport-bounded scroll region; print stylesheet resets so documents print in full.
- **Keyboard-operable rows** — `.dt-row` gets tabindex/role + Enter/Space activation + a visible focus ring (WCAG 2.2 keyboard + focus).
- **CSV export** (Excel-friendly, BOM-prefixed) on Inventory and Customers via a reusable `exportCsv()`.
- A `MutationObserver` re-applies the behaviour to freshly rendered tables.

### 2. Accessibility (commit a25af4b)
- **Unified Escape**: one handler closes any open modal topmost-first — payment, GL entry, JC lookup, ⌘K palette, and every dynamic `.dlg-overlay` (confirm, stock adjust, issue part). Verified.
- **Contrast**: advisor "Inactive" text raised from #94A3B8 (2.56:1, fails) to #64748B (AA).

---

## Per-screen scorecard (current state)

| Screen | UI | UX | A11y | ERP-fit | Notes |
|---|---:|---:|---:|---:|---|
| Login | 90 | 88 | 85 | 88 | Split hero, role tabs, brand intro; strong aria on the form |
| Dashboard | 82 | 80 | 78 | 80 | KPIs, pipeline, cash-flow chart, tech status; could add quick-actions row |
| Job Cards (list) | 88 | 86 | 82 | 88 | KPIs + status breakdown + filter pills + sortable rich table — Tekmetric-class |
| Job Card (detail) | 86 | 85 | 80 | 86 | Service-order layout, works + parts + DVI + progress |
| Inventory | 87 | 85 | 82 | 86 | KPIs, filter pills, sortable table, CSV export |
| Estimates | 82 | 82 | 80 | 82 | Quote→approve→convert; line editor |
| Workshop board | 80 | 82 | 70 | 80 | Kanban; touch drag-drop still a gap |
| Finance hub | 85 | 84 | 82 | 86 | Grouped actions (Record/Ledgers/Statements/Analysis) |
| Reports (TB/BS/P&L/CF/AR/AP/VAT) | 84 | 82 | 82 | 84 | `.data-table` + tokens, sortable, printable, balanced books |
| Suppliers / Purchases | 82 | 82 | 80 | 82 | Master + PO with atomic receive |
| Settings | 82 | 82 | 80 | 82 | Company/financial/security/backup/activity |
| Technician portal (PWA) | 80 | 82 | 76 | 80 | Live timers; now installable |

---

## Top remaining UI/UX recommendations (not blockers)
1. **Advanced grid**: column chooser, freeze first column, drag-reorder, inline edit, saved views (Fiori/Dynamics parity).
2. **Bulk actions** on lists (multi-select + batch status/export).
3. **Density toggle** (comfortable / compact) for 8-hour power users.
4. **Dashboard quick-actions row** + pending-approvals + workshop-occupancy tile.
5. **Touch drag-drop** on the workshop kanban (pointer events fallback).
6. **Global "recent / favourites"** in the command palette.
7. **Server-backed export** for very large lists (client CSV is fine at current scale).
8. **Full focus-trap** in modals (Escape + focus-in are done; Tab-cycle containment remains).

## Compliance notes
- **Design system consistency**: one token set, one table/button/modal/form style — consistent across all screens after prior sprints.
- **Navigation**: consistent sidebar + breadcrumbs + ⌘K + notifications; depth ≤ 2 to any screen.
- **Performance**: gzip on responses, indexes, cache-patch writes (see performance-db.md); tables render <100ms at current data.
- **Responsive**: 0 page-level horizontal scroll across 20+ screens; finance tables scroll within `.dt-scroll`.

## Go-Live UI checklist
- [x] Consistent design tokens & primitives · [x] Sortable/sticky enterprise tables · [x] Keyboard-operable rows · [x] Escape closes all modals · [x] Breadcrumbs on every view · [x] Skeleton loading on lists · [x] Empty states · [x] Print stylesheet hides chrome · [x] CSV export on key lists · [x] Brand theme + PWA installable
- [ ] Column chooser / freeze / inline-edit · [ ] Bulk actions · [ ] Density toggle · [ ] Touch kanban · [ ] Full modal focus-trap
