'use strict';
/*
 * Tecido Garage Management — API server.
 * Serves the front-end (public/) and a REST API that the Firebase-compat shim
 * (public/gms-backend.js) talks to. Data lives in PostgreSQL (Neon); each
 * collection is a JSONB-document table, photos are bytea in `images`.
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
app.use(express.json({ limit: '15mb' })); // room for base64 images

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
};

function extractedColumns(cfg, doc) {
  // Returns { colName: value } for helper columns derived from the document.
  const cols = {};
  if (!cfg.noCreated) cols.created_at = Number.isFinite(doc.createdAt) ? doc.createdAt : Date.now();
  if (cfg.extra) for (const [col, key] of Object.entries(cfg.extra)) cols[col] = doc[key] ?? null;
  return cols;
}

const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch((e) => {
  console.error(`${req.method} ${req.originalUrl}:`, e.message);
  res.status(500).json({ error: e.message });
});

// ---- List ----
app.get('/api/:coll', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next(); // fall through to specific routes (settings, image)
  const { rows } = await pool.query(`SELECT id, data FROM ${cfg.table} ORDER BY ${cfg.order}`);
  res.json(rows.map((r) => ({ ...r.data, id: r.id })));
}));

// ---- Get one ----
app.get('/api/:coll/:id', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
  const { rows } = await pool.query(`SELECT id, data FROM ${cfg.table} WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ ...rows[0].data, id: rows[0].id });
}));

// ---- Create ----
app.post('/api/:coll', asyncH(async (req, res, next) => {
  const cfg = COLL[req.params.coll];
  if (!cfg) return next();
  const body = { ...req.body };
  const id = body.id || crypto.randomUUID();
  delete body.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (cfg.seq) {
      // Serialize concurrent creators so seq is race-free (aggregates disallow FOR UPDATE).
      await client.query('SELECT pg_advisory_xact_lock($1)', [cfg.lock]);
      const r = await client.query(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM ${cfg.table}`);
      body.seq = r.rows[0].n;
    }
    const cols = extractedColumns(cfg, body);
    const colNames = ['id', 'data', ...Object.keys(cols)];
    const vals = [id, JSON.stringify(body), ...Object.values(cols)];
    const ph = vals.map((_, i) => `$${i + 1}`);
    if (cfg.seq) { colNames.push('seq'); vals.push(body.seq); ph.push(`$${vals.length}`); }
    await client.query(
      `INSERT INTO ${cfg.table} (${colNames.join(',')}) VALUES (${ph.join(',')})
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      vals
    );
    await client.query('COMMIT');
    res.json({ id, ...body });
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
  const patch = { ...req.body };
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

// ---- Images (bytea). Path is the client-chosen storage path, url-encoded. ----
app.post('/api/image', asyncH(async (req, res) => {
  const { path: p, mime, base64 } = req.body || {};
  if (!p || !base64) return res.status(400).json({ error: 'path and base64 required' });
  const bytes = Buffer.from(base64, 'base64');
  await pool.query(
    `INSERT INTO images (path, mime, bytes, created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (path) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes`,
    [p, mime || 'image/jpeg', bytes, Date.now()]
  );
  res.json({ url: '/api/image?p=' + encodeURIComponent(p), path: p });
}));
app.get('/api/image', asyncH(async (req, res) => {
  const p = req.query.p;
  if (!p) return res.status(400).end();
  const { rows } = await pool.query(`SELECT mime, bytes FROM images WHERE path = $1`, [p]);
  if (!rows.length) return res.status(404).end();
  res.set('Content-Type', rows[0].mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(rows[0].bytes);
}));
app.delete('/api/image', asyncH(async (req, res) => {
  const p = req.query.p;
  if (p) await pool.query(`DELETE FROM images WHERE path = $1`, [p]);
  res.json({ ok: true });
}));

// ---- Admin login (credentials from env, never from the repo) ----
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const U = (process.env.ADMIN_USER || 'arifpadup').toLowerCase();
  const P = process.env.ADMIN_PASSWORD || '';
  const NAME = process.env.ADMIN_NAME || 'ARIF';
  if (!P) return res.status(500).json({ ok: false, error: 'Admin login not configured (set ADMIN_PASSWORD).' });
  if (String(username || '').trim().toLowerCase() === U && String(password) === P) {
    return res.json({ ok: true, name: NAME });
  }
  return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
});

app.get('/api/health', asyncH(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, ts: Date.now() });
}));

// ---- Static front-end ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => app.listen(PORT, () => console.log(`GMS server on http://localhost:${PORT}`)))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
