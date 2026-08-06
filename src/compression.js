import { logEvent } from './logger.js';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_CACHE_SIZE = 1000;
const CHECKPOINT_VERSION = 1;

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

/**
 * 粗略 token 估算（用于统计，不参与任何缓存/计费逻辑）：
 * - CJK 字符按 1 token/字；
 * - 其余字符按 4 字符 ≈ 1 token（向上取整）。
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) cjk += 1;
  }
  const nonCjk = s.length - cjk;
  return cjk + Math.ceil(nonCjk / 4);
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

function checkpointPath(hash, storeDir) {
  return storeDir ? path.join(storeDir, `${hash}.checkpoint.json`) : null;
}

export function loadCompressionCheckpoint(hash, storeDir) {
  if (!storeDir || !/^[a-f0-9]{64}$/.test(String(hash ?? ''))) return null;
  const file = checkpointPath(hash, storeDir);
  if (!existsSync(file)) return null;
  try {
    const checkpoint = JSON.parse(readFileSync(file, 'utf8'));
    if (checkpoint?.version !== CHECKPOINT_VERSION || typeof checkpoint.text !== 'string') return null;
    return checkpoint.text;
  } catch {
    return null;
  }
}

function storeCompressionCheckpoint(hash, text, storeDir) {
  if (!storeDir) return null;
  mkdirSync(storeDir, { recursive: true });
  const file = checkpointPath(hash, storeDir);
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify({
      version: CHECKPOINT_VERSION,
      checkpoint_id: hash,
      text
    }));
  }
  return file;
}

/**
 * HTTP 取回（GET /v1/ctx/<sha256>）：
 * 按存档指纹返回原始 function_call_output JSON；哈希非法或文件不存在时返回 null。
 */
export function loadOutput(hash, storeDir) {
  if (!storeDir || !/^[a-f0-9]{64}$/.test(String(hash ?? ''))) return null;
  const file = path.join(storeDir, `${hash}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export async function compressInput(input, ctx) {
  const items = Array.isArray(input) ? input : [];
  const out = [];
  const meta = {
    outputs: [],
    overall: {
      chars_before: 0,
      chars_after: 0,
      tokens_before: 0,
      tokens_after: 0,
      tokens_saved: 0,
      outputs_total: 0,
      outputs_cached: 0,
      outputs_compressed: 0,
      outputs_skipped: 0,
      checkpoint_id: null,
      checkpoint_reused: null,
      prefix_changed: null,
      saved_pct: 0
    }
  };
  ctx.meta = meta;
  for (const item of items) {
    if (!item || typeof item !== 'object' || item.type !== 'function_call_output') {
      out.push(item);
      continue;
    }
    if (Array.isArray(item.output)) {
      // 多模态工具输出（图片块数组）：原样透传，不压缩，避免破坏图片内容
      out.push(item);
      continue;
    }
    const fingerprint = outputFingerprint(item);
    const charsBefore = JSON.stringify(item).length;
    const tokensBefore = estimateTokens(JSON.stringify(item));
    if (tokensBefore < (ctx.minOutputTokens ?? 0)) {
      meta.overall.outputs_skipped += 1;
      out.push(item);
      continue;
    }
    let text = ctx.cache.get(fingerprint);
    let checkpointSource = text === undefined
      ? null
      : (typeof text?.then === 'function' ? 'inflight' : 'memory');
    if (typeof text?.then === 'function') text = await text;
    if (text === undefined) {
      text = loadCompressionCheckpoint(fingerprint, ctx.storeDir);
      if (text !== null) {
        ctx.cache.set(fingerprint, text);
        checkpointSource = 'disk';
      } else {
        text = undefined;
      }
    }
    let cached = text !== undefined;
    if (text === undefined) {
      const pending = compressOutput({ output: item.output, model: ctx.model, client: ctx.client })
        .then((result) => {
          ctx.cache.set(fingerprint, result.text);
          storeCompressionCheckpoint(fingerprint, result.text, ctx.storeDir);
          return result.text;
        })
        .catch((error) => {
          if (ctx.cache.get(fingerprint) === pending) ctx.cache.delete(fingerprint);
          throw error;
        });
      ctx.cache.set(fingerprint, pending);
      text = await pending;
      if (ctx.cache.size > (ctx.cacheSize ?? DEFAULT_CACHE_SIZE)) {
        const first = ctx.cache.keys().next().value;
        ctx.cache.delete(first);
      }
      cached = false;
      checkpointSource = 'generated';
    }
    const archiveFile = storeOutput(item, ctx.storeDir);
    const marker = archiveFile ? ` [[ctx:${fingerprint}|${archiveFile}]]` : '';
    const charsAfter = text.length;
    const tokensAfter = estimateTokens(text);
    const savedPct = charsBefore > 0 ? Math.round((1 - charsAfter / charsBefore) * 100) : 0;
    meta.overall.chars_before += charsBefore;
    meta.overall.chars_after += charsAfter;
    meta.overall.tokens_before += tokensBefore;
    meta.overall.tokens_after += tokensAfter;
    if (cached) meta.overall.outputs_cached += 1;
    else meta.overall.outputs_compressed += 1;
    const textHash = createHash('sha256').update(text).digest('hex');
    meta.outputs.push({
      fingerprint,
      cached,
      checkpointId: fingerprint,
      checkpointReused: cached,
      checkpointSource,
      textHash,
      savedPct,
      charsBefore,
      charsAfter,
      tokensBefore,
      tokensAfter
    });
    if (!cached) {
      ctx.log?.({
        event: 'context_compression',
        model: ctx.model,
        call_id: item.call_id,
        cached,
        chars_before: charsBefore,
        chars_after: charsAfter,
        tokens_before: tokensBefore,
        tokens_after: tokensAfter,
        tokens_saved: tokensBefore - tokensAfter,
        saved_pct: savedPct
      });
    }
    out.push({ ...item, output: `${text}${marker}` });
  }
  meta.overall.outputs_total = meta.outputs.length;
  meta.overall.tokens_saved = meta.overall.tokens_before - meta.overall.tokens_after;
  if (meta.outputs.length) {
    meta.overall.checkpoint_id = createHash('sha256')
      .update(meta.outputs.map((output) => `${output.fingerprint}:${output.textHash}`).join('\n'))
      .digest('hex');
    meta.overall.checkpoint_reused = meta.outputs.every((output) => output.checkpointReused);
  }
  meta.overall.saved_pct = meta.overall.chars_before > 0
    ? Math.round((1 - meta.overall.chars_after / meta.overall.chars_before) * 100)
    : 0;
  return out;
}

export async function maybeCompressInput(body, config, client, storeDir, cache, safetyMap, stats, options = {}) {
  if (!config?.compress?.enabled || config.compress.backend !== 'lean-ctx') return body;
  try {
    const ctx = {
      client,
      model: body.model,
      storeDir,
      cache,
      cacheSize: config.compress.cacheSize,
      minOutputTokens: config.compress.minOutputTokens,
      log: (e) => logEvent(config, e)
    };
    const input = await compressInput(body.input, ctx);
    const meta = ctx.meta;
    if (stats) {
      stats.total_chars_before += meta.overall.chars_before;
      stats.total_chars_after += meta.overall.chars_after;
      stats.total_tokens_before += meta.overall.tokens_before;
      stats.total_tokens_after += meta.overall.tokens_after;
      stats.requests += 1;
    }
    logEvent(config, {
      event: 'context_compression',
      model: body.model,
      ...meta.overall,
      total_chars_before: stats?.total_chars_before ?? 0,
      total_chars_after: stats?.total_chars_after ?? 0,
      total_tokens_before: stats?.total_tokens_before ?? 0,
      total_tokens_after: stats?.total_tokens_after ?? 0,
      total_tokens_saved: stats ? stats.total_tokens_before - stats.total_tokens_after : 0,
      total_saved_pct: stats && stats.total_tokens_before > 0
        ? Math.round((1 - stats.total_tokens_after / stats.total_tokens_before) * 100)
        : 0,
      reason: 'ok'
    });
    if (safetyMap) {
      const safetyKey = `${body.model}::${options.safetyKey || 'unscoped'}`;
      const prev = safetyMap.get(safetyKey);
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
      safetyMap.set(safetyKey, {
        hashes: current.map((t) => t.textHash),
        fingerprints: current.map((t) => t.fingerprint)
      });
      meta.overall.prefix_changed = comparable ? !ok : null;
      if (config.compress.logLevel !== 'quiet') {
        logEvent(config, {
          event: 'cache_safety_check',
          model: body.model,
          ok,
          comparable,
          ...(ok ? {} : { reason: 'prefix_drift' })
        });
      }
    }
    options.onMeta?.(meta.overall);
    return { ...body, input };
  } catch {
    logEvent(config, { event: 'context_compression', model: body.model, reason: 'backend_unavailable' });
    return body;
  }
}
