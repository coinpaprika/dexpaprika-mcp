// The gate every upstream URL passes before it is fetched.
//
// Tool arguments (network, pool_address, token_address, dex) are interpolated into the
// upstream path. An argument such as "../../admin/settings" would otherwise walk the request,
// with your API key on it, out of /networks to another path on the API host. So the path must
// have one of the shapes below, no segment may be a dot segment or carry characters that change
// how the URL is parsed, and the URL must keep the same path after parsing.

const S = '[^/]+';
const ALLOWED_SHAPES = [
  /^\/networks$/,
  /^\/search$/,
  /^\/stats$/,
  /^\/usage$/,
  new RegExp(`^/networks/${S}$`),
  new RegExp(`^/networks/${S}/dexes$`),
  new RegExp(`^/networks/${S}/multi/prices$`),
  new RegExp(`^/networks/${S}/pools/search$`),
  new RegExp(`^/networks/${S}/pools/${S}$`),
  new RegExp(`^/networks/${S}/pools/${S}/(ohlcv|transactions|indicators)$`),
  new RegExp(`^/networks/${S}/tokens/search$`),
  new RegExp(`^/networks/${S}/tokens/${S}$`),
  new RegExp(`^/networks/${S}/tokens/${S}/(ohlcv|indicators)$`),
];

// Backslash, percent, "#", "?", whitespace and control characters. Real ids use none of these.
const BAD_SEGMENT_CHAR = /[\\%#?\s\x00-\x1f\x7f]/;
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
  if (!path.startsWith('/')) throw new UnsafeUpstreamPathError();
  for (const seg of path.slice(1).split('/')) {
    if (seg === '' || seg === '.' || seg === '..' || BAD_SEGMENT_CHAR.test(seg)) {
      throw new UnsafeUpstreamPathError();
    }
  }
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
