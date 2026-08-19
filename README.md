# DexPaprika MCP Server

[![smithery badge](https://smithery.ai/badge/coinpaprika/dexpaprika)](https://smithery.ai/servers/coinpaprika/dexpaprika)

A Model Context Protocol (MCP) server that provides on-demand access to DexPaprika's cryptocurrency and DEX data API. Built specifically for AI assistants like Claude to programmatically fetch current token, pool and DEX data with zero configuration.

## TL;DR

```bash
# Install globally
npm install -g dexpaprika-mcp

# Start the server
dexpaprika-mcp

# Or run directly without installation
npx dexpaprika-mcp@latest
```

DexPaprika MCP connects Claude to live DEX data across multiple blockchains. The free tier needs no API key to start. [Installation](#installation) | [Configuration](#claude-desktop-integration) | [API Reference](https://docs.dexpaprika.com/introduction)

> **Prefer zero setup?** Use the hosted MCP server at [mcp.dexpaprika.com](https://mcp.dexpaprika.com): no installation, no key to start, the same data tools plus `submitFeedback`. See [Hosted server](#hosted-server-no-installation) for transport endpoints.

## Latest release

See [CHANGELOG.md](CHANGELOG.md) for release notes and migration guides.

## What Can You Build?

- **Token Analysis Tools**: Track price movements, liquidity depth changes, and volume patterns
- **DEX Comparisons**: Analyze fee structures, volume, and available pools across different DEXes
- **Liquidity Pool Analytics**: Monitor TVL changes, impermanent loss calculations, and price impact assessments
- **Market Analysis**: Cross-chain token comparisons, volume trends, and trading activity metrics
- **Portfolio Trackers**: Current value tracking, historical performance analysis, yield opportunities
- **Technical Analysis**: Perform advanced technical analysis using historical OHLCV data, including trend identification, pattern recognition, and indicator calculations

## Installation

### Installing via Smithery

To install DexPaprika for Claude Desktop automatically via [Smithery](https://smithery.ai/servers/coinpaprika/dexpaprika):

```bash
npx -y smithery mcp add coinpaprika/dexpaprika
```

### Manual Installation
```bash
# Install globally (recommended for regular use)
npm install -g dexpaprika-mcp

# Start the server
dexpaprika-mcp
```

This is a stdio server: it speaks MCP over stdin and stdout and binds no port. On start it writes `DexPaprika MCP server v<version> (tool contract v<contract>) is running...` to stderr and then waits for a client. Run it from an MCP client (Claude Desktop, Cursor, Claude Code) rather than expecting a URL in a browser.

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
      "args": ["dexpaprika-mcp@latest"]
    }
  }
}
```

After restarting Claude Desktop, the DexPaprika tools will be available to Claude automatically.

### Optional: using an API key

**This works without a key and always will.** No signup, no card, nothing to
configure. Everything above is the supported way to run it.

A free key raises the monthly allowance and opens streaming on any token rather
than the public showcase set. It does **not** raise the per-minute request
limit, which is the same on both tiers. Get one at
[console.dexpaprika.com](https://console.dexpaprika.com); current limits are on
the [rate limits page](https://docs.dexpaprika.com/knowledge-base/rate-limits).

```json
{
  "mcpServers": {
    "dexpaprika": {
      "command": "npx",
      "args": ["dexpaprika-mcp@latest"],
      "env": {
        "DEXPAPRIKA_API_KEY": "your_key_here"
      }
    }
  }
}
```

**The key goes in on its own. There is no `Bearer` prefix**, and no other scheme
word either. Paste the key exactly as issued. Almost every other API wants the
opposite, so this is the single most common reason a working key looks broken.

Two things worth knowing:

- **A key we cannot read does not produce an error.** The data endpoints ignore
  an unreadable key and serve you as an anonymous caller, with a normal `200` and
  real data, so a typo looks exactly like success. Ask the assistant to run
  `getKeyStatus` after setting one: it reports which plan the API actually sees
  and names the likely cause when the key is not landing.
- **Pro customers** additionally set `DEXPAPRIKA_API_BASE_URL` to
  `https://api-pro.dexpaprika.com`. The host does not change automatically,
  because sending a free key to that host returns 403.

### Hosted server (no installation)

If you prefer zero setup, point any MCP-compatible client directly at the hosted server at [mcp.dexpaprika.com](https://mcp.dexpaprika.com). The landing page provides setup instructions and documentation. The following transport endpoints are available:

| Transport | Endpoint | Use Case |
|-----------|----------|----------|
| Streamable HTTP | `https://mcp.dexpaprika.com/streamable-http` | Recommended for most clients |
| SSE | `https://mcp.dexpaprika.com/sse` | Legacy SSE transport |
| JSON-RPC | `https://mcp.dexpaprika.com/json-rpc` | Direct JSON-RPC |

> **Note**: These are MCP protocol endpoints. They won't display anything in a browser. Visit [mcp.dexpaprika.com](https://mcp.dexpaprika.com) for the landing page.

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

## Available Tools (17)

This self-host build registers 17 read tools: 16 market-data tools plus `getKeyStatus`. The hosted server at `mcp.dexpaprika.com` registers its own set including `submitFeedback`. Verify either with a live `tools/list`.

### Discovery

| Tool | Description |
|------|-------------|
| `getCapabilities` | Server capabilities, workflow patterns, network synonyms, and best practices. **Start here.** |
| `getNetworks` | List every supported blockchain network (36) |
| `getStats` | High-level ecosystem stats (total networks, DEXes, pools, tokens) |
| `search` | Search tokens, pools, and DEXes across ALL networks by name, symbol, or address |
| `getKeyStatus` | Whether a key is being sent and which plan the API sees. Reads no market data. |

### DEX Operations

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `getNetworkDexes` | List DEXes on a specific network | `network` |

### Pool Operations

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `getNetworkPools` | **PRIMARY**. Get top liquidity pools on a network | `network` |
| `getDexPools` | Get pools from a specific DEX (rows under `results`, cursor pagination) | `network`, `dex` |
| `getNetworkPoolsFilter` | Filter pools by volume, transactions, creation time | `network` |
| `getPoolDetails` | Detailed pool info (price, volume, TVL, tokens) | `network`, `pool_address` |
| `getPoolOHLCV` | Historical OHLCV candle data | `network`, `pool_address`, `start` |
| `getPoolTransactions` | Recent transactions/trades for a pool | `network`, `pool_address` |

### Token Operations

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `getTokenDetails` | Detailed token information | `network`, `token_address` |
| `getTokenPools` | Liquidity pools containing a token (network-scoped filter, `results` + cursor pagination) | `network`, `token_address` |
| `getTokenMultiPrices` | Batched prices for up to 10 tokens | `network`, `tokens[]` |
| `getTopTokens` | Top tokens on a network ranked by volume, liquidity, FDV, or 24h price change | `network` |
| `filterNetworkTokens` | Filter tokens by volume, liquidity, FDV, transactions, and creation time | `network` |

### Example Usage

```javascript
// Start by getting capabilities for workflow guidance:
const caps = await getCapabilities();

// Get details about a specific token:
const solanaJupToken = await getTokenDetails({
  network: "solana",
  token_address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"
});

// Find pools containing a token (returns `results` with cursor pagination;
// the token filter only works network-scoped):
const jupiterPools = await getTokenPools({
  network: "solana",
  token_address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  order_by: "volume_usd_24h",
  limit: 5
});

// Get top pools on Ethereum (returns `results` with cursor pagination):
const ethereumPools = await getNetworkPools({
  network: "ethereum",
  order_by: "volume_usd_24h",
  limit: 10
});

// Filter pools by volume and creation time:
const filteredPools = await getNetworkPoolsFilter({
  network: "ethereum",
  volume_24h_min: 100000,
  created_after: 1710806400,
  sort_by: "volume_usd_24h",
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

- **Free tier**: keyless, no signup, at 15 requests per minute. A free API key raises that to 30 requests per minute, raises the monthly quota, and unlocks streaming. Pro is $99/month at 300 requests per minute. One request costs one credit; batch endpoints cost one credit per item. Monthly quotas change, so read them here rather than from this page: https://dexpaprika.com/api/pricing
- **Data delay**: up to 15 seconds on the free tier, real-time on Pro
- **Response Time**: 100-500ms for most endpoints (network dependent)
- **Error Handling**: Structured errors with codes, suggestions, and retry guidance
- **OHLCV Data Availability**: Historical data typically available from token/pool creation date

## Troubleshooting

**Common Issues:**

- **Rate limiting**: If receiving `DP429_RATE_LIMIT` errors, implement exponential backoff
- **Missing data**: Some newer tokens/pools may have incomplete historical data
- **Timeout errors**: Large data requests may take longer, consider pagination
- **Network errors**: Check network connectivity, the service requires internet access
- **OHLCV limitations**: Maximum range between start and end dates is 1 year; use pagination for longer timeframes
- **Empty OHLCV**: Pool may be too new. Use `getPoolTransactions` instead

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
- [Hosted MCP Server](https://mcp.dexpaprika.com), zero-setup option
- [Model Context Protocol Specification](https://modelcontextprotocol.io)
- [DexPaprika](https://dexpaprika.com) - Comprehensive onchain analytics market data
- [CoinPaprika](https://coinpaprika.com) - Comprehensive cryptocurrency market data
