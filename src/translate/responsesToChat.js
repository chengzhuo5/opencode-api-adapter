import { inputItems } from './responsesContext.js';

export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') ? part.text ?? '' : '')
    .join('');
}

export function responsesToolsToChat(tools) {
  return (tools || [])
    .filter((tool) => tool?.type === 'function')
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} }
      }
    }));
}

export function responsesToChatRequest(body) {
  const messages = [];
  let pendingReasoning = '';
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  for (const item of inputItems(body.input)) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'reasoning') {
      pendingReasoning = (pendingReasoning || '') + reasoningText(item);
      continue;
    }
    if (item.type === 'function_call') {
      appendChatToolCall(messages, {
        id: item.call_id,
        type: 'function',
        function: { name: item.name || '', arguments: item.arguments || '' }
      }, pendingReasoning);
      pendingReasoning = '';
      continue;
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
      });
      continue;
    }
    const role = item.role || 'user';
    if (role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
      });
      continue;
    }
    if (role === 'assistant') {
      const toolCalls = (Array.isArray(item.content) ? item.content : [])
        .filter((part) => part?.type === 'function_call')
        .map((part) => ({
          id: part.call_id,
          type: 'function',
          function: { name: part.name, arguments: part.arguments || '' }
        }));
      const assistant = {
        role: 'assistant',
        content: textFromContent(item.content) || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      };
      if (pendingReasoning) {
        assistant.reasoning_content = pendingReasoning;
        pendingReasoning = '';
      }
      messages.push(assistant);
      continue;
    }
    messages.push({
      role: role === 'developer' ? 'system' : role,
      content: textFromContent(item.content)
    });
  }
  const request = {
    model: body.model,
    messages,
    stream: body.stream ?? false
  };
  const tools = responsesToolsToChat(body.tools);
  if (tools.length) request.tools = tools;
  if (body.tool_choice) request.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls !== undefined) request.parallel_tool_calls = body.parallel_tool_calls;
  if (body.max_output_tokens) request.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) request.temperature = body.temperature;
  return request;
}

function reasoningText(item) {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  return summary
    .map((part) => (part && typeof part === 'object' && part.type === 'summary_text' ? part.text : ''))
    .join('');
}


function appendChatToolCall(messages, toolCall, reasoning = '') {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    last.tool_calls = [...(last.tool_calls || []), toolCall];
    if (last.content === undefined) last.content = null;
    if (reasoning && !last.reasoning_content) last.reasoning_content = reasoning;
    return;
  }
  const assistant = { role: 'assistant', content: null, tool_calls: [toolCall] };
  assistant.reasoning_content = reasoning || '';
  messages.push(assistant);
}
