export type StaffRole = 'owner' | 'manager' | 'employee';
export type Language = 'en' | 'ta';
export type PaymentMethod = 'cash' | 'bank_transfer';
export type SoldByUnit = 'bottle' | 'can' | 'case' | 'pack' | 'unit';
export type StarterSlotKey =
  | '500ML'
  | '1L'
  | '1.5L'
  | '5L'
  | '19L_FILLED'
  | '19L_EMPTY';

export interface StaffMember {
  id: string;
  name: string;
  nameTa: string;
  role: StaffRole;
  isActive: boolean;
  isLocked: boolean;
  lockedUntilMs: number | null;
  createdAt: string;
}

export interface AuthSession {
  token: string;
  staff: StaffMember;
  isTrialMode: boolean;
}

export interface ProductVariant {
  typeId: string;
  sku: string;
  nameEn: string;
  nameTa: string;
  soldBy: SoldByUnit;
  sellingPriceCents: number | null;
  defaultBuyingCostCents?: number | null; // Stripped for employee
  isReturnable: boolean;
  stockQty: number;
  lowStockThreshold: number;
  usedEmptiesCount: number | null; // null => "Not counted"
  damagedEmptiesCount: number | null; // null => "Not counted"
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StockBatch {
  id: string;
  productTypeId: string;
  receivedQty: number;
  remainingQty: number;
  buyingCostCents?: number; // Stripped for employee
  note: string;
  createdByName: string;
  createdAt: string;
}

export interface StarterSlotBinding {
  slotKey: StarterSlotKey;
  productTypeId: string | null;
  excludedTypeIds: string[];
}

export interface StarterSlotDefinition {
  slotKey: StarterSlotKey;
  labelEn: string;
  labelTa: string;
  canonicalSku: string;
  legacySkuAliases: string[];
  acceptedNamesEn: string[];
  soldBy: SoldByUnit;
  defaultNameEn: string;
  defaultNameTa: string;
  defaultReturnable: boolean;
}

export type StarterSlotStatus =
  | 'matched'
  | 'missing'
  | 'archived'
  | 'conflict'
  | 'ambiguous';

export interface StarterSlotResolution {
  definition: StarterSlotDefinition;
  status: StarterSlotStatus;
  variant: ProductVariant | null;
  candidates: ProductVariant[];
  conflictReason: string | null;
}

export interface CustomerCanHolding {
  productTypeId: string;
  productNameEn: string;
  productNameTa: string;
  sku: string;
  qtyHeld: number;
}

export interface Customer {
  id: string;
  name: string;
  nameTa: string;
  phone: string;
  address: string;
  balanceCents: number; // positive = customer owes shop, negative = shop owes customer (account credit)
  isArchived: boolean;
  cansHeld: CustomerCanHolding[];
  createdAt: string;
  updatedAt: string;
}

export interface ShopDetails {
  nameEn: string;
  nameTa: string;
  addressEn: string;
  addressTa: string;
  phone: string;
  taxId: string;
  updatedAt: string | null;
}

export interface InvoiceSnapshotLine {
  productTypeId: string;
  sku: string;
  nameEn: string;
  nameTa: string;
  soldBy: SoldByUnit;
  isReturnable: boolean;
  qty: number;
  unitPriceCents: number;
  lineTotalCents: number;
  internalUnitCostCents?: number; // NEVER shown on receipts/PDF or employee API
  internalLineCostCents?: number; // NEVER shown on receipts/PDF or employee API
  returnedQty?: number;
}

export interface InvoiceSnapshot {
  invoiceNumber: string;
  invoiceDateColombo: string;
  businessDateColombo: string;
  customerId: string;
  customerName: string;
  customerNameTa: string;
  customerPhone: string;
  customerAddress: string;
  staffId: string;
  staffName: string;
  shop: {
    nameEn?: string;
    nameTa?: string;
    addressEn?: string;
    addressTa?: string;
    phone?: string;
    taxId?: string;
  };
  lines: InvoiceSnapshotLine[];
  subtotalCents: number;
  discountCents: number;
  invoiceTotalCents: number;
  paymentMethod: PaymentMethod;
  tenderedCents: number;
  invoicePaidCents: number;
  oldDebtAppliedCents: number;
  changeCents: number;
  invoiceDueCents: number;
  priorBalanceCents: number;
  resultingBalanceCents: number;
  returnableCansIssued: Array<{
    productTypeId: string;
    nameEn: string;
    nameTa: string;
    qty: number;
  }>;
}

export interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  customerId: string;
  staffId: string;
  staffName: string;
  status: 'active' | 'canceled';
  cancelReason: string | null;
  canceledAt: string | null;
  businessDateColombo: string;
  createdAt: string;
  snapshot: InvoiceSnapshot;
  returnedLines: Array<{
    productTypeId: string;
    qtyReturned: number;
    creditCents: number;
    restocked: boolean;
    reason: string;
    createdAt: string;
  }>;
}

export interface PaymentRecord {
  id: string;
  customerId: string;
  customerName: string;
  invoiceId: string | null;
  amountCents: number;
  method: PaymentMethod;
  kind: 'invoice_payment' | 'old_debt_collection' | 'reversal' | 'replacement';
  note: string;
  reversedPaymentId: string | null;
  isReversed: boolean;
  staffId: string;
  staffName: string;
  businessDateColombo: string;
  createdAt: string;
}

export interface CanMovementRecord {
  id: string;
  customerId: string;
  productTypeId: string;
  productNameEn: string;
  productNameTa: string;
  movementType: 'issued' | 'returned_used' | 'returned_damaged';
  qty: number;
  invoiceId: string | null;
  note: string;
  staffName: string;
  createdAt: string;
}

export interface CustomerLedgerEntry {
  id: string;
  createdAt: string;
  businessDateColombo: string;
  entryType:
    | 'invoice'
    | 'payment'
    | 'payment_reversal'
    | 'goods_return_credit'
    | 'invoice_canceled'
    | 'can_issued'
    | 'can_returned_used'
    | 'can_returned_damaged';
  reference: string;
  descriptionEn: string;
  descriptionTa: string;
  amountDeltaCents: number | null;
  canDelta: number | null;
  method?: PaymentMethod | null;
  staffName: string;
  invoiceId?: string | null;
  paymentId?: string | null;
  isReversed?: boolean;
}

export interface AuditLogEntry {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: string | null;
  afterJson: string | null;
  reason: string | null;
}

export interface HomeSummary {
  businessDateColombo: string;
  todaySalesCents: number;
  todayInvoiceCount: number;
  todayCashCollectedCents: number;
  todayBankCollectedCents: number;
  todayCreditAddedCents: number;
  outOfStockItems: ProductVariant[];
  lowStockItems: ProductVariant[];
  conflictSlotCount: number;
}

export interface FinancialReport {
  fromDate: string;
  toDate: string;
  invoiceCount: number;
  canceledInvoiceCount: number;
  grossSalesCents: number;
  discountsCents: number;
  goodsReturnCreditsCents: number;
  netSalesCents: number;
  invoiceCashCents: number;
  oldDebtCashCents: number;
  cashReversalsCents: number;
  netCashCollectedCents: number;
  invoiceBankCents: number;
  oldDebtBankCents: number;
  bankReversalsCents: number;
  netBankCollectedCents: number;
  totalCollectionsCents: number;
  totalHistoricalCostCents: number;
  signedGrossProfitCents: number; // NEVER clamped at zero!
  totalOutstandingReceivablesCents: number;
  totalCustomerHeldCans: number;
  invoices: InvoiceRecord[];
}
