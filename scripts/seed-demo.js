'use strict';
/*
 * Demo data seeder for Tecido Garage Management.
 * Posts a coherent Qatar auto-garage dataset through the REST API so the app
 * renders realistically for demos. Idempotency: refuses to run if data exists.
 * Usage:  node scripts/seed-demo.js            (targets http://localhost:3010)
 *         BASE=http://host:port node scripts/seed-demo.js
 */
const BASE = process.env.BASE || 'http://localhost:3010';

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}
const post = (coll, doc) => api('POST', '/api/' + coll, doc);
const put = (path, doc) => api('PUT', path, doc);

// Date helpers (real time; script runs in a normal Node process).
const now = Date.now();
const daysAgo = (d) => now - d * 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

async function main() {
  // Guard: never seed on top of existing data.
  const existing = await api('GET', '/api/customers');
  if (existing.length) {
    console.error(`Refusing to seed: ${existing.length} customers already exist. Clear data first.`);
    process.exit(1);
  }
  console.log('Seeding demo data ->', BASE);

  // --- Company profile ---
  await put('/api/settings/company', {
    name: 'Tecido Auto Garage', tagline: 'Auto Service & Repair',
    phone: '+974 4444 1234', email: 'service@tecidoqatar.com',
    address: 'Street 22, Industrial Area', city: 'Doha', country: 'Qatar',
    vatNumber: '', currency: 'QAR', website: 'www.tecidoqatar.com',
    invoiceTerms: 'Payment due on collection. All parts carry a 3-month warranty.',
  });

  // --- Financial accounts ---
  const cash = await post('finAccounts', { name: 'Cash in Hand', type: 'cash', accountNumber: '', openingBalance: 5000, description: 'Petty cash drawer', isActive: true, createdAt: daysAgo(120) });
  const bank = await post('finAccounts', { name: 'QNB Current Account', type: 'bank', accountNumber: '****4471', openingBalance: 25000, description: 'Qatar National Bank', isActive: true, createdAt: daysAgo(120) });

  // --- Technicians ---
  const T = {};
  for (const t of [
    { name: 'Rajesh Kumar',   phone: '+974 3355 1201', specialization: 'Engine & Transmission', status: 'available' },
    { name: 'Mohammed Ali',   phone: '+974 3355 1202', specialization: 'Electrical & AC',        status: 'busy' },
    { name: 'Abdul Rahman',   phone: '+974 3355 1203', specialization: 'General Mechanic',        status: 'available' },
    { name: 'Suresh Nair',    phone: '+974 3355 1204', specialization: 'Denting & Painting',      status: 'on_break' },
  ]) { const r = await post('technicians', { ...t, createdAt: daysAgo(90) }); T[t.name] = r.id; }

  // --- Service advisors ---
  const A = {};
  for (const a of [
    { name: 'Karim Hassan', phone: '+974 3366 2201', email: 'karim@tecidoqatar.com', status: 'available' },
    { name: 'Yusuf Ahmed',  phone: '+974 3366 2202', email: 'yusuf@tecidoqatar.com', status: 'available' },
  ]) { const r = await post('advisors', { ...a, createdAt: daysAgo(90) }); A[a.name] = r.id; }

  // --- Customers + their vehicles ---
  const spec = [
    { c: { name: 'Ahmed Al-Kuwari', phone: '+974 5511 3301', wa: '+974 5511 3301', email: 'ahmed.k@example.qa', address: 'Al Waab, Doha' },
      v: { registrationNo: '234567', make: 'Toyota', model: 'Land Cruiser', year: '2021', color: 'White',  mileage: '48200', fuelType: 'Petrol' } },
    { c: { name: 'Fatima Al-Thani', phone: '+974 5511 3302', wa: '', email: 'fatima.t@example.qa', address: 'West Bay, Doha' },
      v: { registrationNo: '445566', make: 'Nissan', model: 'Patrol', year: '2020', color: 'Black', mileage: '61050', fuelType: 'Petrol' } },
    { c: { name: 'John Mathew', phone: '+974 5511 3303', wa: '+974 5511 3303', email: 'john.m@example.qa', address: 'Al Sadd, Doha' },
      v: { registrationNo: '112233', make: 'Honda', model: 'Accord', year: '2019', color: 'Silver', mileage: '82400', fuelType: 'Petrol' } },
    { c: { name: 'Ravi Menon', phone: '+974 5511 3304', wa: '', email: 'ravi.m@example.qa', address: 'Al Gharrafa, Doha' },
      v: { registrationNo: '778899', make: 'Toyota', model: 'Camry', year: '2022', color: 'Grey', mileage: '31200', fuelType: 'Hybrid' } },
    { c: { name: 'Khalid Al-Sulaiti', phone: '+974 5511 3305', wa: '+974 5511 3305', email: 'khalid.s@example.qa', address: 'The Pearl, Doha' },
      v: { registrationNo: '990011', make: 'Lexus', model: 'LX570', year: '2023', color: 'Black', mileage: '18700', fuelType: 'Petrol' } },
    { c: { name: 'Priya Sharma', phone: '+974 5511 3306', wa: '', email: 'priya.s@example.qa', address: 'Umm Ghuwailina, Doha' },
      v: { registrationNo: '556677', make: 'Kia', model: 'Sportage', year: '2021', color: 'Red', mileage: '44100', fuelType: 'Petrol' } },
  ];
  const V = {}; // customerName -> {id, ...vehicle}
  const C = {};
  for (const s of spec) {
    const cr = await post('customers', { ...s.c, createdAt: daysAgo(80) });
    C[s.c.name] = cr.id;
    const vr = await post('vehicles', { ...s.v, notes: '', customerId: cr.id, customerName: s.c.name, createdAt: daysAgo(80) });
    V[s.c.name] = { id: vr.id, ...s.v };
  }

  // --- Job cards (varied statuses) ---
  const work = (description, technicianName, cost, status) => ({ id: Math.random().toString(36).slice(2, 9), description, technicianId: T[technicianName] || '', technicianName: technicianName || '', cost, status });
  const jcSpec = [
    { cust: 'Ahmed Al-Kuwari', advisor: 'Karim Hassan', dIn: daysAgo(2), status: 'in_progress', mileageIn: '48200',
      complaints: 'AC not cooling, due for routine service.',
      works: [ work('Oil & filter change', 'Rajesh Kumar', 350, 'done'), work('AC gas refill & leak check', 'Mohammed Ali', 250, 'in_progress') ] },
    { cust: 'Fatima Al-Thani', advisor: 'Yusuf Ahmed', dIn: daysAgo(1), status: 'pending', mileageIn: '61050',
      complaints: 'Brake noise from front wheels.',
      works: [ work('Front brake pads replacement', 'Abdul Rahman', 600, 'pending') ] },
    { cust: 'John Mathew', advisor: 'Karim Hassan', dIn: daysAgo(5), status: 'completed', mileageIn: '82400',
      complaints: 'Full service + pulling to one side.',
      works: [ work('Major service (40k km)', 'Rajesh Kumar', 450, 'done'), work('Wheel alignment', 'Abdul Rahman', 150, 'done') ] },
    { cust: 'Ravi Menon', advisor: 'Yusuf Ahmed', dIn: daysAgo(6), status: 'invoiced', mileageIn: '31200',
      complaints: 'Car not starting — suspect battery.',
      works: [ work('Battery replacement (70Ah)', 'Mohammed Ali', 400, 'done') ] },
    { cust: 'Khalid Al-Sulaiti', advisor: 'Karim Hassan', dIn: daysAgo(9), dOut: daysAgo(3), status: 'delivered', mileageIn: '18700',
      complaints: 'Rear door dent from parking.',
      works: [ work('Denting & painting — rear door', 'Suresh Nair', 1200, 'done') ] },
    { cust: 'Priya Sharma', advisor: 'Yusuf Ahmed', dIn: daysAgo(1), status: 'in_progress', mileageIn: '44100',
      complaints: 'Engine warning light + timing belt due.',
      works: [ work('Engine diagnostics', 'Rajesh Kumar', 200, 'done'), work('Timing belt replacement', 'Abdul Rahman', 800, 'in_progress') ] },
  ];
  const JC = {};
  for (const j of jcSpec) {
    const v = V[j.cust];
    const doc = {
      customerId: C[j.cust], customerName: j.cust,
      vehicleId: v.id, vehicleReg: v.registrationNo, vehicleMake: v.make, vehicleModel: v.model,
      dateIn: iso(j.dIn), dateOut: j.dOut ? iso(j.dOut) : '', mileageIn: j.mileageIn,
      advisorId: A[j.advisor] || '', advisorName: j.advisor,
      status: j.status, complaints: j.complaints, notes: '', works: j.works, complaintImages: [],
      createdAt: j.dIn,
    };
    const r = await post('jobCards', doc);
    JC[j.cust] = { id: r.id, ...doc };
  }

  // --- Invoices (completed/invoiced/delivered job cards) ---
  const invItems = (jc) => jc.works.map((w) => ({ description: w.description, cost: w.cost }));
  const invTotal = (jc) => jc.works.reduce((s, w) => s + w.cost, 0);
  async function invoiceFor(cust, { paid, method, accountId, accountName, paidDaysAgo }) {
    const jc = JC[cust];
    const total = invTotal(jc);
    const doc = {
      jobCardId: jc.id, jobNumber: '',
      customerId: jc.customerId, customerName: jc.customerName,
      vehicleId: jc.vehicleId, vehicleReg: jc.vehicleReg, vehicleMake: jc.vehicleMake, vehicleModel: jc.vehicleModel,
      items: invItems(jc), total,
      status: paid ? 'paid' : 'unpaid',
      totalPaid: paid ? total : 0,
      paymentType: paid ? method : '',
      payments: paid ? [{ method, amount: total, notes: '', paidAt: daysAgo(paidDaysAgo) }] : [],
      createdAt: daysAgo(paidDaysAgo + 0), source: 'job_card', paidAt: paid ? daysAgo(paidDaysAgo) : undefined,
    };
    const r = await post('invoices', doc);
    if (paid) {
      await post('transactions', {
        type: 'income', date: iso(daysAgo(paidDaysAgo)), amount: total,
        description: `Invoice payment — ${jc.customerName} (${jc.vehicleReg})`,
        category: 'Invoice Payment', paymentMethod: method,
        accountId, accountName, debitAccountId: accountId, debitAccountName: accountName,
        creditAccountId: '', creditAccountName: '',
        partyType: 'customer', partyId: jc.customerId, partyName: jc.customerName,
        reference: '', notes: '', createdAt: daysAgo(paidDaysAgo),
      });
    }
    return r;
  }
  await invoiceFor('Ravi Menon',       { paid: true,  method: 'cash',          accountId: cash.id, accountName: cash.name, paidDaysAgo: 5 });
  await invoiceFor('Khalid Al-Sulaiti',{ paid: true,  method: 'bank_transfer', accountId: bank.id, accountName: bank.name, paidDaysAgo: 3 });
  await invoiceFor('John Mathew',      { paid: false, method: '',              accountId: '',      accountName: '',        paidDaysAgo: 4 });

  // --- Standalone transactions (cash sale + operating expenses) ---
  const txns = [
    { type: 'income',  date: iso(daysAgo(1)),  amount: 300,  description: 'Cash sale — car wash & polish', category: 'Cash Sale',    method: 'cash', acc: cash },
    { type: 'expense', date: iso(daysAgo(10)), amount: 3000, description: 'Workshop rent — July',           category: 'Rent',         method: 'bank_transfer', acc: bank },
    { type: 'expense', date: iso(daysAgo(7)),  amount: 1500, description: 'Spare parts purchase',           category: 'Spare Parts',  method: 'cash', acc: cash },
    { type: 'expense', date: iso(daysAgo(4)),  amount: 400,  description: 'Electricity bill (Kahramaa)',    category: 'Utilities',    method: 'cash', acc: cash },
    { type: 'expense', date: iso(daysAgo(2)),  amount: 5000, description: 'Staff salaries — advance',       category: 'Salaries',     method: 'bank_transfer', acc: bank },
  ];
  for (const t of txns) {
    const isInc = t.type === 'income';
    await post('transactions', {
      type: t.type, date: t.date, amount: t.amount, description: t.description,
      category: t.category, paymentMethod: t.method,
      accountId: t.acc.id, accountName: t.acc.name,
      debitAccountId: isInc ? t.acc.id : '', debitAccountName: isInc ? t.acc.name : '',
      creditAccountId: isInc ? '' : t.acc.id, creditAccountName: isInc ? '' : t.acc.name,
      partyType: 'other', partyId: '', partyName: '', reference: '', notes: '',
      createdAt: now,
    });
  }

  // Summary
  const counts = {};
  for (const c of ['customers', 'vehicles', 'technicians', 'advisors', 'jobCards', 'invoices', 'transactions', 'finAccounts']) {
    counts[c] = (await api('GET', '/api/' + c)).length;
  }
  console.log('Done. Records:', counts);
}

main().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
