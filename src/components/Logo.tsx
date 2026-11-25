import { useApp } from '../context/AppContext';
import { Icon } from './Icon';

export function Logo({ compact = false, shopName }: { compact?: boolean; shopName?: string }) {
  const { lang } = useApp();
  const title = shopName || (lang === 'ta' ? 'மொத்த தண்ணீர் பில்லிங்' : 'Wholesale Water Billing');
  const subtitle = lang === 'ta' ? 'கடை பில்லிங் & சரக்கு' : 'Shop Billing & Stock';

  return (
    <div className={`logo ${compact ? 'compact' : ''}`}>
      <span className="logo-mark">
        <Icon name="bottle" size={compact ? 20 : 26} />
      </span>
      <div>
        <strong>{title}</strong>
        {!compact && <small>{subtitle}</small>}
      </div>
    </div>
  );
}
