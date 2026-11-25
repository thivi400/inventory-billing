import { toInvoice } from '../utils/receipt';
import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import type { CreatedInvoice, Role } from '../types';
import { Icon } from '../components/Icon';
import { Metric } from '../components/Metric';
import { PrintInvoiceModal } from '../components/modals/PrintInvoiceModal';
import { formatMoney } from '../utils/formatters';

export function Reports({
  role,
  token,
}: {
  role: Role;
  token: string;
  onGoHome?: () => void;
}) {
  const { t, lang, speak, showToast } = useApp();
  const shopDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
  const [period, setPeriod] = useState<'today' | 'this_week' | 'this_month' | 'custom'>('this_month');
  const [fromDate, setFromDate] = useState(() => `${shopDate(new Date()).slice(0, 7)}-01`);
  const [toDate, setToDate] = useState(() => shopDate(new Date()));

  const [report, setReport] = useState({
    sales: 0,
    collections: 0,
    cashCollections: 0,
    bankCollections: 0,
    cost: 0,
    profit: 0,
    bills: 0,
    returnsCount: 0,
    returnsAmount: 0,
  });
  const [loadingSummary, setLoadingSummary] = useState(false);

  const [invoices, setInvoices] = useState<any[]>([]);
  const [invoicesError, setInvoicesError] = useState(false);
  const invoicesRequest = useRef(0);
  const summaryRequest = useRef(0);
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'yesterday'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'credit'>('all');
  const [activeInvoice, setActiveInvoice] = useState<CreatedInvoice | null>(null);

  const isManagerOrOwner = role === 'owner' || role === 'manager';

  useEffect(() => {
    speak('Reports and invoices ledger loaded', 'அறிக்கைகள் மற்றும் இன்வாய்ஸ்கள் ஏற்றப்பட்டது');
  }, []);

  const [summaryError, setSummaryError] = useState(false);
  const loadSummaryData = () => {
    if (!isManagerOrOwner) return;
    const request = ++summaryRequest.current;
    setLoadingSummary(true);
    setSummaryError(false);

    const params = new URLSearchParams();
    params.set('period', period);
    if (period === 'custom') {
      params.set('from_date', fromDate);
      params.set('to_date', toDate);
    }

    api
      .get<any>(`/reports/summary?${params.toString()}`, token)
      .then((data) => {
        if (request !== summaryRequest.current) return;
        setReport({
          sales: Number(data.net_sales ?? data.sales ?? 0),
          collections: Number(data.collections ?? 0),
          cashCollections: Number(data.cash_collections ?? 0),
          bankCollections: Number(data.bank_collections ?? 0),
          cost: Number(data.historical_cost ?? data.cost ?? 0),
          profit: Number(data.profit ?? data.gross_profit ?? 0),
          bills: Number(data.bill_count ?? data.bills ?? 0),
          returnsCount: Number(data.returns_count ?? 0),
          returnsAmount: Number(data.returns_amount ?? 0),
        });
      })
      .catch(() => {
        if (request === summaryRequest.current) setSummaryError(true);
      })
      .finally(() => {
        if (request === summaryRequest.current) setLoadingSummary(false);
      });
  };

  const loadInvoices = (searchQuery = search) => {
    const params = new URLSearchParams();
    const request = ++invoicesRequest.current;
    setInvoicesError(false);
    params.set('limit', '200');
    params.set('date_filter', dateFilter);
    if (searchQuery.trim()) {
      params.set('q', searchQuery.trim());
    }

    api
      .get<any[]>(`/invoices/list?${params.toString()}`, token)
      .then((rows) => {
        if (request === invoicesRequest.current && Array.isArray(rows)) {
          setInvoices(rows);
        }
      })
      .catch(() => {
        if (request === invoicesRequest.current) setInvoicesError(true);
      });
  };

  useEffect(() => {
    loadSummaryData();
  }, [token, period, fromDate, toDate]);

  useEffect(() => {
    const timer = setTimeout(() => loadInvoices(search), 250);
    return () => clearTimeout(timer);
  }, [search, token, dateFilter]);

  const openInvoiceA4 = async (invoiceNumber: string) => {
    try {
      const details = await api.get<any>(
        `/invoices/details/${encodeURIComponent(invoiceNumber)}`,
        token,
      );
      setActiveInvoice(toInvoice(details));
    } catch (err: any) {
      showToast(
        lang === 'ta'
          ? `இன்வாய்ஸ் ${invoiceNumber} விவரங்களை ஏற்ற முடியவில்லை`
          : `Could not load invoice ${invoiceNumber}: ${err.message || 'Error'}`,
        'error',
      );
    }
  };

  const todayStr = shopDate(new Date());
  const yesterdayStr = shopDate(new Date(Date.now() - 86400000));
  const filteredInvoices = invoices.filter((inv) => {
    if (statusFilter === 'all') return true;
    if (inv.status === 'cancelled') return false;
    return statusFilter === 'completed' ? inv.due <= 0 : inv.due > 0;
  });

  const groupedByDate: Record<string, any[]> = {};
  filteredInvoices.forEach((inv) => {
    const d = inv.date || todayStr;
    if (!groupedByDate[d]) groupedByDate[d] = [];
    groupedByDate[d].push(inv);
  });
  const dateKeys = Object.keys(groupedByDate).sort((a, b) => b.localeCompare(a));

  return (
    <div className="workflow-page reports-page inside-scroll">
      <div
        className="page-title compact"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <p className="eyebrow">{t('reports')}</p>
          <h1>
            {isManagerOrOwner
              ? lang === 'ta'
                ? 'விற்பனை & வசூல் நிதி அறிக்கை'
                : 'Financial Reports & Audit Ledger'
              : lang === 'ta'
                ? 'எனது இன்வாய்ஸ் வரலாறு'
                : 'My Invoice History'}
          </h1>
        </div>
      </div>

      {isManagerOrOwner ? (
        <section className="report-period-selector" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {(
              [
                ['today', 'Today', 'இன்று'],
                ['this_week', 'This Week', 'இந்த வாரம்'],
                ['this_month', 'This Month', 'இந்த மாதம்'],
                ['custom', 'Custom Range', 'தேதி தேர்வு'],
              ] as const
            ).map(([key, enLabel, taLabel]) => (
              <button
                key={key}
                type="button"
                className={`period-btn ${period === key ? 'active' : ''}`}
                onClick={() => setPeriod(key)}
                style={{
                  padding: '8px 14px',
                  borderRadius: 8,
                  border: 'none',
                  fontWeight: 700,
                  background: period === key ? '#0284c7' : '#e2e8f0',
                  color: period === key ? '#fff' : '#334155',
                }}
              >
                {lang === 'ta' ? taLabel : enLabel}
              </button>
            ))}

            {period === 'custom' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 8 }}>
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff' }}
                />
                <span>to</span>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff' }}
                />
              </div>
            )}
          </div>
        </section>
      ) : (
        <div
          style={{
            padding: 12,
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            marginBottom: 16,
            color: '#64748b',
            fontSize: 13,
          }}
        >
          <b>{lang === 'ta' ? 'பணியாளர் பார்வை:' : 'Staff View:'}</b>{' '}
          {lang === 'ta'
            ? 'நீங்கள் உருவாக்கிய பில்கள் மட்டும் காணப்படும். அடக்க விலை மற்றும் லாப விவரங்கள் மேலாளருக்கு மட்டும்.'
            : 'Showing only invoices you created. Shop costs, totals, and profit figures are restricted to Managers and Owners.'}
        </div>
      )}

      {summaryError && (
        <p role="alert">{lang === 'ta' ? 'அறிக்கை ஏற்றப்படவில்லை' : 'Report unavailable.'}</p>
      )}

      {isManagerOrOwner && (
        <section className="report-grid">
          <Metric
            icon="sale"
            label={lang === 'ta' ? 'நிகர விற்பனை (Net Sales)' : 'Net Sales'}
            value={summaryError ? '—' : loadingSummary ? '...' : formatMoney(report.sales)}
            tone="blue"
          />
          <Metric
            icon="cash"
            label={lang === 'ta' ? 'ரொக்க வசூல் (Cash)' : 'Cash Collections'}
            value={summaryError ? '—' : loadingSummary ? '...' : formatMoney(report.cashCollections)}
            tone="green"
          />
          <Metric
            icon="wallet"
            label={lang === 'ta' ? 'வங்கி வசூல் (Bank Transfer)' : 'Bank Collections'}
            value={summaryError ? '—' : loadingSummary ? '...' : formatMoney(report.bankCollections)}
            tone="green"
          />
          <Metric
            icon="stock"
            label={lang === 'ta' ? 'வரலாற்று சரக்கு செலவு' : 'Historical Stock Cost'}
            value={summaryError ? '—' : loadingSummary ? '...' : formatMoney(report.cost)}
            tone="purple"
          />
          <Metric
            icon="chart"
            label={lang === 'ta' ? 'மொத்த லாபம் (Signed Gross Profit)' : 'Gross Profit (Signed)'}
            value={summaryError ? '—' : loadingSummary ? '...' : formatMoney(report.profit)}
            tone={report.profit < 0 ? 'red' : 'green'}
            negative={report.profit < 0}
          />
          <Metric
            icon="return"
            label={lang === 'ta' ? 'பில்கள் & திருப்புதல்' : 'Invoices & Returns'}
            value={
              summaryError
                ? '—'
                : loadingSummary
                  ? '...'
                  : `${report.bills} (${report.returnsCount} ret / ${formatMoney(report.returnsAmount)})`
            }
            tone="purple"
          />
        </section>
      )}

      <section
        className="ledger-filter-section"
        style={{ marginTop: 20, background: '#fff', padding: '14px 18px', borderRadius: 12, border: '1px solid #e2e8f0' }}
      >
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="customer-search-box" style={{ flex: 1, minWidth: 260, margin: 0 }}>
            <Icon name="search" size={18} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                lang === 'ta'
                  ? 'வாடிக்கையாளர் பெயர் அல்லது இன்வாய்ஸ் எண் தேடுக...'
                  : 'Search by customer name or invoice number...'
              }
            />
            {search && (
              <button type="button" className="clear-search-btn" onClick={() => setSearch('')}>
                ✕
              </button>
            )}
          </div>

          <div className="format-pills" style={{ display: 'flex', gap: 6 }}>
            <button type="button" className={dateFilter === 'all' ? 'active' : ''} onClick={() => setDateFilter('all')}>
              {lang === 'ta' ? 'அனைத்து நாட்கள்' : 'All Dates'}
            </button>
            <button type="button" className={dateFilter === 'today' ? 'active' : ''} onClick={() => setDateFilter('today')}>
              {lang === 'ta' ? 'இன்று' : 'Today'}
            </button>
            <button type="button" className={dateFilter === 'yesterday' ? 'active' : ''} onClick={() => setDateFilter('yesterday')}>
              {lang === 'ta' ? 'நேற்று' : 'Yesterday'}
            </button>
          </div>

          <div className="format-pills" style={{ display: 'flex', gap: 6 }}>
            <button type="button" className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}>
              {lang === 'ta' ? 'அனைத்தும்' : 'All Status'}
            </button>
            <button type="button" className={statusFilter === 'completed' ? 'active' : ''} onClick={() => setStatusFilter('completed')}>
              {lang === 'ta' ? 'செலுத்தப்பட்டது' : 'Paid'}
            </button>
            <button type="button" className={statusFilter === 'credit' ? 'active' : ''} onClick={() => setStatusFilter('credit')}>
              {lang === 'ta' ? 'கடன் பாக்கி' : 'Due / Credit'}
            </button>
          </div>
        </div>
      </section>

      <section className="day-by-day-ledger" style={{ marginTop: 20 }}>
        {invoicesError ? (
          <p role="alert">{lang === 'ta' ? 'பில் வரலாறு கிடைக்கவில்லை' : 'Could not load invoice history.'}</p>
        ) : dateKeys.length > 0 ? (
          dateKeys.map((dateKey) => {
            const dayInvoices = groupedByDate[dateKey] || [];
            const dayTotal = dayInvoices.reduce(
              (s, inv) => s + (inv.status === 'cancelled' ? 0 : Number(inv.total) || 0),
              0,
            );
            const isToday = dateKey === todayStr;
            const isYesterday = dateKey === yesterdayStr;

            return (
              <div
                key={dateKey}
                className="day-group-card"
                style={{ marginBottom: 20, background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0', overflow: 'hidden' }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '12px 18px',
                    background: '#f8fafc',
                    borderBottom: '1px solid #e2e8f0',
                  }}
                >
                  <div>
                    <b style={{ fontSize: 16 }}>
                      {isToday
                        ? lang === 'ta'
                          ? 'இன்று (Today)'
                          : 'Today'
                        : isYesterday
                          ? lang === 'ta'
                            ? 'நேற்று (Yesterday)'
                            : 'Yesterday'
                          : dateKey}
                    </b>
                    <span style={{ color: '#64748b', marginLeft: 8, fontSize: 13 }}>
                      ({dayInvoices.length} {lang === 'ta' ? 'பில்கள்' : 'invoices'})
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <small style={{ color: '#64748b', display: 'block' }}>
                      {lang === 'ta' ? 'காட்டும் பில்களின் மொத்தம்:' : 'Shown Invoice Total:'}
                    </small>
                    <b className="tabular-nums" style={{ fontSize: 17, color: '#0284c7' }}>
                      {formatMoney(dayTotal)}
                    </b>
                  </div>
                </div>

                <div className="day-invoices-list" style={{ padding: '8px 12px' }}>
                  {dayInvoices.map((inv) => (
                    <button
                      key={inv.id || inv.invoice_number}
                      type="button"
                      className="statement-row-btn"
                      onClick={() => openInvoiceA4(inv.invoice_number)}
                      style={{ marginBottom: 6 }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Icon name="receipt" size={18} />
                        <div>
                          <b style={{ color: '#2563eb', fontSize: 14 }}>{inv.invoice_number}</b>
                          <span style={{ marginLeft: 8, fontWeight: 600, color: '#1e293b' }}>
                            {inv.customer_name}
                          </span>
                          <small style={{ display: 'block', color: '#64748b' }}>
                            Staff: {inv.made_by || 'Staff'}
                          </small>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <div style={{ textAlign: 'right' }}>
                          <b className="tabular-nums" style={{ fontSize: 15 }}>
                            {formatMoney(Number(inv.total))}
                          </b>
                          <div style={{ fontSize: 12 }}>
                            {inv.status === 'cancelled' ? (
                              <span style={{ color: '#dc2626', fontWeight: 800 }}>
                                {lang === 'ta' ? 'ரத்து (CANCELED)' : 'CANCELED'}
                              </span>
                            ) : inv.due > 0 ? (
                              <span style={{ color: '#b45309', fontWeight: 700 }}>
                                Due: {formatMoney(Number(inv.due))}
                              </span>
                            ) : (
                              <span style={{ color: '#16a34a', fontWeight: 700 }}>Paid</span>
                            )}
                          </div>
                        </div>
                        <span className="view-a4-pill">{lang === 'ta' ? 'A4 பில்' : 'View A4'} →</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })
        ) : (
          <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8', background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0' }}>
            <p>{lang === 'ta' ? 'பொருத்தமான இன்வாய்ஸ்கள் எதுவும் இல்லை' : 'No invoices found for the selected filter.'}</p>
          </div>
        )}
      </section>

      {activeInvoice && (
        <PrintInvoiceModal
          invoice={activeInvoice}
          initialFormat="a4"
          onClose={() => setActiveInvoice(null)}
          onRetry={() => openInvoiceA4(activeInvoice.invoice_number)}
        />
      )}
    </div>
  );
}
