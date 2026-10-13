// The API refuses a parameter that belongs to another indicator (fast_period
// on rsi is a 400), so the request must carry only what the caller set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indicatorQuery, poolIndicatorPath, tokenIndicatorPath } from '../src/indicators.js';

test('sends only what the caller set, in a fixed order', () => {
  assert.equal(indicatorQuery({ interval: '1h', indicator: 'rsi', period: 7 }), '?indicator=rsi&interval=1h&period=7');
});

test('never fills in parameters of another indicator', () => {
  const q = indicatorQuery({ indicator: 'rsi', interval: '1h' });
  for (const k of ['fast_period', 'slow_period', 'signal_period', 'std_dev', 'period']) assert.ok(!q.includes(k), k);
});

test('drops undefined, null, empty strings and unknown keys such as rationale', () => {
  assert.equal(indicatorQuery({ indicator: 'ema', start: '', end: undefined, cursor: null, rationale: 'x', inversed: true }), '?indicator=ema');
});

test('encodes values', () => {
  assert.equal(
    indicatorQuery({ indicator: 'bbands', start: '2026-10-13T00:00:00Z', std_dev: 2.5 }),
    '?indicator=bbands&start=2026-10-13T00%3A00%3A00Z&std_dev=2.5',
  );
});

test('pool and token paths', () => {
  assert.equal(poolIndicatorPath('ethereum', '0xp', { indicator: 'vwap' }), '/networks/ethereum/pools/0xp/indicators?indicator=vwap');
  assert.equal(tokenIndicatorPath('solana', 'So1', { indicator: 'macd', fast_period: 8 }), '/networks/solana/tokens/So1/indicators?indicator=macd&fast_period=8');
});
