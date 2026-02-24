const http = require('../utils/http');
const { validateAndNormalizeUrl } = require('../utils/urlSafety');
const cheerio = require('cheerio');
const db = require('../utils/database');

class GenericScraper {
  constructor() {
    this.browser = null;
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    ];
  }

  getRandomUA() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  async getBrowser() {
    if (!this.browser) {
      try {
        const puppeteer = require('puppeteer');
        this.browser = await puppeteer.launch({
          headless: 'new',
          args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1920,1080']
        });
      } catch (e) {
        console.warn('Puppeteer not available - using Cheerio only mode');
        return null;
      }
    }
    return this.browser;
  }

  /**
   * Detect if a URL is a Shopify store by checking page HTML.
   * Also tries the product.js API endpoint directly as a fast shortcut.
   */
  async isShopifyUrl(url) {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      const productsIdx = pathParts.indexOf('products');
      if (productsIdx !== -1 && pathParts[productsIdx + 1]) {
        const handle = pathParts[productsIdx + 1].split('?')[0];
        const testUrl = `${urlObj.origin}/products/${handle}.js`;
        const res = await http.get(testUrl, {
          headers: { 'User-Agent': this.getRandomUA(), 'Accept': 'application/json' },
          timeout: 6000,
          validateStatus: () => true,
        });
        if (res.status === 200 && res.data && res.data.variants) return true;
      }
    } catch(e) { /* ignore */ }
    return false;
  }

  async scrapeWithCheerio(url, storeConfig) {
    try {
      const response = await http.get(url, {
        headers: {
          'User-Agent': this.getRandomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'sl-SI,sl;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        timeout: 15000,
        maxRedirects: 5,
      });

      const html = response.data;
      const $ = cheerio.load(html);
      const isShopify = html.includes('cdn.shopify.com') || html.includes('Shopify.theme') ||
                        html.includes('/cart/add') || storeConfig.store_name === 'shopify';

      console.log(`  🔎 Scraping: ${url}`);
      console.log(`  🏪 Platform: ${isShopify ? 'Shopify' : storeConfig.store_name}`);

      // 1. Shopify product.js API — most reliable, try FIRST for any Shopify site
      let shopifyResult = { inStock: null, price: null, variantId: null };
      if (isShopify) {
        shopifyResult = await this.extractShopifyData($, html, url);
        console.log(`  🛍️  Shopify extra: inStock=${shopifyResult.inStock}, price=${shopifyResult.price}, variantId=${shopifyResult.variantId}`);

        // If product.js says IN STOCK, trust it and return early.
        // If it says OUT OF STOCK, still check JSON-LD and HTML selectors as fallback
        // (Shopify sometimes returns available:false when inventory_policy='continue')
        if (shopifyResult.inStock === true && shopifyResult.variantId) {
          const jsonLdResult = this.extractFromJsonLd($, html);
          return {
            inStock: shopifyResult.inStock,
            price: shopifyResult.price || jsonLdResult.price,
            isShopify: true,
            variantId: shopifyResult.variantId,
            stockQty: shopifyResult.stockQty || 0,
            imageUrl: jsonLdResult.imageUrl || shopifyResult.imageUrl,
            rawStockText: shopifyResult.inStock ? 'in stock' : 'out of stock',
          };
        }
      }

      // 2. JSON-LD structured data
      const jsonLdResult = this.extractFromJsonLd($, html);
      console.log(`  📄 JSON-LD: inStock=${jsonLdResult.inStock}, price=${jsonLdResult.price}`);

      // 3. CSS selector extraction
      const selectorResult = this.extractData($, storeConfig, url);
      console.log(`  🎯 Selectors: inStock=${selectorResult.inStock}, rawText="${selectorResult.rawStockText}"`);

      // Merge priority: if ANY method says IN STOCK -> in stock
      // product.js false can be wrong (inventory_policy:continue), so HTML/JSON-LD can override
      const finalInStock =
        shopifyResult.inStock === true ? true :          // product.js says yes -> trust it
        jsonLdResult.inStock === true ? true :            // JSON-LD says yes -> trust it  
        selectorResult.inStock === true ? true :          // HTML selector says yes -> trust it
        shopifyResult.inStock === false && jsonLdResult.inStock === null && selectorResult.inStock === null ? false : // only product.js voted, said no
        jsonLdResult.inStock !== null ? jsonLdResult.inStock :
        selectorResult.inStock !== null ? selectorResult.inStock :
        false;

      const finalPrice = shopifyResult.price || jsonLdResult.price || selectorResult.price;
      console.log(`  ✅ Final: inStock=${finalInStock}, price=${finalPrice}`);

      return {
        inStock: finalInStock,
        price: finalPrice,
        isShopify,
        variantId: shopifyResult.variantId || null,
        stockQty: shopifyResult.stockQty || 0,
        imageUrl: jsonLdResult.imageUrl || selectorResult.imageUrl,
        rawStockText: selectorResult.rawStockText || (finalInStock !== null ? (finalInStock ? 'in stock' : 'out of stock') : ''),
      };
    } catch (error) {
      console.error(`  ❌ Cheerio scrape failed for ${url}:`, error.message);
      return null;
    }
  }

  async extractShopifyData($, html, url) {
    const result = { inStock: null, price: null, variantId: null, stockQty: 0, imageUrl: null };

    // Method 1: /products/handle.js endpoint — most reliable for Shopify
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      // Support both /products/handle and /collections/xxx/products/handle
      const productsIdx = pathParts.indexOf('products');
      
      // If URL is a /collections/handle page (not a product page), try to find
      // the product handle from the collections JSON API
      const collectionsIdx = pathParts.indexOf('collections');
      if (collectionsIdx !== -1 && productsIdx === -1 && pathParts[collectionsIdx + 1]) {
        const collectionHandle = pathParts[collectionsIdx + 1].split('?')[0];
        console.log(`  ℹ️  Collections URL detected, trying to find product from collection: ${collectionHandle}`);
        // Try to get first product from collection
        try {
          const colUrl = `${urlObj.origin}/collections/${collectionHandle}/products.json?limit=1`;
          const colRes = await http.get(colUrl, {
            headers: { 'User-Agent': this.getRandomUA(), 'Accept': 'application/json' },
            timeout: 8000, validateStatus: () => true,
          });
          if (colRes.status === 200 && colRes.data?.products?.length) {
            const firstProduct = colRes.data.products[0];
            const handle = firstProduct.handle;
            console.log(`  ➡️  Redirecting to product: ${handle}`);
            const productJsonUrl = `${urlObj.origin}/products/${handle}.js`;
            const jsonRes2 = await http.get(productJsonUrl, {
              headers: { 'User-Agent': this.getRandomUA(), 'Accept': 'application/json', 'Referer': url },
              timeout: 10000, validateStatus: () => true,
            });
            if (jsonRes2.status === 200 && jsonRes2.data?.variants) {
              const variants = jsonRes2.data.variants;
              result.inStock = variants.some(v => v.available);
              const active = variants.find(v => v.available) || variants[0];
              if (active) {
                const rawPrice = parseFloat(active.price);
                result.price = rawPrice > 500 ? rawPrice / 100 : rawPrice;
                result.variantId = String(active.id);
              }
              console.log(`  📦 Collection->product.js: inStock=${result.inStock}, price=${result.price}`);
              return result;
            }
          }
        } catch(e) { console.log(`  ⚠️  Collection redirect failed: ${e.message}`); }
      }
      
      if (productsIdx !== -1 && pathParts[productsIdx + 1]) {
        const handle = pathParts[productsIdx + 1].split('?')[0];
        const productJsonUrl = `${urlObj.origin}/products/${handle}.js`;
        console.log(`  🔗 Fetching Shopify product.js: ${productJsonUrl}`);
        const jsonRes = await http.get(productJsonUrl, {
          headers: {
            'User-Agent': this.getRandomUA(),
            'Accept': 'application/json',
            'Referer': url,
          },
          timeout: 10000,
          validateStatus: () => true,
        });
        if (jsonRes.status === 200 && jsonRes.data && jsonRes.data.variants) {
          const variants = jsonRes.data.variants;
          // Check variant availability — also consider top-level product.available
          const anyAvailable = variants.some(v => v.available) || jsonRes.data.available === true;
          result.inStock = anyAvailable;
          
          // Log each variant for debugging
          variants.forEach((v, i) => {
            console.log(`    variant[${i}]: id=${v.id} available=${v.available} price=${v.price} title=${v.title}`);
          });

          const activeVariant = variants.find(v => v.available) || variants[0];
          if (activeVariant) {
            // Shopify .js returns price as integer cents (e.g. 1350 = 13.50 EUR)
            // BUT some themes/apps patch it to return decimal string "13.50"
            // Safe: if value > 500, assume cents
            const rawPrice = parseFloat(activeVariant.price);
            result.price = rawPrice > 500 ? rawPrice / 100 : rawPrice;
            result.variantId = String(activeVariant.id);
            result.stockQty = activeVariant.inventory_quantity || 0;
          }
          if (jsonRes.data.images && jsonRes.data.images.length > 0) {
            result.imageUrl = jsonRes.data.images[0];
          }
          console.log(`  📦 Shopify product.js: ${variants.length} variants, anyAvailable=${anyAvailable}, top-level available=${jsonRes.data.available}, variantId=${result.variantId}`);
          return result;
        } else {
          console.log(`  ⚠️  Shopify product.js returned status=${jsonRes.status}`);
        }
      }
    } catch (e) {
      console.log(`  ⚠️  Shopify product.js fetch error: ${e.message}`);
    }

    // Method 2: Embedded JSON in page scripts (ShopifyAnalytics)
    const scriptPatterns = [
      /ShopifyAnalytics\.meta\s*=\s*({.*?});/s,
      /window\.ShopifyAnalytics\s*=\s*({.*?});/s,
      /"product"\s*:\s*({[^{}]*"available"\s*:\s*(true|false)[^{}]*})/,
    ];
    for (const pattern of scriptPatterns) {
      const match = html.match(pattern);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          const product = data.product || data;
          if (product && typeof product.available !== 'undefined') {
            result.inStock = product.available;
            if (product.price) result.price = parseFloat(product.price) / 100;
            console.log(`  📦 Shopify script: available=${product.available}`);
            return result;
          }
        } catch (e) { /* ignore */ }
      }
    }

    // Method 3: Button state analysis
    const addToCartSelectors = [
      'button[name="add"]',
      '.product-form__submit',
      'form[action="/cart/add"] button[type="submit"]',
      '#AddToCart',
      '.btn--add-to-cart',
      '[data-add-to-cart]',
    ];

    for (const sel of addToCartSelectors) {
      const btn = $(sel);
      if (btn.length > 0) {
        const isDisabled =
          btn.prop('disabled') ||
          btn.attr('disabled') !== undefined ||
          btn.attr('aria-disabled') === 'true' ||
          btn.hasClass('disabled') ||
          btn.hasClass('btn--disabled') ||
          btn.attr('data-available') === 'false';

        const btnText = btn.text().trim().toLowerCase();
        const soldOutTexts = ['sold out', 'out of stock', 'razprodano', 'ni na zalogi', 'unavailable'];
        const hasSoldOutText = soldOutTexts.some(t => btnText.includes(t));

        console.log(`  🔘 Button "${sel}": disabled=${isDisabled}, text="${btnText}"`);
        result.inStock = !(isDisabled || hasSoldOutText);
        break;
      }
    }

    // Method 4: Sold-out badges
    if (result.inStock === null) {
      const soldOutIndicators = ['.sold-out-badge','.badge--sold-out','[data-sold-out]','.product__sold-out','.sold_out'];
      for (const sel of soldOutIndicators) {
        if ($(sel).length > 0) {
          result.inStock = false;
          console.log(`  🏷️  Sold-out indicator: ${sel}`);
          break;
        }
      }
    }

    return result;
  }

  async scrapeWithPuppeteer(url, storeConfig) {
    let page = null;
    try {
      const browser = await this.getBrowser();
      if (!browser) return null;
      page = await browser.newPage();
      await page.setUserAgent(this.getRandomUA());
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) req.abort();
        else req.continue();
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
      const html = await page.content();
      const $ = cheerio.load(html);

      const pageData = await page.evaluate((selectors) => {
        const result = {};
        if (selectors.stock) {
          const stockEl = document.querySelector(selectors.stock.split(',')[0].trim());
          result.stockText = stockEl ? stockEl.textContent.trim() : '';
        }
        if (selectors.price) {
          for (const sel of selectors.price.split(',')) {
            const el = document.querySelector(sel.trim());
            if (el) { result.priceText = el.textContent.trim(); break; }
          }
        }
        if (selectors.addToCart) {
          for (const sel of selectors.addToCart.split(',')) {
            const btn = document.querySelector(sel.trim());
            if (btn) {
              result.addToCartFound = true;
              result.addToCartDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
              result.addToCartText = btn.textContent.trim().toLowerCase();
              break;
            }
          }
        }
        const ogImage = document.querySelector('meta[property="og:image"]');
        result.imageUrl = ogImage ? ogImage.getAttribute('content') : '';
        return result;
      }, { stock: storeConfig.stock_selector, price: storeConfig.price_selector, addToCart: storeConfig.add_to_cart_selector });

      const soldOutTexts = ['sold out', 'out of stock', 'razprodano', 'ni na zalogi', 'unavailable'];
      const btnSoldOut = pageData.addToCartText && soldOutTexts.some(t => pageData.addToCartText.includes(t));
      const cheerioData = this.extractData($, storeConfig, url);
      const inStock = pageData.addToCartFound ? (!pageData.addToCartDisabled && !btnSoldOut) : cheerioData.inStock;

      return {
        inStock,
        price: this.parsePrice(pageData.priceText) || cheerioData.price,
        imageUrl: pageData.imageUrl || cheerioData.imageUrl,
        rawStockText: pageData.stockText || cheerioData.rawStockText,
      };
    } catch (error) {
      console.error(`Puppeteer scrape failed for ${url}:`, error.message);
      return null;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  extractFromJsonLd($, html) {
    const result = { inStock: null, price: null, imageUrl: null };
    try {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const json = JSON.parse($(el).html());
          let product = null;
          if (json['@type'] === 'Product') product = json;
          else if (Array.isArray(json['@type']) && json['@type'].includes('Product')) product = json;
          else if (json['@graph']) product = json['@graph'].find(g => g['@type'] === 'Product');

          if (product && product.offers) {
            const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
            let anyInStock = null;
            let bestPrice = null;
            for (const offer of offers) {
              if (offer.price && (bestPrice === null || offer.price < bestPrice)) bestPrice = parseFloat(offer.price);
              if (offer.availability) {
                const offerInStock = offer.availability.toLowerCase().includes('instock');
                anyInStock = anyInStock === null ? offerInStock : (anyInStock || offerInStock);
              }
            }
            if (anyInStock !== null) result.inStock = anyInStock;
            if (bestPrice !== null) result.price = bestPrice;
            if (product.image) result.imageUrl = Array.isArray(product.image) ? product.image[0] : product.image;
          }
        } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }

    if (result.price === null) {
      const metaPrice = $('meta[property="og:price:amount"], meta[property="product:price:amount"]').attr('content');
      if (metaPrice) result.price = parseFloat(metaPrice);
    }
    if (!result.imageUrl) result.imageUrl = $('meta[property="og:image"]').attr('content') || null;
    return result;
  }

  extractData($, storeConfig, url) {
    const result = { inStock: null, price: null, imageUrl: null, rawStockText: '' };
    const outOfStockTexts = (storeConfig.out_of_stock_text || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const inStockTexts = (storeConfig.in_stock_text || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

    if (storeConfig.stock_selector) {
      const selectors = storeConfig.stock_selector.split(',');
      for (const sel of selectors) {
        const el = $(sel.trim());
        if (el.length > 0) {
          const text = el.text().toLowerCase().trim();
          result.rawStockText = text;
          if (outOfStockTexts.some(t => t && text.includes(t))) result.inStock = false;
          else if (inStockTexts.some(t => t && text.includes(t))) result.inStock = true;
          break;
        }
      }
    }

    if (storeConfig.add_to_cart_selector) {
      const cartSelectors = storeConfig.add_to_cart_selector.split(',');
      for (const sel of cartSelectors) {
        const btn = $(sel.trim());
        if (btn.length > 0) {
          const isDisabled = btn.prop('disabled') || btn.attr('disabled') !== undefined || btn.attr('aria-disabled') === 'true' || btn.hasClass('disabled');
          const btnText = btn.text().trim().toLowerCase();
          const soldOutTexts = ['sold out', 'out of stock', 'razprodano', 'ni na zalogi', 'unavailable'];
          const hasSoldOut = soldOutTexts.some(t => btnText.includes(t));
          if (isDisabled || hasSoldOut) result.inStock = false;
          else if (result.inStock === null) result.inStock = true;
          break;
        }
      }
    }

    if (storeConfig.price_selector) {
      const priceSelectors = storeConfig.price_selector.split(',');
      for (const sel of priceSelectors) {
        const priceEl = $(sel.trim());
        if (priceEl.length > 0) {
          result.price = this.parsePrice(priceEl.first().text().trim());
          if (result.price) break;
        }
      }
    }

    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) {
      try { result.imageUrl = ogImage.startsWith('http') ? ogImage : new URL(ogImage, url).href; }
      catch (e) { result.imageUrl = ogImage; }
    }
    return result;
  }

  parsePrice(text) {
    if (!text) return null;
    let cleaned = text.replace(/[€$£¥₹]/g, '').replace(/\s/g, '').replace(/&nbsp;/g, '').trim();
    if (cleaned.match(/\d+\.\d{3},\d{2}/)) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    else if (cleaned.match(/\d+,\d{2}$/)) cleaned = cleaned.replace(',', '.');
    else if (cleaned.match(/\d+,\d{3}\.\d{2}/)) cleaned = cleaned.replace(/,/g, '');
    const price = parseFloat(cleaned);
    return isNaN(price) ? null : price;
  }

  async scrape(product) {
    // SSRF protection / URL validation
    const safeUrl = await validateAndNormalizeUrl(product.url, { requireHttps: false });

    // Auto-detect Shopify store: if product is stored as 'custom' but URL looks like Shopify,
    // upgrade to 'shopify' store config automatically
    let effectiveStore = product.store;
    if (effectiveStore === 'custom' || effectiveStore === 'tcgstar.eu' || !['amazon','bigbang','mimovrste','shopify'].includes(effectiveStore)) {
      // Check if URL has /products/ path (strong Shopify indicator)
      try {
        const urlObj = new URL(safeUrl);
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.includes('products')) {
          effectiveStore = 'shopify';
          console.log(`  🔄 Auto-upgrading store to 'shopify' for: ${safeUrl}`);
        }
      } catch(e) {}
    }

    const storeConfig = db.prepare('SELECT * FROM store_configs WHERE store_name = ?').get(effectiveStore);
    if (!storeConfig) {
      console.error(`No store config found for: ${effectiveStore}, trying 'shopify'...`);
      const fallbackConfig = db.prepare('SELECT * FROM store_configs WHERE store_name = ?').get('shopify');
      if (!fallbackConfig) return null;
      return this._scrapeWithConfig(safeUrl, fallbackConfig, product);
    }

    return this._scrapeWithConfig(safeUrl, storeConfig, product);
  }

  async _scrapeWithConfig(url, config, product) {
    // Merge product-level selector overrides
    let mergedConfig = { ...config };
    if (product.selector_config) {
      try {
        const custom = JSON.parse(product.selector_config);
        if (custom.stock_selector) mergedConfig.stock_selector = custom.stock_selector;
        if (custom.price_selector) mergedConfig.price_selector = custom.price_selector;
        if (custom.add_to_cart_selector) mergedConfig.add_to_cart_selector = custom.add_to_cart_selector;
        if (custom.out_of_stock_text) mergedConfig.out_of_stock_text = custom.out_of_stock_text;
        if (custom.in_stock_text) mergedConfig.in_stock_text = custom.in_stock_text;
      } catch (e) { /* ignore */ }
    }

    if (!mergedConfig.requires_puppeteer) {
      const result = await this.scrapeWithCheerio(url, mergedConfig);
      if (result) return result;
    }
    return await this.scrapeWithPuppeteer(url, mergedConfig);
  }

  async closeBrowser() {
    if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; }
  }
}

module.exports = new GenericScraper();
