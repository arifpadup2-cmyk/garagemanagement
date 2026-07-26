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

// Collection registry: route name -> table + ordering + extracted columns.
const COLL = {
  customers:    { table: 'customers',    order: 'created_at DESC NULLS LAST' },
  vehicles:     { table: 'vehicles',     order: 'created_at DESC NULLS LAST' },
  jobCards:     { table: 'job_cards',    order: 'created_at DESC NULLS LAST', seq: true, lock: 1001 },
  invoices:     { table: 'invoices',     order: 'created_at DESC NULLS LAST', seq: true, lock: 1002 },
  transactions: { table: 'transactions', order: 'txn_date DESC NULLS LAST', extra: { txn_date: 'date' } },
  finAccounts:  { table: 'fin_accounts', order: 'created_at ASC NULLS LAST' },
  technicians:  { table: 'technicians',  order: 'name ASC NULLS LAST', extra: { name: 'name' }, noCreated: true },
  advisors:     { table: 'advisors',     order: 'name ASC NULLS LAST', extra: { name: 'name' }, noCreated: true },
  appointments: { table: 'appointments', order: 'appt_date ASC NULLS LAST', extra: { appt_date: 'date' } },
  parts:        { table: 'parts',        order: 'created_at DESC NULLS LAST' },
};

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
      const sub = round2(doc.items.reduce((s, it) => s + (Number(it.cost) || 0) * (it.qty != null ? Number(it.qty) || 0 : 1), 0));
      const rate = Number(doc.taxRate) || 0;
      const tax = rate > 0 ? round2(sub * rate / 100) : 0;
      doc.subtotal = sub;
      doc.taxAmount = tax;
      doc.total = round2(sub + tax);
    } else if (typeof doc.total === 'number') {
      doc.total = round2(doc.total);
    }
    for (const k of ['totalPaid', 'discount']) {
      if (typeof doc[k] === 'number') doc[k] = round2(doc[k]);
    }
  }
  if (coll === 'transactions' && typeof doc.amount === 'number') doc.amount = round2(doc.amount);
  // Never store a technician PIN in plaintext — hash any incoming plaintext PIN.
  if (coll === 'technicians' && doc.pin != null && isLegacyPin(doc.pin) && String(doc.pin).length) {
    doc.pin = hashPin(String(doc.pin));
  }
  return doc;
}

const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch((e) => {
  console.error(`${req.method} ${req.originalUrl}:`, e.message);
  // Never leak Postgres internals to the UI.
  res.status(500).json({ error: 'Server error — please try again.' });
});

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
const TECH_READ = new Set(['jobCards', 'technicians', 'customers', 'vehicles', 'parts']);
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

// ---- List ----
app.get('/api/:coll', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next(); // fall through to specific routes (settings, image)
  const { rows } = await pool.query(`SELECT id, data FROM ${cfg.table} ORDER BY ${cfg.order}`);
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

// ---- Create (upsert by id) ----
app.post('/api/:coll', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Document body required' });
  }
  const body = sanitizeDoc(req.params.coll, { ...req.body });
  const id = body.id || crypto.randomUUID();
  const isNew = !body.id;
  delete body.id;
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
    const inv = sanitizeDoc('invoices', { ...invoice }); // recomputes total/subtotal/tax
    delete inv.id;
    const id = crypto.randomUUID();
    inv.seq = await allocSeq(client, 'invoices', 'invoices', COLL.invoices.lock, id);
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

// ---- Update (shallow merge, matching Firestore .update()) ----
app.put('/api/:coll/:id', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
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
async function deleteBlocker(coll, id) {
  const has = async (sql, params) => (await pool.query(sql + ' LIMIT 1', params)).rows.length > 0;
  if (coll === 'customers') {
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
  .then(() => app.listen(PORT, () => console.log(`GMS server on http://localhost:${PORT}`)))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
