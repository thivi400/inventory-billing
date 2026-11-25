import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import type { IconName, Product, Role, StarterBindingRecord } from '../types';
import { resolveStarterSlots, STARTER_SLOTS } from '../shared/starterCatalog';
import type { ProductVariant, StarterSlotDefinition, StarterSlotResolution } from '../shared/types';
import { Icon } from '../components/Icon';
import { AddProductModal, type AddProductPreset } from '../components/modals/AddProductModal';
import { EditProductModal } from '../components/modals/EditProductModal';
import { formatMoney } from '../utils/formatters';

const SELECTED_STOCK_KEY = 'wb_selected_stock_type_id';

function toProductVariant(p: Product): ProductVariant {
  return {
    typeId: p.type_id || String(p.id),
    sku: p.sku || '',
    nameEn: p.name,
    nameTa: p.ta || p.name,
    soldBy: (['bottle', 'can', 'case', 'pack', 'unit'].includes(p.unit) ? p.unit : 'unit') as ProductVariant['soldBy'],
    sellingPriceCents: p.price !== null && p.price !== undefined ? Math.round(p.price * 100) : null,
    defaultBuyingCostCents: p.buying_price !== null && p.buying_price !== undefined ? Math.round(p.buying_price * 100) : null,
    isReturnable: Boolean(p.is_returnable),
    stockQty: p.stock,
    lowStockThreshold: p.low_stock_limit ?? 10,
    usedEmptiesCount: p.used_empties_count ?? null,
    damagedEmptiesCount: p.damaged_empties_count ?? null,
    isArchived: p.is_active === false,
    createdAt: '',
    updatedAt: '',
  };
}

export function Stock({
  token,
  role,
}: {
  token: string;
  role: Role;
  onGoHome?: () => void;
}) {
  const { t, lang, speak, showToast } = useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [allProductsForResolve, setAllProductsForResolve] = useState<Product[]>([]);
  const [bindings, setBindings] = useState<StarterBindingRecord[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showOtherProducts, setShowOtherProducts] = useState(false);

  const [qty, setQty] = useState('');
  const [batchBuyingPrice, setBatchBuyingPrice] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');

  // Physical Empties in Shop (non-sellable, separate from sellable stock)
  const [usedEmptiesInput, setUsedEmptiesInput] = useState('');
  const [damagedEmptiesInput, setDamagedEmptiesInput] = useState('');
  const [savingEmpties, setSavingEmpties] = useState(false);

  // Modals & inline confirmation
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [addPreset, setAddPreset] = useState<AddProductPreset | null>(null);
  const [showEditProductModal, setShowEditProductModal] = useState(false);
  const [focusBuyingCostInModal, setFocusBuyingCostInModal] = useState(false);
  const [reviewSlot, setReviewSlot] = useState<StarterSlotResolution | null>(null);
  const [pendingArchiveConfirm, setPendingArchiveConfirm] = useState<{ prod: Product; action: 'archive' | 'restore' } | null>(null);

  // Batch queue & history modal state
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [historyTab, setHistoryTab] = useState<'batches' | 'movements'>('batches');
  const [activeBatches, setActiveBatches] = useState<any[]>([]);
  const [stockMovements, setStockMovements] = useState<any[]>([]);
  const historyRequest = useRef(0);
  const [historyError, setHistoryError] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Stock Reduction (Damage / Expiry / Adjustment)
  const [showReduceDamage, setShowReduceDamage] = useState(false);
  const [reduceQty, setReduceQty] = useState('');
  const [selectedBatchId, setSelectedBatchId] = useState<string>('');
  const [adjustReason, setAdjustReason] = useState<'damaged' | 'expired' | 'adjustment'>('damaged');
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const isManagerOrOwner = role === 'owner' || role === 'manager';
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const lastStockReqIdRef = useRef<number>(0);

  const selectAndPersistProduct = (p: Product | null) => {
    setSelectedProduct(p);
    setShowReduceDamage(false);
    setPendingArchiveConfirm(null);
    try {
      if (p?.type_id) {
        sessionStorage.setItem(SELECTED_STOCK_KEY, p.type_id);
      } else {
        sessionStorage.removeItem(SELECTED_STOCK_KEY);
      }
    } catch {
      // ignore
    }
  };

  const mapRawProducts = (rows: Partial<Product>[]): Product[] =>
    rows.map((row, index) => {
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
        used_empties_count:
          row.used_empties_count !== null && row.used_empties_count !== undefined
            ? Number(row.used_empties_count)
            : null,
        damaged_empties_count:
          row.damaged_empties_count !== null && row.damaged_empties_count !== undefined
            ? Number(row.damaged_empties_count)
            : null,
      };
    });

  const loadProducts = () => {
    const reqId = ++lastStockReqIdRef.current;
    setLoadingProducts(true);
    setProductsError(null);
    const url = showArchived ? '/products/list?show_archived=true' : '/products/list?include_meta=true';
    api
      .get<{
        products?: Partial<Product>[];
        all_products?: Partial<Product>[];
        bindings?: StarterBindingRecord[];
      } | Partial<Product>[]>(url, token)
      .then((result) => {
        if (reqId !== lastStockReqIdRef.current) return;
        const rows = Array.isArray(result) ? result : (result.products ?? []);
        const allRows = !Array.isArray(result) && Array.isArray(result.all_products) ? result.all_products : rows;
        const mapped = mapRawProducts(rows);
        const mappedAll = mapRawProducts(allRows);

        setProducts(mapped);
        setAllProductsForResolve(mappedAll);
        if (!Array.isArray(result) && Array.isArray(result.bindings)) {
          setBindings(result.bindings);
        }

        let persistedId: string | null = null;
        try {
          persistedId = sessionStorage.getItem(SELECTED_STOCK_KEY);
        } catch {
          persistedId = null;
        }

        setSelectedProduct((curr) => {
          const targetId = curr?.type_id || persistedId;
          if (targetId) {
            const found = mapped.find((m) => m.type_id === targetId);
            if (found) return found;
            try {
              sessionStorage.removeItem(SELECTED_STOCK_KEY);
            } catch {
              // ignore
            }
          }
          return null;
        });
        setLoadingProducts(false);
      })
      .catch((err) => {
        if (reqId !== lastStockReqIdRef.current) return;
        setProductsError(err instanceof Error ? err.message : 'Failed to load products');
        setLoadingProducts(false);
      });
  };

  const loadBatchesAndMovements = (typeId?: string) => {
    const tid = typeId || selectedProduct?.type_id;
    if (!tid) return;
    const request = ++historyRequest.current;
    setHistoryError(false);
    setLoadingHistory(true);
    Promise.all([
      api.get<any[]>(`/stock/batches?type_id=${encodeURIComponent(tid)}`, token),
      api.get<any[]>(`/stock/movements?type_id=${encodeURIComponent(tid)}`, token),
    ])
      .then(([batches, movements]) => {
        if (request !== historyRequest.current) return;
        if (Array.isArray(batches)) setActiveBatches(batches);
        if (Array.isArray(movements)) setStockMovements(movements);
      })
      .catch(() => {
        if (request === historyRequest.current) setHistoryError(true);
      })
      .finally(() => {
        if (request === historyRequest.current) setLoadingHistory(false);
      });
  };

  useEffect(() => {
    loadProducts();
    const handleRefresh = () => loadProducts();
    window.addEventListener('refresh-stock-data', handleRefresh);
    return () => window.removeEventListener('refresh-stock-data', handleRefresh);
  }, [token, showArchived]);

  useEffect(() => {
    if (selectedProduct) {
      setSellingPrice(
        selectedProduct.price !== null && selectedProduct.price !== undefined
          ? String(selectedProduct.price)
          : '',
      );
      setQty('');
      setBatchBuyingPrice(
        selectedProduct.buying_price !== null && selectedProduct.buying_price !== undefined
          ? String(selectedProduct.buying_price)
          : '',
      );
      setUsedEmptiesInput(
        selectedProduct.used_empties_count !== null && selectedProduct.used_empties_count !== undefined
          ? String(selectedProduct.used_empties_count)
          : '',
      );
      setDamagedEmptiesInput(
        selectedProduct.damaged_empties_count !== null &&
          selectedProduct.damaged_empties_count !== undefined
          ? String(selectedProduct.damaged_empties_count)
          : '',
      );
      setReduceQty('');
      setSelectedBatchId('');
      setShowReduceDamage(false);
      loadBatchesAndMovements(selectedProduct.type_id);
    } else {
      setSellingPrice('');
      setQty('');
      setBatchBuyingPrice('');
      setUsedEmptiesInput('');
      setDamagedEmptiesInput('');
      setReduceQty('');
      setSelectedBatchId('');
      setShowReduceDamage(false);
    }
  }, [selectedProduct?.type_id]);

  // Direct Stock Receive
  const handleAddStock = async () => {
    if (!isManagerOrOwner || !selectedProduct) return;
    const numQty = Number(qty);
    if (!Number.isInteger(numQty) || numQty <= 0) {
      setStatusMsg({
        type: 'error',
        text: lang === 'ta' ? 'சேர்க்க வேண்டிய எண்ணிக்கை உள்ளிடவும்' : 'Please enter a valid whole quantity',
      });
      return;
    }

    const payload: Record<string, any> = {
      type_id: selectedProduct.type_id,
      quantity: numQty,
      selling_price: selectedProduct.price,
    };

    if (batchBuyingPrice.trim() !== '') {
      payload.buying_price = Number(batchBuyingPrice);
    } else if (selectedProduct.buying_price !== null && selectedProduct.buying_price !== undefined) {
      payload.buying_price = selectedProduct.buying_price;
    } else {
      setStatusMsg({
        type: 'error',
        text:
          lang === 'ta'
            ? 'அடக்க விலை தேவை. (பொருளுக்கு அடிப்படை அடக்க விலை அமைக்கப்படவில்லை)'
            : 'Buying cost is required because this product has no default buying cost set.',
      });
      return;
    }

    setSaving(true);
    setStatusMsg(null);
    try {
      await api.post('/stock/receive', payload, token);
      speak('Stock added successfully', 'சரக்கு வெற்றிகரமாக சேர்க்கப்பட்டது');
      setStatusMsg({
        type: 'success',
        text:
          lang === 'ta'
            ? `சரக்கு சேர்க்கப்பட்டது: +${numQty} (${selectedProduct.ta})`
            : `Stock added: +${numQty} (${selectedProduct.name})`,
      });
      setQty('');
      loadProducts();
      loadBatchesAndMovements(selectedProduct.type_id);
      window.dispatchEvent(new CustomEvent('refresh-stock-data'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to add stock';
      speak('Stock update failed', 'சரக்கு புதுப்பிக்கப்படவில்லை');
      setStatusMsg({ type: 'error', text: message });
    } finally {
      setSaving(false);
    }
  };

  // Direct Update Selling Price
  const handleUpdatePrice = async () => {
    if (!isManagerOrOwner || !selectedProduct) return;
    const newPrice = Number(sellingPrice);
    if (sellingPrice.trim() === '' || isNaN(newPrice) || newPrice < 0) {
      setStatusMsg({ type: 'error', text: lang === 'ta' ? 'சரியான விலையை உள்ளிடவும்' : 'Enter a valid price' });
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      await api.post(
        '/products/update',
        {
          type_id: selectedProduct.type_id,
          name: selectedProduct.name,
          selling_price: newPrice,
        },
        token,
      );
      speak('Price updated', 'விலை மாற்றப்பட்டது');
      setStatusMsg({
        type: 'success',
        text:
          lang === 'ta'
            ? `விற்பனை விலை ${formatMoney(newPrice)} ஆக மாற்றப்பட்டது!`
            : `Selling price updated to ${formatMoney(newPrice)}!`,
      });
      setSelectedProduct({ ...selectedProduct, price: newPrice });
      setProducts((prev) =>
        prev.map((p) => (p.type_id === selectedProduct.type_id ? { ...p, price: newPrice } : p)),
      );
      loadProducts();
      loadBatchesAndMovements(selectedProduct.type_id);
      window.dispatchEvent(new CustomEvent('refresh-stock-data'));
    } catch (err: unknown) {
      setStatusMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update price' });
    } finally {
      setSaving(false);
    }
  };

  // Save Physical Empties Count (Used & Damaged, separate from sellable stock)
  const handleSaveEmptiesCount = async () => {
    if (!isManagerOrOwner || !selectedProduct?.type_id) return;
    const usedVal = usedEmptiesInput.trim() === '' ? null : Number(usedEmptiesInput);
    const dmgVal = damagedEmptiesInput.trim() === '' ? null : Number(damagedEmptiesInput);
    if (
      (usedVal !== null && (!Number.isInteger(usedVal) || usedVal < 0)) ||
      (dmgVal !== null && (!Number.isInteger(dmgVal) || dmgVal < 0))
    ) {
      setStatusMsg({
        type: 'error',
        text: lang === 'ta' ? 'சரியான எண்ணிக்கையை உள்ளிடவும்' : 'Enter valid whole counts (>= 0)',
      });
      return;
    }
    setSavingEmpties(true);
    setStatusMsg(null);
    try {
      const updated = await api.post<Product>(
        '/stock/empties-count',
        {
          type_id: selectedProduct.type_id,
          used_empties_count: usedVal,
          damaged_empties_count: dmgVal,
        },
        token,
      );
      setSelectedProduct((curr) =>
        curr && curr.type_id === selectedProduct.type_id
          ? {
              ...curr,
              used_empties_count: updated.used_empties_count,
              damaged_empties_count: updated.damaged_empties_count,
            }
          : curr,
      );
      showToast(
        lang === 'ta' ? 'காலி கேன் எண்ணிக்கை சேமிக்கப்பட்டது.' : 'Physical empties count updated.',
        'success',
      );
      loadProducts();
    } catch (err) {
      setStatusMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update empties count' });
    } finally {
      setSavingEmpties(false);
    }
  };

  // Execute Archive or Restore Product (confirmed via inline bar — no window.confirm)
  const executeToggleArchiveProduct = async (prod: Product, action: 'archive' | 'restore') => {
    if (!isManagerOrOwner) return;
    const isArchiving = action === 'archive';
    setStatusMsg(null);
    setPendingArchiveConfirm(null);
    try {
      await api.post('/products/archive', { type_id: prod.type_id, action }, token);
      speak(
        isArchiving ? 'Product archived' : 'Product restored',
        isArchiving ? 'பொருள் முடக்கப்பட்டது' : 'பொருள் மீண்டும் இயக்கப்பட்டது',
      );
      showToast(
        isArchiving
          ? lang === 'ta'
            ? `பொருள் '${prod.name}' முடக்கப்பட்டது.`
            : `Product '${prod.name}' archived.`
          : lang === 'ta'
            ? `பொருள் '${prod.name}' மீண்டும் இயக்கப்பட்டது.`
            : `Product '${prod.name}' restored.`,
        'success',
      );
      if (isArchiving && selectedProduct?.type_id === prod.type_id) {
        selectAndPersistProduct(null);
      }
      loadProducts();
      window.dispatchEvent(new CustomEvent('refresh-stock-data'));
    } catch (err: unknown) {
      setStatusMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to change archive state',
      });
    }
  };

  // Stock Reduction with Specific Batch Support
  const handleReduceStock = async () => {
    if (!isManagerOrOwner || !selectedProduct) return;
    const numQty = Number(reduceQty);
    if (!Number.isInteger(numQty) || numQty <= 0) {
      setStatusMsg({
        type: 'error',
        text: lang === 'ta' ? 'குறைக்க வேண்டிய எண்ணிக்கை உள்ளிடவும்' : 'Please enter quantity to reduce',
      });
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      await api.post(
        '/stock/adjust',
        {
          type_id: selectedProduct.type_id,
          batch_id: selectedBatchId || undefined,
          quantity: numQty,
          reason: adjustReason,
        },
        token,
      );
      speak('Stock reduced successfully', 'சரக்கு வெற்றிகரமாக குறைக்கப்பட்டது');
      setStatusMsg({
        type: 'success',
        text:
          lang === 'ta'
            ? `சரக்கு குறைக்கப்பட்டது: -${numQty} (${selectedProduct.ta})`
            : `Stock reduced: -${numQty} (${selectedProduct.name})`,
      });
      setReduceQty('');
      setSelectedBatchId('');
      setShowReduceDamage(false);
      loadProducts();
      loadBatchesAndMovements(selectedProduct.type_id);
      window.dispatchEvent(new CustomEvent('refresh-stock-data'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to reduce stock';
      speak('Stock reduction failed', 'சரக்கு குறைக்கப்படவில்லை');
      setStatusMsg({ type: 'error', text: message });
    } finally {
      setSaving(false);
    }
  };

  // Resolve starter slot conflict via backend
  const handleResolveSlot = async (
    slotKey: string,
    action: 'bind_as_is' | 'fix_and_bind' | 'leave_other',
    productTypeId: string,
  ) => {
    setSaving(true);
    try {
      await api.post(
        '/stock/resolve-slot',
        { slot_key: slotKey, action, product_type_id: productTypeId },
        token,
      );
      setReviewSlot(null);
      showToast(
        lang === 'ta' ? 'சரக்கு அட்டை புதுப்பிக்கப்பட்டது.' : 'Starter card binding updated.',
        'success',
      );
      loadProducts();
      window.dispatchEvent(new CustomEvent('refresh-stock-data'));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not resolve starter slot', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openSetupForSlot = (slotDef: StarterSlotDefinition) => {
    setAddPreset({
      slotKey: slotDef.slotKey,
      name: slotDef.defaultNameEn,
      nameTa: slotDef.defaultNameTa,
      sku: slotDef.canonicalSku,
      unit: slotDef.soldBy,
      isReturnable: slotDef.defaultReturnable,
    });
    setShowAddProductModal(true);
  };

  // Strict Phase 1A starter slot resolution (never maps 20L cans to 19L slots!)
  const variantList = allProductsForResolve.map(toProductVariant);
  const { slots: resolvedSlots, otherActiveProducts: resolvedOtherVariants } = resolveStarterSlots(
    variantList,
    bindings.map((b) => ({
      slotKey: b.slot_key as any,
      productTypeId: b.product_type_id,
      excludedTypeIds: b.excluded_type_ids,
    })),
  );

  const productByTypeId = new Map(products.map((p) => [p.type_id || String(p.id), p]));
  const allProductByTypeId = new Map(allProductsForResolve.map((p) => [p.type_id || String(p.id), p]));
  const otherProducts = resolvedOtherVariants
    .map((v) => productByTypeId.get(v.typeId))
    .filter((p): p is Product => Boolean(p));

  return (
    <div className="workflow-page stock-page">
      <div
        className="page-title compact"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <p className="eyebrow">{t('stock')}</p>
          <h1>{lang === 'ta' ? 'சரக்கு இருப்பு & விலை மேலாண்மை' : 'Stock Inventory & Pricing'}</h1>
        </div>
        <div className="page-title-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="tab-toggle-btn"
            onClick={() => setShowArchived(!showArchived)}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid #cbd5e1',
              background: showArchived ? '#fef3c7' : '#f8fafc',
              color: showArchived ? '#92400e' : '#475569',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {showArchived
              ? lang === 'ta'
                ? 'முடக்கப்பட்ட பொருட்கள் (Archived)'
                : 'Showing Archived Only'
              : lang === 'ta'
                ? 'செயலில் உள்ள பொருட்கள் (Active)'
                : 'Showing Active Only'}
          </button>
        </div>
      </div>

      {statusMsg && (
        <div className={`status-banner ${statusMsg.type}`} style={{ marginBottom: 12 }}>
          <Icon name={statusMsg.type === 'success' ? 'check' : 'warning'} size={18} />
          <span>{statusMsg.text}</span>
        </div>
      )}

      {pendingArchiveConfirm && (
        <div className="inline-confirm-bar">
          <span>
            {pendingArchiveConfirm.action === 'archive'
              ? lang === 'ta'
                ? `பொருள் '${pendingArchiveConfirm.prod.name}' ஐ முடக்க வேண்டுமா?`
                : `Archive product '${pendingArchiveConfirm.prod.name}'?`
              : lang === 'ta'
                ? `பொருள் '${pendingArchiveConfirm.prod.name}' ஐ மீண்டும் இயக்க வேண்டுமா?`
                : `Restore product '${pendingArchiveConfirm.prod.name}'?`}
          </span>
          <div className="inline-confirm-actions">
            <button
              type="button"
              className="btn-cancel"
              style={{ padding: '6px 12px' }}
              onClick={() => setPendingArchiveConfirm(null)}
            >
              {lang === 'ta' ? 'ரத்து' : 'Cancel'}
            </button>
            <button
              type="button"
              className="btn-primary-small"
              style={{
                padding: '6px 12px',
                background: pendingArchiveConfirm.action === 'archive' ? '#dc2626' : '#16a34a',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontWeight: 800,
              }}
              onClick={() =>
                executeToggleArchiveProduct(pendingArchiveConfirm.prod, pendingArchiveConfirm.action)
              }
            >
              {pendingArchiveConfirm.action === 'archive'
                ? lang === 'ta'
                  ? 'முடக்கு'
                  : 'Confirm Archive'
                : lang === 'ta'
                  ? 'மீட்க'
                  : 'Confirm Restore'}
            </button>
          </div>
        </div>
      )}

      <section className="stock-layout">
        {/* Left Column: Product Grid */}
        <div className="workflow-card product-picker-card inside-scroll">
          {showArchived ? (
            <div className="archived-products-container">
              <div className="category-section-label" style={{ marginBottom: 12 }}>
                <span>
                  {lang === 'ta' ? 'முடக்கப்பட்ட பொருட்கள் (Archived Products)' : 'Archived Products'}
                </span>
              </div>
              {products.length === 0 ? (
                <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                  {lang === 'ta' ? 'முடக்கப்பட்ட பொருட்கள் எதுவும் இல்லை.' : 'No archived products found.'}
                </div>
              ) : (
                <div className="archived-items-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {products.map((p) => (
                    <div
                      key={p.type_id || p.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '12px 14px',
                        background: '#fff',
                        border: '1px solid #e2e8f0',
                        borderRadius: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Icon name={p.icon} size={24} />
                        <div>
                          <b style={{ display: 'block', fontSize: 14 }}>
                            {lang === 'ta' ? p.ta : p.name}
                          </b>
                          <small style={{ color: '#64748b' }}>
                            Rate: {p.price !== null ? formatMoney(p.price) : 'Unpriced'} • Stock: {p.stock}
                          </small>
                        </div>
                      </div>
                      {isManagerOrOwner && (
                        <button
                          type="button"
                          className="btn-primary-small"
                          onClick={() => setPendingArchiveConfirm({ prod: p, action: 'restore' })}
                          style={{
                            padding: '6px 12px',
                            background: '#16a34a',
                            borderColor: '#16a34a',
                            color: '#fff',
                            borderRadius: 6,
                            cursor: 'pointer',
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          {lang === 'ta' ? 'மீட்க (Restore)' : 'Restore'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div>
              {productsError && (
                <div
                  style={{
                    padding: 12,
                    marginBottom: 12,
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: 8,
                    color: '#b91c1c',
                  }}
                >
                  <p style={{ margin: 0, fontWeight: 700 }}>
                    {lang === 'ta' ? 'சரக்கு விவரங்களை ஏற்ற முடியவில்லை:' : 'Failed to load stock data:'}{' '}
                    {productsError}
                  </p>
                  <button
                    type="button"
                    onClick={() => loadProducts()}
                    style={{
                      marginTop: 6,
                      padding: '4px 10px',
                      background: '#ef4444',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    {lang === 'ta' ? 'மீண்டும் முயற்சிக்கவும்' : 'Retry'}
                  </button>
                </div>
              )}

              <div className="category-section-label" style={{ marginBottom: 10 }}>
                <span>{lang === 'ta' ? 'முக்கிய 6 சரக்கு வகைகள்' : 'Stock Products (6 Standard Sizes)'}</span>
              </div>

              {/* Six canonical starter cards in exact order */}
              <div
                className="product-grid compact"
                style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}
              >
                {resolvedSlots.map((slotRes) => {
                  const slotDef = slotRes.definition;
                  const iconName: IconName = slotDef.soldBy === 'can' ? 'can' : 'bottle';

                  if (slotRes.status === 'matched' && slotRes.variant) {
                    const p = productByTypeId.get(slotRes.variant.typeId);
                    if (p) {
                      const isSelected = selectedProduct?.type_id === p.type_id;
                      const isEmpties = p.is_returnable || slotDef.slotKey === '19L_EMPTY';
                      return (
                        <button
                          type="button"
                          className={`product-card pick ${isSelected ? 'selected' : ''} ${isEmpties ? 'empty-can-card' : ''}`}
                          key={slotDef.slotKey}
                          onClick={() => selectAndPersistProduct(p)}
                          style={{ minHeight: 128, position: 'relative' }}
                        >
                          <span className="product-icon">
                            <Icon name={p.icon} size={32} />
                          </span>
                          <b className="product-title" style={{ fontSize: 13, marginTop: 4 }}>
                            {lang === 'ta' ? p.ta : p.name}
                          </b>
                          <strong className="product-price-tag" style={{ fontSize: 13 }}>
                            {p.price !== null ? formatMoney(p.price) : lang === 'ta' ? 'விலை இல்லை' : 'Price not set'}
                          </strong>
                          <span
                            className={`stock-badge ${p.stock === 0 ? 'badge-red' : p.stock <= (p.low_stock_limit ?? 10) ? 'badge-amber' : ''}`}
                            style={{
                              fontSize: 11,
                              color: p.stock <= (p.low_stock_limit ?? 10) ? '#fff' : '#0f172a',
                              background:
                                p.stock === 0
                                  ? '#dc2626'
                                  : p.stock <= (p.low_stock_limit ?? 10)
                                    ? '#f59e0b'
                                    : '#e2e8f0',
                            }}
                          >
                            {p.stock} {p.unit}
                          </span>
                        </button>
                      );
                    }
                  }

                  // Archived match -> Restore card for Manager/Owner
                  if (slotRes.status === 'archived' && slotRes.variant) {
                    const archProd = allProductByTypeId.get(slotRes.variant.typeId);
                    return (
                      <div
                        className="product-card"
                        key={slotDef.slotKey}
                        style={{
                          minHeight: 128,
                          background: '#fffbeb',
                          border: '1.5px dashed #f59e0b',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 10,
                          borderRadius: 16,
                          textAlign: 'center',
                        }}
                      >
                        <span className="product-icon" style={{ opacity: 0.75 }}>
                          <Icon name={iconName} size={26} />
                        </span>
                        <b style={{ fontSize: 13, marginTop: 4, color: '#92400e' }}>
                          {lang === 'ta' ? slotDef.labelTa : slotDef.labelEn}
                        </b>
                        {isManagerOrOwner && archProd ? (
                          <button
                            type="button"
                            onClick={() => executeToggleArchiveProduct(archProd, 'restore')}
                            style={{
                              marginTop: 6,
                              padding: '5px 10px',
                              borderRadius: 6,
                              border: 'none',
                              background: '#16a34a',
                              color: '#fff',
                              fontSize: 11,
                              fontWeight: 800,
                            }}
                          >
                            {lang === 'ta' ? 'மீட்க (Restore)' : 'Restore'}
                          </button>
                        ) : (
                          <small style={{ color: '#92400e', fontSize: 11, marginTop: 4 }}>
                            {lang === 'ta' ? 'மேலாளரை அணுகவும்' : 'Ask a manager to restore.'}
                          </small>
                        )}
                      </div>
                    );
                  }

                  // Conflict or Ambiguous -> Review product button for Manager/Owner
                  if (slotRes.status === 'conflict' || slotRes.status === 'ambiguous') {
                    return (
                      <div
                        className="product-card"
                        key={slotDef.slotKey}
                        style={{
                          minHeight: 128,
                          background: '#fef2f2',
                          border: '1.5px dashed #ef4444',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 10,
                          borderRadius: 16,
                          textAlign: 'center',
                        }}
                      >
                        <span className="product-icon" style={{ background: '#fee2e2', color: '#dc2626' }}>
                          <Icon name="warning" size={24} />
                        </span>
                        <b style={{ fontSize: 13, marginTop: 4, color: '#991b1b' }}>
                          {lang === 'ta' ? slotDef.labelTa : slotDef.labelEn}
                        </b>
                        {isManagerOrOwner ? (
                          <button
                            type="button"
                            onClick={() => setReviewSlot(slotRes)}
                            style={{
                              marginTop: 6,
                              padding: '5px 10px',
                              borderRadius: 6,
                              border: 'none',
                              background: '#dc2626',
                              color: '#fff',
                              fontSize: 11,
                              fontWeight: 800,
                            }}
                          >
                            {lang === 'ta' ? 'பொருளை சரிபார்' : 'Review product'}
                          </button>
                        ) : (
                          <small style={{ color: '#991b1b', fontSize: 11, marginTop: 4 }}>
                            {lang === 'ta' ? 'மேலாளரை அணுகவும்' : 'Ask a manager to set up.'}
                          </small>
                        )}
                      </div>
                    );
                  }

                  // Missing starter card -> Working "Set up" button for Manager/Owner, helpful text for Employee
                  return (
                    <div
                      className="product-card"
                      key={slotDef.slotKey}
                      style={{
                        minHeight: 128,
                        background: '#f8fafc',
                        border: '1.5px dashed #94a3b8',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 10,
                        borderRadius: 16,
                        textAlign: 'center',
                      }}
                    >
                      <span className="product-icon" style={{ opacity: 0.65 }}>
                        <Icon name={iconName} size={26} />
                      </span>
                      <b style={{ fontSize: 13, marginTop: 4, color: '#475569' }}>
                        {lang === 'ta' ? slotDef.labelTa : slotDef.labelEn}
                      </b>
                      {isManagerOrOwner ? (
                        <button
                          type="button"
                          onClick={() => openSetupForSlot(slotDef)}
                          style={{
                            marginTop: 6,
                            padding: '5px 12px',
                            borderRadius: 6,
                            border: 'none',
                            background: '#2864dc',
                            color: '#fff',
                            fontSize: 11,
                            fontWeight: 800,
                          }}
                        >
                          {lang === 'ta' ? 'அமைக்கவும்' : 'Set up'}
                        </button>
                      ) : (
                        <small style={{ color: '#64748b', fontSize: 11, marginTop: 6 }}>
                          {lang === 'ta' ? 'மேலாளரிடம் கேட்கவும்.' : 'Ask a manager to set up.'}
                        </small>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Single "+ Add New Product" button straight below the 6 cards */}
              {isManagerOrOwner && (
                <div style={{ marginTop: 14 }}>
                  <button
                    type="button"
                    className="btn-add-product-main"
                    onClick={() => {
                      setAddPreset(null);
                      setShowAddProductModal(true);
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      padding: '12px 16px',
                      borderRadius: 10,
                      border: '2px dashed #2864dc',
                      background: '#eff6ff',
                      color: '#2864dc',
                      fontWeight: 800,
                      fontSize: 14,
                      cursor: 'pointer',
                    }}
                  >
                    <Icon name="plus" size={18} />
                    <span>{lang === 'ta' ? '+ புதிய பொருள் சேர்க்க' : '+ Add New Product'}</span>
                  </button>
                </div>
              )}

              {/* Collapsed "Other Products" section below "+ Add New Product" */}
              {otherProducts.length > 0 && (
                <div className="other-products-section" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #cbd5e1' }}>
                  <button
                    type="button"
                    onClick={() => setShowOtherProducts(!showOtherProducts)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      borderRadius: 10,
                      border: '1px solid #e2e8f0',
                      background: '#f8fafc',
                      color: '#334155',
                      fontWeight: 800,
                      fontSize: 13,
                    }}
                  >
                    <span>
                      {showOtherProducts ? '▼ ' : '▶ '}
                      {lang === 'ta' ? 'பிற பொருட்கள் (Other Products)' : 'Other Products'} ({otherProducts.length})
                    </span>
                    <small style={{ color: '#64748b' }}>
                      {showOtherProducts
                        ? lang === 'ta'
                          ? 'மறை'
                          : 'Hide'
                        : lang === 'ta'
                          ? 'காட்டு'
                          : 'Show'}
                    </small>
                  </button>

                  {showOtherProducts && (
                    <div
                      className="product-grid compact"
                      style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 10 }}
                    >
                      {otherProducts.map((p) => {
                        const isSelected = selectedProduct?.type_id === p.type_id;
                        return (
                          <button
                            type="button"
                            className={`product-card pick ${isSelected ? 'selected' : ''}`}
                            key={p.type_id}
                            onClick={() => selectAndPersistProduct(p)}
                          >
                            <span className="product-icon">
                              <Icon name={p.icon} size={28} />
                            </span>
                            <b className="product-title" style={{ fontSize: 12 }}>
                              {lang === 'ta' ? p.ta : p.name}
                            </b>
                            <strong className="product-price-tag" style={{ fontSize: 13 }}>
                              {p.price !== null ? formatMoney(p.price) : lang === 'ta' ? 'விலை இல்லை' : 'Price not set'}
                            </strong>
                            <span
                              className="stock-badge"
                              style={{
                                fontSize: 11,
                                color: p.stock <= (p.low_stock_limit ?? 10) ? '#fff' : '#0f172a',
                                background:
                                  p.stock === 0
                                    ? '#dc2626'
                                    : p.stock <= (p.low_stock_limit ?? 10)
                                      ? '#f59e0b'
                                      : '#e2e8f0',
                              }}
                            >
                              {p.stock} {p.unit}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {loadingProducts && products.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>
                  {lang === 'ta' ? 'ஏற்றப்படுகிறது...' : 'Loading stock...'}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Stock Management Details Panel */}
        <div className="workflow-card quantity-card inside-scroll">
          {selectedProduct ? (
            <>
              <div
                className="selected-item-banner"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  flexWrap: 'wrap',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span className="product-icon mini">
                    <Icon name={selectedProduct.icon} size={26} />
                  </span>
                  <div>
                    <b style={{ fontSize: 17, display: 'block' }}>
                      {lang === 'ta' ? selectedProduct.ta : selectedProduct.name}
                    </b>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: '#64748b' }}>
                        {lang === 'ta' ? 'இருப்பு:' : 'Stock:'}{' '}
                        <strong>{selectedProduct.stock}</strong> {selectedProduct.unit}
                      </span>
                      <span style={{ fontSize: 12, color: '#0284c7', fontWeight: 700 }}>
                        {lang === 'ta' ? 'விலை:' : 'Rate:'}{' '}
                        {selectedProduct.price !== null
                          ? formatMoney(selectedProduct.price)
                          : lang === 'ta'
                            ? 'அமைக்கப்படவில்லை'
                            : 'Not set'}{' '}
                        / {selectedProduct.unit}
                      </span>
                    </div>

                    {isManagerOrOwner && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                        <span style={{ fontSize: 12, color: '#475569' }}>
                          {lang === 'ta' ? 'அடிப்படை அடக்க விலை:' : 'Default Cost:'}{' '}
                          <strong>
                            {selectedProduct.buying_price !== null &&
                            selectedProduct.buying_price !== undefined
                              ? formatMoney(selectedProduct.buying_price)
                              : lang === 'ta'
                                ? 'அமைக்கப்படவில்லை'
                                : 'Not set'}
                          </strong>
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setFocusBuyingCostInModal(true);
                            setShowEditProductModal(true);
                          }}
                          style={{
                            border: 'none',
                            background: 'none',
                            color: '#2563eb',
                            fontSize: 11,
                            textDecoration: 'underline',
                            cursor: 'pointer',
                            padding: 0,
                            fontWeight: 700,
                          }}
                        >
                          {lang === 'ta' ? 'அடக்க விலை மாற்று' : 'Update buying cost'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn-modify-large"
                    style={{
                      padding: '6px 10px',
                      fontSize: 12,
                      background: '#f1f5f9',
                      color: '#334155',
                      boxShadow: 'none',
                      border: '1px solid #cbd5e1',
                    }}
                    onClick={() => setShowHistoryModal(true)}
                  >
                    {lang === 'ta' ? 'பேட்ச் வரலாறு' : 'Batches & History'}
                  </button>

                  {isManagerOrOwner ? (
                    <>
                      <button
                        type="button"
                        className="btn-modify-large"
                        style={{ padding: '6px 12px', fontSize: 13 }}
                        onClick={() => {
                          setFocusBuyingCostInModal(false);
                          setShowEditProductModal(true);
                        }}
                      >
                        <Icon name="edit" size={14} />
                        <span>{lang === 'ta' ? 'மாற்று' : 'Edit'}</span>
                      </button>
                      <button
                        type="button"
                        className="btn-danger-outline"
                        style={{ padding: '6px 10px' }}
                        onClick={() =>
                          setPendingArchiveConfirm({
                            prod: selectedProduct,
                            action: showArchived ? 'restore' : 'archive',
                          })
                        }
                        title={showArchived ? 'Restore Product' : 'Archive Product'}
                      >
                        <Icon name={showArchived ? 'check' : 'trash'} size={14} />
                      </button>
                    </>
                  ) : (
                    <span style={{ fontSize: 12, color: '#64748b', fontWeight: 700 }}>
                      {lang === 'ta' ? 'பார்வை மட்டும்' : 'View Only'}
                    </span>
                  )}
                </div>
              </div>

              {/* Physical Empties in Shop (non-sellable) for returnable items */}
              {selectedProduct.is_returnable && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 12,
                    background: '#f0f9ff',
                    border: '1px solid #bae6fd',
                    borderRadius: 12,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <b style={{ fontSize: 13, color: '#0369a1' }}>
                      {lang === 'ta'
                        ? 'கடையில் உள்ள காலி கேன்கள் (விற்பனைக்கு அல்ல)'
                        : 'Physical Empties in Shop (Non-sellable)'}
                    </b>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div style={{ background: '#fff', padding: '8px 10px', borderRadius: 8, border: '1px solid #e0f2fe' }}>
                      <small style={{ color: '#64748b', fontWeight: 700, display: 'block' }}>
                        {lang === 'ta' ? 'பயன்படுத்திய காலிகள்' : 'Used Empties'}
                      </small>
                      {isManagerOrOwner ? (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={usedEmptiesInput}
                          onChange={(e) => setUsedEmptiesInput(e.target.value)}
                          placeholder={lang === 'ta' ? 'எண்ணப்படவில்லை' : 'Not counted'}
                          style={{
                            width: '100%',
                            marginTop: 4,
                            padding: '6px 8px',
                            borderRadius: 6,
                            border: '1px solid #cbd5e1',
                            fontWeight: 800,
                            fontSize: 14,
                          }}
                        />
                      ) : (
                        <b style={{ fontSize: 15, color: '#0f172a' }}>
                          {selectedProduct.used_empties_count !== null &&
                          selectedProduct.used_empties_count !== undefined
                            ? selectedProduct.used_empties_count
                            : lang === 'ta'
                              ? 'எண்ணப்படவில்லை'
                              : 'Not counted'}
                        </b>
                      )}
                    </div>
                    <div style={{ background: '#fff', padding: '8px 10px', borderRadius: 8, border: '1px solid #e0f2fe' }}>
                      <small style={{ color: '#64748b', fontWeight: 700, display: 'block' }}>
                        {lang === 'ta' ? 'சேதமடைந்த காலிகள்' : 'Damaged Empties'}
                      </small>
                      {isManagerOrOwner ? (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={damagedEmptiesInput}
                          onChange={(e) => setDamagedEmptiesInput(e.target.value)}
                          placeholder={lang === 'ta' ? 'எண்ணப்படவில்லை' : 'Not counted'}
                          style={{
                            width: '100%',
                            marginTop: 4,
                            padding: '6px 8px',
                            borderRadius: 6,
                            border: '1px solid #cbd5e1',
                            fontWeight: 800,
                            fontSize: 14,
                          }}
                        />
                      ) : (
                        <b style={{ fontSize: 15, color: '#b91c1c' }}>
                          {selectedProduct.damaged_empties_count !== null &&
                          selectedProduct.damaged_empties_count !== undefined
                            ? selectedProduct.damaged_empties_count
                            : lang === 'ta'
                              ? 'எண்ணப்படவில்லை'
                              : 'Not counted'}
                        </b>
                      )}
                    </div>
                  </div>
                  {isManagerOrOwner && (
                    <button
                      type="button"
                      disabled={savingEmpties}
                      onClick={handleSaveEmptiesCount}
                      style={{
                        marginTop: 8,
                        padding: '6px 12px',
                        borderRadius: 6,
                        border: 'none',
                        background: '#0284c7',
                        color: '#fff',
                        fontWeight: 800,
                        fontSize: 12,
                      }}
                    >
                      {savingEmpties
                        ? '...'
                        : lang === 'ta'
                          ? 'காலி கேன் எண்ணிக்கையை சேமி'
                          : 'Save Empties Count'}
                    </button>
                  )}
                </div>
              )}

              {!isManagerOrOwner ? (
                <div
                  style={{
                    padding: 14,
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: 8,
                    marginTop: 14,
                    color: '#64748b',
                  }}
                >
                  <Icon name="warning" size={18} />
                  <b style={{ marginLeft: 6 }}>
                    {lang === 'ta'
                      ? 'பார்வைக்கு மட்டும்: சரக்கு சேர்க்க அல்லது விலை மாற்ற மேலாளர் PIN தேவை.'
                      : 'View-only: Manager or Owner PIN required to add stock or edit prices.'}
                  </b>
                </div>
              ) : (
                <>
                  <div className="receive-form-panel" style={{ marginTop: 14 }}>
                    <div className="form-group">
                      <label className="box-label" style={{ fontWeight: 700 }}>
                        {lang === 'ta' ? 'சேர்க்க வேண்டிய எண்ணிக்கை:' : 'Add Stock Quantity (Count):'}
                      </label>
                      <div className="large-cash-box">
                        <span className="cash-box-prefix">#</span>
                        <input
                          type="number"
                          min="1"
                          value={qty}
                          onChange={(e) => setQty(e.target.value)}
                          placeholder="0"
                        />
                      </div>
                    </div>

                    <div className="form-group" style={{ marginTop: 12 }}>
                      <label
                        className="box-label"
                        style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}
                      >
                        <span>{lang === 'ta' ? 'விற்பனை விலை (Rs.):' : 'Selling Price / Rate (Rs.):'}</span>
                      </label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <div className="large-cash-box" style={{ flex: 1 }}>
                          <span className="cash-box-prefix">Rs.</span>
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={sellingPrice}
                            onChange={(e) => setSellingPrice(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                handleUpdatePrice();
                              }
                            }}
                            placeholder="0"
                          />
                        </div>
                        <button
                          type="button"
                          className="btn-modify-large"
                          style={{ height: 48, padding: '0 16px', borderRadius: 8, whiteSpace: 'nowrap' }}
                          onClick={handleUpdatePrice}
                          disabled={
                            saving ||
                            sellingPrice.trim() === '' ||
                            Number(sellingPrice) === selectedProduct.price
                          }
                        >
                          {lang === 'ta' ? 'விலை மாற்று' : 'Update Price'}
                        </button>
                      </div>
                    </div>

                    <div className="form-group" style={{ marginTop: 12 }}>
                      <label
                        className="box-label"
                        style={{ fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}
                      >
                        <span>
                          {lang === 'ta' ? 'இந்த வரவிற்கான அடக்க விலை (Rs.):' : 'This Batch Buying Cost (Rs.):'}
                        </span>
                        <span style={{ color: '#64748b', fontSize: 11 }}>
                          {selectedProduct.buying_price !== null &&
                          selectedProduct.buying_price !== undefined
                            ? `Default: ${formatMoney(selectedProduct.buying_price)}`
                            : 'No default set'}
                        </span>
                      </label>
                      <div className="large-cash-box">
                        <span className="cash-box-prefix">Rs.</span>
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          value={batchBuyingPrice}
                          onChange={(e) => setBatchBuyingPrice(e.target.value)}
                          placeholder={
                            selectedProduct.buying_price !== null
                              ? String(selectedProduct.buying_price)
                              : 'Required'
                          }
                        />
                      </div>
                      <small style={{ color: '#64748b', fontSize: 11, display: 'block', marginTop: 4 }}>
                        {lang === 'ta'
                          ? 'இந்த பேட்ச்சிற்கான அடக்க விலை பொருளின் அடிப்படை அடக்க விலையை மாற்றாது.'
                          : "Overriding cost here applies to this batch only and does not change the product's default cost."}
                      </small>
                    </div>

                    <button
                      type="button"
                      className="primary-action"
                      onClick={handleAddStock}
                      disabled={saving || !qty || Number(qty) <= 0}
                      style={{ marginTop: 16 }}
                    >
                      <Icon name="plus" size={20} />
                      <span>
                        {saving
                          ? '...'
                          : lang === 'ta'
                            ? `சரக்கு சேர்க்க (+${qty || 0})`
                            : `+ ADD STOCK (+${qty || 0})`}
                      </span>
                    </button>
                  </div>

                  <div
                    className="damage-reduction-drawer"
                    style={{ marginTop: 20, paddingTop: 14, borderTop: '1px dashed #cbd5e1' }}
                  >
                    <button
                      type="button"
                      onClick={() => setShowReduceDamage(!showReduceDamage)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#dc2626',
                        fontWeight: 700,
                        fontSize: 13,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        cursor: 'pointer',
                      }}
                    >
                      <Icon name="warning" size={16} />
                      <span>
                        {showReduceDamage
                          ? lang === 'ta'
                            ? '▲ குறைப்பு படிவம் மறை'
                            : '▲ Hide Damage Form'
                          : lang === 'ta'
                            ? '▼ சேதமடைந்த சரக்கு குறைக்க'
                            : '▼ Report Damaged / Adjust Stock'}
                      </span>
                    </button>

                    {showReduceDamage && (
                      <div className="adjust-form-panel" style={{ marginTop: 12 }}>
                        <div className="form-group" style={{ marginBottom: 10 }}>
                          <label
                            style={{
                              fontSize: 13,
                              fontWeight: 700,
                              color: '#475569',
                              marginBottom: 4,
                              display: 'block',
                            }}
                          >
                            {lang === 'ta' ? 'பேட்ச் தேர்வு:' : 'Select Specific Batch (FIFO Queue):'}
                          </label>
                          <select
                            value={selectedBatchId}
                            onChange={(e) => setSelectedBatchId(e.target.value)}
                            style={{
                              width: '100%',
                              padding: '10px',
                              borderRadius: 8,
                              border: '1px solid #cbd5e1',
                              fontSize: 13,
                            }}
                          >
                            <option value="">FIFO Auto (Oldest batch first)</option>
                            {activeBatches.map((b) => (
                              <option key={b.batch_id} value={b.batch_id}>
                                Batch #{b.batch_number} • Qty: {b.current_quantity} • Recv: {b.received_date}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="form-group" style={{ marginBottom: 10 }}>
                          <div className="large-cash-box">
                            <span className="cash-box-prefix">-</span>
                            <input
                              type="number"
                              min="1"
                              max={selectedProduct.stock}
                              value={reduceQty}
                              onChange={(e) => setReduceQty(e.target.value)}
                              placeholder="Qty to reduce"
                            />
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 6 }}>
                          {(['damaged', 'expired', 'adjustment'] as const).map((r) => (
                            <button
                              key={r}
                              type="button"
                              onClick={() => setAdjustReason(r)}
                              style={{
                                flex: 1,
                                padding: '8px',
                                borderRadius: 8,
                                border: adjustReason === r ? '2px solid #dc2626' : '1px solid #cbd5e1',
                                background: adjustReason === r ? '#fef2f2' : '#fff',
                                color: adjustReason === r ? '#b91c1c' : '#475569',
                                fontWeight: 800,
                                fontSize: 12,
                              }}
                            >
                              {r === 'damaged'
                                ? lang === 'ta'
                                  ? 'சேதம்'
                                  : 'Damaged'
                                : r === 'expired'
                                  ? lang === 'ta'
                                    ? 'காலாவதி'
                                    : 'Expired'
                                  : lang === 'ta'
                                    ? 'சரக்கு திருத்தம்'
                                    : 'Correction'}
                            </button>
                          ))}
                        </div>

                        <button
                          type="button"
                          className="primary-action danger"
                          onClick={handleReduceStock}
                          disabled={saving || !reduceQty || Number(reduceQty) <= 0}
                          style={{ marginTop: 14 }}
                        >
                          <Icon name="minus" size={18} />
                          <span>
                            {saving
                              ? '...'
                              : lang === 'ta'
                                ? `சரக்கு குறை (-${reduceQty || 0})`
                                : `CONFIRM REDUCE (-${reduceQty || 0})`}
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          ) : (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>
              {lang === 'ta'
                ? 'விவரங்களைப் பார்க்க ஒரு பொருளைத் தேர்ந்தெடுக்கவும்'
                : 'Select a product to view details and manage stock'}
            </div>
          )}
        </div>
      </section>

      {/* Starter Slot Conflict / Review Modal */}
      {reviewSlot && (
        <div className="modal-backdrop">
          <div className="modal-dialog" style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <h3>
                {lang === 'ta'
                  ? `சரக்கு அட்டை சரிபார்ப்பு: ${reviewSlot.definition.labelTa}`
                  : `Review Starter Card: ${reviewSlot.definition.labelEn}`}
              </h3>
              <button type="button" className="modal-close-btn" onClick={() => setReviewSlot(null)}>
                ✕
              </button>
            </div>
            <p style={{ fontSize: 13, color: '#475569', marginTop: 10 }}>
              {reviewSlot.conflictReason ||
                'A candidate product matches this slot but needs manager confirmation before binding.'}
            </p>
            <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
              {(reviewSlot.candidates ?? (reviewSlot.variant ? [reviewSlot.variant] : [])).map((cand) => (
                <div
                  key={cand.typeId}
                  style={{
                    padding: 12,
                    border: '1px solid #cbd5e1',
                    borderRadius: 10,
                    background: '#f8fafc',
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <div>
                    <b>{cand.nameEn}</b> <small style={{ color: '#64748b' }}>({cand.sku} • unit: {cand.soldBy})</small>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => handleResolveSlot(reviewSlot.definition.slotKey, 'fix_and_bind', cand.typeId)}
                      style={{
                        padding: '7px 12px',
                        borderRadius: 6,
                        border: 'none',
                        background: '#2864dc',
                        color: '#fff',
                        fontWeight: 800,
                        fontSize: 12,
                      }}
                    >
                      {lang === 'ta' ? 'பெயர்/அலகு திருத்தி இணை' : 'Fix name/unit & bind'}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => handleResolveSlot(reviewSlot.definition.slotKey, 'bind_as_is', cand.typeId)}
                      style={{
                        padding: '7px 12px',
                        borderRadius: 6,
                        border: '1px solid #2864dc',
                        background: '#fff',
                        color: '#2864dc',
                        fontWeight: 800,
                        fontSize: 12,
                      }}
                    >
                      {lang === 'ta' ? 'உள்ளபடியே இணை' : 'Bind as-is'}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => handleResolveSlot(reviewSlot.definition.slotKey, 'leave_other', cand.typeId)}
                      style={{
                        padding: '7px 12px',
                        borderRadius: 6,
                        border: '1px solid #cbd5e1',
                        background: '#fff',
                        color: '#475569',
                        fontWeight: 700,
                        fontSize: 12,
                      }}
                    >
                      {lang === 'ta' ? 'பிற பொருட்களில் வை' : 'Leave under Other Products'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Batch Queue & Movement History Modal */}
      {showHistoryModal && selectedProduct && (
        <div className="modal-backdrop">
          <div className="modal-dialog" style={{ maxWidth: 700 }}>
            <div className="modal-header">
              <h3>
                {lang === 'ta'
                  ? `${selectedProduct.ta} - பேட்ச் & நகர்வு வரலாறு`
                  : `${selectedProduct.name} - Batches & History`}
              </h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowHistoryModal(false)}
              >
                ✕
              </button>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 8,
                borderBottom: '1px solid #e2e8f0',
                paddingBottom: 8,
                margin: '10px 0',
              }}
            >
              <button
                type="button"
                onClick={() => setHistoryTab('batches')}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: 'none',
                  fontWeight: 700,
                  cursor: 'pointer',
                  background: historyTab === 'batches' ? '#0284c7' : '#f1f5f9',
                  color: historyTab === 'batches' ? '#fff' : '#475569',
                }}
              >
                {lang === 'ta' ? 'செயலில் உள்ள பேட்ச்கள்' : 'Active Batches (FIFO)'} ({activeBatches.length})
              </button>
              <button
                type="button"
                onClick={() => setHistoryTab('movements')}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: 'none',
                  fontWeight: 700,
                  cursor: 'pointer',
                  background: historyTab === 'movements' ? '#0284c7' : '#f1f5f9',
                  color: historyTab === 'movements' ? '#fff' : '#475569',
                }}
              >
                {lang === 'ta' ? 'சரக்கு நகர்வு விவரங்கள்' : 'Movement Audit Log'} ({stockMovements.length})
              </button>
            </div>

            {historyError ? (
              <p role="alert">
                {lang === 'ta' ? 'சரக்கு வரலாறு கிடைக்கவில்லை' : 'Could not load stock history.'}
              </p>
            ) : loadingHistory ? (
              <div style={{ padding: 20, textAlign: 'center', color: '#64748b' }}>Loading history...</div>
            ) : historyTab === 'batches' ? (
              <div style={{ maxHeight: 350, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', textAlign: 'left', borderBottom: '1px solid #cbd5e1' }}>
                      <th style={{ padding: 8 }}>Batch #</th>
                      <th style={{ padding: 8 }}>Received Date</th>
                      <th style={{ padding: 8, textAlign: 'right' }}>Current Qty</th>
                      <th style={{ padding: 8, textAlign: 'right' }}>Selling Price</th>
                      {isManagerOrOwner && <th style={{ padding: 8, textAlign: 'right' }}>Buying Cost</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {activeBatches.map((b) => (
                      <tr key={b.batch_id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: 8, fontWeight: 700 }}>#{b.batch_number}</td>
                        <td style={{ padding: 8 }}>{b.received_date}</td>
                        <td style={{ padding: 8, textAlign: 'right', fontWeight: 700 }}>{b.current_quantity}</td>
                        <td style={{ padding: 8, textAlign: 'right' }}>{formatMoney(b.selling_price)}</td>
                        {isManagerOrOwner && (
                          <td style={{ padding: 8, textAlign: 'right', color: '#64748b' }}>
                            {b.buying_price !== null && b.buying_price !== undefined
                              ? formatMoney(b.buying_price)
                              : '—'}
                          </td>
                        )}
                      </tr>
                    ))}
                    {activeBatches.length === 0 && (
                      <tr>
                        <td
                          colSpan={isManagerOrOwner ? 5 : 4}
                          style={{ padding: 20, textAlign: 'center', color: '#94a3b8' }}
                        >
                          No active stock batches found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ maxHeight: 350, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', textAlign: 'left', borderBottom: '1px solid #cbd5e1' }}>
                      <th style={{ padding: 8 }}>Date</th>
                      <th style={{ padding: 8 }}>Type</th>
                      <th style={{ padding: 8 }}>Batch #</th>
                      <th style={{ padding: 8, textAlign: 'right' }}>Change</th>
                      <th style={{ padding: 8 }}>Staff / Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockMovements.map((m) => (
                      <tr key={m.transaction_id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: 8, whiteSpace: 'nowrap' }}>{String(m.date).split('T')[0]}</td>
                        <td style={{ padding: 8, textTransform: 'capitalize' }}>
                          <b>{m.type}</b>
                        </td>
                        <td style={{ padding: 8 }}>#{m.batch_number}</td>
                        <td
                          style={{
                            padding: 8,
                            textAlign: 'right',
                            fontWeight: 700,
                            color: m.quantity_change > 0 ? '#15803d' : '#b91c1c',
                          }}
                        >
                          {m.quantity_change > 0 ? `+${m.quantity_change}` : m.quantity_change}
                        </td>
                        <td style={{ padding: 8, color: '#64748b' }}>
                          {m.staff_name} {m.note ? `• ${m.note}` : ''}
                        </td>
                      </tr>
                    ))}
                    {stockMovements.length === 0 && (
                      <tr>
                        <td colSpan={5} style={{ padding: 20, textAlign: 'center', color: '#94a3b8' }}>
                          No stock movement history found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ marginTop: 14, textAlign: 'right' }}>
              <button
                type="button"
                className="btn-cancel"
                onClick={() => setShowHistoryModal(false)}
                style={{ padding: '8px 16px' }}
              >
                {t('back')}
              </button>
            </div>
          </div>
        </div>
      )}

      <AddProductModal
        isOpen={showAddProductModal}
        onClose={() => {
          setShowAddProductModal(false);
          setAddPreset(null);
        }}
        token={token}
        role={role}
        preset={addPreset}
        onSuccess={(newProd) => {
          selectAndPersistProduct(newProd);
          loadProducts();
          window.dispatchEvent(new CustomEvent('refresh-stock-data'));
        }}
      />

      <EditProductModal
        isOpen={showEditProductModal}
        onClose={() => {
          setShowEditProductModal(false);
          setFocusBuyingCostInModal(false);
        }}
        product={selectedProduct}
        token={token}
        role={role}
        initialFocusPrice={focusBuyingCostInModal}
        onUpdated={(updated) => {
          selectAndPersistProduct(updated);
          loadProducts();
          window.dispatchEvent(new CustomEvent('refresh-stock-data'));
        }}
        onDeleted={() => {
          selectAndPersistProduct(null);
          loadProducts();
          window.dispatchEvent(new CustomEvent('refresh-stock-data'));
        }}
      />
    </div>
  );
}

export { STARTER_SLOTS };
