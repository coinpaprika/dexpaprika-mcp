import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeaders, buildUserAgent, resolveApiKey, resolveBaseUrl, DEFAULT_BASE_URL } from '../src/http-config.js';

const RUNTIME = { node: '22.0.0', platform: 'linux' };
const base = (env) => buildHeaders({ version: '2.4.1', runtime: RUNTIME, env });

// ── The Bearer rule ─────────────────────────────────────────────────────────
// This is the regression this whole file exists for. `Authorization: Bearer
// api_...` returns 401 because the API checksums the raw header value. It has
// resurfaced three times in four months, so pin it exactly rather than loosely.

test('the key is the entire Authorization value, with no scheme word', () => {
  const headers = base({ DEXPAPRIKA_API_KEY: 'api_abc123' });
  assert.equal(headers.Authorization, 'api_abc123');
});

test('Authorization never gains a Bearer prefix', () => {
  const headers = base({ DEXPAPRIKA_API_KEY: 'api_abc123' });
  assert.doesNotMatch(headers.Authorization, /^\s*Bearer\b/i);
});

test('no scheme word of any kind is prepended', () => {
  const headers = base({ DEXPAPRIKA_API_KEY: 'api_abc123' });
  for (const scheme of ['Bearer', 'Token', 'ApiKey', 'Basic', 'Key']) {
    assert.doesNotMatch(headers.Authorization, new RegExp(`^\\s*${scheme}\\b`, 'i'));
  }
});

// ── Keyless stays the default ───────────────────────────────────────────────

test('no key configured sends no Authorization header at all', () => {
  assert.equal('Authorization' in base({}), false);
});

test('an empty or whitespace-only key is keyless, not an empty header', () => {
  for (const value of ['', '   ', '\t']) {
    assert.equal('Authorization' in base({ DEXPAPRIKA_API_KEY: value }), false);
  }
});

test('a non-string key is ignored rather than coerced', () => {
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(resolveApiKey({ DEXPAPRIKA_API_KEY: value }), null);
  }
});

test('surrounding whitespace is trimmed off a real key', () => {
  assert.equal(resolveApiKey({ DEXPAPRIKA_API_KEY: '  api_abc123\n' }), 'api_abc123');
});

// ── Header injection ────────────────────────────────────────────────────────

test('a key containing CR or LF is dropped, not sanitised into a broken key', () => {
  for (const value of ['api_a\r\nX-Evil: 1', 'api_a\nb', 'api_a\0b']) {
    assert.equal(resolveApiKey({ DEXPAPRIKA_API_KEY: value }), null,
      `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('a hostile client name cannot inject a header', () => {
  const ua = buildUserAgent({
    version: '2.4.1', runtime: RUNTIME,
    client: { name: 'evil\r\nX-Injected: 1', version: '1.0' },
  });
  assert.doesNotMatch(ua, /[\r\n]/);
});

test('client fields are length-capped', () => {
  const ua = buildUserAgent({
    version: '2.4.1', runtime: RUNTIME,
    client: { name: 'a'.repeat(500), version: 'b'.repeat(500) },
  });
  assert.ok(ua.length < 200, `user agent was ${ua.length} chars`);
});

// ── User-Agent shape ────────────────────────────────────────────────────────

test('user agent identifies the package, its version and the runtime', () => {
  const ua = buildUserAgent({ version: '2.4.1', runtime: RUNTIME });
  assert.equal(ua, 'dexpaprika-mcp/2.4.1 (node/22.0.0; linux)');
});

test('a known MCP client is named in the user agent', () => {
  const ua = buildUserAgent({
    version: '2.4.1', runtime: RUNTIME,
    client: { name: 'claude-desktop', version: '1.2.3' },
  });
  assert.equal(ua, 'dexpaprika-mcp/2.4.1 (node/22.0.0; linux; client=claude-desktop/1.2.3)');
});

test('a client with no version still gets named', () => {
  const ua = buildUserAgent({
    version: '2.4.1', runtime: RUNTIME, client: { name: 'cursor' },
  });
  assert.match(ua, /client=cursor\)$/);
});

test('an unknown client is omitted rather than guessed', () => {
  for (const client of [undefined, {}, { name: '' }, { name: null }]) {
    const ua = buildUserAgent({ version: '2.4.1', runtime: RUNTIME, client });
    assert.doesNotMatch(ua, /client=/);
  }
});

test('a user agent is always sent, key or no key', () => {
  assert.match(base({})['User-Agent'], /^dexpaprika-mcp\//);
  assert.match(base({ DEXPAPRIKA_API_KEY: 'api_x' })['User-Agent'], /^dexpaprika-mcp\//);
});

// ── Base URL ────────────────────────────────────────────────────────────────
// The host must never be inferred from the presence of a key. Free keys are
// served on the default origin and only Pro moves to api-pro, so a wrong guess
// would return 403 to exactly the people who just registered.

test('the default origin is used when nothing is configured', () => {
  for (const env of [{}, { DEXPAPRIKA_API_BASE_URL: '' }, { DEXPAPRIKA_API_BASE_URL: '  ' }]) {
    assert.equal(resolveBaseUrl(env), DEFAULT_BASE_URL);
  }
});

test('a key alone never changes the host', () => {
  assert.equal(resolveBaseUrl({ DEXPAPRIKA_API_KEY: 'api_abc123' }), DEFAULT_BASE_URL);
});

test('Pro customers can point at api-pro explicitly', () => {
  assert.equal(
    resolveBaseUrl({ DEXPAPRIKA_API_BASE_URL: 'https://api-pro.dexpaprika.com' }),
    'https://api-pro.dexpaprika.com',
  );
});

test('a trailing slash does not produce a double slash in request paths', () => {
  assert.equal(
    resolveBaseUrl({ DEXPAPRIKA_API_BASE_URL: 'https://api-pro.dexpaprika.com/' }),
    'https://api-pro.dexpaprika.com',
  );
});

test('an unusable value falls back rather than breaking the tool', () => {
  for (const value of ['not a url', 'ftp://example.com', 'file:///etc/passwd', '://x']) {
    assert.equal(resolveBaseUrl({ DEXPAPRIKA_API_BASE_URL: value }), DEFAULT_BASE_URL,
      `expected ${value} to fall back`);
  }
});

test('a local origin is accepted, which is what the wire tests run against', () => {
  assert.equal(resolveBaseUrl({ DEXPAPRIKA_API_BASE_URL: 'http://127.0.0.1:8080' }), 'http://127.0.0.1:8080');
});
