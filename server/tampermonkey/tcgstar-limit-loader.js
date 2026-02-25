// tcgstar-limit-loader.js (v5)
// Boots the enforcer once all @required scripts are loaded.
(function () {
  let attempts = 0;
  const MAX_ATTEMPTS = 100; // 5 seconds max

  function initWhenReady() {
    if (window.TCGStarLimitEnforcer?.init) {
      console.log("[tcgstar-limit] 🚀 Loader: starting enforcer v" + (window.TCGStarLimitEnforcer.version || "?"));
      window.TCGStarLimitEnforcer.init();
      return;
    }
    attempts++;
    if (attempts < MAX_ATTEMPTS) {
      setTimeout(initWhenReady, 50);
    } else {
      console.warn("[tcgstar-limit] ⚠️ Loader: TCGStarLimitEnforcer not found after 5s. Is core.js loaded?");
    }
  }

  initWhenReady();
})();
