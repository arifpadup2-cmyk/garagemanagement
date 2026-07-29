'use strict';
// Seeds the Phase 1 master-data lists with sensible Qatar workshop defaults.
//
// Safe to re-run: every entry is matched on (kind, parent, lower(name)) and
// skipped if it already exists, so this never duplicates and never overwrites
// anything the garage has edited. Nothing else in the database is touched.
//
//   node scripts/seed-masters.js
//
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Same minimal .env loader the server uses — no dotenv dependency.
(function loadEnv() {
  try {
    const p = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
})();

const { pool, initSchema } = require('../db');

// name | code | description  (rate as 3rd field for taxCode)
const LISTS = {
  uom: [
    ['Piece', 'PCS', 'Individually counted items'],
    ['Litre', 'LTR', 'Bulk fluids — oil, coolant, brake fluid'],
    ['Set', 'SET', 'Sold together, e.g. a set of brake pads'],
    ['Pair', 'PR', 'Two-part items, e.g. wiper blades'],
    ['Metre', 'MTR', 'Hose, wiring, trim by length'],
    ['Kit', 'KIT', 'Bundled service kit'],
    ['Hour', 'HR', 'Labour time'],
  ],
  fuelType: [
    ['Petrol', 'PET', ''],
    ['Diesel', 'DSL', ''],
    ['Hybrid', 'HYB', ''],
    ['Electric', 'EV', ''],
    ['LPG', 'LPG', ''],
  ],
  category: [
    ['Engine', 'ENG', 'Engine internals, gaskets, belts'],
    ['Filters', 'FLT', 'Oil, air, fuel and cabin filters'],
    ['Brakes', 'BRK', 'Pads, discs, calipers, brake fluid'],
    ['Suspension', 'SUS', 'Shocks, bushes, arms, links'],
    ['Electrical', 'ELE', 'Batteries, alternators, starters, sensors'],
    ['Air Conditioning', 'AC', 'Compressors, gas, condensers'],
    ['Transmission', 'TRN', 'Gearbox, clutch, differential'],
    ['Tyres & Wheels', 'TYR', 'Tyres, rims, balancing weights'],
    ['Body & Paint', 'BDY', 'Panels, bumpers, paint and consumables'],
    ['Fluids & Lubricants', 'FLU', 'Engine oil, coolant, ATF, grease'],
    ['Consumables', 'CNS', 'Rags, cleaners, fasteners, workshop supplies'],
  ],
  brand: [
    ['Bosch', 'BSH', 'Filters, brakes, electrical'],
    ['Denso', 'DNS', 'Plugs, filters, AC components'],
    ['Mobil', 'MBL', 'Engine oils and lubricants'],
    ['Shell', 'SHL', 'Engine oils and lubricants'],
    ['Castrol', 'CST', 'Engine oils and lubricants'],
    ['NGK', 'NGK', 'Spark plugs and ignition'],
    ['Brembo', 'BRM', 'Brake discs and pads'],
    ['Monroe', 'MNR', 'Shock absorbers and suspension'],
    ['Gates', 'GTS', 'Belts and hoses'],
    ['Exide', 'EXD', 'Batteries'],
    ['ACDelco', 'ACD', 'General replacement parts'],
    ['Genuine (OEM)', 'OEM', 'Manufacturer original parts'],
    ['Aftermarket', 'AFT', 'Unbranded or generic replacement'],
  ],
  labourType: [
    ['Mechanical', 'MECH', 'General mechanical repair'],
    ['Electrical', 'ELEC', 'Auto-electrical diagnosis and repair'],
    ['Air Conditioning', 'AC', 'AC service and repair'],
    ['Body & Paint', 'BODY', 'Panel beating, preparation and paint'],
    ['Diagnostics', 'DIAG', 'Scan-tool diagnosis and road testing'],
    ['Tyre & Wheel', 'TYRE', 'Fitting, balancing and alignment'],
    ['Valet & Wash', 'WASH', 'Cleaning, polishing and detailing'],
  ],
  // Qatar levies no VAT today, so the default is a 0% standard code. When VAT
  // arrives, add the rated code here and switch it on in Settings.
  taxCode: [
    ['Standard Rate', 'STD', 0],
    ['Zero Rated', 'ZERO', 0],
    ['Exempt', 'EXM', 0],
  ],
  customerGroup: [
    ['Retail', 'RTL', 'Walk-in private customers'],
    ['Fleet', 'FLT', 'Corporate fleets on account'],
    ['Insurance', 'INS', 'Accident repair billed to an insurer'],
    ['Internal', 'INT', 'Own vehicles — no revenue'],
  ],
  supplierGroup: [
    ['Spare Parts', 'PRT', 'Mechanical and electrical parts'],
    ['Tyres', 'TYR', 'Tyre and wheel suppliers'],
    ['Lubricants', 'LUB', 'Oils, greases and workshop fluids'],
    ['Sublet', 'SUB', 'Outsourced work — machining, upholstery, glass'],
    ['Consumables', 'CNS', 'Workshop supplies and equipment'],
  ],
  vehicleMake: [
    ['Toyota', 'TOY', ''], ['Nissan', 'NIS', ''], ['Lexus', 'LEX', ''],
    ['Mitsubishi', 'MIT', ''], ['Honda', 'HON', ''], ['Hyundai', 'HYU', ''],
    ['Kia', 'KIA', ''], ['Ford', 'FRD', ''], ['Chevrolet', 'CHV', ''],
    ['Mercedes-Benz', 'MRC', ''], ['BMW', 'BMW', ''], ['Land Rover', 'LRV', ''],
    ['Jeep', 'JEP', ''], ['GMC', 'GMC', ''], ['Isuzu', 'ISU', ''],
  ],
};

// Models, filed under their make.
const MODELS = {
  Toyota: ['Camry', 'Corolla', 'Land Cruiser', 'Prado', 'Hilux', 'Fortuner', 'Yaris', 'RAV4', 'Avalon', 'Coaster'],
  Nissan: ['Patrol', 'Altima', 'Sunny', 'X-Trail', 'Pathfinder', 'Navara', 'Kicks', 'Maxima'],
  Lexus: ['LX', 'GX', 'ES', 'RX', 'IS', 'NX'],
  Mitsubishi: ['Pajero', 'L200', 'Lancer', 'Outlander', 'Attrage'],
  Honda: ['Accord', 'Civic', 'CR-V', 'Pilot', 'City'],
  Hyundai: ['Sonata', 'Elantra', 'Tucson', 'Santa Fe', 'Accent', 'Creta'],
  Kia: ['Sportage', 'Sorento', 'Cerato', 'Optima', 'Pegas', 'Carnival'],
  Ford: ['Explorer', 'F-150', 'Edge', 'Expedition', 'Ranger', 'Mustang'],
  Chevrolet: ['Tahoe', 'Silverado', 'Malibu', 'Captiva', 'Suburban', 'Traverse'],
  'Mercedes-Benz': ['C-Class', 'E-Class', 'S-Class', 'GLE', 'GLC', 'G-Class'],
  BMW: ['3 Series', '5 Series', '7 Series', 'X3', 'X5', 'X7'],
  'Land Rover': ['Range Rover', 'Range Rover Sport', 'Discovery', 'Defender'],
  Jeep: ['Wrangler', 'Grand Cherokee', 'Cherokee'],
  GMC: ['Yukon', 'Sierra', 'Acadia', 'Terrain'],
  Isuzu: ['D-Max', 'MU-X', 'NPR'],
};

// The service catalogue a workshop actually sells, priced at hours x rate.
// name | code | category | labour type | hours | rate
const SERVICES = [
  ['Engine Oil & Filter Change', 'SVC-OIL', 'Filters', 'Mechanical', 1, 80],
  ['Major Service (30,000 km)', 'SVC-MAJ', 'Engine', 'Mechanical', 3, 80],
  ['Minor Service (10,000 km)', 'SVC-MIN', 'Engine', 'Mechanical', 1.5, 80],
  ['Front Brake Pad Replacement', 'SVC-BRKF', 'Brakes', 'Mechanical', 1.5, 80],
  ['Rear Brake Pad Replacement', 'SVC-BRKR', 'Brakes', 'Mechanical', 1.5, 80],
  ['Brake Disc Skimming', 'SVC-DISC', 'Brakes', 'Mechanical', 2, 80],
  ['AC Gas Refill & Leak Test', 'SVC-ACG', 'Air Conditioning', 'Air Conditioning', 1.5, 90],
  ['AC Compressor Replacement', 'SVC-ACC', 'Air Conditioning', 'Air Conditioning', 4, 90],
  ['Battery Replacement & Test', 'SVC-BAT', 'Electrical', 'Electrical', 0.5, 85],
  ['Alternator Replacement', 'SVC-ALT', 'Electrical', 'Electrical', 3, 85],
  ['Computer Diagnostic Scan', 'SVC-DIAG', 'Electrical', 'Diagnostics', 1, 100],
  ['Wheel Alignment', 'SVC-ALGN', 'Tyres & Wheels', 'Tyre & Wheel', 1, 70],
  ['Wheel Balancing (4 wheels)', 'SVC-BAL', 'Tyres & Wheels', 'Tyre & Wheel', 0.75, 70],
  ['Tyre Fitting (per tyre)', 'SVC-TYRE', 'Tyres & Wheels', 'Tyre & Wheel', 0.25, 70],
  ['Suspension Inspection', 'SVC-SUSP', 'Suspension', 'Mechanical', 1, 80],
  ['Shock Absorber Replacement (pair)', 'SVC-SHOK', 'Suspension', 'Mechanical', 2.5, 80],
  ['Clutch Overhaul', 'SVC-CLCH', 'Transmission', 'Mechanical', 6, 80],
  ['Gearbox Oil Change', 'SVC-GBOX', 'Transmission', 'Mechanical', 1, 80],
  ['Timing Belt Replacement', 'SVC-TBLT', 'Engine', 'Mechanical', 4, 80],
  ['Radiator Flush & Coolant Change', 'SVC-COOL', 'Engine', 'Mechanical', 1.5, 80],
  ['Full Vehicle Inspection (VHC)', 'SVC-VHC', 'Engine', 'Diagnostics', 1, 100],
  ['Wash & Interior Vacuum', 'SVC-WASH', 'Consumables', 'Valet & Wash', 0.5, 40],
  ['Full Detailing & Polish', 'SVC-DTL', 'Consumables', 'Valet & Wash', 4, 40],
  ['Pre-Purchase Inspection', 'SVC-PPI', 'Engine', 'Diagnostics', 2, 100],
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function main() {
  await initSchema();
  const now = Date.now();
  let added = 0, skipped = 0;

  // Existing rows, so a re-run is a no-op rather than a duplicate storm.
  const existing = new Map();
  for (const r of (await pool.query(`SELECT id, kind, data FROM masters`)).rows) {
    existing.set(`${r.kind}|${r.data.parentId || ''}|${String(r.data.name || '').toLowerCase()}`, r.id);
  }

  const put = async (kind, name, code, extra) => {
    const key = `${kind}|${(extra && extra.parentId) || ''}|${name.toLowerCase()}`;
    if (existing.has(key)) { skipped++; return existing.get(key); }
    const id = crypto.randomUUID();
    const doc = { kind, name, code: code || '', active: true, createdAt: now, createdBy: 'seed', ...(extra || {}) };
    await pool.query(
      `INSERT INTO masters (id, data, kind, name, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, JSON.stringify(doc), kind, name, now]
    );
    existing.set(key, id); added++;
    return id;
  };

  for (const [kind, rows] of Object.entries(LISTS)) {
    for (const [name, code, third] of rows) {
      await put(kind, name, code, kind === 'taxCode' ? { rate: Number(third) || 0 } : { description: third || '' });
    }
  }

  for (const [make, models] of Object.entries(MODELS)) {
    const makeId = existing.get(`vehicleMake||${make.toLowerCase()}`);
    if (!makeId) continue;
    for (const m of models) await put('vehicleModel', m, '', { parentId: makeId });
  }

  // Services reference the category/labour-type ids we just ensured exist.
  const idOf = (kind, name) => existing.get(`${kind}||${name.toLowerCase()}`) || '';
  const haveSvc = new Set(
    (await pool.query(`SELECT data FROM services`)).rows.map((r) => String(r.data.name || '').toLowerCase())
  );
  let svcAdded = 0, svcSkipped = 0;
  for (const [name, code, cat, lab, hours, rate] of SERVICES) {
    if (haveSvc.has(name.toLowerCase())) { svcSkipped++; continue; }
    const doc = {
      name, code, categoryId: idOf('category', cat), labourTypeId: idOf('labourType', lab),
      taxCodeId: idOf('taxCode', 'Standard Rate'),
      standardHours: hours, standardRate: rate, price: round2(hours * rate),
      priceOverride: false, description: '', active: true, createdAt: now, createdBy: 'seed',
    };
    await pool.query(`INSERT INTO services (id, data, created_at) VALUES ($1,$2,$3)`,
      [crypto.randomUUID(), JSON.stringify(doc), now]);
    svcAdded++;
  }

  console.log(`Master lists: ${added} added, ${skipped} already present.`);
  console.log(`Services:     ${svcAdded} added, ${svcSkipped} already present.`);

  // ---- Backfill: link records written before the master lists existed ----
  // Only fills an id that is MISSING, and only on an exact case-insensitive name
  // match. Never rewrites a name, never guesses, never touches a record that is
  // already linked — so this is safe to run repeatedly on live data.
  const link = async (table, field, kind, idField, parentFrom) => {
    const { rows } = await pool.query(
      `SELECT id, data FROM ${table}
        WHERE COALESCE(data->>'${idField}','') = ''
          AND COALESCE(data->>'${field}','') <> ''`
    );
    let n = 0, miss = new Set();
    for (const r of rows) {
      const parentId = parentFrom ? (r.data[parentFrom] || '') : '';
      const key = `${kind}|${parentId}|${String(r.data[field]).trim().toLowerCase()}`;
      const id = existing.get(key);
      if (!id) { miss.add(r.data[field]); continue; }
      await pool.query(`UPDATE ${table} SET data = data || $2::jsonb WHERE id = $1`,
        [r.id, JSON.stringify({ [idField]: id })]);
      n++;
    }
    if (n || miss.size) {
      console.log(`  ${table}.${field} → ${idField}: ${n} linked` +
        (miss.size ? `, ${miss.size} unmatched (${[...miss].slice(0, 6).join(', ')})` : ''));
    }
  };

  console.log('Backfill:');
  await link('parts', 'category', 'category', 'categoryId');
  await link('parts', 'brand', 'brand', 'brandId');
  await link('parts', 'unit', 'uom', 'uomId');
  await link('vehicles', 'make', 'vehicleMake', 'makeId');
  await link('vehicles', 'fuelType', 'fuelType', 'fuelTypeId');
  // Models resolve within their make, so this must run after makeId is set.
  await link('vehicles', 'model', 'vehicleModel', 'modelId', 'makeId');
  await link('customers', 'group', 'customerGroup', 'groupId');
  await link('suppliers', 'group', 'supplierGroup', 'groupId');
  console.log('  (unmatched values are left exactly as they are — add them to the list, then re-run)');

  await pool.end();
}

main().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
