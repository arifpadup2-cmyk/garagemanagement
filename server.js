'use strict';
/*
 * Tecido Garage Management — API server.
 * Serves the front-end (public/) and a REST API that the Firebase-compat shim
 * (public/gms-backend.js) talks to. Data lives in PostgreSQL (Neon); each
 * collection is a JSONB-document table, photos are bytea in `images`.
 *
 * All /api routes require a Bearer token except: POST /api/login,
 * POST /api/tech-login, GET /api/tech-list, GET /api/health and
 * GET /api/image (<img> tags cannot send Authorization headers; image
 * paths are unguessable UUIDs).
 */
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const express = require('express');

// Minimal .env loader (avoids a dotenv dependency).
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
})();

const { pool, initSchema } = require('./db');

const app = express();
app.disable('x-powered-by');
// Trust one proxy hop (Render/nginx) so req.ip is the real client, not the
// spoofable X-Forwarded-For — the brute-force lock depends on this.
app.set('trust proxy', 1);
app.use(express.json({ limit: '15mb' })); // room for base64 images
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  // CSP: the SPA is a single self-contained document (inline styles/scripts,
  // data: images, same-origin API/images). No external origins are needed.
  res.set('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' data: https://fonts.gstatic.com; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});

// gzip large JSON responses — the full-collection fetches compress ~85%.
// Async so a big payload never blocks the event loop; browsers auto-decompress.
app.use((req, res, next) => {
  const _json = res.json.bind(res);
  res.json = (body) => {
    const str = JSON.stringify(body === undefined ? null : body);
    if (str.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      zlib.gzip(str, (err, gz) => {
        if (err) return _json(body);
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.set('Content-Encoding', 'gzip');
        res.set('Vary', 'Accept-Encoding');
        res.end(gz);
      });
      return res;
    }
    return _json(body);
  };
  next();
});

// Collection registry: route name -> table + ordering + extracted columns.
const COLL = {
  customers:    { table: 'customers',    order: 'created_at DESC NULLS LAST' },
  vehicles:     { table: 'vehicles',     order: 'created_at DESC NULLS LAST' },
  jobCards:     { table: 'job_cards',    order: 'created_at DESC NULLS LAST', seq: true, lock: 1001 },
  estimates:    { table: 'estimates',    order: 'created_at DESC NULLS LAST', seq: true, lock: 1003 },
  invoices:     { table: 'invoices',     order: 'created_at DESC NULLS LAST', seq: true, lock: 1002 },
  transactions: { table: 'transactions', order: 'txn_date DESC NULLS LAST', extra: { txn_date: 'date' } },
  finAccounts:  { table: 'fin_accounts', order: 'created_at ASC NULLS LAST' },
  technicians:  { table: 'technicians',  order: 'name ASC NULLS LAST', extra: { name: 'name' }, noCreated: true },
  advisors:     { table: 'advisors',     order: 'name ASC NULLS LAST', extra: { name: 'name' }, noCreated: true },
  appointments: { table: 'appointments', order: 'appt_date ASC NULLS LAST', extra: { appt_date: 'date' } },
  parts:        { table: 'parts',        order: 'created_at DESC NULLS LAST' },
  suppliers:    { table: 'suppliers',    order: 'created_at DESC NULLS LAST' },
  purchaseOrders: { table: 'purchase_orders', order: 'created_at DESC NULLS LAST', seq: true, lock: 1004 },
  masters:      { table: 'masters',      order: 'kind ASC NULLS LAST, name ASC NULLS LAST', extra: { kind: 'kind', name: 'name' } },
  services:     { table: 'services',     order: 'created_at DESC NULLS LAST' },
  purchaseRequests: { table: 'purchase_requests', order: 'created_at DESC NULLS LAST', seq: true, lock: 1005 },
  rfqs:             { table: 'rfqs',              order: 'created_at DESC NULLS LAST', seq: true, lock: 1006 },
  goodsReceipts:    { table: 'goods_receipts',    order: 'created_at DESC NULLS LAST', seq: true, lock: 1007 },
  purchaseInvoices: { table: 'purchase_invoices', order: 'created_at DESC NULLS LAST', seq: true, lock: 1008 },
  purchaseReturns:  { table: 'purchase_returns',  order: 'created_at DESC NULLS LAST', seq: true, lock: 1009 },
  stockLots:        { table: 'stock_lots',        order: 'created_at ASC NULLS LAST', extra: { part_id: 'partId' } },
  stockMovements:   { table: 'stock_movements',   order: 'at DESC NULLS LAST', extra: { part_id: 'partId', at: 'at' }, noCreated: true },
  warehouses:       { table: 'warehouses',        order: 'created_at ASC NULLS LAST' },
  bins:             { table: 'bins',              order: 'created_at ASC NULLS LAST', extra: { warehouse_id: 'warehouseId' } },
  stockTransfers:   { table: 'stock_transfers',   order: 'created_at DESC NULLS LAST', seq: true, lock: 1010 },
  stockCounts:      { table: 'stock_counts',      order: 'created_at DESC NULLS LAST', seq: true, lock: 1011 },
  reservations:     { table: 'reservations',      order: 'created_at DESC NULLS LAST', extra: { part_id: 'partId' } },
  tools:            { table: 'tools',             order: 'created_at DESC NULLS LAST' },
  toolIssues:       { table: 'tool_issues',       order: 'created_at DESC NULLS LAST', extra: { tool_id: 'toolId' } },
};

// Document number prefixes, so every module formats a reference identically.
const DOC_PREFIX = {
  jobCards: 'JC', invoices: 'INV', estimates: 'EST', purchaseOrders: 'PO',
  purchaseRequests: 'PR', rfqs: 'RFQ', goodsReceipts: 'GRN',
  purchaseInvoices: 'PINV', purchaseReturns: 'PRTN',
};
const docNo = (coll, seq) => (DOC_PREFIX[coll] || 'DOC') + '-' + String(seq || 0).padStart(4, '0');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function extractedColumns(cfg, doc) {
  // Returns { colName: value } for helper columns derived from the document.
  const cols = {};
  if (!cfg.noCreated) cols.created_at = Number.isFinite(doc.createdAt) ? doc.createdAt : Date.now();
  if (cfg.extra) for (const [col, key] of Object.entries(cfg.extra)) cols[col] = doc[key] ?? null;
  return cols;
}

// Money fields are rounded server-side so float dust can never strand an
// invoice between "paid" and "partial". Invoice totals are RECOMPUTED from the
// line items (+ optional VAT) rather than trusted from the client — a tampered
// or buggy client can no longer post a total that doesn't match its lines.
function sanitizeDoc(coll, doc) {
  if (coll === 'invoices') {
    if (Array.isArray(doc.items)) {
      // `cost` is the LINE TOTAL for every item (labour or part); qty is metadata.
      const sub = round2(doc.items.reduce((s, it) => s + (Number(it.cost) || 0), 0));
      // Header discount (fixed amount or %), applied to the subtotal; VAT is then
      // charged on the discounted subtotal. Discount can never exceed the subtotal.
      let disc = 0;
      if (doc.discountType === 'pct') disc = round2(sub * (Number(doc.discountValue) || 0) / 100);
      else if (doc.discountType === 'amount') disc = round2(Number(doc.discountValue) || 0);
      disc = Math.max(0, Math.min(disc, sub));
      const net = round2(sub - disc);
      const rate = Number(doc.taxRate) || 0;
      const tax = rate > 0 ? round2(net * rate / 100) : 0;
      doc.subtotal = sub;
      doc.discountAmount = disc;
      doc.taxAmount = tax;
      doc.total = round2(net + tax);
    } else if (typeof doc.total === 'number') {
      doc.total = round2(doc.total);
    }
    for (const k of ['totalPaid', 'discount']) {
      if (typeof doc[k] === 'number') doc[k] = round2(doc[k]);
    }
  }
  if (coll === 'transactions' && typeof doc.amount === 'number') doc.amount = round2(doc.amount);
  // Purchase documents are costed server-side from their own lines, for the same
  // reason invoices are: a total that doesn't follow from the lines is how a
  // supplier gets overpaid.
  if (coll === 'purchaseOrders' || coll === 'purchaseInvoices' || coll === 'purchaseReturns') {
    const lines = Array.isArray(doc.items) ? doc.items : [];
    if (lines.length) {
      let sub = 0, tax = 0;
      for (const l of lines) {
        const qty = Number(l.qty) || 0;
        const unit = Number(l.unitCost) || 0;
        const gross = qty * unit;
        const disc = l.discountPct ? gross * (Number(l.discountPct) || 0) / 100 : 0;
        const net = round2(gross - disc);
        l.lineTotal = net;
        sub += net;
        tax += net * (Number(l.taxRate) || 0) / 100;
      }
      sub = round2(sub);
      let hdrDisc = 0;
      if (doc.discountType === 'pct') hdrDisc = round2(sub * (Number(doc.discountValue) || 0) / 100);
      else if (doc.discountType === 'amount') hdrDisc = round2(Number(doc.discountValue) || 0);
      hdrDisc = Math.max(0, Math.min(hdrDisc, sub));
      // A header discount reduces the taxable base proportionally.
      const taxable = sub - hdrDisc;
      const taxAmt = sub > 0 ? round2(tax * (taxable / sub)) : 0;
      // Landed costs (freight, customs, clearing) are part of what the goods
      // cost you, so they belong in the invoice total and in item cost.
      const landed = Array.isArray(doc.landedCosts)
        ? round2(doc.landedCosts.reduce((s, c) => s + (Number(c.amount) || 0), 0)) : 0;
      doc.subtotal = sub;
      doc.discountAmount = hdrDisc;
      doc.taxAmount = taxAmt;
      doc.landedTotal = landed;
      doc.total = round2(taxable + taxAmt + landed);
    }
    for (const k of ['amountPaid']) if (typeof doc[k] === 'number') doc[k] = round2(doc[k]);
  }
  // Master data is normalised on the way in so the uniqueness indexes and the
  // lookups that read it can never be defeated by stray whitespace or casing.
  if (coll === 'masters') {
    if (doc.name != null) doc.name = String(doc.name).trim().replace(/\s+/g, ' ');
    if (doc.code != null) doc.code = String(doc.code).trim().toUpperCase();
    if (doc.kind != null) doc.kind = String(doc.kind).trim();
    if (doc.active == null) doc.active = true;
    if (doc.rate != null) doc.rate = round2(doc.rate);
  }
  if (coll === 'services') {
    if (doc.name != null) doc.name = String(doc.name).trim().replace(/\s+/g, ' ');
    if (doc.code != null) doc.code = String(doc.code).trim().toUpperCase();
    if (doc.active == null) doc.active = true;
    for (const k of ['standardRate', 'price']) if (doc[k] != null) doc[k] = round2(doc[k]);
    if (doc.standardHours != null) doc.standardHours = Math.round((Number(doc.standardHours) || 0) * 100) / 100;
    // Price is derived from hours x rate unless the admin overrode it, so the
    // catalogue can never quote a figure its own inputs don't support.
    if (!doc.priceOverride) doc.price = round2((Number(doc.standardHours) || 0) * (Number(doc.standardRate) || 0));
  }
  // Never store a technician PIN in plaintext — hash any incoming plaintext PIN.
  if (coll === 'technicians' && doc.pin != null && isLegacyPin(doc.pin) && String(doc.pin).length) {
    doc.pin = hashPin(String(doc.pin));
  }
  return doc;
}

// Human wording for each uniqueness index, so a race that slips past the
// application-level duplicate check still surfaces as a clear 409 rather than a
// generic "server error".
const UNIQUE_MSG = {
  uq_masters_kind_name: 'Another entry with this name already exists in this list.',
  uq_masters_kind_code: 'Another entry with this code already exists in this list.',
  uq_services_code: 'Another service already uses this code.',
  uq_parts_number: 'Another part already uses this part number.',
  uq_parts_barcode: 'Another part already uses this barcode.',
  uq_invoices_jobcard: 'This job card has already been invoiced.',
};

const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch((e) => {
  // 23505 = unique_violation. It's a user-correctable data clash, not a fault.
  if (e && e.code === '23505') {
    return res.status(409).json({ error: UNIQUE_MSG[e.constraint] || 'That value is already in use.' });
  }
  console.error(`${req.method} ${req.originalUrl}:`, e.message);
  // Never leak Postgres internals to the UI.
  res.status(500).json({ error: 'Server error — please try again.' });
});

// ---- Master-data validation ----
// The database enforces uniqueness; this enforces shape. Both run server-side so
// a tampered or buggy client cannot write a master record the rest of the ERP
// would then have to defend against on every read.
const MASTER_KINDS = new Set([
  'category', 'brand', 'uom', 'labourType', 'vehicleMake', 'vehicleModel',
  'fuelType', 'customerGroup', 'supplierGroup', 'taxCode',
]);
// Kinds whose rows must hang off a parent, and the parent kind they require.
const MASTER_PARENT = { vehicleModel: 'vehicleMake' };

async function validateDoc(coll, doc, id) {
  if (coll === 'masters') {
    if (!MASTER_KINDS.has(doc.kind)) return 'Unknown master data list.';
    if (!doc.name) return 'Name is required.';
    if (String(doc.name).length > 80) return 'Name is too long (max 80 characters).';
    const parentKind = MASTER_PARENT[doc.kind];
    if (parentKind) {
      if (!doc.parentId) return 'Please choose the parent record first.';
      const { rows } = await pool.query(`SELECT kind FROM masters WHERE id=$1`, [doc.parentId]);
      if (!rows.length || rows[0].kind !== parentKind) return 'The parent record no longer exists.';
    }
    if (doc.kind === 'taxCode') {
      const r = Number(doc.rate);
      if (!Number.isFinite(r) || r < 0 || r > 100) return 'Tax rate must be between 0 and 100.';
    }
  }
  if (coll === 'services') {
    if (!doc.name) return 'Service name is required.';
    if (Number(doc.standardHours) < 0) return 'Standard hours cannot be negative.';
    if (Number(doc.standardRate) < 0) return 'Standard rate cannot be negative.';
    if (Number(doc.price) < 0) return 'Price cannot be negative.';
  }
  if (coll === 'purchaseOrders' || coll === 'purchaseRequests' || coll === 'rfqs' || coll === 'purchaseInvoices') {
    const lines = Array.isArray(doc.items) ? doc.items : [];
    for (const l of lines) {
      if ((Number(l.qty) || 0) < 0) return 'Quantities cannot be negative.';
      if ((Number(l.unitCost) || 0) < 0) return 'Unit costs cannot be negative.';
      if (l.discountPct != null && (Number(l.discountPct) < 0 || Number(l.discountPct) > 100)) return 'Line discount must be between 0 and 100%.';
      if (l.taxRate != null && (Number(l.taxRate) < 0 || Number(l.taxRate) > 100)) return 'Tax rate must be between 0 and 100%.';
    }
    if (coll !== 'purchaseRequests' && coll !== 'rfqs' && !doc.supplierId) return 'Please choose a supplier.';
    if (Array.isArray(doc.landedCosts)) {
      for (const c of doc.landedCosts) if ((Number(c.amount) || 0) < 0) return 'Landed costs cannot be negative.';
    }
    if (doc.overReceiptPct != null && (Number(doc.overReceiptPct) < 0 || Number(doc.overReceiptPct) > 100)) {
      return 'Over-receipt tolerance must be between 0 and 100%.';
    }
  }
  if (coll === 'customers') {
    if (doc.name != null && !String(doc.name).trim()) return 'Customer name is required.';
    if (doc.creditLimit != null && Number(doc.creditLimit) < 0) return 'Credit limit cannot be negative.';
    if (doc.creditDays != null && Number(doc.creditDays) < 0) return 'Payment terms cannot be negative.';
    // A company account is billed to an entity, so it needs an entity name.
    if (doc.customerType === 'company' && !String(doc.companyName || '').trim()) {
      return 'Enter the company name for a company account.';
    }
  }
  if (coll === 'vehicles') {
    if (doc.registrationNo != null && !String(doc.registrationNo).trim()) return 'Registration number is required.';
    if (doc.year != null && String(doc.year).trim()) {
      const y = Number(doc.year);
      if (!Number.isFinite(y) || y < 1950 || y > new Date().getFullYear() + 2) return 'Enter a valid model year.';
    }
    if (doc.mileage != null && Number(doc.mileage) < 0) return 'Mileage cannot be negative.';
  }
  if (coll === 'parts') {
    if (doc.name != null && !String(doc.name).trim()) return 'Part name is required.';
    // A serialised item is counted one unit at a time; a fractional unit of
    // measure would make the serial ledger and the stock figure disagree.
    if (doc.trackSerial && doc.trackBatch) return 'An item can be tracked by batch or by serial number, not both.';
    if (Number(doc.costPrice) < 0 || Number(doc.sellingPrice) < 0) return 'Prices cannot be negative.';
    if (doc.minStock != null && doc.maxStock != null &&
        Number(doc.maxStock) > 0 && Number(doc.minStock) > Number(doc.maxStock)) {
      return 'Minimum stock cannot exceed maximum stock.';
    }
  }
  return null;
}

// ---- Auth (stateless HMAC tokens; survive server restarts) ----
// SESSION_SECRET is the token-signing key and MUST be set independently of the
// admin password (else a leaked token enables offline password cracking). We
// warn loudly if it's missing and fall back to a random per-boot secret, which
// invalidates all tokens on restart rather than using a weak derived key.
let SECRET;
if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
  SECRET = Buffer.from(process.env.SESSION_SECRET);
} else {
  console.warn('[gms] WARNING: SESSION_SECRET is unset or too short — using a random per-boot secret. Set a strong SESSION_SECRET in .env so sessions survive restarts. See .env.example.');
  SECRET = crypto.randomBytes(32);
}
const TOKEN_TTL = 30 * 24 * 3600 * 1000; // 30 days

// ---- PIN hashing (scrypt; no external deps) ----
// Stored form: "scrypt$<saltHex>$<hashHex>". Legacy plaintext PINs are migrated
// transparently on first successful login.
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function verifyPin(pin, stored) {
  if (!stored) return false;
  if (typeof stored === 'string' && stored.startsWith('scrypt$')) {
    const [, saltHex, hashHex] = stored.split('$');
    try {
      const hash = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32);
      const good = Buffer.from(hashHex, 'hex');
      return hash.length === good.length && crypto.timingSafeEqual(hash, good);
    } catch (_) { return false; }
  }
  // legacy plaintext
  return String(stored) === String(pin);
}
function isLegacyPin(stored) { return stored && !(typeof stored === 'string' && stored.startsWith('scrypt$')); }

function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + TOKEN_TTL })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const i = tok.lastIndexOf('.');
  if (i < 0) return null;
  const body = tok.slice(0, i), sig = tok.slice(i + 1);
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && p.exp < Date.now()) return null;
    return p;
  } catch (_) { return null; }
}
// Token revocation: tokens issued before `authEpoch` are rejected. Bumping it
// (POST /api/logout-all) invalidates every outstanding token at once — the
// "sign out all devices" panic button. Persisted in settings so it survives
// restarts. (Per-token revocation isn't possible with stateless tokens; the
// 30-day expiry bounds exposure, and this gives a real global kill switch.)
let authEpoch = 0;
async function loadAuthEpoch() {
  try {
    const { rows } = await pool.query(`SELECT data FROM settings WHERE id = 'auth'`);
    if (rows.length && Number(rows[0].data.epoch)) authEpoch = Number(rows[0].data.epoch);
  } catch (_) {}
}

// Period lock: no transaction/invoice may be dated on or before this date.
let periodLockDate = '';
// Company settings the API needs on every request, cached at boot and refreshed
// whenever Settings is saved. Three-way match tolerances live here so the
// garage can loosen them without a deploy.
let settingsCache = {};
async function loadPeriodLock() {
  try {
    const { rows } = await pool.query(`SELECT data FROM settings WHERE id = 'company'`);
    settingsCache = (rows.length && rows[0].data) || {};
    periodLockDate = settingsCache.lockDate || '';
  } catch (_) { periodLockDate = ''; settingsCache = {}; }
}
function periodLocked(dateStr) { return !!(periodLockDate && dateStr && dateStr <= periodLockDate); }
function tsToDs(ts) { const t = Number(ts); if (!t) return ''; const d = new Date(t); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
async function bumpAuthEpoch() {
  authEpoch = Date.now();
  await pool.query(`INSERT INTO settings (id, data) VALUES ('auth', $1)
    ON CONFLICT (id) DO UPDATE SET data = settings.data || $1`, [JSON.stringify({ epoch: authEpoch })]);
}
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const p = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!p) return res.status(401).json({ error: 'Unauthorized' });
  if (authEpoch && Number(p.iat || 0) < authEpoch) return res.status(401).json({ error: 'Session ended — please sign in again.' });
  req.auth = p;
  next();
}

// Lightweight audit trail: who did what, when. Fire-and-forget so it never
// blocks or fails a real request.
function audit(req, action, coll, docId, summary) {
  const a = req.auth || {};
  pool.query(`INSERT INTO audit_log (at, actor, role, action, coll, doc_id, summary) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [Date.now(), a.name || '?', a.role || '?', action, coll || '', docId || '', (summary || '').slice(0, 200)]).catch(() => {});
}

// Brute-force guard. Keyed on BOTH source IP and the target account, so an
// attacker who spoofs X-Forwarded-For still can't bypass the per-account lock.
// `app.set('trust proxy', 1)` (below) makes req.ip the real client on Render.
const loginFails = new Map(); // key -> { n, until }
const LOCK_MS = 15 * 60 * 1000, MAX_FAILS = 5;
function keyLocked(key) { const f = loginFails.get(key); return f && f.until > Date.now(); }
function loginGuard(accountKeyFn) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '?';
    const acct = accountKeyFn ? accountKeyFn(req) : '';
    req._lockKeys = ['ip:' + ip].concat(acct ? ['acct:' + acct] : []);
    if (req._lockKeys.some(keyLocked)) return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
    next();
  };
}
function noteLoginFail(req) {
  (req._lockKeys || []).forEach((key) => {
    const f = loginFails.get(key) || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
    loginFails.set(key, f);
  });
}
function clearLoginFail(req) { (req._lockKeys || []).forEach((k) => loginFails.delete(k)); }
// Evict stale lock entries hourly so the map can't grow unbounded.
setInterval(() => { const now = Date.now(); for (const [k, f] of loginFails) if (!f.until || f.until < now) loginFails.delete(k); }, 3600 * 1000).unref();

// ---- Public routes (registered before the auth gate) ----

app.post('/api/login', loginGuard((req) => String((req.body || {}).username || '').trim().toLowerCase()), (req, res) => {
  const { username, password } = req.body || {};
  const U = (process.env.ADMIN_USER || 'arifpadup').toLowerCase();
  const P = process.env.ADMIN_PASSWORD || '';
  const NAME = process.env.ADMIN_NAME || 'ARIF';
  if (!P) return res.status(500).json({ ok: false, error: 'Admin login not configured (set ADMIN_PASSWORD).' });
  const uOk = String(username || '').trim().toLowerCase() === U;
  const pOk = P.length === String(password || '').length && crypto.timingSafeEqual(Buffer.from(P), Buffer.from(String(password || '')));
  if (uOk && pOk) {
    clearLoginFail(req);
    return res.json({ ok: true, name: NAME, token: signToken({ role: 'admin', name: NAME }) });
  }
  noteLoginFail(req);
  return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
});

// Technician login: PIN is compared server-side; the pre-login list exposes
// only safe fields (never the PIN).
app.get('/api/tech-list', asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT id, data FROM technicians ORDER BY name ASC NULLS LAST`);
  res.json(rows.map((r) => ({
    id: r.id,
    name: r.data.name || '',
    specialty: r.data.specialty || '',
    photoUrl: r.data.photoUrl || '',
  })));
}));
app.post('/api/tech-login', loginGuard((req) => 'tech:' + String((req.body || {}).id || '')), asyncH(async (req, res) => {
  const { id, pin } = req.body || {};
  const { rows } = await pool.query(`SELECT id, data FROM technicians WHERE id = $1`, [id]);
  const t = rows.length ? rows[0].data : null;
  if (!t || !verifyPin(pin, t.pin)) {
    noteLoginFail(req);
    return res.status(401).json({ ok: false, error: 'Incorrect PIN. Please try again.' });
  }
  clearLoginFail(req);
  // Transparently upgrade a legacy plaintext PIN to a scrypt hash on login.
  if (isLegacyPin(t.pin)) {
    try { await pool.query(`UPDATE technicians SET data = data || $2 WHERE id = $1`, [id, JSON.stringify({ pin: hashPin(pin) })]); } catch (_) {}
  }
  res.json({ ok: true, id: rows[0].id, name: t.name || '', token: signToken({ role: 'tech', techId: rows[0].id, name: t.name || '' }) });
}));

app.get('/api/health', asyncH(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, ts: Date.now() });
}));

// Image GET stays public: <img> tags cannot send Authorization headers and
// paths are unguessable UUIDs. Mutations require auth (below the gate).
const IMG_MIME = /^image\/(png|jpe?g|webp|gif)$/;
app.get('/api/image', asyncH(async (req, res) => {
  const p = req.query.p;
  if (!p) return res.status(400).end();
  const { rows } = await pool.query(`SELECT mime, bytes FROM images WHERE path = $1`, [p]);
  if (!rows.length) return res.status(404).end();
  res.set('Content-Type', IMG_MIME.test(rows[0].mime || '') ? rows[0].mime : 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400'); // paths are mutable (upsert) — no "immutable"
  res.send(rows[0].bytes);
}));

// ---- Everything below requires a valid token ----
app.use('/api', requireAuth);

// ---- Authorization (RBAC) ----
// Admin: full access. Technician: a tight allowlist — read the shop-floor data
// they need, update job-card work status, and toggle ONLY their own
// availability. Everything else (finance, other people's records, deletes,
// the atomic money/stock endpoints, export, image mutations) is 403.
// Master data is reference material the shop floor reads but never edits, so
// technicians get GET on masters/services and nothing more.
const TECH_READ = new Set(['jobCards', 'technicians', 'customers', 'vehicles', 'parts', 'masters', 'services',
  'warehouses', 'bins', 'stockLots', 'stockMovements', 'reservations', 'tools', 'toolIssues']);
function authorize(req, res, next) {
  const role = req.auth && req.auth.role;
  if (role === 'admin') return next();
  if (role === 'tech') {
    // Mounted at '/api', so req.path is mount-relative: '/<coll>/<id>/<sub>'.
    const parts = req.path.split('/').filter(Boolean); // ['coll',':id',...]
    const coll = parts[0], id = parts[1], sub = parts[2];
    if (req.method === 'GET') {
      if (coll === 'settings' || coll === 'image') return next();
      if (TECH_READ.has(coll)) return next();
    }
    // Update a job card's work status (no sub-action), or your OWN tech status.
    if (req.method === 'PUT' && !sub) {
      if (coll === 'jobCards' && id) return next();
      if (coll === 'technicians' && id === req.auth.techId) return next();
    }
    // Atomic single-work-item update (technician clock in/out on the shop floor).
    if (req.method === 'POST' && coll === 'jobCards' && id && sub === 'work') return next();
    return res.status(403).json({ error: 'Not permitted for this account.' });
  }
  return res.status(403).json({ error: 'Not permitted.' });
}
app.use('/api', authorize);
const requireAdmin = (req, res, next) => (req.auth && req.auth.role === 'admin') ? next() : res.status(403).json({ error: 'Admin only.' });

// Technician PINs (now scrypt hashes) never leave the server for ANY session —
// nobody needs to read them back; the edit form leaves the PIN field blank and
// only re-sets it when the admin types a new one.
function redactTechs(auth, docs) {
  return docs.map((d) => { const c = { ...d }; delete c.pin; c.hasPin = !!d.pin; return c; });
}

// Whitelisted JSONB filter fields per collection (indexed above). Any other
// query param is ignored — no arbitrary JSONB access.
const FILTERABLE = {
  invoices: ['status', 'customerId', 'jobCardId'],
  jobCards: ['status', 'customerId', 'vehicleId'],
  vehicles: ['customerId'],
  transactions: ['accountId', 'invoiceId', 'type'],
  estimates: ['status', 'customerId'],
  appointments: ['status'],
  parts: ['category'],
  masters: ['kind', 'parentId'],
  services: ['categoryId', 'active'],
  purchaseOrders: ['status', 'supplierId'],
  purchaseRequests: ['status'],
  rfqs: ['status'],
  goodsReceipts: ['poId', 'supplierId'],
  purchaseInvoices: ['status', 'supplierId', 'poId'],
  purchaseReturns: ['grnId', 'supplierId'],
  stockLots: ['partId', 'status', 'warehouseId'],
  stockMovements: ['partId', 'refType', 'refId', 'warehouseId'],
  bins: ['warehouseId'],
  reservations: ['partId', 'jobCardId', 'status'],
  toolIssues: ['toolId', 'status', 'technicianId'],
};

// ---- List ----
// Backward-compatible: with no query params, returns the full collection (the
// SPA still relies on that). With ?limit / ?before / whitelisted filters, it
// pages and filters server-side using the JSONB indexes — the capability large
// screens and future client windowing use.
app.get('/api/:coll', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next(); // fall through to specific routes (settings, image)
  const where = [], params = [];
  const allowed = FILTERABLE[req.params.coll] || [];
  for (const f of allowed) {
    if (req.query[f] != null && req.query[f] !== '') { params.push(String(req.query[f])); where.push(`data->>'${f}' = $${params.length}`); }
  }
  // Keyset pagination on the ordering column (created_at for most).
  const limit = req.query.limit != null ? Math.min(Math.max(Number(req.query.limit) || 0, 1), 500) : null;
  if (limit && req.query.before != null && /created_at/.test(cfg.order)) { params.push(Number(req.query.before)); where.push(`created_at < $${params.length}`); }
  let sql = `SELECT id, data FROM ${cfg.table}`;
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ` ORDER BY ${cfg.order}`;
  if (limit) sql += ` LIMIT ${limit}`;
  const { rows } = await pool.query(sql, params);
  let docs = rows.map((r) => ({ ...r.data, id: r.id }));
  if (req.params.coll === 'technicians') docs = redactTechs(req.auth, docs);
  res.json(docs);
}));

// ---- Get one ----
app.get('/api/:coll/:id', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
  const { rows } = await pool.query(`SELECT id, data FROM ${cfg.table} WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  let doc = { ...rows[0].data, id: rows[0].id };
  if (req.params.coll === 'technicians') doc = redactTechs(req.auth, [doc])[0];
  res.json(doc);
}));

// Allocate a race-free document number for a seq-bearing collection, inside an
// already-open transaction `client`. Reused by create and the quick-invoice
// endpoint so numbering behaves identically everywhere.
async function allocSeq(client, coll, table, lock, id) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [lock]);
  const existing = await client.query(`SELECT seq FROM ${table} WHERE id = $1`, [id]);
  if (existing.rows.length && existing.rows[0].seq != null) return Number(existing.rows[0].seq);
  const r = await client.query(
    `INSERT INTO seqs (coll, last)
     VALUES ($1, (SELECT COALESCE(MAX(seq),0) FROM ${table}) + 1)
     ON CONFLICT (coll) DO UPDATE
       SET last = GREATEST(seqs.last, (SELECT COALESCE(MAX(seq),0) FROM ${table})) + 1
     RETURNING last`,
    [coll]
  );
  return Number(r.rows[0].last);
}

// ══════════════════════════════════════════════════════════════════════════
// STOCK MOVEMENT LEDGER
// Every change to on-hand stock goes through here, inside the caller's
// transaction. Movements used to live in an array on the item document, which
// meant a part received 500 times rewrote 500 rows of history on every issue —
// a write-amplification wall, and impossible to query across items ("what moved
// yesterday?" had to load the whole catalogue). The ledger is the single source
// of truth for stock history; parts.stock is the running balance.
// ══════════════════════════════════════════════════════════════════════════
async function postMovement(client, m) {
  const id = crypto.randomUUID();
  const at = m.at || Date.now();
  const doc = {
    partId: m.partId, partName: m.partName || '',
    type: m.type,                     // in | out | set
    qty: round2(m.qty), from: round2(m.from), to: round2(m.to),
    warehouseId: m.warehouseId || '', binId: m.binId || '',
    lotId: m.lotId || '',
    refType: m.refType || '',         // grn | return | adjust | issue | transfer | count | invoice
    refId: m.refId || '', refNo: m.refNo || '',
    unitCost: m.unitCost != null ? round2(m.unitCost) : null,
    note: (m.note || '').trim(), at, by: m.by || '',
  };
  await client.query(
    `INSERT INTO stock_movements (id, data, part_id, at) VALUES ($1,$2,$3,$4)`,
    [id, JSON.stringify(doc), m.partId, at]
  );
  return { id, ...doc };
}

// One-time migration: lift the embedded movement arrays into the ledger. Runs at
// boot, is idempotent (skips any part already migrated), and leaves the original
// arrays alone so an older cached client keeps rendering.
async function migrateMovements() {
  try {
    const { rows } = await pool.query(
      `SELECT id, data FROM parts
        WHERE jsonb_array_length(COALESCE(data->'movements','[]'::jsonb)) > 0
          AND COALESCE((data->>'movementsMigrated')::boolean, false) = false`
    );
    if (!rows.length) return;
    let moved = 0;
    for (const r of rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const m of (Array.isArray(r.data.movements) ? r.data.movements : [])) {
          await postMovement(client, {
            partId: r.id, partName: r.data.name || '',
            type: m.type || 'set', qty: Number(m.qty) || 0,
            from: Number(m.from) || 0, to: Number(m.to) || 0,
            refType: m.grnId ? 'grn' : (m.purchaseReturnId ? 'return' : 'adjust'),
            refId: m.grnId || m.purchaseReturnId || '',
            note: m.note || '', at: Number(m.at) || Date.now(), by: m.by || '',
          });
          moved++;
        }
        await client.query(`UPDATE parts SET data = data || '{"movementsMigrated":true}'::jsonb WHERE id = $1`, [r.id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        console.warn('[gms] movement migration skipped for part', r.id, e.message);
      } finally {
        client.release();
      }
    }
    console.log(`Movement ledger: migrated ${moved} movement(s) from ${rows.length} item(s).`);
  } catch (e) {
    console.warn('[gms] movement migration failed:', e.message);
  }
}

// Stock physically present minus what is already promised to open job cards.
// Issuing against promised stock is how two jobs end up fighting over one part.
async function reservedQty(client, partId) {
  const q = client || pool;
  const { rows } = await q.query(
    `SELECT COALESCE(SUM((data->>'qty')::numeric),0) n FROM reservations
      WHERE part_id = $1 AND COALESCE(data->>'status','open') = 'open'`,
    [partId]
  );
  return round2(Number(rows[0].n) || 0);
}

// Collections that may ONLY be written by their dedicated endpoint. A goods
// receipt that did not move stock, or a return that did not come out of a lot,
// would be a document describing something that never happened — so the generic
// CRUD path hands these straight on to the engine that owns them.
const DEDICATED_WRITE = new Set(['goodsReceipts', 'purchaseReturns', 'stockLots', 'stockMovements', 'stockTransfers', 'stockCounts']);

// ---- Create (upsert by id) ----
app.post('/api/:coll', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
  if (DEDICATED_WRITE.has(req.params.coll)) return next();
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Document body required' });
  }
  const body = sanitizeDoc(req.params.coll, { ...req.body });
  // Reject money records dated into a locked period.
  if (req.params.coll === 'transactions' && periodLocked(body.date)) return res.status(400).json({ error: 'The books are locked up to ' + periodLockDate + '. Use a later date.' });
  if (req.params.coll === 'invoices' && periodLocked(tsToDs(body.createdAt))) return res.status(400).json({ error: 'The books are locked up to ' + periodLockDate + '. Use a later date.' });
  const id = body.id || crypto.randomUUID();
  const isNew = !body.id;
  delete body.id;
  const invalid = await validateDoc(req.params.coll, body, id);
  if (invalid) return res.status(400).json({ error: invalid });
  // A credit sale to a customer who is over their limit, on hold, or past their
  // payment terms is refused. Cash and card sales are unaffected — the control
  // is about lending money, not about selling.
  if (req.params.coll === 'invoices' && isNew && body.customerId &&
      ['credit', 'unpaid'].includes(String(body.status || ''))) {
    const st = await creditStatus(body.customerId);
    if (st && st.blocked && !body.creditOverride) {
      const why = st.creditHold ? 'this account is on credit hold'
        : (st.overdue ? `their oldest invoice is ${st.oldestUnpaidDays} days old against ${st.creditDays}-day terms`
                      : `they already owe ${st.outstanding.toFixed(2)} against a ${st.creditLimit.toFixed(2)} limit`);
      return res.status(409).json({ error: `Cannot invoice ${st.name} on credit — ${why}.`, credit: st });
    }
  }

  // Actor attribution for the audit trail.
  const actor = (req.auth && req.auth.name) || '?';
  if (isNew && body.createdBy == null) body.createdBy = actor;
  else if (!isNew) { body.updatedBy = actor; body.updatedAt = Date.now(); }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (cfg.seq) {
      // Race-free monotonic number (never reissues a deleted doc's number).
      body.seq = await allocSeq(client, req.params.coll, cfg.table, cfg.lock, id);
    }
    const cols = extractedColumns(cfg, body);
    const colNames = ['id', 'data', ...Object.keys(cols)];
    const vals = [id, JSON.stringify(body), ...Object.values(cols)];
    const ph = vals.map((_, i) => `$${i + 1}`);
    if (cfg.seq) { colNames.push('seq'); vals.push(body.seq); ph.push(`$${vals.length}`); }
    const updates = colNames.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`);
    await client.query(
      `INSERT INTO ${cfg.table} (${colNames.join(',')}) VALUES (${ph.join(',')})
       ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}`,
      vals
    );
    await client.query('COMMIT');
    audit(req, isNew ? 'create' : 'update', req.params.coll, id, body.seq ? '#' + body.seq : (body.name || ''));
    res.json({ id, ...body });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'An invoice already exists for this job card.' });
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Record payment(s) on an invoice, atomically ----
// Appends under a row lock (no lost updates from stale clients), enforces the
// outstanding balance, recomputes totalPaid/status server-side, and inserts
// the matching cash-book transaction rows in the same DB transaction.
app.post('/api/invoices/:id/pay', asyncH(async (req, res) => {
  const { payments, transactions, paymentType } = req.body || {};
  if (!Array.isArray(payments) || !payments.length) return res.status(400).json({ error: 'payments required' });
  for (const p of payments) {
    if (!(Number(p.amount) > 0)) return res.status(400).json({ error: 'Invalid payment amount.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT data FROM invoices WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }
    const inv = cur.rows[0].data;
    const total = round2(inv.total);
    const existing = Array.isArray(inv.payments) ? inv.payments : [];
    const already = round2(existing.reduce((s, p) => s + (Number(p.amount) || 0), 0));
    const adding = round2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
    if (already + adding > total + 0.005) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payment exceeds outstanding balance — ' + round2(total - already).toFixed(2) + ' due.' });
    }
    const totalPaid = round2(already + adding);
    const isPaid = totalPaid >= total - 0.005;
    const merged = { ...inv, payments: existing.concat(payments.map((p) => ({ ...p, amount: round2(p.amount) }))), totalPaid, status: isPaid ? 'paid' : 'partial' };
    if (isPaid) {
      merged.paidAt = Date.now();
      merged.paymentType = paymentType || (payments.length === 1 ? payments[0].method : 'split');
    }
    await client.query(`UPDATE invoices SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(merged)]);
    if (Array.isArray(transactions)) {
      for (const t of transactions) {
        const doc = sanitizeDoc('transactions', { ...t });
        const tid = doc.id || crypto.randomUUID();
        delete doc.id;
        await client.query(
          `INSERT INTO transactions (id, data, txn_date, created_at) VALUES ($1,$2,$3,$4)`,
          [tid, JSON.stringify(doc), doc.date || null, Number.isFinite(doc.createdAt) ? doc.createdAt : Date.now()]
        );
      }
    }
    await client.query('COMMIT');
    audit(req, 'pay', 'invoices', req.params.id, fmtAmt(adding));
    res.json({ id: req.params.id, ...merged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));
const fmtAmt = (n) => 'amount ' + round2(n).toFixed(2);

// ---- Quick Invoice (counter sale): invoice + optional cash-book entry, atomic ----
// Creates the invoice (with a race-free number, totals recomputed from lines)
// and its cash-book transaction in ONE DB transaction — the walk-in POS flow no
// longer writes the two as separate calls that can half-succeed.
app.post('/api/invoices/quick', asyncH(async (req, res) => {
  const invoice = (req.body && req.body.invoice) || null;
  const transaction = (req.body && req.body.transaction) || null;
  if (!invoice || !Array.isArray(invoice.items) || !invoice.items.length) {
    return res.status(400).json({ error: 'Invoice with at least one item is required.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = sanitizeDoc('invoices', { ...invoice }); // recomputes total/subtotal/tax/discount
    delete inv.id;
    const id = crypto.randomUUID();
    inv.seq = await allocSeq(client, 'invoices', 'invoices', COLL.invoices.lock, id);
    const invNoStr = 'INV-' + String(inv.seq).padStart(4, '0');
    // Deduct stock for any inventory-part lines, atomically in this same
    // transaction. Locked in stable id order (no deadlock); negative stock blocks
    // the whole sale. Each part line carries {partId, qty}.
    const partLines = (inv.items || []).filter((it) => it.partId && Number(it.qty) > 0);
    if (partLines.length) {
      const ids = Array.from(new Set(partLines.map((l) => l.partId))).sort();
      const rows = {};
      for (const pid of ids) {
        const r = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [pid]);
        if (r.rows.length) rows[pid] = r.rows[0].data;
      }
      // Aggregate qty per part (a part could appear on two lines).
      const need = {};
      partLines.forEach((l) => { need[l.partId] = (need[l.partId] || 0) + Number(l.qty); });
      for (const pid of Object.keys(need)) {
        const p = rows[pid];
        if (!p) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A selected part no longer exists.' }); }
        const from = Number(p.stock) || 0, qty = need[pid], to = from - qty;
        if (qty > from) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient stock — only ' + from + ' of ' + (p.name || 'a part') + ' on hand.' }); }
        const mv = { type: 'out', qty, from, to, note: 'Sold on ' + invNoStr, at: Date.now(), by: (req.auth && req.auth.name) || '' };
        rows[pid] = { ...p, stock: to, movements: (Array.isArray(p.movements) ? p.movements : []).concat([mv]) };
        await client.query(`UPDATE parts SET data = $2 WHERE id = $1`, [pid, JSON.stringify(rows[pid])]);
      }
    }
    // Never trust a client-supplied totalPaid beyond the invoice total.
    if (inv.totalPaid != null) inv.totalPaid = Math.min(round2(inv.totalPaid), inv.total);
    await client.query(
      `INSERT INTO invoices (id, data, seq, created_at) VALUES ($1,$2,$3,$4)`,
      [id, JSON.stringify(inv), inv.seq, Number.isFinite(inv.createdAt) ? inv.createdAt : Date.now()]
    );
    if (transaction && Number(transaction.amount) > 0) {
      const t = sanitizeDoc('transactions', { ...transaction, invoiceId: id });
      const invNo = 'INV-' + String(inv.seq).padStart(4, '0');
      t.description = 'Invoice Payment – ' + invNo; // stamp the real, server-assigned number
      // Cash recorded can never exceed what was actually paid on the invoice.
      t.amount = round2(Math.min(Number(t.amount) || 0, Number(inv.totalPaid) || inv.total));
      const tid = crypto.randomUUID();
      delete t.id;
      await client.query(
        `INSERT INTO transactions (id, data, txn_date, created_at) VALUES ($1,$2,$3,$4)`,
        [tid, JSON.stringify(t), t.date || null, Number.isFinite(t.createdAt) ? t.createdAt : Date.now()]
      );
    }
    await client.query('COMMIT');
    audit(req, 'quick-invoice', 'invoices', id, '#' + inv.seq);
    res.json({ id, ...inv });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'An invoice already exists for this job card.' });
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Update ONE work item on a job card, atomically ----
// Row-locked so two technicians on two devices updating different work items of
// the same job card can't erase each other (the old whole-array PUT race).
app.post('/api/jobCards/:id/work', asyncH(async (req, res) => {
  const { workId, patch } = req.body || {};
  if (!workId || !patch || typeof patch !== 'object') return res.status(400).json({ error: 'workId and patch required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT data FROM job_cards WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Job card not found' }); }
    const jc = cur.rows[0].data;
    const works = Array.isArray(jc.works) ? jc.works : [];
    const idx = works.findIndex((w) => w.id === workId);
    if (idx < 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Work item not found' }); }
    const safe = { ...patch }; delete safe.id; delete safe.cost; // cost is owner-set, never client-mutated here
    works[idx] = { ...works[idx], ...safe };
    const merged = { ...jc, works };
    // Recompute the card's rollup status from its work items (same rule as the
    // client's calcJcStatus: item statuses are pending/in_progress/done → card
    // rollup pending/in_progress/completed). Never downgrade invoiced/delivered.
    if (req.body.recomputeStatus && merged.status !== 'invoiced' && merged.status !== 'delivered') {
      merged.status = works.length === 0 ? 'pending'
        : works.every((w) => w.status === 'done') ? 'completed'
        : works.some((w) => w.status === 'in_progress' || w.status === 'done') ? 'in_progress'
        : 'pending';
    }
    await client.query(`UPDATE job_cards SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(merged)]);
    await client.query('COMMIT');
    res.json({ id: req.params.id, ...merged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Receive a purchase order, atomically ----
// Locks the PO then each part (consistent order), stocks in every line
// (weighted-average cost update), records movements noting the PO, and marks
// the PO received. Idempotent: a PO already received is rejected.
app.post('/api/purchaseOrders/:id/receive', asyncH(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pr = await client.query(`SELECT data, seq FROM purchase_orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!pr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase order not found' }); }
    const po = pr.rows[0].data;
    if (po.status === 'received') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This purchase order has already been received.' }); }
    const poNo = 'PO-' + String(pr.rows[0].seq || 0).padStart(4, '0');
    const lines = Array.isArray(po.items) ? po.items : [];
    // Lock all referenced parts in a stable order (by id) to avoid deadlocks.
    const partIds = Array.from(new Set(lines.map((l) => l.partId).filter(Boolean))).sort();
    const partRows = {};
    for (const pid of partIds) {
      const r = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [pid]);
      if (r.rows.length) partRows[pid] = r.rows[0].data;
    }
    for (const line of lines) {
      const p = partRows[line.partId];
      if (!p) continue;
      const from = Number(p.stock) || 0, qty = Number(line.qty) || 0, to = from + qty;
      const unitCost = round2(Number(line.unitCost) || 0);
      // Weighted-average cost so valuation reflects the real blended cost.
      const oldCost = Number(p.costPrice) || 0;
      const wac = to > 0 ? round2((from * oldCost + qty * unitCost) / to) : unitCost;
      const mv = { type: 'in', qty, from, to, note: 'Received on ' + poNo, at: Date.now(), by: (req.auth && req.auth.name) || '' };
      partRows[line.partId] = { ...p, stock: to, costPrice: wac, movements: (Array.isArray(p.movements) ? p.movements : []).concat([mv]) };
    }
    for (const pid of partIds) {
      if (partRows[pid]) await client.query(`UPDATE parts SET data = $2 WHERE id = $1`, [pid, JSON.stringify(partRows[pid])]);
    }
    const merged = { ...po, status: 'received', receivedAt: Date.now(), receivedBy: (req.auth && req.auth.name) || '' };
    await client.query(`UPDATE purchase_orders SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(merged)]);
    await client.query('COMMIT');
    audit(req, 'receive-po', 'purchaseOrders', req.params.id, poNo);
    res.json({ id: req.params.id, ...merged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ══════════════════════════════════════════════════════════════════════════
// GOODS RECEIPT — what actually arrived.
// A supplier delivery is its own document, not a flag on the order. Deliveries
// arrive short, arrive twice, and arrive with the wrong things; a PO that can
// only be "received" in full cannot describe any of that. Every receipt is
// atomic: the GRN, the stock movement, the lots and the PO's received
// quantities all commit together or not at all.
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/goodsReceipts', asyncH(async (req, res) => {
  const body = req.body || {};
  const poId = body.poId;
  const inLines = Array.isArray(body.items) ? body.items : [];
  if (!poId) return res.status(400).json({ error: 'A goods receipt must reference a purchase order.' });
  if (!inLines.length) return res.status(400).json({ error: 'Enter at least one received quantity.' });
  if (periodLocked(body.receivedDate)) {
    return res.status(400).json({ error: 'The books are locked up to ' + periodLockDate + '. Use a later date.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const por = await client.query(`SELECT data, seq FROM purchase_orders WHERE id = $1 FOR UPDATE`, [poId]);
    if (!por.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase order not found.' }); }
    const po = por.rows[0].data;
    const poNo = docNo('purchaseOrders', por.rows[0].seq);
    if (po.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(400).json({ error: poNo + ' is cancelled.' }); }
    // Goods may only be received against an order somebody authorised.
    if (!['approved', 'partial'].includes(po.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: poNo + ' must be approved before goods can be received.' });
    }

    const poLines = Array.isArray(po.items) ? po.items : [];
    const byLineId = new Map(poLines.map((l, i) => [l.id || String(i), l]));

    // ---- Validate the whole receipt before touching any stock ----
    const work = [];
    for (const rl of inLines) {
      const qty = Number(rl.qty) || 0;
      if (qty <= 0) continue;
      const pl = byLineId.get(rl.poLineId);
      if (!pl) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A received line does not match this purchase order.' }); }
      const ordered = Number(pl.qty) || 0;
      const already = Number(pl.qtyReceived) || 0;
      const tolerance = Number(po.overReceiptPct) || 0;
      const ceiling = ordered * (1 + tolerance / 100);
      if (already + qty > ceiling + 1e-9) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Cannot receive ${qty} of "${pl.name}" — ${ordered} ordered, ${already} already received.` +
                 (tolerance ? ` Over-receipt tolerance is ${tolerance}%.` : ''),
        });
      }
      work.push({ rl, pl, qty });
    }
    if (!work.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Enter at least one received quantity.' }); }

    // Lock every affected part in a stable order so concurrent receipts on
    // overlapping orders can never deadlock.
    const partIds = [...new Set(work.map((w) => w.pl.partId).filter(Boolean))].sort();
    const partRows = {};
    for (const pid of partIds) {
      const r = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [pid]);
      // A line whose item was deleted must stop the receipt, not be skipped —
      // silently receiving nothing is how a PO shows complete with no stock.
      if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'An item on this order no longer exists. Remove the line first.' }); }
      partRows[pid] = r.rows[0].data;
    }

    // Tracked items must arrive with the identity the item master demands.
    for (const w of work) {
      const p = partRows[w.pl.partId];
      const lots = Array.isArray(w.rl.lots) ? w.rl.lots : [];
      const needs = p.trackBatch || p.trackSerial || p.trackExpiry;
      if (!needs) continue;
      const lotQty = round2(lots.reduce((s, l) => s + (Number(l.qty) || 0), 0));
      if (round2(lotQty) !== round2(w.qty)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `"${p.name}" is tracked — the batch/serial quantities must add up to ${w.qty} (got ${lotQty}).` });
      }
      for (const l of lots) {
        if (p.trackBatch && !String(l.lotNo || '').trim()) { await client.query('ROLLBACK'); return res.status(400).json({ error: `"${p.name}" needs a batch number on every line.` }); }
        if (p.trackExpiry && !String(l.expiryDate || '').trim()) { await client.query('ROLLBACK'); return res.status(400).json({ error: `"${p.name}" needs an expiry date on every line.` }); }
        if (p.trackSerial) {
          if (!String(l.serialNo || '').trim()) { await client.query('ROLLBACK'); return res.status(400).json({ error: `"${p.name}" needs a serial number on every unit.` }); }
          if (Number(l.qty) !== 1) { await client.query('ROLLBACK'); return res.status(400).json({ error: `"${p.name}" is serialised — each serial covers exactly one unit.` }); }
        }
      }
    }

    const grnId = crypto.randomUUID();
    const seq = await allocSeq(client, 'goodsReceipts', 'goods_receipts', 1007, grnId);
    const grnNo = docNo('goodsReceipts', seq);
    const now = Date.now();
    const actor = (req.auth && req.auth.name) || '?';
    const grnLines = [];

    for (const w of work) {
      const p = partRows[w.pl.partId];
      const from = Number(p.stock) || 0;
      const to = round2(from + w.qty);
      const unitCost = round2(Number(w.rl.unitCost != null ? w.rl.unitCost : w.pl.unitCost) || 0);
      // Weighted average: valuation must reflect the blended cost of what is
      // actually on the shelf, not just the latest price paid.
      const oldCost = Number(p.costPrice) || 0;
      const wac = to > 0 ? round2((from * oldCost + w.qty * unitCost) / to) : unitCost;
      const mv = { type: 'in', qty: w.qty, from, to, note: `Received on ${grnNo} (${poNo})`, at: now, by: actor, grnId, poId };
      partRows[w.pl.partId] = { ...p, stock: to, costPrice: wac, movements: (Array.isArray(p.movements) ? p.movements : []).concat([mv]) };
      await postMovement(client, { partId: w.pl.partId, partName: p.name, type: 'in', qty: w.qty, from, to,
        warehouseId: body.warehouseId || '', binId: body.binId || '', unitCost,
        refType: 'grn', refId: grnId, refNo: grnNo, note: `Received on ${grnNo} (${poNo})`, at: now, by: actor });

      // One lot row per batch/serial; untracked items still get a lot so cost
      // layers and returns have something concrete to point at.
      const lots = Array.isArray(w.rl.lots) && w.rl.lots.length
        ? w.rl.lots : [{ qty: w.qty, lotNo: '', serialNo: '', expiryDate: '' }];
      for (const l of lots) {
        const lotQty = Number(l.qty) || 0;
        if (lotQty <= 0) continue;
        await client.query(
          `INSERT INTO stock_lots (id, data, part_id, created_at) VALUES ($1,$2,$3,$4)`,
          [crypto.randomUUID(), JSON.stringify({
            partId: w.pl.partId, partName: p.name || '',
            lotNo: String(l.lotNo || '').trim(), serialNo: String(l.serialNo || '').trim(),
            expiryDate: String(l.expiryDate || '').trim(),
            qty: lotQty, remaining: lotQty, unitCost,
            grnId, grnNo, poId, poNo,
            supplierId: po.supplierId || '', supplierName: po.supplierName || '',
            receivedAt: now, status: 'available', createdAt: now, createdBy: actor,
          }), w.pl.partId, now]
        );
      }

      w.pl.qtyReceived = round2((Number(w.pl.qtyReceived) || 0) + w.qty);
      grnLines.push({
        poLineId: w.pl.id, partId: w.pl.partId, name: w.pl.name || p.name || '',
        qty: w.qty, unitCost, lineTotal: round2(w.qty * unitCost),
        lots: lots.map((l) => ({ lotNo: l.lotNo || '', serialNo: l.serialNo || '', expiryDate: l.expiryDate || '', qty: Number(l.qty) || 0 })),
      });
    }

    for (const pid of partIds) {
      await client.query(`UPDATE parts SET data = $2 WHERE id = $1`, [pid, JSON.stringify(partRows[pid])]);
    }

    // The order's own status follows from its lines, never from a manual flag.
    const fullyReceived = poLines.every((l) => (Number(l.qtyReceived) || 0) >= (Number(l.qty) || 0) - 1e-9);
    const poMerged = { ...po, items: poLines, status: fullyReceived ? 'received' : 'partial', lastReceiptAt: now };
    await client.query(`UPDATE purchase_orders SET data = $2 WHERE id = $1`, [poId, JSON.stringify(poMerged)]);

    const grn = {
      poId, poNo, supplierId: po.supplierId || '', supplierName: po.supplierName || '',
      receivedDate: body.receivedDate || tsToDs(now), deliveryNote: String(body.deliveryNote || '').trim(),
      notes: String(body.notes || '').trim(),
      items: grnLines, total: round2(grnLines.reduce((s, l) => s + l.lineTotal, 0)),
      seq, status: 'posted', createdAt: now, createdBy: actor,
    };
    await client.query(`INSERT INTO goods_receipts (id, data, seq, created_at) VALUES ($1,$2,$3,$4)`,
      [grnId, JSON.stringify(grn), seq, now]);

    await client.query('COMMIT');
    audit(req, 'goods-receipt', 'goodsReceipts', grnId, `${grnNo} against ${poNo}`);
    res.json({ id: grnId, ...grn, purchaseOrder: { id: poId, ...poMerged } });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ══════════════════════════════════════════════════════════════════════════
// PURCHASE INVOICE — what the supplier billed, and the liability it creates.
// Posting a supplier bill recognises the payable when the goods arrive, which
// is what makes purchases accrual-based like sales already are. Landed costs
// (freight, customs, clearing) are allocated onto item cost here, because they
// are part of what the goods cost and therefore part of COGS.
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/purchaseInvoices/:id/post', asyncH(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT data, seq FROM purchase_invoices WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase invoice not found.' }); }
    const pi = r.rows[0].data;
    const piNo = docNo('purchaseInvoices', r.rows[0].seq);
    if (pi.status && pi.status !== 'draft') { await client.query('ROLLBACK'); return res.status(400).json({ error: piNo + ' has already been posted.' }); }
    if (periodLocked(pi.invoiceDate)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'The books are locked up to ' + periodLockDate + '.' }); }

    const lines = Array.isArray(pi.items) ? pi.items : [];
    const landed = Array.isArray(pi.landedCosts) ? pi.landedCosts : [];
    const landedTotal = round2(landed.reduce((s, c) => s + (Number(c.amount) || 0), 0));

    // ---- Three-way match: order vs receipt vs invoice ----
    // The control that stops a supplier billing for goods that never arrived.
    // Quantities are matched against what was actually RECEIVED (not ordered),
    // and unit prices against what the order agreed. Both allow a tolerance, so
    // a rounding difference or a small agreed price move doesn't block posting.
    if (pi.poId) {
      const por = await client.query(`SELECT data, seq FROM purchase_orders WHERE id = $1`, [pi.poId]);
      if (!por.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'The purchase order this invoice references no longer exists.' }); }
      const po = por.rows[0].data;
      const poNo = docNo('purchaseOrders', por.rows[0].seq);
      const qtyTol = Number(settingsCache.matchQtyTolerancePct) || 0;
      const priceTol = Number(settingsCache.matchPriceTolerancePct) || 0;

      // Received quantity per item, summed across every line of the order.
      const received = new Map();
      const ordPrice = new Map();
      for (const l of (Array.isArray(po.items) ? po.items : [])) {
        if (!l.partId) continue;
        received.set(l.partId, round2((received.get(l.partId) || 0) + (Number(l.qtyReceived) || 0)));
        if (!ordPrice.has(l.partId)) ordPrice.set(l.partId, Number(l.unitCost) || 0);
      }
      // Quantities already billed on other posted invoices for the same order,
      // so a supplier cannot bill the same delivery twice across two invoices.
      const prev = await client.query(
        `SELECT data FROM purchase_invoices
          WHERE data->>'poId' = $1 AND id <> $2
            AND COALESCE(data->>'status','draft') NOT IN ('draft','cancelled')`,
        [pi.poId, req.params.id]
      );
      const billed = new Map();
      for (const row of prev.rows) {
        for (const l of (Array.isArray(row.data.items) ? row.data.items : [])) {
          if (!l.partId) continue;
          billed.set(l.partId, round2((billed.get(l.partId) || 0) + (Number(l.qty) || 0)));
        }
      }

      for (const l of lines) {
        if (!l.partId) continue;
        const recd = received.get(l.partId) || 0;
        const already = billed.get(l.partId) || 0;
        const ceiling = recd * (1 + qtyTol / 100);
        if (already + (Number(l.qty) || 0) > ceiling + 1e-9) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `"${l.name || 'Item'}" — invoiced ${round2(already + (Number(l.qty) || 0))} against ${recd} received on ${poNo}` +
                   (already ? ` (${already} already billed on another invoice)` : '') +
                   '. Receive the goods first, or correct the invoice.',
          });
        }
        const agreed = ordPrice.get(l.partId);
        if (agreed > 0) {
          const limit = agreed * (1 + priceTol / 100);
          if ((Number(l.unitCost) || 0) > limit + 1e-9) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: `"${l.name || 'Item'}" — billed at ${round2(Number(l.unitCost))} but ${poNo} agreed ${round2(agreed)}` +
                     (priceTol ? ` (tolerance ${priceTol}%)` : '') + '.',
            });
          }
        }
      }
    }

    // Allocate landed cost across the lines. By value is the default because
    // freight on a consignment tracks its worth; by quantity is offered for
    // bulky low-value goods where weight, not value, drives the charge.
    const basis = String(pi.landedAllocation || 'value');
    const lineVal = lines.map((l) => (Number(l.qty) || 0) * (Number(l.unitCost) || 0));
    const lineQty = lines.map((l) => Number(l.qty) || 0);
    const denom = basis === 'qty' ? lineQty.reduce((a, b) => a + b, 0) : lineVal.reduce((a, b) => a + b, 0);

    const partIds = [...new Set(lines.map((l) => l.partId).filter(Boolean))].sort();
    const partRows = {};
    for (const pid of partIds) {
      const pr = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [pid]);
      if (pr.rows.length) partRows[pid] = pr.rows[0].data;
    }

    const now = Date.now();
    const actor = (req.auth && req.auth.name) || '?';
    let allocated = 0;
    lines.forEach((l, i) => {
      if (!landedTotal || !denom) { l.landedShare = 0; return; }
      // Last line absorbs the rounding remainder so the allocation always sums
      // back to exactly the landed total.
      const share = i === lines.length - 1
        ? round2(landedTotal - allocated)
        : round2(landedTotal * ((basis === 'qty' ? lineQty[i] : lineVal[i]) / denom));
      allocated = round2(allocated + share);
      l.landedShare = share;
      const qty = Number(l.qty) || 0;
      l.effectiveUnitCost = qty > 0 ? round2((Number(l.unitCost) || 0) + share / qty) : Number(l.unitCost) || 0;
    });

    // Re-cost the affected items at the landed unit cost. Without this the
    // freight silently disappears and every margin report reads high.
    for (const l of lines) {
      const p = partRows[l.partId];
      if (!p || !l.landedShare) continue;
      const onHand = Number(p.stock) || 0;
      const qty = Number(l.qty) || 0;
      if (onHand <= 0 || qty <= 0) continue;
      const cur = Number(p.costPrice) || 0;
      // Spread this consignment's freight over the units still on hand.
      const uplift = round2(l.landedShare / Math.max(onHand, qty));
      partRows[l.partId] = { ...p, costPrice: round2(cur + uplift) };
    }
    for (const pid of Object.keys(partRows)) {
      await client.query(`UPDATE parts SET data = $2 WHERE id = $1`, [pid, JSON.stringify(partRows[pid])]);
    }

    const merged = sanitizeDoc('purchaseInvoices', {
      ...pi, items: lines, landedTotal, status: 'unpaid',
      amountPaid: Number(pi.amountPaid) || 0, payments: Array.isArray(pi.payments) ? pi.payments : [],
      postedAt: now, postedBy: actor,
    });
    await client.query(`UPDATE purchase_invoices SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(merged)]);
    await client.query('COMMIT');
    audit(req, 'post-purchase-invoice', 'purchaseInvoices', req.params.id, `${piNo} ${merged.total}`);
    res.json({ id: req.params.id, ...merged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Pay a supplier invoice, atomically ----
// Mirrors the customer-payment endpoint: row-locked, overpay rejected, and the
// cash-book entry written in the same transaction as the payment record.
app.post('/api/purchaseInvoices/:id/pay', asyncH(async (req, res) => {
  const amount = round2(Number((req.body || {}).amount));
  const method = String((req.body || {}).method || 'cash');
  const date = String((req.body || {}).date || '').slice(0, 10) || tsToDs(Date.now());
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a payment amount.' });
  if (periodLocked(date)) return res.status(400).json({ error: 'The books are locked up to ' + periodLockDate + '.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT data, seq FROM purchase_invoices WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase invoice not found.' }); }
    const pi = r.rows[0].data;
    const piNo = docNo('purchaseInvoices', r.rows[0].seq);
    if (pi.status === 'draft') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Post ' + piNo + ' before paying it.' }); }
    if (pi.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(400).json({ error: piNo + ' is cancelled.' }); }

    const total = round2(Number(pi.total) || 0);
    const paid = round2(Number(pi.amountPaid) || 0);
    const due = round2(total - paid);
    if (amount > due + 1e-9) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Only ${due.toFixed(2)} is outstanding on ${piNo}.` });
    }
    const now = Date.now();
    const actor = (req.auth && req.auth.name) || '?';
    const payment = { amount, method, date, at: now, by: actor, reference: String((req.body || {}).reference || '').trim() };
    const newPaid = round2(paid + amount);
    const merged = {
      ...pi,
      payments: (Array.isArray(pi.payments) ? pi.payments : []).concat([payment]),
      amountPaid: newPaid,
      status: newPaid >= total - 1e-9 ? 'paid' : 'partial',
      paidAt: newPaid >= total - 1e-9 ? now : pi.paidAt,
    };
    await client.query(`UPDATE purchase_invoices SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(merged)]);

    // Cash leaves the business in the same transaction that records the payment.
    await client.query(`INSERT INTO transactions (id, data, txn_date, created_at) VALUES ($1,$2,$3,$4)`,
      [crypto.randomUUID(), JSON.stringify({
        type: 'expense', date, amount, description: `Supplier payment – ${piNo}`,
        category: 'Spare Parts', paymentMethod: method,
        accountId: (req.body || {}).accountId || '', accountName: (req.body || {}).accountName || '',
        partyType: 'vendor', partyName: pi.supplierName || '', supplierId: pi.supplierId || '',
        reference: piNo, purchaseInvoiceId: req.params.id, createdAt: now, createdBy: actor,
      }), date, now]);

    await client.query('COMMIT');
    audit(req, 'pay-purchase-invoice', 'purchaseInvoices', req.params.id, `${piNo} ${amount}`);
    res.json({ id: req.params.id, ...merged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ══════════════════════════════════════════════════════════════════════════
// PURCHASE RETURN — goods going back to the supplier.
// Stock comes out of the specific lots it went into, so a returned batch stops
// being available for issue and the supplier link survives.
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/purchaseReturns', asyncH(async (req, res) => {
  const body = req.body || {};
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) return res.status(400).json({ error: 'Enter at least one item to return.' });
  if (periodLocked(body.returnDate)) return res.status(400).json({ error: 'The books are locked up to ' + periodLockDate + '.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let grn = null, grnSeq = null;
    if (body.grnId) {
      const g = await client.query(`SELECT data, seq FROM goods_receipts WHERE id = $1 FOR UPDATE`, [body.grnId]);
      if (!g.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Goods receipt not found.' }); }
      grn = g.rows[0].data; grnSeq = g.rows[0].seq;
    }

    const partIds = [...new Set(lines.map((l) => l.partId).filter(Boolean))].sort();
    const partRows = {};
    for (const pid of partIds) {
      const pr = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [pid]);
      if (!pr.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'An item on this return no longer exists.' }); }
      partRows[pid] = pr.rows[0].data;
    }

    // Validate the whole return before any stock moves.
    for (const l of lines) {
      const qty = Number(l.qty) || 0;
      if (qty <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Return quantities must be greater than zero.' }); }
      const p = partRows[l.partId];
      if (qty > (Number(p.stock) || 0) + 1e-9) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Cannot return ${qty} of "${p.name}" — only ${Number(p.stock) || 0} on hand.` });
      }
      if (l.lotId) {
        const lr = await client.query(`SELECT data FROM stock_lots WHERE id = $1 FOR UPDATE`, [l.lotId]);
        if (!lr.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'The selected batch no longer exists.' }); }
        const rem = Number(lr.rows[0].data.remaining) || 0;
        if (qty > rem + 1e-9) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Batch ${lr.rows[0].data.lotNo || lr.rows[0].data.serialNo || ''} has only ${rem} remaining.` });
        }
        l._lot = lr.rows[0].data;
      }
    }

    const retId = crypto.randomUUID();
    const seq = await allocSeq(client, 'purchaseReturns', 'purchase_returns', 1009, retId);
    const retNo = docNo('purchaseReturns', seq);
    const now = Date.now();
    const actor = (req.auth && req.auth.name) || '?';

    for (const l of lines) {
      const p = partRows[l.partId];
      const qty = Number(l.qty) || 0;
      const from = Number(p.stock) || 0, to = round2(from - qty);
      const mv = { type: 'out', qty, from, to, note: `Returned to supplier on ${retNo}`, at: now, by: actor, purchaseReturnId: retId };
      partRows[l.partId] = { ...p, stock: to, movements: (Array.isArray(p.movements) ? p.movements : []).concat([mv]) };
      await postMovement(client, { partId: l.partId, partName: p.name, type: 'out', qty, from, to,
        lotId: l.lotId || '', unitCost: l.unitCost,
        refType: 'return', refId: retId, refNo: retNo, note: `Returned to supplier on ${retNo}`, at: now, by: actor });
      if (l.lotId && l._lot) {
        const rem = round2((Number(l._lot.remaining) || 0) - qty);
        await client.query(`UPDATE stock_lots SET data = $2 WHERE id = $1`,
          [l.lotId, JSON.stringify({ ...l._lot, remaining: rem, status: rem <= 1e-9 ? 'returned' : 'available', returnedAt: now })]);
      }
    }
    for (const pid of partIds) {
      await client.query(`UPDATE parts SET data = $2 WHERE id = $1`, [pid, JSON.stringify(partRows[pid])]);
    }

    const doc = sanitizeDoc('purchaseReturns', {
      grnId: body.grnId || '', grnNo: grnSeq ? docNo('goodsReceipts', grnSeq) : '',
      poId: (grn && grn.poId) || body.poId || '',
      supplierId: (grn && grn.supplierId) || body.supplierId || '',
      supplierName: (grn && grn.supplierName) || body.supplierName || '',
      returnDate: body.returnDate || tsToDs(now),
      reason: String(body.reason || '').trim(),
      creditNoteNo: String(body.creditNoteNo || '').trim(),
      items: lines.map((l) => ({ partId: l.partId, name: l.name || '', qty: Number(l.qty) || 0, unitCost: round2(Number(l.unitCost) || 0), lotId: l.lotId || '' })),
      seq, status: 'posted', createdAt: now, createdBy: actor,
    });
    await client.query(`INSERT INTO purchase_returns (id, data, seq, created_at) VALUES ($1,$2,$3,$4)`,
      [retId, JSON.stringify(doc), seq, now]);

    await client.query('COMMIT');
    audit(req, 'purchase-return', 'purchaseReturns', retId, retNo);
    res.json({ id: retId, ...doc });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Approve / cancel a purchase order ----
// Approval is the control that separates "someone wants this" from "the garage
// has committed to pay for it", and it is what receiving checks against.
app.post('/api/purchaseOrders/:id/status', asyncH(async (req, res) => {
  const next = String((req.body || {}).status || '');
  const ALLOWED = { draft: ['submitted', 'cancelled'], submitted: ['approved', 'draft', 'cancelled'], approved: ['cancelled'], partial: ['closed', 'cancelled'], received: ['closed'], closed: [], cancelled: [] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT data, seq FROM purchase_orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase order not found.' }); }
    const po = r.rows[0].data;
    const cur = po.status || 'draft';
    if (!(ALLOWED[cur] || []).includes(next)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `A ${cur} order cannot move to ${next}.` });
    }
    // Cancelling after goods have arrived would strand the stock already booked.
    if (next === 'cancelled' && (Array.isArray(po.items) ? po.items : []).some((l) => (Number(l.qtyReceived) || 0) > 0)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Goods have already been received against this order — raise a purchase return instead.' });
    }
    const actor = (req.auth && req.auth.name) || '?';
    const merged = { ...po, status: next };
    if (next === 'submitted') { merged.submittedBy = actor; merged.submittedAt = Date.now(); }
    if (next === 'approved') { merged.approvedBy = actor; merged.approvedAt = Date.now(); }
    if (next === 'cancelled') { merged.cancelledBy = actor; merged.cancelledAt = Date.now(); merged.cancelReason = String((req.body || {}).reason || '').trim(); }
    if (next === 'closed') { merged.closedBy = actor; merged.closedAt = Date.now(); }
    await client.query(`UPDATE purchase_orders SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(merged)]);
    await client.query('COMMIT');
    audit(req, 'po-' + next, 'purchaseOrders', req.params.id, docNo('purchaseOrders', r.rows[0].seq));
    res.json({ id: req.params.id, ...merged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ══════════════════════════════════════════════════════════════════════════
// STOCK TRANSFER — move stock between warehouses or bins.
// On-hand total does not change; where it sits does. Both legs are written so
// the ledger reconciles per location, not just per item.
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/stockTransfers', asyncH(async (req, res) => {
  const b = req.body || {};
  const lines = Array.isArray(b.items) ? b.items : [];
  if (!b.fromWarehouseId || !b.toWarehouseId) return res.status(400).json({ error: 'Choose where the stock is moving from and to.' });
  if (b.fromWarehouseId === b.toWarehouseId && (b.fromBinId || '') === (b.toBinId || '')) {
    return res.status(400).json({ error: 'The source and destination are the same.' });
  }
  if (!lines.length) return res.status(400).json({ error: 'Add at least one item to transfer.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const partIds = [...new Set(lines.map((l) => l.partId).filter(Boolean))].sort();
    const rows = {};
    for (const pid of partIds) {
      const r = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [pid]);
      if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'An item on this transfer no longer exists.' }); }
      rows[pid] = r.rows[0].data;
    }
    // Validate everything before moving anything.
    for (const l of lines) {
      const qty = Number(l.qty) || 0;
      if (qty <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Transfer quantities must be greater than zero.' }); }
      const onHand = Number(rows[l.partId].stock) || 0;
      const held = await reservedQty(client, l.partId);
      if (qty > round2(onHand - held) + 1e-9) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Cannot transfer ${qty} of "${rows[l.partId].name}" — ${onHand} on hand, ${held} reserved for job cards.` });
      }
    }

    const id = crypto.randomUUID();
    const seq = await allocSeq(client, 'stockTransfers', 'stock_transfers', 1010, id);
    const no = 'TRF-' + String(seq).padStart(4, '0');
    const now = Date.now();
    const actor = (req.auth && req.auth.name) || '?';

    for (const l of lines) {
      const p = rows[l.partId];
      const qty = Number(l.qty) || 0;
      const bal = Number(p.stock) || 0;
      // Out of the source, into the destination: the running balance is
      // unchanged, but each location gets its own ledger entry.
      await postMovement(client, { partId: l.partId, partName: p.name, type: 'out', qty, from: bal, to: bal,
        warehouseId: b.fromWarehouseId, binId: b.fromBinId || '', refType: 'transfer', refId: id, refNo: no,
        note: 'Transferred out on ' + no, at: now, by: actor });
      await postMovement(client, { partId: l.partId, partName: p.name, type: 'in', qty, from: bal, to: bal,
        warehouseId: b.toWarehouseId, binId: b.toBinId || '', refType: 'transfer', refId: id, refNo: no,
        note: 'Transferred in on ' + no, at: now, by: actor });
      // Follow the lots so batch traceability survives the move.
      if (l.lotId) {
        await client.query(
          `UPDATE stock_lots SET data = data || $2::jsonb WHERE id = $1`,
          [l.lotId, JSON.stringify({ warehouseId: b.toWarehouseId, binId: b.toBinId || '' })]
        );
      }
    }

    const doc = {
      fromWarehouseId: b.fromWarehouseId, fromWarehouseName: b.fromWarehouseName || '',
      toWarehouseId: b.toWarehouseId, toWarehouseName: b.toWarehouseName || '',
      fromBinId: b.fromBinId || '', toBinId: b.toBinId || '',
      transferDate: b.transferDate || tsToDs(now), reason: String(b.reason || '').trim(),
      items: lines.map((l) => ({ partId: l.partId, name: l.name || '', qty: Number(l.qty) || 0, lotId: l.lotId || '' })),
      seq, status: 'posted', createdAt: now, createdBy: actor,
    };
    await client.query(`INSERT INTO stock_transfers (id, data, seq, created_at) VALUES ($1,$2,$3,$4)`,
      [id, JSON.stringify(doc), seq, now]);
    await client.query('COMMIT');
    audit(req, 'stock-transfer', 'stockTransfers', id, no);
    res.json({ id, ...doc });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ══════════════════════════════════════════════════════════════════════════
// PHYSICAL STOCK COUNT — a blind count, then a single posting of the variance.
// Counting and adjusting are deliberately separate: the count is evidence, the
// adjustment is the correction, and both stay on the record.
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/stockCounts', asyncH(async (req, res) => {
  const b = req.body || {};
  const lines = Array.isArray(b.items) ? b.items : [];
  if (!lines.length) return res.status(400).json({ error: 'A count needs at least one item.' });
  if (periodLocked(b.countDate)) return res.status(400).json({ error: 'The books are locked up to ' + periodLockDate + '.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const partIds = [...new Set(lines.map((l) => l.partId).filter(Boolean))].sort();
    const rows = {};
    for (const pid of partIds) {
      const r = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [pid]);
      if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'An item on this count no longer exists.' }); }
      rows[pid] = r.rows[0].data;
    }

    const id = crypto.randomUUID();
    const seq = await allocSeq(client, 'stockCounts', 'stock_counts', 1011, id);
    const no = 'CNT-' + String(seq).padStart(4, '0');
    const now = Date.now();
    const actor = (req.auth && req.auth.name) || '?';
    const post = b.post !== false;   // a count can be saved for review before posting
    const counted = [];
    let varianceValue = 0;

    for (const l of lines) {
      const p = rows[l.partId];
      // The system figure is read HERE, under lock, not whatever the counter's
      // screen showed when they started — otherwise a sale during the count is
      // silently written off as shrinkage.
      const systemQty = round2(Number(p.stock) || 0);
      const countedQty = round2(Number(l.countedQty) || 0);
      const diff = round2(countedQty - systemQty);
      const cost = Number(p.costPrice) || 0;
      varianceValue = round2(varianceValue + diff * cost);
      counted.push({ partId: l.partId, name: p.name || '', systemQty, countedQty, variance: diff, unitCost: round2(cost), note: (l.note || '').trim() });

      if (post && diff !== 0) {
        await postMovement(client, {
          partId: l.partId, partName: p.name, type: diff > 0 ? 'in' : 'out', qty: Math.abs(diff),
          from: systemQty, to: countedQty, warehouseId: b.warehouseId || '',
          refType: 'count', refId: id, refNo: no, unitCost: cost,
          note: 'Stock count ' + no + (l.note ? ' — ' + l.note : ''), at: now, by: actor,
        });
        await client.query(`UPDATE parts SET data = data || $2::jsonb WHERE id = $1`,
          [l.partId, JSON.stringify({ stock: countedQty })]);
      }
    }

    const doc = {
      countDate: b.countDate || tsToDs(now), warehouseId: b.warehouseId || '', warehouseName: b.warehouseName || '',
      countedBy: String(b.countedBy || actor).trim(), notes: String(b.notes || '').trim(),
      items: counted, varianceValue,
      itemsCounted: counted.length, itemsWithVariance: counted.filter((c) => c.variance !== 0).length,
      seq, status: post ? 'posted' : 'draft', postedAt: post ? now : null,
      createdAt: now, createdBy: actor,
    };
    await client.query(`INSERT INTO stock_counts (id, data, seq, created_at) VALUES ($1,$2,$3,$4)`,
      [id, JSON.stringify(doc), seq, now]);
    await client.query('COMMIT');
    audit(req, post ? 'stock-count-post' : 'stock-count-draft', 'stockCounts', id, `${no} variance ${varianceValue}`);
    res.json({ id, ...doc });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Reserve stock for a job card ----
// A reservation promises stock without moving it, so two open jobs cannot both
// plan to use the last alternator.
app.post('/api/reservations/reserve', asyncH(async (req, res) => {
  const b = req.body || {};
  const qty = round2(Number(b.qty));
  if (!b.partId || !(qty > 0)) return res.status(400).json({ error: 'Choose an item and a quantity.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [b.partId]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item not found.' }); }
    const p = r.rows[0].data;
    const onHand = round2(Number(p.stock) || 0);
    const held = await reservedQty(client, b.partId);
    const free = round2(onHand - held);
    if (qty > free + 1e-9) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${free} of "${p.name}" is free — ${onHand} on hand, ${held} already reserved.` });
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const doc = {
      partId: b.partId, partName: p.name || '', qty,
      jobCardId: b.jobCardId || '', jobCardNo: b.jobCardNo || '',
      status: 'open', note: String(b.note || '').trim(),
      createdAt: now, createdBy: (req.auth && req.auth.name) || '?',
    };
    await client.query(`INSERT INTO reservations (id, data, part_id, created_at) VALUES ($1,$2,$3,$4)`,
      [id, JSON.stringify(doc), b.partId, now]);
    await client.query('COMMIT');
    audit(req, 'reserve', 'reservations', id, `${p.name} ×${qty}`);
    res.json({ id, ...doc, freeAfter: round2(free - qty) });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// Release a reservation (job cancelled, or the part was actually issued).
app.post('/api/reservations/:id/release', asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT data FROM reservations WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Reservation not found.' });
  if (rows[0].data.status !== 'open') return res.status(400).json({ error: 'That reservation is already closed.' });
  const merged = { ...rows[0].data, status: String((req.body || {}).status || 'released'), closedAt: Date.now(), closedBy: (req.auth && req.auth.name) || '?' };
  await pool.query(`UPDATE reservations SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(merged)]);
  audit(req, 'release-reservation', 'reservations', req.params.id, merged.partName || '');
  res.json({ id: req.params.id, ...merged });
}));

// ---- Tool issue / return ----
// Workshop tools are assets that walk. Issuing one to a technician and getting
// it back is the whole control.
app.post('/api/tools/:id/issue', asyncH(async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT data FROM tools WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tool not found.' }); }
    const t = r.rows[0].data;
    const open = await client.query(
      `SELECT 1 FROM tool_issues WHERE tool_id = $1 AND COALESCE(data->>'status','open') = 'open' LIMIT 1`, [req.params.id]);
    if (open.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: `"${t.name}" is already issued and not yet returned.` }); }
    const id = crypto.randomUUID();
    const now = Date.now();
    const doc = {
      toolId: req.params.id, toolName: t.name || '',
      technicianId: b.technicianId || '', technicianName: b.technicianName || '',
      jobCardId: b.jobCardId || '', issuedAt: now, dueBack: b.dueBack || '',
      status: 'open', note: String(b.note || '').trim(),
      createdAt: now, createdBy: (req.auth && req.auth.name) || '?',
    };
    await client.query(`INSERT INTO tool_issues (id, data, tool_id, created_at) VALUES ($1,$2,$3,$4)`,
      [id, JSON.stringify(doc), req.params.id, now]);
    await client.query(`UPDATE tools SET data = data || $2::jsonb WHERE id = $1`,
      [req.params.id, JSON.stringify({ status: 'issued', issuedTo: doc.technicianName })]);
    await client.query('COMMIT');
    audit(req, 'issue-tool', 'tools', req.params.id, `${t.name} → ${doc.technicianName}`);
    res.json({ id, ...doc });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

app.post('/api/toolIssues/:id/return', asyncH(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT data FROM tool_issues WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Issue record not found.' }); }
    const iss = r.rows[0].data;
    if (iss.status !== 'open') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'That tool has already been returned.' }); }
    const now = Date.now();
    const cond = String((req.body || {}).condition || 'ok');
    const merged = { ...iss, status: 'returned', returnedAt: now, condition: cond, returnNote: String((req.body || {}).note || '').trim() };
    await client.query(`UPDATE tool_issues SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(merged)]);
    await client.query(`UPDATE tools SET data = data || $2::jsonb WHERE id = $1`,
      [iss.toolId, JSON.stringify({ status: cond === 'damaged' ? 'damaged' : 'available', issuedTo: '' })]);
    await client.query('COMMIT');
    audit(req, 'return-tool', 'tools', iss.toolId, iss.toolName || '');
    res.json({ id: req.params.id, ...merged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ══════════════════════════════════════════════════════════════════════════
// CUSTOMER CREDIT
// What a customer owes, against what they are allowed to owe. Without this a
// credit account grows without limit and nobody notices until it is a bad debt.
// ══════════════════════════════════════════════════════════════════════════
async function creditStatus(customerId, client) {
  const q = client || pool;
  const cr = await q.query(`SELECT data FROM customers WHERE id = $1`, [customerId]);
  if (!cr.rows.length) return null;
  const c = cr.rows[0].data;
  // Outstanding = invoiced but not yet collected, across every open invoice.
  const inv = await q.query(
    `SELECT COALESCE(SUM(
        GREATEST(COALESCE((data->>'total')::numeric,0) - COALESCE((data->>'totalPaid')::numeric,0), 0)
     ),0) AS owed,
     COUNT(*) FILTER (WHERE COALESCE((data->>'total')::numeric,0) - COALESCE((data->>'totalPaid')::numeric,0) > 0.005) AS open_count
       FROM invoices
      WHERE data->>'customerId' = $1
        AND COALESCE(data->>'status','') <> 'cancelled'`,
    [customerId]
  );
  const outstanding = round2(Number(inv.rows[0].owed) || 0);
  const limit = round2(Number(c.creditLimit) || 0);
  const onHold = c.creditHold === true;
  // Oldest unpaid invoice, which is what "overdue" is actually measured from.
  const oldest = await q.query(
    `SELECT data FROM invoices
      WHERE data->>'customerId' = $1
        AND COALESCE((data->>'total')::numeric,0) - COALESCE((data->>'totalPaid')::numeric,0) > 0.005
      ORDER BY created_at ASC LIMIT 1`,
    [customerId]
  );
  let oldestDays = 0;
  if (oldest.rows.length) {
    const t = Number(oldest.rows[0].data.createdAt) || 0;
    if (t) oldestDays = Math.max(0, Math.floor((Date.now() - t) / 86400000));
  }
  const creditDays = Number(c.creditDays) || 0;
  return {
    customerId, name: c.name || '', creditLimit: limit, outstanding,
    available: limit > 0 ? round2(limit - outstanding) : null,
    openInvoices: Number(inv.rows[0].open_count) || 0,
    creditHold: onHold, creditDays, oldestUnpaidDays: oldestDays,
    overdue: creditDays > 0 && oldestDays > creditDays,
    // A limit of 0 means "no credit account", not "unlimited" — that reading is
    // how an unlimited account gets created by leaving a field blank.
    blocked: onHold || (limit > 0 && outstanding >= limit) || (creditDays > 0 && oldestDays > creditDays),
  };
}

app.get('/api/customers/:id/credit', asyncH(async (req, res) => {
  const st = await creditStatus(req.params.id);
  if (!st) return res.status(404).json({ error: 'Customer not found.' });
  res.json(st);
}));

// ---- Reorder report ----
// What to buy, computed server-side so the answer is the same on every device
// and doesn't require loading the whole catalogue into the browser.
app.get('/api/reports/reorder', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.data,
            COALESCE((SELECT SUM((r.data->>'qty')::numeric) FROM reservations r
                       WHERE r.part_id = p.id AND COALESCE(r.data->>'status','open') = 'open'), 0) AS reserved,
            COALESCE((SELECT SUM(COALESCE((li->>'qty')::numeric,0) - COALESCE((li->>'qtyReceived')::numeric,0))
                        FROM purchase_orders po,
                             jsonb_array_elements(COALESCE(po.data->'items','[]'::jsonb)) AS t(li)
                       WHERE li->>'partId' = p.id
                         AND po.data->>'status' IN ('approved','partial')), 0) AS on_order
       FROM parts p
      WHERE COALESCE((p.data->>'active')::boolean, true) = true`
  );
  const out = [];
  for (const r of rows) {
    const d = r.data;
    const onHand = round2(Number(d.stock) || 0);
    const reserved = round2(Number(r.reserved) || 0);
    const onOrder = round2(Math.max(0, Number(r.on_order || 0)));
    const free = round2(onHand - reserved);
    const reorderAt = Number(d.reorderLevel) || Number(d.minStock) || 0;
    // Available INCLUDING what is already on its way — ordering again for stock
    // that is already coming is the most common over-buy.
    const projected = round2(free + onOrder);
    if (reorderAt <= 0 || projected > reorderAt) continue;
    const target = Number(d.maxStock) > 0 ? Number(d.maxStock) : reorderAt * 2;
    out.push({
      id: r.id, name: d.name || '', partNumber: d.partNumber || '',
      category: d.category || '', supplierId: d.supplierId || '', supplier: d.supplier || '',
      onHand, reserved, free, onOrder, projected, reorderLevel: reorderAt,
      maxStock: Number(d.maxStock) || 0, suggestedQty: round2(Math.max(0, target - projected)),
      unitCost: round2(Number(d.costPrice) || 0),
      status: onHand <= 0 ? 'out' : (free <= 0 ? 'committed' : 'low'),
    });
  }
  out.sort((a, b) => (a.projected - a.reorderLevel) - (b.projected - b.reorderLevel));
  res.json({ generatedAt: Date.now(), count: out.length, items: out });
}));

// ---- Stock availability for one item ----
app.get('/api/parts/:id/availability', asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT data FROM parts WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Item not found.' });
  const onHand = round2(Number(rows[0].data.stock) || 0);
  const reserved = await reservedQty(null, req.params.id);
  const lots = await pool.query(
    `SELECT id, data FROM stock_lots
      WHERE part_id = $1 AND (data->>'remaining')::numeric > 0
      ORDER BY COALESCE(NULLIF(data->>'expiryDate',''), '9999-12-31') ASC, created_at ASC`,
    [req.params.id]
  );
  res.json({
    partId: req.params.id, onHand, reserved, available: round2(onHand - reserved),
    // Ordered expiry-first then oldest-first: the sequence a FEFO issue follows.
    lots: lots.rows.map((l) => ({ id: l.id, ...l.data })),
  });
}));

// ---- Adjust part stock, atomically ----
// Row-locked read-modify-write so two devices can never erase each other's
// movements; stock can never go negative.
app.post('/api/parts/:id/adjust', asyncH(async (req, res) => {
  const { type, note } = req.body || {};
  const qty = Number((req.body || {}).qty);
  if (!['in', 'out', 'set'].includes(type)) return res.status(400).json({ error: 'type must be in, out or set' });
  if (!Number.isFinite(qty) || qty < 0 || (type !== 'set' && qty === 0)) return res.status(400).json({ error: 'Invalid quantity.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Part not found' }); }
    const p = cur.rows[0].data;
    const from = Number(p.stock) || 0;
    let to;
    if (type === 'in') to = from + qty;
    else if (type === 'out') {
      if (qty > from) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient stock — only ' + from + ' on hand.' }); }
      to = from - qty;
    } else to = qty;
    const movement = { type, qty, from, to, note: (note || '').trim(), at: Date.now(), by: (req.auth && req.auth.name) || '' };
    const merged = { ...p, stock: to, movements: (Array.isArray(p.movements) ? p.movements : []).concat([movement]) };
    await client.query(`UPDATE parts SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(merged)]);
    await postMovement(client, { partId: req.params.id, partName: p.name, type, qty, from, to,
      refType: 'adjust', unitCost: p.costPrice, note: (note || '').trim(), by: (req.auth && req.auth.name) || '' });
    await client.query('COMMIT');
    audit(req, 'stock-' + type, 'parts', req.params.id, (p.name || '') + ' ' + from + '→' + to);
    res.json({ id: req.params.id, ...merged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Issue a part to a job card, atomically ----
// Locks the part then the job card (consistent order → no deadlock), deducts
// stock (blocking negative), records a movement noting the JC, and appends the
// part line to the job card's parts[]. One transaction: stock and the job card
// can never disagree about what was issued.
app.post('/api/jobCards/:id/parts', asyncH(async (req, res) => {
  const { partId } = req.body || {};
  const qty = Number((req.body || {}).qty);
  if (!partId || !Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'partId and a positive qty are required.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pr = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [partId]);
    if (!pr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Part not found' }); }
    const jr = await client.query(`SELECT data, seq FROM job_cards WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Job card not found' }); }
    const p = pr.rows[0].data, jc = jr.rows[0].data;
    const from = Number(p.stock) || 0;
    // Stock promised to ANOTHER job card is not available to this one. Without
    // this, two open jobs both plan around the last alternator and the second
    // discovers the problem with the car already stripped.
    const heldElsewhere = round2(Number((await client.query(
      `SELECT COALESCE(SUM((data->>'qty')::numeric),0) n FROM reservations
        WHERE part_id = $1 AND COALESCE(data->>'status','open') = 'open'
          AND COALESCE(data->>'jobCardId','') <> $2`,
      [partId, req.params.id])).rows[0].n) || 0);
    const available = round2(from - heldElsewhere);
    if (qty > available) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: heldElsewhere
          ? `Only ${available} of ${p.name || 'this part'} is free — ${from} on hand, ${heldElsewhere} reserved for other job cards.`
          : 'Insufficient stock — only ' + from + ' of ' + (p.name || 'this part') + ' on hand.',
      });
    }
    const jcNo = 'JC-' + String(jr.rows[0].seq || 0).padStart(4, '0');
    const to = from - qty;
    const mv = { type: 'out', qty, from, to, note: 'Issued to ' + jcNo, at: Date.now(), by: (req.auth && req.auth.name) || '' };
    const pMerged = { ...p, stock: to, movements: (Array.isArray(p.movements) ? p.movements : []).concat([mv]) };
    await postMovement(client, { partId, partName: p.name, type: 'out', qty, from, to,
      unitCost: p.costPrice, refType: 'issue', refId: req.params.id, refNo: jcNo,
      note: 'Issued to ' + jcNo, by: (req.auth && req.auth.name) || '' });
    await client.query(`UPDATE parts SET data = $2 WHERE id = $1`, [partId, JSON.stringify(pMerged)]);
    const line = {
      id: crypto.randomUUID(), partId, name: p.name || '', qty,
      unitPrice: round2(Number(req.body.unitPrice != null ? req.body.unitPrice : p.sellingPrice) || 0),
      costPrice: round2(Number(p.costPrice) || 0),
    };
    line.cost = round2(line.unitPrice * qty); // billed amount for this line
    const jcMerged = { ...jc, parts: (Array.isArray(jc.parts) ? jc.parts : []).concat([line]) };
    await client.query(`UPDATE job_cards SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(jcMerged)]);
    await client.query('COMMIT');
    audit(req, 'issue-part', 'jobCards', req.params.id, (p.name || '') + ' ×' + qty);
    res.json({ id: req.params.id, ...jcMerged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Return an issued part from a job card (reverses the stock deduction) ----
app.post('/api/jobCards/:id/parts/return', asyncH(async (req, res) => {
  const { lineId } = req.body || {};
  if (!lineId) return res.status(400).json({ error: 'lineId required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query(`SELECT data, seq FROM job_cards WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Job card not found' }); }
    const jc = jr.rows[0].data;
    const lines = Array.isArray(jc.parts) ? jc.parts : [];
    const line = lines.find((l) => l.id === lineId);
    if (!line) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Part line not found' }); }
    if (line.partId) {
      const pr = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [line.partId]);
      if (pr.rows.length) {
        const p = pr.rows[0].data, from = Number(p.stock) || 0, to = from + Number(line.qty || 0);
        const jcNo = 'JC-' + String(jr.rows[0].seq || 0).padStart(4, '0');
        const mv = { type: 'in', qty: Number(line.qty || 0), from, to, note: 'Returned from ' + jcNo, at: Date.now(), by: (req.auth && req.auth.name) || '' };
        await client.query(`UPDATE parts SET data = $2 WHERE id = $1`, [line.partId, JSON.stringify({ ...p, stock: to, movements: (Array.isArray(p.movements) ? p.movements : []).concat([mv]) })]);
      }
    }
    const jcMerged = { ...jc, parts: lines.filter((l) => l.id !== lineId) };
    await client.query(`UPDATE job_cards SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(jcMerged)]);
    await client.query('COMMIT');
    audit(req, 'return-part', 'jobCards', req.params.id, (line.name || '') + ' ×' + line.qty);
    res.json({ id: req.params.id, ...jcMerged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Update (shallow merge, matching Firestore .update()) ----
app.put('/api/:coll/:id', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
  // Editing a posted receipt or return after the fact would silently desync the
  // document from the stock movement it caused.
  if (DEDICATED_WRITE.has(req.params.coll)) {
    return res.status(400).json({ error: 'This record is created by a posting and cannot be edited. Raise a correcting document instead.' });
  }
  const patch = sanitizeDoc(req.params.coll, { ...req.body });
  delete patch.id;
  patch.updatedBy = (req.auth && req.auth.name) || '?';
  patch.updatedAt = Date.now();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT data FROM ${cfg.table} WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    let merged = { ...cur.rows[0].data, ...patch };
    // Re-derive invoice money from the MERGED items so a bare {total:…} patch
    // (no items) can never desync the total from the lines. Paid amounts are
    // owned by POST /api/invoices/:id/pay — a raw PUT may change lifecycle
    // status (delivered, credit terms) but never rewrite payments/totalPaid.
    if (req.params.coll === 'invoices') {
      if ('totalPaid' in patch || 'payments' in patch) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Payments must be recorded via the payment endpoint.' });
      }
      merged = sanitizeDoc('invoices', merged);
    }
    // Master data is re-derived and re-validated from the MERGED document, so a
    // partial patch can't slip past rules the full document would have failed.
    if (req.params.coll === 'masters' || req.params.coll === 'services') {
      merged = sanitizeDoc(req.params.coll, merged);
      const bad = await validateDoc(req.params.coll, merged, req.params.id);
      if (bad) { await client.query('ROLLBACK'); return res.status(400).json({ error: bad }); }
      // Retiring a master that live records still point at would silently blank
      // those fields in the UI — block it the same way a delete is blocked.
      if (merged.active === false && cur.rows[0].data.active !== false) {
        const inUse = await masterInUse(req.params.coll, req.params.id);
        if (inUse) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Cannot deactivate — ' + inUse + '.' }); }
      }
    }
    if (req.params.coll === 'parts') {
      const bad = await validateDoc('parts', merged, req.params.id);
      if (bad) { await client.query('ROLLBACK'); return res.status(400).json({ error: bad }); }
    }
    const cols = extractedColumns(cfg, merged);
    if (cfg.seq && merged.seq != null) cols.seq = merged.seq;
    const sets = ['data = $2'];
    const vals = [req.params.id, JSON.stringify(merged)];
    for (const [c, v] of Object.entries(cols)) { vals.push(v); sets.push(`${c} = $${vals.length}`); }
    await client.query(`UPDATE ${cfg.table} SET ${sets.join(', ')} WHERE id = $1`, vals);
    await client.query('COMMIT');
    audit(req, 'update', req.params.coll, req.params.id, merged.seq ? '#' + merged.seq : (merged.name || ''));
    res.json({ id: req.params.id, ...merged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// Referential-integrity guard: refuse to hard-delete a record that other
// records still point at (there are no DB foreign keys), so a delete can never
// silently orphan vehicles/invoices/job-cards or a referenced ledger account.
const hasRow = async (sql, params) => (await pool.query(sql + ' LIMIT 1', params)).rows.length > 0;

// Is this master/service value still referenced by live records? Master data is
// the foundation every other module reads by id, so removing or retiring a value
// in use would blank fields on records that are already closed and invoiced.
// Returns a human reason string, or null when the value is safe to remove.
async function masterInUse(coll, id) {
  if (coll === 'services') {
    if (await hasRow(`SELECT 1 FROM job_cards jc WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(jc.data->'works','[]'::jsonb)) w WHERE w->>'serviceId'=$1)`, [id])) return 'this service is used on job cards';
    if (await hasRow(`SELECT 1 FROM estimates e WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.data->'lines','[]'::jsonb)) l WHERE l->>'serviceId'=$1)`, [id])) return 'this service is used on estimates';
    return null;
  }
  const { rows } = await pool.query(`SELECT kind FROM masters WHERE id=$1`, [id]);
  if (!rows.length) return null;
  const refs = {
    category:      [[`parts`, 'categoryId', 'parts'], [`services`, 'categoryId', 'services']],
    brand:         [[`parts`, 'brandId', 'parts']],
    uom:           [[`parts`, 'uomId', 'parts']],
    labourType:    [[`services`, 'labourTypeId', 'services']],
    vehicleMake:   [[`vehicles`, 'makeId', 'vehicles'], [`masters`, 'parentId', 'vehicle models']],
    vehicleModel:  [[`vehicles`, 'modelId', 'vehicles']],
    fuelType:      [[`vehicles`, 'fuelTypeId', 'vehicles']],
    customerGroup: [[`customers`, 'groupId', 'customers']],
    supplierGroup: [[`suppliers`, 'groupId', 'suppliers']],
    taxCode:       [[`parts`, 'taxCodeId', 'parts'], [`services`, 'taxCodeId', 'services']],
  }[rows[0].kind] || [];
  for (const [table, field, label] of refs) {
    if (await hasRow(`SELECT 1 FROM ${table} WHERE data->>'${field}'=$1`, [id])) {
      return `it is still used by existing ${label}`;
    }
  }
  return null;
}

async function deleteBlocker(coll, id) {
  const has = hasRow;
  if (coll === 'masters' || coll === 'services') {
    return await masterInUse(coll, id);
  } else if (coll === 'customers') {
    if (await has(`SELECT 1 FROM vehicles WHERE data->>'customerId'=$1`, [id])) return 'this customer still has vehicles';
    if (await has(`SELECT 1 FROM job_cards WHERE data->>'customerId'=$1`, [id])) return 'this customer still has job cards';
    if (await has(`SELECT 1 FROM invoices WHERE data->>'customerId'=$1`, [id])) return 'this customer still has invoices';
  } else if (coll === 'vehicles') {
    if (await has(`SELECT 1 FROM job_cards WHERE data->>'vehicleId'=$1`, [id])) return 'this vehicle still has job cards';
    if (await has(`SELECT 1 FROM invoices WHERE data->>'vehicleId'=$1`, [id])) return 'this vehicle still has invoices';
  } else if (coll === 'jobCards') {
    if (await has(`SELECT 1 FROM invoices WHERE data->>'jobCardId'=$1`, [id])) return 'this job card has been invoiced';
  } else if (coll === 'invoices') {
    const { rows } = await pool.query(`SELECT data FROM invoices WHERE id=$1`, [id]);
    if (rows.length && Number(rows[0].data.totalPaid || 0) > 0) return 'this invoice has recorded payments — void it instead of deleting';
  } else if (coll === 'technicians') {
    if (await has(`SELECT 1 FROM job_cards jc WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(jc.data->'works','[]'::jsonb)) w WHERE w->>'technicianId'=$1)`, [id])) return 'this technician is assigned to job cards';
  } else if (coll === 'advisors') {
    if (await has(`SELECT 1 FROM job_cards WHERE data->>'advisorId'=$1`, [id])) return 'this advisor is linked to job cards';
  } else if (coll === 'finAccounts') {
    if (await has(`SELECT 1 FROM transactions WHERE data->>'accountId'=$1 OR data->>'debitAccountId'=$1 OR data->>'creditAccountId'=$1`, [id])) return 'this account has posted transactions';
  } else if (coll === 'parts') {
    // An item with stock on hand is an asset on the balance sheet, and one with
    // consumption history is evidence behind posted revenue — neither may vanish.
    const { rows } = await pool.query(`SELECT data FROM parts WHERE id=$1`, [id]);
    if (rows.length) {
      if (Number(rows[0].data.stock || 0) !== 0) return 'this item still has stock on hand — adjust it to zero first';
      if (Array.isArray(rows[0].data.movements) && rows[0].data.movements.length) return 'this item has stock movement history — deactivate it instead of deleting';
    }
    if (await has(`SELECT 1 FROM job_cards jc WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(jc.data->'parts','[]'::jsonb)) p WHERE p->>'partId'=$1)`, [id])) return 'this item has been issued to job cards';
    if (await has(`SELECT 1 FROM purchase_orders po WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(po.data->'items','[]'::jsonb)) l WHERE l->>'partId'=$1)`, [id])) return 'this item appears on purchase orders';
    if (await has(`SELECT 1 FROM stock_lots WHERE part_id=$1`, [id])) return 'this item has received batches on record';
  } else if (coll === 'purchaseOrders') {
    // An order goods have arrived against is the evidence behind those stock
    // movements; deleting it would leave the movements pointing at nothing.
    if (await has(`SELECT 1 FROM goods_receipts WHERE data->>'poId'=$1`, [id])) return 'goods have been received against this order';
    if (await has(`SELECT 1 FROM purchase_invoices WHERE data->>'poId'=$1`, [id])) return 'a supplier invoice references this order';
  } else if (coll === 'goodsReceipts') {
    return 'a goods receipt records stock that has already moved — raise a purchase return instead';
  } else if (coll === 'purchaseReturns') {
    return 'a purchase return records stock that has already moved and cannot be deleted';
  } else if (coll === 'purchaseInvoices') {
    const { rows } = await pool.query(`SELECT data FROM purchase_invoices WHERE id=$1`, [id]);
    if (rows.length) {
      if (Number(rows[0].data.amountPaid || 0) > 0) return 'this invoice has recorded payments';
      if (rows[0].data.status && rows[0].data.status !== 'draft') return 'this invoice has been posted — cancel it instead of deleting';
    }
  } else if (coll === 'suppliers') {
    if (await has(`SELECT 1 FROM purchase_orders WHERE data->>'supplierId'=$1`, [id])) return 'this supplier has purchase orders';
    if (await has(`SELECT 1 FROM purchase_invoices WHERE data->>'supplierId'=$1`, [id])) return 'this supplier has invoices';
    if (await has(`SELECT 1 FROM parts WHERE data->>'supplierId'=$1`, [id])) return 'this supplier is the preferred supplier on items';
  } else if (coll === 'stockLots') {
    return 'stock lots are created by goods receipts and cannot be deleted directly';
  }
  return null;
}

// ---- Delete ----
app.delete('/api/:coll/:id', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
  const blocker = await deleteBlocker(req.params.coll, req.params.id);
  if (blocker) return res.status(409).json({ error: 'Cannot delete — ' + blocker + '. Remove or reassign those first.' });
  await pool.query(`DELETE FROM ${cfg.table} WHERE id = $1`, [req.params.id]);
  audit(req, 'delete', req.params.coll, req.params.id, '');
  res.json({ ok: true });
}));

// ---- Sign out all devices (admin) — invalidates every outstanding token ----
app.post('/api/logout-all', requireAdmin, asyncH(async (req, res) => {
  await bumpAuthEpoch();
  audit(req, 'logout-all', '', '', 'all sessions revoked');
  res.json({ ok: true });
}));

// ---- Audit log (admin) — most recent activity first ----
app.get('/api/audit-log', requireAdmin, asyncH(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const { rows } = await pool.query(`SELECT at, actor, role, action, coll, doc_id, summary FROM audit_log ORDER BY at DESC LIMIT $1`, [limit]);
  res.json(rows);
}));

// ---- Settings (single 'company' doc, merge semantics) ----
app.get('/api/settings/company', asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT data FROM settings WHERE id = 'company'`);
  res.json(rows.length ? { ...rows[0].data, id: 'company' } : null);
}));
app.put('/api/settings/company', asyncH(async (req, res) => {
  const patch = { ...req.body }; delete patch.id;
  const { rows } = await pool.query(
    `INSERT INTO settings (id, data) VALUES ('company', $1)
     ON CONFLICT (id) DO UPDATE SET data = settings.data || $1
     RETURNING data`,
    [JSON.stringify(patch)]
  );
  // Refresh the whole cache from what was actually stored, not from the patch —
  // a partial save must not blank a setting it didn't mention. This is what
  // keeps the period lock and the match tolerances live without a restart.
  settingsCache = rows[0].data || {};
  periodLockDate = settingsCache.lockDate || '';
  res.json({ ...rows[0].data, id: 'company' });
}));

// ---- Full data export (admin only) — the backup path ----
app.get('/api/export', asyncH(async (req, res) => {
  if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const out = { exportedAt: new Date().toISOString(), app: 'tecido-gms' };
  for (const [name, cfg] of Object.entries(COLL)) {
    const { rows } = await pool.query(`SELECT id, data FROM ${cfg.table}`);
    out[name] = rows.map((r) => ({ ...r.data, id: r.id }));
  }
  const s = await pool.query(`SELECT id, data FROM settings`);
  out.settings = s.rows.map((r) => ({ ...r.data, id: r.id }));
  res.set('Content-Disposition', 'attachment; filename="gms-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json(out);
}));

// ---- Images (bytea). Path is the client-chosen storage path, url-encoded. ----
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
app.post('/api/image', asyncH(async (req, res) => {
  const { path: p, mime, base64 } = req.body || {};
  if (!p || !base64) return res.status(400).json({ error: 'path and base64 required' });
  if (!IMG_MIME.test(mime || 'image/jpeg')) return res.status(400).json({ error: 'Only PNG, JPEG, WebP or GIF images are allowed.' });
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Image too large (max 8 MB).' });
  await pool.query(
    `INSERT INTO images (path, mime, bytes, created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (path) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes`,
    [p, mime || 'image/jpeg', bytes, Date.now()]
  );
  res.json({ url: '/api/image?p=' + encodeURIComponent(p), path: p });
}));
app.delete('/api/image', asyncH(async (req, res) => {
  const p = req.query.p;
  if (p) await pool.query(`DELETE FROM images WHERE path = $1`, [p]);
  res.json({ ok: true });
}));

// Unknown /api paths must 404 as JSON, never fall through to the SPA.
app.all('/api/*', (req, res) => res.status(404).json({ error: 'Unknown API route' }));

// ---- Static front-end ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
initSchema()
  .then(loadAuthEpoch)
  .then(loadPeriodLock)
  .then(migrateMovements)
  .then(() => app.listen(PORT, () => console.log(`GMS server on http://localhost:${PORT}`)))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
