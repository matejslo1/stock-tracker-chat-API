/**
 * storeDetection.js
 * Centralised logic for mapping product URLs → store names.
 * Used by generic.js (scraper) and database.js (migration).
 *
 * Supported stores:
 *   tcgstar   — tcgstar.eu       Shopify  (Slovenian)
 *   pikazard  — pikazard.eu      Shoptet  (Slovak)
 *   pokedom   — pokedom.eu       Shopify  (Croatian)
 *   amazon    — amazon.*
 *   bigbang   — bigbang.si
 *   mimovrste — mimovrste.com
 *   shopify   — any other Shopify store (detected via /products/ path)
 *   custom    — fallback
 */

const SHOPIFY_STORES = ['shopify', 'tcgstar', 'pokedom'];
const SHOPTET_STORES = ['pikazard'];
const KNOWN_STORES   = ['amazon', 'bigbang', 'mimovrste', 'shopify', 'custom', 'tcgstar', 'pikazard', 'pokedom'];

/**
 * Detect the store name from a product URL.
 * Returns a store name string (never null/undefined).
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function detectStoreFromUrl(rawUrl) {
  try {
    const urlObj  = new URL(rawUrl);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');

    // ── Exact-domain matches for known TCG stores ──
    if (hostname === 'tcgstar.eu')   return 'tcgstar';
    if (hostname === 'pikazard.eu')  return 'pikazard';
    if (hostname === 'pokedom.eu')   return 'pokedom';

    // ── Other Slovenian stores ──
    if (hostname === 'bigbang.si')    return 'bigbang';
    if (hostname === 'mimovrste.com' || hostname === 'mimovrste.si') return 'mimovrste';

    // ── Amazon (any country domain) ──
    if (hostname.startsWith('amazon.') || hostname.includes('.amazon.')) return 'amazon';

    // ── Generic Shopify: /products/ in the URL path ──
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    if (pathParts.includes('products')) return 'shopify';

  } catch (_e) { /* invalid URL — fall through to 'custom' */ }

  return 'custom';
}

/**
 * Returns true if the store uses the Shopify platform
 * (supports the /products/{handle}.js API).
 */
function isShopifyStore(storeName) {
  return SHOPIFY_STORES.includes(storeName);
}

/**
 * Returns true if the store uses the Shoptet platform.
 */
function isShoptetStore(storeName) {
  return SHOPTET_STORES.includes(storeName);
}

module.exports = {
  detectStoreFromUrl,
  isShopifyStore,
  isShoptetStore,
  KNOWN_STORES,
  SHOPIFY_STORES,
  SHOPTET_STORES,
};
