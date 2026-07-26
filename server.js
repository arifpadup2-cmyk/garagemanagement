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
app.use(express.json({ limit: '15mb' })); // room for base64 images
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

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
// invoice between "paid" and "partial".
function sanitizeDoc(coll, doc) {
  if (coll === 'invoices') {
    for (const k of ['total', 'subtotal', 'taxAmount', 'totalPaid', 'discount']) {
      if (typeof doc[k] === 'number') doc[k] = round2(doc[k]);
    }
  }
  if (coll === 'transactions' && typeof doc.amount === 'number') doc.amount = round2(doc.amount);
  return doc;
}

const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch((e) => {
  console.error(`${req.method} ${req.originalUrl}:`, e.message);
  // Never leak Postgres internals to the UI.
  res.status(500).json({ error: 'Server error — please try again.' });
});

// ---- Auth (stateless HMAC tokens; survive server restarts) ----
const SECRET = process.env.SESSION_SECRET
  ? Buffer.from(process.env.SESSION_SECRET)
  : crypto.createHash('sha256').update('gms:' + (process.env.ADMIN_PASSWORD || '')).digest();
const TOKEN_TTL = 30 * 24 * 3600 * 1000; // 30 days

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
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const p = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!p) return res.status(401).json({ error: 'Unauthorized' });
  req.auth = p;
  next();
}

// Light brute-force guard on the two login routes.
const loginFails = new Map(); // ip -> { n, until }
function loginGuard(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  const f = loginFails.get(ip);
  if (f && f.until > Date.now()) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });
  req._loginIp = ip;
  next();
}
function noteLoginFail(ip) {
  const f = loginFails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; }
  loginFails.set(ip, f);
}

// ---- Public routes (registered before the auth gate) ----

app.post('/api/login', loginGuard, (req, res) => {
  const { username, password } = req.body || {};
  const U = (process.env.ADMIN_USER || 'arifpadup').toLowerCase();
  const P = process.env.ADMIN_PASSWORD || '';
  const NAME = process.env.ADMIN_NAME || 'ARIF';
  if (!P) return res.status(500).json({ ok: false, error: 'Admin login not configured (set ADMIN_PASSWORD).' });
  if (String(username || '').trim().toLowerCase() === U && String(password) === P) {
    return res.json({ ok: true, name: NAME, token: signToken({ role: 'admin', name: NAME }) });
  }
  noteLoginFail(req._loginIp);
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
app.post('/api/tech-login', loginGuard, asyncH(async (req, res) => {
  const { id, pin } = req.body || {};
  const { rows } = await pool.query(`SELECT id, data FROM technicians WHERE id = $1`, [id]);
  const t = rows.length ? rows[0].data : null;
  if (!t || String(t.pin || '') !== String(pin || '')) {
    noteLoginFail(req._loginIp);
    return res.status(401).json({ ok: false, error: 'Incorrect PIN. Please try again.' });
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

// Technician PINs never leave the server for non-admin sessions.
function redactTechs(auth, docs) {
  if (auth && auth.role === 'admin') return docs;
  return docs.map((d) => { const c = { ...d }; delete c.pin; return c; });
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

// ---- Create (upsert by id) ----
app.post('/api/:coll', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Document body required' });
  }
  const body = sanitizeDoc(req.params.coll, { ...req.body });
  const id = body.id || crypto.randomUUID();
  delete body.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (cfg.seq) {
      // Serialize concurrent creators so seq is race-free. Numbers come from a
      // monotonic per-collection counter (seqs table) so a deleted document's
      // number is never reissued.
      await client.query('SELECT pg_advisory_xact_lock($1)', [cfg.lock]);
      const existing = await client.query(`SELECT seq FROM ${cfg.table} WHERE id = $1`, [id]);
      if (existing.rows.length && existing.rows[0].seq != null) {
        body.seq = existing.rows[0].seq; // re-set of an existing doc keeps its number
      } else {
        const r = await client.query(
          `INSERT INTO seqs (coll, last)
           VALUES ($1, (SELECT COALESCE(MAX(seq),0) FROM ${cfg.table}) + 1)
           ON CONFLICT (coll) DO UPDATE
             SET last = GREATEST(seqs.last, (SELECT COALESCE(MAX(seq),0) FROM ${cfg.table})) + 1
           RETURNING last`,
          [req.params.coll]
        );
        body.seq = Number(r.rows[0].last);
      }
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT data FROM ${cfg.table} WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const merged = { ...cur.rows[0].data, ...patch };
    const cols = extractedColumns(cfg, merged);
    if (cfg.seq && merged.seq != null) cols.seq = merged.seq;
    const sets = ['data = $2'];
    const vals = [req.params.id, JSON.stringify(merged)];
    for (const [c, v] of Object.entries(cols)) { vals.push(v); sets.push(`${c} = $${vals.length}`); }
    await client.query(`UPDATE ${cfg.table} SET ${sets.join(', ')} WHERE id = $1`, vals);
    await client.query('COMMIT');
    res.json({ id: req.params.id, ...merged });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- Delete ----
app.delete('/api/:coll/:id', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
  await pool.query(`DELETE FROM ${cfg.table} WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
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
  .then(() => app.listen(PORT, () => console.log(`GMS server on http://localhost:${PORT}`)))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
