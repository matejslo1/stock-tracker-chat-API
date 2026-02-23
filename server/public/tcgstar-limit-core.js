// tcgstar-limit-core.js
// Core logic: detect Shopify cart-limit error message and auto-cap cart quantities.
//
// Runs on tcgstar.eu via a userscript (Tampermonkey) that @requires this file.
// It learns per-product limits by parsing the validation popup message:
// "Product Name: Must have at most X of this item."
//
// Limits are stored locally in the browser (localStorage) keyed by product handle.

(function () {
  const STORAGE_KEY = "tcgstar_limits_by_handle_v1";
  const DEBUG = false;

  const log = (...a) => DEBUG && console.log("[tcgstar-limit]", ...a);

  function loadLimits() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveLimits(limits) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(limits));
  }

  async function getCart() {
    const r = await fetch("/cart.js", { credentials: "same-origin" });
    if (!r.ok) throw new Error("Failed to fetch /cart.js");
    return r.json();
  }

  async function changeLine(lineIndex1Based, qty) {
    const r = await fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ line: lineIndex1Based, quantity: qty }),
    });
    if (!r.ok) throw new Error("Failed to POST /cart/change.js");
    return r.json();
  }

  // Parse numbers from message like:
  // "Product Name: Must have at most 2 of this item."
  function parseLimitsFromText(text) {
    const results = [];
    const lines = (text || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const line of lines) {
      const m = line.match(/^(.*?):\s*Must have at most\s+(\d+)\s+of this item\.?/i);
      if (m) {
        results.push({ title: m[1].trim(), max: parseInt(m[2], 10) });
      }
    }

    // fallback: look for "Must have at most X"
    if (!results.length) {
      const m2 = (text || "").match(/Must have at most\s+(\d+)\s+of this item/i);
      if (m2) results.push({ title: null, max: parseInt(m2[1], 10) });
    }

    return results;
  }

  // Find popup text by searching DOM for the phrase.
  function findValidationText() {
    const needle = "Must have at most";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if ((node.nodeValue || "").includes(needle)) {
        const container = node.parentElement?.closest("dialog, [role='dialog'], .modal, .drawer, aside, section, div");
        const text = container ? container.innerText : node.nodeValue;
        return text || "";
      }
    }
    return "";
  }

  async function enforceCartCaps({ newLimitsByTitle = [], shouldNotify = false } = {}) {
    let limitsByHandle = loadLimits();
    const cart = await getCart();

    // Map title-based limits to cart items -> handle (best-effort)
    for (const nl of newLimitsByTitle) {
      if (!nl.max || nl.max < 0) continue;

      if (nl.title) {
        const item =
          cart.items.find((it) => (it.product_title || "").trim() === nl.title.trim()) ||
          cart.items.find((it) => (it.title || "").includes(nl.title)) ||
          cart.items.find((it) => (nl.title || "").includes(it.product_title || ""));
        if (item?.handle) limitsByHandle[item.handle] = nl.max;
      }
    }

    // Apply optional overrides (set by config file)
    const overrides = window.__TCGSTAR_LIMIT_OVERRIDES__ || {};
    if (Object.keys(overrides).length) {
      limitsByHandle = { ...limitsByHandle, ...overrides };
    }

    saveLimits(limitsByHandle);

    const fixes = [];
    for (let i = 0; i < cart.items.length; i++) {
      const item = cart.items[i];
      const max = limitsByHandle[item.handle];
      if (max != null && item.quantity > max) {
        fixes.push({
          line: i + 1,
          from: item.quantity,
          to: max,
          title: item.product_title || item.title || item.handle,
          handle: item.handle,
        });
      }
    }

    if (!fixes.length) return { changed: false, fixes: [] };

    for (const f of fixes) {
      await changeLine(f.line, f.to);
    }

    if (shouldNotify) {
      const lines = fixes.map((f) => `• ${f.title}: max ${f.to}`).join("\n");
      alert(`Omejitev količine v košarici:\n${lines}\n\nPresežek sem odstranil iz košarice.`);
    }

    return { changed: true, fixes };
  }

  function hookCheckout() {
    document.addEventListener(
      "click",
      async (e) => {
        const el = e.target.closest("a,button,input");
        if (!el) return;

        const href = (el.getAttribute("href") || "").toLowerCase();
        const name = (el.getAttribute("name") || "").toLowerCase();
        const isCheckout =
          href.includes("/checkout") ||
          name.includes("checkout") ||
          (el.type === "submit" && (el.value || "").toLowerCase().includes("checkout"));

        if (!isCheckout) return;

        // Let the site open the validation popup first; then read it and fix.
        setTimeout(async () => {
          try {
            const text = findValidationText();
            if (!text || !text.includes("Must have at most")) return;

            const parsed = parseLimitsFromText(text);
            if (!parsed.length) return;

            const res = await enforceCartCaps({ newLimitsByTitle: parsed, shouldNotify: true });
            if (res.changed) {
              // Try checkout again
              setTimeout(() => (window.location.href = "/checkout"), 200);
            }
          } catch (err) {
            log("checkout hook error", err);
          }
        }, 250);
      },
      true
    );
  }

  function startPeriodicEnforce() {
    setInterval(() => {
      enforceCartCaps().catch(() => {});
    }, 4000);
  }

  window.TCGStarLimitEnforcer = {
    enforceNow: () => enforceCartCaps({ shouldNotify: true }),
    getLimits: () => loadLimits(),
    clearLimits: () => saveLimits({}),
    init: () => {
      hookCheckout();
      startPeriodicEnforce();
      enforceCartCaps().catch(() => {});
    },
  };
})();
