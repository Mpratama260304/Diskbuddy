import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('requires a fixed public origin and rejects loops, credentials and non-HTTP targets', () => {
  assert.throws(() => loadConfig({}), /PUBLIC_URL/);
  for (const url of ['file:///etc/passwd', 'https://user:password@example.com', 'https://example.com/subpath']) {
    assert.throws(() => loadConfig({ PUBLIC_URL: url }));
  }
  assert.throws(() => loadConfig({ PUBLIC_URL: 'https://diskbuddy.com' }), /loop/);
});

test('validates limits, booleans, canonical modes and sitemap paths', () => {
  for (const values of [
    { PORT: '70000' }, { MAX_TRANSFORM_BYTES: '0' }, { INDEXABLE: 'yes' },
    { CANONICAL_MODE: 'automatic' }, { SITEMAP_PATHS: '//evil.example/map.xml' },
    { SITEMAP_PAGE_PATHS: 'http://169.254.169.254/' },
  ]) assert.throws(() => loadConfig({ PUBLIC_URL: 'https://mirror.example', ...values }));
});

test('uses the verified final upstream, supports the apex alias and starts non-indexable', () => {
  const config = loadConfig({ PUBLIC_URL: 'https://mirror.example' });
  assert.equal(config.mapper.upstream.origin, 'https://www.diskbuddy.com');
  assert.equal(config.mapper.mapUrl('https://diskbuddy.com/about'), 'https://mirror.example/about');
  assert.equal(config.indexable, false);
  assert.equal(config.trustProxy, false);
  assert.equal(config.enforceOrigin, true);
});