import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getColomboBusinessDate, getColomboTimestamp } from '../shared/colomboTime.ts';
import type {
  AuditLogEntry,
  Customer,
  CustomerCanHolding,
  InvoiceRecord,
  InvoiceSnapshot,
  ProductVariant,
  ShopDetails,
  StaffMember,
  StaffRole,
  StarterSlotBinding,
  StarterSlotKey,
  StockBatch,
} from '../shared/types.ts';

const DB_FILE = process.env.DB_PATH
  ? path.resolve(process.cwd(), process.env.DB_PATH)
  : path.resolve(process.cwd(), 'data', 'wholesale-billing.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ta TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL CHECK(role IN ('owner', 'manager', 'employee')),
      pin_salt TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      last_seen_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shop_details (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      name_en TEXT NOT NULL DEFAULT '',
      name_ta TEXT NOT NULL DEFAULT '',
      address_en TEXT NOT NULL DEFAULT '',
      address_ta TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      tax_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      type_id TEXT PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name_en TEXT NOT NULL,
      name_ta TEXT NOT NULL DEFAULT '',
      sold_by TEXT NOT NULL CHECK(sold_by IN ('bottle', 'can', 'case', 'pack', 'unit')),
      selling_price_cents INTEGER,
      default_buying_cost_cents INTEGER,
      is_returnable INTEGER NOT NULL DEFAULT 0,
      stock_qty INTEGER NOT NULL DEFAULT 0,
      low_stock_threshold INTEGER NOT NULL DEFAULT 10,
      used_empties_count INTEGER,
      damaged_empties_count INTEGER,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS starter_slot_bindings (
      slot_key TEXT PRIMARY KEY,
      product_type_id TEXT REFERENCES products(type_id),
      excluded_type_ids_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_batches (
      id TEXT PRIMARY KEY,
      batch_number INTEGER NOT NULL DEFAULT 1,
      product_type_id TEXT NOT NULL REFERENCES products(type_id),
      received_qty INTEGER NOT NULL,
      remaining_qty INTEGER NOT NULL,
      buying_cost_cents INTEGER NOT NULL,
      selling_price_cents INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by_id TEXT REFERENCES staff(id),
      created_by_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      product_type_id TEXT NOT NULL REFERENCES products(type_id),
      batch_id TEXT REFERENCES stock_batches(id),
      batch_number INTEGER NOT NULL DEFAULT 0,
      movement_type TEXT NOT NULL,
      quantity_change INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      staff_id TEXT REFERENCES staff(id),
      staff_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ta TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      balance_cents INTEGER NOT NULL DEFAULT 0,
      credit_limit_cents INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_can_holdings (
      customer_id TEXT NOT NULL REFERENCES customers(id),
      product_type_id TEXT NOT NULL REFERENCES products(type_id),
      qty_held INTEGER NOT NULL DEFAULT 0 CHECK(qty_held >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (customer_id, product_type_id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      invoice_number TEXT NOT NULL UNIQUE,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      staff_id TEXT NOT NULL REFERENCES staff(id),
      staff_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'canceled')),
      cancel_reason TEXT,
      canceled_at TEXT,
      business_date_colombo TEXT NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      discount_cents INTEGER NOT NULL,
      invoice_total_cents INTEGER NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'bank_transfer')),
      tendered_cents INTEGER NOT NULL,
      invoice_paid_cents INTEGER NOT NULL,
      old_debt_applied_cents INTEGER NOT NULL,
      change_cents INTEGER NOT NULL,
      invoice_due_cents INTEGER NOT NULL,
      total_internal_cost_cents INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goods_returns (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES invoices(id),
      customer_id TEXT NOT NULL REFERENCES customers(id),
      product_type_id TEXT NOT NULL REFERENCES products(type_id),
      qty_returned INTEGER NOT NULL CHECK(qty_returned > 0),
      credit_cents INTEGER NOT NULL CHECK(credit_cents >= 0),
      cost_reversed_cents INTEGER NOT NULL DEFAULT 0,
      restocked INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      staff_id TEXT NOT NULL REFERENCES staff(id),
      staff_name TEXT NOT NULL,
      business_date_colombo TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      invoice_id TEXT REFERENCES invoices(id),
      amount_cents INTEGER NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('cash', 'bank_transfer')),
      kind TEXT NOT NULL CHECK(kind IN ('invoice_payment', 'old_debt_collection', 'reversal', 'replacement')),
      note TEXT NOT NULL DEFAULT '',
      reversed_payment_id TEXT REFERENCES payments(id),
      staff_id TEXT NOT NULL REFERENCES staff(id),
      staff_name TEXT NOT NULL,
      business_date_colombo TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS can_movements (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      product_type_id TEXT NOT NULL REFERENCES products(type_id),
      movement_type TEXT NOT NULL CHECK(movement_type IN ('issued', 'returned_used', 'returned_damaged')),
      qty INTEGER NOT NULL CHECK(qty > 0),
      invoice_id TEXT REFERENCES invoices(id),
      note TEXT NOT NULL DEFAULT '',
      staff_id TEXT NOT NULL REFERENCES staff(id),
      staff_name TEXT NOT NULL,
      business_date_colombo TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      operation_id TEXT PRIMARY KEY,
      staff_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      actor_id TEXT,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      reason TEXT
    );

    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'Audit log records are immutable and cannot be updated');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'Audit log records are immutable and cannot be deleted');
    END;
  `);

  db.prepare(`INSERT OR IGNORE INTO shop_details (id) VALUES (1)`).run();

  // Safe idempotent column additions for pre-existing local SQLite databases
  const safeAlter = (sql: string) => {
    try {
      db.exec(sql);
    } catch {
      // Column already exists
    }
  };
  safeAlter(`ALTER TABLE stock_batches ADD COLUMN batch_number INTEGER NOT NULL DEFAULT 1`);
  safeAlter(`ALTER TABLE stock_batches ADD COLUMN selling_price_cents INTEGER NOT NULL DEFAULT 0`);
  safeAlter(`ALTER TABLE customers ADD COLUMN credit_limit_cents INTEGER NOT NULL DEFAULT 0`);
}

export function getNextBatchNumber(productTypeId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(batch_number), 0) AS max_num FROM stock_batches WHERE product_type_id = ?`)
    .get(productTypeId) as { max_num: number };
  return Number(row?.max_num ?? 0) + 1;
}

export function recordStockMovement(entry: {
  productTypeId: string;
  batchId?: string | null;
  batchNumber?: number;
  movementType: string;
  quantityChange: number;
  note?: string;
  staffId?: string | null;
  staffName: string;
}): void {
  const id = `MOV-${crypto.randomUUID().slice(0, 10).toUpperCase()}`;
  const now = getColomboTimestamp();
  db.prepare(
    `INSERT INTO stock_movements (id, product_type_id, batch_id, batch_number, movement_type, quantity_change, note, staff_id, staff_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    entry.productTypeId,
    entry.batchId ?? null,
    entry.batchNumber ?? 0,
    entry.movementType,
    entry.quantityChange,
    entry.note ?? '',
    entry.staffId ?? null,
    entry.staffName,
    now
  );
}

export function hashPin(pin: string, salt?: string): { salt: string; hash: string } {
  const actualSalt = salt ?? crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, actualSalt, 64).toString('hex');
  return { salt: actualSalt, hash };
}

export function verifyPin(pin: string, salt: string, storedHash: string): boolean {
  const derived = crypto.scryptSync(pin, salt, 64);
  const stored = Buffer.from(storedHash, 'hex');
  if (derived.length !== stored.length) return false;
  return crypto.timingSafeEqual(derived, stored);
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function hashPayload(obj: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

export function withTransaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failure if already rolled back
    }
    throw err;
  }
}

export function writeAuditLog(entry: {
  actorId: string | null;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}): void {
  const id = `AUD-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const createdAt = getColomboTimestamp();
  db.prepare(
    `INSERT INTO audit_log (id, created_at, actor_id, actor_name, actor_role, action, entity_type, entity_id, before_json, after_json, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    createdAt,
    entry.actorId,
    entry.actorName,
    entry.actorRole,
    entry.action,
    entry.entityType,
    entry.entityId,
    entry.before !== undefined ? JSON.stringify(entry.before) : null,
    entry.after !== undefined ? JSON.stringify(entry.after) : null,
    entry.reason ?? null
  );
}

export function isTrialModeActive(): boolean {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'trial_mode'`).get() as
    | { value: string }
    | undefined;
  return row?.value === '1';
}

export function mapStaffRow(row: Record<string, unknown>): StaffMember {
  const lockedUntilMs =
    typeof row.locked_until_ms === 'number' ? row.locked_until_ms : null;
  const isLocked = lockedUntilMs !== null && lockedUntilMs > Date.now();
  return {
    id: String(row.id),
    name: String(row.name),
    nameTa: String(row.name_ta ?? ''),
    role: row.role as StaffRole,
    isActive: Number(row.is_active) === 1,
    isLocked,
    lockedUntilMs: isLocked ? lockedUntilMs : null,
    createdAt: String(row.created_at),
  };
}

export function mapProductRow(
  row: Record<string, unknown>,
  includeCosts: boolean
): ProductVariant {
  const base: ProductVariant = {
    typeId: String(row.type_id),
    sku: String(row.sku),
    nameEn: String(row.name_en),
    nameTa: String(row.name_ta ?? ''),
    soldBy: row.sold_by as ProductVariant['soldBy'],
    sellingPriceCents:
      row.selling_price_cents === null || row.selling_price_cents === undefined
        ? null
        : Number(row.selling_price_cents),
    isReturnable: Number(row.is_returnable) === 1,
    stockQty: Number(row.stock_qty),
    lowStockThreshold: Number(row.low_stock_threshold ?? 10),
    usedEmptiesCount:
      row.used_empties_count === null || row.used_empties_count === undefined
        ? null
        : Number(row.used_empties_count),
    damagedEmptiesCount:
      row.damaged_empties_count === null || row.damaged_empties_count === undefined
        ? null
        : Number(row.damaged_empties_count),
    isArchived: Number(row.is_archived) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  if (includeCosts) {
    base.defaultBuyingCostCents =
      row.default_buying_cost_cents === null || row.default_buying_cost_cents === undefined
        ? null
        : Number(row.default_buying_cost_cents);
  }
  return base;
}

export function mapBatchRow(
  row: Record<string, unknown>,
  includeCosts: boolean
): StockBatch {
  const b: StockBatch = {
    id: String(row.id),
    productTypeId: String(row.product_type_id),
    receivedQty: Number(row.received_qty),
    remainingQty: Number(row.remaining_qty),
    note: String(row.note ?? ''),
    createdByName: String(row.created_by_name),
    createdAt: String(row.created_at),
  };
  if (includeCosts) {
    b.buyingCostCents = Number(row.buying_cost_cents);
  }
  return b;
}

export function getShopDetails(): ShopDetails {
  const row = db.prepare(`SELECT * FROM shop_details WHERE id = 1`).get() as
    | Record<string, unknown>
    | undefined;
  return {
    nameEn: String(row?.name_en ?? ''),
    nameTa: String(row?.name_ta ?? ''),
    addressEn: String(row?.address_en ?? ''),
    addressTa: String(row?.address_ta ?? ''),
    phone: String(row?.phone ?? ''),
    taxId: String(row?.tax_id ?? ''),
    updatedAt: row?.updated_at ? String(row.updated_at) : null,
  };
}

export function getStarterBindings(): StarterSlotBinding[] {
  const rows = db.prepare(`SELECT * FROM starter_slot_bindings`).all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    slotKey: r.slot_key as StarterSlotKey,
    productTypeId: r.product_type_id ? String(r.product_type_id) : null,
    excludedTypeIds: JSON.parse(String(r.excluded_type_ids_json ?? '[]')),
  }));
}

export function getCustomerWithHoldings(customerId: string): Customer | null {
  const row = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const holdingsRows = db
    .prepare(
      `SELECT h.product_type_id, h.qty_held, p.name_en, p.name_ta, p.sku
       FROM customer_can_holdings h
       JOIN products p ON p.type_id = h.product_type_id
       WHERE h.customer_id = ? AND h.qty_held > 0
       ORDER BY p.name_en ASC`
    )
    .all(customerId) as Array<Record<string, unknown>>;

  const cansHeld: CustomerCanHolding[] = holdingsRows.map((h) => ({
    productTypeId: String(h.product_type_id),
    productNameEn: String(h.name_en),
    productNameTa: String(h.name_ta ?? ''),
    sku: String(h.sku),
    qtyHeld: Number(h.qty_held),
  }));

  return {
    id: String(row.id),
    name: String(row.name),
    nameTa: String(row.name_ta ?? ''),
    phone: String(row.phone ?? ''),
    address: String(row.address ?? ''),
    balanceCents: Number(row.balance_cents),
    isArchived: Number(row.is_archived) === 1,
    cansHeld,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function stripSnapshotCosts(snapshot: InvoiceSnapshot): InvoiceSnapshot {
  return {
    ...snapshot,
    lines: snapshot.lines.map((line) => {
      const { internalUnitCostCents: _u, internalLineCostCents: _l, ...clean } = line;
      return clean;
    }),
  };
}

export function mapInvoiceRow(
  row: Record<string, unknown>,
  includeInternalCosts: boolean
): InvoiceRecord {
  const rawSnapshot = JSON.parse(String(row.snapshot_json)) as InvoiceSnapshot;
  const snapshot = includeInternalCosts ? rawSnapshot : stripSnapshotCosts(rawSnapshot);
  const returnsRows = db
    .prepare(
      `SELECT product_type_id, qty_returned, credit_cents, restocked, reason, created_at
       FROM goods_returns WHERE invoice_id = ? ORDER BY created_at ASC`
    )
    .all(String(row.id)) as Array<Record<string, unknown>>;

  return {
    id: String(row.id),
    invoiceNumber: String(row.invoice_number),
    customerId: String(row.customer_id),
    staffId: String(row.staff_id),
    staffName: String(row.staff_name),
    status: row.status as 'active' | 'canceled',
    cancelReason: row.cancel_reason ? String(row.cancel_reason) : null,
    canceledAt: row.canceled_at ? String(row.canceled_at) : null,
    businessDateColombo: String(row.business_date_colombo),
    createdAt: String(row.created_at),
    snapshot,
    returnedLines: returnsRows.map((r) => ({
      productTypeId: String(r.product_type_id),
      qtyReturned: Number(r.qty_returned),
      creditCents: Number(r.credit_cents),
      restocked: Number(r.restocked) === 1,
      reason: String(r.reason),
      createdAt: String(r.created_at),
    })),
  };
}

export function generateNextInvoiceNumber(businessDate: string): string {
  const compactDate = businessDate.replace(/-/g, '');
  const prefix = `INV-${compactDate}-`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM invoices WHERE invoice_number LIKE ?`
    )
    .get(`${prefix}%`) as { cnt: number };
  const seq = Number(row.cnt) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

export function mapAuditRow(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    actorId: row.actor_id ? String(row.actor_id) : null,
    actorName: String(row.actor_name),
    actorRole: String(row.actor_role),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    beforeJson: row.before_json ? String(row.before_json) : null,
    afterJson: row.after_json ? String(row.after_json) : null,
    reason: row.reason ? String(row.reason) : null,
  };
}

/**
 * Seeds a realistic synthetic Sri Lankan disposable trial shop scenario
 * ONLY when explicitly triggered by the user from First-Run Setup.
 * Includes Phase 1A gate test scenarios:
 * - Missing 1.5 L and 5 L starter cards (for Set up testing)
 * - Premium 20L Can (New) [SKU-CAN-20L] (verifies 20L never binds to 19L)
 * - Extra products (case SKU + special SKU) under collapsed Other Products
 * - Bilingual EN/TA customers with prior debt and held cans
 */
export function seedDisposableTrialScenario(): {
  staff: Array<{ name: string; role: StaffRole; pin: string }>;
} {
  return withTransaction(() => {
    const existingCount = (
      db.prepare(`SELECT COUNT(*) AS cnt FROM staff`).get() as { cnt: number }
    ).cnt;
    if (existingCount > 0) {
      throw new Error('Shop is already initialized.');
    }

    const now = getColomboTimestamp();
    const today = getColomboBusinessDate();

    db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('trial_mode', '1')`).run();

    // Shop details
    db.prepare(
      `UPDATE shop_details
       SET name_en = ?, name_ta = ?, address_en = ?, address_ta = ?, phone = ?, tax_id = ?, updated_at = ?
       WHERE id = 1`
    ).run(
      'Lanka Pure Springs Wholesale',
      'லங்கா பியூர் ஸ்பிரிங்ஸ் மொத்த விற்பனை',
      'No. 42, Kandy Road, Jaffna',
      'இல. 42, கண்டி வீதி, யாழ்ப்பாணம்',
      '021-222-4810',
      'VAT-LK-204819',
      now
    );

    // 3 Staff Accounts (Owner, Manager, Employee)
    const staffSeed: Array<{
      id: string;
      name: string;
      nameTa: string;
      role: StaffRole;
      pin: string;
    }> = [
      { id: 'STF-OWNER', name: 'Suresh Nathan', nameTa: 'சுரேஷ் நாதன்', role: 'owner', pin: '1234' },
      { id: 'STF-MGR', name: 'Kavitha Selvam', nameTa: 'கவிதா செல்வம்', role: 'manager', pin: '2345' },
      { id: 'STF-EMP', name: 'Rajan Kumar', nameTa: 'ராஜன் குமார்', role: 'employee', pin: '3456' },
    ];

    for (const s of staffSeed) {
      const { salt, hash } = hashPin(s.pin);
      db.prepare(
        `INSERT INTO staff (id, name, name_ta, role, pin_salt, pin_hash, is_active, failed_attempts, locked_until_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)`
      ).run(s.id, s.name, s.nameTa, s.role, salt, hash, now, now);
    }

    // Products: 4 of 6 starter slots present (1.5 L and 5 L intentionally missing for Set up testing!),
    // plus Premium 20L Can (New) and 500 ml Case (24) in Other Products.
    const productSeed = [
      {
        typeId: 'PRD-500ML',
        sku: 'SKU-500ML',
        nameEn: '500 ml Water',
        nameTa: '500 மி.லி தண்ணீர்',
        soldBy: 'bottle',
        sellingPriceCents: 7000, // Rs. 70.00
        buyingCostCents: 4800,
        isReturnable: 0,
        stockQty: 180,
        lowStockThreshold: 24,
        usedEmpties: null,
        damagedEmpties: null,
      },
      {
        typeId: 'PRD-1L',
        sku: 'SKU-1L',
        nameEn: '1 L Water',
        nameTa: '1 லிட்டர் தண்ணீர்',
        soldBy: 'bottle',
        sellingPriceCents: 11000, // Rs. 110.00
        buyingCostCents: 7500,
        isReturnable: 0,
        stockQty: 8, // Low stock!
        lowStockThreshold: 15,
        usedEmpties: null,
        damagedEmpties: null,
      },
      {
        typeId: 'PRD-19L-FILLED',
        sku: 'SKU-19L',
        nameEn: '19 L Filled',
        nameTa: '19 லிட்டர் நிரப்பிய கேன்',
        soldBy: 'can',
        sellingPriceCents: 42500, // Rs. 425.00 (4 cans = Rs. 1,700.00!)
        buyingCostCents: 26000,
        isReturnable: 1,
        stockQty: 45,
        lowStockThreshold: 12,
        usedEmpties: 18,
        damagedEmpties: 2,
      },
      {
        typeId: 'PRD-19L-EMPTY',
        sku: 'SKU-19L-EMPTY',
        nameEn: '19 L Empty Can',
        nameTa: '19 லிட்டர் காலி கேன்',
        soldBy: 'can',
        sellingPriceCents: 180000, // Rs. 1,800.00
        buyingCostCents: 135000,
        isReturnable: 0,
        stockQty: 0, // Out of stock! Appears before Low Stock in Needs Attention Today
        lowStockThreshold: 5,
        usedEmpties: null,
        damagedEmpties: null,
      },
      {
        typeId: 'PRD-20L-PREM',
        sku: 'SKU-CAN-20L',
        nameEn: 'Premium 20L Can (New)',
        nameTa: 'பிரீமியம் 20 லிட்டர் கேன் (புதியது)',
        soldBy: 'can',
        sellingPriceCents: 52000, // Rs. 520.00
        buyingCostCents: 34000,
        isReturnable: 1,
        stockQty: 20,
        lowStockThreshold: 5,
        usedEmpties: null, // Shows "Not counted"
        damagedEmpties: null,
      },
      {
        typeId: 'PRD-500ML-CASE',
        sku: 'SKU-500ML-CASE24',
        nameEn: '500 ml Case (24 Bottles)',
        nameTa: '500 மி.லி பெட்டி (24 பாட்டில்கள்)',
        soldBy: 'case',
        sellingPriceCents: 156000, // Rs. 1,560.00
        buyingCostCents: 112000,
        isReturnable: 0,
        stockQty: 30,
        lowStockThreshold: 8,
        usedEmpties: null,
        damagedEmpties: null,
      },
    ];

    for (const p of productSeed) {
      db.prepare(
        `INSERT INTO products (
          type_id, sku, name_en, name_ta, sold_by, selling_price_cents,
          default_buying_cost_cents, is_returnable, stock_qty, low_stock_threshold,
          used_empties_count, damaged_empties_count, is_archived, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(
        p.typeId,
        p.sku,
        p.nameEn,
        p.nameTa,
        p.soldBy,
        p.sellingPriceCents,
        p.buyingCostCents,
        p.isReturnable,
        p.stockQty,
        p.lowStockThreshold,
        p.usedEmpties,
        p.damagedEmpties,
        now,
        now
      );

      if (p.stockQty > 0) {
        const batchId = `BAT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        db.prepare(
          `INSERT INTO stock_batches (id, batch_number, product_type_id, received_qty, remaining_qty, buying_cost_cents, selling_price_cents, note, created_by_id, created_by_name, created_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          batchId,
          p.typeId,
          p.stockQty,
          p.stockQty,
          p.buyingCostCents,
          p.sellingPriceCents,
          'Opening trial stock batch',
          'STF-OWNER',
          'Suresh Nathan',
          now
        );
        recordStockMovement({
          productTypeId: p.typeId,
          batchId,
          batchNumber: 1,
          movementType: 'receive',
          quantityChange: p.stockQty,
          note: 'Opening trial stock batch',
          staffId: 'STF-OWNER',
          staffName: 'Suresh Nathan',
        });
      }
    }

    // Synthetic bilingual wholesale customers
    const customersSeed = [
      {
        id: 'CUST-001',
        name: 'Murugan Stores',
        nameTa: 'முருகன் ஸ்டோர்ஸ்',
        phone: '077-412-8890',
        address: 'Hospital Road, Jaffna',
        balanceCents: 50000, // Rs. 500.00 prior debt (matches Phase 1B gate example!)
        cans: [
          { typeId: 'PRD-19L-FILLED', qty: 6 },
          { typeId: 'PRD-20L-PREM', qty: 2 },
        ],
      },
      {
        id: 'CUST-002',
        name: 'Nallur Bakery & Tea',
        nameTa: 'நல்லூர் பேக்கரி & தேநீர் கடை',
        phone: '071-890-2214',
        address: 'Point Pedro Road, Nallur',
        balanceCents: 10000, // Rs. 100.00 prior debt (matches Phase 1B gate example 2!)
        cans: [{ typeId: 'PRD-19L-FILLED', qty: 3 }],
      },
      {
        id: 'CUST-003',
        name: 'Central Traders Wholesale',
        nameTa: 'சென்ட்ரல் டிரேடர்ஸ்',
        phone: '076-331-9045',
        address: 'Stanley Road, Jaffna',
        balanceCents: 0,
        cans: [],
      },
    ];

    for (const c of customersSeed) {
      db.prepare(
        `INSERT INTO customers (id, name, name_ta, phone, address, balance_cents, is_archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(c.id, c.name, c.nameTa, c.phone, c.address, c.balanceCents, now, now);

      for (const holding of c.cans) {
        db.prepare(
          `INSERT INTO customer_can_holdings (customer_id, product_type_id, qty_held, updated_at)
           VALUES (?, ?, ?, ?)`
        ).run(c.id, holding.typeId, holding.qty, now);
      }
    }

    // Create 1 historical invoice today so Today's Analysis and Invoice History show live numbers
    const invId = `INVREC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const invNum = generateNextInvoiceNumber(today);
    const snapshot: InvoiceSnapshot = {
      invoiceNumber: invNum,
      invoiceDateColombo: now,
      businessDateColombo: today,
      customerId: 'CUST-003',
      customerName: 'Central Traders Wholesale',
      customerNameTa: 'சென்ட்ரல் டிரேடர்ஸ்',
      customerPhone: '076-331-9045',
      customerAddress: 'Stanley Road, Jaffna',
      staffId: 'STF-MGR',
      staffName: 'Kavitha Selvam',
      shop: {
        nameEn: 'Lanka Pure Springs Wholesale',
        nameTa: 'லங்கா பியூர் ஸ்பிரிங்ஸ் மொத்த விற்பனை',
        addressEn: 'No. 42, Kandy Road, Jaffna',
        addressTa: 'இல. 42, கண்டி வீதி, யாழ்ப்பாணம்',
        phone: '021-222-4810',
        taxId: 'VAT-LK-204819',
      },
      lines: [
        {
          productTypeId: 'PRD-500ML-CASE',
          sku: 'SKU-500ML-CASE24',
          nameEn: '500 ml Case (24 Bottles)',
          nameTa: '500 மி.லி பெட்டி (24 பாட்டில்கள்)',
          soldBy: 'case',
          isReturnable: false,
          qty: 2,
          unitPriceCents: 156000,
          lineTotalCents: 312000,
          internalUnitCostCents: 112000,
          internalLineCostCents: 224000,
        },
      ],
      subtotalCents: 312000,
      discountCents: 12000,
      invoiceTotalCents: 300000,
      paymentMethod: 'cash',
      tenderedCents: 300000,
      invoicePaidCents: 300000,
      oldDebtAppliedCents: 0,
      changeCents: 0,
      invoiceDueCents: 0,
      priorBalanceCents: 0,
      resultingBalanceCents: 0,
      returnableCansIssued: [],
    };

    db.prepare(
      `INSERT INTO invoices (
        id, invoice_number, customer_id, staff_id, staff_name, status,
        business_date_colombo, subtotal_cents, discount_cents, invoice_total_cents,
        payment_method, tendered_cents, invoice_paid_cents, old_debt_applied_cents,
        change_cents, invoice_due_cents, total_internal_cost_cents, snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      invId,
      invNum,
      'CUST-003',
      'STF-MGR',
      'Kavitha Selvam',
      today,
      312000,
      12000,
      300000,
      'cash',
      300000,
      300000,
      0,
      0,
      0,
      224000,
      JSON.stringify(snapshot),
      now
    );

    db.prepare(
      `INSERT INTO payments (id, customer_id, invoice_id, amount_cents, method, kind, note, staff_id, staff_name, business_date_colombo, created_at)
       VALUES (?, ?, ?, ?, 'cash', 'invoice_payment', ?, ?, ?, ?, ?)`
    ).run(
      `PAY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      'CUST-003',
      invId,
      300000,
      `Payment for ${invNum}`,
      'STF-MGR',
      'Kavitha Selvam',
      today,
      now
    );

    writeAuditLog({
      actorId: 'STF-OWNER',
      actorName: 'Suresh Nathan',
      actorRole: 'owner',
      action: 'TRIAL_SCENARIO_INITIALIZED',
      entityType: 'system',
      entityId: 'trial-bootstrap',
      after: { staffCount: 3, productCount: productSeed.length, customerCount: customersSeed.length },
      reason: 'User initialized disposable trial shop scenario',
    });

    return {
      staff: staffSeed.map((s) => ({ name: s.name, role: s.role, pin: s.pin })),
    };
  });
}
