import test from 'node:test';
import assert from 'node:assert/strict';
import { responsesToAnthropicRequest } from '../src/translate/responsesToAnthropic.js';

test('converts responses input to anthropic messages', () => {
  const request = responsesToAnthropicRequest({
    model: 'minimax-m3',
    instructions: 'Be brief.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'function_call', call_id: 'call_1', name: 'sh', arguments: '{}' }] },
      { role: 'tool', call_id: 'call_1', output: 'ok' }
    ]
  });
  assert.equal(request.system, 'Be brief.');
  assert.equal(request.messages[0].content[0].text, 'hi');
  assert.equal(request.messages[1].content[0].type, 'tool_use');
  assert.equal(request.messages[2].content[0].type, 'tool_result');
});

test('converts function tools to anthropic tools', () => {
  const request = responsesToAnthropicRequest({
    model: 'x',
    tools: [{ type: 'function', name: 'shell_command', description: 'run', parameters: { type: 'object' } }]
  });
  assert.equal(request.tools[0].name, 'shell_command');
  assert.equal(request.tools[0].input_schema.type, 'object');
});

test('converts native Responses function items into Anthropic tool blocks', () => {
  const request = responsesToAnthropicRequest({
    model: 'minimax-m3',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'sh', arguments: '{}', status: 'completed', outputIndex: 1 },
      { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'ok', outputIndex: 2 }
    ]
  });

  assert.deepEqual(request.messages, [
    { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'sh', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] }
  ]);
});
