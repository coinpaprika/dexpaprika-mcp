// The pool sort list must match the enum the REST layer returns in its 400
// body. A field missing from the mapping does not error: it falls through to
// volume_usd_24h, so the caller gets a page sorted by something else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPoolSortField, mapTokenSortField } from '../src/search-mapping.js';

const POOL_SORT_FIELDS = [
  'volume_usd_24h', 'volume_usd_7d', 'volume_usd_30d', 'liquidity_usd', 'txns_24h',
  'created_at', 'price_usd', 'price_change_percentage_24h', 'price_change_percentage_6h',
  'price_change_percentage_48h', 'price_change_percentage_1h', 'price_change_percentage_5m',
];

test('every pool sort field the API accepts passes through unchanged', () => {
  for (const field of POOL_SORT_FIELDS) assert.equal(mapPoolSortField(field), field);
});

test('the 48h window stays pool-only', () => {
  assert.equal(mapTokenSortField('price_change_percentage_48h'), 'volume_usd_24h');
});
