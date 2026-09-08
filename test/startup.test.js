import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
  });
}

async function verifyStartup(context, publicUrl) {
  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<h1>Ready</h1>');
  });
  upstream.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => {
    upstream.close(resolve);
    upstream.closeAllConnections();
  }));
  await once(upstream, 'listening');

  const railwayDomain = 'diskbuddy-mirror-production.up.railway.app';
  const domain = publicUrl ? new URL(publicUrl).host : railwayDomain;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {
    env: {
      RAILWAY_PUBLIC_DOMAIN: railwayDomain,
      ...(publicUrl ? { PUBLIC_URL: publicUrl } : {}),
      PORT: '0',
      UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  const listening = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server exited before startup (${code}): ${stderr}`)));
    lines.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        if (event.event === 'listening') resolve(event);
      } catch { return; }
    });
  });
  const address = `http://127.0.0.1:${listening.port}`;
  assert.equal(listening.publicUrl, `https://${domain}`);
  const health = await get(`${address}/healthz`, { host: 'healthcheck.railway.app' });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
  assert.equal(upstreamRequests, 0);

  const page = await get(`${address}/`, { host: domain, 'x-forwarded-proto': 'https' });
  assert.equal(page.status, 200);
  assert.equal(page.headers.location, undefined);
  assert.ok(page.body.includes(`href="https://${domain}/"`));
  assert.equal(upstreamRequests, 1);
  if (publicUrl) {
    for (const host of [railwayDomain, 'www.diskbuddy.net']) {
      const redirect = await get(`${address}/article?page=2`, { host, 'x-forwarded-proto': 'https' });
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.location, `${publicUrl}/article?page=2`);
    }
    assert.equal(upstreamRequests, 1);
  }
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
}

test('Railway startup serves health before host enforcement and HTTPS traffic without a redirect loop', { timeout: 10000 }, async (context) => {
  await verifyStartup(context);
});

test('diskbuddy.net serves normally and Railway/www hosts redirect to the custom domain', { timeout: 10000 }, async (context) => {
  await verifyStartup(context, 'https://diskbuddy.net');
});