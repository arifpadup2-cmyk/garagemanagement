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
-- ── Procure-to-pay chain (Phase 2) ──
-- PR -> RFQ -> PO -> GRN -> Purchase Invoice, with returns hanging off the GRN.
-- Each is a real document with its own number, because "who ordered it", "what
-- actually arrived" and "what the supplier billed" are three different facts
-- that routinely disagree.
CREATE TABLE IF NOT EXISTS purchase_requests (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
CREATE TABLE IF NOT EXISTS rfqs              (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
CREATE TABLE IF NOT EXISTS goods_receipts    (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
CREATE TABLE IF NOT EXISTS purchase_invoices (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
CREATE TABLE IF NOT EXISTS purchase_returns  (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
-- Stock lots: the batch / expiry / serial ledger sitting behind parts.stock.
-- One row per received batch; for serialised items, one row per serial (qty 1).
CREATE TABLE IF NOT EXISTS stock_lots        (id text PRIMARY KEY, data jsonb NOT NULL, part_id text, created_at bigint);

-- ── Inventory & warehouse (Phase 3) ──
-- Stock movements are a LEDGER, not an array on the item. Embedding them in the
-- part document meant every issue rewrote the entire history, which is both a
-- write-amplification wall and impossible to query across items.
CREATE TABLE IF NOT EXISTS stock_movements (id text PRIMARY KEY, data jsonb NOT NULL, part_id text, at bigint);
CREATE TABLE IF NOT EXISTS warehouses      (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
CREATE TABLE IF NOT EXISTS bins            (id text PRIMARY KEY, data jsonb NOT NULL, warehouse_id text, created_at bigint);
CREATE TABLE IF NOT EXISTS stock_transfers (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
CREATE TABLE IF NOT EXISTS stock_counts    (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
CREATE TABLE IF NOT EXISTS reservations    (id text PRIMARY KEY, data jsonb NOT NULL, part_id text, created_at bigint);
CREATE TABLE IF NOT EXISTS tools           (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
CREATE TABLE IF NOT EXISTS tool_issues     (id text PRIMARY KEY, data jsonb NOT NULL, tool_id text, created_at bigint);

-- ── Bank reconciliation ──
-- A statement from the bank, and which of our own postings each line matches.
-- The point is the DIFFERENCE: what the bank says minus what we have matched
-- is either a timing difference we can name or an error we need to find.
CREATE TABLE IF NOT EXISTS bank_recs (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);

-- ── Users, roles & permissions (Phase 9) ──
-- Until now there was one hardcoded admin from the environment plus technician
-- PINs. Everyone who was not a technician had complete authority over money,
-- stock and master data, with no way to tell who did what beyond one shared
-- login. These are real accounts with real, named permissions.
CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, data jsonb NOT NULL, username text, created_at bigint);
CREATE TABLE IF NOT EXISTS roles (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);

-- ── Double-entry general ledger (Phase 7) ──
-- Until now the trial balance was DERIVED in the browser from invoices and cash
-- transactions, which is why it could never balance: inventory and COGS had no
-- representation at all. These two tables are the actual books. Every business
-- event posts a balanced journal; every report reads from journal_lines.
CREATE TABLE IF NOT EXISTS journal_entries (id text PRIMARY KEY, data jsonb NOT NULL, seq int, entry_date text, created_at bigint);
CREATE TABLE IF NOT EXISTS journal_lines   (id text PRIMARY KEY, entry_id text NOT NULL, account_id text,
                                            debit numeric(14,2) NOT NULL DEFAULT 0,
                                            credit numeric(14,2) NOT NULL DEFAULT 0,
                                            entry_date text, data jsonb NOT NULL);

-- ── Sales credit notes (Phase 6) ──
-- A sales invoice is evidence given to a customer and posted to the ledger, so
-- it is never edited or deleted after the fact. A credit note is the correcting
-- document: it reverses value, optionally restocks the goods, and leaves both
-- the original and the correction on the record.
CREATE TABLE IF NOT EXISTS credit_notes    (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);

-- ── Workshop operations (Phase 5) ──
-- A bay is a physical work position. Only one job can occupy one at a time,
-- which is what makes "the workshop is full" a fact rather than a feeling.
CREATE TABLE IF NOT EXISTS bays            (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
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
-- Procure-to-pay: every list is drawn newest-first, and each document is looked
-- up by the document upstream of it.
CREATE INDEX IF NOT EXISTS idx_pr_created        ON purchase_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pr_seq            ON purchase_requests(seq);
CREATE INDEX IF NOT EXISTS idx_rfq_created       ON rfqs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rfq_seq           ON rfqs(seq);
CREATE INDEX IF NOT EXISTS idx_grn_created       ON goods_receipts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_grn_seq           ON goods_receipts(seq);
CREATE INDEX IF NOT EXISTS idx_grn_po            ON goods_receipts ((data->>'poId'));
CREATE INDEX IF NOT EXISTS idx_pinv_created      ON purchase_invoices(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pinv_seq          ON purchase_invoices(seq);
CREATE INDEX IF NOT EXISTS idx_pinv_supplier     ON purchase_invoices ((data->>'supplierId'));
CREATE INDEX IF NOT EXISTS idx_pinv_status       ON purchase_invoices ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_pret_created      ON purchase_returns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pret_seq          ON purchase_returns(seq);
CREATE INDEX IF NOT EXISTS idx_pret_grn          ON purchase_returns ((data->>'grnId'));
-- Lots are always read for one part, and picked oldest-first (FIFO / FEFO).
CREATE INDEX IF NOT EXISTS idx_lots_part         ON stock_lots(part_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_lots_expiry       ON stock_lots ((data->>'expiryDate'));
CREATE INDEX IF NOT EXISTS idx_lots_wh           ON stock_lots ((data->>'warehouseId'));
-- Movement ledger: read per item newest-first, and per source document.
CREATE INDEX IF NOT EXISTS idx_mov_part          ON stock_movements(part_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_mov_at            ON stock_movements(at DESC);
CREATE INDEX IF NOT EXISTS idx_mov_ref           ON stock_movements ((data->>'refId'));
CREATE INDEX IF NOT EXISTS idx_mov_wh            ON stock_movements ((data->>'warehouseId'));
CREATE INDEX IF NOT EXISTS idx_bins_wh           ON bins(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_wh_created        ON warehouses(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_xfer_created      ON stock_transfers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_xfer_seq          ON stock_transfers(seq);
CREATE INDEX IF NOT EXISTS idx_count_created     ON stock_counts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_count_seq         ON stock_counts(seq);
CREATE INDEX IF NOT EXISTS idx_resv_part         ON reservations(part_id);
CREATE INDEX IF NOT EXISTS idx_resv_ref          ON reservations ((data->>'jobCardId'));
CREATE INDEX IF NOT EXISTS idx_resv_status       ON reservations ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_tools_created     ON tools(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_toolissue_tool    ON tool_issues(tool_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_toolissue_open    ON tool_issues ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_bays_created      ON bays(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_cn_created        ON credit_notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cn_seq            ON credit_notes(seq);
CREATE INDEX IF NOT EXISTS idx_cn_invoice        ON credit_notes ((data->>'invoiceId'));
-- The ledger is read by account, by date, and by the document that caused it.
CREATE INDEX IF NOT EXISTS idx_bankrec_created   ON bank_recs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bankrec_acct      ON bank_recs ((data->>'accountId'));
-- Reconciled state lives on the journal line, so an extract can show it.
CREATE INDEX IF NOT EXISTS idx_jl_recon         ON journal_lines ((data->>'reconciledIn'));
CREATE INDEX IF NOT EXISTS idx_users_created     ON users(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_roles_created     ON roles(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_je_date           ON journal_entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_je_seq            ON journal_entries(seq);
CREATE INDEX IF NOT EXISTS idx_je_ref            ON journal_entries ((data->>'refId'));
CREATE INDEX IF NOT EXISTS idx_jl_entry          ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_account        ON journal_lines(account_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_jl_date           ON journal_lines(entry_date);
CREATE INDEX IF NOT EXISTS idx_jc_bay            ON job_cards ((data->>'bayId'));
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
  // A serial number identifies one physical unit. Two units of the same item
  // cannot carry the same serial while both are in stock — but a serial may
  // legitimately reappear after the first was sold or returned, so the
  // constraint applies only to lots still available.
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_lots_serial ON stock_lots
      (part_id, lower(data->>'serialNo'))
      WHERE COALESCE(data->>'serialNo','') <> '' AND COALESCE(data->>'status','available') = 'available'`,
   'stock lots (serial number)'],
  // Paying the same supplier bill twice is the classic purchasing loss. One
  // invoice number per supplier makes the duplicate impossible to record.
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_pinv_supplier_no ON purchase_invoices
      ((data->>'supplierId'), lower(data->>'invoiceNo'))
      WHERE COALESCE(data->>'invoiceNo','') <> '' AND COALESCE(data->>'status','') <> 'cancelled'`,
   'purchase invoices (supplier + invoice number)'],
  // A bin code identifies one physical location within a warehouse.
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_bins_code ON bins
      (warehouse_id, lower(data->>'code')) WHERE COALESCE(data->>'code','') <> ''`,
   'bins (warehouse + code)'],
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_code ON warehouses
      (lower(data->>'code')) WHERE COALESCE(data->>'code','') <> ''`,
   'warehouses (code)'],
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_tools_code ON tools
      (lower(data->>'code')) WHERE COALESCE(data->>'code','') <> ''`,
   'tools (code)'],
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_bays_code ON bays
      (lower(data->>'code')) WHERE COALESCE(data->>'code','') <> ''`,
   'bays (code)'],
  // Two accounts sharing a username makes "who did this?" unanswerable.
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users (lower(username))`,
   'users (username)'],
  [`CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_name ON roles (lower(data->>'name'))`,
   'roles (name)'],
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
