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
 */

const POOL_SORT_CANONICAL = new Set([
  'volume_usd_24h', 'volume_usd_7d', 'volume_usd_30d', 'liquidity_usd',
  'txns_24h', 'created_at', 'price_usd', 'price_change_percentage_24h',
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
