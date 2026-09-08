import { createUrlMapper } from './urls.js';

function origin(value, name) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an http(s) origin without credentials, path or query`);
  }
  return url.origin;
}

function boolean(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
  return value === 'true';
}

function integer(value, fallback, name, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

export function loadConfig(env = process.env) {
  const railway = Boolean(env.RAILWAY_PROJECT_ID || env.RAILWAY_PUBLIC_DOMAIN);
  const publicOrigin = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  if (!publicOrigin) throw new Error('PUBLIC_URL is required when RAILWAY_PUBLIC_DOMAIN is unavailable, e.g. https://mirror.example');
  const upstream = origin(env.UPSTREAM_URL || 'https://www.diskbuddy.com', 'UPSTREAM_URL');
  const publicUrl = origin(publicOrigin, 'PUBLIC_URL');
  const aliases = (env.UPSTREAM_ALIASES ?? (env.UPSTREAM_URL ? '' : 'https://diskbuddy.com')).split(',').map((value) => value.trim()).filter(Boolean)
    .map((value) => origin(value, 'UPSTREAM_ALIASES'));
  if ([upstream, ...aliases].some((value) => new URL(value).host === new URL(publicUrl).host)) {
    throw new Error('PUBLIC_URL must not be an upstream host (proxy loop)');
  }
  const canonicalMode = env.CANONICAL_MODE || 'mirror';
  if (!['mirror', 'upstream'].includes(canonicalMode)) throw new Error('Invalid CANONICAL_MODE');
  const mapper = createUrlMapper(upstream, publicUrl, aliases);
  const sitemapPaths = (env.SITEMAP_PATHS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const sitemapPagePaths = [...new Set((env.SITEMAP_PAGE_PATHS || '').split(',').map((value) => value.trim()).filter(Boolean))];
  if (sitemapPagePaths.length > 500) throw new Error('SITEMAP_PAGE_PATHS supports at most 500 explicit pages; publish a source sitemap for larger sites');
  for (const path of [...sitemapPaths, ...sitemapPagePaths]) {
    if (!path.startsWith('/') || path.startsWith('//') || new URL(path, upstream).origin !== upstream) {
      throw new Error('Sitemap paths must contain local absolute paths');
    }
  }
  return {
    mapper,
    canonicalMode,
    sitemapPaths,
    sitemapPagePaths,
    port: integer(env.PORT, 3000, 'PORT', 0, 65535),
    host: env.HOST || '0.0.0.0',
    indexable: boolean(env.INDEXABLE, false, 'INDEXABLE'),
    custom404: boolean(env.CUSTOM_404, true, 'CUSTOM_404'),
    trustProxy: boolean(env.TRUST_PROXY, railway, 'TRUST_PROXY'),
    enforceOrigin: boolean(env.ENFORCE_PUBLIC_ORIGIN, true, 'ENFORCE_PUBLIC_ORIGIN'),
    sanitizeJsonLd: boolean(env.SANITIZE_JSONLD, true, 'SANITIZE_JSONLD'),
    rewriteScripts: boolean(env.REWRITE_SCRIPTS, false, 'REWRITE_SCRIPTS'),
    timeoutMs: integer(env.UPSTREAM_TIMEOUT_MS, 30000, 'UPSTREAM_TIMEOUT_MS'),
    maxTransformBytes: integer(env.MAX_TRANSFORM_BYTES, 16777216, 'MAX_TRANSFORM_BYTES'),
    maxRequestBytes: integer(env.MAX_REQUEST_BYTES, 16777216, 'MAX_REQUEST_BYTES'),
  };
}