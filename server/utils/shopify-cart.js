const axios = require('axios');

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];
const getUA = () => userAgents[Math.floor(Math.random() * userAgents.length)];

/**
 * Probe Shopify cart/add.js to infer store-enforced max quantity for a variant.
 * This does NOT touch any real user cart (no cookies) - it only attempts an anonymous add request
 * and parses the returned validation error message (e.g. "Must have at most 2 of this item.").
 */
async function probeLimitViaCartAdd(domain, variantId, probeQty) {
  try {
    const payload = new URLSearchParams({ id: String(variantId), quantity: String(probeQty) }).toString();
    const res = await axios.post(`${domain}/cart/add.js`, payload, {
      headers: {
        'User-Agent': getUA(),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
      },
      timeout: 10000,
      validateStatus: () => true,
    });

    // Shopify can return JSON or plain text depending on theme/apps
    const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const msg = raw || '';

    // Common patterns
    const m1 = msg.match(/at most\s+(\d+)/i);
    if (m1) return parseInt(m1[1], 10);

    const m2 = msg.match(/max(?:imum)?\s*(?:qty|quantity)?\s*[:\-]?\s*(\d+)/i);
    if (m2) return parseInt(m2[1], 10);

    const m3 = msg.match(/must have\s+at\s+most\s+(\d+)/i);
    if (m3) return parseInt(m3[1], 10);

    // If the add succeeded (200) we assume probeQty is allowed.
    if (res.status >= 200 && res.status < 300) return probeQty;

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Detect order limit by reading the product page HTML and product JSON.
 * NO cart manipulation - completely safe, doesn't touch anyone's cart.
 *
 * Strategies (in order):
 * 1. Parse limit from product tags (e.g. "limit-2")
 * 2. Parse limit from product description HTML
 * 3. Check selling_plan_allocations for quantity rules
 * 4. Try /products/handle.json for metafields hint
 * 5. Default: return stockQty (capped at 10)
 */
async function detectOrderLimit(domain, variantId, stockQty) {
  console.log(`  🔢 Detecting order limit for variant ${variantId}...`);

  // Strategy 0 (most reliable): probe Shopify cart validation server-side.
  // This does NOT affect the user's cart; it's a separate anonymous session on the server.
  // Works even when limits are enforced by apps / cart validation / checkout rules.
  async function probeCartAddLimit(probeQty) {
    const addUrl = `${domain}/cart/add.js`;
    const cartUrl = `${domain}/cart.js`;
    const clearUrl = `${domain}/cart/clear.js`;

    const headers = {
      'User-Agent': getUA(),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    // Helper to parse "at most N" from various response formats
    const parseMax = (payload) => {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload || '');
      const m = text.match(/at\s+most\s+(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    };

    try {
      const addRes = await axios.post(
        addUrl,
        { items: [{ id: Number(variantId), quantity: Number(probeQty) }] },
        {
          headers,
          timeout: 12000,
          validateStatus: () => true,
        }
      );

      // If the store refuses the quantity, Shopify commonly returns 422 + message
      const maxFromErr = parseMax(addRes.data);
      if (maxFromErr && maxFromErr > 0) {
        console.log(`  ✅ Limit from cart validation: ${maxFromErr}`);
        return maxFromErr;
      }

      // If it succeeded (or partially succeeded), read cart state to infer cap.
      if (addRes.status >= 200 && addRes.status < 300) {
        try {
          const cartRes = await axios.get(cartUrl, {
            headers: { 'User-Agent': getUA(), 'Accept': 'application/json' },
            timeout: 8000,
            validateStatus: () => true,
          });
          const item = cartRes?.data?.items?.find(it => String(it.variant_id) === String(variantId));
          const qty = item?.quantity;
          if (typeof qty === 'number' && qty > 0) {
            console.log(`  ✅ Limit inferred from cart quantity: ${qty}`);
            return qty;
          }
        } finally {
          // Best-effort cleanup for this anonymous session
          try {
            await axios.post(clearUrl, {}, { headers, timeout: 8000, validateStatus: () => true });
          } catch (_) {}
        }
      }
    } catch (e) {
      // ignore; we'll fall back to heuristics below
    }

    return null;
  }

  try {
    // Strategy 0: Actively probe cart validation (works with many order-limit apps)
    const probeQty = Math.max(5, Math.min(stockQty || 10, 25));
    const probed = await probeLimitViaCartAdd(domain, variantId, probeQty);
    if (probed && probed > 0) {
      console.log(`  ✅ Limit from cart probe: ${probed}`);
      return probed;
    }
    // Find the product handle from variant ID
    const productsRes = await axios.get(`${domain}/products.json?limit=250`, {
      headers: { 'User-Agent': getUA(), 'Accept': 'application/json' },
      timeout: 10000,
      validateStatus: () => true,
    });

    if (productsRes.status === 200 && productsRes.data && productsRes.data.products) {
      for (const product of productsRes.data.products) {
        const variant = product.variants.find(v => String(v.id) === String(variantId));
        if (!variant) continue;

        // Strategy 1: Check product tags for limit pattern (tags is an ARRAY)
        const tagsArr = Array.isArray(product.tags) ? product.tags : (product.tags || '').split(',');
        const tagsStr = tagsArr.join(' ').toLowerCase();
        const tagMatch = tagsStr.match(/(?:limit|max(?:imum)?|purchase.limit)[_\-\s](\d+)|(\d+)[_\-\s](?:limit|max)/);
        if (tagMatch) {
          const limit = parseInt(tagMatch[1] || tagMatch[2]);
          console.log(`  ✅ Limit from tags: ${limit}`);
          return limit;
        }

        // Strategy 2: Parse product body_html for limit text
        const body = (product.body_html || '').replace(/<[^>]*>/g, ' ').toLowerCase();
        const bodyMatch = body.match(
          /(?:at most|maximum|limit|only|max)\s+(\d+)\s+(?:per|of|item|piece|kos|na naročilo|per order)/i
        ) || body.match(/(\d+)\s+(?:per order|per customer|na naročilo|na stranko)/i);
        if (bodyMatch) {
          const limit = parseInt(bodyMatch[1]);
          console.log(`  ✅ Limit from description: ${limit}`);
          return limit;
        }

        // Strategy 3: Check variant quantity_rule (available in some Shopify versions)
        if (variant.quantity_rule) {
          const max = variant.quantity_rule.max;
          if (max && max > 0) {
            console.log(`  ✅ Limit from quantity_rule: ${max}`);
            return max;
          }
        }

        // Strategy 4: Fetch full product page and look for limit in JS vars or meta
        try {
          const pageRes = await axios.get(`${domain}/products/${product.handle}.js`, {
            headers: { 'User-Agent': getUA(), 'Accept': 'application/json' },
            timeout: 8000,
          });

          if (pageRes.data) {
            // Check variants for quantity_rule
            const v = pageRes.data.variants?.find(pv => String(pv.id) === String(variantId));
            if (v?.quantity_rule?.max) {
              console.log(`  ✅ Limit from product.js quantity_rule: ${v.quantity_rule.max}`);
              return v.quantity_rule.max;
            }
          }
        } catch(e) { /* ignore */ }

        // Strategy 5: Probe cart validation (server-side). This catches hidden limits.
        // Use a high probe, but keep it reasonable.
        const probe = Math.max(5, Math.min(50, Number(stockQty || 50)));
        const probedMax = await probeCartAddLimit(probe);
        if (probedMax && probedMax > 0) {
          return probedMax;
        }

        // Found the product but no explicit limit — use stock qty
        const qty = stockQty > 0 ? Math.min(stockQty, 10) : 10;
        console.log(`  ℹ️  No explicit limit found, using qty=${qty}`);
        return qty;
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Order limit detection failed: ${e.message}`);
  }

  // Fallback
  const fallback = stockQty > 0 ? Math.min(stockQty, 10) : 1;
  console.log(`  ℹ️  Fallback limit: ${fallback}`);
  return fallback;
}

/**
 * Get variant info from Shopify product URL
 */
async function getShopifyVariant(productUrl) {
  try {
    const urlObj = new URL(productUrl);
    const domain = urlObj.origin;
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    const productsIdx = pathParts.indexOf('products');

    if (productsIdx === -1 || !pathParts[productsIdx + 1]) return null;

    const handle = pathParts[productsIdx + 1].split('?')[0];
    const productJsonUrl = `${domain}/products/${handle}.js`;

    const res = await axios.get(productJsonUrl, {
      headers: { 'User-Agent': getUA(), 'Accept': 'application/json' },
      timeout: 8000,
    });

    if (!res.data || !res.data.variants) return null;

    const variants = res.data.variants;
    const available = variants.filter(v => v.available);
    const best = available[0] || variants[0];
    if (!best) return null;

    const stockQty = best.inventory_quantity || 0;
    const unlimited = !best.inventory_management || best.inventory_policy === 'continue';

    let maxQty = 1;
    if (best.available) {
      const probeQty = unlimited ? 10 : (stockQty > 0 ? stockQty : 10);
      maxQty = await detectOrderLimit(domain, best.id, probeQty);
    }

    console.log(`  ✅ Variant ${best.id}: stockQty=${stockQty}, unlimited=${unlimited}, maxQty=${maxQty}`);

    return {
      variantId: best.id,
      domain,
      productTitle: res.data.title,
      price: best.price ? parseFloat(best.price) / 100 : null,
      available: best.available,
      stockQty,
      maxQty,
      allVariants: variants,
    };
  } catch (e) {
    console.log(`  ⚠️  Shopify variant fetch failed for ${productUrl}: ${e.message}`);
    return null;
  }
}

/**
 * Build Shopify cart URL
 */
function buildCartUrl(domain, items) {
  if (!items || items.length === 0) return null;
  const cartPart = items.map(i => `${i.variantId}:${i.quantity}`).join(',');
  return `${domain}/cart/${cartPart}?return_to=/cart`;
}

/**
 * Build direct checkout URL — skips cart page, ideal for mobile
 * Format: /cart/variantId:qty?checkout (Shopify redirects to checkout immediately)
 */
function buildCheckoutUrl(domain, items) {
  if (!items || items.length === 0) return null;
  const cartPart = items.map(i => `${i.variantId}:${i.quantity}`).join(',');
  return `${domain}/cart/${cartPart}?checkout`;
}

/**
 * Build cart URL for list of in-stock Shopify products
 * @param {Array} products - list of product rows from DB
 * @param {number|null} globalMaxQty - optional global max qty from app settings
 */
async function buildCartUrlForProducts(products, globalMaxQty = null) {
  const shopifyProducts = products.filter(p => p.store === 'shopify' && p.in_stock);

  if (shopifyProducts.length === 0) {
    return { cartUrl: null, items: [], domain: null, errors: ['Ni Shopify izdelkov na zalogi'] };
  }

  const items = [];
  const errors = [];
  let domain = null;

  for (const product of shopifyProducts) {
    const variant = await getShopifyVariant(product.url);

    if (variant) {
      if (!domain) domain = variant.domain;
      if (variant.domain === domain) {
        // Priority: per-product max_order_qty > global_max_qty > detected store limit
        const perProductQty = product.max_order_qty && product.max_order_qty > 0 ? product.max_order_qty : null;
        let qty = variant.maxQty;
        if (globalMaxQty && globalMaxQty > 0) qty = Math.min(qty, globalMaxQty);
        if (perProductQty) qty = Math.min(qty, perProductQty);
        items.push({
          variantId: variant.variantId,
          quantity: qty,
          name: product.name,
          price: product.current_price,
          stockQty: variant.stockQty,
          appliedLimit: perProductQty ? 'per-product' : (globalMaxQty ? 'global' : 'store'),
        });
      } else {
        errors.push(`${product.name}: različna domena (${variant.domain})`);
      }
    } else {
      if (product.shopify_variant_id) {
        try {
          const productDomain = new URL(product.url).origin;
          if (!domain) domain = productDomain;
          if (productDomain === domain) {
            const perProductQty = product.max_order_qty || 1;
            let qty = perProductQty;
            if (globalMaxQty && globalMaxQty > 0) qty = Math.min(qty, globalMaxQty);
            items.push({
              variantId: product.shopify_variant_id,
              quantity: qty,
              name: product.name,
              price: product.current_price,
            });
          }
        } catch(e) {}
      } else {
        errors.push(`${product.name}: ni bilo mogoče pridobiti variant ID`);
      }
    }

    // Longer delay between products to avoid 429 on same domain
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
  }

  const cartUrl = domain && items.length > 0 ? buildCartUrl(domain, items) : null;
  return { cartUrl, items, domain, errors };
}

module.exports = { getShopifyVariant, buildCartUrl, buildCheckoutUrl, buildCartUrlForProducts, detectOrderLimit };
