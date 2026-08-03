import { logEvent } from './logger.js';
import { createHash } from 'node:crypto';

export function splitTurns(input) {
  const items = Array.isArray(input) ? input : [];
  const prefix = [];
  const turns = [];
  let pending = [];
  let sawUser = false;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const isUser = item.type === 'message' && item.role === 'user';
    if (isUser) {
      if (sawUser) {
        turns.push([...pending, item]);
      } else {
        sawUser = true;
        if (pending.length) prefix.push(...pending);
        turns.push([item]);
      }
      pending = [];
      continue;
    }
    if (sawUser) {
      // assistant/tool 输出归入下一个 user 轮次，保持已压缩轮次稳定
      pending.push(item);
    } else {
      prefix.push(item);
    }
  }
  if (pending.length && turns.length) turns[turns.length - 1].push(...pending);
  return { prefix, turns };
}

export function turnFingerprint(turn) {
  return createHash('sha256').update(JSON.stringify(turn)).digest('hex');
}

export function turnToMessages(turn) {
  const parts = [];
  for (const item of turn) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      const text = (Array.isArray(item.content) ? item.content : [])
        .map((p) => (p && typeof p === 'object' ? p.text ?? '' : ''))
        .join('\n');
      if (text) parts.push(item.role === 'user' ? `user: ${text}` : `assistant: ${text}`);
    } else if (item.type === 'function_call') {
      parts.push(`tool_call ${item.name}: ${item.arguments || ''}`);
    } else if (item.type === 'function_call_output') {
      parts.push(`tool_output: ${typeof item.output === 'string' ? item.output : JSON.stringify(item.output)}`);
    }
  }
  return [{ role: 'user', content: parts.join('\n') || '[empty turn]' }];
}

export async function compressTurn({ turn, model, client }) {
  const messages = turnToMessages(turn);
  const result = await client.compress(messages, model);
  const text = result.messages?.[0]?.content;
  if (typeof text !== 'string') throw new Error('lean-ctx returned non-string compressed content');
  return { text, stats: result.stats || {} };
}

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_CACHE_SIZE = 1000;

export function storeTurn(turn, storeDir) {
  if (!storeDir) return null;
  const hash = turnFingerprint(turn);
  mkdirSync(storeDir, { recursive: true });
  const file = path.join(storeDir, `${hash}.json`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(turn));
  return file;
}

export async function compressInput(input, ctx) {
  const { prefix, turns } = splitTurns(input);
  const compressed = [...prefix];
  const meta = { turns: [], overall: { chars_before: 0, chars_after: 0, turns_total: turns.length, turns_cached: 0, turns_compressed: 0, saved_pct: 0 } };
  ctx.meta = meta;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const fingerprint = turnFingerprint(turn);
    const charsBefore = JSON.stringify(turn).length;
    let text = ctx.cache.get(fingerprint);
    let cached = true;
    if (text === undefined) {
      const result = await compressTurn({ turn, model: ctx.model, client: ctx.client });
      text = result.text;
      ctx.cache.set(fingerprint, text);
      if (ctx.cache.size > (ctx.cacheSize ?? DEFAULT_CACHE_SIZE)) {
        const first = ctx.cache.keys().next().value;
        ctx.cache.delete(first);
      }
      cached = false;
    }
    const charsAfter = text.length;
    const savedPct = charsBefore > 0 ? Math.round((1 - charsAfter / charsBefore) * 100) : 0;
    meta.overall.chars_before += charsBefore;
    meta.overall.chars_after += charsAfter;
    if (cached) meta.overall.turns_cached += 1;
    else meta.overall.turns_compressed += 1;
    const textHash = createHash('sha256').update(text).digest('hex');
    meta.turns.push({ fingerprint, cached, textHash, savedPct, charsBefore, charsAfter });
    const archiveFile = storeTurn(turn, ctx.storeDir);
    const marker = archiveFile ? ` [[ctx:${fingerprint}|${archiveFile}]]` : '';
    compressed.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `[compressed turn #${i + 1}] ${text}${marker}` }]
    });
    ctx.log?.({
      event: 'context_compression',
      model: ctx.model,
      turn_index: i + 1,
      cached,
      chars_before: charsBefore,
      chars_after: charsAfter,
      saved_pct: savedPct
    });
  }
  meta.overall.saved_pct = meta.overall.chars_before > 0
    ? Math.round((1 - meta.overall.chars_after / meta.overall.chars_before) * 100)
    : 0;
  return compressed;
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
      const current = meta.turns;
      let ok = true;
      if (prev && prev.hashes.length > 0 && current.length >= prev.hashes.length) {
        for (let i = 0; i < prev.hashes.length; i++) {
          if (current[i].textHash !== prev.hashes[i]) { ok = false; break; }
        }
      }
      safetyMap.set(body.model, { hashes: current.map((t) => t.textHash), fingerprints: current.map((t) => t.fingerprint) });
      logEvent(config, {
        event: 'cache_safety_check',
        model: body.model,
        ok,
        ...(ok ? {} : { reason: 'prefix_drift' })
      });
    }
    return { ...body, input };
  } catch {
    logEvent(config, { event: 'context_compression', model: body.model, reason: 'backend_unavailable' });
    return body;
  }
}

