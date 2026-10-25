// Run with `npm test`. Stubs global fetch and the QUOTES KV binding; no network.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const KEY = 'test-finnhub-key';
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
  env = { FINNHUB_KEY: KEY, QUOTES: fakeKV() };
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
});
