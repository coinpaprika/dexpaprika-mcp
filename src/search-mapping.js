/**
 * Search-endpoint parameter mapping.
 *
 * The legacy DexPaprika REST endpoints /networks/{network}/pools,
 * /networks/{network}/pools/filter, /networks/{network}/tokens/top, and
 * /networks/{network}/tokens/filter were removed (HTTP 410). They are replaced
 * by the unified search endpoints:
 *   - GET /networks/{network}/pools/search
 *   - GET /networks/{network}/tokens/search
 *
 * The search endpoints use canonical field names (volume_usd_24h, txns_24h,
 * price_change_percentage_24h, ...) and reject the old short names with HTTP
 * 400. The MCP tools keep their old names and sort-field values for client
 * back-compat, so every value an agent supplies is normalized to the canonical
 * form before the upstream call.
 *
 * Verified live against api.dexpaprika.com (2026-06-30): every canonical value
 * below returns 200 and sorts correctly; the legacy values 400. tokens/search
 * does not support price_usd ordering (400), so it falls back to volume.
 *
 * 2026-07-15: /networks/{network}/tokens/{token_address}/pools was removed the
 * same way (HTTP 410, replacement /networks/:network/pools/search). The pool
 * search endpoint gained a token_address query param that restricts results to
 * pools containing that token, so getTokenPools routes through
 * buildPoolSearchParams too. Two caveats, both verified live (2026-07-15):
 * the filter is network-scoped only (the cross-network /pools/search accepts
 * token_address but silently ignores it), and repeating token_address does
 * not act as a pair filter; the API uses only one of the values (not
 * guaranteed by order).
 *
 * 2026-08-05: /networks/{network}/dexes/{dex}/pools was removed the same way
 * (HTTP 410, replacement /networks/:network/pools/search). The DEX moves from
 * a path segment to a dex_name query param, so getDexPools routes through
 * buildPoolSearchParams too. Verified live on 2026-08-05 against
 * api.dexpaprika.com:
 * Despite its name, dex_name matches the DEX id, case-insensitively. It does
 * not match the human display name. Verified with a DEX whose display name
 * genuinely differs from its id, because Curve alone cannot tell the two
 * behaviours apart:
 *   ?dex_name=curve        -> 2 rows, dex_id "curve"
 *   ?dex_name=CURVE        -> 2 rows, dex_id "curve" (so matching ignores case)
 *   ?dex_name=uniswap_v3   -> 2 rows, dex_id "uniswap_v3"
 *   ?dex_name=Uniswap V3   -> 0 rows, HTTP 200 (display name, silently empty)
 *   ?dex_name=balancer_v2  -> 2 rows, dex_id "balancer_v2"
 *   ?dex_name=Balancer V2  -> 0 rows, HTTP 200 (display name, silently empty)
 *   ?zzz_bogus=curve       -> unfiltered baseline, top row dex_id "makerdao"
 * The bogus-param control matters because unknown query params are dropped
 * silently and still return a plausible 200. Pass the dex_id field from
 * /networks/{network}/dexes, never that response's dex_name field: a display
 * name returns 200 with an empty results[] rather than an error, so a caller
 * gets a plausible empty answer and no signal about why.
 */

// Must match the enum the REST layer returns in its 400 body. A field missing
// here does not error: mapPoolSortField falls through to volume_usd_24h, so the
// caller gets a successful response sorted by something they did not ask for.
const POOL_SORT_CANONICAL = new Set([
  'volume_usd_24h', 'volume_usd_7d', 'volume_usd_30d', 'liquidity_usd',
  'txns_24h', 'created_at', 'price_usd',
  'price_change_percentage_24h', 'price_change_percentage_6h',
  'price_change_percentage_1h', 'price_change_percentage_5m',
]);

const POOL_SORT_LEGACY = {
  volume_usd: 'volume_usd_24h',
  transactions: 'txns_24h',
  last_price_change_usd_24h: 'price_change_percentage_24h',
  volume_24h: 'volume_usd_24h',
  volume_7d: 'volume_usd_7d',
  volume_30d: 'volume_usd_30d',
  liquidity: 'liquidity_usd',
};

const TOKEN_SORT_CANONICAL = new Set([
  'volume_usd_24h', 'volume_usd_7d', 'volume_usd_30d', 'liquidity_usd',
  'txns_24h', 'fdv_usd', 'created_at', 'price_change_percentage_24h',
]);

const TOKEN_SORT_LEGACY = {
  volume_24h: 'volume_usd_24h',
  volume_7d: 'volume_usd_7d',
  volume_30d: 'volume_usd_30d',
  txns: 'txns_24h',
  price_change: 'price_change_percentage_24h',
  fdv: 'fdv_usd',
  // tokens/search rejects price_usd ordering (HTTP 400) -- fall back to volume.
  price_usd: 'volume_usd_24h',
};

export function mapPoolSortField(value) {
  if (typeof value !== 'string' || value === '') return 'volume_usd_24h';
  if (POOL_SORT_CANONICAL.has(value)) return value;
  return POOL_SORT_LEGACY[value] || 'volume_usd_24h';
}

export function mapTokenSortField(value) {
  if (typeof value !== 'string' || value === '') return 'volume_usd_24h';
  if (TOKEN_SORT_CANONICAL.has(value)) return value;
  return TOKEN_SORT_LEGACY[value] || 'volume_usd_24h';
}

// Legacy filter param name -> canonical /search filter param name.
const POOL_FILTER_PARAM = {
  volume_24h_min: 'volume_usd_24h_min',
  volume_24h_max: 'volume_usd_24h_max',
  volume_7d_min: 'volume_usd_7d_min',
  volume_7d_max: 'volume_usd_7d_max',
  liquidity_usd_min: 'liquidity_usd_min',
  liquidity_usd_max: 'liquidity_usd_max',
  txns_24h_min: 'txns_24h_min',
  // Identity mappings, but they must be listed: this map is a whitelist, and a
  // parameter missing from it is dropped before the request leaves.
  price_change_percentage_24h_min: 'price_change_percentage_24h_min',
  price_change_percentage_24h_max: 'price_change_percentage_24h_max',
  price_change_percentage_6h_min: 'price_change_percentage_6h_min',
  price_change_percentage_6h_max: 'price_change_percentage_6h_max',
  price_change_percentage_1h_min: 'price_change_percentage_1h_min',
  price_change_percentage_1h_max: 'price_change_percentage_1h_max',
  price_change_percentage_5m_min: 'price_change_percentage_5m_min',
  price_change_percentage_5m_max: 'price_change_percentage_5m_max',
  created_after: 'created_after',
  created_before: 'created_before',
};

const TOKEN_FILTER_PARAM = {
  volume_24h_min: 'volume_usd_24h_min',
  volume_24h_max: 'volume_usd_24h_max',
  liquidity_usd_min: 'liquidity_usd_min',
  liquidity_usd_max: 'liquidity_usd_max',
  fdv_min: 'fdv_min',
  fdv_max: 'fdv_max',
  txns_24h_min: 'txns_24h_min',
  // The 24h window is the only price-change bound tokens/search honours. The
  // shorter ones are absent from token rows and are ignored if sent, so they
  // are deliberately not listed here.
  price_change_percentage_24h_min: 'price_change_percentage_24h_min',
  price_change_percentage_24h_max: 'price_change_percentage_24h_max',
  created_after: 'created_after',
  created_before: 'created_before',
};

function normalizeDirection(args) {
  const dir = args.sort_dir ?? args.sort;
  return dir === 'asc' ? 'asc' : 'desc';
}

/** Build query params for /networks/{network}/pools/search from tool args. */
export function buildPoolSearchParams(args) {
  const params = {
    order_by: mapPoolSortField(args.sort_by ?? args.order_by),
    sort: normalizeDirection(args),
  };
  if (args.limit !== undefined && args.limit !== null) params.limit = args.limit;
  if (typeof args.cursor === 'string' && args.cursor !== '') params.cursor = args.cursor;
  // token_address restricts results to pools containing that token (used by
  // getTokenPools). Network-scoped /pools/search only; see the header comment.
  if (typeof args.token_address === 'string' && args.token_address !== '') params.token_address = args.token_address;
  // dex_name restricts results to one exchange (used by getDexPools). The tool
  // still calls the argument `dex`, which the handler maps onto this key; the
  // `dex_name` spelling is accepted directly too. The value must be the dex id
  // ("uniswap_v3"), matched case-insensitively; a display name ("Uniswap V3")
  // returns an empty results[] rather than an error.
  if (typeof args.dex_name === 'string' && args.dex_name !== '') params.dex_name = args.dex_name;
  for (const [legacy, canonical] of Object.entries(POOL_FILTER_PARAM)) {
    const v = args[legacy];
    if (v !== undefined && v !== null) params[canonical] = v;
  }
  return params;
}

/** Build query params for /networks/{network}/tokens/search from tool args. */
export function buildTokenSearchParams(args) {
  const params = {
    order_by: mapTokenSortField(args.sort_by ?? args.order_by),
    sort: normalizeDirection(args),
  };
  if (args.limit !== undefined && args.limit !== null) params.limit = args.limit;
  if (typeof args.cursor === 'string' && args.cursor !== '') params.cursor = args.cursor;
  if (typeof args.query === 'string' && args.query !== '') params.query = args.query;
  for (const [legacy, canonical] of Object.entries(TOKEN_FILTER_PARAM)) {
    const v = args[legacy];
    if (v !== undefined && v !== null) params[canonical] = v;
  }
  return params;
}

/** Serialize a params object to a `?a=b&c=d` query string (empty -> ""). */
export function toQueryString(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
