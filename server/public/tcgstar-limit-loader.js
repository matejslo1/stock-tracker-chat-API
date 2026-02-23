// tcgstar-limit-loader.js
// Boots the enforcer once all @required scripts are loaded.
(function () {
  function initWhenReady() {
    if (window.TCGStarLimitEnforcer?.init) {
      window.TCGStarLimitEnforcer.init();
      return;
    }
    setTimeout(initWhenReady, 50);
  }
  initWhenReady();
})();
