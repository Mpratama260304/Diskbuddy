import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { loadConfig } from '../src/config.js';
import { rewriteHtml, rewriteXml, parseXml, buildSitemapIndex, rewriteRobots,
  sitemapDeclarations, rewriteLinkHeader, rewriteRefresh } from '../src/transform.js';

const config = loadConfig({ PUBLIC_URL: 'https://mirror.example', UPSTREAM_URL: 'https://diskbuddy.com', INDEXABLE: 'true' });

test('HTML maps canonical, hreflang, assets, srcset, base, metadata and JSON data', () => {
  const html = `<html><head><base href="https://diskbuddy.com/">
    <link rel="canonical" href="https://diskbuddy.com/article">
    <link rel="canonical" href="/wrong"><link rel="alternate" hreflang="id" href="https://diskbuddy.com/id/article">
    <meta property="og:url" content="https://diskbuddy.com/wrong">
    <link rel="stylesheet" href="/style.css" integrity="sha256-old">
    <script src="/app.js" integrity="sha256-keep"></script></head><body>
    <img src="https://diskbuddy.com/image.png" srcset="https://diskbuddy.com/a.png 1x, https://external.example/b.png 2x">
    <script type="application/json">{"url":"https://diskbuddy.com/api"}</script>
    <a href="https://external.example">External</a></body></html>`;
  const document = load(rewriteHtml(html, 'https://diskbuddy.com/article?utm_source=test', config));
  assert.equal(document('link[rel=canonical]').length, 1);
  assert.equal(document('link[rel=canonical]').attr('href'), 'https://mirror.example/article');
  assert.equal(document('link[hreflang]').attr('href'), 'https://mirror.example/id/article');
  assert.equal(document('meta[property="og:url"]').attr('content'), 'https://mirror.example/article');
  assert.equal(document('base').attr('href'), 'https://mirror.example/');
  assert.equal(document('img').attr('src'), 'https://mirror.example/image.png');
  assert.match(document('img').attr('srcset'), /https:\/\/external.example\/b.png 2x/);
  assert.equal(document('link[rel=stylesheet]').attr('integrity'), undefined);
  assert.equal(document('script[src]').attr('integrity'), 'sha256-keep');
  assert.equal(JSON.parse(document('script[type="application/json"]').text()).url, 'https://mirror.example/api');
});

test('canonical fallback removes tracking but preserves pagination and search', () => {
  const document = load(rewriteHtml('<base href="https://diskbuddy.com/"><p>Page</p>', 'https://diskbuddy.com/search?q=disk&page=2&utm_source=x', config));
  assert.equal(document('link[rel=canonical]').attr('href'), 'https://mirror.example/search?q=disk&page=2');
  const upstream = load(rewriteHtml('<p>Page</p>', 'https://diskbuddy.com/about', { ...config, canonicalMode: 'upstream' }));
  assert.equal(upstream('link[rel=canonical]').attr('href'), 'https://diskbuddy.com/about');
  const missing = load(rewriteHtml('<p>Missing</p>', 'https://diskbuddy.com/missing', config, { status: 404 }));
  assert.equal(missing('link[rel=canonical]').length, 0);
});

test('JSON-LD repairs known breadcrumb positions, removes invalid data, preserves other graph nodes', () => {
  const events = [];
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
    {"@type":"BreadcrumbList","itemListElement":[
      {"@type":"ListItem","position":9,"name":"Home","item":"/"},
      {"@type":"ListItem","position":"bad","name":"Article"}]},
    {"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem"}]},
    {"@type":"Article","url":"https://diskbuddy.com/article","headline":"Example"}]}</script>
    <script type="application/ld+json">{"broken":}</script>`;
  const document = load(rewriteHtml(html, 'https://diskbuddy.com/article', config, { report: (event) => events.push(event) }));
  assert.equal(document('script').length, 1);
  const graph = JSON.parse(document('script').text())['@graph'];
  assert.equal(graph.length, 2);
  assert.deepEqual(graph[0].itemListElement.map((item) => item.position), [1, 2]);
  assert.equal(graph[0].itemListElement[0].item, 'https://mirror.example/');
  assert.equal(graph[1].url, 'https://mirror.example/article');
  assert.deepEqual(events, ['invalid_breadcrumb_removed', 'invalid_jsonld']);
});

test('default staging noindex does not erase upstream robots restrictions', () => {
  const document = load(rewriteHtml('<meta name="robots" content="noindex, nofollow">',
    'https://diskbuddy.com/', loadConfig({ PUBLIC_URL: 'https://mirror.example' })));
  assert.equal(document('meta[name=robots]').length, 2);
  assert.equal(document('meta[name=robots]').first().attr('content'), 'noindex, nofollow');
});

test('XML preserves namespaces and lastmod, maps nested sitemaps, images and alternates', () => {
  const source = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
    xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">
    <url><loc>https://diskbuddy.com/a?x=1&amp;y=2</loc><lastmod>2026-09-01</lastmod>
    <image:image><image:loc>https://diskbuddy.com/image.png</image:loc></image:image>
    <xhtml:link rel="alternate" hreflang="en" href="https://diskbuddy.com/en/a"/></url></urlset>`;
  const result = rewriteXml(source, 'https://diskbuddy.com/sitemap.xml', config);
  const document = parseXml(result);
  assert.equal(document.getElementsByTagName('loc')[0].textContent, 'https://mirror.example/a?x=1&y=2');
  assert.match(result, /<lastmod>2026-09-01<\/lastmod>/);
  assert.match(result, /https:\/\/mirror.example\/image.png/);
  assert.match(result, /href="https:\/\/mirror.example\/en\/a"/);
  const index = rewriteXml(buildSitemapIndex(['https://diskbuddy.com/posts.xml.gz']), 'https://diskbuddy.com/sitemap.xml', config);
  assert.match(index, /https:\/\/mirror.example\/posts.xml.gz/);
  assert.throws(() => rewriteXml('<urlset><url></urlset>', 'https://diskbuddy.com/sitemap.xml', config));
  assert.throws(() => parseXml('<!DOCTYPE root SYSTEM "file:///etc/passwd"><root/>'));
});

test('robots keeps crawl rules and all local sitemap declarations, without allowing external fetches', () => {
  const robots = 'User-agent: *\nDisallow: /private\nSitemap: https://diskbuddy.com/posts.xml\nSitemap: https://diskbuddy.com/pages.xml\nSitemap: http://169.254.169.254/secrets\n';
  const locations = sitemapDeclarations(robots, 'https://diskbuddy.com/robots.txt', config.mapper);
  assert.equal(locations.length, 2);
  const result = rewriteRobots(robots, locations, config);
  assert.match(result, /Disallow: \/private/);
  assert.match(result, /Sitemap: https:\/\/mirror.example\/posts.xml/);
  assert.match(result, /Sitemap: https:\/\/mirror.example\/pages.xml/);
  assert.doesNotMatch(result, /169\.254/);
});

test('Link and Refresh headers map relative URLs, avoid duplicate canonical declarations', () => {
  const result = rewriteLinkHeader('</a>; rel="canonical", <https://diskbuddy.com/b>; rel="canonical", </feed>; rel="alternate"',
    'https://diskbuddy.com/current', config);
  assert.equal(result.canonical, 'https://mirror.example/a');
  assert.equal(result.header.match(/rel=canonical/g).length, 1);
  assert.match(result.header, /https:\/\/mirror.example\/feed/);
  assert.equal(rewriteRefresh('0; url="/login"', 'https://diskbuddy.com/', config.mapper), '0; url="https://mirror.example/login"');
});