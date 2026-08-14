// End-to-end over the real MCP transport: spawn the built server exactly as a
// user's client would, and assert on what reaches the wire. The unit tests pin
// the header rules; this pins that the rules are actually applied to a request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** A throwaway origin that records the requests our server makes to it. */
async function recordingUpstream(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    handler(req, res, seen.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { seen, port: server.address().port, close: () => server.close() };
}

/** Drive the MCP server over stdio and return the response to one tool call. */
async function callTool({ env, toolName, args = {} }) {
  const child = spawn(process.execPath, ['dist/bin.js'], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', () => {});

  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'wire-test-client', version: '9.9.9' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (out.split('\n').some((l) => l.trim().startsWith('{') && JSON.parse(l).id === 2)) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  child.kill();

  const line = out.split('\n').find((l) => {
    try { return JSON.parse(l).id === 2; } catch { return false; }
  });
  assert.ok(line, `no response to the tool call. stdout was:\n${out}`);
  return JSON.parse(line);
}

const RATIONALE = 'Automated wire test asserting which headers the server attaches to outbound calls.';

/** Unwrap the MCP result envelope into the payload object the tool returned. */
function payload(response) {
  const text = response?.result?.content?.[0]?.text;
  assert.ok(typeof text === 'string', `no text content in ${JSON.stringify(response)}`);
  return JSON.parse(text);
}

test('keyless sends no Authorization header but does identify itself', async () => {
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  try {
    await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}`, DEXPAPRIKA_API_KEY: '' },
      toolName: 'getNetworks', args: { rationale: RATIONALE },
    });
    assert.ok(upstream.seen.length > 0, 'the server never called upstream');
    const { headers } = upstream.seen[0];
    assert.equal(headers.authorization, undefined);
    assert.match(headers['user-agent'], /^dexpaprika-mcp\//);
  } finally { upstream.close(); }
});

test('a configured key reaches the wire bare, with no Bearer prefix', async () => {
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  try {
    await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}`, DEXPAPRIKA_API_KEY: 'api_wire_test_key' },
      toolName: 'getNetworks', args: { rationale: RATIONALE },
    });
    const { headers } = upstream.seen[0];
    assert.equal(headers.authorization, 'api_wire_test_key');
    assert.doesNotMatch(headers.authorization, /bearer/i);
  } finally { upstream.close(); }
});

test('the MCP client from the handshake is carried in the user agent', async () => {
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  try {
    await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}` },
      toolName: 'getNetworks', args: { rationale: RATIONALE },
    });
    assert.match(upstream.seen[0].headers['user-agent'], /client=wire-test-client\/9\.9\.9/);
  } finally { upstream.close(); }
});

test('a 429 reports the per-minute limit and the server-supplied Retry-After', async () => {
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '20' });
    res.end('{"message":"rate limit"}');
  });
  try {
    const response = await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}` },
      toolName: 'getNetworks', args: { rationale: RATIONALE },
    });
    const { error } = payload(response);
    assert.equal(error.code, 'DP429_RATE_LIMIT');
    assert.equal(error.metadata.limit_type, 'requests_per_minute');
    // The server said 20 seconds, so we must report 20 seconds.
    assert.equal(error.metadata.retry_after_seconds, 20);
    // The bug this replaced: "Daily rate limit exceeded" plus a wait until local
    // midnight, which for an agent meant abandoning a limit that clears at once.
    assert.doesNotMatch(JSON.stringify(error), /[Dd]aily/);
    assert.ok(error.retryable, 'a per-minute limit is retryable');
  } finally { upstream.close(); }
});

test('a 402 explains the monthly allowance and, when keyless, points at a free key', async () => {
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end('{"message":"quota"}');
  });
  try {
    const response = await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}`, DEXPAPRIKA_API_KEY: '' },
      toolName: 'getNetworks', args: { rationale: RATIONALE },
    });
    const { error } = payload(response);
    assert.equal(error.code, 'DP402_QUOTA_EXHAUSTED');
    assert.equal(error.metadata.limit_type, 'monthly_credits');
    assert.equal(error.metadata.using_api_key, false);
    // Keyless is the one place where pointing at a free key is honest, because a
    // key genuinely raises this ceiling. It does not raise the per-minute one.
    assert.match(error.suggestion, /DEXPAPRIKA_API_KEY/);
  } finally { upstream.close(); }
});
