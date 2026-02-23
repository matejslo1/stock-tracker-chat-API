# Stock Tracker - Deploy na Railway

## Korak za korakom navodila

### 1. Ustvari GitHub repozitorij

1. Pojdi na **https://github.com/new**
2. Ime repozitorija: `stock-tracker`
3. Izberi **Private** (zasebni)
4. Klikni **Create repository**

### 2. Nalozi kodo na GitHub

Odpri terminal (CMD ali PowerShell) v mapi kjer je ta projekt:

```bash
cd pot/do/stock-tracker-railway

git init
git add .
git commit -m "Initial commit - Stock Tracker"
git branch -M main
git remote add origin https://github.com/TVOJ-USERNAME/stock-tracker.git
git push -u origin main
```

Zamenjaj `TVOJ-USERNAME` s tvojim GitHub uporabniskim imenom.

### 3. Deploy na Railway

1. Pojdi na **https://railway.app**
2. Klikni **Login** in izberi **Login with GitHub**
3. Klikni **New Project**
4. Izberi **Deploy from GitHub repo**
5. Najdi in izberi `stock-tracker` repozitorij
6. Railway bo avtomatsko zaznal Node.js projekt

### 4. Nastavi okoljske spremenljivke

V Railway dashboardu za tvoj projekt:

1. Klikni na servis (tvoj deployment)
2. Pojdi v **Variables** tab
3. Dodaj naslednje spremenljivke:

| Spremenljivka | Vrednost |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Tvoj token od @BotFather |
| `TELEGRAM_CHAT_ID` | Tvoj chat ID (ali pusti prazno - se zazna avtomatsko) |
| `CHECK_INTERVAL_MINUTES` | `5` |
| `KEYWORD_CHECK_INTERVAL_MINUTES` | `15` |
| `AUTO_PURCHASE_ENABLED` | `false` |
| `NODE_ENV` | `production` |

### 5. Generiraj domeno

1. V Railway dashboardu pojdi v **Settings** tab
2. Pod **Networking** klikni **Generate Domain**
3. Dobil bos URL kot: `stock-tracker-production-abc123.up.railway.app`
4. To je tvoj javni URL!

### 6. Povezi Telegram bota

1. Odpri Telegram
2. Pojdi na svojega bota
3. Poslji `/start`
4. Bot bo odgovoril in se povezal

### 7. Gotovo!

Tvoj Stock Tracker zdaj tece 24/7 na Railway!
Odpri URL iz koraka 5 v brskalniku za dostop do dashboarda.

---

## Pomembne informacije

### Brezplacni plan (Starter)
- **$5 kreditov/mesec** brezplacno (dovolj za to aplikacijo)
- 512 MB RAM
- Deluje 24/7 (brez sleep kot Render)

### Omejitve
- **Puppeteer NE deluje** na Railway brezplacnem planu
- Scraping deluje prek **Cheerio** (HTTP requests) - to zadostuje za Shopify trgovine
- Auto-purchase ne deluje na cloudu (potrebuje Puppeteer)
- Baza se resetira ob redeployu - za trajno shranjevanje dodaj Railway Volume

### Dodaj trajno shranjevanje (Volume)
1. V Railway dashboardu klikni **+ New** > **Volume**
2. Mount path: `/app/server/data`
3. To ohrani bazo med redeployi

### Posodobitev
Ko spremenis kodo lokalno:
```bash
git add .
git commit -m "Update"
git push
```
Railway avtomatsko redeploya!
