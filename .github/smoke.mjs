// CI smoke test: boot the stdio MCP server and verify the MCP handshake +
// tool registry over a real client. Fully offline — `initialize` and
// `tools/list` make no upstream API calls, so this is deterministic and not
// subject to live-data flakiness or rate limits.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MIN_TOOLS = 14; // lenient floor (package has 16 on v1.x, 17 on v2.x)
const CORE_TOOLS = ['getNetworks', 'getNetworkPools', 'getCapabilities'];

const transport = new StdioClientTransport({ command: 'node', args: ['src/index.js'] });
const client = new Client({ name: 'ci-smoke', version: '1.0.0' }, { capabilities: {} });

let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; };

try {
  await client.connect(transport);

  const info = client.getServerVersion?.() ?? {};
  console.log(`server: ${info.name ?? '?'} v${info.version ?? '?'}`);

  const { tools } = await client.listTools();
  console.log(`tools (${tools.length}): ${tools.map((t) => t.name).sort().join(', ')}`);

  if (tools.length < MIN_TOOLS) fail(`expected >= ${MIN_TOOLS} tools, got ${tools.length}`);

  const missing = CORE_TOOLS.filter((n) => !tools.some((t) => t.name === n));
  if (missing.length) fail(`missing core tools: ${missing.join(', ')}`);
} catch (err) {
  fail(`MCP handshake threw: ${err?.message ?? err}`);
} finally {
  await client.close().catch(() => {});
}

if (failed) process.exit(1);
console.log('SMOKE OK');
