import test from 'node:test';
import assert from 'node:assert/strict';
import { responsesToChatRequest, textFromContent } from '../src/translate/responsesToChat.js';

test('converts responses input to chat messages', () => {
  const request = responsesToChatRequest({
    model: 'deepseek-v4-flash',
    instructions: 'Be brief.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'function_call', call_id: 'call_1', name: 'sh', arguments: '{}' }] },
      { role: 'tool', call_id: 'call_1', output: 'ok' }
    ]
  });
  assert.equal(request.messages[0].content, 'Be brief.');
  assert.equal(request.messages[1].content, 'hi');
  assert.equal(request.messages[2].tool_calls[0].function.name, 'sh');
  assert.equal(request.messages[3].role, 'tool');
});

test('converts function tools', () => {
  const request = responsesToChatRequest({
    model: 'x',
    tools: [{ type: 'function', name: 'shell_command', description: 'run', parameters: { type: 'object' } }]
  });
  assert.equal(request.tools[0].function.name, 'shell_command');
});

test('textFromContent handles string and blocks', () => {
  assert.equal(textFromContent('abc'), 'abc');
  assert.equal(textFromContent([{ type: 'input_text', text: 'a' }, { type: 'output_text', text: 'b' }]), 'ab');
});

test('converts native Responses function items into Chat tool messages', () => {
  const request = responsesToChatRequest({
    model: 'deepseek-v4-flash',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'sh', arguments: '{}', status: 'completed', outputIndex: 1 },
      { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'ok', outputIndex: 2 },
      { type: 'reasoning', id: 'rs_1', summary: [] }
    ]
  });

  assert.deepEqual(request.messages, [
    { role: 'user', content: 'run it' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'sh', arguments: '{}' } }],
      reasoning_content: ''
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' }
  ]);
});


test('maps reasoning history to chat reasoning_content', () => {
  const request = responsesToChatRequest({
    model: 'deepseek-v4-flash',
    instructions: 'Be brief.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thinking hard' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }
    ]
  });
  const assistant = request.messages.find((m) => m.role === 'assistant' && m.content === 'answer');
  assert.equal(assistant.reasoning_content, 'thinking hard');
  assert.equal(assistant.content, 'answer');
});


test('maps reasoning to tool-call assistant for deepseek thinking mode', () => {
  const request = responsesToChatRequest({
    model: 'deepseek-v4-flash',
    instructions: 'Be brief.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'planning' }] },
      { type: 'function_call', call_id: 'call_1', name: 'sh', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
    ]
  });
  const assistant = request.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.reasoning_content, 'planning');
  assert.equal(assistant.tool_calls[0].function.name, 'sh');
});


test('tool-call assistant always carries reasoning_content for deepseek', () => {
  const request = responsesToChatRequest({
    model: 'deepseek-v4-flash',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'function_call', call_id: 'call_1', name: 'sh', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
    ]
  });
  const assistant = request.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.ok(assistant, 'expected tool-call assistant');
  assert.ok(Object.hasOwn(assistant, 'reasoning_content'), 'tool-call assistant must have reasoning_content');
});

