import { useCallback, useEffect, useRef, useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { api, ApiError } from './services/api';
import { hydratePendingOperations, resetPendingCacheOnLogout } from './services/operations';
import type { Role, Screen, ShopDetailsConfig } from './types';
import { Shell } from './components/Shell';
import { Icon } from './components/Icon';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { Sale } from './pages/Sale';
import { Stock } from './pages/Stock';
import { Payments } from './pages/Payments';
import { Customers } from './pages/Customers';
import { Reports } from './pages/Reports';
import { AuditLogPage, ShopDetailsPage, StaffPage } from './pages/AdminPages';

const INACTIVITY_LOCK_MS = 10 * 60 * 1000; // 10 minutes

interface SessionState {
  token: string;
  id: string;
  role: Role;
  name: string;
  trialMode?: boolean;
}

function PinLockOverlay({
  session,
  onUnlocked,
  onSignOut,
  onSessionRevoked,
}: {
  session: SessionState;
  onUnlocked: () => void;
  onSignOut: () => void;
  onSessionRevoked: (locked: boolean) => void;
}) {
  const { t, lang } = useApp();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const verify = async () => {
    if (pin.length < 4 || checking) return;
    setChecking(true);
    setError('');
    try {
      await api.verifyPin(pin, session.token);
      setPin('');
      onUnlocked();
    } catch (err) {
      setPin('');
      if (
        err instanceof ApiError &&
        (err.status === 423 ||
          err.code === 'account_locked' ||
          err.code === 'session_revoked' ||
          err.code === 'session_expired')
      ) {
        onSessionRevoked(err.status === 423 || err.code === 'account_locked');
        return;
      }
      setError(
        lang === 'ta'
          ? 'தவறான PIN. மீண்டும் முயற்சிக்கவும்.'
          : 'Invalid credentials. Try again or sign out.',
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="pin-lock-overlay" role="dialog" aria-modal="true" aria-label="Screen locked">
      <div className="pin-lock-card">
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <span
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              background: '#e9f0ff',
              color: '#2864dc',
              display: 'inline-grid',
              placeItems: 'center',
              marginBottom: 8,
            }}
          >
            <Icon name="lock" size={24} />
          </span>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 900 }}>
            {lang === 'ta' ? 'திரை பூட்டப்பட்டுள்ளது' : 'Screen Locked'}
          </h2>
          <p style={{ margin: '4px 0 0 0', fontSize: 13, color: '#64748b', fontWeight: 700 }}>
            {session.name} ({t(session.role)})
          </p>
          <small style={{ color: '#64748b' }}>
            {lang === 'ta'
              ? 'உங்கள் வரைவுகள் பாதுகாப்பாக உள்ளன. தொடர PIN உள்ளிடவும்.'
              : 'Your current draft is preserved. Enter your PIN to unlock.'}
          </small>
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
            onClick={() => setPin(pin.slice(0, -1))}
          >
            ⌫
          </button>
        </div>

        {error && (
          <div className="error-box" role="alert">
            <Icon name="warning" size={18} />
            <span>{error}</span>
          </div>
        )}

        <button
          type="button"
          className="primary-action"
          disabled={pin.length < 4 || checking}
          onClick={verify}
        >
          <Icon name="check" size={20} />
          <span>{checking ? '...' : t('unlock')}</span>
        </button>

        <button
          type="button"
          onClick={onSignOut}
          style={{
            width: '100%',
            marginTop: 10,
            padding: '10px',
            borderRadius: 10,
            border: '1px solid #fecaca',
            background: '#fef2f2',
            color: '#dc2626',
            fontWeight: 800,
            fontSize: 13,
          }}
        >
          {t('signOut')}
        </button>
      </div>
    </div>
  );
}

function AuthenticatedApp({
  session,
  logout,
  onSessionRevoked,
}: {
  session: SessionState;
  logout: () => void;
  onSessionRevoked: (locked: boolean) => void;
}) {
  const { lang } = useApp();
  const [screen, setScreenState] = useState<Screen>('home');
  const [locked, setLocked] = useState(false);
  const [shop, setShop] = useState<ShopDetailsConfig | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    hydratePendingOperations(session.id);
    api
      .get<ShopDetailsConfig>('/shop-details', session.token)
      .then((d) => setShop(d))
      .catch(() => {});
  }, [session.id, session.token]);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      setLocked(true);
    }, INACTIVITY_LOCK_MS);
  }, []);

  useEffect(() => {
    resetIdleTimer();
    const events = ['pointerdown', 'keydown', 'touchstart'];
    const onActivity = () => {
      if (!locked) resetIdleTimer();
    };
    events.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    return () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      events.forEach((ev) => window.removeEventListener(ev, onActivity));
    };
  }, [locked, resetIdleTimer]);

  const setScreen = (next: Screen) => {
    if ((next === 'staff' || next === 'shop' || next === 'audit') && session.role !== 'owner') {
      return;
    }
    setScreenState(next);
  };

  const goHome = () => setScreen('home');

  const shopDisplayName =
    lang === 'ta'
      ? shop?.name_ta || shop?.name_en || undefined
      : shop?.name_en || undefined;

  return (
    <>
      <Shell
        screen={screen}
        setScreen={setScreen}
        role={session.role}
        name={session.name}
        shopName={shopDisplayName}
        trialMode={session.trialMode}
        onLock={() => setLocked(true)}
        onLogout={logout}
        goHome={goHome}
      >
        {screen === 'home' ? (
          <Home setScreen={setScreen} token={session.token} role={session.role} />
        ) : screen === 'sale' ? (
          <Sale token={session.token} role={session.role} onGoHome={goHome} />
        ) : screen === 'stock' ? (
          <Stock token={session.token} role={session.role} onGoHome={goHome} />
        ) : screen === 'payments' ? (
          <Payments token={session.token} role={session.role} onGoHome={goHome} />
        ) : screen === 'customers' ? (
          <Customers token={session.token} role={session.role} onGoHome={goHome} />
        ) : screen === 'reports' ? (
          <Reports role={session.role} token={session.token} onGoHome={goHome} />
        ) : screen === 'staff' && session.role === 'owner' ? (
          <StaffPage token={session.token} />
        ) : screen === 'shop' && session.role === 'owner' ? (
          <ShopDetailsPage token={session.token} onShopUpdated={setShop} />
        ) : screen === 'audit' && session.role === 'owner' ? (
          <AuditLogPage token={session.token} />
        ) : (
          <Home setScreen={setScreen} token={session.token} role={session.role} />
        )}
      </Shell>

      {/* Lock overlay renders above Shell WITHOUT unmounting active drafts */}
      {locked && (
        <PinLockOverlay
          session={session}
          onUnlocked={() => {
            setLocked(false);
            resetIdleTimer();
          }}
          onSignOut={logout}
          onSessionRevoked={onSessionRevoked}
        />
      )}
    </>
  );
}

function Root() {
  const { lang, showToast } = useApp();
  // Bearer token stays strictly in React memory (NEVER localStorage/sessionStorage!)
  const [session, setSession] = useState<SessionState | null>(null);

  // Stop mouse scroll from accidentally changing number inputs
  useEffect(() => {
    const handleWheel = () => {
      const active = document.activeElement;
      if (active && (active as HTMLInputElement).type === 'number') {
        (active as HTMLInputElement).blur();
      }
    };
    window.addEventListener('wheel', handleWheel, { passive: true });
    return () => window.removeEventListener('wheel', handleWheel);
  }, []);

  const logout = async () => {
    if (session) await api.signOut(session.token).catch(() => {});
    resetPendingCacheOnLogout();
    setSession(null);
  };

  const handleSessionRevoked = (locked: boolean) => {
    resetPendingCacheOnLogout();
    setSession(null);
    showToast(
      locked
        ? lang === 'ta'
          ? 'கணக்கு தற்காலிகமாக பூட்டப்பட்டுள்ளது. சிறிது நேரம் கழித்து மீண்டும் உள்நுழையவும்.'
          : 'Account temporarily locked. Please try again later.'
        : lang === 'ta'
          ? 'அமர்வு முடிவடைந்தது. மீண்டும் உள்நுழையவும்.'
          : 'Session ended. Please sign in again.',
      'error',
    );
  };

  return session ? (
    <AuthenticatedApp
      session={session}
      logout={logout}
      onSessionRevoked={handleSessionRevoked}
    />
  ) : (
    <Login onLogin={(next) => setSession(next)} />
  );
}

export default function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}
