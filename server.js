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
  bays:             { table: 'bays',             order: 'created_at ASC NULLS LAST' },
  creditNotes:      { table: 'credit_notes',     order: 'created_at DESC NULLS LAST', seq: true, lock: 1012 },
  users:            { table: 'users',            order: 'created_at ASC NULLS LAST', extra: { username: 'username' } },
  roles:            { table: 'roles',            order: 'created_at ASC NULLS LAST' },
  bankRecs:         { table: 'bank_recs',        order: 'created_at DESC NULLS LAST', seq: true, lock: 1014 },
  branches:         { table: 'branches',         order: 'created_at ASC NULLS LAST' },
  journalEntries:   { table: 'journal_entries',  order: 'entry_date DESC NULLS LAST, seq DESC', extra: { entry_date: 'date' }, seq: true, lock: 1013 },
};

// Document number prefixes, so every module formats a reference identically.
const DOC_PREFIX = {
  jobCards: 'JC', invoices: 'INV', estimates: 'EST', purchaseOrders: 'PO',
  purchaseRequests: 'PR', rfqs: 'RFQ', goodsReceipts: 'GRN',
  purchaseInvoices: 'PINV', purchaseReturns: 'PRTN', creditNotes: 'CN',
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
  if (coll === 'users') {
    if (doc.username != null) doc.username = String(doc.username).trim().toLowerCase();
    // A plaintext password arrives once, is hashed here, and is never stored or
    // returned. Blank means "leave the existing password alone".
    if (doc.password) { doc.passwordHash = hashPin(String(doc.password)); }
    delete doc.password;
    if (doc.active == null) doc.active = true;
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
  if (coll === 'users') {
    if (!String(doc.username || '').trim()) return 'A username is required.';
    if (!/^[a-z0-9._-]{3,32}$/.test(String(doc.username))) return 'Usernames may use letters, numbers, dot, underscore and hyphen (3–32 characters).';
    if (!String(doc.name || '').trim()) return 'Enter the person\'s name.';
    if (!doc.roleId) return 'Choose a role.';
    if (!doc.passwordHash) return 'Set a password.';
  }
  if (coll === 'roles') {
    if (!String(doc.name || '').trim()) return 'A role needs a name.';
    if (!Array.isArray(doc.permissions) || !doc.permissions.length) return 'A role needs at least one permission.';
    const unknown = doc.permissions.filter((p) => !PERMISSIONS[p]);
    if (unknown.length) return 'Unknown permission: ' + unknown[0];
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
// ---- User login ----
// Sits alongside the bootstrap admin from the environment, which stays so a
// garage can never lock itself out of its own system.
app.post('/api/user-login', loginGuard((req) => String((req.body || {}).username || '').trim().toLowerCase()),
  asyncH(async (req, res) => {
  const username = String((req.body || {}).username || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!username || !password) return res.status(400).json({ error: 'Enter your username and password.' });

  const { rows } = await pool.query(`SELECT id, data FROM users WHERE lower(username) = $1`, [username]);
  const u = rows.length ? rows[0].data : null;
  // Same message either way: a wrong username and a wrong password must not be
  // distinguishable, or the login page becomes a user-enumeration tool.
  if (!u || u.active === false || !verifyPin(password, u.passwordHash)) {
    noteLoginFail(req);
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  clearLoginFail(req);
  const role = await permsForRole(u.roleId);
  await pool.query(`UPDATE users SET data = data || $2::jsonb WHERE id = $1`,
    [rows[0].id, JSON.stringify({ lastLoginAt: Date.now() })]);
  res.json({
    ok: true, name: u.name || u.username, userId: rows[0].id,
    roleId: u.roleId, roleName: u.roleName || '',
    permissions: [...role],
    token: signToken({ role: 'user', name: u.name || u.username, userId: rows[0].id, roleId: u.roleId }),
  });
}));

// ---- Unified sign-in ----
// Tries a real user account first, then the bootstrap admin. One call, one
// answer: a client should not have to fire a request it expects to fail.
app.post('/api/auth/login', loginGuard((req) => String((req.body || {}).username || '').trim().toLowerCase()),
  asyncH(async (req, res) => {
  const username = String((req.body || {}).username || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!username || !password) return res.status(400).json({ error: 'Enter your username and password.' });

  const { rows } = await pool.query(`SELECT id, data FROM users WHERE lower(username) = $1`, [username]);
  const u = rows.length ? rows[0].data : null;
  if (u && u.active !== false && verifyPin(password, u.passwordHash)) {
    clearLoginFail(req);
    const perms = await permsForRole(u.roleId);
    await pool.query(`UPDATE users SET data = data || $2::jsonb WHERE id = $1`,
      [rows[0].id, JSON.stringify({ lastLoginAt: Date.now() })]);
    return res.json({
      ok: true, name: u.name || u.username, userId: rows[0].id, roleId: u.roleId,
      roleName: u.roleName || '', permissions: [...perms],
      token: signToken({ role: 'user', name: u.name || u.username, userId: rows[0].id, roleId: u.roleId }),
    });
  }

  // Bootstrap admin: the account that exists so a garage can never lock itself
  // out of its own system.
  const U = (process.env.ADMIN_USER || 'arifpadup').toLowerCase();
  const P = process.env.ADMIN_PASSWORD || '';
  const NAME = process.env.ADMIN_NAME || 'ARIF';
  if (P && username === U && P.length === password.length &&
      crypto.timingSafeEqual(Buffer.from(P), Buffer.from(password))) {
    clearLoginFail(req);
    return res.json({ ok: true, name: NAME, permissions: null, roleName: 'Garage Admin',
      token: signToken({ role: 'admin', name: NAME }) });
  }

  noteLoginFail(req);
  // One message for every failure — a wrong username and a wrong password must
  // not be distinguishable.
  return res.status(401).json({ ok: false, error: 'Incorrect username or password.' });
}));

app.use('/api', requireAuth);

// ══════════════════════════════════════════════════════════════════════════
// PERMISSIONS (Phase 9)
// Named capabilities rather than a binary admin flag. A service advisor should
// be able to raise a job card without also being able to post a journal or edit
// the chart of accounts, and until now there was no way to express that.
// ══════════════════════════════════════════════════════════════════════════
const PERMISSIONS = {
  'masters.view': 'View master data', 'masters.manage': 'Manage master data',
  'customers.view': 'View customers', 'customers.manage': 'Add and edit customers',
  'vehicles.view': 'View vehicles', 'vehicles.manage': 'Add and edit vehicles',
  'jobcards.view': 'View job cards', 'jobcards.manage': 'Create and edit job cards',
  'jobcards.deliver': 'Check in, quality check and deliver vehicles',
  'inventory.view': 'View stock', 'inventory.manage': 'Adjust, transfer and count stock',
  'purchasing.view': 'View purchasing', 'purchasing.manage': 'Raise requests and orders',
  'purchasing.approve': 'Approve purchase orders',
  'purchasing.receive': 'Receive goods',
  'purchasing.invoice': 'Enter and pay supplier invoices',
  'sales.view': 'View invoices', 'sales.manage': 'Raise invoices',
  'sales.payment': 'Take payments', 'sales.credit': 'Issue credit notes and refunds',
  'finance.view': 'View financial reports', 'finance.manage': 'Manage accounts and journals',
  'reports.view': 'View reports',
  'admin.users': 'Manage users and roles', 'admin.settings': 'Change system settings',
  'admin.audit': 'View the audit log', 'admin.backup': 'Export and back up data',
};

// Which permission each route needs. Keyed by collection, then by intent.
const PERM_MAP = {
  masters: ['masters.view', 'masters.manage'], services: ['masters.view', 'masters.manage'],
  customers: ['customers.view', 'customers.manage'], vehicles: ['vehicles.view', 'vehicles.manage'],
  jobCards: ['jobcards.view', 'jobcards.manage'], estimates: ['jobcards.view', 'jobcards.manage'],
  appointments: ['jobcards.view', 'jobcards.manage'],
  parts: ['inventory.view', 'inventory.manage'], stockLots: ['inventory.view', 'inventory.manage'],
  stockMovements: ['inventory.view', 'inventory.manage'], warehouses: ['inventory.view', 'inventory.manage'],
  bins: ['inventory.view', 'inventory.manage'], stockTransfers: ['inventory.view', 'inventory.manage'],
  stockCounts: ['inventory.view', 'inventory.manage'], reservations: ['inventory.view', 'inventory.manage'],
  tools: ['inventory.view', 'inventory.manage'], toolIssues: ['inventory.view', 'inventory.manage'],
  suppliers: ['purchasing.view', 'purchasing.manage'], purchaseRequests: ['purchasing.view', 'purchasing.manage'],
  rfqs: ['purchasing.view', 'purchasing.manage'], purchaseOrders: ['purchasing.view', 'purchasing.manage'],
  goodsReceipts: ['purchasing.view', 'purchasing.receive'],
  purchaseInvoices: ['purchasing.view', 'purchasing.invoice'],
  purchaseReturns: ['purchasing.view', 'purchasing.receive'],
  invoices: ['sales.view', 'sales.manage'], creditNotes: ['sales.view', 'sales.credit'],
  transactions: ['finance.view', 'finance.manage'], finAccounts: ['finance.view', 'finance.manage'],
  journalEntries: ['finance.view', 'finance.manage'],
  bankRecs: ['finance.view', 'finance.manage'],
  branches: ['masters.view', 'admin.settings'],
  technicians: ['jobcards.view', 'admin.users'], advisors: ['jobcards.view', 'admin.users'],
  bays: ['jobcards.view', 'inventory.manage'],
  users: ['admin.users', 'admin.users'], roles: ['admin.users', 'admin.users'],
};

// Sub-actions that need more than the collection's write permission.
const ACTION_PERM = {
  'purchaseOrders/status': 'purchasing.approve',
  'purchaseInvoices/pay': 'purchasing.invoice',
  'invoices/pay': 'sales.payment',
  'invoices/cancel': 'sales.credit',
  'jobCards/checkin': 'jobcards.deliver',
  'jobCards/qc': 'jobcards.deliver',
  'jobCards/deliver': 'jobcards.deliver',
  'jobCards/bay': 'jobcards.manage',
};

// Roles a garage actually has. Created once, then editable.
const DEFAULT_ROLES = [
  { name: 'Owner', system: true, description: 'Everything, including users and the books.',
    permissions: Object.keys(PERMISSIONS) },
  { name: 'Manager', description: 'Runs the garage day to day; cannot manage users.',
    permissions: Object.keys(PERMISSIONS).filter((p) => !p.startsWith('admin.') || p === 'admin.audit') },
  { name: 'Service Advisor', description: 'Front desk: customers, job cards, invoices and payments.',
    permissions: ['masters.view', 'customers.view', 'customers.manage', 'vehicles.view', 'vehicles.manage',
      'jobcards.view', 'jobcards.manage', 'jobcards.deliver', 'inventory.view',
      'sales.view', 'sales.manage', 'sales.payment', 'reports.view'] },
  { name: 'Storekeeper', description: 'Stock and receiving; no pricing or money.',
    permissions: ['masters.view', 'inventory.view', 'inventory.manage', 'purchasing.view',
      'purchasing.manage', 'purchasing.receive', 'jobcards.view', 'reports.view'] },
  { name: 'Accountant', description: 'The books, supplier invoices and credit control.',
    permissions: ['masters.view', 'customers.view', 'sales.view', 'sales.payment', 'sales.credit',
      'purchasing.view', 'purchasing.invoice', 'finance.view', 'finance.manage',
      'reports.view', 'admin.audit', 'admin.backup'] },
  { name: 'Technician', description: 'Shop floor only.',
    permissions: ['jobcards.view', 'inventory.view', 'masters.view'] },
];

async function ensureRoles() {
  try {
    const { rows } = await pool.query(`SELECT data FROM roles`);
    const have = new Set(rows.map((r) => String(r.data.name || '').toLowerCase()));
    for (const r of DEFAULT_ROLES) {
      if (have.has(r.name.toLowerCase())) continue;
      await pool.query(`INSERT INTO roles (id, data, created_at) VALUES ($1,$2,$3)`,
        [crypto.randomUUID(), JSON.stringify({ ...r, createdAt: Date.now() }), Date.now()]);
    }
  } catch (e) { console.warn('[gms] role seed skipped:', e.message); }
}

// Resolve a user's permissions from their role, cached per request-ish.
let roleCache = null;
async function permsForRole(roleId) {
  if (!roleCache) {
    const { rows } = await pool.query(`SELECT id, data FROM roles`);
    roleCache = {};
    for (const r of rows) roleCache[r.id] = r.data;
  }
  const r = roleCache[roleId];
  return new Set((r && Array.isArray(r.permissions)) ? r.permissions : []);
}


// ---- Who am I, and what may I do ----
app.get('/api/me', asyncH(async (req, res) => {
  const a = req.auth || {};
  if (a.role === 'admin') {
    return res.json({ role: 'admin', name: a.name, permissions: Object.keys(PERMISSIONS), isBootstrapAdmin: true });
  }
  if (a.role === 'user') {
    const perms = await permsForRole(a.roleId);
    return res.json({ role: 'user', name: a.name, userId: a.userId, roleId: a.roleId, permissions: [...perms] });
  }
  res.json({ role: a.role || 'none', name: a.name || '', permissions: [] });
}));

// ---- The permission catalogue, for the role editor ----
app.get('/api/permissions', asyncH(async (req, res) => {
  res.json({ permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label, group: key.split('.')[0] })) });
}));

// ══════════════════════════════════════════════════════════════════════════
// BRANCHES — step 1 of docs/BRANCH-ACCESS-DESIGN.md
//
// This creates the default branch and stamps every existing row with it.
// It does NOT filter anything. No query reads branch_id yet, and none should
// until the cross-branch leak suite exists (step 6) — a half-scoped system,
// where some queries filter and some do not, looks safe and is not.
// ══════════════════════════════════════════════════════════════════════════

// Which tier each collection sits in. Written now so the enforcement step has
// one place to read from rather than rediscovering the decision per handler.
const BRANCH_SCOPE = {
  // Shared: one copy company-wide.
  masters: 'shared', services: 'shared', roles: 'shared', users: 'shared', branches: 'shared',
  // Branch-owned: belongs to exactly one branch.
  jobCards: 'owned', estimates: 'owned', invoices: 'owned', creditNotes: 'owned',
  purchaseRequests: 'owned', rfqs: 'owned', purchaseOrders: 'owned', goodsReceipts: 'owned',
  purchaseInvoices: 'owned', purchaseReturns: 'owned', stockTransfers: 'owned',
  stockCounts: 'owned', bankRecs: 'owned', journalEntries: 'owned', stockMovements: 'owned',
  reservations: 'owned', toolIssues: 'owned', transactions: 'owned', appointments: 'owned',
  // Company-wide, but with a home branch for reporting.
  customers: 'home', vehicles: 'home', suppliers: 'home', parts: 'home',
  technicians: 'home', advisors: 'home', tools: 'home', warehouses: 'home',
  bays: 'home', finAccounts: 'home', stockLots: 'home', bins: 'home',
};

async function ensureDefaultBranch() {
  try {
    const existing = await pool.query(`SELECT id, data FROM branches ORDER BY created_at ASC LIMIT 1`);
    if (existing.rows.length) return existing.rows[0].id;

    const cfg = await pool.query(`SELECT data FROM settings WHERE id = 'company'`);
    const company = cfg.rows.length ? cfg.rows[0].data : {};
    const id = crypto.randomUUID();
    const now = Date.now();
    await pool.query(`INSERT INTO branches (id, data, created_at) VALUES ($1,$2,$3)`,
      [id, JSON.stringify({
        name: company.name || 'Main Branch', code: 'MAIN',
        address: company.address || '', city: company.city || '',
        phone: company.phone || '', trn: company.vatNumber || '',
        isDefault: true, active: true, createdAt: now, createdBy: 'system',
      }), now]);

    // Everything that exists belongs to this branch by definition — there has
    // only ever been one. Stamped per collection so a failure part-way leaves
    // the rest to be picked up on the next boot rather than losing the lot.
    let stamped = 0;
    for (const [coll, tier] of Object.entries(BRANCH_SCOPE)) {
      const c = COLL[coll];
      if (!c || tier === 'shared') continue;
      const field = tier === 'owned' ? 'branchId' : 'homeBranchId';
      const r = await pool.query(
        `UPDATE ${c.table} SET data = data || $1::jsonb
          WHERE COALESCE(data->>'${field}','') = ''`,
        [JSON.stringify({ [field]: id })]
      );
      stamped += r.rowCount;
    }
    // journal_lines is not a COLL table but is branch-owned like its header.
    const jl = await pool.query(
      `UPDATE journal_lines SET data = data || $1::jsonb WHERE COALESCE(data->>'branchId','') = ''`,
      [JSON.stringify({ branchId: id })]);
    stamped += jl.rowCount;

    console.log(`Branches: created the default branch and stamped ${stamped} existing row(s). No query filters on it yet.`);
    return id;
  } catch (e) {
    console.warn('[gms] default branch setup skipped:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PER-BRANCH STOCK — step 2 of docs/BRANCH-ACCESS-DESIGN.md
//
// The accessor lands BEFORE any writer is converted, and it READS THROUGH to
// parts.stock when the branch has no row yet. That is what makes this safe to
// ship on its own: with no rows stored, every caller gets exactly the answer it
// got before, so nothing can drift. A backfilled mirror that the fifteen
// existing writers did not update would drift on the first goods receipt and
// become stale data that looks authoritative — which is why there is no
// backfill here.
//
// As each writer is converted (§5.4), it starts writing a row, and from that
// moment this returns the branch figure instead of the fallback.
// ══════════════════════════════════════════════════════════════════════════
const PBS_FIELDS = ['stock', 'costPrice', 'reorderLevel', 'minStock', 'maxStock', 'location'];

// Read a part's stock position for one branch, falling back to the item master.
async function partStock(client, partId, branchId) {
  const q = client || pool;
  if (branchId) {
    const { rows } = await q.query(
      `SELECT data FROM part_branch_stock WHERE part_id = $1 AND branch_id = $2`, [partId, branchId]);
    if (rows.length) return { ...rows[0].data, partId, branchId, source: 'branch' };
  }
  const p = await q.query(`SELECT data FROM parts WHERE id = $1`, [partId]);
  if (!p.rows.length) return null;
  const d = p.rows[0].data;
  const out = { partId, branchId: branchId || null, source: 'master' };
  for (const f of PBS_FIELDS) out[f] = d[f] != null ? d[f] : (f === 'location' ? '' : 0);
  return out;
}

// Write a part's stock position for one branch. Not called by anything yet —
// each writer adopts it as it is converted, one at a time, with its reads.
async function setPartStock(client, partId, branchId, patch) {
  const cur = await partStock(client, partId, branchId);
  const next = {};
  for (const f of PBS_FIELDS) next[f] = patch[f] != null ? patch[f] : (cur ? cur[f] : 0);
  await client.query(
    `INSERT INTO part_branch_stock (part_id, branch_id, data) VALUES ($1,$2,$3)
     ON CONFLICT (part_id, branch_id) DO UPDATE SET data = part_branch_stock.data || EXCLUDED.data`,
    [partId, branchId, JSON.stringify(next)]);
  return next;
}

// Total across every branch, plus whatever still sits only on the master. This
// is what company-wide reports (valuation, reorder) will use during the
// transition so their answer does not change as writers are converted.
async function partStockTotal(client, partId) {
  const q = client || pool;
  const { rows } = await q.query(
    `SELECT COALESCE(SUM(COALESCE((data->>'stock')::numeric,0)),0) n,
            COUNT(*)::int c FROM part_branch_stock WHERE part_id = $1`, [partId]);
  if (Number(rows[0].c) > 0) return round2(Number(rows[0].n) || 0);
  const p = await q.query(`SELECT data FROM parts WHERE id = $1`, [partId]);
  return p.rows.length ? round2(Number(p.rows[0].data.stock) || 0) : 0;
}

// ---- Authorization (RBAC) ----
// Admin: full access. Technician: a tight allowlist — read the shop-floor data
// they need, update job-card work status, and toggle ONLY their own
// availability. Everything else (finance, other people's records, deletes,
// the atomic money/stock endpoints, export, image mutations) is 403.
// Master data is reference material the shop floor reads but never edits, so
// technicians get GET on masters/services and nothing more.
const TECH_READ = new Set(['jobCards', 'technicians', 'customers', 'vehicles', 'parts', 'masters', 'services',
  'warehouses', 'bins', 'stockLots', 'stockMovements', 'reservations', 'tools', 'toolIssues', 'bays']);
async function authorizeUser(req, res, next) {
  // A permissioned user account. Everything is denied unless their role grants
  // it, which is the opposite of the old model.
  const parts = req.path.split('/').filter(Boolean);
  const coll = parts[0], sub = parts[2];
  const perms = await permsForRole(req.auth.roleId);
  const grant = (p) => perms.has(p);

  // Reports and lookups everyone with a login can see.
  if (coll === 'settings' || coll === 'image') return next();
  if (coll === 'reports') return grant('reports.view') || grant('finance.view')
    ? next() : res.status(403).json({ error: 'You do not have permission to view reports.' });
  if (coll === 'audit-log') return grant('admin.audit') ? next() : res.status(403).json({ error: 'You do not have permission to view the audit log.' });
  if (coll === 'export') return grant('admin.backup') ? next() : res.status(403).json({ error: 'You do not have permission to export data.' });
  if (coll === 'logout-all') return grant('admin.users') ? next() : res.status(403).json({ error: 'Admin only.' });

  const map = PERM_MAP[coll];
  if (!map) return res.status(403).json({ error: 'Not permitted for this account.' });
  const needed = req.method === 'GET' ? map[0] : (ACTION_PERM[coll + '/' + sub] || map[1]);
  if (grant(needed)) return next();
  return res.status(403).json({
    error: `Your role does not allow this — it needs "${PERMISSIONS[needed] || needed}".`,
  });
}

function authorize(req, res, next) {
  const role = req.auth && req.auth.role;
  // A real user account is checked against its role's permissions.
  if (role === 'user' && req.auth.roleId) return authorizeUser(req, res, next).catch(next);
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
// A password hash has no reason to leave the server, for anyone.
function redactUsers(docs) {
  return docs.map((d) => { const c = { ...d }; delete c.passwordHash; delete c.password; c.hasPassword = !!d.passwordHash; return c; });
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
  creditNotes: ['invoiceId', 'customerId', 'status'],
  journalEntries: ['refType', 'refId'],
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
  if (req.params.coll === 'users') docs = redactUsers(docs);
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
  if (req.params.coll === 'users') doc = redactUsers([doc])[0];
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

// ══════════════════════════════════════════════════════════════════════════
// DOUBLE-ENTRY GENERAL LEDGER (Phase 7)
//
// Until now the trial balance was derived in the browser from invoices and cash
// transactions. That can never balance, because inventory and cost of sales had
// no representation at all — the goods went out of the door without anything
// recording that they had left. These are the real books.
//
// postJournal() is the ONLY way anything reaches the ledger, and it refuses to
// write an entry whose debits and credits differ. That single check is what
// makes the trial balance an arithmetic certainty rather than a hope.
// ══════════════════════════════════════════════════════════════════════════

// System accounts, resolved by role rather than by name so a garage can rename
// them freely. Held in settings; auto-created on first use.
const SYS_ACCOUNTS = {
  ar:        { name: 'Accounts Receivable',       type: 'asset' },
  ap:        { name: 'Accounts Payable',          type: 'liability' },
  cash:      { name: 'Cash',                      type: 'asset' },
  bank:      { name: 'Bank',                      type: 'asset' },
  inventory: { name: 'Inventory',                 type: 'asset' },
  grni:      { name: 'Goods Received Not Invoiced', type: 'liability' },
  sales:     { name: 'Sales Revenue',             type: 'income' },
  cogs:      { name: 'Cost of Goods Sold',        type: 'expense' },
  vatOut:    { name: 'VAT Payable',               type: 'liability' },
  vatIn:     { name: 'VAT Receivable',            type: 'asset' },
  discount:  { name: 'Discounts Allowed',         type: 'expense' },
  adjust:    { name: 'Stock Adjustments',         type: 'expense' },
  opening:   { name: 'Opening Balance Equity',    type: 'equity' },
};

let sysAccountCache = null;
// Map role -> account id, creating any missing account once. Cached because
// every posting needs it and it changes only when accounts are added.
async function sysAccounts(client) {
  if (sysAccountCache) return sysAccountCache;
  const q = client || pool;
  const { rows } = await q.query(`SELECT id, data FROM fin_accounts`);
  const byRole = {};
  for (const r of rows) if (r.data.systemRole) byRole[r.data.systemRole] = r.id;
  for (const [role, def] of Object.entries(SYS_ACCOUNTS)) {
    if (byRole[role]) continue;
    const id = crypto.randomUUID();
    await q.query(`INSERT INTO fin_accounts (id, data, created_at) VALUES ($1,$2,$3)`,
      [id, JSON.stringify({ name: def.name, type: def.type, systemRole: role, system: true, createdAt: Date.now() }), Date.now()]);
    byRole[role] = id;
  }
  sysAccountCache = byRole;
  return byRole;
}

// Post one balanced journal entry inside the caller's transaction.
// `lines` are { accountId | role, debit, credit, memo, partyId, partyName }.
async function postJournal(client, entry) {
  const acc = await sysAccounts(client);
  const lines = [];
  let dr = 0, cr = 0;
  for (const l of (entry.lines || [])) {
    const accountId = l.accountId || acc[l.role];
    if (!accountId) throw new Error('Journal line has no account (role: ' + l.role + ')');
    const debit = round2(l.debit || 0), credit = round2(l.credit || 0);
    if (debit === 0 && credit === 0) continue;          // nothing to say
    if (debit > 0 && credit > 0) throw new Error('A journal line cannot be both a debit and a credit.');
    dr = round2(dr + debit); cr = round2(cr + credit);
    lines.push({ accountId, debit, credit, memo: l.memo || '', role: l.role || '', partyId: l.partyId || '', partyName: l.partyName || '' });
  }
  if (!lines.length) return null;
  // The invariant. If this ever fires, the caller's arithmetic is wrong and the
  // whole business event is rolled back rather than half-recorded.
  if (Math.abs(dr - cr) > 0.005) {
    throw new Error(`Unbalanced journal: debits ${dr.toFixed(2)} vs credits ${cr.toFixed(2)} (${entry.memo || entry.refNo || ''})`);
  }

  const id = crypto.randomUUID();
  const seq = await allocSeq(client, 'journalEntries', 'journal_entries', 1013, id);
  const date = entry.date || tsToDs(Date.now());
  const doc = {
    seq, no: 'JV-' + String(seq).padStart(5, '0'), date,
    memo: entry.memo || '', refType: entry.refType || '', refId: entry.refId || '', refNo: entry.refNo || '',
    lines, totalDebit: dr, totalCredit: cr,
    createdAt: Date.now(), createdBy: entry.by || '',
  };
  await client.query(`INSERT INTO journal_entries (id, data, seq, entry_date, created_at) VALUES ($1,$2,$3,$4,$5)`,
    [id, JSON.stringify(doc), seq, date, doc.createdAt]);
  for (const l of lines) {
    await client.query(
      `INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, entry_date, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), id, l.accountId, l.debit, l.credit, date,
       JSON.stringify({ memo: l.memo, role: l.role, partyId: l.partyId, partyName: l.partyName, refType: doc.refType, refNo: doc.refNo })]
    );
  }
  return { id, ...doc };
}

// Revenue recognition for a sales invoice, plus the cost of the goods that left
// with it. Selling stock without relieving inventory is exactly why the old
// balance sheet could not balance.
async function postSalesJournal(client, invId, inv, invNo, actor) {
  const sub = round2(Number(inv.subtotal) || 0);
  const disc = round2(Number(inv.discountAmount) || 0);
  const tax = round2(Number(inv.taxAmount) || 0);
  const total = round2(Number(inv.total) || 0);
  const lines = [
    { role: 'ar', debit: total, memo: 'Receivable from ' + (inv.customerName || 'customer'),
      partyId: inv.customerId, partyName: inv.customerName },
    { role: 'sales', credit: sub, memo: 'Revenue' },
    { role: 'discount', debit: disc, memo: 'Discount allowed' },
    { role: 'vatOut', credit: tax, memo: 'Output VAT' },
  ];
  // Cost of sales is NOT posted here. Stock physically leaves when a part is
  // issued to a job card or sold over the counter, and the cost must post at
  // that same moment — otherwise ledger inventory and the quantity on the shelf
  // disagree for as long as the job is open.
  return postJournal(client, {
    date: tsToDs(inv.createdAt) || tsToDs(Date.now()),
    refType: 'invoice', refId: invId, refNo: invNo, by: actor,
    memo: 'Sales invoice ' + invNo, lines,
  });
}

// Consume stock from specific lots, expiry-first then oldest-first (FEFO, which
// degrades to FIFO when nothing carries an expiry date). Until now the lot
// ledger recorded what arrived but nothing decided what LEFT, so a batch could
// sit "remaining" long after those units had been sold.
async function consumeLots(client, partId, qty, ref) {
  const { rows } = await client.query(
    `SELECT id, data FROM stock_lots
      WHERE part_id = $1 AND COALESCE((data->>'remaining')::numeric,0) > 0
        AND COALESCE(data->>'status','available') = 'available'
      ORDER BY COALESCE(NULLIF(data->>'expiryDate',''), '9999-12-31') ASC, created_at ASC
      FOR UPDATE`,
    [partId]
  );
  let left = round2(qty);
  const used = [];
  for (const r of rows) {
    if (left <= 0) break;
    const rem = round2(Number(r.data.remaining) || 0);
    const take = Math.min(rem, left);
    const after = round2(rem - take);
    await client.query(`UPDATE stock_lots SET data = data || $2::jsonb WHERE id = $1`,
      [r.id, JSON.stringify({ remaining: after, status: after <= 1e-9 ? 'consumed' : 'available' })]);
    used.push({ lotId: r.id, lotNo: r.data.lotNo || '', serialNo: r.data.serialNo || '',
                expiryDate: r.data.expiryDate || '', qty: take, unitCost: Number(r.data.unitCost) || 0 });
    left = round2(left - take);
  }
  // Untracked stock predates the lot ledger, so a shortfall is expected and not
  // an error — the quantity on hand remains the authority.
  return { used, unallocated: left, ref };
}

// Collections that may ONLY be written by their dedicated endpoint. A goods
// receipt that did not move stock, or a return that did not come out of a lot,
// would be a document describing something that never happened — so the generic
// CRUD path hands these straight on to the engine that owns them.
const DEDICATED_WRITE = new Set(['goodsReceipts', 'purchaseReturns', 'stockLots', 'stockMovements', 'stockTransfers', 'stockCounts', 'creditNotes', 'journalEntries']);

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
    // A sales invoice is a business event: recognise the revenue, the tax and the
    // cost of what left the shelf, all inside the same transaction.
    if (req.params.coll === 'invoices' && isNew && body.status !== 'cancelled') {
      await postSalesJournal(client, id, body, docNo('invoices', body.seq), (req.auth && req.auth.name) || '');
    }
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
    const cur = await client.query(`SELECT data, seq FROM invoices WHERE id = $1 FOR UPDATE`, [req.params.id]);
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
    // Collection: cash arrives and the receivable is relieved.
    const payInvNo = docNo('invoices', cur.rows[0].seq);
    for (const p of payments) {
      const amt = round2(Number(p.amount) || 0);
      if (amt <= 0) continue;
      const meth = String(p.method || 'cash');
      await postJournal(client, {
        date: p.date || tsToDs(Date.now()), refType: 'receipt', refId: req.params.id,
        refNo: payInvNo, by: (req.auth && req.auth.name) || '',
        memo: `Payment received on ${payInvNo}`,
        lines: [
          { role: meth === 'cash' ? 'cash' : 'bank', debit: amt, memo: meth },
          { role: 'ar', credit: amt, memo: 'Settling ' + payInvNo,
            partyId: inv.customerId, partyName: inv.customerName },
        ],
      });
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
        // The movement ledger, which this path was skipping entirely.
        await postMovement(client, { partId: pid, partName: p.name, type: 'out', qty, from, to,
          unitCost: p.costPrice, refType: 'invoice', refId: id, refNo: invNoStr,
          note: 'Sold on ' + invNoStr, by: (req.auth && req.auth.name) || '' });
        await consumeLots(client, pid, qty, invNoStr);
        // Cost of sales, posted where the goods physically leave — the same rule
        // the job-card issue path follows.
        const soldCost = round2((Number(p.costPrice) || 0) * qty);
        if (soldCost > 0) {
          await postJournal(client, {
            date: tsToDs(Date.now()), refType: 'invoice', refId: id, refNo: invNoStr,
            by: (req.auth && req.auth.name) || '', memo: `Parts sold on ${invNoStr}`,
            lines: [
              { role: 'cogs', debit: soldCost, memo: (p.name || 'Part') + ' x' + qty },
              { role: 'inventory', credit: soldCost, memo: 'Stock relieved' },
            ],
          });
        }
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
    // Revenue, tax and discount. This whole sales channel was bypassing the
    // general ledger: postSalesJournal is called from the generic create path,
    // and the counter sale has its own endpoint, so nothing here reached the
    // books. Every walk-in sale understated revenue, VAT and cash.
    await postSalesJournal(client, id, inv, invNoStr, (req.auth && req.auth.name) || '');
    // Cash actually tendered settles the receivable the sales journal raised.
    const tendered = round2(Number(inv.totalPaid) || 0);
    if (tendered > 0) {
      const method = String((transaction && transaction.paymentMethod) || inv.paymentMethod || 'cash');
      await postJournal(client, {
        date: (transaction && transaction.date) || tsToDs(Date.now()),
        refType: 'receipt', refId: id, refNo: invNoStr, by: (req.auth && req.auth.name) || '',
        memo: `Counter sale settled on ${invNoStr}`,
        lines: [
          { role: method === 'cash' ? 'cash' : 'bank', debit: tendered, memo: method },
          { role: 'ar', credit: tendered, memo: 'Settling ' + invNoStr,
            partyId: inv.customerId, partyName: inv.customerName },
        ],
      });
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

    await postJournal(client, {
      date: body.receivedDate || tsToDs(now), refType: 'grn', refId: grnId, refNo: grnNo, by: actor,
      memo: `Goods received on ${grnNo} against ${poNo}`,
      lines: [
        { role: 'inventory', debit: round2(grnLines.reduce((s, l) => s + l.lineTotal, 0)), memo: 'Stock received' },
        { role: 'grni', credit: round2(grnLines.reduce((s, l) => s + l.lineTotal, 0)),
          memo: 'Owed to ' + (po.supplierName || 'supplier'), partyId: po.supplierId, partyName: po.supplierName },
      ],
    });

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

    // The provisional liability from receiving becomes the real payable, and any
    // input VAT is recognised.
    // Derive the journal from the SAME figures sanitizeDoc stored on the
    // document. Crediting AP with the gross subtotal while /pay caps payment at
    // the discounted total left a permanent credit balance for a debt that did
    // not exist — the payable could never clear.
    const piGross = round2(lines.reduce((s, l) => s + ((Number(l.qty) || 0) * (Number(l.unitCost) || 0)), 0));
    const piSub = round2(Number(pi.subtotal) != null && Number(pi.subtotal) > 0 ? Number(pi.subtotal) : piGross);
    const piDisc = round2(Number(pi.discountAmount) || 0);
    const piTax = round2(Number(pi.taxAmount) || 0);
    const piTotal = round2(Number(pi.total) || (piSub - piDisc + piTax + landedTotal));
    await postJournal(client, {
      date: pi.invoiceDate, refType: 'purchaseInvoice', refId: req.params.id, refNo: piNo, by: actor,
      memo: `Supplier invoice ${piNo}` + (pi.invoiceNo ? ' (' + pi.invoiceNo + ')' : ''),
      lines: [
        // GRNI clears at the GROSS figure the goods receipt credited it with.
        { role: 'grni', debit: piGross, memo: 'Clearing goods received' },
        { role: 'inventory', debit: landedTotal, memo: 'Landed costs onto stock' },
        { role: 'vatIn', debit: piTax, memo: 'Input VAT' },
        // A supplier discount is income we would otherwise never recognise.
        { role: 'discount', credit: round2(piDisc + (piGross - piSub)), memo: 'Purchase discount' },
        { role: 'ap', credit: piTotal, memo: 'Payable to ' + (pi.supplierName || 'supplier'),
          partyId: pi.supplierId, partyName: pi.supplierName },
      ],
    });

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

    await postJournal(client, {
      date, refType: 'supplierPayment', refId: req.params.id, refNo: piNo, by: actor,
      memo: `Payment to ${pi.supplierName || 'supplier'} for ${piNo}`,
      lines: [
        { role: 'ap', debit: amount, memo: 'Settling ' + piNo, partyId: pi.supplierId, partyName: pi.supplierName },
        { role: method === 'cash' ? 'cash' : 'bank', credit: amount, memo: method },
      ],
    });

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
    // Closes the gap Phase 2 flagged: a return now credits the payable instead
    // of only moving stock.
    const retTotal = round2(doc.items.reduce((s, l) => s + l.qty * l.unitCost, 0));
    await postJournal(client, {
      date: doc.returnDate, refType: 'purchaseReturn', refId: retId, refNo: retNo, by: actor,
      memo: `Returned to ${doc.supplierName || 'supplier'} on ${retNo}`,
      lines: [
        { role: 'ap', debit: retTotal, memo: 'Credit due from supplier', partyId: doc.supplierId, partyName: doc.supplierName },
        { role: 'inventory', credit: retTotal, memo: 'Stock returned' },
      ],
    });

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
        const val = round2(Math.abs(diff) * cost);
        await postJournal(client, {
          date: b.countDate || tsToDs(now), refType: 'stockCount', refId: id, refNo: no, by: actor,
          memo: `Stock count ${no} — ${p.name || ''}`,
          lines: diff > 0
            ? [{ role: 'inventory', debit: val, memo: 'Count surplus' }, { role: 'adjust', credit: val, memo: 'Count surplus' }]
            : [{ role: 'adjust', debit: val, memo: 'Count shortage' }, { role: 'inventory', credit: val, memo: 'Count shortage' }],
        });
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

// ══════════════════════════════════════════════════════════════════════════
// CREDIT NOTES & REFUNDS (Phase 6)
// A sales invoice is evidence handed to a customer and posted to the ledger, so
// it is never edited or deleted after the fact. Corrections happen forwards: a
// credit note reverses value, optionally puts the goods back on the shelf, and
// leaves both documents on the record.
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/creditNotes', asyncH(async (req, res) => {
  const b = req.body || {};
  const lines = Array.isArray(b.items) ? b.items : [];
  if (!b.invoiceId) return res.status(400).json({ error: 'A credit note must reference an invoice.' });
  if (!lines.length) return res.status(400).json({ error: 'Add at least one line to credit.' });
  if (!String(b.reason || '').trim()) return res.status(400).json({ error: 'Give a reason — the customer and the auditor will both ask.' });
  if (periodLocked(b.noteDate)) return res.status(400).json({ error: 'The books are locked up to ' + periodLockDate + '.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ir = await client.query(`SELECT data, seq FROM invoices WHERE id = $1 FOR UPDATE`, [b.invoiceId]);
    if (!ir.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found.' }); }
    const inv = ir.rows[0].data;
    const invNo = docNo('invoices', ir.rows[0].seq);
    if (inv.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(400).json({ error: invNo + ' is cancelled.' }); }

    const invTotal = round2(Number(inv.total) || 0);
    // Everything already credited against this invoice, so the sum of credit
    // notes can never exceed what was invoiced in the first place.
    const prev = await client.query(
      `SELECT COALESCE(SUM((data->>'total')::numeric),0) n FROM credit_notes
        WHERE data->>'invoiceId' = $1 AND COALESCE(data->>'status','posted') <> 'cancelled'`,
      [b.invoiceId]
    );
    const alreadyCredited = round2(Number(prev.rows[0].n) || 0);

    let sub = 0;
    for (const l of lines) {
      const amt = round2(Number(l.amount) || 0);
      if (amt <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Credit amounts must be greater than zero.' }); }
      l.amount = amt;
      sub += amt;
    }
    sub = round2(sub);
    const rate = Number(inv.taxRate) || 0;
    const tax = rate > 0 ? round2(sub * rate / 100) : 0;
    const total = round2(sub + tax);
    if (alreadyCredited + total > invTotal + 1e-9) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Cannot credit ${total.toFixed(2)} — ${invNo} was ${invTotal.toFixed(2)} and ${alreadyCredited.toFixed(2)} has already been credited.`,
      });
    }

    const cnId = crypto.randomUUID();
    const seq = await allocSeq(client, 'creditNotes', 'credit_notes', 1012, cnId);
    const cnNo = docNo('creditNotes', seq);
    const now = Date.now();
    const actor = (req.auth && req.auth.name) || '?';

    // Goods coming back go on the shelf, under the same lock discipline as any
    // other stock movement.
    const restocked = [];
    if (b.restock) {
      const partIds = [...new Set(lines.map((l) => l.partId).filter(Boolean))].sort();
      for (const pid of partIds) {
        const pr = await client.query(`SELECT data FROM parts WHERE id = $1 FOR UPDATE`, [pid]);
        if (!pr.rows.length) continue;
        const p = pr.rows[0].data;
        const qty = round2(lines.filter((l) => l.partId === pid).reduce((s, l) => s + (Number(l.qty) || 0), 0));
        if (qty <= 0) continue;
        const from = round2(Number(p.stock) || 0), to = round2(from + qty);
        await client.query(`UPDATE parts SET data = data || $2::jsonb WHERE id = $1`, [pid, JSON.stringify({ stock: to })]);
        await postMovement(client, {
          partId: pid, partName: p.name, type: 'in', qty, from, to, unitCost: p.costPrice,
          refType: 'creditnote', refId: cnId, refNo: cnNo,
          note: `Returned by customer on ${cnNo} (${invNo})`, at: now, by: actor,
        });
        restocked.push({ partId: pid, name: p.name || '', qty });
      }
    }

    // Cash actually handed back, recorded in the same transaction.
    const refund = round2(Number(b.refundAmount) || 0);
    const paid = round2(Number(inv.totalPaid) || 0);
    if (refund > 0) {
      if (refund > paid - alreadyCredited + 1e-9) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Cannot refund ${refund.toFixed(2)} — only ${round2(paid - alreadyCredited).toFixed(2)} has been collected on ${invNo}.` });
      }
      await client.query(`INSERT INTO transactions (id, data, txn_date, created_at) VALUES ($1,$2,$3,$4)`,
        [crypto.randomUUID(), JSON.stringify({
          type: 'expense', date: b.noteDate || tsToDs(now), amount: refund,
          description: `Customer refund – ${cnNo} (${invNo})`, category: 'Refunds',
          paymentMethod: String(b.refundMethod || 'cash'),
          accountId: b.accountId || '', accountName: b.accountName || '',
          partyType: 'customer', partyName: inv.customerName || '', customerId: inv.customerId || '',
          reference: cnNo, creditNoteId: cnId, invoiceId: b.invoiceId,
          createdAt: now, createdBy: actor,
        }), b.noteDate || tsToDs(now), now]);
    }

    const doc = {
      invoiceId: b.invoiceId, invoiceNo: invNo,
      customerId: inv.customerId || '', customerName: inv.customerName || '',
      noteDate: b.noteDate || tsToDs(now), reason: String(b.reason).trim(),
      items: lines.map((l) => ({ description: l.description || '', partId: l.partId || '', qty: Number(l.qty) || 0, amount: l.amount })),
      subtotal: sub, taxRate: rate, taxAmount: tax, total,
      restocked, restock: !!b.restock,
      refundAmount: refund, refundMethod: refund > 0 ? String(b.refundMethod || 'cash') : '',
      seq, status: 'posted', createdAt: now, createdBy: actor,
    };
    await client.query(`INSERT INTO credit_notes (id, data, seq, created_at) VALUES ($1,$2,$3,$4)`,
      [cnId, JSON.stringify(doc), seq, now]);

    // Reverse the revenue and tax, relieve the receivable, and put the cost back
    // into stock if the goods came back. Closes the gap Phase 6 flagged.
    const cnLines = [
      { role: 'sales', debit: sub, memo: 'Revenue credited' },
      { role: 'vatOut', debit: tax, memo: 'Output VAT credited' },
      { role: 'ar', credit: total, memo: 'Credit to ' + (inv.customerName || 'customer'),
        partyId: inv.customerId, partyName: inv.customerName },
    ];
    let cnCogs = 0;
    for (const rs of restocked) {
      const pr = await client.query(`SELECT data FROM parts WHERE id = $1`, [rs.partId]);
      if (pr.rows.length) cnCogs = round2(cnCogs + (Number(pr.rows[0].data.costPrice) || 0) * rs.qty);
    }
    if (cnCogs > 0) {
      cnLines.push({ role: 'inventory', debit: cnCogs, memo: 'Stock returned to shelf' });
      cnLines.push({ role: 'cogs', credit: cnCogs, memo: 'Cost of sales reversed' });
    }
    if (refund > 0) {
      // Cash actually handed back: the receivable was already relieved when the
      // customer paid, so refunding re-creates it and then pays it out.
      cnLines.push({ role: 'ar', debit: refund, memo: 'Refund paid out', partyId: inv.customerId, partyName: inv.customerName });
      cnLines.push({ role: String(b.refundMethod || 'cash') === 'cash' ? 'cash' : 'bank', credit: refund, memo: 'Refund' });
    }
    await postJournal(client, {
      date: doc.noteDate, refType: 'creditNote', refId: cnId, refNo: cnNo, by: actor,
      memo: `Credit note ${cnNo} against ${invNo}`, lines: cnLines,
    });

    // The invoice carries its credited total so every receivable figure in the
    // system nets it off without having to join.
    const newCredited = round2(alreadyCredited + total);
    const invMerged = { ...inv, creditedTotal: newCredited, fullyCredited: newCredited >= invTotal - 1e-9 };
    await client.query(`UPDATE invoices SET data = $2 WHERE id = $1`, [b.invoiceId, JSON.stringify(invMerged)]);

    await client.query('COMMIT');
    audit(req, 'credit-note', 'creditNotes', cnId, `${cnNo} against ${invNo} ${total}`);
    res.json({ id: cnId, ...doc, invoice: { id: b.invoiceId, ...invMerged } });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Cancel (void) an invoice ----
// Only ever before money or goods have moved. Once either has, the correction
// is a credit note, not a deletion.
app.post('/api/invoices/:id/cancel', asyncH(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT data, seq FROM invoices WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found.' }); }
    const inv = r.rows[0].data;
    const invNo = docNo('invoices', r.rows[0].seq);
    if (inv.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(400).json({ error: invNo + ' is already cancelled.' }); }
    if (round2(Number(inv.totalPaid) || 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${invNo} has payments recorded — raise a credit note instead of cancelling it.` });
    }
    const cn = await client.query(`SELECT 1 FROM credit_notes WHERE data->>'invoiceId' = $1 LIMIT 1`, [req.params.id]);
    if (cn.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: `${invNo} already has a credit note against it.` }); }
    // A car that has left on the strength of this invoice cannot have it voided.
    if (inv.jobCardId) {
      const jc = await client.query(`SELECT data FROM job_cards WHERE id = $1`, [inv.jobCardId]);
      if (jc.rows.length && jc.rows[0].data.status === 'delivered') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `The vehicle on ${invNo} has already been delivered — raise a credit note instead.` });
      }
    }
    const merged = {
      ...inv, status: 'cancelled', cancelledAt: Date.now(),
      cancelledBy: (req.auth && req.auth.name) || '?',
      cancelReason: String((req.body || {}).reason || '').trim(),
    };
    await client.query(`UPDATE invoices SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(merged)]);
    await client.query('COMMIT');
    audit(req, 'cancel-invoice', 'invoices', req.params.id, invNo);
    res.json({ id: req.params.id, ...merged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ══════════════════════════════════════════════════════════════════════════
// WORKSHOP OPERATIONS (Phase 5)
// The stages between "the car arrived" and "the customer drove away": check-in,
// a bay to work in, a quality check, and a delivery that cannot happen until
// both are satisfied.
// ══════════════════════════════════════════════════════════════════════════

// ---- Bay allocation ----
// A bay is a physical position. Two cars cannot occupy one, so the allocation is
// row-locked rather than a flag anybody can set.
app.post('/api/jobCards/:id/bay', asyncH(async (req, res) => {
  const bayId = String((req.body || {}).bayId || '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query(`SELECT data, seq FROM job_cards WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Job card not found.' }); }
    const jc = jr.rows[0].data;
    const jcNo = docNo('jobCards', jr.rows[0].seq);

    if (bayId) {
      const br = await client.query(`SELECT data FROM bays WHERE id = $1 FOR UPDATE`, [bayId]);
      if (!br.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Bay not found.' }); }
      if (br.rows[0].data.active === false) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'That bay is out of service.' }); }
      // Occupied by a job that has not been delivered yet?
      const occ = await client.query(
        `SELECT id, seq FROM job_cards
          WHERE data->>'bayId' = $1 AND id <> $2
            AND COALESCE(data->>'status','') NOT IN ('delivered','cancelled')
          LIMIT 1`, [bayId, req.params.id]);
      if (occ.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Bay ${br.rows[0].data.code || ''} is occupied by ${docNo('jobCards', occ.rows[0].seq)}.` });
      }
      jc.bayId = bayId;
      jc.bayCode = br.rows[0].data.code || '';
      jc.bayAssignedAt = Date.now();
    } else {
      jc.bayId = ''; jc.bayCode = ''; jc.bayAssignedAt = null;
    }
    await client.query(`UPDATE job_cards SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(jc)]);
    await client.query('COMMIT');
    audit(req, bayId ? 'assign-bay' : 'free-bay', 'jobCards', req.params.id, `${jcNo} ${jc.bayCode || ''}`);
    res.json({ id: req.params.id, ...jc });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Vehicle check-in ----
// What the car looked like when it arrived. Recorded once, and not editable
// afterwards, because its whole value is being the state before work began.
app.post('/api/jobCards/:id/checkin', asyncH(async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query(`SELECT data, seq FROM job_cards WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Job card not found.' }); }
    const jc = jr.rows[0].data;
    if (jc.checkIn && jc.checkIn.at) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This vehicle has already been checked in.' }); }
    jc.checkIn = {
      at: Date.now(), by: (req.auth && req.auth.name) || '?',
      mileage: Number(b.mileage) || 0,
      fuelLevel: String(b.fuelLevel || ''),          // E, 1/4, 1/2, 3/4, F
      damageNotes: String(b.damageNotes || '').trim(),
      belongings: String(b.belongings || '').trim(),
      customerPresent: b.customerPresent !== false,
      photos: Array.isArray(b.photos) ? b.photos : [],
    };
    if (jc.checkIn.mileage > 0) jc.mileageIn = jc.checkIn.mileage;
    await client.query(`UPDATE job_cards SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(jc)]);
    await client.query('COMMIT');
    audit(req, 'check-in', 'jobCards', req.params.id, docNo('jobCards', jr.rows[0].seq));
    res.json({ id: req.params.id, ...jc });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Quality check ----
// The gate between "the work is done" and "the customer can have the car".
app.post('/api/jobCards/:id/qc', asyncH(async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query(`SELECT data, seq FROM job_cards WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Job card not found.' }); }
    const jc = jr.rows[0].data;
    const works = Array.isArray(jc.works) ? jc.works : [];
    // Checking the quality of work that is not finished is meaningless.
    if (works.length && !works.every((w) => w.status === 'done')) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Finish every work item before the quality check.' });
    }
    const items = Array.isArray(b.items) ? b.items : [];
    const failed = items.filter((i) => i.result === 'fail');
    const passed = failed.length === 0;
    jc.qc = {
      at: Date.now(), by: (req.auth && req.auth.name) || '?',
      items, passed, notes: String(b.notes || '').trim(),
      roadTested: !!b.roadTested, washed: !!b.washed,
    };
    // A failed check sends the car back to the floor rather than forward.
    if (!passed) {
      jc.status = 'in_progress';
      jc.qcFailedAt = Date.now();
    }
    await client.query(`UPDATE job_cards SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(jc)]);
    await client.query('COMMIT');
    audit(req, passed ? 'qc-pass' : 'qc-fail', 'jobCards', req.params.id,
      `${docNo('jobCards', jr.rows[0].seq)}${failed.length ? ' — ' + failed.length + ' failed' : ''}`);
    res.json({ id: req.params.id, ...jc });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Delivery ----
// The last gate. A car leaves only when the work passed QC and the money is
// settled (or the customer has an approved credit account).
app.post('/api/jobCards/:id/deliver', asyncH(async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jr = await client.query(`SELECT data, seq FROM job_cards WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Job card not found.' }); }
    const jc = jr.rows[0].data;
    const jcNo = docNo('jobCards', jr.rows[0].seq);
    if (jc.status === 'delivered') { await client.query('ROLLBACK'); return res.status(400).json({ error: jcNo + ' has already been delivered.' }); }

    const blockers = [];
    const works = Array.isArray(jc.works) ? jc.works : [];
    if (works.length && !works.every((w) => w.status === 'done')) blockers.push('the work is not finished');
    if (!jc.qc || !jc.qc.passed) blockers.push('it has not passed the quality check');

    // Money: the invoice must exist and be settled, unless it is on approved credit.
    const inv = await client.query(`SELECT data FROM invoices WHERE data->>'jobCardId' = $1 LIMIT 1`, [req.params.id]);
    if (!inv.rows.length) {
      blockers.push('it has not been invoiced');
    } else {
      const iv = inv.rows[0].data;
      const due = round2((Number(iv.total) || 0) - (Number(iv.totalPaid) || 0));
      if (due > 0.005 && iv.status !== 'credit') blockers.push(`${due.toFixed(2)} is still unpaid`);
    }
    if (blockers.length && !b.override) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${jcNo} cannot be delivered — ${blockers.join(', and ')}.`, blockers });
    }

    jc.status = 'delivered';
    jc.delivery = {
      at: Date.now(), by: (req.auth && req.auth.name) || '?',
      receivedBy: String(b.receivedBy || '').trim(),
      mileageOut: Number(b.mileageOut) || 0,
      checklist: Array.isArray(b.checklist) ? b.checklist : [],
      notes: String(b.notes || '').trim(),
      overridden: !!(blockers.length && b.override),
      overrideReason: blockers.length && b.override ? String(b.overrideReason || '').trim() : '',
    };
    // Delivering the car frees the bay for the next job.
    jc.bayId = ''; jc.bayCode = '';
    await client.query(`UPDATE job_cards SET data = $2 WHERE id = $1`, [req.params.id, JSON.stringify(jc)]);
    await client.query('COMMIT');
    audit(req, 'deliver', 'jobCards', req.params.id, jcNo + (jc.delivery.overridden ? ' (OVERRIDDEN)' : ''));
    res.json({ id: req.params.id, ...jc });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ══════════════════════════════════════════════════════════════════════════
// FINANCIAL STATEMENTS — read from the ledger, not re-derived.
// Every figure below is a SUM over journal_lines, so the trial balance balances
// by construction rather than by the reports agreeing with each other.
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/reports/trial-balance', asyncH(async (req, res) => {
  const asAt = String(req.query.asAt || '').slice(0, 10) || '9999-12-31';
  const from = String(req.query.from || '').slice(0, 10) || '0000-01-01';
  const { rows } = await pool.query(
    `SELECT jl.account_id,
            COALESCE(SUM(jl.debit),0)  AS dr,
            COALESCE(SUM(jl.credit),0) AS cr
       FROM journal_lines jl
      WHERE jl.entry_date <= $1 AND jl.entry_date >= $2
      GROUP BY jl.account_id`,
    [asAt, from]
  );
  const accRows = await pool.query(`SELECT id, data FROM fin_accounts`);
  const accById = {};
  for (const a of accRows.rows) accById[a.id] = a.data;

  let totalDr = 0, totalCr = 0;
  const lines = rows.map((r) => {
    const a = accById[r.account_id] || {};
    const dr = round2(Number(r.dr) || 0), cr = round2(Number(r.cr) || 0);
    const net = round2(dr - cr);
    totalDr = round2(totalDr + dr); totalCr = round2(totalCr + cr);
    return {
      accountId: r.account_id, name: a.name || '(deleted account)',
      type: a.type || 'asset', systemRole: a.systemRole || '',
      debit: dr, credit: cr,
      // Presented the way a trial balance is read: one side per account.
      balanceDebit: net > 0 ? net : 0, balanceCredit: net < 0 ? -net : 0,
    };
  }).filter((l) => l.debit !== 0 || l.credit !== 0)
    .sort((a, b) => (a.type || '').localeCompare(b.type || '') || a.name.localeCompare(b.name));

  res.json({
    asAt, from, lines,
    totalDebit: totalDr, totalCredit: totalCr,
    difference: round2(totalDr - totalCr),
    balanced: Math.abs(round2(totalDr - totalCr)) < 0.005,
  });
}));

// ---- General ledger: the postings behind one account ----
app.get('/api/reports/ledger', asyncH(async (req, res) => {
  const accountId = String(req.query.accountId || '');
  const from = String(req.query.from || '').slice(0, 10) || '0000-01-01';
  const to = String(req.query.to || '').slice(0, 10) || '9999-12-31';
  if (!accountId) return res.status(400).json({ error: 'Choose an account.' });
  // Opening balance is everything before the window — without it a ledger
  // extract for a period is just a floating list of numbers.
  const ob = await pool.query(
    `SELECT COALESCE(SUM(debit),0) dr, COALESCE(SUM(credit),0) cr FROM journal_lines
      WHERE account_id = $1 AND entry_date < $2`, [accountId, from]);
  const opening = round2((Number(ob.rows[0].dr) || 0) - (Number(ob.rows[0].cr) || 0));
  const { rows } = await pool.query(
    `SELECT jl.debit, jl.credit, jl.entry_date, jl.data, je.data AS entry
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_id = $1 AND jl.entry_date BETWEEN $2 AND $3
      ORDER BY jl.entry_date ASC, je.seq ASC`, [accountId, from, to]);
  let running = opening;
  const lines = rows.map((r) => {
    const dr = round2(Number(r.debit) || 0), cr = round2(Number(r.credit) || 0);
    running = round2(running + dr - cr);
    return {
      date: r.entry_date, entryNo: r.entry.no, memo: r.entry.memo,
      refType: r.entry.refType, refNo: r.entry.refNo,
      lineMemo: (r.data || {}).memo || '', party: (r.data || {}).partyName || '',
      debit: dr, credit: cr, balance: running,
    };
  });
  res.json({ accountId, from, to, opening, lines, closing: running });
}));

app.get('/api/reports/pl', asyncH(async (req, res) => {
  const from = String(req.query.from || '').slice(0, 10) || '0000-01-01';
  const to = String(req.query.to || '').slice(0, 10) || '9999-12-31';
  const { rows } = await pool.query(
    `SELECT jl.account_id, COALESCE(SUM(jl.debit),0) dr, COALESCE(SUM(jl.credit),0) cr
       FROM journal_lines jl WHERE jl.entry_date BETWEEN $1 AND $2 GROUP BY jl.account_id`,
    [from, to]
  );
  const accRows = await pool.query(`SELECT id, data FROM fin_accounts`);
  const accById = {};
  for (const a of accRows.rows) accById[a.id] = a.data;
  const income = [], expense = [];
  let totalIncome = 0, totalExpense = 0;
  for (const r of rows) {
    const a = accById[r.account_id] || {};
    const dr = round2(Number(r.dr) || 0), cr = round2(Number(r.cr) || 0);
    if (a.type === 'income') {
      const amt = round2(cr - dr);
      if (amt !== 0) { income.push({ name: a.name, amount: amt }); totalIncome = round2(totalIncome + amt); }
    } else if (a.type === 'expense') {
      const amt = round2(dr - cr);
      if (amt !== 0) { expense.push({ name: a.name, amount: amt }); totalExpense = round2(totalExpense + amt); }
    }
  }
  income.sort((x, y) => y.amount - x.amount); expense.sort((x, y) => y.amount - x.amount);
  res.json({ from, to, income, expense, totalIncome, totalExpense, netProfit: round2(totalIncome - totalExpense) });
}));

app.get('/api/reports/balance-sheet', asyncH(async (req, res) => {
  const asAt = String(req.query.asAt || '').slice(0, 10) || '9999-12-31';
  const { rows } = await pool.query(
    `SELECT jl.account_id, COALESCE(SUM(jl.debit),0) dr, COALESCE(SUM(jl.credit),0) cr
       FROM journal_lines jl WHERE jl.entry_date <= $1 GROUP BY jl.account_id`, [asAt]);
  const accRows = await pool.query(`SELECT id, data FROM fin_accounts`);
  const accById = {};
  for (const a of accRows.rows) accById[a.id] = a.data;
  const assets = [], liabilities = [], equity = [];
  let ta = 0, tl = 0, te = 0, income = 0, expense = 0;
  for (const r of rows) {
    const a = accById[r.account_id] || {};
    const dr = round2(Number(r.dr) || 0), cr = round2(Number(r.cr) || 0);
    if (a.type === 'asset') { const v = round2(dr - cr); if (v) { assets.push({ name: a.name, amount: v }); ta = round2(ta + v); } }
    else if (a.type === 'liability') { const v = round2(cr - dr); if (v) { liabilities.push({ name: a.name, amount: v }); tl = round2(tl + v); } }
    else if (a.type === 'equity') { const v = round2(cr - dr); if (v) { equity.push({ name: a.name, amount: v }); te = round2(te + v); } }
    else if (a.type === 'income') income = round2(income + (cr - dr));
    else if (a.type === 'expense') expense = round2(expense + (dr - cr));
  }
  // Retained earnings is the P&L to date; it is what makes the sheet balance.
  const retained = round2(income - expense);
  if (retained !== 0) { equity.push({ name: 'Retained Earnings', amount: retained }); te = round2(te + retained); }
  const diff = round2(ta - (tl + te));
  res.json({
    asAt, assets, liabilities, equity,
    totalAssets: ta, totalLiabilities: tl, totalEquity: te,
    difference: diff, balanced: Math.abs(diff) < 0.005,
  });
}));

// ══════════════════════════════════════════════════════════════════════════
// OPERATIONAL REPORTS (Phase 8)
// Aggregated in Postgres rather than in the browser. The old reports loaded
// whole collections into the client and summed them there, which is both slow
// and gives a different answer on every device depending on what had loaded.
// ══════════════════════════════════════════════════════════════════════════

// ---- Inventory valuation: what the stock on the shelf is actually worth ----
app.get('/api/reports/inventory-valuation', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, data,
            COALESCE((data->>'stock')::numeric,0) AS qty,
            COALESCE((data->>'costPrice')::numeric,0) AS cost
       FROM parts
      WHERE COALESCE((data->>'active')::boolean, true) = true`
  );
  const items = [];
  let totalValue = 0, totalQty = 0, negatives = 0;
  for (const r of rows) {
    const qty = round2(Number(r.qty) || 0), cost = round2(Number(r.cost) || 0);
    if (qty === 0) continue;
    if (qty < 0) negatives++;
    const value = round2(qty * cost);
    totalValue = round2(totalValue + value); totalQty = round2(totalQty + qty);
    items.push({
      id: r.id, name: r.data.name || '', partNumber: r.data.partNumber || '',
      category: r.data.category || '', qty, unitCost: cost, value,
      sellingPrice: round2(Number(r.data.sellingPrice) || 0),
    });
  }
  items.sort((a, b) => b.value - a.value);
  // By category, because that is how a stock write-down conversation happens.
  const byCat = {};
  for (const i of items) {
    const k = i.category || 'Uncategorised';
    byCat[k] = byCat[k] || { category: k, qty: 0, value: 0, items: 0 };
    byCat[k].qty = round2(byCat[k].qty + i.qty);
    byCat[k].value = round2(byCat[k].value + i.value);
    byCat[k].items++;
  }
  res.json({
    asAt: tsToDs(Date.now()), items, totalValue, totalQty, lineCount: items.length,
    negativeStockItems: negatives,
    byCategory: Object.values(byCat).sort((a, b) => b.value - a.value),
  });
}));

// ---- Sales summary: revenue, cost and margin over a period ----
app.get('/api/reports/sales-summary', asyncH(async (req, res) => {
  const from = String(req.query.from || '').slice(0, 10) || '0000-01-01';
  const to = String(req.query.to || '').slice(0, 10) || '9999-12-31';
  const fromTs = from === '0000-01-01' ? 0 : new Date(from + 'T00:00:00Z').getTime();
  const toTs = to === '9999-12-31' ? 8.64e15 : new Date(to + 'T23:59:59Z').getTime();
  const { rows } = await pool.query(
    `SELECT data FROM invoices
      WHERE COALESCE(data->>'status','') <> 'cancelled'
        AND COALESCE((data->>'createdAt')::bigint, 0) BETWEEN $1 AND $2`,
    [fromTs, toTs]
  );
  let gross = 0, tax = 0, discount = 0, collected = 0, credited = 0;
  const byDay = {}, byCustomer = {};
  for (const r of rows) {
    const d = r.data;
    const t = round2(Number(d.total) || 0);
    gross = round2(gross + t);
    tax = round2(tax + (Number(d.taxAmount) || 0));
    discount = round2(discount + (Number(d.discountAmount) || 0));
    collected = round2(collected + (Number(d.totalPaid) || 0));
    credited = round2(credited + (Number(d.creditedTotal) || 0));
    const day = tsToDs(d.createdAt);
    byDay[day] = round2((byDay[day] || 0) + t);
    const c = d.customerName || 'Walk-in';
    byCustomer[c] = byCustomer[c] || { customer: c, invoices: 0, total: 0 };
    byCustomer[c].invoices++; byCustomer[c].total = round2(byCustomer[c].total + t);
  }
  // Cost of sales for the same window comes from the ledger, so margin is the
  // real one rather than selling price minus a guess.
  const cogsRow = await pool.query(
    `SELECT COALESCE(SUM(jl.debit - jl.credit),0) c FROM journal_lines jl
       JOIN fin_accounts fa ON fa.id = jl.account_id
      WHERE fa.data->>'systemRole' = 'cogs' AND jl.entry_date BETWEEN $1 AND $2`,
    [from, to]
  );
  const cogs = round2(Number(cogsRow.rows[0].c) || 0);
  const net = round2(gross - tax - credited);
  res.json({
    from, to, invoiceCount: rows.length,
    gross, tax, discount, credited, netRevenue: net, collected,
    outstanding: round2(gross - collected - credited),
    costOfSales: cogs, grossMargin: round2(net - cogs),
    grossMarginPct: net > 0 ? Math.round(((net - cogs) / net) * 1000) / 10 : 0,
    byDay: Object.entries(byDay).map(([date, total]) => ({ date, total })).sort((a, b) => a.date.localeCompare(b.date)),
    topCustomers: Object.values(byCustomer).sort((a, b) => b.total - a.total).slice(0, 10),
  });
}));

// ---- Workshop performance ----
app.get('/api/reports/workshop', asyncH(async (req, res) => {
  const from = String(req.query.from || '').slice(0, 10) || '0000-01-01';
  const to = String(req.query.to || '').slice(0, 10) || '9999-12-31';
  const fromTs = from === '0000-01-01' ? 0 : new Date(from + 'T00:00:00Z').getTime();
  const toTs = to === '9999-12-31' ? 8.64e15 : new Date(to + 'T23:59:59Z').getTime();
  const { rows } = await pool.query(
    `SELECT data FROM job_cards WHERE COALESCE((data->>'createdAt')::bigint,0) BETWEEN $1 AND $2`,
    [fromTs, toTs]
  );
  const byStatus = {}, byTech = {};
  let labourValue = 0, turnaroundSum = 0, turnaroundCount = 0, qcFails = 0;
  for (const r of rows) {
    const d = r.data;
    const st = d.status || 'pending';
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (d.qc && d.qc.passed === false) qcFails++;
    for (const w of (Array.isArray(d.works) ? d.works : [])) {
      const cost = round2(Number(w.cost) || 0);
      labourValue = round2(labourValue + cost);
      const t = w.technicianName || 'Unassigned';
      byTech[t] = byTech[t] || { technician: t, jobs: 0, done: 0, value: 0 };
      byTech[t].jobs++;
      if (w.status === 'done') byTech[t].done++;
      byTech[t].value = round2(byTech[t].value + cost);
    }
    // Turnaround measured check-in to delivery, the number a customer feels.
    if (d.checkIn && d.checkIn.at && d.delivery && d.delivery.at) {
      turnaroundSum += (d.delivery.at - d.checkIn.at);
      turnaroundCount++;
    }
  }
  res.json({
    from, to, jobCards: rows.length, byStatus,
    labourValue, qcFailures: qcFails,
    avgTurnaroundHours: turnaroundCount ? Math.round((turnaroundSum / turnaroundCount / 3600000) * 10) / 10 : null,
    turnaroundSample: turnaroundCount,
    technicians: Object.values(byTech).sort((a, b) => b.value - a.value),
  });
}));

// ══════════════════════════════════════════════════════════════════════════
// OPENING BALANCES
// A garage migrating in already has cash, debtors, creditors and stock on the
// day it starts. Without a way to state them, every report begins from zero and
// the first month's figures are fiction. The contra is Opening Balance Equity,
// which is what makes the entry balance without inventing profit.
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/opening-balances', asyncH(async (req, res) => {
  const b = req.body || {};
  const date = String(b.date || '').slice(0, 10) || tsToDs(Date.now());
  if (periodLocked(date)) return res.status(400).json({ error: 'The books are locked up to ' + periodLockDate + '.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Posting opening balances twice would double every figure.
    const existing = await client.query(
      `SELECT 1 FROM journal_entries WHERE data->>'refType' = 'opening' LIMIT 1`);
    if (existing.rows.length && !b.replace) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Opening balances have already been posted. Reverse them first if they were wrong.' });
    }

    const lines = [];
    const add = (role, amount, memo, party) => {
      const v = round2(Number(amount) || 0);
      if (v === 0) return;
      // A positive figure debits an asset and credits a liability; the sign
      // convention follows what the account IS, not what the user typed.
      const isLiability = role === 'ap';
      lines.push(isLiability ? { role, credit: v, memo, partyName: party } : { role, debit: v, memo, partyName: party });
    };

    add('cash', b.cash, 'Opening cash in hand');
    add('bank', b.bank, 'Opening bank balance');
    add('ap', b.payables, 'Opening supplier balances');

    // Debtors, per customer, so the aged report has something to age.
    for (const d of (Array.isArray(b.receivables) ? b.receivables : [])) {
      add('ar', d.amount, 'Opening balance — ' + (d.name || 'customer'), d.name);
    }

    // Stock is valued from what is actually on the shelf right now, at cost.
    let stockValue = 0;
    if (b.includeStock !== false) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(COALESCE((data->>'stock')::numeric,0) * COALESCE((data->>'costPrice')::numeric,0)),0) v
           FROM parts WHERE COALESCE((data->>'stock')::numeric,0) > 0`);
      stockValue = round2(Number(rows[0].v) || 0);
      add('inventory', stockValue, 'Opening stock at cost');
    }

    if (!lines.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Enter at least one opening balance.' }); }

    // Whatever the balances come to, the contra is equity — the owner's stake on
    // day one. Working it out this way means the entry always balances.
    const dr = round2(lines.reduce((s, l) => s + (l.debit || 0), 0));
    const cr = round2(lines.reduce((s, l) => s + (l.credit || 0), 0));
    const diff = round2(dr - cr);
    if (diff > 0) lines.push({ role: 'opening', credit: diff, memo: "Owner's opening stake" });
    else if (diff < 0) lines.push({ role: 'opening', debit: -diff, memo: 'Opening deficit' });

    const entry = await postJournal(client, {
      date, refType: 'opening', refNo: 'OPENING', by: (req.auth && req.auth.name) || '?',
      memo: 'Opening balances as at ' + date, lines,
    });
    await client.query('COMMIT');
    audit(req, 'opening-balances', 'journalEntries', entry.id, date);
    res.json({ ok: true, entry, stockValue, equity: Math.abs(diff) });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ══════════════════════════════════════════════════════════════════════════
// BANK RECONCILIATION
// The bank's version of events against ours. The value is not the tick-list —
// it is the DIFFERENCE, which is either a timing difference you can name
// (a cheque not yet presented) or an error you need to find.
// ══════════════════════════════════════════════════════════════════════════

// Everything posted to a cash/bank account up to a date, with its reconciled
// state, so the operator can see what is still outstanding.
app.get('/api/bank/unreconciled', asyncH(async (req, res) => {
  const accountId = String(req.query.accountId || '');
  const to = String(req.query.to || '').slice(0, 10) || '9999-12-31';
  if (!accountId) return res.status(400).json({ error: 'Choose a bank or cash account.' });
  const { rows } = await pool.query(
    `SELECT jl.id, jl.debit, jl.credit, jl.entry_date, jl.data, je.data AS entry
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_id = $1 AND jl.entry_date <= $2
      ORDER BY jl.entry_date ASC, je.seq ASC`, [accountId, to]);
  let bookBalance = 0, reconciled = 0;
  const lines = rows.map((r) => {
    const dr = round2(Number(r.debit) || 0), cr = round2(Number(r.credit) || 0);
    bookBalance = round2(bookBalance + dr - cr);
    const rec = (r.data || {}).reconciledIn || '';
    if (rec) reconciled = round2(reconciled + dr - cr);
    return {
      lineId: r.id, date: r.entry_date, entryNo: r.entry.no,
      memo: (r.data || {}).memo || r.entry.memo, refNo: r.entry.refNo,
      party: (r.data || {}).partyName || '', debit: dr, credit: cr,
      reconciledIn: rec,
    };
  });
  res.json({
    accountId, to, bookBalance, reconciledBalance: reconciled,
    unreconciledBalance: round2(bookBalance - reconciled),
    lines, outstanding: lines.filter((l) => !l.reconciledIn),
  });
}));

// Close a reconciliation: tick the lines that appear on the statement and
// record what did not clear.
app.post('/api/bank/reconcile', asyncH(async (req, res) => {
  const b = req.body || {};
  const accountId = String(b.accountId || '');
  const lineIds = Array.isArray(b.lineIds) ? b.lineIds : [];
  const statementBalance = round2(Number(b.statementBalance) || 0);
  const statementDate = String(b.statementDate || '').slice(0, 10) || tsToDs(Date.now());
  if (!accountId) return res.status(400).json({ error: 'Choose the account being reconciled.' });
  if (!lineIds.length) return res.status(400).json({ error: 'Tick at least one line that appears on the statement.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only lines on this account, and never one already reconciled elsewhere.
    const { rows } = await client.query(
      `SELECT id, debit, credit, data FROM journal_lines
        WHERE id = ANY($1::text[]) AND account_id = $2 FOR UPDATE`, [lineIds, accountId]);
    if (rows.length !== lineIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Some ticked lines do not belong to this account.' });
    }
    const already = rows.filter((r) => (r.data || {}).reconciledIn);
    if (already.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${already.length} of those lines are already reconciled on an earlier statement.` });
    }

    const id = crypto.randomUUID();
    const seq = await allocSeq(client, 'bankRecs', 'bank_recs', 1014, id);
    const no = 'REC-' + String(seq).padStart(4, '0');
    const now = Date.now();
    const actor = (req.auth && req.auth.name) || '?';

    let cleared = 0;
    for (const r of rows) {
      cleared = round2(cleared + (Number(r.debit) || 0) - (Number(r.credit) || 0));
      await client.query(`UPDATE journal_lines SET data = data || $2::jsonb WHERE id = $1`,
        [r.id, JSON.stringify({ reconciledIn: no, reconciledAt: now })]);
    }

    // Everything on this account up to the statement date that was NOT ticked
    // is what has not yet cleared the bank.
    const outRows = await client.query(
      `SELECT COALESCE(SUM(debit - credit),0) v FROM journal_lines
        WHERE account_id = $1 AND entry_date <= $2 AND COALESCE(data->>'reconciledIn','') = ''`,
      [accountId, statementDate]);
    const outstanding = round2(Number(outRows.rows[0].v) || 0);

    const bookRows = await client.query(
      `SELECT COALESCE(SUM(debit - credit),0) v FROM journal_lines
        WHERE account_id = $1 AND entry_date <= $2`, [accountId, statementDate]);
    const bookBalance = round2(Number(bookRows.rows[0].v) || 0);

    // The reconciling item. If this is not zero, something is genuinely wrong —
    // it is reported rather than hidden.
    const difference = round2(statementBalance - (bookBalance - outstanding));

    const doc = {
      accountId, accountName: b.accountName || '', statementDate, statementBalance,
      bookBalance, clearedTotal: cleared, outstandingTotal: outstanding, difference,
      reconciled: Math.abs(difference) < 0.005,
      lineCount: rows.length, lineIds, notes: String(b.notes || '').trim(),
      seq, createdAt: now, createdBy: actor,
    };
    await client.query(`INSERT INTO bank_recs (id, data, seq, created_at) VALUES ($1,$2,$3,$4)`,
      [id, JSON.stringify(doc), seq, now]);
    await client.query('COMMIT');
    audit(req, 'bank-reconcile', 'bankRecs', id, `${no} diff ${difference}`);
    res.json({ id, ...doc, no });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Customer report ----
// Was a customers x jobCards cross-product in the browser: every customer
// re-scanned the whole job-card collection, so it slowed as the square of the
// data and gave a different answer per device depending on what had loaded.
app.get('/api/reports/customers', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.data,
            COALESCE(j.jobs, 0)      AS jobs,
            COALESCE(j.labour, 0)    AS labour,
            COALESCE(v.vehicles, 0)  AS vehicles,
            COALESCE(i.invoiced, 0)  AS invoiced,
            COALESCE(i.paid, 0)      AS paid,
            j.last_job
       FROM customers c
       LEFT JOIN (
         SELECT jc.data->>'customerId' AS cid, COUNT(*) AS jobs,
                MAX((jc.data->>'createdAt')::bigint) AS last_job,
                COALESCE(SUM((SELECT COALESCE(SUM(COALESCE((w->>'cost')::numeric,0)),0)
                                FROM jsonb_array_elements(COALESCE(jc.data->'works','[]'::jsonb)) w)),0) AS labour
           FROM job_cards jc GROUP BY 1
       ) j ON j.cid = c.id
       LEFT JOIN (
         SELECT data->>'customerId' AS cid, COUNT(*) AS vehicles FROM vehicles GROUP BY 1
       ) v ON v.cid = c.id
       LEFT JOIN (
         SELECT data->>'customerId' AS cid,
                COALESCE(SUM(COALESCE((data->>'total')::numeric,0)),0) AS invoiced,
                COALESCE(SUM(COALESCE((data->>'totalPaid')::numeric,0)),0) AS paid
           FROM invoices WHERE COALESCE(data->>'status','') <> 'cancelled' GROUP BY 1
       ) i ON i.cid = c.id`
  );
  const customers = rows.map((r) => ({
    id: r.id, name: r.data.name || '', phone: r.data.phone || '',
    group: r.data.group || '', customerType: r.data.customerType || 'individual',
    jobs: Number(r.jobs) || 0, vehicles: Number(r.vehicles) || 0,
    labourValue: round2(Number(r.labour) || 0),
    invoiced: round2(Number(r.invoiced) || 0),
    paid: round2(Number(r.paid) || 0),
    outstanding: round2((Number(r.invoiced) || 0) - (Number(r.paid) || 0)),
    lastJobAt: r.last_job ? Number(r.last_job) : null,
  })).sort((a, b) => b.invoiced - a.invoiced);
  res.json({
    generatedAt: Date.now(), count: customers.length,
    repeatCustomers: customers.filter((c) => c.jobs > 1).length,
    totalInvoiced: round2(customers.reduce((s, c) => s + c.invoiced, 0)),
    totalOutstanding: round2(customers.reduce((s, c) => s + c.outstanding, 0)),
    customers,
  });
}));

// ---- Sales analysis: invoice-wise, item-wise and service-wise ----
// The one report that genuinely needed new aggregation rather than a repoint.
// It walks invoice LINES, which the browser was doing across the whole
// collection every time a tab was clicked.
app.get('/api/reports/sales-analysis', asyncH(async (req, res) => {
  const from = String(req.query.from || '').slice(0, 10) || '0000-01-01';
  const to = String(req.query.to || '').slice(0, 10) || '9999-12-31';
  const fromTs = from === '0000-01-01' ? 0 : new Date(from + 'T00:00:00Z').getTime();
  const toTs = to === '9999-12-31' ? 8.64e15 : new Date(to + 'T23:59:59Z').getTime();
  const { rows } = await pool.query(
    `SELECT id, seq, data FROM invoices
      WHERE COALESCE(data->>'status','') <> 'cancelled'
        AND COALESCE((data->>'createdAt')::bigint,0) BETWEEN $1 AND $2
      ORDER BY seq DESC`, [fromTs, toTs]);

  const invoices = [], byItem = {}, byService = {};
  let gross = 0, collected = 0;
  for (const r of rows) {
    const d = r.data;
    const total = round2(Number(d.total) || 0);
    const paid = round2(Number(d.totalPaid) || 0);
    gross = round2(gross + total); collected = round2(collected + paid);
    invoices.push({
      id: r.id, no: docNo('invoices', r.seq), date: tsToDs(d.createdAt),
      customer: d.customerName || 'Walk-in', vehicle: d.vehicleReg || '',
      status: d.status || '', total, paid, outstanding: round2(total - paid),
      credited: round2(Number(d.creditedTotal) || 0),
    });
    for (const l of (Array.isArray(d.items) ? d.items : [])) {
      const amount = round2(Number(l.cost) || 0);
      if (!amount) continue;
      // A line with a partId is goods; anything else is labour or a service.
      const bucket = l.partId ? byItem : byService;
      const key = l.partId || String(l.serviceId || l.description || 'Other');
      const name = l.name || l.serviceName || l.description || 'Other';
      bucket[key] = bucket[key] || { key, name, qty: 0, revenue: 0, lines: 0 };
      bucket[key].qty = round2(bucket[key].qty + (Number(l.qty) || 0));
      bucket[key].revenue = round2(bucket[key].revenue + amount);
      bucket[key].lines++;
    }
  }
  const rank = (o) => Object.values(o).sort((a, b) => b.revenue - a.revenue);
  res.json({
    from, to, invoiceCount: invoices.length,
    gross, collected, outstanding: round2(gross - collected),
    invoices, items: rank(byItem), services: rank(byService),
    itemRevenue: round2(rank(byItem).reduce((s, x) => s + x.revenue, 0)),
    serviceRevenue: round2(rank(byService).reduce((s, x) => s + x.revenue, 0)),
  });
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
    const lotUse = await consumeLots(client, partId, qty, jcNo);
    const issueCost = round2((Number(p.costPrice) || 0) * qty);
    if (issueCost > 0) {
      await postJournal(client, {
        date: tsToDs(Date.now()), refType: 'issue', refId: req.params.id, refNo: jcNo,
        by: (req.auth && req.auth.name) || '', memo: `Parts issued to ${jcNo}`,
        lines: [
          { role: 'cogs', debit: issueCost, memo: (p.name || 'Part') + ' x' + qty },
          { role: 'inventory', credit: issueCost, memo: 'Stock relieved' },
        ],
      });
    }
    await client.query(`UPDATE parts SET data = $2 WHERE id = $1`, [partId, JSON.stringify(pMerged)]);
    const line = {
      id: crypto.randomUUID(), partId, name: p.name || '', qty,
      unitPrice: round2(Number(req.body.unitPrice != null ? req.body.unitPrice : p.sellingPrice) || 0),
      costPrice: round2(Number(p.costPrice) || 0),
    };
    line.cost = round2(line.unitPrice * qty); // billed amount for this line
    // Record which batches actually went out, so a recall can trace this unit
    // back to the delivery it arrived on.
    if (lotUse.used.length) line.lots = lotUse.used;
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
        await postMovement(client, { partId: line.partId, partName: p.name, type: 'in',
          qty: Number(line.qty || 0), from, to, unitCost: p.costPrice,
          refType: 'issue-return', refId: req.params.id, refNo: jcNo,
          note: 'Returned from ' + jcNo, by: (req.auth && req.auth.name) || '' });
        const backCost = round2((Number(p.costPrice) || 0) * (Number(line.qty) || 0));
        if (backCost > 0) {
          await postJournal(client, {
            date: tsToDs(Date.now()), refType: 'issue-return', refId: req.params.id, refNo: jcNo,
            by: (req.auth && req.auth.name) || '', memo: `Parts returned from ${jcNo}`,
            lines: [
              { role: 'inventory', debit: backCost, memo: 'Stock back on shelf' },
              { role: 'cogs', credit: backCost, memo: 'Cost of sales reversed' },
            ],
          });
        }
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
    if (req.params.coll === 'finAccounts') sysAccountCache = null;
  if (req.params.coll === 'roles') roleCache = null;
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
  } else if (coll === 'roles') {
    if (await hasRow(`SELECT 1 FROM users WHERE data->>'roleId'=$1`, [id])) return 'people are still assigned to this role';
    const { rows } = await pool.query(`SELECT data FROM roles WHERE id=$1`, [id]);
    if (rows.length && rows[0].data.system) return 'this is a built-in role';
  } else if (coll === 'users') {
    // Deleting a user erases who did what. Deactivate instead.
    return 'a user account is referenced by the audit trail — deactivate it instead of deleting';
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
  // journal_lines is not a COLL document table, but a backup without it would
  // restore journal headers with nothing under them — the books would look
  // present and be empty.
  const jl = await pool.query(`SELECT id, entry_id, account_id, debit, credit, entry_date, data FROM journal_lines`);
  out.journalLines = jl.rows.map((r) => ({
    id: r.id, entryId: r.entry_id, accountId: r.account_id,
    debit: Number(r.debit), credit: Number(r.credit), entryDate: r.entry_date, data: r.data,
  }));
  const sq = await pool.query(`SELECT coll, last FROM seqs`);
  out.seqs = sq.rows;
  // A checksum of what matters, so a restore can say whether the file is whole.
  out.counts = Object.fromEntries(Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
  res.set('Content-Disposition', 'attachment; filename="gms-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json(out);
}));

// ══════════════════════════════════════════════════════════════════════════
// RESTORE
// The counterpart to export, and the reason a backup is worth taking. It is
// deliberately awkward: admin only, it refuses to run without the operator
// typing the exact confirmation phrase, and it defaults to reporting what it
// WOULD do rather than doing it. A restore replaces everything; there is no
// undo, so the friction is the feature.
// ══════════════════════════════════════════════════════════════════════════
const RESTORE_PHRASE = 'REPLACE ALL DATA';

app.post('/api/restore', asyncH(async (req, res) => {
  if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Only the owner account can restore a backup.' });
  const body = req.body || {};
  const backup = body.backup;
  if (!backup || typeof backup !== 'object') return res.status(400).json({ error: 'No backup file supplied.' });
  if (backup.app !== 'tecido-gms') return res.status(400).json({ error: 'That file is not a VIWO backup.' });

  // What the file contains, per collection, before anything is touched.
  const plan = [];
  for (const [name, cfg] of Object.entries(COLL)) {
    const incoming = Array.isArray(backup[name]) ? backup[name].length : 0;
    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM ${cfg.table}`);
    plan.push({ collection: name, current: rows[0].n, incoming });
  }
  const jlIn = Array.isArray(backup.journalLines) ? backup.journalLines.length : 0;
  const jlNow = (await pool.query(`SELECT COUNT(*)::int n FROM journal_lines`)).rows[0].n;
  plan.push({ collection: 'journalLines', current: jlNow, incoming: jlIn });

  const wouldLose = plan.filter((p) => p.current > p.incoming);
  if (!body.confirm || body.confirm !== RESTORE_PHRASE) {
    return res.status(200).json({
      dryRun: true, exportedAt: backup.exportedAt || null, plan, wouldLose,
      message: `This will REPLACE every record in the system with the contents of the backup taken ${backup.exportedAt || 'at an unknown time'}. ` +
        (wouldLose.length ? `${wouldLose.length} collection(s) currently hold MORE than the backup does. ` : '') +
        `To proceed, send confirm: "${RESTORE_PHRASE}".`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Order matters: children before parents on the way out.
    await client.query(`DELETE FROM journal_lines`);
    for (const [, cfg] of Object.entries(COLL)) await client.query(`DELETE FROM ${cfg.table}`);
    await client.query(`DELETE FROM settings`);

    let restored = 0;
    for (const [name, cfg] of Object.entries(COLL)) {
      for (const doc of (Array.isArray(backup[name]) ? backup[name] : [])) {
        const { id, ...data } = doc;
        const cols = extractedColumns(cfg, data);
        if (cfg.seq && data.seq != null) cols.seq = data.seq;
        const names = ['id', 'data', ...Object.keys(cols)];
        const vals = [id || crypto.randomUUID(), JSON.stringify(data), ...Object.values(cols)];
        await client.query(
          `INSERT INTO ${cfg.table} (${names.join(',')}) VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
        restored++;
      }
    }
    for (const l of (Array.isArray(backup.journalLines) ? backup.journalLines : [])) {
      await client.query(
        `INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, entry_date, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [l.id || crypto.randomUUID(), l.entryId, l.accountId, l.debit || 0, l.credit || 0, l.entryDate, JSON.stringify(l.data || {})]);
      restored++;
    }
    for (const st of (Array.isArray(backup.settings) ? backup.settings : [])) {
      const { id, ...data } = st;
      await client.query(`INSERT INTO settings (id, data) VALUES ($1,$2)`, [id || 'company', JSON.stringify(data)]);
    }
    // Numbering must resume above the restored documents, never reissue.
    for (const sq of (Array.isArray(backup.seqs) ? backup.seqs : [])) {
      await client.query(`INSERT INTO seqs (coll, last) VALUES ($1,$2)
                          ON CONFLICT (coll) DO UPDATE SET last = GREATEST(seqs.last, EXCLUDED.last)`,
        [sq.coll, sq.last]);
    }
    await client.query('COMMIT');

    // Caches now describe a database that no longer exists.
    sysAccountCache = null; roleCache = null;
    await loadPeriodLock();

    // Every outstanding token refers to the old data — force everyone to sign in.
    await bumpAuthEpoch();

    audit(req, 'restore', '', '', `${restored} records from ${backup.exportedAt || 'unknown'}`);
    res.json({ ok: true, restored, from: backup.exportedAt || null,
      message: 'Restore complete. Everyone has been signed out — sign in again to continue.' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Restore failed:', e.message);
    return res.status(500).json({ error: 'Restore failed and nothing was changed: ' + e.message });
  } finally {
    client.release();
  }
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
  .then(ensureRoles)
  .then(ensureDefaultBranch)
  .then(migrateMovements)
  .then(() => app.listen(PORT, () => console.log(`GMS server on http://localhost:${PORT}`)))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
