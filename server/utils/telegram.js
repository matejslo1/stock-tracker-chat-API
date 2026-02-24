const TelegramBot = require('node-telegram-bot-api');

class TelegramService {
  constructor() {
    this.bot = null;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.currentToken = null;
    this.initialized = false;
    this._reconnecting = false;
    this._pausedUntil = null;
    this._dailyReportJob = null;
  }

  _isAuthorized(msg) {
    if (!this.chatId) return false;
    return msg.chat.id.toString() === this.chatId.toString();
  }

  _isQuietHours() {
    try {
      const db = require('./database');
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'quiet_hours_enabled'").get();
      if (!row || row.value !== 'true') return false;
      const startRow = db.prepare("SELECT value FROM app_settings WHERE key = 'quiet_hours_start'").get();
      const endRow = db.prepare("SELECT value FROM app_settings WHERE key = 'quiet_hours_end'").get();
      const start = parseInt(startRow?.value ?? '23');
      const end = parseInt(endRow?.value ?? '7');
      const hour = new Date().getHours();
      if (start > end) return hour >= start || hour < end;
      return hour >= start && hour < end;
    } catch(e) { return false; }
  }

  _isPaused() {
    if (!this._pausedUntil) return false;
    if (new Date() < this._pausedUntil) return true;
    this._pausedUntil = null;
    return false;
  }

  async _stopExisting() {
    if (!this.bot) return;
    try { await this.bot.stopPolling(); } catch(e) {}
    await new Promise(r => setTimeout(r, 2000));
    this.bot = null;
    this.initialized = false;
  }

  async initialize(tokenOverride, chatIdOverride) {
    const token = tokenOverride || process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === 'your_telegram_bot_token_here') {
      console.warn('⚠️  Telegram bot token not configured.');
      return false;
    }
    await this._stopExisting();
    try {
      this.currentToken = token;
      if (chatIdOverride) this.chatId = chatIdOverride;
      try {
        const axios = require('axios');
        await axios.post(`https://api.telegram.org/bot${token}/deleteWebhook`, { drop_pending_updates: true }, { timeout: 8000 });
        console.log('🧹 Telegram: cleared stale webhook');
      } catch(e) { console.log('⚠️  Telegram: could not clear webhook:', e.message); }
      await new Promise(r => setTimeout(r, 1500));
      this.bot = new TelegramBot(token, {
        polling: { interval: 2000, autoStart: true, params: { timeout: 10, allowed_updates: ['message', 'callback_query'] } }
      });
      this.initialized = true;
      this.bot.on('polling_error', (err) => {
        if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
          if (!this._reconnecting) {
            this._reconnecting = true;
            console.log('⏳ Telegram: 409 conflict, waiting 15s...');
            setTimeout(async () => {
              this._reconnecting = false;
              try {
                await this._stopExisting();
                const axios = require('axios');
                await axios.post(`https://api.telegram.org/bot${token}/deleteWebhook`, { drop_pending_updates: true }, { timeout: 8000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 2000));
                await this.initialize(this.currentToken, this.chatId);
              } catch(e) { console.error('Telegram reconnect failed:', e.message); }
            }, 15000);
          }
        } else {
          console.error('Telegram polling error:', err.message);
          if (!this._reconnecting) {
            this._reconnecting = true;
            setTimeout(async () => {
              this._reconnecting = false;
              try { await this._stopExisting(); await this.initialize(this.currentToken, this.chatId); }
              catch(e) { console.error('Telegram reconnect failed:', e.message); }
            }, 30000);
          }
        }
      });
      this._registerCommands();
      this._scheduleDailyReport();
      console.log('✅ Telegram bot initialized');
      return true;
    } catch (error) {
      console.error('❌ Telegram bot initialization failed:', error.message);
      return false;
    }
  }

  _scheduleDailyReport() {
    if (this._dailyReportJob) clearInterval(this._dailyReportJob);
    this._dailyReportJob = setInterval(async () => {
      try {
        const db = require('./database');
        const enabled = db.prepare("SELECT value FROM app_settings WHERE key = 'daily_report_enabled'").get();
        if (!enabled || enabled.value !== 'true') return;
        const timeRow = db.prepare("SELECT value FROM app_settings WHERE key = 'daily_report_time'").get();
        const reportTime = timeRow?.value || '08:00';
        const [hh, mm] = reportTime.split(':').map(Number);
        const now = new Date();
        if (now.getHours() === hh && now.getMinutes() === mm) {
          const lastRow = db.prepare("SELECT value FROM app_settings WHERE key = 'daily_report_last_sent'").get();
          const today = now.toISOString().slice(0, 10);
          if (lastRow?.value === today) return;
          db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('daily_report_last_sent', ?)").run(today);
          await this._sendDailyReport();
        }
      } catch(e) { console.error('Daily report check error:', e.message); }
    }, 60000);
  }

  async _sendDailyReport() {
    if (!this.initialized || !this.chatId) return;
    try {
      const db = require('./database');
      const products = db.prepare('SELECT * FROM products ORDER BY name').all();
      const inStock = products.filter(p => p.in_stock);
      const outOfStock = products.filter(p => !p.in_stock);
      const since = new Date(Date.now() - 86400000).toISOString();
      const priceDrops = [];
      for (const p of products) {
        const history = db.prepare('SELECT price FROM stock_history WHERE product_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 1').get(p.id, since);
        if (history && p.current_price && history.price && p.current_price < history.price)
          priceDrops.push({ ...p, oldPrice: history.price });
      }
      let msg = `📊 *DNEVNO POROČILO — ${new Date().toLocaleDateString('sl-SI')}*\n\n`;
      msg += `📦 Skupaj: ${products.length} | ✅ Na zalogi: ${inStock.length} | ❌ Razprodano: ${outOfStock.length}\n\n`;
      if (inStock.length > 0) {
        msg += `*✅ Na zalogi (${inStock.length}):*\n`;
        inStock.slice(0, 10).forEach(p => {
          const price = p.current_price ? `${p.current_price} €` : 'N/A';
          msg += `• [${p.name}](${p.url}) — ${price}\n`;
        });
        if (inStock.length > 10) msg += `  _...in še ${inStock.length - 10} več_\n`;
        msg += '\n';
      }
      if (priceDrops.length > 0) {
        msg += `*💰 Znižanja cen (zadnjih 24h):*\n`;
        priceDrops.forEach(p => {
          const pct = ((p.oldPrice - p.current_price) / p.oldPrice * 100).toFixed(1);
          msg += `• ${p.name}: ~${p.oldPrice}€~ → *${p.current_price}€* (-${pct}%)\n`;
        });
        msg += '\n';
      }
      if (outOfStock.length > 0 && outOfStock.length <= 10) {
        msg += `*❌ Razprodano (${outOfStock.length}):*\n`;
        outOfStock.forEach(p => { msg += `• ${p.name}\n`; });
      }
      await this.bot.sendMessage(this.chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch(e) { console.error('Daily report error:', e.message); }
  }

  _registerCommands() {
    // /start
    this.bot.onText(/\/start/, (msg) => {
      this.chatId = msg.chat.id.toString();
      try { const db = require('./database'); db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run('telegram_chat_id', this.chatId); } catch(e) {}
      this.bot.sendMessage(msg.chat.id, '✅ *Stock Tracker Connected!*\n\nChat ID: `' + this.chatId + '`\n\nPrejeli boste obvestila o zalogah.\n\n*Ukazi:* /help', { parse_mode: 'Markdown' });
    });

    // /help
    this.bot.onText(/\/help/, (msg) => {
      if (!this._isAuthorized(msg)) return;
      this.bot.sendMessage(msg.chat.id,
        '📖 *Stock Tracker — Ukazi*\n\n' +
        '📊 *Pregled*\n/status | /products | /instock | /keywords\n\n' +
        '🔍 *Iskanje & dodajanje*\n/price <ime> | /add <url> | /remove <id> | /wish <url>\n\n' +
        '🔄 *Preverjanje*\n/check | /pause [min] | /resume\n\n' +
        '🛒 *Nakup*\n/buyall — Shopify košarica vseh na zalogi\n\n' +
        '📈 *Poročila*\n/daily | /cheapest\n\n' +
        '⚙️ *Nastavitve*\n/quiet [on/off/HH HH] | /report [on/off/HH:MM]',
        { parse_mode: 'Markdown' }
      );
    });

    // /status
    this.bot.onText(/\/status/, (msg) => {
      if (!this._isAuthorized(msg)) return;
      try {
        const db = require('./database');
        const total = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
        const inStock = db.prepare('SELECT COUNT(*) as c FROM products WHERE in_stock = 1').get().c;
        const kwCount = db.prepare('SELECT COUNT(*) as c FROM keyword_watches WHERE active = 1').get().c;
        const pausedText = this._isPaused() ? `\n⏸ *Pavzirano do:* ${this._pausedUntil.toLocaleTimeString('sl-SI')}` : '';
        const quietText = this._isQuietHours() ? '\n🔕 *Tihe ure aktivne*' : '';
        this.bot.sendMessage(msg.chat.id,
          '📊 *Stock Tracker Status*\n\n' +
          `📦 Sledeni: ${total}\n✅ Na zalogi: ${inStock}\n❌ Razprodano: ${total - inStock}\n🔍 Keyword watchi: ${kwCount}\n⏱ Interval: ${process.env.CHECK_INTERVAL_MINUTES || 5} min` +
          pausedText + quietText, { parse_mode: 'Markdown' });
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /products
    this.bot.onText(/\/products/, (msg) => {
      if (!this._isAuthorized(msg)) return;
      try {
        const db = require('./database');
        const products = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
        if (!products.length) { this.bot.sendMessage(msg.chat.id, '📭 Ni sledenih izdelkov.'); return; }
        let message = `📦 *Sledeni (${products.length}):*\n\n`;
        for (let i = 0; i < products.length; i++) {
          const p = products[i];
          const chunk = `${i+1}. ${p.in_stock ? '✅' : '❌'} *${p.name}*\n   💰 ${p.current_price ? p.current_price + ' €' : 'N/A'} | ID: \`${p.id}\`\n   🔗 [Link](${p.url})\n\n`;
          if (message.length + chunk.length > 3800) { this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', disable_web_page_preview: true }); message = chunk; }
          else { message += chunk; }
        }
        if (message.trim()) this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /instock
    this.bot.onText(/\/instock/, (msg) => {
      if (!this._isAuthorized(msg)) return;
      try {
        const db = require('./database');
        const products = db.prepare('SELECT * FROM products WHERE in_stock = 1 ORDER BY updated_at DESC').all();
        if (!products.length) { this.bot.sendMessage(msg.chat.id, '❌ Trenutno ni nobenih na zalogi.'); return; }
        let message = `✅ *Na zalogi (${products.length}):*\n\n`;
        for (const p of products) {
          const chunk = `• *${p.name}*\n  💰 ${p.current_price ? p.current_price + ' €' : 'N/A'}\n  🔗 [Odpri](${p.url})\n\n`;
          if (message.length + chunk.length > 3800) { this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', disable_web_page_preview: true }); message = chunk; }
          else { message += chunk; }
        }
        if (message.trim()) this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /keywords
    this.bot.onText(/\/keywords/, (msg) => {
      if (!this._isAuthorized(msg)) return;
      try {
        const db = require('./database');
        const watches = db.prepare('SELECT * FROM keyword_watches ORDER BY created_at DESC').all();
        if (!watches.length) { this.bot.sendMessage(msg.chat.id, '📭 Ni keyword watchev.'); return; }
        let message = `🔍 *Keyword Watchi (${watches.length}):*\n\n`;
        for (const w of watches) {
          let knownUrls = []; try { knownUrls = JSON.parse(w.known_product_urls || '[]'); } catch(e) {}
          const last = w.last_checked ? new Date(w.last_checked.includes('Z') ? w.last_checked : w.last_checked + 'Z').toLocaleString('sl-SI') : 'Nikoli';
          message += `${w.active ? '🟢' : '🔴'} *${w.keyword}*\n   🏪 ${w.store_url}\n   📦 Najdenih: ${knownUrls.length} | Zadnji: ${last}\n\n`;
        }
        this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /price <query>
    this.bot.onText(/\/price (.+)/, (msg, match) => {
      if (!this._isAuthorized(msg)) return;
      const query = match[1].toLowerCase().trim();
      try {
        const db = require('./database');
        const products = db.prepare('SELECT * FROM products').all().filter(p => p.name.toLowerCase().includes(query) || p.url.toLowerCase().includes(query));
        if (!products.length) { this.bot.sendMessage(msg.chat.id, `❌ Ni rezultatov za: "${match[1]}"`); return; }
        let message = `🔍 *Rezultati za "${match[1]}":*\n\n`;
        products.slice(0, 10).forEach(p => {
          const checked = p.last_checked ? new Date(p.last_checked.includes('Z') ? p.last_checked : p.last_checked + 'Z').toLocaleString('sl-SI') : 'Nikoli';
          message += `${p.in_stock ? '✅' : '❌'} *${p.name}*\n   💰 ${p.current_price ? p.current_price + ' €' : 'N/A'} | ID: \`${p.id}\`\n   🕐 ${checked}\n   🔗 [Odpri](${p.url})\n\n`;
        });
        if (products.length > 10) message += `_...in še ${products.length - 10} več_`;
        this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /add <url>
    this.bot.onText(/\/add (.+)/, async (msg, match) => {
      if (!this._isAuthorized(msg)) return;
      const url = match[1].trim();
      if (!url.startsWith('http')) { this.bot.sendMessage(msg.chat.id, '❌ Prosim vnesi veljaven URL (začne z http).'); return; }
      try {
        const db = require('./database');
        const existing = db.prepare('SELECT id FROM products WHERE url = ?').get(url);
        if (existing) { this.bot.sendMessage(msg.chat.id, `⚠️ URL je že v sledenju (ID: \`${existing.id}\`)`, { parse_mode: 'Markdown' }); return; }
        let name = '';
        try { const u = new URL(url); const parts = u.pathname.split('/').filter(Boolean); name = (parts[parts.length - 1] || u.hostname).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).substring(0, 100); } catch(e) { name = 'Nov izdelek'; }
        const hostname = (() => { try { return new URL(url).hostname; } catch(e) { return ''; } })();
        let store = 'custom';
        if (hostname.includes('shopify') || hostname.includes('tcgstar')) store = 'shopify';
        else if (hostname.includes('amazon')) store = 'amazon';
        else if (hostname.includes('bigbang')) store = 'bigbang';
        else if (hostname.includes('mimovrste')) store = 'mimovrste';
        const result = db.prepare('INSERT INTO products (name, url, store, notify_on_stock, notify_on_price_drop) VALUES (?, ?, ?, 1, 1)').run(name, url, store);
        const newProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
        await this.bot.sendMessage(msg.chat.id, `✅ *Dodano!*\n\n📦 *${name}*\n🏪 ${store} | ID: \`${result.lastInsertRowid}\`\n\nPreverjam zalogo...`, { parse_mode: 'Markdown' });
        try {
          const checker = require('./checker');
          await checker.checkProduct(newProduct);
          const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
          await this.bot.sendMessage(msg.chat.id, `📊 *${updated.name}*\n${updated.in_stock ? '✅ Na zalogi' : '❌ Ni na zalogi'} — ${updated.current_price ? updated.current_price + ' €' : 'N/A'}`, { parse_mode: 'Markdown' });
        } catch(e) { await this.bot.sendMessage(msg.chat.id, `⚠️ Dodano, check ni uspel: ${e.message}`); }
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /remove <id>
    this.bot.onText(/\/remove (\d+)/, async (msg, match) => {
      if (!this._isAuthorized(msg)) return;
      const id = parseInt(match[1]);
      try {
        const db = require('./database');
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
        if (!product) { this.bot.sendMessage(msg.chat.id, `❌ Izdelek z ID \`${id}\` ni najden.`, { parse_mode: 'Markdown' }); return; }
        await this.bot.sendMessage(msg.chat.id, `🗑 *Odstrani iz sledenja?*\n\n📦 *${product.name}*\nID: \`${id}\``, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✅ Da, odstrani', callback_data: `remove_confirm_${id}` }, { text: '❌ Prekliči', callback_data: `remove_cancel_${id}` }]] }
        });
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /wish <url>
    this.bot.onText(/\/wish (.+)/, async (msg, match) => {
      if (!this._isAuthorized(msg)) return;
      const url = match[1].trim();
      if (!url.startsWith('http')) { this.bot.sendMessage(msg.chat.id, '❌ Prosim vnesi veljaven URL.'); return; }
      try {
        const db = require('./database');
        const existing = db.prepare('SELECT id FROM products WHERE url = ?').get(url);
        if (existing) { this.bot.sendMessage(msg.chat.id, `⚠️ URL je že v sledenju (ID: \`${existing.id}\`)`, { parse_mode: 'Markdown' }); return; }
        let name = '';
        try { const u = new URL(url); const parts = u.pathname.split('/').filter(Boolean); name = (parts[parts.length - 1] || u.hostname).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).substring(0, 100); } catch(e) { name = 'Wishlist izdelek'; }
        const result = db.prepare('INSERT INTO products (name, url, store, notify_on_stock, notify_on_price_drop) VALUES (?, ?, ?, 0, 0)').run(name, url, 'custom');
        await this.bot.sendMessage(msg.chat.id, `🌟 *Dodano na wishlist!*\n\n📦 *${name}*\nID: \`${result.lastInsertRowid}\`\n\n_Brez alertov — samo sledenje._`, { parse_mode: 'Markdown' });
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /check
    this.bot.onText(/\/check/, async (msg) => {
      if (!this._isAuthorized(msg)) return;
      await this.bot.sendMessage(msg.chat.id, '🔄 Preverjam vse izdelke...');
      try {
        const db = require('./database');
        const before = db.prepare('SELECT id, in_stock, current_price FROM products').all();
        const beforeMap = {};
        before.forEach(p => beforeMap[p.id] = { in_stock: p.in_stock, price: p.current_price });
        if (this.onManualCheck) { await this.onManualCheck({ force: true }); }
        else { await this.bot.sendMessage(msg.chat.id, '⚠️ Checker ni inicializiran.'); return; }
        const after = db.prepare('SELECT id, name, in_stock, current_price, url FROM products').all();
        const nowInStock = after.filter(p => p.in_stock && !beforeMap[p.id]?.in_stock);
        const nowOutOfStock = after.filter(p => !p.in_stock && beforeMap[p.id]?.in_stock);
        const priceChanged = after.filter(p => { const old = beforeMap[p.id]?.price; return old && p.current_price && Math.abs(old - p.current_price) > 0.01; });
        const totalInStock = after.filter(p => p.in_stock).length;
        let summary = `✅ *Preverjanje zaključeno!*\n\n📦 Skupaj: ${after.length} | ✅ Na zalogi: ${totalInStock} | ❌ Ni: ${after.length - totalInStock}\n`;
        if (nowInStock.length > 0) { summary += `\n🚨 *Novo na zalogi (${nowInStock.length}):*\n`; nowInStock.forEach(p => { summary += `• [${p.name}](${p.url})${p.current_price ? ' — ' + p.current_price.toFixed(2) + ' €' : ''}\n`; }); }
        if (nowOutOfStock.length > 0) { summary += `\n📦 *Razprodano (${nowOutOfStock.length}):*\n`; nowOutOfStock.forEach(p => summary += `• ${p.name}\n`); }
        if (priceChanged.length > 0) { summary += `\n💰 *Sprememba cene (${priceChanged.length}):*\n`; priceChanged.forEach(p => { summary += `• ${p.name}: ${beforeMap[p.id].price?.toFixed(2)} → ${p.current_price?.toFixed(2)} €\n`; }); }
        if (!nowInStock.length && !nowOutOfStock.length && !priceChanged.length) summary += '\n_Ni sprememb_';
        await this.bot.sendMessage(msg.chat.id, summary, { parse_mode: 'Markdown', disable_web_page_preview: true });
      } catch(e) { await this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /pause [minutes]
    this.bot.onText(/\/pause ?(\d*)/, async (msg, match) => {
      if (!this._isAuthorized(msg)) return;
      const minutes = parseInt(match[1]) || 60;
      this._pausedUntil = new Date(Date.now() + minutes * 60000);
      const untilTime = this._pausedUntil.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
      await this.bot.sendMessage(msg.chat.id, `⏸ *Obvestila pavzirana do ${untilTime}*\n_Za nadaljevanje: /resume_`, { parse_mode: 'Markdown' });
    });

    // /resume
    this.bot.onText(/\/resume/, async (msg) => {
      if (!this._isAuthorized(msg)) return;
      this._pausedUntil = null;
      await this.bot.sendMessage(msg.chat.id, '▶️ *Obvestila spet aktivna!*', { parse_mode: 'Markdown' });
    });

    // /daily
    this.bot.onText(/\/daily/, async (msg) => {
      if (!this._isAuthorized(msg)) return;
      await this.bot.sendMessage(msg.chat.id, '📊 Sestavljam dnevno poročilo...');
      await this._sendDailyReport();
    });

    // /cheapest
    this.bot.onText(/\/cheapest/, (msg) => {
      if (!this._isAuthorized(msg)) return;
      try {
        const db = require('./database');
        const products = db.prepare('SELECT * FROM products WHERE in_stock = 1 AND current_price IS NOT NULL ORDER BY current_price ASC LIMIT 10').all();
        if (!products.length) { this.bot.sendMessage(msg.chat.id, '❌ Ni cenovno rangiranih na zalogi.'); return; }
        let message = `💰 *Najcenejši na zalogi:*\n\n`;
        products.forEach((p, i) => { message += `${i+1}. *${p.name}*\n   💰 *${p.current_price} €*\n   🔗 [Kupi!](${p.url})\n\n`; });
        this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /buyall
    this.bot.onText(/\/buyall/, async (msg) => {
      if (!this._isAuthorized(msg)) return;
      try {
        const db = require('./database');
        const { buildCartUrlForProducts } = require('./shopify-cart');
        const products = db.prepare("SELECT * FROM products WHERE store = 'shopify' AND in_stock = 1").all();
        if (!products.length) { this.bot.sendMessage(msg.chat.id, '❌ Ni Shopify izdelkov na zalogi.'); return; }
        await this.bot.sendMessage(msg.chat.id, `🔄 Sestavljam košarico za ${products.length} izdelkov...`);
        const result = await buildCartUrlForProducts(products);
        if (result.cartUrl) {
          const itemList = result.items.map(i => `• ${i.name} (${i.quantity}x)${i.price ? ` — ${i.price} €` : ''}`).join('\n');
          const errList = result.errors?.length ? `\n\n⚠️ Preskočeni:\n${result.errors.map(e => `• ${e}`).join('\n')}` : '';
          await this.bot.sendMessage(msg.chat.id, `🛒 *Košarica pripravljena!*\n\n${itemList}${errList}\n\n✅ ${result.items.length} izdelkov`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🛒 Dodaj v košarico', url: result.cartUrl }], [{ text: '💳 Direktno checkout', url: result.cartUrl + '?checkout' }]] }
          });
        } else { this.bot.sendMessage(msg.chat.id, `❌ ${result.errors?.join('\n') || 'Ni Shopify izdelkov ali so z različnih domen.'}`); }
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /quiet [on/off/HH HH]
    this.bot.onText(/\/quiet ?(.*)/, async (msg, match) => {
      if (!this._isAuthorized(msg)) return;
      const arg = (match[1] || '').trim().toLowerCase();
      try {
        const db = require('./database');
        if (arg === 'off') {
          db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('quiet_hours_enabled', 'false')").run();
          await this.bot.sendMessage(msg.chat.id, '🔔 *Tihe ure izklopljene*', { parse_mode: 'Markdown' });
        } else {
          const parts = arg.split(/\s+/);
          if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('quiet_hours_start', ?)").run(parts[0]);
            db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('quiet_hours_end', ?)").run(parts[1]);
            db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('quiet_hours_enabled', 'true')").run();
            await this.bot.sendMessage(msg.chat.id, `🔕 *Tihe ure: ${parts[0]}:00 – ${parts[1]}:00*`, { parse_mode: 'Markdown' });
          } else {
            const startRow = db.prepare("SELECT value FROM app_settings WHERE key = 'quiet_hours_start'").get();
            const endRow = db.prepare("SELECT value FROM app_settings WHERE key = 'quiet_hours_end'").get();
            db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('quiet_hours_enabled', 'true')").run();
            await this.bot.sendMessage(msg.chat.id, `🔕 *Tihe ure vklopljene (${startRow?.value ?? '23'}:00 – ${endRow?.value ?? '7'}:00)*\n_/quiet off za izklop | /quiet 22 8 za nastavljanje_`, { parse_mode: 'Markdown' });
          }
        }
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // /report [on/off/HH:MM]
    this.bot.onText(/\/report ?(.*)/, async (msg, match) => {
      if (!this._isAuthorized(msg)) return;
      const args = (match[1] || '').trim().split(/\s+/);
      try {
        const db = require('./database');
        if (args[0].toLowerCase() === 'off') {
          db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('daily_report_enabled', 'false')").run();
          await this.bot.sendMessage(msg.chat.id, '📊 *Dnevno poročilo izklopljeno*', { parse_mode: 'Markdown' });
        } else {
          const time = args.find(a => /^\d{1,2}:\d{2}$/.test(a)) || '08:00';
          db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('daily_report_enabled', 'true')").run();
          db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('daily_report_time', ?)").run(time);
          await this.bot.sendMessage(msg.chat.id, `📊 *Dnevno poročilo ob ${time}*\n_/report off za izklop_`, { parse_mode: 'Markdown' });
        }
      } catch(e) { this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`); }
    });

    // Callback query handler
    this.bot.on('callback_query', async (query) => {
      if (!this._isAuthorized(query.message)) return;
      const data = query.data;

      if (data.startsWith('remove_confirm_')) {
        const id = parseInt(data.replace('remove_confirm_', ''));
        try {
          const db = require('./database');
          const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
          if (!product) { await this.bot.answerCallbackQuery(query.id, { text: 'Izdelek ni najden.' }); return; }
          db.prepare('DELETE FROM products WHERE id = ?').run(id);
          db.prepare('DELETE FROM stock_history WHERE product_id = ?').run(id);
          await this.bot.editMessageText(`🗑 *Odstranjeno:* ${product.name}`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' });
          await this.bot.answerCallbackQuery(query.id, { text: '✅ Odstranjeno!' });
        } catch(e) { await this.bot.answerCallbackQuery(query.id, { text: `Napaka: ${e.message}` }); }
      }
      else if (data.startsWith('remove_cancel_')) {
        await this.bot.editMessageText('❌ Odstranitev preklicana.', { chat_id: query.message.chat.id, message_id: query.message.message_id });
        await this.bot.answerCallbackQuery(query.id, { text: 'Preklicano.' });
      }
      else if (data.startsWith('bought_')) {
        const id = parseInt(data.replace('bought_', ''));
        try {
          const db = require('./database');
          db.prepare("INSERT INTO notifications (product_id, type, message) VALUES (?, 'bought', 'Označeno kot kupljeno')").run(id);
          await this.bot.answerCallbackQuery(query.id, { text: '✅ Označeno kot kupljeno!' });
          try {
            const orig = query.message.text || query.message.caption || '';
            await this.bot.editMessageText(orig + '\n\n✅ *KUPLJENO*', { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown', disable_web_page_preview: true });
          } catch(e) {}
        } catch(e) { await this.bot.answerCallbackQuery(query.id, { text: `Napaka: ${e.message}` }); }
      }
      else if (data.startsWith('check_now_')) {
        const id = parseInt(data.replace('check_now_', ''));
        await this.bot.answerCallbackQuery(query.id, { text: '🔄 Preverjam...' });
        try {
          const db = require('./database');
          const checker = require('./checker');
          const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
          if (!product) { await this.bot.sendMessage(query.message.chat.id, '❌ Izdelek ni najden.'); return; }
          await checker.checkProduct(product, { forceNotify: false });
          const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
          await this.bot.sendMessage(query.message.chat.id,
            `🔄 *${updated.name}*\n${updated.in_stock ? '✅ Na zalogi' : '❌ Ni na zalogi'} — ${updated.current_price ? updated.current_price + ' €' : 'N/A'}`,
            { parse_mode: 'Markdown' }
          );
        } catch(e) { await this.bot.sendMessage(query.message.chat.id, `❌ Napaka: ${e.message}`); }
      }
    });
  }

  // ─── Send alerts ─────────────────────────────────────────────────────────────

  async sendStockAlert(product, cartUrl = null) {
    if (!this.initialized || !this.chatId) return false;
    if (this._isPaused() || this._isQuietHours()) {
      console.log(`⏸ Stock alert skipped (${this._isPaused() ? 'paused' : 'quiet hours'})`);
      return false;
    }
    const price = product.current_price ? `${product.current_price.toFixed(2)} ${product.currency || 'EUR'}` : 'N/A';
    const targetHit = product.target_price && product.current_price <= product.target_price;
    const message =
      '🚨 *IZDELEK NA ZALOGI!*\n\n' +
      `📦 *${product.name}*\n🏪 Trgovina: ${product.store}\n💰 Cena: *${price}*\n` +
      (product.target_price ? `🎯 Ciljna cena: ${product.target_price.toFixed(2)} ${product.currency || 'EUR'}${targetHit ? ' ✅' : ''}\n` : '') +
      (product.max_order_qty > 1 ? `📦 Max količina: ${product.max_order_qty}x\n` : '');
    const keyboard = [[{ text: '🔗 Odpri izdelek', url: product.url }]];
    if (cartUrl) {
      keyboard.push([{ text: '🛒 Dodaj v košarico', url: cartUrl }]);
      keyboard.push([{ text: '💳 Direktno checkout', url: cartUrl + '?checkout' }]);
    }
    keyboard.push([
      { text: '✅ Kupljeno', callback_data: `bought_${product.id}` },
      { text: '🔄 Preveri zdaj', callback_data: `check_now_${product.id}` }
    ]);
    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
      return true;
    } catch (error) { console.error('Failed to send stock alert:', error.message); return false; }
  }

  async sendOutOfStockAlert(product) {
    if (!this.initialized || !this.chatId) return false;
    if (this._isPaused() || this._isQuietHours()) {
      console.log(`⏸ Out-of-stock alert skipped (${this._isPaused() ? 'paused' : 'quiet hours'})`);
      return false;
    }
    const price = product.current_price ? `${product.current_price.toFixed(2)} ${product.currency || 'EUR'}` : 'N/A';
    const message =
      '📭 *IZDELEK RAZPRODAN!*\n\n' +
      `📦 *${product.name}*\n🏪 Trgovina: ${product.store}\n💰 Zadnja cena: ${price}\n` +
      `\n_Obvestilo bo prišlo ko bo spet na zalogi._`;
    const keyboard = [[
      { text: '🔗 Odpri izdelek', url: product.url },
      { text: '🔄 Preveri zdaj', callback_data: `check_now_${product.id}` }
    ]];
    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
      return true;
    } catch (error) { console.error('Failed to send out-of-stock alert:', error.message); return false; }
  }

  async sendAllInStockCartAlert(products, cartUrl) {
    if (!this.initialized || !this.chatId || !cartUrl || products.length <= 1) return false;
    if (this._isPaused() || this._isQuietHours()) return false;
    const itemList = products.map(p => `• ${p.name}`).join('\n');
    try {
      await this.bot.sendMessage(this.chatId, `🛒 *Skupna košarica — ${products.length} izdelkov na zalogi:*\n\n${itemList}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: `🛒 Kupi vse (${products.length})`, url: cartUrl }], [{ text: '💳 Direktno checkout', url: cartUrl + '?checkout' }]] }
      });
      return true;
    } catch (error) { console.error('Failed to send cart alert:', error.message); return false; }
  }

  async sendPriceDropAlert(product, oldPrice, newPrice) {
    if (!this.initialized || !this.chatId) return false;
    if (this._isPaused() || this._isQuietHours()) return false;
    const pctDrop = ((oldPrice - newPrice) / oldPrice * 100).toFixed(1);
    const message =
      '💰 *ZNIŽANJE CENE!*\n\n' +
      `📦 *${product.name}*\n🏪 Trgovina: ${product.store}\n` +
      `💸 Stara cena: ~${oldPrice} ${product.currency || 'EUR'}~\n` +
      `✨ Nova cena: *${newPrice} ${product.currency || 'EUR'}*\n📉 Znižanje: ${pctDrop}%\n` +
      `\n🔗 [Odpri izdelek](${product.url})`;
    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🛒 Kupi zdaj', url: product.url }, { text: '✅ Kupljeno', callback_data: `bought_${product.id}` }]] }
      });
      return true;
    } catch (error) { console.error('Failed to send price drop:', error.message); return false; }
  }

  async sendKeywordAlert(watch, newProducts) {
    if (!this.initialized || !this.chatId) return false;
    if (this._isPaused() || this._isQuietHours()) return false;
    let message = `🔍 *NOVI IZDELKI: "${watch.keyword}"*\n🏪 ${watch.store_url}\n\n`;
    newProducts.slice(0, 10).forEach((p, i) => {
      message += `${i + 1}. *${p.name}*\n`;
      if (p.price) message += `   💰 ${p.price.toFixed(2)} €\n`;
      if (p.inStock !== undefined) message += `   ${p.inStock ? '✅ Na zalogi' : '❌ Ni na zalogi'}\n`;
      message += `   🔗 [Odpri](${p.url})\n\n`;
    });
    if (newProducts.length > 10) message += `_...in še ${newProducts.length - 10} več_\n`;
    message += `Skupaj: ${newProducts.length} novih`;
    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      return true;
    } catch(e) { console.error('Failed to send keyword alert:', e.message); return false; }
  }

  async sendPurchaseAttemptAlert(product, status, details) {
    if (!this.initialized || !this.chatId) return false;
    const emoji = status === 'success' ? '✅' : '⚠️';
    try {
      await this.bot.sendMessage(this.chatId,
        `${emoji} *AVTOMATSKI NAKUP*\n\n📦 *${product.name}*\n🏪 ${product.store}\n📋 Status: ${status}\n${details ? '📝 ' + details + '\n' : ''}\n🔗 [Preveri](${product.url})`,
        { parse_mode: 'Markdown' }
      );
      return true;
    } catch (error) { console.error('Failed to send purchase alert:', error.message); return false; }
  }

  async sendMessage(text) {
    if (!this.initialized || !this.chatId) return false;
    if (this._isPaused() || this._isQuietHours()) return false;
    try { await this.bot.sendMessage(this.chatId, text, { parse_mode: 'Markdown' }); return true; }
    catch (error) { console.error('Failed to send message:', error.message); return false; }
  }

  onManualCheckHandler(callback) { this.onManualCheck = callback; }
  getChatId() { return this.chatId; }
  getToken() { return this.currentToken || process.env.TELEGRAM_BOT_TOKEN || ''; }
  isReady() { return this.initialized && !!this.chatId; }
  isPaused() { return this._isPaused(); }
  isQuietHours() { return this._isQuietHours(); }

  async reinitialize(token, chatId) {
    await this._stopExisting();
    this.currentToken = token;
    if (chatId) this.chatId = chatId;
    return this.initialize(token, chatId || this.chatId);
  }

  async shutdown() {
    if (this._dailyReportJob) clearInterval(this._dailyReportJob);
    await this._stopExisting();
  }
}

module.exports = new TelegramService();
