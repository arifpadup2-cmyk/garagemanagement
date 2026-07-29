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
CREATE TABLE IF NOT EXISTS suppliers    (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
CREATE TABLE IF NOT EXISTS purchase_orders (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
-- Generic master/lookup register. One table, discriminated by "kind"
-- (category, brand, uom, labourType, vehicleMake, vehicleModel, fuelType,
-- customerGroup, supplierGroup, taxCode). Hierarchical kinds (vehicleModel ->
-- vehicleMake) hang off parentId. This is the ERP "configuration lookup"
-- pattern: one CRUD path, one permission surface, one audit trail.
CREATE TABLE IF NOT EXISTS masters      (id text PRIMARY KEY, data jsonb NOT NULL, kind text, name text, created_at bigint);
-- Service Master: the sellable labour catalogue (standard hours + rate),
-- distinct from parts (sellable goods). Richer than a lookup, so its own table.
CREATE TABLE IF NOT EXISTS services     (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
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
CREATE INDEX IF NOT EXISTS idx_suppliers_created ON suppliers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_created        ON purchase_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_seq            ON purchase_orders(seq);
CREATE INDEX IF NOT EXISTS idx_po_supplier       ON purchase_orders ((data->>'supplierId'));
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
-- Master data: list-by-kind is the only access pattern, plus the make->model drill.
CREATE INDEX IF NOT EXISTS idx_masters_kind      ON masters(kind, name);
CREATE INDEX IF NOT EXISTS idx_masters_parent    ON masters ((data->>'parentId'));
CREATE INDEX IF NOT EXISTS idx_services_created  ON services(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_services_cat      ON services ((data->>'categoryId'));
`;

// Uniqueness constraints are created SEPARATELY and non-fatally: an existing
// database may already hold duplicates (the old free-text era allowed them), and
// a failed CREATE UNIQUE INDEX must never stop the server from booting. When one
// can't be created we log exactly which duplicates to clean up; the API-level
// duplicate check still guards every new write in the meantime.
const UNIQUE_INDEXES = [
  // A master value is unique by kind + parent + case-insensitive name, so
  // "Toyota"/"toyota" can't both exist, but Toyota>Camry and Honda>Camry can.
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_masters_kind_name ON masters
      (kind, COALESCE(data->>'parentId',''), lower(data->>'name'))`,
   'masters (kind + parent + name)'],
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_masters_kind_code ON masters
      (kind, lower(data->>'code')) WHERE COALESCE(data->>'code','') <> ''`,
   'masters (kind + code)'],
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_services_code ON services
      (lower(data->>'code')) WHERE COALESCE(data->>'code','') <> ''`,
   'services (code)'],
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_parts_number ON parts
      (lower(data->>'partNumber')) WHERE COALESCE(data->>'partNumber','') <> ''`,
   'parts (part number)'],
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_parts_barcode ON parts
      (lower(data->>'barcode')) WHERE COALESCE(data->>'barcode','') <> ''`,
   'parts (barcode)'],
];

async function initSchema() {
  await pool.query(SCHEMA);
  for (const [sql, label] of UNIQUE_INDEXES) {
    try {
      await pool.query(sql);
    } catch (e) {
      console.warn(`[gms] Uniqueness not enforced on ${label}: ${e.message} — de-duplicate the existing rows, then restart to enable it.`);
    }
  }
  console.log('Schema ready.');
}

module.exports = { pool, initSchema };
