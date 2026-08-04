import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { anthropicToResponsesObject, translateAnthropicStreamToResponses } from '../src/translate/anthropicToResponses.js';

function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  });
}

test('converts anthropic message to responses object', () => {
  const response = anthropicToResponsesObject({
    id: 'msg_1',
    model: 'minimax-m3',
    content: [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'toolu_1', name: 'sh', input: { cmd: 'pwd' } }
    ]
  }, 'minimax-m3');
  assert.equal(response.output[0].content[0].text, 'hi');
  assert.equal(response.output[1].name, 'sh');
  assert.equal(response.output[1].arguments, '{"cmd":"pwd"}');
});

test('translates anthropic stream to responses events', async () => {
  const body = streamFromChunks([
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ]);
  const events = [];
  await translateAnthropicStreamToResponses(body, 'minimax-m3', (event, data) => events.push({ event, data }));
  assert.ok(events.some((item) => item.event === 'response.output_text.delta'));
  assert.ok(events.some((item) => item.event === 'response.completed'));
});

test('does not expose internal output indexes in streamed tool calls', async () => {
  const body = streamFromChunks([
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"sh","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ]);
  const events = [];
  await translateAnthropicStreamToResponses(body, 'minimax-m3', (event, data) => events.push({ event, data }));

  const added = events.find((item) => item.event === 'response.output_item.added');
  const done = events.find((item) => item.event === 'response.output_item.done');
  assert.equal(Object.hasOwn(added.data.item, 'outputIndex'), false);
  assert.equal(Object.hasOwn(done.data.item, 'outputIndex'), false);
});


test('emits response.failed on anthropic stream break', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
      setTimeout(() => controller.error(new Error('anthropic stream exploded')), 0);
    }
  });
  const events = [];
  await translateAnthropicStreamToResponses(body, 'minimax-m3', (event, data) => events.push({ event, data }));
  const failed = events.find((item) => item.event === 'response.failed');
  assert.ok(failed, 'expected response.failed event');
  assert.equal(failed.data.response.status, 'failed');
  assert.equal(events[events.length - 1].event, 'response.failed');
});

test('anthropic response object carries top-level tokens and stream usage', async () => {
  const obj = anthropicToResponsesObject({
    id: 'msg_1',
    model: 'minimax-m3',
    content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 11, output_tokens: 4 }
  }, 'minimax-m3');
  assert.equal(obj.input_tokens, 11);
  assert.equal(obj.output_tokens, 4);

  const body = streamFromChunks([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":9,"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ]);
  const events = [];
  await translateAnthropicStreamToResponses(body, 'minimax-m3', (event, data) => events.push({ event, data }));
  const completed = events.find((item) => item.event === 'response.completed');
  assert.equal(completed.data.response.input_tokens, 9);
  assert.equal(completed.data.response.output_tokens, 2);
  assert.deepEqual(completed.data.response.usage, { input_tokens: 9, output_tokens: 2 });
});

