const http = require('./http');
const { validateAndNormalizeUrl } = require('./urlSafety');
const cheerio = require('cheerio');
const db = require('./database');
const telegram = require('./telegram');

class KeywordWatcher {
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

  // Check if product name OR url slug contains any keyword word
  isRelevant(productName, productUrl, keyword) {
    if (!keyword) return true;
    const kw = keyword.toLowerCase();
    const name = (productName || '').toLowerCase();
    const url = (productUrl || '').toLowerCase();

    if (name.includes(kw)) return true;
    if (url.includes(kw.replace(/\s+/g, '-'))) return true;

    // For single-word keywords, already checked above — not relevant
    // For multi-word keywords, require at least half the words to match
    // Use length > 1 to include short codes like "sv", "ex", "gx"
    const words = kw.split(/\s+/).filter(w => w.length > 1);
    if (words.length === 0) return true;
    if (words.length === 1) return false; // single word already checked above
    const matched = words.filter(w => name.includes(w) || url.includes(w));
    return matched.length >= Math.ceil(words.length / 2);
  }

  buildSearchUrl(watch) {
    if (watch.search_url) {
      return watch.search_url.replace('{keyword}', encodeURIComponent(watch.keyword));
    }
    const baseUrl = watch.store_url.replace(/\/+$/, '');
    const keyword = encodeURIComponent(watch.keyword);
    const hostname = (() => { try { return new URL(baseUrl).hostname; } catch(e) { return ''; } })();
    if (hostname.includes('amazon')) return `${baseUrl}/s?k=${keyword}`;
    if (hostname.includes('bigbang')) return `${baseUrl}/iskanje?q=${keyword}`;
    if (hostname.includes('mimovrste')) return `${baseUrl}/iskanje?q=${keyword}`;
    // Shopify stores: use options[prefix]=last for broader prefix matching
    return `${baseUrl}/search?options%5Bprefix%5D=last&q=${keyword}&type=product`;
  }

  // ─── METHOD 1: Shopify suggest.json ───
  async fetchShopifySuggest(baseUrl, keyword) {
    const products = [];
    try {
      const url = `${baseUrl}/search/suggest.json?q=${encodeURIComponent(keyword)}&resources[type]=product&resources[limit]=250`;
      console.log(`  [1] suggest.json: ${url}`);
      const res = await http.get(url, {
        headers: { 'User-Agent': this.getRandomUA(), 'Accept': 'application/json' },
        timeout: 10000, validateStatus: () => true,
      });
      if (res.status === 200 && res.data?.resources?.results?.products?.length) {
        for (const p of res.data.resources.results.products) {
          const fullUrl = `${baseUrl}${p.url.split('?')[0]}`;
          const anyAvailable = p.variants?.some(v => v.available);
          products.push({
            name: p.title, url: fullUrl,
            price: p.price ? parseFloat(p.price) / 100 : null,
            inStock: anyAvailable ?? undefined,
            image: p.image || '',
          });
        }
        console.log(`  [1] ✅ ${products.length} products`);
      } else {
        console.log(`  [1] ⚠️  status=${res.status}, empty or no products`);
      }
    } catch(e) { console.log(`  [1] ⚠️  ${e.message}`); }
    return products;
  }

  // ─── METHOD 2: Shopify /collections/all + filter by name ───
  // /collections/all/products.json works on ALL Shopify stores, no auth needed
  async fetchShopifyAllProducts(baseUrl, keyword) {
    const products = [];
    // Include short words too (e.g. set codes like "ex", "sv") — use length > 1
    const kwWords = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    try {
      let page = 1;
      let totalFetched = 0;
      const MAX_PAGES = 20; // up to 1000 products
      console.log(`  [2] Scanning /collections/all for "${keyword}"...`);
      while (page <= MAX_PAGES) {
        const url = `${baseUrl}/collections/all/products.json?limit=50&page=${page}`;
        const res = await http.get(url, {
          headers: { 'User-Agent': this.getRandomUA(), 'Accept': 'application/json' },
          timeout: 12000, validateStatus: () => true,
        });
        if (res.status !== 200 || !res.data?.products?.length) {
          console.log(`  [2] Stopped at page ${page}: status=${res.status}`);
          break;
        }
        const batch = res.data.products;
        totalFetched += batch.length;
        for (const p of batch) {
          const nameMatch = kwWords.some(w => p.title.toLowerCase().includes(w));
          const handleMatch = kwWords.some(w => p.handle.toLowerCase().includes(w));
          if (!nameMatch && !handleMatch) continue;
          const fullUrl = `${baseUrl}/products/${p.handle}`;
          if (products.find(pr => pr.url === fullUrl)) continue;
          const anyAvailable = p.variants?.some(v => v.available) ?? false;
          products.push({
            name: p.title, url: fullUrl,
            price: p.variants?.[0]?.price ? parseFloat(p.variants[0].price) : null,
            inStock: anyAvailable,
            image: p.images?.[0]?.src || '',
          });
        }
        if (batch.length < 50) break;
        page++;
        await new Promise(r => setTimeout(r, 600));
      }
      console.log(`  [2] ✅ Scanned ${totalFetched} products, found ${products.length} matching`);
    } catch(e) { console.log(`  [2] ⚠️  ${e.message}`); }
    return products;
  }

  // ─── METHOD 3: Find collections by keyword from /collections HTML page ───
  async fetchCollectionsByKeyword(baseUrl, keyword) {
    const products = [];
    const kwWords = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    try {
      // Scrape /collections page to find matching collection handles
      const colPageUrl = `${baseUrl}/collections`;
      console.log(`  [3] Scraping collections page: ${colPageUrl}`);
      const res = await http.get(colPageUrl, {
        headers: { 'User-Agent': this.getRandomUA(), 'Accept': 'text/html' },
        timeout: 12000, validateStatus: () => true,
      });
      if (res.status !== 200) {
        console.log(`  [3] ⚠️  status=${res.status}`);
        return products;
      }
      const $ = cheerio.load(res.data);
      const matchedHandles = new Set();

      // Find all collection links
      $('a[href*="/collections/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const match = href.match(/\/collections\/([^/?#]+)/);
        if (!match) return;
        const handle = match[1].toLowerCase();
        if (handle === 'all' || handle === 'frontpage') return;
        const text = ($(el).text() + ' ' + handle).toLowerCase();
        if (kwWords.some(w => text.includes(w))) {
          matchedHandles.add(match[1]);
        }
      });

      console.log(`  [3] Found ${matchedHandles.size} matching collections: ${[...matchedHandles].join(', ')}`);

      // Get products from each matched collection
      for (const handle of matchedHandles) {
        try {
          let page = 1;
          while (page <= 3) {
            const url = `${baseUrl}/collections/${handle}/products.json?limit=50&page=${page}`;
            const r = await http.get(url, {
              headers: { 'User-Agent': this.getRandomUA(), 'Accept': 'application/json' },
              timeout: 10000, validateStatus: () => true,
            });
            if (r.status !== 200 || !r.data?.products?.length) break;
            for (const p of r.data.products) {
              const fullUrl = `${baseUrl}/products/${p.handle}`;
              if (products.find(pr => pr.url === fullUrl)) continue;
              const anyAvailable = p.variants?.some(v => v.available) ?? false;
              products.push({
                name: p.title, url: fullUrl,
                price: p.variants?.[0]?.price ? parseFloat(p.variants[0].price) : null,
                inStock: anyAvailable,
                image: p.images?.[0]?.src || '',
              });
            }
            if (r.data.products.length < 50) break;
            page++;
            await new Promise(r => setTimeout(r, 600));
          }
          console.log(`  [3] Collection "${handle}": ${products.length} total products so far`);
        } catch(e) { console.log(`  [3] ⚠️  "${handle}": ${e.message}`); }
      }
    } catch(e) { console.log(`  [3] ⚠️  ${e.message}`); }
    return products;
  }

  // ─── METHOD 4: HTML scrape of search page (with pagination) ───
  async scrapeSearchHtml(searchUrl, keyword) {
    const products = [];
    const seen = new Set();
    const baseUrl = (() => { try { return new URL(searchUrl).origin; } catch(e) { return ''; } })();

    const scrapePage = async (pageUrl) => {
      try {
        const safeUrl = await validateAndNormalizeUrl(pageUrl, { requireHttps: false });
        const response = await http.get(safeUrl, {
          headers: { 'User-Agent': this.getRandomUA(), 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'sl-SI,sl;q=0.9,en;q=0.8' },
          timeout: 20000, maxRedirects: 5,
        });
        const $ = cheerio.load(response.data);
        let pageProducts = 0;

        $('a[href*="/products/"]').each((_, el) => {
          const href = $(el).attr('href') || '';
          if (!href.includes('/products/')) return;
          let fullUrl = href;
          try {
            fullUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
            const u = new URL(fullUrl); u.search = ''; fullUrl = u.toString();
          } catch(e) {}
          if (seen.has(fullUrl)) return;

          const name = $(el).attr('title')
            || $(el).find('[class*="title"],[class*="name"],h3,h2').first().text().trim()
            || $(el).text().trim().replace(/\s+/g, ' ').substring(0, 150);

          if (!name || !this.isRelevant(name, fullUrl, keyword)) return;

          seen.add(fullUrl);
          const container = $(el).closest('.card,.product-card,.grid__item,li,article');
          const hasSoldOut = container.find('.sold-out-badge,.badge--sold-out,[data-sold-out]').length > 0
            || container.text().toLowerCase().includes('sold out');

          const priceEl = container.find('.price-item,.money,.price,.product-price').first();
          let price = null;
          if (priceEl.length) {
            const pt = priceEl.text().replace(/[^0-9.,]/g, '').trim();
            if (pt.match(/\d+[.,]\d{2}/)) price = parseFloat(pt.replace(',', '.'));
          }
          const imgEl = $(el).find('img').first();
          const image = imgEl.attr('src') || imgEl.attr('data-src') || '';
          products.push({ name: name.substring(0, 200), url: fullUrl, price, inStock: hasSoldOut ? false : undefined, image: image.startsWith('//') ? 'https:' + image : image });
          pageProducts++;
        });

        // Find next page link
        const nextLink = $('a[href*="page="]').filter((_, el) => {
          const text = $(el).text().toLowerCase();
          return text.includes('next') || text.includes('naslednja') || $(el).attr('rel') === 'next';
        }).first().attr('href');

        return { count: pageProducts, nextUrl: nextLink ? (nextLink.startsWith('http') ? nextLink : `${baseUrl}${nextLink}`) : null };
      } catch(e) {
        console.log(`  [4] ⚠️  ${e.message}`);
        return { count: 0, nextUrl: null };
      }
    };

    // Scrape first page, then follow pagination (up to 10 pages)
    let currentUrl = searchUrl;
    let maxPages = 10;
    while (currentUrl && maxPages-- > 0) {
      const { count, nextUrl } = await scrapePage(currentUrl);
      console.log(`  [4] Page scraped: ${count} products (total: ${products.length})`);
      if (!nextUrl || nextUrl === currentUrl) break;
      currentUrl = nextUrl;
      await new Promise(r => setTimeout(r, 800));
    }

    console.log(`  [4] HTML scrape total: ${products.length} products`);
    return products;
  }

  // ─── ORCHESTRATOR ───
  async scrapeSearchResults(searchUrl, storeName, keyword) {
    const baseUrl = (() => { try { return new URL(searchUrl).origin; } catch(e) { return ''; } })();
    const isShopify = storeName === 'shopify';
    const seen = new Set();
    const allProducts = [];
    const merge = (list) => { for (const p of list) { if (!seen.has(p.url)) { seen.add(p.url); allProducts.push(p); } } };

    if (isShopify && baseUrl) {
      // 1. suggest.json (fast, up to 250 results)
      merge(await this.fetchShopifySuggest(baseUrl, keyword));
      console.log(`  After [1]: ${allProducts.length}`);

      // 2. /collections/all scan — ALWAYS run, not just fallback
      // suggest.json is capped and misses products; this ensures full coverage
      merge(await this.fetchShopifyAllProducts(baseUrl, keyword));
      console.log(`  After [2]: ${allProducts.length}`);

      // 3. Scrape /collections HTML for matching collection handles
      merge(await this.fetchCollectionsByKeyword(baseUrl, keyword));
      console.log(`  After [3]: ${allProducts.length}`);
    }

    // 4. HTML search page — always run to supplement API results
    merge(await this.scrapeSearchHtml(searchUrl, keyword));
    console.log(`  After [4]: ${allProducts.length}`);

    console.log(`  📊 TOTAL: ${allProducts.length} products for "${keyword}"`);
    return allProducts;
  }

  async checkWatch(watch) {
    if (!watch || !watch.keyword || !watch.store_url) return { total: 0, new: 0 };
    if (this.checkingWatches.has(watch.id)) {
      console.log(`  ⏳ Watch "${watch.keyword}" already running, skipping`);
      return { total: 0, new: 0 };
    }
    this.checkingWatches.add(watch.id);
    try { return await this._doCheckWatch(watch); }
    finally { this.checkingWatches.delete(watch.id); }
  }

  async _doCheckWatch(watch) {
    console.log(`\n🔍 Searching "${watch.keyword}" on ${watch.store_url} ...`);
    const searchUrl = this.buildSearchUrl(watch);
    const foundProducts = await this.scrapeSearchResults(searchUrl, watch.store_name, watch.keyword);

    let knownUrls = [];
    try { knownUrls = JSON.parse(watch.known_product_urls || '[]'); } catch(e) {}
    let knownStockMap = {};
    try { knownStockMap = JSON.parse(watch.known_stock_map || '{}'); } catch(e) {}

    const newProducts = foundProducts.filter(p => !knownUrls.includes(p.url));
    console.log(`  Found ${foundProducts.length} products, ${newProducts.length} new`);

    // Notify new products
    if (newProducts.length > 0 && watch.notify_new_products) {
      let message = `🔍 *NOVI IZDELKI: "${watch.keyword}"*\n🏪 ${watch.store_url}\n\n`;
      newProducts.forEach((p, i) => {
        message += `${i + 1}. *${p.name}*\n`;
        if (p.price) message += `   💰 ${p.price.toFixed(2)} EUR\n`;
        if (p.inStock !== undefined) message += `   ${p.inStock ? '✅ Na zalogi' : '❌ Ni na zalogi'}\n`;
        message += `   🔗 [Odpri](${p.url})\n\n`;
      });
      message += `Skupaj: ${foundProducts.length} izdelkov`;
      await telegram.sendMessage(message);

      // Auto-add to tracking
      if (watch.auto_add_tracking) {
        const checker = require('./checker');
        const toCheck = [];
        for (const product of newProducts) {
          try {
            const existing = db.prepare('SELECT id FROM products WHERE url = ?').get(product.url);
            if (!existing) {
              const validStores = ['shopify', 'amazon', 'bigbang', 'mimovrste', 'custom'];
              const productStore = validStores.includes(watch.store_name) ? watch.store_name : 'shopify';
              let globalCheckInterval = 0;
              try {
                const row = db.prepare("SELECT value FROM app_settings WHERE key = 'check_interval_minutes'").get();
                globalCheckInterval = parseInt(row?.value || '0') || 0;
              } catch(e) {}
              const ins = db.prepare(`INSERT INTO products (name, url, store, current_price, notify_on_stock, notify_on_price_drop, check_interval_minutes) VALUES (?, ?, ?, ?, 1, 1, ?)`)
                .run(product.name, product.url, productStore, product.price, globalCheckInterval);
              console.log(`    ➕ Auto-added: ${product.name}`);
              const newP = db.prepare('SELECT * FROM products WHERE id = ?').get(ins.lastInsertRowid);
              if (newP) toCheck.push(newP);
            }
          } catch(e) {}
        }
        if (toCheck.length > 0) {
          console.log(`  ⚡ Checking ${toCheck.length} newly added products...`);
          for (const p of toCheck) {
            try { await checker.checkProduct(p); console.log(`  ✅ Checked: ${p.name}`); }
            catch(e) { console.error(`  ❌ ${p.name}: ${e.message}`); }
          }
        }
      }
      db.prepare('INSERT INTO notifications (product_id, type, message) VALUES (?, ?, ?)')
        .run(null, 'keyword_watch', `Found ${newProducts.length} new for "${watch.keyword}"`);
    }

    // Notify back-in-stock
    if (watch.notify_in_stock) {
      const backInStock = foundProducts.filter(p => p.inStock === true && knownStockMap[p.url] === false);
      if (backInStock.length > 0) {
        let msg = `🚨 *NA ZALOGI: "${watch.keyword}"*\n🏪 ${watch.store_url}\n\n`;
        backInStock.forEach((p, i) => {
          msg += `${i + 1}. ✅ *${p.name}*\n`;
          if (p.price) msg += `   💰 ${p.price.toFixed(2)} EUR\n`;
          msg += `   🔗 [Kupi!](${p.url})\n\n`;
        });
        await telegram.sendMessage(msg);
      }
    }

    // Update known maps
    foundProducts.forEach(p => { if (p.inStock !== undefined) knownStockMap[p.url] = p.inStock; });
    const trackedUrls = db.prepare('SELECT url FROM products').all().map(p => p.url);
    const allKnownUrls = [...new Set([...knownUrls.filter(u => trackedUrls.includes(u)), ...foundProducts.map(p => p.url)])];

    db.prepare(`UPDATE keyword_watches SET known_product_urls=?, known_stock_map=?, last_checked=datetime('now'), last_found_count=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(allKnownUrls), JSON.stringify(knownStockMap), foundProducts.length, watch.id);

    return { total: foundProducts.length, new: newProducts.length };
  }

  async checkAll() {
    if (this.isChecking) { console.log('⏳ Already in progress...'); return; }
    this.isChecking = true;
    const allWatches = db.prepare('SELECT * FROM keyword_watches WHERE active = 1').all();
    if (!allWatches.length) { this.isChecking = false; return; }

    const globalInterval = parseInt(process.env.KEYWORD_CHECK_INTERVAL_MINUTES || '10');
    const now = Date.now();
    const watches = allWatches.filter(watch => {
      const interval = watch.check_interval_minutes > 0 ? watch.check_interval_minutes : globalInterval;
      if (!watch.last_checked) return true;
      const lastStr = watch.last_checked.endsWith('Z') ? watch.last_checked : watch.last_checked + 'Z';
      const lastMs = new Date(lastStr).getTime();
      return isNaN(lastMs) || (now - lastMs) / 60000 >= interval;
    });

    console.log(`\n🔍 ${allWatches.length} watches, ${watches.length} due`);
    for (const watch of watches) {
      try { await this.checkWatch(watch); }
      catch(e) { console.error(`  Error "${watch.keyword}": ${e.message}`); }
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
    }
    this.isChecking = false;
    console.log('✅ Keyword checks done');
  }
}

module.exports = new KeywordWatcher();
