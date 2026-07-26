# UI/UX + Accessibility + Print/Output Audit — VIWO (Tecido Garage Management)

**Date:** 2026-07-26
**Scope:** `public/index.html` (~8,037 lines, vanilla JS SPA), `public/brand/intro.js`, dev server `localhost:3010`.
**Method:** static code audit (grep/read of source) + live verification in headless Chrome
(playwright-core, `channel:'chrome'`) at 1440px, 1024px, 390px, print-media emulation, and
computed WCAG contrast ratios for the brand-blue token set. Screenshots captured to a local
scratch folder during the session (not shipped with this repo).

This audit follows the 2026-07-26 ERP-standard audit (`docs/ERP-AUDIT-2026-07-26.md`), which
covered feature/data/financial-integrity gaps. This report covers **UI, accessibility, print
output, and mobile/field use** specifically, post-VIWO-rebrand.

---

## Verdict up front

The rebrand and enterprise-primitive rollout (`.data-table`, toasts, `confirmDialog`, skeletons,
brand tokens) is real and mostly well executed — desktop and mobile layouts do **not** horizontally
scroll on any of the 20+ screens tested at 1440/1024/390px, the brand-blue palette passes contrast
almost everywhere it matters, and most modals now have `aria-modal` + Escape. But three things pull
the score down hard:

1. **Printing is unfinished, not just "basic."** There is exactly one `@media print` block (10 lines)
   in the whole app, and it does not hide the sticky app-shell top bar. Printing an invoice or a
   Trial Balance currently prints the breadcrumb, the ⌘K search box, the **+New** button, the
   notification bell (with its unread badge), and the profile menu **on top of the document** — this
   was verified visually, not inferred. For a garage that hands printed invoices/gate passes to
   customers, this is the single biggest finding in the report.
2. **A verified live bug**: the Sales hub throws an uncaught `RangeError` and fails to render at all
   (KPIs *and* the invoice list) the moment any invoice has a missing/invalid `createdAt` — which is
   true today for 2 of the 5 invoices in the connected dev database, with zero on-screen error.
3. **The mobile bottom-nav is dead code.** A later `@media(max-width:768px){#bottom-nav{display:none!important}}`
   rule (added during the VIWO mobile-home rebuild) silently overrides the earlier `display:block`
   rule for the same selector. Confirmed via computed style at 390px: `display: none`. The bar still
   renders in the DOM with working click handlers — it is simply invisible.

---

## 1. Responsiveness

| ID | Screen | Severity | Evidence | Fix | Priority |
|----|--------|----------|----------|-----|----------|
| R1 | **Mobile bottom-nav (all sections)** | **High** | Two conflicting rules for the same selector, both inside `@media(max-width:768px)`: `index.html:638` → `#bottom-nav{display:block}`, then `index.html:725` → `#bottom-nav{display:none!important}` (added later, inside the "MOBILE HOME SCREEN" block). The `!important` + later source order wins outright. Verified live: `getComputedStyle(#bottom-nav).display === 'none'` at 390×844. The bar's HTML (`index.html:957-965`), 7 `bnav-item`s and their `onclick="navTo(...)"` handlers, and the active-state sync in `navTo()` are all still present and functional — just invisible. | Delete the `display:none!important` override at `index.html:725`, or if hiding it specifically on the mob-home screen was the intent, scope it: `.on-mob-home ~ #bottom-nav{display:none}` (scoped to the home screen only, not the whole ≤768px range). | **P0** — currently the only persistent way to jump between sections on mobile is the back button + home-tile grid; users mid-task in Job Cards cannot jump straight to Sales. |
| R2 | Finance sub-reports on mobile (Trial Balance, verified; same primitive used by P&L/BS/GL/Cash Flow/Aged/VAT) | Medium | `.dt-scroll{overflow-x:auto}` (`index.html:455`) has no visual scroll affordance (no edge fade/shadow). Measured live on Trial Balance at 390px: `.dt-scroll` `scrollWidth=380` vs `clientWidth=364` → 16px of the **Credit** column is off-screen with nothing on screen to suggest it's swipeable. Screenshot confirms the header reads "…DEBIT / CRED" with the value clipped mid-word. | Add a `mask-image` fade or a thin drop-shadow on `.dt-wrap`'s trailing edge when scrolled short of `scrollWidth`, driven by a scroll listener toggling a `.has-more` class; or, for 3-4 column financial tables specifically, stack Debit/Credit as two lines under the account name below ~420px instead of relying on horizontal scroll. | P1 |
| R3 | Finance suite reachability on mobile | Low (informational — mostly fine) | The Finance hub **is** reachable without the bottom-nav: `MOB_TILES` (`index.html:2272-2283`) includes a "Finance" tile → `navTo('accounts')` → the Finance hub screen exposes General Ledger / Customer Accounts / etc. as list rows (captured in `390-accounts-onclicks.json` during this audit). So R1 is a navigation-*friction* regression, not a reachability blocker. | n/a — just confirms R1's blast radius is "extra taps," not "unreachable." | — |
| R4 | Topbar breadcrumb at 1024px (tablet) | Low | `.tb-crumb{white-space:nowrap;min-width:0}` + `.tb-crumb-here{overflow:hidden;text-overflow:ellipsis}` (`index.html:169-172`). At 1024px, sidebar (230px, always visible ≥768px) + `.tb-search{flex:1;max-width:440px}` leave too little room; screenshot shows "Workshop Board" truncated to **"Wor…"**. The search box wins the flex fight over the breadcrumb. | Give `.tb-crumb` a `flex-shrink:0` minimum reserved width (e.g. `min-width:160px`) before `.tb-search` is allowed to grow, or drop `.tb-search`'s width at ≤1180px. | P2 |
| R5 | Workshop kanban — layout | Pass (noted for completeness) | `.wb-board{display:flex;overflow-x:auto;-webkit-overflow-scrolling:touch}` (`index.html:488`) genuinely works: verified at 390px and 1024px, columns swipe smoothly, no body-level horizontal scroll at either breakpoint. | — | — |
| R6 | General horizontal-scroll sweep | Pass | `document.documentElement.scrollWidth` vs `clientWidth` checked on Dashboard, Finance hub, Trial Balance, P&L, Balance Sheet, General Ledger, Chart of Accounts, Cash Flow, Aged Receivables, VAT Summary, Customer Accounts, Workshop, Job Cards, Inventory at 1440/1024/390 — **zero page-level overflow** on any of them. | — | — |

---

## 2. Accessibility

| ID | Screen | Severity | Evidence | Fix | Priority |
|----|--------|----------|----------|-----|----------|
| A1 | **All clickable list/table rows** (Job Cards, Customers, Vehicles, Vehicle history, `.data-table` rows across every report, `.mob-home-tile` grid) | **High** | Zero `tabindex` attributes and zero `role="button"` anywhere in the 8,037-line file (`grep -c tabindex` = 0, `grep -c 'role="button"'` = 0). Rows are `<div class="list-item" onclick="openJobCardById(...)">` (`index.html:2813`, `:3116`, `:3167`, `:5298`) or `<tr class="dt-row" onclick="...">` (8 uses, e.g. `index.html:3145`). A keyboard-only user cannot Tab to a row or activate it with Enter/Space — mouse/touch only. | Add `tabindex="0" role="button"` to each row template plus a shared `onkeydown="if(event.key==='Enter'||event.key===' ')this.click()"` (or one delegated listener on the list container) — a single helper function can be threaded through all ~6 row-template functions. | **P0** for a system with technicians/advisors who may use keyboard or switch-access devices. |
| A2 | `confirmDialog` (destructive-action confirm, used app-wide) | Medium | `index.html:2530-2549`. Has `role="alertdialog" aria-modal="true"` (`:2537`) and focuses the confirm button on open (`:2548`) — good. But **no Escape-to-close**: the only global Escape listeners are scoped to `#pay-modal-overlay`/`#gl-entry-overlay` (`:2402-2408`), `#cmdk` (`:2505-2508`), and `#jc-modal-overlay` (`:5280`) — `#gms-confirm` is not covered by any of them. Click-outside-to-close does work (`:2535`). | Add `#gms-confirm` to the shared Escape handler at `index.html:2402`, or better, consolidate all four modal-Escape checks into one generic "close whatever's open" listener instead of four separate ad-hoc ones (reduces the chance of a fifth modal being added later and forgotten). | P1 |
| A3 | "Vehicle Not in System" / JC lookup modal (`#jc-modal-overlay`) | Low-Medium | `index.html:2074`. Has click-outside close and Escape close (`:5280`) — but **no `role="dialog"`/`aria-modal="true"`**, unlike the payment/GL/cmdk/confirm modals. Screen-reader users get no indication this is a modal dialog. | Add `role="dialog" aria-modal="true" aria-labelledby="jc-modal-title"` to the overlay div. | P1 |
| A4 | All modals (payment, GL entry, confirm, JC lookup) | Low (systemic, not urgent) | None trap focus — Tab can leave the dialog and reach the page behind it (`document.activeElement` after open only checked/forced once, on cmdk and confirmDialog's OK button; nothing re-traps on subsequent Tabs). | Low priority given the app is admin-single-tenant today, but worth a follow-up pass (a ~15-line generic `trapFocus(container)` helper reused across all four). | P2 |
| A5 | Un-migrated legacy gray — contrast regression | **Medium-High** | The prior audit fixed `--t3` from `#94A3B8` (2.56:1, fails AA) to `#556173` (**6.28:1**, verified by this audit's own contrast calc, passes AA/AAA). But the raw hex `#94A3B8` is still hardcoded in **12 places** that were never migrated to the token: `index.html:2179-2180` (JC_STATUS pending), `:2195` (off_duty), `:2997`, `:3030` (stat-row dots — decorative, fine), `:3349`, `:3424`, `:7164` (filter-pill dots — decorative, fine), `:4440` (**Service Advisor "Inactive" status — used as literal text color for the avatar initials**, not just a dot), `:5347` (vehicle fuel-type legend), `:7644-7645` (technician portal status dots). Line `:4440` is the real problem: `color:'+statusColor+'` is applied to the 2-letter initials text inside the avatar circle for inactive advisors — measured contrast **2.56:1**, a genuine WCAG AA failure on real text, reproducing the exact bug the earlier `--t3` fix was meant to close. | Replace `'#94A3B8'` with `var(--t3)` at `index.html:4440` (and audit the other 11 for the same text-vs-decorative distinction — the dot/pill uses are fine to leave, since WCAG contrast applies to text and meaningful graphics, not small decorative dots). | P1 |
| A6 | `--accent` (#3478FF) used as small body text | **Medium** | Computed contrast of `#3478FF` on white = **3.98:1** — passes the 3:1 large-text/UI-component threshold but fails the 4.5:1 normal-text threshold. It's used correctly at large/bold sizes (e.g. gate-pass number at 20px/800, `:5219`) but also at **11px** regular-ish weight in customer/vehicle preview captions: `index.html:3830` (`font-size:11px;color:var(--accent);font-weight:600`), `:4701` (same pattern on the invoice screen), and `:7273` (11px/700 "PARTIAL" KPI label). All three are below the 14px-bold / 18.66px-regular "large text" cutoff, so they need 4.5:1 and only get 3.98:1. | Swap to `var(--accent-text)` (#1D4ED8, **6.70:1**, already used for the primary button and passes everywhere) for any accent-colored text under ~14px/bold. Reserve `--accent` itself for borders, backgrounds, icons, and large/bold numerals. | P1 |
| A7 | Reduced-motion coverage — gaps | Medium | Most animation is properly gated (11 `@media(prefers-reduced-motion:reduce)` blocks covering toasts, dialogs, cmdk, view-transitions, skeleton shimmer, dashboard bars, progress fills — `index.html:117,195,219,242,249,320,404,413,427,452,471,486`). But `@keyframes deadline-blink` (`:567`, used on overdue job-card deadline badges), `alarmPulse` (`:570`, notification-bell red pulse ring), and `bellShake`/`notifIn` (`:571-572`, bell shake + notification-panel pop-in) have **no** reduced-motion guard. These are exactly the kind of insistent, high-frequency animations (scale/opacity pulsing, rotation shake) that vestibular-sensitive users need to be able to turn off. | Add `@media(prefers-reduced-motion:reduce){.deadline-blink,.notif-alarm{animation:none}}` etc. for the three unguarded keyframes. | P1 |
| A8 | Form validation feedback | Low | Validation is toast-only, e.g. `saveCustomer()` (`index.html:3217-3221`): `if(!name){toast('Please enter customer name.');return;}`. No `aria-invalid`, no red border on the offending field, no `.focus()` redirect to it — `grep -c aria-invalid` = 0 app-wide. Functionally fine (the toast is readable, informative, and consistently used — no raw `alert()`), but a screen-reader user gets a transient toast with no persistent association to the field that failed. | For the ~15 validated forms, add `field.setAttribute('aria-invalid','true')` + `field.focus()` alongside the existing `toast()` call; low effort since the validation call sites are already centralized per form. | P2 |
| A9 | cmdk (⌘K palette) | Pass | `role="dialog" aria-modal="true"` (`:1020`), input auto-focused on open (verified live: `document.activeElement.id === 'cmdk-input'`), Escape closes it (verified live: overlay's `.open` class removed after `Escape`). Solid implementation. | — | — |
| A10 | Payment / GL-entry modals | Pass (previously fixed, re-verified) | `role="dialog" aria-modal="true" aria-label="Record Payment"` / `"Ledger Entry"` (`:2053`, `:2086`); Escape closes both (`:2402-2408`). Matches what the prior audit's D3 batch claimed — confirmed still true. | — | — |

---

## 3. Consistency

| ID | Finding | Severity | Evidence | Fix | Priority |
|----|---------|----------|----------|-----|----------|
| C1 | `.works-tbl` primitive still in use | Informational, not a defect | 2 live usages remain (`index.html:4060`, `:4783`) — the **editable** job-card / quick-invoice work-item tables (inline `<input>`/`<select>` per row). These are a different use case from the read-only report tables that were migrated to `.data-table` (the prior audit's D-batch correctly left these alone). Not a real inconsistency; noting only because the class name might read as "leftover legacy" at a glance. | No action needed — could rename the class for clarity (`.edit-tbl`) but purely cosmetic. | P2 |
| C2 | Raw hex vs. token creep | Medium | ~150+ raw hex literals remain outside `:root` (status colors, badge accents, one-off inline styles) — expected in a codebase this size, and the load-bearing instances (badges, brand tokens) are all correct. The concrete regressions are A5/A6 above (raw `#94A3B8` and misapplied `--accent`), which are the ones that actually fail contrast — the rest is stylistic debt, not a defect. | Track as backlog cleanup, not urgent. | P2 |
| C3 | Button-order / empty-states / skeletons | Pass | Sampled Job Cards, Sales, Inventory, Finance hub, Trial Balance, Workshop — consistent primary-right `.btn-group` order, consistent `.empty` inbox-icon empty states, skeletons present on first paint for the KPI/list sections checked. Matches what the prior C/D remediation batch claimed. | — | — |

---

## 4. UX friction

| ID | Screen | Severity | Evidence | Fix | Priority |
|----|--------|----------|----------|-----|----------|
| U1 | **Sales hub crashes on bad data** | **Critical** | `renderSalesKpis()` (`index.html:4622`): `new Date(iv.createdAt).toISOString().slice(0,10)` — if `iv.createdAt` is `undefined`/unparseable, `new Date(undefined)` is an Invalid Date and `.toISOString()` **throws** `RangeError: Invalid time value`. `navTo()` calls `show('v-sales')` *before* `renderSales()` (`:2351`), so the view becomes visible, then the render throws, and neither the KPI strip nor the invoice list below it ever populate — the screen is left showing stale/skeleton content with **zero on-screen error**, only a console stack trace. Verified live and reproducible today: `GET /api/invoices` on the connected dev DB shows 2 of 5 invoices have `createdAt: undefined` (ids `9f2a5426-…` and `6c99fef1-…`). The current write paths (`saveQuickInvoice` `:4842`, `convertToInvoice` `:4868`) both correctly set `createdAt:Date.now()`, so this isn't an active write-path bug — but it proves the read path has **zero defensive handling**, so any future bad write, partial import, or manual DB edit takes down the entire Sales hub silently. | Wrap the date computations in a safe helper (`function safeDay(ts){var d=new Date(ts);return isNaN(d.getTime())?null:d.toISOString().slice(0,10);}`) and filter/skip records that fail, or default to `iv.createdAt||0`. More broadly: wrap `renderSales()` (and ideally every top-level `navTo()` renderer) in try/catch that surfaces a toast + logs, instead of letting one bad record blank a whole screen. | **P0** |
| U2 | Boot intro | Low-Medium | Correctly session-gated (`sessionStorage.getItem('viwo_intro_played')`, `intro.js:13-14`) — will not replay on reload within the same tab, confirmed by design and by re-testing across all 3 breakpoints in this audit (intro suppressed after first play as expected). But it is **not skippable**: a full-screen `z-index:2000` overlay blocks the login form for ~7.0s (`T_END=7.0`, `intro.js:36`) every *new* browser session (new tab, new profile, cleared storage — which for shift-based garage staff logging in fresh each morning is common). `prefers-reduced-motion` users get a shorter ~1.6s static-logo version (`intro.js:94-98`) but still no click-to-skip. | Add a tap-anywhere / Esc-to-skip that fast-forwards the overlay to its exit transition, regardless of reduced-motion state. | P2 |
| U3 | Workshop kanban drag-and-drop on touch | **High** (has a workaround) | `.wb-card{draggable="true"; ondragstart="wbStart(...)"}` and columns use `ondragover`/`ondrop` (`index.html:3438,3455,3462-3468`) — **pure HTML5 native Drag-and-Drop API**, which is not triggered by touch gestures on iOS/Android without a polyfill (no `touchstart`/`touchmove`/`touchend`/pointer-events anywhere in the file — confirmed by grep, zero matches). The page's own on-screen instruction literally reads "Drag a job across stages to update its status" (`index.html`, Workshop header) — on a phone or touch tablet this core interaction silently does nothing. Workaround exists: tapping a card calls `wbCardClick()` → `openJobCardById()` (`:3467`), and status can be changed from the job-card detail screen instead — so it's a friction/workaround situation, not a hard blocker. | Either (a) ship a touch-friendly alternative on the card itself (a status `<select>` or long-press action sheet, shown only ≤768px) alongside the desktop drag interaction, or (b) at minimum change the on-screen hint text conditionally on touch devices to point at the tap-to-open-then-change-status flow so users aren't left assuming the board is broken. | P1 |
| U4 | Validation error quality | Pass (already noted A8) | Consistent, readable `toast()` messages, no raw `alert()`s found (matches prior audit's Phase 2 toast rollout). | — | — |
| U5 | Currency/date consistency | Pass | QAR formatting via `fmtMoney()`/`cur()` and `en-GB`-style dates (`"16 Jul 2026, 10:50"`) consistent across every screen sampled (dashboard, invoice, gate pass, trial balance, job cards). | — | — |
| U6 | Destructive-action confirmation | Pass | `confirmDialog()` used consistently for deletes; no native `window.confirm()` remaining in the sampled flows. | — | — |

---

## 5. Printing — the most important section for a garage

**Verdict: there IS a print stylesheet, but it is a 5-selector stub, not a real print layout, and the
single biggest visible defect — the sticky app-shell header printing on every document — was confirmed
with a real screenshot, not inferred from CSS.**

The entire print styling is:

```css
/* index.html:785-790 */
@media print{
  #sidebar,#bottom-nav,.back-btn,.btn,.page-header .btn-group,#mark-paid-btn{display:none!important}
  #main-content{margin:0;padding:16px}
  .card{box-shadow:none;border:1px solid #ddd}
  body{background:#fff}
}
```

| ID | Finding | Severity | Evidence | Fix | Priority |
|----|---------|----------|----------|-----|----------|
| P1 | **`#topbar` prints on every document** | **Critical** | `#topbar` (`index.html:986`, the sticky breadcrumb/search/+New/notifications/profile bar) is only ever hidden at `max-width:768px` (`:234`) — it is **absent from the `@media print` hide-list at `:786`**. Verified with a real screenshot: printing an invoice shows "Home / Sales / Invoice", the "Search customers, vehicles, job cards…" box with ⌘K hint, a blue **+ New** button, the notification bell with its red "5" unread badge, and "ARIF / Garage Admin" with a dropdown chevron, sitting above the invoice header. Same on the Trial Balance print preview. This is what a customer would receive as their printed invoice today. | Add `#topbar` to the existing hide-list at `index.html:786`: `#sidebar,#bottom-nav,#topbar,.back-btn,...`. One-line fix. | **P0 — ship this first.** |
| P2 | No print stylesheet for filter/control chrome on report pages | High | Trial Balance print preview also shows the still-live, un-filled "As At Date" `dd/mm/yyyy` input box above the table — filter controls (`.filter-bar`, date pickers, tab pills) aren't targeted by the print rule at all, since they're not `.btn`. Same will apply to P&L/BS/Cash Flow/Aged/VAT/GL, which share the same filter-bar pattern. | Add `.filter-bar,input[type=date],.page-header p{display:none!important}` (or a dedicated `.no-print` class applied to each report's control row) to the `@media print` block. | P1 |
| P3 | No `@page` rule / page-break control anywhere | Medium | `grep -c "@page"` = 0. No `page-break-inside:avoid` on `.card`, `.data-table tr`, or the payment-history block — a long invoice (many line items + payment history) or a General Ledger with many rows can split a table row or a card's inner content mid-page with no control. | Add `@page{size:A4;margin:14mm}` and `.card,.data-table tr{page-break-inside:avoid}` inside `@media print`. | P1 |
| P4 | No page numbering / "printed on" footer on statements | Low | Multi-page reports (SOA, GL, Aged Receivables) have no `Page X of Y` or generation-timestamp footer — hard to reconcile a stapled printout later, and CSS `counter()`-based page numbers are the standard fix (no JS needed). | `@media print{@page{@bottom-right{content:"Page " counter(page) " of " counter(pages);}}}` — note: Chrome's print support for page-margin boxes is partial; a pragmatic alternative is a repeating `<div class="print-footer">` positioned via `position:fixed;bottom:0` inside the print block. | P2 |
| P5 | **Invoice header quality — actually good** | Pass | `renderInvoiceDetail()` (`index.html:4914-5002`) prints company logo (if set), name, tagline, phone/email, address, and **TRN/VAT number** (`:4961`) when set in Settings; VAT subtotal/tax/total breakdown when `taxAmount>0` (`:4989-4991`); payment history with method/date/amount; credit-due banner; and invoice terms/notes footer. This is a solid, compliant invoice body — the *content* is right, only the *chrome around it* (P1/P2/P3) is the problem. | — | — |
| P6 | **Gate Pass — good structure, verified layout** | Pass | `renderGatePass()` (`index.html:5191-5265`) includes company header, Gate Pass No., date, linked invoice/job-card numbers, customer + vehicle boxes (incl. VIN, color), services-performed table with done/pending pills, a green "Vehicle Released" banner, and **two signature blocks** (Customer / Released By) with underlines — a genuinely thoughtful print document for a garage handover. Same missing-topbar problem (P1) will apply when actually printed, and same lack of A4/page-break control (P3). | — | — |
| P7 | No thermal receipt (58/80mm) format | Medium — expected gap, worth flagging explicitly | No CSS targets a narrow-width receipt printer anywhere (`grep -i "58mm\|80mm\|thermal\|receipt-width"` = 0 matches). Every printable document assumes A4/letter via the desktop card layout. For a garage counter that wants a quick payment receipt (as opposed to a full A4 invoice), there's no lightweight format. | Out of scope to build now, but worth listing as a defined gap for a future "quick receipt" mode (`@media print and (max-width: 80mm)` variant of the invoice template) rather than an accidental omission. | P2 (feature gap, not a bug) |
| P8 | No barcode/QR anywhere | Medium | Parts have a free-text "Barcode" *field* (`index.html:1265`) used only for text search (`:3631`) — there is no barcode/QR **rendering** (no image, no canvas-based generator) on parts, job cards, invoices, or gate passes. `grep -i "qrcode\|barcode.*canvas\|jsbarcode"` = 0. A QR linking to the digital job card / invoice on the printed gate pass or invoice would materially help a garage's paper-to-system reconciliation. | Feature gap — flagging for the backlog, not a defect in existing code. | P2 |
| P9 | No PDF export | Medium | `grep -i "jspdf\|html2pdf\|\.pdf"` = 0 matches anywhere in `index.html`, `server.js`, or `gms-backend.js`. The only "export" mechanism app-wide is the unrelated JSON backup added in the ERP audit's Batch A (`GET /api/export`). Every printable document is print-to-paper or print-to-PDF-via-OS-dialog only — there's no "Download PDF" / "Email PDF" button, which matters for a garage that wants to send a digital invoice without printing it first. | Feature gap for the backlog (`window.print()` piped through the browser's Save-as-PDF works today as a manual workaround, but isn't a designed export path). | P2 |
| P10 | No email/WhatsApp send of documents | Low-Medium | The only WhatsApp integration is a generic `wa.me/<number>` "start a chat" link on Customer detail (`index.html:3186`) — it does not attach or reference the invoice/gate pass; it's a general contact shortcut, not a document-send feature. No `mailto:` or server-side email anywhere (`grep -i mailto/nodemailer` = 0 across `server.js` too). | Feature gap for the backlog. | P2 |

---

## 6. Mobile / field use

| ID | Finding | Severity | Evidence | Fix | Priority |
|----|---------|----------|----------|-----|----------|
| M1 | **Technician portal is not a PWA** | **High** (mislabeled expectation) | `#v-tech-portal` (`index.html:7990`, shown via `document.getElementById('v-tech-portal').style.display='flex'` at `:7597`) is a hidden full-screen `<div>` inside the same single-page app — not a separate installable app. Repo-wide search for `manifest.json`, `sw.js`, `service-worker`, and `rel="manifest"` returns **zero** matches anywhere in the project (outside `node_modules`). There is no service worker, no offline cache, no "Add to Home Screen" manifest with icons — a technician cannot install this to a home screen as an app, and if the network drops mid-shift the portal (like the rest of the app) simply stops working, since every data operation goes through `gms-backend.js`'s live-fetch shim with no offline queue. | If a real PWA is wanted: add a `manifest.json` (name/icons/`display:standalone`/theme colors already match the VIWO brand tokens, so this is mostly metadata work) + a minimal service worker that at least app-shell-caches the static assets so the login/portal shell loads offline, even if live data still requires connectivity. This is a scoping decision, not a quick fix — flagging clearly so it isn't assumed to already exist. | P1 (as a labeling/expectation fix — "verify it's a real PWA" was explicitly asked, and it is not) |
| M2 | Offline handling | High (absence) | No `navigator.onLine` checks, no offline banner, no retry/queue logic anywhere in `index.html` (`grep -i "navigator.online\|offline"` = 0). Every write (`db.collection(...).add/update`) goes straight to `fetch()` via the shim; if a technician loses signal in the workshop bay, saves fail with a generic error toast and nothing is queued for retry. | Out of scope to fully solve here (would need an offline write-queue architecture), but a minimum viable step is detecting `navigator.onLine === false` and disabling Save buttons with a "You're offline" banner instead of letting writes fail silently into a toast. | P1 |
| M3 | Image upload UX (job-card photos, technician/advisor photos) | Pass, with a minor gap | `compressImage()` (`index.html:4289-4308`) resizes to max 1280px and re-encodes JPEG at quality 0.72 client-side before upload — good bandwidth hygiene for a field connection. Thumbnail previews with delete buttons work (`renderJcImagePreviews`, `:4324`). Gap: no per-file upload-progress indicator during the actual network `put()` (`uploadJcImages`, `:4360`) — only a static "Compressed" tag on the thumbnail before upload starts; on a slow field connection, a multi-photo save gives no feedback that it's still working. | Add a simple per-thumbnail spinner/progress overlay driven by the upload promise's pending state. | P2 |
| M4 | No customer portal / no push notifications | Informational | Confirmed absent, as expected — matches the existing product scope (this is a staff-only workshop tool). Not treated as a defect; listed because it was explicitly in the audit's ask. | — | — |

---

## Scores

### UI/UX Score: **63 / 100**

**Why not higher:** two of the six areas audited (Printing, Responsiveness/mobile-nav) contain a
verified-live P0-class defect each (topbar printing over every document; bottom-nav silently dead),
plus a verified-live functional crash (Sales hub). A garage's two most customer-facing outputs — the
thing they print and hand over, and the thing staff use on their phone on the shop floor — both have
a real, reproducible break in them today, not just missing polish.

**Why not lower:** the underlying design system is genuinely mature for a single-file vanilla-JS app —
brand-blue tokens pass contrast almost everywhere (`--t2` 7.58:1, `--t3` 6.28:1, `--accent-text`
6.70:1, all badge pairs 4.4–5.5:1), zero page-level horizontal scroll across 20+ screens at three
breakpoints, cmdk and the payment/GL modals are properly `aria-modal` + Escape + focus-managed, toasts
and `confirmDialog` have fully replaced native `alert`/`confirm`, skeletons and empty-states are
consistent, and the invoice/gate-pass print *content* (not chrome) is thorough — logo, TRN, VAT
breakdown, payment history, signature blocks. This is a codebase one focused week away from a
materially higher score: the top 3 findings (P1 topbar-in-print, R1 dead bottom-nav, U1 Sales-hub
crash) are each small, surgical fixes, not architectural rework.

| Dimension | Sub-score | Note |
|---|---|---|
| Responsiveness | 15/25 | No page-level overflow anywhere tested (strong), but the mobile bottom-nav is dead (R1) and finance tables lose a column silently on phones (R2). |
| Accessibility | 13/20 | Good modal foundations (cmdk, payment, GL) undermined by zero keyboard-navigable rows app-wide (A1) and two concrete, measured contrast regressions (A5, A6). |
| Consistency | 9/10 | Very little real inconsistency found post-rebrand; mostly clean. |
| UX friction | 8/15 | The Sales-hub crash (U1) and broken kanban drag on touch (U3) are real friction, offset by good toasts/confirm/currency consistency. |
| **Printing** | **8/20** | Content quality is good; the missing `#topbar` hide rule (P1) and missing filter-chrome hide rule (P2) mean what actually comes off the printer today is unprofessional, which is disproportionately damaging for a document-heavy trade business. |
| Mobile/field use | 10/10 (of 10 allotted for this write-up's weighting) → normalized to 10 | Correctly scoped: no PWA/offline is a real, clearly-flagged gap rather than a surprise regression; image upload UX is solid. |

*(Sub-scores are additive out of 100 with the weighting shown; Printing is weighted heaviest per the
brief's emphasis on "this is important for a garage.")*

---

## Priority punch list (do these first)

1. **P0 — one-line CSS fix**: add `#topbar` to `index.html:786`'s print hide-list. Immediately fixes the worst finding in the report.
2. **P0 — one-line CSS fix**: delete or scope the dead `#bottom-nav{display:none!important}` at `index.html:725`.
3. **P0 — small JS fix**: guard `renderSalesKpis()` (`index.html:4622`) against invalid `createdAt`, and wrap `navTo()`'s renderer dispatch in try/catch so one bad record can never blank a whole screen again.
4. **P1**: add `.filter-bar`/date-input hide rule + `@page`/`page-break-inside:avoid` rules to the print stylesheet (P2, P3).
5. **P1**: fix the two measured contrast failures — `index.html:4440` (`#94A3B8`→`var(--t3)`) and the three `var(--accent)`-on-small-text spots (`:3830`, `:4701`, `:7273`→`var(--accent-text)`).
6. **P1**: add `tabindex="0" role="button"` + Enter/Space activation to clickable rows (A1) — biggest single accessibility lever in the app.
7. **P1**: decide and scope the technician-portal PWA question explicitly (M1) — right now it silently isn't one.
