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
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const fingerprint = turnFingerprint(turn);
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
      chars_before: JSON.stringify(turn).length,
      chars_after: text.length
    });
  }
  return compressed;
}

