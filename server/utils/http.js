const axios = require('axios');

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];
const getUA = () => userAgents[Math.floor(Math.random() * userAgents.length)];

// Per-domain request timestamps for rate limiting
const domainLastRequest = {};
const MIN_DOMAIN_INTERVAL_MS = parseInt(process.env.MIN_REQUEST_INTERVAL_MS || '1500', 10);

async function waitForDomain(hostname) {
  const now = Date.now();
  const last = domainLastRequest[hostname] || 0;
  const elapsed = now - last;
  if (elapsed < MIN_DOMAIN_INTERVAL_MS) {
    const wait = MIN_DOMAIN_INTERVAL_MS - elapsed + Math.random() * 500;
    await new Promise(r => setTimeout(r, wait));
  }
  domainLastRequest[hostname] = Date.now();
}

// Centralized axios instance
const http = axios.create({
  timeout: parseInt(process.env.HTTP_TIMEOUT_MS || '15000', 10),
  maxRedirects: 5,
  maxContentLength: parseInt(process.env.HTTP_MAX_CONTENT_LENGTH || String(1024 * 1024 * 4), 10), // 4MB
  maxBodyLength: parseInt(process.env.HTTP_MAX_BODY_LENGTH || String(1024 * 1024 * 2), 10),
  validateStatus: (status) => status >= 200 && status < 400,
  headers: {
    'User-Agent': getUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'sl-SI,sl;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  },
});

// Wrap get() with retry + exponential backoff on 429 / 5xx
const originalGet = http.get.bind(http);

http.get = async function(url, config = {}, _retryCount = 0) {
  // Per-domain throttle
  try {
    const hostname = new URL(url).hostname;
    await waitForDomain(hostname);
  } catch(e) {}

  // Rotate User-Agent on every request
  const mergedConfig = {
    ...config,
    headers: {
      'User-Agent': getUA(),
      ...config.headers,
    }
  };

  try {
    const response = await originalGet(url, mergedConfig);
    return response;
  } catch(err) {
    const status = err.response?.status;

    // 429 Too Many Requests — back off and retry
    if (status === 429 && _retryCount < 3) {
      const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
      // Exponential backoff: 5s, 15s, 45s (+ retryAfter header if present)
      const backoff = Math.max(retryAfter * 1000, [5000, 15000, 45000][_retryCount]);
      console.log(`  ⏳ 429 from ${url} — waiting ${backoff/1000}s before retry ${_retryCount + 1}/3...`);
      await new Promise(r => setTimeout(r, backoff));
      return http.get(url, config, _retryCount + 1);
    }

    // 503 / 502 transient errors — short retry
    if ((status === 503 || status === 502) && _retryCount < 2) {
      const backoff = [3000, 8000][_retryCount];
      console.log(`  ⏳ ${status} from ${url} — waiting ${backoff/1000}s before retry...`);
      await new Promise(r => setTimeout(r, backoff));
      return http.get(url, config, _retryCount + 1);
    }

    throw err;
  }
};

// Also patch post() for shopify-cart.js usage
const originalPost = http.post.bind(http);
http.post = async function(url, data, config = {}, _retryCount = 0) {
  try {
    const hostname = new URL(url).hostname;
    await waitForDomain(hostname);
  } catch(e) {}

  const mergedConfig = {
    ...config,
    headers: { 'User-Agent': getUA(), ...config.headers }
  };

  try {
    return await originalPost(url, data, mergedConfig);
  } catch(err) {
    const status = err.response?.status;
    if (status === 429 && _retryCount < 2) {
      const backoff = [8000, 20000][_retryCount];
      console.log(`  ⏳ 429 POST from ${url} — waiting ${backoff/1000}s...`);
      await new Promise(r => setTimeout(r, backoff));
      return http.post(url, data, config, _retryCount + 1);
    }
    throw err;
  }
};

module.exports = http;
