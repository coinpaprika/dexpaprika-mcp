// getCapabilities is machine-read: agents plan against it. A stale number here
// misleads software rather than a reader, so the figures that can drift are
// pinned against the thing they describe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

async function session(requests) {
  const child = spawn(process.execPath, ['dist/bin.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', () => {});
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'capabilities-test', version: '1.0.0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  requests.forEach(send);

  const wanted = requests.map((r) => r.id);
  const found = new Map();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && found.size < wanted.length) {
    for (const line of out.split('\n')) {
      try {
        const msg = JSON.parse(line);
        if (wanted.includes(msg.id)) found.set(msg.id, msg);
      } catch { /* partial line */ }
    }
    if (found.size < wanted.length) await new Promise((r) => setTimeout(r, 40));
  }
  child.kill();
  assert.equal(found.size, wanted.length, `missing responses. stdout:\n${out}`);
  return found;
}

const RATIONALE = 'Automated check that the advertised capabilities match what the server actually registers.';

test('tools_count matches the tools actually registered', async () => {
  const found = await session([
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'getCapabilities', arguments: { rationale: RATIONALE } } },
  ]);
  const registered = found.get(2).result.tools.length;
  const advertised = JSON.parse(found.get(3).result.content[0].text).tools_count;
  // Hard-coded to 16 until 2026-08-14, and wrong the moment a tool was added.
  assert.equal(advertised, registered);
});

test('getKeyStatus is registered and needs no arguments', async () => {
  const found = await session([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const tool = found.get(2).result.tools.find((t) => t.name === 'getKeyStatus');
  assert.ok(tool, 'getKeyStatus is not registered');
  assert.deepEqual(tool.inputSchema.required ?? [], []);
});

test('the advertised limits carry a live source, because they change', async () => {
  const found = await session([
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'getCapabilities', arguments: { rationale: RATIONALE } } },
  ]);
  const { stats } = JSON.parse(found.get(2).result.content[0].text);

  assert.match(stats.limits_url, /^https:\/\/docs\.dexpaprika\.com\//);
  // /pricing is a 301 to /api/pricing; publish the destination, not the redirect.
  assert.equal(stats.pricing_url, 'https://dexpaprika.com/api/pricing');

  // The retired figures, which shipped in getCapabilities until 2026-08-14 even
  // though the README had already been corrected.
  assert.notEqual(stats.free_tier_credits_per_month, 200_000);
  assert.notEqual(stats.free_key_credits_per_month, 500_000);

  // Registering raises the monthly allowance AND the per-minute rate. The old
  // version of this test pinned free_tier_requests_per_minute to 30 with a
  // comment saying registering "raises the monthly allowance and nothing else",
  // and predicted that if that ever stopped being true the 429 copy would have
  // to change with it. It was never true: keyless has always been 15. So the
  // test was pinning the bug, and the 429 copy did have to change.
  assert.ok(stats.free_key_credits_per_month > stats.free_tier_credits_per_month);
  assert.equal(stats.free_tier_requests_per_minute, 15);
  assert.equal(stats.free_key_requests_per_minute, 30);
  assert.ok(
    stats.free_key_requests_per_minute > stats.free_tier_requests_per_minute,
    'a free key must buy real per-minute headroom, otherwise the 429 hint is false',
  );

  // Telling an agent a key doubles its limit is only useful with somewhere to
  // get one.
  assert.equal(stats.console_url, 'https://console.dexpaprika.com');
});
