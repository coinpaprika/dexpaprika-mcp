import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanRequired, PAID_BASE_URL } from '../src/http-config.js';

// The body the API sends a keyless caller on /transactions and token OHLCV,
// captured on 2026-10-02.
const LIVE = '{"error":"plan_required","tier":"keyless","message":"this endpoint requires a Dev or Pro plan","required_tier":"dev","links":{"coupon":"https://dexpaprika.com/api/pricing?coupon=START10","docs":"https://docs.dexpaprika.com/","pricing":"https://dexpaprika.com/api/pricing","register":"https://console.dexpaprika.com"}}';

test('reads the tier and message from a live plan_required body', () => {
  assert.deepEqual(parsePlanRequired(LIVE), {
    requiredTier: 'dev',
    message: 'this endpoint requires a Dev or Pro plan',
  });
});

test('a plan_required body without required_tier still matches', () => {
  assert.deepEqual(parsePlanRequired('{"error":"plan_required"}'), { requiredTier: null, message: null });
});

// Other 403s carry their own advice (an OHLCV window, a wrong host) and must
// not be relabelled as a plan problem.
test('a different 403 is not a plan refusal', () => {
  assert.equal(parsePlanRequired('{"error":"wrong_host","message":"use api.dexpaprika.com"}'), null);
  assert.equal(parsePlanRequired('{"message":"OHLCV history beyond the last 24 hours requires an API key"}'), null);
});

test('an HTML block page, an empty body or garbage is null', () => {
  assert.equal(parsePlanRequired('<!DOCTYPE html><title>Sorry, you have been blocked</title>'), null);
  assert.equal(parsePlanRequired(''), null);
  assert.equal(parsePlanRequired(undefined), null);
  assert.equal(parsePlanRequired('null'), null);
});

test('the paid origin is api-pro', () => {
  assert.equal(PAID_BASE_URL, 'https://api-pro.dexpaprika.com');
});
