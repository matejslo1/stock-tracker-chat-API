const net = require('net');
const dns = require('dns').promises;

const DEFAULTS = {
  allowedProtocols: new Set(['https:', 'http:']),
  requireHttps: false,
  maxUrlLength: 2048,
  allowUserInfo: false,
  blockLocalhost: true,
  blockPrivateIps: true,
  resolveDns: true,
};

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}
function inRange(ip, start, end) {
  const x = ipv4ToInt(ip);
  return x >= ipv4ToInt(start) && x <= ipv4ToInt(end);
}
function isPrivateIpv4(ip) {
  return (
    inRange(ip, '10.0.0.0', '10.255.255.255') ||
    inRange(ip, '172.16.0.0', '172.31.255.255') ||
    inRange(ip, '192.168.0.0', '192.168.255.255') ||
    inRange(ip, '127.0.0.0', '127.255.255.255') ||
    inRange(ip, '169.254.0.0', '169.254.255.255') ||
    inRange(ip, '0.0.0.0', '0.255.255.255')
  );
}
function isPrivateIpv6(ip) {
  const lower = String(ip).toLowerCase();

  if (lower === '::1') return true; // loopback

  // unique local addresses fc00::/7 (fc00..fdff)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;

  // link-local fe80::/10 (fe8x..febx)
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;

  // IPv4-mapped IPv6: ::ffff:127.0.0.1
  const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m && isPrivateIpv4(m[1])) return true;

  return false;
}
function looksLocalHostname(hostname) {
  const h = String(hostname).toLowerCase();
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;
  if (h === '0') return true;
  if (h === 'metadata' || h.endsWith('.internal')) return true;
  return false;
}

async function hostnameResolvesToPrivateIp(hostname) {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  for (const r of results) {
    const addr = r.address;
    const family = net.isIP(addr);
    if (family === 4 && isPrivateIpv4(addr)) return true;
    if (family === 6 && isPrivateIpv6(addr)) return true;
  }
  return false;
}

async function validateAndNormalizeUrl(input, opts = {}) {
  const o = { ...DEFAULTS, ...opts };

  if (typeof input !== 'string') throw new Error('URL must be a string');

  const raw = input.trim();
  if (!raw) throw new Error('URL is empty');
  if (raw.length > o.maxUrlLength) throw new Error('URL is too long');

  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!o.allowedProtocols.has(u.protocol)) throw new Error('Unsupported URL protocol');
  if (o.requireHttps && u.protocol !== 'https:') throw new Error('Only https URLs are allowed');

  if (!o.allowUserInfo && (u.username || u.password)) {
    throw new Error('Userinfo in URL is not allowed');
  }

  const hostname = u.hostname;

  if (o.blockLocalhost && looksLocalHostname(hostname)) {
    throw new Error('Localhost/internal hostnames are not allowed');
  }

  const ipFamily = net.isIP(hostname);
  if (ipFamily === 4 && o.blockPrivateIps && isPrivateIpv4(hostname)) {
    throw new Error('Private IPs are not allowed');
  }
  if (ipFamily === 6 && o.blockPrivateIps && isPrivateIpv6(hostname)) {
    throw new Error('Private IPs are not allowed');
  }

  if (o.resolveDns && o.blockPrivateIps && ipFamily === 0) {
    const isPrivate = await hostnameResolvesToPrivateIp(hostname);
    if (isPrivate) throw new Error('Hostname resolves to a private IP');
  }

  // Normalize: remove hash and Shopify tracking params
  u.hash = '';
  const shopifyTrackingParams = ['_pos', '_sid', '_ss', '_ga', '_gl', 'ref', 'fbclid', 'gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  shopifyTrackingParams.forEach(p => u.searchParams.delete(p));
  // If no meaningful query params remain, remove the query string entirely
  if (u.searchParams.toString() === '') u.search = '';
  return u.toString();
}

module.exports = {
  validateAndNormalizeUrl,
  isPrivateIpv4,
  isPrivateIpv6,
};
