const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const { detectStoreFromUrl, KNOWN_STORES } = require('./storeDetection');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'tracker.db');
const DB_PATH = process.env.DB_PATH || (fs.existsSync('/data') ? '/data/tracker.db' : DEFAULT_DB_PATH);
const dataDir = path.dirname(DB_PATH);
const TEMP_DB_PATH = DB_PATH + '.tmp';

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;
let isDirty = false;
let pendingSaveTimeout = null;
let sqlRuntime = null;
let sqlRuntimePromise = null;
let initPromise = null;

function isRecoverableWasmError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('memory access out of bounds');
}

async function getSqlRuntime() {
  if (sqlRuntime) return sqlRuntime;
  if (!sqlRuntimePromise) {
    sqlRuntimePromise = initSqlJs().then((SQL) => {
      sqlRuntime = SQL;
      return SQL;
    });
  }
  return sqlRuntimePromise;
}

function createEmptyDatabase(SQL) {
  db = new SQL.Database();
  console.log('Created new database');
}

function loadDatabaseFromFile(SQL) {
  if (!fs.existsSync(DB_PATH)) {
    createEmptyDatabase(SQL);
    return;
  }

  const fileBuffer = fs.readFileSync(DB_PATH);
  try {
    db = new SQL.Database(fileBuffer);
    db.run('PRAGMA journal_mode = MEMORY');
    db.run('PRAGMA foreign_keys = ON');
    const integrityResult = db.exec('PRAGMA integrity_check');
    const integrityOk = integrityResult?.[0]?.values?.[0]?.[0] === 'ok';
    if (!integrityOk) throw new Error('integrity_check failed');
    console.log('Loaded existing database');
  } catch (e) {
    console.error('Database corrupted (' + e.message + '), starting fresh. Backup saved as tracker.db.bak');
    try {
      fs.copyFileSync(DB_PATH, DB_PATH + '.bak');
    } catch (_) {}
    db = new SQL.Database();
    console.log('Created new database (recovery)');
  }
}

function recoverDatabase(error, context) {
  if (!isRecoverableWasmError(error) || !sqlRuntime) throw error;

  console.error('Recoverable sql.js error during ' + context + ': ' + error.message);
  try {
    if (db) db.close();
  } catch (_) {}
  db = null;
  isDirty = false;
  loadDatabaseFromFile(sqlRuntime);
}

function withRecovery(context, operation) {
  try {
    return operation();
  } catch (error) {
    if (!isRecoverableWasmError(error)) throw error;
    recoverDatabase(error, context);
    return operation();
  }
}

// Save DB to file
function saveToFile() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(TEMP_DB_PATH, buffer);
    fs.renameSync(TEMP_DB_PATH, DB_PATH);
    isDirty = false;
  } catch (e) {
    console.error('Failed to save database:', e.message);
    try {
      if (fs.existsSync(TEMP_DB_PATH)) fs.unlinkSync(TEMP_DB_PATH);
    } catch (_) {}
  }
}


function scheduleSave() {
  if (!db) return;
  isDirty = true;

  // Debounce frequent writes; flush at most once every SAVE_DEBOUNCE_MS
  const debounceMs = parseInt(process.env.SAVE_DEBOUNCE_MS || '5000', 10);
  if (pendingSaveTimeout) return;
  pendingSaveTimeout = setTimeout(() => {
    pendingSaveTimeout = null;
    if (isDirty) saveToFile();
  }, debounceMs);
}

// Auto-save interval
let saveInterval = null;

// Initialize database (must be called before use)
async function initDatabase() {
  if (db) return db;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const SQL = await getSqlRuntime();
    loadDatabaseFromFile(SQL);

    if (!db.run) throw new Error('DB not initialized');
    try { db.run('PRAGMA journal_mode = MEMORY'); } catch(_) {}
    try { db.run('PRAGMA foreign_keys = ON'); } catch(_) {}

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      store TEXT NOT NULL,
      target_price REAL,
      current_price REAL,
      currency TEXT DEFAULT 'EUR',
      in_stock INTEGER DEFAULT 0,
      is_preorder INTEGER DEFAULT 0,
      last_checked TEXT,
      last_in_stock TEXT,
      auto_purchase INTEGER DEFAULT 0,
      notify_on_stock INTEGER DEFAULT 1,
      notify_on_price_drop INTEGER DEFAULT 0,
      price_drop_threshold_amount REAL DEFAULT 0,
      price_drop_threshold_percentage REAL DEFAULT 0,
      image_url TEXT,
      selector_config TEXT,
      check_interval_minutes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Add check_interval_minutes column if it doesn't exist (migration)
  try {
    db.run('ALTER TABLE products ADD COLUMN check_interval_minutes INTEGER DEFAULT 0');
  } catch(e) { /* column already exists */ }

  try {
    db.run('ALTER TABLE products ADD COLUMN is_preorder INTEGER DEFAULT 0');
  } catch(e) { /* column already exists */ }

  // Add shopify_variant_id column if it doesn't exist (migration)
  try { db.run('ALTER TABLE products ADD COLUMN shopify_variant_id TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE products ADD COLUMN max_order_qty INTEGER DEFAULT 1'); } catch(e) {}
  try { db.run('ALTER TABLE products ADD COLUMN price_drop_threshold_amount REAL DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE products ADD COLUMN price_drop_threshold_percentage REAL DEFAULT 0'); } catch(e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS stock_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      in_stock INTEGER NOT NULL,
      price REAL,
      checked_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    )
  `);


  // Migration: allow notifications without a product (e.g. keyword watch events)
  try {
    const info = db.exec("PRAGMA table_info('notifications')");
    if (info && info[0] && info[0].values) {
      const cols = info[0].values.map(v => ({ name: v[1], notnull: v[3] }));
      const productIdCol = cols.find(c => c.name === 'product_id');
      if (productIdCol && productIdCol.notnull === 1) {
        console.log('🔧 Migrating notifications.product_id to nullable...');
        db.run(`
          CREATE TABLE IF NOT EXISTS notifications_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            sent_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
          )
        `);
        db.run(`
          INSERT INTO notifications_new (id, product_id, type, message, sent_at)
          SELECT id, product_id, type, message, sent_at FROM notifications
        `);
        db.run("DROP TABLE notifications");
        db.run("ALTER TABLE notifications_new RENAME TO notifications");
      }
    }
  } catch(e) {
    // Ignore migration errors; table might not exist yet
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      details TEXT,
      attempted_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS store_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_name TEXT NOT NULL UNIQUE,
      base_url TEXT NOT NULL,
      stock_selector TEXT,
      price_selector TEXT,
      add_to_cart_selector TEXT,
      out_of_stock_text TEXT,
      in_stock_text TEXT,
      requires_puppeteer INTEGER DEFAULT 0,
      config_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS keyword_watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      store_url TEXT NOT NULL,
      store_name TEXT NOT NULL,
      search_url TEXT,
      notify_new_products INTEGER DEFAULT 1,
      notify_in_stock INTEGER DEFAULT 1,
      auto_add_tracking INTEGER DEFAULT 0,
      known_product_urls TEXT DEFAULT '[]',
      known_stock_map TEXT DEFAULT '{}',
      last_checked TEXT,
      last_found_count INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      check_interval_minutes INTEGER DEFAULT 0,
      min_price REAL DEFAULT NULL,
      max_price REAL DEFAULT NULL,
      include_keywords TEXT DEFAULT NULL,
      exclude_keywords TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS category_watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_name TEXT,
      category_url TEXT NOT NULL,
      store_url TEXT NOT NULL,
      store_name TEXT NOT NULL,
      notify_new_products INTEGER DEFAULT 1,
      auto_add_tracking INTEGER DEFAULT 0,
      known_product_urls TEXT DEFAULT '[]',
      last_checked TEXT,
      last_found_count INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      check_interval_minutes INTEGER DEFAULT 0,
      min_price REAL DEFAULT NULL,
      max_price REAL DEFAULT NULL,
      include_keywords TEXT DEFAULT NULL,
      exclude_keywords TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add known_stock_map if not exists
  try { db.run("ALTER TABLE keyword_watches ADD COLUMN known_stock_map TEXT DEFAULT '{}'"); } catch(e) {}

  // Migration: add check_interval_minutes to keyword_watches (per-watch scan interval)
  try { db.run("ALTER TABLE keyword_watches ADD COLUMN check_interval_minutes INTEGER DEFAULT 0"); } catch(e) {}
  // Migration: add price filters
  try { db.run("ALTER TABLE keyword_watches ADD COLUMN min_price REAL DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE keyword_watches ADD COLUMN max_price REAL DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE category_watches ADD COLUMN check_interval_minutes INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE category_watches ADD COLUMN min_price REAL DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE category_watches ADD COLUMN max_price REAL DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE keyword_watches ADD COLUMN include_keywords TEXT DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE keyword_watches ADD COLUMN exclude_keywords TEXT DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE category_watches ADD COLUMN include_keywords TEXT DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE category_watches ADD COLUMN exclude_keywords TEXT DEFAULT NULL"); } catch(e) {}

  // Migration: fix products where store = hostname (e.g. 'tcgstar.eu') instead of valid store name
  // Auto-upgrade to the correct built-in store based on the URL/domain.
  try {
    const validStores = KNOWN_STORES; // ['amazon','bigbang','mimovrste','shopify','custom','tcgstar','pikazard','pokedom']
    const allProducts = db.exec("SELECT id, url, store FROM products");
    if (allProducts && allProducts[0]) {
      const rows = allProducts[0].values;
      for (const [id, url, store] of rows) {
        if (!validStores.includes(store)) {
          const newStore = detectStoreFromUrl(url);
          db.run("UPDATE products SET store = ? WHERE id = ?", [newStore, id]);
          console.log(`🔧 Fixed store for product ${id}: '${store}' → '${newStore}'`);
        }
      }
    }
  } catch(e) { console.log('Store migration skipped:', e.message); }

  // Insert default store configurations
  const defaultStores = [
    {
      name: 'amazon',
      base_url: 'https://www.amazon.de',
      stock_selector: '#availability span, #add-to-cart-button',
      price_selector: '.a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice',
      add_to_cart: '#add-to-cart-button',
      out_of_stock: 'Derzeit nicht verfügbar,Currently unavailable,Trenutno ni na voljo',
      in_stock: 'Auf Lager,In Stock,Na zalogi',
      puppeteer: 1,
      config: JSON.stringify({ locale: 'de' })
    },
    {
      name: 'bigbang',
      base_url: 'https://www.bigbang.si',
      stock_selector: '.product-availability, .add-to-cart-button, .availability-status',
      price_selector: '.product-price .price, .current-price',
      add_to_cart: '.add-to-cart-button, button[data-action="addToCart"]',
      out_of_stock: 'Ni na zalogi,Razprodano,Nedostopno',
      in_stock: 'Na zalogi,Dobavljivo,V košarico',
      puppeteer: 1,
      config: JSON.stringify({ locale: 'si' })
    },
    {
      name: 'mimovrste',
      base_url: 'https://www.mimovrste.com',
      stock_selector: '.product-availability, .add-to-basket, .availability, .watchdog-button-b',
      price_selector: '.price__relevant, .product-price__relevant, .product-price, .price-current, .selling-price',
      add_to_cart: '.add-to-cart-list, .add-to-basket, .btn-add-to-cart',
      out_of_stock: 'Ni na zalogi,Razprodano,Pričakovano,Trenutno ni na zalogi,Zanima me',
      in_stock: 'Na zalogi,Dobavljivo,V košarico',
      puppeteer: 1,
      config: JSON.stringify({ locale: 'si' })
    },
    {
      name: 'shopify',
      base_url: '',
      stock_selector: 'button[name="add"], .product-form__submit, form[action="/cart/add"] button[type="submit"], .shopify-payment-button',
      price_selector: '.price-item--regular, .price__regular .price-item, .product__price, .price-item--sale, .price .money, .product-price',
      add_to_cart: 'button[name="add"], .product-form__submit, form[action="/cart/add"] button[type="submit"]',
      out_of_stock: 'ni na zalogi,sold out,out of stock,unavailable,razprodano',
      in_stock: 'v kosharico,add to cart,dodaj v kosharico,buy now,v kosarico',
      puppeteer: 0,
      config: JSON.stringify({ platform: 'shopify' })
    },
    {
      name: 'tcgstar',
      base_url: 'https://tcgstar.eu',
      stock_selector: 'button[name="add"], .product-form__submit, form[action="/cart/add"] button[type="submit"], .shopify-payment-button',
      price_selector: '.price-item--regular, .price__regular .price-item, .product__price, .price-item--sale, .price .money, .product-price',
      add_to_cart: 'button[name="add"], .product-form__submit, form[action="/cart/add"] button[type="submit"]',
      out_of_stock: 'ni na zalogi,sold out,out of stock,unavailable,razprodano',
      in_stock: 'v kosharico,add to cart,dodaj v kosharico,buy now,v kosarico',
      puppeteer: 0,
      config: JSON.stringify({
        platform: 'shopify',
        locale: 'sl',
        search_url: '/search?options%5Bprefix%5D=last&q={keyword}&type=product',
        preorder_terms: ['prednaročilo', 'prednarocilo', 'preorder', 'pre-order'],
        collections_url: '/collections'
      })
    },
    {
      name: 'pokedom',
      base_url: 'https://pokedom.eu',
      stock_selector: 'button[name="add"], .product-form__submit, form[action="/cart/add"] button[type="submit"], .shopify-payment-button',
      price_selector: '.hdt-price .money, .hdt-price__current, .price-item--regular, .price .money, .product-price',
      add_to_cart: 'button[name="add"], .product-form__submit, form[action="/cart/add"] button[type="submit"]',
      out_of_stock: 'sold out,out of stock,rasprodano,nije dostupno',
      in_stock: 'add to cart,dodaj u kosaricu,dodaj u košaricu,kupi odmah',
      puppeteer: 0,
      config: JSON.stringify({
        platform: 'shopify',
        locale: 'hr',
        search_url: '/search?options%5Bprefix%5D=last&q={keyword}&type=product',
        preorder_terms: ['prednarudžba', 'prednarudzba', 'preorder', 'pre-order'],
        preorder_collection: '/collections/prednarudzbe'
      })
    },
    {
      // Pikazard.eu — Shoptet platform (Slovak), NOT Shopify
      // Stock: .availability-label shows "Skladom" / "Nedostupné"
      // Price: strong.price-final or .price-final-holder .price-final
      // Cart: button.add-to-cart-button (class: "btn btn-lg btn-conversion add-to-cart-button")
      name: 'pikazard',
      base_url: 'https://www.pikazard.eu',
      stock_selector: '.availability-label, .availability-value, .availability',
      price_selector: 'strong.price-final, .price-final-holder .price-final, .price-final, [itemprop="price"]',
      add_to_cart: 'button.add-to-cart-button, .btn-conversion.add-to-cart-button, .add-to-cart-button',
      out_of_stock: 'vypredané,nie je skladom,nedostupné,na objednávku,nedostupný,dopyt',
      in_stock: 'skladom,pridať do košíka,do košíka',
      puppeteer: 0,
      config: JSON.stringify({
        platform: 'shoptet',
        locale: 'sk',
        search_url: '/vyhladavanie/?string={keyword}',
        preorder_terms: ['predobjednávka', 'predobjednavka', 'preorder', 'pre-order'],
        brand_collection: '/znacka/pokemon-company/'
      })
    },
    {
      name: 'custom',
      base_url: '',
      stock_selector: '',
      price_selector: '',
      add_to_cart: '',
      out_of_stock: 'out of stock,sold out,unavailable',
      in_stock: 'in stock,add to cart,buy now',
      puppeteer: 1,
      config: JSON.stringify({})
    }
  ];

  // TCG-specific stores always get updated (OR REPLACE) so selector fixes are applied to existing DBs.
  // Other stores use OR IGNORE to avoid overwriting user customisations.
  const managedStores = ['tcgstar', 'pikazard', 'pokedom', 'mimovrste'];
  defaultStores.forEach(store => {
    try {
      const verb = managedStores.includes(store.name) ? 'OR REPLACE' : 'OR IGNORE';
      db.run(
        `INSERT ${verb} INTO store_configs (store_name, base_url, stock_selector, price_selector, add_to_cart_selector, out_of_stock_text, in_stock_text, requires_puppeteer, config_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [store.name, store.base_url, store.stock_selector, store.price_selector,
         store.add_to_cart, store.out_of_stock, store.in_stock, store.puppeteer, store.config]
      );
    } catch (e) {
      // Ignore duplicates
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS found_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      price REAL,
      store TEXT NOT NULL,
      image_url TEXT,
      in_stock INTEGER DEFAULT NULL,
      is_preorder INTEGER DEFAULT 0,
      source_type TEXT, -- 'keyword' or 'category'
      source_id INTEGER,
      status TEXT DEFAULT 'new',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add source_type, source_id if not exists
  try { db.run("ALTER TABLE found_items ADD COLUMN source_type TEXT"); } catch(e) {}
  try { db.run("ALTER TABLE found_items ADD COLUMN source_id INTEGER"); } catch(e) {}
  try { db.run("ALTER TABLE found_items ADD COLUMN in_stock INTEGER DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE found_items ADD COLUMN is_preorder INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE found_items ADD COLUMN original_price REAL"); } catch(e) {}
  try { db.run("ALTER TABLE found_items ADD COLUMN status TEXT DEFAULT 'new'"); } catch(e) {}
  db.run("UPDATE found_items SET status = 'new' WHERE status IS NULL");
  try { db.run("ALTER TABLE category_watches ADD COLUMN notify_stock_changes INTEGER DEFAULT 0"); } catch(e) {}

  // Helpful indexes (speed up filtering & history lookups)
  // NOTE: create indexes AFTER ALL tables exist. Otherwise a fresh DB will crash.
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_products_store ON products(store);
    CREATE INDEX IF NOT EXISTS idx_products_in_stock ON products(in_stock);
    CREATE INDEX IF NOT EXISTS idx_products_last_checked ON products(last_checked);

    CREATE INDEX IF NOT EXISTS idx_stock_history_product_checked ON stock_history(product_id, checked_at);

    CREATE INDEX IF NOT EXISTS idx_notifications_product_sent ON notifications(product_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_purchase_attempts_product_attempted ON purchase_attempts(product_id, attempted_at);

    CREATE INDEX IF NOT EXISTS idx_keyword_watches_store ON keyword_watches(store_name);
    CREATE INDEX IF NOT EXISTS idx_keyword_watches_last_checked ON keyword_watches(last_checked);
    CREATE INDEX IF NOT EXISTS idx_category_watches_store ON category_watches(store_name);
    CREATE INDEX IF NOT EXISTS idx_category_watches_last_checked ON category_watches(last_checked);

    CREATE INDEX IF NOT EXISTS idx_found_items_status ON found_items(status);
    CREATE INDEX IF NOT EXISTS idx_found_items_url ON found_items(url);
  `);

  saveToFile();
  const periodicMs = parseInt(process.env.SAVE_INTERVAL_MS || '60000', 10);
  if (saveInterval) clearInterval(saveInterval);
  saveInterval = setInterval(() => { if (isDirty) saveToFile(); }, periodicMs);

  console.log('✅ Database initialized');
  return db;
  })();

  try {
    return await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}

// ============================================================
// Compatibility layer: mimic better-sqlite3 .prepare() API
// so the rest of the codebase doesn't need changes
// ============================================================

const dbProxy = {
  prepare(sql) {
    return {
      run(...params) {
        if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
        return withRecovery(`run: ${sql}`, () => {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
          db.run(sql, flatParams);
          scheduleSave();
          const result = db.exec('SELECT last_insert_rowid() as lid');
          return {
            lastInsertRowid: result.length > 0 ? Number(result[0].values[0][0]) : null,
            changes: db.getRowsModified()
          };
        });
      },
      get(...params) {
        if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
        return withRecovery(`get: ${sql}`, () => {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
          const safeParams = flatParams.map(p => p === undefined ? null : (typeof p === 'bigint' ? Number(p) : p));
          const stmt = db.prepare(sql);
          try {
            if (safeParams.length > 0) stmt.bind(safeParams);
            let row = undefined;
            if (stmt.step()) {
              row = stmt.getAsObject();
            }
            return row;
          } finally {
            stmt.free();
          }
        });
      },
      all(...params) {
        if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
        return withRecovery(`all: ${sql}`, () => {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
          const safeParams = flatParams.map(p => p === undefined ? null : (typeof p === 'bigint' ? Number(p) : p));
          const results = [];
          const stmt = db.prepare(sql);
          try {
            if (safeParams.length > 0) stmt.bind(safeParams);
            while (stmt.step()) {
              results.push(stmt.getAsObject());
            }
            return results;
          } finally {
            stmt.free();
          }
        });
      }
    };
  },

  exec(sql) {
    if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
    return withRecovery(`exec: ${sql}`, () => {
      db.run(sql);
      scheduleSave();
    });
  },

  pragma() {
    return null;
  },

  close() {
    if (saveInterval) clearInterval(saveInterval);
    if (pendingSaveTimeout) { clearTimeout(pendingSaveTimeout); pendingSaveTimeout = null; }
    if (isDirty) saveToFile();
    if (db) db.close();
    db = null;
    initPromise = null;
  }
};

module.exports = dbProxy;
module.exports.initDatabase = initDatabase;
module.exports.isInitialized = () => db !== null;
