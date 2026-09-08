import test from 'node:test';
import assert from 'node:assert/strict';
import { createUrlMapper } from '../src/urls.js';

const mapper = createUrlMapper('https://diskbuddy.com', 'https://mirror.example', ['https://www.diskbuddy.com']);

test('maps source URLs, aliases, query strings and protocol-relative URLs', () => {
  assert.equal(mapper.mapUrl('https://diskbuddy.com/a?x=1#part'), 'https://mirror.example/a?x=1#part');
  assert.equal(mapper.mapUrl('//www.diskbuddy.com/image.png'), 'https://mirror.example/image.png');
  assert.equal(mapper.mapUrl('../about', 'https://diskbuddy.com/blog/post', true), 'https://mirror.example/about');
  assert.equal(mapper.mapUrl('/about'), '/about');
});

test('does not rewrite external hosts, credentials, ports or special schemes', () => {
  for (const value of [
    'https://diskbuddy.com.evil.example/a',
    'https://diskbuddy.com@evil.example/a',
    'https://user@diskbuddy.com/a',
    'https://diskbuddy.com:8443/a',
    'https://cdn.example/a',
    'mailto:help@diskbuddy.com',
    'data:image/png;base64,abc',
  ]) assert.equal(mapper.mapUrl(value), value);
});

test('rewrites literal URLs in CSS without rewriting lookalike domains', () => {
  assert.equal(
    mapper.mapText('url("https://diskbuddy.com/a.png") url(https://diskbuddy.com.evil.example/a.png)'),
    'url("https://mirror.example/a.png") url(https://diskbuddy.com.evil.example/a.png)',
  );
});

test('replaces upstream ports with the public port, including the default port', () => {
  const local = createUrlMapper('http://127.0.0.1:8000', 'https://mirror.example');
  assert.equal(local.mapUrl('http://127.0.0.1:8000/a'), 'https://mirror.example/a');
  const custom = createUrlMapper('https://diskbuddy.com', 'http://localhost:3000');
  assert.equal(custom.mapUrl('https://diskbuddy.com/a'), 'http://localhost:3000/a');
});

test('maps CSP origins before semicolons without adding a path or changing external origins', () => {
  assert.equal(mapper.mapText("default-src https://diskbuddy.com; img-src https://cdn.example;"),
    "default-src https://mirror.example; img-src https://cdn.example;");
});