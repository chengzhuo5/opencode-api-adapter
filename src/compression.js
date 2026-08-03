import { logEvent } from './logger.js';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_CACHE_SIZE = 1000;

/**
 * 显式 CCR 取回方式
 * ------------------
 * 被压缩的 function_call_output 会被替换为：
 *
 *   output = "<压缩文本> [[ctx:<sha256>|<绝对路径>]]"
 *
 * 取回原文（二选一）：
 * 1) 本地文件：直接用 shell 读取标记里的 <绝对路径>（该文件是原始 function_call_output 的 JSON）：
 *      PowerShell: Get-Content -Raw "<绝对路径>"
 *      bash:       cat "<绝对路径>"
 * 2) HTTP（预留）：路由可扩展 GET /v1/ctx/<sha256>，按指纹返回原始 JSON。
 */

export function outputFingerprint(output) {
  return createHash('sha256').update(JSON.stringify(output)).digest('hex');
}

export function outputToMessages(output) {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return [{ role: 'user', content: text }];
}

export async function compressOutput({ output, model, client }) {
  const messages = outputToMessages(output);
  const result = await client.compress(messages, model);
  const text = result.messages?.[0]?.content;
  if (typeof text !== 'string') throw new Error('lean-ctx returned non-string compressed content');
  return { text, stats: result.stats || {} };
}

export function storeOutput(output, storeDir) {
  if (!storeDir) return null;
  const hash = outputFingerprint(output);
  mkdirSync(storeDir, { recursive: true });
  const file = path.join(storeDir, `${hash}.json`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(output));
  return file;
}

export async function compressInput(input, ctx) {
  const items = Array.isArray(input) ? input : [];
  const out = [];
  const meta = {
    outputs: [],
    overall: {
      chars_before: 0,
      chars_after: 0,
      outputs_total: 0,
      outputs_cached: 0,
      outputs_compressed: 0,
      saved_pct: 0
    }
  };
  ctx.meta = meta;
  for (const item of items) {
    if (!item || typeof item !== 'object' || item.type !== 'function_call_output') {
      out.push(item);
      continue;
    }
    const fingerprint = outputFingerprint(item);
    const charsBefore = JSON.stringify(item).length;
    let text = ctx.cache.get(fingerprint);
    let cached = true;
    if (text === undefined) {
      const result = await compressOutput({ output: item.output, model: ctx.model, client: ctx.client });
      text = result.text;
      ctx.cache.set(fingerprint, text);
      if (ctx.cache.size > (ctx.cacheSize ?? DEFAULT_CACHE_SIZE)) {
        const first = ctx.cache.keys().next().value;
        ctx.cache.delete(first);
      }
      cached = false;
    }
    const archiveFile = storeOutput(item, ctx.storeDir);
    const marker = archiveFile ? ` [[ctx:${fingerprint}|${archiveFile}]]` : '';
    const charsAfter = text.length;
    const savedPct = charsBefore > 0 ? Math.round((1 - charsAfter / charsBefore) * 100) : 0;
    meta.overall.chars_before += charsBefore;
    meta.overall.chars_after += charsAfter;
    if (cached) meta.overall.outputs_cached += 1;
    else meta.overall.outputs_compressed += 1;
    const textHash = createHash('sha256').update(text).digest('hex');
    meta.outputs.push({ fingerprint, cached, textHash, savedPct, charsBefore, charsAfter });
    ctx.log?.({
      event: 'context_compression',
      model: ctx.model,
      call_id: item.call_id,
      cached,
      chars_before: charsBefore,
      chars_after: charsAfter,
      saved_pct: savedPct
    });
    out.push({ ...item, output: `${text}${marker}` });
  }
  meta.overall.outputs_total = meta.outputs.length;
  meta.overall.saved_pct = meta.overall.chars_before > 0
    ? Math.round((1 - meta.overall.chars_after / meta.overall.chars_before) * 100)
    : 0;
  return out;
}

export async function maybeCompressInput(body, config, client, storeDir, cache, safetyMap) {
  if (!config?.compress?.enabled || config.compress.backend !== 'lean-ctx') return body;
  try {
    const ctx = { client, model: body.model, storeDir, cache, log: (e) => logEvent(config, e) };
    const input = await compressInput(body.input, ctx);
    const meta = ctx.meta;
    logEvent(config, {
      event: 'context_compression',
      model: body.model,
      ...meta.overall,
      reason: 'ok'
    });
    if (safetyMap) {
      const prev = safetyMap.get(body.model);
      const current = meta.outputs;
      let ok = true;
      let comparable = false;
      if (prev && prev.fingerprints.length > 0 && current.length >= prev.fingerprints.length) {
        comparable = true;
        for (let i = 0; i < prev.fingerprints.length; i++) {
          if (current[i].fingerprint !== prev.fingerprints[i]) { comparable = false; break; }
        }
        if (comparable) {
          for (let i = 0; i < prev.hashes.length; i++) {
            if (current[i].textHash !== prev.hashes[i]) { ok = false; break; }
          }
        }
      }
      safetyMap.set(body.model, { hashes: current.map((t) => t.textHash), fingerprints: current.map((t) => t.fingerprint) });
      logEvent(config, {
        event: 'cache_safety_check',
        model: body.model,
        ok,
        comparable,
        ...(ok ? {} : { reason: 'prefix_drift' })
      });
    }
    return { ...body, input };
  } catch {
    logEvent(config, { event: 'context_compression', model: body.model, reason: 'backend_unavailable' });
    return body;
  }
}
