import { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import type { Customer, Role } from '../../types';
import { Icon } from '../Icon';

export function AddCustomerModal({
  isOpen,
  onClose,
  token,
  role = 'employee',
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  token: string;
  role?: Role;
  onSuccess: (customer: Customer) => void;
}) {
  const { lang, showToast, speak } = useApp();
  const [name, setName] = useState('');
  const [nameTa, setNameTa] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [creditLimit, setCreditLimit] = useState('0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const isManagerOrOwner = role === 'owner' || role === 'manager';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(lang === 'ta' ? 'வாடிக்கையாளர் பெயர் தேவை' : 'Customer name is required');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const created = await api.post<Customer>(
        '/customers/create',
        {
          name: name.trim(),
          name_ta: nameTa.trim(),
          phone: phone.trim(),
          address: address.trim(),
          credit_limit: isManagerOrOwner ? Number(creditLimit) || 0 : 0,
        },
        token,
      );
      speak('Customer added', 'வாடிக்கையாளர் சேர்க்கப்பட்டார்');
      showToast(
        lang === 'ta' ? `${created.name} சேர்க்கப்பட்டார்.` : `Customer ${created.name} added.`,
        'success',
      );
      onSuccess(created);
      setName('');
      setNameTa('');
      setPhone('');
      setAddress('');
      setCreditLimit('0');
      onClose();
      window.dispatchEvent(new CustomEvent('refresh-customer-data'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add customer');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-dialog" style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3>{lang === 'ta' ? 'புதிய வாடிக்கையாளர் சேர்க்க' : 'Add New Customer'}</h3>
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

          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
            <span>{lang === 'ta' ? 'வாடிக்கையாளர் பெயர் (English) *' : 'Customer Name (English) *'}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={lang === 'ta' ? 'எ.கா. Murugan Stores' : 'e.g. Murugan Stores'}
              autoFocus
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
            />
          </label>

          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
            <span>{lang === 'ta' ? 'தமிழ் பெயர் (விருப்பம்)' : 'Tamil Name (Optional)'}</span>
            <input
              value={nameTa}
              onChange={(e) => setNameTa(e.target.value)}
              placeholder="எ.கா. முருகன் ஸ்டோர்ஸ்"
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
            />
          </label>

          <div className="form-row-2">
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'தொலைபேசி' : 'Phone'}</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="077-000-0000"
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              />
            </label>

            {isManagerOrOwner && (
              <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
                <span>{lang === 'ta' ? 'கடன் வரம்பு (Rs.)' : 'Credit Limit (Rs.)'}</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={creditLimit}
                  onChange={(e) => setCreditLimit(e.target.value)}
                  style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
                />
              </label>
            )}
          </div>

          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
            <span>{lang === 'ta' ? 'முகவரி' : 'Address'}</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={lang === 'ta' ? 'கடை முகவரி' : 'Shop address'}
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
            />
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
            <button type="button" className="btn-cancel" onClick={onClose} style={{ padding: '10px 16px' }}>
              {lang === 'ta' ? 'ரத்து' : 'Cancel'}
            </button>
            <button type="submit" className="btn-primary" disabled={saving} style={{ padding: '10px 18px' }}>
              <Icon name="check" size={16} />
              <span>{saving ? '...' : lang === 'ta' ? 'வாடிக்கையாளரைச் சேமி' : 'Save Customer'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
