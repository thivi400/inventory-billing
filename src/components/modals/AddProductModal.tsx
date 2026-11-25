import { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import type { Product, Role } from '../../types';
import { Icon } from '../Icon';

export interface AddProductPreset {
  slotKey?: string;
  name: string;
  nameTa: string;
  sku: string;
  unit: 'bottle' | 'can' | 'case' | 'pack' | 'unit';
  isReturnable: boolean;
}

export function AddProductModal({
  isOpen,
  onClose,
  token,
  role,
  preset,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  token: string;
  role: Role;
  preset?: AddProductPreset | null;
  onSuccess: (product: Product) => void;
}) {
  const { lang, showToast, speak } = useApp();
  const [name, setName] = useState('');
  const [nameTa, setNameTa] = useState('');
  const [sku, setSku] = useState('');
  const [unit, setUnit] = useState<'bottle' | 'can' | 'case' | 'pack' | 'unit'>('bottle');
  const [sellingPrice, setSellingPrice] = useState('');
  const [buyingCost, setBuyingCost] = useState('');
  const [openingQty, setOpeningQty] = useState('0');
  const [lowStockLimit, setLowStockLimit] = useState('10');
  // Explicit returnable flag — NEVER auto-checked just because unit === 'can' or name has 'can'!
  const [isReturnable, setIsReturnable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    if (preset) {
      setName(preset.name);
      setNameTa(preset.nameTa);
      setSku(preset.sku);
      setUnit(preset.unit);
      setIsReturnable(preset.isReturnable);
    } else {
      setName('');
      setNameTa('');
      setSku('');
      setUnit('bottle');
      setIsReturnable(false);
    }
    // Selling price, buying cost, and opening qty are deliberately empty / 0 so staff enters real figures!
    setSellingPrice('');
    setBuyingCost('');
    setOpeningQty('0');
    setLowStockLimit('10');
  }, [isOpen, preset]);

  if (!isOpen || (role !== 'owner' && role !== 'manager')) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(lang === 'ta' ? 'பொருள் பெயர் தேவை' : 'Product name is required');
      return;
    }

    const qtyNum = Number(openingQty) || 0;
    if (!Number.isInteger(qtyNum) || qtyNum < 0) {
      setError(lang === 'ta' ? 'சரியான ஆரம்ப கையிருப்பு எண்ணிக்கை தேவை' : 'Opening quantity must be a whole number >= 0');
      return;
    }

    const priceVal = sellingPrice.trim() === '' ? null : Number(sellingPrice);
    if (priceVal !== null && (isNaN(priceVal) || priceVal < 0)) {
      setError(lang === 'ta' ? 'சரியான விற்பனை விலை உள்ளிடவும்' : 'Enter a valid selling price');
      return;
    }

    const costVal = buyingCost.trim() === '' ? null : Number(buyingCost);
    if (costVal !== null && (isNaN(costVal) || costVal < 0)) {
      setError(lang === 'ta' ? 'சரியான அடக்க விலை உள்ளிடவும்' : 'Enter a valid buying cost');
      return;
    }

    if (qtyNum > 0 && costVal === null) {
      setError(
        lang === 'ta'
          ? 'ஆரம்ப கையிருப்பு சேர்க்க அடக்க விலை தேவை'
          : 'Buying cost is required when adding opening stock quantity',
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const created = await api.post<Product>(
        '/products/create',
        {
          slot_key: preset?.slotKey || undefined,
          name: name.trim(),
          ta: nameTa.trim() || name.trim(),
          sku: sku.trim() || undefined,
          unit,
          selling_price: priceVal,
          buying_price: costVal,
          opening_qty: qtyNum,
          low_stock_limit: Number(lowStockLimit) || 10,
          is_returnable: isReturnable,
        },
        token,
      );
      speak('Product created', 'புதிய பொருள் சேர்க்கப்பட்டது');
      showToast(
        lang === 'ta' ? `${created.ta || created.name} சேர்க்கப்பட்டது.` : `Product "${created.name}" created.`,
        'success',
      );
      onSuccess(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create product');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-dialog" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>
            {preset
              ? lang === 'ta'
                ? `அமைக்கவும்: ${preset.nameTa}`
                : `Set up: ${preset.name}`
              : lang === 'ta'
                ? 'புதிய பொருள் சேர்க்க'
                : 'Add New Product'}
          </h3>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          {error && (
            <div className="error-box" style={{ marginTop: 0 }}>
              <Icon name="warning" size={18} />
              <span>{error}</span>
            </div>
          )}

          <div className="form-row-2">
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'பெயர் (English) *' : 'Product Name (English) *'}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. 1.5 L Water"
                autoFocus={!preset}
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'தமிழ் பெயர்' : 'Tamil Name'}</span>
              <input
                value={nameTa}
                onChange={(e) => setNameTa(e.target.value)}
                placeholder="எ.கா. 1.5 லிட்டர் தண்ணீர்"
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              />
            </label>
          </div>

          <div className="form-row-2">
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'SKU குறியீடு' : 'SKU Code'}</span>
              <input
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="e.g. SKU-1.5L"
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'விற்பனை அலகு (Unit)' : 'Sold By (Unit)'}</span>
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value as typeof unit)}
              >
                <option value="bottle">Bottle</option>
                <option value="can">Can</option>
                <option value="case">Case</option>
                <option value="pack">Pack</option>
                <option value="unit">Unit</option>
              </select>
            </label>
          </div>

          <div className="form-row-2">
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'விற்பனை விலை (Rs.)' : 'Selling Price (Rs.)'}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={sellingPrice}
                onChange={(e) => setSellingPrice(e.target.value)}
                placeholder={lang === 'ta' ? 'விலையை உள்ளிடவும்' : 'Enter deliberate price'}
                autoFocus={Boolean(preset)}
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'அடிப்படை அடக்க விலை (Rs.)' : 'Default Buying Cost (Rs.)'}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={buyingCost}
                onChange={(e) => setBuyingCost(e.target.value)}
                placeholder={lang === 'ta' ? 'அடக்க விலை' : 'Enter buying cost'}
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              />
            </label>
          </div>

          <div className="form-row-2">
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'ஆரம்ப கையிருப்பு' : 'Opening Stock Qty'}</span>
              <input
                type="number"
                min="0"
                step="1"
                value={openingQty}
                onChange={(e) => setOpeningQty(e.target.value)}
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'குறைந்த இருப்பு எச்சரிக்கை' : 'Low Stock Limit'}</span>
              <input
                type="number"
                min="0"
                step="1"
                value={lowStockLimit}
                onChange={(e) => setLowStockLimit(e.target.value)}
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              />
            </label>
          </div>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              background: '#f8fafc',
              borderRadius: 8,
              border: '1px solid #e2e8f0',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={isReturnable}
              onChange={(e) => setIsReturnable(e.target.checked)}
              style={{ width: 18, height: 18 }}
            />
            <span>
              {lang === 'ta'
                ? 'திருப்பித் தரும் கேன் கணக்கில் சேர்க்க (Customer Returnable Can)'
                : 'Track as Customer Returnable Can (only filled returnable cans)'}
            </span>
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
            <button type="button" className="btn-cancel" onClick={onClose} style={{ padding: '10px 16px' }}>
              {lang === 'ta' ? 'ரத்து' : 'Cancel'}
            </button>
            <button type="submit" className="btn-primary" disabled={saving} style={{ padding: '10px 18px' }}>
              <Icon name="check" size={16} />
              <span>{saving ? '...' : lang === 'ta' ? 'பொருளைச் சேமி' : 'Save Product'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
