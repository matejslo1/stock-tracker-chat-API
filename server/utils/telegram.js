const TelegramBot = require('node-telegram-bot-api');

class TelegramService {
  constructor() {
    this.bot = null;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.currentToken = null;
    this.initialized = false;
    this._reconnecting = false;
  }

  // Security: only allow messages from authorized chat
  _isAuthorized(msg) {
    if (!this.chatId) return false;
    return msg.chat.id.toString() === this.chatId.toString();
  }

  // Stop any existing bot cleanly before creating a new one
  async _stopExisting() {
    if (!this.bot) return;
    try {
      await this.bot.stopPolling();
    } catch(e) {}
    // Give Telegram servers 2s to release the lock
    await new Promise(r => setTimeout(r, 2000));
    this.bot = null;
    this.initialized = false;
  }

  async initialize(tokenOverride, chatIdOverride) {
    const token = tokenOverride || process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === 'your_telegram_bot_token_here') {
      console.warn('⚠️  Telegram bot token not configured. Notifications disabled.');
      return false;
    }

    // Stop any existing instance first
    await this._stopExisting();

    try {
      this.currentToken = token;
      if (chatIdOverride) this.chatId = chatIdOverride;

      // Delete any stale webhook before starting polling (prevents 409)
      try {
        const axios = require('axios');
        await axios.post(`https://api.telegram.org/bot${token}/deleteWebhook`, { drop_pending_updates: true }, { timeout: 8000 });
        console.log('🧹 Telegram: cleared stale webhook');
      } catch(e) {
        console.log('⚠️  Telegram: could not clear webhook:', e.message);
      }

      // Small delay after deleteWebhook before starting polling
      await new Promise(r => setTimeout(r, 1500));

      this.bot = new TelegramBot(token, {
        polling: {
          interval: 2000,
          autoStart: true,
          params: { timeout: 10, allowed_updates: ['message', 'callback_query'] }
        }
      });
      this.initialized = true;

      // Handle polling errors gracefully with auto-reconnect
      this.bot.on('polling_error', (err) => {
        if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
          // 409 = another instance is running; wait longer and retry
          if (!this._reconnecting) {
            this._reconnecting = true;
            console.log('⏳ Telegram: 409 conflict, waiting 15s for other instance to stop...');
            setTimeout(async () => {
              this._reconnecting = false;
              try {
                await this._stopExisting();
                // deleteWebhook again before retry
                const axios = require('axios');
                await axios.post(`https://api.telegram.org/bot${token}/deleteWebhook`, { drop_pending_updates: true }, { timeout: 8000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 2000));
                await this.initialize(this.currentToken, this.chatId);
              } catch(e) {
                console.error('Telegram reconnect failed:', e.message);
              }
            }, 15000);
          }
        } else {
          console.error('Telegram polling error:', err.message);
          if (!this._reconnecting) {
            this._reconnecting = true;
            setTimeout(async () => {
              this._reconnecting = false;
              try {
                await this._stopExisting();
                await this.initialize(this.currentToken, this.chatId);
              } catch(e) {
                console.error('Telegram reconnect failed:', e.message);
              }
            }, 30000);
          }
        }
      });

      this._registerCommands();

      console.log('✅ Telegram bot initialized');
      return true;
    } catch (error) {
      console.error('❌ Telegram bot initialization failed:', error.message);
      return false;
    }
  }

  _registerCommands() {
    // /start command — set chat ID
    this.bot.onText(/\/start/, (msg) => {
      this.chatId = msg.chat.id.toString();
      console.log(`📱 Telegram Chat ID detected: ${this.chatId}`);

      try {
        const db = require('./database');
        db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run('telegram_chat_id', this.chatId);
        console.log(`💾 Chat ID saved to DB: ${this.chatId}`);
      } catch(e) { console.error('Failed to save chat ID:', e.message); }

      this.bot.sendMessage(msg.chat.id,
        '✅ *Stock Tracker Connected!*\n\n' +
        `Your Chat ID: \`${this.chatId}\`\n\n` +
        'You will now receive stock notifications here.\n\n' +
        '*Commands:*\n' +
        '/status - Tracker status\n' +
        '/products - All tracked products\n' +
        '/instock - Only in-stock products\n' +
        '/check - Force check now\n' +
        '/buyall - Cart URL for all in-stock\n' +
        '/help - Full command list',
        { parse_mode: 'Markdown' }
      );
    });

    // /help
    this.bot.onText(/\/help/, (msg) => {
      if (!this._isAuthorized(msg)) return;
      this.bot.sendMessage(msg.chat.id,
        '📖 *Stock Tracker — Ukazi*\n\n' +
        '📊 *Pregled*\n' +
        '/status — Status tracker ja, št. izdelkov, zaloga\n' +
        '/products — Seznam vseh sledenih izdelkov\n' +
        '/instock — Samo izdelki, ki so trenutno na zalogi\n\n' +
        '🔄 *Preverjanje*\n' +
        '/check — Prisilno preverjanje vseh izdelkov + poroča spremembe\n\n' +
        '🛒 *Nakup*\n' +
        '/buyall — Shopify košarica z vsemi na zalogi (max količine)\n' +
        '/alltocart — Direkten checkout link za vse na zalogi\n\n' +
        '📈 *Statistika*\n' +
        '/daily — Povzetek dneva (zaloge, cene, trendi)\n' +
        '/cheapest — Najcenejši trenutno na zalogi\n\n' +
        '❓ *Pomoč*\n' +
        '/help — Ta seznam ukazov\n\n' +
        '_Obvestila prispejo avtomatsko ob spremembi zaloge ali cene._',
        { parse_mode: 'Markdown' }
      );
    });

    // /status
    this.bot.onText(/\/status/, (msg) => {
      if (!this._isAuthorized(msg)) return;
      try {
        const db = require('./database');
        const products = db.prepare('SELECT COUNT(*) as count FROM products').get();
        const inStock = db.prepare('SELECT COUNT(*) as count FROM products WHERE in_stock = 1').get();
        this.bot.sendMessage(msg.chat.id,
          '📊 *Stock Tracker Status*\n\n' +
          `📦 Sledeni izdelki: ${products.count}\n` +
          `✅ Na zalogi: ${inStock.count}\n` +
          `❌ Ni na zalogi: ${products.count - inStock.count}\n` +
          `⏰ Interval: ${process.env.CHECK_INTERVAL_MINUTES || 5} min`,
          { parse_mode: 'Markdown' }
        );
      } catch(e) {
        this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`);
      }
    });

    // /instock
    this.bot.onText(/\/instock/, (msg) => {
      if (!this._isAuthorized(msg)) return;
      try {
        const db = require('./database');
        const products = db.prepare('SELECT * FROM products WHERE in_stock = 1 ORDER BY updated_at DESC').all();
        if (products.length === 0) {
          this.bot.sendMessage(msg.chat.id, '❌ Trenutno ni nobenih izdelkov na zalogi.');
          return;
        }
        let message = `✅ *Na zalogi (${products.length}):*\n\n`;
        for (const p of products) {
          const price = p.current_price ? `${p.current_price} ${p.currency || 'EUR'}` : 'N/A';
          const chunk = `• *${p.name}*\n  💰 ${price}\n  🔗 [Odpri](${p.url})\n\n`;
          if (message.length + chunk.length > 3800) {
            this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
            message = chunk;
          } else {
            message += chunk;
          }
        }
        if (message.trim()) {
          this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
        }
      } catch(e) {
        this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`);
      }
    });

    // /products
    this.bot.onText(/\/products/, (msg) => {
      if (!this._isAuthorized(msg)) return;
      try {
        const db = require('./database');
        const products = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
        if (products.length === 0) {
          this.bot.sendMessage(msg.chat.id, '📭 Ni sledenih izdelkov.');
          return;
        }
        let message = `📦 *Sledeni (${products.length}):*\n\n`;
        for (let i = 0; i < products.length; i++) {
          const p = products[i];
          const status = p.in_stock ? '✅' : '❌';
          const price = p.current_price ? `${p.current_price} ${p.currency || 'EUR'}` : 'N/A';
          const chunk = `${i+1}. ${status} *${p.name}*\n   💰 ${price}\n   🔗 [Link](${p.url})\n\n`;
          if (message.length + chunk.length > 3800) {
            this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
            message = chunk;
          } else {
            message += chunk;
          }
        }
        if (message.trim()) {
          this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
        }
      } catch(e) {
        this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`);
      }
    });

    // /check
    this.bot.onText(/\/check/, async (msg) => {
      if (!this._isAuthorized(msg)) return;
      await this.bot.sendMessage(msg.chat.id, '🔄 Preverjam vse izdelke...');
      try {
        const db = require('./database');
        // Snapshot before
        const before = db.prepare('SELECT id, in_stock, current_price FROM products').all();
        const beforeMap = {};
        before.forEach(p => beforeMap[p.id] = { in_stock: p.in_stock, price: p.current_price });

        if (this.onManualCheck) {
          await this.onManualCheck({ force: true });
        } else {
          await this.bot.sendMessage(msg.chat.id, '⚠️ Checker ni inicializiran.');
          return;
        }

        // Snapshot after
        const after = db.prepare('SELECT id, name, in_stock, current_price, url, store FROM products').all();
        const nowInStock = after.filter(p => p.in_stock && !beforeMap[p.id]?.in_stock);
        const nowOutOfStock = after.filter(p => !p.in_stock && beforeMap[p.id]?.in_stock);
        const priceChanged = after.filter(p => {
          const oldPrice = beforeMap[p.id]?.price;
          return oldPrice && p.current_price && Math.abs(oldPrice - p.current_price) > 0.01;
        });
        const totalInStock = after.filter(p => p.in_stock).length;

        let summary = `✅ *Preverjanje zaključeno!*

`;
        summary += `📦 Skupaj: ${after.length} izdelkov
`;
        summary += `✅ Na zalogi: ${totalInStock}
`;
        summary += `❌ Ni na zalogi: ${after.length - totalInStock}
`;

        if (nowInStock.length > 0) {
          summary += `
🚨 *Novo na zalogi (${nowInStock.length}):*
`;
          nowInStock.forEach(p => {
            const price = p.current_price ? ` — ${p.current_price.toFixed(2)} EUR` : '';
            summary += `• [${p.name}](${p.url})${price}
`;
          });
        }
        if (nowOutOfStock.length > 0) {
          summary += `
📦 *Razprodano (${nowOutOfStock.length}):*
`;
          nowOutOfStock.forEach(p => summary += `• ${p.name}
`);
        }
        if (priceChanged.length > 0) {
          summary += `
💰 *Sprememba cene (${priceChanged.length}):*
`;
          priceChanged.forEach(p => {
            const old = beforeMap[p.id].price?.toFixed(2);
            summary += `• ${p.name}: ${old} → ${p.current_price?.toFixed(2)} EUR
`;
          });
        }
        if (nowInStock.length === 0 && nowOutOfStock.length === 0 && priceChanged.length === 0) {
          summary += `
_Ni sprememb_`;
        }

        await this.bot.sendMessage(msg.chat.id, summary, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
      } catch(e) {
        await this.bot.sendMessage(msg.chat.id, `❌ Napaka: ${e.message}`);
      }
    });

    // /buyall
    this.bot.onText(/\/buyall/, async (msg) => {
      if (!this._isAuthorized(msg)) return;
      try {
        const db = require('./database');
        const { buildCartUrlForProducts } = require('./shopify-cart');

        const products = db.prepare("SELECT * FROM products WHERE store = 'shopify' AND in_stock = 1").all();

        if (products.length === 0) {
          this.bot.sendMessage(msg.chat.id, '❌ Ni nobenih Shopify izdelkov na zalogi.');
          return;
        }

        await this.bot.sendMessage(msg.chat.id, `🔄 Sestavljam košarico za ${products.length} izdelkov...`);

        const result = await buildCartUrlForProducts(products);

        if (result.cartUrl) {
          const itemList = result.items.map(i =>
            `• ${i.name} (${i.quantity}x)${i.price ? ` — ${i.price} EUR` : ''}`
          ).join('\n');
          const errList = result.errors && result.errors.length > 0
            ? `\n\n⚠️ Preskočeni:\n${result.errors.map(e => `• ${e}`).join('\n')}`
            : '';
          await this.bot.sendMessage(msg.chat.id,
            `🛒 *Košarica pripravljena!*\n\n${itemList}${errList}\n\n✅ ${result.items.length} izdelkov`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🛒 Dodaj v košarico', url: result.cartUrl }],
                  [{ text: '💳 Direktno na checkout', url: result.cartUrl + '?checkout' }]
                ]
              }
            }
          );
        } else {
          const errMsg = result.errors && result.errors.length > 0
            ? result.errors.join('\n')
            : 'Ni Shopify izdelkov ali so z različnih domen.';
          this.bot.sendMessage(msg.chat.id, `❌ ${errMsg}`);
        }
      } catch(e) {
        this.bot.sendMessage(msg.chat.id, `❌ Napaka pri gradnji košarice: ${e.message}`);
      }
    });
  }

  async sendStockAlert(product, cartUrl = null) {
    if (!this.initialized || !this.chatId) return false;

    const price = product.current_price ? `${product.current_price.toFixed(2)} ${product.currency || 'EUR'}` : 'N/A';
    const targetHit = product.target_price && product.current_price <= product.target_price;

    const message =
      '🚨 *IZDELEK NA ZALOGI!*\n\n' +
      `📦 *${product.name}*\n` +
      `🏪 Trgovina: ${product.store}\n` +
      `💰 Cena: *${price}*\n` +
      (product.target_price ? `🎯 Ciljna cena: ${product.target_price.toFixed(2)} ${product.currency || 'EUR'}${targetHit ? ' ✅' : ''}\n` : '') +
      (product.max_order_qty > 1 ? `📦 Max količina: ${product.max_order_qty}x\n` : '');

    const keyboard = [[{ text: '🔗 Odpri izdelek', url: product.url }]];
    if (cartUrl) {
      keyboard.push([{ text: '🛒 Dodaj v košarico', url: cartUrl }]);
      keyboard.push([{ text: '💳 Direktno checkout', url: cartUrl + '?checkout' }]);
    }

    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard }
      });
      return true;
    } catch (error) {
      console.error('Failed to send Telegram notification:', error.message);
      return false;
    }
  }

  async sendAllInStockCartAlert(products, cartUrl) {
    if (!this.initialized || !this.chatId || !cartUrl || products.length <= 1) return false;
    const itemList = products.map(p => `• ${p.name}`).join('\n');
    try {
      await this.bot.sendMessage(this.chatId,
        `🛒 *Skupna košarica — ${products.length} izdelkov na zalogi:*\n\n${itemList}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: `🛒 Kupi vse (${products.length})`, url: cartUrl }],
              [{ text: '💳 Direktno checkout', url: cartUrl + '?checkout' }]
            ]
          }
        }
      );
      return true;
    } catch (error) {
      console.error('Failed to send combined cart alert:', error.message);
      return false;
    }
  }

  async sendPriceDropAlert(product, oldPrice, newPrice) {
    if (!this.initialized || !this.chatId) return false;
    const pctDrop = ((oldPrice - newPrice) / oldPrice * 100).toFixed(1);
    const message =
      '💰 *ZNIŽANJE CENE!*\n\n' +
      `📦 *${product.name}*\n` +
      `🏪 Trgovina: ${product.store}\n` +
      `💸 Stara cena: ~${oldPrice} ${product.currency || 'EUR'}~\n` +
      `✨ Nova cena: *${newPrice} ${product.currency || 'EUR'}*\n` +
      `📉 Znižanje: ${pctDrop}%\n` +
      `\n🔗 [Odpri izdelek](${product.url})`;
    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🛒 Kupi zdaj', url: product.url }]] }
      });
      return true;
    } catch (error) {
      console.error('Failed to send price drop notification:', error.message);
      return false;
    }
  }

  async sendPurchaseAttemptAlert(product, status, details) {
    if (!this.initialized || !this.chatId) return false;
    const emoji = status === 'success' ? '✅' : '⚠️';
    const message =
      `${emoji} *AVTOMATSKI NAKUP*\n\n` +
      `📦 *${product.name}*\n` +
      `🏪 Trgovina: ${product.store}\n` +
      `📋 Status: ${status}\n` +
      (details ? `📝 ${details}\n` : '') +
      `\n🔗 [Preveri](${product.url})`;
    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
      return true;
    } catch (error) {
      console.error('Failed to send purchase notification:', error.message);
      return false;
    }
  }

  async sendMessage(text) {
    if (!this.initialized || !this.chatId) return false;
    try {
      await this.bot.sendMessage(this.chatId, text, { parse_mode: 'Markdown' });
      return true;
    } catch (error) {
      console.error('Failed to send message:', error.message);
      return false;
    }
  }

  onManualCheckHandler(callback) {
    this.onManualCheck = callback;
  }

  getChatId() { return this.chatId; }
  getToken() { return this.currentToken || process.env.TELEGRAM_BOT_TOKEN || ''; }
  isReady() { return this.initialized && !!this.chatId; }

  async reinitialize(token, chatId) {
    await this._stopExisting();
    this.currentToken = token;
    if (chatId) this.chatId = chatId;
    return this.initialize(token, chatId || this.chatId);
  }

  async shutdown() {
    await this._stopExisting();
  }
}

module.exports = new TelegramService();
