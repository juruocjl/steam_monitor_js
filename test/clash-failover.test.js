const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ClashFailover, parseClashSecret } = require('../src/clash-failover');

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
