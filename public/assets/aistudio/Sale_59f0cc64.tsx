import { useState, useEffect, useRef } from "react";
import { useApp } from "../context/AppContext";
import { api, ApiError } from "../services/api";
import type { Customer, CreatedInvoice, IconName, Product } from "../types";
import { classifyProductRank } from "../data/sampleData";
import { Icon } from "../components/Icon";
import { Stepper } from "../components/Stepper";
import { AddCustomerModal } from "../components/modals/AddCustomerModal";
import { PrintInvoiceModal } from "../components/modals/PrintInvoiceModal";
import { formatMoney } from "../utils/formatters";

import { hasPendingOperation, retryOperation, submitOnce } from "../services/operations";
import { toInvoice } from "../utils/receipt";

const noCustomer: Customer = { id: "", name: "", phone: "", balance: 0, cans: 0 };

export function Sale({ token, onGoHome }: { token: string; onGoHome: () => void }) {
  const { t, lang, speak, showToast } = useApp();
  const [step, setStep] = useState(1);
  const [customer, setCustomer] = useState(noCustomer);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [editingQty, setEditingQty] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState<boolean>(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const lastStockReqIdRef = useRef<number>(0);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [payMode, setPayMode] = useState<"cash" | "credit" | "custom">("cash");
  const [cashReceived, setCashReceived] = useState<string>("");
  const [cashManuallyOverridden, setCashManuallyOverridden] = useState<boolean>(false);
  const [discountInput, setDiscountInput] = useState("");
  const [applyToOldDebt, setApplyToOldDebt] = useState<boolean>(true);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [returnCanType, setReturnCanType] = useState("");
  const [heldTypes, setHeldTypes] = useState<NonNullable<Customer["container_types"]>>([]);
  const [cansReturning, setCansReturning] = useState<string>("");
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [createdInvoice, setCreatedInvoice] = useState<CreatedInvoice | null>(null);
  const checkoutInFlight = useRef(false);
  const [customerError, setCustomerError] = useState(false);
  const getProductKey = (p: Product) => (p.type_id ? String(p.type_id) : "");

  // Active products set & missing cart items detection
  const activeTypeIds = new Set(products.map(getProductKey).filter(Boolean));
  const missingCartEntries = Object.entries(cart).filter(([key, qty]) => qty > 0 && !activeTypeIds.has(key));
  const hasMissingCartItems = missingCartEntries.length > 0;

  const subtotalCents = products.reduce((sum, p) => {
    const key = getProductKey(p);
    return key ? sum + Math.round(p.price * 100) * (cart[key] || 0) : sum;
  }, 0);

  const subtotal = subtotalCents / 100;
  const discount = Number(discountInput) || 0;
  const discountCents = Math.round(discount * 100);
  const invalidDiscount = !/^\d*(?:\.\d{0,2})?$/.test(discountInput) || discountCents > subtotalCents;
  const total = (subtotalCents - (invalidDiscount ? 0 : discountCents)) / 100;

  // Sync cashReceived with current invoice total when cash mode active and not overridden
  useEffect(() => {
    if (payMode !== "credit" && !cashManuallyOverridden) {
      setCashReceived(String(total));
    }
  }, [total, payMode, cashManuallyOverridden]);

  const loadData = () => {
    const reqId = ++lastStockReqIdRef.current;
    setLoadingProducts(true);
    setProductsError(null);

    api
      .get<{ products?: Partial<Product>[] } | Partial<Product>[]>("/products/list", token)
      .then((result) => {
        if (reqId !== lastStockReqIdRef.current) return;
        const rows = Array.isArray(result) ? result : (result.products ?? []);
        const mapped: Product[] = rows.map((row, index) => {
          const isCan = (row.unit || "").toLowerCase().includes("can") || (row.name || "").includes("19") || (row.name || "").includes("5 L");
          return {
            id: Number(row.id ?? index + 1),
            type_id: row.type_id ? String(row.type_id) : undefined,
            name: String(row.name || "Product"),
            ta: String(row.ta || row.name || "Product"),
            price: Number(row.price ?? 0),
            stock: Number(row.stock ?? 0),
            unit: String(row.unit || (isCan ? "can" : "bottle")),
            sku: row.sku ? String(row.sku) : "",
            icon: row.icon === "can" || isCan ? ("can" as IconName) : ("bottle" as IconName),
            is_returnable: Boolean(row.is_returnable),
            is_active: row.is_active !== false,
            buying_price: row.buying_price !== null && row.buying_price !== undefined ? Number(row.buying_price) : null,
          };
        });
        mapped.sort((a, b) => classifyProductRank(a) - classifyProductRank(b));
        setProducts(mapped);
        setLoadingProducts(false);
      })
      .catch((err) => {
        if (reqId !== lastStockReqIdRef.current) return;
        setProductsError(err instanceof Error ? err.message : "Failed to load products");
        setLoadingProducts(false);
      });

    setCustomerError(false);
    api.get<Customer[]>(`/customers/list?q=${encodeURIComponent(query)}`, token)
      .then((rows) => {
        if (reqId !== lastStockReqIdRef.current) return;
        setCustomers(rows);
        setCustomer((curr) => rows.find((row) => row.id === curr.id) || curr);
      })
      .catch(() => { if (reqId === lastStockReqIdRef.current) setCustomerError(true); });

  };

  useEffect(() => {
    loadData();
    const handleRefresh = () => {
      loadData();
    };
    window.addEventListener("refresh-customer-data", handleRefresh);
    window.addEventListener("refresh-stock-data", handleRefresh);
    return () => {
      window.removeEventListener("refresh-customer-data", handleRefresh);
      window.removeEventListener("refresh-stock-data", handleRefresh);
    };
  }, [token, query]);

  useEffect(() => {
    if (!query) { loadData(); return; }
    const timer = setTimeout(loadData, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const handleQuantityChange = (prod: Product, val: string) => {
    const key = getProductKey(prod);
    if (!key) {
      showToast(lang === "ta" ? "இந்த பொருளுக்கு சரியான type_id இல்லை" : "Product has no valid type_id and cannot be selected", "error");
      return;
    }
    setEditingQty((prev) => ({ ...prev, [key]: val }));
    if (val.trim() === "") {
      setCart((c) => ({ ...c, [key]: 0 }));
      return;
    }
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      if (parsed > prod.stock) {
        showToast(
          lang === "ta"
            ? `${prod.ta || prod.name}: கையிருப்பில் உள்ளதை விட அதிகம்! (இருப்பு: ${prod.stock})`
            : `${prod.name}: Quantity exceeds available stock (${prod.stock} in stock)`,
          "error"
        );
      }
      setCart((c) => ({ ...c, [key]: Math.min(parsed, prod.stock) }));
    }
  };

  const handleQuantityCommit = (prod: Product) => {
    const key = getProductKey(prod);
    if (!key) return;
    const rawVal = editingQty[key];
    if (rawVal === undefined) return;
    if (rawVal.trim() === "") {
      setCart((c) => ({ ...c, [key]: 0 }));
      setEditingQty((prev) => ({ ...prev, [key]: "0" }));
      return;
    }
    const parsed = parseInt(rawVal, 10);
    if (isNaN(parsed) || parsed < 0) {
      setCart((c) => ({ ...c, [key]: 0 }));
      setEditingQty((prev) => ({ ...prev, [key]: "0" }));
    } else if (parsed > prod.stock) {
      showToast(
        lang === "ta"
          ? `${prod.ta || prod.name}: கையிருப்பு ${prod.stock} மட்டுமே உள்ளது!`
          : `${prod.name}: Limited to ${prod.stock} available units!`,
        "error"
      );
      setCart((c) => ({ ...c, [key]: prod.stock }));
      setEditingQty((prev) => ({ ...prev, [key]: String(prod.stock) }));
    } else {
      setCart((c) => ({ ...c, [key]: parsed }));
      setEditingQty((prev) => ({ ...prev, [key]: String(parsed) }));
    }
  };

  const add = (prod: Product, delta: number) => {
    const key = getProductKey(prod);
    if (!key) {
      showToast(lang === "ta" ? "இந்த பொருளுக்கு சரியான type_id இல்லை" : "Product has no valid type_id and cannot be selected", "error");
      return;
    }
    const current = cart[key] || 0;
    const nextVal = current + delta;
    if (nextVal < 0) return;
    if (nextVal > prod.stock) {
      showToast(
        lang === "ta"
          ? `${prod.ta || prod.name}: கையிருப்பு ${prod.stock} மட்டுமே உள்ளது!`
          : `${prod.name}: Cannot exceed available stock (${prod.stock})`,
        "error"
      );
      return;
    }
    setCart((c) => ({ ...c, [key]: nextVal }));
    setEditingQty((prev) => ({ ...prev, [key]: String(nextVal) }));
  };

  const invalidCash = payMode !== "credit" && !/^\d*(?:\.\d{0,2})?$/.test(cashReceived);
  const numCashReceived = payMode === "credit" ? 0 : (Number(cashReceived) || 0);
  const appliedToBill = Math.min(total, numCashReceived);
  const excessCash = Math.max(0, numCashReceived - total);
  const previousDebt = Math.max(0, customer.balance);
  const appliedToDebt = (applyToOldDebt && excessCash > 0 && previousDebt > 0) ? Math.min(previousDebt, excessCash) : 0;
  const changeReturned = (applyToOldDebt && excessCash > 0 && previousDebt > 0) ? (excessCash - appliedToDebt) : excessCash;
  const newBalance = customer.balance + (total - appliedToBill) - appliedToDebt;
  const numCansReturn = Number(cansReturning) || 0;
  const filledCansGiven = products.reduce((sum, p) => {
    if (p.is_returnable) {
      return sum + (cart[getProductKey(p)] || 0);
    }
    return sum;
  }, 0);
  const cansAlreadyWithCustomer = customer.cans || 0;
  const cansAfterSale = cansAlreadyWithCustomer + filledCansGiven - numCansReturn;

  useEffect(() => {
    setHeldTypes([]);
    setReturnCanType("");
    if (!customer.id) return;
    let current = true;
    api.get<Customer>(`/customers/details/${customer.id}`, token)
      .then((row) => { if (current) setHeldTypes(row.container_types || []); })
      .catch(() => {});
    return () => { current = false; };
  }, [customer.id, customer.cans, token]);

  const canOptions = new Map(heldTypes.map((row) => [row.type_id, row]));
  for (const p of products) {
    const type_id = getProductKey(p);
    const quantity = cart[type_id] || 0;
    if (p.is_returnable && quantity > 0) {
      canOptions.set(type_id, { type_id, name: p.name, ta: p.ta, held: (canOptions.get(type_id)?.held || 0) + quantity });
    }
  }
  const selectedCanType = canOptions.size === 1 ? canOptions.keys().next().value : returnCanType;
  const invalidCans = !Number.isInteger(numCansReturn) || numCansReturn < 0 ||
    (numCansReturn > 0 && (!selectedCanType || numCansReturn > (canOptions.get(selectedCanType)?.held ?? 0)));
  const pendingCheckout = hasPendingOperation("/sales/create", token);

  const saveInvoice = async (retry = false) => {
    if (checkoutInFlight.current || (!retry && (!customer.id || invalidCans || invalidCash || invalidDiscount))) return;
    if (!retry && hasMissingCartItems) {
      setCheckoutError(lang === "ta"
        ? "கிடைக்காத பொருட்கள் வரைவில் உள்ளன. தொடர்வதற்கு அவற்றை நீக்கவும்."
        : "Some items in your draft are no longer available in the catalog. Please remove them before saving.");
      return;
    }

    checkoutInFlight.current = true;
    setSaving(true);
    setCheckoutError(null);
    try {
      const saleItems = Object.entries(cart)
        .filter(([, q]) => q > 0)
        .map(([key, quantity]) => {
          const prod = products.find((p) => getProductKey(p) === key);
          return {
            product_id: prod?.id,
            type_id: prod?.type_id || key,
            name: prod?.name || `Item ${key}`,
            ta: prod?.ta,
            price: prod?.price || 0,
            quantity,
            subtotal: (prod?.price || 0) * quantity,
          };
        });

      const res = retry ? await retryOperation<any>("/sales/create", token) : await submitOnce<any>(
        "/sales/create",
        {
          customer_id: customer.id,
          items: saleItems,
          payment_type: payMode,
          discount: discountCents / 100,
          cash_received: numCashReceived,
          amount_paid: appliedToBill,
          apply_to_old_debt: applyToOldDebt,
          expected_previous_balance: customer.balance,
          empty_cans_returned: numCansReturn,
          ...(numCansReturn > 0 ? { return_container_type_id: selectedCanType } : {}),
        },
        token,
      );

      const invoice = toInvoice(res.receipt);
      speak("Invoice saved and stock updated", "இன்வாய்ஸ் சேமிக்கப்பட்டு சரக்கு குறைக்கப்பட்டது");
      showToast(lang === "ta" ? `இன்வாய்ஸ் ${invoice.invoice_number} சேமிக்கப்பட்டது!` : `Invoice ${invoice.invoice_number} saved.`, "success");
      setCreatedInvoice(invoice);

      setCart({});
      setDiscountInput("");
      setPayMode("cash");
      setApplyToOldDebt(true);
      setEditingQty({});
      setCansReturning("");
      setCashReceived("");
      setCashManuallyOverridden(false);
      if (res.new_cans_balance !== undefined) {
        setCustomer((prev) => ({ ...prev, balance: res.new_balance, cans: res.new_cans_balance }));
      }
      loadData();
      window.dispatchEvent(new CustomEvent("refresh-customer-data"));
      window.dispatchEvent(new CustomEvent("refresh-stock-data"));
    } catch (err: any) {
      if (err instanceof ApiError && err.code === "stale_balance") {
        setCheckoutError(lang === "ta"
          ? "வாடிக்கையாளரின் கடன் தொகை மாறியுள்ளது. புதிய தொகையை சரிபார்க்கவும்."
          : "Customer balance changed while reviewing. Please verify the updated numbers.");
        loadData();
      } else if (err instanceof ApiError && err.status < 500) {
        setCheckoutError(err.message);
      } else {
        setCheckoutError(lang === "ta"
          ? "இன்வாய்ஸ் சேமிக்கப்பட்டதா என சோதிக்கவும். மீண்டும் உடனடியாக தட்ட வேண்டாம்."
          : "Could not confirm the invoice. Use “Retry the same bill” above.");
      }
      speak("Invoice not confirmed", "இன்வாய்ஸ் உறுதி செய்யப்படவில்லை");
    } finally {
      checkoutInFlight.current = false;
      setSaving(false);
    }
  };

  const isEmptyCanProduct = (p: Partial<Product>) => {
    const n = (p.name || "").toLowerCase();
    return n.includes("empty") || (n.includes("19") && Boolean(p.is_returnable) && !n.includes("filled") && !n.includes("water"));
  };
  const regularWaterProducts = products.filter((p) => !isEmptyCanProduct(p));
  const emptyCanProducts = products.filter((p) => isEmptyCanProduct(p));

  return (
    <div className="workflow-page sale-page">
      {pendingCheckout && !createdInvoice && (
        <div className="workflow-card" role="status">
          <p>{lang === "ta" ? "முந்தைய பில் உறுதி செய்யப்படவில்லை." : "The previous bill is not confirmed."}</p>
          <button type="button" className="primary-action" disabled={saving} onClick={() => saveInvoice(true)}>
            {lang === "ta" ? "அதே பில்லை மீண்டும் முயற்சி செய்" : "Retry the same bill"}
          </button>
        </div>
      )}
      {/* Sub-bar below navbar */}
      <div className="subbar-nav">
        <button
          className="subbar-btn"
          onClick={() => (step > 1 ? setStep(step - 1) : onGoHome())}
          title={step > 1 ? t("back") : t("home")}
        >
          <Icon name="back" size={16} />
          <span>{step > 1 ? t("back") : t("home")}</span>
        </button>

        <div className="subbar-center">
          <Stepper step={step} />
        </div>

        <div className="subbar-right" />
      </div>

      {/* STEP 1: Select Customer (Highlights customer and does not auto-advance) */}
      {step === 1 && (
        <section className="sale-step1-layout">
          {/* Left: Customer Search & List */}
          <div className="workflow-card inside-scroll">
            <div className="customer-search-row">
              <label className="customer-search-box">
                <Icon name="search" size={20} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("findCustomer")}
                  autoFocus
                />
                {query && <button className="clear-search-btn" onClick={() => setQuery("")}>✕</button>}
              </label>
              <button
                className="btn-add-customer-quick"
                onClick={() => setShowAddCustomerModal(true)}
                title="Add New Customer"
              >
                <Icon name="plus" size={14} />
                <span>{lang === "ta" ? "புதியவர்" : "+ New"}</span>
              </button>
            </div>

            <div className="choice-list inside-scroll">
              {customerError && <p role="alert">{lang === "ta" ? "வாடிக்கையாளர்களை ஏற்ற முடியவில்லை" : "Could not load customers"}</p>}
              {customers
                .filter(
                  (c) =>
                    c.name.toLowerCase().includes(query.toLowerCase()) ||
                    c.phone.includes(query),
                )
                .map((c) => (
                  <button
                    className={`customer-item-btn ${customer && customer.id === c.id ? "selected" : ""}`}
                    key={String(c.id)}
                    onClick={() => {
                      if (customer && customer.id !== c.id && Object.values(cart).some((q) => q > 0)) {
                        if (!window.confirm(lang === "ta" ? "வாடிக்கையாளரை மாற்றினால் நடப்பு வரைவு சரக்குகள் புதிய வாடிக்கையாளருக்கு தொடரும். தொடரவா?" : "Switching customer will assign the draft items to this customer. Continue?")) {
                          return;
                        }
                      }
                      setCustomer(c);
                    }}
                  >
                    <span className="cust-info">
                      <b>{c.name}</b>
                      <small>
                        <Icon name="phone" size={12} /> {c.phone}
                      </small>
                    </span>
                    <strong className={c.balance > 0 ? "debt" : "credit"}>
                      {formatMoney(Math.abs(c.balance))}
                    </strong>
                  </button>
                ))}
            </div>
          </div>

          {/* Right: Selected Customer Card with explicit "Start adding items" button */}
          <div className="selected-customer-preview workflow-card">
            {customer.id ? (
              <div style={{ display: "flex", flexDirection: "column", height: "100%", textAlign: "left" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                  <div className="large-avatar" style={{ margin: 0 }}>
                    {customer.name[0]?.toUpperCase() || "C"}
                  </div>
                  <div>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900, color: "#0f172a" }}>{customer.name}</h2>
                    <p style={{ margin: "2px 0 0 0", color: "#64748b", fontSize: 13 }}>
                      <Icon name="phone" size={12} /> {customer.phone || "No phone added"}
                      {customer.address ? ` • ${customer.address}` : ""}
                    </p>
                  </div>
                </div>

                <div className="customer-metrics-grid" style={{ marginBottom: 20 }}>
                  <div className={`customer-metric-card ${customer.balance > 0 ? "debt" : "credit"}`}>
                    <span className="metric-label">{lang === "ta" ? "நிலுவை கடன்" : "Outstanding Debt"}</span>
                    <span className="metric-value">
                      {formatMoney(Math.abs(customer.balance))}
                    </span>
                  </div>
                  <div className="customer-metric-card limit">
                    <span className="metric-label">{lang === "ta" ? "கடன் வரம்பு" : "Credit Limit"}</span>
                    <span className="metric-value">
                      {formatMoney(Number(customer.credit_limit || 0))}
                    </span>
                  </div>
                  <div className="customer-metric-card cans">
                    <span className="metric-label">{lang === "ta" ? "காலி கேன்கள்" : "Cans Held"}</span>
                    <span className="metric-value">
                      {customer.cans} {lang === "ta" ? "கேன்கள்" : "cans"}
                    </span>
                  </div>
                </div>

                <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: 8, border: "1px solid #e2e8f0", marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>
                    {lang === "ta" ? "பில் தொடங்குவதற்கான தயார் நிலை" : "Ready to Bill"}
                  </div>
                  <small style={{ color: "#64748b", display: "block", marginTop: 2 }}>
                    {lang === "ta"
                      ? "வாடிக்கையாளர் தேர்ந்தெடுக்கப்பட்டார். சரக்குகளைத் தேர்வு செய்ய கீழே உள்ள பொத்தானை அழுத்தவும்."
                      : "Customer selected. Click below to start adding water bottles and containers to this order."}
                  </small>
                </div>

                <div style={{ marginTop: "auto" }}>
                  <button
                    type="button"
                    className="primary-action"
                    onClick={() => setStep(2)}
                    style={{
                      width: "100%",
                      padding: "16px 20px",
                      fontSize: 16,
                      fontWeight: 900,
                      borderRadius: 10,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 10,
                      boxShadow: "0 4px 14px rgba(2, 132, 199, 0.35)",
                    }}
                  >
                    <Icon name="sale" size={20} />
                    <span>{lang === "ta" ? "சரக்கு சேர்க்க தொடங்கு (Start adding items) →" : "Start adding items →"}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "#94a3b8" }}>
                <Icon name="user" size={48} />
                <p style={{ marginTop: 12, fontWeight: 700, fontSize: 15 }}>
                  {lang === "ta" ? "வாடிக்கையாளரை தேர்ந்தெடுக்கவும்" : "Select a customer to begin invoice"}
                </p>
                <small style={{ color: "#64748b", textAlign: "center", maxWidth: 280 }}>
                  {lang === "ta" ? "இடதுபுறப் பட்டியலில் உள்ள வாடிக்கையாளரைத் தொடவும்" : "Click any customer from the list on the left to review their balance and start billing."}
                </small>
              </div>
            )}
          </div>
        </section>
      )}

      {/* STEP 2: Pick Products & Cart (With Editable Quantity Input) */}
      {step === 2 && (
        <section className="sale-step2-layout">
          <div className="product-selection-pane inside-scroll">
            {hasMissingCartItems && (
              <div style={{ padding: 12, marginBottom: 14, background: "#fef2f2", border: "1px solid #f87171", borderRadius: 8, color: "#991b1b" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <b>{lang === "ta" ? "கிடைக்காத பொருட்கள் வரைவில் உள்ளன:" : "Unavailable Items in Draft:"}</b>
                    <span style={{ marginLeft: 6, fontSize: 13 }}>
                      {lang === "ta"
                        ? "சில பொருட்கள் பட்டியலில் இருந்து நீக்கப்பட்டுள்ளன அல்லது மாற்றப்பட்டுள்ளன. தொடர்வதற்கு அவற்றை நீக்கவும்."
                        : "Some items in your draft are no longer available in the catalog. Remove them to proceed."}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCart((prev) => {
                        const next = { ...prev };
                        missingCartEntries.forEach(([k]) => delete next[k]);
                        return next;
                      });
                      setEditingQty((prev) => {
                        const next = { ...prev };
                        missingCartEntries.forEach(([k]) => delete next[k]);
                        return next;
                      });
                    }}
                    style={{
                      padding: "6px 12px",
                      background: "#dc2626",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      fontWeight: 700,
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {lang === "ta" ? "கிடைக்காதவற்றை நீக்கு" : "Remove Unavailable Items"}
                  </button>
                </div>
              </div>
            )}
            {productsError && (
              <div style={{ padding: 12, marginBottom: 12, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#b91c1c" }}>
                <p style={{ margin: 0, fontWeight: 700 }}>
                  {lang === "ta" ? "பொருட்கள் விவரங்களை ஏற்ற முடியவில்லை:" : "Failed to load products:"} {productsError}
                </p>
                <button
                  type="button"
                  onClick={() => loadData()}
                  style={{ marginTop: 6, padding: "4px 10px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, fontWeight: 700, cursor: "pointer", fontSize: 12 }}
                >
                  {lang === "ta" ? "மீண்டும் முயற்சிக்கவும் (Retry)" : "Retry"}
                </button>
              </div>
            )}
            {loadingProducts && products.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", color: "#64748b" }}>
                <span>{lang === "ta" ? "பொருட்கள் ஏற்றப்படுகின்றன..." : "Loading products..."}</span>
              </div>
            )}
            {!loadingProducts && products.length === 0 && !productsError && (
              <div style={{ padding: 24, textAlign: "center", color: "#64748b" }}>
                <span>{lang === "ta" ? "பொருட்கள் எதுவும் கிடைக்கவில்லை" : "No products available"}</span>
              </div>
            )}
            <div className="category-section-label">
              <span>{lang === "ta" ? "தண்ணீர் வகைகள் (Water Bottles)" : "Water Categories"}</span>
            </div>
            <div className="product-grid">
              {regularWaterProducts.map((p) => {
                const hasValidTypeId = Boolean(p.type_id);
                const key = getProductKey(p);
                const currentQty = key ? cart[key] || 0 : 0;
                const displayQty = key && editingQty[key] !== undefined ? editingQty[key] : String(currentQty);
                return (
                  <div className={`product-card ${p.stock < 10 ? "low" : ""}`} key={key || `no-type-${p.id}`}>
                    <button
                      className="product-main"
                      disabled={!hasValidTypeId}
                      onClick={() => {
                        if (!hasValidTypeId) return;
                        add(p, 1);
                      }}
                      style={!hasValidTypeId ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                    >
                      <span className="product-icon">
                        <Icon name={p.icon} size={36} />
                      </span>
                      <b className="product-title">{lang === "ta" ? p.ta : p.name}</b>
                      <strong className="product-price-tag">{formatMoney(p.price)}</strong>
                      <span className={`stock-badge ${p.stock < 10 ? "low" : ""}`}>
                        {hasValidTypeId ? `${p.stock} ${p.unit || t("stock")}` : (lang === "ta" ? "தேர்வு செய்ய முடியாது" : "Not selectable")}
                      </span>
                    </button>
                    <div className="quantity-control">
                      <button type="button" disabled={!hasValidTypeId} onClick={() => add(p, -1)} aria-label="Decrease quantity">
                        <Icon name="minus" size={16} />
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        disabled={!hasValidTypeId}
                        value={displayQty}
                        onChange={(e) => handleQuantityChange(p, e.target.value)}
                        onBlur={() => handleQuantityCommit(p)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                        style={{
                          width: 48,
                          height: 36,
                          textAlign: "center",
                          fontWeight: 900,
                          fontSize: 16,
                          border: "1px solid #cbd5e1",
                          borderRadius: 8,
                          background: hasValidTypeId ? "#ffffff" : "#f1f5f9",
                          margin: "0 4px",
                          cursor: hasValidTypeId ? "text" : "not-allowed",
                        }}
                      />
                      <button type="button" disabled={!hasValidTypeId} onClick={() => add(p, 1)} aria-label="Increase quantity">
                        <Icon name="plus" size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 19L Empty Cans in separate row */}
            {emptyCanProducts.length > 0 && (
              <div className="empty-cans-separate-section">
                <div className="category-section-label empty-can-label">
                  <Icon name="can" size={18} />
                  <span>{lang === "ta" ? "19L காலி கேன் (Returnable Containers)" : "19L Returnable Containers"}</span>
                </div>
                <div className="product-grid single-row">
                  {emptyCanProducts.map((p) => {
                    const hasValidTypeId = Boolean(p.type_id);
                    const key = getProductKey(p);
                    const currentQty = key ? cart[key] || 0 : 0;
                    const displayQty = key && editingQty[key] !== undefined ? editingQty[key] : String(currentQty);
                    return (
                      <div className={`product-card empty-can-card ${p.stock < 10 ? "low" : ""}`} key={key || `no-type-${p.id}`}>
                        <button
                          className="product-main"
                          disabled={!hasValidTypeId}
                          onClick={() => {
                            if (!hasValidTypeId) return;
                            add(p, 1);
                          }}
                          style={!hasValidTypeId ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                        >
                          <span className="product-icon">
                            <Icon name="can" size={36} />
                          </span>
                          <b className="product-title">{lang === "ta" ? p.ta : p.name}</b>
                          <strong className="product-price-tag">{formatMoney(p.price)}</strong>
                          <span className="stock-badge">
                            {hasValidTypeId ? `${p.stock} ${p.unit || t("stock")}` : (lang === "ta" ? "தேர்வு செய்ய முடியாது" : "Not selectable")}
                          </span>
                        </button>
                        <div className="quantity-control">
                          <button type="button" disabled={!hasValidTypeId} onClick={() => add(p, -1)} aria-label="Decrease quantity">
                            <Icon name="minus" size={16} />
                          </button>
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            disabled={!hasValidTypeId}
                            value={displayQty}
                            onChange={(e) => handleQuantityChange(p, e.target.value)}
                            onBlur={() => handleQuantityCommit(p)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                            style={{
                              width: 48,
                              height: 36,
                              textAlign: "center",
                              fontWeight: 900,
                              fontSize: 16,
                              border: "1px solid #cbd5e1",
                              borderRadius: 8,
                              background: hasValidTypeId ? "#ffffff" : "#f1f5f9",
                              margin: "0 4px",
                              cursor: hasValidTypeId ? "text" : "not-allowed",
                            }}
                          />
                          <button type="button" disabled={!hasValidTypeId} onClick={() => add(p, 1)} aria-label="Increase quantity">
                            <Icon name="plus" size={16} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="workflow-card live-cart-pane">
            <div className="live-cart-header">
              <span className="avatar">{customer.name[0]}</span>
              <div>
                <b>{customer.name}</b>
                <small>{customer.phone}</small>
              </div>
              <span className="live-pill" style={{ marginLeft: "auto", fontSize: 11 }}>
                {lang === "ta" ? `கடன்: ${formatMoney(customer.balance)}` : `Debt: ${formatMoney(customer.balance)}`}
              </span>
            </div>

            <div className="cart-items-list inside-scroll">
              {Object.entries(cart).filter(([, q]) => q > 0).length === 0 ? (
                <div className="empty-cart-hint">
                  <Icon name="sale" size={32} />
                  <span>{t("chooseItems")}</span>
                </div>
              ) : (
                Object.entries(cart)
                  .filter(([, q]) => q > 0)
                  .map(([key, q]) => {
                    const prod = products.find((p) => getProductKey(p) === key);
                    if (!prod) {
                      return (
                        <div className="cart-item-row unavailable" key={key} style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "8px 10px" }}>
                          <div className="item-meta">
                            <b style={{ color: "#dc2626" }}>{lang === "ta" ? "கிடைக்காத பொருள்" : "Unavailable SKU"}</b>
                            <small style={{ color: "#991b1b" }}>ID: {key.slice(0, 8)}... × {q}</small>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setCart((prev) => {
                                const next = { ...prev };
                                delete next[key];
                                return next;
                              });
                              setEditingQty((prev) => {
                                const next = { ...prev };
                                delete next[key];
                                return next;
                              });
                            }}
                            style={{ padding: "4px 8px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 700 }}
                          >
                            ✕
                          </button>
                        </div>
                      );
                    }
                    const displayQty = editingQty[key] !== undefined ? editingQty[key] : String(q);
                    return (
                      <div className="cart-item-row" key={key}>
                        <div className="item-meta">
                          <b>{lang === "ta" ? prod.ta : prod.name}</b>
                          <small>{formatMoney(prod.price)} × {q} {prod.unit || ""}</small>
                        </div>
                        <div className="item-stepper">
                          <button type="button" onClick={() => add(prod, -1)}>-</button>
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={displayQty}
                            onChange={(e) => handleQuantityChange(prod, e.target.value)}
                            onBlur={() => handleQuantityCommit(prod)}
                            style={{
                              width: 44,
                              height: 32,
                              textAlign: "center",
                              fontWeight: 900,
                              fontSize: 15,
                              border: "1px solid #cbd5e1",
                              borderRadius: 6,
                              background: "#ffffff",
                              margin: "0 2px",
                            }}
                          />
                          <button type="button" onClick={() => add(prod, 1)}>+</button>
                        </div>
                        <strong className="item-subtotal">{formatMoney(prod.price * q)}</strong>
                      </div>
                    );
                  })
              )}
            </div>

            <div className="live-cart-footer">
              <div className="cart-total-bar">
                <span>{t("total")}</span>
                <b>{formatMoney(subtotal)}</b>
              </div>
              <div className="cart-actions-row">
                <button className="back-step-btn" onClick={() => setStep(1)}>
                  ← {t("back")}
                </button>
                <button className="next-step-btn" disabled={!subtotal || hasMissingCartItems} onClick={() => setStep(3)}>
                  {t("next")} →
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* STEP 3: Pay & Save (Full-Screen Side-by-Side Layout) */}
      {step === 3 && (
        <section className="sale-step3-layout">
          {/* Left Column: Order Summary & Customer Account Breakdown */}
          <div className="workflow-card sale-step3-col inside-scroll" style={{ padding: 22 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
              <span className="success-mark" style={{ width: 48, height: 48, margin: 0 }}>
                <Icon name="receipt" size={28} />
              </span>
              <div>
                <b style={{ fontSize: 18 }}>{customer.name}</b>
                <small style={{ display: "block", color: "#64748b" }}>
                  {customer.phone || "No phone added"} {customer.address ? `• ${customer.address}` : ""}
                </small>
              </div>
            </div>

            {/* Cart Items List */}
            {hasMissingCartItems && (
              <div style={{ padding: 12, marginBottom: 12, background: "#fef2f2", border: "1px solid #f87171", borderRadius: 8, color: "#991b1b" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <b style={{ fontSize: 13 }}>{lang === "ta" ? "கிடைக்காத பொருட்கள் வரைவில் உள்ளன:" : "Unavailable Items in Draft:"}</b>
                    <small style={{ display: "block", color: "#b91c1c" }}>
                      {lang === "ta" ? "இன்வாய்ஸ் சேமிக்க கிடைக்காத பொருட்களை நீக்கவும்." : "Remove unavailable items to enable saving this invoice."}
                    </small>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCart((prev) => {
                        const next = { ...prev };
                        missingCartEntries.forEach(([k]) => delete next[k]);
                        return next;
                      });
                      setEditingQty((prev) => {
                        const next = { ...prev };
                        missingCartEntries.forEach(([k]) => delete next[k]);
                        return next;
                      });
                    }}
                    style={{
                      padding: "4px 10px",
                      background: "#dc2626",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      fontWeight: 700,
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {lang === "ta" ? "நீக்குக" : "Remove"}
                  </button>
                </div>
              </div>
            )}
            <h4 style={{ margin: "8px 0 6px 0", fontSize: 13, textTransform: "uppercase", color: "#64748b", letterSpacing: "0.05em" }}>
              {lang === "ta" ? "ஆர்டர் பொருட்கள் (Order Items)" : "Order Items"}
            </h4>
            <div style={{ background: "#f8fafc", borderRadius: 10, padding: "8px 12px", border: "1px solid #e2e8f0", marginBottom: 14, maxHeight: 180, overflowY: "auto" }}>
              {Object.entries(cart).filter(([, q]) => q > 0).map(([key, q]) => {
                const prod = products.find((p) => getProductKey(p) === key);
                if (!prod) {
                  return (
                    <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px dashed #fca5a5", fontSize: 13, color: "#dc2626" }}>
                      <span>
                        <b>{lang === "ta" ? "கிடைக்காத பொருள்" : "Unavailable SKU"}</b> <small>({key.slice(0, 8)}... × {q})</small>
                      </span>
                      <b>-</b>
                    </div>
                  );
                }
                return (
                  <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px dashed #f1f5f9", fontSize: 13 }}>
                    <span>
                      {lang === "ta" ? prod.ta : prod.name} <small style={{ color: "#64748b" }}>× {q} {prod.unit || ""}</small>
                    </span>
                    <b>{formatMoney(prod.price * q)}</b>
                  </div>
                );
              })}
            </div>

            <label className="large-cash-box" style={{marginBottom: 10}}>
              <span>{lang === "ta" ? "தள்ளுபடி (Rs.)" : "Discount (Rs.)"}</span>
              <input type="number" min="0" max={subtotal} step="0.01" value={discountInput}
                onChange={(e) => setDiscountInput(e.target.value)} placeholder="0" />
            </label>
            {invalidDiscount && <p role="alert">{lang === "ta" ? "தள்ளுபடியை சரிபார்க்கவும்." : "Enter a discount no greater than the subtotal."}</p>}
            {/* Customer Outstanding Credit & Today's Invoice Breakdown */}
            <div className="kadan-breakdown-box">
              <div className="breakdown-row">
                <span>{customer.balance < 0 ? (lang === "ta" ? "முந்தைய வரவு" : "Previous Credit") : (lang === "ta" ? "பழைய கடன்" : "Previous Debt")}</span>
                <b>{formatMoney(Math.abs(customer.balance))}</b>
              </div>
              <div className="breakdown-row highlight">
                <span>{lang === "ta" ? "இன்றைய இன்வாய்ஸ் (Today's Invoice)" : "Today's Invoice Total"}</span>
                <b>{formatMoney(total)}</b>
              </div>
              <div className="breakdown-row total-row">
                <span>{lang === "ta" ? "மொத்த நிலுவை (Total Outstanding)" : "Total Outstanding"}</span>
                <strong>{formatMoney(customer.balance + total)}</strong>
              </div>
            </div>

            {/* 19L Empty Cans Return & 4-Line Can Summary */}
            <div className="returnable-cans-summary-panel" style={{ marginTop: 14, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="can" size={20} />
                  <b style={{ fontSize: 14, color: "#0f172a" }}>
                    {lang === "ta" ? "19L திரும்பப் பெறும் கேன்கள் கணக்கு" : "19L Returnable Cans Account"}
                  </b>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#ffffff", padding: "8px 12px", borderRadius: 8, border: "1px solid #cbd5e1", marginBottom: 10 }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>
                    {lang === "ta" ? "காலி கேன் வரவு (Empties Received):" : "Empty Cans Received:"}
                  </span>
                  <small style={{ display: "block", color: "#64748b" }}>
                    {lang === "ta" ? `வாடிக்கையாளரிடம் உள்ளது: ${cansAlreadyWithCustomer} கேன்கள்` : `Customer holds: ${cansAlreadyWithCustomer} cans`}
                  </small>
                </div>
                <div className="large-cash-box mini-box" style={{ width: 90, margin: 0 }}>
                  <Icon name="can" size={16} />
                  <input
                    type="number"
                    min="0"
                    value={cansReturning}
                    onChange={(e) => setCansReturning(e.target.value)}
                    placeholder="0"
                    style={{ width: "100%", textAlign: "center", fontWeight: 800, fontSize: 16 }}
                  />
                </div>
              </div>

              {numCansReturn > 0 && canOptions.size > 1 && (
                <label>
                  {lang === "ta" ? "கேன் வகை" : "Can type"}
                  <select value={returnCanType} onChange={(e) => setReturnCanType(e.target.value)}>
                    <option value="">{lang === "ta" ? "வகையைத் தேர்ந்தெடு" : "Choose type"}</option>
                    {[...canOptions.values()].map((row) => <option key={row.type_id} value={row.type_id}>{lang === "ta" ? row.ta || row.name : row.name} ({row.held})</option>)}
                  </select>
                </label>
              )}
              {invalidCans && <p role="alert">{lang === "ta" ? "கேன் வகையையும் எண்ணிக்கையையும் சரிபார்க்கவும்." : "Check the can type and quantity."}</p>}
              {/* 4-Line Can Balance Specification */}
              <div style={{ background: "#f1f5f9", borderRadius: 8, padding: "10px 12px", fontSize: 13, display: "grid", gap: 6, border: "1px solid #e2e8f0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", color: "#475569" }}>
                  <span>{lang === "ta" ? `${customer.name} வசம் உள்ள கேன்கள்:` : `Cans already with ${customer.name}:`}</span>
                  <b>{cansAlreadyWithCustomer}</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", color: "#0284c7" }}>
                  <span>{lang === "ta" ? "இன்று வழங்கப்பட்ட கேன்கள்:" : "Filled cans given today:"}</span>
                  <b>+{filledCansGiven}</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", color: "#15803d" }}>
                  <span>{lang === "ta" ? "பெறப்பட்ட காலி கேன்கள்:" : "Empty cans received:"}</span>
                  <b>−{numCansReturn}</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px dashed #cbd5e1", paddingTop: 6, marginTop: 2, fontWeight: 800, color: "#0f172a" }}>
                  <span>{lang === "ta" ? `விற்பனைக்குப் பின் ${customer.name} வசம் உள்ளவை:` : `Cans with ${customer.name} after this sale:`}</span>
                  <b style={{ color: cansAfterSale > 0 ? "#0284c7" : "#334155" }}>{cansAfterSale}</b>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Payment & Tender Controls */}
          <div className="workflow-card sale-step3-col inside-scroll" style={{ padding: 22 }}>
            <p className="eyebrow" style={{ margin: "0 0 8px 0" }}>
              {lang === "ta" ? "செலுத்தும் முறை" : "Payment Mode"}
            </p>
            <div className="payment-types" style={{ margin: "0 0 14px 0" }}>
              <button
                type="button"
                className={payMode === "cash" ? "selected" : ""}
                onClick={() => {
                  setPayMode("cash");
                  setCashManuallyOverridden(false);
                  setCashReceived(String(total));
                }}
              >
                <Icon name="cash" size={20} />
                {t("cash")}
                {payMode === "cash" && <Icon name="check" size={14} />}
              </button>
              <button
                type="button"
                className={payMode === "credit" ? "selected" : ""}
                onClick={() => {
                  setPayMode("credit");
                  setCashManuallyOverridden(true);
                  setCashReceived("0");
                }}
              >
                <Icon name="calendar" size={20} />
                {t("credit")} ({lang === "ta" ? "கடன்" : "Debt"})
                {payMode === "credit" && <Icon name="check" size={14} />}
              </button>
              <button
                type="button"
                className={payMode === "custom" ? "selected" : ""}
                onClick={() => {
                  setPayMode("custom");
                  if (!cashReceived) setCashReceived(String(total));
                }}
              >
                <Icon name="wallet" size={20} />
                {lang === "ta" ? "பகுதி / அதிக தொகை" : "Custom Tender"}
                {payMode === "custom" && <Icon name="check" size={14} />}
              </button>
            </div>

            {payMode !== "credit" && (
              <div className="tender-section" style={{ width: "100%", marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <label style={{ fontWeight: 700, fontSize: 14 }}>
                    {lang === "ta" ? "பெற்ற ரொக்கம் (Cash Received):" : "Cash Received:"}
                  </label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      style={{ padding: "4px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #cbd5e1", background: "#f8fafc", cursor: "pointer" }}
                      onClick={() => {
                        setCashReceived(String(total));
                        setCashManuallyOverridden(false);
                      }}
                    >
                      {formatMoney(total)} ({lang === "ta" ? "சரியாக" : "Exact"})
                    </button>
                    {excessCash === 0 && (
                      <button
                        type="button"
                        style={{ padding: "4px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #cbd5e1", background: "#f8fafc", cursor: "pointer" }}
                        onClick={() => {
                          setCashReceived(String(Math.ceil(total / 500) * 500 || total + 500));
                          setCashManuallyOverridden(true);
                        }}
                      >
                        {formatMoney(Math.ceil(total / 500) * 500 || total + 500)}
                      </button>
                    )}
                    <button
                      type="button"
                      style={{ padding: "4px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #cbd5e1", background: "#f8fafc", cursor: "pointer" }}
                      onClick={() => {
                        setCashReceived("2000");
                        setCashManuallyOverridden(true);
                      }}
                    >
                      {formatMoney(2000)}
                    </button>
                  </div>
                </div>
                <div className="large-cash-box">
                  <span className="cash-box-prefix">Rs.</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={cashReceived}
                    onChange={(e) => {
                      setCashReceived(e.target.value);
                      setCashManuallyOverridden(true);
                    }}
                    placeholder={String(total)}
                    style={{ fontSize: 20, fontWeight: 700 }}
                  />
                </div>

                {/* Excess cash options: apply to old debt or give change */}
                {numCashReceived > total && previousDebt > 0 && (
                  <div style={{ marginTop: 12, padding: 12, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontWeight: 700, color: "#166534" }}>
                        <input
                          type="checkbox"
                          checked={applyToOldDebt}
                          onChange={(e) => setApplyToOldDebt(e.target.checked)}
                          style={{ width: 18, height: 18 }}
                        />
                        <span>{lang === "ta" ? "பழைய கடனுக்கு வரவு வைக்கவும்" : "Apply excess to old debt"}</span>
                      </label>
                      <span style={{ fontSize: 12, color: "#15803d" }}>
                        {applyToOldDebt ? (lang === "ta" ? "இயக்கத்தில் உள்ளது" : "Active") : (lang === "ta" ? "சில்லறை கொடுக்கப்படும்" : "Change instead")}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: "#14532d", display: "grid", gap: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>{lang === "ta" ? "இந்த பில்லுக்கு:" : "Applied to this invoice:"}</span>
                        <b>{formatMoney(appliedToBill)}</b>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>{lang === "ta" ? "பழைய கடனுக்கு வரவு:" : "Applied to old debt:"}</span>
                        <b>{formatMoney(appliedToDebt)}</b>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>{lang === "ta" ? "திருப்பித் தரும் சில்லறை:" : "Change returned:"}</span>
                        <b style={{ color: "#15803d" }}>{formatMoney(changeReturned)}</b>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px dashed #86efac", paddingTop: 4, marginTop: 4 }}>
                        <span>{lang === "ta" ? "மீதமுள்ள பழைய கடன்:" : "Remaining old debt:"}</span>
                        <b style={{ color: "#b45309" }}>{formatMoney(Math.max(0, previousDebt - appliedToDebt))}</b>
                      </div>
                    </div>
                  </div>
                )}

                {numCashReceived > total && previousDebt === 0 && (
                  <div style={{ marginTop: 10, padding: 10, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "#1e40af", fontWeight: 600 }}>
                      {lang === "ta" ? "திருப்பித் தரும் சில்லறை (Change to return):" : "Change to return:"}
                    </span>
                    <b style={{ color: "#15803d", fontSize: 18 }}>{formatMoney(changeReturned)}</b>
                  </div>
                )}
              </div>
            )}

            <div className="resulting-balance-banner" style={{ marginTop: "auto", marginBottom: 14 }}>
              <span>{lang === "ta" ? "பில்லுக்குப் பின் மொத்த கடன்:" : "Total Debt After Bill:"}</span>
              <b style={{ color: newBalance > 0 ? "#b45309" : "#15803d" }}>{formatMoney(newBalance)}</b>
            </div>

            {checkoutError && (
              <div style={{ marginBottom: 12, padding: 12, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#dc2626" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <Icon name="warning" size={18} />
                  <b>{checkoutError}</b>
                </div>
                <button
                  type="button"
                  style={{ padding: "6px 12px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}
                  onClick={() => {
                    loadData();
                    setCheckoutError(null);
                  }}
                >
                  {lang === "ta" ? "கணக்கை சரிபார்த்து புதுப்பிக்கவும்" : "Refresh invoice details"}
                </button>
              </div>
            )}



            <div className="summary-actions">
              <button className="back-step-btn" onClick={() => setStep(2)}>
                ← {t("back")}
              </button>
              <button className="primary-action" style={{width: "100%"}} disabled={saving || pendingCheckout || invalidCans || invalidCash || invalidDiscount || !subtotal || hasMissingCartItems} onClick={() => saveInvoice()}>
                <Icon name="check" size={22} />
                {saving ? "..." : `${t("saveBill")} (${formatMoney(total)})`}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Add Customer Modal */}
      <AddCustomerModal
        isOpen={showAddCustomerModal}
        onClose={() => setShowAddCustomerModal(false)}
        token={token}
        onSuccess={(newCust) => {
          setCustomers((prev) => [newCust, ...prev]);
          setCustomer(newCust);
        }}
      />

      {/* Invoice Generated & Print Modal */}
      {createdInvoice && (
        <PrintInvoiceModal
          invoice={createdInvoice}
          onClose={() => {
            setCreatedInvoice(null);
            setStep(1);
          }}
        />
      )}
    </div>
  );
}
