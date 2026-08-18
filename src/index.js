import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'module';
import { buildPoolSearchParams, buildTokenSearchParams, toQueryString } from './search-mapping.js';
import { buildHeaders, parseRetryAfterSeconds, resolveApiKey, resolveBaseUrl } from './http-config.js';

const PACKAGE_VERSION = createRequire(import.meta.url)('../package.json').version;

// Sort-field values accepted by the pool/token tools. Canonical *_24h names are
// what /pools/search and /tokens/search use; the trailing short names are legacy
// aliases kept for back-compat and normalized in search-mapping.js.
const POOL_SORT_FIELDS = ['volume_usd_24h', 'volume_usd_7d', 'volume_usd_30d', 'liquidity_usd', 'txns_24h', 'created_at', 'price_usd', 'price_change_percentage_24h', 'price_change_percentage_6h', 'price_change_percentage_1h', 'price_change_percentage_5m', 'volume_usd', 'transactions', 'last_price_change_usd_24h', 'volume_24h', 'volume_7d', 'volume_30d', 'liquidity'];
const TOKEN_SORT_FIELDS = ['volume_usd_24h', 'volume_usd_7d', 'volume_usd_30d', 'liquidity_usd', 'txns_24h', 'fdv_usd', 'created_at', 'price_change_percentage_24h', 'volume_24h', 'volume_7d', 'volume_30d', 'txns', 'price_change', 'fdv', 'price_usd'];

// ─────────────────────────────────────────────────────────────────────────────
// DexPaprika MCP — self-host (stdio) build, contract-aligned 1:1 with the hosted
// v2.0.0 Cloudflare Worker. Only the transport differs (stdio vs HTTP). Tools,
// params/aliases, synonym resolution, sort normalization, output schemas,
// instructions and version match the worker.
// ─────────────────────────────────────────────────────────────────────────────

// Base URL for DexPaprika API.
//
// Keyless works and stays the default: no key, no signup, nothing to configure.
// Setting DEXPAPRIKA_API_KEY raises the monthly allowance and opens streaming on
// any token. The host does NOT change when a key is present: free keys are served
// here, and only Pro moves to api-pro.dexpaprika.com.
const API_BASE_URL = resolveBaseUrl();

// Server version — matches the hosted worker.
const SERVER_VERSION = '2.0.0';

// Which MCP client we are talking to, learned from the initialize handshake and
// forwarded in the User-Agent. Stays null until the handshake completes, and the
// User-Agent simply omits the segment while it is unknown rather than guessing.
let mcpClient = null;

function currentHeaders() {
  // getClientVersion() returns undefined until the initialize handshake lands,
  // so this resolves on first use rather than at startup. Guarded because it is
  // reaching through the SDK's public-but-nested surface for a nice-to-have.
  if (mcpClient === null) {
    try {
      const info = server?.server?.getClientVersion?.();
      if (info?.name) mcpClient = { name: info.name, version: info.version };
    } catch {
      // Identification is optional. Never let it break a data call.
    }
  }
  return buildHeaders({ version: PACKAGE_VERSION, client: mcpClient });
}

// Server identity (inlined from the worker's server-identity.ts).
const SERVER_CANONICAL_NAME = 'dexpaprika';
const SERVER_ALIASES = [
  'dexpapika',   // dropped r
  'dexpaprica',  // k -> c
  'dex-paprika', // hyphenated
  'dex paprika', // spaced
];

// ─────────────────────────────────────────────────────────────────────────────
// Network synonym normalization (ported from src/upstream/network-synonyms.ts).
//
// getCapabilities advertises common alternate names agents might try
// (eth -> ethereum, matic -> polygon, etc.). This module gives a single point of
// normalization so the synonym promise actually holds at the wire layer.
//
// Canonical network id (matches /networks response) -> alternates an agent might
// try. Lowercase. The canonical id is ALWAYS valid as a passthrough.
// ─────────────────────────────────────────────────────────────────────────────
const NETWORK_SYNONYMS = {
  ethereum: ['ethereum', 'eth', 'mainnet', 'eth_mainnet', 'ethereum_mainnet'],
  solana: ['solana', 'sol'],
  bsc: ['bsc', 'binance-smart-chain', 'bnb', 'binance', 'bnb_chain', 'bnb-chain'],
  polygon: ['polygon', 'matic', 'pol', 'polygon_pos'],
  arbitrum: ['arbitrum', 'arb', 'arbitrum_one', 'arbitrum-one'],
  base: ['base', 'base_mainnet'],
  optimism: ['optimism', 'op', 'optimism_mainnet', 'op_mainnet'],
  avalanche: ['avalanche', 'avalanche-c', 'avax', 'avalanche_c'],
  sui: ['sui'],
  mantle: ['mantle', 'mnt'],
  flow_evm: ['flow_evm', 'flow-evm', 'flow'],
  katana: ['katana'],
  unichain: ['unichain', 'uni'],
  ronin: ['ronin', 'ron'],
  x_layer: ['x_layer', 'x-layer', 'xlayer', 'okx_xlayer'],
  linea: ['linea'],
  sonic: ['sonic', 's'],
  cronos: ['cronos', 'cro'],
  sei: ['sei'],
  blast: ['blast'],
  tempo: ['tempo'],
  aptos: ['aptos', 'apt'],
  zksync: ['zksync', 'zksync_era', 'zksync-era'],
  scroll: ['scroll'],
  tron: ['tron', 'trx'],
  ton: ['ton'],
  plasma: ['plasma'],
  bob_network: ['bob_network', 'bob', 'bob-network'],
  botanix: ['botanix'],
  fantom: ['fantom', 'ftm'],
  celo: ['celo'],
  monad: ['monad'],
  megaeth: ['megaeth', 'mega-eth', 'mega_eth'],
  berachain: ['berachain', 'bera'],
  hyperevm: ['hyperevm', 'hyper-evm', 'hyper_evm'],
};

// Reverse map built once at module load: alternate (lowercase) -> canonical.
const REVERSE_SYNONYM_MAP = (() => {
  const out = {};
  for (const [canonical, alternates] of Object.entries(NETWORK_SYNONYMS)) {
    for (const alt of alternates) {
      out[alt.toLowerCase()] = canonical;
    }
  }
  return out;
})();

// Map an agent-supplied network identifier to its canonical form. Returns the
// input unchanged if not in the synonym table — upstream will then 404 as before.
function normalizeNetwork(input) {
  if (!input || typeof input !== 'string') return input;
  return REVERSE_SYNONYM_MAP[input.toLowerCase()] ?? input;
}

// Rewrite the first /networks/{X}/... segment so X is replaced with its canonical
// form. Idempotent for already-canonical inputs. No-op if it doesn't match.
function normalizeNetworkPath(endpoint) {
  return endpoint.replace(/^\/networks\/([^/?]+)/, (_match, raw) => {
    const canonical = normalizeNetwork(raw);
    return `/networks/${canonical}`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured error handling (kept from the existing package — works on top of
// the new response shape).
// ─────────────────────────────────────────────────────────────────────────────
const ErrorCodes = {
  DP400_INVALID_NETWORK: 'DP400_INVALID_NETWORK',
  DP400_TOO_MANY_TOKENS: 'DP400_TOO_MANY_TOKENS',
  DP400_INVALID_ADDRESS: 'DP400_INVALID_ADDRESS',
  DP400_MISSING_REQUIRED: 'DP400_MISSING_REQUIRED',
  DP400_UNSUPPORTED_PARAM: 'DP400_UNSUPPORTED_PARAM',
  DP404_NOT_FOUND: 'DP404_NOT_FOUND',
  DP429_RATE_LIMIT: 'DP429_RATE_LIMIT',
  DP402_QUOTA_EXHAUSTED: 'DP402_QUOTA_EXHAUSTED',
};

function buildErrorResponse(code, message, retryable, suggestion, correctedExample, metadata) {
  const error = { error: { code, message, retryable, suggestion } };
  if (correctedExample) error.error.corrected_example = correctedExample;
  if (metadata) error.error.metadata = metadata;
  return error;
}

// Defensively parse a deprecation hint out of an error response body. The API
// signals a removed/moved endpoint with a JSON body of the shape
// { "code": 410, "message": "endpoint removed", "replacement": "/networks/{network}/pools/search" }.
// We key on the presence of a string "replacement" field so ANY future
// deprecation self-documents (not just 410, not hardcoded to any endpoint).
// Returns null when the body is missing, not JSON, or has no usable replacement,
// so callers fall back to the existing status-based error behavior.
function parseDeprecationHint(body) {
  if (!body || typeof body !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const replacement = parsed.replacement;
  if (typeof replacement !== 'string' || replacement.length === 0) return null;
  const apiMessage = typeof parsed.message === 'string' ? parsed.message : null;
  return { replacement, apiMessage };
}

function parseAPIError(status, statusText, endpoint, body, responseHeaders) {
  // Generic, self-documenting deprecation handling: if the error body carries a
  // "replacement" hint, surface BOTH the API message and the replacement path,
  // for ANY error status. Keeps the DP<status>_ERROR code structure.
  const hint = parseDeprecationHint(body);
  if (hint) {
    const baseMessage = (hint.apiMessage ?? `API request failed: ${status} ${statusText}`)
      .replace(/\s*\.?\s*$/, '');
    return buildErrorResponse(
      `DP${status}_ERROR`,
      `${baseMessage}. Use ${hint.replacement} instead.`,
      false,
      `This endpoint has been deprecated or removed. Use ${hint.replacement} instead.`,
      undefined,
      { endpoint, status, replacement: hint.replacement },
    );
  }

  if (status === 404 && endpoint.includes('/networks/')) {
    const networkMatch = endpoint.match(/\/networks\/([^/?]+)/);
    const providedNetwork = networkMatch ? networkMatch[1] : 'unknown';
    return buildErrorResponse(
      ErrorCodes.DP400_INVALID_NETWORK,
      `Network ID '${providedNetwork}' not recognized`,
      true,
      'Use normalized network ID from getNetworks. Call getCapabilities for network_synonyms.',
      `getNetworkPools('ethereum', 10)`,
      {
        provided: providedNetwork,
        suggested: 'ethereum',
        valid_networks: ['ethereum', 'bsc', 'polygon', 'base', 'arbitrum', 'optimism', 'solana', 'avalanche', 'fantom'],
      },
    );
  }

  if (status === 404) {
    return buildErrorResponse(
      ErrorCodes.DP404_NOT_FOUND,
      'Resource not found',
      false,
      'Verify the resource exists. Use search or list endpoints to find correct identifiers.',
      undefined,
      { endpoint },
    );
  }

  if (status === 429) {
    // This is the PER-MINUTE request limit, not the monthly credit allowance.
    // Until 2026-08-14 this branch reported a "daily" limit and told the caller
    // to wait until local midnight, which for an agent meant giving up for hours
    // on a limit that clears in seconds. Honour the server's own Retry-After.
    const retryAfterSeconds = parseRetryAfterSeconds(responseHeaders);
    return buildErrorResponse(
      ErrorCodes.DP429_RATE_LIMIT,
      'Per-minute request limit exceeded',
      true,
      retryAfterSeconds === null
        ? 'Wait a few seconds and retry. This is a per-minute limit, so it clears on its own; it is not the monthly credit allowance running out.'
        : `Wait ${retryAfterSeconds}s and retry, then pace requests below the limit. This is a per-minute limit, not the monthly credit allowance.`,
      'getTokenMultiPrices({ network, tokens: [a, b, c] })  // up to 10 per request',
      {
        limit_type: 'requests_per_minute',
        // Null rather than invented: a made-up number is what produced the
        // wait-until-midnight advice this replaces.
        retry_after_seconds: retryAfterSeconds,
        // Deliberately no "register for more" hint here. A free API key raises
        // the monthly allowance and opens streaming, but it does NOT raise the
        // per-minute limit, so suggesting it at this moment would be false.
        reduce_request_count: 'Batch up to 10 tokens per call with getTokenMultiPrices, or stream instead of polling.',
      },
    );
  }

  if (status === 402) {
    // Monthly credit allowance exhausted. Unlike 429, a free key genuinely does
    // help here: it raises the ceiling from the keyless allowance.
    const keyed = resolveApiKey() !== null;
    return buildErrorResponse(
      ErrorCodes.DP402_QUOTA_EXHAUSTED,
      'Monthly credit allowance exhausted',
      false,
      keyed
        ? 'This key has spent its monthly credits. The allowance resets at the start of the next period, and the response body carries the current upgrade options.'
        : 'Running keyless. A free API key raises the monthly allowance well above the keyless tier and takes no card: set DEXPAPRIKA_API_KEY and restart. Current limits: https://docs.dexpaprika.com/knowledge-base/rate-limits',
      undefined,
      {
        limit_type: 'monthly_credits',
        using_api_key: keyed,
        endpoint,
      },
    );
  }

  if (status === 400) {
    return buildErrorResponse(
      ErrorCodes.DP400_MISSING_REQUIRED,
      `Bad request: ${statusText}`,
      false,
      'Check that all required parameters are provided with correct formats',
      undefined,
      { endpoint, status },
    );
  }

  return buildErrorResponse(
    `DP${status}_ERROR`,
    `API request failed: ${status} ${statusText}`,
    false,
    'Check API documentation or try again later',
    undefined,
    { endpoint, status },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire chokepoint. The network-synonym rewrite happens here, before the URL is
// composed, so eth -> ethereum etc. resolve for every /networks/* endpoint.
// Logging goes to stderr only (stdout carries the JSON-RPC frames).
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFromAPI(endpoint) {
  // Synonym normalization so agent-supplied `eth`, `matic`, etc. route to the
  // canonical network IDs. No-op for already-canonical IDs and non-/networks paths.
  endpoint = normalizeNetworkPath(endpoint);
  const url = `${API_BASE_URL}${endpoint}`;
  const response = await fetch(url, { headers: currentHeaders() });
  if (!response.ok) {
    // Read the error body so a deprecation hint (a "replacement" field) can be
    // surfaced to the caller. Defensive: the body may be empty or non-JSON, in
    // which case parseAPIError falls back to status-based behavior.
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '';
    }
    console.error(`[upstream] url=${url} http_status=${response.status} text="${response.statusText}"`);
    // Preserve the package's structured error contract.
    throw parseAPIError(response.status, response.statusText, endpoint, body, response.headers);
  }
  return response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Response helpers (ported from src/tools/responses.ts).
// jsonText returns BOTH content[0].text (JSON string) AND structuredContent.
// ─────────────────────────────────────────────────────────────────────────────
function jsonText(data, structuredKey) {
  const result = {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
  if (data !== null && typeof data === 'object') {
    if (Array.isArray(data)) {
      if (structuredKey) result.structuredContent = { [structuredKey]: data };
      // else: keep content-only (older callers that haven't migrated)
    } else {
      result.structuredContent = data;
    }
  }
  return result;
}

function errorText(err) {
  // Structured error objects (from parseAPIError) surface their full payload so
  // agents keep the actionable code/suggestion. Plain errors fall back to message.
  // isError: true is required: SDK 1.29 validates non-error results against the
  // tool's outputSchema and rejects any result without structuredContent, so an
  // error result missing the flag surfaces as an opaque JSON-RPC -32602 instead
  // of the structured payload below.
  if (err && typeof err === 'object' && 'error' in err) {
    return {
      content: [{ type: 'text', text: JSON.stringify(err, null, 2) }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text',
      text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
    }],
    isError: true,
  };
}

// MCP tool annotations.
const ANNOTATIONS_READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: true,
};
// ─────────────────────────────────────────────────────────────────────────────
// rationale field — REQUIRED on every read tool.
// Accepted by the handler and IGNORED (no analytics sink; no D1 in stdio).
// ─────────────────────────────────────────────────────────────────────────────
const RATIONALE_DESCRIPTION =
  'REQUIRED. 1-2 sentence rationale for this call (e.g. "User asked for X; calling Y to fetch Z"). ' +
  'Logged for MCP improvement, never shown to end users. No PII or secrets. ' +
  'See the server `instructions` field for the full convention and worked examples.';

const rationaleZod = z.string().min(20).max(500).describe(RATIONALE_DESCRIPTION);

// Coerce page=0 (and any non-positive) to 1 in paginated handlers.
function coercePage(page) {
  return page && page > 0 ? page : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVER_INSTRUCTIONS (ported from src/tools/responses.ts) — advertised once per
// session via the MCP initialize result.instructions. Truthful for stdio.
// ─────────────────────────────────────────────────────────────────────────────
const SERVER_INSTRUCTIONS = [
  '# DexPaprika MCP: agent usage notes',
  '',
  '## `rationale` field (required on every read tool)',
  'Every read tool (`getNetworks`, `getPoolDetails`, etc.) requires a `rationale` string of 20-500 chars.',
  'Format: 1-2 sentences referencing (a) what triggered the call and (b) downstream use.',
  'Do not include user PII or secrets. Rationales are accepted to satisfy the schema and never persisted in the self-host build.',
  '',
  'Examples:',
  '- "User asked for SOL price; calling getTokenDetails to fetch current USD value."',
  '- "Building a portfolio dashboard; need top pools for WETH on ethereum to estimate liquidity."',
  '- "Backtesting USDC/WETH spread; fetching 24h OHLCV at 1h interval."',
  '',
  '## Tool discovery',
  'Start with `getNetworks` (discover supported chains) or `getCapabilities` (agent-onboarding doc: network synonyms, workflow patterns, common pitfalls). Both are free and have no parameters beyond rationale.',
  '',
  '## Parameter naming',
  'Sort parameters accept both legacy and canonical names. Pick whichever is clearer; the server normalizes both. Canonical names (preferred going forward):',
  '- `sort_dir` (legacy: `sort`), sort direction, "asc" or "desc".',
  '- `sort_by` (legacy: `order_by`), sort field, tool-specific enum.',
  '',
  '`getTokenPools` no longer accepts `inversed`/`reorder` or `paired_token_address`/`address`: the endpoint it',
  'proxied was removed and its replacement (/networks/{network}/pools/search with token_address) has no equivalent',
  'for either. Supplying them returns a structured error with a client-side workaround. The token filter is',
  'network-scoped only; the cross-network /pools/search ignores token_address.',
  '',
  '`getDexPools` kept its name and its `dex` argument, but the endpoint underneath changed on 2026-08-05:',
  '/networks/{network}/dexes/{dex}/pools was removed and the tool now proxies /networks/{network}/pools/search',
  'with a `dex_name` filter. Rows arrive under `results` with `has_next_page` + `next_cursor`, not under `pools`',
  'with `page_info`, and the 24h volume field is `volume_usd_24h`, not `volume_usd`. `page` is superseded by',
  '`cursor`: page 2 and above return a structured error rather than silently repeating page 1.',
  '',
  'Pagination is 1-indexed; the server accepts `page=0` as a backward-compat alias for `page=1`.',
  '',
  '## Time formats',
  '- `getPoolOHLCV.start` / `.end`: RFC3339 recommended (`2024-01-01T00:00:00Z`). Also accepts Unix epoch seconds and `YYYY-MM-DD` (treated as 00:00:00 UTC).',
  '- `getPoolTransactions.from` / `.to`: Unix epoch SECONDS only. Window capped to last 7 days.',
  '',
  '## Output shape',
  "All tools return both `content[0].text` (JSON string, for older clients) and `structuredContent` (validated against the tool's `outputSchema`, 2025-06-18+). Prefer `structuredContent` to avoid the parse round-trip.",
  '',
  'Array-returning tools wrap the array under a named key in structuredContent: `getNetworks` gives `{ networks: [...] }`, `getPoolOHLCV` gives `{ ohlcv: [...] }`, `getTokenMultiPrices` gives `{ prices: [...] }`.',
].join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// Reusable output subschemas (ported from src/tools/output-schemas.ts).
// Every nested object uses .passthrough() so upstream can add fields safely.
// ─────────────────────────────────────────────────────────────────────────────
const PageInfo = z.object({
  limit: z.number().optional().describe('Items per page in the request.'),
  page: z.number().optional().describe('Current page number (1-indexed).'),
  total_items: z.number().optional().describe('Total number of items across all pages.'),
  total_pages: z.number().optional().describe('Total number of pages available.'),
}).passthrough();

const TokenSummary = z.object({
  id: z.string().optional().describe('Token contract address (chain-canonical form).'),
  name: z.string().optional(),
  symbol: z.string().optional(),
  chain: z.string().optional(),
  decimals: z.number().optional(),
  fdv: z.number().nullable().optional().describe('Fully-diluted valuation in USD.'),
  added_at: z.string().optional().describe('ISO 8601 timestamp when DexPaprika first indexed this token.'),
}).passthrough();

const PoolSummary = z.object({
  id: z.string().optional().describe('Pool contract address.'),
  chain: z.string().optional().describe("Network slug (e.g. 'ethereum'). Note: also exposed as 'network' on some endpoints."),
  dex_id: z.string().optional(),
  dex_name: z.string().optional(),
  fee: z.number().nullable().optional().describe('Pool fee (units depend on DEX; null for some DEXes).'),
  created_at: z.string().optional().describe('ISO 8601 pool-creation timestamp.'),
  created_at_block_number: z.number().optional(),
  tokens: z.array(TokenSummary).optional(),
  last_price: z.number().nullable().optional(),
  last_price_usd: z.number().nullable().optional(),
}).passthrough();

const DexSummary = z.object({
  id: z.string().optional(),
  dex_id: z.string().optional(),
  display_name: z.string().optional(),
  dex_name: z.string().optional(),
  chain: z.string().optional(),
  network_id: z.string().optional(),
  protocol: z.string().optional(),
  volume_usd_24h: z.number().optional(),
  txns_24h: z.number().optional(),
  pools_count: z.number().optional(),
}).passthrough();

const NetworkSummary = z.object({
  display_name: z.string().optional().describe("Human-readable network name (e.g. 'Ethereum')."),
  id: z.string().optional().describe("Network slug for use in other endpoints (e.g. 'ethereum')."),
  volume_usd_24h: z.number().optional().describe('Total 24h trading volume across all pools on this network, USD.'),
  txns_24h: z.number().optional().describe('Total transactions in the last 24h on this network.'),
  pools_count: z.number().optional().describe('Number of indexed pools on this network.'),
}).passthrough();

const OHLCVRow = z.object({
  time_open: z.string().optional().describe('ISO 8601 timestamp of bucket open.'),
  time_close: z.string().optional().describe('ISO 8601 timestamp of bucket close (inclusive at 23:59:59 for 24h).'),
  open: z.number().optional(),
  high: z.number().optional(),
  low: z.number().optional(),
  close: z.number().optional(),
  volume: z.number().optional().describe('Trade volume in the bucket, in pair-quote units (or USD where applicable).'),
}).passthrough();

const PoolTransaction = z.object({
  id: z.string().optional(),
  block_number: z.number().optional(),
  block_timestamp: z.string().optional(),
  pool_id: z.string().optional(),
  token0: z.unknown().optional(),
  token1: z.unknown().optional(),
  amount_usd: z.number().optional(),
}).passthrough();

const PriceEntry = z.object({
  chain: z.string().optional(),
  id: z.string().optional().describe('Token contract address.'),
  price_usd: z.number().nullable().optional().describe('Current USD price; null if not available.'),
}).passthrough();

// Per-tool output schema RAW SHAPES (Record<string, ZodTypeAny>). Wrapped in
// z.object(shape).passthrough() at registration so the outer level also allows
// extra fields (additionalProperties:true), matching the worker.
const OUTPUT_SCHEMAS = {
  getNetworks: {
    networks: z.array(NetworkSummary).describe('All supported blockchain networks with current 24h volume + indexing stats.'),
  },
  getStats: {
    chains: z.number().describe('Total chains indexed.'),
    factories: z.number().describe('Total DEX factory contracts indexed.'),
    pools: z.number().describe('Total pools indexed across all chains.'),
    tokens: z.number().describe('Total tokens indexed.'),
  },
  getCapabilities: {
    server: z.object({ name: z.string(), version: z.string() }).passthrough(),
    stats: z.object({
      networks: z.number(),
      tokens_approx: z.number(),
      pools_approx: z.number(),
      free_tier: z.boolean(),
      key_required_to_start: z.boolean(),
      free_tier_credits_per_month: z.number(),
      free_key_credits_per_month: z.number(),
      free_tier_requests_per_minute: z.number(),
      free_tier_max_data_delay_seconds: z.number(),
      limits_url: z.string().describe('Live source for the quota and rate figures above, which change.'),
      pricing_url: z.string(),
    }).passthrough(),
    network_synonyms: z.record(z.string(), z.array(z.string())).describe('Canonical network id -> common alternates an agent might try.'),
    workflows: z.record(z.string(), z.array(z.string())).describe('Named tool sequences for common agent tasks.'),
    common_pitfalls: z.array(z.string()).describe('Known edge cases agents should be aware of.'),
    documentation: z.string(),
    agent_skills: z.string(),
  },

  // NOTE: the array/page_info keys below are marked .optional() so SDK 1.29's
  // strict structuredContent validation accepts real upstream shapes. The outer
  // schema is .passthrough(), so the documented key (e.g. `results`) is advertised
  // while alternate upstream keys still validate. getNetworkPools,
  // getNetworkPoolsFilter, getDexPools, getTokenPools, getTopTokens, and
  // filterNetworkTokens proxy the /pools/search and /tokens/search endpoints:
  // they return rows under `results` with cursor pagination (has_next_page +
  // next_cursor), not pools/tokens/data + page_info. Keeping every key optional
  // keeps the client robust to upstream shape drift.
  search: {
    tokens: z.array(TokenSummary).optional(),
    pools: z.array(PoolSummary).optional(),
    dexes: z.array(DexSummary).optional(),
  },

  getNetworkDexes: { dexes: z.array(DexSummary).optional(), page_info: PageInfo.optional() },
  getDexPools: { results: z.array(PoolSummary).optional(), has_next_page: z.boolean().optional(), next_cursor: z.string().nullable().optional(), query: z.record(z.string(), z.unknown()).optional() },
  getTokenPools: { results: z.array(PoolSummary).optional(), has_next_page: z.boolean().optional(), next_cursor: z.string().nullable().optional(), query: z.record(z.string(), z.unknown()).optional() },
  getNetworkPools: { results: z.array(PoolSummary).optional(), has_next_page: z.boolean().optional(), next_cursor: z.string().nullable().optional(), query: z.record(z.string(), z.unknown()).optional() },
  getNetworkPoolsFilter: { results: z.array(PoolSummary).optional(), has_next_page: z.boolean().optional(), next_cursor: z.string().nullable().optional(), query: z.record(z.string(), z.unknown()).optional() },
  getTopTokens: { results: z.array(TokenSummary).optional(), has_next_page: z.boolean().optional(), next_cursor: z.string().nullable().optional(), query: z.record(z.string(), z.unknown()).optional() },
  filterNetworkTokens: { results: z.array(TokenSummary).optional(), has_next_page: z.boolean().optional(), next_cursor: z.string().nullable().optional(), query: z.record(z.string(), z.unknown()).optional() },

  getPoolDetails: {
    id: z.string().optional(),
    chain: z.string().optional(),
    factory_id: z.string().optional(),
    dex_id: z.string().optional(),
    dex_name: z.string().optional(),
    created_at: z.string().optional(),
    created_at_block_number: z.number().optional(),
    fee: z.number().nullable().optional(),
    tokens: z.array(TokenSummary).optional(),
    token_reserves: z.array(z.unknown()).optional(),
    last_price: z.number().nullable().optional(),
    last_price_usd: z.number().nullable().optional(),
    price_time: z.string().optional(),
    price_stats: z.unknown().optional(),
  },
  getTokenDetails: {
    id: z.string().optional(),
    name: z.string().optional(),
    symbol: z.string().optional(),
    chain: z.string().optional(),
    decimals: z.number().optional(),
    total_supply: z.union([z.number(), z.string()]).optional().describe('Raw on-chain total supply. Big numbers may overflow JS Number, so handle as string for tokens with 18+ decimals.'),
    description: z.string().optional(),
    website: z.string().optional(),
    has_image: z.boolean().optional(),
    added_at: z.string().optional(),
    price_stats: z.unknown().optional(),
    summary: z.unknown().optional(),
  },

  getPoolOHLCV: {
    ohlcv: z.array(OHLCVRow).describe('Open-High-Low-Close-Volume rows ordered by time_open ascending.'),
  },
  getPoolTransactions: {
    transactions: z.array(PoolTransaction),
    page_info: PageInfo,
  },
  getTokenMultiPrices: {
    prices: z.array(PriceEntry).describe('USD prices for the requested tokens, in input order.'),
    missing_tokens: z.array(z.string()).optional().describe('Input tokens that upstream could not price (invalid address, no liquidity, unknown contract). Empty array when all input tokens were resolved.'),
  },
};

// Build the permissive (outer-passthrough) outputSchema for a tool name.
function outputSchemaFor(name) {
  const shape = OUTPUT_SCHEMAS[name];
  if (!shape) return undefined;
  return z.object(shape).passthrough();
}

// ─────────────────────────────────────────────────────────────────────────────
// getCapabilities document (ported verbatim from src/tools/meta.ts). Local-only,
// no upstream call. network_synonyms references the same NETWORK_SYNONYMS map to
// remove the worker's hand-sync footgun (behavior-identical object).
// ─────────────────────────────────────────────────────────────────────────────
function buildCapabilitiesDocument() {
  return {
    name: SERVER_CANONICAL_NAME,
    aliases: SERVER_ALIASES,
    server: { name: 'DexPaprika MCP', version: SERVER_VERSION },
    tools_count: TOOL_COUNT,
    stats: {
      networks: 36,
      tokens_approx: 33_000_000,
      pools_approx: 36_000_000,
      free_tier: true,             // a free tier exists; it is metered, not unlimited
      key_required_to_start: false,
      // These four move. They last changed on 2026-08-11 (keyless 400K -> 50K,
      // free key 500K -> 300K) and this document is frozen into each published
      // tarball, so an agent that treats them as current will eventually be
      // wrong. limits_url is the live source and takes precedence over anything
      // hard-coded here.
      free_tier_credits_per_month: 50_000,         // keyless, per IP
      free_key_credits_per_month: 300_000,         // with a free API key
      free_tier_requests_per_minute: 30,           // same on both free tiers
      free_tier_max_data_delay_seconds: 15,        // real-time is the Pro figure
      limits_url: 'https://docs.dexpaprika.com/knowledge-base/rate-limits',
      pricing_url: 'https://dexpaprika.com/api/pricing',
    },
    network_synonyms: NETWORK_SYNONYMS,
    workflows: {
      discover_networks: ['getNetworks'],
      find_pools_on_network: ['getNetworks', 'getNetworkPools'],
      filter_pools_by_volume: ['getNetworks', 'getNetworkPoolsFilter'],
      find_new_pools: [
        'getNetworkPoolsFilter with created_after',
        'sort_by=created_at sort_dir=desc',
      ],
      token_details_and_pools: ['getTokenDetails', 'getTokenPools'],
      batch_price_lookup: ['getTokenMultiPrices (max 10 tokens per call)'],
      top_tokens_on_network: ['getTopTokens'],
      filter_tokens_by_metrics: ['filterNetworkTokens'],
      historical_price_chart: ['getPoolOHLCV with start + interval'],
      recent_swaps: ['getPoolTransactions with from/to UNIX timestamps'],
      cross_network_search: ['search with token name/symbol/address'],
    },
    common_pitfalls: [
      '/pools (global) returns 410 Gone: use getNetworkPools, which proxies /networks/{network}/pools/search',
      'getTokenPools token filtering is network-scoped only: the cross-network /pools/search silently ignores token_address, and an unknown token_address returns empty results, not an error',
      'getTokenPools no longer supports inversed/reorder or paired_token_address/address (no equivalent on /networks/{network}/pools/search); invert prices client-side and filter results[].tokens for pair queries',
      'getTokenMultiPrices is capped at 10 tokens per request',
      'getPoolTransactions from/to are UNIX timestamps; results always capped to last 7 days',
      "Token addresses must match the network (e.g., don't send a Solana address to ethereum queries)",
      'This MCP takes sort_by/sort_dir, but the REST API at api.dexpaprika.com takes order_by/sort. The MCP maps them for you, so use sort_by/sort_dir here. If you call the REST API directly, use order_by/sort: an unrecognized parameter NAME is silently dropped and you get the default volume_usd_24h desc ordering, which looks like a working sort. An unrecognized VALUE for order_by does return 400 listing the valid fields.',
    ],
    documentation: 'https://docs.dexpaprika.com',
    agent_skills: 'https://dexpaprika.com/agents/skill.md',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP server instance.
// ─────────────────────────────────────────────────────────────────────────────
const server = new McpServer(
  {
    name: 'dexpaprika',
    version: SERVER_VERSION,
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  },
);

// Number of tools this build registers. Derived after registration rather than
// typed by hand: it was hard-coded to 16 and went stale the moment a tool was
// added, and getCapabilities is machine-read, so a wrong count misleads agents
// rather than just readers.
let TOOL_COUNT = 0;

// ─── getKeyStatus ────────────────────────────────────────────────────────────
// Answers "is my key actually being used?", which on this API you cannot tell
// from a normal call: the data endpoints ignore an unreadable key and serve the
// keyless tier with a 200, so a wrong header name looks exactly like success.
// /usage is the one endpoint that reports the truth.
server.registerTool(
  'getKeyStatus',
  {
    description:
      'Report whether this server is sending an API key and which plan the API sees. '
      + 'Use when calls are being rate limited or refused, or when the user asks whether '
      + 'their DexPaprika key is working. Takes no arguments and reads no market data.',
    inputSchema: {},
    annotations: ANNOTATIONS_READ_ONLY,
  },
  async () => {
    const configured = resolveApiKey() !== null;
    try {
      const usage = await fetchFromAPI('/usage');
      const plan = typeof usage?.plan === 'string' ? usage.plan : null;
      return jsonText({
        api_key_configured: configured,
        key_source: configured ? 'DEXPAPRIKA_API_KEY environment variable' : null,
        plan_reported_by_api: plan,
        // The one case worth calling out loudly: a key is set but the API still
        // sees an anonymous caller, so the key is not reaching us at all.
        key_reaching_api: configured ? plan !== null && plan !== 'keyless' : false,
        diagnosis: !configured
          ? 'No key configured. Running keyless, which works and needs no signup. Set DEXPAPRIKA_API_KEY to raise the monthly allowance and open streaming on any token.'
          : plan === 'keyless'
            ? 'A key is configured but the API still reports the keyless plan, so it is not reaching us. Check the variable name is exactly DEXPAPRIKA_API_KEY and that the value is the key on its own.'
            : `Key is working. The API reports plan "${plan}".`,
        usage,
      });
    } catch (error) {
      // A 401 here is itself the answer: the key arrived and was rejected.
      return jsonText({
        api_key_configured: configured,
        plan_reported_by_api: null,
        key_reaching_api: false,
        diagnosis: configured
          ? 'The key reached the API and was rejected. The most common cause is a scheme word: the key must be the entire Authorization value, so "ApiKey" or "Token" in front of it fails. ("Bearer" is stripped by api.dexpaprika.com and would not cause this.) Otherwise check for a truncated paste.'
          : 'Could not read usage. The server is running keyless, which is the default and needs no key.',
        error: error && typeof error === 'object' && 'error' in error ? error.error : String(error),
      });
    }
  },
);
TOOL_COUNT += 1;

// Helper: register a read tool with rationale + outputSchema + read-only annotations.
function registerReadTool(name, description, inputShape, handler) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: { ...inputShape, rationale: rationaleZod },
      outputSchema: outputSchemaFor(name),
      annotations: ANNOTATIONS_READ_ONLY,
    },
    handler,
  );
  TOOL_COUNT += 1;
}

// ─── getNetworks ─────────────────────────────────────────────────────────────
registerReadTool(
  'getNetworks',
  'List every blockchain network DexPaprika indexes, each row carrying its network id (slug), 24h volume, transaction count, and pool count. Read-only and keyless. Start here (or getCapabilities) to get the exact network slug that nearly every other tool requires as its \'network\' argument. Use for \'which chains do you support?\', \'is Base/Solana/Arbitrum covered?\', or \'what is the slug for Polygon?\'. Returns the full array with no pagination or sorting; takes no parameters beyond a short rationale. For platform-wide totals rather than a per-network list use getStats.',
  {},
  async () => {
    try {
      return jsonText(await fetchFromAPI('/networks'), 'networks');
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getCapabilities (local-only, no upstream call) ──────────────────────────
registerReadTool(
  'getCapabilities',
  'Get the static agent onboarding guide for this server: supported workflows, network name synonyms (mapping words like \'eth\' to the canonical slug \'ethereum\'), recommended call sequences, and common pitfalls. Read-only and keyless. Read it once at the start of a session before your first query, or when asked \'how do I use this API?\', \'what order should I call things in?\', or \'which slug maps to eth?\'. This returns onboarding docs, not live market data; for the actual list of network slugs use getNetworks, and for coverage totals use getStats. Takes no parameters beyond a short rationale.',
  {},
  async () => {
    try {
      return jsonText(buildCapabilitiesDocument());
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getNetworkDexes ─────────────────────────────────────────────────────────
registerReadTool(
  'getNetworkDexes',
  'List the DEXes (exchanges) operating on one network, such as Uniswap on ethereum or Raydium on solana, returned under \'dexes\' with page_info (page, total_pages). Read-only and keyless. Use for \'which DEXes are on Base?\', \'does Solana have Orca?\', or to get a dex id to feed into getDexPools. Scope is a single network; call getNetworks first for the slug. Params: network (required slug); limit (default 10, max 100); page (default 1, 1-indexed); sort_by (only \'pool\'; legacy alias order_by); sort_dir \'asc\' or \'desc\' (default \'desc\'; legacy alias sort).',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    page: z.coerce.number().optional().default(1).describe('OPTIONAL: Page number for pagination (default: 1, 1-indexed)'),
    limit: z.coerce.number().optional().default(10).describe('OPTIONAL: Number of items per page (default: 10, max: 100)'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction, 'asc' or 'desc' (default: 'desc'). The REST API calls this parameter sort."),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL: alias of sort_dir; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes sort, so use this name when calling the REST API directly.'),
    sort_by: z.enum(['pool']).optional().describe("OPTIONAL (preferred): Field to sort by (only 'pool'). The REST API calls this parameter order_by."),
    order_by: z.enum(['pool']).optional().describe('OPTIONAL: alias of sort_by; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes order_by, so use this name when calling the REST API directly.'),
  },
  async (args) => {
    try {
      const { network } = args;
      const page = coercePage(args.page);
      const limit = args.limit ?? 10;
      const direction = args.sort_dir ?? args.sort ?? 'desc';
      const field = args.sort_by ?? args.order_by; // no default — may be undefined
      let endpoint = `/networks/${network}/dexes?page=${page}&limit=${limit}&sort=${direction}`;
      if (field) endpoint += `&order_by=${field}`;
      const upstream = await fetchFromAPI(endpoint);
      // Upstream ignores limit and returns the full list — slice client-side.
      if (upstream && Array.isArray(upstream.dexes)) {
        const total = upstream.dexes.length;
        const effectivePage = Math.max(1, Number(page ?? 1));
        const effectiveLimit = Math.max(1, Number(limit ?? 10));
        const start = (effectivePage - 1) * effectiveLimit;
        upstream.dexes = upstream.dexes.slice(start, start + effectiveLimit);
        upstream.page_info = {
          ...(upstream.page_info ?? {}),
          limit: effectiveLimit,
          page: effectivePage,
          total_items: total,
          total_pages: Math.max(1, Math.ceil(total / effectiveLimit)),
        };
      }
      return jsonText(upstream);
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getNetworkPools ─────────────────────────────────────────────────────────
registerReadTool(
  'getNetworkPools',
  'Get the top liquidity pools across a whole network, ranked by 24h volume by default, returned under \'results\' with has_next_page and next_cursor. Read-only and keyless. This is the primary chain-wide pool discovery tool. Use for \'biggest pools on ethereum\', \'top trading pairs on Base\', or \'most active pools on Solana\'. Narrow to one exchange with getDexPools, or apply numeric/time filters with getNetworkPoolsFilter. Params: network (required slug); limit (default 10, max 100); cursor (pass previous next_cursor to page); sort_by (default \'volume_usd_24h\', canonical *_24h fields, alias order_by); sort_dir \'asc\' or \'desc\' (default \'desc\', alias sort).',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    limit: z.coerce.number().optional().default(10).describe('OPTIONAL: Number of items per page (default: 10, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Pagination cursor. Pass `next_cursor` from a previous response to fetch the next page. Replaces the old page number.'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc'). The REST API calls this parameter sort."),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL: alias of sort_dir; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes sort, so use this name when calling the REST API directly.'),
    sort_by: z.enum(POOL_SORT_FIELDS).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd_24h'). Prefer the canonical *_24h names; short legacy names are still accepted. The REST API calls this parameter order_by."),
    order_by: z.enum(POOL_SORT_FIELDS).optional().describe('OPTIONAL: alias of sort_by; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes order_by, so use this name when calling the REST API directly.'),
  },
  async (args) => {
    try {
      const { network } = args;
      const endpoint = `/networks/${network}/pools/search${toQueryString(buildPoolSearchParams(args))}`;
      return jsonText(await fetchFromAPI(endpoint));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getDexPools ─────────────────────────────────────────────────────────────
// The upstream /networks/{network}/dexes/{dex}/pools endpoint was removed
// (HTTP 410, replacement /networks/{network}/pools/search). The pool search
// endpoint carries a dex_name filter, so this tool proxies it through the same
// search-mapping normalization as getNetworkPools and getTokenPools. The tool
// name and the `dex` argument are kept so agent prompts that already know them
// keep working; only the wire call and the response shape changed.
//
// Two consequences of the swap, both verified live 2026-08-05:
//   - rows come back under `results` with has_next_page + next_cursor, not
//     under `pools` with page_info, and the 24h volume field is now
//     volume_usd_24h rather than volume_usd
//   - /pools/search accepts `page` and silently ignores it (a page=3 request
//     returns the same first row as page=1), so a page above 1 returns a
//     structured error rather than the wrong data under a plausible 200
registerReadTool(
  'getDexPools',
  'Get the pools belonging to one specific DEX on one network, e.g. all Uniswap v3 pools on ethereum. Proxies /networks/{network}/pools/search with a dex_name filter (the old /networks/{network}/dexes/{dex}/pools endpoint was removed): rows come back under \'results\' with cursor pagination (has_next_page + next_cursor), and the 24h volume field is volume_usd_24h. Read-only and keyless. Narrower than getNetworkPools (a single exchange, not the whole chain). Use for \'show me Raydium pools\', \'top pairs on PancakeSwap\', or \'liquidity on Orca\'. Get the dex id from getNetworkDexes or search first, and pass that response\'s dex_id field (\'uniswap_v3\'), matched case-insensitively. Do not pass its dex_name field (\'Uniswap V3\'): a human display name returns HTTP 200 with an empty results[] rather than an error, so an empty answer here usually means the wrong form of the name was sent. Params: network (required slug); dex (required id, e.g. \'uniswap_v3\'; the REST API calls this query parameter dex_name); limit (default 10, max 100); cursor (pass previous next_cursor to page); sort_by (default \'volume_usd_24h\', canonical *_24h fields, short legacy names still accepted, alias order_by); sort_dir \'asc\'/\'desc\' (default \'desc\', alias sort). The old page number is gone: page 2 and above return an error pointing at cursor.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    dex: z.string().describe("REQUIRED: the dex_id field from getNetworkDexes (e.g., 'uniswap_v3'), matched case-insensitively. Do not pass that response's dex_name field, the human display name (e.g., 'Uniswap V3'): it returns an empty results[] instead of an error, so a wrong value looks like a real but empty answer. The REST API calls this parameter dex_name."),
    limit: z.coerce.number().optional().default(10).describe('OPTIONAL: Number of items per page (default: 10, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Pagination cursor. Pass `next_cursor` from a previous response to fetch the next page (read `has_next_page` to know if more remain). Replaces the old page number.'),
    page: z.coerce.number().optional().describe('SUPERSEDED: the replacement endpoint is cursor-paginated and ignores page. page=1 (or 0) still works as the first page; page=2 or above returns a structured error telling you to use cursor.'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc'). The REST API calls this parameter sort."),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL: alias of sort_dir; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes sort, so use this name when calling the REST API directly.'),
    sort_by: z.enum(POOL_SORT_FIELDS).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd_24h'). Prefer the canonical *_24h names; short legacy names such as volume_usd are still accepted and normalized. The REST API calls this parameter order_by."),
    order_by: z.enum(POOL_SORT_FIELDS).optional().describe('OPTIONAL: alias of sort_by; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes order_by, so use this name when calling the REST API directly.'),
  },
  async (args) => {
    try {
      const { network, dex } = args;
      // /pools/search accepts page and silently ignores it, so a page above 1
      // would hand back page 1 under a 200 and an agent paging through would
      // loop forever. Error instead, and point at the cursor that replaced it.
      const page = args.page;
      if (page !== undefined && Number(page) > 1) {
        return errorText(buildErrorResponse(
          ErrorCodes.DP400_UNSUPPORTED_PARAM,
          "'page' is no longer supported: the API removed /networks/{network}/dexes/{dex}/pools and its replacement /networks/{network}/pools/search is cursor-paginated",
          false,
          'Retry without page to get the first page, then pass the response `next_cursor` as `cursor` for each following page while `has_next_page` is true.',
          undefined,
          { parameter: 'page', replacement: 'cursor' },
        ));
      }
      // buildPoolSearchParams picks up dex_name, limit, cursor, and the
      // normalized sort params from args.
      const endpoint = `/networks/${network}/pools/search${toQueryString(buildPoolSearchParams({ ...args, dex_name: dex }))}`;
      return jsonText(await fetchFromAPI(endpoint));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getNetworkPoolsFilter ───────────────────────────────────────────────────
registerReadTool(
  'getNetworkPoolsFilter',
  'Get pools on one network filtered by numeric thresholds, returned under \'results\' with has_next_page and next_cursor. Read-only and keyless. Choose this over getNetworkPools when the user gives numeric constraints or a time window. Use for \'pools over $1M liquidity on Base\', \'pools created in the last 24h\', or \'high-volume low-liquidity pairs\'. Optional filters (AND-combined): volume_24h_min/max, volume_7d_min/max, liquidity_usd_min/max, txns_24h_min, created_after/created_before (Unix timestamps). Also network (required); limit (default 50, max 100); cursor to page; sort_by (default \'volume_usd_24h\', alias order_by); sort_dir asc/desc (default \'desc\', alias sort).',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    limit: z.coerce.number().optional().default(50).describe('OPTIONAL: Number of items per page (default: 50, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Pagination cursor. Pass `next_cursor` from a previous response to fetch the next page. Replaces the old page number.'),
    volume_24h_min: z.coerce.number().optional().describe('OPTIONAL: Minimum 24h volume in USD'),
    volume_24h_max: z.coerce.number().optional().describe('OPTIONAL: Maximum 24h volume in USD'),
    volume_7d_min: z.coerce.number().optional().describe('OPTIONAL: Minimum 7d volume in USD'),
    volume_7d_max: z.coerce.number().optional().describe('OPTIONAL: Maximum 7d volume in USD'),
    liquidity_usd_min: z.coerce.number().optional().describe('OPTIONAL: Minimum pool liquidity in USD'),
    liquidity_usd_max: z.coerce.number().optional().describe('OPTIONAL: Maximum pool liquidity in USD'),
    txns_24h_min: z.coerce.number().optional().describe('OPTIONAL: Minimum number of transactions in 24h'),
    // All four price-change windows filter. Verified live against a
    // garbage-named control, so a silently-dropped parameter could not pass for
    // a working one.
    price_change_percentage_24h_min: z.coerce.number().optional().describe('OPTIONAL: Minimum 24h price change, in percent. Negatives are allowed, so -20 finds pools down at least 20%.'),
    price_change_percentage_24h_max: z.coerce.number().optional().describe('OPTIONAL: Maximum 24h price change, in percent'),
    price_change_percentage_6h_min: z.coerce.number().optional().describe('OPTIONAL: Minimum 6h price change, in percent'),
    price_change_percentage_6h_max: z.coerce.number().optional().describe('OPTIONAL: Maximum 6h price change, in percent'),
    price_change_percentage_1h_min: z.coerce.number().optional().describe('OPTIONAL: Minimum 1h price change, in percent'),
    price_change_percentage_1h_max: z.coerce.number().optional().describe('OPTIONAL: Maximum 1h price change, in percent'),
    price_change_percentage_5m_min: z.coerce.number().optional().describe("OPTIONAL: Minimum 5m price change, in percent. The shortest window we carry, so it is the one to reach for on 'what is moving right now'."),
    price_change_percentage_5m_max: z.coerce.number().optional().describe('OPTIONAL: Maximum 5m price change, in percent'),
    created_after: z.coerce.number().optional().describe('OPTIONAL: Only pools created after this UNIX timestamp'),
    created_before: z.coerce.number().optional().describe('OPTIONAL: Only pools created before this UNIX timestamp'),
    sort_by: z.enum(POOL_SORT_FIELDS).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd_24h'). Prefer the canonical *_24h names; short legacy names are still accepted. The REST API calls this parameter order_by."),
    order_by: z.enum(POOL_SORT_FIELDS).optional().describe('OPTIONAL: alias of sort_by; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes order_by, so use this name when calling the REST API directly.'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc'). The REST API calls this parameter sort."),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL: alias of sort_dir; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes sort, so use this name when calling the REST API directly.'),
  },
  async (args) => {
    try {
      const { network } = args;
      const endpoint = `/networks/${network}/pools/search${toQueryString(buildPoolSearchParams(args))}`;
      return jsonText(await fetchFromAPI(endpoint));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getPoolDetails ──────────────────────────────────────────────────────────
registerReadTool(
  'getPoolDetails',
  'Get the full current snapshot for one pool by address: its two tokens, current price, liquidity/TVL, 24h volume, and transaction counts, returned as a single pool object (not a list). Read-only and keyless. Use after search or getNetworkPools surfaces a pool, or for \'price/TVL of this pool?\' or \'details for pool 0x...\'. Returns live values only; for historical candles use getPoolOHLCV, and for the raw swap feed use getPoolTransactions. Params: network (required slug); pool_address (required, e.g. \'0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640\'); inversed (optional bool, default false, flips the token price ratio to token1/token0).',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    pool_address: z.string().describe("REQUIRED: Pool address or identifier (e.g., '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640')"),
    inversed: z.boolean().optional().default(false).describe('OPTIONAL: Whether to invert the price ratio (default: false)'),
  },
  async ({ network, pool_address, inversed }) => {
    try {
      const endpoint = `/networks/${network}/pools/${pool_address}?inversed=${inversed}`;
      return jsonText(await fetchFromAPI(endpoint));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getPoolOHLCV ────────────────────────────────────────────────────────────
registerReadTool(
  'getPoolOHLCV',
  'Get historical OHLCV candles (open, high, low, close, volume) for one pool over a time range, returned as a time-series array. Read-only and keyless. Use for \'price history of this pair\', \'hourly chart for the last week\', \'candles since Jan 1\', or backtesting; for the single current price use getPoolDetails instead. Params: network (required); pool_address (required); start (required; Unix timestamp, RFC3339, or yyyy-mm-dd); end (optional, capped to 1 year after start); interval one of \'1m\',\'5m\',\'10m\',\'15m\',\'30m\',\'1h\',\'6h\',\'12h\',\'24h\' (default \'24h\'); limit (default 100, max 366 candles); inversed (optional bool, default false).',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    pool_address: z.string().describe('REQUIRED: Pool address or identifier'),
    start: z.string().describe('REQUIRED: Start time for historical data (Unix timestamp, RFC3339 timestamp, or yyyy-mm-dd format)'),
    end: z.string().optional().describe('OPTIONAL: End time for historical data (max 1 year from start)'),
    limit: z.coerce.number().optional().default(100).describe('OPTIONAL: Number of data points to retrieve (default: 100, max: 366)'),
    interval: z.enum(['1m', '5m', '10m', '15m', '30m', '1h', '6h', '12h', '24h']).optional().default('24h').describe("OPTIONAL: Interval granularity (default: '24h')"),
    inversed: z.boolean().optional().default(false).describe('OPTIONAL: Whether to invert the price ratio for alternative pair perspective (default: false)'),
  },
  async ({ network, pool_address, start, end, limit, interval, inversed }) => {
    try {
      let endpoint = `/networks/${network}/pools/${pool_address}/ohlcv?start=${encodeURIComponent(start)}&limit=${limit}&interval=${interval}&inversed=${inversed}`;
      if (end) endpoint += `&end=${encodeURIComponent(end)}`;
      return jsonText(await fetchFromAPI(endpoint), 'ohlcv');
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getPoolTransactions ─────────────────────────────────────────────────────
registerReadTool(
  'getPoolTransactions',
  'Get one pool\'s recent individual swap transactions, newest first, returned under \'transactions\' (paginate with page, or a cursor). Read-only and keyless. These are per-trade records, not aggregated candles (use getPoolOHLCV) or a summary snapshot (use getPoolDetails). Use for \'recent trades on this pool\', \'who swapped in the last hour\', or \'raw transaction feed\'. Params: network (required); pool_address (required); limit (default 10, max 100); page (default 1, up to 100 pages) or cursor (a transaction id); from (optional Unix seconds, inclusive, capped to the last 7 days); to (optional Unix seconds, exclusive, must be after from).',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    pool_address: z.string().describe('REQUIRED: Pool address or identifier'),
    page: z.coerce.number().optional().default(1).describe('OPTIONAL: Page number for pagination, up to 100 pages (default: 1, 1-indexed)'),
    limit: z.coerce.number().optional().default(10).describe('OPTIONAL: Number of items per page (default: 10, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Transaction ID used for cursor-based pagination'),
    from: z.coerce.number().optional().describe('OPTIONAL: Filter transactions starting from this UNIX timestamp (inclusive). Results always capped to last 7 days.'),
    to: z.coerce.number().optional().describe("OPTIONAL: Filter transactions up to this UNIX timestamp (exclusive). Must be after 'from'."),
  },
  async (args) => {
    try {
      const { network, pool_address, cursor, from, to } = args;
      const page = coercePage(args.page);
      const limit = args.limit ?? 10;
      let endpoint = `/networks/${network}/pools/${pool_address}/transactions?page=${page}&limit=${limit}`;
      if (cursor) endpoint += `&cursor=${encodeURIComponent(cursor)}`;
      if (from !== undefined) endpoint += `&from=${from}`;
      if (to !== undefined) endpoint += `&to=${to}`;
      return jsonText(await fetchFromAPI(endpoint));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getTokenDetails ─────────────────────────────────────────────────────────
registerReadTool(
  'getTokenDetails',
  'Get one token\'s data and metadata by contract address on one network: multi-timeframe price and volume metrics, plus name, website, Twitter, and Telegram links, returned as a single token object. Read-only and keyless. Use for \'price and volume for 0x... on Base\' or \'tell me about this token\'. If you only have a symbol like WETH, call search first to resolve the address and network. For many tokens\' prices at once use getTokenMultiPrices; for the pools holding this token use getTokenPools. Params: network (required slug); token_address (required contract address, e.g. \'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN\' on solana).',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    token_address: z.string().describe("REQUIRED: Token contract address (e.g., 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' for Jupiter on Solana)"),
  },
  async ({ network, token_address }) => {
    try {
      const endpoint = `/networks/${network}/tokens/${token_address}`;
      return jsonText(await fetchFromAPI(endpoint));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getTokenPools ───────────────────────────────────────────────────────────
// The upstream /networks/{network}/tokens/{token_address}/pools endpoint was
// removed (HTTP 410, replacement /networks/{network}/pools/search). The pool
// search endpoint gained a token_address filter, so this tool proxies it via
// the same search-mapping normalization as getNetworkPools. The old
// inversed/reorder and paired_token_address/address params have NO equivalent
// on the new endpoint (spec is final per the API team): the params stay in the
// schema so existing callers do not fail input validation, but supplying them
// returns a structured error with a client-side workaround instead of
// silently returning data that does not match the request.
registerReadTool(
  'getTokenPools',
  'Get the liquidity pools that contain a specific token on one network, returned under \'results\' with has_next_page and next_cursor. Read-only and keyless. Use for \'which pools hold WETH on ethereum?\' or \'liquidity venues for 0x...\'. Network-scoped, so run search first if unsure of the network; unknown addresses return empty results, not an error. For the token\'s own price use getTokenDetails. Params: network (required); token_address (required); limit (default 10, max 100); cursor to page; sort_by (default \'volume_usd_24h\', alias order_by); sort_dir asc/desc (default \'desc\', alias sort). Extra params such as inversed or paired_token_address are unsupported and error.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    token_address: z.string().describe('REQUIRED: Token contract address. Results are restricted to pools on the given network containing this token. Unknown addresses return empty results, not an error.'),
    limit: z.coerce.number().optional().default(10).describe('OPTIONAL: Number of items per page (default: 10, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Pagination cursor. Pass `next_cursor` from a previous response to fetch the next page. Replaces the old page number.'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc'). The REST API calls this parameter sort."),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL: alias of sort_dir; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes sort, so use this name when calling the REST API directly.'),
    sort_by: z.enum(POOL_SORT_FIELDS).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd_24h'). Prefer the canonical *_24h names; short legacy names are still accepted. The REST API calls this parameter order_by."),
    order_by: z.enum(POOL_SORT_FIELDS).optional().describe('OPTIONAL: alias of sort_by; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes order_by, so use this name when calling the REST API directly.'),
    inversed: z.boolean().optional().describe('UNSUPPORTED: the replacement endpoint has no pair-perspective flip. Passing true returns a structured error; invert prices client-side (1/price) instead.'),
    reorder: z.boolean().optional().describe('UNSUPPORTED (deprecated alias of inversed): passing true returns a structured error.'),
    paired_token_address: z.string().optional().describe('UNSUPPORTED: the replacement endpoint cannot filter by a second token. Passing it returns a structured error; filter results[].tokens client-side for pair queries.'),
    address: z.string().optional().describe('UNSUPPORTED (deprecated alias of paired_token_address): passing it returns a structured error.'),
  },
  async (args) => {
    try {
      const { network } = args;
      const flip = args.inversed ?? args.reorder;
      if (flip === true) {
        return errorText(buildErrorResponse(
          ErrorCodes.DP400_UNSUPPORTED_PARAM,
          "'inversed'/'reorder' is no longer supported: the API removed /networks/{network}/tokens/{token_address}/pools and its replacement /networks/{network}/pools/search has no pair-perspective flip",
          false,
          "Retry without 'inversed'/'reorder'. Prices come back in the pool's default perspective; compute 1/price client-side if you need the flipped pair.",
          undefined,
          { parameter: 'inversed', legacy_alias: 'reorder' },
        ));
      }
      const paired = args.paired_token_address ?? args.address;
      if (typeof paired === 'string' && paired !== '') {
        return errorText(buildErrorResponse(
          ErrorCodes.DP400_UNSUPPORTED_PARAM,
          "'paired_token_address'/'address' is no longer supported: the replacement /networks/{network}/pools/search accepts a single token_address filter and has no second-token pair filter",
          false,
          "Retry with token_address only, then filter results[].tokens client-side for pools that also contain the second token.",
          undefined,
          { parameter: 'paired_token_address', legacy_alias: 'address' },
        ));
      }
      // buildPoolSearchParams picks up token_address, limit, cursor, and the
      // normalized sort params from args.
      const endpoint = `/networks/${network}/pools/search${toQueryString(buildPoolSearchParams(args))}`;
      return jsonText(await fetchFromAPI(endpoint));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getTokenMultiPrices (hand-built response, not jsonText) ──────────────────
registerReadTool(
  'getTokenMultiPrices',
  'Get current USD prices for up to 10 tokens on the same network in one batched call, returned as a prices array plus a missing_tokens list. Read-only and keyless. Tokens that cannot be priced come back in missing_tokens rather than being dropped, so check that list for partial failures. Use for \'prices for these tokens\', \'compare the price of X, Y and Z\', or building a portfolio/dashboard snapshot. For one token with full metadata and multi-timeframe stats use getTokenDetails. Params: network (required slug, all tokens must share it); tokens (required array of 1 to 10 contract addresses).',
  {
    network: z.string().describe('REQUIRED: Network ID from getNetworks'),
    tokens: z.array(z.string()).min(1).max(10).describe('REQUIRED: Up to 10 token contract addresses on the same network.'),
  },
  async ({ network, tokens }) => {
    try {
      if (tokens.length > 10) {
        return jsonText({
          error: 'Too many tokens',
          message: 'getTokenMultiPrices accepts at most 10 tokens per call.',
          provided: tokens.length,
          limit: 10,
        });
      }
      const joined = tokens.join(',');
      const upstream = await fetchFromAPI(`/networks/${network}/multi/prices?tokens=${encodeURIComponent(joined)}`);
      const prices = Array.isArray(upstream) ? upstream : [];
      // Upstream silently drops tokens it can't price — surface them so callers
      // can detect partial failures without a set-difference of their own.
      const returnedIds = new Set(prices.map((p) => String(p?.id ?? '').toLowerCase()));
      const missing_tokens = tokens.filter((t) => !returnedIds.has(t.toLowerCase()));
      const enriched = { prices, missing_tokens };
      return {
        content: [{ type: 'text', text: JSON.stringify(enriched) }],
        structuredContent: enriched,
      };
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── filterNetworkTokens ─────────────────────────────────────────────────────
registerReadTool(
  'filterNetworkTokens',
  'Get tokens on one network matching numeric thresholds, returned under \'results\' with has_next_page and next_cursor. Read-only and keyless. Choose this over getTopTokens when the user gives numeric constraints or a time window. Use for \'tokens with FDV over $10M on Base\', \'newly created tokens today\', or \'low-liquidity high-volume tokens\'. Optional filters (AND-combined): volume_24h_min/max, liquidity_usd_min/max, fdv_min/max, txns_24h_min, price_change_percentage_24h_min/max, created_after/created_before (Unix timestamps). Also network (required); limit (default 50, max 100); cursor to page; sort_by (default \'volume_usd_24h\', alias order_by); sort_dir asc/desc (default \'desc\', alias sort).',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    limit: z.coerce.number().optional().default(50).describe('OPTIONAL: Number of items per page (default: 50, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Pagination cursor. Pass `next_cursor` from a previous response to fetch the next page. Replaces the old page number.'),
    volume_24h_min: z.coerce.number().optional().describe('OPTIONAL: Minimum 24h volume in USD'),
    volume_24h_max: z.coerce.number().optional().describe('OPTIONAL: Maximum 24h volume in USD'),
    liquidity_usd_min: z.coerce.number().optional().describe('OPTIONAL: Minimum token liquidity in USD'),
    liquidity_usd_max: z.coerce.number().optional().describe('OPTIONAL: Maximum token liquidity in USD'),
    fdv_min: z.coerce.number().optional().describe('OPTIONAL: Minimum fully diluted valuation in USD'),
    fdv_max: z.coerce.number().optional().describe('OPTIONAL: Maximum fully diluted valuation in USD'),
    txns_24h_min: z.coerce.number().optional().describe('OPTIONAL: Minimum number of transactions in 24h'),
    price_change_percentage_24h_min: z.coerce.number().optional().describe('OPTIONAL: Minimum 24h price change, in percent. Negatives are allowed, so -20 finds tokens down at least 20%. This is the only price-change window tokens carry; for 6h, 1h or 5m use getNetworkPoolsFilter.'),
    price_change_percentage_24h_max: z.coerce.number().optional().describe('OPTIONAL: Maximum 24h price change, in percent'),
    created_after: z.coerce.number().optional().describe('OPTIONAL: Only tokens created after this UNIX timestamp'),
    created_before: z.coerce.number().optional().describe('OPTIONAL: Only tokens created before this UNIX timestamp'),
    sort_by: z.enum(TOKEN_SORT_FIELDS).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd_24h'). Prefer the canonical names; short legacy names are still accepted. The REST API calls this parameter order_by."),
    order_by: z.enum(TOKEN_SORT_FIELDS).optional().describe('OPTIONAL: alias of sort_by; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes order_by, so use this name when calling the REST API directly.'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc'). The REST API calls this parameter sort."),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL: alias of sort_dir; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes sort, so use this name when calling the REST API directly.'),
  },
  async (args) => {
    try {
      const { network } = args;
      const endpoint = `/networks/${network}/tokens/search${toQueryString(buildTokenSearchParams(args))}`;
      return jsonText(await fetchFromAPI(endpoint));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getTopTokens ────────────────────────────────────────────────────────────
registerReadTool(
  'getTopTokens',
  'Get the top tokens on one network ranked by volume, liquidity, transactions, FDV, or 24h price change, returned under \'results\' with has_next_page and next_cursor. Read-only and keyless. Use for \'top gainers on Solana\', \'highest-volume tokens on Base\', or \'biggest tokens by FDV on ethereum\'. For arbitrary numeric filters or a time window use filterNetworkTokens instead. Params: network (required slug); limit (default 50, max 100); cursor (pass previous next_cursor to page); sort_by (default \'volume_usd_24h\', alias order_by), noting that ranking by raw price is unsupported and silently falls back to volume; sort_dir asc/desc (default \'desc\', alias sort).',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    limit: z.coerce.number().optional().default(50).describe('OPTIONAL: Number of items per page (default: 50, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Pagination cursor. Pass `next_cursor` from a previous response to fetch the next page. Replaces the old page number.'),
    sort_by: z.enum(TOKEN_SORT_FIELDS).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd_24h'). Prefer the canonical names; short legacy names are still accepted. The REST API calls this parameter order_by."),
    order_by: z.enum(TOKEN_SORT_FIELDS).optional().describe('OPTIONAL: alias of sort_by; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes order_by, so use this name when calling the REST API directly.'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc'). The REST API calls this parameter sort."),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL: alias of sort_dir; both are accepted. Not deprecated at the REST layer: api.dexpaprika.com itself takes sort, so use this name when calling the REST API directly.'),
  },
  async (args) => {
    try {
      const { network } = args;
      const endpoint = `/networks/${network}/tokens/search${toQueryString(buildTokenSearchParams(args))}`;
      return jsonText(await fetchFromAPI(endpoint));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── search (cross-network) ──────────────────────────────────────────────────
registerReadTool(
  'search',
  'Search across ALL networks at once for tokens, pools, and DEXes by name, symbol, or address, returning three arrays: \'tokens\', \'pools\', and \'dexes\'. Read-only and keyless. This is the cross-chain entry point when you do not yet know which network something lives on; once you have a network slug from the results, switch to the network-scoped tools. Use for \'find PEPE\', \'what is the address for USDC\', or \'which chain is this token on?\'. No matches returns empty arrays, not an error. Params: query (required; a name, symbol, or contract address, e.g. \'uniswap\', \'bitcoin\', or \'0x...\'); limit (optional, caps results per category, applied client-side).',
  {
    query: z.string().describe("REQUIRED: Search term (e.g., 'uniswap', 'bitcoin', or a token address)"),
    limit: z.coerce.number().optional().describe('OPTIONAL: Max results per category (tokens/pools/dexes), applied client-side'),
  },
  async ({ query, limit }) => {
    try {
      const upstream = await fetchFromAPI(`/search?query=${encodeURIComponent(query)}`);
      // Rename dex_id -> factory_id in pools[] for consistency with getPoolDetails.
      if (upstream && Array.isArray(upstream.pools)) {
        upstream.pools = upstream.pools.map((p) => {
          if (p && typeof p === 'object' && 'dex_id' in p) {
            const { dex_id, ...rest } = p;
            return { ...rest, factory_id: dex_id };
          }
          return p;
        });
      }
      // Client-side per-category limit. Never sent upstream.
      if (limit !== undefined && upstream && typeof upstream === 'object') {
        const n = Math.max(1, Math.floor(limit));
        for (const key of ['tokens', 'pools', 'dexes']) {
          if (Array.isArray(upstream[key])) upstream[key] = upstream[key].slice(0, n);
        }
      }
      return jsonText(upstream);
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getStats ────────────────────────────────────────────────────────────────
registerReadTool(
  'getStats',
  'Get platform-wide totals for DexPaprika: the number of networks, DEXes, pools, and tokens indexed, returned as a single summary object. Read-only and keyless. Use for \'how much data do you cover?\', \'how many chains or pools total?\', or a one-line coverage summary. These are ecosystem-wide counts, not per-network figures; use getNetworks for the per-chain breakdown, or getCapabilities for onboarding docs. Takes no parameters beyond a short rationale.',
  {},
  async () => {
    try {
      return jsonText(await fetchFromAPI('/stats'));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Start the server over stdio.
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`DexPaprika MCP server v${PACKAGE_VERSION} (tool contract v${SERVER_VERSION}) is running...`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
