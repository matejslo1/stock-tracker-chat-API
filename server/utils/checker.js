const db = require('../utils/database');
const telegram = require('../utils/telegram');
const scraper = require('../scrapers/generic');
const pLimit = require('p-limit');
const { detectStoreFromUrl } = require('./storeDetection');
class StockChecker {
  constructor() {
    this.isChecking = false;
    this.lastCheckTime = null;
    this.checkCount = 0;
  }

  // Persist global check stats into DB so the UI can show them even after server restart.
  // app_settings is a key/value store.
  _persistGlobalStats(nowIso) {
    try {
      db.prepare(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('last_check_at', ?, ?)"
      ).run(String(nowIso), String(nowIso));

      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'total_checks'").get();
      const prev = parseInt(row?.value || '0', 10);
      const next = Number.isFinite(prev) ? prev + 1 : 1;
      db.prepare(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('total_checks', ?, ?)"
      ).run(String(next), String(nowIso));
    } catch (e) {
      console.warn('⚠️  Could not persist global stats:', e.message);
    }
  }

  async runProductChecks(products, { forceNotify = false, label = 'products', totalCount = products.length } = {}) {
    const concurrency = Math.max(1, parseInt(process.env.SCRAPE_CONCURRENCY || '3', 10) || 3);
    const limit = pLimit(concurrency);

    await Promise.all(products.map(product => limit(async () => {
      try {
        await this.checkProduct(product, { forceNotify });

        // Small jitter after each product to be nicer to stores
        const delay = 800 + Math.random() * 1200;
        await new Promise(resolve => setTimeout(resolve, delay));
      } catch (error) {
        console.error(`❌ Error checking ${product.name}:`, error.message);
        const nowIso = new Date().toISOString();
        // Still update last_checked so UI doesn't show "Nikoli" forever
        try {
          db.prepare('UPDATE products SET last_checked = ?, updated_at = ? WHERE id = ?').run(nowIso, nowIso, product.id);
        } catch (e) {}
      }
    })));

    this.lastCheckTime = new Date().toISOString();
    this.checkCount++;
    this._persistGlobalStats(this.lastCheckTime);
    console.log(`✅ Stock check #${this.checkCount} complete. Checked ${products.length}/${totalCount} ${label}.`);
    return { checked: products.length, total: totalCount };
  }

  async checkAll(forceProductId = null, { force = false } = {}) {
    if (this.isChecking) {
      if (forceProductId) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(forceProductId);
        if (product) {
          console.log(`⚡ Force-checking newly added product: ${product.name}`);
          try { await this.checkProduct(product, { forceNotify: false }); } catch(e) { console.error(e.message); }
        }
      } else {
        console.log('⏳ Check already in progress, skipping...');
      }
      return;
    }

    this.isChecking = true;
    console.log(`\n🔍 [${new Date().toLocaleTimeString()}] Starting stock check... (force=${force})`);

    try {
      const globalInterval = parseInt(process.env.CHECK_INTERVAL_MINUTES || 5);
      const now = Date.now();
      const allProducts = db.prepare('SELECT * FROM products').all();

      const products = force ? allProducts : allProducts.filter(product => {
        const productInterval = product.check_interval_minutes && product.check_interval_minutes > 0
          ? product.check_interval_minutes
          : globalInterval;
        if (!product.last_checked) return true;
        const lastCheckedStr = product.last_checked.includes('Z') || product.last_checked.includes('+')
          ? product.last_checked
          : product.last_checked + 'Z';
        const lastCheckedMs = new Date(lastCheckedStr).getTime();
        if (isNaN(lastCheckedMs)) return true;
        const minutesSince = (now - lastCheckedMs) / 60000;
        return minutesSince >= productInterval;
      });

      console.log(`📋 ${allProducts.length} total products, ${products.length} need checking`);

      if (products.length === 0) {
        // Even if we skip because everything was checked recently, update global stats.
        this.lastCheckTime = new Date().toISOString();
        this.checkCount++;
        this._persistGlobalStats(this.lastCheckTime);
        console.log('📭 All products checked recently, skipping');
        return { checked: 0, total: allProducts.length };
      }
      return await this.runProductChecks(products, {
        forceNotify: force,
        label: 'products',
        totalCount: allProducts.length,
      });

    } catch (error) {
      console.error('❌ Stock check failed:', error.message);
    } finally {
      this.isChecking = false;
    }
  }

  async checkProductsByIds(ids, { forceNotify = true } = {}) {
    const uniqueIds = [...new Set(
      (Array.isArray(ids) ? ids : [])
        .map(id => parseInt(id, 10))
        .filter(id => Number.isFinite(id))
    )];

    if (uniqueIds.length === 0) {
      return { started: false, checked: 0, total: 0 };
    }

    if (this.isChecking) {
      console.log('⏳ Check already in progress, skipping bulk re-check...');
      return { started: false, busy: true };
    }

    const placeholders = uniqueIds.map(() => '?').join(',');
    const products = db.prepare(`SELECT * FROM products WHERE id IN (${placeholders})`).all(...uniqueIds);

    if (products.length === 0) {
      return { started: false, checked: 0, total: 0 };
    }

    this.isChecking = true;
    console.log(`\n🔍 [${new Date().toLocaleTimeString()}] Starting filtered stock check for ${products.length} products...`);

    try {
      const result = await this.runProductChecks(products, {
        forceNotify,
        label: 'filtered products',
        totalCount: products.length,
      });
      return { started: true, ...result };
    } catch (error) {
      console.error('❌ Bulk stock check failed:', error.message);
      throw error;
    } finally {
      this.isChecking = false;
    }
  }

  async checkSingleProduct(productOrId, { forceNotify = false } = {}) {
    const product = typeof productOrId === 'object' && productOrId
      ? productOrId
      : db.prepare('SELECT * FROM products WHERE id = ?').get(productOrId);

    if (!product) {
      return { started: false, missing: true };
    }

    if (this.isChecking) {
      console.log(`⚡ Running inline single-product check for: ${product.name}`);
      try {
        await this.checkProduct(product, { forceNotify });
      } catch (error) {
        console.error(`❌ Error checking ${product.name}:`, error.message);
      }
      return { started: false, inline: true };
    }

    this.isChecking = true;
    console.log(`\n🔍 [${new Date().toLocaleTimeString()}] Starting single-product stock check for: ${product.name}`);

    try {
      const result = await this.runProductChecks([product], {
        forceNotify,
        label: 'product',
        totalCount: 1,
      });
      return { started: true, ...result };
    } catch (error) {
      console.error(`❌ Single-product stock check failed for ${product.name}:`, error.message);
      throw error;
    } finally {
      this.isChecking = false;
    }
  }

  async checkProduct(product, { forceNotify = false } = {}) {
    console.log(`  📦 Checking: ${product.name} (${product.store})`);
    const nowIso = new Date().toISOString();


    const result = await scraper.scrape(product);

    if (!result) {
      console.log(`  ⚠️  Could not scrape: ${product.name}`);
      db.prepare('UPDATE products SET last_checked = ?, updated_at = ? WHERE id = ?')
        .run(nowIso, nowIso, product.id);
      return;
    }

    const wasInStock = product.in_stock === 1;
    const isNowInStock = result.inStock;
    const isNowPreorder = result.isPreorder === true;
    const oldPrice = product.current_price;
    const newPrice = result.price ? Math.round(result.price * 100) / 100 : null;
    const variantId = result.variantId || null;

    // Upgrade store type in DB if scraper auto-detected Shopify
    const detectedStore = detectStoreFromUrl(product.url);
    const effectiveStore = detectedStore !== 'custom'
      ? detectedStore
      : (result.isShopify && product.store !== 'shopify' ? 'shopify' : product.store);
    if (effectiveStore !== product.store) {
      console.log(`  🔄 Upgrading store from '${product.store}' to '${effectiveStore}' in DB`);
      db.prepare('UPDATE products SET store = ? WHERE id = ?').run(effectiveStore, product.id);
    }

    // For Shopify: probe per-order limit so we know max qty to add to cart
    if (effectiveStore === 'shopify' && isNowInStock && variantId) {
      try {
        const { detectOrderLimit } = require('./shopify-cart');
        const domain = new URL(product.url).origin;
        const probeQty = (result.stockQty && result.stockQty > 0) ? result.stockQty : 10;
        result.maxOrderQty = await detectOrderLimit(domain, variantId, probeQty);
        console.log(`  🛒 Max order qty for ${product.name}: ${result.maxOrderQty}`);
      } catch(e) {
        console.log(`  ⚠️  Could not detect order limit: ${e.message}`);
      }
    }

    // Update product in database
    db.prepare(`
      UPDATE products SET
        in_stock = ?,
        is_preorder = ?,
        store = ?,
        current_price = COALESCE(?, current_price),
        image_url = COALESCE(?, image_url),
        shopify_variant_id = COALESCE(?, shopify_variant_id),
        max_order_qty = COALESCE(?, max_order_qty),
        last_checked = ?,
        last_in_stock = CASE WHEN ? = 1 THEN ? ELSE last_in_stock END,
        updated_at = ?
      WHERE id = ?
    `).run(
      isNowInStock ? 1 : 0,
      isNowPreorder ? 1 : 0,
      effectiveStore,
      newPrice,
      result.imageUrl,
      variantId,
      result.maxOrderQty || null,
      nowIso,
      isNowInStock ? 1 : 0,
      nowIso,
      nowIso,
      product.id
    );

    // Record history
    db.prepare('INSERT INTO stock_history (product_id, in_stock, price) VALUES (?, ?, ?)')
      .run(product.id, isNowInStock ? 1 : 0, newPrice);

    // Stock came back (or force-check while in stock)
    if (isNowInStock && (!wasInStock || forceNotify)) {
      console.log(`  🚨 BACK IN STOCK: ${product.name}!`);

      if (product.notify_on_stock) {
        const updatedProduct = {
          ...product,
          store: effectiveStore,
          current_price: newPrice,
          shopify_variant_id: variantId || product.shopify_variant_id
        };

        // For Shopify: build grouped cart URL with ALL in-stock products from SAME domain
        let cartUrl = null;
        let allInStockForCart = [];
        if (['shopify', 'pokedom', 'tcgstar', 'pikazard'].includes(effectiveStore)) {
          try {
            const { buildCartForProducts } = require('./cart-builder');
            const domain = new URL(product.url).origin;
            const allCartProducts = db.prepare("SELECT * FROM products WHERE store IN ('shopify', 'pokedom', 'tcgstar', 'pikazard') AND in_stock = 1").all();
            const sameDomain = allCartProducts.filter(p => {
              try { return new URL(p.url).origin === domain; } catch(e) { return false; }
            });
            const withCurrent = sameDomain.map(p =>
              p.id === product.id ? { ...p, in_stock: 1, shopify_variant_id: variantId || p.shopify_variant_id, max_order_qty: result.maxOrderQty || p.max_order_qty } : p
            );
            if (!withCurrent.find(p => p.id === product.id)) {
              withCurrent.push({ ...updatedProduct, in_stock: 1 });
            }
            allInStockForCart = withCurrent;
            const cartResult = await buildCartForProducts(withCurrent);
            cartUrl = cartResult.cartUrl;
            if (cartUrl) console.log(`  🛒 Cart URL (${withCurrent.length} products): ${cartUrl}`);
          } catch(e) {
            console.log(`  ⚠️  Cart URL build failed: ${e.message}`);
          }
        }

        await telegram.sendStockAlert(updatedProduct, cartUrl);

        // If multiple products in stock, also send combined cart summary
        if (allInStockForCart.length > 1 && cartUrl) {
          await telegram.sendAllInStockCartAlert(allInStockForCart, cartUrl);
        }

        db.prepare('INSERT INTO notifications (product_id, type, message) VALUES (?, ?, ?)')
          .run(product.id, 'stock_alert', `Product back in stock! Price: ${newPrice || 'N/A'}`);
      }

      if (product.auto_purchase && process.env.AUTO_PURCHASE_ENABLED === 'true' && product.store !== 'shopify') {
        console.log(`  🤖 Attempting auto-purchase for: ${product.name}`);
        await this.attemptPurchase(product);
      }
    }

    // Price drop detection
    const priceDiff = oldPrice ? Math.round((oldPrice - newPrice) * 100) / 100 : 0;
    const dropPercentage = oldPrice ? (priceDiff / oldPrice) * 100 : 0;

    let shouldNotifyPrice = false;
    let priceReason = "";

    // 1. Target price reached
    if (newPrice && product.target_price && newPrice <= product.target_price && isNowInStock) {
      shouldNotifyPrice = true;
      priceReason = `🎯 Ciljna cena dosežena! (${newPrice} ${product.currency})`;
    } 
    // 2. Threshold-based price drop
    else if (newPrice && oldPrice && newPrice < oldPrice && product.notify_on_price_drop) {
      const thresholdAmt = product.price_drop_threshold_amount || 0;
      const thresholdPct = product.price_drop_threshold_percentage || 0;

      if (thresholdAmt > 0 && priceDiff >= thresholdAmt) {
        shouldNotifyPrice = true;
        priceReason = `💰 Cena se je znižala za ${priceDiff.toFixed(2)} ${product.currency}`;
      } else if (thresholdPct > 0 && dropPercentage >= thresholdPct) {
        shouldNotifyPrice = true;
        priceReason = `📉 Cena se je znižala za ${dropPercentage.toFixed(1)}%`;
      } else if (thresholdAmt === 0 && thresholdPct === 0 && priceDiff >= 0.05) {
        // Default sensitivity if no thresholds are set
        shouldNotifyPrice = true;
        priceReason = `✨ Cena se je znižala z ${oldPrice} na ${newPrice} ${product.currency}`;
      }
    }

    if (shouldNotifyPrice) {
      console.log(`  💰 Price alert for ${product.name}: ${priceReason}`);
      await telegram.sendPriceDropAlert(product, oldPrice, newPrice);
      
      db.prepare('INSERT INTO notifications (product_id, type, message) VALUES (?, ?, ?)')
        .run(product.id, 'price_drop', priceReason);
    }

    const stockStatus = isNowInStock ? '✅ In stock' : '❌ Out of stock';
    const priceStatus = newPrice ? `${newPrice} ${product.currency || 'EUR'}` : 'N/A';
    console.log(`  ${stockStatus} | 💰 ${priceStatus}`);
  }

  async attemptPurchase(product) {
    try {
      let puppeteer;
      try {
        puppeteer = require('puppeteer');
      } catch(e) {
        console.log('  Puppeteer not available - auto-purchase requires Puppeteer');
        await telegram.sendPurchaseAttemptAlert(product, 'failed',
          'Puppeteer ni na voljo na tem serverju. Auto-purchase potrebuje lokalno namestitev.');
        return;
      }
      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const page = await browser.newPage();

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));

      const storeConfig = db.prepare('SELECT * FROM store_configs WHERE store_name = ?').get(product.store);

      if (storeConfig && storeConfig.add_to_cart_selector) {
        const selectors = storeConfig.add_to_cart_selector.split(',');
        let clicked = false;

        for (const sel of selectors) {
          try {
            await page.click(sel.trim());
            clicked = true;
            console.log(`  🛒 Added to cart using selector: ${sel.trim()}`);
            break;
          } catch (e) {
            continue;
          }
        }

        if (clicked) {
          await new Promise(r => setTimeout(r, 2000));
          const screenshotPath = `./data/purchase_${product.id}_${Date.now()}.png`;
          await page.screenshot({ path: screenshotPath, fullPage: false });

          db.prepare('INSERT INTO purchase_attempts (product_id, status, details) VALUES (?, ?, ?)')
            .run(product.id, 'added_to_cart', 'Product added to cart successfully. Manual checkout required.');

          await telegram.sendPurchaseAttemptAlert(product, 'added_to_cart',
            'Izdelek dodan v košarico! Prosim zaključi nakup ročno.');
        } else {
          db.prepare('INSERT INTO purchase_attempts (product_id, status, details) VALUES (?, ?, ?)')
            .run(product.id, 'failed', 'Could not find add-to-cart button');

          await telegram.sendPurchaseAttemptAlert(product, 'failed',
            'Ni bilo mogoče dodati v košarico.');
        }
      }

      await browser.close();
    } catch (error) {
      console.error(`  ❌ Auto-purchase failed:`, error.message);
      db.prepare('INSERT INTO purchase_attempts (product_id, status, details) VALUES (?, ?, ?)')
        .run(product.id, 'error', error.message);

      await telegram.sendPurchaseAttemptAlert(product, 'error', error.message);
    }
  }

  getStatus() {
    return {
      isChecking: this.isChecking,
      lastCheckTime: this.lastCheckTime,
      checkCount: this.checkCount,
      telegramConnected: telegram.isReady(),
    };
  }
}

module.exports = new StockChecker();
