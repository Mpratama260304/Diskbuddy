import http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { load } from 'cheerio';
import robotsParser from 'robots-parser';
import { rewriteHtml, rewriteXml, parseXml, rewriteRobots, sitemapDeclarations,
  buildSitemapIndex, buildUrlset, canonicalUrl, rewriteLinkHeader, rewriteRefresh, notFoundPage } from './transform.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);
const binaryPath = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|pdf|zip|7z|wasm|bin)$/i;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

class ProxyError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function upstreamUrl(value, config) {
  const source = new URL(value, config.mapper.upstream);
  const target = new URL(config.mapper.upstream);
  target.pathname = source.pathname;
  target.search = source.search;
  return target;
}

async function readLimited(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > limit) throw new ProxyError(502, 'upstream_document_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function decode(buffer, contentType) {
  const charset = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] || 'utf-8';
  return new TextDecoder(charset).decode(buffer);
}

function withAbort(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function syntheticHeaders(headers, config) {
  for (const name of ['content-disposition', 'content-location', 'link', 'refresh', 'location', 'x-robots-tag']) delete headers[name];
  if (!config.indexable) headers['x-robots-tag'] = 'noindex';
}

function requestHeaders(request, config, pathname) {
  const headers = new Headers();
  const blocked = new Set([...hopHeaders, 'host', 'content-length', 'accept-encoding', 'x-real-ip', 'forwarded',
    ...(request.headers.connection || '').toLowerCase().split(',').map((value) => value.trim())]);
  for (const [name, value] of Object.entries(request.headers)) {
    if (blocked.has(name) || name.startsWith('x-forwarded-') || name.startsWith('cf-') || value === undefined) continue;
    if (['GET', 'HEAD'].includes(request.method) && ['if-none-match', 'if-modified-since'].includes(name)) continue;
    if (['range', 'if-range'].includes(name) && !binaryPath.test(pathname)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('accept-encoding', 'identity');
  for (const name of ['origin', 'referer']) {
    if (!headers.has(name)) continue;
    try {
      const url = new URL(headers.get(name));
      if (url.origin === config.mapper.publicUrl.origin) {
        const rewritten = upstreamUrl(url, config);
        headers.set(name, name === 'origin' ? rewritten.origin : rewritten.href);
      }
    } catch { headers.delete(name); }
  }
  return headers;
}

function rewriteCookie(cookie, config) {
  return cookie.replace(/;\s*Domain=([^;]+)/i, (match, domain) => {
    return config.mapper.isSourceHostname(domain.trim().replace(/^\./, '')) ? '' : match;
  });
}

function responseHeaders(response, target, config, report) {
  const headers = {};
  const blocked = new Set([...hopHeaders, 'set-cookie', 'alt-svc',
    ...(response.headers.get('connection') || '').toLowerCase().split(',').map((value) => value.trim())]);
  for (const [name, value] of response.headers) if (!blocked.has(name)) headers[name] = value;
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies.map((value) => rewriteCookie(value, config));
  if (headers['content-encoding']) {
    delete headers['content-encoding'];
    delete headers['content-length'];
  }
  for (const name of ['location', 'content-location']) {
    if (headers[name]) headers[name] = config.mapper.mapUrl(headers[name], target, true);
  }
  for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
    if (headers[name]) headers[name] = config.mapper.mapText(headers[name]);
  }
  if (headers['access-control-allow-origin'] && headers['access-control-allow-origin'] !== '*') {
    try {
      headers['access-control-allow-origin'] = new URL(config.mapper.mapUrl(headers['access-control-allow-origin'])).origin;
    } catch { delete headers['access-control-allow-origin']; }
  }
  if (headers.refresh) headers.refresh = rewriteRefresh(headers.refresh, target, config.mapper);
  let canonical;
  if (headers.link) {
    try {
      const result = rewriteLinkHeader(headers.link, target, config);
      headers.link = result.header;
      canonical = result.canonical;
    } catch {
      delete headers.link;
      report('invalid_link_header_removed');
    }
  }
  if (!config.indexable) headers['x-robots-tag'] = `noindex${headers['x-robots-tag'] ? `, ${headers['x-robots-tag']}` : ''}`;
  return { headers, canonical };
}

function transformedHeaders(headers, contentType) {
  for (const name of ['content-length', 'content-encoding', 'etag', 'last-modified', 'content-md5',
    'digest', 'content-digest', 'repr-digest', 'accept-ranges']) delete headers[name];
  headers['content-type'] = contentType;
  headers['cache-control'] = /private|no-store/i.test(headers['cache-control'] || '') ? 'private, no-store' : 'no-cache';
}

function jsonUrls(value, mapper, base) {
  if (typeof value === 'string') return mapper.mapUrl(value, base);
  if (Array.isArray(value)) return value.map((entry) => jsonUrls(entry, mapper, base));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, jsonUrls(entry, mapper, base)]));
  return value;
}

function documentKind(contentType, pathname, config) {
  if (/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return 'html';
  if (/\.xml\.gz$/i.test(pathname)) return 'gzip-xml';
  if (/^(?:text|application)\/(?:[\w.-]+\+)?xml\b|^image\/svg\+xml\b/i.test(contentType)
      || /\.xml$/i.test(pathname)) return 'xml';
  if (/^text\/css\b/i.test(contentType)) return 'css';
  if (/^application\/(?:[\w.-]+\+)?json\b/i.test(contentType)) return 'json';
  if (config.rewriteScripts && /^(?:application|text)\/(?:java|ecma)script\b/i.test(contentType)) return 'script';
  return undefined;
}

function sitemapDiscovery(config, report) {
  let cached;
  let pending;

  async function fetchLocal(value, signal) {
    let target = upstreamUrl(value, config);
    const visited = new Set();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (visited.has(target.href)) return null;
      visited.add(target.href);
      const response = await fetch(target, { redirect: 'manual', signal,
        headers: { 'accept-encoding': 'identity', 'user-agent': 'DiskbuddyMirror/1.0 sitemap-discovery' } });
      if (!redirectStatuses.has(response.status)) {
        if (response.status !== 200) {
          await response.body?.cancel();
          if ([404, 410].includes(response.status)) return null;
          throw new Error('Sitemap discovery upstream unavailable');
        }
        const buffer = await readLimited(response, config.maxTransformBytes);
        return { buffer, url: target, type: response.headers.get('content-type') || '', headers: response.headers };
      }
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) return null;
      const next = new URL(location, target);
      if (!config.mapper.isSource(next)) throw new Error('External sitemap discovery redirect');
      target = upstreamUrl(next, config);
    }
    return null;
  }

  async function discover() {
    const signal = AbortSignal.timeout(config.timeoutMs);
    const locations = new Set(config.sitemapPaths.map((path) => upstreamUrl(path, config).href));
    const pages = new Set();
    try {
      const robots = await fetchLocal('/robots.txt', signal);
      const robotsText = robots ? decode(robots.buffer, robots.type) : '';
      if (/^\s*</.test(robotsText)) throw new Error('Invalid robots response');
      if (robots) {
        for (const location of sitemapDeclarations(robotsText, robots.url, config.mapper)) {
          locations.add(upstreamUrl(location, config).href);
        }
      }
      if (!locations.size) {
        for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml']) {
          const candidate = await fetchLocal(path, signal);
          if (!candidate) continue;
          try {
            const buffer = /\.xml\.gz$/i.test(candidate.url.pathname)
              ? await decompress(candidate.buffer, { maxOutputLength: config.maxTransformBytes }) : candidate.buffer;
            const root = parseXml(decode(buffer, candidate.type)).documentElement.localName;
            if (['urlset', 'sitemapindex'].includes(root)) locations.add(candidate.url.href);
          } catch { report('invalid_sitemap_candidate'); }
        }
      }
      if (!locations.size && config.sitemapPagePaths.length) {
        const rules = robotsParser(upstreamUrl('/robots.txt', config).href, robotsText);
        for (const path of config.sitemapPagePaths) {
          const target = upstreamUrl(path, config);
          if (rules.isAllowed(target.href, 'Googlebot') === false || rules.isAllowed(target.href, '*') === false) continue;
          const page = await fetchLocal(path, signal);
          if (!page || !/^text\/html\b/i.test(page.type) || /\b(noindex|none)\b/i.test(page.headers.get('x-robots-tag') || '')) continue;
          if (rules.isAllowed(page.url.href, 'Googlebot') === false || rules.isAllowed(page.url.href, '*') === false) continue;
          const document = load(decode(page.buffer, page.type));
          const blocked = document('meta[name]').toArray().some((element) => {
            const node = document(element);
            return /^(robots|googlebot|bingbot)$/i.test(node.attr('name')) && /\b(noindex|none)\b/i.test(node.attr('content') || '');
          });
          if (blocked) continue;
          const base = new URL(document('base[href]').first().attr('href') || page.url.href, page.url);
          const canonical = page.headers.get('link')
            ? rewriteLinkHeader(page.headers.get('link'), page.url, config).canonical : undefined;
          const htmlCanonical = document('link[rel="canonical"]').first().attr('href');
          const expected = canonicalUrl(undefined, page.url, config);
          const actual = canonical || (htmlCanonical ? canonicalUrl(htmlCanonical, base, config) : expected);
          if (actual === expected) pages.add(config.mapper.mapUrl(page.url.href));
        }
      }
    } catch {
      pages.clear();
      report('sitemap_discovery_failed');
    }
    if (!locations.size && !pages.size) report('sitemap_not_found');
    return { locations: [...locations], pages: [...pages] };
  }

  return async () => {
    if (cached && cached.expires > Date.now()) return cached.result;
    if (!pending) pending = discover().then((result) => {
      cached = { result, expires: Date.now() + (result.locations.length || result.pages.length ? 300000 : 15000) };
      return result;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

export function createProxyServer(config, { logger = console } = {}) {
  const log = (event, details = {}) => logger.warn(JSON.stringify({ event, ...details }));
  const discoverSitemaps = sitemapDiscovery(config, log);
  const server = http.createServer(async (request, response) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('upstream_timeout')), config.timeoutMs);
    timer.unref();
    request.on('aborted', () => controller.abort());
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    let target;
    try {
      if (!request.url.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) {
        throw new ProxyError(400, 'invalid_request_target');
      }
      target = upstreamUrl(request.url, config);
      if (target.pathname === '/healthz' && ['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }));
        return;
      }
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) {
        response.setHeader('allow', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
        throw new ProxyError(405, 'method_not_allowed');
      }
      const protocol = config.trustProxy
        ? (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http'
        : request.socket.encrypted ? 'https' : 'http';
      const publicTarget = new URL(config.mapper.publicUrl);
      publicTarget.pathname = target.pathname;
      publicTarget.search = target.search;
      if (config.enforceOrigin && (request.headers.host !== config.mapper.publicUrl.host
          || `${protocol}:` !== config.mapper.publicUrl.protocol)) {
        response.writeHead(308, { location: publicTarget.href, 'cache-control': 'no-store' });
        response.end();
        return;
      }
      const headers = requestHeaders(request, config, target.pathname);
      const readOnly = ['GET', 'HEAD'].includes(request.method);
      let body;
      if (!readOnly) {
        if (Number(request.headers['content-length'] || 0) > config.maxRequestBytes) throw new ProxyError(413, 'request_too_large');
        let received = 0;
        body = request.pipe(new Transform({ transform(chunk, _encoding, callback) {
          received += chunk.length;
          callback(received > config.maxRequestBytes ? new ProxyError(413, 'request_too_large') : null, chunk);
        } }));
      }
      const robotsRequest = target.pathname === '/robots.txt' && readOnly;
      const upstream = await fetch(target, {
        method: robotsRequest ? 'GET' : request.method,
        headers, body, duplex: body ? 'half' : undefined,
        redirect: 'manual', signal: controller.signal,
      });
      const report = (event) => log(event, { path: target.pathname });
      const { headers: outgoing, canonical } = responseHeaders(upstream, target, config, report);
      let status = upstream.status;
      let output;
      if (redirectStatuses.has(status) && outgoing.location === publicTarget.href) {
        await upstream.body?.cancel();
        throw new ProxyError(502, 'upstream_redirect_loop_check_upstream_url_and_aliases');
      }
      if (robotsRequest && [200, 404].includes(status)) {
        const original = status === 200 ? decode(await readLimited(upstream, config.maxTransformBytes), outgoing['content-type'] || '') : '';
        if (status === 404) await upstream.body?.cancel();
        if (/^\s*</.test(original)) throw new ProxyError(502, 'upstream_robots_is_html');
        const declared = sitemapDeclarations(original, target, config.mapper);
        let locations = [...declared, ...config.sitemapPaths.map((path) => upstreamUrl(path, config).href)];
        if (!locations.length) {
          const discovered = await withAbort(discoverSitemaps(), controller.signal);
          locations = discovered.locations;
          if (discovered.pages.length) locations = [upstreamUrl('/sitemap.xml', config).href];
        }
        output = rewriteRobots(original, locations, config);
        if (status === 404) syntheticHeaders(outgoing, config);
        status = 200;
        transformedHeaders(outgoing, 'text/plain; charset=utf-8');
      } else if (target.pathname === '/sitemap.xml' && readOnly && status === 404) {
        const discovered = await withAbort(discoverSitemaps(), controller.signal);
        const locations = discovered.locations.map((value) => config.mapper.mapUrl(value))
          .filter((value) => new URL(value).pathname !== '/sitemap.xml');
        if (locations.length || discovered.pages.length) {
          await upstream.body?.cancel();
          output = locations.length ? buildSitemapIndex(locations) : buildUrlset(discovered.pages);
          status = 200;
          syntheticHeaders(outgoing, config);
          transformedHeaders(outgoing, 'application/xml; charset=utf-8');
        }
      }
      const detectedKind = documentKind(outgoing['content-type'] || '', target.pathname, config);
      if (output === undefined && status === 404 && config.custom404 && request.method === 'GET'
          && (detectedKind === 'html' || /\btext\/html\b/i.test(request.headers.accept || ''))) {
        await upstream.body?.cancel();
        output = notFoundPage(config, target.pathname);
        syntheticHeaders(outgoing, config);
        transformedHeaders(outgoing, 'text/html; charset=utf-8');
      }
      const kind = status >= 400 ? (detectedKind === 'html' ? 'html' : undefined)
        : redirectStatuses.has(status) ? undefined : detectedKind;
      if (output === undefined && kind && ![204, 206, 304].includes(status)) {
        const contentType = outgoing['content-type'] || '';
        const resultType = kind === 'html' ? 'text/html; charset=utf-8' : kind === 'gzip-xml' ? 'application/gzip'
          : `${contentType.split(';')[0] || 'application/xml'}; charset=utf-8`;
        transformedHeaders(outgoing, resultType);
        if (request.method !== 'HEAD') {
          let buffer = await readLimited(upstream, config.maxTransformBytes);
          if (kind === 'gzip-xml') buffer = await decompress(buffer, { maxOutputLength: config.maxTransformBytes });
          const text = decode(buffer, contentType);
          if (kind === 'html') output = rewriteHtml(text, target.href, config, { status, headerCanonical: canonical, report });
          else if (['xml', 'gzip-xml'].includes(kind)) {
            output = rewriteXml(text, target.href, config);
            if (kind === 'gzip-xml') output = await compress(output);
          } else if (kind === 'json') output = JSON.stringify(jsonUrls(JSON.parse(text), config.mapper, target));
          else output = config.mapper.mapText(text);
        }
      }
      if (request.headers.cookie || request.headers.authorization || outgoing['set-cookie']) outgoing['cache-control'] = 'private, no-store';
      if (output !== undefined && request.method !== 'HEAD') outgoing['content-length'] = Buffer.byteLength(output);
      response.writeHead(status, outgoing);
      if (request.method === 'HEAD' || [204, 304].includes(status)) {
        await upstream.body?.cancel();
        response.end();
      } else if (output !== undefined) response.end(output);
      else if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
      else response.end();
    } catch (error) {
      const status = error.status || error.cause?.status || (controller.signal.aborted ? 504 : 502);
      log(error.code || error.cause?.code || (status === 504 ? 'upstream_timeout' : 'upstream_error'),
        { path: target?.pathname, status });
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...(status >= 500 ? { 'retry-after': '30' } : {}) });
        response.end(request.method === 'HEAD' ? undefined : `${http.STATUS_CODES[status] || 'Proxy error'}\n`);
      } else response.destroy();
    } finally { clearTimeout(timer); }
  });
  server.requestTimeout = Math.max(config.timeoutMs, 30000);
  server.headersTimeout = Math.min(server.requestTimeout, 15000);
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n'));
  return server;
}