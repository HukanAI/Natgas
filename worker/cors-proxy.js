// worker/cors-proxy.js — optional self-hosted CORS proxy (Cloudflare Worker).
//
// The dashboard works without this, using public proxies. But public proxies are
// what broke the app in the first place: corsproxy.io started demanding an API
// key, thingproxy's domain stopped resolving, and allorigins rate-limits the
// startup burst. Deploying this removes that dependency entirely.
//
// Deploy:  npx wrangler deploy worker/cors-proxy.js --name natgas-cors
// Enable:  open the dashboard and run in the browser console —
//   localStorage.setItem('ng_proxy_self', 'https://natgas-cors.<subdomain>.workers.dev/')
// Disable: localStorage.removeItem('ng_proxy_self')
//
// js/proxy.js calls it as:  <worker>/?url=<encoded target>

// Only these hosts can be fetched. Without an allowlist this would be an open
// relay that anyone could point at any server.
const ALLOWED_HOSTS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'www.bing.com',
  'oilprice.com',
  'www.eia.gov',
  'news.google.com',
];

// Restrict who may call the worker. Add your own origins here.
const ALLOWED_ORIGINS = [
  'https://hukanai.github.io',
  'http://localhost:8099',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('Missing ?url=', { status: 400, headers: cors });

    let parsed;
    try { parsed = new URL(target); }
    catch (e) { return new Response('Malformed url', { status: 400, headers: cors }); }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return new Response('Unsupported scheme', { status: 400, headers: cors });
    }
    if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
      return new Response('Host not allowed: ' + parsed.hostname, { status: 403, headers: cors });
    }

    try {
      const upstream = await fetch(parsed.toString(), {
        // A browser-ish UA keeps Yahoo and the news feeds from serving bot pages.
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NatGasDashboard/1.0)',
          'Accept': request.headers.get('Accept') || '*/*',
        },
        // Short edge cache absorbs the dashboard's repeated polling.
        cf: { cacheTtl: 30, cacheEverything: true },
      });

      const headers = new Headers(cors);
      const ct = upstream.headers.get('Content-Type');
      if (ct) headers.set('Content-Type', ct);
      headers.set('Cache-Control', 'no-store');

      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) {
      return new Response('Upstream fetch failed: ' + e.message, { status: 502, headers: cors });
    }
  },
};
