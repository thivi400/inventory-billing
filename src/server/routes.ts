import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  db,
  generateNextInvoiceNumber,
  getNextBatchNumber,
  getShopDetails,
  getStarterBindings,
  hashPayload,
  hashPin,
  hashToken,
  isTrialModeActive,
  mapAuditRow,
  recordStockMovement,
  seedDisposableTrialScenario,
  stripSnapshotCosts,
  verifyPin,
  withTransaction,
  writeAuditLog,
} from './db.ts';
import { getColomboBusinessDate, getColomboTimestamp } from '../shared/colomboTime.ts';
import { isForbiddenBinding, STARTER_SLOTS } from '../shared/starterCatalog.ts';
import type { InvoiceSnapshot, StaffRole, StarterSlotKey } from '../shared/types.ts';

interface AuthStaff {
  id: string;
  name: string;
  nameTa: string;
  role: StaffRole;
  tokenHash: string;
}

interface AuthedRequest extends Request {
  staff?: AuthStaff;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

function toRupees(cents: number | null | undefined): number | null {
  if (cents === null || cents === undefined) return null;
  return Number((cents / 100).toFixed(2));
}

function parseMoneyToCents(
  raw: unknown,
  options: { allowNull?: boolean; allowNegative?: boolean; fieldName?: string } = {},
): { ok: true; cents: number | null } | { ok: false; error: string } {
  const field = options.fieldName || 'Amount';
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    if (options.allowNull) return { ok: true, cents: null };
    return { ok: false, error: `${field} must be a valid amount.` };
  }
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    return { ok: false, error: `${field} must be a valid numeric amount.` };
  }

  let str: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return { ok: false, error: `${field} must be a valid finite number.` };
    }
    str = String(raw);
  } else if (typeof raw === 'string') {
    str = raw.trim();
  } else {
    return { ok: false, error: `${field} must be a valid numeric amount.` };
  }

  const pattern = options.allowNegative ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/;
  if (!pattern.test(str)) {
    return {
      ok: false,
      error: options.allowNegative
        ? `${field} must be a valid number with at most 2 decimal places.`
        : `${field} must be a valid non-negative number with at most 2 decimal places.`,
    };
  }

  const negative = str.startsWith('-');
  const unsigned = negative ? str.slice(1) : str;
  const [wholeStr, fracStr = ''] = unsigned.split('.');
  const whole = Number(wholeStr);
  const frac = Number(fracStr.padEnd(2, '0'));
  const cents = (whole * 100 + frac) * (negative ? -1 : 1);
  if (!Number.isSafeInteger(cents)) {
    return { ok: false, error: `${field} is out of range.` };
  }
  return { ok: true, cents };
}

function normalizeMethod(raw: unknown): 'cash' | 'bank_transfer' | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'cash') return 'cash';
  if (v === 'bank' || v === 'bank_transfer') return 'bank_transfer';
  return null;
}

function methodToClient(method: string): 'cash' | 'bank' {
  return method === 'bank_transfer' || method === 'bank' ? 'bank' : 'cash';
}

function formatProductForClient(row: Record<string, unknown>, includeCosts: boolean) {
  const unit = String(row.sold_by || 'bottle');
  const name = String(row.name_en || '');
  const isCan = unit === 'can' || name.includes('19') || name.includes('20') || name.includes('5 L');
  const out: Record<string, unknown> = {
    id: String(row.type_id),
    type_id: String(row.type_id),
    name,
    ta: String(row.name_ta || name),
    price: row.selling_price_cents !== null && row.selling_price_cents !== undefined
      ? toRupees(Number(row.selling_price_cents))
      : null,
    stock: Number(row.stock_qty ?? 0),
    unit,
    sku: String(row.sku || ''),
    icon: isCan ? 'can' : 'bottle',
    is_returnable: Number(row.is_returnable) === 1,
    is_active: Number(row.is_archived) === 0,
    low_stock_limit: Number(row.low_stock_threshold ?? 10),
    used_empties_count:
      row.used_empties_count !== null && row.used_empties_count !== undefined
        ? Number(row.used_empties_count)
        : null,
    damaged_empties_count:
      row.damaged_empties_count !== null && row.damaged_empties_count !== undefined
        ? Number(row.damaged_empties_count)
        : null,
  };
  if (includeCosts) {
    out.buying_price =
      row.default_buying_cost_cents !== null && row.default_buying_cost_cents !== undefined
        ? toRupees(Number(row.default_buying_cost_cents))
        : null;
  }
  return out;
}

function formatCustomerForClient(row: Record<string, unknown>) {
  const cid = String(row.id);
  const holdingsRows = db
    .prepare(
      `SELECT h.product_type_id, h.qty_held, p.name_en, p.name_ta
       FROM customer_can_holdings h
       JOIN products p ON p.type_id = h.product_type_id
       WHERE h.customer_id = ? AND h.qty_held > 0
       ORDER BY p.name_en ASC`,
    )
    .all(cid) as Array<Record<string, unknown>>;

  const containerTypes = holdingsRows.map((h) => ({
    type_id: String(h.product_type_id),
    name: String(h.name_en),
    ta: String(h.name_ta || h.name_en),
    held: Number(h.qty_held),
  }));
  const totalCans = containerTypes.reduce((sum, item) => sum + item.held, 0);

  return {
    id: cid,
    name: String(row.name),
    name_ta: String(row.name_ta || ''),
    phone: String(row.phone || ''),
    address: String(row.address || ''),
    balance: Number((Number(row.balance_cents ?? 0) / 100).toFixed(2)),
    credit_limit: Number((Number(row.credit_limit_cents ?? 0) / 100).toFixed(2)),
    cans: totalCans,
    is_active: Number(row.is_archived) === 0,
    container_types: containerTypes,
  };
}

function buildReceiptFromInvoiceRow(row: Record<string, unknown>) {
  const rawSnap = JSON.parse(String(row.snapshot_json)) as InvoiceSnapshot;
  // NEVER expose internal buying costs on customer receipts or invoice details!
  const snap = stripSnapshotCosts(rawSnap);

  const returnRows = db
    .prepare(
      `SELECT product_type_id, SUM(qty_returned) AS qty_returned
       FROM goods_returns
       WHERE invoice_id = ?
       GROUP BY product_type_id`,
    )
    .all(String(row.id)) as Array<{ product_type_id: string; qty_returned: number }>;

  const returnedMap = new Map<string, number>();
  for (const r of returnRows) {
    returnedMap.set(String(r.product_type_id), Number(r.qty_returned || 0));
  }

  const canRetRow = db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS qty
       FROM can_movements
       WHERE invoice_id = ? AND movement_type IN ('returned_used', 'returned_damaged')`,
    )
    .get(String(row.id)) as { qty: number };

  return {
    sale_id: String(row.id),
    id: String(row.id),
    invoice_number: String(row.invoice_number),
    status: String(row.status) === 'canceled' ? 'cancelled' : 'completed',
    cancel_reason: row.cancel_reason ? String(row.cancel_reason) : null,
    customer_id: String(row.customer_id),
    customer_name: snap.customerName,
    customer_name_ta: snap.customerNameTa || '',
    customer_phone: snap.customerPhone || '',
    customer_address: snap.customerAddress || '',
    previous_balance: Number((snap.priorBalanceCents / 100).toFixed(2)),
    customer_balance: Number((snap.resultingBalanceCents / 100).toFixed(2)),
    subtotal: Number((snap.subtotalCents / 100).toFixed(2)),
    discount: Number((snap.discountCents / 100).toFixed(2)),
    total: Number((snap.invoiceTotalCents / 100).toFixed(2)),
    payment_method: methodToClient(snap.paymentMethod),
    cash_received: Number((snap.tenderedCents / 100).toFixed(2)),
    amount_paid: Number((snap.invoicePaidCents / 100).toFixed(2)),
    applied_to_bill: Number((snap.invoicePaidCents / 100).toFixed(2)),
    applied_to_old_debt: Number((snap.oldDebtAppliedCents / 100).toFixed(2)),
    change_returned: Number((snap.changeCents / 100).toFixed(2)),
    balance_due: Number((snap.invoiceDueCents / 100).toFixed(2)),
    cans_issued: snap.returnableCansIssued.map((c) => ({
      type_id: c.productTypeId,
      name: c.nameEn,
      ta: c.nameTa || c.nameEn,
      qty: c.qty,
    })),
    cans_returned: Number(canRetRow?.qty ?? 0),
    staff_name: snap.staffName,
    date: snap.invoiceDateColombo,
    business_date: snap.businessDateColombo,
    shop: {
      name_en: snap.shop.nameEn || '',
      name_ta: snap.shop.nameTa || '',
      address_en: snap.shop.addressEn || '',
      address_ta: snap.shop.addressTa || '',
      phone: snap.shop.phone || '',
      tax_id: snap.shop.taxId || '',
    },
    items: snap.lines.map((l) => ({
      sale_item_id: l.productTypeId,
      type_id: l.productTypeId,
      sku: l.sku,
      name: l.nameEn,
      ta: l.nameTa || l.nameEn,
      unit: l.soldBy,
      quantity: l.qty,
      returned_quantity: returnedMap.get(l.productTypeId) || 0,
      price: Number((l.unitPriceCents / 100).toFixed(2)),
      subtotal: Number((l.lineTotalCents / 100).toFixed(2)),
    })),
  };
}

function createSessionForStaff(staffId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const now = getColomboTimestamp();
  db.prepare(
    `INSERT INTO sessions (token_hash, staff_id, created_at, last_seen_ms) VALUES (?, ?, ?, ?)`,
  ).run(tokenHash, staffId, now, Date.now());
  return token;
}

function revokeAllSessionsForStaff(staffId: string): void {
  db.prepare(`DELETE FROM sessions WHERE staff_id = ?`).run(staffId);
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT s.token_hash, s.last_seen_ms, st.id, st.name, st.name_ta, st.role, st.is_active, st.locked_until_ms
       FROM sessions s
       JOIN staff st ON st.id = s.staff_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as Record<string, unknown> | undefined;

  if (!row || Number(row.is_active) !== 1) {
    res.status(401).json({ error: 'Session expired or revoked', code: 'session_revoked' });
    return;
  }

  if (typeof row.locked_until_ms === 'number' && row.locked_until_ms > Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    res.status(401).json({ error: 'Session expired or revoked', code: 'session_revoked' });
    return;
  }

  if (Date.now() - Number(row.last_seen_ms) > SESSION_IDLE_MS) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    res.status(401).json({ error: 'Session expired', code: 'session_expired' });
    return;
  }

  db.prepare(`UPDATE sessions SET last_seen_ms = ? WHERE token_hash = ?`).run(Date.now(), tokenHash);

  req.staff = {
    id: String(row.id),
    name: String(row.name),
    nameTa: String(row.name_ta || ''),
    role: row.role as StaffRole,
    tokenHash,
  };
  next();
}

function requireRole(...roles: StaffRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.staff || !roles.includes(req.staff.role)) {
      res.status(403).json({ error: 'Insufficient permissions for this action' });
      return;
    }
    next();
  };
}

function checkIdempotency(
  req: AuthedRequest,
  res: Response,
  endpoint: string,
): { operationId: string | null; payloadHash: string; replayed: boolean } {
  const opHeader = req.headers['x-operation-id'];
  const operationId = typeof opHeader === 'string' && opHeader.trim() ? opHeader.trim() : null;
  const payloadHash = hashPayload(req.body ?? {});
  if (!operationId || !req.staff) {
    return { operationId: null, payloadHash, replayed: false };
  }

  const existing = db
    .prepare(`SELECT * FROM idempotency_keys WHERE operation_id = ?`)
    .get(operationId) as Record<string, unknown> | undefined;

  if (!existing) {
    return { operationId, payloadHash, replayed: false };
  }

  if (
    String(existing.staff_id) !== req.staff.id ||
    String(existing.endpoint) !== endpoint ||
    String(existing.payload_hash) !== payloadHash
  ) {
    res.status(409).json({
      error: 'Operation ID was already used with different request details.',
      code: 'idempotency_conflict',
    });
    return { operationId, payloadHash, replayed: true };
  }

  res.status(Number(existing.status_code)).json(JSON.parse(String(existing.response_json)));
  return { operationId, payloadHash, replayed: true };
}

function saveIdempotency(
  operationId: string | null,
  staffId: string,
  endpoint: string,
  payloadHash: string,
  statusCode: number,
  body: unknown,
): void {
  if (!operationId) return;
  db.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (operation_id, staff_id, endpoint, payload_hash, status_code, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    operationId,
    staffId,
    endpoint,
    payloadHash,
    statusCode,
    JSON.stringify(body),
    getColomboTimestamp(),
  );
}

function computeColomboDateRange(
  period: string,
  fromParam?: string,
  toParam?: string,
): { fromDate: string; toDate: string } {
  const today = getColomboBusinessDate();
  if (period === 'today') {
    return { fromDate: today, toDate: today };
  }
  if (period === 'this_week') {
    const d = new Date(`${today}T12:00:00+05:30`);
    const dayOfWeek = d.getUTCDay(); // 0 Sun..6 Sat
    const diffToMon = (dayOfWeek + 6) % 7;
    d.setUTCDate(d.getUTCDate() - diffToMon);
    return { fromDate: getColomboBusinessDate(d), toDate: today };
  }
  if (period === 'this_month') {
    return { fromDate: `${today.slice(0, 7)}-01`, toDate: today };
  }
  if (period === 'custom' && fromParam && toParam) {
    return { fromDate: fromParam.slice(0, 10), toDate: toParam.slice(0, 10) };
  }
  return { fromDate: `${today.slice(0, 7)}-01`, toDate: today };
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  // =========================================================================
  // 1. AUTHENTICATION, FIRST-RUN OWNER SETUP & DISPOSABLE TRIAL SCENARIO
  // =========================================================================
  router.get('/auth/status', (_req: Request, res: Response) => {
    const rows = db
      .prepare(
        `SELECT id, name, name_ta, role, is_active, locked_until_ms
         FROM staff
         WHERE is_active = 1
         ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, name ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    const totalStaff = (
      db.prepare(`SELECT COUNT(*) AS cnt FROM staff`).get() as { cnt: number }
    ).cnt;
    const shop = getShopDetails();

    res.json({
      initialized: totalStaff > 0,
      trialMode: isTrialModeActive(),
      shopNameEn: shop.nameEn,
      shopNameTa: shop.nameTa,
      staff: rows.map((r) => {
        const lockedUntilMs =
          typeof r.locked_until_ms === 'number' && r.locked_until_ms > Date.now()
            ? r.locked_until_ms
            : null;
        return {
          id: String(r.id),
          name: String(r.name),
          name_ta: String(r.name_ta || ''),
          role: r.role as StaffRole,
          is_active: Number(r.is_active) === 1,
          is_locked: lockedUntilMs !== null,
          locked_until_ms: lockedUntilMs,
        };
      }),
    });
  });

  router.post('/auth/bootstrap-owner', (req: Request, res: Response) => {
    const {
      ownerName,
      ownerNameTa = '',
      pin,
      shopNameEn = '',
      shopNameTa = '',
      addressEn = '',
      addressTa = '',
      phone = '',
      taxId = '',
    } = req.body ?? {};

    if (!String(ownerName || '').trim()) {
      res.status(400).json({ error: 'Owner name is required.' });
      return;
    }
    if (!/^\d{4,8}$/.test(String(pin || ''))) {
      res.status(400).json({ error: 'PIN must be 4 to 8 numeric digits.' });
      return;
    }

    try {
      const result = withTransaction(() => {
        const existing = (
          db.prepare(`SELECT COUNT(*) AS cnt FROM staff`).get() as { cnt: number }
        ).cnt;
        if (existing > 0) {
          throw Object.assign(new Error('Shop is already initialized.'), { statusCode: 409 });
        }

        const now = getColomboTimestamp();
        const ownerId = `STF-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const { salt, hash } = hashPin(String(pin));

        db.prepare(
          `INSERT INTO staff (id, name, name_ta, role, pin_salt, pin_hash, is_active, failed_attempts, locked_until_ms, created_at, updated_at)
           VALUES (?, ?, ?, 'owner', ?, ?, 1, 0, NULL, ?, ?)`,
        ).run(ownerId, String(ownerName).trim(), String(ownerNameTa || '').trim(), salt, hash, now, now);

        db.prepare(
          `UPDATE shop_details
           SET name_en = ?, name_ta = ?, address_en = ?, address_ta = ?, phone = ?, tax_id = ?, updated_at = ?
           WHERE id = 1`,
        ).run(
          String(shopNameEn || '').trim(),
          String(shopNameTa || '').trim(),
          String(addressEn || '').trim(),
          String(addressTa || '').trim(),
          String(phone || '').trim(),
          String(taxId || '').trim(),
          now,
        );

        db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('trial_mode', '0')`).run();

        writeAuditLog({
          actorId: ownerId,
          actorName: String(ownerName).trim(),
          actorRole: 'owner',
          action: 'OWNER_BOOTSTRAPPED',
          entityType: 'staff',
          entityId: ownerId,
          after: { name: String(ownerName).trim(), role: 'owner', shopNameEn: String(shopNameEn || '').trim() },
          reason: 'First-run owner setup',
        });

        const accessToken = createSessionForStaff(ownerId);
        return {
          access_token: accessToken,
          user: {
            id: ownerId,
            name: String(ownerName).trim(),
            name_ta: String(ownerNameTa || '').trim(),
            role: 'owner' as StaffRole,
          },
          trialMode: false,
        };
      });

      res.status(201).json(result);
    } catch (err: any) {
      res.status(err?.statusCode || 400).json({ error: err?.message || 'Bootstrap failed' });
    }
  });

  router.post('/auth/bootstrap-trial', (_req: Request, res: Response) => {
    try {
      const seeded = seedDisposableTrialScenario();
      res.status(201).json(seeded);
    } catch (err: any) {
      res.status(409).json({ error: err?.message || 'Shop is already initialized.' });
    }
  });

  function evaluateStaffPinAttempt(
    staffRow: Record<string, unknown>,
    pinStr: string,
    context: 'login' | 'unlock',
  ):
    | { ok: true }
    | { ok: false; status: number; code?: string; error: string; lockedUntilMs?: number | null } {
    const staffId = String(staffRow.id);
    const nowMs = Date.now();
    const lockedUntil =
      typeof staffRow.locked_until_ms === 'number' ? staffRow.locked_until_ms : null;

    if (lockedUntil !== null && lockedUntil > nowMs) {
      writeAuditLog({
        actorId: staffId,
        actorName: String(staffRow.name),
        actorRole: String(staffRow.role),
        action: context === 'login' ? 'LOGIN_LOCKED_ATTEMPT' : 'UNLOCK_LOCKED_ATTEMPT',
        entityType: 'staff',
        entityId: staffId,
        after: { context, locked: true },
      });
      return {
        ok: false,
        status: 423,
        code: 'account_locked',
        error: 'Account temporarily locked. Try again later.',
        lockedUntilMs: lockedUntil,
      };
    }

    const valid =
      Boolean(pinStr) && verifyPin(pinStr, String(staffRow.pin_salt), String(staffRow.pin_hash));
    if (!valid) {
      const lockExpired = lockedUntil !== null && lockedUntil <= nowMs;
      const baseAttempts = lockExpired ? 0 : Number(staffRow.failed_attempts ?? 0);
      const nextAttempts = baseAttempts + 1;
      const shouldLock = nextAttempts >= MAX_FAILED_ATTEMPTS;
      const newLockedUntil = shouldLock ? nowMs + LOCKOUT_MS : null;

      withTransaction(() => {
        db.prepare(
          `UPDATE staff SET failed_attempts = ?, locked_until_ms = ?, updated_at = ? WHERE id = ?`,
        ).run(nextAttempts, newLockedUntil, getColomboTimestamp(), staffId);

        if (shouldLock) {
          revokeAllSessionsForStaff(staffId);
        }

        writeAuditLog({
          actorId: staffId,
          actorName: String(staffRow.name),
          actorRole: String(staffRow.role),
          action: shouldLock
            ? context === 'login'
              ? 'LOGIN_LOCKED_OUT'
              : 'UNLOCK_LOCKED_OUT'
            : context === 'login'
              ? 'LOGIN_FAILED'
              : 'UNLOCK_FAILED',
          entityType: 'staff',
          entityId: staffId,
          after: {
            context,
            failedAttempts: nextAttempts,
            locked: shouldLock,
            sessionsRevoked: shouldLock,
          },
        });
      });

      if (shouldLock) {
        return {
          ok: false,
          status: 423,
          code: 'account_locked',
          error: 'Account temporarily locked. Try again later.',
          lockedUntilMs: newLockedUntil,
        };
      }

      return { ok: false, status: 401, error: 'Invalid credentials.' };
    }

    db.prepare(
      `UPDATE staff SET failed_attempts = 0, locked_until_ms = NULL, updated_at = ? WHERE id = ?`,
    ).run(getColomboTimestamp(), staffId);

    return { ok: true };
  }

  router.post('/auth/login', (req: Request, res: Response) => {
    const { staffId, role, pin } = req.body ?? {};
    const pinStr = String(pin ?? '').trim();

    if (!pinStr) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    let staffRow: Record<string, unknown> | undefined;
    if (staffId) {
      staffRow = db
        .prepare(`SELECT * FROM staff WHERE id = ?`)
        .get(String(staffId)) as Record<string, unknown> | undefined;
    } else if (role) {
      staffRow = db
        .prepare(`SELECT * FROM staff WHERE role = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1`)
        .get(String(role)) as Record<string, unknown> | undefined;
    }

    if (!staffRow || Number(staffRow.is_active) !== 1) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    const attempt = evaluateStaffPinAttempt(staffRow, pinStr, 'login');
    if (!attempt.ok) {
      res.status(attempt.status).json({
        error: attempt.error,
        ...(attempt.code ? { code: attempt.code } : {}),
        ...(attempt.lockedUntilMs ? { lockedUntilMs: attempt.lockedUntilMs } : {}),
      });
      return;
    }

    const accessToken = createSessionForStaff(String(staffRow.id));
    res.json({
      access_token: accessToken,
      user: {
        id: String(staffRow.id),
        name: String(staffRow.name),
        name_ta: String(staffRow.name_ta || ''),
        role: staffRow.role as StaffRole,
      },
      trialMode: isTrialModeActive(),
    });
  });

  router.get('/auth/me', requireAuth, (req: AuthedRequest, res: Response) => {
    const s = req.staff!;
    res.json({
      id: s.id,
      full_name: s.name,
      name: s.name,
      name_ta: s.nameTa,
      role: s.role,
    });
  });

  router.post('/auth/verify-pin', requireAuth, (req: AuthedRequest, res: Response) => {
    const pinStr = String(req.body?.pin ?? '').trim();
    const row = db
      .prepare(`SELECT * FROM staff WHERE id = ? AND is_active = 1`)
      .get(req.staff!.id) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    const attempt = evaluateStaffPinAttempt(row, pinStr, 'unlock');
    if (!attempt.ok) {
      res.status(attempt.status).json({
        error: attempt.error,
        ...(attempt.code ? { code: attempt.code } : {}),
        ...(attempt.lockedUntilMs ? { lockedUntilMs: attempt.lockedUntilMs } : {}),
      });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/auth/logout', requireAuth, (req: AuthedRequest, res: Response) => {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(req.staff!.tokenHash);
    res.json({ ok: true });
  });

  // =========================================================================
  // 2. DASHBOARD TODAY (Colombo Business Day)
  // =========================================================================
  router.get('/dashboard/today', requireAuth, (req: AuthedRequest, res: Response) => {
    const today = getColomboBusinessDate();
    const isManagerOrOwner = req.staff!.role === 'owner' || req.staff!.role === 'manager';

    const invAgg = isManagerOrOwner
      ? (db
          .prepare(
            `SELECT COALESCE(SUM(invoice_total_cents), 0) AS gross_sales,
                    COALESCE(SUM(total_internal_cost_cents), 0) AS total_cost
             FROM invoices
             WHERE status = 'active' AND business_date_colombo = ?`,
          )
          .get(today) as { gross_sales: number; total_cost: number })
      : (db
          .prepare(
            `SELECT COALESCE(SUM(invoice_total_cents), 0) AS gross_sales,
                    0 AS total_cost
             FROM invoices
             WHERE status = 'active' AND business_date_colombo = ? AND staff_id = ?`,
          )
          .get(today, req.staff!.id) as { gross_sales: number; total_cost: number });

    const retAgg = isManagerOrOwner
      ? (db
          .prepare(
            `SELECT COALESCE(SUM(credit_cents), 0) AS ret_credit,
                    COALESCE(SUM(cost_reversed_cents), 0) AS ret_cost
             FROM goods_returns
             WHERE business_date_colombo = ?`,
          )
          .get(today) as { ret_credit: number; ret_cost: number })
      : (db
          .prepare(
            `SELECT COALESCE(SUM(gr.credit_cents), 0) AS ret_credit,
                    0 AS ret_cost
             FROM goods_returns gr
             JOIN invoices i ON i.id = gr.invoice_id
             WHERE gr.business_date_colombo = ? AND i.staff_id = ?`,
          )
          .get(today, req.staff!.id) as { ret_credit: number; ret_cost: number });

    const payAgg = isManagerOrOwner
      ? (db
          .prepare(
            `SELECT COALESCE(SUM(CASE WHEN method = 'cash' THEN amount_cents ELSE 0 END), 0) AS cash_cents,
                    COALESCE(SUM(CASE WHEN method = 'bank_transfer' THEN amount_cents ELSE 0 END), 0) AS bank_cents
             FROM payments
             WHERE business_date_colombo = ?`,
          )
          .get(today) as { cash_cents: number; bank_cents: number })
      : (db
          .prepare(
            `SELECT COALESCE(SUM(CASE WHEN method = 'cash' THEN amount_cents ELSE 0 END), 0) AS cash_cents,
                    COALESCE(SUM(CASE WHEN method = 'bank_transfer' THEN amount_cents ELSE 0 END), 0) AS bank_cents
             FROM payments
             WHERE business_date_colombo = ? AND staff_id = ?`,
          )
          .get(today, req.staff!.id) as { cash_cents: number; bank_cents: number });

    const netSalesCents = Number(invAgg.gross_sales) - Number(retAgg.ret_credit);
    const netCostCents = Number(invAgg.total_cost) - Number(retAgg.ret_cost);
    const signedGrossProfitCents = netSalesCents - netCostCents;
    const totalCollectionsCents = Number(payAgg.cash_cents) + Number(payAgg.bank_cents);

    const payload: Record<string, unknown> = {
      date: today,
      total_sales: Number((netSalesCents / 100).toFixed(2)),
      total_collections_today: Number((totalCollectionsCents / 100).toFixed(2)),
      cash_collections_today: Number((Number(payAgg.cash_cents) / 100).toFixed(2)),
      bank_collections_today: Number((Number(payAgg.bank_cents) / 100).toFixed(2)),
    };

    if (isManagerOrOwner) {
      payload.profit = Number((signedGrossProfitCents / 100).toFixed(2));
    }

    res.json(payload);
  });

  // =========================================================================
  // 3. PRODUCTS & STOCK (Strict Employee Cost Stripping & Phase 1A Starter Slots)
  // =========================================================================
  router.get('/products/list', requireAuth, (req: AuthedRequest, res: Response) => {
    const showArchived = req.query.show_archived === 'true';
    const includeMeta = req.query.include_meta === 'true';
    const includeCosts = req.staff!.role === 'owner' || req.staff!.role === 'manager';

    const rows = db
      .prepare(
        `SELECT * FROM products WHERE is_archived = ? ORDER BY created_at ASC, name_en ASC`,
      )
      .all(showArchived ? 1 : 0) as Array<Record<string, unknown>>;

    const products = rows.map((r) => formatProductForClient(r, includeCosts));

    if (!includeMeta) {
      res.json({ products });
      return;
    }

    const allRows = db
      .prepare(`SELECT * FROM products ORDER BY created_at ASC, name_en ASC`)
      .all() as Array<Record<string, unknown>>;

    const bindings = getStarterBindings().map((b) => ({
      slot_key: b.slotKey,
      product_type_id: b.productTypeId,
      excluded_type_ids: b.excludedTypeIds,
    }));

    res.json({
      products,
      all_products: allRows.map((r) => formatProductForClient(r, includeCosts)),
      bindings,
    });
  });

  router.post(
    '/products/create',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const {
        slot_key,
        name,
        ta,
        sku,
        unit = 'bottle',
        selling_price,
        buying_price,
        opening_qty = 0,
        low_stock_limit = 10,
        is_returnable = false,
      } = req.body ?? {};

      const cleanName = String(name || '').trim();
      if (!cleanName) {
        res.status(400).json({ error: 'Product name is required.' });
        return;
      }

      const validUnits = ['bottle', 'can', 'case', 'pack', 'unit'];
      const cleanUnit = validUnits.includes(String(unit)) ? String(unit) : 'unit';
      const qtyNum = Number(opening_qty ?? 0);
      if (!Number.isInteger(qtyNum) || qtyNum < 0) {
        res.status(400).json({ error: 'Opening quantity must be a whole number >= 0.' });
        return;
      }

      const parsedPrice = parseMoneyToCents(selling_price, {
        allowNull: true,
        allowNegative: false,
        fieldName: 'Selling price',
      });
      if (!parsedPrice.ok) {
        res.status(400).json({ error: parsedPrice.error, code: 'invalid_money', not_posted: true });
        return;
      }
      const parsedCost = parseMoneyToCents(buying_price, {
        allowNull: true,
        allowNegative: false,
        fieldName: 'Buying cost',
      });
      if (!parsedCost.ok) {
        res.status(400).json({ error: parsedCost.error, code: 'invalid_money', not_posted: true });
        return;
      }
      const priceCents = parsedPrice.cents;
      const costCents = parsedCost.cents;

      if (qtyNum > 0 && costCents === null) {
        res.status(400).json({ error: 'Buying cost is required when adding opening stock.', not_posted: true });
        return;
      }

      const cleanSku =
        String(sku || '').trim() ||
        `SKU-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

      if (slot_key) {
        const slotDef = STARTER_SLOTS.find((s) => s.slotKey === slot_key);
        if (!slotDef) {
          res.status(400).json({ error: 'Invalid starter slot key.' });
          return;
        }
        if (isForbiddenBinding(slotDef.slotKey, { sku: cleanSku, nameEn: cleanName })) {
          res.status(400).json({ error: '20L products cannot be bound to 19L starter slots.' });
          return;
        }
      }

      try {
        const created = withTransaction(() => {
          const dupSku = db
            .prepare(`SELECT type_id FROM products WHERE LOWER(sku) = LOWER(?)`)
            .get(cleanSku);
          if (dupSku) {
            throw Object.assign(new Error(`SKU "${cleanSku}" already exists.`), { statusCode: 409 });
          }

          const typeId = `PRD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
          const now = getColomboTimestamp();

          db.prepare(
            `INSERT INTO products (
              type_id, sku, name_en, name_ta, sold_by, selling_price_cents,
              default_buying_cost_cents, is_returnable, stock_qty, low_stock_threshold,
              used_empties_count, damaged_empties_count, is_archived, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
          ).run(
            typeId,
            cleanSku,
            cleanName,
            String(ta || cleanName).trim(),
            cleanUnit,
            priceCents,
            costCents,
            is_returnable ? 1 : 0,
            qtyNum,
            Math.max(0, Number(low_stock_limit ?? 10) || 10),
            now,
            now,
          );

          if (qtyNum > 0 && costCents !== null) {
            const batchId = `BAT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
            db.prepare(
              `INSERT INTO stock_batches (id, batch_number, product_type_id, received_qty, remaining_qty, buying_cost_cents, selling_price_cents, note, created_by_id, created_by_name, created_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              batchId,
              typeId,
              qtyNum,
              qtyNum,
              costCents,
              priceCents ?? 0,
              'Opening stock',
              req.staff!.id,
              req.staff!.name,
              now,
            );
            recordStockMovement({
              productTypeId: typeId,
              batchId,
              batchNumber: 1,
              movementType: 'receive',
              quantityChange: qtyNum,
              note: 'Opening stock',
              staffId: req.staff!.id,
              staffName: req.staff!.name,
            });
          }

          if (slot_key) {
            db.prepare(
              `INSERT INTO starter_slot_bindings (slot_key, product_type_id, excluded_type_ids_json, updated_at)
               VALUES (?, ?, '[]', ?)
               ON CONFLICT(slot_key) DO UPDATE SET product_type_id = excluded.product_type_id, updated_at = excluded.updated_at`,
            ).run(String(slot_key), typeId, now);
          }

          writeAuditLog({
            actorId: req.staff!.id,
            actorName: req.staff!.name,
            actorRole: req.staff!.role,
            action: 'PRODUCT_CREATED',
            entityType: 'product',
            entityId: typeId,
            after: { sku: cleanSku, name: cleanName, unit: cleanUnit, priceCents, costCents, openingQty: qtyNum, isReturnable: Boolean(is_returnable), slotKey: slot_key ?? null },
          });

          const row = db.prepare(`SELECT * FROM products WHERE type_id = ?`).get(typeId) as Record<string, unknown>;
          return formatProductForClient(row, true);
        });

        res.status(201).json(created);
      } catch (err: any) {
        res.status(err?.statusCode || 400).json({ error: err?.message || 'Failed to create product' });
      }
    },
  );

  router.post(
    '/products/update',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const {
        type_id,
        name,
        ta,
        unit,
        selling_price,
        buying_price,
        low_stock_limit,
        is_returnable,
      } = req.body ?? {};

      const existing = db
        .prepare(`SELECT * FROM products WHERE type_id = ?`)
        .get(String(type_id || '')) as Record<string, unknown> | undefined;
      if (!existing) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }

      const validUnits = ['bottle', 'can', 'case', 'pack', 'unit'];
      const nextName = name !== undefined ? String(name).trim() || String(existing.name_en) : String(existing.name_en);
      const nextTa = ta !== undefined ? String(ta).trim() : String(existing.name_ta || nextName);
      const nextUnit = unit !== undefined && validUnits.includes(String(unit)) ? String(unit) : String(existing.sold_by);

      let nextPriceCents = existing.selling_price_cents as number | null;
      if (selling_price !== undefined) {
        const parsedPrice = parseMoneyToCents(selling_price, {
          allowNull: true,
          allowNegative: false,
          fieldName: 'Selling price',
        });
        if (!parsedPrice.ok) {
          res.status(400).json({ error: parsedPrice.error, code: 'invalid_money', not_posted: true });
          return;
        }
        nextPriceCents = parsedPrice.cents;
      }

      // IMPORTANT: Updating default_buying_cost_cents ONLY prefills future batches.
      // It NEVER modifies historical stock_batches or invoices.
      let nextCostCents = existing.default_buying_cost_cents as number | null;
      if (buying_price !== undefined) {
        const parsedCost = parseMoneyToCents(buying_price, {
          allowNull: true,
          allowNegative: false,
          fieldName: 'Buying cost',
        });
        if (!parsedCost.ok) {
          res.status(400).json({ error: parsedCost.error, code: 'invalid_money', not_posted: true });
          return;
        }
        nextCostCents = parsedCost.cents;
      }

      const nextLowLimit =
        low_stock_limit !== undefined ? Math.max(0, Number(low_stock_limit) || 0) : Number(existing.low_stock_threshold ?? 10);
      const nextReturnable =
        is_returnable !== undefined ? (is_returnable ? 1 : 0) : Number(existing.is_returnable);

      const updated = withTransaction(() => {
        const now = getColomboTimestamp();
        db.prepare(
          `UPDATE products
           SET name_en = ?, name_ta = ?, sold_by = ?, selling_price_cents = ?,
               default_buying_cost_cents = ?, low_stock_threshold = ?, is_returnable = ?, updated_at = ?
           WHERE type_id = ?`,
        ).run(
          nextName,
          nextTa,
          nextUnit,
          nextPriceCents,
          nextCostCents,
          nextLowLimit,
          nextReturnable,
          now,
          String(type_id),
        );

        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: 'PRODUCT_UPDATED',
          entityType: 'product',
          entityId: String(type_id),
          before: {
            name: existing.name_en,
            sellingPriceCents: existing.selling_price_cents,
            defaultBuyingCostCents: existing.default_buying_cost_cents,
            unit: existing.sold_by,
            isReturnable: Number(existing.is_returnable) === 1,
          },
          after: {
            name: nextName,
            sellingPriceCents: nextPriceCents,
            defaultBuyingCostCents: nextCostCents,
            unit: nextUnit,
            isReturnable: nextReturnable === 1,
          },
        });

        const fresh = db.prepare(`SELECT * FROM products WHERE type_id = ?`).get(String(type_id)) as Record<string, unknown>;
        return formatProductForClient(fresh, true);
      });

      res.json(updated);
    },
  );

  router.post(
    '/products/archive',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const { type_id, action } = req.body ?? {};
      const existing = db
        .prepare(`SELECT * FROM products WHERE type_id = ?`)
        .get(String(type_id || '')) as Record<string, unknown> | undefined;
      if (!existing) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }

      const isArchiving = action !== 'restore';
      withTransaction(() => {
        db.prepare(`UPDATE products SET is_archived = ?, updated_at = ? WHERE type_id = ?`).run(
          isArchiving ? 1 : 0,
          getColomboTimestamp(),
          String(type_id),
        );
        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: isArchiving ? 'PRODUCT_ARCHIVED' : 'PRODUCT_RESTORED',
          entityType: 'product',
          entityId: String(type_id),
          before: { isArchived: Number(existing.is_archived) === 1 },
          after: { isArchived: isArchiving },
        });
      });

      res.json({ ok: true, is_active: !isArchiving });
    },
  );

  router.post(
    '/stock/receive',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const { type_id, quantity, buying_price, selling_price, note = '' } = req.body ?? {};
      const qtyNum = Number(quantity);
      if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
        res.status(400).json({ error: 'Quantity must be a positive whole number.' });
        return;
      }

      const prod = db
        .prepare(`SELECT * FROM products WHERE type_id = ?`)
        .get(String(type_id || '')) as Record<string, unknown> | undefined;
      if (!prod) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }

      let batchCostCents: number | null;
      if (buying_price !== undefined && buying_price !== null && String(buying_price).trim() !== '') {
        const parsedBatchCost = parseMoneyToCents(buying_price, {
          allowNull: false,
          allowNegative: false,
          fieldName: 'Buying cost',
        });
        if (!parsedBatchCost.ok) {
          res.status(400).json({ error: parsedBatchCost.error, code: 'invalid_money', not_posted: true });
          return;
        }
        batchCostCents = parsedBatchCost.cents;
      } else {
        batchCostCents =
          prod.default_buying_cost_cents !== null && prod.default_buying_cost_cents !== undefined
            ? Number(prod.default_buying_cost_cents)
            : null;
      }

      if (batchCostCents === null || batchCostCents < 0) {
        res.status(400).json({
          error: 'A valid non-negative buying cost is required for this stock batch.',
          not_posted: true,
        });
        return;
      }

      let batchSellCents = Number(prod.selling_price_cents ?? 0);
      if (selling_price !== undefined && selling_price !== null && String(selling_price).trim() !== '') {
        const parsedBatchSell = parseMoneyToCents(selling_price, {
          allowNull: false,
          allowNegative: false,
          fieldName: 'Selling price',
        });
        if (!parsedBatchSell.ok) {
          res.status(400).json({ error: parsedBatchSell.error, code: 'invalid_money', not_posted: true });
          return;
        }
        batchSellCents = parsedBatchSell.cents ?? 0;
      }

      const result = withTransaction(() => {
        const now = getColomboTimestamp();
        const batchNumber = getNextBatchNumber(String(type_id));
        const batchId = `BAT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

        db.prepare(
          `INSERT INTO stock_batches (id, batch_number, product_type_id, received_qty, remaining_qty, buying_cost_cents, selling_price_cents, note, created_by_id, created_by_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          batchId,
          batchNumber,
          String(type_id),
          qtyNum,
          qtyNum,
          batchCostCents,
          batchSellCents,
          String(note || 'Stock received'),
          req.staff!.id,
          req.staff!.name,
          now,
        );

        const newStock = Number(prod.stock_qty) + qtyNum;
        // Does NOT overwrite default_buying_cost_cents!
        db.prepare(`UPDATE products SET stock_qty = ?, updated_at = ? WHERE type_id = ?`).run(
          newStock,
          now,
          String(type_id),
        );

        recordStockMovement({
          productTypeId: String(type_id),
          batchId,
          batchNumber,
          movementType: 'receive',
          quantityChange: qtyNum,
          note: String(note || `Batch #${batchNumber} received`),
          staffId: req.staff!.id,
          staffName: req.staff!.name,
        });

        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: 'STOCK_RECEIVED',
          entityType: 'stock_batch',
          entityId: batchId,
          before: { stockQty: Number(prod.stock_qty) },
          after: { stockQty: newStock, batchNumber, qty: qtyNum, buyingCostCents: batchCostCents },
          reason: String(note || 'Stock receipt'),
        });

        return { ok: true, batch_id: batchId, batch_number: batchNumber, stock: newStock };
      });

      res.status(201).json(result);
    },
  );

  router.post(
    '/stock/adjust',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const { type_id, batch_id, quantity, reason = 'damaged', note = '' } = req.body ?? {};
      const qtyNum = Number(quantity);
      if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
        res.status(400).json({ error: 'Adjustment quantity must be a positive whole number.' });
        return;
      }

      const prod = db
        .prepare(`SELECT * FROM products WHERE type_id = ?`)
        .get(String(type_id || '')) as Record<string, unknown> | undefined;
      if (!prod) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }

      if (qtyNum > Number(prod.stock_qty)) {
        res.status(400).json({ error: `Cannot reduce by ${qtyNum}; only ${prod.stock_qty} in stock.` });
        return;
      }

      try {
        const result = withTransaction(() => {
          const now = getColomboTimestamp();
          let remainingToDeduct = qtyNum;

          if (batch_id) {
            const b = db
              .prepare(`SELECT * FROM stock_batches WHERE id = ? AND product_type_id = ?`)
              .get(String(batch_id), String(type_id)) as Record<string, unknown> | undefined;
            if (!b) {
              throw Object.assign(new Error('Selected batch not found.'), { statusCode: 404 });
            }
            if (Number(b.remaining_qty) < qtyNum) {
              throw Object.assign(
                new Error(`Batch #${b.batch_number} only has ${b.remaining_qty} remaining.`),
                { statusCode: 400 },
              );
            }
            db.prepare(`UPDATE stock_batches SET remaining_qty = remaining_qty - ? WHERE id = ?`).run(
              qtyNum,
              String(batch_id),
            );
            recordStockMovement({
              productTypeId: String(type_id),
              batchId: String(batch_id),
              batchNumber: Number(b.batch_number),
              movementType: String(reason),
              quantityChange: -qtyNum,
              note: String(note || `Stock reduced (${reason})`),
              staffId: req.staff!.id,
              staffName: req.staff!.name,
            });
            remainingToDeduct = 0;
          } else {
            const batches = db
              .prepare(
                `SELECT * FROM stock_batches
                 WHERE product_type_id = ? AND remaining_qty > 0
                 ORDER BY created_at ASC, batch_number ASC`,
              )
              .all(String(type_id)) as Array<Record<string, unknown>>;

            for (const b of batches) {
              if (remainingToDeduct <= 0) break;
              const take = Math.min(Number(b.remaining_qty), remainingToDeduct);
              db.prepare(`UPDATE stock_batches SET remaining_qty = remaining_qty - ? WHERE id = ?`).run(
                take,
                String(b.id),
              );
              recordStockMovement({
                productTypeId: String(type_id),
                batchId: String(b.id),
                batchNumber: Number(b.batch_number),
                movementType: String(reason),
                quantityChange: -take,
                note: String(note || `Stock reduced (${reason})`),
                staffId: req.staff!.id,
                staffName: req.staff!.name,
              });
              remainingToDeduct -= take;
            }
          }

          const newStock = Number(prod.stock_qty) - qtyNum;
          db.prepare(`UPDATE products SET stock_qty = ?, updated_at = ? WHERE type_id = ?`).run(
            newStock,
            now,
            String(type_id),
          );

          writeAuditLog({
            actorId: req.staff!.id,
            actorName: req.staff!.name,
            actorRole: req.staff!.role,
            action: 'STOCK_ADJUSTED',
            entityType: 'product',
            entityId: String(type_id),
            before: { stockQty: Number(prod.stock_qty) },
            after: { stockQty: newStock, deducted: qtyNum, batchId: batch_id ?? 'FIFO' },
            reason: String(reason),
          });

          return { ok: true, stock: newStock };
        });

        res.json(result);
      } catch (err: any) {
        res.status(err?.statusCode || 400).json({ error: err?.message || 'Stock adjustment failed' });
      }
    },
  );

  router.get('/stock/batches', requireAuth, (req: AuthedRequest, res: Response) => {
    const typeId = String(req.query.type_id || '');
    const includeCosts = req.staff!.role === 'owner' || req.staff!.role === 'manager';

    const rows = db
      .prepare(
        `SELECT * FROM stock_batches
         WHERE product_type_id = ? AND remaining_qty > 0
         ORDER BY created_at ASC, batch_number ASC`,
      )
      .all(typeId) as Array<Record<string, unknown>>;

    res.json(
      rows.map((b) => {
        const out: Record<string, unknown> = {
          batch_id: String(b.id),
          batch_number: Number(b.batch_number),
          received_date: String(b.created_at).slice(0, 10),
          received_quantity: Number(b.received_qty),
          current_quantity: Number(b.remaining_qty),
          selling_price: Number((Number(b.selling_price_cents ?? 0) / 100).toFixed(2)),
          note: String(b.note || ''),
        };
        if (includeCosts) {
          out.buying_price = Number((Number(b.buying_cost_cents ?? 0) / 100).toFixed(2));
        }
        return out;
      }),
    );
  });

  router.get('/stock/movements', requireAuth, (req: AuthedRequest, res: Response) => {
    const typeId = String(req.query.type_id || '');
    const isEmployee = req.staff!.role === 'employee';
    const rows = db
      .prepare(
        `SELECT * FROM stock_movements
         WHERE product_type_id = ?
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all(typeId) as Array<Record<string, unknown>>;

    res.json(
      rows.map((m) => {
        const ownMovement = String(m.staff_id || '') === req.staff!.id;
        const movementType = String(m.movement_type);
        let note = String(m.note || '');
        let staffName = String(m.staff_name || 'Staff');
        if (isEmployee && !ownMovement) {
          staffName = 'Staff';
          if (movementType === 'sale') {
            note = 'Sale';
          } else if (movementType === 'return_restock') {
            note = 'Return restock';
          } else if (movementType === 'cancel_restore') {
            note = 'Canceled sale restock';
          } else {
            note = note.replace(/\bINV-[A-Za-z0-9-]+\b/gi, '[invoice]');
          }
        }
        return {
          transaction_id: String(m.id),
          date: String(m.created_at),
          type: movementType,
          batch_number: Number(m.batch_number ?? 0),
          quantity_change: Number(m.quantity_change),
          note,
          staff_name: staffName,
        };
      }),
    );
  });

  router.post(
    '/stock/resolve-slot',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const { slot_key, action, product_type_id } = req.body ?? {};
      const slotDef = STARTER_SLOTS.find((s) => s.slotKey === slot_key);
      if (!slotDef) {
        res.status(400).json({ error: 'Unknown starter slot key.' });
        return;
      }
      const prod = db
        .prepare(`SELECT * FROM products WHERE type_id = ?`)
        .get(String(product_type_id || '')) as Record<string, unknown> | undefined;
      if (!prod) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }

      if (
        (action === 'bind_as_is' || action === 'fix_and_bind') &&
        isForbiddenBinding(slotDef.slotKey as StarterSlotKey, {
          sku: String(prod.sku),
          nameEn: String(prod.name_en),
        })
      ) {
        res.status(400).json({
          error: '20L products cannot be bound to 19L starter cards. Keep them under Other Products.',
        });
        return;
      }

      withTransaction(() => {
        const now = getColomboTimestamp();
        const existingBinding = db
          .prepare(`SELECT * FROM starter_slot_bindings WHERE slot_key = ?`)
          .get(slotDef.slotKey) as Record<string, unknown> | undefined;

        const excluded: string[] = existingBinding
          ? JSON.parse(String(existingBinding.excluded_type_ids_json || '[]'))
          : [];

        if (action === 'leave_other') {
          if (!excluded.includes(String(product_type_id))) {
            excluded.push(String(product_type_id));
          }
          db.prepare(
            `INSERT INTO starter_slot_bindings (slot_key, product_type_id, excluded_type_ids_json, updated_at)
             VALUES (?, NULL, ?, ?)
             ON CONFLICT(slot_key) DO UPDATE SET product_type_id = CASE WHEN product_type_id = ? THEN NULL ELSE product_type_id END, excluded_type_ids_json = ?, updated_at = ?`,
          ).run(
            slotDef.slotKey,
            JSON.stringify(excluded),
            now,
            String(product_type_id),
            JSON.stringify(excluded),
            now,
          );
        } else {
          if (action === 'fix_and_bind') {
            db.prepare(
              `UPDATE products SET name_en = ?, name_ta = ?, sold_by = ?, is_archived = 0, updated_at = ? WHERE type_id = ?`,
            ).run(slotDef.defaultNameEn, slotDef.defaultNameTa, slotDef.soldBy, now, String(product_type_id));
          }
          const filteredExcluded = excluded.filter((id) => id !== String(product_type_id));
          db.prepare(
            `INSERT INTO starter_slot_bindings (slot_key, product_type_id, excluded_type_ids_json, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(slot_key) DO UPDATE SET product_type_id = excluded.product_type_id, excluded_type_ids_json = excluded.excluded_type_ids_json, updated_at = excluded.updated_at`,
          ).run(slotDef.slotKey, String(product_type_id), JSON.stringify(filteredExcluded), now);
        }

        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: 'STARTER_SLOT_RESOLVED',
          entityType: 'starter_slot',
          entityId: slotDef.slotKey,
          after: { action, productTypeId: String(product_type_id) },
        });
      });

      res.json({ ok: true });
    },
  );

  router.post(
    '/stock/empties-count',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const { type_id, used_empties_count, damaged_empties_count } = req.body ?? {};
      const prod = db
        .prepare(`SELECT * FROM products WHERE type_id = ?`)
        .get(String(type_id || '')) as Record<string, unknown> | undefined;
      if (!prod) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }

      const usedVal =
        used_empties_count === null || used_empties_count === undefined || used_empties_count === ''
          ? null
          : Number(used_empties_count);
      const dmgVal =
        damaged_empties_count === null || damaged_empties_count === undefined || damaged_empties_count === ''
          ? null
          : Number(damaged_empties_count);

      if (
        (usedVal !== null && (!Number.isInteger(usedVal) || usedVal < 0)) ||
        (dmgVal !== null && (!Number.isInteger(dmgVal) || dmgVal < 0))
      ) {
        res.status(400).json({ error: 'Physical empty counts must be whole numbers >= 0 or empty.' });
        return;
      }

      const updated = withTransaction(() => {
        // NEVER touches sellable stock_qty!
        db.prepare(
          `UPDATE products SET used_empties_count = ?, damaged_empties_count = ?, updated_at = ? WHERE type_id = ?`,
        ).run(usedVal, dmgVal, getColomboTimestamp(), String(type_id));

        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: 'PHYSICAL_EMPTIES_COUNTED',
          entityType: 'product',
          entityId: String(type_id),
          before: {
            usedEmptiesCount: prod.used_empties_count,
            damagedEmptiesCount: prod.damaged_empties_count,
          },
          after: { usedEmptiesCount: usedVal, damagedEmptiesCount: dmgVal },
        });

        const fresh = db.prepare(`SELECT * FROM products WHERE type_id = ?`).get(String(type_id)) as Record<string, unknown>;
        return formatProductForClient(fresh, true);
      });

      res.json(updated);
    },
  );

  // =========================================================================
  // 4. CUSTOMERS & ACCOUNT STATEMENT
  // =========================================================================
  router.get('/customers/list', requireAuth, (req: AuthedRequest, res: Response) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const showArchived = req.query.show_archived === 'true';

    const rows = db
      .prepare(`SELECT * FROM customers WHERE is_archived = ? ORDER BY name ASC`)
      .all(showArchived ? 1 : 0) as Array<Record<string, unknown>>;

    const filtered = q
      ? rows.filter(
          (r) =>
            String(r.name || '').toLowerCase().includes(q) ||
            String(r.name_ta || '').toLowerCase().includes(q) ||
            String(r.phone || '').toLowerCase().includes(q),
        )
      : rows;

    res.json(filtered.map(formatCustomerForClient));
  });

  router.get('/customers/details/:id', requireAuth, (req: AuthedRequest, res: Response) => {
    const row = db
      .prepare(`SELECT * FROM customers WHERE id = ?`)
      .get(String(req.params.id)) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'Customer not found.' });
      return;
    }
    res.json(formatCustomerForClient(row));
  });

  router.post('/customers/create', requireAuth, (req: AuthedRequest, res: Response) => {
    const { name, name_ta = '', phone = '', address = '', credit_limit = 0 } = req.body ?? {};
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      res.status(400).json({ error: 'Customer name is required.' });
      return;
    }
    const canSetCreditLimit = req.staff!.role === 'owner' || req.staff!.role === 'manager';
    let creditLimitCents = 0;
    if (canSetCreditLimit && credit_limit !== undefined && credit_limit !== null && String(credit_limit).trim() !== '') {
      const parsedLimit = parseMoneyToCents(credit_limit, {
        allowNull: false,
        allowNegative: false,
        fieldName: 'Credit limit',
      });
      if (!parsedLimit.ok) {
        res.status(400).json({ error: parsedLimit.error, code: 'invalid_money', not_posted: true });
        return;
      }
      creditLimitCents = parsedLimit.cents ?? 0;
    }

    const created = withTransaction(() => {
      const id = `CUST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const now = getColomboTimestamp();
      db.prepare(
        `INSERT INTO customers (id, name, name_ta, phone, address, balance_cents, credit_limit_cents, is_archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
      ).run(
        id,
        cleanName,
        String(name_ta || '').trim(),
        String(phone || '').trim(),
        String(address || '').trim(),
        creditLimitCents,
        now,
        now,
      );

      writeAuditLog({
        actorId: req.staff!.id,
        actorName: req.staff!.name,
        actorRole: req.staff!.role,
        action: 'CUSTOMER_CREATED',
        entityType: 'customer',
        entityId: id,
        after: { name: cleanName, phone: String(phone || '').trim(), creditLimitCents },
      });

      const fresh = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id) as Record<string, unknown>;
      return formatCustomerForClient(fresh);
    });

    res.status(201).json(created);
  });

  router.post(
    '/customers/update',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const { customer_id, name, name_ta = '', phone = '', address = '', credit_limit } = req.body ?? {};
      const existing = db
        .prepare(`SELECT * FROM customers WHERE id = ?`)
        .get(String(customer_id || '')) as Record<string, unknown> | undefined;
      if (!existing) {
        res.status(404).json({ error: 'Customer not found.' });
        return;
      }

      const cleanName = String(name || '').trim();
      if (!cleanName) {
        res.status(400).json({ error: 'Customer name is required.' });
        return;
      }

      let nextCreditCents = Number(existing.credit_limit_cents ?? 0);
      if (credit_limit !== undefined) {
        const parsedLimit = parseMoneyToCents(credit_limit, {
          allowNull: false,
          allowNegative: false,
          fieldName: 'Credit limit',
        });
        if (!parsedLimit.ok) {
          res.status(400).json({ error: parsedLimit.error, code: 'invalid_money', not_posted: true });
          return;
        }
        nextCreditCents = parsedLimit.cents ?? 0;
      }

      const updated = withTransaction(() => {
        db.prepare(
          `UPDATE customers SET name = ?, name_ta = ?, phone = ?, address = ?, credit_limit_cents = ?, updated_at = ? WHERE id = ?`,
        ).run(
          cleanName,
          String(name_ta || '').trim(),
          String(phone || '').trim(),
          String(address || '').trim(),
          nextCreditCents,
          getColomboTimestamp(),
          String(customer_id),
        );

        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: 'CUSTOMER_UPDATED',
          entityType: 'customer',
          entityId: String(customer_id),
          before: { name: existing.name, phone: existing.phone, creditLimitCents: existing.credit_limit_cents },
          after: { name: cleanName, phone: String(phone || '').trim(), creditLimitCents: nextCreditCents },
        });

        const fresh = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(String(customer_id)) as Record<string, unknown>;
        return formatCustomerForClient(fresh);
      });

      res.json(updated);
    },
  );

  router.post(
    '/customers/archive',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const { customer_id, action } = req.body ?? {};
      const existing = db
        .prepare(`SELECT * FROM customers WHERE id = ?`)
        .get(String(customer_id || '')) as Record<string, unknown> | undefined;
      if (!existing) {
        res.status(404).json({ error: 'Customer not found.' });
        return;
      }

      const isArchiving = action !== 'restore';
      if (isArchiving) {
        const balanceCents = Number(existing.balance_cents ?? 0);
        const heldRow = db
          .prepare(`SELECT COALESCE(SUM(qty_held), 0) AS total_held FROM customer_can_holdings WHERE customer_id = ?`)
          .get(String(customer_id)) as { total_held: number };

        if (balanceCents !== 0 || Number(heldRow.total_held) > 0) {
          res.status(400).json({
            error: `Cannot archive customer while they have an unpaid balance (Rs. ${(balanceCents / 100).toFixed(2)}) or unreturned cans (${heldRow.total_held} held).`,
            code: 'archive_blocked_non_zero',
          });
          return;
        }
      }

      withTransaction(() => {
        db.prepare(`UPDATE customers SET is_archived = ?, updated_at = ? WHERE id = ?`).run(
          isArchiving ? 1 : 0,
          getColomboTimestamp(),
          String(customer_id),
        );
        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: isArchiving ? 'CUSTOMER_ARCHIVED' : 'CUSTOMER_RESTORED',
          entityType: 'customer',
          entityId: String(customer_id),
          before: { isArchived: Number(existing.is_archived) === 1 },
          after: { isArchived: isArchiving },
        });
      });

      res.json({ ok: true, is_active: !isArchiving });
    },
  );

  router.get('/customers/statement/:id', requireAuth, (req: AuthedRequest, res: Response) => {
    const cid = String(req.params.id);
    const cust = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(cid) as Record<string, unknown> | undefined;
    if (!cust) {
      res.status(404).json({ error: 'Customer not found.' });
      return;
    }

    const isEmployee = req.staff!.role === 'employee';

    type LedgerRow = {
      statement_id: string;
      transaction_date: string;
      entry_type: string;
      reference_number: string;
      description: string;
      debit_cents: number;
      credit_cents: number;
      is_aggregate?: boolean;
      drillable?: boolean;
    };

    const entries: LedgerRow[] = [];

    const invoices = isEmployee
      ? (db
          .prepare(`SELECT * FROM invoices WHERE customer_id = ? AND staff_id = ? ORDER BY created_at ASC`)
          .all(cid, req.staff!.id) as Array<Record<string, unknown>>)
      : (db
          .prepare(`SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at ASC`)
          .all(cid) as Array<Record<string, unknown>>);

    for (const inv of invoices) {
      entries.push({
        statement_id: `INV-${inv.id}`,
        transaction_date: String(inv.created_at),
        entry_type: inv.status === 'canceled' ? 'canceled_invoice' : 'invoice',
        reference_number: String(inv.invoice_number),
        description:
          inv.status === 'canceled'
            ? `Canceled invoice ${inv.invoice_number}`
            : `Invoice ${inv.invoice_number}`,
        debit_cents: inv.status === 'canceled' ? 0 : Number(inv.invoice_total_cents),
        credit_cents: 0,
        is_aggregate: false,
        drillable: true,
      });
    }

    const payments = isEmployee
      ? (db
          .prepare(`SELECT * FROM payments WHERE customer_id = ? AND staff_id = ? ORDER BY created_at ASC`)
          .all(cid, req.staff!.id) as Array<Record<string, unknown>>)
      : (db
          .prepare(`SELECT * FROM payments WHERE customer_id = ? ORDER BY created_at ASC`)
          .all(cid) as Array<Record<string, unknown>>);

    for (const p of payments) {
      const amt = Number(p.amount_cents);
      entries.push({
        statement_id: `PAY-${p.id}`,
        transaction_date: String(p.created_at),
        entry_type: amt < 0 ? 'payment_reversal' : 'payment',
        reference_number: String(p.id),
        description: String(p.note || `${String(p.method).toUpperCase()} payment`),
        debit_cents: amt < 0 ? Math.abs(amt) : 0,
        credit_cents: amt > 0 ? amt : 0,
        is_aggregate: false,
        drillable: false,
      });
    }

    if (!isEmployee) {
      const returns = db
        .prepare(`SELECT * FROM goods_returns WHERE customer_id = ? ORDER BY created_at ASC`)
        .all(cid) as Array<Record<string, unknown>>;
      for (const r of returns) {
        entries.push({
          statement_id: `RET-${r.id}`,
          transaction_date: String(r.created_at),
          entry_type: 'goods_return',
          reference_number: String(r.id),
          description: `Goods return (${r.qty_returned}): ${r.reason}`,
          debit_cents: 0,
          credit_cents: Number(r.credit_cents),
          is_aggregate: false,
          drillable: false,
        });
      }
    }

    entries.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));

    const custBalanceCents = Number(cust.balance_cents);
    const visibleNetDeltaCents = entries.reduce((sum, e) => sum + e.debit_cents - e.credit_cents, 0);
    const unexplainedDeltaCents = custBalanceCents - visibleNetDeltaCents;

    if (isEmployee) {
      // Keep the customer's true overall balance while hiding other staff members'
      // individual invoices, payments, returns, and identities behind one non-drillable aggregate.
      const finalEntries: LedgerRow[] = [];
      if (unexplainedDeltaCents !== 0) {
        finalEntries.push({
          statement_id: 'OTHER-AGGREGATE',
          transaction_date: '',
          entry_type: 'other_transactions',
          reference_number: '',
          description: 'Other transactions',
          debit_cents: unexplainedDeltaCents > 0 ? unexplainedDeltaCents : 0,
          credit_cents: unexplainedDeltaCents < 0 ? Math.abs(unexplainedDeltaCents) : 0,
          is_aggregate: true,
          drillable: false,
        });
      }
      finalEntries.push(...entries);

      let runningCents = 0;
      const result = finalEntries.map((e) => {
        runningCents += e.debit_cents - e.credit_cents;
        return {
          statement_id: e.statement_id,
          transaction_date: e.transaction_date,
          entry_type: e.entry_type,
          reference_number: e.reference_number,
          description: e.description,
          debit: Number((e.debit_cents / 100).toFixed(2)),
          credit: Number((e.credit_cents / 100).toFixed(2)),
          running_balance: Number((runningCents / 100).toFixed(2)),
          is_aggregate: Boolean(e.is_aggregate),
          drillable: Boolean(e.drillable),
        };
      });

      res.json(result);
      return;
    }

    // Owner/Manager: reconstruct opening balance if customer was seeded with initial prior debt
    let runningCents = unexplainedDeltaCents;

    const result = entries.map((e) => {
      runningCents += e.debit_cents - e.credit_cents;
      return {
        statement_id: e.statement_id,
        transaction_date: e.transaction_date,
        entry_type: e.entry_type,
        reference_number: e.reference_number,
        description: e.description,
        debit: Number((e.debit_cents / 100).toFixed(2)),
        credit: Number((e.credit_cents / 100).toFixed(2)),
        running_balance: Number((runningCents / 100).toFixed(2)),
        is_aggregate: false,
        drillable: Boolean(e.drillable),
      };
    });

    res.json(result);
  });

  // =========================================================================
  // 5. SALES / BILLING, GOODS RETURNS & CANCELLATION
  // =========================================================================
  router.post('/sales/create', requireAuth, (req: AuthedRequest, res: Response) => {
    const idem = checkIdempotency(req, res, '/sales/create');
    if (idem.replayed) return;

    const {
      customer_id,
      items,
      payment_type = 'cash',
      payment_method = 'cash',
      discount = 0,
      cash_received = 0,
      apply_to_old_debt = true,
      expected_previous_balance,
      empty_cans_returned = 0,
      return_container_type_id,
    } = req.body ?? {};

    if (!customer_id || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Customer and at least one bill item are required.', not_posted: true });
      return;
    }

    const dbMethod = normalizeMethod(payment_method);
    if (!dbMethod) {
      res.status(400).json({ error: 'Payment method must be Cash or Bank Transfer.', not_posted: true });
      return;
    }

    const parsedDiscount = parseMoneyToCents(discount, {
      allowNull: false,
      allowNegative: false,
      fieldName: 'Discount',
    });
    if (!parsedDiscount.ok) {
      res.status(400).json({ error: parsedDiscount.error, code: 'invalid_money', not_posted: true });
      return;
    }
    const discountCents = parsedDiscount.cents ?? 0;

    let tenderedCents = 0;
    if (payment_type !== 'credit') {
      const parsedCash = parseMoneyToCents(cash_received, {
        allowNull: false,
        allowNegative: false,
        fieldName: 'Tendered amount',
      });
      if (!parsedCash.ok) {
        res.status(400).json({ error: parsedCash.error, code: 'invalid_money', not_posted: true });
        return;
      }
      tenderedCents = parsedCash.cents ?? 0;
    }

    let expectedPriorCents: number | null = null;
    if (expected_previous_balance !== undefined && expected_previous_balance !== null && String(expected_previous_balance).trim() !== '') {
      const parsedExpected = parseMoneyToCents(expected_previous_balance, {
        allowNull: false,
        allowNegative: true,
        fieldName: 'Expected previous balance',
      });
      if (!parsedExpected.ok) {
        res.status(400).json({ error: parsedExpected.error, code: 'invalid_money', not_posted: true });
        return;
      }
      expectedPriorCents = parsedExpected.cents;
    }

    const emptyReturnQty = Number(empty_cans_returned || 0);
    if (!Number.isInteger(emptyReturnQty) || emptyReturnQty < 0) {
      res.status(400).json({ error: 'Returned empty cans must be a whole number >= 0.', not_posted: true });
      return;
    }

    try {
      const responsePayload = withTransaction(() => {
        const cust = db
          .prepare(`SELECT * FROM customers WHERE id = ?`)
          .get(String(customer_id)) as Record<string, unknown> | undefined;
        if (!cust || Number(cust.is_archived) === 1) {
          throw Object.assign(new Error('Active customer not found.'), { statusCode: 400, notPosted: true });
        }

        const priorBalanceCents = Number(cust.balance_cents);
        if (expectedPriorCents !== null) {
          if (Math.abs(expectedPriorCents - priorBalanceCents) > 1) {
            throw Object.assign(
              new Error('Customer balance changed while creating bill. Refresh and verify.'),
              { statusCode: 409, code: 'stale_balance', notPosted: true },
            );
          }
        }

        // PASS 1 (Read-Only): Validate all items, submitted prices, stock, totals, bank cap, and cans BEFORE any DB mutation
        const qtyByType = new Map<string, number>();
        const expectedPriceByType = new Map<string, number>();
        for (const it of items) {
          const tid = String(it?.type_id || it?.product_id || '');
          const q = Number(it?.quantity);
          if (!tid || !Number.isInteger(q) || q <= 0) {
            throw Object.assign(
              new Error('Each item must have a valid product and positive whole quantity.'),
              { statusCode: 400, notPosted: true },
            );
          }
          const rawSubmittedPrice = it?.price !== undefined ? it.price : it?.unit_price;
          if (rawSubmittedPrice !== undefined && rawSubmittedPrice !== null && String(rawSubmittedPrice).trim() !== '') {
            const parsedItemPrice = parseMoneyToCents(rawSubmittedPrice, {
              allowNull: false,
              allowNegative: false,
              fieldName: 'Item price',
            });
            if (!parsedItemPrice.ok) {
              throw Object.assign(new Error(parsedItemPrice.error), {
                statusCode: 400,
                code: 'invalid_money',
                notPosted: true,
              });
            }
            const prevExpected = expectedPriceByType.get(tid);
            if (prevExpected !== undefined && prevExpected !== parsedItemPrice.cents) {
              throw Object.assign(
                new Error('Conflicting unit prices submitted for the same product.'),
                { statusCode: 400, code: 'invalid_money', notPosted: true },
              );
            }
            expectedPriceByType.set(tid, parsedItemPrice.cents!);
          }
          qtyByType.set(tid, (qtyByType.get(tid) || 0) + q);
        }

        const validatedItems: Array<{
          tid: string;
          qty: number;
          prod: Record<string, unknown>;
          unitPriceCents: number;
        }> = [];
        const staleItems: Array<{
          type_id: string;
          name: string;
          ta: string;
          expected_price: number | null;
          current_price: number | null;
        }> = [];
        let projectedSubtotalCents = 0;
        const projectedReturnableIssued = new Map<string, number>();

        for (const [tid, qty] of qtyByType.entries()) {
          const prod = db
            .prepare(`SELECT * FROM products WHERE type_id = ?`)
            .get(tid) as Record<string, unknown> | undefined;
          if (!prod || Number(prod.is_archived) === 1) {
            throw Object.assign(new Error(`Product ${tid} is not active in catalog.`), {
              statusCode: 400,
              notPosted: true,
            });
          }
          if (prod.selling_price_cents === null || prod.selling_price_cents === undefined) {
            throw Object.assign(
              new Error(`Product "${prod.name_en}" has no selling price set and cannot be sold.`),
              { statusCode: 400, notPosted: true },
            );
          }
          if (Number(prod.stock_qty) < qty) {
            throw Object.assign(
              new Error(`Insufficient stock for "${prod.name_en}" (${prod.stock_qty} available).`),
              { statusCode: 400, notPosted: true },
            );
          }

          const currentPriceCents = Number(prod.selling_price_cents);
          const expectedPriceCents = expectedPriceByType.get(tid);
          if (expectedPriceCents !== undefined && expectedPriceCents !== currentPriceCents) {
            staleItems.push({
              type_id: tid,
              name: String(prod.name_en),
              ta: String(prod.name_ta || prod.name_en),
              expected_price: toRupees(expectedPriceCents),
              current_price: toRupees(currentPriceCents),
            });
          }

          projectedSubtotalCents += currentPriceCents * qty;
          if (Number(prod.is_returnable) === 1) {
            projectedReturnableIssued.set(tid, (projectedReturnableIssued.get(tid) || 0) + qty);
          }
          validatedItems.push({ tid, qty, prod, unitPriceCents: currentPriceCents });
        }

        if (staleItems.length > 0) {
          throw Object.assign(
            new Error('Product prices changed while creating this bill. Review the updated total and confirm again.'),
            {
              statusCode: 409,
              code: 'stale_price',
              staleItems,
              notPosted: true,
            },
          );
        }

        if (discountCents > projectedSubtotalCents) {
          throw Object.assign(new Error('Discount cannot exceed subtotal.'), {
            statusCode: 400,
            notPosted: true,
          });
        }

        const projectedInvoiceTotalCents = projectedSubtotalCents - discountCents;
        const previousDebtCents = Math.max(0, priorBalanceCents);

        // STRICT Phase 1B Bank Transfer excess block (checked before any DB writes)
        if (dbMethod === 'bank_transfer' && tenderedCents > projectedInvoiceTotalCents + previousDebtCents) {
          throw Object.assign(
            new Error(
              `Bank transfer cannot exceed invoice total plus prior debt (max Rs. ${((projectedInvoiceTotalCents + previousDebtCents) / 100).toFixed(2)}).`,
            ),
            { statusCode: 400, code: 'bank_excess_blocked', notPosted: true },
          );
        }

        if (emptyReturnQty > 0) {
          const targetCanType = String(return_container_type_id || '');
          if (!targetCanType) {
            throw Object.assign(new Error('Select a returnable can type for returned empty cans.'), {
              statusCode: 400,
              notPosted: true,
            });
          }
          const held = db
            .prepare(`SELECT qty_held FROM customer_can_holdings WHERE customer_id = ? AND product_type_id = ?`)
            .get(String(customer_id), targetCanType) as { qty_held: number } | undefined;
          const heldAfterIssue = Number(held?.qty_held ?? 0) + (projectedReturnableIssued.get(targetCanType) || 0);
          if (emptyReturnQty > heldAfterIssue) {
            throw Object.assign(
              new Error(`Cannot return ${emptyReturnQty} cans; customer holds ${heldAfterIssue}.`),
              { statusCode: 400, notPosted: true },
            );
          }
        }

        // PASS 2: All validations passed — apply atomic DB mutations
        const now = getColomboTimestamp();
        const today = getColomboBusinessDate();
        const invoiceId = `INVREC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const invoiceNumber = generateNextInvoiceNumber(today);

        let subtotalCents = 0;
        let totalInternalCostCents = 0;
        const snapshotLines: InvoiceSnapshot['lines'] = [];
        const returnableCansIssued: InvoiceSnapshot['returnableCansIssued'] = [];

        for (const { tid, qty, prod, unitPriceCents } of validatedItems) {
          // FIFO batch consumption to compute exact historical cost
          let remaining = qty;
          let lineCostCents = 0;
          const batches = db
            .prepare(
              `SELECT * FROM stock_batches
               WHERE product_type_id = ? AND remaining_qty > 0
               ORDER BY created_at ASC, batch_number ASC`,
            )
            .all(tid) as Array<Record<string, unknown>>;

          for (const b of batches) {
            if (remaining <= 0) break;
            const take = Math.min(Number(b.remaining_qty), remaining);
            db.prepare(`UPDATE stock_batches SET remaining_qty = remaining_qty - ? WHERE id = ?`).run(
              take,
              String(b.id),
            );
            lineCostCents += take * Number(b.buying_cost_cents);
            recordStockMovement({
              productTypeId: tid,
              batchId: String(b.id),
              batchNumber: Number(b.batch_number),
              movementType: 'sale',
              quantityChange: -take,
              note: `Invoice ${invoiceNumber}`,
              staffId: req.staff!.id,
              staffName: req.staff!.name,
            });
            remaining -= take;
          }

          if (remaining > 0) {
            const fallbackCost = Number(prod.default_buying_cost_cents ?? 0);
            lineCostCents += remaining * fallbackCost;
            recordStockMovement({
              productTypeId: tid,
              movementType: 'sale',
              quantityChange: -remaining,
              note: `Invoice ${invoiceNumber}`,
              staffId: req.staff!.id,
              staffName: req.staff!.name,
            });
          }

          db.prepare(`UPDATE products SET stock_qty = stock_qty - ?, updated_at = ? WHERE type_id = ?`).run(
            qty,
            now,
            tid,
          );

          const lineTotalCents = unitPriceCents * qty;
          subtotalCents += lineTotalCents;
          totalInternalCostCents += lineCostCents;

          snapshotLines.push({
            productTypeId: tid,
            sku: String(prod.sku),
            nameEn: String(prod.name_en),
            nameTa: String(prod.name_ta || prod.name_en),
            soldBy: prod.sold_by as InvoiceSnapshot['lines'][number]['soldBy'],
            isReturnable: Number(prod.is_returnable) === 1,
            qty,
            unitPriceCents,
            lineTotalCents,
            internalUnitCostCents: Math.round(lineCostCents / qty),
            internalLineCostCents: lineCostCents,
          });

          if (Number(prod.is_returnable) === 1) {
            returnableCansIssued.push({
              productTypeId: tid,
              nameEn: String(prod.name_en),
              nameTa: String(prod.name_ta || prod.name_en),
              qty,
            });
          }
        }

        const invoiceTotalCents = subtotalCents - discountCents;
        const invoicePaidCents = Math.min(invoiceTotalCents, tenderedCents);
        const excessCents = Math.max(0, tenderedCents - invoiceTotalCents);
        const useOldDebt = dbMethod === 'bank_transfer' ? true : Boolean(apply_to_old_debt);
        const oldDebtAppliedCents =
          useOldDebt && excessCents > 0 && previousDebtCents > 0
            ? Math.min(previousDebtCents, excessCents)
            : 0;
        const changeCents =
          dbMethod === 'bank_transfer' ? 0 : Math.max(0, excessCents - oldDebtAppliedCents);
        const invoiceDueCents = invoiceTotalCents - invoicePaidCents;
        const resultingBalanceCents = priorBalanceCents + invoiceDueCents - oldDebtAppliedCents;

        const shop = getShopDetails();
        const snapshot: InvoiceSnapshot = {
          invoiceNumber,
          invoiceDateColombo: now,
          businessDateColombo: today,
          customerId: String(customer_id),
          customerName: String(cust.name),
          customerNameTa: String(cust.name_ta || ''),
          customerPhone: String(cust.phone || ''),
          customerAddress: String(cust.address || ''),
          staffId: req.staff!.id,
          staffName: req.staff!.name,
          shop: {
            nameEn: shop.nameEn,
            nameTa: shop.nameTa,
            addressEn: shop.addressEn,
            addressTa: shop.addressTa,
            phone: shop.phone,
            taxId: shop.taxId,
          },
          lines: snapshotLines,
          subtotalCents,
          discountCents,
          invoiceTotalCents,
          paymentMethod: dbMethod,
          tenderedCents,
          invoicePaidCents,
          oldDebtAppliedCents,
          changeCents,
          invoiceDueCents,
          priorBalanceCents,
          resultingBalanceCents,
          returnableCansIssued,
        };

        db.prepare(
          `INSERT INTO invoices (
            id, invoice_number, customer_id, staff_id, staff_name, status,
            business_date_colombo, subtotal_cents, discount_cents, invoice_total_cents,
            payment_method, tendered_cents, invoice_paid_cents, old_debt_applied_cents,
            change_cents, invoice_due_cents, total_internal_cost_cents, snapshot_json, created_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          invoiceId,
          invoiceNumber,
          String(customer_id),
          req.staff!.id,
          req.staff!.name,
          today,
          subtotalCents,
          discountCents,
          invoiceTotalCents,
          dbMethod,
          tenderedCents,
          invoicePaidCents,
          oldDebtAppliedCents,
          changeCents,
          invoiceDueCents,
          totalInternalCostCents,
          JSON.stringify(snapshot),
          now,
        );

        // Update customer balance
        db.prepare(`UPDATE customers SET balance_cents = ?, updated_at = ? WHERE id = ?`).run(
          resultingBalanceCents,
          now,
          String(customer_id),
        );

        // Record payments (separate rows for invoice payment and old debt collection!)
        if (invoicePaidCents > 0) {
          db.prepare(
            `INSERT INTO payments (id, customer_id, invoice_id, amount_cents, method, kind, note, staff_id, staff_name, business_date_colombo, created_at)
             VALUES (?, ?, ?, ?, ?, 'invoice_payment', ?, ?, ?, ?, ?)`,
          ).run(
            `PAY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
            String(customer_id),
            invoiceId,
            invoicePaidCents,
            dbMethod,
            `Payment for ${invoiceNumber}`,
            req.staff!.id,
            req.staff!.name,
            today,
            now,
          );
        }

        if (oldDebtAppliedCents > 0) {
          db.prepare(
            `INSERT INTO payments (id, customer_id, invoice_id, amount_cents, method, kind, note, staff_id, staff_name, business_date_colombo, created_at)
             VALUES (?, ?, NULL, ?, ?, 'old_debt_collection', ?, ?, ?, ?, ?)`,
          ).run(
            `PAY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
            String(customer_id),
            oldDebtAppliedCents,
            dbMethod,
            `Excess applied to old debt on ${invoiceNumber}`,
            req.staff!.id,
            req.staff!.name,
            today,
            now,
          );
        }

        // Issue returnable cans to customer_can_holdings
        for (const issued of returnableCansIssued) {
          db.prepare(
            `INSERT INTO customer_can_holdings (customer_id, product_type_id, qty_held, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(customer_id, product_type_id) DO UPDATE SET qty_held = qty_held + excluded.qty_held, updated_at = excluded.updated_at`,
          ).run(String(customer_id), issued.productTypeId, issued.qty, now);

          db.prepare(
            `INSERT INTO can_movements (id, customer_id, product_type_id, movement_type, qty, invoice_id, note, staff_id, staff_name, business_date_colombo, created_at)
             VALUES (?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            `CAN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
            String(customer_id),
            issued.productTypeId,
            issued.qty,
            invoiceId,
            `Issued on ${invoiceNumber}`,
            req.staff!.id,
            req.staff!.name,
            today,
            now,
          );
        }

        // Optional empty cans returned during checkout (increments used_empties_count, NEVER sellable stock_qty!)
        if (emptyReturnQty > 0) {
          const targetCanType = String(return_container_type_id || '');
          if (!targetCanType) {
            throw Object.assign(new Error('Select a returnable can type for returned empty cans.'), {
              statusCode: 400,
            });
          }
          const held = db
            .prepare(`SELECT qty_held FROM customer_can_holdings WHERE customer_id = ? AND product_type_id = ?`)
            .get(String(customer_id), targetCanType) as { qty_held: number } | undefined;
          const heldQty = Number(held?.qty_held ?? 0);
          if (emptyReturnQty > heldQty) {
            throw Object.assign(
              new Error(`Cannot return ${emptyReturnQty} cans; customer holds ${heldQty}.`),
              { statusCode: 400 },
            );
          }

          db.prepare(
            `UPDATE customer_can_holdings SET qty_held = qty_held - ?, updated_at = ? WHERE customer_id = ? AND product_type_id = ?`,
          ).run(emptyReturnQty, now, String(customer_id), targetCanType);

          db.prepare(
            `UPDATE products SET used_empties_count = COALESCE(used_empties_count, 0) + ?, updated_at = ? WHERE type_id = ?`,
          ).run(emptyReturnQty, now, targetCanType);

          db.prepare(
            `INSERT INTO can_movements (id, customer_id, product_type_id, movement_type, qty, invoice_id, note, staff_id, staff_name, business_date_colombo, created_at)
             VALUES (?, ?, ?, 'returned_used', ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            `CAN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
            String(customer_id),
            targetCanType,
            emptyReturnQty,
            invoiceId,
            `Returned on ${invoiceNumber}`,
            req.staff!.id,
            req.staff!.name,
            today,
            now,
          );
        }

        const totalCansHeldRow = db
          .prepare(`SELECT COALESCE(SUM(qty_held), 0) AS total_held FROM customer_can_holdings WHERE customer_id = ?`)
          .get(String(customer_id)) as { total_held: number };

        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: 'INVOICE_CREATED',
          entityType: 'invoice',
          entityId: invoiceId,
          after: {
            invoiceNumber,
            customerId: String(customer_id),
            invoiceTotalCents,
            invoicePaidCents,
            oldDebtAppliedCents,
            changeCents,
            paymentMethod: dbMethod,
          },
        });

        const freshInv = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoiceId) as Record<string, unknown>;
        const payload = {
          receipt: buildReceiptFromInvoiceRow(freshInv),
          new_balance: Number((resultingBalanceCents / 100).toFixed(2)),
          new_cans_balance: Number(totalCansHeldRow.total_held),
        };

        saveIdempotency(idem.operationId, req.staff!.id, '/sales/create', idem.payloadHash, 201, payload);
        return payload;
      });

      res.status(201).json(responsePayload);
    } catch (err: any) {
      const status = err?.statusCode || 400;
      res.status(status).json({
        error: err?.message || 'Failed to create invoice',
        ...(err?.code ? { code: err.code } : {}),
        ...(err?.staleItems ? { stale_items: err.staleItems } : {}),
        ...(err?.notPosted === true || (status >= 400 && status < 500) ? { not_posted: true } : {}),
      });
    }
  });

  router.post(
    '/sales/return-item',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const idem = checkIdempotency(req, res, '/sales/return-item');
      if (idem.replayed) return;

      const { invoice_id, sale_item_id, quantity, reason, restock = false } = req.body ?? {};
      const qtyNum = Number(quantity);
      const cleanReason = String(reason || '').trim();
      if (!invoice_id || !sale_item_id || !Number.isInteger(qtyNum) || qtyNum <= 0 || !cleanReason) {
        res.status(400).json({
          error: 'Invoice, line item, positive whole quantity, and reason are required.',
          not_posted: true,
        });
        return;
      }

      try {
        const result = withTransaction(() => {
          const inv = db
            .prepare(`SELECT * FROM invoices WHERE id = ? OR invoice_number = ?`)
            .get(String(invoice_id), String(invoice_id)) as Record<string, unknown> | undefined;
          if (!inv) {
            throw Object.assign(new Error('Invoice not found.'), { statusCode: 404 });
          }
          if (String(inv.status) !== 'active') {
            throw Object.assign(new Error('Cannot return items from a canceled invoice.'), { statusCode: 400 });
          }

          const snap = JSON.parse(String(inv.snapshot_json)) as InvoiceSnapshot;
          const line = snap.lines.find((l) => l.productTypeId === String(sale_item_id));
          if (!line) {
            throw Object.assign(new Error('Line item not found on this invoice.'), { statusCode: 404 });
          }

          const priorRetRow = db
            .prepare(
              `SELECT COALESCE(SUM(qty_returned), 0) AS qty_ret
               FROM goods_returns WHERE invoice_id = ? AND product_type_id = ?`,
            )
            .get(String(inv.id), line.productTypeId) as { qty_ret: number };
          const alreadyReturned = Number(priorRetRow.qty_ret ?? 0);
          const remainingReturnable = line.qty - alreadyReturned;
          if (qtyNum > remainingReturnable) {
            throw Object.assign(
              new Error(`Only ${remainingReturnable} unit(s) remain returnable for "${line.nameEn}".`),
              { statusCode: 400 },
            );
          }

          const totalAlreadyCreditedRow = db
            .prepare(`SELECT COALESCE(SUM(credit_cents), 0) AS credited FROM goods_returns WHERE invoice_id = ?`)
            .get(String(inv.id)) as { credited: number };
          const remainingBillCreditCap = Math.max(
            0,
            snap.invoiceTotalCents - Number(totalAlreadyCreditedRow.credited ?? 0),
          );

          // Proportional discounted credit (never over-credits discounted invoices!)
          const rawProportionalCents =
            snap.subtotalCents > 0
              ? Math.round((line.lineTotalCents * (snap.invoiceTotalCents / snap.subtotalCents)) * (qtyNum / line.qty))
              : 0;
          const creditCents = Math.min(remainingBillCreditCap, rawProportionalCents);

          const unitInternalCostCents =
            line.internalLineCostCents !== undefined
              ? Math.round(line.internalLineCostCents / line.qty)
              : Number(line.internalUnitCostCents ?? 0);
          const costReversedCents = unitInternalCostCents * qtyNum;

          const now = getColomboTimestamp();
          const today = getColomboBusinessDate();
          const retId = `RET-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

          db.prepare(
            `INSERT INTO goods_returns (id, invoice_id, customer_id, product_type_id, qty_returned, credit_cents, cost_reversed_cents, restocked, reason, staff_id, staff_name, business_date_colombo, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            retId,
            String(inv.id),
            String(inv.customer_id),
            line.productTypeId,
            qtyNum,
            creditCents,
            costReversedCents,
            restock ? 1 : 0,
            cleanReason,
            req.staff!.id,
            req.staff!.name,
            today,
            now,
          );

          // Credit customer account (no cash payout!)
          db.prepare(`UPDATE customers SET balance_cents = balance_cents - ?, updated_at = ? WHERE id = ?`).run(
            creditCents,
            now,
            String(inv.customer_id),
          );

          if (restock) {
            const batchNumber = getNextBatchNumber(line.productTypeId);
            const batchId = `BAT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
            db.prepare(
              `INSERT INTO stock_batches (id, batch_number, product_type_id, received_qty, remaining_qty, buying_cost_cents, selling_price_cents, note, created_by_id, created_by_name, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              batchId,
              batchNumber,
              line.productTypeId,
              qtyNum,
              qtyNum,
              unitInternalCostCents,
              line.unitPriceCents,
              `Restock from return ${inv.invoice_number}`,
              req.staff!.id,
              req.staff!.name,
              now,
            );
            db.prepare(`UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE type_id = ?`).run(
              qtyNum,
              now,
              line.productTypeId,
            );
            recordStockMovement({
              productTypeId: line.productTypeId,
              batchId,
              batchNumber,
              movementType: 'return_restock',
              quantityChange: qtyNum,
              note: `Goods return from ${inv.invoice_number}: ${cleanReason}`,
              staffId: req.staff!.id,
              staffName: req.staff!.name,
            });
          }

          writeAuditLog({
            actorId: req.staff!.id,
            actorName: req.staff!.name,
            actorRole: req.staff!.role,
            action: 'GOODS_RETURNED',
            entityType: 'goods_return',
            entityId: retId,
            after: {
              invoiceNumber: inv.invoice_number,
              productTypeId: line.productTypeId,
              qtyReturned: qtyNum,
              creditCents,
              restock: Boolean(restock),
            },
            reason: cleanReason,
          });

          const payload = {
            ok: true,
            return_id: retId,
            credit_amount: Number((creditCents / 100).toFixed(2)),
            credit_cents: creditCents,
          };
          saveIdempotency(idem.operationId, req.staff!.id, '/sales/return-item', idem.payloadHash, 200, payload);
          return payload;
        });

        res.json(result);
      } catch (err: any) {
        const status = err?.statusCode || 400;
        res.status(status).json({
          error: err?.message || 'Failed to process return',
          ...(status >= 400 && status < 500 ? { not_posted: true } : {}),
        });
      }
    },
  );

  router.post(
    '/sales/cancel',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const { sale_id, reason } = req.body ?? {};
      const cleanReason = String(reason || '').trim();
      if (!sale_id || !cleanReason) {
        res.status(400).json({ error: 'Invoice ID and cancellation reason are required.' });
        return;
      }

      try {
        const result = withTransaction(() => {
          const inv = db
            .prepare(`SELECT * FROM invoices WHERE id = ? OR invoice_number = ?`)
            .get(String(sale_id), String(sale_id)) as Record<string, unknown> | undefined;
          if (!inv) {
            throw Object.assign(new Error('Invoice not found.'), { statusCode: 404 });
          }
          if (String(inv.status) === 'canceled') {
            throw Object.assign(new Error('Invoice is already canceled.'), { statusCode: 400 });
          }

          // Block cancel if any unreversed payment is linked to this invoice
          const netPaidRow = db
            .prepare(
              `SELECT COALESCE(SUM(amount_cents), 0) AS net_paid
               FROM payments
               WHERE invoice_id = ?
                  OR reversed_payment_id IN (SELECT id FROM payments WHERE invoice_id = ?)`,
            )
            .get(String(inv.id), String(inv.id)) as { net_paid: number };

          if (Number(netPaidRow.net_paid) > 0) {
            throw Object.assign(
              new Error('Cannot cancel an invoice with active recorded payments. Reverse the payment first.'),
              { statusCode: 400, code: 'paid_invoice_cancel_blocked' },
            );
          }

          // Block cancel if goods returns already exist
          const retCount = (
            db.prepare(`SELECT COUNT(*) AS cnt FROM goods_returns WHERE invoice_id = ?`).get(String(inv.id)) as {
              cnt: number;
            }
          ).cnt;
          if (retCount > 0) {
            throw Object.assign(
              new Error('Cannot cancel an invoice that already has recorded goods returns.'),
              { statusCode: 400 },
            );
          }

          // Block cancel if linked can movements exist
          const canCount = (
            db.prepare(`SELECT COUNT(*) AS cnt FROM can_movements WHERE invoice_id = ?`).get(String(inv.id)) as {
              cnt: number;
            }
          ).cnt;
          if (canCount > 0) {
            throw Object.assign(
              new Error('Cannot cancel an invoice with linked returnable can movements.'),
              { statusCode: 400, code: 'linked_can_movements_block_cancel' },
            );
          }

          const snap = JSON.parse(String(inv.snapshot_json)) as InvoiceSnapshot;
          const now = getColomboTimestamp();

          // Restore sellable stock for each line
          for (const line of snap.lines) {
            const unitCost =
              line.internalLineCostCents !== undefined
                ? Math.round(line.internalLineCostCents / line.qty)
                : Number(line.internalUnitCostCents ?? 0);
            const batchNumber = getNextBatchNumber(line.productTypeId);
            const batchId = `BAT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
            db.prepare(
              `INSERT INTO stock_batches (id, batch_number, product_type_id, received_qty, remaining_qty, buying_cost_cents, selling_price_cents, note, created_by_id, created_by_name, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              batchId,
              batchNumber,
              line.productTypeId,
              line.qty,
              line.qty,
              unitCost,
              line.unitPriceCents,
              `Restored from canceled ${inv.invoice_number}`,
              req.staff!.id,
              req.staff!.name,
              now,
            );
            db.prepare(`UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE type_id = ?`).run(
              line.qty,
              now,
              line.productTypeId,
            );
            recordStockMovement({
              productTypeId: line.productTypeId,
              batchId,
              batchNumber,
              movementType: 'cancel_restore',
              quantityChange: line.qty,
              note: `Canceled ${inv.invoice_number}: ${cleanReason}`,
              staffId: req.staff!.id,
              staffName: req.staff!.name,
            });
          }

          // Reverse the unpaid debt originally added by this invoice
          const debtAddedCents = Number(inv.invoice_total_cents);
          db.prepare(`UPDATE customers SET balance_cents = balance_cents - ?, updated_at = ? WHERE id = ?`).run(
            debtAddedCents,
            now,
            String(inv.customer_id),
          );

          // Keep immutable invoice row & snapshot; mark status = 'canceled'
          db.prepare(
            `UPDATE invoices SET status = 'canceled', cancel_reason = ?, canceled_at = ? WHERE id = ?`,
          ).run(cleanReason, now, String(inv.id));

          writeAuditLog({
            actorId: req.staff!.id,
            actorName: req.staff!.name,
            actorRole: req.staff!.role,
            action: 'INVOICE_CANCELED',
            entityType: 'invoice',
            entityId: String(inv.id),
            before: { status: 'active' },
            after: { status: 'canceled', invoiceNumber: inv.invoice_number },
            reason: cleanReason,
          });

          return { ok: true, status: 'cancelled' };
        });

        res.json(result);
      } catch (err: any) {
        res
          .status(err?.statusCode || 400)
          .json({ error: err?.message || 'Failed to cancel invoice', code: err?.code });
      }
    },
  );

  // =========================================================================
  // 6. PAYMENTS (Cash & Bank Only, One-Time Reversal / Correction) & CANS
  // =========================================================================
  router.post('/payments/receive', requireAuth, (req: AuthedRequest, res: Response) => {
    const idem = checkIdempotency(req, res, '/payments/receive');
    if (idem.replayed) return;

    const { customer_id, amount, payment_method = 'cash', notes = '' } = req.body ?? {};
    const dbMethod = normalizeMethod(payment_method);
    if (!dbMethod) {
      res.status(400).json({ error: 'Payment method must be Cash or Bank Transfer.', not_posted: true });
      return;
    }

    const parsedAmount = parseMoneyToCents(amount, {
      allowNull: false,
      allowNegative: false,
      fieldName: 'Payment amount',
    });
    if (!parsedAmount.ok) {
      res.status(400).json({ error: parsedAmount.error, code: 'invalid_money', not_posted: true });
      return;
    }
    const amountCents = parsedAmount.cents ?? 0;
    if (!customer_id || amountCents <= 0) {
      res.status(400).json({
        error: 'Customer and a positive payment amount are required.',
        not_posted: true,
      });
      return;
    }

    try {
      const payload = withTransaction(() => {
        const cust = db
          .prepare(`SELECT * FROM customers WHERE id = ?`)
          .get(String(customer_id)) as Record<string, unknown> | undefined;
        if (!cust || Number(cust.is_archived) === 1) {
          throw Object.assign(new Error('Active customer not found.'), { statusCode: 400 });
        }

        const now = getColomboTimestamp();
        const today = getColomboBusinessDate();
        const payId = `PAY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const newBalanceCents = Number(cust.balance_cents) - amountCents;

        db.prepare(
          `INSERT INTO payments (id, customer_id, invoice_id, amount_cents, method, kind, note, staff_id, staff_name, business_date_colombo, created_at)
           VALUES (?, ?, NULL, ?, ?, 'old_debt_collection', ?, ?, ?, ?, ?)`,
        ).run(
          payId,
          String(customer_id),
          amountCents,
          dbMethod,
          String(notes || `Payment via ${dbMethod}`),
          req.staff!.id,
          req.staff!.name,
          today,
          now,
        );

        db.prepare(`UPDATE customers SET balance_cents = ?, updated_at = ? WHERE id = ?`).run(
          newBalanceCents,
          now,
          String(customer_id),
        );

        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: 'PAYMENT_RECEIVED',
          entityType: 'payment',
          entityId: payId,
          before: { balanceCents: Number(cust.balance_cents) },
          after: { amountCents, method: dbMethod, balanceCents: newBalanceCents },
          reason: String(notes || ''),
        });

        const out = {
          payment_id: payId,
          new_balance: Number((newBalanceCents / 100).toFixed(2)),
        };
        saveIdempotency(idem.operationId, req.staff!.id, '/payments/receive', idem.payloadHash, 201, out);
        return out;
      });

      res.status(201).json(payload);
    } catch (err: any) {
      const status = err?.statusCode || 400;
      res.status(status).json({
        error: err?.message || 'Payment failed',
        ...(status >= 400 && status < 500 ? { not_posted: true } : {}),
      });
    }
  });

  router.get('/payments/recent', requireAuth, (req: AuthedRequest, res: Response) => {
    const cid = req.query.customer_id ? String(req.query.customer_id) : null;
    const isEmployee = req.staff!.role === 'employee';
    const rows = isEmployee
      ? cid
        ? (db
            .prepare(
              `SELECT * FROM payments WHERE customer_id = ? AND staff_id = ? ORDER BY created_at DESC LIMIT 30`,
            )
            .all(cid, req.staff!.id) as Array<Record<string, unknown>>)
        : (db
            .prepare(`SELECT * FROM payments WHERE staff_id = ? ORDER BY created_at DESC LIMIT 30`)
            .all(req.staff!.id) as Array<Record<string, unknown>>)
      : cid
        ? (db
            .prepare(`SELECT * FROM payments WHERE customer_id = ? ORDER BY created_at DESC LIMIT 30`)
            .all(cid) as Array<Record<string, unknown>>)
        : (db
            .prepare(`SELECT * FROM payments ORDER BY created_at DESC LIMIT 30`)
            .all() as Array<Record<string, unknown>>);

    const reversedIds = new Set(
      (
        db
          .prepare(`SELECT reversed_payment_id FROM payments WHERE reversed_payment_id IS NOT NULL`)
          .all() as Array<{ reversed_payment_id: string }>
      ).map((r) => String(r.reversed_payment_id)),
    );

    res.json(
      rows.map((p) => {
        const pid = String(p.id);
        const kind = String(p.kind);
        const alreadyReversed = reversedIds.has(pid);
        return {
          payment_id: pid,
          customer_id: String(p.customer_id),
          invoice_id: p.invoice_id ? String(p.invoice_id) : null,
          amount: Number((Number(p.amount_cents) / 100).toFixed(2)),
          method: methodToClient(String(p.method)),
          payment_method: methodToClient(String(p.method)),
          kind,
          notes: String(p.note || ''),
          payment_date: String(p.created_at).slice(0, 16).replace('T', ' '),
          staff_name: String(p.staff_name || 'Staff'),
          can_correct: !isEmployee && kind !== 'reversal' && !alreadyReversed && Number(p.amount_cents) > 0,
        };
      }),
    );
  });

  router.post(
    '/payments/void',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const { payment_id, reason } = req.body ?? {};
      const cleanReason = String(reason || '').trim();
      if (!payment_id || !cleanReason) {
        res.status(400).json({ error: 'Payment ID and reason are required.' });
        return;
      }

      try {
        const result = withTransaction(() => {
          const orig = db
            .prepare(`SELECT * FROM payments WHERE id = ?`)
            .get(String(payment_id)) as Record<string, unknown> | undefined;
          if (!orig) {
            throw Object.assign(new Error('Payment not found.'), { statusCode: 404 });
          }
          if (String(orig.kind) === 'reversal' || Number(orig.amount_cents) <= 0) {
            throw Object.assign(new Error('Reversal entries cannot be reversed again.'), { statusCode: 400 });
          }

          const existingRev = db
            .prepare(`SELECT id FROM payments WHERE reversed_payment_id = ?`)
            .get(String(payment_id));
          if (existingRev) {
            throw Object.assign(
              new Error('This payment has already been reversed once and cannot be reversed again.'),
              { statusCode: 409, code: 'already_reversed' },
            );
          }

          const now = getColomboTimestamp();
          const today = getColomboBusinessDate();
          const revId = `REV-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
          const amountCents = Number(orig.amount_cents);

          db.prepare(
            `INSERT INTO payments (id, customer_id, invoice_id, amount_cents, method, kind, note, reversed_payment_id, staff_id, staff_name, business_date_colombo, created_at)
             VALUES (?, ?, ?, ?, ?, 'reversal', ?, ?, ?, ?, ?, ?)`,
          ).run(
            revId,
            String(orig.customer_id),
            orig.invoice_id ? String(orig.invoice_id) : null,
            -amountCents,
            String(orig.method),
            `Reversal of ${payment_id}: ${cleanReason}`,
            String(payment_id),
            req.staff!.id,
            req.staff!.name,
            today,
            now,
          );

          // Restore debt on customer account
          db.prepare(`UPDATE customers SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?`).run(
            amountCents,
            now,
            String(orig.customer_id),
          );

          writeAuditLog({
            actorId: req.staff!.id,
            actorName: req.staff!.name,
            actorRole: req.staff!.role,
            action: 'PAYMENT_REVERSED',
            entityType: 'payment',
            entityId: String(payment_id),
            after: { reversalId: revId, reversedAmountCents: amountCents },
            reason: cleanReason,
          });

          return { ok: true, reversal_id: revId };
        });

        res.json(result);
      } catch (err: any) {
        res.status(err?.statusCode || 400).json({ error: err?.message || 'Reversal failed', code: err?.code });
      }
    },
  );

  router.post(
    '/payments/correct',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const { payment_id, new_amount, payment_method = 'cash', reason } = req.body ?? {};
      const cleanReason = String(reason || '').trim();
      const dbMethod = normalizeMethod(payment_method);

      if (!payment_id || !cleanReason) {
        res.status(400).json({ error: 'Payment ID and audit reason are required.', not_posted: true });
        return;
      }
      if (!dbMethod) {
        res.status(400).json({
          error: 'Corrected payment method must be Cash or Bank Transfer.',
          not_posted: true,
        });
        return;
      }
      const parsedNewAmount = parseMoneyToCents(new_amount, {
        allowNull: false,
        allowNegative: false,
        fieldName: 'Corrected amount',
      });
      if (!parsedNewAmount.ok) {
        res.status(400).json({ error: parsedNewAmount.error, code: 'invalid_money', not_posted: true });
        return;
      }
      const newAmountCents = parsedNewAmount.cents ?? 0;
      if (newAmountCents <= 0) {
        res.status(400).json({ error: 'Corrected amount must be greater than zero.', not_posted: true });
        return;
      }

      try {
        const result = withTransaction(() => {
          const orig = db
            .prepare(`SELECT * FROM payments WHERE id = ?`)
            .get(String(payment_id)) as Record<string, unknown> | undefined;
          if (!orig) {
            throw Object.assign(new Error('Payment not found.'), { statusCode: 404 });
          }
          if (String(orig.kind) === 'reversal' || Number(orig.amount_cents) <= 0) {
            throw Object.assign(new Error('Reversal entries cannot be corrected.'), { statusCode: 400 });
          }
          const existingRev = db
            .prepare(`SELECT id FROM payments WHERE reversed_payment_id = ?`)
            .get(String(payment_id));
          if (existingRev) {
            throw Object.assign(
              new Error('This payment has already been reversed/corrected once.'),
              { statusCode: 409, code: 'already_reversed' },
            );
          }

          const now = getColomboTimestamp();
          const today = getColomboBusinessDate();
          const oldAmountCents = Number(orig.amount_cents);
          const revId = `REV-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
          const repId = `PAY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

          // 1. Append reversal of original payment
          db.prepare(
            `INSERT INTO payments (id, customer_id, invoice_id, amount_cents, method, kind, note, reversed_payment_id, staff_id, staff_name, business_date_colombo, created_at)
             VALUES (?, ?, ?, ?, ?, 'reversal', ?, ?, ?, ?, ?, ?)`,
          ).run(
            revId,
            String(orig.customer_id),
            orig.invoice_id ? String(orig.invoice_id) : null,
            -oldAmountCents,
            String(orig.method),
            `Reversed for correction: ${cleanReason}`,
            String(payment_id),
            req.staff!.id,
            req.staff!.name,
            today,
            now,
          );

          // 2. Append replacement payment
          db.prepare(
            `INSERT INTO payments (id, customer_id, invoice_id, amount_cents, method, kind, note, staff_id, staff_name, business_date_colombo, created_at)
             VALUES (?, ?, ?, ?, ?, 'replacement', ?, ?, ?, ?, ?)`,
          ).run(
            repId,
            String(orig.customer_id),
            orig.invoice_id ? String(orig.invoice_id) : null,
            newAmountCents,
            dbMethod,
            `Corrected ${payment_id}: ${cleanReason}`,
            req.staff!.id,
            req.staff!.name,
            today,
            now,
          );

          // Adjust balance by delta (+oldAmount - newAmount)
          const balanceDelta = oldAmountCents - newAmountCents;
          db.prepare(`UPDATE customers SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?`).run(
            balanceDelta,
            now,
            String(orig.customer_id),
          );

          writeAuditLog({
            actorId: req.staff!.id,
            actorName: req.staff!.name,
            actorRole: req.staff!.role,
            action: 'PAYMENT_CORRECTED',
            entityType: 'payment',
            entityId: String(payment_id),
            before: { amountCents: oldAmountCents, method: orig.method },
            after: { reversalId: revId, replacementId: repId, amountCents: newAmountCents, method: dbMethod },
            reason: cleanReason,
          });

          return { ok: true, reversal_id: revId, replacement_id: repId };
        });

        res.json(result);
      } catch (err: any) {
        res.status(err?.statusCode || 400).json({ error: err?.message || 'Correction failed', code: err?.code });
      }
    },
  );

  router.post('/containers/movement', requireAuth, (req: AuthedRequest, res: Response) => {
    const idem = checkIdempotency(req, res, '/containers/movement');
    if (idem.replayed) return;

    const { customer_id, type_id, quantity = 0, damaged_quantity = 0, notes = '' } = req.body ?? {};
    const usedQty = Number(quantity || 0);
    const dmgQty = Number(damaged_quantity || 0);
    const totalQty = usedQty + dmgQty;

    if (
      !customer_id ||
      !Number.isInteger(usedQty) ||
      !Number.isInteger(dmgQty) ||
      usedQty < 0 ||
      dmgQty < 0 ||
      totalQty <= 0
    ) {
      res.status(400).json({
        error: 'Enter valid whole counts for used and/or damaged empty cans.',
        not_posted: true,
      });
      return;
    }

    try {
      const payload = withTransaction(() => {
        const holdings = db
          .prepare(`SELECT product_type_id, qty_held FROM customer_can_holdings WHERE customer_id = ? AND qty_held > 0`)
          .all(String(customer_id)) as Array<{ product_type_id: string; qty_held: number }>;

        let targetTypeId = type_id ? String(type_id) : '';
        if (!targetTypeId) {
          if (holdings.length === 1) {
            targetTypeId = String(holdings[0].product_type_id);
          } else {
            throw Object.assign(new Error('Please select which returnable can type is being returned.'), {
              statusCode: 400,
            });
          }
        }

        const heldRow = holdings.find((h) => String(h.product_type_id) === targetTypeId);
        const heldQty = Number(heldRow?.qty_held ?? 0);
        if (totalQty > heldQty) {
          throw Object.assign(
            new Error(`Cannot return ${totalQty} cans; customer only holds ${heldQty} of this type.`),
            { statusCode: 400 },
          );
        }

        const now = getColomboTimestamp();
        const today = getColomboBusinessDate();

        db.prepare(
          `UPDATE customer_can_holdings SET qty_held = qty_held - ?, updated_at = ?
           WHERE customer_id = ? AND product_type_id = ?`,
        ).run(totalQty, now, String(customer_id), targetTypeId);

        // CRITICAL Phase 2 Invariant: Returned empties update used_empties_count / damaged_empties_count
        // and NEVER increment sellable stock_qty!
        if (usedQty > 0) {
          db.prepare(
            `UPDATE products SET used_empties_count = COALESCE(used_empties_count, 0) + ?, updated_at = ? WHERE type_id = ?`,
          ).run(usedQty, now, targetTypeId);
          db.prepare(
            `INSERT INTO can_movements (id, customer_id, product_type_id, movement_type, qty, invoice_id, note, staff_id, staff_name, business_date_colombo, created_at)
             VALUES (?, ?, ?, 'returned_used', ?, NULL, ?, ?, ?, ?, ?)`,
          ).run(
            `CAN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
            String(customer_id),
            targetTypeId,
            usedQty,
            String(notes || 'Used empty cans returned'),
            req.staff!.id,
            req.staff!.name,
            today,
            now,
          );
        }

        if (dmgQty > 0) {
          db.prepare(
            `UPDATE products SET damaged_empties_count = COALESCE(damaged_empties_count, 0) + ?, updated_at = ? WHERE type_id = ?`,
          ).run(dmgQty, now, targetTypeId);
          db.prepare(
            `INSERT INTO can_movements (id, customer_id, product_type_id, movement_type, qty, invoice_id, note, staff_id, staff_name, business_date_colombo, created_at)
             VALUES (?, ?, ?, 'returned_damaged', ?, NULL, ?, ?, ?, ?, ?)`,
          ).run(
            `CAN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
            String(customer_id),
            targetTypeId,
            dmgQty,
            String(notes || 'Damaged empty cans returned'),
            req.staff!.id,
            req.staff!.name,
            today,
            now,
          );
        }

        const totalRemainingRow = db
          .prepare(`SELECT COALESCE(SUM(qty_held), 0) AS total_held FROM customer_can_holdings WHERE customer_id = ?`)
          .get(String(customer_id)) as { total_held: number };

        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: 'EMPTY_CANS_RETURNED',
          entityType: 'customer',
          entityId: String(customer_id),
          after: {
            productTypeId: targetTypeId,
            usedReturned: usedQty,
            damagedReturned: dmgQty,
            remainingHeld: Number(totalRemainingRow.total_held),
          },
          reason: String(notes || ''),
        });

        const out = {
          ok: true,
          held: Number(totalRemainingRow.total_held),
          new_cans_balance: Number(totalRemainingRow.total_held),
        };
        saveIdempotency(idem.operationId, req.staff!.id, '/containers/movement', idem.payloadHash, 200, out);
        return out;
      });

      res.json(payload);
    } catch (err: any) {
      const status = err?.statusCode || 400;
      res.status(status).json({
        error: err?.message || 'Can return failed',
        ...(status >= 400 && status < 500 ? { not_posted: true } : {}),
      });
    }
  });

  // =========================================================================
  // 7. INVOICES & REPORTS (Employee Own-Invoice Isolation + Signed Gross Profit)
  // =========================================================================
  router.get('/invoices/list', requireAuth, (req: AuthedRequest, res: Response) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const dateFilter = String(req.query.date_filter || 'all');
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
    const isEmployee = req.staff!.role === 'employee';

    const today = getColomboBusinessDate();
    const yesterday = getColomboBusinessDate(new Date(Date.now() - 86400000));

    let sql = `SELECT i.*, c.name AS customer_name_live
               FROM invoices i
               JOIN customers c ON c.id = i.customer_id
               WHERE 1 = 1`;
    const params: Array<string | number> = [];

    if (isEmployee) {
      sql += ` AND i.staff_id = ?`;
      params.push(req.staff!.id);
    }
    if (dateFilter === 'today') {
      sql += ` AND i.business_date_colombo = ?`;
      params.push(today);
    } else if (dateFilter === 'yesterday') {
      sql += ` AND i.business_date_colombo = ?`;
      params.push(yesterday);
    }

    sql += ` ORDER BY i.created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    const mapped = rows
      .map((r) => {
        const snap = JSON.parse(String(r.snapshot_json)) as InvoiceSnapshot;
        return {
          id: String(r.id),
          invoice_number: String(r.invoice_number),
          customer_name: snap.customerName || String(r.customer_name_live || ''),
          made_by: String(r.staff_name || 'Staff'),
          date: String(r.business_date_colombo),
          total: Number((Number(r.invoice_total_cents) / 100).toFixed(2)),
          due: Number((Number(r.invoice_due_cents) / 100).toFixed(2)),
          status: String(r.status) === 'canceled' ? 'cancelled' : 'completed',
        };
      })
      .filter(
        (inv) =>
          !q ||
          inv.invoice_number.toLowerCase().includes(q) ||
          inv.customer_name.toLowerCase().includes(q),
      );

    res.json(mapped);
  });

  router.get('/invoices/details/:invoiceNumber', requireAuth, (req: AuthedRequest, res: Response) => {
    const key = String(req.params.invoiceNumber);
    const row = db
      .prepare(`SELECT * FROM invoices WHERE invoice_number = ? OR id = ?`)
      .get(key, key) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ error: 'Invoice not found.' });
      return;
    }

    if (req.staff!.role === 'employee' && String(row.staff_id) !== req.staff!.id) {
      res.status(403).json({ error: 'Employees can only view invoices they created.' });
      return;
    }

    res.json(buildReceiptFromInvoiceRow(row));
  });

  router.get(
    '/reports/summary',
    requireAuth,
    requireRole('owner', 'manager'),
    (req: AuthedRequest, res: Response) => {
      const period = String(req.query.period || 'this_month');
      const { fromDate, toDate } = computeColomboDateRange(
        period,
        req.query.from_date ? String(req.query.from_date) : undefined,
        req.query.to_date ? String(req.query.to_date) : undefined,
      );

      const invAgg = db
        .prepare(
          `SELECT COUNT(*) AS bill_count,
                  COALESCE(SUM(invoice_total_cents), 0) AS gross_sales,
                  COALESCE(SUM(total_internal_cost_cents), 0) AS total_cost
           FROM invoices
           WHERE status = 'active'
             AND business_date_colombo >= ?
             AND business_date_colombo <= ?`,
        )
        .get(fromDate, toDate) as { bill_count: number; gross_sales: number; total_cost: number };

      const retAgg = db
        .prepare(
          `SELECT COUNT(*) AS ret_count,
                  COALESCE(SUM(credit_cents), 0) AS ret_credit,
                  COALESCE(SUM(cost_reversed_cents), 0) AS ret_cost
           FROM goods_returns
           WHERE business_date_colombo >= ?
             AND business_date_colombo <= ?`,
        )
        .get(fromDate, toDate) as { ret_count: number; ret_credit: number; ret_cost: number };

      const payAgg = db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN method = 'cash' THEN amount_cents ELSE 0 END), 0) AS cash_cents,
                  COALESCE(SUM(CASE WHEN method = 'bank_transfer' THEN amount_cents ELSE 0 END), 0) AS bank_cents
           FROM payments
           WHERE business_date_colombo >= ?
             AND business_date_colombo <= ?`,
        )
        .get(fromDate, toDate) as { cash_cents: number; bank_cents: number };

      const netSalesCents = Number(invAgg.gross_sales) - Number(retAgg.ret_credit);
      const historicalCostCents = Number(invAgg.total_cost) - Number(retAgg.ret_cost);
      // SIGNED UNCLAMPED GROSS PROFIT (can be negative!)
      const signedProfitCents = netSalesCents - historicalCostCents;
      const cashCents = Number(payAgg.cash_cents);
      const bankCents = Number(payAgg.bank_cents);

      res.json({
        from_date: fromDate,
        to_date: toDate,
        net_sales: Number((netSalesCents / 100).toFixed(2)),
        collections: Number(((cashCents + bankCents) / 100).toFixed(2)),
        cash_collections: Number((cashCents / 100).toFixed(2)),
        bank_collections: Number((bankCents / 100).toFixed(2)),
        historical_cost: Number((historicalCostCents / 100).toFixed(2)),
        profit: Number((signedProfitCents / 100).toFixed(2)),
        bill_count: Number(invAgg.bill_count),
        returns_count: Number(retAgg.ret_count),
        returns_amount: Number((Number(retAgg.ret_credit) / 100).toFixed(2)),
      });
    },
  );

  // =========================================================================
  // 8. OWNER-ONLY ADMIN: STAFF, SHOP DETAILS & IMMUTABLE AUDIT LOG
  // =========================================================================
  router.get('/staff', requireAuth, requireRole('owner'), (_req: AuthedRequest, res: Response) => {
    const rows = db
      .prepare(
        `SELECT id, name, name_ta, role, is_active, locked_until_ms
         FROM staff
         ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, name ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    res.json(
      rows.map((r) => {
        const lockedUntilMs =
          typeof r.locked_until_ms === 'number' && r.locked_until_ms > Date.now()
            ? r.locked_until_ms
            : null;
        return {
          id: String(r.id),
          name: String(r.name),
          name_ta: String(r.name_ta || ''),
          role: r.role as StaffRole,
          is_active: Number(r.is_active) === 1,
          is_locked: lockedUntilMs !== null,
          locked_until_ms: lockedUntilMs,
        };
      }),
    );
  });

  router.post('/staff', requireAuth, requireRole('owner'), (req: AuthedRequest, res: Response) => {
    const { name, name_ta = '', role = 'employee', pin } = req.body ?? {};
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      res.status(400).json({ error: 'Staff name is required.' });
      return;
    }
    if (!['owner', 'manager', 'employee'].includes(String(role))) {
      res.status(400).json({ error: 'Invalid role.' });
      return;
    }
    if (!/^\d{4,8}$/.test(String(pin || ''))) {
      res.status(400).json({ error: 'PIN must be 4 to 8 numeric digits.' });
      return;
    }

    const created = withTransaction(() => {
      const id = `STF-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const now = getColomboTimestamp();
      const { salt, hash } = hashPin(String(pin));

      db.prepare(
        `INSERT INTO staff (id, name, name_ta, role, pin_salt, pin_hash, is_active, failed_attempts, locked_until_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)`,
      ).run(id, cleanName, String(name_ta || '').trim(), String(role), salt, hash, now, now);

      writeAuditLog({
        actorId: req.staff!.id,
        actorName: req.staff!.name,
        actorRole: req.staff!.role,
        action: 'STAFF_CREATED',
        entityType: 'staff',
        entityId: id,
        after: { name: cleanName, role },
      });

      return { id, name: cleanName, name_ta: String(name_ta || '').trim(), role, is_active: true };
    });

    res.status(201).json(created);
  });

  router.put('/staff/:id', requireAuth, requireRole('owner'), (req: AuthedRequest, res: Response) => {
    const targetId = String(req.params.id);
    const target = db
      .prepare(`SELECT * FROM staff WHERE id = ?`)
      .get(targetId) as Record<string, unknown> | undefined;
    if (!target) {
      res.status(404).json({ error: 'Staff member not found.' });
      return;
    }

    const nextRole =
      req.body?.role !== undefined && ['owner', 'manager', 'employee'].includes(String(req.body.role))
        ? (String(req.body.role) as StaffRole)
        : (target.role as StaffRole);
    const nextActive =
      req.body?.is_active !== undefined ? (req.body.is_active ? 1 : 0) : Number(target.is_active);

    // Block removing or deactivating the last active Owner
    if (String(target.role) === 'owner' && (nextRole !== 'owner' || nextActive === 0)) {
      const otherOwners = (
        db
          .prepare(`SELECT COUNT(*) AS cnt FROM staff WHERE role = 'owner' AND is_active = 1 AND id != ?`)
          .get(targetId) as { cnt: number }
      ).cnt;
      if (otherOwners === 0) {
        res.status(400).json({ error: 'Cannot disable or demote the last active Owner account.' });
        return;
      }
    }

    withTransaction(() => {
      db.prepare(`UPDATE staff SET role = ?, is_active = ?, updated_at = ? WHERE id = ?`).run(
        nextRole,
        nextActive,
        getColomboTimestamp(),
        targetId,
      );

      // Immediately revoke active sessions on role change or deactivation!
      if (nextRole !== target.role || nextActive === 0) {
        revokeAllSessionsForStaff(targetId);
      }

      writeAuditLog({
        actorId: req.staff!.id,
        actorName: req.staff!.name,
        actorRole: req.staff!.role,
        action: 'STAFF_UPDATED',
        entityType: 'staff',
        entityId: targetId,
        before: { role: target.role, isActive: Number(target.is_active) === 1 },
        after: { role: nextRole, isActive: nextActive === 1 },
      });
    });

    res.json({ ok: true, id: targetId, role: nextRole, is_active: nextActive === 1 });
  });

  router.post(
    '/staff/:id/reset-pin',
    requireAuth,
    requireRole('owner'),
    (req: AuthedRequest, res: Response) => {
      const targetId = String(req.params.id);
      const pinStr = String(req.body?.pin || '');
      if (!/^\d{4,8}$/.test(pinStr)) {
        res.status(400).json({ error: 'New PIN must be 4 to 8 numeric digits.' });
        return;
      }

      const target = db
        .prepare(`SELECT * FROM staff WHERE id = ?`)
        .get(targetId) as Record<string, unknown> | undefined;
      if (!target) {
        res.status(404).json({ error: 'Staff member not found.' });
        return;
      }

      withTransaction(() => {
        const { salt, hash } = hashPin(pinStr);
        db.prepare(
          `UPDATE staff SET pin_salt = ?, pin_hash = ?, failed_attempts = 0, locked_until_ms = NULL, updated_at = ? WHERE id = ?`,
        ).run(salt, hash, getColomboTimestamp(), targetId);

        revokeAllSessionsForStaff(targetId);

        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: 'STAFF_PIN_RESET',
          entityType: 'staff',
          entityId: targetId,
          after: { sessionsRevoked: true, lockoutCleared: true },
        });
      });

      res.json({ ok: true });
    },
  );

  router.get('/shop-details', requireAuth, (_req: AuthedRequest, res: Response) => {
    const s = getShopDetails();
    res.json({
      name_en: s.nameEn,
      name_ta: s.nameTa,
      address_en: s.addressEn,
      address_ta: s.addressTa,
      phone: s.phone,
      tax_id: s.taxId,
    });
  });

  router.put(
    '/shop-details',
    requireAuth,
    requireRole('owner'),
    (req: AuthedRequest, res: Response) => {
      const {
        name_en = '',
        name_ta = '',
        address_en = '',
        address_ta = '',
        phone = '',
        tax_id = '',
      } = req.body ?? {};

      const before = getShopDetails();
      const now = getColomboTimestamp();

      withTransaction(() => {
        db.prepare(
          `UPDATE shop_details
           SET name_en = ?, name_ta = ?, address_en = ?, address_ta = ?, phone = ?, tax_id = ?, updated_at = ?
           WHERE id = 1`,
        ).run(
          String(name_en).trim(),
          String(name_ta).trim(),
          String(address_en).trim(),
          String(address_ta).trim(),
          String(phone).trim(),
          String(tax_id).trim(),
          now,
        );

        writeAuditLog({
          actorId: req.staff!.id,
          actorName: req.staff!.name,
          actorRole: req.staff!.role,
          action: 'SHOP_DETAILS_UPDATED',
          entityType: 'shop_details',
          entityId: '1',
          before,
          after: {
            name_en: String(name_en).trim(),
            name_ta: String(name_ta).trim(),
            address_en: String(address_en).trim(),
            address_ta: String(address_ta).trim(),
            phone: String(phone).trim(),
            tax_id: String(tax_id).trim(),
          },
        });
      });

      const updated = getShopDetails();
      res.json({
        name_en: updated.nameEn,
        name_ta: updated.nameTa,
        address_en: updated.addressEn,
        address_ta: updated.addressTa,
        phone: updated.phone,
        tax_id: updated.taxId,
      });
    },
  );

  router.get('/audit-log', requireAuth, requireRole('owner'), (req: AuthedRequest, res: Response) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
    const rows = db
      .prepare(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    res.json(rows.map(mapAuditRow));
  });

  return router;
}
