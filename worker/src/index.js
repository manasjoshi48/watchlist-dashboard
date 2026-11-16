// Price proxy for the watchlist dashboard.
// GET /quote?symbol=CRWD   -> { price, change, changePct, day, fetchedAt }
// GET /history?symbol=CRWD -> { symbol, points: [{ date, close }], fetchedAt }, oldest first
// Keeps the Finnhub and Twelve Data keys server-side and caches each symbol in KV.
// Quotes are cached for 5 minutes (Finnhub's limit is per minute, so a short cache
// is enough); a year of daily closes only changes once a day, so history is cached
// for 12 hours to stay well inside Twelve Data's daily credit allowance.

const ALLOWED_SYMBOLS = new Set(['CRWD', 'AMD', 'VST']);
const CACHE_TTL_SECONDS = 5 * 60;
const HISTORY_CACHE_TTL_SECONDS = 12 * 60 * 60;
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

// Upstream failures are mapped to our own messages; the provider's text and the
// key (sent in a request header) are never sent back to the caller.
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

// Returns { symbol } or { error: Response } for a missing or unsupported symbol.
function parseSymbol(url, cors) {
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!symbol) {
    return { error: json({ error: `Missing symbol parameter, e.g. ${url.pathname}?symbol=AMD` }, 400, cors) };
  }
  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return { error: json({ error: `Unsupported symbol "${symbol}". Allowed: ${[...ALLOWED_SYMBOLS].join(', ')}` }, 400, cors) };
  }
  return { symbol };
}

async function handleQuote(url, env, cors) {
  const { symbol, error } = parseSymbol(url, cors);
  if (error) return error;

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A year ago in New York, as YYYY-MM-DD. With a start_date set, Twelve Data returns
// every bar in range (outputsize defaults to its maximum), so this is ~252 trading days.
function oneYearAgo(now = new Date()) {
  const [y, m, d] = tradingDay.format(now).split('-').map(Number);
  // Date.UTC rolls Feb 29 over to Mar 1 in a non-leap year, which is fine here.
  return new Date(Date.UTC(y - 1, m - 1, d)).toISOString().slice(0, 10);
}

// Twelve Data: https://twelvedata.com/docs/market-data/time-series
// Success: { meta, values: [{ datetime, open, high, low, close, volume }], status: 'ok' }
// with every value a string. Errors are { code, message, status: 'error' }, and may
// arrive with HTTP 200, so the body's status/code is checked as well as res.status.
async function fetchFromTwelveData(symbol, apiKey) {
  const params = new URLSearchParams({
    symbol,
    interval: '1day',
    start_date: oneYearAgo(),
    order: 'asc',
  });
  const url = `https://api.twelvedata.com/time_series?${params}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { 'Authorization': `apikey ${apiKey}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    throw new UpstreamError(
      timedOut ? 504 : 502,
      timedOut ? 'History provider timed out' : 'Could not reach history provider',
      err.name,
    );
  }

  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  const code = res.ok && body && body.status === 'error' ? Number(body.code) : res.status;
  if (code === 429) {
    throw new UpstreamError(429, 'History provider rate limit reached, try again later', 'code 429');
  }
  if (!res.ok || (body && body.status === 'error')) {
    throw new UpstreamError(502, 'History provider returned an error', `code ${code}`);
  }
  if (body === undefined) {
    throw new UpstreamError(502, 'History provider returned an unreadable response', 'invalid JSON');
  }

  const values = Array.isArray(body?.values) ? body.values : [];
  const points = [];
  for (const v of values) {
    const date = typeof v?.datetime === 'string' ? v.datetime.slice(0, 10) : '';
    const close = Number(v?.close);
    if (ISO_DATE.test(date) && Number.isFinite(close) && close > 0) points.push({ date, close });
  }
  if (points.length === 0) {
    throw new UpstreamError(502, 'History provider returned no prices', `no usable values (${values.length} raw)`);
  }
  // order=asc is requested, but sort anyway so the oldest-first contract doesn't
  // depend on the provider honouring it.
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { symbol, points, fetchedAt: Date.now() };
}

async function handleHistory(url, env, cors) {
  const { symbol, error } = parseSymbol(url, cors);
  if (error) return error;

  const cacheKey = `history:${symbol}`;
  const cached = await env.QUOTES.get(cacheKey, 'json');
  if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_SECONDS * 1000) {
    return json(cached, 200, { ...cors, 'X-Cache': 'HIT' });
  }

  if (!env.TWELVE_DATA_KEY) {
    console.error('TWELVE_DATA_KEY secret is not set');
    return json({ error: 'Server is not configured' }, 500, { ...cors, 'X-Cache': 'MISS' });
  }

  try {
    const history = await fetchFromTwelveData(symbol, env.TWELVE_DATA_KEY);
    await env.QUOTES.put(cacheKey, JSON.stringify(history), { expirationTtl: HISTORY_CACHE_TTL_SECONDS });
    return json(history, 200, { ...cors, 'X-Cache': 'MISS' });
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    const detail = err.message.replaceAll(env.TWELVE_DATA_KEY, '[redacted]');
    console.error(`Twelve Data failed for ${symbol}: ${detail}`);
    const headers = { ...cors, 'X-Cache': 'MISS' };
    if (err.status === 429) headers['Retry-After'] = '60';
    return json({ error: err.publicMessage }, err.status, headers);
  }
}

const ROUTES = { '/quote': handleQuote, '/history': handleHistory };

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
    const handler = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
    if (!handler) {
      return json({ error: 'Not found. Use GET /quote?symbol=XXX or /history?symbol=XXX' }, 404, cors);
    }

    try {
      return await handler(url, env, cors);
    } catch (err) {
      console.error('Unexpected error:', err.name);
      return json({ error: 'Internal error' }, 500, cors);
    }
  },
};
