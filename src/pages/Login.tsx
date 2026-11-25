import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { api, ApiError, type AuthStatusResponse } from '../services/api';
import type { IconName, Role, StaffUser } from '../types';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { LanguageButton } from '../components/LanguageButton';

const roleStyle: Record<Role, { icon: IconName; color: string }> = {
  owner: { icon: 'crown', color: 'purple' },
  manager: { icon: 'box', color: 'blue' },
  employee: { icon: 'hand', color: 'orange' },
};

export function Login({
  onLogin,
}: {
  onLogin: (session: {
    token: string;
    id: string;
    role: Role;
    name: string;
    trialMode?: boolean;
  }) => void;
}) {
  const { t, lang, speak, voice, setVoice, showToast } = useApp();
  const [status, setStatus] = useState<AuthStatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [selectedStaff, setSelectedStaff] = useState<StaffUser | null>(null);
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // First-Run Owner Setup state
  const [ownerName, setOwnerName] = useState('');
  const [shopNameEn, setShopNameEn] = useState('');
  const [shopNameTa, setShopNameTa] = useState('');
  const [phone, setPhone] = useState('');
  const [setupPin, setSetupPin] = useState('');
  const [setupPinConfirm, setSetupPinConfirm] = useState('');
  const [trialCreds, setTrialCreds] = useState<Array<{ name: string; role: Role; pin: string }> | null>(null);

  const loadStatus = async () => {
    setLoadingStatus(true);
    try {
      const data = await api.getStatus();
      setStatus(data);
      const activeStaff = data.staff.filter((s) => s.is_active);
      setSelectedStaff((curr) => activeStaff.find((s) => s.id === curr?.id) ?? activeStaff[0] ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach shop server');
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const submitPinLogin = async () => {
    if (!selectedStaff || pin.length < 4 || loading) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.signIn(pin, selectedStaff.role, selectedStaff.id);
      speak('Signed in', 'உள்நுழைந்துவிட்டீர்கள்');
      onLogin({
        token: result.access_token,
        id: result.user.id,
        role: result.user.role,
        name: result.user.name,
        trialMode: result.trialMode ?? status?.trialMode,
      });
    } catch (e) {
      setPin('');
      if (e instanceof ApiError && (e.status === 423 || e.code === 'account_locked')) {
        setError(
          lang === 'ta'
            ? 'கணக்கு தற்காலிகமாக பூட்டப்பட்டுள்ளது. சிறிது நேரம் கழித்து முயற்சிக்கவும்.'
            : 'Account temporarily locked. Try again later.',
        );
        loadStatus();
      } else {
        setError(
          lang === 'ta'
            ? 'தவறான PIN அல்லது கணக்கு கிடைக்கவில்லை.'
            : 'Invalid credentials.',
        );
      }
      speak('Sign in failed', 'உள்நுழைய முடியவில்லை');
    } finally {
      setLoading(false);
    }
  };

  const handleBootstrapOwner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ownerName.trim() || !shopNameEn.trim()) {
      setError(lang === 'ta' ? 'உரிமையாளர் மற்றும் கடை பெயர் தேவை' : 'Owner name and shop name are required');
      return;
    }
    if (!/^\d{4,8}$/.test(setupPin)) {
      setError(lang === 'ta' ? 'PIN 4 முதல் 8 இலக்க எண்களாக இருக்க வேண்டும்' : 'PIN must be 4 to 8 digits');
      return;
    }
    if (setupPin !== setupPinConfirm) {
      setError(lang === 'ta' ? 'PIN இரண்டும் பொருந்தவில்லை' : 'PIN confirmation does not match');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const result = await api.bootstrapOwner({
        ownerName: ownerName.trim(),
        shopNameEn: shopNameEn.trim(),
        shopNameTa: shopNameTa.trim(),
        phone: phone.trim(),
        pin: setupPin,
      });
      showToast(lang === 'ta' ? 'கடை அமைக்கப்பட்டது!' : 'Shop initialized successfully.', 'success');
      onLogin({
        token: result.access_token,
        id: result.user.id,
        role: result.user.role,
        name: result.user.name,
        trialMode: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setLoading(false);
    }
  };

  const handleBootstrapTrial = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.bootstrapTrial();
      setTrialCreds(res.staff);
      showToast(
        lang === 'ta' ? 'சோதனை தரவு ஏற்றப்பட்டது.' : 'Disposable trial scenario loaded.',
        'info',
      );
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trial scenario');
    } finally {
      setLoading(false);
    }
  };

  const activeStaffList = (status?.staff ?? []).filter((s) => s.is_active);
  const shopDisplayName =
    lang === 'ta'
      ? status?.shopNameTa || status?.shopNameEn || undefined
      : status?.shopNameEn || undefined;

  return (
    <main className="login-page">
      <header className="login-header">
        <Logo shopName={shopDisplayName} />
        <div className="header-tools">
          <LanguageButton />
          <button
            type="button"
            className={`utility-btn ${voice ? 'active' : ''}`}
            onClick={() => setVoice(!voice)}
          >
            <Icon name="speaker" size={18} />
            <b>{voice ? t('on') : t('off')}</b>
          </button>
        </div>
      </header>

      {loadingStatus ? (
        <section className="login-card" style={{ gridTemplateColumns: '1fr', padding: 48, textAlign: 'center' }}>
          <p style={{ color: '#64748b', fontWeight: 800 }}>
            {lang === 'ta' ? 'கடை சர்வருடன் இணைகிறது...' : 'Connecting to shop server...'}
          </p>
        </section>
      ) : !status?.initialized ? (
        <section className="login-card" style={{ gridTemplateColumns: '1fr 370px' }}>
          <div className="login-intro" style={{ paddingBottom: 32 }}>
            <p className="eyebrow">{lang === 'ta' ? 'முதல் முறை அமைப்பு' : 'FIRST-RUN SETUP'}</p>
            <h1>{lang === 'ta' ? 'உரிமையாளர் கணக்கை அமைக்கவும்' : 'Set Up Your Shop'}</h1>
            <p style={{ marginTop: 12, color: '#64748b', fontSize: 14, fontWeight: 700, lineHeight: 1.5 }}>
              {lang === 'ta'
                ? 'உங்கள் கடை விவரங்களையும் உரிமையாளர் PIN எண்ணையும் உள்ளிட்டு தொடங்கவும். அல்லது சோதனை தரவை ஏற்றிப் பார்க்கலாம்.'
                : 'Create your Owner account and shop details to begin with a clean ledger, or load a clearly labeled synthetic trial scenario.'}
            </p>

            <div
              style={{
                marginTop: 24,
                padding: 16,
                background: '#fffbeb',
                border: '1px solid #fde68a',
                borderRadius: 14,
              }}
            >
              <b style={{ display: 'block', fontSize: 14, color: '#92400e' }}>
                {lang === 'ta' ? 'சோதனை தரவு (Trial Mode)' : 'Optional Disposable Trial Scenario'}
              </b>
              <small style={{ display: 'block', marginTop: 4, color: '#78350f', fontSize: 12 }}>
                {lang === 'ta'
                  ? '3 பணியாளர்கள், மாதிரி சரக்குகள் மற்றும் வாடிக்கையாளர்களுடன் சோதிக்க.'
                  : 'Loads synthetic Sri Lankan wholesale products, customers, and 3 staff accounts for testing.'}
              </small>
              <button
                type="button"
                disabled={loading}
                onClick={handleBootstrapTrial}
                style={{
                  marginTop: 12,
                  padding: '10px 14px',
                  borderRadius: 10,
                  border: '1px solid #d97706',
                  background: '#ffffff',
                  color: '#92400e',
                  fontWeight: 800,
                  fontSize: 13,
                }}
              >
                {loading ? '...' : lang === 'ta' ? 'சோதனை தரவை ஏற்று' : 'Load Trial Scenario'}
              </button>
            </div>
          </div>

          <form className="pin-area" onSubmit={handleBootstrapOwner} style={{ display: 'grid', gap: 10, alignContent: 'center' }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 800 }}>
              <span>{lang === 'ta' ? 'உரிமையாளர் பெயர் *' : 'Owner Name *'}</span>
              <input
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="e.g. Suresh Nathan"
                style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff' }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 800 }}>
              <span>{lang === 'ta' ? 'கடை பெயர் (English) *' : 'Shop Name (English) *'}</span>
              <input
                value={shopNameEn}
                onChange={(e) => setShopNameEn(e.target.value)}
                placeholder="e.g. Lanka Pure Water"
                style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff' }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 800 }}>
              <span>{lang === 'ta' ? 'கடை பெயர் (தமிழ்)' : 'Shop Name (Tamil)'}</span>
              <input
                value={shopNameTa}
                onChange={(e) => setShopNameTa(e.target.value)}
                placeholder="எ.கா. லங்கா பியூர் வாட்டர்"
                style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff' }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 800 }}>
              <span>{lang === 'ta' ? 'தொலைபேசி' : 'Shop Phone'}</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="021-222-0000"
                style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff' }}
              />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 800 }}>
                <span>{lang === 'ta' ? 'PIN (4-8 எண்கள்) *' : 'Owner PIN *'}</span>
                <input
                  type="password"
                  inputMode="numeric"
                  value={setupPin}
                  onChange={(e) => setSetupPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  placeholder="4-8 digits"
                  style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff' }}
                />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 800 }}>
                <span>{lang === 'ta' ? 'PIN உறுதி *' : 'Confirm PIN *'}</span>
                <input
                  type="password"
                  inputMode="numeric"
                  value={setupPinConfirm}
                  onChange={(e) => setSetupPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  placeholder="Repeat PIN"
                  style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff' }}
                />
              </label>
            </div>
            {error && (
              <div className="error-box" style={{ marginTop: 4 }}>
                <Icon name="warning" size={18} />
                <span>{error}</span>
              </div>
            )}
            <button type="submit" className="primary-action" disabled={loading} style={{ marginTop: 6 }}>
              <Icon name="check" size={22} />
              <span>{loading ? '...' : lang === 'ta' ? 'கடையைத் தொடங்கு' : 'Create Owner & Start'}</span>
            </button>
          </form>
        </section>
      ) : (
        <section className="login-card">
          <div className="login-intro">
            <p className="eyebrow">{t('hello')}</p>
            <h1>{t('chooseRole')}</h1>
            {trialCreds && (
              <div
                style={{
                  marginTop: 10,
                  padding: '8px 12px',
                  background: '#fffbeb',
                  border: '1px solid #fde68a',
                  borderRadius: 10,
                  fontSize: 12,
                  color: '#92400e',
                  fontWeight: 700,
                }}
              >
                {lang === 'ta' ? 'சோதனை PINகள்: ' : 'Trial PINs: '}
                {trialCreds.map((c) => `${c.name} (${c.role}): ${c.pin}`).join(' • ')}
              </div>
            )}
          </div>

          <div className="role-grid" style={{ maxHeight: 360, overflowY: 'auto' }}>
            {activeStaffList.map((staff) => {
              const meta = roleStyle[staff.role];
              const isSelected = selectedStaff?.id === staff.id;
              return (
                <button
                  key={staff.id}
                  type="button"
                  className={`role-card ${meta.color} ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedStaff(staff);
                    setPin('');
                    setError('');
                    speak(staff.name, staff.name_ta || staff.name);
                  }}
                >
                  <span>
                    <Icon name={meta.icon} size={32} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <b style={{ display: 'block' }}>
                      {lang === 'ta' && staff.name_ta ? staff.name_ta : staff.name}
                    </b>
                    <small style={{ color: '#64748b', fontSize: 12, fontWeight: 700 }}>
                      {t(staff.role)}
                      {staff.is_locked ? ` • ${lang === 'ta' ? 'பூட்டப்பட்டது' : 'Locked'}` : ''}
                    </small>
                  </div>
                  {isSelected && (
                    <i>
                      <Icon name="check" size={16} />
                    </i>
                  )}
                </button>
              );
            })}
          </div>

          <div className="pin-area">
            <div className="pin-title">
              <div>
                <p className="eyebrow">{t('enterPin')}</p>
                <h2>
                  {selectedStaff
                    ? lang === 'ta' && selectedStaff.name_ta
                      ? selectedStaff.name_ta
                      : selectedStaff.name
                    : t('chooseRole')}
                </h2>
              </div>
              <span>{t('pinHint')}</span>
            </div>

            <div className="pin-dots" aria-label={`${pin.length} digits entered`}>
              {Array.from({ length: 6 }, (_, i) => (
                <i key={i} className={i < pin.length ? 'filled' : ''} />
              ))}
            </div>

            <div className="keypad">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <button
                  type="button"
                  key={n}
                  onClick={() => pin.length < 8 && setPin(pin + String(n))}
                >
                  {n}
                </button>
              ))}
              <button type="button" className="key-action" onClick={() => setPin('')}>
                {t('clear')}
              </button>
              <button type="button" onClick={() => pin.length < 8 && setPin(pin + '0')}>
                0
              </button>
              <button
                type="button"
                className="key-action"
                aria-label={t('delete')}
                onClick={() => setPin(pin.slice(0, -1))}
              >
                ⌫
              </button>
            </div>

            {error && (
              <div className="error-box" role="alert">
                <Icon name="warning" size={20} />
                <span>{error}</span>
              </div>
            )}

            <button
              type="button"
              className="primary-action"
              disabled={!selectedStaff || pin.length < 4 || loading}
              onClick={submitPinLogin}
            >
              <Icon name="check" size={24} />
              <span>{loading ? '...' : t('signIn')}</span>
            </button>
          </div>
        </section>
      )}

      <footer className="login-footer">
        <span>{lang === 'ta' ? 'பாதுகாப்பான ஆஃப்லைன் பில்லிங்' : 'Offline Wholesale Water Billing'}</span>
        <span className="status-dot">{lang === 'ta' ? 'கடை சர்வர்' : 'Shop server'}</span>
      </footer>
    </main>
  );
}
