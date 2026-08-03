
import { once } from 'node:events';
import { createRouter } from '../src/server.js';

const MODELS = { gpt: 'gpt-5.6-luna', deepseek: 'deepseek-v4-flash' };
const TOOL_NAME = 'shell_command';

export function chatCompletion(toolCall) {
  const message = { role: 'assistant', content: 'done' };
  if (toolCall) message.tool_calls = [{ id: 'call_1', type: 'function', function: { name: toolCall, arguments: '{}' } }];
  return JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'deepseek-v4-flash', choices: [{ message }] });
}

export async function startRouter(apiBaseUrl, apiKey, fetchImpl) {
  const config = { apiKey, apiBaseUrl, models: {}, timeouts: { requestMs: 120000 } };
  const server = createRouter(config, fetchImpl ? { fetchImpl } : {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

export async function request(base, model, input, stream = false) {
  const r = await fetch(base + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, instructions: 'You are a test agent.', input, stream, max_output_tokens: 8, store: false })
  });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch { d = { raw: text.slice(0, 200) }; }
  return { status: r.status, data: d };
}

export function assertNoInvalid(label, r) {
  const err = r.data?.error ? JSON.stringify(r.data.error) : '';
  if (/invalid_prompt/i.test(err)) throw new Error(label + ' got invalid_prompt: ' + err);
  if (/invalid_request_error/i.test(err)) throw new Error(label + ' got invalid_request_error: ' + err);
  console.log('PASS', label, 'status=' + r.status, r.data?.error ? 'error=' + (r.data.error.code || '') : 'ok');
}

export function reasoningItem(id, text) {
  return { type: 'reasoning', id, summary: [{ type: 'summary_text', text }] };
}

export function toolCallItem(id, callId, name) {
  return { type: 'function_call', id, call_id: callId, name, arguments: '{}' };
}

export function toolOutputItem(id, callId, output) {
  return { type: 'function_call_output', id, call_id: callId, output };
}

export function assistantItem(id, text) {
  return { type: 'message', role: 'assistant', id, phase: 'final', content: [{ type: 'output_text', text, annotations: [] }] };
}


async function main() {
  const isMock = process.argv.includes('--mock');
  const baseArgIndex = process.argv.indexOf('--base');
  const base = baseArgIndex >= 0 ? process.argv[baseArgIndex + 1] : null;
  const useLive = base !== null;
  const router = useLive ? null : await startRouter('https://opencode.ai/zen/go/v1', process.env.OPENCODE_GO_API_KEY, isMock ? async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'responses unavailable' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(chatCompletion(TOOL_NAME), { status: 200, headers: { 'content-type': 'application/json' } });
  } : undefined);
  const target = useLive ? base : router.base;
  const history = [{ type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'hello' }] }];
  try {
    let r = await request(target, MODELS.deepseek, history, true); assertNoInvalid('hop1 deepseek', r);
    history.push(toolCallItem('fc1', 'call_1', TOOL_NAME));
    history.push(toolOutputItem('fco1', 'call_1', 'ok'));
    r = await request(target, MODELS.gpt, history); assertNoInvalid('hop2 gpt', r);
    history.push(reasoningItem('rs1', 'thinking'));
    history.push(assistantItem('a1', 'done'));
    r = await request(target, MODELS.deepseek, history, true); assertNoInvalid('hop3 deepseek', r);
    history.push(reasoningItem('rs2', 'more thinking'));
    history.push(assistantItem('a2', 'done again'));
    r = await request(target, MODELS.gpt, history); assertNoInvalid('hop4 gpt', r);
    console.log((useLive ? 'live' : isMock ? 'mock' : 'live-default') + ' OK: DeepSeek->GPT->DeepSeek->GPT no invalid');
  } finally {
    if (router) router.close();
  }
}
await main();
