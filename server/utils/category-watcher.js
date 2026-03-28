const cheerio = require('cheerio');
const http = require('./http');
const db = require('./database');
const telegram = require('./telegram');
const { validateAndNormalizeUrl } = require('./urlSafety');
const { detectStoreFromUrl } = require('./storeDetection');
const mimovrsteCampaign = require('./mimovrste-campaign');

class CategoryWatcher {
  constructor() {
    this.isChecking = false;
    this.checkingWatches = new Set();
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    ];
  }

  getRandomUA() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  matchesKeywordFilters(product, includeList, excludeList) {
    const haystack = this.normalizeText(`${product?.name || ''} ${product?.url || ''}`);

    if (includeList.length > 0 && !includeList.some((keyword) => haystack.includes(keyword))) return false;
    if (excludeList.length > 0 && excludeList.some((keyword) => haystack.includes(keyword))) return false;

    return true;
  }

  normalizeUrl(baseUrl, href) {
    try {
      const url = new URL(href, baseUrl);
      url.hash = '';
      url.search = '';
      return url.toString();
    } catch (e) {
      return href;
    }
  }

  parsePrice(text) {
    if (!text) return null;
    let cleaned = String(text).replace(/[€$£¥₹]/g, '').replace(/\s/g, '').replace(/&nbsp;/g, '').trim();
    if (cleaned.match(/\d+\.\d{3},\d{2}/)) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    else if (cleaned.match(/\d+,\d{2}$/)) cleaned = cleaned.replace(',', '.');
    else if (cleaned.match(/\d+,\d{3}\.\d{2}/)) cleaned = cleaned.replace(/,/g, '');
    const price = parseFloat(cleaned);
    return Number.isFinite(price) ? price : null;
  }

  isLikelyProductUrl(href) {
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
    const lowerHref = href.toLowerCase();
    if (lowerHref.includes('/products/')) return true;
    if (lowerHref.includes('/collections/') || lowerHref.includes('/search') || lowerHref.includes('/vyhladavanie/') || lowerHref.includes('/vyhledavani/')) return false;
    if (lowerHref.includes('/znacka/') || lowerHref.includes('/tag/') || lowerHref.includes('/blog/') || lowerHref.includes('/cart')) return false;
    return /^\/[^/]+\/?$/.test(lowerHref) || /^https?:\/\/[^/]+\/[^/]+\/?$/.test(lowerHref);
  }

  extractPrice(container) {
    const priceEl = container.find('.price-final,.price-final-holder .price-final,.price-item,.money,.price,.product-price,[itemprop="price"]').first();
    return this.parsePrice(priceEl.text());
  }

  async fetchShopifyCollectionProducts(categoryUrl) {
    const products = [];
    try {
      const urlObj = new URL(categoryUrl);
      const parts = urlObj.pathname.split('/').filter(Boolean);
      const collectionIdx = parts.indexOf('collections');
      if (collectionIdx === -1 || !parts[collectionIdx + 1]) return products;

      const handle = parts[collectionIdx + 1];
      let page = 1;
      const seen = new Set();
      while (page <= 20) {
        const apiUrl = `${urlObj.origin}/collections/${handle}/products.json?limit=50&page=${page}`;
        const res = await http.get(apiUrl, {
          headers: { 'User-Agent': this.getRandomUA(), 'Accept': 'application/json' },
          timeout: 12000,
          validateStatus: () => true,
        });
        if (res.status !== 200 || !Array.isArray(res.data?.products) || res.data.products.length === 0) break;
        for (const product of res.data.products) {
          const fullUrl = `${urlObj.origin}/products/${product.handle}`;
          if (seen.has(fullUrl)) continue;
          seen.add(fullUrl);
          const anyAvailable = product.variants?.some(v => v.available) ?? false;
          products.push({
            name: product.title,
            url: fullUrl,
            price: product.variants?.[0]?.price ? parseFloat(product.variants[0].price) : null,
            inStock: anyAvailable,
            image: product.images?.[0]?.src || '',
          });
        }
        if (res.data.products.length < 50) break;
        page++;
      }
    } catch (e) {
      console.log(`  ⚠️  Shopify collection fetch failed: ${e.message}`);
    }
    return products;
  }

  async scrapeCategoryHtml(categoryUrl) {
    const products = [];
    const seen = new Set();
    const baseUrl = (() => { try { return new URL(categoryUrl).origin; } catch (e) { return ''; } })();
    const blocklistedPathHints = ['/collections/', '/search', '/vyhladavanie/', '/vyhledavani/', '/znacka/', '/tag/', '/blog/', '/cart/', '/kosik/', '/kosik', '/kontakt', '/gdpr'];
    const likelyPriceText = (text) => /\d+\s*(?:,|\.)?\d*\s*€/.test(text || '');
    const likelyAvailabilityText = (text) => /(skladom|vypredan|predobjed|do koš|do kos|detail|na objedn|dostupn)/i.test(text || '');

    const collectFromLink = ($, linkEl) => {
      const href = $(linkEl).attr('href') || '';
      if (!this.isLikelyProductUrl(href)) return false;

      const fullUrl = this.normalizeUrl(baseUrl, href);
      if (seen.has(fullUrl)) return false;

      const container = $(linkEl).closest('.product, .p, .product-item, .products-block > div, .products .item, li, article, .card, .box');
      const containerText = container.text().replace(/\s+/g, ' ').trim();
      if (!containerText) return false;
      if (!likelyPriceText(containerText) && !likelyAvailabilityText(containerText)) return false;

      const name = $(linkEl).attr('title')
        || $(linkEl).text().trim().replace(/\s+/g, ' ')
        || container.find('h3, h2, .name, .product-name').first().text().trim().replace(/\s+/g, ' ');
      if (!name) return false;

      const normalizedText = containerText.toLowerCase();
      const imageEl = container.find('img').first();
      const image = imageEl.attr('src') || imageEl.attr('data-src') || imageEl.attr('data-srcset') || '';
      const hasSoldOut = normalizedText.includes('vypredan')
        || normalizedText.includes('nie je skladom')
        || normalizedText.includes('nedostupn');
      const hasInStock = normalizedText.includes('skladom')
        || normalizedText.includes('do košíka')
        || normalizedText.includes('do kosika');

      seen.add(fullUrl);
      products.push({
        name: name.substring(0, 200),
        url: fullUrl,
        price: this.extractPrice(container),
        inStock: hasSoldOut ? false : hasInStock ? true : undefined,
        image: image.startsWith('//') ? `https:${image}` : image,
      });
      return true;
    };

    const scrapePage = async (pageUrl) => {
      try {
        const safeUrl = await validateAndNormalizeUrl(pageUrl, { requireHttps: false });
        const response = await http.get(safeUrl, {
          headers: {
            'User-Agent': this.getRandomUA(),
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'sl-SI,sl;q=0.9,en;q=0.8',
          },
          timeout: 20000,
          maxRedirects: 5,
        });
        const $ = cheerio.load(response.data);
        const resultRoot = $('.search-results').first().length
          ? $('.search-results').first()
          : ($('#content .products-block').first().length ? $('#content .products-block').first() : $.root());
        let pageProducts = 0;

        resultRoot.find('.product, .p, [data-testid="productItem"], .products .product, .products-block .product, .card, article').each((_, el) => {
          const container = $(el);
          const link = container.find('a.name, a.image, a[href]').filter((__, aEl) => this.isLikelyProductUrl($(aEl).attr('href') || '')).first();
          const href = link.attr('href') || '';
          if (!this.isLikelyProductUrl(href)) return;

          const fullUrl = this.normalizeUrl(baseUrl, href);
          if (seen.has(fullUrl)) return;

          const name = container.find('.name, .top-products-name, [data-testid="productCardName"], [data-micro="name"], h3, h2').first().text().trim()
            || link.attr('title')
            || link.text().trim().replace(/\s+/g, ' ').substring(0, 200);
          if (!name) return;

          const text = container.text().toLowerCase();
          const hasSoldOut = text.includes('sold out')
            || text.includes('vypredané')
            || text.includes('nie je skladom')
            || text.includes('rasprodano')
            || container.find('.sold-out-badge,.badge--sold-out,[data-sold-out],.availability').text().toLowerCase().includes('vypredané');

          const imageEl = container.find('img').first();
          const image = imageEl.attr('src') || imageEl.attr('data-src') || imageEl.attr('data-lazy') || imageEl.attr('data-original') || imageEl.attr('data-lazy-src') || '';

          seen.add(fullUrl);
          products.push({
            name: name.substring(0, 200),
            url: fullUrl,
            price: this.extractPrice(container),
            inStock: hasSoldOut ? false : undefined,
            image: image.startsWith('//') ? `https:${image}` : image,
          });
          pageProducts++;
        });

        $('a[href*="/products/"]').each((_, el) => {
          const href = $(el).attr('href') || '';
          if (!href.includes('/products/')) return;
          const fullUrl = this.normalizeUrl(baseUrl, href);
          if (seen.has(fullUrl)) return;
          const name = $(el).attr('title')
            || $(el).find('[class*="title"],[class*="name"],h3,h2').first().text().trim()
            || $(el).text().trim().replace(/\s+/g, ' ').substring(0, 200);
          if (!name) return;
          const container = $(el).closest('.card,.product-card,.grid__item,li,article');
          const hasSoldOut = container.find('.sold-out-badge,.badge--sold-out,[data-sold-out]').length > 0
            || container.text().toLowerCase().includes('sold out');
          const imgEl = $(el).find('img').first();
          const image = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy') || imgEl.attr('data-original') || imgEl.attr('data-lazy-src') || '';

          seen.add(fullUrl);
          products.push({
            name: name.substring(0, 200),
            url: fullUrl,
            price: this.extractPrice(container),
            inStock: hasSoldOut ? false : undefined,
            image: image.startsWith('//') ? `https:${image}` : image,
          });
          pageProducts++;
        });

        // 3. Generic anchor fallback for Shoptet-like category pages (e.g. pikazard.eu)
        resultRoot.find('a[href]').each((_, el) => {
          const href = $(el).attr('href') || '';
          const lowerHref = href.toLowerCase();
          if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
          if (blocklistedPathHints.some(part => lowerHref.includes(part))) return;
          if (collectFromLink($, el)) pageProducts++;
        });

        const nextLink = $('a[href*="page="]').filter((_, el) => {
          const text = $(el).text().toLowerCase();
          return text.includes('next') || text.includes('naslednja') || text.includes('ďalš') || $(el).attr('rel') === 'next';
        }).first().attr('href');

        return { count: pageProducts, nextUrl: nextLink ? this.normalizeUrl(baseUrl, nextLink) : null };
      } catch (e) {
        console.log(`  ⚠️  Category HTML scrape failed: ${e.message}`);
        return { count: 0, nextUrl: null };
      }
    };

    let currentUrl = categoryUrl;
    let pagesLeft = 10;
    while (currentUrl && pagesLeft-- > 0) {
      const { nextUrl } = await scrapePage(currentUrl);
      if (!nextUrl || nextUrl === currentUrl) break;
      currentUrl = nextUrl;
      await new Promise(r => setTimeout(r, 800));
    }

    return products;
  }

  async fetchCategoryProducts(watch) {
    const categoryUrl = watch.category_url;
    const storeName = watch.store_name || detectStoreFromUrl(watch.store_url || categoryUrl);
    
    // Support Mimovrste campaign pages via GraphQL
    if ((storeName === 'mimovrste' || categoryUrl.includes('mimovrste')) && mimovrsteCampaign.isCampaignUrl(categoryUrl)) {
      const campaignId = mimovrsteCampaign.extractCampaignId(categoryUrl);
      if (campaignId) {
        const urlObj = new URL(categoryUrl);
        const baseUrl = urlObj.origin;
        const urlCategory = urlObj.searchParams.get('category');
        
        const fetchAndMap = async (cat) => {
          const items = await mimovrsteCampaign.fetchMimovrsteCampaignItems(campaignId, cat, this.getRandomUA(), categoryUrl);
          return mimovrsteCampaign.mapGqlItemsToProducts(items, baseUrl);
        };

        const products = [];
        if (urlCategory) {
          console.log(`  [Category] Mimovrste campaign "${campaignId}" - fetching category "${urlCategory}"...`);
          const items = await fetchAndMap(urlCategory);
          for (const p of items) { if (!products.find(x => x.url === p.url)) products.push(p); }
        } else {
          console.log(`  [Category] Mimovrste campaign "${campaignId}" - fetching all categories...`);
          const defaultItems = await fetchAndMap(null);
          for (const p of defaultItems) { if (!products.find(x => x.url === p.url)) products.push(p); }
          
          try {
            const pageRes = await http.get(categoryUrl, {
              headers: { 'User-Agent': this.getRandomUA(), 'Accept': 'text/html' },
              timeout: 10000, validateStatus: () => true,
            });
            if (pageRes.status === 200) {
              const $ = cheerio.load(pageRes.data);
              const categories = new Set();
              $(`a[href*="/kampanja/${campaignId}?category="]`).each((_, el) => {
                const href = $(el).attr('href') || '';
                const catMatch = href.match(/[?&]category=([^&]+)/);
                if (catMatch) categories.add(catMatch[1]);
              });
              for (const cat of categories) {
                const items = await fetchAndMap(cat);
                for (const p of items) { if (!products.find(x => x.url === p.url)) products.push(p); }
                await new Promise(r => setTimeout(r, 400));
              }
            }
          } catch(e) {}
        }
        return products;
      }
    }

    const fromHtml = await this.scrapeCategoryHtml(categoryUrl);
    if (['shopify', 'tcgstar', 'pokedom'].includes(storeName) && categoryUrl.includes('/collections/')) {
      const fromApi = await this.fetchShopifyCollectionProducts(categoryUrl);
      const byUrl = new Map();
      [...fromHtml, ...fromApi].forEach((product) => {
        const existing = byUrl.get(product.url);
        if (!existing) {
          byUrl.set(product.url, product);
          return;
        }
        if ((product.price ?? null) !== null) existing.price = product.price;
        if (product.inStock !== undefined) existing.inStock = product.inStock;
        if (product.name) existing.name = product.name;
        if (product.image) existing.image = product.image;
      });
      return [...byUrl.values()];
    }
    return fromHtml;
  }

  async autoAddProducts(watch, newProducts) {
    if (newProducts.length === 0) return;
    const checker = require('./checker');
    const toCheck = [];
    for (const product of newProducts) {
      try {
        const inProducts = db.prepare('SELECT id FROM products WHERE url = ?').get(product.url);
        if (inProducts) continue;

        const storeName = watch.store_name || detectStoreFromUrl(product.url);

        if (watch.auto_add_tracking) {
          let globalCheckInterval = 0;
          try {
            const row = db.prepare("SELECT value FROM app_settings WHERE key = 'check_interval_minutes'").get();
            globalCheckInterval = parseInt(row?.value || '0', 10) || 0;
          } catch (e) {}
          const ins = db.prepare(`
            INSERT INTO products (name, url, store, current_price, in_stock, is_preorder, notify_on_stock, notify_on_price_drop, check_interval_minutes, image_url)
            VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
          `).run(
            product.name,
            product.url,
            storeName,
            product.price,
            product.inStock === undefined ? null : (product.inStock ? 1 : 0),
            product.isPreorder ? 1 : 0,
            globalCheckInterval,
            product.image
          );
          const inserted = db.prepare('SELECT * FROM products WHERE id = ?').get(ins.lastInsertRowid);
          if (inserted) toCheck.push(inserted);
          console.log(`    ➕ Auto-added: ${product.name}`);
        } else {
          // Add to discovered items for manual review
          db.prepare(`
            INSERT OR IGNORE INTO found_items (name, url, price, original_price, store, image_url, in_stock, is_preorder, source_type, source_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            product.name,
            product.url,
            product.price,
            product.originalPrice || null,
            storeName,
            product.image,
            product.inStock === undefined ? null : (product.inStock ? 1 : 0),
            product.isPreorder ? 1 : 0,
            'category',
            watch.id
          );
          console.log(`    🔍 Discovered: ${product.name}`);
        }
      } catch (e) { console.error('Error adding new product from category:', e.message); }
    }

    for (const product of toCheck) {
      try { await checker.checkProduct(product); }
      catch (e) { console.error(`  ❌ Category auto-check failed for ${product.name}: ${e.message}`); }
    }
  }

  async checkWatch(watch) {
    if (!watch || !watch.category_url) return { total: 0, new: 0 };
    if (this.checkingWatches.has(watch.id)) return { total: 0, new: 0 };
    this.checkingWatches.add(watch.id);
    try { return await this._doCheckWatch(watch); }
    finally { this.checkingWatches.delete(watch.id); }
  }

  async _doCheckWatch(watch) {
    console.log(`\n📚 Checking category "${watch.category_name || watch.category_url}" ...`);
    const foundProducts = await this.fetchCategoryProducts(watch);

    let knownUrls = [];
    try { knownUrls = JSON.parse(watch.known_product_urls || '[]'); } catch (e) {}

    const minPrice = watch.min_price ? parseFloat(watch.min_price) : null;
    const maxPrice = watch.max_price ? parseFloat(watch.max_price) : null;

    const includeList = watch.include_keywords ? watch.include_keywords.split(',').map(k => this.normalizeText(k.trim())).filter(k => k) : [];
    const excludeList = watch.exclude_keywords ? watch.exclude_keywords.split(',').map(k => this.normalizeText(k.trim())).filter(k => k) : [];

    const filteredProducts = foundProducts.filter((product) => {
      // 1. Price filters
      if (minPrice !== null && product.price !== null && product.price !== undefined && product.price < minPrice) return false;
      if (maxPrice !== null && product.price !== null && product.price !== undefined && product.price > maxPrice) return false;

      return this.matchesKeywordFilters(product, includeList, excludeList);
    });
    const newProducts = filteredProducts.filter(product => !knownUrls.includes(product.url));

    if (newProducts.length > 0 && (watch.notify_new_products || !watch.auto_add_tracking)) {
      if (watch.notify_new_products) {
        await telegram.sendCategoryAlert(watch, newProducts);
      }
      await this.autoAddProducts(watch, newProducts);
      db.prepare('INSERT INTO notifications (product_id, type, message) VALUES (?, ?, ?)')
        .run(null, 'category_watch', `Found ${newProducts.length} new in category "${watch.category_name || watch.category_url}"`);
    }

    db.prepare(`UPDATE category_watches SET known_product_urls=?, last_checked=datetime('now'), last_found_count=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(filteredProducts.map(product => product.url)), filteredProducts.length, watch.id);

    return { total: filteredProducts.length, new: newProducts.length };
  }

  async checkAll() {
    if (this.isChecking) return;
    this.isChecking = true;
    try {
      const allWatches = db.prepare('SELECT * FROM category_watches WHERE active = 1').all();
      if (!allWatches.length) return;

      const globalInterval = parseInt(process.env.CATEGORY_CHECK_INTERVAL_MINUTES || '15', 10);
      const now = Date.now();
      const watches = allWatches.filter((watch) => {
        const interval = watch.check_interval_minutes > 0 ? watch.check_interval_minutes : globalInterval;
        if (!watch.last_checked) return true;
        const lastStr = watch.last_checked.endsWith('Z') ? watch.last_checked : `${watch.last_checked}Z`;
        const lastMs = new Date(lastStr).getTime();
        return Number.isNaN(lastMs) || (now - lastMs) / 60000 >= interval;
      });

      for (const watch of watches) {
        try { await this.checkWatch(watch); }
        catch (e) { console.error(`  Error category "${watch.category_url}": ${e.message}`); }
        await new Promise(r => setTimeout(r, 2500 + Math.random() * 1500));
      }
    } finally {
      this.isChecking = false;
    }
  }
}

module.exports = new CategoryWatcher();
