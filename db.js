'use strict';
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Copy .env.example to .env.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 8,
  idleTimeoutMillis: 30000,
  // Fail fast instead of hanging forever when the pool is exhausted or a query
  // runs away — users get an error toast, not a silent multi-minute stall.
  connectionTimeoutMillis: 10000,
  statement_timeout: 20000,
  query_timeout: 20000,
});

pool.on('error', (err) => console.error('Unexpected PG pool error:', err.message));

// Each JSONB-document table stores the full Firestore-shaped document in `data`,
// with a few columns extracted from it purely for ordering/indexing.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers    (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
CREATE TABLE IF NOT EXISTS vehicles     (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
CREATE TABLE IF NOT EXISTS job_cards    (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
CREATE TABLE IF NOT EXISTS estimates    (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
CREATE TABLE IF NOT EXISTS invoices     (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
CREATE TABLE IF NOT EXISTS transactions (id text PRIMARY KEY, data jsonb NOT NULL, txn_date text, created_at bigint);
CREATE TABLE IF NOT EXISTS fin_accounts (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
CREATE TABLE IF NOT EXISTS technicians  (id text PRIMARY KEY, data jsonb NOT NULL, name text);
CREATE TABLE IF NOT EXISTS advisors     (id text PRIMARY KEY, data jsonb NOT NULL, name text);
CREATE TABLE IF NOT EXISTS appointments (id text PRIMARY KEY, data jsonb NOT NULL, appt_date text, created_at bigint);
CREATE TABLE IF NOT EXISTS parts        (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
CREATE TABLE IF NOT EXISTS settings     (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS images       (path text PRIMARY KEY, mime text, bytes bytea, created_at bigint);
CREATE TABLE IF NOT EXISTS seqs         (coll text PRIMARY KEY, last bigint NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log    (id bigserial PRIMARY KEY, at bigint, actor text, role text, action text, coll text, doc_id text, summary text);

-- Sort-column indexes for the ORDER BY on every list query.
CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicles_created  ON vehicles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobcards_created  ON job_cards(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_estimates_created ON estimates(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_estimates_seq     ON estimates(seq);
CREATE INDEX IF NOT EXISTS idx_invoices_created  ON invoices(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parts_created     ON parts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_finacc_created    ON fin_accounts(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_tech_name         ON technicians(name ASC);
CREATE INDEX IF NOT EXISTS idx_adv_name          ON advisors(name ASC);
CREATE INDEX IF NOT EXISTS idx_txn_date          ON transactions(txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_appt_date         ON appointments(appt_date);
-- seq indexes so the numbering allocator's MAX(seq) is O(1), not a scan.
CREATE INDEX IF NOT EXISTS idx_jobcards_seq      ON job_cards(seq);
CREATE INDEX IF NOT EXISTS idx_invoices_seq      ON invoices(seq);
-- One invoice per job card, enforced by the database (client-side guards race).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_jobcard
  ON invoices ((data->>'jobCardId')) WHERE data->>'jobCardId' IS NOT NULL AND data->>'jobCardId' <> '';
-- JSONB expression indexes for the filters server-side pagination will use.
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices ((data->>'customerId'));
CREATE INDEX IF NOT EXISTS idx_invoices_status   ON invoices ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_jobcards_customer ON job_cards ((data->>'customerId'));
CREATE INDEX IF NOT EXISTS idx_jobcards_vehicle  ON job_cards ((data->>'vehicleId'));
CREATE INDEX IF NOT EXISTS idx_jobcards_status   ON job_cards ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_vehicles_customer ON vehicles ((data->>'customerId'));
CREATE INDEX IF NOT EXISTS idx_txn_account       ON transactions ((data->>'accountId'));
CREATE INDEX IF NOT EXISTS idx_txn_invoice       ON transactions ((data->>'invoiceId'));
CREATE INDEX IF NOT EXISTS idx_audit_at          ON audit_log(at DESC);
`;

async function initSchema() {
  await pool.query(SCHEMA);
  console.log('Schema ready.');
}

module.exports = { pool, initSchema };
