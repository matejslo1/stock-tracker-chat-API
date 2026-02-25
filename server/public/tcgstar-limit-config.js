// tcgstar-limit-config.js (v5)
// Optional manual overrides: handle -> max quantity.
// This merges on top of auto-learned limits (stored in localStorage).
//
// How to find the handle: go to the product page URL, e.g.
// https://tcgstar.eu/products/pokemon-mega-evolution-me01 → handle = "pokemon-mega-evolution-me01"
//
// Overrides always win over auto-learned limits.

(function () {
  window.__TCGSTAR_LIMIT_OVERRIDES__ = {
    // Uncomment and edit to pin known limits:
    // "pokemon-mega-evolution-me01-mega-lucario-mega-gardevoir-mini-portfolio": 2,
    // "pokemon-scarlet-violet-black-bolt-white-flare-sv10-5-unova-victini-illustration-collection-copy": 3,
  };
})();
