// tcgstar-limit-core.js (v4) — better title matching + fixes even if handle not found
(function () {
  const STORAGE_KEY = "tcgstar_limits_by_handle_v1";
  const DEBUG = false;
  const log = (...a) => DEBUG && console.log("[tcgstar-limit]", ...a);

  function loadLimits() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
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

  // ---- parsing ----
  function parseAllLimitsFromText(bigText) {
    const results = [];
    const re = /([^:\n]+):\s*Must have at most\s+(\d+)\s+of this item\.?/gi;
    let m;
    while ((m = re.exec(bigText || ""))) {
      results.push({ title: (m[1] || "").trim(), max: parseInt(m[2], 10) });
    }
    return results;
  }

  // ---- better matching ----
  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/&amp;/g, "&")
      .replace(/[’']/g, "'")
      .replace(/[–—]/g, "-")
      .replace(/[\u0300-\u036f]/g, "") // diacritics (works if already decomposed)
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

    // simple token overlap score
    const at = new Set(a.split(" "));
    const bt = new Set(b.split(" "));
    let common = 0;
    for (const t of at) if (bt.has(t)) common++;
    const denom = Math.max(at.size, bt.size) || 1;
    return Math.round((common / denom) * 60); // up to 60
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
    // require some confidence
    return best.score >= 35 ? best.idx : -1;
  }

  // ---- DOM collection ----
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

  // ---- main enforcement ----
  async function enforceFromPopupText(popupText, { shouldNotify = false } = {}) {
    const cart = await getCart();
    const parsed = parseAllLimitsFromText(popupText);

    if (!parsed.length) return { changed: false, fixes: [] };

    // 1) Try to learn handle limits (for future)
    let limitsByHandle = loadLimits();
    for (const p of parsed) {
      const idx = findBestCartLine(cart, p.title);
      if (idx >= 0) {
        const item = cart.items[idx];
        if (item?.handle) limitsByHandle[item.handle] = p.max;
      }
    }
    saveLimits(limitsByHandle);

    // 2) Apply fixes RIGHT NOW, even if handle learning fails
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

    if (shouldNotify) {
      const lines = fixes.map((f) => `• ${f.title}: max ${f.to}`).join("\n");
      alert(`Omejitev količine v košarici:\n${lines}\n\nPresežek sem odstranil iz košarice.`);
    }

    return { changed: true, fixes };
  }

  async function enforceKnownCaps({ shouldNotify = false } = {}) {
    const cart = await getCart();
    const limitsByHandle = loadLimits();
    const fixes = [];

    for (let i = 0; i < cart.items.length; i++) {
      const it = cart.items[i];
      const max = limitsByHandle[it.handle];
      if (max != null && it.quantity > max) {
        fixes.push({ line: i + 1, title: it.product_title || it.title, to: max });
      }
    }

    if (!fixes.length) return { changed: false, fixes: [] };
    for (const f of fixes) await changeLine(f.line, f.to);

    if (shouldNotify) {
      const lines = fixes.map((f) => `• ${f.title}: max ${f.to}`).join("\n");
      alert(`Omejitev količine v košarici:\n${lines}\n\nPresežek sem odstranil iz košarice.`);
    }

    return { changed: true, fixes };
  }

  async function waitForPopupAndFix(timeoutMs = 9000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const txt = collectLimitTextFromDOM();
      if (txt && txt.includes("Must have at most")) {
        const res = await enforceFromPopupText(txt, { shouldNotify: true });
        if (res.changed) setTimeout(() => (window.location.href = "/checkout"), 200);
        return true;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  function hookCheckout() {
    document.addEventListener(
      "click",
      (e) => {
        const el = e.target.closest("a,button,input");
        if (!el) return;

        const href = (el.getAttribute("href") || "").toLowerCase();
        const name = (el.getAttribute("name") || "").toLowerCase();
        const isCheckout =
          href.includes("/checkout") ||
          name.includes("checkout") ||
          (el.type === "submit" && (el.value || "").toLowerCase().includes("checkout"));

        if (!isCheckout) return;
        setTimeout(() => { waitForPopupAndFix(9000).catch(() => {}); }, 50);
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
              if (res.changed) setTimeout(() => (window.location.href = "/checkout"), 200);
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

  window.TCGStarLimitEnforcer = {
    enforceNow: async () => {
      const txt = collectLimitTextFromDOM();
      if (txt && txt.includes("Must have at most")) {
        return enforceFromPopupText(txt, { shouldNotify: true });
      }
      return enforceKnownCaps({ shouldNotify: true });
    },
    getLimits: () => loadLimits(),
    clearLimits: () => saveLimits({}),
    init: () => {
      hookCheckout();
      observeDOMForPopup();
      startPeriodicEnforce();
      enforceKnownCaps().catch(() => {});
    },
  };
})();