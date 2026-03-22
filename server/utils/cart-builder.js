const { buildCartUrlForProducts } = require('./shopify-cart');
const { buildPikazardCartHelperUrl } = require('./pikazard-cart');

async function buildCartForProducts(products, globalMaxQty = null, cartQtyMode = 'global') {
  const activeProducts = (products || []).filter(p => p && p.in_stock);
  if (activeProducts.length === 0) {
    return { cartUrl: null, items: [], domain: null, errors: ['Ni izdelkov na zalogi'] };
  }

  const store = activeProducts[0].store;
  if (['shopify', 'pokedom', 'tcgstar'].includes(store)) {
    return buildCartUrlForProducts(activeProducts, globalMaxQty, cartQtyMode);
  }
  if (store === 'pikazard') {
    return buildPikazardCartHelperUrl(activeProducts);
  }

  return { cartUrl: null, items: [], domain: null, errors: [`Košarica za store "${store}" še ni podprta`] };
}

module.exports = { buildCartForProducts };
