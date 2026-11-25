import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import type { Customer, Role } from '../types';
import {
  dismissResolvedSettlement,
  getPendingSettlement,
  hasPendingOperation,
  isPendingQueueReady,
  recoverSettlement,
  retryOperation,
  startSettlement,
  submitOnce,
  subscribePendingOps,
  type SettlementExecutionResult,
} from '../services/operations';
import { Icon } from '../components/Icon';
import { formatMoney } from '../utils/formatters';

const noCustomer: Customer = { id: '', name: '', phone: '', balance: 0, cans: 0 };

export function Payments({
  token,
  role = 'employee',
}: {
  token: string;
  role?: Role;
  onGoHome?: () => void;
}) {
  const { t, lang, speak, showToast } = useApp();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer>(noCustomer);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const settlementInFlight = useRef(false);
  const customerRequest = useRef(0);
  const [customerError, setCustomerError] = useState(false);
  const [refreshingBalance, setRefreshingBalance] = useState(false);

  // Settlement Form State (Money + Used/Damaged Empty Cans together)
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank'>('cash');
  const [moneyNotes, setMoneyNotes] = useState('');
  const [returnCanType, setReturnCanType] = useState('');
  const [canQty, setCanQty] = useState('');
  const [damagedCanQty, setDamagedCanQty] = useState('');
  const [canNotes, setCanNotes] = useState('');

  // Subscribe to durable IndexedDB retry/settlement state
  const [, setOpsTick] = useState(0);
  useEffect(() => subscribePendingOps(() => setOpsTick((n) => n + 1)), []);

  // Collapsible Secondary Section: Goods Return & Invoice Cancellation
  const [showGoodsReturn, setShowGoodsReturn] = useState(false);
  const [invoiceQuery, setInvoiceQuery] = useState('');
  const [selectedInvoice, setSelectedInvoice] = useState<any | null>(null);
  const [loadingInvoice, setLoadingInvoice] = useState(false);
  const [returnItemId, setReturnItemId] = useState<string>('');
  const [returnQty, setReturnQty] = useState<string>('1');
  const [returnReason, setReturnReason] = useState<string>('');
  const [restockReturn, setRestockReturn] = useState<boolean>(false);
  const [cancelReason, setCancelReason] = useState<string>('');
  const [confirmCancelSale, setConfirmCancelSale] = useState(false);

  // Recent payments & Mistake correction / Inline Void state
  const [recentPayments, setRecentPayments] = useState<any[]>([]);
  const [editingPayment, setEditingPayment] = useState<any | null>(null);
  const [correctedAmount, setCorrectedAmount] = useState('');
  const [correctedMethod, setCorrectedMethod] = useState<'cash' | 'bank'>('cash');
  const [correctionReason, setCorrectionReason] = useState('');
  const [voidingPayment, setVoidingPayment] = useState<any | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const isManagerOrOwner = role === 'owner' || role === 'manager';

  const loadCustomers = () => {
    const requestId = ++customerRequest.current;
    setCustomerError(false);
    api
      .get<Customer[]>(`/customers/list?q=${encodeURIComponent(query)}`, token)
      .then((rows) => {
        if (requestId !== customerRequest.current) return;
        setCustomers(rows);
        setCustomer((curr) => {
          const row = rows.find((item) => item.id === curr.id);
          return row ? { ...curr, ...row } : curr;
        });
      })
      .catch(() => {
        if (requestId === customerRequest.current) setCustomerError(true);
      });
  };

  const loadRecentPayments = (customerId?: string) => {
    const cid = customerId || (customer ? String(customer.id) : '');
    const url = cid ? `/payments/recent?customer_id=${encodeURIComponent(cid)}` : '/payments/recent';
    api
      .get<any[]>(url, token)
      .then((rows) => {
        if (Array.isArray(rows)) setRecentPayments(rows);
      })
      .catch(() => {});
  };

  const heldTypes = customer.container_types || [];
  const selectedCanType = heldTypes.length === 1 ? heldTypes[0].type_id : returnCanType;
  const queueReady = isPendingQueueReady();
  const pendingSettlement = getPendingSettlement();
  const settlementHasPendingPart = Boolean(
    pendingSettlement &&
      (pendingSettlement.money?.status === 'pending' || pendingSettlement.cans?.status === 'pending'),
  );
  const pendingPaths = (
    [
      ['/payments/receive', 'payment', 'பணம்'],
      ['/containers/movement', 'can return', 'கேன் வரவு'],
      ['/sales/return-item', 'goods return', 'சரக்கு திருப்புதல்'],
    ] as const
  ).filter(([path]) => hasPendingOperation(path, token));

  const retryUnconfirmed = async (path: string) => {
    if (settlementInFlight.current || saving || !queueReady) return;
    settlementInFlight.current = true;
    setSaving(true);
    try {
      await retryOperation(path, token);
      if (path === '/payments/receive') {
        setAmount('');
        setMoneyNotes('');
      }
      if (path === '/containers/movement') {
        setCanQty('');
        setDamagedCanQty('');
        setCanNotes('');
      }
      if (path === '/sales/return-item') {
        setReturnReason('');
        setReturnQty('1');
        setRestockReturn(false);
        if (invoiceQuery.trim()) handleSearchInvoice();
        window.dispatchEvent(new CustomEvent('refresh-stock-data'));
      }
      showToast(
        lang === 'ta' ? 'முந்தைய பதிவு உறுதி செய்யப்பட்டது.' : 'Previous entry confirmed.',
        'success',
      );
      window.dispatchEvent(new CustomEvent('refresh-customer-data'));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not confirm previous entry', 'error');
    } finally {
      settlementInFlight.current = false;
      setSaving(false);
    }
  };

  const applySettlementOutcome = (res: SettlementExecutionResult, isRecovery: boolean) => {
    const rec = res.record;
    const cid = String(rec.customerId);

    if (res.moneyJustConfirmed && rec.money?.newBalance !== null && rec.money?.newBalance !== undefined) {
      const nb = rec.money.newBalance;
      setCustomer((prev) => (String(prev.id) === cid ? { ...prev, balance: nb } : prev));
      setCustomers((prev) => prev.map((c) => (String(c.id) === cid ? { ...c, balance: nb } : c)));
    }
    if (
      res.cansJustConfirmed &&
      rec.cans?.newCansBalance !== null &&
      rec.cans?.newCansBalance !== undefined
    ) {
      const nc = rec.cans.newCansBalance;
      setCustomer((prev) => (String(prev.id) === cid ? { ...prev, cans: nc } : prev));
      setCustomers((prev) => prev.map((c) => (String(c.id) === cid ? { ...c, cans: nc } : c)));
    }

    if (res.moneyJustConfirmed || (!isRecovery && rec.money?.status === 'confirmed')) {
      setAmount('');
      setMoneyNotes('');
    }
    if (res.cansJustConfirmed || (!isRecovery && rec.cans?.status === 'confirmed')) {
      setCanQty('');
      setDamagedCanQty('');
      setCanNotes('');
    }

    if (res.moneyJustConfirmed || res.cansJustConfirmed) {
      loadRecentPayments(cid);
      window.dispatchEvent(new CustomEvent('refresh-customer-data'));
    }

    const moneyAmt = Number(rec.money?.payload.amount ?? 0);
    const totalCans =
      Number(rec.cans?.payload.quantity ?? 0) + Number(rec.cans?.payload.damaged_quantity ?? 0);

    if (res.fullyConfirmed) {
      if (rec.money && rec.cans) {
        speak('Settlement recorded successfully', 'வரவு வெற்றிகரமாக சேமிக்கப்பட்டது');
        showToast(
          lang === 'ta'
            ? `${formatMoney(moneyAmt)} பணம் & ${totalCans} கேன்கள் வரவு வைக்கப்பட்டது!`
            : `Recorded ${formatMoney(moneyAmt)} & ${totalCans} returned cans!`,
          'success',
        );
      } else if (rec.money) {
        speak('Payment collected successfully', 'பணம் வரவு வைக்கப்பட்டது');
        showToast(
          lang === 'ta'
            ? `${formatMoney(moneyAmt)} வரவு வைக்கப்பட்டது.`
            : `${formatMoney(moneyAmt)} collected for ${rec.customerName}.`,
          'success',
        );
      } else if (rec.cans) {
        speak('Empty cans recorded', 'காலி கேன்கள் வரவு வைக்கப்பட்டது');
        showToast(
          lang === 'ta'
            ? `${totalCans} கேன்கள் வரவு வைக்கப்பட்டது.`
            : `${totalCans} empty cans returned by ${rec.customerName}.`,
          'success',
        );
      }
      return;
    }

    if (rec.money?.status === 'confirmed' && rec.cans && rec.cans.status !== 'confirmed') {
      showToast(
        lang === 'ta'
          ? `பணம் (${formatMoney(moneyAmt)}) சேமிக்கப்பட்டது; கேன் பதிவு முடிக்கப்படவில்லை: ${res.cansError || ''}`
          : `Payment (${formatMoney(moneyAmt)}) saved; can return incomplete: ${res.cansError || 'pending confirmation'}.`,
        'error',
      );
    } else if (rec.money?.status === 'pending') {
      showToast(
        lang === 'ta'
          ? 'பணம் உறுதி செய்யப்படவில்லை. மேலே உள்ள மீட்பு பொத்தானைப் பயன்படுத்தி அதே பதிவை முடிக்கவும்.'
          : 'Payment could not be confirmed. Use the recovery panel above to resolve with the original ID.',
        'error',
      );
    } else if (res.moneyError || res.cansError) {
      showToast(res.moneyError || res.cansError || 'Settlement did not complete', 'error');
    }
  };

  const handleRecoverSettlement = async () => {
    if (settlementInFlight.current || saving || !queueReady || !pendingSettlement) return;
    settlementInFlight.current = true;
    setSaving(true);
    try {
      const res = await recoverSettlement(token);
      applySettlementOutcome(res, true);
    } catch (err: any) {
      showToast(err?.message || 'Could not recover settlement', 'error');
    } finally {
      settlementInFlight.current = false;
      setSaving(false);
    }
  };

  const handleDismissSettlement = async () => {
    if (settlementInFlight.current || saving || settlementHasPendingPart) return;
    try {
      await dismissResolvedSettlement();
    } catch (err: any) {
      showToast(err?.message || 'Cannot dismiss pending settlement', 'error');
    }
  };

  const refreshBalance = async (silent = false) => {
    if (!customer?.id) return;
    setRefreshingBalance(true);
    try {
      const freshCust = await api.get<Customer>(`/customers/details/${customer.id}`, token);
      if (freshCust) {
        const b = Number(freshCust.balance ?? 0);
        const c = Number(freshCust.cans ?? 0);
        setCustomer((prev) =>
          prev.id === customer.id
            ? { ...prev, balance: b, cans: c, container_types: freshCust.container_types }
            : prev,
        );
        setCustomers((prev) =>
          prev.map((item) =>
            String(item.id) === String(customer.id)
              ? { ...item, balance: b, cans: c, container_types: freshCust.container_types }
              : item,
          ),
        );
        if (!silent) {
          showToast(
            lang === 'ta'
              ? `இருப்பு புதுப்பிக்கப்பட்டது: கடன் ${formatMoney(b)}, கேன்கள்: ${c}`
              : `Balance updated: Debt ${formatMoney(b)}, Cans: ${c}`,
            'info',
          );
        }
      }
    } catch (e: any) {
      if (!silent) {
        showToast(
          lang === 'ta'
            ? 'இருப்பு புதுப்பிக்க முடியவில்லை'
            : 'Could not refresh balance: ' + e.message,
          'error',
        );
      }
    } finally {
      setRefreshingBalance(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(loadCustomers, 200);
    return () => clearTimeout(timer);
  }, [token, query]);

  useEffect(() => {
    const handleRefresh = () => {
      loadCustomers();
      if (customer?.id) {
        refreshBalance(true);
        loadRecentPayments(String(customer.id));
      }
    };
    window.addEventListener('refresh-customer-data', handleRefresh);
    return () => window.removeEventListener('refresh-customer-data', handleRefresh);
  }, [customer?.id, query, token]);

  useEffect(() => {
    if (customer && customer.id) {
      loadRecentPayments(String(customer.id));
      refreshBalance(true);
      setReturnCanType('');
      setEditingPayment(null);
      setVoidingPayment(null);
    }
  }, [customer?.id, token]);

  const numEnteredAmt = Number(amount) || 0;
  const numUsedCans = Number(canQty) || 0;
  const numDamagedCans = Number(damagedCanQty) || 0;
  const totalReturnedCans = numUsedCans + numDamagedCans;

  // UNIFIED SETTLEMENT SUBMIT (persists both operation IDs upfront before sending either request)
  const submitSettlement = async () => {
    if (
      !customer.id ||
      !queueReady ||
      settlementInFlight.current ||
      Boolean(pendingSettlement) ||
      pendingPaths.length > 0
    )
      return;

    if (numEnteredAmt <= 0 && totalReturnedCans <= 0) {
      showToast(
        lang === 'ta'
          ? 'தொகை அல்லது காலி கேன் எண்ணிக்கையை உள்ளிடவும்'
          : 'Please enter money received or empty cans returned (or both)',
        'error',
      );
      return;
    }

    settlementInFlight.current = true;
    setSaving(true);
    try {
      const res = await startSettlement(
        {
          customerId: customer.id,
          customerName: customer.name,
          customerNameTa: customer.name_ta,
          money:
            numEnteredAmt > 0
              ? {
                  amount: numEnteredAmt,
                  payment_method: paymentMethod,
                  notes: moneyNotes || `Collected via ${paymentMethod.toUpperCase()}`,
                }
              : undefined,
          cans:
            totalReturnedCans > 0
              ? {
                  quantity: numUsedCans,
                  damaged_quantity: numDamagedCans,
                  ...(selectedCanType ? { type_id: selectedCanType } : {}),
                  notes: canNotes || 'Empty cans returned by customer',
                }
              : undefined,
        },
        token,
      );
      applySettlementOutcome(res, false);
    } catch (err: any) {
      showToast(err?.message || 'Settlement failed', 'error');
    } finally {
      settlementInFlight.current = false;
      setSaving(false);
    }
  };

  const handleSearchInvoice = async () => {
    if (!invoiceQuery.trim()) return;
    setLoadingInvoice(true);
    setConfirmCancelSale(false);
    try {
      const inv = await api.get<any>(
        `/invoices/details/${encodeURIComponent(invoiceQuery.trim())}`,
        token,
      );
      setSelectedInvoice(inv);
      if (inv.items && inv.items.length > 0) {
        setReturnItemId(inv.items[0].sale_item_id);
      }
    } catch (err: any) {
      setSelectedInvoice(null);
      showToast(
        lang === 'ta' ? 'இன்வாய்ஸ் காணப்படவில்லை' : err.message || 'Invoice not found',
        'error',
      );
    } finally {
      setLoadingInvoice(false);
    }
  };

  const submitItemReturn = async () => {
    if (
      !selectedInvoice ||
      selectedInvoice.status !== 'completed' ||
      !returnItemId ||
      saving ||
      !queueReady ||
      hasPendingOperation('/sales/return-item', token)
    )
      return;
    const qty = Number(returnQty);
    if (!Number.isInteger(qty) || qty <= 0) {
      showToast(
        lang === 'ta' ? 'திருப்பி அனுப்பும் எண்ணிக்கையை உள்ளிடவும்' : 'Enter valid return quantity',
        'error',
      );
      return;
    }
    if (!returnReason.trim()) {
      showToast(lang === 'ta' ? 'காரணத்தை உள்ளிடவும்' : 'Please provide a reason for return', 'error');
      return;
    }

    setSaving(true);
    try {
      await submitOnce(
        '/sales/return-item',
        {
          invoice_id: selectedInvoice.sale_id,
          sale_item_id: returnItemId,
          quantity: qty,
          reason: returnReason.trim(),
          restock: restockReturn,
        },
        token,
      );

      speak('Item return processed', 'பொருட்கள் திருப்புதல் ஏற்கப்பட்டது');
      showToast(
        lang === 'ta'
          ? `${qty} சரக்கு திருப்பப்பட்டது. வாடிக்கையாளர் கணக்கில் தொகை வரவு வைக்கப்பட்டது.`
          : `Returned ${qty} item(s). Customer account credited (no cash payout).`,
        'success',
      );

      handleSearchInvoice();
      refreshBalance(true);
      window.dispatchEvent(new CustomEvent('refresh-stock-data'));
      window.dispatchEvent(new CustomEvent('refresh-customer-data'));
      setReturnQty('1');
      setReturnReason('');
      setRestockReturn(false);
    } catch (err: any) {
      showToast(err.message || 'Failed to process return', 'error');
    } finally {
      setSaving(false);
    }
  };

  const executeSaleCancellation = async () => {
    if (!selectedInvoice || !cancelReason.trim()) return;
    setSaving(true);
    setConfirmCancelSale(false);
    try {
      await api.post(
        '/sales/cancel',
        {
          sale_id: selectedInvoice.sale_id,
          reason: cancelReason.trim(),
        },
        token,
      );

      speak('Bill cancelled successfully', 'பில் ரத்து செய்யப்பட்டது');
      showToast(
        lang === 'ta'
          ? `பில் ${selectedInvoice.invoice_number} ரத்து செய்யப்பட்டது.`
          : `Invoice ${selectedInvoice.invoice_number} cancelled and stock restored.`,
        'success',
      );

      setSelectedInvoice(null);
      setInvoiceQuery('');
      setCancelReason('');
      refreshBalance(true);
      window.dispatchEvent(new CustomEvent('refresh-stock-data'));
      window.dispatchEvent(new CustomEvent('refresh-customer-data'));
    } catch (err: any) {
      showToast(err.message || 'Failed to cancel sale', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCorrection = async () => {
    if (!editingPayment) return;
    const newAmt = Number(correctedAmount);
    if (!newAmt || newAmt <= 0) {
      showToast('Please enter a valid amount greater than zero', 'error');
      return;
    }
    if (!correctionReason.trim()) {
      showToast('Reason is required for auditing payment corrections', 'error');
      return;
    }

    try {
      await api.post(
        '/payments/correct',
        {
          payment_id: editingPayment.payment_id,
          new_amount: newAmt,
          payment_method: correctedMethod,
          reason: correctionReason.trim(),
        },
        token,
      );
      speak('Payment corrected', 'தொகை மாற்றப்பட்டது');
      showToast(
        lang === 'ta'
          ? `கட்டணம் திருத்தப்பட்டது: ${formatMoney(newAmt)}`
          : `Payment corrected to ${formatMoney(newAmt)}.`,
        'success',
      );
      setEditingPayment(null);
      setCorrectedAmount('');
      setCorrectionReason('');
      refreshBalance(true);
      loadRecentPayments(String(customer.id));
      window.dispatchEvent(new CustomEvent('refresh-customer-data'));
    } catch (err: unknown) {
      showToast(
        'Failed to correct payment: ' + (err instanceof Error ? err.message : String(err)),
        'error',
      );
    }
  };

  const executeVoidPayment = async () => {
    if (!voidingPayment || !voidReason.trim()) return;
    try {
      await api.post(
        '/payments/void',
        { payment_id: voidingPayment.payment_id, reason: voidReason.trim() },
        token,
      );
      speak('Payment voided', 'கட்டணம் ரத்து செய்யப்பட்டது');
      showToast(
        lang === 'ta'
          ? `${formatMoney(voidingPayment.amount)} கட்டணம் ரத்து செய்யப்பட்டது.`
          : `Payment of ${formatMoney(voidingPayment.amount)} reversed.`,
        'success',
      );
      setVoidingPayment(null);
      setVoidReason('');
      refreshBalance(true);
      loadRecentPayments(String(customer.id));
      window.dispatchEvent(new CustomEvent('refresh-customer-data'));
    } catch (err: unknown) {
      showToast(
        'Failed to void payment: ' + (err instanceof Error ? err.message : String(err)),
        'error',
      );
    }
  };

  const filteredCustomers = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(query.toLowerCase()) ||
      (c.name_ta || '').toLowerCase().includes(query.toLowerCase()) ||
      c.phone.includes(query),
  );

  const projectedBalance = customer.balance - numEnteredAmt;
  const projectedCans = Math.max(0, customer.cans - totalReturnedCans);

  const selectedHeldLimit =
    heldTypes.find((row) => row.type_id === selectedCanType)?.held ?? customer.cans;

  const invalidCanQuantity =
    !Number.isInteger(numUsedCans) ||
    !Number.isInteger(numDamagedCans) ||
    numUsedCans < 0 ||
    numDamagedCans < 0 ||
    (totalReturnedCans > 0 &&
      ((heldTypes.length > 1 && !selectedCanType) || totalReturnedCans > selectedHeldLimit));

  const isButtonDisabled =
    saving ||
    !queueReady ||
    !customer.id ||
    Boolean(pendingSettlement) ||
    pendingPaths.length > 0 ||
    invalidCanQuantity ||
    !/^\d*(?:\.\d{0,2})?$/.test(amount) ||
    (numEnteredAmt <= 0 && totalReturnedCans <= 0);

  let buttonLabel = lang === 'ta' ? 'வரவு சேமிக்க' : 'RECORD SETTLEMENT';
  if (saving) {
    buttonLabel = lang === 'ta' ? 'சேமிக்கப்படுகிறது...' : 'Recording...';
  } else if (!queueReady) {
    buttonLabel = lang === 'ta' ? 'சரிபார்க்கிறது...' : 'Checking pending items...';
  } else if (numEnteredAmt > 0 && totalReturnedCans > 0) {
    buttonLabel = lang === 'ta'
      ? `${formatMoney(numEnteredAmt)} & ${totalReturnedCans} கேன்கள் சேமி`
      : `RECORD ${formatMoney(numEnteredAmt)} & ${totalReturnedCans} CANS`;
  } else if (numEnteredAmt > 0) {
    buttonLabel = lang === 'ta'
      ? `பணம் வரவு சேமிக்க (${formatMoney(numEnteredAmt)})`
      : `RECORD PAYMENT OF ${formatMoney(numEnteredAmt)}`;
  } else if (totalReturnedCans > 0) {
    buttonLabel = lang === 'ta'
      ? `${totalReturnedCans} காலிகேன்கள் வரவு சேமிக்க`
      : `RECORD ${totalReturnedCans} EMPTY CANS`;
  }

  return (
    <div className="workflow-page payments-page">
      {!queueReady && (
        <div
          className="workflow-card"
          role="status"
          style={{
            marginBottom: 10,
            padding: '10px 14px',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            color: '#1e3a8a',
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          {lang === 'ta'
            ? 'முந்தைய நிலுவை வரவுகளைச் சரிபார்க்கிறது...'
            : 'Checking pending settlements before enabling submissions...'}
        </div>
      )}

      {pendingSettlement && (
        <div
          className="workflow-card"
          role="status"
          style={{
            marginBottom: 10,
            padding: 14,
            background: '#fffbeb',
            border: '1px solid #f59e0b',
          }}
        >
          <p style={{ margin: '0 0 6px 0', fontWeight: 800, color: '#92400e' }}>
            {settlementHasPendingPart
              ? lang === 'ta'
                ? 'முந்தைய வரவு முழுமையாக உறுதி செய்யப்படவில்லை. புதிய வரவு தற்காலிகமாக நிறுத்தப்பட்டுள்ளது.'
                : 'Previous settlement is incomplete. Complete recovery below before starting a new settlement.'
              : lang === 'ta'
                ? 'முந்தைய வரவு பகுதியாக மட்டுமே சேமிக்கப்பட்டது.'
                : 'Previous settlement was partially saved.'}
          </p>
          <p style={{ margin: '0 0 8px 0', fontSize: 13, fontWeight: 700, color: '#78350f' }}>
            {lang === 'ta' ? 'வாடிக்கையாளர்:' : 'Customer:'}{' '}
            {lang === 'ta' && pendingSettlement.customerNameTa
              ? pendingSettlement.customerNameTa
              : pendingSettlement.customerName}
          </p>
          <div style={{ display: 'grid', gap: 4, marginBottom: 10, fontSize: 13 }}>
            {pendingSettlement.money && (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>
                  {lang === 'ta' ? '1. பணம்:' : '1. Payment:'}{' '}
                  <b>{formatMoney(Number(pendingSettlement.money.payload.amount ?? 0))}</b> (
                  {String(pendingSettlement.money.payload.payment_method || 'cash').toUpperCase()})
                </span>
                <b
                  style={{
                    color:
                      pendingSettlement.money.status === 'confirmed'
                        ? '#15803d'
                        : pendingSettlement.money.status === 'rejected'
                          ? '#b91c1c'
                          : '#b45309',
                  }}
                >
                  {pendingSettlement.money.status === 'confirmed'
                    ? lang === 'ta'
                      ? '✓ சேமிக்கப்பட்டது'
                      : '✓ Saved'
                    : pendingSettlement.money.status === 'rejected'
                      ? `${lang === 'ta' ? 'நிராகரிக்கப்பட்டது' : 'Rejected'}${pendingSettlement.money.error ? `: ${pendingSettlement.money.error}` : ''}`
                      : lang === 'ta'
                        ? 'உறுதி செய்யப்படவில்லை (அதே ID மூலம் முயற்சி)'
                        : 'Unconfirmed (will retry with original ID)'}
                </b>
              </div>
            )}
            {pendingSettlement.cans && (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>
                  {lang === 'ta' ? '2. காலிகேன் வரவு:' : '2. Empty cans:'}{' '}
                  <b>
                    {Number(pendingSettlement.cans.payload.quantity ?? 0) +
                      Number(pendingSettlement.cans.payload.damaged_quantity ?? 0)}
                  </b>
                </span>
                <b
                  style={{
                    color:
                      pendingSettlement.cans.status === 'confirmed'
                        ? '#15803d'
                        : pendingSettlement.cans.status === 'rejected'
                          ? '#b91c1c'
                          : '#b45309',
                  }}
                >
                  {pendingSettlement.cans.status === 'confirmed'
                    ? lang === 'ta'
                      ? '✓ சேமிக்கப்பட்டது'
                      : '✓ Saved'
                    : pendingSettlement.cans.status === 'rejected'
                      ? `${lang === 'ta' ? 'நிராகரிக்கப்பட்டது' : 'Rejected'}${pendingSettlement.cans.error ? `: ${pendingSettlement.cans.error}` : ''}`
                      : lang === 'ta'
                        ? 'மீதமுள்ளது (அதே ID மூலம் சேமி)'
                        : 'Remaining (will complete with original ID)'}
                </b>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {settlementHasPendingPart ? (
              <button
                type="button"
                className="primary-action"
                style={{ marginTop: 0 }}
                disabled={saving || !queueReady}
                onClick={handleRecoverSettlement}
              >
                {saving
                  ? '...'
                  : lang === 'ta'
                    ? 'மீதமுள்ள பதிவை முடி'
                    : 'Complete remaining settlement'}
              </button>
            ) : (
              <button
                type="button"
                className="btn-cancel"
                style={{ padding: '8px 14px', borderRadius: 6 }}
                disabled={saving}
                onClick={handleDismissSettlement}
              >
                {lang === 'ta' ? 'அறிவிப்பை மூடு' : 'Dismiss notice'}
              </button>
            )}
          </div>
        </div>
      )}

      {pendingPaths.map(([path, enLabel, taLabel]) => (
        <div key={path} className="workflow-card" role="status" style={{ marginBottom: 10, padding: 14 }}>
          <p style={{ margin: '0 0 8px 0', fontWeight: 800, color: '#92400e' }}>
            {lang === 'ta'
              ? `முந்தைய ${taLabel} உறுதி செய்யப்படவில்லை.`
              : `The previous ${enLabel} is not confirmed.`}
          </p>
          <button
            type="button"
            className="primary-action"
            style={{ marginTop: 0 }}
            disabled={saving || !queueReady}
            onClick={() => retryUnconfirmed(path)}
          >
            {lang === 'ta' ? `அதே ${taLabel} மீண்டும் முயற்சி செய்` : `Retry the same ${enLabel}`}
          </button>
        </div>
      ))}

      <div
        className="page-title compact"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <p className="eyebrow">{t('payReturn')}</p>
          <h1>{lang === 'ta' ? 'வசூல் & காலிகேன் வரவு' : 'Pay & Empty Cans Settlement'}</h1>
        </div>
      </div>

      <section className="payments-layout">
        {/* Left Column: Customer Picker */}
        <div className="workflow-card customer-picker-card">
          <label className="customer-search-box">
            <Icon name="search" size={18} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('findCustomer')}
            />
            {query && (
              <button type="button" className="clear-search-btn" onClick={() => setQuery('')}>
                ✕
              </button>
            )}
          </label>
          <div className="choice-list inside-scroll">
            {customerError && (
              <p role="alert">
                {lang === 'ta' ? 'வாடிக்கையாளர்களை ஏற்ற முடியவில்லை' : 'Could not load customers'}
              </p>
            )}
            {filteredCustomers.map((c) => (
              <button
                type="button"
                className={`customer-item-btn ${customer.id === c.id ? 'selected' : ''}`}
                key={String(c.id)}
                disabled={saving || Boolean(pendingSettlement)}
                onClick={() => {
                  setCustomer(c);
                  setSelectedInvoice(null);
                }}
              >
                <span className="cust-info">
                  <b>{lang === 'ta' && c.name_ta ? c.name_ta : c.name}</b>
                  <small>{c.phone}</small>
                </span>
                <div style={{ textAlign: 'right' }}>
                  <strong className={c.balance > 0 ? 'debt' : 'credit'}>
                    {formatMoney(Math.abs(c.balance))}
                  </strong>
                  {c.cans > 0 && (
                    <small style={{ display: 'block', color: '#64748b' }}>{c.cans} cans</small>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right Column: Unified Form */}
        <div className="workflow-card amount-card inside-scroll">
          {!customer.id && (
            <p style={{ color: '#64748b', fontWeight: 700 }}>
              {lang === 'ta'
                ? 'வாடிக்கையாளரைத் தேர்ந்தெடுக்கவும்'
                : 'Select a customer to record a settlement.'}
            </p>
          )}
          {customer.id && (
            <div
              className="selected-item-banner"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: '#f8fafc',
                padding: '10px 14px',
                borderRadius: 10,
                border: '1px solid #e2e8f0',
              }}
            >
              <div>
                <b style={{ fontSize: 17, color: '#0f172a' }}>
                  {lang === 'ta' && customer.name_ta ? customer.name_ta : customer.name}
                </b>
                <small style={{ display: 'block', marginTop: 2, color: '#64748b' }}>
                  {customer.phone} {customer.address ? `• ${customer.address}` : ''}
                </small>
              </div>
              <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: 14 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700 }}>
                    {lang === 'ta' ? 'தற்போதைய கடன்:' : 'Current Debt:'}
                  </div>
                  <strong
                    className="tabular-nums"
                    style={{ fontSize: 19, color: customer.balance > 0 ? '#b45309' : '#15803d' }}
                  >
                    {formatMoney(Math.abs(customer.balance))}{' '}
                    {customer.balance > 0
                      ? lang === 'ta'
                        ? '(கடன்)'
                        : '(Debt)'
                      : lang === 'ta'
                        ? '(வரவு)'
                        : '(Credit)'}
                  </strong>
                  <div style={{ fontSize: 12, color: '#0284c7', fontWeight: 700, marginTop: 1 }}>
                    {customer.cans} {lang === 'ta' ? 'கேன்கள் கைவசம்' : 'cans held'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => refreshBalance(false)}
                  disabled={refreshingBalance}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                    background: '#ffffff',
                    color: '#334155',
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  <Icon name="refresh" size={13} />
                  <span>{refreshingBalance ? '...' : lang === 'ta' ? 'சரிபார்' : 'Refresh'}</span>
                </button>
              </div>
            </div>
          )}

          <div className="unified-settlement-form" style={{ marginTop: 12, display: 'grid', gap: 12 }}>
            <div className="settlement-grid-2col">
              {/* SECTION 1: MONEY RECEIVED */}
              <div
                className="settlement-section money-section"
                style={{
                  background: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: 10,
                  padding: 12,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label style={{ fontSize: 14, fontWeight: 800, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="cash" size={18} />
                    <span>{lang === 'ta' ? '1. பணம் வரவு (Rs.)' : '1. Money Received (Rs.)'}</span>
                  </label>
                </div>

                <div className="large-cash-box" style={{ maxWidth: '100%', padding: '6px 12px' }}>
                  <span className="cash-box-prefix">Rs.</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0"
                    disabled={Boolean(pendingSettlement)}
                    style={{ fontSize: 18 }}
                  />
                </div>

                {numEnteredAmt > 0 && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      color: '#15803d',
                      fontWeight: 700,
                      background: '#f0fdf4',
                      padding: '4px 8px',
                      borderRadius: 4,
                      border: '1px solid #bbf7d0',
                    }}
                  >
                    {lang === 'ta'
                      ? `கடன்: ${formatMoney(customer.balance)} − ${formatMoney(numEnteredAmt)} = ${formatMoney(projectedBalance)}`
                      : `Debt: ${formatMoney(customer.balance)} − ${formatMoney(numEnteredAmt)} = ${formatMoney(projectedBalance)}`}
                  </div>
                )}

                <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                  {(['cash', 'bank'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      disabled={Boolean(pendingSettlement)}
                      onClick={() => setPaymentMethod(m)}
                      style={{
                        flex: 1,
                        padding: '8px 6px',
                        borderRadius: 6,
                        border: paymentMethod === m ? '2px solid #0284c7' : '1px solid #cbd5e1',
                        background: paymentMethod === m ? '#e0f2fe' : '#ffffff',
                        fontWeight: paymentMethod === m ? 800 : 600,
                        fontSize: 12,
                        color: paymentMethod === m ? '#0284c7' : '#475569',
                      }}
                    >
                      {m === 'cash'
                        ? lang === 'ta'
                          ? 'ரொக்கம் (Cash)'
                          : 'Cash'
                        : lang === 'ta'
                          ? 'வங்கி (Bank)'
                          : 'Bank Transfer'}
                    </button>
                  ))}
                </div>

                <div style={{ marginTop: 8 }}>
                  <input
                    type="text"
                    disabled={Boolean(pendingSettlement)}
                    placeholder={lang === 'ta' ? 'குறிப்பு / ரசீது எண்' : 'Memo / Bank Ref #'}
                    value={moneyNotes}
                    onChange={(e) => setMoneyNotes(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: '1px solid #cbd5e1',
                      fontSize: 12,
                    }}
                  />
                </div>
              </div>

              {/* SECTION 2: EMPTY CANS RETURNED (Used & Damaged separately) */}
              <div
                className="settlement-section cans-section"
                style={{
                  background: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: 10,
                  padding: 12,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label style={{ fontSize: 14, fontWeight: 800, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="can" size={18} />
                    <span>{lang === 'ta' ? '2. காலிகேன் வரவு' : '2. Empty Cans Returned'}</span>
                  </label>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <small style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#0369a1', marginBottom: 3 }}>
                      {lang === 'ta' ? 'நல்ல காலிகள் (Used)' : 'Used / Good Empties'}
                    </small>
                    <div className="large-cash-box" style={{ maxWidth: '100%', padding: '5px 10px' }}>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={canQty}
                        onChange={(e) => setCanQty(e.target.value)}
                        placeholder="0"
                        disabled={Boolean(pendingSettlement)}
                        style={{ fontSize: 17 }}
                      />
                    </div>
                  </div>

                  <div>
                    <small style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#b91c1c', marginBottom: 3 }}>
                      {lang === 'ta' ? 'சேதமடைந்தவை (Damaged)' : 'Damaged Empties'}
                    </small>
                    <div className="large-cash-box" style={{ maxWidth: '100%', padding: '5px 10px' }}>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={damagedCanQty}
                        onChange={(e) => setDamagedCanQty(e.target.value)}
                        placeholder="0"
                        disabled={Boolean(pendingSettlement)}
                        style={{ fontSize: 17 }}
                      />
                    </div>
                  </div>
                </div>

                {totalReturnedCans > 0 && heldTypes.length > 1 && (
                  <label style={{ display: 'grid', gap: 3, marginTop: 8, fontSize: 12, fontWeight: 700 }}>
                    <span>{lang === 'ta' ? 'கேன் வகை' : 'Can type'}</span>
                    <select
                      value={returnCanType}
                      disabled={saving || Boolean(pendingSettlement)}
                      onChange={(e) => setReturnCanType(e.target.value)}
                      style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #cbd5e1' }}
                    >
                      <option value="">{lang === 'ta' ? 'வகையைத் தேர்ந்தெடு' : 'Choose type'}</option>
                      {heldTypes.map((row) => (
                        <option key={row.type_id} value={row.type_id}>
                          {lang === 'ta' ? row.ta || row.name : row.name} ({row.held})
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {invalidCanQuantity && (
                  <p role="alert" style={{ color: '#dc2626', fontSize: 12, fontWeight: 700, marginTop: 6 }}>
                    {lang === 'ta'
                      ? `கேன் வகையையும் எண்ணிக்கையையும் சரிபார்க்கவும் (அதிகபட்சம் ${selectedHeldLimit}).`
                      : `Check can type and quantity (max held: ${selectedHeldLimit}).`}
                  </p>
                )}

                {totalReturnedCans > 0 && !invalidCanQuantity && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      color: '#0284c7',
                      fontWeight: 700,
                      background: '#f0f9ff',
                      padding: '4px 8px',
                      borderRadius: 4,
                      border: '1px solid #bae6fd',
                    }}
                  >
                    {lang === 'ta'
                      ? `கைவசம்: ${customer.cans} − வரவு: ${totalReturnedCans} = மீதம்: ${projectedCans}`
                      : `Held: ${customer.cans} − Return: ${totalReturnedCans} = Remaining: ${projectedCans} cans`}
                  </div>
                )}

                <div style={{ marginTop: 8 }}>
                  <input
                    type="text"
                    disabled={Boolean(pendingSettlement)}
                    placeholder={lang === 'ta' ? 'கேன் குறிப்பு' : 'Can notes (e.g. via driver)'}
                    value={canNotes}
                    onChange={(e) => setCanNotes(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: '1px solid #cbd5e1',
                      fontSize: 12,
                    }}
                  />
                </div>
              </div>
            </div>

            <button
              type="button"
              className="primary-action"
              onClick={submitSettlement}
              disabled={isButtonDisabled}
              style={{ marginTop: 0 }}
            >
              <Icon name="check" size={18} />
              <span>{buttonLabel}</span>
            </button>
          </div>

          {/* Collapsible Goods Return & Invoice Cancellation */}
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px dashed #cbd5e1' }}>
            <button
              type="button"
              onClick={() => setShowGoodsReturn(!showGoodsReturn)}
              style={{
                background: 'none',
                border: 'none',
                color: '#0f172a',
                fontWeight: 800,
                fontSize: 14,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Icon name="return" size={16} />
              <span>
                {showGoodsReturn
                  ? lang === 'ta'
                    ? '▲ சரக்கு திருப்புதல் / பில் ரத்து மறை'
                    : '▲ Hide Goods Return & Invoice Cancellation'
                  : lang === 'ta'
                    ? '▼ சரக்கு திருப்புதல் & பில் ரத்து'
                    : '▼ Goods Return & Invoice Cancellation'}
              </span>
            </button>

            {showGoodsReturn && (
              <div style={{ marginTop: 12, padding: 14, background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                {!isManagerOrOwner ? (
                  <div style={{ color: '#64748b', fontSize: 13, fontWeight: 700 }}>
                    {lang === 'ta'
                      ? 'சரக்கு திருப்புதல் & பில் ரத்து செய்ய மேலாளர் / உரிமையாளர் PIN தேவை.'
                      : 'Permission Required: Only Owners and Managers can process item returns or cancel invoices.'}
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                      <input
                        type="text"
                        placeholder={
                          lang === 'ta'
                            ? 'இன்வாய்ஸ் எண் (எ.கா. INV-20261124-0001)'
                            : 'Enter Invoice Number (e.g. INV-20261124-0001)'
                        }
                        value={invoiceQuery}
                        onChange={(e) => setInvoiceQuery(e.target.value)}
                        style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff' }}
                      />
                      <button
                        type="button"
                        onClick={handleSearchInvoice}
                        disabled={loadingInvoice || !invoiceQuery.trim()}
                        style={{
                          padding: '10px 16px',
                          borderRadius: 8,
                          background: '#0284c7',
                          color: '#fff',
                          border: 'none',
                          fontWeight: 700,
                        }}
                      >
                        {loadingInvoice ? '...' : lang === 'ta' ? 'தேடு' : 'Find Invoice'}
                      </button>
                    </div>

                    {selectedInvoice && (
                      <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 14 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, borderBottom: '1px solid #e2e8f0', paddingBottom: 8 }}>
                          <div>
                            <b style={{ fontSize: 16 }}>{selectedInvoice.invoice_number}</b>
                            <small style={{ display: 'block', color: '#64748b' }}>
                              {selectedInvoice.date} • {selectedInvoice.customer_name}
                            </small>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <b>{formatMoney(selectedInvoice.total)}</b>
                            <small
                              style={{
                                display: 'block',
                                fontWeight: 800,
                                color: selectedInvoice.status === 'cancelled' ? '#dc2626' : '#16a34a',
                              }}
                            >
                              {String(selectedInvoice.status || '').toUpperCase()}
                            </small>
                          </div>
                        </div>

                        <h4 style={{ margin: '10px 0 6px 0', fontSize: 14, fontWeight: 700 }}>
                          {lang === 'ta' ? 'சரக்கு திருப்புதல்:' : 'Return Line Item:'}
                        </h4>
                        <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
                          <select
                            value={returnItemId}
                            onChange={(e) => setReturnItemId(e.target.value)}
                            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1' }}
                          >
                            {selectedInvoice.items?.map((it: any) => (
                              <option key={it.sale_item_id} value={it.sale_item_id}>
                                {it.name} (Sold: {it.quantity}, Returned: {it.returned_quantity || 0}) - {formatMoney(it.price)}
                              </option>
                            ))}
                          </select>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <input
                              type="number"
                              min="1"
                              value={returnQty}
                              onChange={(e) => setReturnQty(e.target.value)}
                              placeholder="Qty"
                              style={{ width: 90, padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1' }}
                            />
                            <input
                              type="text"
                              placeholder={lang === 'ta' ? 'காரணம் (Reason)' : 'Reason for return'}
                              value={returnReason}
                              onChange={(e) => setReturnReason(e.target.value)}
                              style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1' }}
                            />
                          </div>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={restockReturn}
                              onChange={(e) => setRestockReturn(e.target.checked)}
                            />
                            <span>
                              {lang === 'ta'
                                ? 'மீண்டும் விற்கக்கூடியதை சரக்கில் சேர்'
                                : 'Put sellable goods back into stock'}
                            </span>
                          </label>
                          <small style={{ color: '#64748b' }}>
                            {lang === 'ta'
                              ? 'வாடிக்கையாளர் கணக்கில் விகிதாசார வரவு வைக்கப்படும். ரொக்கம் திருப்பப்படாது.'
                              : 'Credits the customer account proportionally for discounted bills. No cash refund.'}
                          </small>
                          <button
                            type="button"
                            onClick={submitItemReturn}
                            disabled={
                              saving ||
                              !queueReady ||
                              selectedInvoice.status !== 'completed' ||
                              !returnItemId ||
                              hasPendingOperation('/sales/return-item', token) ||
                              !returnReason.trim()
                            }
                            style={{
                              padding: '8px 14px',
                              background: '#d97706',
                              color: '#fff',
                              border: 'none',
                              borderRadius: 6,
                              fontWeight: 700,
                            }}
                          >
                            {saving ? '...' : lang === 'ta' ? 'சரக்கு திருப்பத்தை உறுதி செய்' : 'Confirm Item Return'}
                          </button>
                        </div>

                        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 12, marginTop: 14 }}>
                          <h4 style={{ margin: '0 0 6px 0', fontSize: 14, fontWeight: 700, color: '#b91c1c' }}>
                            {lang === 'ta' ? 'முழு பில்லை ரத்து செய்:' : 'Cancel Entire Invoice:'}
                          </h4>
                          {selectedInvoice.amount_paid > 0 && (
                            <small style={{ display: 'block', color: '#b91c1c', marginBottom: 6 }}>
                              {lang === 'ta'
                                ? 'பணம் பெற்ற பில்லை ரத்து செய்ய முதலில் கட்டணத்தைத் திருப்பவும்.'
                                : 'Cannot cancel an invoice with recorded payments. Reverse payment first.'}
                            </small>
                          )}

                          {confirmCancelSale ? (
                            <div className="inline-confirm-bar">
                              <span>
                                {lang === 'ta'
                                  ? `பில் ${selectedInvoice.invoice_number} ஐ ரத்து செய்யவா?`
                                  : `Confirm cancelling invoice ${selectedInvoice.invoice_number}?`}
                              </span>
                              <div className="inline-confirm-actions">
                                <button
                                  type="button"
                                  className="btn-cancel"
                                  style={{ padding: '5px 10px' }}
                                  onClick={() => setConfirmCancelSale(false)}
                                >
                                  {lang === 'ta' ? 'இல்லை' : 'No'}
                                </button>
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={executeSaleCancellation}
                                  style={{
                                    padding: '5px 12px',
                                    background: '#dc2626',
                                    color: '#fff',
                                    border: 'none',
                                    borderRadius: 6,
                                    fontWeight: 800,
                                  }}
                                >
                                  {lang === 'ta' ? 'ஆம், ரத்து செய்' : 'Yes, Cancel Bill'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 8 }}>
                              <input
                                type="text"
                                placeholder={lang === 'ta' ? 'பில் ரத்து செய்ய காரணம்...' : 'Cancellation reason...'}
                                value={cancelReason}
                                onChange={(e) => setCancelReason(e.target.value)}
                                style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1' }}
                              />
                              <button
                                type="button"
                                onClick={() => setConfirmCancelSale(true)}
                                disabled={
                                  saving ||
                                  selectedInvoice.status !== 'completed' ||
                                  selectedInvoice.amount_paid > 0 ||
                                  !cancelReason.trim()
                                }
                                style={{
                                  padding: '8px 14px',
                                  background: '#ef4444',
                                  color: '#fff',
                                  border: 'none',
                                  borderRadius: 6,
                                  fontWeight: 700,
                                }}
                              >
                                {lang === 'ta' ? 'பில் ரத்து செய்' : 'Cancel Bill'}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Recent Payments & Mistake Correction Section */}
          <div className="mistake-correction-section">
            <div style={{ marginBottom: 12 }}>
              <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>
                {lang === 'ta' ? 'சமீபத்திய கட்டணங்கள் & தணிக்கை' : 'Recent Payments & Mistake Correction'}
              </h3>
              <small style={{ color: '#64748b' }}>
                {isManagerOrOwner
                  ? lang === 'ta'
                    ? 'தவறாக உள்ளிட்ட தொகையை திருத்த அல்லது ஒருமுறை ரத்து செய்ய'
                    : 'Authorized: Correct mistyped amounts or reverse an entry once'
                  : lang === 'ta'
                    ? 'பார்வைக்கு மட்டும் (மாற்ற மேலாளர் PIN தேவை)'
                    : 'Read-only: Manager/Owner PIN required to correct or reverse'}
              </small>
            </div>

            {editingPayment && isManagerOrOwner && (
              <div
                style={{
                  background: '#fefce8',
                  border: '2px solid #facc15',
                  borderRadius: 10,
                  padding: 14,
                  marginBottom: 14,
                }}
              >
                <b style={{ color: '#854d0e', display: 'block', marginBottom: 6 }}>
                  {lang === 'ta' ? 'தவறான தொகையை திருத்துக:' : 'Correct Mistaken Payment:'}
                </b>
                <p style={{ margin: '4px 0', fontSize: 13, color: '#713f12' }}>
                  {lang === 'ta'
                    ? `தற்போது பதிவாகியுள்ளது: ${formatMoney(editingPayment.amount)}`
                    : `Currently entered: ${formatMoney(editingPayment.amount)}`}
                </p>
                <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <div className="large-cash-box" style={{ flex: 1, padding: '6px 12px' }}>
                      <span className="cash-box-prefix">Rs.</span>
                      <input
                        type="number"
                        value={correctedAmount}
                        onChange={(e) => setCorrectedAmount(e.target.value)}
                        placeholder="e.g. 2000"
                        autoFocus
                      />
                    </div>
                    <select
                      value={correctedMethod}
                      onChange={(e) => setCorrectedMethod(e.target.value as 'cash' | 'bank')}
                      style={{ padding: '10px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff' }}
                    >
                      <option value="cash">{lang === 'ta' ? 'ரொக்கம் (Cash)' : 'Cash'}</option>
                      <option value="bank">{lang === 'ta' ? 'வங்கி (Bank Transfer)' : 'Bank Transfer'}</option>
                    </select>
                  </div>
                  <input
                    type="text"
                    placeholder={
                      lang === 'ta' ? 'காரணம் (கட்டாயம்)' : 'Reason for correction (required)'
                    }
                    value={correctionReason}
                    onChange={(e) => setCorrectionReason(e.target.value)}
                    style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff' }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      onClick={handleSaveCorrection}
                      disabled={!correctedAmount || !correctionReason.trim()}
                      style={{
                        padding: '8px 16px',
                        background: '#16a34a',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        fontWeight: 800,
                      }}
                    >
                      {lang === 'ta' ? 'திருத்தத்தை சேமி' : 'Save Correction'}
                    </button>
                    <button
                      type="button"
                      className="btn-cancel"
                      onClick={() => {
                        setEditingPayment(null);
                        setCorrectedAmount('');
                        setCorrectionReason('');
                      }}
                      style={{ padding: '8px 14px', borderRadius: 6 }}
                    >
                      {lang === 'ta' ? 'ரத்து' : 'Cancel'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {voidingPayment && isManagerOrOwner && (
              <div
                style={{
                  background: '#fef2f2',
                  border: '2px solid #fca5a5',
                  borderRadius: 10,
                  padding: 14,
                  marginBottom: 14,
                }}
              >
                <b style={{ color: '#991b1b', display: 'block', marginBottom: 6 }}>
                  {lang === 'ta'
                    ? `${formatMoney(voidingPayment.amount)} கட்டணத்தை ரத்து செய்ய காரணம் உள்ளிடவும்:`
                    : `Reverse payment of ${formatMoney(voidingPayment.amount)}:`}
                </b>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    placeholder={lang === 'ta' ? 'காரணம் (கட்டாயம்)' : 'Reason for reversal (required)'}
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    autoFocus
                    style={{ flex: 1, minWidth: 200, padding: '8px 12px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fff' }}
                  />
                  <button
                    type="button"
                    disabled={!voidReason.trim()}
                    onClick={executeVoidPayment}
                    style={{
                      padding: '8px 14px',
                      background: '#dc2626',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      fontWeight: 800,
                    }}
                  >
                    {lang === 'ta' ? 'ரத்து உறுதி' : 'Confirm Reverse'}
                  </button>
                  <button
                    type="button"
                    className="btn-cancel"
                    onClick={() => {
                      setVoidingPayment(null);
                      setVoidReason('');
                    }}
                    style={{ padding: '8px 12px', borderRadius: 6 }}
                  >
                    {lang === 'ta' ? 'மூடு' : 'Cancel'}
                  </button>
                </div>
              </div>
            )}

            <div className="recent-payments-list">
              {recentPayments.length > 0 ? (
                recentPayments.map((p) => (
                  <div
                    key={p.payment_id}
                    className="recent-payment-card"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 14px',
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      borderRadius: 8,
                      marginBottom: 8,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 15, color: Number(p.amount) < 0 ? '#dc2626' : '#0f172a' }}>
                        {formatMoney(Number(p.amount))}
                        <span style={{ fontSize: 12, marginLeft: 8, color: '#64748b', fontWeight: 600 }}>
                          ({String(p.payment_method || p.method || 'CASH').toUpperCase()})
                        </span>
                      </div>
                      <small style={{ color: '#64748b' }}>
                        {p.payment_date} {p.notes ? `• ${p.notes}` : ''}
                      </small>
                    </div>
                    {isManagerOrOwner && p.can_correct ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          type="button"
                          className="btn-correct-mistake"
                          onClick={() => {
                            setVoidingPayment(null);
                            setEditingPayment(p);
                            setCorrectedAmount(String(p.amount));
                            setCorrectedMethod(
                              String(p.method || '').toLowerCase().includes('bank') ? 'bank' : 'cash',
                            );
                          }}
                          style={{
                            background: '#fef3c7',
                            color: '#92400e',
                            border: '1px solid #fde68a',
                            padding: '6px 10px',
                            borderRadius: 6,
                            fontWeight: 700,
                            fontSize: 12,
                          }}
                        >
                          {lang === 'ta' ? 'திருத்து' : 'Correct'}
                        </button>
                        <button
                          type="button"
                          className="btn-void-mistake"
                          onClick={() => {
                            setEditingPayment(null);
                            setVoidingPayment(p);
                            setVoidReason('');
                          }}
                          style={{
                            background: '#fee2e2',
                            color: '#b91c1c',
                            border: '1px solid #fecaca',
                            padding: '6px 10px',
                            borderRadius: 6,
                            fontWeight: 700,
                            fontSize: 12,
                          }}
                        >
                          {lang === 'ta' ? 'ரத்து செய்' : 'Reverse'}
                        </button>
                      </div>
                    ) : (
                      <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700 }}>
                        {p.kind === 'reversal'
                          ? lang === 'ta'
                            ? 'ரத்து செய்யப்பட்டது'
                            : 'Reversal'
                          : lang === 'ta'
                            ? 'உறுதி செய்யப்பட்டது'
                            : 'Locked'}
                      </span>
                    )}
                  </div>
                ))
              ) : (
                <div style={{ padding: 14, textAlign: 'center', color: '#94a3b8', background: '#f8fafc', borderRadius: 8 }}>
                  <small>
                    {lang === 'ta'
                      ? 'சமீபத்திய கட்டணங்கள் எதுவும் இல்லை'
                      : 'No recent payments recorded for this customer'}
                  </small>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
