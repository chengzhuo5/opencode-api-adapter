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


test('emits response.failed instead of silent stream break', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"he"}}]}\n\n'));
      setTimeout(() => controller.error(new Error('upstream stream exploded')), 0);
    }
  });
  const events = [];
  await translateChatStreamToResponses(body, 'deepseek-v4-flash', (event, data) => events.push({ event, data }));
  const failed = events.find((item) => item.event === 'response.failed');
  assert.ok(failed, 'expected response.failed event');
  assert.equal(failed.data.type, 'response.failed');
  assert.equal(failed.data.response.status, 'failed');
  assert.ok(failed.data.response.error);
  assert.equal(events[events.length - 1].event, 'response.failed');
});

test('carries streamed usage into response.completed', async () => {
  const body = streamFromChunks([
    'data: {"choices":[{"delta":{"role":"assistant","content":"he"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":2,"total_tokens":125,"prompt_cache_hit_tokens":100,"prompt_cache_miss_tokens":23}}\n\n',
    'data: [DONE]\n\n'
  ]);
  const events = [];
  await translateChatStreamToResponses(body, 'deepseek-v4-flash', (event, data) => events.push({ event, data }));
  const completed = events.find((item) => item.event === 'response.completed');
  assert.ok(completed, 'expected response.completed');
  assert.deepEqual(completed.data.response.usage, {
    prompt_tokens: 123,
    completion_tokens: 2,
    total_tokens: 125,
    prompt_cache_hit_tokens: 100,
    prompt_cache_miss_tokens: 23
  });
});

test('response object always carries top-level input/output tokens', () => {
  const withUsage = chatToResponsesObject({
    id: 'chatcmpl-1',
    model: 'deepseek-v4-flash',
    choices: [{ message: { role: 'assistant', content: 'hi' } }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
  }, 'deepseek-v4-flash');
  assert.equal(withUsage.input_tokens, 10);
  assert.equal(withUsage.output_tokens, 3);
  assert.deepEqual(withUsage.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });

  const withoutUsage = chatToResponsesObject({
    id: 'chatcmpl-2',
    model: 'deepseek-v4-flash',
    choices: [{ message: { role: 'assistant', content: 'hi' } }]
  }, 'deepseek-v4-flash');
  assert.equal(withoutUsage.input_tokens, 0);
  assert.equal(withoutUsage.output_tokens, 0);
});

test('streamed completed response carries usage and top-level tokens', async () => {
  const body = streamFromChunks([
    'data: {"choices":[{"delta":{"role":"assistant","content":"he"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":7,"total_tokens":49}}\n\n',
    'data: [DONE]\n\n'
  ]);
  const events = [];
  await translateChatStreamToResponses(body, 'deepseek-v4-flash', (event, data) => events.push({ event, data }));
  const completed = events.find((item) => item.event === 'response.completed');
  assert.equal(completed.data.response.input_tokens, 42);
  assert.equal(completed.data.response.output_tokens, 7);
  assert.deepEqual(completed.data.response.usage, { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 });
});


test('converts apply_patch chat tool call back to custom_tool_call with unescaped input', () => {
  const patch = '*** Begin Patch\n*** End Patch';
  const chat = {
    id: 'chatcmpl-1',
    model: 'deepseek-v4-flash',
    choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify(patch) } }] } }]
  };
  const response = chatToResponsesObject(chat, 'deepseek-v4-flash');
  const item = response.output[0];
  assert.equal(item.type, 'custom_tool_call');
  assert.equal(item.name, 'apply_patch');
  assert.equal(item.call_id, 'call_patch');
  assert.equal(item.input, patch);
  assert.equal(Object.hasOwn(item, 'arguments'), false);
});

test('converts streamed apply_patch tool call to custom_tool_call on done', async () => {
  const patch = '*** Begin Patch\n*** Update File: x\n@@\n*** End Patch';
  const body = streamFromChunks([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_patch","type":"function","function":{"name":"apply_patch"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_patch","type":"function","function":{"arguments":' + JSON.stringify(JSON.stringify(patch)) + '}}]}}]}\n\n',
    'data: [DONE]\n\n'
  ]);
  const events = [];
  await translateChatStreamToResponses(body, 'deepseek-v4-flash', (event, data) => events.push({ event, data }));
  const done = events.find((item) => item.event === 'response.output_item.done' && item.data.item.name === 'apply_patch');
  assert.ok(done, 'expected output_item.done for apply_patch');
  assert.equal(done.data.item.type, 'custom_tool_call');
  assert.equal(done.data.item.input, patch);
  assert.equal(Object.hasOwn(done.data.item, 'arguments'), false);
  const customDone = events.find((item) => item.event === 'response.custom_tool_call.done');
  assert.ok(customDone, 'expected response.custom_tool_call.done');
  assert.equal(customDone.data.input, patch);
});
