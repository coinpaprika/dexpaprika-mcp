import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fetch from 'node-fetch';
import { z } from 'zod';

// Base URL for DexPaprika API
const API_BASE_URL = 'https://api.dexpaprika.com';

// Server version
const SERVER_VERSION = '1.3.0';

// Error code constants
const ErrorCodes = {
  DP400_INVALID_NETWORK: "DP400_INVALID_NETWORK",
  DP400_TOO_MANY_TOKENS: "DP400_TOO_MANY_TOKENS",
  DP400_INVALID_ADDRESS: "DP400_INVALID_ADDRESS",
  DP400_MISSING_REQUIRED: "DP400_MISSING_REQUIRED",
  DP404_NOT_FOUND: "DP404_NOT_FOUND",
  DP429_RATE_LIMIT: "DP429_RATE_LIMIT",
};

// Structured error response builder
function buildErrorResponse(code, message, retryable, suggestion, correctedExample, metadata) {
  const error = {
    error: {
      code,
      message,
      retryable,
      suggestion,
    }
  };
  if (correctedExample) {
    error.error.corrected_example = correctedExample;
  }
  if (metadata) {
    error.error.metadata = metadata;
  }
  return error;
}

// Parse API error response and convert to structured format
function parseAPIError(status, statusText, endpoint) {
  if (status === 404 && endpoint.includes('/networks/')) {
    const networkMatch = endpoint.match(/\/networks\/([^\/\?]+)/);
    const providedNetwork = networkMatch ? networkMatch[1] : 'unknown';
    return buildErrorResponse(
      ErrorCodes.DP400_INVALID_NETWORK,
      `Network ID '${providedNetwork}' not recognized`,
      true,
      "Use normalized network ID from getNetworks. Call getCapabilities for network_synonyms.",
      `getNetworkPools('ethereum', 10)`,
      {
        provided: providedNetwork,
        suggested: "ethereum",
        valid_networks: ["ethereum", "bsc", "polygon", "base", "arbitrum", "optimism", "solana", "avalanche", "fantom"]
      }
    );
  }

  if (status === 404) {
    return buildErrorResponse(
      ErrorCodes.DP404_NOT_FOUND,
      "Resource not found",
      false,
      "Verify the resource exists. Use search or list endpoints to find correct identifiers.",
      undefined,
      { endpoint }
    );
  }

  if (status === 429) {
    const resetTime = new Date();
    resetTime.setHours(24, 0, 0, 0);
    return buildErrorResponse(
      ErrorCodes.DP429_RATE_LIMIT,
      "Daily rate limit of 10,000 requests exceeded",
      true,
      "Wait until rate limit resets or use cached data",
      undefined,
      {
        limit: 10000,
        reset_at: resetTime.toISOString(),
        retry_after_seconds: Math.floor((resetTime.getTime() - Date.now()) / 1000)
      }
    );
  }

  if (status === 400) {
    return buildErrorResponse(
      ErrorCodes.DP400_MISSING_REQUIRED,
      `Bad request: ${statusText}`,
      false,
      "Check that all required parameters are provided with correct formats",
      undefined,
      { endpoint, status }
    );
  }

  return buildErrorResponse(
    `DP${status}_ERROR`,
    `API request failed: ${status} ${statusText}`,
    false,
    "Check API documentation or try again later",
    undefined,
    { endpoint, status }
  );
}

// Rate limit tracking
let requestCount = 0;
const RATE_LIMIT = 10000;

// Helper function to fetch data from DexPaprika API with structured error handling
async function fetchFromAPI(endpoint) {
  const startTime = Date.now();
  const response = await fetch(`${API_BASE_URL}${endpoint}`);

  if (!response.ok) {
    const structuredError = parseAPIError(response.status, response.statusText, endpoint);
    throw structuredError;
  }

  const data = await response.json();
  requestCount++;
  const responseTime = Date.now() - startTime;

  const resetTime = new Date();
  resetTime.setHours(24, 0, 0, 0);

  return {
    data,
    meta: {
      rate_limit: {
        limit: RATE_LIMIT,
        remaining: RATE_LIMIT - requestCount,
        used: requestCount,
        percentage_used: (requestCount / RATE_LIMIT) * 100,
        reset_at: resetTime.toISOString()
      },
      response_time_ms: responseTime,
      cached: false,
      timestamp: new Date().toISOString()
    }
  };
}

// Helper to format response for MCP
function formatMcpResponse(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

// Helper to format MCP error response
function formatMcpError(error) {
  if (error && typeof error === 'object' && 'error' in error) {
    return formatMcpResponse(error);
  }
  return formatMcpResponse({
    error: {
      code: "DP500_UNEXPECTED",
      message: error instanceof Error ? error.message : 'Unknown error',
      retryable: false,
      suggestion: "Please try again later or contact support"
    }
  });
}

// Build capabilities document
async function buildCapabilitiesDocument() {
  let supportedNetworks = [];
  try {
    const res = await fetch(`${API_BASE_URL}/networks`);
    if (res.ok) {
      const json = await res.json();
      supportedNetworks = Array.isArray(json) ? json.map(n => n.id).filter(Boolean) : [];
    }
  } catch { /* ignore */ }

  const synonymsMaster = {
    ethereum: ["eth", "ethereum", "mainnet", "erc20"],
    bsc: ["binance smart chain", "bnb chain", "binance", "bnb", "bsc", "bep20"],
    polygon: ["matic", "polygon", "poly"],
    arbitrum: ["arb", "arbitrum", "arbitrum one"],
    optimism: ["op", "optimism"],
    base: ["base", "base chain"],
    avalanche: ["avax", "avalanche", "c-chain"],
    solana: ["sol", "solana"],
    fantom: ["ftm", "fantom"],
    blast: ["blast"],
    zksync: ["zk", "zksync", "zksync era"],
    linea: ["linea"],
    scroll: ["scroll"],
    mantle: ["mantle", "mnt"],
    celo: ["celo"],
    cronos: ["cro", "cronos"],
    aptos: ["apt", "aptos"],
    sui: ["sui"],
    ton: ["ton", "the open network"],
    tron: ["trx", "tron"],
  };

  const network_synonyms = {};
  const keys = supportedNetworks.length > 0 ? supportedNetworks : Object.keys(synonymsMaster);
  for (const k of keys) {
    if (synonymsMaster[k]) network_synonyms[k] = synonymsMaster[k];
  }

  const now = new Date();
  const lastUpdated = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return {
    service: "dexpaprika",
    version: SERVER_VERSION,
    description: "DeFi analytics across 33 blockchain networks",
    server: {
      name: "DexPaprika MCP Server",
      version: SERVER_VERSION,
      description: "DeFi data aggregation across multiple blockchain networks and DEXes",
      last_updated: lastUpdated,
      documentation_url: "https://docs.dexpaprika.com",
    },
    tools: [
      {
        name: "getNetworks",
        description: "List all supported blockchain networks",
        category: "discovery",
        parameters: {},
        returns: { type: "array", items: "Network" },
        cost: 1
      },
      {
        name: "getCapabilities",
        description: "Return server capabilities, workflow patterns, network synonyms, common pitfalls, and best-practice sequences",
        category: "discovery",
        parameters: {},
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "getNetworkDexes",
        description: "Get available DEXes on a specific network",
        category: "dexes",
        parameters: {
          network: { type: "string", required: true, description: "Network ID", example: "ethereum" },
          page: { type: "number", required: false, default: 1, description: "Page number (1-indexed)" },
          limit: { type: "number", required: false, default: 10, max: 100, description: "Items per page" },
          sort: { type: "string", required: false, enum: ["asc", "desc"], default: "desc" },
          order_by: { type: "string", required: false, enum: ["pool"] }
        },
        returns: { type: "object", properties: ["dexes", "page_info"] },
        cost: 1
      },
      {
        name: "getNetworkPools",
        description: "Get top liquidity pools on a network",
        category: "pools",
        parameters: {
          network: { type: "string", required: true, description: "Network ID", example: "ethereum" },
          page: { type: "number", required: false, default: 1 },
          limit: { type: "number", required: false, default: 10, max: 100 },
          sort: { type: "string", required: false, enum: ["asc", "desc"], default: "desc" },
          order_by: { type: "string", required: false, enum: ["volume_usd", "price_usd", "transactions", "last_price_change_usd_24h", "created_at"], default: "volume_usd" }
        },
        returns: { type: "object", properties: ["pools", "page_info"] },
        cost: 1
      },
      {
        name: "getDexPools",
        description: "Get pools from a specific DEX on a network",
        category: "pools",
        parameters: {
          network: { type: "string", required: true, description: "Network ID", example: "ethereum" },
          dex: { type: "string", required: true, description: "DEX identifier", example: "uniswap_v3" },
          page: { type: "number", required: false, default: 1 },
          limit: { type: "number", required: false, default: 10, max: 100 },
          sort: { type: "string", required: false, enum: ["asc", "desc"], default: "desc" },
          order_by: { type: "string", required: false, enum: ["volume_usd", "price_usd", "transactions", "last_price_change_usd_24h", "created_at"], default: "volume_usd" }
        },
        returns: { type: "object", properties: ["pools", "page_info"] },
        cost: 1
      },
      {
        name: "getNetworkPoolsFilter",
        description: "Filter pools by volume, liquidity, transactions, and creation time",
        category: "pools",
        parameters: {
          network: { type: "string", required: true, description: "Network ID", example: "ethereum" },
          page: { type: "number", required: false, default: 1 },
          limit: { type: "number", required: false, default: 50, max: 100 },
          volume_24h_min: { type: "number", required: false, description: "Minimum 24h volume USD" },
          volume_24h_max: { type: "number", required: false, description: "Maximum 24h volume USD" },
          volume_7d_min: { type: "number", required: false, description: "Minimum 7d volume USD" },
          volume_7d_max: { type: "number", required: false, description: "Maximum 7d volume USD" },
          liquidity_usd_min: { type: "number", required: false, description: "Minimum pool liquidity USD" },
          liquidity_usd_max: { type: "number", required: false, description: "Maximum pool liquidity USD" },
          txns_24h_min: { type: "number", required: false, description: "Minimum 24h transactions" },
          created_after: { type: "number", required: false, description: "UNIX timestamp" },
          created_before: { type: "number", required: false, description: "UNIX timestamp" },
          sort_by: { type: "string", required: false, enum: ["volume_24h", "volume_7d", "volume_30d", "liquidity", "txns_24h", "created_at"], default: "volume_24h" },
          sort_dir: { type: "string", required: false, enum: ["asc", "desc"], default: "desc" }
        },
        returns: { type: "object", properties: ["results", "page_info"] },
        cost: 1,
        note: "Response uses 'results' key (not 'pools'). Fields: address, volume_usd_24h, volume_usd_7d, liquidity_usd, txns_24h."
      },
      {
        name: "filterNetworkTokens",
        description: "Filter tokens by volume, liquidity, FDV, transactions, and creation time",
        category: "tokens",
        parameters: {
          network: { type: "string", required: true, description: "Network ID", example: "ethereum" },
          page: { type: "number", required: false, default: 1 },
          limit: { type: "number", required: false, default: 50, max: 100 },
          volume_24h_min: { type: "number", required: false, description: "Minimum 24h volume USD" },
          volume_24h_max: { type: "number", required: false, description: "Maximum 24h volume USD" },
          liquidity_usd_min: { type: "number", required: false, description: "Minimum token liquidity USD" },
          fdv_min: { type: "number", required: false, description: "Minimum fully diluted valuation USD" },
          fdv_max: { type: "number", required: false, description: "Maximum fully diluted valuation USD" },
          txns_24h_min: { type: "number", required: false, description: "Minimum 24h transactions" },
          created_after: { type: "number", required: false, description: "UNIX timestamp" },
          created_before: { type: "number", required: false, description: "UNIX timestamp" },
          sort_by: { type: "string", required: false, enum: ["volume_24h", "volume_7d", "volume_30d", "liquidity_usd", "txns_24h", "created_at", "fdv"], default: "volume_24h" },
          sort_dir: { type: "string", required: false, enum: ["asc", "desc"], default: "desc" }
        },
        returns: { type: "object", properties: ["results", "page_info"] },
        cost: 1,
        note: "Response uses 'results' key. Fields: chain, address, price_usd, volume_usd_24h, volume_usd_7d, liquidity_usd, fdv_usd, txns_24h, created_at."
      },
      {
        name: "getTopTokens",
        description: "Get top tokens on a network ranked by volume, price, liquidity, or activity",
        category: "tokens",
        parameters: {
          network: { type: "string", required: true, description: "Network ID", example: "ethereum" },
          page: { type: "number", required: false, default: 1 },
          limit: { type: "number", required: false, default: 50, max: 100 },
          order_by: { type: "string", required: false, enum: ["volume_24h", "price_usd", "liquidity_usd", "txns", "price_change"], default: "volume_24h" },
          sort: { type: "string", required: false, enum: ["asc", "desc"], default: "desc" }
        },
        returns: { type: "object", properties: ["tokens", "page_info"] },
        cost: 1,
        note: "Each token includes enriched metadata + multi-timeframe metrics (24h, 1h, 5m) with volume, buys, sells, txns, price change."
      },
      {
        name: "getPoolDetails",
        description: "Get detailed info about a pool",
        category: "pools",
        parameters: {
          network: { type: "string", required: true, description: "Network ID", example: "ethereum" },
          pool_address: { type: "string", required: true, description: "Pool address", example: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" },
          inversed: { type: "boolean", required: false, default: false, description: "Invert price ratio" }
        },
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "getPoolOHLCV",
        description: "Get historical price data (OHLCV) for a pool",
        category: "pools",
        parameters: {
          network: { type: "string", required: true },
          pool_address: { type: "string", required: true },
          start: { type: "string", required: true, description: "Start time (Unix timestamp, RFC3339, or yyyy-mm-dd)" },
          end: { type: "string", required: false },
          limit: { type: "number", required: false, default: 1, max: 366 },
          interval: { type: "string", required: false, enum: ["1m", "5m", "10m", "15m", "30m", "1h", "6h", "12h", "24h"], default: "24h" },
          inversed: { type: "boolean", required: false, default: false }
        },
        returns: { type: "array", items: "OHLCVRecord" },
        cost: 1
      },
      {
        name: "getPoolTransactions",
        description: "Get recent transactions for a pool",
        category: "pools",
        parameters: {
          network: { type: "string", required: true },
          pool_address: { type: "string", required: true },
          page: { type: "number", required: false, default: 1, max: 100 },
          limit: { type: "number", required: false, default: 10, max: 100 },
          cursor: { type: "string", required: false, description: "Transaction ID for cursor pagination" },
          from: { type: "number", required: false, description: "Filter transactions starting from this UNIX timestamp" },
          to: { type: "number", required: false, description: "Filter transactions up to this UNIX timestamp" }
        },
        returns: { type: "object", properties: ["transactions", "page_info"] },
        cost: 1
      },
      {
        name: "getTokenDetails",
        description: "Get detailed information about a token",
        category: "tokens",
        parameters: {
          network: { type: "string", required: true },
          token_address: { type: "string", required: true, description: "Token contract address", example: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" }
        },
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "getTokenPools",
        description: "Get liquidity pools containing a token",
        category: "tokens",
        parameters: {
          network: { type: "string", required: true },
          token_address: { type: "string", required: true },
          page: { type: "number", required: false, default: 1 },
          limit: { type: "number", required: false, default: 10, max: 100 },
          sort: { type: "string", required: false, enum: ["asc", "desc"], default: "desc" },
          order_by: { type: "string", required: false, enum: ["volume_usd", "price_usd", "transactions", "last_price_change_usd_24h", "created_at"], default: "volume_usd" },
          reorder: { type: "boolean", required: false },
          address: { type: "string", required: false, description: "Filter by additional token address" }
        },
        returns: { type: "object", properties: ["pools", "page_info"] },
        cost: 1
      },
      {
        name: "getTokenMultiPrices",
        description: "Batch fetch prices for up to 10 tokens",
        category: "tokens",
        parameters: {
          network: { type: "string", required: true, description: "Network ID", example: "ethereum" },
          tokens: { type: "array", required: true, format: "comma-separated", max_items: 10, description: "Up to 10 token addresses", example: ["0x123...", "0x456..."] }
        },
        returns: { type: "array", items: "TokenPrice" },
        cost: 1
      },
      {
        name: "search",
        description: "Search across ALL networks for tokens, pools, and DEXes by name, symbol, or address",
        category: "search",
        parameters: {
          query: { type: "string", required: true, description: "Search term", example: "uniswap" }
        },
        returns: { type: "object", properties: ["tokens", "pools", "dexes"] },
        cost: 1
      },
      {
        name: "getStats",
        description: "Get high-level statistics about the DexPaprika ecosystem",
        category: "utils",
        parameters: {},
        returns: { type: "object", properties: ["chains", "factories", "pools", "tokens"] },
        cost: 1
      }
    ],
    network_synonyms,
    validation_rules: {
      address_formats: {
        ethereum: "^0x[a-fA-F0-9]{40}$",
        bsc: "^0x[a-fA-F0-9]{40}$",
        polygon: "^0x[a-fA-F0-9]{40}$",
        arbitrum: "^0x[a-fA-F0-9]{40}$",
        optimism: "^0x[a-fA-F0-9]{40}$",
        base: "^0x[a-fA-F0-9]{40}$",
        avalanche: "^0x[a-fA-F0-9]{40}$",
        fantom: "^0x[a-fA-F0-9]{40}$",
        blast: "^0x[a-fA-F0-9]{40}$",
        zksync: "^0x[a-fA-F0-9]{40}$",
        linea: "^0x[a-fA-F0-9]{40}$",
        scroll: "^0x[a-fA-F0-9]{40}$",
        mantle: "^0x[a-fA-F0-9]{40}$",
        celo: "^0x[a-fA-F0-9]{40}$",
        cronos: "^0x[a-fA-F0-9]{40}$",
        solana: "^[1-9A-HJ-NP-Za-km-z]{32,44}$",
        aptos: "^0x[a-fA-F0-9]{64}$",
        sui: "^0x[a-fA-F0-9]{64}$",
        ton: "^[A-Za-z0-9_-]{48}$",
        tron: "^T[A-Za-z1-9]{33}$"
      },
      batch_limits: {
        getTokenMultiPrices: 10
      }
    },
    rate_limits: {
      requests_per_day: 10000,
      burst_limit: 100
    },
    error_codes: {
      DP400_INVALID_NETWORK: "Network ID not recognized. Use network_synonyms to normalize input.",
      DP400_TOO_MANY_TOKENS: "Exceeded batch limit. Max {limit} tokens per request.",
      DP400_INVALID_ADDRESS: "Token address format invalid for this network.",
      DP400_MISSING_REQUIRED: "Required parameter missing.",
      DP404_NOT_FOUND: "Resource not found. May not exist or be delisted.",
      DP429_RATE_LIMIT: "Daily rate limit exceeded. Resets at {reset_at}."
    },
    meta: {
      documentation: "https://docs.dexpaprika.com",
      support: "https://github.com/coinpaprika/claude-marketplace"
    },
    workflow_patterns: {
      discovery: {
        description: "Discover available networks, DEXes, and pools",
        steps: [
          "getNetworks - List all supported blockchain networks",
          "getNetworkDexes - Find DEXes on a specific network",
          "getNetworkPools - Browse top liquidity pools",
        ],
        example_use_case: "Finding the most active trading pools on a network",
      },
      price_tracking: {
        description: "Track token prices and historical data",
        steps: [
          "search - Find token by name, symbol, or address",
          "getTokenDetails - Get current price and metadata",
          "getTokenPools - Find all pools containing the token",
          "getPoolOHLCV - Get historical price data (candlestick charts)",
        ],
        example_use_case: "Analyzing price trends for a specific token over 7 days",
      },
      multi_price: {
        description: "Get prices for multiple tokens at once (batch operation)",
        steps: [
          "getNetworks - Verify network ID",
          "getTokenMultiPrices - Fetch up to 10 token prices in one call",
        ],
        example_use_case: "Building a portfolio tracker showing multiple token prices",
        limitations: "Maximum 10 tokens per request",
      },
      find_tokens_by_mcap: {
        description: "Discover tokens within specific market cap ranges",
        steps: [
          "getNetworkPools - Get pools sorted by volume",
          "Extract tokens[].fdv (Fully Diluted Valuation) from response",
          "Filter tokens where fdv is in your target range (e.g., $10M-$100M)",
          "getTokenDetails - Deep dive into promising candidates",
        ],
        example_use_case: "Finding mid-cap tokens ($10M-$100M) with high trading volume",
        note: "Currently requires client-side filtering by fdv field",
      },
      technical_analysis: {
        description: "Perform comprehensive technical analysis on a token",
        steps: [
          "search - Locate token by name/symbol",
          "getTokenDetails - Get current metrics (price, fdv, volume)",
          "getTokenPools - Identify highest liquidity pool",
          "getPoolOHLCV - Fetch price history (OHLC candlesticks)",
          "getPoolTransactions - Analyze recent trading activity",
        ],
        example_use_case: "Creating buy/sell signals based on price patterns and volume",
        recommended_intervals: ["5m", "1h", "24h"],
      },
      whale_watching: {
        description: "Monitor large transactions and whale activity",
        steps: [
          "getTokenPools - Find pools for target token",
          "getPoolTransactions - Get recent transactions with details",
          "Filter by amount_0 or amount_1 for large trades",
          "Track sender/recipient addresses for patterns",
        ],
        example_use_case: "Alert when transactions >$100K occur",
        tip: "Use cursor pagination for continuous monitoring",
      },
      new_token_discovery: {
        description: "Find newly created tokens and pools",
        steps: [
          "getNetworkPools - Sort by created_at descending",
          "getPoolDetails - Verify liquidity and token info",
          "getPoolTransactions - Check initial trading activity",
          "getTokenDetails - Validate token metrics",
        ],
        example_use_case: "Finding tokens launched in the last 24 hours",
        warning: "New tokens are extremely high risk - verify contracts carefully",
      },
      dex_comparison: {
        description: "Compare liquidity across different DEXes",
        steps: [
          "getNetworkDexes - List all DEXes on network",
          "getDexPools - Get pools for each DEX",
          "Compare volume_usd and transactions across DEXes",
        ],
        example_use_case: "Finding best liquidity for a trading pair",
      },
      pool_filtering: {
        description: "Find pools matching specific criteria using server-side filters",
        steps: [
          "getNetworkPoolsFilter - Filter by volume, transactions, or creation time",
          "getPoolDetails - Deep dive into matching pools",
          "getPoolOHLCV - Analyze price history of filtered pools",
        ],
        example_use_case: "Finding high-volume pools created in the last 24 hours",
        note: "More efficient than fetching all pools and filtering client-side",
      },
      arbitrage_opportunities: {
        description: "Identify price discrepancies across pools",
        steps: [
          "getTokenPools - Get all pools for a token",
          "Compare price_usd across different pools",
          "getPoolDetails - Verify liquidity depth",
          "Calculate potential arbitrage profit minus gas",
        ],
        example_use_case: "Finding price differences between DEXes",
        note: "Consider gas fees, slippage, and MEV when calculating profitability",
      },
    },
    parameter_examples: {
      getNetworkPools: {
        high_volume_pools: {
          description: "Top 20 pools by 24h trading volume",
          params: { network: "ethereum", limit: 20, order_by: "volume_usd", sort: "desc" },
        },
        new_pools: {
          description: "Recently created pools (last 24h)",
          params: { network: "bsc", order_by: "created_at", sort: "desc", limit: 50 },
        },
        most_transactions: {
          description: "Pools with highest transaction count",
          params: { network: "base", order_by: "transactions", sort: "desc", limit: 10 },
        },
        price_movers: {
          description: "Pools with biggest 24h price changes",
          params: { network: "solana", order_by: "last_price_change_usd_24h", sort: "desc", limit: 30 },
        },
      },
      getPoolOHLCV: {
        last_24h_hourly: {
          description: "Hourly candlesticks for last 24 hours",
          params: { network: "ethereum", pool_address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", start: "2025-10-15", interval: "1h", limit: 24 },
        },
        last_week_daily: {
          description: "Daily candlesticks for last 7 days",
          params: { network: "bsc", pool_address: "0x...", start: "2025-10-09", interval: "24h", limit: 7 },
        },
        intraday_5min: {
          description: "5-minute intervals for day trading",
          params: { network: "base", pool_address: "0x...", start: "2025-10-16T00:00:00Z", interval: "5m", limit: 288, inversed: false },
        },
        monthly_overview: {
          description: "30 days of daily data",
          params: { network: "arbitrum", pool_address: "0x...", start: "2025-09-16", interval: "24h", limit: 30 },
        },
      },
      getPoolTransactions: {
        recent_activity: {
          description: "Last 50 transactions",
          params: { network: "ethereum", pool_address: "0x...", limit: 50, page: 1 },
        },
        whale_trades: {
          description: "Large transactions (filter client-side by volume)",
          params: { network: "bsc", pool_address: "0x...", limit: 100, page: 1 },
          post_filter: "Filter where volume_1 > 10000 for trades >$10K",
        },
        cursor_pagination: {
          description: "Using cursor for efficient pagination",
          params: { network: "polygon", pool_address: "0x...", limit: 20, cursor: "0xabcd1234..." },
          note: "Use last transaction ID as cursor for next page",
        },
        time_range: {
          description: "Transactions within a specific time window (last 7 days max)",
          params: { network: "ethereum", pool_address: "0x...", limit: 100, from: 1712700000, to: 1712800000 },
          note: "from is inclusive, to is exclusive. Results always capped to last 7 days.",
        },
      },
      getTokenMultiPrices: {
        portfolio_tracking: {
          description: "Get prices for multiple tokens at once",
          params: {
            network: "ethereum",
            tokens: [
              "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
              "0xdac17f958d2ee523a2206206994597c13d831ec7",
              "0x6b175474e89094c44da98b954eedeac495271d0f"
            ]
          },
          note: "Maximum 10 tokens per request",
        },
      },
      search: {
        by_name: { description: "Find token by name", params: { query: "uniswap" } },
        by_symbol: { description: "Find token by ticker symbol", params: { query: "USDC" } },
        by_address: { description: "Find token by contract address", params: { query: "0xa0b8..." } },
      },
    },
    important_fields: {
      fdv: { name: "Fully Diluted Valuation", description: "Total supply x current price. Use this for market cap comparisons.", example: "fdv: 50000000 means $50M market cap", use_case: "Filtering tokens by market cap range" },
      volume_usd: { name: "24h Trading Volume (USD)", description: "Total USD value traded in last 24 hours", use_case: "Identifying liquid vs illiquid tokens" },
      last_price_change_usd_24h: { name: "24h Absolute Price Change", description: "Absolute price change in USD, NOT percentage", example: "0.5 means +$0.50", calculation: "(last_price_change_usd_24h / price_usd) x 100" },
      transactions: { name: "Total Transaction Count", description: "Cumulative number of swaps since pool creation", use_case: "Gauge trading activity and pool maturity" },
      inversed: { name: "Inverse Token Pair", description: "When true, flips token0/token1", example: "USDC/WETH -> WETH/USDC", use_case: "Viewing price from opposite perspective" },
      price_usd: { name: "Current Price (USD)", description: "Real-time token price in USD", note: "Based on most recent pool transaction" },
      created_at: { name: "Pool Creation Time", format: "ISO 8601 timestamp", example: "2025-10-16T10:00:08Z", use_case: "Finding new pools, calculating pool age" },
      "amount_0 / amount_1": { name: "Transaction Token Amounts", description: "Positive = tokens added; Negative = removed", use_case: "Identifying buy vs sell transactions" },
    },
    common_pitfalls: {
      external_apis: { issue: "Using external APIs when DexPaprika has data", solution: "Prefer built-in tools", example: "Don't fetch OHLCV elsewhere when getPoolOHLCV exists" },
      batch_limits: { issue: "Exceeding 10 token limit in getTokenMultiPrices", solution: "Split requests into batches of 10", example: "For 25 tokens: 10 + 10 + 5" },
      response_size: { issue: "Response too large", solution: "Reduce limit, start with 10", prevention: "Use fields and smaller limits" },
      ohlcv_empty: { issue: "getPoolOHLCV returns []", cause: "Pool too new", solution: "Use getPoolTransactions for very new pools" },
      invalid_network: { issue: "Network not found", solution: "Call getNetworks first", tip: "Check network_synonyms" },
      pagination_confusion: { issue: "Only fetching page 0", solution: "Use cursor or increment page", note: "Page limit 100" },
      price_change_misinterpretation: { issue: "Assuming 24h change is percentage", reality: "It's absolute USD", calculation: "(change/price_usd)x100" },
      fdv_vs_mcap: { issue: "FDV vs circulating market cap", clarification: "FDV includes locked/unvested", note: "Circulating may be lower" },
    },
    best_practices: {
      workflow: [
        "Always call getCapabilities first",
        "Call getNetworks to validate network IDs",
        "Use search to find tokens by name/symbol before details",
        "Start with small limit values and increase if needed",
        "Cache getNetworks response",
      ],
      performance: [
        "Use getTokenMultiPrices for batch operations",
        "Client-side caching for networks and DEX lists",
        "Use cursor pagination for large histories",
        "Request only necessary OHLCV intervals",
      ],
      data_quality: [
        "Verify pool liquidity before trading",
        "Cross-reference token data across pools",
        "Be cautious with pools <24h old",
        "Check created_at for brand new tokens",
      ],
      error_handling: [
        "Handle empty OHLCV arrays gracefully",
        "Retry with backoff for rate limits",
        "Validate network IDs against getNetworks",
        "Reduce limits if responses are too large",
      ],
    },
    quick_reference: {
      market_cap_ranges: {
        nano_cap: "< $1M (extremely high risk)",
        micro_cap: "$1M - $10M (very high risk)",
        small_cap: "$10M - $100M (high risk)",
        mid_cap: "$100M - $1B (moderate risk)",
        large_cap: "> $1B (lower risk)",
      },
      ohlcv_intervals: {
        scalping: ["1m", "5m"],
        day_trading: ["5m", "15m", "1h"],
        swing_trading: ["1h", "6h", "24h"],
        position_trading: ["24h"],
      },
      order_by_options: [
        "volume_usd - 24h trading volume",
        "price_usd - Current price",
        "transactions - Total swap count",
        "last_price_change_usd_24h - 24h price change",
        "created_at - Pool creation time",
      ],
      max_limits: {
        pools_per_request: 100,
        transactions_per_request: 100,
        ohlcv_data_points: 366,
        multi_token_prices: 10,
        transaction_pages: "Unlimited (use cursor)",
      },
      supported_dexes: [
        "Uniswap V2/V3",
        "PancakeSwap V2/V3",
        "SushiSwap",
        "Curve",
        "Balancer",
        "And many more - use getNetworkDexes",
      ],
    },
    error_handling: {
      empty_ohlcv_array: { error_pattern: "getPoolOHLCV returns []", cause: "Pool created too recently", solution: "Use getPoolTransactions", prevention: "Check created_at" },
      response_too_large: { error_pattern: "Response exceeds size budget", cause: "Too many items", solution: "Reduce limit or paginate" },
      invalid_network_id: { error_pattern: "Network not found", cause: "Incorrect network", solution: "Call getNetworks", check: "Use network_synonyms" },
      rate_limit_exceeded: { error_pattern: "Too many requests", solution: "Exponential backoff", prevention: "Use batching where possible" },
      invalid_time_range: { error_pattern: "Time range exceeds 1 year", cause: "start/end span too large", solution: "Split into multiple requests", note: "Limit 366 data points" },
      pool_not_found: { error_pattern: "Pool address not found", cause: "Invalid or unknown pool", solution: "Find from getNetworkPools or getTokenPools", tip: "Addresses are network-specific" },
    },
    use_case_templates: {
      find_trending_tokens: {
        goal: "Find tokens with >100% gains in last 24h on BSC",
        steps: [
          "1. getNetworks -> confirm 'bsc' is valid",
          "2. getNetworkPools(network='bsc', order_by='last_price_change_usd_24h', sort='desc', limit=50)",
          "3. Filter results where (last_price_change_usd_24h / price_usd) x 100 > 100",
          "4. For each promising token: getPoolDetails, getPoolOHLCV, getPoolTransactions",
          "5. Analyze: volume trends, liquidity, holder activity",
        ],
      },
      build_price_alert_bot: {
        goal: "Alert when ETH price crosses a threshold",
        steps: [
          "1. search(query='WETH') -> find WETH token address",
          "2. getTokenPools(network='ethereum', token_address='0x...') -> find highest liquidity pool",
          "3. Poll getPoolDetails to check price_usd",
          "4. Trigger alert on threshold",
          "5. Optional: getPoolTransactions to see what triggered the move",
        ],
      },
      analyze_new_token_launch: {
        goal: "Evaluate a token launched recently",
        steps: [
          "1. getNetworkPools(order_by='created_at', sort='desc') -> find recent pools",
          "2. getPoolDetails -> check liquidity depth, token info",
          "3. getPoolTransactions(limit=100) -> analyze initial trades",
          "4. Check: whale wallets? mostly buys or sells?",
          "5. getTokenDetails -> verify fdv",
        ],
      },
      portfolio_rebalancing: {
        goal: "Check prices of 15 tokens to rebalance portfolio",
        steps: [
          "1. Split 15 tokens into batches: [10] + [5]",
          "2. getTokenMultiPrices for batch1",
          "3. getTokenMultiPrices for batch2",
          "4. Calculate portfolio weights",
          "5. For tokens to trade: getTokenPools -> find best liquidity",
        ],
      },
    },
    integration_tips: {
      trading_bots: [
        "Cache network IDs and DEX lists",
        "Implement circuit breakers for rate limits",
        "Store historical OHLCV locally for longer-term charts",
      ],
      portfolio_trackers: [
        "Use getTokenMultiPrices for efficient batch price fetching",
        "Cache token metadata (symbols, names)",
        "Poll price updates every 30-60s",
      ],
      analytics_dashboards: [
        "Pre-fetch and cache getNetworks and getNetworkDexes",
        "Use lazy loading; avoid fetching all pools upfront",
        "Use transaction data for volume charts",
      ],
      token_screeners: [
        "Fetch pools with high volume",
        "Client-side filter by fdv for market cap ranges",
        "Use created_at to separate new vs established tokens",
        "Combine filters: volume + fdv + price_change",
      ],
    },
    version_history: {
      "1.1.0": "Added capabilities endpoint and basic workflows; enhanced with detailed examples and guidance",
      "1.2.0": "Added getNetworkPoolsFilter tool; fixed pagination to 1-indexed; updated stats to 33 networks, 28M+ pools, 25M+ tokens",
      "1.4.0": "Added filterNetworkTokens and getTopTokens tools; expanded getNetworkPoolsFilter with volume_7d, liquidity params; enriched network/dex responses with volume, txns, pools_count",
      "1.3.0": "Synced npm package with hosted MCP server; added getCapabilities, getNetworkPoolsFilter; structured error handling; snake_case parameters",
    },
  };
}

// MCP server instance
const server = new McpServer({
  name: 'dexpaprika',
  version: SERVER_VERSION,
  description: 'MCP server for accessing DexPaprika API data for decentralized exchanges and tokens',
});

// getNetworks
server.tool(
  'getNetworks',
  'START HERE: Prefer calling getCapabilities first to see workflows and examples. Then use this to list supported networks.',
  async () => {
    try {
      const response = await fetchFromAPI('/networks');
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getCapabilities
server.tool(
  'getCapabilities',
  'Return server capabilities, workflow patterns, network synonyms, common pitfalls, and best-practice sequences. Use this to onboard agents quickly.',
  async () => {
    try {
      const doc = await buildCapabilitiesDocument();
      return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getNetworkDexes
server.tool(
  'getNetworkDexes',
  'Get available DEXes on a specific network. TIP: Call getCapabilities for examples. REQUIRED: network. OPTIONAL: page, limit, sort, order_by.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    page: z.number().optional().default(1).describe("OPTIONAL: Page number for pagination (default: 1, 1-indexed)"),
    limit: z.number().optional().default(10).describe("OPTIONAL: Number of items per page (default: 10, max: 100)"),
    sort: z.enum(['asc', 'desc']).optional().default('desc').describe("OPTIONAL: Sort order (default: 'desc')"),
    order_by: z.enum(['pool']).optional().describe("OPTIONAL: How to order the returned data")
  },
  async ({ network, page, limit, sort, order_by }) => {
    try {
      let endpoint = `/networks/${network}/dexes?page=${page}&limit=${limit}`;
      if (sort) endpoint += `&sort=${sort}`;
      if (order_by) endpoint += `&order_by=${order_by}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getNetworkPools
server.tool(
  'getNetworkPools',
  'PRIMARY POOL FUNCTION: Get top liquidity pools on a network. TIP: Call getCapabilities first for parameter examples. REQUIRED: network. OPTIONAL: page, limit, sort, order_by.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    page: z.number().optional().default(1).describe("OPTIONAL: Page number for pagination (default: 1, 1-indexed)"),
    limit: z.number().optional().default(10).describe("OPTIONAL: Number of items per page (default: 10, max: 100)"),
    sort: z.enum(['asc', 'desc']).optional().default('desc').describe("OPTIONAL: Sort order (default: 'desc')"),
    order_by: z.enum(['volume_usd', 'price_usd', 'transactions', 'last_price_change_usd_24h', 'created_at']).optional().default('volume_usd').describe("OPTIONAL: Field to order by (default: 'volume_usd')")
  },
  async ({ network, page, limit, sort, order_by }) => {
    try {
      const endpoint = `/networks/${network}/pools?page=${page}&limit=${limit}&sort=${sort}&order_by=${order_by}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getDexPools
server.tool(
  'getDexPools',
  'Get pools from a specific DEX on a network. TIP: See examples in getCapabilities. REQUIRED: network, dex. OPTIONAL: page, limit, sort, order_by.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    dex: z.string().describe("REQUIRED: DEX identifier from getNetworkDexes (e.g., 'uniswap_v3')"),
    page: z.number().optional().default(1).describe("OPTIONAL: Page number for pagination (default: 1, 1-indexed)"),
    limit: z.number().optional().default(10).describe("OPTIONAL: Number of items per page (default: 10, max: 100)"),
    sort: z.enum(['asc', 'desc']).optional().default('desc').describe("OPTIONAL: Sort order (default: 'desc')"),
    order_by: z.enum(['volume_usd', 'price_usd', 'transactions', 'last_price_change_usd_24h', 'created_at']).optional().default('volume_usd').describe("OPTIONAL: Field to order by (default: 'volume_usd')")
  },
  async ({ network, dex, page, limit, sort, order_by }) => {
    try {
      const endpoint = `/networks/${network}/dexes/${dex}/pools?page=${page}&limit=${limit}&sort=${sort}&order_by=${order_by}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getNetworkPoolsFilter
server.tool(
  'getNetworkPoolsFilter',
  'Filter pools by volume, liquidity, transactions, and creation time. REQUIRED: network. OPTIONAL: page, limit, volume_24h_min/max, volume_7d_min/max, liquidity_usd_min/max, txns_24h_min, created_after, created_before, sort_by, sort_dir.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    page: z.number().optional().default(1).describe("OPTIONAL: Page number for pagination (default: 1, 1-indexed)"),
    limit: z.number().optional().default(50).describe("OPTIONAL: Number of items per page (default: 50, max: 100)"),
    volume_24h_min: z.number().optional().describe("OPTIONAL: Minimum 24h volume in USD"),
    volume_24h_max: z.number().optional().describe("OPTIONAL: Maximum 24h volume in USD"),
    volume_7d_min: z.number().optional().describe("OPTIONAL: Minimum 7d volume in USD"),
    volume_7d_max: z.number().optional().describe("OPTIONAL: Maximum 7d volume in USD"),
    liquidity_usd_min: z.number().optional().describe("OPTIONAL: Minimum pool liquidity in USD"),
    liquidity_usd_max: z.number().optional().describe("OPTIONAL: Maximum pool liquidity in USD"),
    txns_24h_min: z.number().optional().describe("OPTIONAL: Minimum number of transactions in 24h"),
    created_after: z.number().optional().describe("OPTIONAL: Only pools created after this UNIX timestamp"),
    created_before: z.number().optional().describe("OPTIONAL: Only pools created before this UNIX timestamp"),
    sort_by: z.enum(['volume_24h', 'volume_7d', 'volume_30d', 'liquidity', 'txns_24h', 'created_at']).optional().default('volume_24h').describe("OPTIONAL: Field to sort by (default: 'volume_24h')"),
    sort_dir: z.enum(['asc', 'desc']).optional().default('desc').describe("OPTIONAL: Sort direction (default: 'desc')")
  },
  async ({ network, page, limit, volume_24h_min, volume_24h_max, volume_7d_min, volume_7d_max, liquidity_usd_min, liquidity_usd_max, txns_24h_min, created_after, created_before, sort_by, sort_dir }) => {
    try {
      let endpoint = `/networks/${network}/pools/filter?page=${page}&limit=${limit}&sort_by=${sort_by}&sort_dir=${sort_dir}`;
      if (volume_24h_min !== undefined) endpoint += `&volume_24h_min=${volume_24h_min}`;
      if (volume_24h_max !== undefined) endpoint += `&volume_24h_max=${volume_24h_max}`;
      if (volume_7d_min !== undefined) endpoint += `&volume_7d_min=${volume_7d_min}`;
      if (volume_7d_max !== undefined) endpoint += `&volume_7d_max=${volume_7d_max}`;
      if (liquidity_usd_min !== undefined) endpoint += `&liquidity_usd_min=${liquidity_usd_min}`;
      if (liquidity_usd_max !== undefined) endpoint += `&liquidity_usd_max=${liquidity_usd_max}`;
      if (txns_24h_min !== undefined) endpoint += `&txns_24h_min=${txns_24h_min}`;
      if (created_after !== undefined) endpoint += `&created_after=${created_after}`;
      if (created_before !== undefined) endpoint += `&created_before=${created_before}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getPoolDetails
server.tool(
  'getPoolDetails',
  'Get detailed info about a pool. TIP: Use getCapabilities for workflows. REQUIRED: network, pool_address. OPTIONAL: inversed.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    pool_address: z.string().describe("REQUIRED: Pool address or identifier (e.g., '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640')"),
    inversed: z.boolean().optional().default(false).describe("OPTIONAL: Whether to invert the price ratio (default: false)")
  },
  async ({ network, pool_address, inversed }) => {
    try {
      const endpoint = `/networks/${network}/pools/${pool_address}?inversed=${inversed}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getPoolOHLCV
server.tool(
  'getPoolOHLCV',
  'Get historical price data (OHLCV) for a pool. TIP: See intervals in getCapabilities. REQUIRED: network, pool_address, start. OPTIONAL: end, limit, interval, inversed.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    pool_address: z.string().describe("REQUIRED: Pool address or identifier"),
    start: z.string().describe("REQUIRED: Start time for historical data (Unix timestamp, RFC3339 timestamp, or yyyy-mm-dd format)"),
    end: z.string().optional().describe("OPTIONAL: End time for historical data (max 1 year from start)"),
    limit: z.number().optional().default(1).describe("OPTIONAL: Number of data points to retrieve (default: 1, max: 366)"),
    interval: z.enum(['1m', '5m', '10m', '15m', '30m', '1h', '6h', '12h', '24h']).optional().default('24h').describe("OPTIONAL: Interval granularity (default: '24h')"),
    inversed: z.boolean().optional().default(false).describe("OPTIONAL: Whether to invert the price ratio for alternative pair perspective (default: false)")
  },
  async ({ network, pool_address, start, end, limit, interval, inversed }) => {
    try {
      let endpoint = `/networks/${network}/pools/${pool_address}/ohlcv?start=${encodeURIComponent(start)}&limit=${limit}&interval=${interval}&inversed=${inversed}`;
      if (end) endpoint += `&end=${encodeURIComponent(end)}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getPoolTransactions
server.tool(
  'getPoolTransactions',
  'Get recent transactions for a pool. TIP: Use cursor for long histories (see getCapabilities). Use from/to for time-range filtering (UNIX timestamps, results capped to last 7 days). REQUIRED: network, pool_address. OPTIONAL: page, limit, cursor, from, to.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    pool_address: z.string().describe("REQUIRED: Pool address or identifier"),
    page: z.number().optional().default(1).describe("OPTIONAL: Page number for pagination, up to 100 pages (default: 1, 1-indexed)"),
    limit: z.number().optional().default(10).describe("OPTIONAL: Number of items per page (default: 10, max: 100)"),
    cursor: z.string().optional().describe("OPTIONAL: Transaction ID used for cursor-based pagination"),
    from: z.number().optional().describe("OPTIONAL: Filter transactions starting from this UNIX timestamp (inclusive). Results always capped to last 7 days."),
    to: z.number().optional().describe("OPTIONAL: Filter transactions up to this UNIX timestamp (exclusive). Must be after 'from'.")
  },
  async ({ network, pool_address, page, limit, cursor, from, to }) => {
    try {
      let endpoint = `/networks/${network}/pools/${pool_address}/transactions?page=${page}&limit=${limit}`;
      if (cursor) endpoint += `&cursor=${encodeURIComponent(cursor)}`;
      if (from !== undefined) endpoint += `&from=${from}`;
      if (to !== undefined) endpoint += `&to=${to}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getTokenDetails
server.tool(
  'getTokenDetails',
  'Get detailed information about a token. TIP: Normalize networks via getCapabilities synonyms. REQUIRED: network, token_address.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    token_address: z.string().describe("REQUIRED: Token contract address (e.g., 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' for Jupiter on Solana)")
  },
  async ({ network, token_address }) => {
    try {
      const endpoint = `/networks/${network}/tokens/${token_address}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getTokenPools
server.tool(
  'getTokenPools',
  'Get liquidity pools containing a token. TIP: Use fields to reduce payloads. REQUIRED: network, token_address. OPTIONAL: page, limit, sort, order_by, reorder, address.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    token_address: z.string().describe("REQUIRED: Token contract address"),
    page: z.number().optional().default(1).describe("OPTIONAL: Page number for pagination (default: 1, 1-indexed)"),
    limit: z.number().optional().default(10).describe("OPTIONAL: Number of items per page (default: 10, max: 100)"),
    sort: z.enum(['asc', 'desc']).optional().default('desc').describe("OPTIONAL: Sort order (default: 'desc')"),
    order_by: z.enum(['volume_usd', 'price_usd', 'transactions', 'last_price_change_usd_24h', 'created_at']).optional().default('volume_usd').describe("OPTIONAL: Field to order by (default: 'volume_usd')"),
    reorder: z.boolean().optional().describe("OPTIONAL: If true, reorders the pool so that the specified token becomes the primary token for all metrics"),
    address: z.string().optional().describe("OPTIONAL: Filter pools that contain this additional token address")
  },
  async ({ network, token_address, page, limit, sort, order_by, reorder, address }) => {
    try {
      let endpoint = `/networks/${network}/tokens/${token_address}/pools?page=${page}&limit=${limit}&sort=${sort}&order_by=${order_by}`;
      if (reorder !== undefined) endpoint += `&reorder=${reorder}`;
      if (address) endpoint += `&address=${encodeURIComponent(address)}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getTokenMultiPrices
server.tool(
  'getTokenMultiPrices',
  'Get batched prices for multiple tokens. TIP: Max 10; join into a single comma-separated tokens string. REQUIRED: network, tokens.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    tokens: z.array(z.string()).nonempty().describe("REQUIRED: Up to 10 token addresses. Will be serialized as a single comma-separated query param (?tokens=a,b,c).")
  },
  async ({ network, tokens }) => {
    try {
      if (tokens.length > 10) {
        const error = buildErrorResponse(
          ErrorCodes.DP400_TOO_MANY_TOKENS,
          "Too many tokens in batch request",
          false,
          "Split request into batches of max 10 tokens each",
          `getTokenMultiPrices('ethereum', ['0x123...', '0x456...']) // max 10`,
          { limit: 10, provided: tokens.length }
        );
        return formatMcpResponse(error);
      }
      const joined = tokens.join(',');
      const endpoint = `/networks/${network}/multi/prices?tokens=${encodeURIComponent(joined)}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// filterNetworkTokens
server.tool(
  'filterNetworkTokens',
  'Filter tokens by volume, liquidity, FDV, transactions, and creation time. REQUIRED: network. OPTIONAL: page, limit, volume_24h_min/max, liquidity_usd_min, fdv_min/max, txns_24h_min, created_after/before, sort_by, sort_dir.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    page: z.number().optional().default(1).describe("OPTIONAL: Page number for pagination (default: 1, 1-indexed)"),
    limit: z.number().optional().default(50).describe("OPTIONAL: Number of items per page (default: 50, max: 100)"),
    volume_24h_min: z.number().optional().describe("OPTIONAL: Minimum 24h volume in USD"),
    volume_24h_max: z.number().optional().describe("OPTIONAL: Maximum 24h volume in USD"),
    liquidity_usd_min: z.number().optional().describe("OPTIONAL: Minimum token liquidity in USD"),
    fdv_min: z.number().optional().describe("OPTIONAL: Minimum fully diluted valuation in USD"),
    fdv_max: z.number().optional().describe("OPTIONAL: Maximum fully diluted valuation in USD"),
    txns_24h_min: z.number().optional().describe("OPTIONAL: Minimum number of transactions in 24h"),
    created_after: z.number().optional().describe("OPTIONAL: Only tokens created after this UNIX timestamp"),
    created_before: z.number().optional().describe("OPTIONAL: Only tokens created before this UNIX timestamp"),
    sort_by: z.enum(['volume_24h', 'volume_7d', 'volume_30d', 'liquidity_usd', 'txns_24h', 'created_at', 'fdv']).optional().default('volume_24h').describe("OPTIONAL: Field to sort by (default: 'volume_24h')"),
    sort_dir: z.enum(['asc', 'desc']).optional().default('desc').describe("OPTIONAL: Sort direction (default: 'desc')")
  },
  async ({ network, page, limit, volume_24h_min, volume_24h_max, liquidity_usd_min, fdv_min, fdv_max, txns_24h_min, created_after, created_before, sort_by, sort_dir }) => {
    try {
      let endpoint = `/networks/${network}/tokens/filter?page=${page}&limit=${limit}&sort_by=${sort_by}&sort_dir=${sort_dir}`;
      if (volume_24h_min !== undefined) endpoint += `&volume_24h_min=${volume_24h_min}`;
      if (volume_24h_max !== undefined) endpoint += `&volume_24h_max=${volume_24h_max}`;
      if (liquidity_usd_min !== undefined) endpoint += `&liquidity_usd_min=${liquidity_usd_min}`;
      if (fdv_min !== undefined) endpoint += `&fdv_min=${fdv_min}`;
      if (fdv_max !== undefined) endpoint += `&fdv_max=${fdv_max}`;
      if (txns_24h_min !== undefined) endpoint += `&txns_24h_min=${txns_24h_min}`;
      if (created_after !== undefined) endpoint += `&created_after=${created_after}`;
      if (created_before !== undefined) endpoint += `&created_before=${created_before}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getTopTokens
server.tool(
  'getTopTokens',
  'Get top tokens on a network ranked by volume, price, liquidity, or activity. Each token includes enriched metadata and multi-timeframe metrics (24h, 1h, 5m). REQUIRED: network. OPTIONAL: page, limit, order_by, sort.',
  {
    network: z.string().describe("REQUIRED: Network ID from getNetworks (e.g., 'ethereum', 'solana')"),
    page: z.number().optional().default(1).describe("OPTIONAL: Page number for pagination (default: 1, 1-indexed)"),
    limit: z.number().optional().default(50).describe("OPTIONAL: Number of items per page (default: 50, max: 100)"),
    order_by: z.enum(['volume_24h', 'price_usd', 'liquidity_usd', 'txns', 'price_change']).optional().default('volume_24h').describe("OPTIONAL: Field to order by (default: 'volume_24h')"),
    sort: z.enum(['asc', 'desc']).optional().default('desc').describe("OPTIONAL: Sort direction (default: 'desc')")
  },
  async ({ network, page, limit, order_by, sort }) => {
    try {
      const endpoint = `/networks/${network}/tokens/top?page=${page}&limit=${limit}&order_by=${order_by}&sort=${sort}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// search
server.tool(
  'search',
  "Search across ALL networks for tokens, pools, and DEXes by name, symbol, or address. Good starting point when you don't know the specific network. Returns matching tokens, pools, and DEXes. REQUIRED: query. No optional parameters.",
  {
    query: z.string().describe("REQUIRED: Search term (e.g., 'uniswap', 'bitcoin', 'ethereum', or a token address)")
  },
  async ({ query }) => {
    try {
      const endpoint = `/search?query=${encodeURIComponent(query)}`;
      const response = await fetchFromAPI(endpoint);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// getStats
server.tool(
  'getStats',
  'Get high-level statistics about the DexPaprika ecosystem: total networks, DEXes, pools, and tokens available. Provides a quick overview of the platform\'s coverage. No parameters required.',
  async () => {
    try {
      const response = await fetchFromAPI('/stats');
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// Start the server
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('DexPaprika MCP server is running...');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
