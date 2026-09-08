import { load } from 'cheerio';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import parseSrcset from 'parse-srcset';
import LinkHeader from 'http-link-header';

const urlAttributes = ['href', 'src', 'action', 'formaction', 'poster', 'data', 'cite',
  'background', 'manifest', 'itemid', 'resource', 'about', 'data-src', 'data-href', 'data-url', 'data-original'];
const trackingParameter = /^(utm_.+|gclid|fbclid|msclkid|dclid|_ga)$/i;
const sitemapNamespace = 'http://www.sitemaps.org/schemas/sitemap/0.9';

export function canonicalUrl(value, requestUrl, config) {
  const url = new URL(value || requestUrl, requestUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid canonical URL');
  if (!value) {
    for (const key of [...url.searchParams.keys()]) {
      if (trackingParameter.test(key)) url.searchParams.delete(key);
    }
  }
  url.hash = '';
  return config.canonicalMode === 'mirror' ? config.mapper.mapUrl(url.href) : url.href;
}

export function rewriteLinkHeader(value, requestUrl, config) {
  const links = LinkHeader.parse(value);
  let canonical;
  links.refs = links.refs.filter((reference) => {
    if ((reference.rel || '').split(/\s+/).includes('canonical')) {
      if (canonical) return false;
      canonical = canonicalUrl(reference.uri, requestUrl, config);
      reference.uri = canonical;
    } else {
      reference.uri = config.mapper.mapUrl(reference.uri, requestUrl, true);
    }
    return true;
  });
  return { header: links.toString(), canonical };
}

export function rewriteRefresh(value, requestUrl, mapper) {
  return value.replace(/(\burl\s*=\s*)(["']?)(.*?)(\2)\s*$/i,
    (_match, prefix, quote, target) => `${prefix}${quote}${mapper.mapUrl(target, requestUrl, true)}${quote}`);
}

function rewriteData(value, requestUrl, config, report, structured = false) {
  if (typeof value === 'string') return config.mapper.mapUrl(value, requestUrl);
  if (Array.isArray(value)) return value.map((entry) => rewriteData(entry, requestUrl, config, report, structured))
    .filter((entry) => entry !== undefined);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, rewriteData(entry, requestUrl, config, report, structured)]).filter(([, entry]) => entry !== undefined));
  const types = Array.isArray(result['@type']) ? result['@type'] : [result['@type']];
  if (structured && config.sanitizeJsonLd && types.includes('BreadcrumbList')) {
    const items = result.itemListElement;
    const valid = Array.isArray(items) && items.length >= 2 && items.every((item, index) => {
      if (!item || typeof item !== 'object' || item['@type'] !== 'ListItem') return false;
      const name = item.name || item.item?.name;
      if (typeof name !== 'string' || !name.trim()) return false;
      const target = typeof item.item === 'string' ? item.item : item.item?.['@id'];
      if (target === undefined) return index === items.length - 1;
      try {
        const url = new URL(target, requestUrl);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    });
    if (!valid) {
      report('invalid_breadcrumb_removed');
      return undefined;
    }
    items.forEach((item, index) => {
      item.position = index + 1;
      if (typeof item.item === 'string') item.item = config.mapper.mapUrl(item.item, requestUrl, true);
      else if (item.item?.['@id']) item.item['@id'] = config.mapper.mapUrl(item.item['@id'], requestUrl, true);
    });
  }
  return result;
}

export function rewriteHtml(html, requestUrl, config, { status = 200, headerCanonical, report = () => {} } = {}) {
  const document = load(html);
  const originalBase = document('base[href]').first().attr('href');
  let base = requestUrl;
  try { base = new URL(originalBase || requestUrl, requestUrl).href; } catch { report('invalid_base_url'); }
  const canonicalNodes = document('link[rel]').filter((_index, element) =>
    (document(element).attr('rel') || '').toLowerCase().split(/\s+/).includes('canonical'));
  let canonical;
  try {
    const sourceCanonical = canonicalNodes.first().attr('href');
    canonical = headerCanonical || canonicalUrl(sourceCanonical, sourceCanonical ? base : requestUrl, config);
    if (!['http:', 'https:'].includes(new URL(canonical).protocol)) throw new Error('Invalid canonical');
  } catch {
    canonical = canonicalUrl(undefined, requestUrl, config);
    report('invalid_canonical_replaced');
  }
  canonicalNodes.remove();

  document('*').each((_index, element) => {
    const node = document(element);
    const resource = node.attr('src') || node.attr('href');
    if (resource && node.attr('integrity')) {
      try {
        const local = config.mapper.isSource(new URL(resource, base));
        if (local && (element.tagName === 'link' || config.rewriteScripts)) node.removeAttr('integrity');
      } catch { report('invalid_resource_url'); }
    }
    for (const attribute of urlAttributes) {
      if (node.attr(attribute)) node.attr(attribute, config.mapper.mapUrl(node.attr(attribute), base));
    }
    for (const attribute of ['srcset', 'data-srcset', 'imagesrcset']) {
      if (!node.attr(attribute)) continue;
      const candidates = parseSrcset(node.attr(attribute));
      node.attr(attribute, candidates.map((candidate) => {
        const descriptor = candidate.w ? ` ${candidate.w}w` : candidate.d ? ` ${candidate.d}x` : '';
        return `${config.mapper.mapUrl(candidate.url, base)}${descriptor}`;
      }).join(', '));
    }
    if (node.attr('style')) node.attr('style', config.mapper.mapText(node.attr('style')));
    if (element.tagName === 'style') node.text(config.mapper.mapText(node.text()));
    if (element.tagName === 'meta') {
      const property = (node.attr('property') || node.attr('name') || '').toLowerCase();
      if (node.attr('content')) {
        node.attr('content', ['og:url', 'twitter:url'].includes(property)
          ? canonical : config.mapper.mapUrl(node.attr('content'), base));
      }
      if ((node.attr('http-equiv') || '').toLowerCase() === 'refresh') {
        node.attr('content', rewriteRefresh(node.attr('content') || '', base, config.mapper));
      }
      if (node.attr('charset')) node.attr('charset', 'utf-8');
      if ((node.attr('http-equiv') || '').toLowerCase() === 'content-type') {
        node.attr('content', 'text/html; charset=utf-8');
      }
    }
    if (element.tagName !== 'script' || node.attr('src')) return;
    const type = (node.attr('type') || '').toLowerCase().split(';')[0].trim();
    if (['application/ld+json', 'application/json', 'importmap'].includes(type)) {
      try {
        const value = rewriteData(JSON.parse(node.html()), base, config, report, type === 'application/ld+json');
        if (value === undefined) node.remove();
        else node.text(JSON.stringify(value).replace(/</g, '\\u003c'));
      } catch {
        report(type === 'application/ld+json' ? 'invalid_jsonld' : 'invalid_json_payload');
        if (type === 'application/ld+json' && config.sanitizeJsonLd) node.remove();
      }
    } else if (config.rewriteScripts) node.text(config.mapper.mapText(node.html() || ''));
  });

  if (status >= 200 && status < 300) {
    document('head').append(document('<link>').attr({ rel: 'canonical', href: canonical }));
  }
  if (!config.indexable) document('head').append('<meta name="robots" content="noindex, follow">');
  return document.html();
}

export function parseXml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML DTD/entity declarations are not supported');
  return new DOMParser({ onError: (_level, message) => { throw new Error(message); } })
    .parseFromString(text, 'application/xml');
}

export function rewriteXml(text, requestUrl, config) {
  const document = parseXml(text);
  const elements = Array.from(document.getElementsByTagName('*'));
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'xmlns' || attribute.prefix === 'xmlns') continue;
      attribute.value = config.mapper.mapUrl(attribute.value, requestUrl);
    }
    for (const child of Array.from(element.childNodes)) {
      if (![3, 4].includes(child.nodeType)) continue;
      const sitemapLocation = ['urlset', 'sitemapindex'].includes(document.documentElement.localName)
        && element.localName === 'loc';
      child.nodeValue = config.mapper.mapUrl(child.nodeValue, requestUrl, sitemapLocation);
    }
  }
  return new XMLSerializer().serializeToString(document)
    .replace(/(<\?xml\b[^?]*encoding\s*=\s*)["'][^"']*["']/i, '$1"UTF-8"');
}

export function buildSitemapIndex(locations) {
  const document = parseXml(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="${sitemapNamespace}"/>`);
  for (const location of [...new Set(locations)]) {
    const sitemap = document.createElementNS(sitemapNamespace, 'sitemap');
    const loc = document.createElementNS(sitemapNamespace, 'loc');
    loc.appendChild(document.createTextNode(location));
    sitemap.appendChild(loc);
    document.documentElement.appendChild(sitemap);
  }
  return new XMLSerializer().serializeToString(document);
}

export function buildUrlset(locations) {
  const document = parseXml(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="${sitemapNamespace}"/>`);
  for (const location of [...new Set(locations)]) {
    const entry = document.createElementNS(sitemapNamespace, 'url');
    const loc = document.createElementNS(sitemapNamespace, 'loc');
    loc.appendChild(document.createTextNode(location));
    entry.appendChild(loc);
    document.documentElement.appendChild(entry);
  }
  return new XMLSerializer().serializeToString(document);
}

export function sitemapDeclarations(robots, requestUrl, mapper) {
  const locations = [];
  for (const line of robots.split(/\r?\n/)) {
    const match = line.match(/^\s*Sitemap\s*:\s*(\S+)/i);
    if (!match) continue;
    try {
      const url = new URL(match[1], requestUrl);
      if (mapper.isSource(url)) locations.push(url.href);
    } catch { continue; }
  }
  return [...new Set(locations)];
}

export function rewriteRobots(text, locations, config) {
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*(Sitemap|Host)\s*:/i.test(line));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (!lines.some((line) => /^\s*User-agent\s*:/i.test(line))) lines.push('User-agent: *', 'Disallow:');
  lines.push('', ...[...new Set(locations)].map((location) => `Sitemap: ${config.mapper.mapUrl(location)}`));
  return `${lines.join('\n')}\n`;
}