/**
 * Client-side IndexedDB persistence for idempotent financial operations.
 * Scoped by shopScope and staffId.
 * NEVER stores PINs, credentials, or auth tokens.
 */

export interface PendingOperationMeta {
  customerId?: string;
  customerName?: string;
  customerNameTa?: string;
  amount?: number;
  summary?: string;
}

export interface PendingOperationRecord {
  operationId: string;
  shopScope: string;
  staffId: string;
  endpoint: string;
  payload: Record<string, unknown>;
  meta?: PendingOperationMeta;
  createdAt: string;
}

export type SettlementStepStatus = 'pending' | 'confirmed' | 'rejected';

export interface SettlementMoneyPart {
  operationId: string;
  endpoint: '/payments/receive';
  payload: {
    customer_id: string;
    amount: number;
    payment_method: 'cash' | 'bank';
    notes: string;
  };
  status: SettlementStepStatus;
  error?: string | null;
  paymentId?: string | null;
  newBalance?: number | null;
}

export interface SettlementCansPart {
  operationId: string;
  endpoint: '/containers/movement';
  payload: {
    customer_id: string;
    quantity: number;
    damaged_quantity: number;
    action: 'return';
    type_id?: string;
    notes: string;
  };
  status: SettlementStepStatus;
  error?: string | null;
  newCansBalance?: number | null;
}

export interface PendingSettlementRecord {
  settlementId: string;
  shopScope: string;
  staffId: string;
  customerId: string;
  customerName: string;
  customerNameTa?: string;
  createdAt: string;
  money?: SettlementMoneyPart;
  cans?: SettlementCansPart;
}

const DB_NAME = 'wholesale_water_retry_queue_v2';
const DB_VERSION = 2;
const STORE_NAME = 'pending_operations';
const SETTLEMENT_STORE_NAME = 'pending_settlements';

function openQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(STORE_NAME)) {
        idb.createObjectStore(STORE_NAME, { keyPath: 'operationId' });
      }
      if (!idb.objectStoreNames.contains(SETTLEMENT_STORE_NAME)) {
        idb.createObjectStore(SETTLEMENT_STORE_NAME, { keyPath: 'settlementId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

export async function savePendingOperation(op: PendingOperationRecord): Promise<void> {
  try {
    const idb = await openQueueDb();
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(op);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    idb.close();
  } catch {
    // Non-fatal if browser restricts IndexedDB in sandboxed mode
  }
}

export async function clearPendingOperation(operationId: string): Promise<void> {
  try {
    const idb = await openQueueDb();
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(operationId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    idb.close();
  } catch {
    // ignore
  }
}

export async function listPendingOperations(
  staffId: string,
  shopScope = 'local-shop',
): Promise<PendingOperationRecord[]> {
  try {
    const idb = await openQueueDb();
    const all = await new Promise<PendingOperationRecord[]>((resolve, reject) => {
      const tx = idb.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as PendingOperationRecord[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    idb.close();
    return all
      .filter((op) => op.staffId === staffId && op.shopScope === shopScope)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}

export async function savePendingSettlement(settlement: PendingSettlementRecord): Promise<void> {
  try {
    const idb = await openQueueDb();
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(SETTLEMENT_STORE_NAME, 'readwrite');
      tx.objectStore(SETTLEMENT_STORE_NAME).put(settlement);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    idb.close();
  } catch {
    // Non-fatal if browser restricts IndexedDB in sandboxed mode
  }
}

export async function clearPendingSettlement(settlementId: string): Promise<void> {
  try {
    const idb = await openQueueDb();
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(SETTLEMENT_STORE_NAME, 'readwrite');
      tx.objectStore(SETTLEMENT_STORE_NAME).delete(settlementId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    idb.close();
  } catch {
    // ignore
  }
}

export async function listPendingSettlements(
  staffId: string,
  shopScope = 'local-shop',
): Promise<PendingSettlementRecord[]> {
  try {
    const idb = await openQueueDb();
    const all = await new Promise<PendingSettlementRecord[]>((resolve, reject) => {
      const tx = idb.transaction(SETTLEMENT_STORE_NAME, 'readonly');
      const req = tx.objectStore(SETTLEMENT_STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as PendingSettlementRecord[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    idb.close();
    return all
      .filter((s) => s.staffId === staffId && s.shopScope === shopScope)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}
