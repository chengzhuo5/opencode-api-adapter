import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResponsesRequest } from '../src/translate/responsesContext.js';
import { responsesToChatRequest } from '../src/translate/responsesToChat.js';
import { responsesToAnthropicRequest } from '../src/translate/responsesToAnthropic.js';

function requestFixture(model = 'deepseek-v4-flash') {
  return {
    model,
    instructions: 'Keep the prefix stable.',
    stream: true,
    tools: [
      {
        type: 'function',
        name: 'first_tool',
        description: 'first',
        parameters: { type: 'object', properties: { value: { type: 'string' } } }
      },
      {
        type: 'function',
        name: 'second_tool',
        description: 'second',
        parameters: { type: 'object', properties: { count: { type: 'integer' } } }
      }
    ],
    input: [
      {
        type: 'message',
        role: 'user',
        id: 'volatile-user-id',
        content: [{ type: 'input_text', text: 'hello' }]
      },
      {
        type: 'function_call',
        id: 'volatile-call-id',
        call_id: 'call_1',
        name: 'first_tool',
        arguments: '{"value":"x"}',
        status: 'completed'
      },
      {
        type: 'function_call_output',
        id: 'volatile-output-id',
        call_id: 'call_1',
        output: 'ok',
        status: 'completed'
      }
    ]
  };
}

test('same input produces byte-equivalent model-visible payloads for every protocol', () => {
  const responsesBody = requestFixture();
  const chatBody = requestFixture();
  const messagesBody = requestFixture('minimax-m3');
  const cases = [
    () => normalizeResponsesRequest(responsesBody),
    () => responsesToChatRequest(chatBody),
    () => responsesToAnthropicRequest(messagesBody)
  ];
  for (const convert of cases) {
    assert.equal(JSON.stringify(convert()), JSON.stringify(convert()));
  }
});

test('appending a new message preserves the already-converted prefix', () => {
  const base = requestFixture();
  const appended = {
    ...base,
    input: [
      ...base.input,
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue' }]
      }
    ]
  };

  const baseResponses = normalizeResponsesRequest(base);
  const nextResponses = normalizeResponsesRequest(appended);
  assert.deepEqual(nextResponses.input.slice(0, baseResponses.input.length), baseResponses.input);

  const baseChat = responsesToChatRequest(base);
  const nextChat = responsesToChatRequest(appended);
  assert.deepEqual(nextChat.messages.slice(0, baseChat.messages.length), baseChat.messages);

  const baseMessages = responsesToAnthropicRequest({ ...base, model: 'minimax-m3' });
  const nextMessages = responsesToAnthropicRequest({ ...appended, model: 'minimax-m3' });
  assert.deepEqual(nextMessages.messages.slice(0, baseMessages.messages.length), baseMessages.messages);
});

test('tool order remains stable across all protocol adapters', () => {
  const body = requestFixture();
  assert.deepEqual(
    normalizeResponsesRequest(body).tools.map((tool) => tool.name),
    ['first_tool', 'second_tool']
  );
  assert.deepEqual(
    responsesToChatRequest(body).tools.map((tool) => tool.function.name),
    ['first_tool', 'second_tool']
  );
  assert.deepEqual(
    responsesToAnthropicRequest({ ...body, model: 'minimax-m3' }).tools.map((tool) => tool.name),
    ['first_tool', 'second_tool']
  );
});

test('repairing malformed tool history is deterministic', () => {
  const body = {
    model: 'deepseek-v4-flash',
    input: [
      { type: 'function_call_output', call_id: 'orphan', output: 'drop me' },
      { type: 'function_call', call_id: 'valid', name: 'first_tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'valid', output: 'keep me' }
    ]
  };
  const first = normalizeResponsesRequest(body);
  const second = normalizeResponsesRequest(body);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.input.map((item) => item.call_id), ['valid', 'valid']);
});
