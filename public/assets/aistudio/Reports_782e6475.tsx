import { toInvoice } from "../utils/receipt";
import { useState, useEffect, useRef } from "react";
import { useApp } from "../context/AppContext";
import { api } from "../services/api";
import type { CreatedInvoice, Role } from "../types";
import { Icon } from "../components/Icon";
import { Metric } from "../components/Metric";
import { PrintInvoiceModal } from "../components/modals/PrintInvoiceModal";
import { formatMoney } from "../utils/formatters";

export function Reports({ role, token, onGoHome }: { role: Role; token: string; onGoHome: () => void }) {
  const { t, lang, speak, showToast } = useApp();
  const shopDate = (d: Date) => d.toLocaleDateString("en-CA", {timeZone: "Asia/Colombo"});
  const [period, setPeriod] = useState<"today" | "this_week" | "this_month" | "custom">("this_month");
  const [fromDate, setFromDate] = useState(() => `${shopDate(new Date()).slice(0, 7)}-01`);
  const [toDate, setToDate] = useState(() => shopDate(new Date()));

  // Authentic 0 initial state - no dummy or mock numbers
  const [report, setReport] = useState({
    sales: 0,
    collections: 0,
    profit: 0,
    expenses: 0,
    bills: 0,
    returnsCount: 0,
    returnsAmount: 0,
  });
  const [loadingSummary, setLoadingSummary] = useState(false);

  const [invoices, setInvoices] = useState<any[]>([]);
  const [invoicesError, setInvoicesError] = useState(false);
  const invoicesRequest = useRef(0);
  const summaryRequest = useRef(0);
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "yesterday">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "completed" | "credit">("all");
  const [activeInvoice, setActiveInvoice] = useState<CreatedInvoice | null>(null);

  const isManagerOrOwner = role === "owner" || role === "manager";

  useEffect(() => {
    speak("Reports and invoices ledger loaded", "அறிக்கைகள் மற்றும் இன்வாய்ஸ்கள் ஏற்றப்பட்டது");
  }, []);

  const [summaryError, setSummaryError] = useState(false);
  const loadSummaryData = () => {
    if (!isManagerOrOwner) return;
    const request = ++summaryRequest.current;
    setLoadingSummary(true);
    setSummaryError(false);

    const params = new URLSearchParams();
    params.set("period", period);
    if (period === "custom") {
      params.set("from_date", fromDate);
      params.set("to_date", toDate);
    }

    api
      .get<any>(`/reports/summary?${params.toString()}`, token)
      .then((data) => {
        if (request !== summaryRequest.current) return;
        setReport({
          sales: Number(data.net_sales ?? data.sales ?? 0),
          collections: Number(data.collections ?? 0),
          profit: Number(data.profit ?? data.gross_profit ?? 0),
          expenses: Number(data.expenses ?? 0),
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
    params.set("limit", "200");
    params.set("date_filter", dateFilter);
    if (searchQuery.trim()) {
      params.set("q", searchQuery.trim());
    }

    api
      .get<any[]>(`/invoices/list?${params.toString()}`, token)
      .then((rows) => {
        if (request === invoicesRequest.current && Array.isArray(rows)) {
          setInvoices(rows);
        }
      })
      .catch(() => { if (request === invoicesRequest.current) setInvoicesError(true); });
  };

  useEffect(() => {
    loadSummaryData();
  }, [token, period, fromDate, toDate]);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadInvoices(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, token, dateFilter]);

  // Open invoice in full A4 view
  const openInvoiceA4 = async (invoiceNumber: string) => {
    try {
      const details = await api.get<any>(`/invoices/details/${encodeURIComponent(invoiceNumber)}`, token);
      setActiveInvoice(toInvoice(details));
    } catch (err: any) {
      showToast(
        lang === "ta"
          ? `இன்வாய்ஸ் ${invoiceNumber} விவரங்களை ஏற்ற முடியவில்லை: ${err.message || "பிழை"}. மீண்டும் முயற்சிக்கவும்.`
          : `Could not load items for invoice ${invoiceNumber}: ${err.message || "Network error"}. Please click to retry.`,
        "error"
      );
    }
  };

  const todayStr = shopDate(new Date());
  const yesterdayStr = shopDate(new Date(Date.now() - 86400000));
  const filteredInvoices = invoices.filter((inv) => {
    if (statusFilter === "all") return true;
    if (inv.status === "cancelled") return false;
    return statusFilter === "completed" ? inv.due <= 0 : inv.due > 0;
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
      <div className="page-title compact" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <p className="eyebrow">{t("reports")}</p>
          <h1>{lang === "ta" ? "விற்பனை & வசூல் நிதி அறிக்கை" : "Financial Reports & Audit Ledger"}</h1>
        </div>
      </div>

      {/* Period Selection Tabs (Manager & Owner) */}
      {isManagerOrOwner ? (
        <section className="report-period-selector" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              className={`period-btn ${period === "today" ? "active" : ""}`}
              onClick={() => setPeriod("today")}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "none",
                fontWeight: 700,
                cursor: "pointer",
                background: period === "today" ? "#0284c7" : "#e2e8f0",
                color: period === "today" ? "#fff" : "#334155",
              }}
            >
              {lang === "ta" ? "இன்று (Today)" : "Today"}
            </button>
            <button
              type="button"
              className={`period-btn ${period === "this_week" ? "active" : ""}`}
              onClick={() => setPeriod("this_week")}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "none",
                fontWeight: 700,
                cursor: "pointer",
                background: period === "this_week" ? "#0284c7" : "#e2e8f0",
                color: period === "this_week" ? "#fff" : "#334155",
              }}
            >
              {lang === "ta" ? "இந்த வாரம் (Mon-Sun)" : "This Week"}
            </button>
            <button
              type="button"
              className={`period-btn ${period === "this_month" ? "active" : ""}`}
              onClick={() => setPeriod("this_month")}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "none",
                fontWeight: 700,
                cursor: "pointer",
                background: period === "this_month" ? "#0284c7" : "#e2e8f0",
                color: period === "this_month" ? "#fff" : "#334155",
              }}
            >
              {lang === "ta" ? "இந்த மாதம் (Month)" : "This Month"}
            </button>
            <button
              type="button"
              className={`period-btn ${period === "custom" ? "active" : ""}`}
              onClick={() => setPeriod("custom")}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "none",
                fontWeight: 700,
                cursor: "pointer",
                background: period === "custom" ? "#0284c7" : "#e2e8f0",
                color: period === "custom" ? "#fff" : "#334155",
              }}
            >
              {lang === "ta" ? "தேதி தேர்வு (Custom)" : "Custom Range"}
            </button>

            {period === "custom" && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: 8 }}>
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
                <span>to</span>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
              </div>
            )}
          </div>
        </section>
      ) : (
        <div style={{ padding: 12, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, marginBottom: 16, color: "#64748b", fontSize: 13 }}>
          🔒 <b>Staff View:</b> Invoices ledger and sales activity are visible. Financial summaries and profit figures are restricted to Managers/Owners.
        </div>
      )}

      {/* Top Metrics Row */}
      {summaryError && <p role="alert">{lang === "ta" ? "அறிக்கை ஏற்றப்படவில்லை" : "Report unavailable."}</p>}
      {isManagerOrOwner && (
        <section className="report-grid">
          <Metric
            icon="sale"
            label={lang === "ta" ? "நிகர விற்பனை (Net Sales)" : "Net Sales"}
            value={summaryError ? "—" : loadingSummary ? "..." : formatMoney(report.sales)}
            tone="blue"
          />
          <Metric
            icon="cash"
            label={lang === "ta" ? "உண்மை வசூல் (Collections)" : "Actual Collections"}
            value={summaryError ? "—" : loadingSummary ? "..." : formatMoney(report.collections)}
            tone="green"
          />
          <Metric
            icon="chart"
            label={lang === "ta" ? "மொத்த லாபம் (Gross Profit)" : "Gross Profit"}
            value={summaryError ? "—" : loadingSummary ? "..." : formatMoney(report.profit)}
            tone="green"
          />
          <Metric
            icon="wallet"
            label={lang === "ta" ? "செலவுகள் (Expenses)" : "Expenses"}
            value={summaryError ? "—" : loadingSummary ? "..." : formatMoney(report.expenses)}
            tone="red"
          />
          <Metric
            icon="receipt"
            label={lang === "ta" ? "மொத்த பில்கள் (Invoices)" : "Total Invoices"}
            value={summaryError ? "—" : loadingSummary ? "..." : String(report.bills)}
            tone="purple"
          />
          <Metric
            icon="return"
            label={lang === "ta" ? "சரக்கு திருப்புதல் (Returns)" : "Item Returns"}
            value={summaryError ? "—" : loadingSummary ? "..." : `${report.returnsCount} (${formatMoney(report.returnsAmount)})`}
            tone="purple"
          />
        </section>
      )}

      {/* Search & Filter Bar */}
      <section className="ledger-filter-section" style={{ marginTop: 20, background: "#fff", padding: "14px 18px", borderRadius: 12, border: "1px solid #e2e8f0" }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          {/* Server Search Box */}
          <div className="customer-search-box" style={{ flex: 1, minWidth: 260, margin: 0 }}>
            <Icon name="search" size={18} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={lang === "ta" ? "வாடிக்கையாளர் பெயர் அல்லது இன்வாய்ஸ் எண் தேடுக..." : "Search by customer name or invoice number (e.g. INV-202611-0001)..."}
            />
            {search && <button className="clear-search-btn" onClick={() => setSearch("")}>✕</button>}
          </div>

          {/* Date Filter Pills */}
          <div className="format-pills" style={{ display: "flex", gap: 6 }}>
            <button
              className={dateFilter === "all" ? "active" : ""}
              onClick={() => setDateFilter("all")}
            >
              {lang === "ta" ? "அனைத்து நாட்கள்" : "All Dates"}
            </button>
            <button
              className={dateFilter === "today" ? "active" : ""}
              onClick={() => setDateFilter("today")}
            >
              {lang === "ta" ? "இன்று" : "Today"}
            </button>
            <button
              className={dateFilter === "yesterday" ? "active" : ""}
              onClick={() => setDateFilter("yesterday")}
            >
              {lang === "ta" ? "நேற்று" : "Yesterday"}
            </button>
          </div>

          {/* Status Filter Pills */}
          <div className="format-pills" style={{ display: "flex", gap: 6 }}>
            <button
              className={statusFilter === "all" ? "active" : ""}
              onClick={() => setStatusFilter("all")}
            >
              {lang === "ta" ? "அனைத்தும்" : "All Status"}
            </button>
            <button
              className={statusFilter === "completed" ? "active" : ""}
              onClick={() => setStatusFilter("completed")}
            >
              {lang === "ta" ? "செலுத்தப்பட்டது" : "Paid"}
            </button>
            <button
              className={statusFilter === "credit" ? "active" : ""}
              onClick={() => setStatusFilter("credit")}
            >
              {lang === "ta" ? "கடன் பாக்கி" : "Due / Credit"}
            </button>
          </div>
        </div>
      </section>

      {/* Day-by-Day Clickable Invoice History */}
      <section className="day-by-day-ledger" style={{ marginTop: 20 }}>
        {invoicesError ? <p role="alert">{lang === "ta" ? "பில் வரலாறு கிடைக்கவில்லை" : "Could not load invoice history."}</p> : dateKeys.length > 0 ? (
          dateKeys.map((dateKey) => {
            const dayInvoices = groupedByDate[dateKey] || [];
            const dayTotal = dayInvoices.reduce((s, inv) => s + (inv.status === "cancelled" ? 0 : Number(inv.total) || 0), 0);
            const isToday = dateKey === todayStr;
            const isYesterday = dateKey === yesterdayStr;

            return (
              <div key={dateKey} className="day-group-card" style={{ marginBottom: 20, background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 18px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  <div>
                    <b style={{ fontSize: 16 }}>
                      {isToday ? (lang === "ta" ? "இன்று (Today)" : "Today") : isYesterday ? (lang === "ta" ? "நேற்று (Yesterday)" : "Yesterday") : dateKey}
                    </b>
                    <span style={{ color: "#64748b", marginLeft: 8, fontSize: 13 }}>
                      ({dayInvoices.length} {lang === "ta" ? "பில்கள்" : "invoices"})
                    </span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <small style={{ color: "#64748b", display: "block" }}>{lang === "ta" ? "காட்டும் பில்களின் மொத்தம்:" : "Shown Invoice Total:"}</small>
                    <b style={{ fontSize: 17, color: "#0284c7" }}>{formatMoney(dayTotal)}</b>
                  </div>
                </div>

                <div className="day-invoices-list" style={{ padding: "8px 12px" }}>
                  {dayInvoices.map((inv) => (
                    <button
                      key={inv.id || inv.invoice_number}
                      type="button"
                      className="statement-row-btn"
                      onClick={() => openInvoiceA4(inv.invoice_number)}
                      style={{
                        width: "100%",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 14px",
                        border: "none",
                        background: "none",
                        borderBottom: "1px solid #f1f5f9",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                      title="Click to view full A4 Invoice"
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Icon name="receipt" size={18} />
                        <div>
                          <b style={{ color: "#2563eb", fontSize: 14 }}>{inv.invoice_number}</b>
                          <span style={{ marginLeft: 8, fontWeight: 600, color: "#1e293b" }}>{inv.customer_name}</span>
                          <small style={{ display: "block", color: "#64748b" }}>Staff: {inv.made_by || "Cashier"}</small>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                        <div style={{ textAlign: "right" }}>
                          <b style={{ fontSize: 15 }}>{formatMoney(Number(inv.total))}</b>
                          <div style={{ fontSize: 12 }}>
                            {inv.status === "cancelled" ? <span style={{ color: "#991b1b" }}>{lang === "ta" ? "ரத்து" : "Cancelled"}</span> : inv.due > 0 ? (
                              <span style={{ color: "#b45309", fontWeight: 700 }}>Due: {formatMoney(Number(inv.due))}</span>
                            ) : (
                              <span style={{ color: "#16a34a", fontWeight: 700 }}>Paid</span>
                            )}
                          </div>
                        </div>
                        <span className="view-a4-pill">{lang === "ta" ? "A4 பில்" : "View A4"} →</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })
        ) : (
          <div style={{ padding: 30, textAlign: "center", color: "#94a3b8", background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0" }}>
            <p>{lang === "ta" ? "பொருத்தமான இன்வாய்ஸ்கள் எதுவும் இல்லை" : "No invoices found for the selected filter."}</p>
          </div>
        )}
      </section>

      {/* Full A4 View Modal on Click */}
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
