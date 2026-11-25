import { api, ApiError } from './api';
import {
  clearPendingOperation as idbClear,
  clearPendingSettlement as idbClearSettlement,
  listPendingOperations,
  listPendingSettlements,
  savePendingOperation,
  savePendingSettlement,
  type PendingOperationMeta,
  type PendingOperationRecord,
  type PendingSettlementRecord,
  type SettlementCansPart,
  type SettlementMoneyPart,
} from '../lib/retryQueue';

export type {
  PendingOperationMeta,
  PendingOperationRecord,
  PendingSettlementRecord,
  SettlementCansPart,
  SettlementMoneyPart,
};

/**
 * Synchronous in-memory mirror backed by IndexedDB (`src/lib/retryQueue.ts`).
 * Stores ONLY business operation payloads + client operationIds scoped by staffId.
 * NEVER stores PINs, Bearer tokens, or auth credentials.
 */
const pendingMap = new Map<string, PendingOperationRecord>();
const settlementMap = new Map<string, PendingSettlementRecord>();
let activeScopeStaffId = 'default';
let hydratedForStaff: string | null = null;
let hydrationState: 'idle' | 'hydrating' | 'ready' = 'idle';
let hydrationPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  listeners.forEach((fn) => fn());
}

export function subscribePendingOps(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function makeKey(endpoint: string, staffId: string): string {
  return `${staffId}::${endpoint}`;
}

export function isPendingQueueReady(): boolean {
  return hydrationState === 'ready' && hydratedForStaff === activeScopeStaffId;
}

export async function hydratePendingOperations(staffId: string): Promise<void> {
  const targetStaff = staffId || 'default';
  if (hydrationState === 'ready' && hydratedForStaff === targetStaff) return;
  if (hydrationState === 'hydrating' && activeScopeStaffId === targetStaff && hydrationPromise) {
    return hydrationPromise;
  }

  activeScopeStaffId = targetStaff;
  hydrationState = 'hydrating';
  hydratedForStaff = null;
  pendingMap.clear();
  settlementMap.clear();
  notifyListeners();

  hydrationPromise = (async () => {
    try {
      const [records, settlements] = await Promise.all([
        listPendingOperations(targetStaff),
        listPendingSettlements(targetStaff),
      ]);
      if (activeScopeStaffId !== targetStaff) return;
      for (const rec of records) {
        pendingMap.set(makeKey(rec.endpoint, rec.staffId), rec);
      }
      if (settlements.length > 0) {
        settlementMap.set(targetStaff, settlements[0]);
      }
    } catch {
      // IndexedDB unavailable in restricted environment; in-memory map still works
    } finally {
      if (activeScopeStaffId === targetStaff) {
        hydratedForStaff = targetStaff;
        hydrationState = 'ready';
        notifyListeners();
      }
    }
  })();

  return hydrationPromise;
}

export function resetPendingCacheOnLogout(): void {
  pendingMap.clear();
  settlementMap.clear();
  hydratedForStaff = null;
  hydrationState = 'idle';
  hydrationPromise = null;
  notifyListeners();
}

export function hasPendingOperation(endpoint: string, _token?: string): boolean {
  return pendingMap.has(makeKey(endpoint, activeScopeStaffId));
}

export function getPendingOperation(endpoint: string): PendingOperationRecord | undefined {
  return pendingMap.get(makeKey(endpoint, activeScopeStaffId));
}

export function getPendingSettlement(): PendingSettlementRecord | undefined {
  return settlementMap.get(activeScopeStaffId);
}

export async function discardPendingOperation(endpoint: string): Promise<void> {
  const key = makeKey(endpoint, activeScopeStaffId);
  const existing = pendingMap.get(key);
  pendingMap.delete(key);
  if (existing) {
    await idbClear(existing.operationId).catch(() => {});
  }
  notifyListeners();
}

/**
 * Only clear a pending record when the server explicitly proves nothing posted
 * for that operation (`not_posted: true`). NEVER decide from HTTP status alone:
 * timeouts, lost responses, 5xx, 401/423 auth/lockout, and 409 idempotency_conflict
 * keep the pending record intact so the original operationId can be resolved safely.
 */
export function isDefinitiveNotPosted(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.notPosted === true &&
    err.code !== 'idempotency_conflict'
  );
}

function createOperationId(prefix = 'OP'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function submitOnce<T>(
  endpoint: string,
  payload: Record<string, unknown>,
  token: string,
  meta?: PendingOperationMeta,
): Promise<T> {
  if (!isPendingQueueReady()) {
    throw new ApiError(
      'Recovering previous pending operations. Please wait a moment and try again.',
      0,
      'queue_not_ready',
    );
  }

  const key = makeKey(endpoint, activeScopeStaffId);
  const existing = pendingMap.get(key);
  if (existing) {
    throw new ApiError(
      'A previous submission is still awaiting confirmation. Retry it before submitting a new one.',
      409,
      'pending_operation_exists',
    );
  }

  const record: PendingOperationRecord = {
    operationId: createOperationId('OP'),
    staffId: activeScopeStaffId,
    shopScope: 'local-shop',
    endpoint,
    payload,
    meta,
    createdAt: new Date().toISOString(),
  };

  pendingMap.set(key, record);
  await savePendingOperation(record).catch(() => {});
  notifyListeners();

  try {
    const response = await api.post<T>(endpoint, record.payload, token, record.operationId);
    pendingMap.delete(key);
    await idbClear(record.operationId).catch(() => {});
    notifyListeners();
    return response;
  } catch (err) {
    if (isDefinitiveNotPosted(err)) {
      pendingMap.delete(key);
      await idbClear(record.operationId).catch(() => {});
      notifyListeners();
    }
    throw err;
  }
}

export async function retryOperation<T>(endpoint: string, token: string): Promise<T> {
  if (!isPendingQueueReady()) {
    throw new ApiError(
      'Recovering previous pending operations. Please wait a moment and try again.',
      0,
      'queue_not_ready',
    );
  }

  const key = makeKey(endpoint, activeScopeStaffId);
  const existing = pendingMap.get(key);
  if (!existing) {
    throw new ApiError('No pending operation found to retry.', 404, 'no_pending_op');
  }
  try {
    const response = await api.post<T>(endpoint, existing.payload, token, existing.operationId);
    pendingMap.delete(key);
    await idbClear(existing.operationId).catch(() => {});
    notifyListeners();
    return response;
  } catch (err) {
    if (isDefinitiveNotPosted(err)) {
      pendingMap.delete(key);
      await idbClear(existing.operationId).catch(() => {});
      notifyListeners();
    }
    throw err;
  }
}

// =========================================================================
// Combined Money + Empty Cans Settlement Recovery (2.3)
// =========================================================================

export interface SettlementIntentInput {
  customerId: string;
  customerName: string;
  customerNameTa?: string;
  money?: {
    amount: number;
    payment_method: 'cash' | 'bank';
    notes: string;
  };
  cans?: {
    quantity: number;
    damaged_quantity: number;
    type_id?: string;
    notes: string;
  };
}

export interface SettlementExecutionResult {
  record: PendingSettlementRecord;
  cleared: boolean;
  fullyConfirmed: boolean;
  moneyJustConfirmed: boolean;
  cansJustConfirmed: boolean;
  moneyError?: string | null;
  cansError?: string | null;
}

async function persistSettlement(record: PendingSettlementRecord): Promise<void> {
  const clone: PendingSettlementRecord = {
    ...record,
    money: record.money ? { ...record.money } : undefined,
    cans: record.cans ? { ...record.cans } : undefined,
  };
  settlementMap.set(record.staffId, clone);
  await savePendingSettlement(clone).catch(() => {});
  notifyListeners();
}

async function clearSettlementState(record: PendingSettlementRecord): Promise<void> {
  settlementMap.delete(record.staffId);
  await idbClearSettlement(record.settlementId).catch(() => {});
  notifyListeners();
}

async function executeSettlementSteps(
  initialRecord: PendingSettlementRecord,
  token: string,
): Promise<SettlementExecutionResult> {
  const record: PendingSettlementRecord = {
    ...initialRecord,
    money: initialRecord.money ? { ...initialRecord.money } : undefined,
    cans: initialRecord.cans ? { ...initialRecord.cans } : undefined,
  };

  let moneyJustConfirmed = false;
  let cansJustConfirmed = false;
  let moneyUnresolved = false;

  // Step 1: Money part (if pending)
  if (record.money && record.money.status === 'pending') {
    try {
      const res = await api.post<{ payment_id?: string; new_balance?: number }>(
        record.money.endpoint,
        record.money.payload,
        token,
        record.money.operationId,
      );
      record.money.status = 'confirmed';
      record.money.error = null;
      record.money.paymentId = res?.payment_id ?? null;
      record.money.newBalance = res?.new_balance !== undefined ? Number(res.new_balance) : null;
      moneyJustConfirmed = true;
      // Persist confirmed payment progress BEFORE starting cans request
      await persistSettlement(record);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Payment collection failed';
      if (isDefinitiveNotPosted(err)) {
        record.money.status = 'rejected';
        record.money.error = msg;
        await persistSettlement(record);
      } else {
        // Unresolved (lost response, timeout, 5xx, etc.): keep original money operationId pending
        // and stop before starting cans so money is resolved under its original ID first.
        record.money.error = msg;
        moneyUnresolved = true;
        await persistSettlement(record);
      }
    }
  }

  // Step 2: Cans part (only when money is not in an unresolved lost-response state)
  if (!moneyUnresolved && record.cans && record.cans.status === 'pending') {
    try {
      const res = await api.post<{ held?: number; new_cans_balance?: number }>(
        record.cans.endpoint,
        record.cans.payload,
        token,
        record.cans.operationId,
      );
      record.cans.status = 'confirmed';
      record.cans.error = null;
      record.cans.newCansBalance =
        res && (res.held !== undefined || res.new_cans_balance !== undefined)
          ? Number(res.held ?? res.new_cans_balance)
          : null;
      cansJustConfirmed = true;
      await persistSettlement(record);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Can return failed';
      if (isDefinitiveNotPosted(err)) {
        record.cans.status = 'rejected';
        record.cans.error = msg;
      } else {
        record.cans.error = msg;
      }
      await persistSettlement(record);
    }
  }

  const parts = [record.money, record.cans].filter(Boolean) as Array<{ status: string }>;
  const hasPending = parts.some((p) => p.status === 'pending');
  const hasConfirmed = parts.some((p) => p.status === 'confirmed');
  const allConfirmed = parts.length > 0 && parts.every((p) => p.status === 'confirmed');
  const allRejected = parts.length > 0 && parts.every((p) => p.status === 'rejected');

  let cleared = false;
  if (allConfirmed || allRejected) {
    await clearSettlementState(record);
    cleared = true;
  } else if (!hasPending && hasConfirmed) {
    // Partial confirmed + definitive rejection: keep persisted so cashier sees what saved & what was rejected
    await persistSettlement(record);
  }

  return {
    record,
    cleared,
    fullyConfirmed: allConfirmed,
    moneyJustConfirmed,
    cansJustConfirmed,
    moneyError: record.money?.error ?? null,
    cansError: record.cans?.error ?? null,
  };
}

export async function startSettlement(
  intent: SettlementIntentInput,
  token: string,
): Promise<SettlementExecutionResult> {
  if (!isPendingQueueReady()) {
    throw new ApiError(
      'Recovering previous pending operations. Please wait a moment and try again.',
      0,
      'queue_not_ready',
    );
  }

  if (
    settlementMap.has(activeScopeStaffId) ||
    hasPendingOperation('/payments/receive') ||
    hasPendingOperation('/containers/movement')
  ) {
    throw new ApiError(
      'A previous settlement is still awaiting confirmation. Complete or resolve it before starting a new one.',
      409,
      'pending_settlement_exists',
    );
  }

  const record: PendingSettlementRecord = {
    settlementId: createOperationId('SET'),
    shopScope: 'local-shop',
    staffId: activeScopeStaffId,
    customerId: intent.customerId,
    customerName: intent.customerName,
    customerNameTa: intent.customerNameTa,
    createdAt: new Date().toISOString(),
    money: intent.money
      ? {
          operationId: createOperationId('PAY'),
          endpoint: '/payments/receive',
          payload: {
            customer_id: intent.customerId,
            amount: intent.money.amount,
            payment_method: intent.money.payment_method,
            notes: intent.money.notes,
          },
          status: 'pending',
        }
      : undefined,
    cans: intent.cans
      ? {
          operationId: createOperationId('CAN'),
          endpoint: '/containers/movement',
          payload: {
            customer_id: intent.customerId,
            quantity: intent.cans.quantity,
            damaged_quantity: intent.cans.damaged_quantity,
            action: 'return',
            ...(intent.cans.type_id ? { type_id: intent.cans.type_id } : {}),
            notes: intent.cans.notes,
          },
          status: 'pending',
        }
      : undefined,
  };

  // Persist the complete intent and BOTH operation IDs before sending either request
  await persistSettlement(record);
  return executeSettlementSteps(record, token);
}

export async function recoverSettlement(token: string): Promise<SettlementExecutionResult> {
  if (!isPendingQueueReady()) {
    throw new ApiError(
      'Recovering previous pending operations. Please wait a moment and try again.',
      0,
      'queue_not_ready',
    );
  }

  const existing = settlementMap.get(activeScopeStaffId);
  if (!existing) {
    throw new ApiError('No pending settlement found to recover.', 404, 'no_pending_settlement');
  }

  return executeSettlementSteps(existing, token);
}

export async function dismissResolvedSettlement(): Promise<void> {
  const existing = settlementMap.get(activeScopeStaffId);
  if (!existing) return;
  const parts = [existing.money, existing.cans].filter(Boolean) as Array<{ status: string }>;
  // Never discard while any step is still unconfirmed/pending!
  if (parts.some((p) => p.status === 'pending')) {
    throw new ApiError(
      'Cannot dismiss while an unconfirmed settlement step is still pending.',
      409,
      'pending_step_cannot_dismiss',
    );
  }
  await clearSettlementState(existing);
}
