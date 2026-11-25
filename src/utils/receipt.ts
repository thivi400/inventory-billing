import type { CreatedInvoice } from '../types';

export function toInvoice(raw: Record<string, any>): CreatedInvoice {
  const items = Array.isArray(raw.items)
    ? raw.items.map((it: any, idx: number) => ({
        id: it.sale_item_id || it.id || idx + 1,
        sale_item_id: it.sale_item_id || it.id,
        type_id: it.type_id || it.product_type_id,
        name: String(it.product_name || it.name || 'Item'),
        variant: it.variant || it.type_name,
        unit: String(it.unit || it.sold_by || 'unit'),
        sku: it.sku ? String(it.sku) : undefined,
        ta: it.ta ? String(it.ta) : undefined,
        quantity: Number(it.quantity ?? 0),
        returned_quantity: Number(it.returned_quantity ?? 0),
        price: Number(it.price ?? 0),
        subtotal: Number(it.subtotal ?? Number(it.price ?? 0) * Number(it.quantity ?? 0)),
      }))
    : [];

  const subtotal = Number(raw.subtotal ?? raw.total ?? 0);
  const discount = Number(raw.discount ?? 0);
  const total = Number(raw.total ?? Math.max(0, subtotal - discount));
  const amountPaid = Number(raw.amount_paid ?? raw.applied_to_bill ?? 0);
  const appliedToOldDebt = Number(raw.applied_to_old_debt ?? 0);
  const changeReturned = Number(raw.change_returned ?? 0);
  const balanceDue = Number(raw.balance_due ?? Math.max(0, total - amountPaid));

  return {
    sale_id: raw.sale_id || raw.id,
    invoice_number: String(raw.invoice_number || ''),
    status: raw.status === 'cancelled' || raw.status === 'canceled' ? 'cancelled' : 'completed',
    cancel_reason: raw.cancel_reason ?? null,
    customer_name: String(raw.customer_name || ''),
    customer_name_ta: raw.customer_name_ta ? String(raw.customer_name_ta) : undefined,
    customer_phone: raw.customer_phone ? String(raw.customer_phone) : '',
    customer_address: raw.customer_address ? String(raw.customer_address) : '',
    customer_balance: Number(raw.customer_balance ?? raw.current_customer_balance ?? 0),
    previous_balance: raw.previous_balance !== undefined ? Number(raw.previous_balance) : undefined,
    subtotal,
    discount,
    total,
    payment_method: raw.payment_method === 'bank' || raw.payment_method === 'bank_transfer' ? 'bank' : 'cash',
    cash_received: raw.cash_received !== undefined ? Number(raw.cash_received) : amountPaid + appliedToOldDebt + changeReturned,
    amount_paid: amountPaid,
    applied_to_bill: Number(raw.applied_to_bill ?? amountPaid),
    applied_to_old_debt: appliedToOldDebt,
    change_returned: changeReturned,
    balance_due: balanceDue,
    cans_issued: Array.isArray(raw.cans_issued) ? raw.cans_issued : undefined,
    cans_returned: Number(raw.cans_returned ?? 0),
    staff_name: String(raw.staff_name || 'Staff'),
    date: String(raw.date || ''),
    shop: raw.shop || undefined,
    items,
  };
}
