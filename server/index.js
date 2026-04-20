// server/index.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const fs = require("fs");
const cron = require("node-cron");
const rateLimit = require("express-rate-limit");
const { initDatabase } = require("./utils/database");
const db = require("./utils/database");
const checker = require("./utils/checker");
const keywordWatcher = require("./utils/keyword-watcher");
const categoryWatcher = require("./utils/category-watcher");
const telegram = require("./utils/telegram");
const scraper = require("./scrapers/generic");
const { buildCartForProducts } = require("./utils/cart-builder");
const { decodeCartItems } = require("./utils/pikazard-cart");
const { detectStoreFromUrl } = require("./utils/storeDetection");

const resolvePreferredStore = (url, requestedStore) => {
  const detectedStore = detectStoreFromUrl(url);
  return detectedStore !== "custom" ? detectedStore : (requestedStore || "custom");
};


// Cron scheduling (global stock check) with dynamic interval from app_settings
let globalCheckJob = null;

const getGlobalIntervalMinutes = () => {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'check_interval_minutes'").get();
    const raw = row?.value ?? process.env.CHECK_INTERVAL_MINUTES ?? '5';
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 1) return 5;
    return Math.min(n, 59);
  } catch {
    return 5;
  }
};

function rescheduleGlobalCheck() {
  if (globalCheckJob) {
    globalCheckJob.stop();
    globalCheckJob = null;
  }
  // Run every minute — individual product intervals are respected inside checkAll()
  // This ensures products with short intervals (e.g., 1 min) are actually checked on time
  globalCheckJob = cron.schedule('* * * * *', () => checker.checkAll());
  const intervalMin = getGlobalIntervalMinutes();
  console.log(`⏱️ Global stock check cron: every 1 min (default product interval: ${intervalMin} min)`);
}

const app = express();

// Railway (and most PaaS) sits behind a reverse proxy and sets X-Forwarded-* headers.
// This is required so express-rate-limit can correctly identify client IPs.
app.set('trust proxy', 1);

// Security: simple API key auth for /api routes (set API_KEY in env)
const apiAuth = (req, res, next) => {
  const expected = process.env.API_KEY;
  const disabled = process.env.DISABLE_AUTH === 'true';
  if (disabled) return next();

  if (!expected) {
    return res.status(500).json({ error: "API_KEY is not set on server" });
  }
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
};

// Security: basic rate limiting for API
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});


app.use(express.json());


app.use("/api", apiLimiter, apiAuth);
// ─────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────

// Products
app.get("/api/products", (req, res) => {
  try {
    const products = db.prepare("SELECT * FROM products ORDER BY created_at DESC").all();
    res.json(products);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/products", async (req, res) => {
  try {
    const { name, store, target_price, auto_purchase, notify_on_stock, notify_on_price_drop, price_drop_threshold_amount, price_drop_threshold_percentage, check_interval_minutes, max_order_qty } = req.body;
    let { url } = req.body;
    if (!name || !url) return res.status(400).json({ error: "name and url required" });
    // Strip Shopify tracking params from URL before saving
    try {
      const u = new URL(url);
      ['_pos','_sid','_ss','_ga','_gl','ref','fbclid','gclid','utm_source','utm_medium','utm_campaign'].forEach(p => u.searchParams.delete(p));
      if (u.searchParams.toString() === '') u.search = '';
      u.hash = '';
      url = u.toString();
    } catch(e) { console.error('Telegram initialization error:', e.message); }
    const resolvedStore = resolvePreferredStore(url, store);
    const result = db.prepare(
      `INSERT INTO products (name, url, store, target_price, auto_purchase, notify_on_stock, notify_on_price_drop, price_drop_threshold_amount, price_drop_threshold_percentage, check_interval_minutes, max_order_qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, url, resolvedStore, target_price || null,
      auto_purchase ? 1 : 0, notify_on_stock !== false ? 1 : 0,
      notify_on_price_drop ? 1 : 0,
      price_drop_threshold_amount || 0,
      price_drop_threshold_percentage || 0,
      check_interval_minutes || 0,
      max_order_qty || 1);
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid);
    // Kick off an immediate check in the background using dedicated single-product checker
    checker.checkSingleProduct(result.lastInsertRowid).catch(e => console.error('Initial check failed:', e.message));
    res.json(product);
  } catch (e) {
    if (e.message && e.message.includes("UNIQUE")) return res.status(400).json({ error: "URL already tracked" });
    res.status(500).json({ error: e.message });
  }
});

// Bulk delete products
app.post("/api/products/bulk-delete", (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array required" });
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM products WHERE id IN (${placeholders})`).run(...ids);
    res.json({ ok: true, deleted: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/products/:id", (req, res) => {
  try {
    const { name, url, store, target_price, auto_purchase, notify_on_stock, notify_on_price_drop, price_drop_threshold_amount, price_drop_threshold_percentage, check_interval_minutes, max_order_qty } = req.body;
    const resolvedStore = resolvePreferredStore(url, store);
    db.prepare(
      `UPDATE products SET name=?, url=?, store=?, target_price=?, auto_purchase=?, notify_on_stock=?, notify_on_price_drop=?, price_drop_threshold_amount=?, price_drop_threshold_percentage=?, check_interval_minutes=?, max_order_qty=?, updated_at=datetime('now') WHERE id=?`
    ).run(name, url, resolvedStore, target_price || null,
      auto_purchase ? 1 : 0, notify_on_stock ? 1 : 0,
      notify_on_price_drop ? 1 : 0,
      price_drop_threshold_amount || 0,
      price_drop_threshold_percentage || 0,
      check_interval_minutes || 0,
      max_order_qty || 1,
      req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/products/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Stores
app.get("/api/stores", (req, res) => {
  try {
    const stores = db.prepare("SELECT * FROM store_configs ORDER BY store_name").all();
    res.json(stores);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/stores/:name", (req, res) => {
  try {
    const { base_url, stock_selector, price_selector, add_to_cart_selector, out_of_stock_text, in_stock_text } = req.body;
    db.prepare(`UPDATE store_configs SET base_url=?, stock_selector=?, price_selector=?, add_to_cart_selector=?, out_of_stock_text=?, in_stock_text=? WHERE store_name=?`)
      .run(base_url ?? '', stock_selector ?? '', price_selector ?? '', add_to_cart_selector ?? '', out_of_stock_text ?? '', in_stock_text ?? '', req.params.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/stores", (req, res) => {
  try {
    const { store_name, base_url, stock_selector, price_selector, add_to_cart_selector, out_of_stock_text, in_stock_text } = req.body;
    if (!store_name) return res.status(400).json({ error: "store_name required" });
    db.prepare(`INSERT OR IGNORE INTO store_configs (store_name, base_url, stock_selector, price_selector, add_to_cart_selector, out_of_stock_text, in_stock_text) VALUES (?,?,?,?,?,?,?)`)
      .run(store_name, base_url||'', stock_selector||'', price_selector||'', add_to_cart_selector||'', out_of_stock_text||'', in_stock_text||'');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/stores/:name", (req, res) => {
  try {
    const builtIn = ['amazon','bigbang','mimovrste','shopify','tcgstar','pikazard','pokedom','custom'];
    if (builtIn.includes(req.params.name)) return res.status(400).json({ error: "Ne moreš izbrisati privzetih trgovin" });
    db.prepare("DELETE FROM store_configs WHERE store_name = ?").run(req.params.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// App settings (interval, auto-purchase, etc.)
app.get("/api/app-settings", (req, res) => {
  try {
    const rows = db.prepare("SELECT key, value FROM app_settings").all();
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    // Also expose env-based defaults
    settings.check_interval_minutes = settings.check_interval_minutes || process.env.CHECK_INTERVAL_MINUTES || '5';
    settings.auto_purchase_enabled = settings.auto_purchase_enabled || (process.env.AUTO_PURCHASE_ENABLED === 'true' ? 'true' : 'false');
    res.json(settings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/app-settings", (req, res) => {
  try {
    const allowed = ['check_interval_minutes', 'auto_purchase_enabled', 'quiet_hours', 'daily_report', 'global_max_qty', 'cart_qty_mode'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const val = typeof req.body[key] === 'object' ? JSON.stringify(req.body[key]) : String(req.body[key]);
        db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, val);
      }
    }
    if (req.body.check_interval_minutes !== undefined) {
      rescheduleGlobalCheck();
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Telegram pause/resume/status
app.post("/api/telegram/pause", (req, res) => {
  telegram._paused = true;
  res.json({ ok: true, paused: true });
});
app.post("/api/telegram/resume", (req, res) => {
  telegram._paused = false;
  res.json({ ok: true, paused: false });
});
app.get("/api/telegram/status", (req, res) => {
  res.json({ connected: telegram.isReady(), paused: telegram.isPaused(), chatId: telegram.getChatId() });
});

// Status
app.get("/api/status", (req, res) => {
  try {
    const status = checker.getStatus();
    const lastCheckRow = db.prepare("SELECT value FROM app_settings WHERE key = 'last_check_at'").get();
    const totalChecksRow = db.prepare("SELECT value FROM app_settings WHERE key = 'total_checks'").get();
    const intervalRow = db.prepare("SELECT value FROM app_settings WHERE key = 'check_interval_minutes'").get();
    const autoPurchaseRow = db.prepare("SELECT value FROM app_settings WHERE key = 'auto_purchase_enabled'").get();
    res.json({
      ...status,
      // Prefer persisted values (survive restarts) for dashboard.
      lastCheckTime: lastCheckRow?.value || status.lastCheckTime,
      checkCount: totalChecksRow ? parseInt(totalChecksRow.value || '0', 10) : status.checkCount,
      telegramConnected: telegram.isReady(),
      checkInterval: parseInt(intervalRow?.value || process.env.CHECK_INTERVAL_MINUTES || 5),
      autoPurchaseEnabled: (autoPurchaseRow?.value || process.env.AUTO_PURCHASE_ENABLED) === 'true',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Notifications
app.get("/api/notifications", (req, res) => {
  try {
    const notifications = db.prepare(
      `SELECT n.*, p.name as product_name, p.store FROM notifications n
       LEFT JOIN products p ON n.product_id = p.id
       ORDER BY n.sent_at DESC LIMIT 100`
    ).all();
    res.json(notifications);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual check
app.post("/api/check", async (req, res) => {
  res.json({ ok: true });
  checker.checkAll(null, { force: true }).catch(e => console.error('Manual full check failed:', e.message));
});

app.post("/api/check/bulk", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(id => parseInt(id, 10)).filter(id => Number.isFinite(id))
      : [];

    if (ids.length === 0) {
      return res.status(400).json({ error: "ids array required" });
    }

    if (checker.getStatus().isChecking) {
      return res.status(409).json({ error: "Preverjanje že poteka" });
    }

    res.json({ ok: true, queued: ids.length });
    checker.checkProductsByIds(ids, { forceNotify: true }).catch(e => console.error('Bulk filtered check failed:', e.message));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/check/:id", async (req, res) => {
  res.json({ ok: true });
  checker.checkSingleProduct(parseInt(req.params.id, 10)).catch(e => console.error('Manual single check failed:', e.message));
});

// Analyze URL (scrape without saving)
app.post("/api/analyze-url", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });

    let detectedStore = detectStoreFromUrl(url);

    // Try Shopify detection
    const scraperStore = detectedStore === "custom" ? "shopify" : detectedStore;
    const storeConfig = db.prepare("SELECT * FROM store_configs WHERE store_name = ?").get(scraperStore);
    const fakeProduct = { id: 0, url, store: scraperStore, name: "" };

    let result = null;
    try { result = await scraper.scrape(fakeProduct); } catch(e) { console.error('Telegram initialization error:', e.message); }

    if (result && result.isShopify && detectedStore === "custom") detectedStore = "shopify";

    // Detect if URL is a collections page and suggest canonical product URL
    let canonicalUrl = url;
    let isCollectionsUrl = false;
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      const colIdx = parts.indexOf('collections');
      const prodIdx = parts.indexOf('products');
      if (colIdx !== -1 && prodIdx === -1) {
        isCollectionsUrl = true;
        // Try to get first product URL from this collection
        const colHandle = parts[colIdx + 1]?.split('?')[0];
        if (colHandle) {
          try {
            const colApiUrl = `${u.origin}/collections/${colHandle}/products.json?limit=1`;
            const http = require('./utils/http');
            const colRes = await http.get(colApiUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
              timeout: 6000, validateStatus: () => true,
            });
            if (colRes.status === 200 && colRes.data?.products?.[0]) {
              canonicalUrl = `${u.origin}/products/${colRes.data.products[0].handle}`;
            }
          } catch(e) { console.error('Telegram initialization error:', e.message); }
        }
      }
    } catch(e) { console.error('Telegram initialization error:', e.message); }

    res.json({
      detected_store: detectedStore,
      detected_name: result?.name || null,
      detected_price: result?.price || null,
      detected_in_stock: result?.inStock ?? null,
      detected_is_preorder: result?.isPreorder ?? false,
      detected_image: result?.imageUrl || null,
      is_collections_url: isCollectionsUrl,
      canonical_url: canonicalUrl !== url ? canonicalUrl : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Telegram settings
app.get("/api/telegram/settings", (req, res) => {
  res.json({
    token: telegram.getToken(),
    chatId: telegram.getChatId(),
    connected: telegram.isReady(),
  });
});

app.post("/api/telegram/settings", async (req, res) => {
  try {
    const { token, chatId } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });
    const connected = await telegram.reinitialize(token, chatId);
    // Persist to DB settings
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run("telegram_token", token);
    if (chatId) db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run("telegram_chat_id", chatId);
    res.json({ ok: true, connected });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/telegram/test", async (req, res) => {
  try {
    const sent = await telegram.sendMessage("🧪 Test iz Stock Trackerja — vse deluje!");
    res.json({ success: sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Keyword watches
app.get("/api/keyword-watches", (req, res) => {
  try {
    const watches = db.prepare("SELECT *, (SELECT COUNT(*) FROM json_each(known_product_urls)) as known_count FROM keyword_watches ORDER BY created_at DESC").all();
    res.json(watches.map(w => ({ ...w, known_count: w.known_count || 0, active: w.active !== 0 })));
  } catch (e) {
    // Fallback without json_each
    try {
      const watches = db.prepare("SELECT * FROM keyword_watches ORDER BY created_at DESC").all();
      res.json(watches.map(w => {
        let knownCount = 0;
        try { knownCount = JSON.parse(w.known_product_urls || "[]").length; } catch(e2) {}
        return { ...w, known_count: knownCount, active: w.active !== 0 };
      }));
    } catch(e2) { res.status(500).json({ error: e2.message }); }
  }
});

app.post("/api/keyword-watches", async (req, res) => {
  try {
    const {
      keyword, store_url, search_url,
      notify_new_products, notify_in_stock, auto_add_tracking,
      check_interval_minutes, min_price, max_price,
      include_keywords, exclude_keywords
    } = req.body;
    if (!keyword || !store_url) return res.status(400).json({ error: "keyword and store_url required" });

    const normalizedStoreUrl = new URL(store_url).toString();
    const normalizedSearchUrl = (() => {
      if (!search_url) return null;
      const raw = String(search_url).trim();
      if (!raw) return null;
      return raw.startsWith("http") ? raw : new URL(raw, normalizedStoreUrl).toString();
    })();
    const storeName = detectStoreFromUrl(normalizedStoreUrl);

    const result = db.prepare(
      `INSERT INTO keyword_watches (keyword, store_url, store_name, search_url, notify_new_products, notify_in_stock, auto_add_tracking, check_interval_minutes, min_price, max_price, include_keywords, exclude_keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(keyword, normalizedStoreUrl, storeName, normalizedSearchUrl,
      notify_new_products !== false ? 1 : 0,
      notify_in_stock !== false ? 1 : 0,
      auto_add_tracking ? 1 : 0,
      parseInt(check_interval_minutes) || 0,
      min_price ? parseFloat(min_price) : null,
      max_price ? parseFloat(max_price) : null,
      include_keywords || null,
      exclude_keywords || null);
    const watch = db.prepare("SELECT * FROM keyword_watches WHERE id = ?").get(result.lastInsertRowid);

    // Respond immediately, then run the first check in background (no delay)
    res.json(watch);
    keywordWatcher.checkWatch(watch).catch(e => console.error('Initial keyword check failed:', e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/keyword-watches/:id", async (req, res) => {
  try {
    const {
      keyword, store_url, search_url,
      notify_new_products, notify_in_stock, auto_add_tracking,
      check_interval_minutes, min_price, max_price,
      include_keywords, exclude_keywords
    } = req.body;
    const normalizedStoreUrl = new URL(store_url).toString();
    const normalizedSearchUrl = (() => {
      if (!search_url) return null;
      const raw = String(search_url).trim();
      if (!raw) return null;
      return raw.startsWith("http") ? raw : new URL(raw, normalizedStoreUrl).toString();
    })();
    const storeName = detectStoreFromUrl(normalizedStoreUrl);
    db.prepare(
      `UPDATE keyword_watches SET keyword=?, store_url=?, store_name=?, search_url=?, notify_new_products=?, notify_in_stock=?, auto_add_tracking=?, check_interval_minutes=?, min_price=?, max_price=?, include_keywords=?, exclude_keywords=?, updated_at=datetime('now') WHERE id=?`
    ).run(keyword, normalizedStoreUrl, storeName, normalizedSearchUrl,
      notify_new_products !== false ? 1 : 0, notify_in_stock !== false ? 1 : 0, auto_add_tracking ? 1 : 0,
      parseInt(check_interval_minutes) || 0,
      min_price ? parseFloat(min_price) : null,
      max_price ? parseFloat(max_price) : null,
      include_keywords || null,
      exclude_keywords || null,
      req.params.id);
    res.json({ ok: true });
    // Re-run check after edit (in background)
    const watch = db.prepare("SELECT * FROM keyword_watches WHERE id = ?").get(req.params.id);
    if (watch) setTimeout(() => keywordWatcher.checkWatch(watch), 300);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/keyword-watches/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM keyword_watches WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/keyword-watches/:id/check", async (req, res) => {
  res.json({ ok: true });
  // Reset known products and count before manual check so deleted products are re-discovered
  db.prepare("UPDATE keyword_watches SET known_product_urls='[]', known_stock_map='{}', last_found_count=0 WHERE id=?").run(req.params.id);
  const watch = db.prepare("SELECT * FROM keyword_watches WHERE id = ?").get(req.params.id);
  if (watch) keywordWatcher.checkWatch(watch);
});

app.post("/api/keyword-watches/:id/reset", (req, res) => {
  try {
    db.prepare("UPDATE keyword_watches SET known_product_urls='[]', known_stock_map='{}' WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Category watches
app.get("/api/category-watches", (req, res) => {
  try {
    const watches = db.prepare("SELECT *, (SELECT COUNT(*) FROM json_each(known_product_urls)) as known_count FROM category_watches ORDER BY created_at DESC").all();
    res.json(watches.map(w => ({ ...w, known_count: w.known_count || 0, active: w.active !== 0 })));
  } catch (e) {
    try {
      const watches = db.prepare("SELECT * FROM category_watches ORDER BY created_at DESC").all();
      res.json(watches.map(w => {
        let knownCount = 0;
        try { knownCount = JSON.parse(w.known_product_urls || "[]").length; } catch (e2) {}
        return { ...w, known_count: knownCount, active: w.active !== 0 };
      }));
    } catch (e2) { res.status(500).json({ error: e2.message }); }
  }
});

app.post("/api/category-watches", async (req, res) => {
  try {
    const {
      category_name, category_url,
      notify_new_products, notify_stock_changes, auto_add_tracking,
      check_interval_minutes, min_price, max_price,
      include_keywords, exclude_keywords
    } = req.body;
    if (!category_url) return res.status(400).json({ error: "category_url required" });

    const normalizedCategoryUrl = new URL(category_url).toString();
    const storeUrl = (() => {
      const u = new URL(normalizedCategoryUrl);
      return `${u.origin}/`;
    })();
    const storeName = detectStoreFromUrl(storeUrl);

    const result = db.prepare(
      `INSERT INTO category_watches (category_name, category_url, store_url, store_name, notify_new_products, notify_stock_changes, auto_add_tracking, check_interval_minutes, min_price, max_price, include_keywords, exclude_keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      category_name || null,
      normalizedCategoryUrl,
      storeUrl,
      storeName,
      notify_new_products !== false ? 1 : 0,
      notify_stock_changes ? 1 : 0,
      auto_add_tracking ? 1 : 0,
      parseInt(check_interval_minutes, 10) || 0,
      min_price ? parseFloat(min_price) : null,
      max_price ? parseFloat(max_price) : null,
      include_keywords || null,
      exclude_keywords || null,
    );
    const watch = db.prepare("SELECT * FROM category_watches WHERE id = ?").get(result.lastInsertRowid);
    res.json(watch);
    categoryWatcher.checkWatch(watch).catch(e => console.error('Initial category check failed:', e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/category-watches/:id", async (req, res) => {
  try {
    const {
      category_name, category_url,
      notify_new_products, notify_stock_changes, auto_add_tracking,
      check_interval_minutes, min_price, max_price,
      include_keywords, exclude_keywords
    } = req.body;
    const normalizedCategoryUrl = new URL(category_url).toString();
    const storeUrl = (() => {
      const u = new URL(normalizedCategoryUrl);
      return `${u.origin}/`;
    })();
    const storeName = detectStoreFromUrl(storeUrl);
    db.prepare(
      `UPDATE category_watches SET category_name=?, category_url=?, store_url=?, store_name=?, notify_new_products=?, notify_stock_changes=?, auto_add_tracking=?, check_interval_minutes=?, min_price=?, max_price=?, include_keywords=?, exclude_keywords=?, updated_at=datetime('now') WHERE id=?`
    ).run(
      category_name || null,
      normalizedCategoryUrl,
      storeUrl,
      storeName,
      notify_new_products !== false ? 1 : 0,
      notify_stock_changes !== false ? 1 : 0,
      auto_add_tracking ? 1 : 0,
      parseInt(check_interval_minutes, 10) || 0,
      min_price ? parseFloat(min_price) : null,
      max_price ? parseFloat(max_price) : null,
      include_keywords || null,
      exclude_keywords || null,
      req.params.id
    );
    res.json({ ok: true });
    const watch = db.prepare("SELECT * FROM category_watches WHERE id = ?").get(req.params.id);
    if (watch) setTimeout(() => categoryWatcher.checkWatch(watch), 300);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/category-watches/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM category_watches WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/category-watches/:id/check", async (req, res) => {
  res.json({ ok: true });
  const watch = db.prepare("SELECT * FROM category_watches WHERE id = ?").get(req.params.id);
  if (watch) categoryWatcher.checkWatch(watch);
});

app.post("/api/category-watches/:id/reset", (req, res) => {
  try {
    db.prepare("UPDATE category_watches SET known_product_urls='[]' WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Found Items (Discovered from watches)
app.get("/api/found-items", (req, res) => {
  try {
    const items = db.prepare("SELECT * FROM found_items WHERE status = 'new' ORDER BY created_at DESC").all();
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/found-items/:id/promote", async (req, res) => {
  try {
    const item = db.prepare("SELECT * FROM found_items WHERE id = ?").get(req.params.id);
    if (!item) return res.status(404).json({ error: "Item not found" });

    // Try to detect store if not set or generic
    const store = item.store === 'custom' ? detectStoreFromUrl(item.url) : item.store;

    // Get global interval
    let globalInterval = 5;
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'check_interval_minutes'").get();
      globalInterval = parseInt(row?.value || '5', 10);
    } catch(e) { console.error('Telegram initialization error:', e.message); }

    // Add to products
    const result = db.prepare(
      `INSERT INTO products (name, url, store, current_price, in_stock, is_preorder, notify_on_stock, notify_on_price_drop, check_interval_minutes, image_url)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`
    ).run(item.name, item.url, store, item.price, item.in_stock, item.is_preorder || 0, globalInterval, item.image_url);

    // Remove from found_items
    db.prepare("DELETE FROM found_items WHERE id = ?").run(req.params.id);

    // Initial check
    checker.checkSingleProduct(result.lastInsertRowid).catch(e => console.error('Initial check failed:', e.message));

    res.json({ ok: true, productId: result.lastInsertRowid });
  } catch (e) {
    if (e.message?.includes("UNIQUE")) {
      db.prepare("DELETE FROM found_items WHERE id = ?").run(req.params.id);
      return res.status(400).json({ error: "Izdelek se že sledi" });
    }
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/found-items/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM found_items WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/found-items/bulk-delete", (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array required" });
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM found_items WHERE id IN (${placeholders})`).run(...ids);
    res.json({ ok: true, deleted: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/found-items/bulk-promote", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array required" });
    
    let promoted = 0;
    let errors = 0;

    for (const id of ids) {
      try {
        const item = db.prepare("SELECT * FROM found_items WHERE id = ?").get(id);
        if (!item) continue;

        const store = item.store === 'custom' ? detectStoreFromUrl(item.url) : item.store;
        let globalInterval = 5;
        try {
          const row = db.prepare("SELECT value FROM app_settings WHERE key = 'check_interval_minutes'").get();
          globalInterval = parseInt(row?.value || '5', 10);
        } catch(e) { console.error('Telegram initialization error:', e.message); }

        db.prepare(
          `INSERT INTO products (name, url, store, current_price, in_stock, is_preorder, notify_on_stock, notify_on_price_drop, check_interval_minutes, image_url)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`
        ).run(item.name, item.url, store, item.price, item.in_stock, item.is_preorder || 0, globalInterval, item.image_url);

        db.prepare("DELETE FROM found_items WHERE id = ?").run(id);
        promoted++;
      } catch(e) { 
        if (e.message?.includes("UNIQUE")) {
          db.prepare("DELETE FROM found_items WHERE id = ?").run(id);
        }
        errors++; 
      }
    }
    res.json({ ok: true, promoted, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shopify cart
app.get("/api/cart/domains", (req, res) => {
  try {
    const cartProducts = db.prepare("SELECT * FROM products WHERE store IN ('shopify', 'pokedom', 'tcgstar', 'pikazard')").all();
    const domainMap = {};
    cartProducts.forEach(p => {
      try {
        const domain = new URL(p.url).origin;
        if (!domainMap[domain]) domainMap[domain] = { domain, store: p.store, products: [], inStock: 0 };
        domainMap[domain].products.push(p);
        if (p.in_stock) domainMap[domain].inStock++;
      } catch(e) { console.error('Telegram initialization error:', e.message); }
    });
    res.json(Object.values(domainMap));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/cart/build", async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: "domain required" });
    const products = db.prepare("SELECT * FROM products WHERE store IN ('shopify', 'pokedom', 'tcgstar', 'pikazard') AND in_stock = 1").all()
      .filter(p => { try { return new URL(p.url).origin === domain; } catch(e) { return false; } });
    if (products.length === 0) return res.json({ cartUrl: null, message: "Ni izdelkov na zalogi", items: [] });
    // Load cart quantity mode setting
    const modeRow = db.prepare("SELECT value FROM app_settings WHERE key = 'cart_qty_mode'").get();
    const cartQtyMode = modeRow?.value || 'global'; // 'global' | 'per_product' | 'tampermonkey'
    // Load global_max_qty setting
    const globalMaxRow = db.prepare("SELECT value FROM app_settings WHERE key = 'global_max_qty'").get();
    const globalMaxQty = globalMaxRow ? parseInt(globalMaxRow.value) || null : null;
    const result = await buildCartForProducts(products, globalMaxQty, cartQtyMode);
    res.json({ ...result, cartQtyMode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/cart-helper/pikazard", (req, res) => {
  const items = decodeCartItems(req.query.items);
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).send("Invalid cart payload");
  }

  const safeItems = items
    .filter(item => item && item.productId && item.priceId)
    .map(item => ({
      productId: String(item.productId),
      priceId: String(item.priceId),
      amount: Math.max(1, parseInt(item.amount, 10) || 1),
      language: item.language === 'en' ? 'en' : 'sk',
    }));

  if (safeItems.length === 0) {
    return res.status(400).send("No valid cart items");
  }

  res.type("html").send(`<!doctype html>
<html lang="sl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pripravljam Pikazard košarico...</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f8fafc; color: #0f172a; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
    .card { background:#fff; border:1px solid #e2e8f0; border-radius:16px; padding:24px; max-width:520px; box-shadow:0 10px 30px rgba(15,23,42,.08); }
    h1 { margin:0 0 12px; font-size:20px; }
    p { margin:8px 0; line-height:1.5; }
    a { color:#2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Pripravljam Pikazard košarico</h1>
    <p>Če se popup ne odpre sam, klikni spodnji gumb.</p>
    <p><a id="manual" href="https://www.pikazard.eu/kosik/" target="pikazardCartWindow" rel="noopener noreferrer">Odpri Pikazard košarico</a></p>
    <p id="status">Dodajam ${safeItems.length} izdelkov ...</p>
  </div>
  <script>
    const items = ${JSON.stringify(safeItems)};
    const targetName = 'pikazardCartWindow';
    const statusEl = document.getElementById('status');
    const popup = window.open('https://www.pikazard.eu/', targetName);

    function submitItem(index) {
      if (index >= items.length) {
        statusEl.textContent = 'Košarica je pripravljena. Odpiram /kosik/ ...';
        setTimeout(() => {
          if (popup && !popup.closed) popup.location = 'https://www.pikazard.eu/kosik/';
        }, 900);
        return;
      }

      statusEl.textContent = 'Dodajam izdelek ' + (index + 1) + ' / ' + items.length + ' ...';
      const item = items[index];
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = 'https://www.pikazard.eu/action/Cart/addCartItem/';
      form.target = targetName;

      [['productId', item.productId], ['priceId', item.priceId], ['amount', item.amount], ['language', item.language]].forEach(([name, value]) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = String(value);
        form.appendChild(input);
      });

      document.body.appendChild(form);
      form.submit();
      form.remove();
      setTimeout(() => submitItem(index + 1), 1200);
    }

    if (!popup) {
      statusEl.textContent = 'Popup je blokiran. Dovoli popup in poskusi znova.';
    } else {
      setTimeout(() => submitItem(0), 700);
    }
  </script>
</body>
</html>`);
});

// -----------------------------
// 1) Tampermonkey static files
// Files must be placed in:
// server/tampermonkey/
// -----------------------------
const tmDir = path.join(__dirname, "tampermonkey");

if (fs.existsSync(tmDir)) {
  app.use(
    "/tm",
    express.static(tmDir, {
      setHeaders(res, filePath) {
        if (filePath.endsWith(".user.js")) {
          // Tampermonkey recognizes .user.js and prompts installation
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        } else if (filePath.endsWith(".js")) {
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "public, max-age=300");
        }
      },
    })
  );
}

// -----------------------------
// 2) Main SPA static files
// Frontend build must live in server/public
// -----------------------------
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// -----------------------------
// 3) Optional debug routes
// -----------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/debug/db-path", (req, res) => {
  res.json({ DB_PATH: process.env.DB_PATH || null });
});

// Recovery endpoint: restore data from corrupted .bak file
app.post("/api/restore-from-backup", async (req, res) => {
  const fs = require('fs');
  const initSqlJs = require('sql.js');
  const DB_PATH = process.env.DB_PATH || (fs.existsSync('/data') ? '/data/tracker.db' : require('path').join(__dirname, 'data', 'tracker.db'));
  const BAK_PATH = DB_PATH + '.bak';

  if (!fs.existsSync(BAK_PATH)) {
    return res.status(404).json({ error: 'No backup file found at ' + BAK_PATH });
  }

  try {
    const SQL = await initSqlJs();
    const buf = fs.readFileSync(BAK_PATH);
    const bakDb = new SQL.Database(buf);
    const report = { restored: {}, errors: [] };

    const tryRead = (sql) => {
      try { return bakDb.exec(sql)?.[0]?.values || []; }
      catch(e) { return null; }
    };

    // products
    const products = tryRead('SELECT name, url, store, target_price, current_price, in_stock, is_preorder, last_checked, image_url, check_interval_minutes, notify_on_stock, notify_on_price_drop, price_drop_threshold_amount, price_drop_threshold_percentage FROM products');
    if (products) {
      let count = 0;
      for (const r of products) {
        try {
          db.prepare('INSERT OR IGNORE INTO products (name, url, store, target_price, current_price, in_stock, is_preorder, last_checked, image_url, check_interval_minutes, notify_on_stock, notify_on_price_drop, price_drop_threshold_amount, price_drop_threshold_percentage) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...r);
          count++;
        } catch(e) { report.errors.push('product: ' + e.message); }
      }
      report.restored.products = count;
    }

    // keyword_watches
    const kw = tryRead('SELECT keyword, store_url, store_name, search_url, notify_new_products, auto_add_tracking, check_interval_minutes, min_price, max_price, include_keywords, exclude_keywords FROM keyword_watches');
    if (kw) {
      let count = 0;
      for (const r of kw) {
        try {
          db.prepare('INSERT OR IGNORE INTO keyword_watches (keyword, store_url, store_name, search_url, notify_new_products, auto_add_tracking, check_interval_minutes, min_price, max_price, include_keywords, exclude_keywords) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...r);
          count++;
        } catch(e) { report.errors.push('keyword_watch: ' + e.message); }
      }
      report.restored.keyword_watches = count;
    }

    // category_watches
    const cw = tryRead('SELECT category_name, category_url, store_name, notify_new_products, auto_add_tracking, check_interval_minutes, min_price, max_price, include_keywords, exclude_keywords FROM category_watches');
    if (cw) {
      let count = 0;
      for (const r of cw) {
        try {
          db.prepare('INSERT OR IGNORE INTO category_watches (category_name, category_url, store_name, notify_new_products, auto_add_tracking, check_interval_minutes, min_price, max_price, include_keywords, exclude_keywords) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...r);
          count++;
        } catch(e) { report.errors.push('category_watch: ' + e.message); }
      }
      report.restored.category_watches = count;
    }

    // app_settings
    const settings = tryRead('SELECT key, value FROM app_settings');
    if (settings) {
      for (const r of settings) {
        try { db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)').run(...r); } catch(e) {}
      }
      report.restored.app_settings = settings.length;
    }

    bakDb.close();
    res.json({ ok: true, report });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// 4) SPA fallback (MUST be last)
// -----------------------------
app.get("*", (req, res) => {
  const indexPath = path.join(publicDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    return res.status(503).send(
      "Frontend not built yet. Run: cd client && npm run build && cp -r build/* ../server/public/"
    );
  }
  res.sendFile(indexPath);
});

// -----------------------------
// 5) Start server
// -----------------------------
const PORT = process.env.PORT || 3000;

async function start() {

  await initDatabase();

  // Migration: clean tracking params from existing product URLs
  try {
    const allProds = db.prepare('SELECT id, url FROM products').all();
    const trackingParams = ['_pos','_sid','_ss','_ga','_gl','ref','fbclid','gclid','utm_source','utm_medium','utm_campaign'];
    for (const p of allProds) {
      try {
        const u = new URL(p.url);
        let changed = false;
        trackingParams.forEach(param => { if (u.searchParams.has(param)) { u.searchParams.delete(param); changed = true; } });
        if (u.hash) { u.hash = ''; changed = true; }
        if (u.searchParams.toString() === '') { u.search = ''; }
        if (changed) {
          db.prepare('UPDATE products SET url = ? WHERE id = ?').run(u.toString(), p.id);
          console.log(`🧹 Cleaned URL for product ${p.id}: ${u.toString()}`);
        }
      } catch(e) { console.error('Telegram initialization error:', e.message); }
    }
  } catch(e) { console.log('URL cleanup skipped:', e.message); }

  // Start cron jobs
  rescheduleGlobalCheck();

  // Restore telegram settings from DB
  try {
    const tokenRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_token'").get();
    const chatRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_chat_id'").get();
    await telegram.initialize(tokenRow?.value, chatRow?.value);
  } catch(e) { console.error('Telegram initialization error:', e.message); }

  // Register Telegram manual check handler
  telegram.onManualCheckHandler(() => checker.checkAll(null, { force: true }));

  // Cron: check stocks on interval (read from DB, fallback to env)
  const intervalRow = db.prepare("SELECT value FROM app_settings WHERE key = 'check_interval_minutes'").get();

  // Cron: keyword watches — check every minute, individual intervals are respected inside checkAll()
  cron.schedule("* * * * *", () => keywordWatcher.checkAll());
  cron.schedule("* * * * *", () => categoryWatcher.checkAll());

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch(err => { console.error("Startup failed:", err); process.exit(1); });
