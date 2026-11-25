/**
 * Automated verification script for Phase 1A, Phase 1B, Phase 2, and Phase 3 gates
 * against a fresh disposable SQLite database.
 *
 * Run with:
 *   DB_PATH=data/test-gates.db npx tsx scripts/verify-all-gates.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';

// Ensure disposable DB path BEFORE importing db.ts
const testDbRel = process.env.DB_PATH || 'data/test-gates.db';
process.env.DB_PATH = testDbRel;
const absTestDb = path.resolve(process.cwd(), testDbRel);
for (const suffix of ['', '-wal', '-shm']) {
  const f = `${absTestDb}${suffix}`;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const { initDatabase, db } = await import('../src/server/db.ts');
const { createApiRouter } = await import('../src/server/routes.ts');
const { resolveStarterSlots } = await import('../src/shared/starterCatalog.ts');

initDatabase();

const app = express();
app.use(express.json());
app.use('/api', createApiRouter());

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const addr = server.address() as { port: number };
const baseUrl = `http://127.0.0.1:${addr.port}/api`;

async function req(
  method: string,
  p: string,
  opts: { token?: string; body?: unknown; opId?: string } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.opId) headers['X-Operation-Id'] = opts.opId;
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  [PASS] ${name}`);
}

try {
  console.log('Running Wholesale Billing System verification gates...\n');

  // GATE 0: Fresh install status & Disposable Trial bootstrap
  await check('Fresh install reports initialized=false and zero default staff', async () => {
    const r = await req('GET', '/auth/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.initialized, false);
    assert.equal(r.json.staff.length, 0);
  });

  await check('Disposable Trial bootstrap creates Owner/Manager/Employee and Phase 1A fixtures', async () => {
    const r = await req('POST', '/auth/bootstrap-trial', { body: {} });
    assert.equal(r.status, 201);
    assert.equal(r.json.staff.length, 3);

    const st = await req('GET', '/auth/status');
    assert.equal(st.json.initialized, true);
    assert.equal(st.json.trialMode, true);
    assert.equal(st.json.staff.length, 3);
  });

  // Sign in Owner, Manager, Employee
  let ownerToken = '';
  let managerToken = '';
  let empToken = '';

  await check('Owner, Manager, and Employee sign in via salted PINs', async () => {
    const o = await req('POST', '/auth/login', { body: { staffId: 'STF-OWNER', pin: '1234' } });
    assert.equal(o.status, 200);
    ownerToken = o.json.access_token;

    const m = await req('POST', '/auth/login', { body: { staffId: 'STF-MGR', pin: '2345' } });
    assert.equal(m.status, 200);
    managerToken = m.json.access_token;

    const e = await req('POST', '/auth/login', { body: { staffId: 'STF-EMP', pin: '3456' } });
    assert.equal(e.status, 200);
    empToken = e.json.access_token;
  });

  // PHASE 3 SECURITY GATE: Lockout after 5 failed attempts + Owner PIN reset clears lockout & revokes sessions
  await check('5 wrong PIN attempts trigger 423 DB lockout; Owner reset clears lockout & revokes active session', async () => {
    const newStaff = await req('POST', '/staff', {
      token: ownerToken,
      body: { name: 'Test Clerk', role: 'employee', pin: '9999' },
    });
    assert.equal(newStaff.status, 201);
    const tid = newStaff.json.id;

    // Login once to create an active session
    const activeLogin = await req('POST', '/auth/login', { body: { staffId: tid, pin: '9999' } });
    assert.equal(activeLogin.status, 200);
    const clerkToken = activeLogin.json.access_token;

    // 5 failed attempts -> 5th locks account
    for (let i = 1; i <= 4; i++) {
      const fail = await req('POST', '/auth/login', { body: { staffId: tid, pin: '0000' } });
      assert.equal(fail.status, 401);
    }
    const fifth = await req('POST', '/auth/login', { body: { staffId: tid, pin: '0000' } });
    assert.equal(fifth.status, 423);

    // Even right PIN rejected while locked
    const whileLocked = await req('POST', '/auth/login', { body: { staffId: tid, pin: '9999' } });
    assert.equal(whileLocked.status, 423);

    // Owner resets PIN -> revokes old clerkToken & unlocks account
    const reset = await req('POST', `/staff/${tid}/reset-pin`, {
      token: ownerToken,
      body: { pin: '8888' },
    });
    assert.equal(reset.status, 200);

    const revokedCheck = await req('GET', '/auth/me', { token: clerkToken });
    assert.equal(revokedCheck.status, 401);

    const newLogin = await req('POST', '/auth/login', { body: { staffId: tid, pin: '8888' } });
    assert.equal(newLogin.status, 200);
  });

  // PHASE 1A & SECURITY GATE: Employee cost/profit stripping + 20L never binds to 19L
  await check('Employee API responses strictly omit buying_price, batch costs, and profit', async () => {
    const prodEmp = await req('GET', '/products/list?include_meta=true', { token: empToken });
    assert.equal(prodEmp.status, 200);
    for (const p of prodEmp.json.products) {
      assert.equal('buying_price' in p, false, 'Employee must never receive buying_price');
    }

    const batchesEmp = await req('GET', '/stock/batches?type_id=PRD-19L-FILLED', { token: empToken });
    assert.equal(batchesEmp.status, 200);
    for (const b of batchesEmp.json) {
      assert.equal('buying_price' in b, false, 'Employee must never receive batch buying_price');
    }

    const dashEmp = await req('GET', '/dashboard/today', { token: empToken });
    assert.equal(dashEmp.status, 200);
    assert.equal('profit' in dashEmp.json, false, 'Employee dashboard must omit profit');

    const repEmp = await req('GET', '/reports/summary?period=today', { token: empToken });
    assert.equal(repEmp.status, 403, 'Employee must get 403 on financial summary');

    // Employee sees only own invoices (0 initially since trial invoice was created by Manager)
    const invEmp = await req('GET', '/invoices/list', { token: empToken });
    assert.equal(invEmp.status, 200);
    assert.equal(invEmp.json.length, 0);
  });

  await check('Phase 1A: 20L Can never binds to 19L starter slot (resolver + server guard)', async () => {
    const prodMgr = await req('GET', '/products/list?include_meta=true', { token: managerToken });
    assert.equal(prodMgr.status, 200);

    // Server must reject binding PRD-20L-PREM to 19L_FILLED or 19L_EMPTY
    const badBind = await req('POST', '/stock/resolve-slot', {
      token: managerToken,
      body: { slot_key: '19L_FILLED', action: 'bind_as_is', product_type_id: 'PRD-20L-PREM' },
    });
    assert.equal(badBind.status, 400);

    // Verify resolveStarterSlots keeps PRD-20L-PREM in otherActiveProducts and 1.5L / 5L missing
    const variants = prodMgr.json.all_products.map((p: any) => ({
      typeId: p.type_id,
      sku: p.sku,
      nameEn: p.name,
      nameTa: p.ta,
      soldBy: p.unit,
      sellingPriceCents: p.price !== null ? Math.round(p.price * 100) : null,
      defaultBuyingCostCents: p.buying_price !== null ? Math.round(p.buying_price * 100) : null,
      isReturnable: p.is_returnable,
      stockQty: p.stock,
      lowStockThreshold: p.low_stock_limit,
      usedEmptiesCount: p.used_empties_count,
      damagedEmptiesCount: p.damaged_empties_count,
      isArchived: !p.is_active,
      createdAt: '',
      updatedAt: '',
    }));
    const resolved = resolveStarterSlots(variants, []);
    const slot15 = resolved.slots.find((s) => s.definition.slotKey === '1.5L');
    const slot5 = resolved.slots.find((s) => s.definition.slotKey === '5L');
    const slot19 = resolved.slots.find((s) => s.definition.slotKey === '19L_FILLED');
    assert.equal(slot15?.status, 'missing');
    assert.equal(slot5?.status, 'missing');
    assert.equal(slot19?.variant?.typeId, 'PRD-19L-FILLED');
    assert.ok(resolved.otherActiveProducts.some((v) => v.typeId === 'PRD-20L-PREM'));
  });

  await check('Phase 1A: Updating default buying cost never rewrites past batches', async () => {
    const beforeBatches = await req('GET', '/stock/batches?type_id=PRD-500ML', { token: ownerToken });
    const originalCost = beforeBatches.json[0].buying_price;
    assert.equal(originalCost, 48);

    const upd = await req('POST', '/products/update', {
      token: ownerToken,
      body: { type_id: 'PRD-500ML', buying_price: 55 },
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.json.buying_price, 55);

    const afterBatches = await req('GET', '/stock/batches?type_id=PRD-500ML', { token: ownerToken });
    assert.equal(afterBatches.json[0].buying_price, 48, 'Existing batch cost must remain 48');
  });

  // PHASE 1B GATE: Rs. 1,700 invoice + Rs. 2,000 Cash + Rs. 500 prior debt + Bank excess block + Idempotency
  let empInvoiceNum = '';
  let empInvoiceId = '';

  await check('Phase 1B: Rs. 1,700 bill + Rs. 2,000 Cash + Rs. 500 prior debt (applyToOldDebt=true) + Idempotent Replay', async () => {
    // CUST-001 has Rs. 500 prior debt; PRD-19L-FILLED is Rs. 425 -> 4 cans = Rs. 1,700
    const opId = 'OP-GATE-1B-CASH-001';
    const body = {
      customer_id: 'CUST-001',
      items: [{ type_id: 'PRD-19L-FILLED', quantity: 4 }],
      payment_type: 'custom',
      payment_method: 'cash',
      discount: 0,
      cash_received: 2000,
      apply_to_old_debt: true,
      expected_previous_balance: 500,
    };

    const r1 = await req('POST', '/sales/create', { token: empToken, body, opId });
    assert.equal(r1.status, 201);
    assert.equal(r1.json.receipt.total, 1700);
    assert.equal(r1.json.receipt.applied_to_bill, 1700);
    assert.equal(r1.json.receipt.applied_to_old_debt, 300);
    assert.equal(r1.json.receipt.change_returned, 0);
    assert.equal(r1.json.new_balance, 200);
    assert.equal(r1.json.new_cans_balance, 12); // 6+2=8 prior + 4 issued = 12
    empInvoiceNum = r1.json.receipt.invoice_number;
    empInvoiceId = r1.json.receipt.sale_id;

    // Replay same X-Operation-Id -> returns identical receipt without double charging
    const r2 = await req('POST', '/sales/create', { token: empToken, body, opId });
    assert.equal(r2.status, 201);
    assert.equal(r2.json.receipt.invoice_number, empInvoiceNum);

    const cust = await req('GET', '/customers/details/CUST-001', { token: empToken });
    assert.equal(cust.json.balance, 200, 'Idempotent replay must not double-apply debt payment');
  });

  await check('Phase 1B: Bank Transfer exceeding invoice total + prior debt is strictly blocked (400)', async () => {
    // CUST-002 has Rs. 100 prior debt. 4 x PRD-19L-FILLED = Rs. 1,700 -> max allowed bank = Rs. 1,800
    const badBank = await req('POST', '/sales/create', {
      token: managerToken,
      body: {
        customer_id: 'CUST-002',
        items: [{ type_id: 'PRD-19L-FILLED', quantity: 4 }],
        payment_type: 'custom',
        payment_method: 'bank',
        cash_received: 2000,
        apply_to_old_debt: true,
        expected_previous_balance: 100,
      },
    });
    assert.equal(badBank.status, 400);
    assert.equal(badBank.json.code, 'bank_excess_blocked');
  });

  // PHASE 2 GATE: Returned empties separate used/damaged & NEVER increment sellable stock; Customer archive block
  await check('Phase 2: Returning 2 used + 1 damaged empties updates empties counts & NEVER increments sellable stock', async () => {
    const beforeProd = (await req('GET', '/products/list', { token: managerToken })).json.products.find(
      (p: any) => p.type_id === 'PRD-19L-FILLED',
    );
    const beforeStock = beforeProd.stock;
    const beforeUsed = beforeProd.used_empties_count;
    const beforeDmg = beforeProd.damaged_empties_count;

    const ret = await req('POST', '/containers/movement', {
      token: managerToken,
      body: {
        customer_id: 'CUST-001',
        type_id: 'PRD-19L-FILLED',
        quantity: 2,
        damaged_quantity: 1,
      },
      opId: 'OP-GATE-2-CANS-001',
    });
    assert.equal(ret.status, 200);
    assert.equal(ret.json.held, 9); // 12 - 3 = 9

    const afterProd = (await req('GET', '/products/list', { token: managerToken })).json.products.find(
      (p: any) => p.type_id === 'PRD-19L-FILLED',
    );
    assert.equal(afterProd.stock, beforeStock, 'Sellable stock must NEVER increase on returned empties');
    assert.equal(afterProd.used_empties_count, beforeUsed + 2);
    assert.equal(afterProd.damaged_empties_count, beforeDmg + 1);
  });

  await check('Phase 2: Archiving customer with debt or held cans is strictly blocked (400)', async () => {
    const blocked = await req('POST', '/customers/archive', {
      token: managerToken,
      body: { customer_id: 'CUST-001', action: 'archive' },
    });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.json.code, 'archive_blocked_non_zero');
  });

  await check('Phase 2: Payments accept Cash/Bank only, one-time reversal enforced, paid invoice cancel blocked', async () => {
    const badMethod = await req('POST', '/payments/receive', {
      token: managerToken,
      body: { customer_id: 'CUST-001', amount: 100, payment_method: 'cheque' },
    });
    assert.equal(badMethod.status, 400);

    const pay = await req('POST', '/payments/receive', {
      token: managerToken,
      body: { customer_id: 'CUST-001', amount: 100, payment_method: 'bank', notes: 'Bank ref #11' },
      opId: 'OP-GATE-2-PAY-001',
    });
    assert.equal(pay.status, 201);
    const payId = pay.json.payment_id;

    // Reverse once -> succeeds
    const rev1 = await req('POST', '/payments/void', {
      token: managerToken,
      body: { payment_id: payId, reason: 'Wrong amount entered' },
    });
    assert.equal(rev1.status, 200);

    // Reverse second time -> blocked 409
    const rev2 = await req('POST', '/payments/void', {
      token: managerToken,
      body: { payment_id: payId, reason: 'Duplicate attempt' },
    });
    assert.equal(rev2.status, 409);

    // Paid invoice cancel -> strictly blocked 400
    const cancelPaid = await req('POST', '/sales/cancel', {
      token: managerToken,
      body: { sale_id: empInvoiceId, reason: 'Attempt cancel paid bill' },
    });
    assert.equal(cancelPaid.status, 400);
    assert.equal(cancelPaid.json.code, 'paid_invoice_cancel_blocked');
  });

  await check('Phase 2: Proportional discounted goods return credits customer account without over-crediting', async () => {
    // Sell 10 x PRD-500ML (Rs. 70 each = Rs. 700 subtotal) with Rs. 140 discount (20% off -> Rs. 560 total) on credit
    const sale = await req('POST', '/sales/create', {
      token: managerToken,
      body: {
        customer_id: 'CUST-003',
        items: [{ type_id: 'PRD-500ML', quantity: 10 }],
        payment_type: 'credit',
        payment_method: 'cash',
        discount: 140,
        cash_received: 0,
      },
    });
    assert.equal(sale.status, 201);
    assert.equal(sale.json.receipt.total, 560);

    // Return 2 bottles -> proportional credit must be Rs. 112 (NOT Rs. 140!)
    const ret = await req('POST', '/sales/return-item', {
      token: managerToken,
      body: {
        invoice_id: sale.json.receipt.sale_id,
        sale_item_id: 'PRD-500ML',
        quantity: 2,
        reason: 'Damaged seal',
        restock: false,
      },
    });
    assert.equal(ret.status, 200);
    assert.equal(ret.json.credit_amount, 112, 'Proportional discounted return must credit Rs. 112, not Rs. 140');
  });

  await check('Phase 3: Signed unclamped negative gross profit + immutable audit_log SQLite triggers', async () => {
    // Sell 20 x PRD-500ML (buying cost Rs. 48 each -> Rs. 960 cost) with huge discount making invoice Rs. 200 -> loss of Rs. -760
    // Create a clean custom date or sell heavily discounted so today's gross profit drops negative
    const heavyLoss = await req('POST', '/sales/create', {
      token: ownerToken,
      body: {
        customer_id: 'CUST-003',
        items: [{ type_id: 'PRD-500ML', quantity: 50 }], // 50*70 = 3500; cost = 50*48 = 2400
        payment_type: 'credit',
        payment_method: 'cash',
        discount: 3400, // net = 100 -> -2300 loss, pulling day profit clearly negative!
        cash_received: 0,
      },
    });
    assert.equal(heavyLoss.status, 201);

    const summary = await req('GET', '/reports/summary?period=today', { token: ownerToken });
    assert.equal(summary.status, 200);
    assert.ok(summary.json.profit < 0, `Expected negative signed gross profit, got ${summary.json.profit}`);

    // Employee trying to read Manager's invoice details gets 403
    const forbiddenInv = await req('GET', `/invoices/details/${heavyLoss.json.receipt.invoice_number}`, {
      token: empToken,
    });
    assert.equal(forbiddenInv.status, 403);

    // Employee reading OWN invoice details succeeds and never contains internal costs
    const ownInv = await req('GET', `/invoices/details/${empInvoiceNum}`, { token: empToken });
    assert.equal(ownInv.status, 200);
    assert.equal(JSON.stringify(ownInv.json).includes('internalUnitCostCents'), false);

    // Immutable audit_log trigger check
    let updateBlocked = false;
    try {
      db.prepare(`UPDATE audit_log SET reason = 'tampered'`).run();
    } catch {
      updateBlocked = true;
    }
    assert.equal(updateBlocked, true, 'audit_log UPDATE must be aborted by SQLite trigger');

    let deleteBlocked = false;
    try {
      db.prepare(`DELETE FROM audit_log`).run();
    } catch {
      deleteBlocked = true;
    }
    assert.equal(deleteBlocked, true, 'audit_log DELETE must be aborted by SQLite trigger');
  });

  console.log(`\nALL ${passed} VERIFICATION GATES PASSED!`);
} finally {
  server.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${absTestDb}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}
