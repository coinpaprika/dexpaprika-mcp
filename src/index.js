import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fetch from 'node-fetch';
import { z } from 'zod';

// Base URL for DexPaprika API
const API_BASE_URL = 'https://api.dexpaprika.com';

// Helper function to fetch data from DexPaprika API
async function fetchFromAPI(endpoint) {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`);
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error(
          'Rate limit exceeded. You have reached the maximum number of requests allowed for the free tier. ' +
          'To increase your rate limits and access additional features, please consider upgrading to a paid plan at https://docs.dexpaprika.com/'
        );
      }
      throw new Error(`API request failed with status ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Error fetching from API: ${error.message}`);
    throw error;
  }
}

// Helper to format response for MCP
function formatMcpResponse(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data)
      }
    ]
  };
}

// MCP server instance
const server = new McpServer({
  name: 'dexpaprika-mcp',
  version: '1.0.4',
  description: 'MCP server for accessing DexPaprika API data for decentralized exchanges and tokens',
});

// getNetworks
server.tool(
  'getNetworks',
  'Retrieve a list of all supported blockchain networks and their metadata',
  {},
  async () => {
    const data = await fetchFromAPI('/networks');
    return formatMcpResponse(data);
  }
);

// getNetworkDexes
server.tool(
  'getNetworkDexes',
  'Get a list of available decentralized exchanges on a specific network',
  {
    network: z.string().describe('Network ID (e.g., ethereum, solana)'),
    page: z.number().optional().default(0).describe('Page number for pagination'),
    limit: z.number().optional().default(10).describe('Number of items per page')
  },
  async ({ network, page, limit }) => {
    const data = await fetchFromAPI(`/networks/${network}/dexes?page=${page}&limit=${limit}`);
    return formatMcpResponse(data);
  }
);

// getTopPools
server.tool(
  'getTopPools',
  'Get a paginated list of top liquidity pools from all networks',
  {
    page: z.number().optional().default(0).describe('Page number for pagination'),
    limit: z.number().optional().default(10).describe('Number of items per page'),
    sort: z.enum(['asc', 'desc']).optional().default('desc').describe('Sort order'),
    orderBy: z.enum(['volume_usd', 'price_usd', 'transactions', 'last_price_change_usd_24h', 'created_at']).optional().default('volume_usd').describe('Field to order by')
  },
  async ({ page, limit, sort, orderBy }) => {
    const data = await fetchFromAPI(`/pools?page=${page}&limit=${limit}&sort=${sort}&order_by=${orderBy}`);
    return formatMcpResponse(data);
  }
);

// getNetworkPools
server.tool(
  'getNetworkPools',
  'Get a list of top liquidity pools on a specific network',
  {
    network: z.string().describe('Network ID (e.g., ethereum, solana)'),
    page: z.number().optional().default(0).describe('Page number for pagination'),
    limit: z.number().optional().default(10).describe('Number of items per page'),
    sort: z.enum(['asc', 'desc']).optional().default('desc').describe('Sort order'),
    orderBy: z.enum(['volume_usd', 'price_usd', 'transactions', 'last_price_change_usd_24h', 'created_at']).optional().default('volume_usd').describe('Field to order by')
  },
  async ({ network, page, limit, sort, orderBy }) => {
    const data = await fetchFromAPI(`/networks/${network}/pools?page=${page}&limit=${limit}&sort=${sort}&order_by=${orderBy}`);
    return formatMcpResponse(data);
  }
);

// getDexPools
server.tool(
  'getDexPools',
  'Get top pools on a specific DEX within a network',
  {
    network: z.string().describe('Network ID (e.g., ethereum, solana)'),
    dex: z.string().describe('DEX identifier'),
    page: z.number().optional().default(0).describe('Page number for pagination'),
    limit: z.number().optional().default(10).describe('Number of items per page'),
    sort: z.enum(['asc', 'desc']).optional().default('desc').describe('Sort order'),
    orderBy: z.enum(['volume_usd', 'price_usd', 'transactions', 'last_price_change_usd_24h', 'created_at']).optional().default('volume_usd').describe('Field to order by')
  },
  async ({ network, dex, page, limit, sort, orderBy }) => {
    const data = await fetchFromAPI(`/networks/${network}/dexes/${dex}/pools?page=${page}&limit=${limit}&sort=${sort}&order_by=${orderBy}`);
    return formatMcpResponse(data);
  }
);

// getPoolDetails
server.tool(
  'getPoolDetails',
  'Get detailed information about a specific pool on a network',
  {
    network: z.string().describe('Network ID (e.g., ethereum, solana)'),
    poolAddress: z.string().describe('Pool address or identifier'),
    inversed: z.boolean().optional().default(false).describe('Whether to invert the price ratio')
  },
  async ({ network, poolAddress, inversed }) => {
    const data = await fetchFromAPI(`/networks/${network}/pools/${poolAddress}?inversed=${inversed}`);
    return formatMcpResponse(data);
  }
);

// getTokenDetails
server.tool(
  'getTokenDetails',
  'Get detailed information about a specific token on a network',
  {
    network: z.string().describe('Network ID (e.g., ethereum, solana)'),
    tokenAddress: z.string().describe('Token address or identifier')
  },
  async ({ network, tokenAddress }) => {
    const data = await fetchFromAPI(`/networks/${network}/tokens/${tokenAddress}`);
    return formatMcpResponse(data);
  }
);

// getTokenPools
server.tool(
  'getTokenPools',
  'Get a list of top liquidity pools for a specific token on a network',
  {
    network: z.string().describe('Network ID (e.g., ethereum, solana)'),
    tokenAddress: z.string().describe('Token address or identifier'),
    page: z.number().optional().default(0).describe('Page number for pagination'),
    limit: z.number().optional().default(10).describe('Number of items per page'),
    sort: z.enum(['asc', 'desc']).optional().default('desc').describe('Sort order'),
    orderBy: z.enum(['volume_usd', 'price_usd', 'transactions', 'last_price_change_usd_24h', 'created_at']).optional().default('volume_usd').describe('Field to order by'),
    address: z.string().optional().describe('Filter pools that contain this additional token address')
  },
  async ({ network, tokenAddress, page, limit, sort, orderBy, address }) => {
    let endpoint = `/networks/${network}/tokens/${tokenAddress}/pools?page=${page}&limit=${limit}&sort=${sort}&order_by=${orderBy}`;
    if (address) {
      endpoint += `&address=${encodeURIComponent(address)}`;
    }
    const data = await fetchFromAPI(endpoint);
    return formatMcpResponse(data);
  }
);

// getPoolOHLCV
server.tool(
  'getPoolOHLCV',
  'Get OHLCV (Open-High-Low-Close-Volume) data for a specific pool',
  {
    network: z.string().describe('Network ID (e.g., ethereum, solana)'),
    poolAddress: z.string().describe('Pool address or identifier'),
    start: z.string().describe('Start time for historical data (ISO-8601, yyyy-mm-dd, or Unix timestamp)'),
    end: z.string().optional().describe('End time for historical data (max 1 year from start)'),
    limit: z.number().optional().default(1).describe('Number of data points to retrieve (max 366)'),
    interval: z.string().optional().default('24h').describe('Interval granularity for OHLCV data (1m, 5m, 10m, 15m, 30m, 1h, 6h, 12h, 24h)'),
    inversed: z.boolean().optional().default(false).describe('Whether to invert the price ratio in OHLCV calculations')
  },
  async ({ network, poolAddress, start, end, limit, interval, inversed }) => {
    let endpoint = `/networks/${network}/pools/${poolAddress}/ohlcv?start=${encodeURIComponent(start)}&interval=${interval}&limit=${limit}&inversed=${inversed}`;
    if (end) {
      endpoint += `&end=${encodeURIComponent(end)}`;
    }
    const data = await fetchFromAPI(endpoint);
    return formatMcpResponse(data);
  }
);

// getPoolTransactions
server.tool(
  'getPoolTransactions',
  'Get transactions of a pool on a network',
  {
    network: z.string().describe('Network ID (e.g., ethereum, solana)'),
    poolAddress: z.string().describe('Pool address or identifier'),
    page: z.number().optional().default(0).describe('Page number for pagination'),
    limit: z.number().optional().default(10).describe('Number of items per page'),
    cursor: z.string().optional().describe('Transaction ID used for cursor-based pagination')
  },
  async ({ network, poolAddress, page, limit, cursor }) => {
    let endpoint = `/networks/${network}/pools/${poolAddress}/transactions?page=${page}&limit=${limit}`;
    if (cursor) {
      endpoint += `&cursor=${encodeURIComponent(cursor)}`;
    }
    const data = await fetchFromAPI(endpoint);
    return formatMcpResponse(data);
  }
);

// search
server.tool(
  'search',
  'Search for tokens, pools, and DEXes by name or identifier',
  {
    query: z.string().describe('Search term (e.g., "uniswap", "bitcoin", or a token address)')
  },
  async ({ query }) => {
    if (!query.trim()) {
      throw new Error('Search query cannot be empty');
    }
    const sanitizedQuery = encodeURIComponent(query.trim());
    const data = await fetchFromAPI(`/search?query=${sanitizedQuery}`);
    return formatMcpResponse(data);
  }
);

// getStats
server.tool(
  'getStats',
  'Get high-level statistics about the DexPaprika ecosystem',
  {},
  async () => {
    const data = await fetchFromAPI('/stats');
    return formatMcpResponse(data);
  }
);

// Start the server
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log('DexPaprika MCP server is running...');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main(); 