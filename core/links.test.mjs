import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWebUrl, objectUrl, webUsers } from './links.mjs';

test('web URLs encode one object segment and refuse credentials, queries and unsupported schemes', () => {
  assert.equal(normalizeWebUrl('https://infohub.example.test/'), 'https://infohub.example.test');
  assert.equal(objectUrl('https://example.test/base/', '中文 %/#'), 'https://example.test/base/o/%E4%B8%AD%E6%96%87%20%25%2F%23');
  assert.equal(objectUrl(undefined, 'id'), undefined);
  for (const url of ['file:///tmp/test', 'javascript:alert(1)', 'https://user:pass@example.test', 'https://example.test?a=b', 'https://example.test/#anchor']) assert.throws(() => normalizeWebUrl(url));
  assert.deepEqual(webUsers(), []); assert.deepEqual(webUsers({ webUser: 'alice' }), ['alice']);
  assert.deepEqual(webUsers({ webUser: ['alice', 'bob'] }), ['alice', 'bob']);
  assert.throws(() => webUsers({ webUser: 42 }));
});
