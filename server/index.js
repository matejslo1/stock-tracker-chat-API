// server/index.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
const rateLimit = require("express-rate-limit");
const { initDatabase } = require("./utils/database");
const db = require("./utils/database");
const checker = require("./utils/checker");
const keywordWatcher = require("./utils/keyword-watcher");
const telegram = require("./utils/telegram");
const scraper = require("./scrapers/generic");
const { buildCartUrl, buildCartUrlForProducts } = require("./utils/shopify-cart");


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
    const { name, store, target_price, auto_purchase, notify_on_stock, notify_on_price_drop, check_interval_minutes, max_order_qty } = req.body;
    let { url } = req.body;
    if (!name || !url) return res.status(400).json({ error: "name and url required" });
    // Strip Shopify tracking params from URL before saving
    try {
      const u = new URL(url);
      ['_pos','_sid','_ss','_ga','_gl','ref','fbclid','gclid','utm_source','utm_medium','utm_campaign'].forEach(p => u.searchParams.delete(p));
      if (u.searchParams.toString() === '') u.search = '';
      u.hash = '';
      url = u.toString();
    } catch(e) {}
    const result = db.prepare(
      `INSERT INTO products (name, url, store, target_price, auto_purchase, notify_on_stock, notify_on_price_drop, check_interval_minutes, max_order_qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, url, store || "custom", target_price || null,
      auto_purchase ? 1 : 0, notify_on_stock !== false ? 1 : 0,
      notify_on_price_drop ? 1 : 0, check_interval_minutes || 0,
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
    const { name, url, store, target_price, auto_purchase, notify_on_stock, notify_on_price_drop, check_interval_minutes, max_order_qty } = req.body;
    db.prepare(
      `UPDATE products SET name=?, url=?, store=?, target_price=?, auto_purchase=?, notify_on_stock=?, notify_on_price_drop=?, check_interval_minutes=?, max_order_qty=?, updated_at=datetime('now') WHERE id=?`
    ).run(name, url, store, target_price || null,
      auto_purchase ? 1 : 0, notify_on_stock ? 1 : 0,
      notify_on_price_drop ? 1 : 0, check_interval_minutes || 0,
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
    const builtIn = ['amazon','bigbang','mimovrste','shopify','custom'];
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
    const allowed = ['check_interval_minutes', 'auto_purchase_enabled', 'quiet_hours', 'daily_report'];
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
  checker.checkAll(null, { force: true });
});

app.post("/api/check/:id", async (req, res) => {
  res.json({ ok: true });
  checker.checkSingleProduct(parseInt(req.params.id));
});

// Analyze URL (scrape without saving)
app.post("/api/analyze-url", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });

    const hostname = new URL(url).hostname;
    let detectedStore = "custom";
    if (hostname.includes("amazon")) detectedStore = "amazon";
    else if (hostname.includes("bigbang")) detectedStore = "bigbang";
    else if (hostname.includes("mimovrste")) detectedStore = "mimovrste";

    // Try Shopify detection
    const storeConfig = db.prepare("SELECT * FROM store_configs WHERE store_name = ?").get(detectedStore === "custom" ? "shopify" : detectedStore);
    const fakeProduct = { id: 0, url, store: detectedStore === "custom" ? "shopify" : detectedStore, name: "" };

    let result = null;
    try { result = await scraper.scrape(fakeProduct); } catch(e) {}

    if (result && result.isShopify) detectedStore = "shopify";

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
          } catch(e) {}
        }
      }
    } catch(e) {}

    res.json({
      detected_store: detectedStore,
      detected_name: result?.name || null,
      detected_price: result?.price || null,
      detected_in_stock: result?.inStock ?? null,
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
    const { keyword, store_url, search_url, notify_new_products, notify_in_stock, auto_add_tracking, check_interval_minutes, min_price, max_price } = req.body;
    if (!keyword || !store_url) return res.status(400).json({ error: "keyword and store_url required" });

    try { db.prepare("ALTER TABLE keyword_watches ADD COLUMN check_interval_minutes INTEGER DEFAULT 0").run(); } catch(e) {}
    try { db.prepare("ALTER TABLE keyword_watches ADD COLUMN min_price REAL DEFAULT NULL").run(); } catch(e) {}
    try { db.prepare("ALTER TABLE keyword_watches ADD COLUMN max_price REAL DEFAULT NULL").run(); } catch(e) {}

    const detectStoreName = (url) => {
      if (url.includes("amazon")) return "amazon";
      if (url.includes("bigbang.si")) return "bigbang";
      if (url.includes("mimovrste.com")) return "mimovrste";
      return "shopify";
    };
    const storeName = detectStoreName(store_url);

    const result = db.prepare(
      `INSERT INTO keyword_watches (keyword, store_url, store_name, search_url, notify_new_products, notify_in_stock, auto_add_tracking, check_interval_minutes, min_price, max_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(keyword, store_url, storeName, search_url || null,
      notify_new_products !== false ? 1 : 0,
      notify_in_stock !== false ? 1 : 0,
      auto_add_tracking ? 1 : 0,
      parseInt(check_interval_minutes) || 0,
      min_price ? parseFloat(min_price) : null,
      max_price ? parseFloat(max_price) : null);
    const watch = db.prepare("SELECT * FROM keyword_watches WHERE id = ?").get(result.lastInsertRowid);

    // Respond immediately, then run the first check in background (no delay)
    res.json(watch);
    keywordWatcher.checkWatch(watch).catch(e => console.error('Initial keyword check failed:', e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/keyword-watches/:id", async (req, res) => {
  try {
    const { keyword, store_url, search_url, notify_new_products, notify_in_stock, auto_add_tracking, check_interval_minutes, min_price, max_price } = req.body;
    const detectStoreName = (url) => {
      if (url.includes("amazon")) return "amazon";
      if (url.includes("bigbang.si")) return "bigbang";
      if (url.includes("mimovrste.com")) return "mimovrste";
      return "shopify";
    };
    const storeName = detectStoreName(store_url);
    db.prepare(
      `UPDATE keyword_watches SET keyword=?, store_url=?, store_name=?, search_url=?, notify_new_products=?, notify_in_stock=?, auto_add_tracking=?, check_interval_minutes=?, min_price=?, max_price=?, updated_at=datetime('now') WHERE id=?`
    ).run(keyword, store_url, storeName, search_url || null,
      notify_new_products ? 1 : 0, notify_in_stock ? 1 : 0, auto_add_tracking ? 1 : 0,
      parseInt(check_interval_minutes) || 0,
      min_price ? parseFloat(min_price) : null,
      max_price ? parseFloat(max_price) : null,
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
  const watch = db.prepare("SELECT * FROM keyword_watches WHERE id = ?").get(req.params.id);
  if (watch) keywordWatcher.checkWatch(watch);
});

app.post("/api/keyword-watches/:id/reset", (req, res) => {
  try {
    db.prepare("UPDATE keyword_watches SET known_product_urls='[]', known_stock_map='{}' WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shopify cart
app.get("/api/cart/domains", (req, res) => {
  try {
    const shopifyProducts = db.prepare("SELECT * FROM products WHERE store = 'shopify'").all();
    const domainMap = {};
    shopifyProducts.forEach(p => {
      try {
        const domain = new URL(p.url).origin;
        if (!domainMap[domain]) domainMap[domain] = { domain, products: [], inStock: 0 };
        domainMap[domain].products.push(p);
        if (p.in_stock) domainMap[domain].inStock++;
      } catch(e) {}
    });
    res.json(Object.values(domainMap));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/cart/build", async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: "domain required" });
    const products = db.prepare("SELECT * FROM products WHERE store = 'shopify' AND in_stock = 1").all()
      .filter(p => { try { return new URL(p.url).origin === domain; } catch(e) { return false; } });
    if (products.length === 0) return res.json({ cartUrl: null, message: "Ni izdelkov na zalogi", items: [] });
    const result = await buildCartUrlForProducts(products);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        if (filePath.endsWith(".js")) {
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
      } catch(e) {}
    }
  } catch(e) { console.log('URL cleanup skipped:', e.message); }

  // Start cron jobs
  rescheduleGlobalCheck();

  // Restore telegram settings from DB
  try {
    const tokenRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_token'").get();
    const chatRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_chat_id'").get();
    if (tokenRow) await telegram.initialize(tokenRow.value, chatRow?.value);
  } catch(e) {}

  // Register Telegram manual check handler
  telegram.onManualCheckHandler(() => checker.checkAll(null, { force: true }));

  // Cron: check stocks on interval (read from DB, fallback to env)
  const intervalRow = db.prepare("SELECT value FROM app_settings WHERE key = 'check_interval_minutes'").get();

  // Cron: keyword watches — check every minute, individual intervals are respected inside checkAll()
  cron.schedule("* * * * *", () => keywordWatcher.checkAll());

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch(err => { console.error("Startup failed:", err); process.exit(1); });
