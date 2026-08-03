import { textFromContent } from './responsesToChat.js';
import { inputItems } from './responsesContext.js';

export function responsesToolsToAnthropic(tools) {
  return (tools || [])
    .filter((tool) => tool?.type === 'function')
    .map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.parameters || { type: 'object', properties: {} }
    }));
}

export function responsesToAnthropicRequest(body) {
  const system = [];
  const messages = [];
  if (body.instructions) system.push({ type: 'text', text: body.instructions });
  for (const item of inputItems(body.input)) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: [{ type: 'text', text: item }] });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'reasoning') continue;
    if (item.type === 'function_call') {
      appendAnthropicToolUse(messages, {
        type: 'tool_use',
        id: item.call_id,
        name: item.name || '',
        input: safeJsonParse(item.arguments || '{}')
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      appendAnthropicToolResult(messages, {
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
      });
      continue;
    }
    const role = item.role || 'user';
    if (role === 'developer' || role === 'system') {
      const text = textFromContent(item.content);
      if (text) system.push({ type: 'text', text });
      continue;
    }
    if (role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
      };
      const last = messages[messages.length - 1];
      if (last?.role === 'user') last.content.push(block);
      else messages.push({ role: 'user', content: [block] });
      continue;
    }
    if (role === 'assistant') {
      const content = [];
      const text = textFromContent(item.content);
      if (text) content.push({ type: 'text', text });
      for (const part of item.content || []) {
        if (part?.type === 'function_call') {
          content.push({
            type: 'tool_use',
            id: part.call_id,
            name: part.name,
            input: safeJsonParse(part.arguments || '{}')
          });
        }
      }
      messages.push({ role: 'assistant', content });
      continue;
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: textFromContent(item.content) }] });
  }
  const request = {
    model: body.model,
    max_tokens: body.max_output_tokens || 8192,
    messages,
    stream: body.stream ?? false
  };
  if (system.length) request.system = system.length === 1 ? system[0].text : system;
  const tools = responsesToolsToAnthropic(body.tools);
  if (tools.length) request.tools = tools;
  if (body.tool_choice) request.tool_choice = body.tool_choice === 'required' ? { type: 'any' } : { type: 'auto' };
  return request;
}

function appendAnthropicToolUse(messages, block) {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    last.content.push(block);
    return;
  }
  messages.push({ role: 'assistant', content: [block] });
}

function appendAnthropicToolResult(messages, block) {
  const last = messages[messages.length - 1];
  if (last?.role === 'user') {
    last.content.push(block);
    return;
  }
  messages.push({ role: 'user', content: [block] });
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
