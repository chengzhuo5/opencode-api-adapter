/**
 * 非流式上游回放：路由向上游发 stream:false 拿到完整 response 对象后，
 * 把它回放成标准 SSE 事件序列给 Codex（客户端仍以为自己在用流式）。
 * 好处：响应字段完全可控、可在转发前重试/校验，杜绝半截 completed 事件。
 */
export function replayResponsesAsSse(response, writeEvent) {
  writeEvent('response.created', { type: 'response.created', response });
  writeEvent('response.in_progress', { type: 'response.in_progress', response });
  let outputIndex = 0;
  for (const rawItem of response.output || []) {
    const item = { ...rawItem, status: 'completed' };
    writeEvent('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item });
    if (item.type === 'reasoning') {
      const text = (item.summary || []).map((s) => s?.text || '').join('');
      writeEvent('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        item_id: item.id,
        output_index: outputIndex,
        summary_index: 0,
        text
      });
    } else if (item.type === 'message') {
      const text = (Array.isArray(item.content) ? item.content : []).map((p) => p?.text || '').join('');
      const part = { type: 'output_text', text, annotations: [] };
      writeEvent('response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: 0, part });
      writeEvent('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: outputIndex, content_index: 0, delta: text });
      writeEvent('response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: outputIndex, content_index: 0, text });
      writeEvent('response.content_part.done', { type: 'response.content_part.done', item_id: item.id, output_index: outputIndex, content_index: 0, part });
    } else if (item.type === 'function_call') {
      writeEvent('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments || ''
      });
    }
    writeEvent('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
    outputIndex += 1;
  }
  writeEvent('response.completed', { type: 'response.completed', response });
}
