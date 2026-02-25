// ==UserScript==
// @name         Stock Tracker – Shopify Cart Limit Enforcer
// @namespace    https://github.com/stock-tracker
// @version      5.0
// @description  Avtomatsko prilagodi količine v Shopify košarici glede na omejitve trgovine. Deluje s Stock Tracker app-om v Tampermonkey modu.
// @author       Stock Tracker
// @match        https://*.myshopify.com/*
// @match        https://tcgstar.eu/*
// @match        https://www.tcgstar.eu/*
// @match        https://tcgstar.si/*
// @match        https://www.tcgstar.si/*
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-idle
// @updateURL    STOCK_TRACKER_URL/tm/stock-tracker-cart-enforcer.user.js
// @downloadURL  STOCK_TRACKER_URL/tm/stock-tracker-cart-enforcer.user.js
// ==/UserScript==

/**
 * Stock Tracker – Shopify Cart Limit Enforcer v5
 *
 * KAKO DELUJE:
 * 1. Ko odpreš košarico ali checkout na Shopify trgovini, skripta preveri
 *    ali obstajajo omejitve količine (error popup: "Must have at most X of this item")
 * 2. Če so omejitve presežene, skripta avtomatsko zmanjša količino na dovoljeno mejo
 * 3. Omejitve se naučijo in shranijo lokalno za hitrejše prilagoditve v prihodnosti
 * 4. Na cart strani skripta aktivno prilagodi qty inpute na maximum dovoljeno vrednost
 *
 * NAMESTITEV:
 * 1. Dodaj @match pravila za trgovine, ki jih želiš podpreti
 * 2. Zamenjaj STOCK_TRACKER_URL z dejanskim URL-jem tvojega Stock Tracker-ja
 *    (za auto-update — ni obvezno)
 *
 * NASTAVITVE (v Stock Tracker app-u):
 * - V nastavitvah izberi "🐒 Tampermonkey" način za košarico
 * - Košarica se bo zgradila z 1x na izdelek, skripta pa prilagodi količino
 */

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════════════════
  const CONFIG = {
    DEBUG: false,
    STORAGE_KEY: "stk_limits_v2",
    PERIODIC_CHECK_MS: 3000,
    POPUP_POLL_MS: 120,
    POPUP_TIMEOUT_MS: 10000,
    CART_PAGE_POLL_MS: 1500,
    MAX_RETRY_CHECKOUT: 3,
    NOTIFICATION_TIMEOUT: 5000,
  };

  const log = (...a) => CONFIG.DEBUG && console.log("%c[STK-Enforcer]", "color:#e67e22;font-weight:bold", ...a);

  // ═══════════════════════════════════════════════════
  // LIMIT STORAGE (localStorage backed)
  // ═══════════════════════════════════════════════════
  function loadLimits() {
    try { return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || "{}"); }
    catch { return {}; }
  }
  function saveLimits(limits) {
    try { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(limits)); } catch {}
  }
  function setLimit(handle, max) {
    const limits = loadLimits();
    limits[handle] = max;
    saveLimits(limits);
    log(`Learned limit: ${handle} → max ${max}`);
  }
  function getLimit(handle) {
    return loadLimits()[handle] ?? null;
  }

  // ═══════════════════════════════════════════════════
  // SHOPIFY CART API
  // ═══════════════════════════════════════════════════
  async function getCart() {
    const r = await fetch("/cart.js", { credentials: "same-origin" });
    if (!r.ok) throw new Error("Failed to fetch /cart.js");
    return r.json();
  }

  async function changeLineQty(lineIndex1Based, qty) {
    log(`Changing line ${lineIndex1Based} → qty ${qty}`);
    const r = await fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ line: lineIndex1Based, quantity: qty }),
    });
    if (!r.ok) throw new Error("Failed to POST /cart/change.js");
    return r.json();
  }

  async function updateCartItem(variantId, qty) {
    log(`Updating variant ${variantId} → qty ${qty}`);
    const r = await fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ id: String(variantId), quantity: qty }),
    });
    if (!r.ok) throw new Error("Failed to update variant");
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

  function scoreMatch(a, b) {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb) return 100;
    if (nb.includes(na)) return 80;
    if (na.includes(nb)) return 70;
    const at = new Set(na.split(" "));
    const bt = new Set(nb.split(" "));
    let common = 0;
    for (const t of at) if (bt.has(t)) common++;
    return Math.round((common / Math.max(at.size, bt.size, 1)) * 60);
  }

  function findBestCartLine(cart, title) {
    let best = { idx: -1, score: 0 };
    for (let i = 0; i < cart.items.length; i++) {
      const it = cart.items[i];
      const candidates = [
        it.product_title,
        it.title,
        `${it.product_title || ""} ${it.variant_title || ""}`.trim(),
      ];
      let s = 0;
      for (const c of candidates) s = Math.max(s, scoreMatch(title, c));
      if (s > best.score) best = { idx: i, score: s };
    }
    return best.score >= 35 ? best.idx : -1;
  }

  // ═══════════════════════════════════════════════════
  // PARSE LIMIT ERRORS FROM DOM
  // ═══════════════════════════════════════════════════
  function parseAllLimitsFromText(text) {
    const results = [];
    // Pattern: "Product Name: Must have at most X of this item."
    const re = /([^:\n]+):\s*Must have at most\s+(\d+)\s+of this item\.?/gi;
    let m;
    while ((m = re.exec(text || ""))) {
      results.push({ title: (m[1] || "").trim(), max: parseInt(m[2], 10) });
    }
    return results;
  }

  function collectLimitTextFromDOM() {
    const needle = "Must have at most";
    const parts = [];
    for (const el of document.querySelectorAll("*")) {
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style") continue;
      const t = el.innerText;
      if (t && t.includes(needle)) parts.push(t);
    }
    return [...new Set(parts)].join("\n");
  }

  // ═══════════════════════════════════════════════════
  // UI NOTIFICATION BANNER
  // ═══════════════════════════════════════════════════
  function showBanner(fixes) {
    // Remove existing banner
    const existing = document.getElementById("stk-enforcer-banner");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.id = "stk-enforcer-banner";
    banner.style.cssText = `
      position:fixed; top:12px; right:12px; z-index:999999;
      background:linear-gradient(135deg,#1a1a2e,#16213e); color:#fff;
      padding:16px 20px; border-radius:14px;
      box-shadow:0 8px 32px rgba(0,0,0,.35);
      font-family:-apple-system,BlinkMacSystemFont,sans-serif;
      font-size:13px; max-width:380px; line-height:1.5;
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

    // Auto-hide
    setTimeout(() => {
      if (banner.parentNode) {
        banner.style.transition = "opacity .3s, transform .3s";
        banner.style.opacity = "0";
        banner.style.transform = "translateX(20px)";
        setTimeout(() => banner.remove(), 300);
      }
    }, CONFIG.NOTIFICATION_TIMEOUT);
  }

  // Add animation keyframes
  try {
    const style = document.createElement("style");
    style.textContent = `@keyframes stk-slide-in{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:translateX(0)}}`;
    document.head.appendChild(style);
  } catch {}

  // ═══════════════════════════════════════════════════
  // CORE: ENFORCE FROM POPUP TEXT
  // ═══════════════════════════════════════════════════
  async function enforceFromPopupText(popupText) {
    const cart = await getCart();
    const parsed = parseAllLimitsFromText(popupText);
    if (!parsed.length) return { changed: false, fixes: [] };

    // Learn limits by handle
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
          fixes.push({ line: idx + 1, title: item.product_title || item.title, to: p.max, handle: item.handle });
        }
      }
    }

    if (!fixes.length) return { changed: false, fixes: [] };

    for (const f of fixes) await changeLineQty(f.line, f.to);

    showBanner(fixes);
    log(`Fixed ${fixes.length} items`);
    return { changed: true, fixes };
  }

  // ═══════════════════════════════════════════════════
  // CORE: ENFORCE KNOWN LIMITS
  // ═══════════════════════════════════════════════════
  async function enforceKnownCaps() {
    const cart = await getCart();
    const limits = loadLimits();
    const fixes = [];

    for (let i = 0; i < cart.items.length; i++) {
      const it = cart.items[i];
      const max = limits[it.handle];
      if (max != null && it.quantity > max) {
        fixes.push({ line: i + 1, title: it.product_title || it.title, to: max, handle: it.handle });
      }
    }

    if (!fixes.length) return { changed: false, fixes: [] };
    for (const f of fixes) await changeLineQty(f.line, f.to);

    showBanner(fixes);
    return { changed: true, fixes };
  }

  // ═══════════════════════════════════════════════════
  // CART PAGE: ACTIVELY INCREASE QTY TO MAX
  // ═══════════════════════════════════════════════════
  async function optimizeCartPageQty() {
    // Only run on cart page
    if (!location.pathname.startsWith("/cart")) return;

    const cart = await getCart();
    const limits = loadLimits();
    const changes = [];

    for (let i = 0; i < cart.items.length; i++) {
      const it = cart.items[i];
      const maxKnown = limits[it.handle];

      // If we know the max and current qty is less, try to bump it up
      if (maxKnown && it.quantity < maxKnown) {
        changes.push({
          line: i + 1,
          variantId: it.variant_id,
          title: it.product_title || it.title,
          from: it.quantity,
          to: maxKnown,
          handle: it.handle,
        });
      }
    }

    if (!changes.length) return;

    log(`Optimizing cart: bumping ${changes.length} items to known max`);
    for (const c of changes) {
      try {
        await changeLineQty(c.line, c.to);
        log(`  ✅ ${c.title}: ${c.from} → ${c.to}`);
      } catch (e) {
        log(`  ❌ ${c.title}: failed (${e.message})`);
      }
    }

    // Reload cart page to reflect changes
    if (changes.length > 0) {
      showBanner(changes.map(c => ({ title: c.title, to: c.to })));
      setTimeout(() => location.reload(), 800);
    }
  }

  // ═══════════════════════════════════════════════════
  // POPUP WATCHER
  // ═══════════════════════════════════════════════════
  async function waitForPopupAndFix(timeoutMs = CONFIG.POPUP_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const txt = collectLimitTextFromDOM();
      if (txt && txt.includes("Must have at most")) {
        const res = await enforceFromPopupText(txt);
        if (res.changed) {
          // Retry checkout after fix
          setTimeout(() => { window.location.href = "/checkout"; }, 300);
        }
        return true;
      }
      await new Promise((r) => setTimeout(r, CONFIG.POPUP_POLL_MS));
    }
    return false;
  }

  // ═══════════════════════════════════════════════════
  // HOOKS & OBSERVERS
  // ═══════════════════════════════════════════════════
  function hookCheckoutClicks() {
    document.addEventListener("click", (e) => {
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

      log("Checkout click detected, watching for popups...");
      setTimeout(() => waitForPopupAndFix().catch(() => {}), 50);
    }, true);
  }

  function observeDOMForPopup() {
    let t = null;
    const obs = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        const txt = collectLimitTextFromDOM();
        if (txt && txt.includes("Must have at most")) {
          enforceFromPopupText(txt)
            .then((res) => {
              if (res.changed) setTimeout(() => { window.location.href = "/checkout"; }, 300);
            })
            .catch(() => {});
        }
      }, CONFIG.POPUP_POLL_MS);
    });

    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function startPeriodicEnforce() {
    setInterval(() => { enforceKnownCaps().catch(() => {}); }, CONFIG.PERIODIC_CHECK_MS);
  }

  // ═══════════════════════════════════════════════════
  // CART PAGE: QTY INPUT WATCHER
  // ═══════════════════════════════════════════════════
  function watchCartQtyInputs() {
    if (!location.pathname.startsWith("/cart")) return;

    // Observe qty inputs and clamp them when user types a value
    const observer = new MutationObserver(() => {
      const inputs = document.querySelectorAll('input[name="updates[]"], input[data-quantity-input], input.cart__quantity-selector, input.quantity__input');
      inputs.forEach((input) => {
        if (input.dataset.stkWatched) return;
        input.dataset.stkWatched = "1";

        input.addEventListener("change", async () => {
          const cart = await getCart();
          const row = input.closest("tr, .cart-item, .cart__item, [data-cart-item]");
          if (!row) return;

          // Try to identify which cart item this input belongs to
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
            const max = getLimit(handle);
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
    // Trigger initial scan
    observer.takeRecords();
  }

  // ═══════════════════════════════════════════════════
  // STATUS INDICATOR
  // ═══════════════════════════════════════════════════
  function addStatusIndicator() {
    const indicator = document.createElement("div");
    indicator.id = "stk-enforcer-status";
    indicator.style.cssText = `
      position:fixed; bottom:12px; right:12px; z-index:999998;
      background:#1a1a2e; color:#4ade80;
      padding:6px 12px; border-radius:20px;
      font-family:-apple-system,sans-serif; font-size:11px; font-weight:600;
      box-shadow:0 2px 12px rgba(0,0,0,.2);
      cursor:pointer; opacity:.7; transition:opacity .2s;
      display:flex; align-items:center; gap:5px;
    `;
    indicator.innerHTML = `<span style="font-size:14px">🛡️</span> STK Enforcer`;
    indicator.title = "Stock Tracker Cart Limit Enforcer aktiven";

    indicator.onmouseenter = () => indicator.style.opacity = "1";
    indicator.onmouseleave = () => indicator.style.opacity = ".7";
    indicator.onclick = async () => {
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
          ? Object.entries(limits).map(([h, m]) => `  • ${h}: max ${m}`).join("\n")
          : "  Še ni naučenih omejitev")
      );
    };

    document.body.appendChild(indicator);
  }

  // ═══════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════
  function init() {
    log("Initializing Stock Tracker Cart Enforcer v5...");

    // 1. Hook checkout button clicks
    hookCheckoutClicks();

    // 2. Observe DOM for limit popups
    observeDOMForPopup();

    // 3. Periodic known-limit enforcement
    startPeriodicEnforce();

    // 4. Immediately enforce known caps
    enforceKnownCaps().catch(() => {});

    // 5. On cart page: optimize quantities to known max
    if (location.pathname.startsWith("/cart")) {
      setTimeout(() => optimizeCartPageQty().catch(() => {}), 1000);
    }

    // 6. Watch qty inputs on cart page
    watchCartQtyInputs();

    // 7. Status indicator
    addStatusIndicator();

    log("Initialized ✅");
  }

  // Expose for manual use in console
  window.STKEnforcer = {
    init,
    enforceNow: async () => {
      const txt = collectLimitTextFromDOM();
      if (txt && txt.includes("Must have at most")) return enforceFromPopupText(txt);
      return enforceKnownCaps();
    },
    optimizeCart: optimizeCartPageQty,
    getLimits: loadLimits,
    clearLimits: () => { saveLimits({}); log("Limits cleared"); },
    setLimit,
    getLimit,
    version: "5.0",
  };

  // Auto-start
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
