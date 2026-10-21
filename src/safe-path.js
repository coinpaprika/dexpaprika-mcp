// The gate every upstream URL passes before it is fetched.
//
// Tool arguments (network, pool_address, token_address, dex) are interpolated into the
// upstream path. An argument such as "../../admin/settings" would otherwise walk the request,
// with your API key on it, out of /networks to another path on the API host. So the path must
// have one of the shapes below, every identifier in it must use only the characters real ids
// use, and the URL must keep the same path after parsing.
//
// The identifier rules are an allowlist, not a list of bad characters: a denylist depends on
// every parser between here and the API agreeing with ours, and a segment such as "..;" or a
// Unicode look-alike of "." or "/" can mean ".." to a server that strips path parameters or
// folds Unicode. None of the characters allowed here changes meaning when decoded or folded.

// Network ids: "ethereum", "bsc", "bob_network", "x_layer".
const NETWORK = '[a-z0-9_-]+';
export const NETWORK_ID = new RegExp(`^${NETWORK}$`);
// Pool and token addresses: EVM and Sui 0x hex, Solana and Tron base58, TON base64url
// ("EQ...", with "-" and "_") and Sui or Aptos type tags ("0x2::sui::SUI").
const ADDRESS = '[A-Za-z0-9:_-]+';
export const ADDRESS_ID = new RegExp(`^${ADDRESS}$`);
const ALLOWED_SHAPES = [
  /^\/networks$/,
  /^\/search$/,
  /^\/stats$/,
  /^\/usage$/,
  new RegExp(`^/networks/${NETWORK}$`),
  new RegExp(`^/networks/${NETWORK}/dexes$`),
  new RegExp(`^/networks/${NETWORK}/multi/prices$`),
  new RegExp(`^/networks/${NETWORK}/pools/search$`),
  new RegExp(`^/networks/${NETWORK}/pools/${ADDRESS}$`),
  new RegExp(`^/networks/${NETWORK}/pools/${ADDRESS}/(ohlcv|transactions|indicators)$`),
  new RegExp(`^/networks/${NETWORK}/tokens/search$`),
  new RegExp(`^/networks/${NETWORK}/tokens/${ADDRESS}$`),
  new RegExp(`^/networks/${NETWORK}/tokens/${ADDRESS}/(ohlcv|indicators)$`),
];

// Query values are percent-encoded where they are built, so a raw "?" or "/" here can only come
// from an identifier that smuggled one in.
const BAD_QUERY_CHAR = /[\\#?/\s\x00-\x1f\x7f]/;

export class UnsafeUpstreamPathError extends Error {
  constructor() {
    super('Invalid network, pool or token identifier.');
    this.name = 'UnsafeUpstreamPathError';
  }
}

export function assertSafeEndpoint(endpoint) {
  const q = endpoint.indexOf('?');
  const path = q === -1 ? endpoint : endpoint.slice(0, q);
  const query = q === -1 ? '' : endpoint.slice(q + 1);
  if (!ALLOWED_SHAPES.some((re) => re.test(path))) throw new UnsafeUpstreamPathError();
  if (BAD_QUERY_CHAR.test(query)) throw new UnsafeUpstreamPathError();
}

export function safeUpstreamUrl(baseUrl, endpoint) {
  assertSafeEndpoint(endpoint);
  const url = `${baseUrl}${endpoint}`;
  const q = endpoint.indexOf('?');
  const endpointPath = q === -1 ? endpoint : endpoint.slice(0, q);
  let expected;
  let parsedPath;
  try {
    expected = new URL(baseUrl).pathname.replace(/\/$/, '') + endpointPath;
    parsedPath = decodeURIComponent(new URL(url).pathname);
  } catch {
    throw new UnsafeUpstreamPathError();
  }
  if (parsedPath !== expected) throw new UnsafeUpstreamPathError();
  return url;
}

// Where a redirect from the API may be followed, or null when it may not. The key is on every
// request, so a hop is allowed only to the same origin and under the same base path, and the new
// path must pass the same gate as the first one: a redirect cannot take the key anywhere a tool
// argument could not.
export function upstreamRedirectTarget(baseUrl, currentUrl, location) {
  if (!location) return null;
  try {
    const base = new URL(baseUrl);
    const next = new URL(location, currentUrl);
    const basePath = base.pathname.replace(/\/$/, '');
    if (next.origin !== base.origin) return null;
    if (!next.pathname.startsWith(`${basePath}/`)) return null;
    const endpoint = next.pathname.slice(basePath.length) + next.search;
    return safeUpstreamUrl(baseUrl, endpoint);
  } catch {
    return null;
  }
}
