import type { IconName } from '../types';
import { Icon } from './Icon';

export function Metric({
  icon,
  label,
  value,
  tone = 'blue',
  negative = false,
}: {
  icon: IconName;
  label: string;
  value: string;
  tone?: 'blue' | 'green' | 'red' | 'purple';
  negative?: boolean;
}) {
  return (
    <div className={`metric-card ${tone}`}>
      <span className="metric-icon">
        <Icon name={icon} size={22} />
      </span>
      <div>
        <small>{label}</small>
        <strong className="tabular-nums" style={negative ? { color: '#dc2626' } : undefined}>
          {value}
        </strong>
      </div>
    </div>
  );
}
