import { sseEvents } from '../sse.js';
import { newId } from './chatToResponses.js';

export function anthropicToResponsesObject(message, requestModel) {
  const output = [];
  for (const block of message.content || []) {
    if (block.type === 'text') {
      output.push({
        type: 'message',
        id: newId('msg'),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: block.text, annotations: [] }],
        logprobs: []
      });
    } else if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: newId('fc'),
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
        status: 'completed'
      });
    }
  }
  return {
    id: message.id || newId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: message.model || requestModel,
    output,
    error: null,
    incomplete_details: null,
    input_tokens: message.usage?.input_tokens ?? 0,
    output_tokens: message.usage?.output_tokens ?? 0,
    ...(message.usage ? { usage: message.usage } : {})
  };
}

export async function translateAnthropicStreamToResponses(body, requestModel, writeEvent, { signal } = {}) {
  const response = {
    id: newId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model: requestModel,
    output: [],
    error: null,
    incomplete_details: null,
    input_tokens: 0,
    output_tokens: 0
  };
  writeEvent('response.created', { type: 'response.created', response });
  writeEvent('response.in_progress', { type: 'response.in_progress', response });

  let currentItem = null;
  let currentIndex = -1;
  let currentText = '';

  try {
  for await (const { data } of sseEvents(body, { signal })) {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === 'message_delta' && event.usage && !response.usage) {
      response.usage = event.usage;
      response.input_tokens = event.usage.input_tokens ?? 0;
      response.output_tokens = event.usage.output_tokens ?? 0;
      continue;
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block.type === 'text') {
        currentItem = {
          id: newId('msg'),
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: []
        };
        currentIndex = response.output.length;
        response.output.push(currentItem);
        writeEvent('response.output_item.added', { type: 'response.output_item.added', output_index: currentIndex, item: currentItem });
        const part = { type: 'output_text', text: '', annotations: [] };
        writeEvent('response.content_part.added', { type: 'response.content_part.added', item_id: currentItem.id, output_index: currentIndex, content_index: 0, part });
      } else if (block.type === 'tool_use') {
        currentItem = {
          item: {
            id: newId('fc'),
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: '',
            status: 'in_progress'
          },
          outputIndex: response.output.length
        };
        currentIndex = currentItem.outputIndex;
        response.output.push(currentItem.item);
        writeEvent('response.output_item.added', { type: 'response.output_item.added', output_index: currentIndex, item: currentItem.item });
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta || {};
      if (delta.type === 'text_delta' && currentItem?.type === 'message') {
        currentText += delta.text || '';
        writeEvent('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: currentItem.id,
          output_index: currentIndex,
          content_index: 0,
          delta: delta.text
        });
      } else if (delta.type === 'input_json_delta' && currentItem?.item?.type === 'function_call') {
        currentItem.item.arguments += delta.partial_json || '';
        writeEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: currentItem.item.id,
          output_index: currentIndex,
          delta: delta.partial_json || ''
        });
      }
    } else if (event.type === 'content_block_stop' && currentItem) {
      if (currentItem.type === 'message') {
        const text = currentText;
        currentItem.content = [{ type: 'output_text', text, annotations: [] }];
        const part = { type: 'output_text', text, annotations: [] };
        writeEvent('response.output_text.done', { type: 'response.output_text.done', item_id: currentItem.id, output_index: currentIndex, content_index: 0, text });
        writeEvent('response.content_part.done', { type: 'response.content_part.done', item_id: currentItem.id, output_index: currentIndex, content_index: 0, part });
      } else {
        writeEvent('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: currentItem.item.id,
          output_index: currentIndex,
          arguments: currentItem.item.arguments
        });
      }
      const item = currentItem.item || currentItem;
      item.status = 'completed';
      writeEvent('response.output_item.done', { type: 'response.output_item.done', output_index: currentIndex, item });
      currentItem = null;
      currentText = '';
    }
  }
  } catch (error) {
    if (signal?.aborted) return false;
    response.status = 'failed';
    response.error = { code: 'upstream_error', message: (error?.message || 'stream failed').slice(0, 200) };
    writeEvent('response.failed', { type: 'response.failed', response });
    return false;
  }

  response.status = 'completed';
  writeEvent('response.completed', { type: 'response.completed', response });
  return true;
}
