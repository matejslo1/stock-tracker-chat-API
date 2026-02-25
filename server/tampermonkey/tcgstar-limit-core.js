// tcgstar-limit-core.js (v5.2) — active probing via cart/change.js ONLY
// Never uses cart/add.js to avoid duplicate line items.
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
  // SHOPIFY CART API (change.js ONLY — never add.js)
  // ═══════════════════════════════════════════════════
  async function getCart() {
    const r = await fetch("/cart.js", { credentials: "same-origin" });
    if (!r.ok) throw new Error("cart.js failed");
    return r.json();
  }

  /**
   * Change qty for a line item. Returns the full updated cart.
   * Uses line index (1-based).
   */
  async function changeLineGetCart(lineIndex1Based, qty) {
    const r = await fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ line: lineIndex1Based, quantity: qty }),
    });
    // change.js returns the full cart object on success
    // On 422 it may return error text
    const data = await r.json().catch(() => null);
    return { status: r.status, data, ok: r.status >= 200 && r.status < 300 };
  }

  function parseMaxFromText(text) {
    const m = String(text || "").match(/at\s+most\s+(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // ═══════════════════════════════════════════════════
  // TEXT MATCHING (for popup parsing)
  // ═══════════════════════════════════════════════════
  function norm(s) {
    return String(s || "").toLowerCase()
      .replace(/&amp;/g, "&").replace(/['']/g, "'").replace(/[–—]/g, "-")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function scoreMatch(a, b) {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb) return 100;
    if (nb.includes(na)) return 80;
    if (na.includes(nb)) return 70;
    const at = new Set(na.split(" ")), bt = new Set(nb.split(" "));
    let c = 0; for (const t of at) if (bt.has(t)) c++;
    return Math.round((c / Math.max(at.size, bt.size, 1)) * 60);
  }

  function findBestCartLine(cart, title) {
    let best = { idx: -1, score: 0 };
    for (let i = 0; i < cart.items.length; i++) {
      const it = cart.items[i];
      for (const c of [it.product_title, it.title, `${it.product_title || ""} ${it.variant_title || ""}`.trim()]) {
        const s = scoreMatch(title, c);
        if (s > best.score) best = { idx: i, score: s };
      }
    }
    return best.score >= 35 ? best.idx : -1;
  }

  function parseAllLimitsFromText(text) {
    const results = [];
    const re = /([^:\n]+):\s*Must have at most\s+(\d+)\s+of this item\.?/gi;
    let m;
    while ((m = re.exec(text || ""))) results.push({ title: m[1].trim(), max: parseInt(m[2], 10) });
    return results;
  }

  function collectLimitTextFromDOM() {
    const needle = "Must have at most";
    const parts = [];
    for (const el of document.querySelectorAll("*")) {
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style") continue;
      if (el.innerText?.includes(needle)) parts.push(el.innerText);
    }
    return [...new Set(parts)].join("\n");
  }

  // ═══════════════════════════════════════════════════
  // UI
  // ═══════════════════════════════════════════════════
  function showBanner(lines, title = "🛒 Količina prilagojena", color = "#1a1a2e") {
    const old = document.getElementById("stk-banner"); if (old) old.remove();
    const d = document.createElement("div"); d.id = "stk-banner";
    d.style.cssText = `position:fixed;top:12px;right:12px;z-index:999999;background:linear-gradient(135deg,${color},#16213e);color:#fff;padding:16px 20px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.35);font:13px/1.5 -apple-system,sans-serif;max-width:400px;animation:stk-in .3s ease-out`;
    d.innerHTML = `<div style="font-weight:700;font-size:14px;margin-bottom:8px">${title}</div><div style="font-size:12px;opacity:.9">${lines.map(l => `<div>• <b>${l.title}</b> → <b>${l.to}x</b></div>`).join("")}</div><div onclick="this.parentNode.remove()" style="position:absolute;top:8px;right:12px;cursor:pointer;opacity:.6;font-size:16px">✕</div>`;
    document.body.appendChild(d);
    setTimeout(() => { if (d.parentNode) { d.style.transition = "opacity .3s"; d.style.opacity = "0"; setTimeout(() => d.remove(), 300); } }, 6000);
  }

  try { const s = document.createElement("style"); s.textContent = `@keyframes stk-in{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:translateX(0)}}`; document.head.appendChild(s); } catch {}

  function setStatus(text, color) {
    const el = document.getElementById("stk-status");
    if (!el) return;
    el.querySelector(".stk-lbl").textContent = text;
    if (color) el.querySelector(".stk-dot").style.background = color;
  }

  function addStatusBadge() {
    if (document.getElementById("stk-status")) return;
    const el = document.createElement("div"); el.id = "stk-status";
    el.style.cssText = `position:fixed;bottom:12px;right:12px;z-index:999998;background:#1a1a2e;color:#e2e8f0;padding:6px 12px;border-radius:20px;font:11px/1 -apple-system,sans-serif;font-weight:600;box-shadow:0 2px 12px rgba(0,0,0,.2);cursor:pointer;opacity:.7;transition:opacity .2s;display:flex;align-items:center;gap:6px`;
    el.innerHTML = `<span class="stk-dot" style="width:8px;height:8px;border-radius:50%;background:#4ade80"></span><span class="stk-lbl">STK v5.2</span>`;
    el.onmouseenter = () => el.style.opacity = "1";
    el.onmouseleave = () => el.style.opacity = ".7";
    el.onclick = async () => {
      const lim = loadLimits(), n = Object.keys(lim).length;
      const cart = await getCart().catch(() => null);
      alert(`🛡️ STK v5.2\n\n📦 Naučenih: ${n}\n🛒 V košarici: ${cart?.items?.length || 0}\n\n` +
        (n > 0 ? Object.entries(lim).slice(0, 25).map(([h, m]) => `${h}: max ${m}`).join("\n") : "Ni omejitev"));
    };
    document.body.appendChild(el);
  }

  // ═══════════════════════════════════════════════════
  // ENFORCE FROM POPUP TEXT (for checkout errors)
  // ═══════════════════════════════════════════════════
  async function enforceFromPopupText(popupText) {
    const cart = await getCart();
    const parsed = parseAllLimitsFromText(popupText);
    if (!parsed.length) return { changed: false, fixes: [] };

    // Learn & fix
    const fixes = [];
    for (const p of parsed) {
      const idx = findBestCartLine(cart, p.title);
      if (idx >= 0) {
        const it = cart.items[idx];
        if (it?.handle) setLimit(it.handle, p.max);
        if (it.quantity > p.max) fixes.push({ line: idx + 1, title: it.product_title || it.title, to: p.max });
      }
    }
    if (!fixes.length) return { changed: false, fixes: [] };
    for (const f of fixes) await changeLineGetCart(f.line, f.to);
    showBanner(fixes);
    return { changed: true, fixes };
  }

  // ═══════════════════════════════════════════════════
  // ENFORCE KNOWN CAPS
  // ═══════════════════════════════════════════════════
  async function enforceKnownCaps() {
    const cart = await getCart();
    const limits = loadLimits();
    const ov = window.__TCGSTAR_LIMIT_OVERRIDES__ || {};
    const fixes = [];
    for (let i = 0; i < cart.items.length; i++) {
      const it = cart.items[i];
      const max = ov[it.handle] ?? limits[it.handle];
      if (max != null && it.quantity > max) fixes.push({ line: i + 1, title: it.product_title || it.title, to: max });
    }
    if (!fixes.length) return;
    for (const f of fixes) await changeLineGetCart(f.line, f.to);
    showBanner(fixes);
  }

  // ═══════════════════════════════════════════════════
  // PROBE MAX QTY — uses ONLY cart/change.js
  //
  // How it works:
  // 1. Set qty to high number (e.g. 50) via change.js
  // 2. If Shopify returns error with "at most X" → max = X
  // 3. If Shopify accepts but silently caps → read actual qty from response
  // 4. That actual qty IS the max
  //
  // change.js NEVER creates duplicate items — it only modifies existing lines.
  // ═══════════════════════════════════════════════════
  async function probeMaxForLine(lineIndex1Based, variantId, currentQty) {
    const PROBE_QTY = 99;

    try {
      // Step 1: Try setting qty very high
      log(`    🔍 Probing line ${lineIndex1Based} (variant ${variantId}): trying qty=${PROBE_QTY}...`);
      const res = await changeLineGetCart(lineIndex1Based, PROBE_QTY);

      // Step 2: Check for "at most X" error
      const errMax = parseMaxFromText(JSON.stringify(res.data || ""));
      if (errMax && errMax > 0) {
        log(`    🎯 Error says max = ${errMax}`);
        // Set to the actual max
        await changeLineGetCart(lineIndex1Based, errMax);
        return errMax;
      }

      // Step 3: Shopify accepted or silently capped. Read actual qty from returned cart.
      if (res.ok && res.data && res.data.items) {
        const item = res.data.items.find(it => String(it.variant_id) === String(variantId));
        if (item) {
          const actualQty = item.quantity;
          log(`    🎯 Shopify set qty to ${actualQty} (requested ${PROBE_QTY})`);
          // If Shopify gave us less than we asked, that's the cap
          // If it gave us exactly PROBE_QTY, the real limit is probably higher (or no limit)
          return actualQty;
        }
      }

      // Step 4: 422 but no parseable max — try a moderate amount
      if (res.status === 422) {
        log(`    ⚠️ 422 without parseable max, trying lower...`);
        // Try 10, 5, 3
        for (const tryQty of [10, 5, 3, 2]) {
          const r2 = await changeLineGetCart(lineIndex1Based, tryQty);
          const m2 = parseMaxFromText(JSON.stringify(r2.data || ""));
          if (m2) {
            await changeLineGetCart(lineIndex1Based, m2);
            return m2;
          }
          if (r2.ok && r2.data?.items) {
            const it = r2.data.items.find(x => String(x.variant_id) === String(variantId));
            if (it) return it.quantity;
          }
        }
      }
    } catch (e) {
      log(`    ❌ Probe failed: ${e.message}`);
    }

    return null;
  }

  // ═══════════════════════════════════════════════════
  // CART PAGE: MAXIMIZE ALL QUANTITIES
  // ═══════════════════════════════════════════════════
  let isOptimizing = false;

  async function optimizeCartPageQty() {
    if (!location.pathname.startsWith("/cart")) return { bumped: 0 };
    if (isOptimizing) return { bumped: 0 };
    isOptimizing = true;

    log("🚀 Starting cart optimization...");
    setStatus("Optimiziram...", "#f59e0b");

    try {
      let cart = await getCart();
      if (!cart.items || cart.items.length === 0) {
        log("⚠️ Cart is empty");
        setStatus("Košarica prazna", "#ef4444");
        isOptimizing = false;
        return { bumped: 0 };
      }

      const limits = loadLimits();
      const ov = window.__TCGSTAR_LIMIT_OVERRIDES__ || {};
      const results = [];

      for (let i = 0; i < cart.items.length; i++) {
        const it = cart.items[i];
        const title = it.product_title || it.title;
        const knownMax = ov[it.handle] ?? limits[it.handle];

        // Case 1: Already at known max
        if (knownMax && it.quantity >= knownMax) {
          log(`  ✅ ${title}: qty ${it.quantity} = max ${knownMax}`);
          results.push({ title, from: it.quantity, to: knownMax, action: "ok" });
          continue;
        }

        // Case 2: Known max, bump to it
        if (knownMax && it.quantity < knownMax) {
          log(`  📈 ${title}: ${it.quantity} → ${knownMax} (known)`);
          const r = await changeLineGetCart(i + 1, knownMax);
          // Verify
          if (r.ok && r.data?.items) {
            const actual = r.data.items.find(x => String(x.variant_id) === String(it.variant_id));
            const finalQty = actual?.quantity || knownMax;
            results.push({ title, from: it.quantity, to: finalQty, action: "bumped" });
            // Update cart reference for next iterations (line indices may shift if items merge)
            cart = r.data;
          }
          continue;
        }

        // Case 3: Unknown max — probe it
        log(`  🔍 ${title}: probing (current qty: ${it.quantity})...`);
        const maxFound = await probeMaxForLine(i + 1, it.variant_id, it.quantity);

        if (maxFound && maxFound > 0) {
          if (it.handle) setLimit(it.handle, maxFound);
          results.push({ title, from: it.quantity, to: maxFound, action: maxFound > it.quantity ? "bumped" : "ok" });
          log(`  ✅ ${title}: max = ${maxFound}`);
        } else {
          log(`  ⚠️ ${title}: could not determine max, leaving at ${it.quantity}`);
          results.push({ title, from: it.quantity, to: it.quantity, action: "unknown" });
        }

        // Re-read cart after each probe (line indices may shift)
        cart = await getCart();

        // Small delay
        await new Promise(r => setTimeout(r, 300));
      }

      const bumped = results.filter(r => r.action === "bumped");
      if (bumped.length > 0) {
        showBanner(bumped, "📈 Količine povečane na max", "#065f46");
        log(`✅ Done: ${bumped.length} items bumped`);
      } else {
        log("✅ All items already at max");
      }

      setStatus(`STK ✅ ${bumped.length ? bumped.length + " ↑" : "max"}`, "#4ade80");

      // Reload to show updated quantities in store UI
      if (bumped.length > 0) {
        setTimeout(() => location.reload(), 1500);
      }

      isOptimizing = false;
      return { bumped: bumped.length };
    } catch (e) {
      log(`❌ Optimization failed: ${e.message}`);
      setStatus("STK ❌", "#ef4444");
      isOptimizing = false;
      return { bumped: 0 };
    }
  }

  // ═══════════════════════════════════════════════════
  // POPUP WATCHER (for checkout)
  // ═══════════════════════════════════════════════════
  let checkoutRetries = 0;

  async function waitForPopupAndFix(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const txt = collectLimitTextFromDOM();
      if (txt && txt.includes("Must have at most")) {
        const res = await enforceFromPopupText(txt);
        if (res.changed && checkoutRetries < 3) {
          checkoutRetries++;
          setTimeout(() => (window.location.href = "/checkout"), 300);
        }
        return true;
      }
      await new Promise(r => setTimeout(r, 120));
    }
    return false;
  }

  // ═══════════════════════════════════════════════════
  // HOOKS
  // ═══════════════════════════════════════════════════
  function hookCheckout() {
    document.addEventListener("click", (e) => {
      const el = e.target.closest("a,button,input");
      if (!el) return;
      const h = (el.getAttribute("href") || "").toLowerCase();
      const t = (el.textContent || "").toLowerCase();
      if (h.includes("/checkout") || t.includes("checkout") || t.includes("zaključi") || t.includes("plačaj")) {
        checkoutRetries = 0;
        log("🛒 Checkout click");
        setTimeout(() => waitForPopupAndFix().catch(() => {}), 50);
      }
    }, true);
  }

  function observeDOMForPopup() {
    let t = null;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        const txt = collectLimitTextFromDOM();
        if (txt?.includes("Must have at most")) {
          enforceFromPopupText(txt).then(res => {
            if (res.changed && checkoutRetries < 3) { checkoutRetries++; setTimeout(() => (window.location.href = "/checkout"), 300); }
          }).catch(() => {});
        }
      }, 120);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  // ═══════════════════════════════════════════════════
  // GLOBAL API
  // ═══════════════════════════════════════════════════
  window.TCGStarLimitEnforcer = {
    version: "5.2",
    enforceNow: async () => {
      const txt = collectLimitTextFromDOM();
      if (txt?.includes("Must have at most")) return enforceFromPopupText(txt);
      return enforceKnownCaps();
    },
    optimizeCart: optimizeCartPageQty,
    getLimits: () => loadLimits(),
    setLimit,
    getLimit,
    clearLimits: () => { saveLimits({}); log("Limits cleared"); },
    init: () => {
      log("🚀 Initializing v5.2...");
      hookCheckout();
      observeDOMForPopup();
      setInterval(() => enforceKnownCaps().catch(() => {}), 5000);
      enforceKnownCaps().catch(() => {});
      addStatusBadge();

      // Cart page: auto-optimize quantities
      if (location.pathname.startsWith("/cart")) {
        log("📋 Cart page detected — optimizing in 2s...");
        setTimeout(() => optimizeCartPageQty().catch(e => log("❌", e)), 2000);
      }

      log("✅ Ready");
    },
  };
})();
