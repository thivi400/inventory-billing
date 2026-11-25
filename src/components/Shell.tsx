import React from 'react';
import { useApp } from '../context/AppContext';
import type { IconName, Role, Screen } from '../types';
import { Icon } from './Icon';
import { LanguageButton } from './LanguageButton';
import { Logo } from './Logo';

export function Shell({
  screen,
  setScreen,
  role,
  name,
  shopName,
  trialMode,
  onLock,
  onLogout,
  goHome,
  children,
}: {
  screen: Screen;
  setScreen: (s: Screen) => void;
  role: Role;
  name: string;
  shopName?: string;
  trialMode?: boolean;
  onLock: () => void;
  onLogout: () => void;
  goHome: () => void;
  children: React.ReactNode;
}) {
  const { t, lang, voice, setVoice } = useApp();

  const navItems: Array<{ id: Screen; icon: IconName; label: string; ownerOnly?: boolean }> = [
    { id: 'home', icon: 'home', label: t('home') },
    { id: 'sale', icon: 'sale', label: lang === 'ta' ? 'இன்வாய்ஸ்' : 'Invoice' },
    { id: 'stock', icon: 'stock', label: t('stock') },
    { id: 'payments', icon: 'wallet', label: t('payReturn') },
    { id: 'customers', icon: 'users', label: t('customers') },
    { id: 'reports', icon: 'chart', label: t('reports') },
    { id: 'staff', icon: 'shield', label: t('staff'), ownerOnly: true },
    { id: 'shop', icon: 'store', label: t('shopDetails'), ownerOnly: true },
    { id: 'audit', icon: 'receipt', label: t('auditLog'), ownerOnly: true },
  ];

  const visibleNav = navItems.filter((item) => !item.ownerOnly || role === 'owner');

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-left">
          <button type="button" className="brand-button" onClick={goHome} title={t('home')}>
            <Logo compact shopName={shopName} />
          </button>

          <nav className="header-nav-tabs" aria-label="Main navigation">
            {visibleNav.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-tab-pill ${screen === item.id ? 'active' : ''}`}
                onClick={() => setScreen(item.id)}
              >
                <Icon name={item.icon} size={15} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="header-tools">
          {trialMode && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                padding: '4px 8px',
                borderRadius: 6,
                background: '#fffbeb',
                color: '#92400e',
                border: '1px solid #fde68a',
                whiteSpace: 'nowrap',
              }}
            >
              {lang === 'ta' ? 'சோதனை தரவு' : 'Trial Data'}
            </span>
          )}

          <LanguageButton />

          <button
            type="button"
            className={`utility-btn ${voice ? 'active' : ''}`}
            onClick={() => setVoice(!voice)}
            title={voice ? 'Mute voice' : 'Enable voice'}
          >
            <Icon name="speaker" size={16} />
            <b>{voice ? t('on') : t('off')}</b>
          </button>

          <button
            type="button"
            className="utility-btn"
            onClick={onLock}
            title={t('lockScreen')}
          >
            <Icon name="lock" size={15} />
            <b>{lang === 'ta' ? 'பூட்டு' : 'Lock'}</b>
          </button>

          <div className="session-info">
            <span className={`role-dot ${role}`} />
            <div>
              <small>{t(role)}</small>
              <b>{name}</b>
            </div>
          </div>

          <button type="button" className="signout-button" onClick={onLogout} title={t('signOut')}>
            <Icon name="logout" size={15} />
            <b>{t('signOut')}</b>
          </button>
        </div>
      </header>

      <main className="page-content">{children}</main>
    </div>
  );
}
