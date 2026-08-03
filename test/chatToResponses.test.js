import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { chatToResponsesObject, translateChatStreamToResponses } from '../src/translate/chatToResponses.js';

function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  });
}

test('converts chat completion to responses object', () => {
  const response = chatToResponsesObject({
    id: 'chatcmpl-1',
    created: 1,
    model: 'deepseek-v4-flash',
    choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'sh', arguments: '{}' } }] } }]
  }, 'deepseek-v4-flash');
  assert.equal(response.object, 'response');
  assert.equal(response.output[0].content[0].text, 'hi');
  assert.equal(response.output[1].name, 'sh');
});

test('translates chat stream to responses events', async () => {
  const body = streamFromChunks([
    'data: {"choices":[{"delta":{"role":"assistant","content":"he"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
    'data: [DONE]\n\n'
  ]);
  const events = [];
  await translateChatStreamToResponses(body, 'deepseek-v4-flash', (event, data) => events.push({ event, data }));
  const types = events.map((item) => item.event);
  assert.ok(types.includes('response.output_text.delta'));
  assert.ok(types.includes('response.completed'));
  const delta = events.find((item) => item.event === 'response.output_text.delta').data;
  assert.equal(delta.delta, 'he');
});

test('does not expose internal output indexes in streamed function calls', async () => {
  const body = streamFromChunks([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"sh","arguments":"{}"}}]}}]}\n\n',
    'data: [DONE]\n\n'
  ]);
  const events = [];
  await translateChatStreamToResponses(body, 'deepseek-v4-flash', (event, data) => events.push({ event, data }));

  const added = events.find((item) => item.event === 'response.output_item.added');
  const done = events.find((item) => item.event === 'response.output_item.done');
  assert.equal(Object.hasOwn(added.data.item, 'outputIndex'), false);
  assert.equal(Object.hasOwn(done.data.item, 'outputIndex'), false);
});


test('does not duplicate tool names when every delta repeats the full name', async () => {
  const body = streamFromChunks([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell_command"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell_command"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell_command"}}]}}]}\n\n',
    'data: [DONE]\n\n'
  ]);
  const events = [];
  await translateChatStreamToResponses(body, 'deepseek-v4-flash', (event, data) => events.push({ event, data }));

  const added = events.find((item) => item.event === 'response.output_item.added');
  assert.equal(added.data.item.name, 'shell_command');

  const done = events.find((item) => item.event === 'response.output_item.done');
  assert.equal(done.data.item.name, 'shell_command');
});


test('translates deepseek reasoning_content deltas into reasoning output items', async () => {
  const body = streamFromChunks([
    'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":" hard"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
    'data: [DONE]\n\n'
  ]);
  const events = [];
  await translateChatStreamToResponses(body, 'deepseek-v4-flash', (event, data) => events.push({ event, data }));

  const added = events.filter((item) => item.event === 'response.output_item.added');
  const reasoning = added.find((item) => item.data.item.type === 'reasoning');
  assert.ok(reasoning, 'expected a reasoning output item');
  assert.equal(reasoning.data.item.summary[0].text, 'thinking hard');

  const done = events.find((item) => item.event === 'response.output_item.done' && item.data.item.type === 'reasoning');
  assert.ok(done);
});

