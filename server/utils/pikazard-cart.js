const cheerio = require('cheerio');
const http = require('./http');

function encodeCartItems(items) {
  return Buffer.from(JSON.stringify(items), 'utf8').toString('base64url');
}

function decodeCartItems(raw) {
  try {
    return JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch (e) {
    return [];
  }
}

async function getPikazardCartItem(productUrl, quantity = 1) {
  try {
    const res = await http.get(productUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/xhtml+xml' },
      timeout: 15000,
      maxRedirects: 5,
    });
    const $ = cheerio.load(res.data);
    const form = $('#product-detail-form');
    if (!form.length) return null;

    const productId = form.find('input[name="productId"]').attr('value');
    const priceId = form.find('input[name="priceId"]').attr('value');
    const language = form.find('input[name="language"]').attr('value') || 'sk';
    if (!productId || !priceId) return null;

    return {
      productId: String(productId),
      priceId: String(priceId),
      amount: Math.max(1, parseInt(quantity, 10) || 1),
      language,
      name: $('h1').first().text().trim() || productUrl,
      url: productUrl,
    };
  } catch (e) {
    console.log(`  ⚠️  Pikazard cart item fetch failed for ${productUrl}: ${e.message}`);
    return null;
  }
}

async function buildPikazardCartHelperUrl(products) {
  const items = [];
  const errors = [];
  for (const product of products) {
    const quantity = product.max_order_qty && product.max_order_qty > 0 ? product.max_order_qty : 1;
    const item = await getPikazardCartItem(product.url, quantity);
    if (item) {
      items.push(item);
    } else {
      errors.push(`${product.name}: ni bilo mogoče pridobiti productId/priceId`);
    }
    await new Promise(r => setTimeout(r, 1200));
  }

  const cartUrl = items.length > 0 ? `/cart-helper/pikazard?items=${encodeURIComponent(encodeCartItems(items))}` : null;
  return { cartUrl, items, domain: 'https://www.pikazard.eu', errors };
}

module.exports = { getPikazardCartItem, buildPikazardCartHelperUrl, encodeCartItems, decodeCartItems };
