import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import type { IconName, Role, Screen, Product } from '../types';
import { Icon } from '../components/Icon';
import { formatMoney } from '../utils/formatters';

export function Home({
  setScreen,
  token,
  role = 'employee',
}: {
  setScreen: (s: Screen) => void;
  token: string;
  role?: Role;
}) {
  const { lang } = useApp();
  const [summary, setSummary] = useState({
    cash: null as number | null,
    sales: null as number | null,
    date: '',
    profit: null as number | null,
  });
  const [lowStockProducts, setLowStockProducts] = useState<Product[]>([]);
  const [loadingStock, setLoadingStock] = useState(true);
  const [stockError, setStockError] = useState(false);

  const isManagerOrOwner = role === 'owner' || role === 'manager';
  const isTa = lang === 'ta';

  useEffect(() => {
    api
      .get<{
        date?: string;
        cash?: number;
        cash_inflow?: number;
        collections?: number;
        total_collections_today?: number;
        sales?: number;
        total_sales?: number;
        profit?: number | null;
        gross_profit_today?: number | null;
      }>('/dashboard/today', token)
      .then((data) =>
        setSummary({
          date: data.date || '',
          cash: Number(data.total_collections_today ?? data.collections ?? data.cash_inflow ?? data.cash ?? 0),
          sales: Number(data.total_sales ?? data.sales ?? 0),
          profit:
            isManagerOrOwner && data.profit !== undefined && data.profit !== null
              ? Number(data.profit)
              : null,
        }),
      )
      .catch(() => setSummary({ cash: null, sales: null, profit: null, date: '' }));

    setLoadingStock(true);
    api
      .get<{ products?: Partial<Product>[] } | Partial<Product>[]>('/products/list', token)
      .then((result) => {
        const rows = Array.isArray(result) ? result : (result.products ?? []);
        const allItems = rows.filter(
          (row): row is Product => Boolean(row.type_id && typeof row.stock === 'number'),
        );
        const attentionItems = allItems
          .filter(
            (p) => p.stock === 0 || ((p.low_stock_limit ?? 0) > 0 && p.stock <= p.low_stock_limit!),
          )
          .sort((a, b) => {
            const stockA = a.stock ?? 0;
            const stockB = b.stock ?? 0;
            if (stockA === 0 && stockB !== 0) return -1;
            if (stockB === 0 && stockA !== 0) return 1;
            return stockA - stockB;
          });

        setLowStockProducts(attentionItems.slice(0, 6));
        setStockError(false);
      })
      .catch(() => {
        setLowStockProducts([]);
        setStockError(true);
      })
      .finally(() => {
        setLoadingStock(false);
      });
  }, [token, isManagerOrOwner]);

  const openStockForProduct = (typeId?: string) => {
    if (typeId) {
      try {
        sessionStorage.setItem('wb_selected_stock_type_id', typeId);
      } catch {
        // ignore
      }
    }
    setScreen('stock');
  };

  const actions = [
    {
      screen: 'sale' as Screen,
      icon: 'sale' as IconName,
      titleEn: 'Invoice',
      titleTa: 'புதிய இன்வாய்ஸ்',
      subEn: 'Start billing',
      subTa: 'விற்பனை செய்ய',
      tone: 'blue',
    },
    {
      screen: 'stock' as Screen,
      icon: 'stock' as IconName,
      titleEn: 'Stock',
      titleTa: 'சரக்கு இருப்பு',
      subEn: 'Inventory & adjustments',
      subTa: 'கையிருப்பு & திருத்தம்',
      tone: 'green',
    },
    {
      screen: 'payments' as Screen,
      icon: 'wallet' as IconName,
      titleEn: 'Pay / Return',
      titleTa: 'வசூல் & கேன் வரவு',
      subEn: 'Collect debt & empty cans',
      subTa: 'கடன் வசூல் & காலி கேன் வரவு',
      tone: 'yellow',
    },
    {
      screen: 'reports' as Screen,
      icon: 'chart' as IconName,
      titleEn: 'Reports',
      titleTa: 'அறிக்கைகள்',
      subEn: isManagerOrOwner ? 'Sales analytics & ledger' : 'Invoice history & records',
      subTa: isManagerOrOwner ? 'விற்பனை & லாப அறிக்கை' : 'இன்வாய்ஸ் வரலாறு & கணக்கு',
      tone: 'purple',
    },
  ];

  return (
    <div className="home-page inside-scroll">
      <section className="welcome-row" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{isTa ? 'வணக்கம் • இன்று' : 'Welcome • Today'}</p>
          <h1 style={{ margin: 0 }}>{isTa ? 'என்ன செய்ய வேண்டும்?' : 'What do you want to do?'}</h1>
        </div>
      </section>

      <div className="home-dashboard-layout">
        <div className="home-left-column">
          <div className="home-launcher-grid">
            {actions.map((act) => (
              <button
                key={act.screen}
                type="button"
                className={`home-launcher-tile ${act.tone}`}
                onClick={() => setScreen(act.screen)}
              >
                <div className="tile-icon-bubble">
                  <Icon name={act.icon} size={36} />
                </div>
                <div className="tile-text">
                  <strong>{isTa ? act.titleTa : act.titleEn}</strong>
                  <small>{isTa ? act.subTa : act.subEn}</small>
                </div>
                <span className="tile-arrow">→</span>
              </button>
            ))}
          </div>

          <div className="home-today-analysis-card">
            <div className="today-analysis-header">
              <div>
                <p className="eyebrow" style={{ margin: 0, fontSize: 11, color: '#64748b' }}>
                  {isTa ? 'இன்றைய கடை நிலவரம்' : 'Daily Activity'}
                </p>
                <h3 style={{ margin: '2px 0 0 0', fontSize: 15, fontWeight: 800, color: '#0f172a' }}>
                  {isTa ? 'இன்றைய ஆய்வு' : "Today's Analysis"}
                </h3>
              </div>
              <span className="today-date-badge">
                {(summary.date ? new Date(`${summary.date}T12:00:00`) : new Date()).toLocaleDateString(
                  isTa ? 'ta-LK' : 'en-GB',
                  {
                    timeZone: 'Asia/Colombo',
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  },
                )}
              </span>
            </div>

            {summary.sales === null && (
              <small>{isTa ? 'தரவு கிடைக்கவில்லை' : 'Daily totals unavailable'}</small>
            )}
            <div className="today-metrics-strip">
              <div className="today-metric-cell">
                <span className="metric-label">{isTa ? 'இன்றைய விற்பனை' : "Today's Sales"}</span>
                <b className="metric-value dark tabular-nums">
                  {summary.sales === null ? '—' : formatMoney(summary.sales)}
                </b>
              </div>

              <div className="today-metric-cell">
                <span className="metric-label">{isTa ? 'இன்றைய வசூல்' : "Today's Collections"}</span>
                <b className="metric-value green tabular-nums">
                  {summary.cash === null ? '—' : formatMoney(summary.cash)}
                </b>
              </div>

              {isManagerOrOwner && (
                <div className="today-metric-cell">
                  <span className="metric-label">
                    {isTa ? 'இன்றைய மொத்த லாபம்' : "Today's Gross Profit"}
                  </span>
                  <b
                    className="metric-value purple tabular-nums"
                    style={
                      summary.profit !== null && summary.profit < 0
                        ? { color: '#dc2626' }
                        : undefined
                    }
                  >
                    {summary.profit !== null ? formatMoney(summary.profit) : '—'}
                  </b>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="home-sidebar-column">
          <div className="home-attention-card">
            <div className="home-attention-header">
              <div>
                <p className="eyebrow" style={{ color: '#d97706', margin: 0, fontSize: 11 }}>
                  {isTa ? 'கவனம் தேவை' : 'Needs Attention Today'}
                </p>
                <h3 style={{ margin: '2px 0 0 0', fontSize: 16 }}>
                  {isTa ? 'குறைந்த கையிருப்பு' : 'Low Stock & Alerts'}
                </h3>
              </div>
              <button
                type="button"
                className="link-button"
                onClick={() => openStockForProduct()}
                style={{ fontSize: 12, fontWeight: 700 }}
              >
                {isTa ? 'அனைத்தும் காண்க' : 'View in Stock'} →
              </button>
            </div>

            {stockError ? (
              <p role="alert">
                {isTa ? 'சரக்கு விவரம் கிடைக்கவில்லை' : 'Could not load inventory alerts'}
              </p>
            ) : loadingStock ? (
              <div style={{ padding: '30px 20px', textAlign: 'center', color: '#64748b' }}>
                <small>
                  {isTa ? 'கையிருப்பு விவரம் சோதிக்கப்படுகிறது...' : 'Checking inventory levels...'}
                </small>
              </div>
            ) : lowStockProducts.length > 0 ? (
              <div className="home-attention-list inside-scroll">
                {lowStockProducts.map((p) => {
                  const isOut = (p.stock ?? 0) === 0;
                  return (
                    <div
                      key={String(p.type_id || p.id)}
                      className={`attention-item-row ${isOut ? 'out-of-stock' : 'low-stock'}`}
                    >
                      <div className="attention-item-info">
                        <span className={`attention-icon ${isOut ? 'red' : 'amber'}`}>
                          <Icon name={p.icon || 'bottle'} size={16} />
                        </span>
                        <div className="attention-item-titles">
                          <b title={isTa && p.ta ? p.ta : p.name}>{isTa && p.ta ? p.ta : p.name}</b>
                          <small>{p.unit}</small>
                        </div>
                      </div>

                      <div className="attention-item-actions">
                        <span className={`stock-badge ${isOut ? 'badge-red' : 'badge-amber'}`}>
                          {isOut
                            ? isTa
                              ? 'தீர்ந்தது (0)'
                              : 'OUT (0)'
                            : `${p.stock} ${isTa ? 'மீதம்' : 'left'}`}
                        </span>

                        <button
                          type="button"
                          className="btn-restock"
                          onClick={() => openStockForProduct(p.type_id)}
                        >
                          {isTa ? 'வரவு' : 'Restock'} →
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="attention-empty-state">
                <div style={{ fontSize: 14, fontWeight: 800 }}>
                  ✓ {isTa ? 'கவனம் தேவைப்படும் எதுவும் இல்லை' : 'Nothing needs attention'}
                </div>
                <small style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                  {isTa
                    ? 'அனைத்து பொருட்களும் போதிய கையிருப்பில் உள்ளன.'
                    : 'All inventory levels are healthy.'}
                </small>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
