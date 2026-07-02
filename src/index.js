import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'module';
import { buildPoolSearchParams, buildTokenSearchParams, toQueryString } from './search-mapping.js';

const PACKAGE_VERSION = createRequire(import.meta.url)('../package.json').version;

// Sort-field values accepted by the pool/token tools. Canonical *_24h names are
// what /pools/search and /tokens/search use; the trailing short names are legacy
// aliases kept for back-compat and normalized in search-mapping.js.
const POOL_SORT_FIELDS = ['volume_usd_24h', 'volume_usd_7d', 'volume_usd_30d', 'liquidity_usd', 'txns_24h', 'created_at', 'price_usd', 'price_change_percentage_24h', 'volume_usd', 'transactions', 'last_price_change_usd_24h', 'volume_24h', 'volume_7d', 'volume_30d', 'liquidity'];
const TOKEN_SORT_FIELDS = ['volume_usd_24h', 'volume_usd_7d', 'volume_usd_30d', 'liquidity_usd', 'txns_24h', 'fdv_usd', 'created_at', 'price_change_percentage_24h', 'volume_24h', 'volume_7d', 'volume_30d', 'txns', 'price_change', 'fdv', 'price_usd'];

// ─────────────────────────────────────────────────────────────────────────────
// DexPaprika MCP — self-host (stdio) build, contract-aligned 1:1 with the hosted
// v2.0.0 Cloudflare Worker. Only the transport differs (stdio vs HTTP). Tools,
// params/aliases, synonym resolution, sort normalization, output schemas,
// instructions and version match the worker.
// ─────────────────────────────────────────────────────────────────────────────

// Base URL for DexPaprika API. DexPaprika is fully free: no API key, no auth header.
const API_BASE_URL = 'https://api.dexpaprika.com';

// Server version — matches the hosted worker.
const SERVER_VERSION = '2.0.0';

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
  DP404_NOT_FOUND: 'DP404_NOT_FOUND',
  DP429_RATE_LIMIT: 'DP429_RATE_LIMIT',
};

function buildErrorResponse(code, message, retryable, suggestion, correctedExample, metadata) {
  const error = { error: { code, message, retryable, suggestion } };
  if (correctedExample) error.error.corrected_example = correctedExample;
  if (metadata) error.error.metadata = metadata;
  return error;
}

// Defensively parse a deprecation hint out of an error response body. The API
// signals a removed/moved endpoint with a JSON body of the shape
// { "code": 410, "message": "endpoint removed", "replacement": "/networks/:network/pools/search" }.
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

function parseAPIError(status, statusText, endpoint, body) {
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
    const resetTime = new Date();
    resetTime.setHours(24, 0, 0, 0);
    return buildErrorResponse(
      ErrorCodes.DP429_RATE_LIMIT,
      'Daily rate limit exceeded',
      true,
      'Wait until rate limit resets or use cached data',
      undefined,
      {
        reset_at: resetTime.toISOString(),
        retry_after_seconds: Math.floor((resetTime.getTime() - Date.now()) / 1000),
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
  const response = await fetch(url);
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
    throw parseAPIError(response.status, response.statusText, endpoint, body);
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
  if (err && typeof err === 'object' && 'error' in err) {
    return {
      content: [{ type: 'text', text: JSON.stringify(err, null, 2) }],
    };
  }
  return {
    content: [{
      type: 'text',
      text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
    }],
  };
}

// MCP tool annotations.
const ANNOTATIONS_READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: true,
};
const ANNOTATIONS_WRITE_FEEDBACK = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// rationale field — REQUIRED on every read tool (all tools except submitFeedback).
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
  '# DexPaprika MCP — agent usage notes',
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
  '`submitFeedback` is the exception — it has its own `goal`/`expected`/`observed` fields which serve as the rationale.',
  '',
  '## Tool discovery',
  'Start with `getNetworks` (discover supported chains) or `getCapabilities` (agent-onboarding doc: network synonyms, workflow patterns, common pitfalls). Both are free and have no parameters beyond rationale.',
  '',
  '## Parameter naming',
  'Sort parameters accept both legacy and canonical names — pick whichever is clearer; the server normalizes both. Canonical names (preferred going forward):',
  '- `sort_dir` (legacy: `sort`) — sort direction, "asc" or "desc".',
  '- `sort_by` (legacy: `order_by`) — sort field, tool-specific enum.',
  '',
  '`getTokenPools` also accepts:',
  "- `inversed` (legacy: `reorder`) — flip pool's pair perspective.",
  '- `paired_token_address` (legacy: `address`) — filter pools that also contain this token.',
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
  'Array-returning tools wrap the array under a named key in structuredContent — `getNetworks` → `{ networks: [...] }`, `getPoolOHLCV` → `{ ohlcv: [...] }`, `getTokenMultiPrices` → `{ prices: [...] }`.',
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
      free: z.boolean(),
      requires_api_key: z.boolean(),
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
  // getNetworkPoolsFilter, getTopTokens, and filterNetworkTokens proxy the
  // /pools/search and /tokens/search endpoints: they return rows under `results`
  // with cursor pagination (has_next_page + next_cursor), not pools/tokens/data
  // + page_info. Keeping every key optional keeps the client robust to upstream
  // shape drift.
  search: {
    tokens: z.array(TokenSummary).optional(),
    pools: z.array(PoolSummary).optional(),
    dexes: z.array(DexSummary).optional(),
  },

  getNetworkDexes: { dexes: z.array(DexSummary).optional(), page_info: PageInfo.optional() },
  getDexPools: { pools: z.array(PoolSummary).optional(), page_info: PageInfo.optional() },
  getTokenPools: { pools: z.array(PoolSummary).optional(), page_info: PageInfo.optional() },
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
    total_supply: z.union([z.number(), z.string()]).optional().describe('Raw on-chain total supply. Big numbers may overflow JS Number — handle as string for tokens with 18+ decimals.'),
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

  submitFeedback: {
    ok: z.boolean().describe('True if the feedback was accepted.'),
    tracking_id: z.string().nullable().optional().describe('Stable id agents can reference in follow-up submissions; null if persistence failed.'),
    message: z.string(),
    severity: z.enum(['blocker', 'major', 'minor', 'nit']).optional(),
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
    tools_count: 17,
    stats: {
      networks: 35,
      tokens_approx: 29_000_000,
      pools_approx: 31_000_000,
      free: true,
      requires_api_key: false,
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
      '/pools (global) returns 410 Gone — use /networks/{network}/pools instead',
      'getTokenMultiPrices is capped at 10 tokens per request',
      'getPoolTransactions from/to are UNIX timestamps; results always capped to last 7 days',
      "Token addresses must match the network (e.g., don't send a Solana address to ethereum queries)",
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
}

// ─── getNetworks ─────────────────────────────────────────────────────────────
registerReadTool(
  'getNetworks',
  'START HERE: list all supported blockchain networks with current 24h volume and indexing stats. Prefer calling getCapabilities first to see workflows and synonyms.',
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
  'Return server capabilities, workflow patterns, network synonyms, common pitfalls, and best-practice sequences. Use this to onboard agents quickly. No parameters required beyond rationale.',
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
  'Get available DEXes on a specific network. REQUIRED: network. OPTIONAL: page, limit, sort_dir/sort, sort_by/order_by.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    page: z.number().optional().default(1).describe('OPTIONAL: Page number for pagination (default: 1, 1-indexed)'),
    limit: z.number().optional().default(10).describe('OPTIONAL: Number of items per page (default: 10, max: 100)'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction, 'asc' or 'desc' (default: 'desc')"),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL (deprecated alias of sort_dir): Sort direction'),
    sort_by: z.enum(['pool']).optional().describe("OPTIONAL (preferred): Field to sort by (only 'pool')"),
    order_by: z.enum(['pool']).optional().describe('OPTIONAL (deprecated alias of sort_by): Field to sort by'),
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
  'PRIMARY POOL FUNCTION: get top liquidity pools on a network. Proxies /networks/{network}/pools/search: rows are returned under `results` with cursor pagination (has_next_page + next_cursor). REQUIRED: network. OPTIONAL: limit, cursor, sort_dir/sort, sort_by/order_by.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    limit: z.number().optional().default(10).describe('OPTIONAL: Number of items per page (default: 10, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Pagination cursor. Pass `next_cursor` from a previous response to fetch the next page. Replaces the old page number.'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc')"),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL (deprecated alias of sort_dir): Sort direction'),
    sort_by: z.enum(POOL_SORT_FIELDS).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd_24h'). Prefer the canonical *_24h names; short legacy names are still accepted."),
    order_by: z.enum(POOL_SORT_FIELDS).optional().describe('OPTIONAL (deprecated alias of sort_by): Field to sort by'),
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
registerReadTool(
  'getDexPools',
  'Get pools from a specific DEX on a network. REQUIRED: network, dex. OPTIONAL: page, limit, sort_dir/sort, sort_by/order_by.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    dex: z.string().describe("REQUIRED: DEX identifier from getNetworkDexes (e.g., 'uniswap_v3')"),
    page: z.number().optional().default(1).describe('OPTIONAL: Page number for pagination (default: 1, 1-indexed)'),
    limit: z.number().optional().default(10).describe('OPTIONAL: Number of items per page (default: 10, max: 100)'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc')"),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL (deprecated alias of sort_dir): Sort direction'),
    sort_by: z.enum(['volume_usd', 'price_usd', 'transactions', 'last_price_change_usd_24h', 'created_at']).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd')"),
    order_by: z.enum(['volume_usd', 'price_usd', 'transactions', 'last_price_change_usd_24h', 'created_at']).optional().describe('OPTIONAL (deprecated alias of sort_by): Field to sort by'),
  },
  async (args) => {
    try {
      const { network, dex } = args;
      const page = coercePage(args.page);
      const limit = args.limit ?? 10;
      const direction = args.sort_dir ?? args.sort ?? 'desc';
      const field = args.sort_by ?? args.order_by ?? 'volume_usd';
      const endpoint = `/networks/${network}/dexes/${dex}/pools?page=${page}&limit=${limit}&sort=${direction}&order_by=${field}`;
      return jsonText(await fetchFromAPI(endpoint));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getNetworkPoolsFilter ───────────────────────────────────────────────────
registerReadTool(
  'getNetworkPoolsFilter',
  'Filter pools by volume, liquidity, transactions, and creation time. Proxies /networks/{network}/pools/search with filter params; rows are returned under `results` with cursor pagination. REQUIRED: network. OPTIONAL: limit, cursor, volume_24h_min/max, volume_7d_min/max, liquidity_usd_min/max, txns_24h_min, created_after, created_before, sort_by/order_by, sort_dir/sort.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    limit: z.number().optional().default(50).describe('OPTIONAL: Number of items per page (default: 50, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Pagination cursor. Pass `next_cursor` from a previous response to fetch the next page. Replaces the old page number.'),
    volume_24h_min: z.number().optional().describe('OPTIONAL: Minimum 24h volume in USD'),
    volume_24h_max: z.number().optional().describe('OPTIONAL: Maximum 24h volume in USD'),
    volume_7d_min: z.number().optional().describe('OPTIONAL: Minimum 7d volume in USD'),
    volume_7d_max: z.number().optional().describe('OPTIONAL: Maximum 7d volume in USD'),
    liquidity_usd_min: z.number().optional().describe('OPTIONAL: Minimum pool liquidity in USD'),
    liquidity_usd_max: z.number().optional().describe('OPTIONAL: Maximum pool liquidity in USD'),
    txns_24h_min: z.number().optional().describe('OPTIONAL: Minimum number of transactions in 24h'),
    created_after: z.number().optional().describe('OPTIONAL: Only pools created after this UNIX timestamp'),
    created_before: z.number().optional().describe('OPTIONAL: Only pools created before this UNIX timestamp'),
    sort_by: z.enum(POOL_SORT_FIELDS).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd_24h'). Prefer the canonical *_24h names; short legacy names are still accepted."),
    order_by: z.enum(POOL_SORT_FIELDS).optional().describe('OPTIONAL (deprecated alias of sort_by): Field to sort by'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc')"),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL (deprecated alias of sort_dir): Sort direction'),
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
  'Get detailed info about a pool. REQUIRED: network, pool_address. OPTIONAL: inversed.',
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
  'Get historical price data (OHLCV) for a pool. REQUIRED: network, pool_address, start. OPTIONAL: end, limit, interval, inversed.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    pool_address: z.string().describe('REQUIRED: Pool address or identifier'),
    start: z.string().describe('REQUIRED: Start time for historical data (Unix timestamp, RFC3339 timestamp, or yyyy-mm-dd format)'),
    end: z.string().optional().describe('OPTIONAL: End time for historical data (max 1 year from start)'),
    limit: z.number().optional().default(100).describe('OPTIONAL: Number of data points to retrieve (default: 100, max: 366)'),
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
  'Get recent transactions for a pool. Use from/to for time-range filtering (UNIX epoch seconds, results capped to last 7 days). REQUIRED: network, pool_address. OPTIONAL: page, limit, cursor, from, to.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    pool_address: z.string().describe('REQUIRED: Pool address or identifier'),
    page: z.number().optional().default(1).describe('OPTIONAL: Page number for pagination, up to 100 pages (default: 1, 1-indexed)'),
    limit: z.number().optional().default(10).describe('OPTIONAL: Number of items per page (default: 10, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Transaction ID used for cursor-based pagination'),
    from: z.number().optional().describe('OPTIONAL: Filter transactions starting from this UNIX timestamp (inclusive). Results always capped to last 7 days.'),
    to: z.number().optional().describe("OPTIONAL: Filter transactions up to this UNIX timestamp (exclusive). Must be after 'from'."),
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
  'Get detailed information about a token. REQUIRED: network, token_address.',
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
registerReadTool(
  'getTokenPools',
  'Get liquidity pools containing a token. REQUIRED: network, token_address. OPTIONAL: page, limit, sort_dir/sort, sort_by/order_by, inversed/reorder, paired_token_address/address.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    token_address: z.string().describe('REQUIRED: Token contract address'),
    page: z.number().optional().default(1).describe('OPTIONAL: Page number for pagination (default: 1, 1-indexed)'),
    limit: z.number().optional().default(10).describe('OPTIONAL: Number of items per page (default: 10, max: 100)'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc')"),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL (deprecated alias of sort_dir): Sort direction'),
    sort_by: z.enum(['volume_usd', 'price_usd', 'transactions', 'last_price_change_usd_24h', 'created_at']).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd')"),
    order_by: z.enum(['volume_usd', 'price_usd', 'transactions', 'last_price_change_usd_24h', 'created_at']).optional().describe('OPTIONAL (deprecated alias of sort_by): Field to sort by'),
    inversed: z.boolean().optional().describe("OPTIONAL (preferred): Flip the pool's pair perspective so the specified token becomes primary"),
    reorder: z.boolean().optional().describe('OPTIONAL (deprecated alias of inversed): Reorder the pool'),
    paired_token_address: z.string().optional().describe('OPTIONAL (preferred): Filter pools that also contain this token address'),
    address: z.string().optional().describe('OPTIONAL (deprecated alias of paired_token_address): Additional token address filter'),
  },
  async (args) => {
    try {
      const { network, token_address } = args;
      const page = coercePage(args.page);
      const limit = args.limit ?? 10;
      const direction = args.sort_dir ?? args.sort ?? 'desc';
      const field = args.sort_by ?? args.order_by ?? 'volume_usd';
      const flip = args.inversed ?? args.reorder; // may be undefined
      const paired = args.paired_token_address ?? args.address; // may be undefined
      let endpoint = `/networks/${network}/tokens/${token_address}/pools?page=${page}&limit=${limit}&sort=${direction}&order_by=${field}`;
      if (flip !== undefined) endpoint += `&reorder=${flip}`;
      if (paired) endpoint += `&address=${encodeURIComponent(paired)}`;
      return jsonText(await fetchFromAPI(endpoint));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── getTokenMultiPrices (hand-built response, not jsonText) ──────────────────
registerReadTool(
  'getTokenMultiPrices',
  'Get batched prices for multiple tokens. Max 10 tokens per call, same network. REQUIRED: network, tokens.',
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
  'Filter tokens by volume, liquidity, FDV, transactions, and creation time. Proxies /networks/{network}/tokens/search with filter params; rows are returned under `results` with cursor pagination. REQUIRED: network. OPTIONAL: limit, cursor, volume_24h_min/max, liquidity_usd_min/max, fdv_min/max, txns_24h_min, created_after/before, sort_by/order_by, sort_dir/sort.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    limit: z.number().optional().default(50).describe('OPTIONAL: Number of items per page (default: 50, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Pagination cursor. Pass `next_cursor` from a previous response to fetch the next page. Replaces the old page number.'),
    volume_24h_min: z.number().optional().describe('OPTIONAL: Minimum 24h volume in USD'),
    volume_24h_max: z.number().optional().describe('OPTIONAL: Maximum 24h volume in USD'),
    liquidity_usd_min: z.number().optional().describe('OPTIONAL: Minimum token liquidity in USD'),
    liquidity_usd_max: z.number().optional().describe('OPTIONAL: Maximum token liquidity in USD'),
    fdv_min: z.number().optional().describe('OPTIONAL: Minimum fully diluted valuation in USD'),
    fdv_max: z.number().optional().describe('OPTIONAL: Maximum fully diluted valuation in USD'),
    txns_24h_min: z.number().optional().describe('OPTIONAL: Minimum number of transactions in 24h'),
    created_after: z.number().optional().describe('OPTIONAL: Only tokens created after this UNIX timestamp'),
    created_before: z.number().optional().describe('OPTIONAL: Only tokens created before this UNIX timestamp'),
    sort_by: z.enum(TOKEN_SORT_FIELDS).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd_24h'). Prefer the canonical names; short legacy names are still accepted."),
    order_by: z.enum(TOKEN_SORT_FIELDS).optional().describe('OPTIONAL (deprecated alias of sort_by): Field to sort by'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc')"),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL (deprecated alias of sort_dir): Sort direction'),
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
  'Get top tokens on a network ranked by volume, liquidity, transactions, FDV, or 24h price change. Proxies /networks/{network}/tokens/search: rows are returned under `results` (address, price_usd, volume_usd_24h, liquidity_usd, fdv_usd, txns_24h, price_change_percentage_24h) with cursor pagination. Ordering by price is not supported and falls back to volume. REQUIRED: network. OPTIONAL: limit, cursor, sort_by/order_by, sort_dir/sort.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    limit: z.number().optional().default(50).describe('OPTIONAL: Number of items per page (default: 50, max: 100)'),
    cursor: z.string().optional().describe('OPTIONAL: Pagination cursor. Pass `next_cursor` from a previous response to fetch the next page. Replaces the old page number.'),
    sort_by: z.enum(TOKEN_SORT_FIELDS).optional().describe("OPTIONAL (preferred): Field to sort by (default: 'volume_usd_24h'). Prefer the canonical names; short legacy names are still accepted."),
    order_by: z.enum(TOKEN_SORT_FIELDS).optional().describe('OPTIONAL (deprecated alias of sort_by): Field to sort by'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe("OPTIONAL (preferred): Sort direction (default: 'desc')"),
    sort: z.enum(['asc', 'desc']).optional().describe('OPTIONAL (deprecated alias of sort_dir): Sort direction'),
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
  "Search across ALL networks for tokens, pools, and DEXes by name, symbol, or address. Good starting point when you don't know the specific network. REQUIRED: query. OPTIONAL: limit (per-category, applied client-side).",
  {
    query: z.string().describe("REQUIRED: Search term (e.g., 'uniswap', 'bitcoin', or a token address)"),
    limit: z.number().optional().describe('OPTIONAL: Max results per category (tokens/pools/dexes), applied client-side'),
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
  'Get high-level statistics about the DexPaprika ecosystem: total chains, factories, pools, and tokens indexed. No parameters required beyond rationale.',
  {},
  async () => {
    try {
      return jsonText(await fetchFromAPI('/stats'));
    } catch (error) {
      return errorText(error);
    }
  },
);

// ─── submitFeedback (17th tool, NO rationale, write annotation) ──────────────
// stdio has no D1; we degrade to a structured ack instead of a DB INSERT.
server.registerTool(
  'submitFeedback',
  {
    description:
      "Call this when you got stuck, when a tool's response was unexpected, when you needed information that wasn't available, or when something didn't behave as documented. Low friction — submit even partial feedback. We read every submission. Does NOT require a 'rationale' field; the goal/expected/observed fields below ARE the rationale.",
    inputSchema: {
      goal: z.string().min(10).max(500).describe('REQUIRED. What you were trying to accomplish (10-500 chars).'),
      attempted_tools: z.array(z.string()).optional().describe('OPTIONAL. Tools you tried before getting stuck.'),
      blocked_at: z.string().optional().describe('OPTIONAL. Where exactly you got blocked.'),
      expected: z.string().max(500).optional().describe('OPTIONAL. What you expected to happen (max 500 chars).'),
      observed: z.string().max(500).optional().describe('OPTIONAL. What actually happened (max 500 chars).'),
      severity: z.enum(['blocker', 'major', 'minor', 'nit']).optional().default('minor').describe("OPTIONAL. Impact severity (default: 'minor')."),
    },
    outputSchema: outputSchemaFor('submitFeedback'),
    annotations: ANNOTATIONS_WRITE_FEEDBACK,
  },
  async ({ severity }) => {
    // No D1 / no analytics sink in the self-host build. Accept and acknowledge.
    const ack = {
      ok: true,
      tracking_id: null,
      message: 'Thanks. This self-host build does not persist feedback; please open an issue at https://github.com/coinpaprika/dexpaprika-mcp for anything actionable.',
      severity: severity ?? 'minor',
    };
    return jsonText(ack);
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
