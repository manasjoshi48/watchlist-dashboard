// Quote proxy for the watchlist dashboard.
// GET /quote?symbol=CRWD -> { price, change, changePct, day, fetchedAt }
// Keeps the Finnhub key server-side and caches each symbol in KV for 5 minutes;
// Finnhub's limit is per minute, so a short cache is enough to stay under it.

const ALLOWED_SYMBOLS = new Set(['CRWD', 'AMD', 'VST']);
const CACHE_TTL_SECONDS = 5 * 60;
const UPSTREAM_TIMEOUT_MS = 10_000;

// Origin is checked server-side as well as via CORS. Browsers always send it on
// cross-origin fetches; anything outside a browser can fake it, so this keeps other
// websites from using the Worker but is not authentication.
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === 'https://manasjoshi48.github.io') return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Cache',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// Upstream failures are mapped to our own messages; Finnhub's text and the key
// (sent in a request header) are never sent back to the caller.
class UpstreamError extends Error {
  constructor(status, publicMessage, detail) {
    super(detail);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

// Finnhub's `t` is a Unix timestamp in seconds. The trading day is the date in
// New York, not UTC, so a late-afternoon trade isn't labeled as the next day.
const tradingDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

async function fetchFromFinnhub(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { 'X-Finnhub-Token': apiKey },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    throw new UpstreamError(
      timedOut ? 504 : 502,
      timedOut ? 'Price provider timed out' : 'Could not reach price provider',
      err.name,
    );
  }
  if (res.status === 429) {
    throw new UpstreamError(429, 'Price provider rate limit reached, try again later', 'HTTP 429');
  }
  if (!res.ok) {
    throw new UpstreamError(502, 'Price provider returned an error', `HTTP ${res.status}`);
  }

  let q;
  try {
    q = await res.json();
  } catch {
    throw new UpstreamError(502, 'Price provider returned an unreadable response', 'invalid JSON');
  }

  // An unknown symbol comes back as HTTP 200 with c, t, etc. all 0 (and d/dp null).
  const { c: price, d: change, dp: changePct, t } = q || {};
  if (!(price > 0) || !(t > 0) || !Number.isFinite(change) || !Number.isFinite(changePct)) {
    throw new UpstreamError(502, 'Price provider returned no quote', 'empty or zero quote');
  }
  return {
    price,
    change,
    changePct,
    day: tradingDay.format(new Date(t * 1000)),
    fetchedAt: Date.now(),
  };
}

async function handleQuote(url, env, cors) {
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!symbol) {
    return json({ error: 'Missing symbol parameter, e.g. /quote?symbol=AMD' }, 400, cors);
  }
  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return json({ error: `Unsupported symbol "${symbol}". Allowed: ${[...ALLOWED_SYMBOLS].join(', ')}` }, 400, cors);
  }

  const cacheKey = `quote:${symbol}`;
  const cached = await env.QUOTES.get(cacheKey, 'json');
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_SECONDS * 1000) {
    return json(cached, 200, { ...cors, 'X-Cache': 'HIT' });
  }

  if (!env.FINNHUB_KEY) {
    console.error('FINNHUB_KEY secret is not set');
    return json({ error: 'Server is not configured' }, 500, { ...cors, 'X-Cache': 'MISS' });
  }

  try {
    const quote = await fetchFromFinnhub(symbol, env.FINNHUB_KEY);
    await env.QUOTES.put(cacheKey, JSON.stringify(quote), { expirationTtl: CACHE_TTL_SECONDS });
    return json(quote, 200, { ...cors, 'X-Cache': 'MISS' });
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    // Redact in case upstream text ever echoes the key back.
    const detail = err.message.replaceAll(env.FINNHUB_KEY, '[redacted]');
    console.error(`Finnhub failed for ${symbol}: ${detail}`);
    const headers = { ...cors, 'X-Cache': 'MISS' };
    if (err.status === 429) headers['Retry-After'] = '60';
    return json({ error: err.publicMessage }, err.status, headers);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (!isAllowedOrigin(origin)) {
      return json({ error: 'Origin not allowed' }, 403);
    }
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, { ...cors, 'Allow': 'GET, OPTIONS' });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/quote') {
      return json({ error: 'Not found. Use GET /quote?symbol=XXX' }, 404, cors);
    }

    try {
      return await handleQuote(url, env, cors);
    } catch (err) {
      console.error('Unexpected error:', err.name);
      return json({ error: 'Internal error' }, 500, cors);
    }
  },
};
