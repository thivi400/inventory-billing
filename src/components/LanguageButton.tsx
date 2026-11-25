import { useApp } from '../context/AppContext';

export function LanguageButton() {
  const { lang, setLang } = useApp();

  return (
    <button
      type="button"
      className={`utility-btn ${lang === 'ta' ? 'active' : ''}`}
      onClick={() => setLang(lang === 'en' ? 'ta' : 'en')}
      title={lang === 'en' ? 'Switch to Tamil' : 'Switch to English'}
    >
      <b>{lang === 'en' ? 'தமிழ்' : 'EN'}</b>
    </button>
  );
}
