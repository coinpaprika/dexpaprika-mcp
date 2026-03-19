# DexPaprika MCP Server

A Model Context Protocol (MCP) server that provides on-demand access to DexPaprika's cryptocurrency and DEX data API. Built specifically for AI assistants like Claude to programmatically fetch real-time token, pool, and DEX data with zero configuration.

## TL;DR

```bash
# Install globally
npm install -g dexpaprika-mcp

# Start the server
dexpaprika-mcp

# Or run directly without installation
npx dexpaprika-mcp
```

DexPaprika MCP connects Claude to live DEX data across multiple blockchains. No API keys required. [Installation](#installation) | [Configuration](#claude-desktop-integration) | [API Reference](https://docs.dexpaprika.com/introduction)

> **Prefer zero setup?** Use the hosted MCP server at [mcp.dexpaprika.com](https://mcp.dexpaprika.com) — no installation, no API key, same 14 tools. See [Hosted Alternative](#hosted-alternative-no-installation) for transport endpoints.

## Version 1.3.0 Update Highlights

**New tools**: `getCapabilities` (agent onboarding with workflows, synonyms, best practices) and `getNetworkPoolsFilter` (server-side pool filtering by volume, transactions, creation time).

**Breaking**: Parameters renamed to snake_case (`poolAddress` → `pool_address`, `tokenAddress` → `token_address`, `orderBy` → `order_by`). Pagination is now 1-indexed. See [CHANGELOG.md](CHANGELOG.md) for full migration guide.

## What Can You Build?

- **Token Analysis Tools**: Track price movements, liquidity depth changes, and volume patterns
- **DEX Comparisons**: Analyze fee structures, volume, and available pools across different DEXes
- **Liquidity Pool Analytics**: Monitor TVL changes, impermanent loss calculations, and price impact assessments
- **Market Analysis**: Cross-chain token comparisons, volume trends, and trading activity metrics
- **Portfolio Trackers**: Real-time value tracking, historical performance analysis, yield opportunities
- **Technical Analysis**: Perform advanced technical analysis using historical OHLCV data, including trend identification, pattern recognition, and indicator calculations

## Installation

### Installing via Smithery

To install DexPaprika for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@coinpaprika/dexpaprika-mcp):

```bash
npx -y @smithery/cli install @coinpaprika/dexpaprika-mcp --client claude
```

### Manual Installation
```bash
# Install globally (recommended for regular use)
npm install -g dexpaprika-mcp

# Verify installation
dexpaprika-mcp --version

# Start the server
dexpaprika-mcp
```

The server runs on port 8010 by default. You'll see `MCP server is running at http://localhost:8010` when successfully started.

## Video Tutorial

Watch our step-by-step tutorial on setting up and using the DexPaprika MCP server:

[![DexPaprika MCP Tutorial](https://img.youtube.com/vi/rIxFn2PhtvI/0.jpg)](https://www.youtube.com/watch?v=rIxFn2PhtvI)

## Claude Desktop Integration

Add the following to your Claude Desktop configuration file:

**macOS**: `~/Library/Application\ Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dexpaprika": {
      "command": "npx",
      "args": ["dexpaprika-mcp"]
    }
  }
}
```

After restarting Claude Desktop, the DexPaprika tools will be available to Claude automatically.

### Hosted Alternative (No Installation)

If you prefer zero setup, point any MCP-compatible client directly at the hosted server at [mcp.dexpaprika.com](https://mcp.dexpaprika.com). The landing page provides setup instructions and documentation. The following transport endpoints are available:

| Transport | Endpoint | Use Case |
|-----------|----------|----------|
| Streamable HTTP | `https://mcp.dexpaprika.com/streamable-http` | Recommended for most clients |
| SSE | `https://mcp.dexpaprika.com/sse` | Legacy SSE transport |
| JSON-RPC | `https://mcp.dexpaprika.com/mcp` | Direct JSON-RPC |

> **Note**: These are MCP protocol endpoints — they won't display anything in a browser. Visit [mcp.dexpaprika.com](https://mcp.dexpaprika.com) for the landing page.

```json
{
  "mcpServers": {
    "dexpaprika": {
      "type": "streamable-http",
      "url": "https://mcp.dexpaprika.com/streamable-http"
    }
  }
}
```

## Available Tools (14)

### Discovery

| Tool | Description |
|------|-------------|
| `getCapabilities` | Server capabilities, workflow patterns, network synonyms, and best practices. **Start here.** |
| `getNetworks` | List all 33 supported blockchain networks |
| `getStats` | High-level ecosystem stats (total networks, DEXes, pools, tokens) |
| `search` | Search tokens, pools, and DEXes across ALL networks by name, symbol, or address |

### DEX Operations

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `getNetworkDexes` | List DEXes on a specific network | `network` |

### Pool Operations

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `getNetworkPools` | **PRIMARY** — Get top liquidity pools on a network | `network` |
| `getDexPools` | Get pools from a specific DEX | `network`, `dex` |
| `getNetworkPoolsFilter` | Filter pools by volume, transactions, creation time | `network` |
| `getPoolDetails` | Detailed pool info (price, volume, TVL, tokens) | `network`, `pool_address` |
| `getPoolOHLCV` | Historical OHLCV candle data | `network`, `pool_address`, `start` |
| `getPoolTransactions` | Recent transactions/trades for a pool | `network`, `pool_address` |

### Token Operations

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `getTokenDetails` | Detailed token information | `network`, `token_address` |
| `getTokenPools` | Liquidity pools containing a token | `network`, `token_address` |
| `getTokenMultiPrices` | Batched prices for up to 10 tokens | `network`, `tokens[]` |

### Example Usage

```javascript
// Start by getting capabilities for workflow guidance:
const caps = await getCapabilities();

// Get details about a specific token:
const solanaJupToken = await getTokenDetails({
  network: "solana",
  token_address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"
});

// Find all pools for a specific token with volume sorting:
const jupiterPools = await getTokenPools({
  network: "solana",
  token_address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  order_by: "volume_usd",
  limit: 5
});

// Get top pools on Ethereum:
const ethereumPools = await getNetworkPools({
  network: "ethereum",
  order_by: "volume_usd",
  limit: 10
});

// Filter pools by volume and creation time:
const filteredPools = await getNetworkPoolsFilter({
  network: "ethereum",
  volume_24h_min: 100000,
  created_after: 1710806400,
  sort_by: "volume_24h",
  limit: 20
});

// Get historical price data:
const ohlcvData = await getPoolOHLCV({
  network: "ethereum",
  pool_address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  start: "2023-01-01",
  interval: "24h",
  limit: 30
});

// Batch prices for multiple tokens (max 10):
const prices = await getTokenMultiPrices({
  network: "ethereum",
  tokens: [
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "0xdac17f958d2ee523a2206206994597c13d831ec7"
  ]
});
```

## Sample Prompts for Claude

- "Analyze the JUP token on Solana. Fetch price, volume, and top liquidity pools."
- "Compare trading volume between Uniswap V3 and SushiSwap on Ethereum."
- "Get the 7-day OHLCV data for SOL/USDC on Raydium and plot a price chart."
- "Find the top 5 pools by liquidity on Fantom network and analyze their fee structures."
- "Get recent transactions for the ETH/USDT pool on Uniswap and analyze buy vs sell pressure."
- "Show me the top 10 pools on Ethereum by 24h volume."
- "Search for all pools containing the ARB token and rank them by volume."
- "Filter Ethereum pools with >$100K 24h volume created in the last week."
- "First get all available networks, then show me the top pools on each major network."

## Rate Limits & Performance

- **Free Tier Limits**: 10,000 requests per day
- **Response Time**: 100-500ms for most endpoints (network dependent)
- **Data Freshness**: Pool and token data updated every 15-30s
- **Error Handling**: Structured errors with codes, suggestions, and retry guidance
- **OHLCV Data Availability**: Historical data typically available from token/pool creation date

## Troubleshooting

**Common Issues:**

- **Rate limiting**: If receiving `DP429_RATE_LIMIT` errors, implement exponential backoff
- **Missing data**: Some newer tokens/pools may have incomplete historical data
- **Timeout errors**: Large data requests may take longer, consider pagination
- **Network errors**: Check network connectivity, the service requires internet access
- **OHLCV limitations**: Maximum range between start and end dates is 1 year; use pagination for longer timeframes
- **Empty OHLCV**: Pool may be too new — use `getPoolTransactions` instead

## Development

```bash
# Clone the repository
git clone https://github.com/coinpaprika/dexpaprika-mcp.git
cd dexpaprika-mcp

# Install dependencies
npm install

# Run with auto-restart on code changes
npm run watch

# Build for production
npm run build

# Run tests
npm test
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for detailed release notes and migration guides.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Additional Resources

- [DexPaprika API Documentation](https://docs.dexpaprika.com/introduction)
- [Hosted MCP Server](https://mcp.dexpaprika.com) — Zero-setup alternative
- [Model Context Protocol Specification](https://github.com/anthropics/anthropic-cookbook/blob/main/mcp/README.md)
- [DexPaprika](https://dexpaprika.com) - Comprehensive onchain analytics market data
- [CoinPaprika](https://coinpaprika.com) - Comprehensive cryptocurrency market data
