#!/usr/bin/env node
// Path traversal regression test: runs the real server over stdio against a local HTTP
// server that records every path it is asked for, calls the tools with arguments that try to
// leave /networks, and fails if any such request arrives. Run: node src/test_path_safety.js
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const seen = [];
const upstream = http.createServer((req, res) => {
  seen.push(req.url);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'x', results: [], data: [], tokens: [] }));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${upstream.address().port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, 'index.js')],
  env: { ...process.env, DEXPAPRIKA_API_BASE_URL: base, DEXPAPRIKA_API_KEY: '' },
});
const client = new Client({ name: 'path-safety', version: '0' });
await client.connect(transport);

const PAYLOADS = [
  '../../outside/target', '../../../outside/other', '..', 'x/../../../outside/target',
  '..%2F..%2Foutside%2Ftarget', '%2e%2e/%2e%2e/outside/target', '..\\..\\outside\\target',
  '0xabc?x=1/../../outside/target', '0xabc#/../../outside',
];
const R = 'Regression test for the path traversal fix in the upstream URL builder.';
for (const p of PAYLOADS) {
  for (const [name, args] of [
    ['getPoolDetails', { network: 'ethereum', pool_address: p }],
    ['getPoolOHLCV', { network: 'ethereum', pool_address: p, start: '-24h' }],
    ['getTokenDetails', { network: 'ethereum', token_address: p }],
    ['getTokenDetails', { network: p, token_address: '0xabc' }],
    ['getPoolIndicator', { network: 'ethereum', pool_address: p, indicator: 'rsi', interval: '1h' }],
  ]) {
    await client.callTool({ name, arguments: { ...args, rationale: R } }).catch(() => {});
  }
}
// The key status check must still reach the API.
await client.callTool({ name: 'getKeyStatus', arguments: {} }).catch(() => {});
// A real id must still reach the API.
await client.callTool({ name: 'getTokenDetails', arguments: { network: 'sui', token_address: '0x2::sui::SUI', rationale: R } });
await client.close();
upstream.close();

const escaped = seen.filter((u) => (!u.startsWith('/networks/') && u !== '/usage') || /outside|\.\./i.test(decodeURIComponent(u)));
const legit = seen.filter((u) => u.startsWith('/networks/sui/tokens/0x2::sui::SUI'));
const usage = seen.filter((u) => u === '/usage');
console.log(`requests seen: ${seen.length}, escaped /networks: ${escaped.length}, real id reached: ${legit.length}, /usage reached: ${usage.length}`);
if (escaped.length) console.log(escaped.join('\n'));
process.exit(escaped.length === 0 && legit.length === 1 && usage.length === 1 ? 0 : 1);
