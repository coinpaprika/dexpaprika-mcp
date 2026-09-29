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

test('a 403 hands the agent the API message instead of a bare status', async () => {
  // OHLCV outside the plan's window answers 403 with a message naming the plan
  // that opens it. Until 2.5.2 the tool returned "API request failed: 403
  // Forbidden" and dropped it, so the agent could not tell what to change.
  const message = 'OHLCV history beyond the last 24 hours requires an API key (free key: 7 days, Dev plan: 30 days, Pro plan: unlimited)';
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message }));
  });
  try {
    const response = await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}`, DEXPAPRIKA_API_KEY: '' },
      toolName: 'getPoolOHLCV',
      args: { rationale: RATIONALE, network: 'ethereum', pool_address: '0xpool', start: '-7d' },
    });
    const { error } = payload(response);
    assert.equal(error.code, 'DP403_ERROR');
    assert.equal(error.message, message);
    assert.equal(error.retryable, false);
  } finally { upstream.close(); }
});

test('getTokenOHLCV calls the token ohlcv path with no inversed param', async () => {
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  try {
    await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}`, DEXPAPRIKA_API_KEY: '' },
      toolName: 'getTokenOHLCV',
      args: { rationale: RATIONALE, network: 'ethereum', token_address: '0xtoken', start: '-24h', interval: '1h', limit: 24 },
    });
    assert.equal(upstream.seen.length, 1, 'expected exactly one upstream request');
    const { pathname, searchParams } = new URL(upstream.seen[0].url, 'http://upstream.test');
    assert.equal(pathname, '/networks/ethereum/tokens/0xtoken/ohlcv');
    assert.equal(searchParams.get('start'), '-24h');
    assert.equal(searchParams.get('interval'), '1h');
    assert.equal(searchParams.get('limit'), '24');
    assert.equal(searchParams.has('inversed'), false, 'getTokenOHLCV must never send inversed, unlike getPoolOHLCV');
  } finally { upstream.close(); }
});

test('getTokenOHLCV on a keyless/free caller returns the 403 naming the required plan', async () => {
  const message = 'this endpoint requires a Dev or Pro plan';
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message }));
  });
  try {
    const response = await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}`, DEXPAPRIKA_API_KEY: '' },
      toolName: 'getTokenOHLCV',
      args: { rationale: RATIONALE, network: 'ethereum', token_address: '0xtoken', start: '-24h' },
    });
    const { error } = payload(response);
    assert.equal(error.code, 'DP403_ERROR');
    assert.equal(error.message, message);
    assert.equal(error.retryable, false);
  } finally { upstream.close(); }
});

test('a 400 carries the API message naming the bad parameter', async () => {
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"message":"invalid start"}');
  });
  try {
    const response = await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}`, DEXPAPRIKA_API_KEY: '' },
      toolName: 'getPoolOHLCV',
      args: { rationale: RATIONALE, network: 'ethereum', pool_address: '0xpool', start: 'yesterday' },
    });
    assert.equal(payload(response).error.message, 'Bad request: invalid start');
  } finally { upstream.close(); }
});

/** The query parameters of the one request the upstream saw. */
function sentParams(upstream) {
  assert.equal(upstream.seen.length, 1, 'expected exactly one upstream request');
  return new URL(upstream.seen[0].url, 'http://upstream.test').searchParams;
}

test('created_after and created_before reach the wire as relative offsets', async () => {
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"results":[],"has_next_page":false}');
  });
  try {
    await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}`, DEXPAPRIKA_API_KEY: '' },
      toolName: 'getNetworkPoolsFilter',
      args: { rationale: RATIONALE, network: 'ethereum', created_after: '-24h', created_before: '-1h' },
    });
    const q = sentParams(upstream);
    assert.equal(q.get('created_after'), '-24h');
    assert.equal(q.get('created_before'), '-1h');
  } finally { upstream.close(); }
});

test('a numeric created_after still works and is sent as it is', async () => {
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"results":[],"has_next_page":false}');
  });
  try {
    const response = await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}`, DEXPAPRIKA_API_KEY: '' },
      toolName: 'filterNetworkTokens',
      args: { rationale: RATIONALE, network: 'ethereum', created_after: 1790000000 },
    });
    assert.equal(response.error, undefined, 'a number must pass input validation');
    assert.equal(sentParams(upstream).get('created_after'), '1790000000');
  } finally { upstream.close(); }
});

test('transactions from and to accept a relative offset and an RFC3339 time with an offset', async () => {
  const upstream = await recordingUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"transactions":[],"page_info":{"page":1,"limit":10,"total_items":0,"total_pages":0}}');
  });
  try {
    await callTool({
      env: { DEXPAPRIKA_API_BASE_URL: `http://127.0.0.1:${upstream.port}`, DEXPAPRIKA_API_KEY: '' },
      toolName: 'getPoolTransactions',
      args: { rationale: RATIONALE, network: 'ethereum', pool_address: '0xpool', from: '-1h', to: '2026-09-28T12:00:00+02:00' },
    });
    const q = sentParams(upstream);
    assert.equal(q.get('from'), '-1h');
    // Unencoded, the + would arrive as a space and the API would reject the time.
    assert.equal(q.get('to'), '2026-09-28T12:00:00+02:00');
  } finally { upstream.close(); }
});
