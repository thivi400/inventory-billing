import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import type { Role, ShopDetailsConfig, StaffUser } from '../types';
import { Icon } from '../components/Icon';

export function StaffPage({ token }: { token: string }) {
  const { lang, showToast } = useApp();
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [name, setName] = useState('');
  const [nameTa, setNameTa] = useState('');
  const [role, setRole] = useState<Role>('employee');
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [resetTarget, setResetTarget] = useState<StaffUser | null>(null);
  const [resetPinVal, setResetPinVal] = useState('');

  const loadStaff = () => {
    api
      .get<StaffUser[]>('/staff', token)
      .then((rows) => setStaff(Array.isArray(rows) ? rows : []))
      .catch((err) => showToast(err instanceof Error ? err.message : 'Failed to load staff', 'error'));
  };

  useEffect(() => {
    loadStaff();
  }, [token]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !/^\d{4,8}$/.test(pin)) {
      showToast(lang === 'ta' ? 'பெயர் மற்றும் 4-8 இலக்க PIN தேவை' : 'Name and 4-8 digit PIN required', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.post('/staff', { name: name.trim(), name_ta: nameTa.trim(), role, pin }, token);
      showToast(lang === 'ta' ? 'பணியாளர் சேர்க்கப்பட்டார்.' : 'Staff member added.', 'success');
      setName('');
      setNameTa('');
      setPin('');
      loadStaff();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to add staff', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateStaff = async (member: StaffUser, patch: { role?: Role; is_active?: boolean }) => {
    try {
      await api.put(`/staff/${member.id}`, patch, token);
      showToast(lang === 'ta' ? 'பணியாளர் புதுப்பிக்கப்பட்டார்.' : 'Staff account updated.', 'success');
      loadStaff();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update staff', 'error');
    }
  };

  const handleResetPin = async () => {
    if (!resetTarget || !/^\d{4,8}$/.test(resetPinVal)) {
      showToast(lang === 'ta' ? '4-8 இலக்க PIN உள்ளிடவும்' : 'Enter a 4-8 digit PIN', 'error');
      return;
    }
    try {
      await api.post(`/staff/${resetTarget.id}/reset-pin`, { pin: resetPinVal }, token);
      showToast(
        lang === 'ta'
          ? 'PIN மாற்றப்பட்டது மற்றும் பழைய அமர்வுகள் நீக்கப்பட்டன.'
          : 'PIN reset and existing sessions revoked.',
        'success',
      );
      setResetTarget(null);
      setResetPinVal('');
      loadStaff();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to reset PIN', 'error');
    }
  };

  return (
    <div className="workflow-page inside-scroll">
      <div className="page-title compact">
        <div>
          <p className="eyebrow">{lang === 'ta' ? 'உரிமையாளர் மட்டும்' : 'OWNER ONLY'}</p>
          <h1>{lang === 'ta' ? 'பணியாளர்கள் & PIN மேலாண்மை' : 'Staff & PIN Management'}</h1>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 16, alignItems: 'start' }}>
        <form className="workflow-card" onSubmit={handleCreate} style={{ display: 'grid', gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>
            {lang === 'ta' ? 'புதிய பணியாளர் சேர்க்க' : 'Add Staff Account'}
          </h3>
          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
            <span>{lang === 'ta' ? 'பெயர் (English) *' : 'Name (English) *'}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Karthik"
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
            <span>{lang === 'ta' ? 'தமிழ் பெயர்' : 'Tamil Name'}</span>
            <input
              value={nameTa}
              onChange={(e) => setNameTa(e.target.value)}
              placeholder="எ.கா. கார்த்திக்"
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
            />
          </label>
          <div className="form-row-2">
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'பதவி' : 'Role'}</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="employee">{lang === 'ta' ? 'பணியாளர் (Employee)' : 'Employee'}</option>
                <option value="manager">{lang === 'ta' ? 'மேலாளர் (Manager)' : 'Manager'}</option>
                <option value="owner">{lang === 'ta' ? 'உரிமையாளர் (Owner)' : 'Owner'}</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
              <span>{lang === 'ta' ? 'PIN (4-8 எண்கள்) *' : 'PIN (4-8 digits) *'}</span>
              <input
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="4-8 digits"
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
              />
            </label>
          </div>
          <button type="submit" className="primary-action" disabled={saving} style={{ marginTop: 4 }}>
            <Icon name="plus" size={18} />
            <span>{saving ? '...' : lang === 'ta' ? 'பணியாளர் சேர்க்க' : 'Create Staff Account'}</span>
          </button>
        </form>

        <div className="workflow-card" style={{ display: 'grid', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>
            {lang === 'ta' ? 'கடை பணியாளர்கள்' : 'Shop Staff Accounts'} ({staff.length})
          </h3>

          {resetTarget && (
            <div className="inline-confirm-bar">
              <span>
                {lang === 'ta' ? `${resetTarget.name} புதிய PIN:` : `New PIN for ${resetTarget.name}:`}
              </span>
              <div className="inline-confirm-actions">
                <input
                  type="password"
                  inputMode="numeric"
                  value={resetPinVal}
                  onChange={(e) => setResetPinVal(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  placeholder="4-8 digits"
                  style={{ width: 110, padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff' }}
                />
                <button
                  type="button"
                  onClick={handleResetPin}
                  style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#2864dc', color: '#fff', fontWeight: 800 }}
                >
                  {lang === 'ta' ? 'மாற்று' : 'Save PIN'}
                </button>
                <button type="button" className="btn-cancel" onClick={() => setResetTarget(null)}>
                  {lang === 'ta' ? 'ரத்து' : 'Cancel'}
                </button>
              </div>
            </div>
          )}

          {staff.map((m) => (
            <div
              key={m.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 10,
                padding: '12px 14px',
                borderRadius: 12,
                border: '1px solid #e2e8f0',
                background: m.is_active ? '#fff' : '#f8fafc',
                opacity: m.is_active ? 1 : 0.7,
              }}
            >
              <div>
                <b style={{ fontSize: 15 }}>
                  {lang === 'ta' && m.name_ta ? m.name_ta : m.name}
                </b>
                <small style={{ display: 'block', color: '#64748b', fontWeight: 700 }}>
                  {m.role.toUpperCase()} • {m.is_active ? 'Active' : 'Disabled'}
                  {m.is_locked ? ' • LOCKED' : ''}
                </small>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <select
                  value={m.role}
                  onChange={(e) => handleUpdateStaff(m, { role: e.target.value as Role })}
                  style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, fontWeight: 700 }}
                >
                  <option value="employee">Employee</option>
                  <option value="manager">Manager</option>
                  <option value="owner">Owner</option>
                </select>
                <button
                  type="button"
                  onClick={() => {
                    setResetTarget(m);
                    setResetPinVal('');
                  }}
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', fontSize: 12, fontWeight: 700 }}
                >
                  {lang === 'ta' ? 'PIN மாற்று' : 'Reset PIN'}
                </button>
                <button
                  type="button"
                  onClick={() => handleUpdateStaff(m, { is_active: !m.is_active })}
                  className={m.is_active ? 'btn-danger-outline' : 'btn-modify-large'}
                  style={{ padding: '6px 10px', fontSize: 12 }}
                >
                  {m.is_active ? (lang === 'ta' ? 'முடக்கு' : 'Disable') : lang === 'ta' ? 'இயக்கு' : 'Enable'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ShopDetailsPage({
  token,
  onShopUpdated,
}: {
  token: string;
  onShopUpdated?: (shop: ShopDetailsConfig) => void;
}) {
  const { lang, showToast } = useApp();
  const [form, setForm] = useState<ShopDetailsConfig>({
    name_en: '',
    name_ta: '',
    address_en: '',
    address_ta: '',
    phone: '',
    tax_id: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<ShopDetailsConfig>('/shop-details', token)
      .then((data) => setForm(data))
      .catch(() => {});
  }, [token]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api.put<ShopDetailsConfig>('/shop-details', form, token);
      setForm(updated);
      if (onShopUpdated) onShopUpdated(updated);
      showToast(
        lang === 'ta'
          ? 'கடை விவரங்கள் சேமிக்கப்பட்டன (புதிய பில்களுக்கு மட்டும்).'
          : 'Shop details saved for future invoices.',
        'success',
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save shop details', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="workflow-page inside-scroll">
      <div className="page-title compact">
        <div>
          <p className="eyebrow">{lang === 'ta' ? 'உரிமையாளர் மட்டும்' : 'OWNER ONLY'}</p>
          <h1>{lang === 'ta' ? 'கடை விவரங்கள்' : 'Shop Details'}</h1>
        </div>
      </div>

      <form className="workflow-card narrow" onSubmit={handleSave} style={{ display: 'grid', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#64748b', fontWeight: 700 }}>
          {lang === 'ta'
            ? 'இங்கே உள்ளிடும் கடை விவரங்கள் புதிய பில்களில் மட்டும் இடம்பெறும். பழைய பில்களின் நகல் மாறாது.'
            : 'Configured details appear on newly created invoices only. Historical invoice snapshots remain untouched.'}
        </p>

        <div className="form-row-2">
          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
            <span>Shop Name (English)</span>
            <input
              value={form.name_en}
              onChange={(e) => setForm({ ...form, name_en: e.target.value })}
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
            <span>கடை பெயர் (தமிழ்)</span>
            <input
              value={form.name_ta}
              onChange={(e) => setForm({ ...form, name_ta: e.target.value })}
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
            />
          </label>
        </div>

        <div className="form-row-2">
          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
            <span>Address (English)</span>
            <input
              value={form.address_en}
              onChange={(e) => setForm({ ...form, address_en: e.target.value })}
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
            <span>முகவரி (தமிழ்)</span>
            <input
              value={form.address_ta}
              onChange={(e) => setForm({ ...form, address_ta: e.target.value })}
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
            />
          </label>
        </div>

        <div className="form-row-2">
          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
            <span>{lang === 'ta' ? 'தொலைபேசி' : 'Phone'}</span>
            <input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 700 }}>
            <span>{lang === 'ta' ? 'வரி எண் (Tax / VAT ID)' : 'Tax / VAT ID'}</span>
            <input
              value={form.tax_id}
              onChange={(e) => setForm({ ...form, tax_id: e.target.value })}
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
            />
          </label>
        </div>

        <button type="submit" className="primary-action" disabled={saving}>
          <Icon name="check" size={20} />
          <span>{saving ? '...' : lang === 'ta' ? 'கடை விவரங்களை சேமி' : 'Save Shop Details'}</span>
        </button>
      </form>
    </div>
  );
}

export function AuditLogPage({ token }: { token: string }) {
  const { lang } = useApp();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .get<any[]>('/audit-log?limit=200', token)
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div className="workflow-page inside-scroll">
      <div className="page-title compact">
        <div>
          <p className="eyebrow">{lang === 'ta' ? 'உரிமையாளர் மட்டும் • மாறாத பதிவு' : 'OWNER ONLY • APPEND-ONLY'}</p>
          <h1>{lang === 'ta' ? 'தணிக்கை பதிவு (Audit Log)' : 'Immutable Audit Log'}</h1>
        </div>
      </div>

      <div className="workflow-card" style={{ padding: 16 }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>Loading audit log...</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8' }}>No audit entries yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f1f5f9', borderBottom: '2px solid #cbd5e1', textAlign: 'left' }}>
                  <th style={{ padding: '8px 10px' }}>Timestamp</th>
                  <th style={{ padding: '8px 10px' }}>Actor</th>
                  <th style={{ padding: '8px 10px' }}>Action</th>
                  <th style={{ padding: '8px 10px' }}>Entity</th>
                  <th style={{ padding: '8px 10px' }}>Reason / Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.createdAt}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <b>{r.actorName}</b> <small style={{ color: '#64748b' }}>({r.actorRole})</small>
                    </td>
                    <td style={{ padding: '8px 10px', fontWeight: 800, color: '#1d4ed8' }}>{r.action}</td>
                    <td style={{ padding: '8px 10px' }}>
                      {r.entityType} <small style={{ color: '#64748b' }}>#{r.entityId}</small>
                    </td>
                    <td style={{ padding: '8px 10px', color: '#475569' }}>{r.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
