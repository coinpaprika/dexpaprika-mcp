// ─────────────────────────────────────────────────────────────────────────────
// Outbound request configuration: base URL, optional API key, client identity.
//
// Keyless is and stays the default. With no key configured, the only difference
// from what this package sent before is a User-Agent, which is what lets us tell
// this tool's traffic apart from everything else hitting the API.
//
// Pure module on purpose: every rule below is unit-tested in
// test/http-config.test.js without starting a server or touching the network.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Anything that could break out of a header value. A key or client name
 * carrying CR, LF or NUL is not sanitised into something usable, it is dropped:
 * a silently mangled key would authenticate as nobody and, because our data
 * endpoints ignore an unreadable key rather than rejecting it, the caller would
 * never find out.
 */
const HEADER_UNSAFE = /[\r\n\0]/;

/** Client names arrive from the MCP handshake, so they are untrusted input. */
const CLIENT_TOKEN_UNSAFE = /[^\w.@/-]+/g;
const CLIENT_FIELD_MAX = 48;

/**
 * Read a usable API key off an env-shaped object, or null for keyless.
 *
 * @param {Record<string, unknown>} [env]
 * @returns {string|null}
 */
export function resolveApiKey(env = process.env) {
  const raw = env?.DEXPAPRIKA_API_KEY;
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (key === '') return null;
  if (HEADER_UNSAFE.test(key)) return null;
  return key;
}

/** Reduce an untrusted client-supplied string to something safe in a header. */
function sanitizeClientField(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CLIENT_TOKEN_UNSAFE, '_').slice(0, CLIENT_FIELD_MAX);
}

/**
 * `dexpaprika-mcp/2.4.1 (node/22.1.0; darwin; client=claude-desktop/1.2.3)`
 *
 * The client segment comes from the MCP initialize handshake and is omitted
 * entirely when we do not have it, rather than guessed.
 */
export function buildUserAgent({ version, client, runtime } = {}) {
  const nodeVersion = runtime?.node ?? process.versions.node;
  const platform = runtime?.platform ?? process.platform;

  const parts = [`node/${nodeVersion}`, platform];

  const name = sanitizeClientField(client?.name);
  if (name !== '') {
    const clientVersion = sanitizeClientField(client?.version);
    parts.push(clientVersion === '' ? `client=${name}` : `client=${name}/${clientVersion}`);
  }

  return `dexpaprika-mcp/${version ?? '0.0.0'} (${parts.join('; ')})`;
}

/**
 * Headers for an outbound API call.
 *
 * **The key is the entire `Authorization` value.** There is no `Bearer` prefix
 * and no other scheme word. `Authorization: Bearer api_...` returns 401, because
 * the API checksums the raw header value and nothing strips a scheme word off
 * the front. This is the single most common reason a working key looks broken,
 * it has resurfaced three times in four months, and the test file pins the
 * format precisely so nobody reintroduces it.
 *
 * @returns {Record<string, string>}
 */
export function buildHeaders({ version, client, runtime, env } = {}) {
  const headers = { 'User-Agent': buildUserAgent({ version, client, runtime }) };

  const key = resolveApiKey(env);
  if (key !== null) headers.Authorization = key;

  return headers;
}

/**
 * Seconds from an inbound `Retry-After`, or null when it is absent or unusable.
 *
 * RFC 9110 allows either delta-seconds or an HTTP-date, so both are handled.
 * Null means "we do not know" and callers must say so: inventing a number is
 * exactly how this package came to advise waiting until local midnight for a
 * limit that clears in seconds.
 *
 * @param {{ get?: (name: string) => string|null }} [responseHeaders]
 * @param {number} [now] epoch ms, injectable so the date branch is testable
 * @returns {number|null}
 */
export function parseRetryAfterSeconds(responseHeaders, now = Date.now()) {
  const raw = responseHeaders?.get?.('retry-after');
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const asSeconds = Number(raw.trim());
  if (Number.isFinite(asSeconds)) return asSeconds < 0 ? 0 : Math.ceil(asSeconds);

  const asDate = Date.parse(raw);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, Math.ceil((asDate - now) / 1000));
}

/** Default origin. Serves keyless callers and registered free keys alike. */
export const DEFAULT_BASE_URL = 'https://api.dexpaprika.com';

/**
 * Resolve the API origin.
 *
 * The host does **not** change when a key is present. Keyless callers and
 * registered free keys are both served from the default origin, and only Pro
 * moves to `api-pro.dexpaprika.com`, so Pro customers set this explicitly.
 * Sending a free key to an api-pro host returns 403 rather than 401, which is
 * why guessing the host from the key would be worse than making it explicit.
 *
 * An unusable value falls back to the default rather than throwing: a data tool
 * that refuses to start over a typo in an optional variable is a worse outcome
 * than one that keeps working against the public API.
 *
 * @returns {string} origin with no trailing slash
 */
export function resolveBaseUrl(env = process.env) {
  const raw = env?.DEXPAPRIKA_API_BASE_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_BASE_URL;

  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return DEFAULT_BASE_URL;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return DEFAULT_BASE_URL;

  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}
