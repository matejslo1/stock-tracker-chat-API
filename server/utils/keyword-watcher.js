const http = require('./http');
const { validateAndNormalizeUrl } = require('./urlSafety');
const cheerio = require('cheerio');
const db = require('./database');
const telegram = require('./telegram');
const { detectStoreFromUrl } = require('./storeDetection');
const mimovrsteCampaign = require('./mimovrste-campaign');

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
      const raw = watch.search_url
        .replace('/vyhledavani/', '/vyhladavanie/')
        .replace('{keyword}', encodeURIComponent(watch.keyword));
      if (raw.startsWith('http')) return raw;
      try {
        return new URL(raw, watch.store_url).toString();
      } catch (e) {
        return raw;
      }
    }
    const baseUrl = watch.store_url.replace(/\/+$/, '');
    const keyword = encodeURIComponent(watch.keyword);
    const hostname = (() => { try { return new URL(baseUrl).hostname; } catch(e) { return ''; } })();
    try {
      const configRow = watch.store_name ? db.prepare('SELECT config_json FROM store_configs WHERE store_name = ?').get(watch.store_name) : null;
      const meta = configRow?.config_json ? JSON.parse(configRow.config_json) : null;
      if (meta?.search_url) {
        return new URL(meta.search_url.replace('{keyword}', keyword), baseUrl).toString();
      }
    } catch (e) { /* ignore and fall back */ }
    if (hostname.includes('amazon')) return `${baseUrl}/s?k=${keyword}`;
    if (hostname.includes('bigbang')) return `${baseUrl}/iskanje?q=${keyword}`;
    if (hostname.includes('mimovrste')) return `${baseUrl}/iskanje?s=${keyword}`;
    if (hostname.includes('pikazard.eu')) return `${baseUrl}/vyhladavanie/?string=${keyword}`;
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
        const seenUrls = new Map(); // url -> index in products
        for (const p of res.data.resources.results.products) {
          const fullUrl = `${baseUrl}${p.url.split('?')[0]}`;
          const anyAvailable = p.variants?.some(v => v.available);
          // Shopify suggest returns price in cents as integer string
          const price = p.price ? parseFloat(p.price) / 100 : null;
          if (seenUrls.has(fullUrl)) {
            // Keep highest price (main product price, not cheapest variant)
            const idx = seenUrls.get(fullUrl);
            if (price !== null && price > (products[idx].price || 0)) {
              products[idx].price = price;
            }
            if (anyAvailable) products[idx].inStock = true;
          } else {
            seenUrls.set(fullUrl, products.length);
            products.push({
              name: p.title, url: fullUrl,
              price,
              inStock: anyAvailable ?? undefined,
              image: p.image || '',
            });
          }
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
    const blocklistedPathHints = ['/znacka/', '/tag/', '/vyhladavanie/', '/vyhledavani/', '/booster-', '/booster-balicky/', '/booster-boxy/', '/pokemon-produkty/', '/edicie/', '/kolekcie/', '/lorcana/', '/one-piece', '/spolocenske-hry/'];

    const normalizeUrl = (href) => {
      try {
        const fullUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
        const u = new URL(fullUrl);
        u.search = '';
        return u.toString();
      } catch (e) {
        return href;
      }
    };

    const isLikelyProductUrl = (href) => {
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
      const lowerHref = href.toLowerCase();
      if (lowerHref.includes('/products/')) return true;
      if (!lowerHref.startsWith('/') && !lowerHref.startsWith('http')) return false;
      if (blocklistedPathHints.some(part => lowerHref.includes(part))) return false;
      return /^\/[^/]+\/?$/.test(lowerHref) || /^https?:\/\/[^/]+\/[^/]+\/?$/.test(lowerHref);
    };

    const extractPrice = (container) => {
      const priceEl = container.find('.price-final,.price-final-holder .price-final,.price-item,.money,.price,.product-price,[itemprop="price"]').first();
      if (!priceEl.length) return null;
      const pt = priceEl.text().replace(/[^0-9.,]/g, '').trim();
      if (pt.match(/\d+[.,]\d{2}/)) return parseFloat(pt.replace(',', '.'));
      if (pt.match(/^\d+$/)) return parseFloat(pt);
      return null;
    };

    const scrapePage = async (pageUrl) => {
      try {
        const safeUrl = await validateAndNormalizeUrl(pageUrl, { requireHttps: false });
        const response = await http.get(safeUrl, {
          headers: { 'User-Agent': this.getRandomUA(), 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'sl-SI,sl;q=0.9,en;q=0.8' },
          timeout: 20000, maxRedirects: 5,
        });
        const $ = cheerio.load(response.data);
        const resultRoot = $('.search-results').first().length
          ? $('.search-results').first()
          : ($('#content .products-block').first().length ? $('#content .products-block').first() : $.root());
        let pageProducts = 0;

        // 1. Structured product cards (Shoptet + many generic stores)
        resultRoot.find('.product, .p, [data-testid="productItem"], .products .product, .products-block .product').each((_, el) => {
          const container = $(el);
          const link = container.find('a.name, a.image, a[href]').filter((__, aEl) => isLikelyProductUrl($(aEl).attr('href') || '')).first();
          const href = link.attr('href') || '';
          if (!isLikelyProductUrl(href)) return;

          const fullUrl = normalizeUrl(href);
          if (seen.has(fullUrl)) return;

          const name = container.find('.name, .top-products-name, [data-testid="productCardName"], [data-micro="name"], h3, h2').first().text().trim()
            || link.attr('title')
            || link.text().trim().replace(/\s+/g, ' ').substring(0, 150);

          if (!name || !this.isRelevant(name, fullUrl, keyword)) return;

          const text = container.text().toLowerCase();
          const hasSoldOut = text.includes('sold out')
            || text.includes('vypredané')
            || text.includes('nie je skladom')
            || container.find('.sold-out-badge,.badge--sold-out,[data-sold-out],.availability').text().toLowerCase().includes('vypredané');

          const imageEl = container.find('img').first();
          const _imgCandidates1 = [imageEl.attr('src'), imageEl.attr('data-src'), imageEl.attr('data-lazy'), imageEl.attr('data-original'), imageEl.attr('data-lazy-src')];
          const image = _imgCandidates1.find(u => u && u.startsWith('http')) || '';

          seen.add(fullUrl);
          products.push({
            name: name.substring(0, 200),
            url: fullUrl,
            price: extractPrice(container),
            inStock: hasSoldOut ? false : undefined,
            image: image.startsWith('//') ? 'https:' + image : image,
          });
          pageProducts++;
        });

        // 2. Shopify-style product links fallback
        $('a[href*="/products/"]').each((_, el) => {
          const href = $(el).attr('href') || '';
          if (!href.includes('/products/')) return;
          const fullUrl = normalizeUrl(href);
          if (seen.has(fullUrl)) return;

          const name = $(el).attr('title')
            || $(el).find('[class*="title"],[class*="name"],h3,h2').first().text().trim()
            || $(el).text().trim().replace(/\s+/g, ' ').substring(0, 150);

          if (!name || !this.isRelevant(name, fullUrl, keyword)) return;

          seen.add(fullUrl);
          const container = $(el).closest('.card,.product-card,.grid__item,li,article');
          const hasSoldOut = container.find('.sold-out-badge,.badge--sold-out,[data-sold-out]').length > 0
            || container.text().toLowerCase().includes('sold out');

          const imgEl = $(el).find('img').first();
          const _imgCandidates2 = [imgEl.attr('src'), imgEl.attr('data-src'), imgEl.attr('data-lazy'), imgEl.attr('data-original'), imgEl.attr('data-lazy-src')];
          const image = _imgCandidates2.find(u => u && u.startsWith('http')) || '';
          products.push({ name: name.substring(0, 200), url: fullUrl, price: extractPrice(container), inStock: hasSoldOut ? false : undefined, image });
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

  // ─── METHOD 5: mimovrste.com GraphQL (campaign pages) ───
  async fetchMimovrsteCampaign(searchUrl, keyword) {
    const products = [];
    try {
      const campaignId = mimovrsteCampaign.extractCampaignId(searchUrl);
      if (!campaignId) return products;
      const urlObj = new URL(searchUrl);
      const baseUrl = urlObj.origin;
      const urlCategory = urlObj.searchParams.get('category');

      const fetchAndMap = async (cat) => {
        const items = await mimovrsteCampaign.fetchMimovrsteCampaignItems(campaignId, cat, this.getRandomUA(), searchUrl);
        const mapped = mimovrsteCampaign.mapGqlItemsToProducts(items, baseUrl);
        return mapped.filter(p => !keyword || this.isRelevant(p.name, p.url, keyword));
      };

      if (urlCategory) {
        console.log(`  [5] mimovrste campaign "${campaignId}" - fetching category "${urlCategory}"...`);
        const items = await fetchAndMap(urlCategory);
        for (const p of items) { if (!products.find(x => x.url === p.url)) products.push(p); }
      } else {
        console.log(`  [5] mimovrste campaign "${campaignId}" - fetching without category...`);
        const defaultItems = await fetchAndMap(null);
        for (const p of defaultItems) { if (!products.find(x => x.url === p.url)) products.push(p); }
        console.log(`  [5] Default: ${defaultItems.length} products`);

        try {
          const pageRes = await http.get(searchUrl, {
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
            console.log(`  [5] Found ${categories.size} categories: ${[...categories].join(', ')}`);
            for (const cat of categories) {
              const items = await fetchAndMap(cat);
              let added = 0;
              for (const p of items) {
                if (!products.find(x => x.url === p.url)) { products.push(p); added++; }
              }
              console.log(`  [5] Category "${cat}": ${items.length} found, ${added} new (total: ${products.length})`);
              await new Promise(r => setTimeout(r, 400));
            }
          }
        } catch(e) { console.log(`  [5] Category scrape error: ${e.message}`); }
      }

      console.log(`  [5] ✅ mimovrste total: ${products.length} products`);
    } catch(e) { console.log(`  [5] ⚠️  ${e.message}`); }
    return products;
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
        console.warn('Puppeteer not available for keyword search');
        return null;
      }
    }
    return this.browser;
  }

  async scrapeSearchPuppeteer(searchUrl, keyword) {
    const products = [];
    const seen = new Set();
    let page = null;
    try {
      const browser = await this.getBrowser();
      if (!browser) return products;
      page = await browser.newPage();
      await page.setUserAgent(this.getRandomUA());
      await page.setViewport({ width: 1920, height: 1080 });
      
      console.log(`  [P] Opening Puppeteer search: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Wait for product titles to appear (Vue rendering)
      try { await page.waitForSelector('.pb-brief__title-wrap', { timeout: 10000 }); } catch(e) { console.log('  [P] Timeout waiting for products'); }
      await new Promise(r => setTimeout(r, 2000));

      const pageData = await page.evaluate((kw) => {
        const results = [];
        const items = document.querySelectorAll('.pb-brief__title-wrap, .product-item, .pb-brief__desktop');
        const seenHrefs = new Set();

        items.forEach(el => {
          let href = '';
          let name = '';
          let priceText = '';
          let image = '';

          // Find name and link
          const linkEl = el.closest('a') || el.querySelector('a') || el;
          if (linkEl.href) {
            href = linkEl.href.split('?')[0];
            name = linkEl.textContent.trim();
          }

          // If we found a link, look for sibling or child price
          if (href && !seenHrefs.has(href)) {
            const container = el.closest('.product-item') || el.parentElement?.parentElement;
            if (container) {
              const priceEl = container.querySelector('.pb-price__discounts, .price__relevant, .product-price__relevant, .price-main, .price');
              if (priceEl) priceText = priceEl.textContent.trim();
              const imgEl = container.querySelector('img');
              if (imgEl) image = imgEl.src;
            }
            if (name && href) {
              results.push({ name, url: href, priceText, image });
              seenHrefs.add(href);
            }
          }
        });
        return results;
      }, keyword);

      const baseUrl = new URL(searchUrl).origin;
      for (const p of pageData) {
        if (!p.name || !this.isRelevant(p.name, p.url, keyword)) continue;
        const fullUrl = p.url.startsWith('http') ? p.url : `${baseUrl}${p.url.startsWith('/') ? '' : '/'}${p.url}`;
        if (seen.has(fullUrl)) continue;
        seen.add(fullUrl);
        
        // Parse price
        let price = null;
        if (p.priceText) {
          const pt = p.priceText.replace(/[^0-9.,]/g, '').replace(',', '.').trim();
          price = parseFloat(pt);
        }

        products.push({
          name: p.name.substring(0, 200),
          url: fullUrl,
          price: isNaN(price) ? null : price,
          inStock: undefined, // Puppeteer search doesn't easily show stock for all items
          image: p.image,
        });
      }
      console.log(`  [P] Puppeteer found ${products.length} products`);
    } catch (e) {
      console.error(`  [P] Puppeteer search failed: ${e.message}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
    return products;
  }

  // ─── ORCHESTRATOR ───
  async scrapeSearchResults(searchUrl, storeName, keyword) {
    const baseUrl = (() => { try { return new URL(searchUrl).origin; } catch(e) { return ''; } })();
    // tcgstar and pokedom are Shopify-based stores and support the same product.js API
    const isShopify = ['shopify', 'tcgstar', 'pokedom'].includes(storeName);
    const isMimovrste = storeName === 'mimovrste' || baseUrl.includes('mimovrste.com') || baseUrl.includes('mimovrste.si');
    const isMimovrsteCampaign = isMimovrste && searchUrl.includes('/kampanja/');
    const seen = new Set();
    const allProducts = [];
    // merge: first source wins for new URLs, BUT later sources can UPDATE price/stock if they have better data
    const merge = (list, { overwritePrice = false } = {}) => {
      if (!list) return;
      for (const p of list) {
        if (!seen.has(p.url)) {
          seen.add(p.url);
          allProducts.push(p);
        } else if (overwritePrice) {
          // Update existing entry with better price/stock data
          const existing = allProducts.find(e => e.url === p.url);
          if (existing) {
            if (p.price !== null && p.price !== undefined) existing.price = p.price;
            if (p.inStock !== undefined) existing.inStock = p.inStock;
            if (p.name && p.name.length > 0) existing.name = p.name;
          }
        }
      }
    };

    if (isMimovrsteCampaign) {
      // 5. mimovrste GraphQL campaign API
      merge(await this.fetchMimovrsteCampaign(searchUrl, keyword));
      console.log(`  After [5]: ${allProducts.length}`);
    } else if (isMimovrste) {
      // Use Puppeteer for mimovrste regular search as it's JS-rendered
      merge(await this.scrapeSearchPuppeteer(searchUrl, keyword));
      console.log(`  After [P]: ${allProducts.length}`);
    } else if (isShopify && baseUrl) {
      // 1. suggest.json (fast, up to 250 results)
      // 1. suggest.json first (fast discovery, but prices may be inaccurate - lowest variant in cents)
      merge(await this.fetchShopifySuggest(baseUrl, keyword));
      console.log(`  After [1]: ${allProducts.length}`);

      // 2. /collections/all — authoritative prices, overwrites suggest.json prices
      merge(await this.fetchShopifyAllProducts(baseUrl, keyword), { overwritePrice: true });
      console.log(`  After [2]: ${allProducts.length}`);

      // 3. Collections by keyword — also authoritative, overwrites
      merge(await this.fetchCollectionsByKeyword(baseUrl, keyword), { overwritePrice: true });
      console.log(`  After [3]: ${allProducts.length}`);
    }

    // 4. HTML search page — skip for mimovrste campaign (JS-rendered, no products in HTML)
    if (!isMimovrsteCampaign) {
      merge(await this.scrapeSearchHtml(searchUrl, keyword), { overwritePrice: true });
      console.log(`  After [4]: ${allProducts.length}`);
    }

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

    // Apply price and keyword filters
    const minPrice = watch.min_price ? parseFloat(watch.min_price) : null;
    const maxPrice = watch.max_price ? parseFloat(watch.max_price) : null;
    
    const includeList = watch.include_keywords ? watch.include_keywords.split(',').map(k => this.normalizeText(k.trim())).filter(k => k) : [];
    const excludeList = watch.exclude_keywords ? watch.exclude_keywords.split(',').map(k => this.normalizeText(k.trim())).filter(k => k) : [];

    const filteredProducts = foundProducts.filter(p => {
      // 1. Price filters
      if (minPrice !== null && p.price !== null && p.price !== undefined && p.price < minPrice) return false;
      if (maxPrice !== null && p.price !== null && p.price !== undefined && p.price > maxPrice) return false;

      return this.matchesKeywordFilters(p, includeList, excludeList);
    });

    if (minPrice !== null || maxPrice !== null || includeList.length > 0 || excludeList.length > 0) {
      console.log(`  Filters applied: ${foundProducts.length} -> ${filteredProducts.length} products`);
    }

    const newProducts = filteredProducts.filter(p => !knownUrls.includes(p.url));
    console.log(`  Found ${foundProducts.length} products, ${newProducts.length} new`);

    // Add new products to tracking or found_items (always, regardless of notify setting)
    if (newProducts.length > 0) {
      if (watch.notify_new_products) {
        await telegram.sendKeywordAlert(watch, newProducts);
      }

      const checker = require('./checker');
      const toCheck = [];
      for (const product of newProducts) {
        try {
          const inProducts = db.prepare('SELECT id FROM products WHERE url = ?').get(product.url);
          if (inProducts) continue;

          const validStores = ['shopify', 'amazon', 'bigbang', 'mimovrste', 'pikazard', 'tcgstar', 'pokedom', 'custom'];
          const productStore = validStores.includes(watch.store_name)
            ? watch.store_name
            : detectStoreFromUrl(product.url);

          if (watch.auto_add_tracking) {
            // Auto-add to main tracking
            let globalCheckInterval = 0;
            try {
              const row = db.prepare("SELECT value FROM app_settings WHERE key = 'check_interval_minutes'").get();
              globalCheckInterval = parseInt(row?.value || '0') || 0;
            } catch(e) {}
            const ins = db.prepare(`
              INSERT INTO products (name, url, store, current_price, in_stock, is_preorder, notify_on_stock, notify_on_price_drop, check_interval_minutes, image_url)
              VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
            `).run(
              product.name,
              product.url,
              productStore,
              product.price,
              product.inStock === undefined ? null : (product.inStock ? 1 : 0),
              product.isPreorder ? 1 : 0,
              globalCheckInterval,
              product.image
            );
            console.log(`    ➕ Auto-added: ${product.name}`);
            const newP = db.prepare('SELECT * FROM products WHERE id = ?').get(ins.lastInsertRowid);
            if (newP) toCheck.push(newP);
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
              productStore,
              product.image,
              product.inStock === undefined ? null : (product.inStock ? 1 : 0),
              product.isPreorder ? 1 : 0,
              'keyword',
              watch.id
            );
            // Update original_price and image for existing items
            if (product.originalPrice || product.image) {
              db.prepare(`
                UPDATE found_items SET
                  original_price = COALESCE(?, original_price),
                  image_url = COALESCE(NULLIF(?, ''), image_url)
                WHERE url = ? AND (original_price IS NULL OR image_url IS NULL OR image_url = '')
              `).run(product.originalPrice || null, product.image || '', product.url);
            }
            console.log(`    🔍 Discovered: ${product.name}`);
          }
        } catch(e) { console.error('Error adding new product:', e.message); }
      }
      if (toCheck.length > 0) {
        console.log(`  ⚡ Checking ${toCheck.length} newly added products...`);
        for (const p of toCheck) {
          try { await checker.checkProduct(p); console.log(`  ✅ Checked: ${p.name}`); }
          catch(e) { console.error(`  ❌ ${p.name}: ${e.message}`); }
        }
      }
      db.prepare('INSERT INTO notifications (product_id, type, message) VALUES (?, ?, ?)')
        .run(null, 'keyword_watch', `Found ${newProducts.length} new for "${watch.keyword}"`);
    }

    // Notify back-in-stock
    if (watch.notify_in_stock) {
      const backInStock = filteredProducts.filter(p => p.inStock === true && knownStockMap[p.url] === false);
      if (backInStock.length > 0) {
        await telegram.sendKeywordAlert(watch, null, backInStock);
      }
    }

    // Update known maps
    filteredProducts.forEach(p => { if (p.inStock !== undefined) knownStockMap[p.url] = p.inStock; });
    const trackedUrls = db.prepare('SELECT url FROM products').all().map(p => p.url);
    const discoveredUrls = db.prepare("SELECT url FROM found_items WHERE source_type = 'keyword' AND source_id = ?").all(watch.id).map(p => p.url);
    const allKnownUrls = [...new Set([...filteredProducts.map(p => p.url), ...trackedUrls, ...discoveredUrls])];

    db.prepare(`UPDATE keyword_watches SET known_product_urls=?, known_stock_map=?, last_checked=datetime('now'), last_found_count=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(allKnownUrls), JSON.stringify(knownStockMap), filteredProducts.length, watch.id);

    return { total: foundProducts.length, new: newProducts.length };
  }

  async checkAll() {
    if (!db.isInitialized()) {
      console.log('⏳ Database not ready yet, skipping keyword watch check...');
      return;
    }
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
