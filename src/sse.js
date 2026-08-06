export function parseSseEvent(part) {
  let event = 'message';
  const dataLines = [];
  for (const line of part.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export function sseEncode(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function* sseEvents(body, { signal } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const parsed = parseSseEvent(part);
        if (parsed) yield parsed;
      }
    }
    const parsed = parseSseEvent(buffer);
    if (parsed) yield parsed;
  } finally {
    if (signal?.aborted) {
      try { await reader.cancel(signal.reason); } catch { /* noop */ }
    }
    reader.releaseLock();
  }
}
import { readWithAbort } from './requestLifecycle.js';
