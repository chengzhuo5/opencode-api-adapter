// 长上下文压缩试验（真实 lean-ctx daemon）
// 用法: node scripts/long-context-experiment.mjs [--rounds 6] [--base http://127.0.0.1:4444]
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLeanCtxClient } from '../src/leanCtxClient.js';
import { maybeCompressInput } from '../src/compression.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const ROUNDS = Number(arg('--rounds', '6'));
const BASE = arg('--base', 'http://127.0.0.1:4444');
const LINES = 300;

function makeTurn(i) {
  const userText = `任务 ${i}：读取并汇总以下日志，找出错误并给出修复建议。${'x'.repeat(300)}`;
  const outputLines = Array.from({ length: LINES }, (_, j) => `[${i}-${j}] module=worker line=${j} level=info msg=${'y'.repeat(60)}`);
  return {
    user: { type: 'message', role: 'user', id: `u${i}`, content: [{ type: 'input_text', text: userText }] },
    assistant: { type: 'message', role: 'assistant', id: `a${i}`, content: [{ type: 'output_text', text: `第 ${i} 轮已处理`, annotations: [] }] },
    call: { type: 'function_call', id: `fc${i}`, call_id: `c${i}`, name: 'shell_command', arguments: '{}' },
    output: { type: 'function_call_output', id: `fco${i}`, call_id: `c${i}`, output: outputLines.join('\n') }
  };
}

const turns = Array.from({ length: ROUNDS }, (_, i) => makeTurn(i));
const client = createLeanCtxClient({ baseUrl: BASE, token: '', timeoutMs: 30000 });
const storeDir = mkdtempSync(path.join(os.tmpdir(), 'ctx-exp-'));
const cache = new Map();
const safety = new Map();
const logs = [];
const config = {
  compress: { enabled: true, backend: 'lean-ctx', storeDir },
  logger: (e) => logs.push(e)
};

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL'), name, extra);
  if (!ok) failures += 1;
};

for (let k = 1; k <= ROUNDS; k++) {
  const input = [];
  for (let i = 0; i < k; i++) input.push(turns[i].user, turns[i].assistant, turns[i].call, turns[i].output);
  const body = { model: 'deepseek-v4-flash', input };
  const result = await maybeCompressInput(body, config, client, storeDir, cache, safety);
  const meta = { outputs: [], overall: { outputs_total: 0, outputs_compressed: 0, outputs_cached: 0, saved_pct: 0 } };
  // maybeCompressInput 通过 logEvent 记录 context_compression；直接从日志恢复统计
  const agg = logs.filter((e) => e.event === 'context_compression' && e.reason === 'ok').pop();
  const per = logs.filter((e) => e.event === 'context_compression' && e.reason === undefined);
  const safetyLog = logs.filter((e) => e.event === 'cache_safety_check').pop();
  console.log(`\n--- 第 ${k} 次请求（${k} 轮） ---`);
  console.log('整体统计:', JSON.stringify({ ...agg }));
  console.log('缓存安全:', safetyLog ? JSON.stringify({ ok: safetyLog.ok, ...(safetyLog.reason ? { reason: safetyLog.reason } : {}) }) : 'N/A');

  // 校验：用户/助手消息保持原文
  const compressedOut = result.input;
  for (let i = 0; i < k; i++) {
    const u = compressedOut.find((x) => x.id === turns[i].user.id);
    const a = compressedOut.find((x) => x.id === turns[i].assistant.id);
    if (!u || !a || u.content[0].text !== turns[i].user.content[0].text || a.content[0].text !== turns[i].assistant.content[0].text) {
      check(`轮 ${i} 指令/回复原文保留`, false);
    }
  }
  // 校验：工具输出被压缩且带 CCR 标记
  let outputOk = true;
  for (let i = 0; i < k; i++) {
    const o = compressedOut.find((x) => x.id === turns[i].output.id);
    if (!o || !/^[\s\S]+ \[\[ctx:[a-f0-9]{64}\|.+\]\]$/.test(o.output)) outputOk = false;
  }
  check(`第 ${k} 次：全部 ${k} 个工具输出已压缩并带 CCR 标记`, outputOk);

  // 校验：非工具消息数量 = 3k，工具输出数量 = k
  const msgs = compressedOut.filter((x) => x.type === 'message').length;
  const outs = compressedOut.filter((x) => x.type === 'function_call_output').length;
  check(`第 ${k} 次：结构完整（message=${msgs} 含工具输出 ${outs}）`, msgs === 2 * k && outs === k);

  if (k >= 2) {
    // 增量缓存：本次请求中旧轮次应命中
    check(`第 ${k} 次：旧轮次工具输出缓存命中（cached=${agg.outputs_cached}）`, agg.outputs_cached >= k - 1, `期望 >= ${k - 1}`);
    // 前缀稳定
    check(`第 ${k} 次：cache_safety_check ok`, safetyLog?.ok === true, safetyLog?.reason ?? '');
  }
}

// CCR 取回验证：取第一个标记的绝对路径，读回原文
const firstOut = (await maybeCompressInput(
  { model: 'deepseek-v4-flash', input: [turns[0].output] },
  config, client, storeDir, new Map(), new Map()
)).input[0];
const marker = firstOut.output.match(/\[\[ctx:([a-f0-9]{64})\|(.+)\]\]/);
if (marker && existsSync(marker[2])) {
  const archived = JSON.parse(readFileSync(marker[2], 'utf8'));
  check('CCR 取回：存档文件存在且内容与原始工具输出一致', archived.id === turns[0].output.id && archived.output === turns[0].output.output);
} else {
  check('CCR 取回：标记可解析且文件存在', false);
}

console.log(`\n总轮数: ${ROUNDS}，工具输出行数/轮: ${LINES}，storeDir: ${storeDir}`);
console.log(failures === 0 ? '\n试验全部通过' : `\n试验失败项: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
