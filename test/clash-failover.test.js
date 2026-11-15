const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ClashFailover,
  isInfoProxyName,
  parseClashSecret,
  resolvePrimaryGroup,
} = require('../src/clash-failover');

test('parseClashSecret supports quoted and plain YAML values', () => {
  assert.equal(parseClashSecret('secret: "abc123"\n'), 'abc123');
  assert.equal(parseClashSecret("secret: 'abc123'\n"), 'abc123');
  assert.equal(parseClashSecret('secret: abc123 # comment\n'), 'abc123');
});

test('switches to an untried healthy candidate and avoids oscillation', async (t) => {
  let selected = 'Fallback';
  const switches = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-secret');
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/proxies/E-IX') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ type: 'Selector', now: selected, all: ['Fallback', 'Auto'] }));
      return;
    }

    if (req.method === 'GET' && /^\/proxies\/(Auto|Fallback)\/delay$/.test(url.pathname)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ delay: url.pathname.includes('Auto') ? 123 : 234 }));
      return;
    }

    if (req.method === 'PUT' && url.pathname === '/proxies/E-IX') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        selected = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        switches.push(selected);
        res.statusCode = 204;
        res.end();
      });
      return;
    }

    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-failover-'));
  const secretFile = path.join(tempDir, 'runtime.yaml');
  fs.writeFileSync(secretFile, 'secret: test-secret\n');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const failover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    secretFile,
    group: 'E-IX',
    candidates: ['Auto', 'Fallback'],
    timeoutMs: 1000,
    logger: { warn() {}, error() {} },
  });

  const first = await failover.failover('NoConnection');
  assert.equal(first.switched, true);
  assert.equal(first.from, 'Fallback');
  assert.equal(first.to, 'Auto');
  assert.deepEqual(switches, ['Auto']);

  const second = await failover.failover('login-timeout-reset');
  assert.equal(second.switched, false);
  assert.equal(second.error, '没有未尝试的候选节点');
  assert.deepEqual(switches, ['Auto']);

  failover.resetCycle();
  const third = await failover.failover('new-outage');
  assert.equal(third.switched, true);
  assert.equal(third.to, 'Fallback');
  assert.deepEqual(switches, ['Auto', 'Fallback']);

  const available = await failover.ensureAvailable('recovery-probe');
  assert.equal(available.available, true);
  assert.equal(available.switched, false);
  assert.equal(available.current, 'Fallback');
  assert.equal(available.delay, 234);
  assert.deepEqual(switches, ['Auto', 'Fallback']);
});

test('recovery probe switches only after the current selection fails', async (t) => {
  let selected = 'Auto';
  const switches = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/proxies/E-IX') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ type: 'Selector', now: selected, all: ['Auto', 'Fallback'] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/proxies/Auto/delay') {
      res.statusCode = 504;
      res.end('timeout');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/proxies/Fallback/delay') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ delay: 88 }));
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/proxies/E-IX') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        selected = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        switches.push(selected);
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const failover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    group: 'E-IX',
    candidates: ['Auto', 'Fallback'],
    timeoutMs: 1000,
    logger: { warn() {}, error() {} },
  });

  const result = await failover.ensureAvailable('recovery-probe');
  assert.equal(result.available, true);
  assert.equal(result.switched, true);
  assert.equal(result.from, 'Auto');
  assert.equal(result.to, 'Fallback');
  assert.equal(result.delay, 88);
  assert.deepEqual(switches, ['Fallback']);
});

test('wildcard candidates discover nodes from the selected Clash group', async (t) => {
  let selected = 'Dead node';
  const switches = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/proxies/%F0%9F%A7%B1%20GFW') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ type: 'Selector', now: selected, all: ['Dead node', 'Healthy node'] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/proxies/Dead%20node/delay') {
      res.statusCode = 504;
      res.end('timeout');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/proxies/Healthy%20node/delay') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ delay: 77 }));
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/proxies/%F0%9F%A7%B1%20GFW') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        selected = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        switches.push(selected);
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const failover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    group: '🧱 GFW',
    candidates: ['*'],
    timeoutMs: 1000,
    logger: { warn() {}, error() {} },
  });

  const result = await failover.ensureAvailable('dynamic-recovery');
  assert.equal(result.available, true);
  assert.equal(result.switched, true);
  assert.equal(result.to, 'Healthy node');
  assert.deepEqual(switches, ['Healthy node']);
  assert.equal(failover.snapshot().dynamicCandidates, true);
});

test('recovery probe skips recently failed zombie nodes across rounds and recycles cleanly when exhausted', async (t) => {
  let selected = 'HK 01';
  let currentNow = 1000;
  const switches = [];
  const probed = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/proxies') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          proxies: {
            'E-IX': { type: 'Selector', now: selected, all: ['HK 01', 'HK 02', 'JP 05'] },
            'HK 01': { type: 'AnyTLS' },
            'HK 02': { type: 'AnyTLS' },
            'JP 05': { type: 'AnyTLS' },
          },
        })
      );
      return;
    }
    if (req.method === 'GET' && /^\/proxies\/(HK%2001|HK%2002|JP%2005)\/delay$/.test(url.pathname)) {
      const node = decodeURIComponent(url.pathname.split('/')[2]);
      probed.push(node);
      res.setHeader('Content-Type', 'application/json');
      // All 3 zombie/healthy nodes return HTTP 200 on Web API
      res.end(JSON.stringify({ delay: 120 }));
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/proxies/E-IX') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        selected = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        switches.push(selected);
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const failover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    group: 'E-IX',
    candidates: ['*'],
    timeoutMs: 1000,
    failedCooldownMs: 60_000,
    now: () => currentNow,
    logger: { warn() {}, error() {} },
  });

  // Initial login failure on HK 01 (before any ensureAvailable ran, currentSelection is still null)
  failover.recordLoginFailure('login-timeout-reset');
  const round1 = await failover.ensureAvailable('recovery-1');
  assert.equal(round1.available, true);
  assert.equal(round1.switched, true);
  assert.equal(round1.from, 'HK 01');
  assert.equal(round1.to, 'HK 02');
  assert.equal(probed.includes('HK 01'), false);

  // HK 02 also fails Steam TLS handshake -> must not bounce back to HK 01 or stay on HK 02
  currentNow += 1000;
  failover.recordLoginFailure('Client network socket disconnected before secure TLS connection was established');
  const round2 = await failover.ensureAvailable('recovery-2');
  assert.equal(round2.available, true);
  assert.equal(round2.switched, true);
  assert.equal(round2.from, 'HK 02');
  assert.equal(round2.to, 'JP 05');

  // JP 05 also fails -> pool is now 100% exhausted; must recycle oldest failed (HK 01) and NOT stay on JP 05
  currentNow += 1000;
  failover.recordLoginFailure('login-timeout-reset');
  const round3 = await failover.ensureAvailable('recovery-3');
  assert.equal(round3.available, true);
  assert.equal(round3.switched, true);
  assert.equal(round3.from, 'JP 05');
  assert.equal(round3.to, 'HK 01');
  assert.deepEqual(switches, ['HK 02', 'JP 05', 'HK 01']);

  // On successful login, resetCycle() clears all failed selections
  failover.resetCycle();
  assert.equal(failover.snapshot().failedSelections.length, 0);
  const steady = await failover.ensureAvailable('recovery-after-success');
  assert.equal(steady.available, true);
  assert.equal(steady.switched, false);
  assert.equal(steady.current, 'HK 01');
});

test('wildcard candidates exclude nested proxy groups and virtual nodes while explicit config still allows them', async (t) => {
  let selected = 'Auto';
  const probed = [];
  const switches = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/proxies') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          proxies: {
            'E-IX': {
              type: 'Selector',
              now: selected,
              all: ['Fallback', 'Auto', 'DIRECT', 'REJECT', 'SubGroup', 'JP 05'],
            },
            Fallback: { type: 'Fallback', now: 'HK 01', all: ['HK 01'] },
            Auto: { type: 'URLTest', now: 'SG 03', all: ['SG 03'] },
            DIRECT: { type: 'Direct' },
            REJECT: { type: 'Reject' },
            SubGroup: { type: 'Selector', now: 'HK 01', all: ['HK 01'] },
            'JP 05': { type: 'AnyTLS' },
          },
        })
      );
      return;
    }
    if (req.method === 'GET' && /^\/proxies\/[^/]+\/delay$/.test(url.pathname)) {
      const node = decodeURIComponent(url.pathname.split('/')[2]);
      probed.push(node);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ delay: 65 }));
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/proxies/E-IX') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        selected = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        switches.push(selected);
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const dynamicFailover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    group: 'E-IX',
    candidates: ['*'],
    timeoutMs: 1000,
    logger: { warn() {}, error() {} },
  });

  // Even though current selection is 'Auto' and would return 200, wildcard mode migrates away to real leaf 'JP 05'
  const res1 = await dynamicFailover.ensureAvailable('migrate-off-auto');
  assert.equal(res1.available, true);
  assert.equal(res1.switched, true);
  assert.equal(res1.from, 'Auto');
  assert.equal(res1.to, 'JP 05');
  assert.deepEqual(probed, ['JP 05']);
  assert.deepEqual(switches, ['JP 05']);

  // Explicit candidate configuration still allows non-leaf groups when deliberately specified
  selected = 'Fallback';
  const explicitFailover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    group: 'E-IX',
    candidates: ['Auto', 'Fallback'],
    timeoutMs: 1000,
    logger: { warn() {}, error() {} },
  });
  const res2 = await explicitFailover.failover('explicit-switch');
  assert.equal(res2.switched, true);
  assert.equal(res2.to, 'Auto');
});

test('aligns drifted upstream Steam selector group back to failover group and avoids false blacklisting', async (t) => {
  let eixNow = 'JP 05';
  let steamNow = 'HK 06';
  const steamSwitches = [];
  const eixSwitches = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/proxies') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          proxies: {
            Steam: { type: 'Selector', now: steamNow, all: ['E-IX', 'DIRECT', 'HK 06', 'JP 05'] },
            'E-IX': { type: 'Selector', now: eixNow, all: ['Auto', 'HK 06', 'JP 05'] },
            Auto: { type: 'URLTest', all: ['HK 06', 'JP 05'] },
            'HK 06': { type: 'AnyTLS' },
            'JP 05': { type: 'AnyTLS' },
          },
        })
      );
      return;
    }
    if (req.method === 'GET' && /^\/proxies\/[^/]+\/delay$/.test(url.pathname)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ delay: 95 }));
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/proxies/Steam') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        steamNow = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        steamSwitches.push(steamNow);
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/proxies/E-IX') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        eixNow = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        eixSwitches.push(eixNow);
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const failover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    group: 'E-IX',
    upstreamGroups: ['Steam'],
    candidates: ['*'],
    timeoutMs: 1000,
    logger: { warn() {}, error() {} },
  });

  // First ensureUpstreamAligned aligns Steam on startup
  const startupAligned = await failover.ensureUpstreamAligned();
  assert.deepEqual(startupAligned, [{ group: 'Steam', from: 'HK 06', to: 'E-IX' }]);
  assert.equal(steamNow, 'E-IX');

  // Simulate Steam drifting back to HK 06 while currentSelection was JP 05, causing login failure
  await failover.ensureAvailable('warm-up');
  steamNow = 'HK 06';
  failover.recordLoginFailure('login-timeout-reset');

  // Recovery probe aligns Steam -> E-IX, clears speculative failure on JP 05, and keeps healthy JP 05
  const recovery = await failover.ensureAvailable('recovery-with-drift');
  assert.equal(recovery.available, true);
  assert.equal(recovery.switched, false);
  assert.equal(recovery.current, 'JP 05');
  assert.deepEqual(recovery.alignedUpstreams, [{ group: 'Steam', from: 'HK 06', to: 'E-IX' }]);
  assert.equal(failover.snapshot().failedSelections.length, 0);

  // Also test failover() aligns drifted Steam
  steamNow = 'HK 06';
  const fo = await failover.failover('manual-failover');
  assert.equal(fo.switched, true);
  assert.equal(fo.to, 'HK 06');
  assert.deepEqual(fo.alignedUpstreams, [{ group: 'Steam', from: 'HK 06', to: 'E-IX' }]);
  assert.deepEqual(steamSwitches, ['E-IX', 'E-IX', 'E-IX']);
  assert.deepEqual(eixSwitches, ['HK 06']);
});

test('CM 443 probe filters out WebAPI-only zombie nodes and degrades safely when all CM URLs fail', async (t) => {
  let selected = 'HK 01';
  let cmReachableOnJp05 = true;
  const switches = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/proxies') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          proxies: {
            'E-IX': { type: 'Selector', now: selected, all: ['HK 01', 'HK 02', 'JP 05'] },
            'HK 01': { type: 'AnyTLS' },
            'HK 02': { type: 'AnyTLS' },
            'JP 05': { type: 'AnyTLS' },
          },
        })
      );
      return;
    }
    if (req.method === 'GET' && /^\/proxies\/[^/]+\/delay$/.test(url.pathname)) {
      const node = decodeURIComponent(url.pathname.split('/')[2]);
      const probeUrl = url.searchParams.get('url') || '';
      const expected = url.searchParams.get('expected') || '';
      res.setHeader('Content-Type', 'application/json');

      if (probeUrl.includes('api.steampowered.com')) {
        res.end(JSON.stringify({ delay: 150 }));
        return;
      }

      if (probeUrl.includes('/cmsocket/')) {
        assert.equal(expected, '200-499');
        if (node === 'JP 05' && cmReachableOnJp05) {
          res.end(JSON.stringify({ delay: 220 }));
          return;
        }
        res.statusCode = 504;
        res.end('timeout');
        return;
      }
    }
    if (req.method === 'PUT' && url.pathname === '/proxies/E-IX') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        selected = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        switches.push(selected);
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const failover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    group: 'E-IX',
    candidates: ['*'],
    cmTestUrls: ['https://cmp1-tyo3.steamserver.net:443/cmsocket/'],
    timeoutMs: 1000,
    logger: { warn() {}, error() {} },
  });

  assert.equal(
    failover.recordCmEndpoint('cmp2-tyo3.steamserver.net:443'),
    'https://cmp2-tyo3.steamserver.net/cmsocket/'
  );
  assert.equal(failover.recordCmEndpoint('cmp2-lax1.steamserver.net:27018'), null);

  // HK 01 & HK 02 pass Web API but timeout on /cmsocket/; JP 05 passes both
  const first = await failover.ensureAvailable('cm-probe-prefer-jp');
  assert.equal(first.available, true);
  assert.equal(first.switched, true);
  assert.equal(first.to, 'JP 05');
  assert.equal(first.cmVerified, true);
  assert.deepEqual(switches, ['JP 05']);

  // Now simulate all static/dynamic CM hostnames becoming unreachable while HK 02 is unfailed Web API fallback
  cmReachableOnJp05 = false;
  failover.recordLoginFailure('login-timeout-reset');
  const degraded = await failover.ensureAvailable('cm-probe-fallback');
  assert.equal(degraded.available, true);
  assert.equal(degraded.switched, true);
  assert.equal(degraded.to, 'HK 01');
  assert.equal(degraded.cmVerified, false);
  assert.equal(degraded.cmFallback, true);
});

test('failed node cooldown expires and single-node pool falls back to current when needed', async (t) => {
  let currentNow = 1000;
  let selected = 'OnlyNode';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/proxies') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          proxies: {
            'E-IX': { type: 'Selector', now: selected, all: ['Auto', 'OnlyNode'] },
            Auto: { type: 'URLTest', all: ['OnlyNode'] },
            OnlyNode: { type: 'AnyTLS' },
          },
        })
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/proxies/OnlyNode/delay') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ delay: 90 }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const failover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    group: 'E-IX',
    candidates: ['*'],
    timeoutMs: 1000,
    failedCooldownMs: 10_000,
    now: () => currentNow,
    logger: { warn() {}, error() {} },
  });

  failover.recordLoginFailure('login-timeout-reset');
  const singleRes = await failover.ensureAvailable('single-node-fallback');
  assert.equal(singleRes.available, true);
  assert.equal(singleRes.switched, false);
  assert.equal(singleRes.current, 'OnlyNode');

  // Record again and advance past cooldownMs
  failover.recordLoginFailure('login-timeout-reset');
  currentNow += 15_000;
  const expiredRes = await failover.ensureAvailable('after-cooldown');
  assert.equal(expiredRes.available, true);
  assert.equal(expiredRes.switched, false);
  assert.equal(failover.snapshot().failedSelections.length, 0);
});

test('isInfoProxyName filters informational fake nodes while preserving real proxy nodes', () => {
  const fakeNodes = [
    '剩余流量：146.48 GB',
    '距离下次重置剩余：27 天',
    '套餐到期：2027-05-12',
    'youtunice.com',
    'Website: wpku.org',
    'Telegram: t.me/wallesspku',
    'Balance: 20.00 GiB',
    '2026-11-01 00:00:02 (UTC+8)',
    '官网：example.org',
    '公告：请更新订阅',
  ];
  for (const name of fakeNodes) {
    assert.equal(isInfoProxyName(name), true, `expected info node to be filtered: ${name}`);
  }

  const realNodes = [
    '高速隧道1x-新加坡-4',
    '专线2.5x-香港-1',
    '🇺🇸 US-G1 (0.6x)',
    '🇭🇰 Hong Kong 06',
    '[youtunice.com] 香港 01',
    'HK.BGP',
  ];
  for (const name of realNodes) {
    assert.equal(isInfoProxyName(name), false, `expected real node to be preserved: ${name}`);
  }
});

test('auto group resolves 悠兔 style subscription, filters fake nodes, and switches cleanly', async (t) => {
  let selected = '剩余流量：146.48 GB';
  const probed = [];
  const switches = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/proxies') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          proxies: {
            GLOBAL: { type: 'Selector', now: 'DIRECT', all: ['DIRECT', 'REJECT', '悠兔', '自动选择', '故障转移'] },
            '悠兔': {
              type: 'Selector',
              now: selected,
              all: [
                '自动选择',
                '故障转移',
                'DIRECT',
                '剩余流量：146.48 GB',
                '距离下次重置剩余：27 天',
                '套餐到期：2027-05-12',
                'youtunice.com',
                '专线2.5x-香港-1',
                '高速隧道1x-新加坡-4',
              ],
            },
            '自动选择': { type: 'URLTest', now: '专线2.5x-香港-1', all: ['专线2.5x-香港-1', '高速隧道1x-新加坡-4'] },
            '故障转移': { type: 'Fallback', now: '专线2.5x-香港-1', all: ['专线2.5x-香港-1', '高速隧道1x-新加坡-4'] },
            DIRECT: { type: 'Direct' },
            '剩余流量：146.48 GB': { type: 'Shadowsocks' },
            '距离下次重置剩余：27 天': { type: 'Shadowsocks' },
            '套餐到期：2027-05-12': { type: 'Shadowsocks' },
            'youtunice.com': { type: 'Shadowsocks' },
            '专线2.5x-香港-1': { type: 'Shadowsocks' },
            '高速隧道1x-新加坡-4': { type: 'Shadowsocks' },
          },
        })
      );
      return;
    }
    if (req.method === 'GET' && /^\/proxies\/[^/]+\/delay$/.test(url.pathname)) {
      const node = decodeURIComponent(url.pathname.split('/')[2]);
      probed.push(node);
      if (node === '专线2.5x-香港-1') {
        res.statusCode = 504;
        res.end('timeout');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ delay: 112 }));
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/proxies/%E6%82%A0%E5%85%94') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        selected = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        switches.push(selected);
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const failover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    group: 'auto',
    upstreamGroups: ['Steam', 'Final'],
    candidates: ['*'],
    timeoutMs: 1000,
    logger: { warn() {}, error() {} },
  });

  const aligned = await failover.ensureUpstreamAligned();
  assert.deepEqual(aligned, []);

  const initialSnap = failover.snapshot();
  assert.equal(initialSnap.group, 'auto');
  assert.equal(initialSnap.resolvedGroup, '悠兔');
  assert.equal(initialSnap.resolvedGroupSource, 'auto');
  assert.equal(initialSnap.currentSelection, '剩余流量：146.48 GB');
  assert.equal(initialSnap.eligibleCandidateCount, 2);
  assert.deepEqual(initialSnap.filteredInfoNodes, [
    '剩余流量：146.48 GB',
    '距离下次重置剩余：27 天',
    '套餐到期：2027-05-12',
    'youtunice.com',
  ]);

  const recovered = await failover.ensureAvailable('migrate-off-info-node');
  assert.equal(recovered.available, true);
  assert.equal(recovered.switched, true);
  assert.equal(recovered.group, '悠兔');
  assert.equal(recovered.from, '剩余流量：146.48 GB');
  assert.equal(recovered.to, '高速隧道1x-新加坡-4');
  assert.deepEqual(probed, ['专线2.5x-香港-1', '高速隧道1x-新加坡-4']);
  assert.deepEqual(switches, ['高速隧道1x-新加坡-4']);

  const fo = await failover.failover('node-down');
  assert.equal(fo.switched, false);
  assert.equal(fo.group, '悠兔');
  assert.equal(probed.some((name) => isInfoProxyName(name)), false);
});

test('configured missing group falls back cleanly and resets cycle across live subscription switch', async (t) => {
  let profile = 'eix';
  let eixNow = 'HK 01';
  let youtuNow = '新加坡-1';
  const warnings = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/proxies') {
      res.setHeader('Content-Type', 'application/json');
      if (profile === 'eix') {
        res.end(
          JSON.stringify({
            proxies: {
              GLOBAL: { type: 'Selector', now: 'E-IX', all: ['E-IX', 'HK 01', 'JP 02'] },
              'E-IX': { type: 'Selector', now: eixNow, all: ['HK 01', 'JP 02'] },
              'HK 01': { type: 'AnyTLS' },
              'JP 02': { type: 'AnyTLS' },
            },
          })
        );
      } else {
        res.end(
          JSON.stringify({
            proxies: {
              GLOBAL: { type: 'Selector', now: '悠兔', all: ['悠兔', '新加坡-1', '香港-2'] },
              '悠兔': { type: 'Selector', now: youtuNow, all: ['剩余流量：100 GB', '新加坡-1', '香港-2'] },
              '剩余流量：100 GB': { type: 'Shadowsocks' },
              '新加坡-1': { type: 'Shadowsocks' },
              '香港-2': { type: 'Shadowsocks' },
            },
          })
        );
      }
      return;
    }
    if (req.method === 'GET' && /^\/proxies\/[^/]+\/delay$/.test(url.pathname)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ delay: 80 }));
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/proxies/E-IX') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        eixNow = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/proxies/%E6%82%A0%E5%85%94') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        youtuNow = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const failover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    group: 'E-IX',
    candidates: ['*'],
    timeoutMs: 1000,
    logger: { warn: (msg) => warnings.push(msg), error() {} },
  });

  await failover.ensureUpstreamAligned();
  assert.equal(failover.snapshot().resolvedGroup, 'E-IX');
  assert.equal(failover.snapshot().resolvedGroupSource, 'configured');

  // Record a failure on E-IX before switching subscription
  failover.recordLoginFailure('login-timeout-reset', 'HK 01');
  const firstSwitch = await failover.ensureAvailable('pre-sub-switch');
  assert.equal(firstSwitch.to, 'JP 02');
  assert.equal(failover.snapshot().failedSelections.length, 1);

  // Live switch subscription from E-IX to 悠兔 while group config is still E-IX
  profile = 'youtu';
  const fallbackRes = await failover.failover('post-sub-switch');
  assert.equal(fallbackRes.switched, true);
  assert.equal(fallbackRes.group, '悠兔');
  assert.equal(fallbackRes.from, '新加坡-1');
  assert.equal(fallbackRes.to, '香港-2');

  const snap = failover.snapshot();
  assert.equal(snap.resolvedGroup, '悠兔');
  assert.equal(snap.resolvedGroupSource, 'fallback');
  assert.equal(snap.failedSelections.length, 0);
  assert.equal(snap.eligibleCandidateCount, 2);
  assert.deepEqual(snap.filteredInfoNodes, ['剩余流量：100 GB']);
  assert.ok(warnings.some((msg) => msg.includes('自动回退到当前订阅主策略组: 悠兔')));
});

test('resolvePrimaryGroup and upstream alignment handle E-IX and GFW multi-selector topologies', async (t) => {
  // 1. Direct resolvePrimaryGroup on 🧱 GFW topology (Match -> DIRECT, Info + Accel + GFW)
  const gfwProxies = {
    GLOBAL: { type: 'Selector', all: ['DIRECT', '🧱 GFW', '🔔 Info', '🚀 Accel.'] },
    '🔔 Info': {
      type: 'Selector',
      all: ['Website: wpku.org', 'Telegram: t.me/wallesspku', 'Balance: 20.00 GiB', '2026-11-01 00:00:02 (UTC+8)'],
    },
    '🚀 Accel.': { type: 'Selector', all: ['DIRECT', '🧱 GFW'] },
    '🧱 GFW': { type: 'Selector', all: ['🇺🇸 US-G1 (0.6x)', '🇯🇵 JP-Z1 (0.8x)'] },
    'Website: wpku.org': { type: 'Shadowsocks' },
    'Telegram: t.me/wallesspku': { type: 'Shadowsocks' },
    'Balance: 20.00 GiB': { type: 'Shadowsocks' },
    '2026-11-01 00:00:02 (UTC+8)': { type: 'Shadowsocks' },
    '🇺🇸 US-G1 (0.6x)': { type: 'Shadowsocks' },
    '🇯🇵 JP-Z1 (0.8x)': { type: 'Shadowsocks' },
  };
  const gfwRules = [
    { type: 'DomainSuffix', payload: 'steampowered.com', proxy: '🧱 GFW' },
    { type: 'Match', payload: '', proxy: 'DIRECT' },
  ];
  assert.equal(resolvePrimaryGroup(gfwProxies, gfwRules), '🧱 GFW');

  // 2. E-IX topology (Match -> Final delegating to E-IX, Steam + Final + AI selectors)
  let eixNow = '🇭🇰 Hong Kong 06';
  let steamNow = '🇭🇰 Hong Kong 06';
  let finalNow = 'Auto';
  const upstreamSwitches = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/proxies') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          proxies: {
            GLOBAL: { type: 'Selector', all: ['Final', 'E-IX', 'Steam', 'AI'] },
            'E-IX': { type: 'Selector', now: eixNow, all: ['Fallback', 'Auto', '🇭🇰 Hong Kong 06', '🇯🇵 Japan 01'] },
            Steam: { type: 'Selector', now: steamNow, all: ['E-IX', 'Fallback', 'Auto', 'DIRECT', '🇭🇰 Hong Kong 06', '🇯🇵 Japan 01'] },
            AI: { type: 'Selector', now: 'E-IX', all: ['E-IX', 'Fallback', 'Auto', '🇭🇰 Hong Kong 06', '🇯🇵 Japan 01'] },
            Final: { type: 'Selector', now: finalNow, all: ['E-IX', 'Fallback', 'Auto', 'DIRECT', '🇭🇰 Hong Kong 06', '🇯🇵 Japan 01'] },
            Auto: { type: 'URLTest', all: ['🇭🇰 Hong Kong 06', '🇯🇵 Japan 01'] },
            Fallback: { type: 'Fallback', all: ['🇭🇰 Hong Kong 06', '🇯🇵 Japan 01'] },
            '🇭🇰 Hong Kong 06': { type: 'AnyTLS' },
            '🇯🇵 Japan 01': { type: 'AnyTLS' },
          },
        })
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/rules') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          rules: [
            { type: 'DomainSuffix', payload: 'steampowered.com', proxy: 'Steam' },
            { type: 'Match', payload: '', proxy: 'Final' },
          ],
        })
      );
      return;
    }
    if (req.method === 'PUT' && /^\/proxies\/(Steam|Final)$/.test(url.pathname)) {
      const targetGroup = decodeURIComponent(url.pathname.split('/')[2]);
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const name = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        if (targetGroup === 'Steam') steamNow = name;
        if (targetGroup === 'Final') finalNow = name;
        upstreamSwitches.push([targetGroup, name]);
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const failover = new ClashFailover({
    enabled: true,
    controllerUrl: `http://127.0.0.1:${server.address().port}`,
    group: 'auto',
    upstreamGroups: ['Steam', 'Final'],
    candidates: ['*'],
    timeoutMs: 1000,
    logger: { warn() {}, error() {} },
  });

  const aligned = await failover.ensureUpstreamAligned();
  assert.equal(failover.snapshot().resolvedGroup, 'E-IX');
  assert.deepEqual(aligned, [
    { group: 'Steam', from: '🇭🇰 Hong Kong 06', to: 'E-IX' },
    { group: 'Final', from: 'Auto', to: 'E-IX' },
  ]);
  assert.deepEqual(upstreamSwitches, [
    ['Steam', 'E-IX'],
    ['Final', 'E-IX'],
  ]);
});
