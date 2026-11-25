import { useState, useEffect } from "react";
import { useApp } from "../context/AppContext";
import { api } from "../services/api";
import type { Customer, CreatedInvoice, Role } from "../types";

import { Icon } from "../components/Icon";
import { AddCustomerModal } from "../components/modals/AddCustomerModal";
import { PrintInvoiceModal } from "../components/modals/PrintInvoiceModal";
import { formatMoney } from "../utils/formatters";

export function Customers({
  token,
  role = "employee",
  onGoHome,
}: {
  token: string;
  role?: Role;
  onGoHome?: () => void;
}) {
  const { t, lang, speak, showToast } = useApp();
  const [selected, setSelected] = useState<Customer>({ id: "", name: "", phone: "", balance: 0, cans: 0 });
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [statementRows, setStatementRows] = useState<any[]>([]);
  const [loadingStatement, setLoadingStatement] = useState(false);
  const [detailedInvoice, setDetailedInvoice] = useState<CreatedInvoice | null>(null);

  // Editing state for selected customer
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editCreditLimit, setEditCreditLimit] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const isManagerOrOwner = role === "owner" || role === "manager";

  const loadCustomers = (searchQuery = query, archived = showArchived) => {
    const params = new URLSearchParams();
    if (searchQuery.trim()) params.set("q", searchQuery.trim());
    if (archived) params.set("show_archived", "true");

    api
      .get<{ customers?: Partial<Customer>[] } | Partial<Customer>[]>(`/customers/list?${params.toString()}`, token)
      .then((result) => {
        const rows = Array.isArray(result) ? result : (result.customers ?? []);
        const mapped: Customer[] = rows.map((row, index) => ({
          ...row,
          id: row.id ? String(row.id) : String(index + 1),
          name: String(row.name || "Customer"),
          phone: String(row.phone || ""),
          address: row.address ? String(row.address) : "",
          balance: Number(row.balance ?? 0),
          cans: Number(row.cans ?? 0),
          credit_limit: Number(row.credit_limit ?? 0),
          is_active: row.is_active !== false,
        }));
        setCustomers(mapped);
        setSelected((curr) => mapped.find((m) => m.id === curr.id) || mapped[0] || { id: "", name: "", phone: "", balance: 0, cans: 0 });
      })
      .catch((err) => {
        showToast(lang === "ta" ? "வாடிக்கையாளர்களை ஏற்ற முடியவில்லை" : "Could not load customers", "error");
      });
  };

  const loadStatement = (customerId: string | number) => {
    if (!customerId) return;
    setLoadingStatement(true);
    api
      .get<any[]>(`/customers/statement/${customerId}`, token)
      .then((rows) => {
        if (Array.isArray(rows)) {
          setStatementRows(rows);
        } else {
          setStatementRows([]);
        }
      })
      .catch(() => {
        setStatementRows([]);
      })
      .finally(() => {
        setLoadingStatement(false);
      });
  };

  useEffect(() => {
    loadCustomers(query, showArchived);
    const handleRefresh = () => {
      loadCustomers(query, showArchived);
      if (selected?.id) {
        loadStatement(selected.id);
      }
    };
    window.addEventListener("refresh-customer-data", handleRefresh);
    return () => window.removeEventListener("refresh-customer-data", handleRefresh);
  }, [token, showArchived]);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadCustomers(query, showArchived);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Load statement whenever selected customer changes
  useEffect(() => {
    if (selected && selected.id) {
      setEditName(selected.name || "");
      setEditPhone(selected.phone || "");
      setEditAddress(selected.address || "");
      setEditCreditLimit(String(selected.credit_limit || 0));
      setIsEditing(false);
      setEditError(null);
      loadStatement(selected.id);
    }
  }, [selected?.id]);

  const saveCustomerChanges = async () => {
    if (!editName.trim()) {
      setEditError(lang === "ta" ? "பெயர் தேவை" : "Customer name is required");
      return;
    }
    setSavingEdit(true);
    setEditError(null);
    try {
      await api.post(
        "/customers/update",
        {
          customer_id: selected.id,
          name: editName.trim(),
          phone: editPhone.trim(),
          address: editAddress.trim(),
          credit_limit: Number(editCreditLimit) || 0,
        },
        token
      );
      speak("Customer updated", "வாடிக்கையாளர் விவரம் மாற்றப்பட்டது");
      showToast(
        lang === "ta" ? "வாடிக்கையாளர் விவரங்கள் மாற்றப்பட்டது!" : "Customer details updated successfully!",
        "success"
      );
      setIsEditing(false);
      loadCustomers(query, showArchived);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update customer";
      setEditError(msg);
    } finally {
      setSavingEdit(false);
    }
  };

  const toggleArchiveCustomer = async (cust: Customer, action: "archive" | "restore") => {
    const isArchiving = action === "archive";
    const confirmMsg = isArchiving
      ? (lang === "ta" ? `'${cust.name}' வாடிக்கையாளரை முடக்க (Archive) வேண்டுமா?` : `Archive customer '${cust.name}'?`)
      : (lang === "ta" ? `'${cust.name}' வாடிக்கையாளரை மீண்டும் இயக்க (Restore) வேண்டுமா?` : `Restore customer '${cust.name}'?`);
    if (!window.confirm(confirmMsg)) return;

    try {
      await api.post(
        "/customers/archive",
        { customer_id: cust.id, action },
        token
      );
      speak(
        isArchiving ? "Customer archived" : "Customer restored",
        isArchiving ? "வாடிக்கையாளர் முடக்கப்பட்டது" : "வாடிக்கையாளர் மீண்டும் இயக்கப்பட்டது"
      );
      showToast(
        isArchiving
          ? (lang === "ta" ? `'${cust.name}' முடக்கப்பட்டது.` : `Customer '${cust.name}' archived.`)
          : (lang === "ta" ? `'${cust.name}' மீண்டும் இயக்கப்பட்டது.` : `Customer '${cust.name}' restored.`),
        "success"
      );
      // Immediately refresh both views without reload
      loadCustomers(query, showArchived);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Action failed";
      showToast(msg, "error");
    }
  };

  // Open invoice in full A4 view when clicked in statement
  const openInvoiceA4 = async (invoiceNumber: string) => {
    try {
      const details = await api.get<any>(`/invoices/details/${encodeURIComponent(invoiceNumber)}`, token);
      setDetailedInvoice({
        invoice_number: details.invoice_number,
        customer_name: details.customer_name,
        customer_phone: details.customer_phone,
        customer_address: details.customer_address,
        customer_balance: details.current_customer_balance,
        subtotal: details.subtotal || details.total,
        amount_paid: details.amount_paid,
        applied_to_bill: details.amount_paid,
        applied_to_old_debt: details.applied_to_old_debt || 0,
        balance_due: details.balance_due,
        cans_returned: details.cans_returned || 0,
        staff_name: details.staff_name || "Cashier",
        date: details.date,
        items: (details.items || []).map((it: any, idx: number) => ({
          id: it.sale_item_id || idx + 1,
          name: it.product_name || it.name,
          variant: it.variant || it.type_name,
          unit: it.unit || "unit",
          sku: it.sku,
          ta: it.ta,
          quantity: it.quantity,
          price: it.price,
          subtotal: it.subtotal,
        })),
      });
    } catch (err: any) {
      showToast(
        lang === "ta"
          ? `இன்வாய்ஸ் ${invoiceNumber} விவரங்களை ஏற்ற முடியவில்லை: ${err.message || "பிழை"}`
          : `Could not load invoice ${invoiceNumber}: ${err.message || "Network error"}`,
        "error"
      );
    }
  };

  return (
    <div className="workflow-page customers-page">
      <div className="page-title compact" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <p className="eyebrow">{t("customers")}</p>
          <h1>{lang === "ta" ? "வாடிக்கையாளர் கணக்கு & லெட்ஜர்" : "Customer Accounts & Ledger"}</h1>
        </div>
        <div className="page-title-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Active / Archived Toggle */}
          <button
            type="button"
            className={`tab-toggle-btn ${showArchived ? "archived-active" : ""}`}
            onClick={() => setShowArchived(!showArchived)}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              background: showArchived ? "#fef3c7" : "#f8fafc",
              color: showArchived ? "#92400e" : "#475569",
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {showArchived
              ? (lang === "ta" ? "முடக்கப்பட்டவை (Archived Only)" : "Showing Archived Only")
              : (lang === "ta" ? "செயலில் உள்ளவை (Active Only)" : "Showing Active Only")}
          </button>
          <span className="count-pill">{customers.length} {t("customers")}</span>
        </div>
      </div>

      <section className="customer-layout">
        {/* Left Column: Customer Picker with Server-side Search - Fills full width of column */}
        <div className="workflow-card customer-picker-card">
          <div className="customer-search-row">
            <label className="customer-search-box">
              <Icon name="search" size={18} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={showArchived ? (lang === "ta" ? "முடக்கப்பட்ட வாடிக்கையாளர் தேட..." : "Search archived customers...") : t("findCustomer")}
              />
              {query && (
                <button className="clear-search-btn" onClick={() => setQuery("")}>✕</button>
              )}
            </label>
            {!showArchived && (
              <button
                type="button"
                className="btn-add-customer-quick"
                onClick={() => setShowAddModal(true)}
                title={lang === "ta" ? "புதிய வாடிக்கையாளர் சேர்க்க" : "Add New Customer"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 14px",
                  background: "#0284c7",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: 8,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <Icon name="plus" size={14} />
                <span>{lang === "ta" ? "+ வாடிக்கையாளர்" : "+ Customer"}</span>
              </button>
            )}
          </div>

          <div className="choice-list inside-scroll">
            {customers.map((c) => (
              <div
                className={`customer-item-row-wrap ${selected?.id === c.id ? "selected" : ""}`}
                key={String(c.id)}
              >
                <button
                  className="customer-item-btn-inner"
                  onClick={() => setSelected(c)}
                  style={{ wordBreak: "break-word", overflowWrap: "break-word" }}
                >
                  <span className="cust-info" style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ wordBreak: "break-word", whiteSpace: "normal" }}>{c.name}</b>
                    <small style={{ color: "#64748b" }}>{c.phone || "No phone"}</small>
                  </span>
                  <div style={{ textAlign: "right", whiteSpace: "nowrap", marginLeft: 8 }}>
                    <strong className={c.balance > 0 ? "debt" : "credit"}>
                      {formatMoney(Math.abs(c.balance))}
                    </strong>
                    {c.cans > 0 && (
                      <small style={{ display: "block", color: "#64748b" }}>{c.cans} cans</small>
                    )}
                  </div>
                </button>
                {isManagerOrOwner && (
                  <button
                    className={showArchived ? "btn-restore-customer" : "customer-delete-btn"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleArchiveCustomer(c, showArchived ? "restore" : "archive");
                    }}
                    title={showArchived ? "Restore Customer" : "Archive Customer"}
                    style={{
                      padding: showArchived ? "6px 12px" : "8px 10px",
                      marginRight: 6,
                      background: showArchived ? "#16a34a" : "transparent",
                      color: showArchived ? "#ffffff" : "#dc2626",
                      borderRadius: 6,
                      border: showArchived ? "none" : "1px solid #fee2e2",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {showArchived ? (
                      <span>{lang === "ta" ? "மீட்க" : "Restore"}</span>
                    ) : (
                      <Icon name="trash" size={15} />
                    )}
                  </button>
                )}
              </div>
            ))}
            {customers.length === 0 && (
              <div className="empty-state" style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>
                <small>
                  {showArchived
                    ? (lang === "ta" ? "முடக்கப்பட்ட வாடிக்கையாளர் எவரும் இல்லை" : "No archived customers found")
                    : (lang === "ta" ? "வாடிக்கையாளர் இல்லை" : "No matching customers found")}
                </small>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Customer Details, Metrics, Actions & Statement */}
        <div className="workflow-card amount-card inside-scroll">
          {selected ? (
            <>
              {/* Customer Header */}
              <div className="selected-customer-top" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h2 style={{ margin: 0, fontSize: 20, wordBreak: "break-word" }}>{selected.name}</h2>
                  {!selected.is_active && (
                    <span style={{ fontSize: 11, padding: "2px 8px", background: "#fef3c7", color: "#92400e", borderRadius: 4, fontWeight: 700 }}>
                      ARCHIVED
                    </span>
                  )}
                </div>
              </div>

              {!isEditing ? (
                <>
                  {/* METRIC LABELS PLACED STRICTLY ABOVE NUMBERS */}
                  <div className="customer-metrics-grid">
                    <div className={`customer-metric-card ${selected.balance > 0 ? "debt" : "credit"}`}>
                      <span className="metric-label">{lang === "ta" ? "நிலுவை கடன் (Outstanding Debt)" : "Outstanding Debt"}</span>
                      <span className="metric-value">
                        {formatMoney(Math.abs(selected.balance))} {selected.balance > 0 ? (lang === "ta" ? "(கடன்)" : "(Debt)") : (lang === "ta" ? "(வரவு)" : "(Credit)")}
                      </span>
                    </div>

                    <div className="customer-metric-card limit">
                      <span className="metric-label">{lang === "ta" ? "கடன் வரம்பு (Credit Limit)" : "Credit Limit"}</span>
                      <span className="metric-value">
                        {formatMoney(selected.credit_limit || 0)}
                      </span>
                    </div>

                    <div className="customer-metric-card cans">
                      <span className="metric-label">{lang === "ta" ? "காலி கேன்கள் கைவசம் (Cans Held)" : "Empty Cans Held"}</span>
                      <span className="metric-value">
                        {selected.cans} {lang === "ta" ? "கேன்கள்" : "cans"}
                      </span>
                    </div>
                  </div>

                  {/* GROUP CONTACT DETAILS AND ACTIONS BELOW METRICS */}
                  <div className="customer-contact-actions-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#f8fafc", padding: "12px 14px", borderRadius: 8, border: "1px solid #e2e8f0", marginTop: 12, flexWrap: "wrap", gap: 10 }}>
                    <div className="customer-contact-info" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: 13, color: "#334155", display: "flex", alignItems: "center", gap: 6 }}>
                        <Icon name="phone" size={14} />
                        <strong>{selected.phone || "No phone added"}</strong>
                      </span>
                      {selected.address && (
                        <span style={{ fontSize: 12, color: "#64748b" }}>
                          📍 {selected.address}
                        </span>
                      )}
                    </div>

                    <div className="customer-action-buttons" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {isManagerOrOwner ? (
                        <>
                          <button
                            type="button"
                            className="btn-modify-large"
                            onClick={() => setIsEditing(true)}
                            style={{ padding: "6px 12px", fontSize: 13 }}
                          >
                            <Icon name="edit" size={15} />
                            <span>{lang === "ta" ? "விவரங்கள் மாற்று" : "Modify Details"}</span>
                          </button>
                          <button
                            type="button"
                            className="customer-delete-btn"
                            style={{ padding: "6px 12px" }}
                            onClick={() => toggleArchiveCustomer(selected, showArchived ? "restore" : "archive")}
                            title={showArchived ? "Restore Customer" : "Archive Customer"}
                          >
                            <Icon name={showArchived ? "check" : "trash"} size={15} />
                            <span style={{ marginLeft: 4 }}>{showArchived ? (lang === "ta" ? "மீட்க" : "Restore") : (lang === "ta" ? "முடக்கு" : "Archive")}</span>
                          </button>
                        </>
                      ) : (
                        <span style={{ fontSize: 12, color: "#94a3b8" }}>🔒 Staff View</span>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                /* EDITABLE FORM (Owner/Manager Only) */
                <div className="customer-edit-form" style={{ marginTop: 14 }}>
                  <h3 style={{ margin: "0 0 12px 0" }}>{lang === "ta" ? "வாடிக்கையாளர் விவரம் மாற்றுக" : "Edit Customer Details"}</h3>
                  {editError && (
                    <div style={{ padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13, marginBottom: 10 }}>
                      ⚠ {editError}
                    </div>
                  )}
                  <label>
                    <span>{lang === "ta" ? "பெயர் *" : "Customer Name *"}</span>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Customer Name"
                    />
                  </label>
                  <label>
                    <span>{lang === "ta" ? "தொலைபேசி எண்:" : "Phone Number:"}</span>
                    <input
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      placeholder="Phone"
                    />
                  </label>
                  <label>
                    <span>{lang === "ta" ? "முகவரி:" : "Address:"}</span>
                    <input
                      value={editAddress}
                      onChange={(e) => setEditAddress(e.target.value)}
                      placeholder="Shop address"
                    />
                  </label>
                  <label>
                    <span>{lang === "ta" ? "கடன் வரம்பு (Rs.):" : "Credit Limit (Rs.):"}</span>
                    <input
                      type="number"
                      value={editCreditLimit}
                      onChange={(e) => setEditCreditLimit(e.target.value)}
                    />
                  </label>

                  <div className="edit-form-actions" style={{ display: "flex", gap: 10, marginTop: 12 }}>
                    <button
                      type="button"
                      className="btn-cancel"
                      onClick={() => setIsEditing(false)}
                    >
                      {lang === "ta" ? "ரத்து" : "Cancel"}
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={saveCustomerChanges}
                      disabled={savingEdit}
                    >
                      <Icon name="check" size={16} />
                      <span>{savingEdit ? "..." : (lang === "ta" ? "மாற்றங்களை சேமி" : "Save Changes")}</span>
                    </button>
                  </div>
                </div>
              )}

              {/* REAL STATEMENT LEDGER FROM v_customer_statement */}
              <div className="statement" style={{ marginTop: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <h3 style={{ margin: 0 }}>
                    {lang === "ta" ? "கணக்கு அறிக்கை (Official Statement Ledger)" : "Account Statement Ledger"}
                  </h3>
                  <small style={{ color: "#64748b" }}>
                    {statementRows.length} {lang === "ta" ? "பதிவுகள்" : "transactions"}
                  </small>
                </div>

                {loadingStatement ? (
                  <div style={{ padding: 20, textAlign: "center", color: "#64748b" }}>
                    <span>Loading official statement...</span>
                  </div>
                ) : statementRows.length > 0 ? (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "2px solid #cbd5e1" }}>
                          <th style={{ padding: "8px 10px" }}>Date</th>
                          <th style={{ padding: "8px 10px" }}>Type</th>
                          <th style={{ padding: "8px 10px" }}>Reference</th>
                          <th style={{ padding: "8px 10px", textAlign: "right" }}>Debit (+)</th>
                          <th style={{ padding: "8px 10px", textAlign: "right" }}>Credit (-)</th>
                          <th style={{ padding: "8px 10px", textAlign: "right" }}>Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statementRows.map((row, idx) => {
                          const isInvoice = row.entry_type === "sale" || row.entry_type === "invoice" || (row.reference_number && row.reference_number.startsWith("INV"));
                          return (
                            <tr
                              key={row.statement_id || idx}
                              style={{
                                borderBottom: "1px solid #e2e8f0",
                                cursor: isInvoice ? "pointer" : "default",
                                background: idx % 2 === 0 ? "#ffffff" : "#f8fafc",
                              }}
                              onClick={() => {
                                if (isInvoice && row.reference_number) {
                                  openInvoiceA4(row.reference_number);
                                }
                              }}
                              title={isInvoice ? "Click to view full A4 Invoice" : undefined}
                            >
                              <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                                {row.transaction_date ? String(row.transaction_date).split("T")[0] : ""}
                              </td>
                              <td style={{ padding: "8px 10px", textTransform: "capitalize" }}>
                                <b>{row.entry_type || "Entry"}</b>
                              </td>
                              <td style={{ padding: "8px 10px" }}>
                                <span style={{ color: isInvoice ? "#2563eb" : "#475569", fontWeight: isInvoice ? 700 : 400 }}>
                                  {row.reference_number || row.description || "—"}
                                </span>
                                {isInvoice && <span style={{ fontSize: 11, marginLeft: 4, color: "#2563eb" }}>[View A4]</span>}
                              </td>
                              <td style={{ padding: "8px 10px", textAlign: "right", color: Number(row.debit) > 0 ? "#b45309" : "#64748b" }}>
                                {Number(row.debit) > 0 ? formatMoney(row.debit) : "—"}
                              </td>
                              <td style={{ padding: "8px 10px", textAlign: "right", color: Number(row.credit) > 0 ? "#15803d" : "#64748b" }}>
                                {Number(row.credit) > 0 ? formatMoney(row.credit) : "—"}
                              </td>
                              <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700 }}>
                                {formatMoney(row.running_balance ?? 0)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ padding: 20, textAlign: "center", color: "#94a3b8", background: "#f8fafc", borderRadius: 8 }}>
                    <small>{lang === "ta" ? "கணக்கு அறிக்கை பதிவுகள் எதுவும் இல்லை" : "No ledger transactions recorded yet for this customer"}</small>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{ padding: 40, textAlign: "center", color: "#94a3b8" }}>
              {lang === "ta" ? "வாடிக்கையாளரைத் தேர்ந்தெடுக்கவும்" : "Select a customer to view profile and statement"}
            </div>
          )}
        </div>
      </section>

      {/* Add Customer Modal */}
      <AddCustomerModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        token={token}
        role={role}
        onSuccess={(newCust) => {
          setCustomers((prev) => [newCust, ...prev]);
          setSelected(newCust);
        }}
      />

      {/* Full A4 Invoice View Modal on Click */}
      {detailedInvoice && (
        <PrintInvoiceModal
          invoice={detailedInvoice}
          initialFormat="a4"
          onClose={() => setDetailedInvoice(null)}
          onRetry={() => openInvoiceA4(detailedInvoice.invoice_number)}
        />
      )}
    </div>
  );
}
