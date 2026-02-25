// tcgstar-limit-core.js (v5) — full cart limit enforcement + cart page qty optimization
// Loaded via @require from Tampermonkey userscript.
// Learns limits from "Must have at most X" popups and enforces them.
(function () {
  const STORAGE_KEY = "tcgstar_limits_by_handle_v2";
  const DEBUG = false;
  const log = (...a) => DEBUG && console.log("%c[tcgstar-limit]", "color:#e67e22;font-weight:bold", ...a);

  // ═══════════════════════════════════════════════════
  // LIMIT STORAGE
  // ═══════════════════════════════════════════════════
  function loadLimits() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
  }
  function saveLimits(limits) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(limits)); } catch {}
  }
  function setLimit(handle, max) {
    const limits = loadLimits();
    limits[handle] = max;
    saveLimits(limits);
    log(`Learned: ${handle} → max ${max}`);
  }
  function getLimit(handle) {
    return loadLimits()[handle] ?? null;
  }

  // Migrate v1 data to v2 if present
  try {
    const v1 = localStorage.getItem("tcgstar_limits_by_handle_v1");
    if (v1 && !localStorage.getItem(STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, v1);
      log("Migrated v1 limits → v2");
    }
  } catch {}

  // ═══════════════════════════════════════════════════
  // SHOPIFY CART API
  // ═══════════════════════════════════════════════════
  async function getCart() {
    const r = await fetch("/cart.js", { credentials: "same-origin" });
    if (!r.ok) throw new Error("Failed to fetch /cart.js");
    return r.json();
  }

  async function changeLine(lineIndex1Based, qty) {
    log(`Change line ${lineIndex1Based} → qty ${qty}`);
    const r = await fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ line: lineIndex1Based, quantity: qty }),
    });
    if (!r.ok) throw new Error("Failed to POST /cart/change.js");
    return r.json();
  }

  // ═══════════════════════════════════════════════════
  // TEXT NORMALIZATION & MATCHING
  // ═══════════════════════════════════════════════════
  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/&amp;/g, "&")
      .replace(/['']/g, "'")
      .replace(/[–—]/g, "-")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function scoreMatch(popupTitle, cartTitle) {
    const a = norm(popupTitle);
    const b = norm(cartTitle);
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (b.includes(a)) return 80;
    if (a.includes(b)) return 70;
    const at = new Set(a.split(" "));
    const bt = new Set(b.split(" "));
    let common = 0;
    for (const t of at) if (bt.has(t)) common++;
    const denom = Math.max(at.size, bt.size) || 1;
    return Math.round((common / denom) * 60);
  }

  function findBestCartLine(cart, popupTitle) {
    let best = { idx: -1, score: 0 };
    for (let i = 0; i < cart.items.length; i++) {
      const it = cart.items[i];
      const candidates = [
        it.product_title,
        it.title,
        `${it.product_title || ""} ${it.variant_title || ""}`.trim(),
      ];
      let localBest = 0;
      for (const c of candidates) localBest = Math.max(localBest, scoreMatch(popupTitle, c));
      if (localBest > best.score) best = { idx: i, score: localBest };
    }
    return best.score >= 35 ? best.idx : -1;
  }

  // ═══════════════════════════════════════════════════
  // PARSE LIMIT ERRORS
  // ═══════════════════════════════════════════════════
  function parseAllLimitsFromText(bigText) {
    const results = [];
    const re = /([^:\n]+):\s*Must have at most\s+(\d+)\s+of this item\.?/gi;
    let m;
    while ((m = re.exec(bigText || ""))) {
      results.push({ title: (m[1] || "").trim(), max: parseInt(m[2], 10) });
    }
    return results;
  }

  function collectLimitTextFromDOM() {
    const needle = "Must have at most";
    const parts = [];
    const nodes = document.querySelectorAll("*");
    for (const el of nodes) {
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style") continue;
      const t = el.innerText;
      if (t && t.includes(needle)) parts.push(t);
    }
    if (!parts.length) return "";
    return Array.from(new Set(parts)).join("\n");
  }

  // ═══════════════════════════════════════════════════
  // UI: NOTIFICATION BANNER
  // ═══════════════════════════════════════════════════
  function showBanner(fixes) {
    const existing = document.getElementById("stk-enforcer-banner");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.id = "stk-enforcer-banner";
    banner.style.cssText = `
      position:fixed;top:12px;right:12px;z-index:999999;
      background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;
      padding:16px 20px;border-radius:14px;
      box-shadow:0 8px 32px rgba(0,0,0,.35);
      font-family:-apple-system,BlinkMacSystemFont,sans-serif;
      font-size:13px;max-width:380px;line-height:1.5;
      animation:stk-slide-in .3s ease-out;
    `;

    const title = document.createElement("div");
    title.style.cssText = "font-weight:700;font-size:14px;margin-bottom:8px;display:flex;align-items:center;gap:6px";
    title.innerHTML = `<span style="font-size:18px">🛒</span> Količina prilagojena`;

    const list = document.createElement("div");
    list.style.cssText = "font-size:12px;opacity:.85";
    list.innerHTML = fixes.map(f =>
      `<div style="margin:3px 0">• <strong>${f.title}</strong> → max <strong>${f.to}</strong></div>`
    ).join("");

    const closeBtn = document.createElement("div");
    closeBtn.style.cssText = "position:absolute;top:8px;right:12px;cursor:pointer;opacity:.6;font-size:16px";
    closeBtn.textContent = "✕";
    closeBtn.onclick = () => banner.remove();

    banner.append(title, list, closeBtn);
    document.body.appendChild(banner);

    setTimeout(() => {
      if (banner.parentNode) {
        banner.style.transition = "opacity .3s, transform .3s";
        banner.style.opacity = "0";
        banner.style.transform = "translateX(20px)";
        setTimeout(() => banner.remove(), 300);
      }
    }, 5000);
  }

  // Inject CSS animation
  try {
    const style = document.createElement("style");
    style.textContent = `@keyframes stk-slide-in{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:translateX(0)}}`;
    document.head.appendChild(style);
  } catch {}

  // ═══════════════════════════════════════════════════
  // UI: STATUS INDICATOR
  // ═══════════════════════════════════════════════════
  function addStatusIndicator() {
    if (document.getElementById("stk-enforcer-status")) return;
    const el = document.createElement("div");
    el.id = "stk-enforcer-status";
    el.style.cssText = `
      position:fixed;bottom:12px;right:12px;z-index:999998;
      background:#1a1a2e;color:#4ade80;
      padding:6px 12px;border-radius:20px;
      font-family:-apple-system,sans-serif;font-size:11px;font-weight:600;
      box-shadow:0 2px 12px rgba(0,0,0,.2);
      cursor:pointer;opacity:.6;transition:opacity .2s;
      display:flex;align-items:center;gap:5px;
    `;
    el.innerHTML = `<span style="font-size:13px">🛡️</span> STK v5`;
    el.title = "Stock Tracker Cart Limit Enforcer";
    el.onmouseenter = () => el.style.opacity = "1";
    el.onmouseleave = () => el.style.opacity = ".6";
    el.onclick = async () => {
      const limits = loadLimits();
      const count = Object.keys(limits).length;
      const cart = await getCart().catch(() => null);
      const itemCount = cart?.items?.length || 0;
      alert(
        `🛡️ Stock Tracker Cart Enforcer v5\n\n` +
        `📦 Naučenih omejitev: ${count}\n` +
        `🛒 Izdelkov v košarici: ${itemCount}\n\n` +
        `Omejitve:\n` +
        (count > 0
          ? Object.entries(limits).slice(0, 30).map(([h, m]) => `  • ${h}: max ${m}`).join("\n")
          : "  Še ni naučenih omejitev")
      );
    };
    document.body.appendChild(el);
  }

  // ═══════════════════════════════════════════════════
  // ENFORCE FROM POPUP TEXT
  // ═══════════════════════════════════════════════════
  async function enforceFromPopupText(popupText, { shouldNotify = false } = {}) {
    const cart = await getCart();
    const parsed = parseAllLimitsFromText(popupText);
    if (!parsed.length) return { changed: false, fixes: [] };

    // Learn handle limits
    for (const p of parsed) {
      const idx = findBestCartLine(cart, p.title);
      if (idx >= 0) {
        const item = cart.items[idx];
        if (item?.handle) setLimit(item.handle, p.max);
      }
    }

    // Apply fixes
    const fixes = [];
    for (const p of parsed) {
      const idx = findBestCartLine(cart, p.title);
      if (idx >= 0) {
        const item = cart.items[idx];
        if (item.quantity > p.max) {
          fixes.push({ line: idx + 1, title: item.product_title || item.title, to: p.max });
        }
      }
    }

    if (!fixes.length) return { changed: false, fixes: [] };
    for (const f of fixes) await changeLine(f.line, f.to);

    if (shouldNotify) showBanner(fixes);
    log(`Fixed ${fixes.length} items from popup`);
    return { changed: true, fixes };
  }

  // ═══════════════════════════════════════════════════
  // ENFORCE KNOWN CAPS
  // ═══════════════════════════════════════════════════
  async function enforceKnownCaps({ shouldNotify = false } = {}) {
    const cart = await getCart();
    const limitsByHandle = loadLimits();
    const fixes = [];

    for (let i = 0; i < cart.items.length; i++) {
      const it = cart.items[i];
      const maxStored = limitsByHandle[it.handle];
      const maxOverride = (window.__TCGSTAR_LIMIT_OVERRIDES__ || {})[it.handle];
      const max = maxOverride ?? maxStored;

      if (max != null && it.quantity > max) {
        fixes.push({ line: i + 1, title: it.product_title || it.title, to: max });
      }
    }

    if (!fixes.length) return { changed: false, fixes: [] };
    for (const f of fixes) await changeLine(f.line, f.to);

    if (shouldNotify) showBanner(fixes);
    return { changed: true, fixes };
  }

  // ═══════════════════════════════════════════════════
  // CART PAGE: OPTIMIZE QTY TO MAX
  // ═══════════════════════════════════════════════════
  async function optimizeCartPageQty() {
    if (!location.pathname.startsWith("/cart")) return { bumped: 0 };

    const cart = await getCart();
    const limits = loadLimits();
    const overrides = window.__TCGSTAR_LIMIT_OVERRIDES__ || {};
    const changes = [];

    for (let i = 0; i < cart.items.length; i++) {
      const it = cart.items[i];
      const maxKnown = overrides[it.handle] ?? limits[it.handle];

      if (maxKnown && it.quantity < maxKnown) {
        changes.push({ line: i + 1, title: it.product_title || it.title, from: it.quantity, to: maxKnown });
      }
    }

    if (!changes.length) return { bumped: 0 };

    log(`Optimizing cart: bumping ${changes.length} items to known max`);
    for (const c of changes) {
      try {
        await changeLine(c.line, c.to);
        log(`  ✅ ${c.title}: ${c.from} → ${c.to}`);
      } catch (e) {
        log(`  ❌ ${c.title}: ${e.message}`);
      }
    }

    showBanner(changes.map(c => ({ title: c.title, to: c.to })));
    setTimeout(() => location.reload(), 800);
    return { bumped: changes.length };
  }

  // ═══════════════════════════════════════════════════
  // POPUP WATCHER
  // ═══════════════════════════════════════════════════
  let checkoutRetries = 0;
  const MAX_CHECKOUT_RETRIES = 3;

  async function waitForPopupAndFix(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const txt = collectLimitTextFromDOM();
      if (txt && txt.includes("Must have at most")) {
        const res = await enforceFromPopupText(txt, { shouldNotify: true });
        if (res.changed && checkoutRetries < MAX_CHECKOUT_RETRIES) {
          checkoutRetries++;
          log(`Retrying checkout (attempt ${checkoutRetries}/${MAX_CHECKOUT_RETRIES})`);
          setTimeout(() => (window.location.href = "/checkout"), 300);
        }
        return true;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }

  // ═══════════════════════════════════════════════════
  // CART QTY INPUT WATCHER
  // ═══════════════════════════════════════════════════
  function watchCartQtyInputs() {
    if (!location.pathname.startsWith("/cart")) return;

    const observer = new MutationObserver(() => {
      const inputs = document.querySelectorAll(
        'input[name="updates[]"], input[data-quantity-input], input.cart__quantity-selector, input.quantity__input, input[type="number"][name*="quantity"]'
      );
      inputs.forEach((input) => {
        if (input.dataset.stkWatched) return;
        input.dataset.stkWatched = "1";

        input.addEventListener("change", async () => {
          const row = input.closest("tr, .cart-item, .cart__item, [data-cart-item], .cart__row");
          if (!row) return;

          const links = row.querySelectorAll("a[href*='/products/']");
          let handle = null;
          for (const link of links) {
            try {
              const parts = new URL(link.href).pathname.split("/");
              const pi = parts.indexOf("products");
              if (pi >= 0 && parts[pi + 1]) handle = parts[pi + 1].split("?")[0];
            } catch {}
          }

          if (handle) {
            const max = (window.__TCGSTAR_LIMIT_OVERRIDES__ || {})[handle] ?? getLimit(handle);
            const val = parseInt(input.value) || 0;
            if (max && val > max) {
              log(`Input clamped: ${handle} ${val} → ${max}`);
              input.value = max;
              input.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
        });
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ═══════════════════════════════════════════════════
  // HOOKS
  // ═══════════════════════════════════════════════════
  function hookCheckout() {
    document.addEventListener(
      "click",
      (e) => {
        const el = e.target.closest("a,button,input");
        if (!el) return;

        const href = (el.getAttribute("href") || "").toLowerCase();
        const name = (el.getAttribute("name") || "").toLowerCase();
        const val = (el.value || "").toLowerCase();
        const txt = (el.textContent || "").toLowerCase();

        const isCheckout =
          href.includes("/checkout") ||
          name.includes("checkout") ||
          (el.type === "submit" && val.includes("checkout")) ||
          txt.includes("checkout") ||
          txt.includes("zaključi") ||
          txt.includes("plačaj");

        if (!isCheckout) return;
        checkoutRetries = 0;
        log("Checkout click detected");
        setTimeout(() => { waitForPopupAndFix(10000).catch(() => {}); }, 50);
      },
      true
    );
  }

  function observeDOMForPopup() {
    let t = null;
    const obs = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        const txt = collectLimitTextFromDOM();
        if (txt && txt.includes("Must have at most")) {
          enforceFromPopupText(txt, { shouldNotify: true })
            .then((res) => {
              if (res.changed && checkoutRetries < MAX_CHECKOUT_RETRIES) {
                checkoutRetries++;
                setTimeout(() => (window.location.href = "/checkout"), 300);
              }
            })
            .catch(() => {});
        }
      }, 120);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function startPeriodicEnforce() {
    setInterval(() => { enforceKnownCaps().catch(() => {}); }, 4000);
  }

  // ═══════════════════════════════════════════════════
  // GLOBAL API (used by loader & console)
  // ═══════════════════════════════════════════════════
  window.TCGStarLimitEnforcer = {
    version: "5.0",
    enforceNow: async () => {
      const txt = collectLimitTextFromDOM();
      if (txt && txt.includes("Must have at most")) {
        return enforceFromPopupText(txt, { shouldNotify: true });
      }
      return enforceKnownCaps({ shouldNotify: true });
    },
    optimizeCart: optimizeCartPageQty,
    getLimits: () => loadLimits(),
    setLimit,
    getLimit,
    clearLimits: () => { saveLimits({}); log("Limits cleared"); },
    init: () => {
      log("Initializing v5...");
      hookCheckout();
      observeDOMForPopup();
      startPeriodicEnforce();
      enforceKnownCaps().catch(() => {});
      watchCartQtyInputs();
      addStatusIndicator();

      // On cart page: try to optimize qty after a short delay
      if (location.pathname.startsWith("/cart")) {
        setTimeout(() => optimizeCartPageQty().catch(() => {}), 1200);
      }

      log("Initialized ✅");
    },
  };
})();
