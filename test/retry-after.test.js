import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryAfterSeconds } from '../src/http-config.js';

/** Minimal stand-in for the Headers interface fetch hands back. */
const headers = (value) => ({ get: (name) => (name === 'retry-after' ? value : null) });

const NOW = Date.parse('2026-08-14T12:00:00Z');

test('reads delta-seconds, the form our API sends', () => {
  assert.equal(parseRetryAfterSeconds(headers('20')), 20);
});

test('surrounding whitespace does not defeat it', () => {
  assert.equal(parseRetryAfterSeconds(headers('  20  ')), 20);
});

test('a fractional value rounds up rather than truncating into a busy retry', () => {
  assert.equal(parseRetryAfterSeconds(headers('1.2')), 2);
});

test('a negative value clamps to zero rather than scheduling a retry in the past', () => {
  assert.equal(parseRetryAfterSeconds(headers('-5')), 0);
});

test('an HTTP-date is converted against the supplied clock', () => {
  assert.equal(parseRetryAfterSeconds(headers('Fri, 14 Aug 2026 12:00:30 GMT'), NOW), 30);
});

test('an HTTP-date already in the past clamps to zero', () => {
  assert.equal(parseRetryAfterSeconds(headers('Fri, 14 Aug 2026 11:59:00 GMT'), NOW), 0);
});

// Null means "we do not know". The caller must say so rather than substitute a
// guess: a guessed value is what produced the wait-until-midnight advice that
// this replaced, which told agents to give up for hours on a per-minute limit.
test('a missing header is null, not a guess', () => {
  assert.equal(parseRetryAfterSeconds(headers(null)), null);
});

test('an empty header is null', () => {
  assert.equal(parseRetryAfterSeconds(headers('   ')), null);
});

test('an unparseable header is null', () => {
  assert.equal(parseRetryAfterSeconds(headers('soon')), null);
});

test('a response with no headers object at all does not throw', () => {
  for (const value of [undefined, null, {}]) {
    assert.equal(parseRetryAfterSeconds(value), null);
  }
});

test('never returns the multi-hour value the old midnight logic produced', () => {
  // Regression guard. The previous implementation ignored the header entirely
  // and computed seconds-until-local-midnight, which could exceed 80,000.
  for (const raw of ['20', '1', '0', 'Fri, 14 Aug 2026 12:00:30 GMT']) {
    const seconds = parseRetryAfterSeconds(headers(raw), NOW);
    assert.ok(seconds !== null && seconds < 3600, `${raw} gave ${seconds}`);
  }
});
