import { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import type { Product, Role } from '../../types';
import { Icon } from '../Icon';

export function EditProductModal({
  isOpen,
  onClose,
  product,
  token,
  role,
  initialFocusPrice = false,
  onUpdated,
  onDeleted,
}: {
  isOpen: boolean;
  onClose: () => void;
  product: Product | null;
  token: string;
  role: Role;
  initialFocusPrice?: boolean;
  onUpdated: (product: Product) => void;
  onDeleted?: (id: string | number) => void;
}) {
  const { lang, showToast, speak } = useApp();
  const [name, setName] = useState('');
  const [nameTa, setNameTa] = useState('');
  const [unit, setUnit] = useState('bottle');
  const [sellingPrice, setSellingPrice] = useState('');
  const [buyingCost, setBuyingCost] = useState('');
  const [lowStockLimit, setLowStockLimit] = useState('10');
  const [isReturnable, setIsReturnable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !product) return;
    setName(product.name);
    setNameTa(product.ta || product.name);
    setUnit(product.unit || 'bottle');
    setSellingPrice(product.price !== null && product.price !== undefined ? String(product.price) : '');
    setBuyingCost(product.buying_price !== null && product.buying_price !== undefined ? String(product.buying_price) : '');
    setLowStockLimit(String(product.low_stock_limit ?? 10));
    setIsReturnable(Boolean(product.is_returnable));
    setConfirmArchive(false);
    setError(null);
  }, [isOpen, product]);

  if (!isOpen || !product || (role !== 'owner' && role !== 'manager')) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(lang === 'ta' ? 'பெயர் தேவை' : 'Product name is required');
      return;
    }

    const priceVal = sellingPrice.trim() === '' ? null : Number(sellingPrice);
    const costVal = buyingCost.trim() === '' ? null : Number(buyingCost);

    setSaving(true);
    setError(null);
    try {
      const updated = await api.post<Product>(
        '/products/update',
        {
          type_id: product.type_id,
          name: name.trim(),
          ta: nameTa.trim() || name.trim(),
          unit,
          selling_price: priceVal,
          buying_price: costVal,
          low_stock_limit: Number(lowStockLimit) || 10,
          is_returnable: isReturnable,
        },
        token,
      );
      speak('Product updated', 'பொருள் விவரம் மாற்றப்பட்டது');
      showToast(
        lang === 'ta' ? `${updated.ta || updated.name} மாற்றப்பட்டது.` : `Updated "${updated.name}".`,
        'success',
      );
      onUpdated(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update product');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post('/products/archive', { type_id: product.type_id, action: 'archive' }, token);
      showToast(lang === 'ta' ? 'பொருள் முடக்கப்பட்டது.' : `Archived "${product.name}".`, 'success');
      if (onDeleted) onDeleted(product.type_id || product.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive product');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-dialog" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>{lang === 'ta' ? 'பொருள் விவரம் மாற்றுக' : 'Edit Product Details'}</h3>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSave} style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          {error && (
            <div className="error-box" style={{ marginTop: 0 }}>
              <Icon name="warning" size={18} />
              <span>{error}</span>
            </div>
          )}

          <div className="form-row-2">
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'பெயர் (English) *' : 'Name (English) *'}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'தமிழ் பெயர்' : 'Tamil Name'}</span>
              <input
                value={nameTa}
                onChange={(e) => setNameTa(e.target.value)}
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              />
            </label>
          </div>

          <div className="form-row-2">
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'அலகு (Unit)' : 'Sold By (Unit)'}</span>
              <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                <option value="bottle">Bottle</option>
                <option value="can">Can</option>
                <option value="case">Case</option>
                <option value="pack">Pack</option>
                <option value="unit">Unit</option>
              </select>
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

          <div className="form-row-2">
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'விற்பனை விலை (Rs.)' : 'Selling Price (Rs.)'}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={sellingPrice}
                onChange={(e) => setSellingPrice(e.target.value)}
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
                autoFocus={initialFocusPrice}
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              />
            </label>
          </div>

          <small style={{ color: '#64748b', fontSize: 11 }}>
            {lang === 'ta'
              ? 'அடிப்படை அடக்க விலையை மாற்றுவது பழைய பேட்ச் அல்லது பழைய பில்களின் செலவை மாற்றாது.'
              : 'Updating the default buying cost only prefills future batches and never rewrites past batches or invoices.'}
          </small>

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
                ? 'திருப்பித் தரும் கேன் (Customer Returnable Can)'
                : 'Track as Customer Returnable Can'}
            </span>
          </label>

          {confirmArchive && (
            <div className="inline-confirm-bar">
              <span>{lang === 'ta' ? `'${product.name}' பொருளை முடக்கவா?` : `Archive "${product.name}"?`}</span>
              <div className="inline-confirm-actions">
                <button type="button" className="btn-cancel" onClick={() => setConfirmArchive(false)}>
                  {lang === 'ta' ? 'இல்லை' : 'No'}
                </button>
                <button
                  type="button"
                  className="btn-danger-outline"
                  disabled={saving}
                  onClick={handleArchive}
                >
                  {lang === 'ta' ? 'ஆம், முடக்கு' : 'Yes, Archive'}
                </button>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 8 }}>
            {!confirmArchive ? (
              <button
                type="button"
                className="btn-danger-outline"
                onClick={() => setConfirmArchive(true)}
              >
                <Icon name="trash" size={14} />
                <span>{lang === 'ta' ? 'முடக்கு' : 'Archive'}</span>
              </button>
            ) : (
              <span />
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn-cancel" onClick={onClose} style={{ padding: '10px 16px' }}>
                {lang === 'ta' ? 'ரத்து' : 'Cancel'}
              </button>
              <button type="submit" className="btn-primary" disabled={saving} style={{ padding: '10px 18px' }}>
                <Icon name="check" size={16} />
                <span>{saving ? '...' : lang === 'ta' ? 'சேமி' : 'Save Changes'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
