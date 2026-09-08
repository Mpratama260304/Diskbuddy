import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import { load } from 'cheerio';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/proxy.js';
import { parseXml } from '../src/transform.js';

async function fixture(context, overrides = {}, handler) {
  const seen = [];
  let source;
  const origin = http.createServer(async (request, response) => {
    seen.push({ url: request.url, headers: request.headers, method: request.method });
    const pathname = new URL(request.url, source).pathname;
    if (handler && await handler(request, response, source)) return;
    if (pathname === '/robots.txt') {
      response.setHeader('content-type', 'text/plain');
      response.end(`User-agent: *\nDisallow: /admin\nSitemap: ${source}/sitemap_index.xml\nSitemap: ${source}/extra.xml\n`);
    } else if (pathname === '/sitemap_index.xml') {
      response.setHeader('content-type', 'application/xml');
      response.end(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${source}/posts.xml.gz</loc></sitemap></sitemapindex>`);
    } else if (pathname === '/posts.xml.gz') {
      response.setHeader('content-type', 'application/gzip');
      response.end(gzipSync(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${source}/article?x=1&amp;y=2</loc><lastmod>2026-09-01</lastmod></url></urlset>`));
    } else if (pathname === '/article') {
      response.writeHead(200, { 'content-type': 'text/html', etag: '"source"', 'last-modified': 'Tue, 01 Sep 2026 00:00:00 GMT',
        'content-encoding': 'gzip', 'content-security-policy': `default-src 'self' ${source};`,
        link: `<${source}/article>; rel="canonical"`, 'x-robots-tag': 'nofollow' });
      response.end(gzipSync(`<link rel="canonical" href="${source}/wrong"><h1>Article</h1><img src="${source}/image.png">`));
    } else if (pathname === '/old') {
      response.writeHead(301, { location: '/article' }); response.end();
    } else if (pathname === '/external') {
      response.writeHead(302, { location: 'https://external.example/' }); response.end();
    } else if (pathname === '/loop') {
      response.writeHead(301, { location: `${source}/loop` }); response.end();
    } else if (pathname === '/api' || pathname === '/submit') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ url: `${source}/article`, body: Buffer.concat(chunks).toString(),
        origin: request.headers.origin, referer: request.headers.referer, method: request.method }));
    } else if (pathname === '/image.png') {
      const range = request.headers.range;
      response.writeHead(range ? 206 : 200, { 'content-type': 'image/png', etag: '"binary"',
        ...(range ? { 'content-range': 'bytes 0-2/5' } : {}) });
      response.end(range ? Buffer.from([0, 1, 2]) : Buffer.from([0, 1, 2, 3, 255]));
    } else if (pathname === '/slow') {
      request.on('close', () => response.destroy());
    } else if (pathname === '/large') {
      response.setHeader('content-type', 'text/html'); response.end('x'.repeat(2048));
    } else if (pathname === '/error') {
      response.writeHead(503, { 'content-type': 'text/html' }); response.end('<h1>Unavailable</h1>');
    } else {
      response.writeHead(404, { 'content-type': 'text/html' }); response.end('<h1>Not found</h1>');
    }
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  source = `http://127.0.0.1:${origin.address().port}`;
  const logs = [];
  const config = loadConfig({ PUBLIC_URL: 'https://mirror.example', UPSTREAM_URL: source,
    TRUST_PROXY: 'true', INDEXABLE: 'true', ...overrides });
  const server = createProxyServer(config, { logger: { warn: (value) => logs.push(JSON.parse(value)) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await Promise.all([server, origin].map((instance) => new Promise((resolve) => {
      instance.close(resolve); instance.closeAllConnections();
    })));
  });
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const client = http.request(`${address}${path}`, { method: options.method || 'GET',
      headers: { host: 'mirror.example', 'x-forwarded-proto': 'https', ...options.headers } }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined) headers.append(name, entry);
        }
        resolve(new Response(options.method === 'HEAD' || [204, 304].includes(incoming.statusCode) ? null : Buffer.concat(chunks),
          { status: incoming.statusCode, headers }));
      });
    });
    client.on('error', reject);
    client.end(options.body);
  });
  return { request, source, seen, logs, address };
}

test('HTTP HTML rewrites gzip bodies and canonical headers, drops stale validators, supports HEAD', async (context) => {
  const { request, seen } = await fixture(context);
  const response = await request('/article?utm_source=test', { headers: { 'if-none-match': '"source"' } });
  assert.equal(response.status, 200);
  const document = load(await response.text());
  assert.equal(document('link[rel=canonical]').attr('href'), 'https://mirror.example/article');
  assert.equal(document('img').attr('src'), 'https://mirror.example/image.png');
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('last-modified'), null);
  assert.equal(response.headers.get('x-robots-tag'), 'nofollow');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'self' https://mirror.example;");
  assert.equal(seen[0].headers['if-none-match'], undefined);
  const head = await request('/article', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('etag'), null);
});

test('preserves 404/503, rewrites redirects without following, detects loops', async (context) => {
  const { request } = await fixture(context);
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/error')).status, 503);
  const redirect = await request('/old');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), 'https://mirror.example/article');
  assert.equal((await request('/external')).headers.get('location'), 'https://external.example/');
  assert.equal((await request('/loop')).status, 502);
});

test('serves a branded 404 page for missing HTML pages, passes upstream 404 through when disabled', async (context) => {
  const custom = await fixture(context);
  const response = await custom.request('/dadac', { headers: { accept: 'text/html' } });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  const document = load(await response.text());
  assert.equal(document('meta[name=robots]').attr('content'), 'noindex, follow');
  assert.match(document('.code').text(), /404/);
  assert.equal(document('a.button').attr('href'), 'https://mirror.example/');
  assert.match(document('.path').text(), /\/dadac/);

  const disabled = await fixture(context, { CUSTOM_404: 'false' });
  const original = await disabled.request('/dadac', { headers: { accept: 'text/html' } });
  assert.equal(original.status, 404);
  assert.match(await original.text(), /Not found/);
});

test('robots discovers multiple maps; fallback sitemap index links to nested gzip sitemaps', async (context) => {
  const { request } = await fixture(context);
  const robots = await (await request('/robots.txt')).text();
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Sitemap: https:\/\/mirror.example\/sitemap_index.xml/);
  assert.match(robots, /Sitemap: https:\/\/mirror.example\/extra.xml/);
  const fallback = await request('/sitemap.xml');
  assert.equal(fallback.status, 200);
  const index = parseXml(await fallback.text());
  assert.equal(index.documentElement.localName, 'sitemapindex');
  assert.equal(index.getElementsByTagName('loc').length, 2);
  assert.match(await (await request('/sitemap_index.xml')).text(), /https:\/\/mirror.example\/posts.xml.gz/);
  const compressed = await request('/posts.xml.gz');
  assert.equal(compressed.headers.get('content-type'), 'application/gzip');
  const xml = gunzipSync(Buffer.from(await compressed.arrayBuffer())).toString();
  assert.match(xml, /https:\/\/mirror.example\/article\?x=1&amp;y=2/);
  assert.match(xml, /2026-09-01/);
});

test('POST bodies, Origin and Referer are forwarded, JSON URLs rewritten without public caching', async (context) => {
  const { request, source, seen } = await fixture(context);
  const response = await request('/submit', { method: 'POST', body: 'message=hello', headers: {
    'content-type': 'application/x-www-form-urlencoded', origin: 'https://mirror.example',
    referer: 'https://mirror.example/form', cookie: 'session=test', 'x-forwarded-host': 'evil.example',
  } });
  const json = await response.json();
  assert.equal(json.body, 'message=hello');
  assert.equal(json.method, 'POST');
  assert.equal(json.url, 'https://mirror.example/article');
  assert.equal(seen.at(-1).headers.origin, source);
  assert.equal(seen.at(-1).headers.referer, `${source}/form`);
  assert.equal(seen.at(-1).headers['x-forwarded-host'], undefined);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('binary bytes, range responses and validators are preserved', async (context) => {
  const { request } = await fixture(context);
  const response = await request('/image.png');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 1, 2, 3, 255]);
  assert.equal(response.headers.get('etag'), '"binary"');
  const range = await request('/image.png', { headers: { range: 'bytes=0-2' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 0-2/5');
  assert.deepEqual([...new Uint8Array(await range.arrayBuffer())], [0, 1, 2]);
});

test('canonical host is fixed by config, health bypasses redirect, staging is noindex', async (context) => {
  const { request, address } = await fixture(context, { INDEXABLE: 'false' });
  const wrongHost = await fetch(`${address}/article?x=1`, { redirect: 'manual', headers: { host: 'evil.example' } });
  assert.equal(wrongHost.status, 308);
  assert.equal(wrongHost.headers.get('location'), 'https://mirror.example/article?x=1');
  const health = await fetch(`${address}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.match((await request('/article')).headers.get('x-robots-tag'), /^noindex/);
});

test('timeouts and transform/request size limits return explicit non-indexable errors', async (context) => {
  const { request } = await fixture(context, { UPSTREAM_TIMEOUT_MS: '100', MAX_TRANSFORM_BYTES: '1024', MAX_REQUEST_BYTES: '10' });
  const timeout = await request('/slow');
  assert.equal(timeout.status, 504);
  assert.equal(timeout.headers.get('x-robots-tag'), 'noindex');
  assert.equal((await request('/large')).status, 502);
  assert.equal((await request('/submit', { method: 'POST', body: 'long body exceeding limit' })).status, 413);
});

test('missing source sitemaps stay 404, never fabricate an incomplete homepage-only sitemap', async (context) => {
  const { request } = await fixture(context, {}, (request, response) => {
    if (/sitemap|robots/.test(request.url)) { response.writeHead(404); response.end('Missing'); return true; }
    return false;
  });
  assert.equal((await request('/sitemap.xml')).status, 404);
  assert.doesNotMatch(await (await request('/robots.txt')).text(), /Sitemap:/);
});

test('source cookie domains become host-only without losing security attributes or multiple cookies', async (context) => {
  const { request } = await fixture(context, {}, (request, response) => {
    if (request.url !== '/cookies') return false;
    response.setHeader('set-cookie', [
      'session=example; Domain=.127.0.0.1; Path=/; Secure; HttpOnly; SameSite=Lax',
      'preference=dark; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT',
    ]);
    response.end('ok');
    return true;
  });
  const response = await request('/cookies');
  assert.deepEqual(response.headers.getSetCookie(), [
    'session=example; Path=/; Secure; HttpOnly; SameSite=Lax',
    'preference=dark; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT',
  ]);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('explicit fallback pages yield a verified sitemap, excluding noindex, blocked, missing and noncanonical pages', async (context) => {
  const { request, seen } = await fixture(context, {
    SITEMAP_PAGE_PATHS: '/article,/missing,/noindex,/header-noindex,/private,/duplicate',
  }, (request, response, source) => {
    if (/sitemap/.test(request.url)) {
      response.writeHead(404, { 'content-disposition': 'inline; filename="404"', 'x-robots-tag': 'noindex' });
      response.end('Missing'); return true;
    }
    if (request.url === '/robots.txt') {
      response.end('User-agent: *\nDisallow: /private\n'); return true;
    }
    if (['/noindex', '/header-noindex', '/duplicate'].includes(request.url)) {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/header-noindex') response.setHeader('x-robots-tag', 'noindex');
      response.end(request.url === '/duplicate' ? `<link rel="canonical" href="${source}/article">`
        : '<meta name="robots" content="noindex">');
      return true;
    }
    return false;
  });
  const response = await request('/sitemap.xml');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), null);
  assert.equal(response.headers.get('x-robots-tag'), null);
  const document = parseXml(await response.text());
  assert.equal(document.documentElement.localName, 'urlset');
  assert.deepEqual(Array.from(document.getElementsByTagName('loc')).map((element) => element.textContent), ['https://mirror.example/article']);
  assert.equal(seen.some((entry) => entry.url === '/private'), false);
  assert.match(await (await request('/robots.txt')).text(), /Sitemap: https:\/\/mirror.example\/sitemap.xml/);
});

test('robots discovery follows an internal redirect to a compressed sitemap', async (context) => {
  const { request } = await fixture(context, {}, (request, response) => {
    if (request.url === '/robots.txt') { response.writeHead(404); response.end(); return true; }
    if (request.url === '/sitemap.xml') { response.writeHead(302, { location: '/posts.xml.gz' }); response.end(); return true; }
    return false;
  });
  assert.match(await (await request('/robots.txt')).text(), /Sitemap: https:\/\/mirror.example\/posts.xml.gz/);
});

test('fallback discovery does not assume robots is absent on source failure or access denial', async (context) => {
  const { request, seen, logs } = await fixture(context, { SITEMAP_PAGE_PATHS: '/article' }, (request, response) => {
    if (request.url === '/robots.txt') { response.writeHead(503); response.end(); return true; }
    return false;
  });
  assert.equal((await request('/sitemap.xml')).status, 404);
  assert.equal(seen.some((entry) => entry.url === '/article'), false);
  assert.equal(logs.some((entry) => entry.event === 'sitemap_discovery_failed'), true);
});