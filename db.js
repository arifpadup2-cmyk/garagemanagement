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
});

pool.on('error', (err) => console.error('Unexpected PG pool error:', err.message));

// Each JSONB-document table stores the full Firestore-shaped document in `data`,
// with a few columns extracted from it purely for ordering/indexing.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers    (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
CREATE TABLE IF NOT EXISTS vehicles     (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
CREATE TABLE IF NOT EXISTS job_cards    (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
CREATE TABLE IF NOT EXISTS invoices     (id text PRIMARY KEY, data jsonb NOT NULL, seq int, created_at bigint);
CREATE TABLE IF NOT EXISTS transactions (id text PRIMARY KEY, data jsonb NOT NULL, txn_date text, created_at bigint);
CREATE TABLE IF NOT EXISTS fin_accounts (id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint);
CREATE TABLE IF NOT EXISTS technicians  (id text PRIMARY KEY, data jsonb NOT NULL, name text);
CREATE TABLE IF NOT EXISTS advisors     (id text PRIMARY KEY, data jsonb NOT NULL, name text);
CREATE TABLE IF NOT EXISTS settings     (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS images       (path text PRIMARY KEY, mime text, bytes bytea, created_at bigint);

CREATE INDEX IF NOT EXISTS idx_jobcards_created  ON job_cards(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_created  ON invoices(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_txn_date          ON transactions(txn_date DESC);
`;

async function initSchema() {
  await pool.query(SCHEMA);
  console.log('Schema ready.');
}

module.exports = { pool, initSchema };
