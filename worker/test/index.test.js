// Run with `npm test`. Stubs global fetch and the QUOTES KV binding; no network.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const KEY = 'test-finnhub-key';
const TD_KEY = 'test-twelvedata-key';
const ORIGIN = 'https://manasjoshi48.github.io';
const realFetch = globalThis.fetch;
const realConsoleError = console.error;

// 2026-10-23 15:59:59 in New York = 19:59:59 UTC (EDT, UTC-4).
const FRIDAY_CLOSE = Date.UTC(2026, 9, 23, 19, 59, 59) / 1000;
const GOOD_QUOTE = { c: 161.5, d: 2.25, dp: 1.4129, h: 162, l: 158.1, o: 159, pc: 159.25, t: FRIDAY_CLOSE };
const UNKNOWN_SYMBOL = { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 };

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    puts: [],
    async get(key, type) {
      const v = store.get(key);
      return v == null ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, opts) {
      this.puts.push({ key, value, opts });
      store.set(key, value);
    },
  };
}

let calls, logs, env;
function upstream(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
}
const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function request(path, { origin = ORIGIN, method = 'GET' } = {}) {
  const headers = origin ? { Origin: origin } : {};
  return worker.fetch(new Request(`https://worker.example${path}`, { method, headers }), env);
}

beforeEach(() => {
  calls = [];
  logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  env = { FINNHUB_KEY: KEY, TWELVE_DATA_KEY: TD_KEY, QUOTES: fakeKV() };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

test('returns the same shape as before, from Finnhub fields', async () => {
  upstream(() => jsonRes(GOOD_QUOTE));
  const res = await request('/quote?symbol=amd');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Cache'), 'MISS');
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['change', 'changePct', 'day', 'fetchedAt', 'price']);
  assert.equal(body.price, 161.5);
  assert.equal(body.change, 2.25);
  assert.equal(body.changePct, 1.4129);
  assert.equal(body.day, '2026-10-23');
  assert.ok(Math.abs(body.fetchedAt - Date.now()) < 5000);
});

test('derives day in New York time, not UTC', async () => {
  // 21:30 New York on Oct 23 is already Oct 24 in UTC.
  upstream(() => jsonRes({ ...GOOD_QUOTE, t: Date.UTC(2026, 9, 24, 1, 30) / 1000 }));
  const body = await (await request('/quote?symbol=AMD')).json();
  assert.equal(body.day, '2026-10-23');
});

test('sends the key in X-Finnhub-Token, never in the URL', async () => {
  upstream(() => jsonRes(GOOD_QUOTE));
  await request('/quote?symbol=CRWD');
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://finnhub.io/api/v1/quote?symbol=CRWD');
  assert.ok(!url.includes(KEY));
  assert.equal(new Headers(init.headers).get('X-Finnhub-Token'), KEY);
});

test('caches in KV for 5 minutes', async () => {
  upstream(() => jsonRes(GOOD_QUOTE));
  await request('/quote?symbol=VST');
  assert.equal(env.QUOTES.puts.length, 1);
  assert.equal(env.QUOTES.puts[0].key, 'quote:VST');
  assert.equal(env.QUOTES.puts[0].opts.expirationTtl, 300);

  const res = await request('/quote?symbol=VST');
  assert.equal(res.headers.get('X-Cache'), 'HIT');
  assert.equal(calls.length, 1);
});

test('refetches once a cached quote is older than 5 minutes', async () => {
  const stale = { price: 1, change: 0, changePct: 0, day: '2026-10-22', fetchedAt: Date.now() - 301_000 };
  env.QUOTES = fakeKV({ 'quote:AMD': JSON.stringify(stale) });
  upstream(() => jsonRes(GOOD_QUOTE));
  const res = await request('/quote?symbol=AMD');
  assert.equal(res.headers.get('X-Cache'), 'MISS');
  assert.equal((await res.json()).price, 161.5);
  assert.equal(calls.length, 1);
});

test('treats the all-zero unknown-symbol response as an error and does not cache it', async () => {
  upstream(() => jsonRes(UNKNOWN_SYMBOL));
  const res = await request('/quote?symbol=AMD');
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'Price provider returned no quote' });
  assert.equal(env.QUOTES.puts.length, 0);
});

test('treats an empty object as an error', async () => {
  upstream(() => jsonRes({}));
  const res = await request('/quote?symbol=AMD');
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'Price provider returned no quote' });
});

test('maps 429 to the rate-limit message with Retry-After', async () => {
  upstream(() => jsonRes({ error: `API limit reached for ${KEY}` }, 429));
  const res = await request('/quote?symbol=AMD');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.deepEqual(await res.json(), { error: 'Price provider rate limit reached, try again later' });
  assert.equal(env.QUOTES.puts.length, 0);
});

test('maps other upstream statuses to a generic error without leaking upstream text', async () => {
  upstream(() => jsonRes({ error: `Invalid API key ${KEY}` }, 401));
  const res = await request('/quote?symbol=AMD');
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.equal(text, JSON.stringify({ error: 'Price provider returned an error' }));
  assert.ok(!text.includes(KEY));
});

test('maps unreadable JSON, network failure and timeout', async () => {
  upstream(() => new Response('<html>oops</html>', { status: 200 }));
  let res = await request('/quote?symbol=AMD');
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'Price provider returned an unreadable response' });

  upstream(() => { throw new TypeError('fetch failed'); });
  res = await request('/quote?symbol=AMD');
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'Could not reach price provider' });

  upstream(() => { throw new DOMException('timed out', 'TimeoutError'); });
  res = await request('/quote?symbol=AMD');
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: 'Price provider timed out' });
});

test('redacts the key from logged error details', async () => {
  upstream(() => { throw Object.assign(new Error('x'), { name: `Err-${KEY}` }); });
  await request('/quote?symbol=AMD');
  assert.ok(logs.length > 0);
  assert.ok(logs.every(l => !l.includes(KEY)));
  assert.ok(logs.some(l => l.includes('[redacted]')));
});

test('returns 500 when FINNHUB_KEY is not set, without calling upstream', async () => {
  delete env.FINNHUB_KEY;
  upstream(() => jsonRes(GOOD_QUOTE));
  const res = await request('/quote?symbol=AMD');
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'Server is not configured' });
  assert.equal(calls.length, 0);
});

test('keeps the origin check', async () => {
  upstream(() => jsonRes(GOOD_QUOTE));
  for (const origin of [null, 'https://evil.example', 'http://localhost.evil.example']) {
    const res = await request('/quote?symbol=AMD', { origin });
    assert.equal(res.status, 403);
  }
  const local = await request('/quote?symbol=AMD', { origin: 'http://localhost:8000' });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
  assert.equal(calls.length, 1);
});

test('keeps the symbol allow-list', async () => {
  upstream(() => jsonRes(GOOD_QUOTE));
  let res = await request('/quote?symbol=AAPL');
  assert.equal(res.status, 400);
  res = await request('/quote');
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('keeps CORS preflight, method and path handling', async () => {
  assert.equal((await request('/quote', { method: 'OPTIONS' })).status, 204);
  assert.equal((await request('/quote', { method: 'POST' })).status, 405);
  assert.equal((await request('/other')).status, 404);
  assert.equal((await request('/constructor')).status, 404);
});

// ---- /history (Twelve Data time_series) ----

const tdValue = (datetime, close) =>
  ({ datetime, open: '1.0', high: '1.0', low: '1.0', close, volume: '100' });
const GOOD_SERIES = {
  meta: { symbol: 'AMD', interval: '1day', currency: 'USD', exchange_timezone: 'America/New_York', exchange: 'NASDAQ', mic_code: 'XNGS', type: 'Common Stock' },
  values: [
    tdValue('2025-11-17', '240.10000'),
    tdValue('2025-11-18', '238.50000'),
    tdValue('2025-11-19', '242.75000'),
  ],
  status: 'ok',
};
const tdError = (code, message) => ({ code, message, status: 'error' });

test('history: returns { symbol, points, fetchedAt } oldest first with numeric closes', async () => {
  upstream(() => jsonRes(GOOD_SERIES));
  const res = await request('/history?symbol=amd');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Cache'), 'MISS');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['fetchedAt', 'points', 'symbol']);
  assert.equal(body.symbol, 'AMD');
  assert.deepEqual(body.points, [
    { date: '2025-11-17', close: 240.1 },
    { date: '2025-11-18', close: 238.5 },
    { date: '2025-11-19', close: 242.75 },
  ]);
  assert.ok(Math.abs(body.fetchedAt - Date.now()) < 5000);
});

test('history: sorts oldest first even if upstream returns newest first, and skips bad rows', async () => {
  upstream(() => jsonRes({
    ...GOOD_SERIES,
    values: [
      tdValue('2025-11-19', '242.75'),
      tdValue('2025-11-18', 'NaN'),
      tdValue('not-a-date', '1'),
      tdValue('2025-11-17', '240.1'),
    ],
  }));
  const body = await (await request('/history?symbol=AMD')).json();
  assert.deepEqual(body.points.map(p => p.date), ['2025-11-17', '2025-11-19']);
});

test('history: asks for ~1 year of daily bars, key in Authorization header, never in the URL', async () => {
  upstream(() => jsonRes(GOOD_SERIES));
  await request('/history?symbol=CRWD');
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://api.twelvedata.com/time_series');
  assert.equal(u.searchParams.get('symbol'), 'CRWD');
  assert.equal(u.searchParams.get('interval'), '1day');
  assert.equal(u.searchParams.get('order'), 'asc');
  assert.equal(u.searchParams.get('apikey'), null);
  const start = Date.parse(u.searchParams.get('start_date'));
  const days = (Date.now() - start) / 86_400_000;
  assert.ok(days > 363 && days < 368, `start_date ${days} days ago`);
  assert.ok(!url.includes(TD_KEY));
  assert.equal(new Headers(init.headers).get('Authorization'), `apikey ${TD_KEY}`);
});

test('history: caches under history:SYMBOL for 12 hours, separately from quotes', async () => {
  upstream(() => jsonRes(GOOD_SERIES));
  await request('/history?symbol=VST');
  assert.equal(env.QUOTES.puts.length, 1);
  assert.equal(env.QUOTES.puts[0].key, 'history:VST');
  assert.equal(env.QUOTES.puts[0].opts.expirationTtl, 12 * 60 * 60);

  const res = await request('/history?symbol=VST');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Cache'), 'HIT');
  assert.equal((await res.json()).points.length, 3);
  assert.equal(calls.length, 1);

  // A cached quote for the same symbol is not mistaken for history.
  upstream(() => jsonRes(GOOD_QUOTE));
  const q = await request('/quote?symbol=VST');
  assert.equal(q.headers.get('X-Cache'), 'MISS');
});

test('history: refetches once the cached entry is older than 12 hours', async () => {
  const stale = { symbol: 'AMD', points: [{ date: '2025-01-01', close: 1 }], fetchedAt: Date.now() - 12 * 3600_000 - 1000 };
  env.QUOTES = fakeKV({ 'history:AMD': JSON.stringify(stale) });
  upstream(() => jsonRes(GOOD_SERIES));
  const res = await request('/history?symbol=AMD');
  assert.equal(res.headers.get('X-Cache'), 'MISS');
  assert.equal((await res.json()).points.length, 3);
  assert.equal(calls.length, 1);
});

test('history: maps a 429 in the body (HTTP 200) or status to rate-limit, not cached', async () => {
  for (const make of [
    () => jsonRes(tdError(429, `You have run out of API credits for ${TD_KEY}`), 200),
    () => jsonRes(tdError(429, 'limit'), 429),
  ]) {
    upstream(make);
    const res = await request('/history?symbol=AMD');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '60');
    assert.equal(res.headers.get('X-Cache'), 'MISS');
    const text = await res.text();
    assert.equal(text, JSON.stringify({ error: 'History provider rate limit reached, try again later' }));
  }
  assert.equal(env.QUOTES.puts.length, 0);
});

test('history: maps other error bodies and statuses to a generic error without leaking text', async () => {
  for (const make of [
    () => jsonRes(tdError(401, `Invalid apikey ${TD_KEY}`), 200),
    () => jsonRes(tdError(404, 'symbol not found'), 200),
    () => jsonRes(tdError(401, `Invalid apikey ${TD_KEY}`), 401),
    () => new Response('<html>bad gateway</html>', { status: 502 }),
  ]) {
    upstream(make);
    const res = await request('/history?symbol=AMD');
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.equal(text, JSON.stringify({ error: 'History provider returned an error' }));
    assert.ok(!text.includes(TD_KEY));
  }
  assert.equal(env.QUOTES.puts.length, 0);
  assert.ok(logs.every(l => !l.includes(TD_KEY)));
});

test('history: maps unreadable JSON, empty series, network failure and timeout; caches none', async () => {
  const cases = [
    [() => new Response('<html>oops</html>', { status: 200 }), 502, 'History provider returned an unreadable response'],
    [() => jsonRes(null), 502, 'History provider returned no prices'],
    [() => jsonRes({ meta: GOOD_SERIES.meta, values: [], status: 'ok' }), 502, 'History provider returned no prices'],
    [() => jsonRes({ status: 'ok' }), 502, 'History provider returned no prices'],
    [() => { throw new TypeError('fetch failed'); }, 502, 'Could not reach history provider'],
    [() => { throw new DOMException('timed out', 'TimeoutError'); }, 504, 'History provider timed out'],
  ];
  for (const [make, status, error] of cases) {
    upstream(make);
    const res = await request('/history?symbol=AMD');
    assert.equal(res.status, status, error);
    assert.deepEqual(await res.json(), { error });
  }
  assert.equal(env.QUOTES.puts.length, 0);
});

test('history: redacts the key from logged error details', async () => {
  upstream(() => { throw Object.assign(new Error('x'), { name: `Err-${TD_KEY}` }); });
  await request('/history?symbol=AMD');
  assert.ok(logs.length > 0);
  assert.ok(logs.every(l => !l.includes(TD_KEY)));
  assert.ok(logs.some(l => l.includes('[redacted]')));
});

test('history: returns 500 when TWELVE_DATA_KEY is not set, without calling upstream', async () => {
  delete env.TWELVE_DATA_KEY;
  upstream(() => jsonRes(GOOD_SERIES));
  const res = await request('/history?symbol=AMD');
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'Server is not configured' });
  assert.equal(calls.length, 0);
});

test('history: keeps the origin check and symbol allow-list', async () => {
  upstream(() => jsonRes(GOOD_SERIES));
  for (const origin of [null, 'https://evil.example']) {
    assert.equal((await request('/history?symbol=AMD', { origin })).status, 403);
  }
  assert.equal((await request('/history?symbol=AAPL')).status, 400);
  const missing = await request('/history');
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /\/history\?symbol=AMD/);
  assert.equal((await request('/history', { method: 'OPTIONS' })).status, 204);
  assert.equal((await request('/history?symbol=AMD', { method: 'POST' })).status, 405);
  assert.equal(calls.length, 0);
});
