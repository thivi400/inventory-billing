export type Role = 'owner' | 'manager' | 'employee';

export type Screen =
  | 'home'
  | 'sale'
  | 'stock'
  | 'payments'
  | 'customers'
  | 'reports'
  | 'staff'
  | 'shop'
  | 'audit';

export type IconName =
  | 'sale'
  | 'stock'
  | 'wallet'
  | 'chart'
  | 'bottle'
  | 'can'
  | 'crown'
  | 'box'
  | 'hand'
  | 'check'
  | 'warning'
  | 'speaker'
  | 'search'
  | 'plus'
  | 'minus'
  | 'trash'
  | 'edit'
  | 'phone'
  | 'back'
  | 'user'
  | 'users'
  | 'receipt'
  | 'calendar'
  | 'refresh'
  | 'return'
  | 'home'
  | 'cash'
  | 'print'
  | 'download'
  | 'store'
  | 'shield'
  | 'lock'
  | 'logout';

export interface Product {
  id: number;
  type_id?: string;
  name: string;
  ta: string;
  price: number | null;
  stock: number;
  unit: string;
  sku?: string;
  icon: IconName;
  is_returnable?: boolean;
  is_active?: boolean;
  low_stock_limit?: number;
  buying_price?: number | null;
  used_empties_count?: number | null;
  damaged_empties_count?: number | null;
}

export interface ContainerHolding {
  type_id: string;
  name: string;
  ta?: string;
  held: number;
}

export interface Customer {
  id: string;
  name: string;
  name_ta?: string;
  phone: string;
  address?: string;
  balance: number;
  cans: number;
  credit_limit?: number;
  is_active?: boolean;
  container_types?: ContainerHolding[];
}

export interface InvoiceItemLine {
  id: number | string;
  sale_item_id?: string;
  type_id?: string;
  name: string;
  variant?: string;
  unit: string;
  sku?: string;
  ta?: string;
  quantity: number;
  returned_quantity?: number;
  price: number;
  subtotal: number;
}

export interface CreatedInvoice {
  sale_id?: string;
  invoice_number: string;
  status?: 'completed' | 'cancelled';
  cancel_reason?: string | null;
  customer_name: string;
  customer_name_ta?: string;
  customer_phone?: string;
  customer_address?: string;
  customer_balance?: number;
  previous_balance?: number;
  subtotal: number;
  discount?: number;
  total?: number;
  payment_method?: 'cash' | 'bank';
  cash_received?: number;
  amount_paid: number;
  applied_to_bill: number;
  applied_to_old_debt: number;
  change_returned?: number;
  balance_due: number;
  cans_issued?: Array<{ type_id: string; name: string; ta?: string; quantity: number }>;
  cans_returned: number;
  staff_name: string;
  date: string;
  shop?: {
    name_en?: string;
    name_ta?: string;
    address_en?: string;
    address_ta?: string;
    phone?: string;
    tax_id?: string;
  };
  items: InvoiceItemLine[];
}

export interface StaffUser {
  id: string;
  name: string;
  name_ta?: string;
  role: Role;
  is_active: boolean;
  is_locked: boolean;
  locked_until_ms?: number | null;
}

export interface ShopDetailsConfig {
  name_en: string;
  name_ta: string;
  address_en: string;
  address_ta: string;
  phone: string;
  tax_id: string;
  updated_at?: string | null;
}

export interface StarterBindingRecord {
  slot_key: string;
  product_type_id: string | null;
  excluded_type_ids: string[];
}
