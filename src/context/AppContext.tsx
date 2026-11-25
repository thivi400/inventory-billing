import React, { createContext, useCallback, useContext, useState } from 'react';
import en from '../locales/en.json';
import ta from '../locales/ta.json';
import { playClickChime } from '../lib/sound';

export type Lang = 'en' | 'ta';

interface ToastItem {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface AppContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string) => string;
  voice: boolean;
  setVoice: (enabled: boolean) => void;
  speak: (enText: string, taText?: string) => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const AppContext = createContext<AppContextValue | null>(null);

const enDict = en as Record<string, string>;
const taDict = ta as Record<string, string>;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const saved = sessionStorage.getItem('wb_lang');
      return saved === 'ta' ? 'ta' : 'en';
    } catch {
      return 'en';
    }
  });

  const [voice, setVoiceState] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('wb_voice') === '1';
    } catch {
      return false;
    }
  });

  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      sessionStorage.setItem('wb_lang', next);
    } catch {
      // ignore
    }
  }, []);

  const setVoice = useCallback((enabled: boolean) => {
    setVoiceState(enabled);
    try {
      sessionStorage.setItem('wb_voice', enabled ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  const t = useCallback(
    (key: string): string => {
      if (lang === 'ta') return taDict[key] ?? enDict[key] ?? key;
      return enDict[key] ?? key;
    },
    [lang],
  );

  const speak = useCallback(
    (enText: string, taText?: string) => {
      if (!voice) return;
      playClickChime();
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(lang === 'ta' && taText ? taText : enText);
        utter.lang = lang === 'ta' ? 'ta-IN' : 'en-IN';
        utter.rate = 1;
        window.speechSynthesis.speak(utter);
      } catch {
        // Speech synthesis unavailable in browser
      }
    },
    [voice, lang],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: 'success' | 'error' | 'info' = 'info') => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { id, message, type }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, 5000);
    },
    [],
  );

  return (
    <AppContext.Provider value={{ lang, setLang, t, voice, setVoice, speak, showToast }}>
      {children}
      {toasts.length > 0 && (
        <div className="floating-toast-container" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`floating-toast ${toast.type}`} role="status">
              <span className="toast-icon">
                {toast.type === 'success' ? '✓' : toast.type === 'error' ? '!' : 'i'}
              </span>
              <span className="toast-message">{toast.message}</span>
              <button
                type="button"
                className="toast-close-btn"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(toast.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
