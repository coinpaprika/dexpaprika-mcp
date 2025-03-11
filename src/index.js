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

// Create a new MCP server
const server = new McpServer({
  name: 'dexpaprika-mcp',
  version: '1.0.4',
  description: 'MCP server for accessing DexPaprika API data for decentralized exchanges and tokens',
});

// Tool 1: Get Available Networks
server.tool(
  'getNetworks',
  'Retrieve a list of all supported blockchain networks and their metadata',
  {},
  async () => {
    const data = await fetchFromAPI('/networks');
    return formatMcpResponse(data);
  }
);

// Tool 2: Get DEXes on a Network
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

// Tool 3: Get Top Pools
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

// Tool 4: Get Network Pools
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

// Tool 5: Get DEX Pools
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

// Tool 6: Get Pool Details
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

// Tool 7: Get Token Details
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

// Tool 8: Search
server.tool(
  'search',
  'Search for tokens, pools, and DEXes by name or identifier',
  {
    query: z.string().describe('Search term (e.g., "uniswap", "bitcoin", or a token address)')
  },
  async ({ query }) => {
    // The parameter in the API is 'q' not 'query'
    const data = await fetchFromAPI(`/search?q=${encodeURIComponent(query)}`);
    return formatMcpResponse(data);
  }
);

// Tool 9: Get Stats
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