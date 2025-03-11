# DexPaprika MCP Server

A Model Context Protocol (MCP) server that provides access to decentralized exchange (DEX) data from the DexPaprika API. This server enables AI assistants like Claude to fetch and analyze DEX, token, and liquidity pool information without requiring API keys.

## Features

- Blockchain network information across multiple chains
- Decentralized exchange (DEX) data
- Liquidity pool details and metrics
- Token information and market data
- Price and volume analytics for tokens and pools
- Comprehensive search capabilities across DeFi entities

## Installation

```bash
# Install from npm
npm install -g dexpaprika-mcp

# Or use directly with npx
npx dexpaprika-mcp
```

## Usage with Claude Desktop

Add this configuration to your Claude Desktop config file:

**MacOS**: `~/Library/Application\ Support/Claude/claude_desktop_config.json`  
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

## Sample Prompts for Claude

Once configured with Claude Desktop, you can use prompts like:

- "What are the top liquidity pools on Ethereum by volume?"
- "Show me details about the USDC/ETH pool on Uniswap V3."
- "What's the current price of SOL in the Raydium pool on Solana?"
- "Which DEXes are available on the Fantom network?"
- "What tokens have the highest trading volume in the last 24 hours?"
- "Find pools for the Jupiter token on Solana."
- "What's the overall size of the DeFi ecosystem tracked by DexPaprika?"

## Available Tools

The server provides these tools to Claude:

1. **getNetworks** - Get a list of all supported blockchain networks and their metadata
2. **getNetworkDexes** - Get a list of available DEXes on a specific network
3. **getTopPools** - Get a paginated list of top liquidity pools from all networks
4. **getNetworkPools** - Get a list of top liquidity pools on a specific network
5. **getDexPools** - Get top pools on a specific DEX within a network
6. **getPoolDetails** - Get detailed information about a specific pool on a network
7. **getTokenDetails** - Get detailed information about a specific token on a network
8. **search** - Search for tokens, pools, and DEXes by name or identifier
9. **getStats** - Get high-level statistics about the DexPaprika ecosystem

## Development

To develop or modify this server:

```bash
# Clone the repository
git clone https://github.com/coinpaprika/dexpaprika-mcp.git
cd dexpaprika-mcp

# Install dependencies
npm install

# Start the server in development mode
npm run watch

# Build for production
npm run build
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

This server uses the DexPaprika API to fetch decentralized exchange data. DexPaprika is developed by [CoinPaprika](https://coinpaprika.com) and provides comprehensive data on tokens, pools, and DEXes across multiple blockchain networks. 