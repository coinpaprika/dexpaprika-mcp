// From 23 November 2026 the API answers 400 to a query key a route does not
// accept. Until then it ignores it, so a misspelled filter looks like an
// unfiltered page. These are the routes' accepted keys as the API defines them
// (dexpaprika-go internal/doc/all/static/api-rest.yml, 16 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolSearchParams, buildTokenSearchParams } from '../src/search-mapping.js';

const COMMON = [
  'created_after', 'created_before', 'cursor', 'detailed', 'limit', 'order_by', 'sort',
  'liquidity_usd_max', 'liquidity_usd_min', 'price_usd_max', 'price_usd_min',
  'txns_24h_max', 'txns_24h_min',
  'volume_usd_24h_max', 'volume_usd_24h_min', 'volume_usd_7d_max', 'volume_usd_7d_min',
  'volume_usd_30d_max', 'volume_usd_30d_min',
];
const WINDOWS = ['5m', '1h', '6h', '24h', '48h'].flatMap((w) => [
  `price_change_percentage_${w}_min`, `price_change_percentage_${w}_max`,
]);
const POOL_SEARCH = new Set([...COMMON, ...WINDOWS, 'dex_name', 'token_address']);
const TOKEN_SEARCH = new Set([
  ...COMMON, 'fdv_usd_max', 'fdv_usd_min',
  'price_change_percentage_24h_max', 'price_change_percentage_24h_min',
]);

// Every argument the tools pass through, plus a stray `query` and `page`.
const ARGS = {
  limit: 5, cursor: 'c', sort_by: 'volume_usd_24h', sort_dir: 'asc', query: 'weth', page: 2,
  token_address: '0xabc', dex_name: 'uniswap_v3',
  volume_24h_min: 1, volume_24h_max: 2, volume_7d_min: 1, volume_7d_max: 2,
  liquidity_usd_min: 1, liquidity_usd_max: 2, fdv_min: 1, fdv_max: 2, txns_24h_min: 1,
  created_after: '-1d', created_before: '-1h',
  ...Object.fromEntries(WINDOWS.map((k) => [k, 1])),
};

test('pool search sends only keys /pools/search accepts', () => {
  const sent = Object.keys(buildPoolSearchParams(ARGS)).filter((k) => !POOL_SEARCH.has(k));
  assert.deepEqual(sent, []);
});

test('token search sends only keys /tokens/search accepts, FDV as fdv_usd_*', () => {
  const params = buildTokenSearchParams(ARGS);
  assert.deepEqual(Object.keys(params).filter((k) => !TOKEN_SEARCH.has(k)), []);
  assert.equal(params.fdv_usd_min, 1);
  assert.equal(params.fdv_usd_max, 2);
});
