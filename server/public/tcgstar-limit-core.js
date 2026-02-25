// tcgstar-limit-core.js (v5.1) — active cart qty probing + enforcement
// Loaded via @require from Tampermonkey userscript.
(function () {
  const STORAGE_KEY = "tcgstar_limits_by_handle_v2";
  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("%c[STK]", "color:#e67e22;font-weight:bold", ...a);

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
    log(`💾 Learned: ${handle} → max ${max}`);
  }
  function getLimit(handle) {
    return loadLimits()[handle] ?? null;
  }

  // Migrate v1→v2
  try {
    const v1 = localStorage.getItem("tcgstar_limits_by_handle_v1");
    if (v1 && !localStorage.getItem(STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, v1);
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
    log(`  🔄 Line ${lineIndex1Based} → qty ${qty}`);
    const r = await fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ line: lineIndex1Based, quantity: qty }),
    });
    if (!r.ok) throw new Error("Failed to POST /cart/change.js");
    return r.json();
  }

  async function addToCart(variantId, qty) {
    const r = await fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ items: [{ id: Number(variantId), quantity: Number(qty) }] }),
    });
    return { status: r.status, data: await r.json().catch(() => null), text: await r.text().catch(() => "") };
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

  function parseMaxFromResponse(data) {
    const text = typeof data === "string" ? data : JSON.stringify(data || "");
    const m = text.match(/at\s+most\s+(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
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
  // UI: NOTIFICATION BANNER
  // ═══════════════════════════════════════════════════
  function showBanner(fixes, { title: bannerTitle = "🛒 Količina prilagojena", color = "#1a1a2e" } = {}) {
    const existing = document.getElementById("stk-enforcer-banner");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.id = "stk-enforcer-banner";
    banner.style.cssText = `
      position:fixed;top:12px;right:12px;z-index:999999;
      background:linear-gradient(135deg,${color},#16213e);color:#fff;
      padding:16px 20px;border-radius:14px;
      box-shadow:0 8px 32px rgba(0,0,0,.35);
      font-family:-apple-system,BlinkMacSystemFont,sans-serif;
      font-size:13px;max-width:400px;line-height:1.5;
      animation:stk-slide-in .3s ease-out;
    `;

    const titleEl = document.createElement("div");
    titleEl.style.cssText = "font-weight:700;font-size:14px;margin-bottom:8px;display:flex;align-items:center;gap:6px";
    titleEl.textContent = bannerTitle;

    const list = document.createElement("div");
    list.style.cssText = "font-size:12px;opacity:.9";
    list.innerHTML = fixes.map(f =>
      `<div style="margin:3px 0">• <strong>${f.title}</strong> → <strong>${f.to}x</strong></div>`
    ).join("");

    const closeBtn = document.createElement("div");
    closeBtn.style.cssText = "position:absolute;top:8px;right:12px;cursor:pointer;opacity:.6;font-size:16px";
    closeBtn.textContent = "✕";
    closeBtn.onclick = () => banner.remove();

    banner.append(titleEl, list, closeBtn);
    document.body.appendChild(banner);

    setTimeout(() => {
      if (banner.parentNode) {
        banner.style.transition = "opacity .3s, transform .3s";
        banner.style.opacity = "0";
        banner.style.transform = "translateX(20px)";
        setTimeout(() => banner.remove(), 300);
      }
    }, 6000);
  }

  try {
    const style = document.createElement("style");
    style.textContent = `@keyframes stk-slide-in{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:translateX(0)}}`;
    document.head.appendChild(style);
  } catch {}

  // ═══════════════════════════════════════════════════
  // UI: STATUS INDICATOR
  // ═══════════════════════════════════════════════════
  function updateStatusIndicator(text, color) {
    const el = document.getElementById("stk-enforcer-status");
    if (el) {
      el.querySelector(".stk-label").textContent = text;
      if (color) el.querySelector(".stk-dot").style.background = color;
    }
  }

  function addStatusIndicator() {
    if (document.getElementById("stk-enforcer-status")) return;
    const el = document.createElement("div");
    el.id = "stk-enforcer-status";
    el.style.cssText = `
      position:fixed;bottom:12px;right:12px;z-index:999998;
      background:#1a1a2e;color:#e2e8f0;
      padding:6px 12px;border-radius:20px;
      font-family:-apple-system,sans-serif;font-size:11px;font-weight:600;
      box-shadow:0 2px 12px rgba(0,0,0,.2);
      cursor:pointer;opacity:.7;transition:opacity .2s;
      display:flex;align-items:center;gap:6px;
    `;
    el.innerHTML = `<span class="stk-dot" style="width:8px;height:8px;border-radius:50%;background:#4ade80"></span><span class="stk-label">STK v5.1</span>`;
    el.title = "Stock Tracker Cart Enforcer — klikni za info";
    el.onmouseenter = () => el.style.opacity = "1";
    el.onmouseleave = () => el.style.opacity = ".7";
    el.onclick = async () => {
      const limits = loadLimits();
      const count = Object.keys(limits).length;
      const cart = await getCart().catch(() => null);
      const itemCount = cart?.items?.length || 0;
      const lines = count > 0
        ? Object.entries(limits).slice(0, 30).map(([h, m]) => `  ${h}: max ${m}`).join("\n")
        : "  Še ni naučenih omejitev";
      alert(`🛡️ STK Cart Enforcer v5.1\n\n📦 Naučenih omejitev: ${count}\n🛒 V košarici: ${itemCount}\n\nOmejitve:\n${lines}`);
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

    for (const p of parsed) {
      const idx = findBestCartLine(cart, p.title);
      if (idx >= 0) {
        const item = cart.items[idx];
        if (item?.handle) setLimit(item.handle, p.max);
      }
    }

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
    return { changed: true, fixes };
  }

  // ═══════════════════════════════════════════════════
  // ENFORCE KNOWN CAPS (reduce over-limit items)
  // ═══════════════════════════════════════════════════
  async function enforceKnownCaps({ shouldNotify = false } = {}) {
    const cart = await getCart();
    const limitsByHandle = loadLimits();
    const overrides = window.__TCGSTAR_LIMIT_OVERRIDES__ || {};
    const fixes = [];

    for (let i = 0; i < cart.items.length; i++) {
      const it = cart.items[i];
      const max = overrides[it.handle] ?? limitsByHandle[it.handle];
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
  // ACTIVE QTY PROBING — the key new feature in v5.1
  // For each cart item, actively tries to increase qty
  // by probing Shopify's cart validation.
  // Does NOT rely on previously learned limits.
  // ═══════════════════════════════════════════════════
  async function probeMaxQtyForItem(variantId, currentQty) {
    // Strategy: try setting a high qty via cart/change.js
    // If Shopify accepts it → that's the allowed qty
    // If Shopify rejects with "at most X" → X is the max
    // If Shopify silently caps → read cart to see actual qty

    const HIGH_PROBE = 50; // start high
    const probeQty = Math.max(HIGH_PROBE, currentQty);

    try {
      // First clear this item, then re-add with high qty to trigger limit message
      const addRes = await fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ items: [{ id: Number(variantId), quantity: probeQty }] }),
      });

      const addData = await addRes.json().catch(() => null);
      const addText = JSON.stringify(addData || "");

      // Check for "at most X" in response
      const maxFromError = parseMaxFromResponse(addText);
      if (maxFromError && maxFromError > 0) {
        log(`  🎯 Probe hit limit: variant ${variantId} → max ${maxFromError}`);
        return maxFromError;
      }

      // If add succeeded, check what Shopify actually put in cart
      if (addRes.status >= 200 && addRes.status < 300) {
        const cart = await getCart();
        const item = cart.items.find(it => String(it.variant_id) === String(variantId));
        if (item) {
          log(`  🎯 Probe accepted: variant ${variantId} → qty in cart: ${item.quantity}`);
          return item.quantity; // Shopify may have silently capped
        }
      }

      // If 422 but no parseable limit, try lower amounts
      if (addRes.status === 422) {
        // Binary search between current and probe
        let lo = currentQty, hi = probeQty;
        while (lo < hi - 1) {
          const mid = Math.floor((lo + hi) / 2);
          const testRes = await fetch("/cart/change.js", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ id: String(variantId), quantity: mid }),
          });
          const testData = await testRes.json().catch(() => null);
          const testMax = parseMaxFromResponse(JSON.stringify(testData || ""));
          if (testMax) return testMax;

          if (testRes.status >= 200 && testRes.status < 300) {
            lo = mid; // mid was accepted
          } else {
            hi = mid; // mid was rejected
          }
        }
        return lo;
      }
    } catch (e) {
      log(`  ⚠️ Probe failed for ${variantId}: ${e.message}`);
    }

    return null; // couldn't determine
  }

  // ═══════════════════════════════════════════════════
  // CART PAGE: ACTIVELY MAXIMIZE QTY FOR ALL ITEMS
  // This is the main function that runs on /cart page.
  // It probes each item to find the real max, then sets it.
  // ═══════════════════════════════════════════════════
  let isOptimizing = false;

  async function optimizeCartPageQty() {
    if (!location.pathname.startsWith("/cart")) return { bumped: 0 };
    if (isOptimizing) return { bumped: 0 };
    isOptimizing = true;

    log("🚀 Starting cart optimization...");
    updateStatusIndicator("Optimiziram...", "#f59e0b");

    try {
      const cart = await getCart();
      const limits = loadLimits();
      const overrides = window.__TCGSTAR_LIMIT_OVERRIDES__ || {};
      const changes = [];

      for (let i = 0; i < cart.items.length; i++) {
        const it = cart.items[i];
        const title = it.product_title || it.title;

        // Check if we already know the max
        let maxKnown = overrides[it.handle] ?? limits[it.handle];

        if (maxKnown && it.quantity >= maxKnown) {
          log(`  ✅ ${title}: already at max ${maxKnown}`);
          continue;
        }

        if (maxKnown && it.quantity < maxKnown) {
          // We know the max, just bump to it
          log(`  📈 ${title}: ${it.quantity} → ${maxKnown} (known limit)`);
          changes.push({ line: i + 1, variantId: it.variant_id, title, from: it.quantity, to: maxKnown });
          continue;
        }

        // Don't know the max — probe it!
        log(`  🔍 ${title}: probing max (current: ${it.quantity})...`);
        const probedMax = await probeMaxQtyForItem(it.variant_id, it.quantity);

        if (probedMax && probedMax > 0) {
          // Save learned limit
          if (it.handle) setLimit(it.handle, probedMax);

          if (probedMax > it.quantity) {
            changes.push({ line: i + 1, variantId: it.variant_id, title, from: it.quantity, to: probedMax });
          } else {
            log(`  ℹ️ ${title}: already at max ${probedMax}`);
          }
        } else {
          log(`  ⚠️ ${title}: couldn't determine max`);
        }

        // Small delay between probes to not hammer the server
        await new Promise(r => setTimeout(r, 500));
      }

      if (!changes.length) {
        log("✅ Cart already optimized");
        updateStatusIndicator("STK v5.1 ✅", "#4ade80");
        isOptimizing = false;
        return { bumped: 0 };
      }

      // Now set all quantities to their max
      // Re-fetch cart because probing may have changed it
      log(`📦 Setting final quantities for ${changes.length} items...`);
      const freshCart = await getCart();

      for (const c of changes) {
        // Find current line for this variant (may have shifted)
        const lineIdx = freshCart.items.findIndex(it => String(it.variant_id) === String(c.variantId));
        if (lineIdx >= 0) {
          try {
            await changeLine(lineIdx + 1, c.to);
            log(`  ✅ ${c.title}: ${c.from} → ${c.to}`);
          } catch (e) {
            log(`  ❌ ${c.title}: ${e.message}`);
          }
        }
      }

      showBanner(changes.map(c => ({ title: c.title, to: c.to })),
        { title: "📈 Količine povečane na max", color: "#065f46" });

      updateStatusIndicator(`STK ✅ ${changes.length} povečanih`, "#4ade80");

      // Reload to reflect changes in UI
      setTimeout(() => location.reload(), 1200);
      return { bumped: changes.length };
    } catch (e) {
      log(`❌ Optimization failed: ${e.message}`);
      updateStatusIndicator("STK ⚠️", "#ef4444");
    } finally {
      isOptimizing = false;
    }
    return { bumped: 0 };
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
          setTimeout(() => (window.location.href = "/checkout"), 300);
        }
        return true;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
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
        log("🛒 Checkout click detected");
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
    setInterval(() => { enforceKnownCaps().catch(() => {}); }, 5000);
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
  // GLOBAL API
  // ═══════════════════════════════════════════════════
  window.TCGStarLimitEnforcer = {
    version: "5.1",
    enforceNow: async () => {
      const txt = collectLimitTextFromDOM();
      if (txt && txt.includes("Must have at most")) {
        return enforceFromPopupText(txt, { shouldNotify: true });
      }
      return enforceKnownCaps({ shouldNotify: true });
    },
    optimizeCart: optimizeCartPageQty,
    probeItem: probeMaxQtyForItem,
    getLimits: () => loadLimits(),
    setLimit,
    getLimit,
    clearLimits: () => { saveLimits({}); log("Limits cleared"); },
    init: () => {
      log("🚀 Initializing v5.1...");
      hookCheckout();
      observeDOMForPopup();
      startPeriodicEnforce();
      enforceKnownCaps().catch(() => {});
      watchCartQtyInputs();
      addStatusIndicator();

      // On cart page: actively optimize ALL quantities
      if (location.pathname.startsWith("/cart")) {
        log("📋 Cart page detected — will optimize quantities in 1.5s...");
        setTimeout(() => optimizeCartPageQty().catch(e => log("❌", e.message)), 1500);
      }

      log("✅ Initialized");
    },
  };
})();
