import { useState, useEffect, useCallback } from "react";
import { Package, Plus, RefreshCw, Bell, Settings, Trash2, Eye, Edit3, Send, ShoppingCart, TrendingDown, Activity, X, Check, AlertTriangle, ExternalLink, Clock, Zap, ChevronDown, ChevronUp, Search, BarChart3, Key, Save, ShoppingBag, Link } from "lucide-react";


// API helper: attaches x-api-key header when VITE_API_KEY is set
const API_KEY = import.meta.env.VITE_API_KEY;

const apiFetch = (url, options = {}) => {
  const headers = {
    ...(options.headers || {}),
    ...(API_KEY ? { "x-api-key": API_KEY } : {})
  };
  return fetch(url, { ...options, headers });
};


const API = "/api";
const cn = (...classes) => classes.filter(Boolean).join(" ");
const timeAgo = (dateStr) => {
  if (!dateStr) return "Nikoli";
  const utcStr = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const diff = Date.now() - new Date(utcStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 0) return "Ravnokar";
  if (mins < 1) return "Ravnokar";
  if (mins < 60) return `${mins} min nazaj`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h nazaj`;
  return `${Math.floor(hrs / 24)}d nazaj`;
};


// Extract hostname from a URL without throwing (replaces the old  helper)
const hostnameFromUrl = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

const Toast = ({ message, type, onClose }) => {
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  const colors = { success: "bg-emerald-500", error: "bg-red-500", info: "bg-blue-500", warning: "bg-amber-500" };
  return (
    <div className={`fixed top-4 right-4 z-50 ${colors[type] || colors.info} text-white px-5 py-3 rounded-xl shadow-2xl flex items-center gap-3 animate-slideIn`}>
      <span className="text-sm font-medium">{message}</span>
      <button onClick={onClose} className="opacity-70 hover:opacity-100"><X size={16} /></button>
    </div>
  );
};

const StoreBadge = ({ store }) => {
  const colors = {
    amazon: "bg-amber-100 text-amber-800 border-amber-200",
    bigbang: "bg-blue-100 text-blue-800 border-blue-200",
    mimovrste: "bg-purple-100 text-purple-800 border-purple-200",
    shopify: "bg-green-100 text-green-800 border-green-200",
    custom: "bg-gray-100 text-gray-700 border-gray-200",
  };
  return (
    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${colors[store] || colors.custom}`}>
      {store}
    </span>
  );
};

const StockBadge = ({ inStock }) => (
  <span className={cn("inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full",
    inStock ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-600 border border-red-200")}>
    <span className={cn("w-2 h-2 rounded-full", inStock ? "bg-emerald-500 animate-pulse" : "bg-red-400")} />
    {inStock ? "Na zalogi" : "Ni na zalogi"}
  </span>
);

// Toggle component
const Toggle = ({ checked, onChange, color = "#10b981" }) => (
  <div className="w-10 h-6 rounded-full relative transition-colors duration-200 cursor-pointer"
    style={{ backgroundColor: checked ? color : "#e5e7eb" }}
    onClick={() => onChange(!checked)}>
    <div className={cn("absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200",
      checked ? "translate-x-4" : "translate-x-0.5")} />
  </div>
);

// Product Card
const ProductCard = ({ product, onCheck, onDelete, onEdit, checking, selected, onSelect }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div onClick={onSelect ? (e) => { if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A' && e.target.tagName !== 'INPUT') onSelect(); } : undefined}
      className={cn("group relative bg-white rounded-2xl border transition-all duration-300 overflow-hidden",
        product.in_stock ? "border-emerald-200 shadow-emerald-100/50 shadow-lg" : "border-gray-200 shadow-sm hover:shadow-md",
        selected ? "ring-2 ring-gray-900" : "",
        onSelect ? "cursor-pointer" : "")}>
      {product.in_stock && <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-400 via-emerald-500 to-teal-400" />}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {onSelect && (
              <div className="float-left mr-3 mt-1">
                <input type="checkbox" checked={!!selected} onChange={onSelect}
                  onClick={e => e.stopPropagation()}
                  className="w-4 h-4 rounded border-gray-300 accent-gray-900 cursor-pointer" />
              </div>
            )}
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <StoreBadge store={product.store} />
              <StockBadge inStock={product.in_stock} />
              {product.auto_purchase === 1 && (
                <span className="text-xs bg-orange-100 text-orange-700 border border-orange-200 px-2 py-0.5 rounded-full font-semibold flex items-center gap-1">
                  <Zap size={10} /> Auto
                </span>
              )}
              {product.check_interval_minutes > 0 && (
                <span className="text-xs bg-indigo-50 text-indigo-600 border border-indigo-200 px-2 py-0.5 rounded-full font-semibold flex items-center gap-1">
                  <Clock size={10} /> {product.check_interval_minutes}min
                </span>
              )}
            </div>
            <h3 className="font-bold text-gray-900 text-lg leading-tight truncate">{product.name}</h3>
            <a href={product.url} target="_blank" rel="noopener noreferrer"
              className="text-sm text-blue-500 hover:text-blue-700 flex items-center gap-1 mt-1 truncate">
              <ExternalLink size={12} /> {hostnameFromUrl(product.url) || 'invalid-url'}
            </a>
          </div>
          <div className="text-right shrink-0">
            {product.current_price && (
              <div className="text-2xl font-black text-gray-900">
                {product.current_price.toFixed(2)}
                <span className="text-sm font-medium text-gray-500 ml-1">{product.currency || "EUR"}</span>
              </div>
            )}
            {product.target_price && (
              <div className="text-xs text-gray-500 mt-1">Cilj: {product.target_price.toFixed(2)} {product.currency || "EUR"}</div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-1 text-xs text-gray-400">
            <Clock size={12} />
            <span>Preverjeno: {timeAgo(product.last_checked)}</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setExpanded(!expanded)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            <button onClick={() => onCheck(product.id)} disabled={checking}
              className={cn("p-2 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors", checking && "animate-spin")}>
              <RefreshCw size={16} />
            </button>
            <button onClick={() => onEdit(product)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
              <Edit3 size={16} />
            </button>
            <button onClick={() => onDelete(product.id)} className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="px-5 pb-5 bg-gray-50 border-t border-gray-100">
          <div className="grid grid-cols-2 gap-3 mt-3 text-sm">
            <div><span className="text-gray-500">Preverjanj:</span><span className="ml-2 font-semibold">{product.check_count || 0}</span></div>
            <div><span className="text-gray-500">Obvestil:</span><span className="ml-2 font-semibold">{product.notification_count || 0}</span></div>
            <div><span className="text-gray-500">Dodano:</span><span className="ml-2 font-medium">{new Date(product.created_at).toLocaleDateString("sl-SI")}</span></div>
            <div><span className="text-gray-500">Zadnjič na zalogi:</span><span className="ml-2 font-medium">{product.last_in_stock ? timeAgo(product.last_in_stock) : "Nikoli"}</span></div>
          </div>
        </div>
      )}
    </div>
  );
};

// Add/Edit Product Modal
const ProductModal = ({ product, stores, onSave, onClose, appSettings }) => {
  const globalInterval = appSettings?.check_interval_minutes || 5;
  const [form, setForm] = useState({
    name: product?.name || "",
    url: product?.url || "",
    store: product?.store || "custom",
    target_price: product?.target_price || "",
    max_order_qty: product?.max_order_qty || 1,
    auto_purchase: product?.auto_purchase === 1,
    notify_on_stock: product?.notify_on_stock !== 0,
    notify_on_price_drop: product?.notify_on_price_drop === 1,
    check_interval_minutes: product?.check_interval_minutes || 0,
  });
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState(null);

  const analyzeUrl = async () => {
    if (!form.url) return;
    setAnalyzing(true);
    setAnalyzeResult(null);
    try {
      const res = await apiFetch(`${API}/analyze-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: form.url }),
      });
      const data = await res.json();
      setForm(f => ({
        ...f,
        store: data.detected_store || f.store,
        name: data.detected_name || f.name || (() => { try { return new URL(form.url).pathname.split("/").filter(Boolean).pop()?.replace(/-/g," ") || ""; } catch(e) { return ""; } })() || "Product",
        target_price: f.target_price || (data.detected_price ? data.detected_price.toString() : ""),
      }));
      setAnalyzeResult({ price: data.detected_price, inStock: data.detected_in_stock, store: data.detected_store, image: data.detected_image });
    } catch (e) { /* ignore */ }
    setAnalyzing(false);
  };

  const handleSubmit = () => {
    if (!form.name || !form.url) return;
    onSave({ ...form, target_price: form.target_price ? parseFloat(form.target_price) : null, check_interval_minutes: parseInt(form.check_interval_minutes) || 0, max_order_qty: parseInt(form.max_order_qty) || 1 });
  };

  const toggleFields = [
    { key: "notify_on_stock", icon: <Bell size={16} />, label: "Obvesti ko pride na zalogo", color: "#10b981" },
    { key: "notify_on_price_drop", icon: <TrendingDown size={16} />, label: "Obvesti ob znižanju cene", color: "#3b82f6" },
    { key: "auto_purchase", icon: <ShoppingCart size={16} />, label: "Avtomatski nakup (dodaj v košarico)", color: "#f97316" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="p-6 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-900">{product ? "Uredi izdelek" : "Dodaj nov izdelek"}</h2>
          <p className="text-sm text-gray-500 mt-1">Vnesi URL izdelka za sledenje zalog</p>
        </div>
        <div className="p-6 space-y-4">
          {/* URL */}
          <div>
            <label className="text-sm font-semibold text-gray-700 mb-1 block">URL izdelka *</label>
            <div className="flex gap-2">
              <input type="url" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                placeholder="https://..." autoFocus={!product}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all" />
              <button onClick={analyzeUrl} disabled={analyzing || !form.url}
                className="px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-40 flex items-center gap-1 shrink-0">
                {analyzing ? <RefreshCw size={14} className="animate-spin" /> : <Eye size={14} />}
                Analiziraj
              </button>
            </div>
          </div>
          {/* Analyze result preview */}
          {analyzeResult && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-sm space-y-1">
              <div className="font-semibold text-emerald-800">✅ Zaznano:</div>
              <div className="text-emerald-700">🏪 Platforma: <strong>{analyzeResult.store}</strong></div>
              {analyzeResult.price && <div className="text-emerald-700">💰 Cena: <strong>{analyzeResult.price?.toFixed(2)} EUR</strong></div>}
              {analyzeResult.inStock !== null && <div className="text-emerald-700">📦 Zaloga: <strong>{analyzeResult.inStock ? "✅ Na zalogi" : "❌ Ni na zalogi"}</strong></div>}
            </div>
          )}
          {/* Name */}
          <div>
            <label className="text-sm font-semibold text-gray-700 mb-1 block">Ime izdelka *</label>
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="npr. Pikachu EX Booster Box"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all" />
          </div>
          {/* Store + Price */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-semibold text-gray-700 mb-1 block">Trgovina</label>
              <select value={form.store} onChange={e => setForm(f => ({ ...f, store: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm bg-white transition-all">
                {stores.map(s => <option key={s.store_name} value={s.store_name}>{s.store_name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-semibold text-gray-700 mb-1 block">Ciljna cena (EUR)</label>
              <input type="number" step="0.01" value={form.target_price} onChange={e => setForm(f => ({ ...f, target_price: e.target.value }))}
                placeholder="Opcijsko..."
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all" />
            </div>
          </div>
          {/* Check interval */}
          <div>
            <label className="text-sm font-semibold text-gray-700 mb-1 block flex items-center gap-1">
              <Clock size={14} /> Interval preverjanja (minute)
            </label>
            <input type="number" min="0" step="1" value={form.check_interval_minutes}
              onChange={e => setForm(f => ({ ...f, check_interval_minutes: e.target.value }))}
              placeholder="0 = globalna nastavitev"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all" />
            <p className="text-xs text-gray-400 mt-1">0 = uporabi globalni interval iz nastavitev</p>
          </div>
          {/* Max order qty */}
          <div>
            <label className="text-sm font-semibold text-gray-700 mb-1 block flex items-center gap-1">
              <ShoppingCart size={14} /> Max količina na naročilo
            </label>
            <input type="number" min="1" step="1" value={form.max_order_qty}
              onChange={e => setForm(f => ({ ...f, max_order_qty: e.target.value }))}
              placeholder="1"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all" />
            <p className="text-xs text-gray-400 mt-1">Ročno nastavi max količino za košarico (override avtomatskega zaznavanja)</p>
          </div>
          {/* Toggles */}
          <div>
            <label className="text-sm font-semibold text-gray-700 mb-1 block">Interval iskanja (min)</label>
            <div className="flex items-center gap-2">
              <input type="number" min="0" max="1440" step="1"
                value={form.check_interval_minutes}
                onChange={e => setForm(f => ({ ...f, check_interval_minutes: e.target.value }))}
                className="w-28 px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all" />
              <span className="text-xs text-gray-400">
                {parseInt(form.check_interval_minutes) > 0
                  ? `Vsake ${form.check_interval_minutes} min`
                  : `Globalni interval (${globalInterval} min)`}
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1">0 = uporabi globalni interval iz nastavitev</p>
          </div>
          <div className="space-y-3 pt-2">
            {toggleFields.map(({ key, icon, label, color }) => (
              <label key={key} className="flex items-center gap-3 cursor-pointer group">
                <Toggle checked={form[key]} onChange={v => setForm(f => ({ ...f, [key]: v }))} color={color} />
                <span className="flex items-center gap-2 text-sm text-gray-700 group-hover:text-gray-900">{icon} {label}</span>
              </label>
            ))}
          </div>
          {form.auto_purchase && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">Avtomatski nakup bo dodal izdelek v košarico. Za zaključek nakupa boš potreboval ročno potrditev.</p>
            </div>
          )}
        </div>
        <div className="p-6 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-xl transition-colors">Prekliči</button>
          <button onClick={handleSubmit} disabled={!form.name || !form.url}
            className="px-6 py-2.5 text-sm font-bold text-white bg-gray-900 hover:bg-gray-800 rounded-xl transition-colors disabled:opacity-40 flex items-center gap-2">
            <Check size={16} /> {product ? "Shrani" : "Dodaj"}
          </button>
        </div>
      </div>
    </div>
  );
};

// Add/Edit Keyword Watch Modal
const KeywordModal = ({ watch, onSave, onClose, appSettings }) => {
  const globalInterval = appSettings?.check_interval_minutes || 5;
  const [form, setForm] = useState({
    keyword: watch?.keyword || "",
    store_url: watch?.store_url || "",
    search_url: watch?.search_url || "",  // ensure never null
    notify_new_products: watch ? watch.notify_new_products !== 0 : true,
    notify_in_stock: watch ? watch.notify_in_stock !== 0 : true,
    auto_add_tracking: watch ? watch.auto_add_tracking === 1 : false,
    check_interval_minutes: watch?.check_interval_minutes != null ? String(watch.check_interval_minutes) : "0",
  });

  const handleSubmit = () => {
    if (!form.keyword || !form.store_url) return;
    onSave(form);
  };

  const toggleFields = [
    { key: "notify_new_products", icon: <Bell size={16} />, label: "Obvesti ob novih izdelkih", color: "#10b981" },
    { key: "notify_in_stock", icon: <Package size={16} />, label: "Obvesti ko pride na zalogo", color: "#3b82f6" },
    { key: "auto_add_tracking", icon: <Zap size={16} />, label: "Avtomatsko dodaj v sledenje", color: "#f97316" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="p-6 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-900">{watch ? "Uredi iskanje" : "Novo iskanje po ključni besedi"}</h2>
          <p className="text-sm text-gray-500 mt-1">Spremljaj trgovino za nove izdelke</p>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="text-sm font-semibold text-gray-700 mb-1 block">Ključna beseda *</label>
            <input type="text" value={form.keyword} onChange={e => setForm(f => ({ ...f, keyword: e.target.value }))}
              placeholder="npr. Ascended Heroes, Pikachu, Booster Box ..."
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all" />
          </div>
          <div>
            <label className="text-sm font-semibold text-gray-700 mb-1 block">URL trgovine *</label>
            <input type="text" value={form.store_url} onChange={e => setForm(f => ({ ...f, store_url: e.target.value }))}
              placeholder="https://pokedom.eu ali https://tcgstar.eu ..."
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all" />
            <p className="text-xs text-gray-400 mt-1">Samo osnovna domena trgovine</p>
          </div>
          <div>
            <label className="text-sm font-semibold text-gray-700 mb-1 block">Custom iskalni URL (opcijsko)</label>
            <input type="text" value={form.search_url} onChange={e => setForm(f => ({ ...f, search_url: e.target.value }))}
              placeholder="Pusti prazno za avtomatsko detekcijo"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all" />
            <p className="text-xs text-gray-400 mt-1">Primer za tcgstar.eu: <span className="font-mono text-xs text-gray-500">https://tcgstar.eu/search?options%5Bprefix%5D=last&q={'{keyword}'}&type=product</span></p>
          </div>
          <div>
            <label className="text-sm font-semibold text-gray-700 mb-1 block">Interval iskanja (min)</label>
            <div className="flex items-center gap-2">
              <input type="number" min="0" max="1440" step="1"
                value={form.check_interval_minutes}
                onChange={e => setForm(f => ({ ...f, check_interval_minutes: e.target.value }))}
                className="w-28 px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all" />
              <span className="text-xs text-gray-400">
                {parseInt(form.check_interval_minutes) > 0
                  ? `Vsake ${form.check_interval_minutes} min`
                  : `Globalni interval (${globalInterval} min)`}
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1">0 = uporabi globalni interval iz nastavitev</p>
          </div>
          <div className="space-y-3 pt-2">
            {toggleFields.map(({ key, icon, label, color }) => (
              <label key={key} className="flex items-center gap-3 cursor-pointer group">
                <Toggle checked={form[key]} onChange={v => setForm(f => ({ ...f, [key]: v }))} color={color} />
                <span className="flex items-center gap-2 text-sm text-gray-700 group-hover:text-gray-900">{icon} {label}</span>
              </label>
            ))}
          </div>
          {form.auto_add_tracking && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">Novi izdelki bodo avtomatsko dodani v sledenje zalog.</p>
            </div>
          )}
        </div>
        <div className="p-6 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-xl transition-colors">Prekliči</button>
          <button onClick={handleSubmit} disabled={!form.keyword || !form.store_url}
            className="px-6 py-2.5 text-sm font-bold text-white bg-gray-900 hover:bg-gray-800 rounded-xl transition-colors disabled:opacity-40 flex items-center gap-2">
            <Check size={16} /> {watch ? "Shrani" : "Dodaj iskanje"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ==================== SETTINGS TAB ====================
const SettingsTab = ({ telegramSettings, telegramForm, setTelegramForm, savingTelegram, handleSaveTelegram, handleTestTelegram, status, stores, onStoresUpdate, showToast, appSettings, onSettingsChange }) => {
  const [intervalVal, setIntervalVal] = useState(String(appSettings?.check_interval_minutes || status?.checkInterval || 5));
  const [autoPurchase, setAutoPurchase] = useState(status?.autoPurchaseEnabled || false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [editingStore, setEditingStore] = useState(null);
  const [storeForm, setStoreForm] = useState({});

  const handleSaveGeneralSettings = async () => {
    setSavingSettings(true);
    try {
      await apiFetch('/api/app-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ check_interval_minutes: parseInt(intervalVal) || 5, auto_purchase_enabled: autoPurchase }),
      });
      showToast('Nastavitve shranjene! Restart za novo cron vrednost.', 'success');
      if (onSettingsChange) onSettingsChange({ check_interval_minutes: parseInt(intervalVal) || 5 });
    } catch(e) { showToast('Napaka pri shranjevanju', 'error'); }
    setSavingSettings(false);
  };

  const startEditStore = (store) => {
    setEditingStore(store.store_name);
    setStoreForm({
      base_url: store.base_url || '',
      stock_selector: store.stock_selector || '',
      price_selector: store.price_selector || '',
      add_to_cart_selector: store.add_to_cart_selector || '',
      out_of_stock_text: store.out_of_stock_text || '',
      in_stock_text: store.in_stock_text || '',
    });
  };

  const handleSaveStore = async () => {
    try {
      await apiFetch(`/api/stores/${editingStore}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storeForm),
      });
      showToast(`Trgovina ${editingStore} posodobljena!`, 'success');
      setEditingStore(null);
      onStoresUpdate();
    } catch(e) { showToast('Napaka pri shranjevanju', 'error'); }
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Telegram */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2"><Key size={18} /> Telegram Bot Nastavitve</h3>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-semibold text-gray-700 mb-1 block">Bot Token</label>
            <input type="text" value={telegramForm.token} onChange={e => setTelegramForm(f => ({ ...f, token: e.target.value }))}
              placeholder="1234567890:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm font-mono transition-all" />
            <p className="text-xs text-gray-400 mt-1">Dobite od @BotFather na Telegramu</p>
          </div>
          <div>
            <label className="text-sm font-semibold text-gray-700 mb-1 block">Chat ID (opcijsko)</label>
            <input type="text" value={telegramForm.chatId} onChange={e => setTelegramForm(f => ({ ...f, chatId: e.target.value }))}
              placeholder="Pusti prazno - zaznamo avtomatsko ob /start"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm font-mono transition-all" />
            <p className="text-xs text-gray-400 mt-1">Pošlji /start botu za avtomatsko zaznavanje — shrani se trajno v bazo</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={handleSaveTelegram} disabled={savingTelegram || !telegramForm.token}
              className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-white rounded-xl text-sm font-bold transition-colors disabled:opacity-40">
              {savingTelegram ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />} Shrani in poveži
            </button>
            <button onClick={handleTestTelegram}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-xl text-sm font-bold transition-colors">
              <Send size={14} /> Test
            </button>
          </div>
          <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-xl">
            <div className={cn("w-2.5 h-2.5 rounded-full", telegramSettings.connected ? "bg-emerald-500 animate-pulse" : "bg-red-400")} />
            <span className={cn("text-sm font-semibold", telegramSettings.connected ? "text-emerald-700" : "text-red-600")}>
              {telegramSettings.connected ? "Telegram je povezan" : "Telegram ni povezan"}
            </span>
            {telegramSettings.chatId && <code className="ml-auto text-xs font-mono bg-gray-200 px-2 py-0.5 rounded">Chat ID: {telegramSettings.chatId}</code>}
          </div>
        </div>
        <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-xl">
          <h4 className="text-sm font-bold text-blue-800 mb-2">Navodila:</h4>
          <ol className="text-xs text-blue-700 space-y-1 list-decimal ml-4">
            <li>Odpri Telegram in poišči <strong>@BotFather</strong></li>
            <li>Pošlji <code>/newbot</code> in sledi navodilom</li>
            <li>Kopiraj token in ga vnesi zgoraj ter klikni "Shrani in poveži"</li>
            <li>Pošlji <code>/start</code> svojemu botu — Chat ID se zazna in shrani avtomatsko</li>
          </ol>
        </div>
      </div>

      {/* General Settings */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2"><Settings size={18} /> Splošne nastavitve</h3>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-semibold text-gray-700 mb-1 block flex items-center gap-1"><Clock size={14} /> Interval preverjanja (min)</label>
              <input type="number" min="1" max="60" value={intervalVal} onChange={e => setIntervalVal(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all" />
            </div>
            <div>
              <label className="text-sm font-semibold text-gray-700 mb-1 block">Avtomatski nakup</label>
              <div className="flex items-center gap-3 mt-2">
                <Toggle checked={autoPurchase} onChange={setAutoPurchase} color="#f97316" />
                <span className="text-sm text-gray-600">{autoPurchase ? 'Vklopljen' : 'Izklopljen'}</span>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="p-3 bg-gray-50 rounded-xl">
              <span className="text-gray-500">Zadnje preverjanje</span>
              <div className="font-semibold mt-0.5">{status?.lastCheckTime ? timeAgo(status.lastCheckTime) : 'Nikoli'}</div>
            </div>
            <div className="p-3 bg-gray-50 rounded-xl">
              <span className="text-gray-500">Skupaj preverjanj</span>
              <div className="font-semibold mt-0.5">{status?.checkCount || 0}</div>
            </div>
          </div>
          <button onClick={handleSaveGeneralSettings} disabled={savingSettings}
            className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-white rounded-xl text-sm font-bold transition-colors disabled:opacity-40">
            {savingSettings ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />} Shrani nastavitve
          </button>
        </div>
      </div>

      {/* Store Configs */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2"><BarChart3 size={18} /> Konfiguracije trgovin</h3>
        <div className="space-y-3">
          {stores.map(s => (
            <div key={s.store_name}>
              {editingStore === s.store_name ? (
                <div className="border border-blue-200 rounded-xl p-4 space-y-3 bg-blue-50/30">
                  <div className="flex items-center justify-between mb-1">
                    <StoreBadge store={s.store_name} />
                    <button onClick={() => setEditingStore(null)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
                  </div>
                  {[
                    { key: 'base_url', label: 'Base URL' },
                    { key: 'stock_selector', label: 'Stock selektor (CSS)' },
                    { key: 'price_selector', label: 'Price selektor (CSS)' },
                    { key: 'add_to_cart_selector', label: 'Add to cart selektor (CSS)' },
                    { key: 'out_of_stock_text', label: 'Out of stock besede (vejica)' },
                    { key: 'in_stock_text', label: 'In stock besede (vejica)' },
                  ].map(({ key, label }) => (
                    <div key={key}>
                      <label className="text-xs font-semibold text-gray-600 mb-0.5 block">{label}</label>
                      <input type="text" value={storeForm[key] || ''} onChange={e => setStoreForm(f => ({ ...f, [key]: e.target.value }))}
                        className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-blue-400 outline-none text-xs font-mono transition-all" />
                    </div>
                  ))}
                  <button onClick={handleSaveStore}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white rounded-xl text-sm font-bold transition-colors">
                    <Save size={14} /> Shrani
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                  <div className="flex items-center gap-3">
                    <StoreBadge store={s.store_name} />
                    <span className="text-xs text-gray-500 font-mono">{s.base_url || 'Custom'}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => startEditStore(s)} className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-400 hover:text-gray-700 transition-colors" title="Uredi">
                      <Edit3 size={14} />
                    </button>
                    {!['amazon','bigbang','mimovrste','shopify','custom'].includes(s.store_name) && (
                      <button onClick={async () => {
                        if (!confirm(`Izbriši trgovino "${s.store_name}"?`)) return;
                        await apiFetch(`/api/stores/${s.store_name}`, { method: 'DELETE' });
                        showToast(`Trgovina ${s.store_name} izbrisana`, 'info');
                        onStoresUpdate();
                      }} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors" title="Izbriši">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ==================== MAIN APP ====================
export default function StockTracker() {
  const [products, setProducts] = useState([]);
  const [stores, setStores] = useState([]);
  const [status, setStatus] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [keywordWatches, setKeywordWatches] = useState([]);
  const [telegramSettings, setTelegramSettings] = useState({ token: "", chatId: "", connected: false });
  const [showModal, setShowModal] = useState(false);
  const [showKeywordModal, setShowKeywordModal] = useState(false);
  const [editProduct, setEditProduct] = useState(null);
  const [editKeyword, setEditKeyword] = useState(null);
  const [toast, setToast] = useState(null);
  const [activeTab, setActiveTab] = useState("products");
  const [checkingId, setCheckingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [telegramForm, setTelegramForm] = useState({ token: "", chatId: "" });
  const [savingTelegram, setSavingTelegram] = useState(false);
  const [shopifyDomains, setShopifyDomains] = useState([]);
  const [cartUrls, setCartUrls] = useState({});
  const [buildingCart, setBuildingCart] = useState(null);
  const [appSettings, setAppSettings] = useState({ check_interval_minutes: 5 });
  // Products filter/bulk-select state
  const [filterStock, setFilterStock] = useState("all"); // "all" | "in_stock" | "out_of_stock"
  const [filterStore, setFilterStore] = useState("all");
  const [selectedIds, setSelectedIds] = useState(new Set());

  const showToast = (message, type = "info") => setToast({ message, type });

  const fetchData = useCallback(async () => {
    try {
      const [prods, sts, stat, notifs, kwWatches, domains, settings] = await Promise.all([
        apiFetch(`${API}/products`).then(r => r.json()),
        apiFetch(`${API}/stores`).then(r => r.json()),
        apiFetch(`${API}/status`).then(r => r.json()),
        apiFetch(`${API}/notifications`).then(r => r.json()),
        apiFetch(`${API}/keyword-watches`).then(r => r.json()),
        apiFetch(`${API}/cart/domains`).then(r => r.json()).catch(() => []),
        apiFetch(`${API}/app-settings`).then(r => r.json()).catch(() => ({})),
      ]);
      setProducts(prods);
      setStores(sts);
      setStatus(stat);
      setNotifications(notifs);
      setKeywordWatches(kwWatches);
      setShopifyDomains(domains);
      if (settings && settings.check_interval_minutes) setAppSettings(settings);
    } catch (e) {
      showToast("Napaka pri povezavi s strežnikom", "error");
    }
    setLoading(false);
  }, []);

  const fetchTelegramSettings = useCallback(async () => {
    try {
      const data = await apiFetch(`${API}/telegram/settings`).then(r => r.json());
      setTelegramSettings(data);
      setTelegramForm({ token: data.token || "", chatId: data.chatId || "" });
    } catch (e) { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchData();
    fetchTelegramSettings();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData, fetchTelegramSettings]);

  // Auto-build cart URLs for all domains that have in-stock items
  useEffect(() => {
    shopifyDomains.filter(d => d.inStock > 0).forEach(domain => {
      if (!cartUrls[domain.domain]) {
        handleBuildCart(domain.domain);
      }
    });
  }, [shopifyDomains]);

  const handleAdd = async (data) => {
    try {
      const res = await apiFetch(`${API}/products`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      showToast("Izdelek dodan za sledenje!", "success");
      setShowModal(false);
      fetchData();
    } catch (e) { showToast(e.message, "error"); }
  };

  const handleEdit = async (data) => {
    try {
      await apiFetch(`${API}/products/${editProduct.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      showToast("Izdelek posodobljen!", "success");
      setEditProduct(null);
      fetchData();
    } catch (e) { showToast("Napaka pri posodabljanju", "error"); }
  };

  const handleDelete = async (id) => {
    if (!confirm("Ali res želiš odstraniti ta izdelek?")) return;
    await apiFetch(`${API}/products/${id}`, { method: "DELETE" });
    showToast("Izdelek odstranjen", "info");
    fetchData();
  };

  const handleCheck = async (id) => {
    setCheckingId(id);
    await apiFetch(`${API}/check/${id}`, { method: "POST" });
    showToast("Preverjanje zaloge...", "info");
    setTimeout(() => { fetchData(); setCheckingId(null); }, 5000);
  };

  const handleCheckAll = async () => {
    setCheckingId("all");
    await apiFetch(`${API}/check`, { method: "POST" });
    showToast("Preverjam vse izdelke...", "info");
    setTimeout(() => { fetchData(); setCheckingId(null); }, 10000);
  };

  const handleTestTelegram = async () => {
    const res = await apiFetch(`${API}/telegram/test`, { method: "POST" });
    const data = await res.json();
    showToast(data.success ? "Telegram test uspešen!" : "Telegram ni povezan", data.success ? "success" : "error");
  };

  const handleSaveTelegram = async () => {
    if (!telegramForm.token) { showToast("Token je obvezen", "error"); return; }
    setSavingTelegram(true);
    try {
      const res = await apiFetch(`${API}/telegram/settings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: telegramForm.token, chatId: telegramForm.chatId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast(data.connected ? "Telegram nastavitve shranjene!" : "Token shranjen, a bot ni uspel vzpostaviti povezave.", data.connected ? "success" : "warning");
      fetchTelegramSettings();
      fetchData();
    } catch(e) { showToast(e.message, "error"); }
    setSavingTelegram(false);
  };

  // Keyword watch handlers
  const handleAddKeywordWatch = async (data) => {
    try {
      const res = await apiFetch(`${API}/keyword-watches`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      showToast("Iskanje dodano! Prvo preverjanje teče ...", "success");
      setShowKeywordModal(false);
      setTimeout(fetchData, 3000);
    } catch (e) { showToast(e.message, "error"); }
  };

  const handleEditKeywordWatch = async (data) => {
    try {
      await apiFetch(`${API}/keyword-watches/${editKeyword.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      showToast("Iskanje posodobljeno!", "success");
      setEditKeyword(null);
      fetchData();
    } catch(e) { showToast("Napaka pri posodabljanju", "error"); }
  };

  const handleDeleteKeywordWatch = async (id) => {
    if (!confirm("Odstrani to iskanje?")) return;
    await apiFetch(`${API}/keyword-watches/${id}`, { method: "DELETE" });
    showToast("Iskanje odstranjeno", "info");
    fetchData();
  };

  // Bulk delete handler
  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Odstranil boš ${selectedIds.size} označenih izdelkov. Si prepričan?`)) return;
    try {
      await apiFetch(`${API}/products/bulk-delete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      setSelectedIds(new Set());
      showToast(`${selectedIds.size} izdelkov odstranjenih`, "success");
      fetchData();
    } catch(e) { showToast("Napaka pri brisanju", "error"); }
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (filteredProducts) => {
    if (selectedIds.size === filteredProducts.length && filteredProducts.every(p => selectedIds.has(p.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredProducts.map(p => p.id)));
    }
  };

  const handleCheckKeywordWatch = async (id) => {
    setCheckingId(`kw-${id}`);
    await apiFetch(`${API}/keyword-watches/${id}/check`, { method: "POST" });
    showToast("Iščem ...", "info");
    setTimeout(() => { fetchData(); setCheckingId(null); }, 5000);
  };

  const handleResetKeywordWatch = async (id) => {
    if (!confirm("Resetiraj znane izdelke? Ob naslednjem preverjanju boš dobil obvestila za vse najdene izdelke.")) return;
    await apiFetch(`${API}/keyword-watches/${id}/reset`, { method: "POST" });
    showToast("Resetirano", "info");
    fetchData();
  };

  const handleBuildCart = async (domain) => {
    setBuildingCart(domain);
    try {
      const res = await apiFetch(`${API}/cart/build`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = await res.json();
      if (data.cartUrl) {
        setCartUrls(prev => ({ ...prev, [domain]: data.cartUrl }));
        showToast(`Košarica pripravljena! ${data.items.length} izdelkov dodanih.`, "success");
      } else {
        showToast(data.message || "Ni izdelkov za košarico", "warning");
      }
    } catch(e) {
      showToast("Napaka pri gradnji košarice", "error");
    }
    setBuildingCart(null);
  };

  const inStockCount = products.filter(p => p.in_stock).length;

  return (
    <div className="min-h-screen bg-gray-50">
      {toast && <Toast {...toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-gray-900 flex items-center justify-center">
                <Package size={20} className="text-white" />
              </div>
              <div>
                <h1 className="text-xl font-extrabold text-gray-900 tracking-tight">Stock Tracker</h1>
                <p className="text-xs text-gray-400">Sledenje zalog in cen</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {status && (
                <div className={cn("hidden sm:flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full",
                  status.telegramConnected ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500")}>
                  <Send size={12} />
                  {status.telegramConnected ? "Telegram povezan" : "Telegram ni povezan"}
                </div>
              )}
              <button onClick={handleCheckAll} disabled={checkingId === "all"}
                className="flex items-center gap-2 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 rounded-xl text-sm font-semibold text-gray-700 transition-colors disabled:opacity-50">
                <RefreshCw size={14} className={checkingId === "all" ? "animate-spin" : ""} />
                <span className="hidden sm:inline">Preveri vse</span>
              </button>
              <button onClick={() => setShowModal(true)}
                className="flex items-center gap-2 px-4 py-2.5 bg-gray-900 hover:bg-gray-800 rounded-xl text-sm font-bold text-white transition-colors">
                <Plus size={16} />
                <span className="hidden sm:inline">Dodaj izdelek</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Stats Bar */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Vseh izdelkov", value: products.length, icon: <Package size={18} />, color: "bg-gray-900 text-white" },
            { label: "Na zalogi", value: inStockCount, icon: <Check size={18} />, color: inStockCount > 0 ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-600" },
            { label: "Ni na zalogi", value: products.length - inStockCount, icon: <X size={18} />, color: "bg-gray-100 text-gray-600" },
            { label: "Iskanj", value: keywordWatches.filter(w => w.active).length, icon: <Search size={18} />, color: "bg-gray-100 text-gray-600" },
          ].map((stat, i) => (
            <div key={i} className={cn("rounded-2xl p-4 flex items-center gap-3", stat.color)}>
              {stat.icon}
              <div>
                <div className="text-2xl font-extrabold">{stat.value}</div>
                <div className="text-xs opacity-75 font-medium">{stat.label}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit mb-6 overflow-x-auto">
          {[
            { id: "products", label: "Izdelki", icon: <Package size={14} /> },
            { id: "keywords", label: "Iskanja", icon: <Search size={14} /> },
            { id: "notifications", label: "Obvestila", icon: <Bell size={14} /> },
            { id: "settings", label: "Nastavitve", icon: <Settings size={14} /> },
          ].map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={cn("flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all whitespace-nowrap",
                activeTab === tab.id ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700")}>
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {/* Products Tab */}
        {activeTab === "products" && (
          <div>
            {loading ? (
              <div className="text-center py-20 text-gray-400">
                <RefreshCw size={32} className="animate-spin mx-auto mb-3" />
                <p>Nalagam...</p>
              </div>
            ) : products.length === 0 ? (
              <div className="text-center py-20">
                <Package size={48} className="mx-auto mb-4 text-gray-300" />
                <h3 className="text-lg font-bold text-gray-600 mb-2">Ni izdelkov za sledenje</h3>
                <p className="text-gray-400 mb-6">Dodaj prvi izdelek za začetek sledenja zalog</p>
                <button onClick={() => setShowModal(true)}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-gray-900 text-white rounded-xl font-bold hover:bg-gray-800 transition-colors">
                  <Plus size={18} /> Dodaj izdelek
                </button>
              </div>
            ) : (
              <>
                {/* Shopify Cart Sections - grouped by domain */}
                {shopifyDomains.filter(d => d.inStock > 0).map(domain => (
                  <div key={domain.domain} className="mb-6 bg-gradient-to-r from-emerald-50 to-teal-50 border-2 border-emerald-300 rounded-2xl p-4 shadow-sm">
                    {/* Store header */}
                    <div className="flex items-center gap-2 mb-3">
                      <ShoppingBag size={18} className="text-emerald-600" />
                      <span className="font-extrabold text-emerald-800 text-base">{domain.domain.replace('https://', '')}</span>
                      <span className="text-xs bg-emerald-500 text-white px-2.5 py-0.5 rounded-full font-bold">
                        {domain.inStock} na zalogi
                      </span>
                    </div>
                    {/* In-stock products with max qty badges */}
                    <div className="space-y-2 mb-4">
                      {domain.products.filter(p => p.in_stock).map(p => (
                        <div key={p.id} className="flex items-center justify-between bg-white/70 rounded-xl px-3 py-2 border border-emerald-100">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                            <span className="text-sm font-semibold text-gray-800 truncate">{p.name}</span>
                          </div>
                          <div className="flex items-center gap-3 shrink-0 ml-2">
                            {p.current_price && (
                              <span className="text-sm font-bold text-gray-700">{p.current_price.toFixed(2)} EUR</span>
                            )}
                            <span className="text-xs bg-emerald-100 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full font-bold whitespace-nowrap">
                              max {p.max_order_qty || 1}x
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* Action buttons */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <button onClick={() => handleBuildCart(domain.domain)}
                        disabled={buildingCart === domain.domain}
                        className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-800 text-white rounded-xl text-sm font-bold transition-colors disabled:opacity-50">
                        {buildingCart === domain.domain
                          ? <RefreshCw size={14} className="animate-spin" />
                          : <ShoppingCart size={14} />}
                        {cartUrls[domain.domain] ? "Obnovi košarico" : "Pripravi košarico"}
                      </button>
                      {cartUrls[domain.domain] && (
                        <>
                          <a href={cartUrls[domain.domain]} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-sm font-bold transition-colors">
                            <ShoppingCart size={14} /> Odpri košarico
                          </a>
                          <a href={cartUrls[domain.domain]} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-2 px-5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-sm font-extrabold transition-colors shadow-md">
                            <Zap size={14} /> Zaključi nakup →
                          </a>
                        </>
                      )}
                    </div>
                    {buildingCart === domain.domain && (
                      <p className="text-xs text-emerald-600 mt-2 flex items-center gap-1">
                        <RefreshCw size={10} className="animate-spin" /> Preverja maksimalne količine...
                      </p>
                    )}
                  </div>
                ))}

                {/* Filter bar */}
                <div className="flex flex-wrap items-center gap-2 mb-4 pb-4 border-b border-gray-100">
                  <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
                    {[["all","Vsi"],["in_stock","Na zalogi"],["out_of_stock","Ni na zalogi"]].map(([val,label]) => (
                      <button key={val} onClick={() => { setFilterStock(val); setSelectedIds(new Set()); }}
                        className={cn("px-3 py-1.5 rounded-lg text-xs font-semibold transition-all",
                          filterStock === val ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700")}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <select value={filterStore} onChange={e => { setFilterStore(e.target.value); setSelectedIds(new Set()); }}
                    className="px-3 py-1.5 rounded-xl border border-gray-200 text-xs font-semibold bg-white text-gray-700 outline-none cursor-pointer">
                    <option value="all">Vse trgovine</option>
                    {[...new Set(products.map(p => p.store))].map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  {selectedIds.size > 0 && (
                    <button onClick={handleBulkDelete}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white rounded-xl text-xs font-bold transition-colors ml-auto">
                      <Trash2 size={12} /> Izbriši označene ({selectedIds.size})
                    </button>
                  )}
                </div>
                {/* Filtered product list */}
                {(() => {
                  const filtered = products.filter(p => {
                    const stockOk = filterStock === "all" || (filterStock === "in_stock" ? p.in_stock : !p.in_stock);
                    const storeOk = filterStore === "all" || p.store === filterStore;
                    return stockOk && storeOk;
                  });
                  const allFilteredSelected = filtered.length > 0 && filtered.every(p => selectedIds.has(p.id));
                  return (
                    <>
                      {filtered.length > 0 && (
                        <div className="flex items-center gap-2 mb-3">
                          <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-500 font-semibold select-none">
                            <input type="checkbox" checked={allFilteredSelected}
                              onChange={() => toggleSelectAll(filtered)}
                              className="w-4 h-4 rounded border-gray-300 accent-gray-900 cursor-pointer" />
                            Označi vse ({filtered.length})
                          </label>
                        </div>
                      )}
                      {filtered.length === 0 ? (
                        <div className="text-center py-12 text-gray-400">
                          <Search size={28} className="mx-auto mb-2 opacity-40" />
                          <p className="text-sm">Ni rezultatov za izbrane filtre</p>
                        </div>
                      ) : (
                        <div className="grid gap-4 sm:grid-cols-2 pb-8">
                          {filtered.map(p => (
                            <ProductCard key={p.id} product={p} onCheck={handleCheck} onDelete={handleDelete}
                              onEdit={setEditProduct} checking={checkingId === p.id}
                              selected={selectedIds.has(p.id)}
                              onSelect={() => toggleSelect(p.id)} />
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </>
            )}
          </div>
        )}

        {/* Keywords Tab */}
        {activeTab === "keywords" && (
          <div className="pb-8">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-gray-500">Spremljaj trgovine za nove izdelke po ključni besedi</p>
              <button onClick={() => setShowKeywordModal(true)}
                className="flex items-center gap-2 px-4 py-2.5 bg-gray-900 hover:bg-gray-800 rounded-xl text-sm font-bold text-white transition-colors">
                <Plus size={16} /> Novo iskanje
              </button>
            </div>

            {keywordWatches.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <Search size={40} className="mx-auto mb-3 opacity-40" />
                <p className="font-medium">Ni aktivnih iskanj</p>
                <p className="text-sm mt-1">Dodaj iskanje za spremljanje novih izdelkov</p>
              </div>
            ) : (
              <div className="space-y-3">
                {keywordWatches.map(w => (
                  <div key={w.id} className={cn("bg-white rounded-2xl border p-5 transition-all",
                    w.active ? "border-gray-200" : "border-gray-100 opacity-60")}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">
                            {w.store_name}
                          </span>
                          {w.notify_in_stock === 1 && (
                            <span className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full font-semibold flex items-center gap-1">
                              <Bell size={10} /> Zaloga
                            </span>
                          )}
                          {w.auto_add_tracking === 1 && (
                            <span className="text-xs bg-orange-100 text-orange-700 border border-orange-200 px-2 py-0.5 rounded-full font-semibold flex items-center gap-1">
                              <Zap size={10} /> Auto-track
                            </span>
                          )}
                          {!w.active && <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Neaktivno</span>}
                        </div>
                        <h3 className="font-bold text-gray-900 text-lg">"{w.keyword}"</h3>
                        <a href={w.store_url} target="_blank" rel="noopener noreferrer"
                          className="text-sm text-blue-500 hover:text-blue-700 flex items-center gap-1 mt-1">
                          <ExternalLink size={12} /> {w.store_url}
                        </a>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-2xl font-black text-gray-900">{w.known_count || 0}</div>
                        <div className="text-xs text-gray-500">najdenih</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-100">
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        <Clock size={12} />
                        <span>Preverjeno: {timeAgo(w.last_checked)}</span>
                        {w.check_interval_minutes > 0 && (
                          <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-semibold">
                            ⏱ {w.check_interval_minutes}min
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleCheckKeywordWatch(w.id)}
                          disabled={checkingId === `kw-${w.id}`}
                          className={cn("p-2 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors",
                            checkingId === `kw-${w.id}` && "animate-spin")}>
                          <RefreshCw size={16} />
                        </button>
                        <button onClick={() => setEditKeyword(w)}
                          className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors" title="Uredi iskanje">
                          <Edit3 size={16} />
                        </button>
                        <button onClick={() => handleResetKeywordWatch(w.id)}
                          className="p-2 rounded-lg hover:bg-amber-50 text-gray-400 hover:text-amber-600 transition-colors" title="Resetiraj znane izdelke">
                          <Activity size={16} />
                        </button>
                        <button onClick={() => handleDeleteKeywordWatch(w.id)}
                          className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Notifications Tab */}
        {activeTab === "notifications" && (
          <div className="space-y-3 pb-8">
            {notifications.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <Bell size={40} className="mx-auto mb-3 opacity-40" />
                <p className="font-medium">Še ni obvestil</p>
              </div>
            ) : notifications.map(n => (
              <div key={n.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-start gap-3">
                <div className={cn("w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                  n.type === "stock_alert" ? "bg-emerald-100 text-emerald-600" :
                  n.type === "keyword_watch" ? "bg-indigo-100 text-indigo-600" : "bg-blue-100 text-blue-600")}>
                  {n.type === "stock_alert" ? <Package size={14} /> : n.type === "keyword_watch" ? <Search size={14} /> : <TrendingDown size={14} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{n.product_name || "Iskanje"}</p>
                  <p className="text-sm text-gray-500">{n.message}</p>
                  <p className="text-xs text-gray-400 mt-1">{new Date(n.sent_at).toLocaleString("sl-SI")}</p>
                </div>
                <StoreBadge store={n.store || "custom"} />
              </div>
            ))}
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === "settings" && (
          <SettingsTab
            telegramSettings={telegramSettings}
            telegramForm={telegramForm}
            setTelegramForm={setTelegramForm}
            savingTelegram={savingTelegram}
            handleSaveTelegram={handleSaveTelegram}
            handleTestTelegram={handleTestTelegram}
            status={status}
            stores={stores}
            onStoresUpdate={fetchData}
            showToast={showToast}
            appSettings={appSettings}
            onSettingsChange={newSettings => setAppSettings(prev => ({ ...prev, ...newSettings }))}
          />
        )}
      </div>

      {/* Modals */}
      {showModal && <ProductModal stores={stores} appSettings={appSettings} onSave={handleAdd} onClose={() => setShowModal(false)} />}
      {editProduct && <ProductModal product={editProduct} stores={stores} appSettings={appSettings} onSave={handleEdit} onClose={() => setEditProduct(null)} />}
      {showKeywordModal && <KeywordModal appSettings={appSettings} onSave={handleAddKeywordWatch} onClose={() => setShowKeywordModal(false)} />}
      {editKeyword && <KeywordModal watch={editKeyword} appSettings={appSettings} onSave={handleEditKeywordWatch} onClose={() => setEditKeyword(null)} />}
    </div>
  );
}