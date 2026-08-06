import { randomUUID } from 'node:crypto';
import { sseEvents } from '../sse.js';

export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function tokensFromUsage(usage) {
  return {
    input_tokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? usage?.output_tokens ?? 0
  };
}

export function chatToResponsesObject(chat, requestModel) {
  const choice = chat.choices?.[0] || {};
  const message = choice.message || {};
  const text = typeof message.content === 'string' ? message.content : '';
  const output = [];
  if (text) {
    output.push({
      type: 'message',
      id: newId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
      logprobs: []
    });
  }
  for (const toolCall of message.tool_calls || []) {
    const toolName = toolCall.function?.name || '';
    if (toolName === 'apply_patch') {
      // Codex 的 apply_patch 是 freeform 工具：请求方向以 custom_tool_call 发出，
      // chat/completions 把 input JSON 转义进 function.arguments。
      // 必须还原成 custom_tool_call（input 反转义），否则 Codex handler 报
      // "apply_patch invoked with incompatible payload"。
      let raw = toolCall.function?.arguments || '';
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') raw = parsed;
      } catch { /* 不是 JSON 转义，保持原样 */ }
      output.push({
        type: 'custom_tool_call',
        id: newId('ctc'),
        call_id: toolCall.id,
        name: toolName,
        input: raw,
        status: 'completed'
      });
    } else {
      output.push({
        type: 'function_call',
        id: newId('fc'),
        call_id: toolCall.id,
        name: toolName,
        arguments: toolCall.function?.arguments || '',
        status: 'completed'
      });
    }
  }
  return {
    id: chat.id || newId('resp'),
    object: 'response',
    created_at: chat.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model: chat.model || requestModel,
    output,
    error: null,
    incomplete_details: null,
    input_tokens: tokensFromUsage(chat.usage).input_tokens,
    output_tokens: tokensFromUsage(chat.usage).output_tokens,
    ...(chat.usage ? { usage: chat.usage } : {})
  };
}

export async function translateChatStreamToResponses(body, requestModel, writeEvent) {
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

  let text = '';
  let reasoningText = '';
  let reasoningItem = null;
  let reasoningIndex = -1;
  let messageItem = null;
  let messageIndex = -1;
  const toolItems = new Map();

  try {
  for await (const { data } of sseEvents(body)) {
    if (data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const delta = chunk.choices?.[0]?.delta || {};
    // OpenAI chat 流式在最后一个 chunk 携带 usage；透传给客户端用于上下文统计
    if (chunk.usage && !response.usage) {
      response.usage = chunk.usage;
      const tokens = tokensFromUsage(chunk.usage);
      response.input_tokens = tokens.input_tokens;
      response.output_tokens = tokens.output_tokens;
    }
    if (delta.reasoning_content) {
      if (!reasoningItem) {
        reasoningItem = {
          id: newId('rs'),
          type: 'reasoning',
          status: 'in_progress',
          summary: []
        };
        reasoningIndex = response.output.length;
        response.output.push(reasoningItem);
        writeEvent('response.output_item.added', { type: 'response.output_item.added', output_index: reasoningIndex, item: reasoningItem });
      }
      reasoningText += delta.reasoning_content;
      reasoningItem.summary = [{ type: 'summary_text', text: reasoningText }];
      writeEvent('response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        item_id: reasoningItem.id,
        output_index: reasoningIndex,
        summary_index: 0,
        delta: delta.reasoning_content
      });
    }
    if (delta.content) {
      if (!messageItem) {
        messageItem = {
          id: newId('msg'),
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: []
        };
        messageIndex = response.output.length;
        response.output.push(messageItem);
        writeEvent('response.output_item.added', { type: 'response.output_item.added', output_index: messageIndex, item: messageItem });
        const part = { type: 'output_text', text: '', annotations: [] };
        writeEvent('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: messageItem.id,
          output_index: messageIndex,
          content_index: 0,
          part
        });
      }
      text += delta.content;
      writeEvent('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: messageItem.id,
        output_index: messageIndex,
        content_index: 0,
        delta: delta.content
      });
    }
    for (const toolCall of delta.tool_calls || []) {
      let item = toolItems.get(toolCall.index);
      if (!item) {
        const outputIndex = response.output.length;
        item = {
          item: {
            id: newId('fc'),
            type: 'function_call',
            call_id: toolCall.id || newId('call'),
            name: toolCall.function?.name || '',
            arguments: '',
            status: 'in_progress'
          },
          outputIndex
        };
        toolItems.set(toolCall.index, item);
        response.output.push(item.item);
        writeEvent('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: item.item });
      }
      if (toolCall.function?.name && !item.item.name) item.item.name = toolCall.function.name;
      if (toolCall.function?.arguments) {
        item.item.arguments += toolCall.function.arguments;
        writeEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: item.item.id,
          output_index: item.outputIndex,
          delta: toolCall.function.arguments
        });
      }
    }
  }

  if (reasoningItem) {
    reasoningItem.status = 'completed';
    writeEvent('response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done',
      item_id: reasoningItem.id,
      output_index: reasoningIndex,
      summary_index: 0,
      text: reasoningText
    });
    writeEvent('response.output_item.done', { type: 'response.output_item.done', output_index: reasoningIndex, item: reasoningItem });
  }
  } catch (error) {
    response.status = 'failed';
    response.error = { code: 'upstream_error', message: (error?.message || 'stream failed').slice(0, 200) };
    writeEvent('response.failed', { type: 'response.failed', response });
    return false;
  }

  if (messageItem) {
    const part = { type: 'output_text', text, annotations: [] };
    messageItem.content = [part];
    writeEvent('response.output_text.done', { type: 'response.output_text.done', item_id: messageItem.id, output_index: messageIndex, content_index: 0, text });
    writeEvent('response.content_part.done', { type: 'response.content_part.done', item_id: messageItem.id, output_index: messageIndex, content_index: 0, part });
    messageItem.status = 'completed';
    writeEvent('response.output_item.done', { type: 'response.output_item.done', output_index: messageIndex, item: messageItem });
  }
  for (const { item, outputIndex } of toolItems.values()) {
    if (item.name === 'apply_patch') {
      // 流式路径同样需要把 apply_patch 还原为 custom_tool_call，
      // 否则 Codex handler 报 "apply_patch invoked with incompatible payload"。
      let raw = item.arguments || '';
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') raw = parsed;
      } catch { /* 不是 JSON 转义，保持原样 */ }
      item.type = 'custom_tool_call';
      item.input = raw;
      delete item.arguments;
      writeEvent('response.custom_tool_call.done', {
        type: 'response.custom_tool_call.done',
        item_id: item.id,
        output_index: outputIndex,
        input: raw
      });
      item.status = 'completed';
      writeEvent('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
    } else {
      writeEvent('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments
      });
      item.status = 'completed';
      writeEvent('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
    }
  }

  response.status = 'completed';
  writeEvent('response.completed', { type: 'response.completed', response });
  return true;
}
