import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseEvent, sseEncode } from '../src/sse.js';

test('parses event and data', () => {
  const parsed = parseSseEvent('event: response.created\ndata: {"ok":true}');
  assert.deepEqual(parsed, { event: 'response.created', data: '{"ok":true}' });
});

test('encodes sse', () => {
  assert.equal(sseEncode('x', { a: 1 }), 'event: x\ndata: {"a":1}\n\n');
});
