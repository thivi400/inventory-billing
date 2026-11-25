import { useState, useEffect, useRef } from "react";
import { useApp } from "../context/AppContext";
import { api } from "../services/api";
import type { IconName, Product, Role } from "../types";
import { Icon } from "../components/Icon";
import { AddProductModal } from "../components/modals/AddProductModal";
import { EditProductModal } from "../components/modals/EditProductModal";
import { formatMoney } from "../utils/formatters";

// Six canonical default stock cards in required order:
// 1. 500 ml
// 2. 1 L
// 3. 1.5 L
// 4. 5 L
// 5. 19 L
// 6. 19 L Empty Can
export interface StarterSlotSpec {
  rank: number;
  label: string;
  taLabel: string;
  unit: string;
  icon: IconName;
  matchSkus: string[];
  matchNames: string[];
}

export const STARTER_SLOTS: StarterSlotSpec[] = [
  {
    rank: 1,
    label: "500 ml",
    taLabel: "500மிலி",
    unit: "bottle",
    icon: "bottle",
    matchSkus: ["SKU-500ML", "500ML", "SKU-500", "SKU-WAT-500"],
    matchNames: ["500 ml Water", "500ml Water", "500 ml", "500ml"],
  },
  {
    rank: 2,
    label: "1 L",
    taLabel: "1 லிட்டர்",
    unit: "bottle",
    icon: "bottle",
    matchSkus: ["SKU-1L", "1L", "SKU-WAT-1L"],
    matchNames: ["1 L Water", "1L Water", "1 L", "1L"],
  },
  {
    rank: 3,
    label: "1.5 L",
    taLabel: "1.5 லிட்டர்",
    unit: "bottle",
    icon: "bottle",
    matchSkus: ["SKU-1.5L", "1.5L", "SKU-WAT-1.5L"],
    matchNames: ["1.5 L Water", "1.5L Water", "1.5 L", "1.5L"],
  },
  {
    rank: 4,
    label: "5 L",
    taLabel: "5 லிட்டர்",
    unit: "can",
    icon: "can",
    matchSkus: ["SKU-5L", "5L", "SKU-WAT-5L"],
    matchNames: ["5 L Water", "5L Water", "5 L", "5L"],
  },
  {
    rank: 5,
    label: "19 L Filled",
    taLabel: "19 லிட்டர் நிரப்பியது",
    unit: "can",
    icon: "can",
    matchSkus: ["SKU-19L", "19L", "SKU-19L-FILLED", "SKU-WAT-19L"],
    matchNames: ["19 L Water (filled)", "19L Water (filled)", "19 L Water", "19L Water", "19 L", "19L"],
  },
  {
    rank: 6,
    label: "19 L Empty Can",
    taLabel: "19 லிட்டர் காலி கேன்",
    unit: "can",
    icon: "can",
    matchSkus: ["SKU-19L-EMPTY", "SKU-TEST-CAN-20L", "CAN-20L", "SKU-CAN-20L"],
    matchNames: ["19 L Bottle (empty/new)", "19 L Empty Can", "Premium 20L Can (New)"],
  },
];

export function Stock({
  token,
  role,
  onGoHome,
}: {
  token: string;
  role: Role;
  onGoHome?: () => void;
}) {
  const { t, lang, speak, showToast } = useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [qty, setQty] = useState("");
  const [batchBuyingPrice, setBatchBuyingPrice] = useState("");
  const [sellingPrice, setSellingPrice] = useState("");
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [showEditProductModal, setShowEditProductModal] = useState(false);
  const [focusBuyingCostInModal, setFocusBuyingCostInModal] = useState(false);

  // Batch queue & history modal state
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [historyTab, setHistoryTab] = useState<"batches" | "movements">("batches");
  const [activeBatches, setActiveBatches] = useState<any[]>([]);
  const [stockMovements, setStockMovements] = useState<any[]>([]);
  const historyRequest = useRef(0);
  const [historyError, setHistoryError] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Stock Reduction (Damage / Expiry / Adjustment)
  const [showReduceDamage, setShowReduceDamage] = useState(false);
  const [reduceQty, setReduceQty] = useState("");
  const [selectedBatchId, setSelectedBatchId] = useState<string>("");
  const [adjustReason, setAdjustReason] = useState<"damaged" | "expired" | "adjustment">("damaged");
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const isManagerOrOwner = role === "owner" || role === "manager";
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const lastStockReqIdRef = useRef<number>(0);

  const loadProducts = () => {
    const reqId = ++lastStockReqIdRef.current;
    setLoadingProducts(true);
    setProductsError(null);
    const url = showArchived ? "/products/list?show_archived=true" : "/products/list";
    api
      .get<{ products?: Partial<Product>[] } | Partial<Product>[]>(url, token)
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

        setProducts(mapped);
        setSelectedProduct((curr) => {
          if (curr && curr.type_id) {
            const found = mapped.find((m) => m.type_id === curr.type_id);
            if (found) return found;
          }
          return null;
        });
        setLoadingProducts(false);
      })
      .catch((err) => {
        if (reqId !== lastStockReqIdRef.current) return;
        console.error("Failed to load products:", err);
        setProductsError(err instanceof Error ? err.message : "Failed to load products");
        setLoadingProducts(false);
      });
  };

  const loadBatchesAndMovements = (typeId?: string) => {
    const tid = typeId || selectedProduct?.type_id;
    if (!tid) return;
    const request = ++historyRequest.current;
    setHistoryError(false);
    setLoadingHistory(true);
    Promise.all([
      api.get<any[]>(`/stock/batches?type_id=${encodeURIComponent(tid)}`, token),
      api.get<any[]>(`/stock/movements?type_id=${encodeURIComponent(tid)}`, token),
    ])
      .then(([batches, movements]) => {
        if (request !== historyRequest.current) return;
        if (Array.isArray(batches)) setActiveBatches(batches);
        if (Array.isArray(movements)) setStockMovements(movements);
      })
      .catch(() => { if (request === historyRequest.current) setHistoryError(true); })
      .finally(() => { if (request === historyRequest.current) setLoadingHistory(false); });
  };

  useEffect(() => {
    loadProducts();
    const handleRefresh = () => {
      loadProducts();
    };
    window.addEventListener("refresh-stock-data", handleRefresh);
    return () => window.removeEventListener("refresh-stock-data", handleRefresh);
  }, [token, showArchived]);

  useEffect(() => {
    if (selectedProduct) {
      setSellingPrice(String(selectedProduct.price ?? ""));
      setQty("");
      // Pre-fill batch buying cost with product's default buying price if set
      if (selectedProduct.buying_price !== null && selectedProduct.buying_price !== undefined) {
        setBatchBuyingPrice(String(selectedProduct.buying_price));
      } else {
        setBatchBuyingPrice("");
      }
      setReduceQty("");
      setSelectedBatchId("");
      setShowReduceDamage(false);
      loadBatchesAndMovements(selectedProduct.type_id);
    } else {
      setSellingPrice("");
      setQty("");
      setBatchBuyingPrice("");
      setReduceQty("");
      setSelectedBatchId("");
      setShowReduceDamage(false);
    }
  }, [selectedProduct?.type_id]);

  // Direct Stock Receive
  const handleAddStock = async () => {
    if (!isManagerOrOwner || !selectedProduct) return;
    const numQty = Number(qty);
    if (!numQty || numQty <= 0) {
      setStatusMsg({ type: "error", text: lang === "ta" ? "சேர்க்க வேண்டிய எண்ணிக்கை உள்ளிடவும்" : "Please enter a valid quantity" });
      return;
    }

    const payload: Record<string, any> = {
      type_id: selectedProduct.type_id,
      quantity: numQty,
      selling_price: selectedProduct.price,
    };

    if (batchBuyingPrice.trim() !== "") {
      payload.buying_price = Number(batchBuyingPrice);
    } else if (selectedProduct.buying_price !== null && selectedProduct.buying_price !== undefined) {
      payload.buying_price = selectedProduct.buying_price;
    } else {
      setStatusMsg({
        type: "error",
        text: lang === "ta"
          ? "அடக்க விலை தேவை. (பொருளுக்கு அடிப்படை அடக்க விலை அமைக்கப்படவில்லை)"
          : "Buying cost is required because this product has no default buying cost set."
      });
      return;
    }

    setSaving(true);
    setStatusMsg(null);
    try {
      await api.post("/stock/receive", payload, token);
      speak("Stock added successfully", "சரக்கு வெற்றிகரமாக சேர்க்கப்பட்டது");
      setStatusMsg({
        type: "success",
        text: lang === "ta" ? `சரக்கு சேர்க்கப்பட்டது: +${numQty} (${selectedProduct.ta})` : `Stock added: +${numQty} (${selectedProduct.name})`,
      });
      setQty("");
      loadProducts();
      loadBatchesAndMovements(selectedProduct.type_id);
      window.dispatchEvent(new CustomEvent("refresh-stock-data"));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to add stock";
      speak("Stock update failed", "சரக்கு புதுப்பிக்கப்படவில்லை");
      setStatusMsg({ type: "error", text: message });
    } finally {
      setSaving(false);
    }
  };

  // Direct Update Selling Price
  const handleUpdatePrice = async () => {
    if (!isManagerOrOwner || !selectedProduct) return;
    const newPrice = Number(sellingPrice);
    if (isNaN(newPrice) || newPrice < 0) {
      setStatusMsg({ type: "error", text: lang === "ta" ? "சரியான விலையை உள்ளிடவும்" : "Enter a valid price" });
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      await api.post(
        "/products/update",
        {
          type_id: selectedProduct.type_id,
          name: selectedProduct.name,
          selling_price: newPrice,
        },
        token
      );
      speak("Price updated", "விலை மாற்றப்பட்டது");
      setStatusMsg({
        type: "success",
        text: lang === "ta" ? `விற்பனை விலை ${formatMoney(newPrice)} ஆக மாற்றப்பட்டது!` : `Selling price updated to ${formatMoney(newPrice)}!`,
      });
      setSelectedProduct({ ...selectedProduct, price: newPrice });
      setProducts((prev) => prev.map((p) => (p.type_id === selectedProduct.type_id ? { ...p, price: newPrice } : p)));
      loadProducts();
      loadBatchesAndMovements(selectedProduct.type_id);
      window.dispatchEvent(new CustomEvent("refresh-stock-data"));
    } catch (err: unknown) {
      setStatusMsg({ type: "error", text: err instanceof Error ? err.message : "Failed to update price" });
    } finally {
      setSaving(false);
    }
  };

  // Archive or Restore Product
  const handleToggleArchiveProduct = async (prod: Product, action: "archive" | "restore") => {
    if (!isManagerOrOwner) return;
    const isArchiving = action === "archive";
    const confirmMsg = isArchiving
      ? (lang === "ta" ? `பொருள் '${prod.name}' ஐ முடக்க (Archive) வேண்டுமா?` : `Archive product '${prod.name}'?`)
      : (lang === "ta" ? `பொருள் '${prod.name}' ஐ மீண்டும் இயக்க (Restore) வேண்டுமா?` : `Restore product '${prod.name}'?`);
    if (!window.confirm(confirmMsg)) return;

    setStatusMsg(null);
    try {
      await api.post(
        "/products/archive",
        { type_id: prod.type_id, action },
        token
      );
      speak(
        isArchiving ? "Product archived" : "Product restored",
        isArchiving ? "பொருள் முடக்கப்பட்டது" : "பொருள் மீண்டும் இயக்கப்பட்டது"
      );
      showToast(
        isArchiving
          ? (lang === "ta" ? `பொருள் '${prod.name}' முடக்கப்பட்டது.` : `Product '${prod.name}' archived.`)
          : (lang === "ta" ? `பொருள் '${prod.name}' மீண்டும் இயக்கப்பட்டது.` : `Product '${prod.name}' restored.`),
        "success"
      );
      if (isArchiving && selectedProduct?.type_id === prod.type_id) {
        setSelectedProduct(null);
      }
      loadProducts();
      window.dispatchEvent(new CustomEvent("refresh-stock-data"));
    } catch (err: unknown) {
      setStatusMsg({ type: "error", text: err instanceof Error ? err.message : "Failed to change archive state" });
    }
  };

  // Stock Reduction with Specific Batch Support
  const handleReduceStock = async () => {
    if (!isManagerOrOwner || !selectedProduct) return;
    const numQty = Number(reduceQty);
    if (!numQty || numQty <= 0) {
      setStatusMsg({ type: "error", text: lang === "ta" ? "குறைக்க வேண்டிய எண்ணிக்கை உள்ளிடவும்" : "Please enter quantity to reduce" });
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      await api.post(
        "/stock/adjust",
        {
          type_id: selectedProduct.type_id,
          batch_id: selectedBatchId || undefined,
          quantity: numQty,
          reason: adjustReason,
        },
        token,
      );
      speak("Stock reduced successfully", "சரக்கு வெற்றிகரமாக குறைக்கப்பட்டது");
      setStatusMsg({
        type: "success",
        text: lang === "ta" ? `சரக்கு குறைக்கப்பட்டது: -${numQty} (${selectedProduct.ta})` : `Stock reduced: -${numQty} (${selectedProduct.name})`,
      });
      setReduceQty("");
      setSelectedBatchId("");
      setShowReduceDamage(false);
      loadProducts();
      loadBatchesAndMovements(selectedProduct.type_id);
      window.dispatchEvent(new CustomEvent("refresh-stock-data"));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to reduce stock";
      speak("Stock reduction failed", "சரக்கு குறைக்கப்படவில்லை");
      setStatusMsg({ type: "error", text: message });
    } finally {
      setSaving(false);
    }
  };

  // Match 6 starter slots to explicit catalog SKUs/names; unclaimed SKUs flow to otherProducts
  const claimedTypeIds = new Set<string>();
  const starterCards: Array<{ slot: StarterSlotSpec; product: Product | null }> = STARTER_SLOTS.map((slot) => {
    const candidates = products.filter((p) => p.type_id && !claimedTypeIds.has(p.type_id));
    const bySku = candidates.find(p => p.sku && slot.matchSkus.some(sku => sku.toLowerCase() === p.sku!.trim().toLowerCase()));
    const byName = candidates.filter((p) => {
      if (!p.type_id || claimedTypeIds.has(p.type_id)) return false;

      // 2. Explicit exact name match
      const pName = p.name.trim().toLowerCase();
      if (slot.matchNames.some((m) => m.toLowerCase() === pName)) {
        if (slot.rank === 5 && (pName.includes("empty") || (p.is_returnable && !pName.includes("filled") && !pName.includes("water")))) {
          return false;
        }
        if (slot.rank === 6 && !pName.includes("empty") && !p.is_returnable) {
          return false;
        }
        return true;
      }
      return false;
    });

    const match = bySku ?? (byName.length === 1 ? byName[0] : undefined);
    if (match && match.type_id) {
      claimedTypeIds.add(match.type_id);
      return { slot, product: match };
    }
    return { slot, product: null };
  });

  // Every real active SKU not displayed in starter slots goes into Other Products (even if same size)
  const otherProducts = products.filter((p) => p.type_id && !claimedTypeIds.has(p.type_id));

  return (
    <div className="workflow-page stock-page">
      <div className="page-title compact" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <p className="eyebrow">{t("stock")}</p>
          <h1>{lang === "ta" ? "சரக்கு இருப்பு & விலை மேலாண்மை" : "Stock Inventory & Pricing"}</h1>
        </div>
        <div className="page-title-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Active / Archived Toggle */}
          <button
            type="button"
            className="tab-toggle-btn"
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
              ? (lang === "ta" ? "முடக்கப்பட்ட பொருட்கள் (Archived)" : "Showing Archived Only")
              : (lang === "ta" ? "செயலில் உள்ள பொருட்கள் (Active)" : "Showing Active Only")}
          </button>
        </div>
      </div>

      {statusMsg && (
        <div className={`status-banner ${statusMsg.type}`} style={{ marginBottom: 12 }}>
          <Icon name={statusMsg.type === "success" ? "check" : "warning"} size={18} />
          <span>{statusMsg.text}</span>
        </div>
      )}

      <section className="stock-layout">
        {/* Left Column: Product Grid */}
        <div className="workflow-card product-picker-card inside-scroll">
          {showArchived ? (
            /* Archived Products List View */
            <div className="archived-products-container">
              <div className="category-section-label" style={{ marginBottom: 12 }}>
                <span>{lang === "ta" ? "முடக்கப்பட்ட பொருட்கள் (Archived Products)" : "Archived Products"}</span>
              </div>
              {products.length === 0 ? (
                <div style={{ padding: 30, textAlign: "center", color: "#94a3b8" }}>
                  {lang === "ta" ? "முடக்கப்பட்ட பொருட்கள் எதுவும் இல்லை." : "No archived products found."}
                </div>
              ) : (
                <div className="archived-items-list" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {products.map((p) => (
                    <div
                      key={p.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "12px 14px",
                        background: "#fff",
                        border: "1px solid #e2e8f0",
                        borderRadius: 8,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Icon name={p.icon} size={24} />
                        <div>
                          <b style={{ display: "block", fontSize: 14 }}>{lang === "ta" ? p.ta : p.name}</b>
                          <small style={{ color: "#64748b" }}>Rate: {formatMoney(p.price)} • Stock: {p.stock}</small>
                        </div>
                      </div>
                      {isManagerOrOwner && (
                        <button
                          type="button"
                          className="btn-primary-small"
                          onClick={() => handleToggleArchiveProduct(p, "restore")}
                          style={{ padding: "6px 12px", background: "#16a34a", borderColor: "#16a34a", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700 }}
                        >
                          {lang === "ta" ? "மீட்க (Restore)" : "Restore"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* Active Mode: 6 Default Cards strictly in order */
            <div>
              {productsError && (
                <div style={{ padding: 12, marginBottom: 12, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#b91c1c" }}>
                  <p style={{ margin: 0, fontWeight: 700 }}>
                    {lang === "ta" ? "சரக்கு விவரங்களை ஏற்ற முடியவில்லை:" : "Failed to load stock data:"} {productsError}
                  </p>
                  <button
                    type="button"
                    onClick={() => loadProducts()}
                    style={{ marginTop: 6, padding: "4px 10px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, fontWeight: 700, cursor: "pointer", fontSize: 12 }}
                  >
                    {lang === "ta" ? "மீண்டும் முயற்சிக்கவும் (Retry)" : "Retry"}
                  </button>
                </div>
              )}
              <div className="category-section-label" style={{ marginBottom: 10 }}>
                <span>{lang === "ta" ? "சரக்கு வகைகள் (Stock Products)" : "Stock Products"}</span>
              </div>

              {/* Six default cards in exact order */}
              <div className="product-grid compact" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                {starterCards.map(({ slot, product: p }) => {
                  if (!p) {
                    return (
                      <div
                        className="product-card slot-not-set-up"
                        key={`starter-slot-${slot.rank}`}
                        style={{
                          minHeight: 120,
                          position: "relative",
                          opacity: 0.55,
                          background: "#f8fafc",
                          border: "1.5px dashed #cbd5e1",
                          cursor: "not-allowed",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 12,
                          borderRadius: 12,
                        }}
                      >
                        <span className="product-icon" style={{ opacity: 0.5 }}>
                          <Icon name={slot.icon} size={30} />
                        </span>
                        <b className="product-title" style={{ fontSize: 13, marginTop: 4, color: "#64748b" }}>
                          {lang === "ta" ? slot.taLabel : slot.label}
                        </b>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: "#94a3b8",
                            marginTop: 6,
                            background: "#e2e8f0",
                            padding: "2px 8px",
                            borderRadius: 4,
                          }}
                        >
                          {lang === "ta" ? "அமைக்கப்படவில்லை" : "Not set up"}
                        </span>
                      </div>
                    );
                  }

                  const isSelected = selectedProduct && selectedProduct.type_id === p.type_id;
                  const isEmpties = p.is_returnable || p.name.toLowerCase().includes("empty");
                  return (
                    <button
                      type="button"
                      className={`product-card pick ${isSelected ? "selected" : ""} ${isEmpties ? "empty-can-card" : ""}`}
                      key={p.type_id}
                      onClick={() => { setSelectedProduct(p); setShowReduceDamage(false); }}
                      style={{ minHeight: 120, position: "relative" }}
                    >
                      <span className="product-icon">
                        <Icon name={p.icon} size={34} />
                      </span>
                      <b className="product-title" style={{ fontSize: 13, marginTop: 4 }}>
                        {lang === "ta" ? p.ta : p.name}
                      </b>
                      <strong className="product-price-tag" style={{ fontSize: 13 }}>
                        {formatMoney(p.price)}
                      </strong>
                      <span className={`stock-badge ${p.stock < 10 ? "low" : ""}`} style={{ fontSize: 11 }}>
                        {p.stock} {p.unit || (isEmpties ? (lang === "ta" ? "காலிகள்" : "empties") : t("stock"))}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Other Products Section if any exist outside the 6 default slots */}
              {otherProducts.length > 0 && (
                <div className="other-products-section" style={{ marginTop: 20 }}>
                  <div className="category-section-label" style={{ marginBottom: 8 }}>
                    <span>{lang === "ta" ? "பிற சரக்கு வகைகள் (Other Products in Stock)" : "Other Products in Stock"}</span>
                    <span className="count-pill" style={{ marginLeft: 6 }}>{otherProducts.length}</span>
                  </div>
                  <div className="product-grid compact" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                    {otherProducts.map((p) => {
                      const isSelected = selectedProduct && selectedProduct.type_id === p.type_id;
                      return (
                        <button
                          type="button"
                          className={`product-card pick ${isSelected ? "selected" : ""}`}
                          key={p.type_id}
                          onClick={() => { setSelectedProduct(p); setShowReduceDamage(false); }}
                        >
                          <span className="product-icon">
                            <Icon name={p.icon} size={30} />
                          </span>
                          <b className="product-title">{lang === "ta" ? p.ta : p.name}</b>
                          <strong className="product-price-tag">{formatMoney(p.price)}</strong>
                          <span className={`stock-badge ${p.stock < 10 ? "low" : ""}`}>
                            {p.stock} {p.unit || t("stock")}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Single "+ Add New Product" button placed BELOW the cards inside the page */}
              {isManagerOrOwner && (
                <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px dashed #cbd5e1" }}>
                  <button
                    type="button"
                    className="btn-add-product-main"
                    onClick={() => setShowAddProductModal(true)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      padding: "12px 16px",
                      borderRadius: 8,
                      border: "2px dashed #0284c7",
                      background: "#f0f9ff",
                      color: "#0284c7",
                      fontWeight: 800,
                      fontSize: 14,
                      cursor: "pointer",
                      transition: "all 0.2s",
                    }}
                  >
                    <Icon name="plus" size={18} />
                    <span>{lang === "ta" ? "+ புதிய பொருள் சேர்க்க (Add New Product)" : "+ Add New Product"}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Stock Management Details Panel */}
        <div className="workflow-card quantity-card inside-scroll">
          {selectedProduct ? (
            <>
              <div className="selected-item-banner" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="product-icon mini">
                    <Icon name={selectedProduct.icon} size={28} />
                  </span>
                  <div>
                    <b style={{ fontSize: 17, display: "block" }}>{lang === "ta" ? selectedProduct.ta : selectedProduct.name}</b>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12, color: "#64748b" }}>
                        Stock: <strong>{selectedProduct.stock}</strong> {selectedProduct.unit || "units"}
                      </span>
                      <span style={{ fontSize: 12, color: "#0284c7", fontWeight: 700 }}>
                        Rate: {formatMoney(selectedProduct.price)} / {selectedProduct.unit || "unit"}
                      </span>
                    </div>

                    {/* Default Buying Cost Display for Manager/Owner */}
                    {isManagerOrOwner && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                        <span style={{ fontSize: 12, color: "#475569" }}>
                          Default Cost:{" "}
                          <strong>
                            {selectedProduct.buying_price !== null && selectedProduct.buying_price !== undefined
                              ? formatMoney(selectedProduct.buying_price)
                              : (lang === "ta" ? "அமைக்கப்படவில்லை" : "Not set")}
                          </strong>
                          {" "}/ {selectedProduct.unit || "unit"}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setFocusBuyingCostInModal(true);
                            setShowEditProductModal(true);
                          }}
                          style={{
                            border: "none",
                            background: "none",
                            color: "#2563eb",
                            fontSize: 11,
                            textDecoration: "underline",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          {lang === "ta" ? "அடக்க விலை மாற்று" : "Update buying cost"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6 }}>
                  {/* Batches & History Button */}
                  <button
                    type="button"
                    className="btn-modify-large"
                    style={{ padding: "6px 10px", fontSize: 12, background: "#f1f5f9", borderColor: "#cbd5e1", color: "#334155" }}
                    onClick={() => setShowHistoryModal(true)}
                    title="View batch queue and movement audit"
                  >
                    📋 {lang === "ta" ? "பேட்ச் வரலாறு" : "Batches & History"}
                  </button>

                  {isManagerOrOwner ? (
                    <>
                      <button
                        type="button"
                        className="btn-modify-large"
                        style={{ padding: "6px 12px", fontSize: 13 }}
                        onClick={() => {
                          setFocusBuyingCostInModal(false);
                          setShowEditProductModal(true);
                        }}
                      >
                        <Icon name="edit" size={15} />
                        <span>{lang === "ta" ? "மாற்று" : "Edit"}</span>
                      </button>
                      <button
                        type="button"
                        className="customer-delete-btn"
                        style={{ padding: "6px 10px" }}
                        onClick={() => handleToggleArchiveProduct(selectedProduct, showArchived ? "restore" : "archive")}
                        title={showArchived ? "Restore Product" : "Archive Product"}
                      >
                        <Icon name={showArchived ? "check" : "trash"} size={15} />
                      </button>
                    </>
                  ) : (
                    <span style={{ fontSize: 12, color: "#94a3b8" }}>🔒 Staff View</span>
                  )}
                </div>
              </div>

              {!isManagerOrOwner ? (
                <div style={{ padding: 14, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, marginTop: 14, color: "#64748b" }}>
                  <Icon name="warning" size={18} />
                  <b style={{ marginLeft: 6 }}>
                    {lang === "ta" ? "பார்வைக்கு மட்டும்: சரக்கு சேர்க்க அல்லது விலை மாற்ற மேலாளர் PIN தேவை." : "View-only: Manager or Owner PIN required to add stock or edit prices."}
                  </b>
                </div>
              ) : (
                <>
                  {/* Direct Stock Addition Form */}
                  <div className="receive-form-panel" style={{ marginTop: 14 }}>
                    <div className="form-group">
                      <label className="box-label" style={{ fontWeight: 700 }}>
                        {lang === "ta" ? "சேர்க்க வேண்டிய எண்ணிக்கை (Add Stock Quantity):" : "Add Stock Quantity (Count):"}
                      </label>
                      <div className="large-cash-box">
                        <span className="cash-box-prefix">#</span>
                        <input
                          type="number"
                          min="1"
                          value={qty}
                          onChange={(e) => setQty(e.target.value)}
                          placeholder="0"
                        />
                      </div>
                    </div>

                    {/* Selling Price quick update */}
                    <div className="form-group" style={{ marginTop: 12 }}>
                      <label className="box-label" style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                        <span>{lang === "ta" ? "விற்பனை விலை (Selling Price Rs.):" : "Selling Price / Rate (Rs.):"}</span>
                        <span style={{ color: "#2563eb", fontSize: 12 }}>{lang === "ta" ? "Enter அழுத்தவும்" : "Press Enter to update"}</span>
                      </label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <div className="large-cash-box" style={{ flex: 1 }}>
                          <span className="cash-box-prefix">Rs.</span>
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={sellingPrice}
                            onChange={(e) => setSellingPrice(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleUpdatePrice();
                              }
                            }}
                            placeholder="0"
                          />
                        </div>
                        <button
                          type="button"
                          className="btn-primary-small"
                          style={{ height: 48, padding: "0 16px", borderRadius: 8, whiteSpace: "nowrap" }}
                          onClick={handleUpdatePrice}
                          disabled={saving || Number(sellingPrice) === selectedProduct.price}
                        >
                          {lang === "ta" ? "விலை மாற்று" : "Update Price"}
                        </button>
                      </div>
                    </div>

                    {/* Batch Buying Price field (Pre-filled, one-time batch override) */}
                    <div className="form-group" style={{ marginTop: 12 }}>
                      <label className="box-label" style={{ fontWeight: 700, display: "flex", justifyContent: "space-between" }}>
                        <span>{lang === "ta" ? "இந்த வரவிற்கான அடக்க விலை (Batch Buying Cost Rs.):" : "This Batch Buying Cost (Rs.):"}</span>
                        <span style={{ color: "#64748b", fontSize: 11 }}>
                          {selectedProduct.buying_price !== null && selectedProduct.buying_price !== undefined
                            ? `Default: Rs. ${selectedProduct.buying_price}`
                            : "No default set"}
                        </span>
                      </label>
                      <div className="large-cash-box">
                        <span className="cash-box-prefix">Rs.</span>
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          value={batchBuyingPrice}
                          onChange={(e) => setBatchBuyingPrice(e.target.value)}
                          placeholder={selectedProduct.buying_price !== null ? String(selectedProduct.buying_price) : "Required (No default cost set)"}
                        />
                      </div>
                      <small style={{ color: "#64748b", fontSize: 11, display: "block", marginTop: 4 }}>
                        {lang === "ta"
                          ? "இந்த பேட்ச்சிற்கான அடக்க விலை பொருளின் அடிப்படை அடக்க விலையை மாற்றாது."
                          : "Overriding cost here applies to this batch only and does not change the product's default cost."}
                      </small>
                    </div>

                    <button
                      className="primary-action"
                      onClick={handleAddStock}
                      disabled={saving || !qty || Number(qty) <= 0}
                      style={{ marginTop: 16 }}
                    >
                      <Icon name="plus" size={20} />
                      <span>{saving ? "..." : (lang === "ta" ? `சரக்கு சேர்க்க (+${qty || 0})` : `+ ADD STOCK (+${qty || 0})`)}</span>
                    </button>
                  </div>

                  {/* Collapsible Damaged / Lost Stock Reduction */}
                  <div className="damage-reduction-drawer" style={{ marginTop: 24, paddingTop: 16, borderTop: "1px dashed #cbd5e1" }}>
                    <button
                      type="button"
                      className="link-toggle-btn"
                      onClick={() => setShowReduceDamage(!showReduceDamage)}
                      style={{ background: "none", border: "none", color: "#dc2626", fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                    >
                      <Icon name="warning" size={16} />
                      <span>{showReduceDamage ? (lang === "ta" ? "▲ குறைப்பு படிவம் மறை" : "▲ Hide Damage Form") : (lang === "ta" ? "▼ சேதமடைந்த சரக்கு குறைக்க (Reduce Damaged / Write Off)" : "▼ Report Damaged / Adjust Stock")}</span>
                    </button>

                    {showReduceDamage && (
                      <div className="adjust-form-panel" style={{ marginTop: 12 }}>
                        {/* Batch Selection Dropdown */}
                        <div className="form-group" style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 13, fontWeight: 700, color: "#475569", marginBottom: 4, display: "block" }}>
                            {lang === "ta" ? "பாதிக்கப்பட்ட பேட்ச் தேர்வு:" : "Select Specific Batch (FIFO Queue):"}
                          </label>
                          <select
                            value={selectedBatchId}
                            onChange={(e) => setSelectedBatchId(e.target.value)}
                            style={{ width: "100%", padding: "10px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 13 }}
                          >
                            <option value="">FIFO Auto (Oldest batch first)</option>
                            {activeBatches.map((b) => (
                              <option key={b.batch_id} value={b.batch_id}>
                                Batch #{b.batch_number} • Qty: {b.current_quantity} • Recv: {b.received_date} • Rate: {formatMoney(b.selling_price)}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="form-group">
                          <label className="box-label">{lang === "ta" ? "குறைக்க வேண்டிய எண்ணிக்கை:" : "Quantity to Reduce:"}</label>
                          <div className="large-cash-box">
                            <span className="cash-box-prefix">-</span>
                            <input
                              type="number"
                              min="1"
                              value={reduceQty}
                              onChange={(e) => setReduceQty(e.target.value)}
                              placeholder="0"
                            />
                          </div>
                        </div>

                        <div className="reason-row" style={{ marginTop: 10, display: "flex", gap: 8 }}>
                          <button
                            type="button"
                            className={adjustReason === "damaged" ? "selected" : ""}
                            onClick={() => setAdjustReason("damaged")}
                          >
                            {t("damaged")}
                          </button>
                          <button
                            type="button"
                            className={adjustReason === "expired" ? "selected" : ""}
                            onClick={() => setAdjustReason("expired")}
                          >
                            {lang === "ta" ? "காலாவதி" : "Expired"}
                          </button>
                          <button
                            type="button"
                            className={adjustReason === "adjustment" ? "selected" : ""}
                            onClick={() => setAdjustReason("adjustment")}
                          >
                            {lang === "ta" ? "சரக்கு திருத்தம்" : "Correction"}
                          </button>
                        </div>

                        <button
                          className="primary-action danger"
                          onClick={handleReduceStock}
                          disabled={saving || !reduceQty || Number(reduceQty) <= 0}
                          style={{ marginTop: 14 }}
                        >
                          <Icon name="minus" size={18} />
                          <span>{saving ? "..." : (lang === "ta" ? `சரக்கு குறை (-${reduceQty || 0})` : `CONFIRM REDUCE (-${reduceQty || 0})`)}</span>
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          ) : (
            <div style={{ padding: 40, textAlign: "center", color: "#94a3b8" }}>
              {lang === "ta" ? "பொருளைத் தேர்ந்தெடுக்கவும்" : "Select a product to view details and manage stock"}
            </div>
          )}
        </div>
      </section>

      {/* Batch Queue & Movement History Modal */}
      {showHistoryModal && selectedProduct && (
        <div className="modal-backdrop">
          <div className="modal-dialog" style={{ maxWidth: 700 }}>
            <div className="modal-header">
              <h3>
                {lang === "ta" ? `${selectedProduct.ta} - பேட்ச் & நகர்வு வரலாறு` : `${selectedProduct.name} - Batches & History`}
              </h3>
              <button className="modal-close-btn" onClick={() => setShowHistoryModal(false)}>✕</button>
            </div>

            <div style={{ display: "flex", gap: 8, borderBottom: "1px solid #e2e8f0", paddingBottom: 8, margin: "10px 0" }}>
              <button
                type="button"
                className={`tab-btn ${historyTab === "batches" ? "active" : ""}`}
                onClick={() => setHistoryTab("batches")}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "none",
                  fontWeight: 700,
                  cursor: "pointer",
                  background: historyTab === "batches" ? "#0284c7" : "#f1f5f9",
                  color: historyTab === "batches" ? "#fff" : "#475569",
                }}
              >
                {lang === "ta" ? "செயலில் உள்ள பேட்ச்கள்" : "Active Batches (FIFO)"} ({activeBatches.length})
              </button>
              <button
                type="button"
                className={`tab-btn ${historyTab === "movements" ? "active" : ""}`}
                onClick={() => setHistoryTab("movements")}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "none",
                  fontWeight: 700,
                  cursor: "pointer",
                  background: historyTab === "movements" ? "#0284c7" : "#f1f5f9",
                  color: historyTab === "movements" ? "#fff" : "#475569",
                }}
              >
                {lang === "ta" ? "சரக்கு நகர்வு விவரங்கள்" : "Movement Audit Log"} ({stockMovements.length})
              </button>
            </div>

            {historyError ? <p role="alert">{lang === "ta" ? "சரக்கு வரலாறு கிடைக்கவில்லை" : "Could not load stock history."}</p> : loadingHistory ? (
              <div style={{ padding: 20, textAlign: "center", color: "#64748b" }}>Loading history...</div>
            ) : historyTab === "batches" ? (
              <div style={{ maxHeight: 350, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f8fafc", textAlign: "left", borderBottom: "1px solid #cbd5e1" }}>
                      <th style={{ padding: 8 }}>Batch #</th>
                      <th style={{ padding: 8 }}>Received Date</th>
                      <th style={{ padding: 8, textAlign: "right" }}>Current Qty</th>
                      <th style={{ padding: 8, textAlign: "right" }}>Selling Price</th>
                      {isManagerOrOwner && <th style={{ padding: 8, textAlign: "right" }}>Buying Cost</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {activeBatches.map((b) => (
                      <tr key={b.batch_id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                        <td style={{ padding: 8, fontWeight: 700 }}>#{b.batch_number}</td>
                        <td style={{ padding: 8 }}>{b.received_date}</td>
                        <td style={{ padding: 8, textAlign: "right", fontWeight: 700 }}>{b.current_quantity}</td>
                        <td style={{ padding: 8, textAlign: "right" }}>{formatMoney(b.selling_price)}</td>
                        {isManagerOrOwner && (
                          <td style={{ padding: 8, textAlign: "right", color: "#64748b" }}>
                            {b.buying_price !== null && b.buying_price !== undefined ? formatMoney(b.buying_price) : "—"}
                          </td>
                        )}
                      </tr>
                    ))}
                    {activeBatches.length === 0 && (
                      <tr>
                        <td colSpan={isManagerOrOwner ? 5 : 4} style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>
                          No active stock batches found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ maxHeight: 350, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f8fafc", textAlign: "left", borderBottom: "1px solid #cbd5e1" }}>
                      <th style={{ padding: 8 }}>Date</th>
                      <th style={{ padding: 8 }}>Type</th>
                      <th style={{ padding: 8 }}>Batch #</th>
                      <th style={{ padding: 8, textAlign: "right" }}>Change</th>
                      <th style={{ padding: 8 }}>Staff / Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockMovements.map((m) => (
                      <tr key={m.transaction_id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                        <td style={{ padding: 8, whiteSpace: "nowrap" }}>{String(m.date).split("T")[0]}</td>
                        <td style={{ padding: 8, textTransform: "capitalize" }}><b>{m.type}</b></td>
                        <td style={{ padding: 8 }}>#{m.batch_number}</td>
                        <td style={{ padding: 8, textAlign: "right", fontWeight: 700, color: m.quantity_change > 0 ? "#15803d" : "#b91c1c" }}>
                          {m.quantity_change > 0 ? `+${m.quantity_change}` : m.quantity_change}
                        </td>
                        <td style={{ padding: 8, color: "#64748b" }}>
                          {m.staff_name} {m.note ? `• ${m.note}` : ""}
                        </td>
                      </tr>
                    ))}
                    {stockMovements.length === 0 && (
                      <tr>
                        <td colSpan={5} style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>
                          No stock movement history found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ marginTop: 14, textAlign: "right" }}>
              <button
                type="button"
                className="btn-cancel"
                onClick={() => setShowHistoryModal(false)}
                style={{ padding: "8px 16px" }}
              >
                {t("back")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Product Modal */}
      <AddProductModal
        isOpen={showAddProductModal}
        onClose={() => setShowAddProductModal(false)}
        token={token}
        role={role}
        onSuccess={(newProd) => {
          setProducts((prev) => [...prev, newProd]);
          setSelectedProduct(newProd);
          loadProducts();
      window.dispatchEvent(new CustomEvent("refresh-stock-data"));
        }}
      />

      {/* Edit Product Modal */}
      <EditProductModal
        isOpen={showEditProductModal}
        onClose={() => {
          setShowEditProductModal(false);
          setFocusBuyingCostInModal(false);
        }}
        product={selectedProduct}
        token={token}
        role={role}
        initialFocusPrice={focusBuyingCostInModal}
        onUpdated={(updated) => {
          setSelectedProduct(updated);
          setProducts((prev) => prev.map((p) => (p.type_id === updated.type_id ? updated : p)));
          loadProducts();
          window.dispatchEvent(new CustomEvent("refresh-stock-data"));
        }}
        onDeleted={(delId) => {
          const remaining = products.filter((p) => p.type_id !== String(delId) && p.id !== delId);
          setProducts(remaining);
          if (remaining.length) setSelectedProduct(remaining[0]);
          loadProducts();
          window.dispatchEvent(new CustomEvent("refresh-stock-data"));
        }}
      />
    </div>
  );
}
