// tcgstar-limit-config.js
// Optional manual overrides: handle -> max quantity.
// This merges on top of learned limits (stored in localStorage).
//
// Example:
// window.__TCGSTAR_LIMIT_OVERRIDES__ = {
//   "pokemon-mega-evolution-me01-mega-lucario-mega-gardevoir-mini-portfolio": 2,
// };

(function () {
  window.__TCGSTAR_LIMIT_OVERRIDES__ = {
    // You can pin known limits here if you want:
    // "pokemon-mega-evolution-me01-mega-lucario-mega-gardevoir-mini-portfolio": 2,
    // "pokemon-scarlet-violet-black-bolt-white-flare-sv10-5-unova-victini-illustration-collection-copy": 3,
  };
})();
