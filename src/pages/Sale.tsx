import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { api, ApiError } from '../services/api';
import type { Customer, CreatedInvoice, IconName, Product, Role } from '../types';
import { classifyProductRank } from '../data/sampleData';
import { Icon } from '../components/Icon';
import { Stepper } from '../components/Stepper';
import { AddCustomerModal } from '../components/modals/AddCustomerModal';
import { PrintInvoiceModal } from '../components/modals/PrintInvoiceModal';
import { formatMoney } from '../utils/formatters';
import {
  getPendingOperation,
  isPendingQueueReady,
  retryOperation,
  submitOnce,
  subscribePendingOps,
} from '../services/operations';
import { toInvoice } from '../utils/receipt';

interface StalePriceNotice {
  items: Array<{
    type_id: string;
    name: string;
    ta?: string;
    expected_price: number | null;
    current_price: number | null;
  }>;
  previousTotal: number;
}

const noCustomer: Customer = { id: '', name: '', phone: '', balance: 0, cans: 0 };

export function Sale({
  token,
  role = 'employee',
  onGoHome,
}: {
  token: string;
  role?: Role;
  onGoHome: () => void;
}) {
  const { t, lang, speak, showToast } = useApp();
  const [step, setStep] = useState(1);
  const [customer, setCustomer] = useState(noCustomer);
  const [pendingSwitchCustomer, setPendingSwitchCustomer] = useState<Customer | null>(null);
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [editingQty, setEditingQty] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState<boolean>(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const lastStockReqIdRef = useRef<number>(0);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [payMode, setPayMode] = useState<'cash' | 'credit' | 'custom'>('cash');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank'>('cash');
  const [cashReceived, setCashReceived] = useState<string>('');
  const [cashManuallyOverridden, setCashManuallyOverridden] = useState<boolean>(false);
  const [discountInput, setDiscountInput] = useState('');
  const [applyToOldDebt, setApplyToOldDebt] = useState<boolean>(true);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [returnCanType, setReturnCanType] = useState('');
  const [heldTypes, setHeldTypes] = useState<NonNullable<Customer['container_types']>>([]);
  const [cansReturning, setCansReturning] = useState<string>('');
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [createdInvoice, setCreatedInvoice] = useState<CreatedInvoice | null>(null);
  const checkoutInFlight = useRef(false);
  const [customerError, setCustomerError] = useState(false);
  const [, setOpsTick] = useState(0);
  const [stalePriceNotice, setStalePriceNotice] = useState<StalePriceNotice | null>(null);
  const getProductKey = (p: Product) => (p.type_id ? String(p.type_id) : '');

  useEffect(() => subscribePendingOps(() => setOpsTick((n) => n + 1)), []);

  const activeTypeIds = new Set(products.map(getProductKey).filter(Boolean));
  const missingCartEntries = Object.entries(cart).filter(
    ([key, qty]) => qty > 0 && !activeTypeIds.has(key),
  );
  const hasMissingCartItems = missingCartEntries.length > 0;

  const subtotalCents = products.reduce((sum, p) => {
    const key = getProductKey(p);
    if (!key || p.price === null || p.price === undefined) return sum;
    return sum + Math.round(p.price * 100) * (cart[key] || 0);
  }, 0);

  const subtotal = subtotalCents / 100;
  const discount = Number(discountInput) || 0;
  const discountCents = Math.round(discount * 100);
  const invalidDiscount =
    !/^\d*(?:\.\d{0,2})?$/.test(discountInput) || discountCents > subtotalCents;
  const totalCents = subtotalCents - (invalidDiscount ? 0 : discountCents);
  const total = totalCents / 100;

  // Default tender strictly to discounted invoice total (NEVER old debt + invoice!)
  useEffect(() => {
    if (payMode !== 'credit' && !cashManuallyOverridden) {
      setCashReceived(String(total));
    }
  }, [total, payMode, cashManuallyOverridden]);

  const loadData = () => {
    const reqId = ++lastStockReqIdRef.current;
    setLoadingProducts(true);
    setProductsError(null);

    api
      .get<{ products?: Partial<Product>[] } | Partial<Product>[]>('/products/list', token)
      .then((result) => {
        if (reqId !== lastStockReqIdRef.current) return;
        const rows = Array.isArray(result) ? result : (result.products ?? []);
        const mapped: Product[] = rows.map((row, index) => {
          const isCan =
            (row.unit || '').toLowerCase().includes('can') ||
            (row.name || '').includes('19') ||
            (row.name || '').includes('5 L');
          return {
            id: Number(row.id ?? index + 1),
            type_id: row.type_id ? String(row.type_id) : undefined,
            name: String(row.name || 'Product'),
            ta: String(row.ta || row.name || 'Product'),
            price: row.price !== null && row.price !== undefined ? Number(row.price) : null,
            stock: Number(row.stock ?? 0),
            unit: String(row.unit || (isCan ? 'can' : 'bottle')),
            sku: row.sku ? String(row.sku) : '',
            icon: row.icon === 'can' || isCan ? ('can' as IconName) : ('bottle' as IconName),
            is_returnable: Boolean(row.is_returnable),
            is_active: row.is_active !== false,
            low_stock_limit: row.low_stock_limit !== undefined ? Number(row.low_stock_limit) : 10,
            buying_price:
              row.buying_price !== null && row.buying_price !== undefined
                ? Number(row.buying_price)
                : null,
          };
        });
        mapped.sort((a, b) => classifyProductRank(a) - classifyProductRank(b));
        setProducts(mapped);
        setLoadingProducts(false);
      })
      .catch((err) => {
        if (reqId !== lastStockReqIdRef.current) return;
        setProductsError(err instanceof Error ? err.message : 'Failed to load products');
        setLoadingProducts(false);
      });

    setCustomerError(false);
    api
      .get<Customer[]>(`/customers/list?q=${encodeURIComponent(query)}`, token)
      .then((rows) => {
        if (reqId !== lastStockReqIdRef.current) return;
        setCustomers(rows);
        setCustomer((curr) => rows.find((row) => row.id === curr.id) || curr);
      })
      .catch(() => {
        if (reqId === lastStockReqIdRef.current) setCustomerError(true);
      });
  };

  useEffect(() => {
    loadData();
    const handleRefresh = () => loadData();
    window.addEventListener('refresh-customer-data', handleRefresh);
    window.addEventListener('refresh-stock-data', handleRefresh);
    return () => {
      window.removeEventListener('refresh-customer-data', handleRefresh);
      window.removeEventListener('refresh-stock-data', handleRefresh);
    };
  }, [token]);

  useEffect(() => {
    const timer = setTimeout(loadData, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query]);

  const handleQuantityChange = (prod: Product, val: string) => {
    const key = getProductKey(prod);
    if (!key || prod.price === null) {
      showToast(
        lang === 'ta'
          ? 'இந்த பொருளுக்கு விற்பனை விலை அமைக்கப்படவில்லை'
          : 'This product has no selling price set and cannot be billed.',
        'error',
      );
      return;
    }
    setEditingQty((prev) => ({ ...prev, [key]: val }));
    if (val.trim() === '') {
      setCart((c) => ({ ...c, [key]: 0 }));
      return;
    }
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      if (parsed > prod.stock) {
        showToast(
          lang === 'ta'
            ? `${prod.ta || prod.name}: கையிருப்பு ${prod.stock} மட்டுமே உள்ளது!`
            : `${prod.name}: Quantity exceeds available stock (${prod.stock} in stock)`,
          'error',
        );
      }
      setCart((c) => ({ ...c, [key]: Math.min(parsed, prod.stock) }));
      setStalePriceNotice(null);
    }
  };

  const handleQuantityCommit = (prod: Product) => {
    const key = getProductKey(prod);
    if (!key) return;
    const rawVal = editingQty[key];
    if (rawVal === undefined) return;
    if (rawVal.trim() === '') {
      setCart((c) => ({ ...c, [key]: 0 }));
      setEditingQty((prev) => ({ ...prev, [key]: '0' }));
      return;
    }
    const parsed = parseInt(rawVal, 10);
    if (isNaN(parsed) || parsed < 0) {
      setCart((c) => ({ ...c, [key]: 0 }));
      setEditingQty((prev) => ({ ...prev, [key]: '0' }));
    } else if (parsed > prod.stock) {
      setCart((c) => ({ ...c, [key]: prod.stock }));
      setEditingQty((prev) => ({ ...prev, [key]: String(prod.stock) }));
    } else {
      setCart((c) => ({ ...c, [key]: parsed }));
      setEditingQty((prev) => ({ ...prev, [key]: String(parsed) }));
    }
  };

  const add = (prod: Product, delta: number) => {
    const key = getProductKey(prod);
    if (!key || prod.price === null) {
      showToast(
        lang === 'ta'
          ? 'இந்த பொருளுக்கு விற்பனை விலை அமைக்கப்படவில்லை'
          : 'This product has no selling price set.',
        'error',
      );
      return;
    }
    const current = cart[key] || 0;
    const nextVal = current + delta;
    if (nextVal < 0) return;
    if (nextVal > prod.stock) {
      showToast(
        lang === 'ta'
          ? `${prod.ta || prod.name}: கையிருப்பு ${prod.stock} மட்டுமே உள்ளது!`
          : `${prod.name}: Cannot exceed available stock (${prod.stock})`,
        'error',
      );
      return;
    }
    setCart((c) => ({ ...c, [key]: nextVal }));
    setEditingQty((prev) => ({ ...prev, [key]: String(nextVal) }));
    setStalePriceNotice(null);
  };

  // Phase 1B exact tender math (Cash vs Bank Transfer)
  const invalidCash = payMode !== 'credit' && !/^\d*(?:\.\d{0,2})?$/.test(cashReceived);
  const numCashReceived = payMode === 'credit' ? 0 : Number(cashReceived) || 0;
  const tenderedCents = Math.round(numCashReceived * 100);
  const previousBalanceCents = Math.round((customer.balance || 0) * 100);
  const previousDebtCents = Math.max(0, previousBalanceCents);
  const maxBankAllowedCents = totalCents + previousDebtCents;
  const bankExcessBlocked =
    payMode !== 'credit' && paymentMethod === 'bank' && tenderedCents > maxBankAllowedCents;

  const appliedToBillCents = Math.min(totalCents, tenderedCents);
  const excessCents = Math.max(0, tenderedCents - totalCents);
  const shouldApplyToDebt =
    paymentMethod === 'bank' ? true : applyToOldDebt;
  const appliedToDebtCents =
    shouldApplyToDebt && excessCents > 0 && previousDebtCents > 0
      ? Math.min(previousDebtCents, excessCents)
      : 0;
  const changeReturnedCents =
    paymentMethod === 'bank'
      ? 0
      : Math.max(0, excessCents - appliedToDebtCents);
  const newBalanceCents =
    previousBalanceCents + (totalCents - appliedToBillCents) - appliedToDebtCents;

  const appliedToBill = appliedToBillCents / 100;
  const appliedToDebt = appliedToDebtCents / 100;
  const changeReturned = changeReturnedCents / 100;
  const previousDebt = previousDebtCents / 100;
  const newBalance = newBalanceCents / 100;

  const numCansReturn = Number(cansReturning) || 0;
  const filledCansGiven = products.reduce((sum, p) => {
    if (p.is_returnable) {
      return sum + (cart[getProductKey(p)] || 0);
    }
    return sum;
  }, 0);
  const cansAlreadyWithCustomer = customer.cans || 0;
  const cansAfterSale = cansAlreadyWithCustomer + filledCansGiven - numCansReturn;

  useEffect(() => {
    setHeldTypes([]);
    setReturnCanType('');
    if (!customer.id) return;
    let current = true;
    api
      .get<Customer>(`/customers/details/${customer.id}`, token)
      .then((row) => {
        if (current) setHeldTypes(row.container_types || []);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [customer.id, customer.cans, token]);

  const canOptions = new Map(heldTypes.map((row) => [row.type_id, row]));
  for (const p of products) {
    const type_id = getProductKey(p);
    const quantity = cart[type_id] || 0;
    if (p.is_returnable && quantity > 0) {
      canOptions.set(type_id, {
        type_id,
        name: p.name,
        ta: p.ta,
        held: (canOptions.get(type_id)?.held || 0) + quantity,
      });
    }
  }
  const selectedCanType = canOptions.size === 1 ? canOptions.keys().next().value : returnCanType;
  const invalidCans =
    !Number.isInteger(numCansReturn) ||
    numCansReturn < 0 ||
    (numCansReturn > 0 &&
      (!selectedCanType || numCansReturn > (canOptions.get(selectedCanType)?.held ?? 0)));
  const queueReady = isPendingQueueReady();
  const pendingSale = getPendingOperation('/sales/create');
  const pendingCheckout = Boolean(pendingSale);

  const saveInvoice = async (retry = false) => {
    if (checkoutInFlight.current || !queueReady) return;
    if (!retry && pendingCheckout) {
      setCheckoutError(
        lang === 'ta'
          ? 'முந்தைய பில் உறுதி செய்யப்படும் வரை புதிய பில்லை சேமிக்க முடியாது. மேலே உள்ள "அதே பில்லை மீண்டும் முயற்சி செய்" பொத்தானை அழுத்தவும்.'
          : 'A previous bill is still awaiting confirmation. Retry it above before creating a new bill.',
      );
      return;
    }
    if (
      !retry &&
      (!customer.id || invalidCans || invalidCash || invalidDiscount || bankExcessBlocked)
    )
      return;
    if (!retry && hasMissingCartItems) {
      setCheckoutError(
        lang === 'ta'
          ? 'கிடைக்காத பொருட்கள் வரைவில் உள்ளன. தொடர்வதற்கு அவற்றை நீக்கவும்.'
          : 'Some items in your draft are no longer available in the catalog. Please remove them before saving.',
      );
      return;
    }

    checkoutInFlight.current = true;
    setSaving(true);
    setCheckoutError(null);
    if (!retry) {
      setStalePriceNotice(null);
    }
    try {
      const saleItems = Object.entries(cart)
        .filter(([, q]) => q > 0)
        .map(([key, quantity]) => {
          const prod = products.find((p) => getProductKey(p) === key);
          return {
            product_id: prod?.id,
            type_id: prod?.type_id || key,
            name: prod?.name || `Item ${key}`,
            ta: prod?.ta,
            price: prod?.price || 0,
            quantity,
            subtotal: (prod?.price || 0) * quantity,
          };
        });

      const res = retry
        ? await retryOperation<any>('/sales/create', token)
        : await submitOnce<any>(
            '/sales/create',
            {
              customer_id: customer.id,
              items: saleItems,
              payment_type: payMode,
              payment_method: paymentMethod,
              discount: discountCents / 100,
              cash_received: numCashReceived,
              amount_paid: appliedToBill,
              apply_to_old_debt: shouldApplyToDebt,
              expected_previous_balance: customer.balance,
              empty_cans_returned: numCansReturn,
              ...(numCansReturn > 0 ? { return_container_type_id: selectedCanType } : {}),
            },
            token,
            {
              customerId: customer.id,
              customerName: customer.name,
              customerNameTa: customer.name_ta,
              amount: total,
            },
          );

      const invoice = toInvoice(res.receipt);
      speak('Invoice saved and stock updated', 'இன்வாய்ஸ் சேமிக்கப்பட்டு சரக்கு குறைக்கப்பட்டது');
      showToast(
        lang === 'ta'
          ? `இன்வாய்ஸ் ${invoice.invoice_number} சேமிக்கப்பட்டது!`
          : `Invoice ${invoice.invoice_number} saved.`,
        'success',
      );
      setCreatedInvoice(invoice);
      setStalePriceNotice(null);

      if (!retry) {
        setCart({});
        setDiscountInput('');
        setPayMode('cash');
        setPaymentMethod('cash');
        setApplyToOldDebt(true);
        setEditingQty({});
        setCansReturning('');
        setCashReceived('');
        setCashManuallyOverridden(false);
      }
      if (
        res.new_cans_balance !== undefined &&
        (!res.customer_id || String(res.customer_id) === String(customer.id))
      ) {
        setCustomer((prev) => ({
          ...prev,
          balance: res.new_balance,
          cans: res.new_cans_balance,
        }));
      }
      loadData();
      window.dispatchEvent(new CustomEvent('refresh-customer-data'));
      window.dispatchEvent(new CustomEvent('refresh-stock-data'));
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'stale_price') {
        const rawItems = (err.details as { stale_items?: StalePriceNotice['items'] } | undefined)
          ?.stale_items;
        setStalePriceNotice({
          items: Array.isArray(rawItems) ? rawItems : [],
          previousTotal: total,
        });
        setCheckoutError(
          lang === 'ta'
            ? 'பொருளின் விலை மாறியுள்ளது. புதிய தொகையைச் சரிபார்த்து மீண்டும் "பில்லை சேமிக்க" என்பதை அழுத்தவும்.'
            : 'Product prices changed before saving. Review the updated total and click Save Bill again to confirm.',
        );
        loadData();
      } else if (err instanceof ApiError && err.code === 'stale_balance') {
        setCheckoutError(
          lang === 'ta'
            ? 'வாடிக்கையாளரின் கடன் தொகை மாறியுள்ளது. புதிய தொகையை சரிபார்க்கவும்.'
            : 'Customer balance changed while reviewing. Please verify the updated numbers.',
        );
        loadData();
      } else if (err instanceof ApiError && err.code === 'pending_operation_exists') {
        setCheckoutError(
          lang === 'ta'
            ? 'முந்தைய பில் உறுதி செய்யப்படும் வரை புதிய பில்லை சேமிக்க முடியாது.'
            : 'A previous bill is still pending confirmation. Retry it above before creating a new bill.',
        );
      } else if (err instanceof ApiError && err.code === 'queue_not_ready') {
        setCheckoutError(
          lang === 'ta'
            ? 'நிலுவை பதிவுகளைச் சரிபார்க்கிறது. சிறிது நேரத்தில் முயற்சிக்கவும்.'
            : 'Still checking pending operations. Please wait a moment and try again.',
        );
      } else if (err instanceof ApiError && err.notPosted) {
        setCheckoutError(err.message);
      } else {
        setCheckoutError(
          lang === 'ta'
            ? 'இன்வாய்ஸ் சேமிக்கப்பட்டதா என சோதிக்கவும். மேலே உள்ள "அதே பில்லை மீண்டும் முயற்சி செய்" பொத்தானைப் பயன்படுத்தவும்.'
            : 'Could not confirm the invoice. Use "Retry the same bill" above.',
        );
      }
      speak('Invoice not confirmed', 'இன்வாய்ஸ் உறுதி செய்யப்படவில்லை');
    } finally {
      checkoutInFlight.current = false;
      setSaving(false);
    }
  };

  const isEmptyCanProduct = (p: Partial<Product>) => {
    const n = (p.name || '').toLowerCase();
    return n.includes('empty');
  };
  const regularWaterProducts = products.filter((p) => !isEmptyCanProduct(p));
  const emptyCanProducts = products.filter((p) => isEmptyCanProduct(p));

  const pendingSaleCustomerLabel = pendingSale?.meta
    ? lang === 'ta' && pendingSale.meta.customerNameTa
      ? pendingSale.meta.customerNameTa
      : pendingSale.meta.customerName || pendingSale.meta.customerId || ''
    : '';
  const pendingSaleAmount =
    pendingSale?.meta && typeof pendingSale.meta.amount === 'number'
      ? pendingSale.meta.amount
      : null;

  return (
    <div className="workflow-page sale-page">
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
            ? 'முந்தைய நிலுவை பில்களைச் சரிபார்க்கிறது...'
            : 'Checking pending bills before enabling checkout...'}
        </div>
      )}

      {pendingCheckout && !createdInvoice && (
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
            {lang === 'ta'
              ? 'முந்தைய பில் உறுதி செய்யப்படவில்லை. புதிய பில் சேமிப்பு தற்காலிகமாக நிறுத்தப்பட்டுள்ளது.'
              : 'Previous bill is not confirmed. New bill submissions are blocked until this bill is resolved.'}
          </p>
          {(pendingSaleCustomerLabel || pendingSaleAmount !== null) && (
            <p style={{ margin: '0 0 10px 0', fontSize: 13, fontWeight: 700, color: '#78350f' }}>
              {lang === 'ta' ? 'அசல் பில்:' : 'Original bill:'}{' '}
              {pendingSaleCustomerLabel || (lang === 'ta' ? 'வாடிக்கையாளர்' : 'Customer')}
              {pendingSaleAmount !== null ? ` • ${formatMoney(pendingSaleAmount)}` : ''}
            </p>
          )}
          <button
            type="button"
            className="primary-action"
            style={{ marginTop: 0 }}
            disabled={saving || !queueReady}
            onClick={() => saveInvoice(true)}
          >
            {saving
              ? '...'
              : lang === 'ta'
                ? 'அதே பில்லை மீண்டும் முயற்சி செய்'
                : 'Retry the same bill'}
          </button>
        </div>
      )}

      <div className="subbar-nav">
        <button
          type="button"
          className="subbar-btn"
          onClick={() => (step > 1 ? setStep(step - 1) : onGoHome())}
          title={step > 1 ? t('back') : t('home')}
        >
          <Icon name="back" size={16} />
          <span>{step > 1 ? t('back') : t('home')}</span>
        </button>

        <div className="subbar-center">
          <Stepper step={step} />
        </div>

        <div className="subbar-right" />
      </div>

      {/* STEP 1: Select Customer */}
      {step === 1 && (
        <section className="sale-step1-layout">
          <div className="workflow-card inside-scroll">
            <div className="customer-search-row">
              <label className="customer-search-box">
                <Icon name="search" size={20} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('findCustomer')}
                  autoFocus
                />
                {query && (
                  <button type="button" className="clear-search-btn" onClick={() => setQuery('')}>
                    ✕
                  </button>
                )}
              </label>
              <button
                type="button"
                className="btn-add-customer-quick"
                onClick={() => setShowAddCustomerModal(true)}
                title="Add New Customer"
              >
                <Icon name="plus" size={14} />
                <span>{lang === 'ta' ? 'புதியவர்' : '+ New'}</span>
              </button>
            </div>

            {pendingSwitchCustomer && (
              <div className="inline-confirm-bar" style={{ marginTop: 10 }}>
                <span>
                  {lang === 'ta'
                    ? `வாடிக்கையாளரை '${pendingSwitchCustomer.name}' ஆக மாற்றவா? நடப்பு சரக்குகள் தொடரும்.`
                    : `Switch draft customer to '${pendingSwitchCustomer.name}'? Draft items will stay.`}
                </span>
                <div className="inline-confirm-actions">
                  <button
                    type="button"
                    className="btn-cancel"
                    style={{ padding: '4px 10px' }}
                    onClick={() => setPendingSwitchCustomer(null)}
                  >
                    {lang === 'ta' ? 'ரத்து' : 'Cancel'}
                  </button>
                  <button
                    type="button"
                    className="btn-primary-small"
                    style={{ padding: '4px 10px', background: '#2864dc', color: '#fff', border: 'none', borderRadius: 6 }}
                    onClick={() => {
                      setCustomer(pendingSwitchCustomer);
                      setPendingSwitchCustomer(null);
                    }}
                  >
                    {lang === 'ta' ? 'மாற்று' : 'Switch'}
                  </button>
                </div>
              </div>
            )}

            <div className="choice-list inside-scroll">
              {customerError && (
                <p role="alert">
                  {lang === 'ta' ? 'வாடிக்கையாளர்களை ஏற்ற முடியவில்லை' : 'Could not load customers'}
                </p>
              )}
              {customers
                .filter(
                  (c) =>
                    c.name.toLowerCase().includes(query.toLowerCase()) ||
                    (c.name_ta || '').toLowerCase().includes(query.toLowerCase()) ||
                    c.phone.includes(query),
                )
                .map((c) => (
                  <button
                    type="button"
                    className={`customer-item-btn ${customer && customer.id === c.id ? 'selected' : ''}`}
                    key={String(c.id)}
                    onClick={() => {
                      if (
                        customer &&
                        customer.id &&
                        customer.id !== c.id &&
                        Object.values(cart).some((q) => q > 0)
                      ) {
                        setPendingSwitchCustomer(c);
                        return;
                      }
                      setCustomer(c);
                    }}
                  >
                    <span className="cust-info">
                      <b>{lang === 'ta' && c.name_ta ? c.name_ta : c.name}</b>
                      <small>
                        <Icon name="phone" size={12} /> {c.phone}
                      </small>
                    </span>
                    <strong className={c.balance > 0 ? 'debt' : 'credit'}>
                      {formatMoney(Math.abs(c.balance))}
                    </strong>
                  </button>
                ))}
            </div>
          </div>

          <div className="selected-customer-preview workflow-card">
            {customer.id ? (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                  <div className="large-avatar" style={{ margin: 0 }}>
                    {customer.name[0]?.toUpperCase() || 'C'}
                  </div>
                  <div>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900, color: '#0f172a' }}>
                      {lang === 'ta' && customer.name_ta ? customer.name_ta : customer.name}
                    </h2>
                    <p style={{ margin: '2px 0 0 0', color: '#64748b', fontSize: 13 }}>
                      <Icon name="phone" size={12} /> {customer.phone || 'No phone added'}
                      {customer.address ? ` • ${customer.address}` : ''}
                    </p>
                  </div>
                </div>

                <div className="customer-metrics-grid" style={{ marginBottom: 20 }}>
                  <div className={`customer-metric-card ${customer.balance > 0 ? 'debt' : 'credit'}`}>
                    <span className="metric-label">
                      {lang === 'ta' ? 'நிலுவை கடன்' : 'Outstanding Debt'}
                    </span>
                    <span className="metric-value tabular-nums">
                      {formatMoney(Math.abs(customer.balance))}
                    </span>
                  </div>
                  <div className="customer-metric-card limit">
                    <span className="metric-label">{lang === 'ta' ? 'கடன் வரம்பு' : 'Credit Limit'}</span>
                    <span className="metric-value tabular-nums">
                      {formatMoney(Number(customer.credit_limit || 0))}
                    </span>
                  </div>
                  <div className="customer-metric-card cans">
                    <span className="metric-label">{lang === 'ta' ? 'காலி கேன்கள்' : 'Cans Held'}</span>
                    <span className="metric-value tabular-nums">
                      {customer.cans} {lang === 'ta' ? 'கேன்கள்' : 'cans'}
                    </span>
                  </div>
                </div>

                <div
                  style={{
                    background: '#f8fafc',
                    padding: '12px 14px',
                    borderRadius: 8,
                    border: '1px solid #e2e8f0',
                    marginBottom: 20,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>
                    {lang === 'ta' ? 'பில் தொடங்குவதற்கான தயார் நிலை' : 'Ready to Bill'}
                  </div>
                  <small style={{ color: '#64748b', display: 'block', marginTop: 2 }}>
                    {lang === 'ta'
                      ? 'வாடிக்கையாளர் தேர்ந்தெடுக்கப்பட்டார். சரக்குகளைத் தேர்வு செய்ய கீழே உள்ள பொத்தானை அழுத்தவும்.'
                      : 'Customer selected. Click below to start adding water bottles and containers to this order.'}
                  </small>
                </div>

                <div style={{ marginTop: 'auto' }}>
                  <button
                    type="button"
                    className="primary-action"
                    onClick={() => setStep(2)}
                    style={{ width: '100%' }}
                  >
                    <Icon name="sale" size={20} />
                    <span>
                      {lang === 'ta' ? 'சரக்கு சேர்க்க தொடங்கு →' : 'Start adding items →'}
                    </span>
                  </button>
                </div>
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  color: '#94a3b8',
                }}
              >
                <Icon name="user" size={48} />
                <p style={{ marginTop: 12, fontWeight: 700, fontSize: 15 }}>
                  {lang === 'ta' ? 'வாடிக்கையாளரை தேர்ந்தெடுக்கவும்' : 'Select a customer to begin invoice'}
                </p>
                <small style={{ color: '#64748b', textAlign: 'center', maxWidth: 280 }}>
                  {lang === 'ta'
                    ? 'இடதுபுறப் பட்டியலில் உள்ள வாடிக்கையாளரைத் தொடவும்'
                    : 'Click any customer from the list on the left to review their balance and start billing.'}
                </small>
              </div>
            )}
          </div>
        </section>
      )}

      {/* STEP 2: Pick Products & Cart */}
      {step === 2 && (
        <section className="sale-step2-layout">
          <div className="product-selection-pane inside-scroll">
            {hasMissingCartItems && (
              <div
                style={{
                  padding: 12,
                  marginBottom: 14,
                  background: '#fef2f2',
                  border: '1px solid #f87171',
                  borderRadius: 8,
                  color: '#991b1b',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <b>{lang === 'ta' ? 'கிடைக்காத பொருட்கள் வரைவில் உள்ளன' : 'Unavailable Items in Draft'}</b>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCart((prev) => {
                        const next = { ...prev };
                        missingCartEntries.forEach(([k]) => delete next[k]);
                        return next;
                      });
                    }}
                    style={{
                      padding: '6px 12px',
                      background: '#dc2626',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      fontWeight: 700,
                      fontSize: 12,
                    }}
                  >
                    {lang === 'ta' ? 'கிடைக்காதவற்றை நீக்கு' : 'Remove Unavailable Items'}
                  </button>
                </div>
              </div>
            )}

            {productsError && (
              <div style={{ padding: 12, marginBottom: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c' }}>
                <p style={{ margin: 0, fontWeight: 700 }}>{productsError}</p>
              </div>
            )}

            {loadingProducts && products.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>
                {lang === 'ta' ? 'பொருட்கள் ஏற்றப்படுகின்றன...' : 'Loading products...'}
              </div>
            )}

            <div className="category-section-label">
              <span>{lang === 'ta' ? 'தண்ணீர் வகைகள்' : 'Water Categories'}</span>
            </div>
            <div className="product-grid">
              {regularWaterProducts.map((p) => {
                const canSell = Boolean(p.type_id && p.price !== null && p.stock > 0);
                const key = getProductKey(p);
                const currentQty = key ? cart[key] || 0 : 0;
                const displayQty = key && editingQty[key] !== undefined ? editingQty[key] : String(currentQty);
                return (
                  <div className={`product-card ${p.stock < 10 ? 'low' : ''}`} key={key || `no-type-${p.id}`}>
                    <button
                      type="button"
                      className="product-main"
                      disabled={!canSell}
                      onClick={() => canSell && add(p, 1)}
                    >
                      <span className="product-icon">
                        <Icon name={p.icon} size={32} />
                      </span>
                      <b className="product-title">{lang === 'ta' ? p.ta : p.name}</b>
                      <strong className="product-price-tag">
                        {p.price !== null ? formatMoney(p.price) : lang === 'ta' ? 'விலை இல்லை' : 'Price not set'}
                      </strong>
                      <span
                        className="stock-badge"
                        style={{
                          background: p.stock === 0 ? '#dc2626' : p.stock <= (p.low_stock_limit ?? 10) ? '#f59e0b' : '#e2e8f0',
                          color: p.stock <= (p.low_stock_limit ?? 10) ? '#fff' : '#0f172a',
                        }}
                      >
                        {p.stock} {p.unit}
                      </span>
                    </button>
                    <div className="quantity-control">
                      <button type="button" disabled={!canSell} onClick={() => add(p, -1)} aria-label="Decrease quantity">
                        <Icon name="minus" size={16} />
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        disabled={!canSell}
                        value={displayQty}
                        onChange={(e) => handleQuantityChange(p, e.target.value)}
                        onBlur={() => handleQuantityCommit(p)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                        style={{
                          width: 44,
                          height: 32,
                          textAlign: 'center',
                          fontWeight: 900,
                          fontSize: 15,
                          border: '1px solid #cbd5e1',
                          borderRadius: 6,
                          background: canSell ? '#ffffff' : '#f1f5f9',
                        }}
                      />
                      <button type="button" disabled={!canSell} onClick={() => add(p, 1)} aria-label="Increase quantity">
                        <Icon name="plus" size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {emptyCanProducts.length > 0 && (
              <div className="empty-cans-separate-section" style={{ marginTop: 14 }}>
                <div className="category-section-label empty-can-label">
                  <Icon name="can" size={18} />
                  <span>{lang === 'ta' ? '19L காலி கேன் விற்பனை' : '19L Empty Cans'}</span>
                </div>
                <div className="product-grid single-row">
                  {emptyCanProducts.map((p) => {
                    const canSell = Boolean(p.type_id && p.price !== null && p.stock > 0);
                    const key = getProductKey(p);
                    const currentQty = key ? cart[key] || 0 : 0;
                    const displayQty = key && editingQty[key] !== undefined ? editingQty[key] : String(currentQty);
                    return (
                      <div className={`product-card empty-can-card ${p.stock < 10 ? 'low' : ''}`} key={key || `no-type-${p.id}`}>
                        <button type="button" className="product-main" disabled={!canSell} onClick={() => canSell && add(p, 1)}>
                          <span className="product-icon">
                            <Icon name="can" size={32} />
                          </span>
                          <b className="product-title">{lang === 'ta' ? p.ta : p.name}</b>
                          <strong className="product-price-tag">
                            {p.price !== null ? formatMoney(p.price) : lang === 'ta' ? 'விலை இல்லை' : 'Price not set'}
                          </strong>
                          <span
                            className="stock-badge"
                            style={{
                              background: p.stock === 0 ? '#dc2626' : '#e2e8f0',
                              color: p.stock === 0 ? '#fff' : '#0f172a',
                            }}
                          >
                            {p.stock} {p.unit}
                          </span>
                        </button>
                        <div className="quantity-control">
                          <button type="button" disabled={!canSell} onClick={() => add(p, -1)} aria-label="Decrease quantity">
                            <Icon name="minus" size={16} />
                          </button>
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            disabled={!canSell}
                            value={displayQty}
                            onChange={(e) => handleQuantityChange(p, e.target.value)}
                            onBlur={() => handleQuantityCommit(p)}
                            style={{
                              width: 44,
                              height: 32,
                              textAlign: 'center',
                              fontWeight: 900,
                              fontSize: 15,
                              border: '1px solid #cbd5e1',
                              borderRadius: 6,
                              background: canSell ? '#ffffff' : '#f1f5f9',
                            }}
                          />
                          <button type="button" disabled={!canSell} onClick={() => add(p, 1)} aria-label="Increase quantity">
                            <Icon name="plus" size={16} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="workflow-card live-cart-pane">
            <div className="live-cart-header">
              <span className="avatar">{customer.name[0]}</span>
              <div>
                <b>{lang === 'ta' && customer.name_ta ? customer.name_ta : customer.name}</b>
                <small>{customer.phone}</small>
              </div>
              <span className="live-pill" style={{ marginLeft: 'auto', fontSize: 11 }}>
                {lang === 'ta' ? `கடன்: ${formatMoney(customer.balance)}` : `Debt: ${formatMoney(customer.balance)}`}
              </span>
            </div>

            <div className="cart-items-list inside-scroll">
              {Object.entries(cart).filter(([, q]) => q > 0).length === 0 ? (
                <div className="empty-cart-hint">
                  <Icon name="sale" size={32} />
                  <span>{t('chooseItems')}</span>
                </div>
              ) : (
                Object.entries(cart)
                  .filter(([, q]) => q > 0)
                  .map(([key, q]) => {
                    const prod = products.find((p) => getProductKey(p) === key);
                    if (!prod) return null;
                    const displayQty = editingQty[key] !== undefined ? editingQty[key] : String(q);
                    return (
                      <div className="cart-item-row" key={key}>
                        <div className="item-meta">
                          <b>{lang === 'ta' ? prod.ta : prod.name}</b>
                          <small>
                            {formatMoney(prod.price)} × {q} {prod.unit}
                          </small>
                        </div>
                        <div className="item-stepper">
                          <button type="button" onClick={() => add(prod, -1)}>-</button>
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={displayQty}
                            onChange={(e) => handleQuantityChange(prod, e.target.value)}
                            onBlur={() => handleQuantityCommit(prod)}
                            style={{
                              width: 40,
                              height: 28,
                              textAlign: 'center',
                              fontWeight: 900,
                              fontSize: 14,
                              border: '1px solid #cbd5e1',
                              borderRadius: 6,
                              background: '#ffffff',
                            }}
                          />
                          <button type="button" onClick={() => add(prod, 1)}>+</button>
                        </div>
                        <strong className="item-subtotal tabular-nums">
                          {formatMoney((prod.price || 0) * q)}
                        </strong>
                      </div>
                    );
                  })
              )}
            </div>

            <div className="live-cart-footer">
              <div className="cart-total-bar">
                <span>{t('total')}</span>
                <b className="tabular-nums">{formatMoney(subtotal)}</b>
              </div>
              <div className="cart-actions-row">
                <button type="button" className="back-step-btn" onClick={() => setStep(1)}>
                  ← {t('back')}
                </button>
                <button
                  type="button"
                  className="next-step-btn"
                  disabled={!subtotal || hasMissingCartItems}
                  onClick={() => setStep(3)}
                >
                  {t('next')} →
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* STEP 3: Pay & Save */}
      {step === 3 && (
        <section className="sale-step3-layout">
          <div className="workflow-card sale-step3-col inside-scroll" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span className="success-mark" style={{ width: 44, height: 44, margin: 0 }}>
                <Icon name="receipt" size={24} />
              </span>
              <div>
                <b style={{ fontSize: 17 }}>
                  {lang === 'ta' && customer.name_ta ? customer.name_ta : customer.name}
                </b>
                <small style={{ display: 'block', color: '#64748b' }}>
                  {customer.phone || 'No phone added'} {customer.address ? `• ${customer.address}` : ''}
                </small>
              </div>
            </div>

            <div
              style={{
                background: '#f8fafc',
                borderRadius: 10,
                padding: '8px 12px',
                border: '1px solid #e2e8f0',
                marginBottom: 12,
                maxHeight: 160,
                overflowY: 'auto',
              }}
            >
              {Object.entries(cart)
                .filter(([, q]) => q > 0)
                .map(([key, q]) => {
                  const prod = products.find((p) => getProductKey(p) === key);
                  if (!prod) return null;
                  return (
                    <div
                      key={key}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '5px 0',
                        borderBottom: '1px dashed #f1f5f9',
                        fontSize: 13,
                      }}
                    >
                      <span>
                        {lang === 'ta' ? prod.ta : prod.name}{' '}
                        <small style={{ color: '#64748b' }}>
                          × {q} {prod.unit}
                        </small>
                      </span>
                      <b className="tabular-nums">{formatMoney((prod.price || 0) * q)}</b>
                    </div>
                  );
                })}
            </div>

            <label className="large-cash-box" style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>
                {lang === 'ta' ? 'தள்ளுபடி (Rs.)' : 'Discount (Rs.)'}
              </span>
              <input
                type="number"
                min="0"
                max={subtotal}
                step="0.01"
                value={discountInput}
                onChange={(e) => setDiscountInput(e.target.value)}
                placeholder="0"
              />
            </label>
            {invalidDiscount && (
              <p role="alert" style={{ color: '#dc2626', fontSize: 12, fontWeight: 700 }}>
                {lang === 'ta'
                  ? 'தள்ளுபடி கூட்டுத்தொகையை விட அதிகமாக இருக்கக் கூடாது.'
                  : 'Enter a discount no greater than the subtotal.'}
              </p>
            )}

            <div className="kadan-breakdown-box">
              <div className="breakdown-row">
                <span>
                  {customer.balance < 0
                    ? lang === 'ta'
                      ? 'முந்தைய வரவு'
                      : 'Previous Credit'
                    : lang === 'ta'
                      ? 'பழைய கடன்'
                      : 'Previous Debt'}
                </span>
                <b className="tabular-nums">{formatMoney(Math.abs(customer.balance))}</b>
              </div>
              <div className="breakdown-row highlight">
                <span>{lang === 'ta' ? 'இன்றைய இன்வாய்ஸ்' : "Today's Invoice Total"}</span>
                <b className="tabular-nums">{formatMoney(total)}</b>
              </div>
              <div className="breakdown-row total-row">
                <span>{lang === 'ta' ? 'மொத்த நிலுவை' : 'Total Outstanding'}</span>
                <strong className="tabular-nums">{formatMoney(customer.balance + total)}</strong>
              </div>
            </div>

            <div
              className="returnable-cans-summary-panel"
              style={{
                marginTop: 12,
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                padding: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Icon name="can" size={18} />
                <b style={{ fontSize: 13, color: '#0f172a' }}>
                  {lang === 'ta' ? 'திருப்பித் தரும் கேன்கள் கணக்கு' : 'Returnable Cans Account'}
                </b>
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: '#ffffff',
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid #cbd5e1',
                  marginBottom: 8,
                }}
              >
                <div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>
                    {lang === 'ta' ? 'காலி கேன் வரவு:' : 'Empty Cans Returned:'}
                  </span>
                  <small style={{ display: 'block', color: '#64748b' }}>
                    {lang === 'ta'
                      ? `வாடிக்கையாளரிடம்: ${cansAlreadyWithCustomer} கேன்கள்`
                      : `Customer holds: ${cansAlreadyWithCustomer} cans`}
                  </small>
                </div>
                <div className="large-cash-box mini-box" style={{ width: 88, margin: 0 }}>
                  <input
                    type="number"
                    min="0"
                    value={cansReturning}
                    onChange={(e) => setCansReturning(e.target.value)}
                    placeholder="0"
                    style={{ width: '100%', textAlign: 'center', fontWeight: 800, fontSize: 16 }}
                  />
                </div>
              </div>

              {numCansReturn > 0 && canOptions.size > 1 && (
                <label style={{ display: 'grid', gap: 4, marginBottom: 8, fontSize: 12, fontWeight: 700 }}>
                  <span>{lang === 'ta' ? 'கேன் வகை' : 'Can type'}</span>
                  <select
                    value={returnCanType}
                    onChange={(e) => setReturnCanType(e.target.value)}
                    style={{ padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                  >
                    <option value="">{lang === 'ta' ? 'வகையைத் தேர்ந்தெடு' : 'Choose type'}</option>
                    {[...canOptions.values()].map((row) => (
                      <option key={row.type_id} value={row.type_id}>
                        {lang === 'ta' ? row.ta || row.name : row.name} ({row.held})
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {invalidCans && (
                <p role="alert" style={{ color: '#dc2626', fontSize: 12, fontWeight: 700 }}>
                  {lang === 'ta' ? 'கேன் வகையையும் எண்ணிக்கையையும் சரிபார்க்கவும்.' : 'Check the can type and quantity.'}
                </p>
              )}

              <div
                style={{
                  background: '#f1f5f9',
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontSize: 12,
                  display: 'grid',
                  gap: 4,
                  border: '1px solid #e2e8f0',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#475569' }}>
                  <span>{lang === 'ta' ? 'ஏற்கனவே உள்ள கேன்கள்:' : 'Cans already held:'}</span>
                  <b>{cansAlreadyWithCustomer}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#0284c7' }}>
                  <span>{lang === 'ta' ? 'இன்று வழங்கப்பட்டவை:' : 'Filled cans given today:'}</span>
                  <b>+{filledCansGiven}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#15803d' }}>
                  <span>{lang === 'ta' ? 'பெறப்பட்ட காலிகள்:' : 'Empty cans received:'}</span>
                  <b>−{numCansReturn}</b>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    borderTop: '1px dashed #cbd5e1',
                    paddingTop: 4,
                    fontWeight: 800,
                    color: '#0f172a',
                  }}
                >
                  <span>{lang === 'ta' ? 'விற்பனைக்குப் பின் கேன்கள்:' : 'Cans after this sale:'}</span>
                  <b style={{ color: cansAfterSale > 0 ? '#0284c7' : '#334155' }}>{cansAfterSale}</b>
                </div>
              </div>
            </div>
          </div>

          <div className="workflow-card sale-step3-col inside-scroll" style={{ padding: 20 }}>
            <p className="eyebrow" style={{ margin: '0 0 8px 0' }}>
              {lang === 'ta' ? 'செலுத்தும் முறை' : 'Payment Mode'}
            </p>
            <div className="payment-types" style={{ margin: '0 0 10px 0', gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <button
                type="button"
                className={payMode === 'cash' ? 'selected' : ''}
                onClick={() => {
                  setPayMode('cash');
                  setCashManuallyOverridden(false);
                  setCashReceived(String(total));
                }}
              >
                <Icon name="cash" size={18} />
                <span>{lang === 'ta' ? 'முழுத் தொகை' : 'Pay Now'}</span>
              </button>
              <button
                type="button"
                className={payMode === 'credit' ? 'selected' : ''}
                onClick={() => {
                  setPayMode('credit');
                  setCashManuallyOverridden(true);
                  setCashReceived('0');
                }}
              >
                <Icon name="calendar" size={18} />
                <span>{lang === 'ta' ? 'கடன்' : 'Credit'}</span>
              </button>
              <button
                type="button"
                className={payMode === 'custom' ? 'selected' : ''}
                onClick={() => {
                  setPayMode('custom');
                  if (!cashReceived) setCashReceived(String(total));
                }}
              >
                <Icon name="wallet" size={18} />
                <span>{lang === 'ta' ? 'பகுதி / அதிகம்' : 'Custom'}</span>
              </button>
            </div>

            {payMode !== 'credit' && (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  {(['cash', 'bank'] as const).map((method) => (
                    <button
                      key={method}
                      type="button"
                      onClick={() => setPaymentMethod(method)}
                      style={{
                        flex: 1,
                        padding: '9px 10px',
                        borderRadius: 10,
                        border: paymentMethod === method ? '2px solid #2864dc' : '1px solid #cbd5e1',
                        background: paymentMethod === method ? '#e9f0ff' : '#ffffff',
                        color: paymentMethod === method ? '#2864dc' : '#475569',
                        fontWeight: 800,
                        fontSize: 13,
                      }}
                    >
                      {method === 'cash'
                        ? lang === 'ta'
                          ? 'ரொக்கம் (Cash)'
                          : 'Cash'
                        : lang === 'ta'
                          ? 'வங்கி பரிமாற்றம் (Bank Transfer)'
                          : 'Bank Transfer'}
                    </button>
                  ))}
                </div>

                <div className="tender-section" style={{ width: '100%', marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <label style={{ fontWeight: 700, fontSize: 14 }}>
                      {paymentMethod === 'bank'
                        ? lang === 'ta'
                          ? 'வங்கி பரிமாற்ற தொகை:'
                          : 'Bank Transfer Amount:'
                        : lang === 'ta'
                          ? 'பெற்ற ரொக்கம்:'
                          : 'Cash Received:'}
                    </label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        style={{ padding: '4px 8px', fontSize: 12, borderRadius: 6, border: '1px solid #cbd5e1', background: '#f8fafc' }}
                        onClick={() => {
                          setCashReceived(String(total));
                          setCashManuallyOverridden(false);
                        }}
                      >
                        {formatMoney(total)} ({lang === 'ta' ? 'பில்' : 'Exact'})
                      </button>
                      {previousDebt > 0 && (
                        <button
                          type="button"
                          style={{ padding: '4px 8px', fontSize: 12, borderRadius: 6, border: '1px solid #cbd5e1', background: '#f8fafc' }}
                          onClick={() => {
                            setCashReceived(String(total + previousDebt));
                            setCashManuallyOverridden(true);
                          }}
                        >
                          {formatMoney(total + previousDebt)} ({lang === 'ta' ? 'முழு கடன்' : '+Old Debt'})
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="large-cash-box">
                    <span className="cash-box-prefix">Rs.</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={cashReceived}
                      onChange={(e) => {
                        setCashReceived(e.target.value);
                        setCashManuallyOverridden(true);
                      }}
                      placeholder={String(total)}
                      style={{ fontSize: 20, fontWeight: 700 }}
                    />
                  </div>

                  {bankExcessBlocked && (
                    <div className="error-box" role="alert" style={{ marginTop: 10 }}>
                      <Icon name="warning" size={18} />
                      <span>
                        {lang === 'ta'
                          ? `வங்கி பரிமாற்றம் ${formatMoney(total + previousDebt)} ஐ விட அதிகமாக இருக்க முடியாது (மீதிப் பணம் வங்கியில் வழங்க முடியாது).`
                          : `Bank Transfer cannot exceed invoice total + old debt (${formatMoney(total + previousDebt)}).`}
                      </span>
                    </div>
                  )}

                  {!bankExcessBlocked && numCashReceived > total && previousDebt > 0 && (
                    <div
                      style={{
                        marginTop: 10,
                        padding: 12,
                        background: '#f0fdf4',
                        border: '1px solid #bbf7d0',
                        borderRadius: 10,
                      }}
                    >
                      {paymentMethod === 'cash' && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 700, color: '#166534' }}>
                            <input
                              type="checkbox"
                              checked={applyToOldDebt}
                              onChange={(e) => setApplyToOldDebt(e.target.checked)}
                              style={{ width: 18, height: 18 }}
                            />
                            <span>
                              {lang === 'ta'
                                ? 'கூடுதல் தொகையை பழைய கடனில் கழிக்கவும்'
                                : 'Apply excess to old debt'}
                            </span>
                          </label>
                        </div>
                      )}
                      <div style={{ fontSize: 13, color: '#14532d', display: 'grid', gap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>{lang === 'ta' ? 'இந்த பில்லுக்கு:' : 'Applied to this invoice:'}</span>
                          <b className="tabular-nums">{formatMoney(appliedToBill)}</b>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>{lang === 'ta' ? 'பழைய கடனுக்கு வரவு:' : 'Applied to old debt:'}</span>
                          <b className="tabular-nums">{formatMoney(appliedToDebt)}</b>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>{lang === 'ta' ? 'திருப்பித் தரும் மீதிப் பணம்:' : 'Change returned:'}</span>
                          <b className="tabular-nums" style={{ color: '#15803d' }}>
                            {formatMoney(changeReturned)}
                          </b>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #86efac', paddingTop: 4 }}>
                          <span>{lang === 'ta' ? 'மீதமுள்ள பழைய கடன்:' : 'Remaining old debt:'}</span>
                          <b className="tabular-nums" style={{ color: '#b45309' }}>
                            {formatMoney(Math.max(0, previousDebt - appliedToDebt))}
                          </b>
                        </div>
                      </div>
                    </div>
                  )}

                  {!bankExcessBlocked && paymentMethod === 'cash' && numCashReceived > total && previousDebt === 0 && (
                    <div
                      style={{
                        marginTop: 10,
                        padding: 10,
                        background: '#eff6ff',
                        border: '1px solid #bfdbfe',
                        borderRadius: 8,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ color: '#1e40af', fontWeight: 700 }}>
                        {lang === 'ta' ? 'திருப்பித் தரும் சில்லறை:' : 'Change to return:'}
                      </span>
                      <b className="tabular-nums" style={{ color: '#15803d', fontSize: 18 }}>
                        {formatMoney(changeReturned)}
                      </b>
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="resulting-balance-banner" style={{ marginTop: 'auto', marginBottom: 12 }}>
              <span>{lang === 'ta' ? 'பில்லுக்குப் பின் மொத்த கடன்:' : 'Total Debt After Bill:'}</span>
              <b className="tabular-nums" style={{ color: newBalance > 0 ? '#b45309' : '#15803d' }}>
                {formatMoney(newBalance)}
              </b>
            </div>

            {stalePriceNotice && (
              <div
                role="alert"
                style={{
                  marginBottom: 10,
                  padding: '10px 12px',
                  background: '#fffbeb',
                  border: '1px solid #f59e0b',
                  borderRadius: 8,
                  color: '#92400e',
                  fontSize: 13,
                }}
              >
                <div style={{ fontWeight: 800, marginBottom: 4 }}>
                  {lang === 'ta'
                    ? 'விலை புதுப்பிக்கப்பட்டது — புதிய தொகையைச் சரிபார்த்து மீண்டும் உறுதிப்படுத்தவும்:'
                    : 'Prices refreshed — review the updated total and confirm again:'}
                </div>
                {stalePriceNotice.items.length > 0 && (
                  <div style={{ display: 'grid', gap: 2, marginBottom: 6, fontSize: 12 }}>
                    {stalePriceNotice.items.map((item) => (
                      <div key={item.type_id} style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{lang === 'ta' && item.ta ? item.ta : item.name}</span>
                        <b className="tabular-nums">
                          {item.expected_price !== null ? formatMoney(item.expected_price) : '—'} →{' '}
                          {item.current_price !== null ? formatMoney(item.current_price) : '—'}
                        </b>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ fontWeight: 800, fontSize: 12 }}>
                  {lang === 'ta'
                    ? `முந்தைய மொத்தம்: ${formatMoney(stalePriceNotice.previousTotal)} → புதிய மொத்தம்: ${formatMoney(total)}`
                    : `Previous total: ${formatMoney(stalePriceNotice.previousTotal)} → Updated total: ${formatMoney(total)}`}
                </div>
              </div>
            )}

            {checkoutError && (
              <div className="error-box" style={{ marginBottom: 10, marginTop: 0 }}>
                <Icon name="warning" size={18} />
                <div style={{ flex: 1 }}>
                  <b>{checkoutError}</b>
                </div>
                <button
                  type="button"
                  style={{ padding: '5px 10px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700 }}
                  onClick={() => {
                    loadData();
                    setCheckoutError(null);
                  }}
                >
                  {lang === 'ta' ? 'புதுப்பி' : 'Refresh'}
                </button>
              </div>
            )}

            <div className="summary-actions">
              <button type="button" className="back-step-btn" onClick={() => setStep(2)}>
                ← {t('back')}
              </button>
              <button
                type="button"
                className="primary-action"
                style={{ width: '100%' }}
                disabled={
                  saving ||
                  !queueReady ||
                  pendingCheckout ||
                  invalidCans ||
                  invalidCash ||
                  invalidDiscount ||
                  bankExcessBlocked ||
                  !subtotal ||
                  hasMissingCartItems
                }
                onClick={() => saveInvoice()}
              >
                <Icon name="check" size={22} />
                <span>
                  {saving
                    ? '...'
                    : !queueReady
                      ? lang === 'ta'
                        ? 'சரிபார்க்கிறது...'
                        : 'Checking...'
                      : `${t('saveBill')} (${formatMoney(total)})`}
                </span>
              </button>
            </div>
          </div>
        </section>
      )}

      <AddCustomerModal
        isOpen={showAddCustomerModal}
        onClose={() => setShowAddCustomerModal(false)}
        token={token}
        role={role}
        onSuccess={(newCust) => {
          setCustomers((prev) => [newCust, ...prev]);
          setCustomer(newCust);
        }}
      />

      {createdInvoice && (
        <PrintInvoiceModal
          invoice={createdInvoice}
          initialFormat="thermal"
          onClose={() => {
            setCreatedInvoice(null);
            setStep(1);
          }}
        />
      )}
    </div>
  );
}
