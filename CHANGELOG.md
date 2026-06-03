# Changelog

All notable changes to the DexPaprika MCP Server will be documented in this file.

## [2.0.0] - 2026-06-03

Full 1:1 contract parity with the hosted DexPaprika MCP worker (`mcp.dexpaprika.com`) v2.0.0. Only the transport differs (stdio vs HTTP); tools, parameters, aliases, synonym resolution, sort normalization, output schemas, server instructions and version now match the worker.

### Breaking changes

- **Response shape — the `{ data, meta }` wrapper is gone.** Previously every tool wrapped its payload as `{ data: <payload>, meta: { rate_limit, response_time_ms, cached, timestamp } }`. Now each tool returns the upstream payload directly, in two forms: `content[0].text` (the JSON string, for older clients) and `structuredContent` (the same object, validated against the tool's `outputSchema`, MCP 2025-06-18+). The per-request `meta` block (rate-limit counters, response time) is no longer emitted. Consumers that read `response.data` must now read the top level. This is intentional and aligns the self-host build with the worker's wire shape.
- **Array tools wrap under named keys** in `structuredContent`: `getNetworks` → `{ networks: [...] }`, `getPoolOHLCV` → `{ ohlcv: [...] }`. `getTokenMultiPrices` now returns `{ prices: [{id, chain, price_usd}], missing_tokens: [...] }` — tokens upstream could not price are surfaced in `missing_tokens` instead of being silently dropped.
- **`rationale` is now required on every read tool** (all tools except `submitFeedback`): a 20-500 char string explaining why the call is made. The self-host build accepts it to satisfy the schema and does not persist it (no analytics sink). `submitFeedback` is the one tool with no `rationale` field — its `goal`/`expected`/`observed` fields serve that purpose.
- **Minimum SDK bump**: `@modelcontextprotocol/sdk` is now `^1.29.0` (was `^1.4.1`). Tools migrated from the deprecated `server.tool()` signature to `server.registerTool()` with explicit `inputSchema`/`outputSchema`/`annotations`.

### Added

- **Network synonym resolution at the wire layer** — `eth` → `ethereum`, `matic` → `polygon`, `sol` → `solana`, and 30+ more across 35 canonical networks. The rewrite happens at the single fetch chokepoint, so advertised synonyms now actually resolve instead of 404ing. The same map drives `getCapabilities.network_synonyms`.
- **Canonical sort aliases** — `sort_dir` (canonical) alongside `sort` (legacy), and `sort_by` (canonical) alongside `order_by` (legacy), on `getNetworkDexes`, `getNetworkPools`, `getDexPools`, `getTokenPools`, `getTopTokens`. The two filter tools (`getNetworkPoolsFilter`, `filterNetworkTokens`) gain the legacy `sort`/`order_by` aliases. Canonical wins when both are supplied; the legacy wire param each tool already used is preserved.
- **`getTokenPools` aliases** — `inversed` (canonical, alias of legacy `reorder`) and `paired_token_address` (canonical, alias of legacy `address`).
- **`submitFeedback` tool (17th tool)** — low-friction feedback channel with `goal`/`attempted_tools`/`blocked_at`/`expected`/`observed`/`severity`. The self-host build returns a structured ack (`{ ok: true, tracking_id: null, ... }`) rather than persisting; the hosted worker writes to its analytics DB.
- **Per-tool output schemas** — every tool advertises an `outputSchema` (permissive `.passthrough()` so extra upstream fields don't break strict validators like Cursor / Claude Desktop).
- **Server `instructions`** — onboarding notes (rationale convention, parameter naming, time formats, output shape) advertised once per session via the initialize result.

### Changed

- `getCapabilities` is now a lean, local-only doc matching the worker: top-level `name`/`aliases`/`server`/`tools_count: 17`/`stats` (35 networks, ~29M tokens, ~31M pools, free, no API key)/`network_synonyms`/`workflows`/`common_pitfalls`/`documentation`/`agent_skills`. The previous sprawling capabilities object (validation rules, rate limits, parameter examples, version history, etc.) was replaced. Stale "33 networks" corrected to 35.
- `page=0` is coerced to `page=1` in all paginated handlers (1-indexed, backward-compat).
- The structured error handling (`parseAPIError`) is preserved and still surfaces actionable `code`/`suggestion` payloads.

### Notes

- `filterNetworkTokens` advertises a `results` array in its output schema for parity, but the live API returns its rows under `data` (plus a `query` echo). Both pass through `structuredContent` via the schema's outer passthrough; the documented key is optional so real responses validate.

## [1.3.0] - 2026-03-19

### ⚠️ BREAKING CHANGES

#### Parameter Naming — snake_case Alignment
All tool parameters now use snake_case to match the hosted MCP server at `mcp.dexpaprika.com`:
- `poolAddress` → `pool_address` (getPoolDetails, getPoolOHLCV, getPoolTransactions)
- `tokenAddress` → `token_address` (getTokenDetails, getTokenPools)
- `orderBy` → `order_by` (getNetworkDexes, getNetworkPools, getDexPools, getTokenPools)

#### Pagination — 1-indexed
All `page` parameters now default to `1` (1-indexed) instead of `0` (0-indexed), matching the hosted server behavior.

#### Token Multi Prices — Comma-Separated Format
`getTokenMultiPrices` now serializes tokens as a single comma-separated query param (`?tokens=a,b,c`) instead of repeated params (`?tokens=a&tokens=b`).

### ✨ Added

- **New tool: `getCapabilities`** — Returns server capabilities, workflow patterns, network synonyms, common pitfalls, and best-practice sequences. Essential for agent onboarding.
- **New tool: `getNetworkPoolsFilter`** — Server-side pool filtering by volume (`volume_24h_min`, `volume_24h_max`), transactions (`txns_24h_min`), and creation time (`created_after`, `created_before`). More efficient than client-side filtering.
- **Structured error handling** — All errors now return structured objects with `code`, `message`, `retryable`, `suggestion`, `corrected_example`, and `metadata` fields. Error codes include `DP400_INVALID_NETWORK`, `DP404_NOT_FOUND`, `DP429_RATE_LIMIT`, etc.
- **Response metadata** — All successful responses now include `meta` with `rate_limit` info, `response_time_ms`, and `timestamp`.
- **Batch validation** — `getTokenMultiPrices` now validates max 10 tokens and returns a structured error if exceeded.
- **OHLCV interval validation** — `interval` parameter on `getPoolOHLCV` now uses `z.enum()` for strict validation of allowed values.

### 🔧 Changed

- All tool descriptions updated to match the hosted MCP server exactly (added TIP references, REQUIRED/OPTIONAL labels).
- Server name changed from `dexpaprika-mcp` to `dexpaprika` to match hosted server.
- JSON responses are now pretty-printed (`JSON.stringify(data, null, 2)`).
- Startup log uses `console.error` instead of `console.log` (proper MCP stdio convention).
- Version bumped to 1.3.0.

### 📝 Notes

- The npm package now matches the hosted MCP server at `mcp.dexpaprika.com` exactly — same tools, same schemas, same error handling, same response format.
- All 14 tools are now available: getCapabilities, getNetworks, getNetworkDexes, getNetworkPools, getDexPools, getNetworkPoolsFilter, getPoolDetails, getPoolOHLCV, getPoolTransactions, getTokenDetails, getTokenPools, getTokenMultiPrices, search, getStats.
- For users who prefer a hosted solution with zero setup, use `mcp.dexpaprika.com/streamable-http` directly.

### 🔄 Migration Guide

**Parameter renames:**
```javascript
// Before (v1.2.0)
getPoolDetails({ network: 'ethereum', poolAddress: '0x...', inversed: false })
getTokenDetails({ network: 'ethereum', tokenAddress: '0x...' })
getNetworkPools({ network: 'ethereum', orderBy: 'volume_usd' })

// After (v1.3.0)
getPoolDetails({ network: 'ethereum', pool_address: '0x...', inversed: false })
getTokenDetails({ network: 'ethereum', token_address: '0x...' })
getNetworkPools({ network: 'ethereum', order_by: 'volume_usd' })
```

**Pagination:**
```javascript
// Before: 0-indexed
getNetworkPools({ network: 'ethereum', page: 0 })

// After: 1-indexed
getNetworkPools({ network: 'ethereum', page: 1 })
```

## [1.2.0] - 2025-10-14

### ✨ Added

- New MCP tool: `getTokenMultiPrices` for batched token price retrieval via repeatable `tokens` query parameters (e.g., `?tokens=a&tokens=b`). Unknown tokens are omitted from the response.

### 🔧 Changed

- `getNetworkDexes` now supports `sort` (asc|desc) and `order_by=pool` to align with the latest OpenAPI.
- Updated tests to cover the new batched prices endpoint and expanded parameter combinations.
- Documentation updates in README for 1.2.0 usage examples and configuration notes.
- Version bumped to 1.2.0.

### 📝 Notes for 1.2.0

- No breaking changes in this release.
- The batched prices endpoint improves efficiency when you only need current USD prices for multiple tokens.

## [1.1.0] - 2025-01-27

### ⚠️ BREAKING CHANGES

#### API Deprecation - Global Pools Endpoint Removed
- **REMOVED**: `getTopPools` function that used the deprecated global `/pools` endpoint
- The global `/pools` endpoint has been permanently removed and now returns `410 Gone`
- All pool queries now require a specific network to improve performance and provide more relevant results

### 🔄 Migration Guide

#### For users who were using `getTopPools`:

**Before (v1.0.x):**
```javascript
// This will no longer work
getTopPools({ page: 0, limit: 10, sort: 'desc', orderBy: 'volume_usd' })
```

**After (v1.1.0):**
```javascript
// Use network-specific queries instead
getNetworkPools({ network: 'ethereum', page: 0, limit: 10, sort: 'desc', orderBy: 'volume_usd' })
getNetworkPools({ network: 'solana', page: 0, limit: 10, sort: 'desc', orderBy: 'volume_usd' })
```

### ✨ Added

- **Enhanced Error Handling**: Added specific error handling for `410 Gone` responses with helpful migration messages
- **Improved Function Descriptions**: All functions now include better guidance on parameter usage
- **New Parameter Support**: Added `reorder` parameter to `getTokenPools` function
- **Better Documentation**: Enhanced parameter descriptions with references to helper functions (e.g., "use getNetworks to see all available networks")
- **Network Guidance**: All network-dependent functions now reference `getNetworks` for discovering valid network IDs

### 🔧 Changed

- **Version**: Updated from 1.0.5 to 1.1.0 to reflect breaking changes
- **Primary Pool Method**: `getNetworkPools` is now highlighted as the primary method for pool data retrieval
- **Parameter Limits**: Updated limit descriptions to reflect API maximum of 100 items per page
- **OHLCV Documentation**: Improved parameter descriptions for better clarity on supported formats
- **Transaction Pagination**: Enhanced documentation for both page-based and cursor-based pagination options

### 🛠️ Technical Improvements

- **Better Error Messages**: More descriptive error messages that guide users toward correct usage patterns
- **Consistent Parameter Descriptions**: Standardized network parameter descriptions across all functions
- **Enhanced Type Safety**: Maintained strong typing with Zod schemas while improving usability

### 📝 Notes

- This update aligns with DexPaprika API v1.3.0 changes
- The API is now considered stable (no longer in beta)
- No API key is required for any endpoints
- All existing network-specific endpoints remain unchanged and fully functional

## [1.0.5] - Previous Release

### 🔧 Changed
- Updated dependencies
- Minor bug fixes and improvements

## [1.0.4] - Previous Release

### ✨ Added
- Initial stable release with full DexPaprika API coverage
- Support for networks, DEXes, pools, tokens, and search functionality
- OHLCV data retrieval for price analysis
- Transaction history access
- Comprehensive error handling and rate limiting support

---

## Migration Support

If you need help migrating from v1.0.x to v1.1.0, please:

1. **Replace all `getTopPools` calls** with `getNetworkPools` calls specifying the desired network
2. **Use `getNetworks`** first to discover available networks if you need to query multiple networks
3. **Update any error handling** to account for the new `410 Gone` error messages
4. **Consider the performance benefits** of network-specific queries for your use case

For additional support, please refer to the [DexPaprika API documentation](https://docs.dexpaprika.com/) or open an issue in this repository. 