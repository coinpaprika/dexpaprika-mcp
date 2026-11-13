// The upstream path gate, without a server: which identifiers may reach the API and which
// redirects may be followed with the key on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS_ID, NETWORK_ID, safeUpstreamUrl, upstreamRedirectTarget } from '../src/safe-path.js';

const BASE = 'https://api.example.test';

// Ids that the WHATWG parser leaves alone but another parser could read as a dot segment or a
// separator: path parameters, Unicode look-alikes of "." and "/", and characters some servers
// strip or truncate at. Every one must be refused before a request is made.
const LOOKALIKES = [
  '..;', '.;', '..;x', 'x;y=1', '0xabc;', 'a.b',
  '\u2024\u2024', '\u2025', '\uFF0E\uFF0E', '\u3002\u3002', '\uFE52\uFE52', '.\u200B.',
  '\uFF0E\uFF0E\uFF0Fkey\uFF0Finfo', 'x\u2215y', 'x\uFF0Fy',
  '..\u0000', '.. ', '..\t', '..\u00AD', 'x\u00ADy', '..?', 'x?y=1', 'x#y', 'a/b', '%2e%2e', '..\\x',
];

test('identifier arguments outside their alphabet are refused', () => {
  for (const id of LOOKALIKES) {
    assert.equal(ADDRESS_ID.test(id), false, JSON.stringify(id));
    assert.equal(NETWORK_ID.test(id), false, JSON.stringify(id));
  }
});

test('built paths carrying such ids are refused', () => {
  // A "?" in an id only shows up as a query here, so the argument check above covers it.
  for (const id of LOOKALIKES.filter((x) => !x.includes('?'))) {
    for (const endpoint of [
      `/networks/ethereum/pools/${id}`,
      `/networks/ethereum/pools/${id}/ohlcv?start=-24h`,
      `/networks/ethereum/tokens/${id}`,
      `/networks/ethereum/tokens/${id}/indicators`,
    ]) {
      assert.throws(() => safeUpstreamUrl(BASE, endpoint), /Invalid network, pool or token identifier/, JSON.stringify(endpoint));
    }
  }
});

test('network ids outside [a-z0-9_-] are refused', () => {
  for (const id of [...LOOKALIKES, 'Ethereum', 'eth:1']) {
    assert.throws(() => safeUpstreamUrl(BASE, `/networks/${id}/tokens/0xabc`), /Invalid/, JSON.stringify(id));
  }
});

test('real id formats still pass', () => {
  const ok = [
    '/networks/ethereum/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    '/networks/solana/tokens/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    '/networks/tron/tokens/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    '/networks/sui/tokens/0x2::sui::SUI',
    '/networks/aptos/tokens/0x1::aptos_coin::AptosCoin/ohlcv?start=-24h',
    '/networks/ton/pools/EQA-HvcTvVqAtDUylxk6cHhppXf-vbpqkqZcX4HFHSjYlDZW',
    '/networks/ton/tokens/EQCFd_1lGNp8l6BA17IULZM-s_6yWYDz2RdRwSqbt35eXA9I',
    '/networks/bob_network/dexes?page=1',
    '/networks/x_layer/pools/search?limit=10',
    '/usage',
  ];
  for (const endpoint of ok) assert.equal(safeUpstreamUrl(BASE, endpoint), `${BASE}${endpoint}`);
});

test('a redirect is followed only to an allowed path on the same origin', () => {
  const from = `${BASE}/networks/ethereum/tokens/0xabc`;
  assert.equal(
    upstreamRedirectTarget(BASE, from, '/networks/ethereum/tokens/0xdef'),
    `${BASE}/networks/ethereum/tokens/0xdef`,
  );
  for (const location of [
    '/outside/target', '../../../outside', '/networks/ethereum/tokens/..;', '/networks/ethereum/tokens/%EF%BC%8E%EF%BC%8E',
    'https://elsewhere.example.test/networks/ethereum/tokens/0xabc',
    'http://api.example.test/networks/ethereum/tokens/0xabc',
    '//elsewhere.example.test/networks', '', null,
  ]) {
    assert.equal(upstreamRedirectTarget(BASE, from, location), null, JSON.stringify(location));
  }
});

test('a redirect must stay under a base URL that carries a path', () => {
  const base = 'https://gw.example.test/dp';
  const from = `${base}/networks/ethereum/tokens/0xabc`;
  assert.equal(upstreamRedirectTarget(base, from, '/dp/networks/ethereum'), `${base}/networks/ethereum`);
  assert.equal(upstreamRedirectTarget(base, from, '/networks/ethereum'), null);
  assert.equal(upstreamRedirectTarget(base, from, '/dpx/networks/ethereum'), null);
});
