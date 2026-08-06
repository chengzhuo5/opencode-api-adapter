export function inputItems(input) {
  if (Array.isArray(input)) return input;
  if (input === undefined || input === null) return [];
  return [input];
}

export function normalizeResponsesRequest(body) {
  const request = { ...body };
  if (body.input !== undefined) {
    request.input = sanitizeResponsesToolPairs(inputItems(body.input)
      .map(normalizeResponsesItem)
      .filter((item) => item !== null));
  }
  // The router cannot resolve a response created by another protocol. When the
  // full input is present, replay it instead of forwarding a stale provider ID.
  if (request.previous_response_id && request.input?.length) {
    delete request.previous_response_id;
  }
  return request;
}

function normalizeToolName(name) {
  if (typeof name !== 'string' || !name) return name;
  const match = /^(.+?)\1+$/.exec(name);
  return match ? match[1] : name;
}

function normalizeResponsesItem(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return null;

  if (item.type === 'message') {
    const role = item.role || 'user';
    const message = {
      type: 'message',
      // OpenCode Go's Responses endpoint rejects assistant history items and
      // output_text content blocks, so flatten assistant turns to user turns
      // and rewrite output parts as input parts when replaying across providers.
      role: role === 'assistant' ? 'user' : role
    };
    // Drop stored item ids when replaying: legacy Codex threads carry
    // `resp_..._msg` style ids that third-party endpoints reject (they expect
    // `msg_`/`fc_`/`fco_` prefixes), and a full replay never references them.
    if (item.content !== undefined) message.content = normalizeContent(item.content);
    return message;
  }

  if (item.type === 'function_call') {
    const call = {
      type: 'function_call',
      call_id: item.call_id,
      name: normalizeToolName(item.name || ''),
      arguments: item.arguments || ''
    };
    return call;
  }

  if (item.type === 'function_call_output') {
    const output = {
      type: 'function_call_output',
      call_id: item.call_id,
      output: item.output
    };
    return output;
  }

  // Old Codex threads store custom tools (e.g. apply_patch) as custom_tool_call
  // items with the payload in "input". Normalize them to standard function
  // items so third-party Responses endpoints and the chat fallback accept them.
  if (item.type === 'custom_tool_call') {
    const call = {
      type: 'function_call',
      call_id: item.call_id,
      name: normalizeToolName(item.name || ''),
      arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.input ?? {})
    };
    return call;
  }

  if (item.type === 'custom_tool_call_output') {
    const output = {
      type: 'function_call_output',
      call_id: item.call_id,
      output: item.output
    };
    return output;
  }

  // OpenAI-compatible Responses endpoints (including ergou relays) reject
  // `reasoning` as an input item and treat its id as a stored-item reference,
  // which 404s/400s when `store` is false. Reasoning is an output artifact, so
  // drop it when replaying history. The chat path maps it separately via
  // responsesToChatRequest.
  if (item.type === 'reasoning') return null;

  return stripInternalFields(item);
}

/**
 * Responses 直通路径不允许出现没有对应调用项的工具输出。
 * 旧会话里被中断/截断的工具轮次会留下孤立输出（例如 maxHistoryMessages 从一轮
 * 工具的中间切掉），ergou 等兼容端点会报
 * "function_call_output requires previous_response_id or item_reference ids
 * matching each call_id"，或 "No tool call found for tool search output"。
 * Codex 除 function/custom tools 外还会产生 tool_search、computer、MCP 等
 * `*_call` / `*_output` 项，因此统一按 call_id 配对；尚未收到输出应答的调用项
 * 保留，因为它可能仍待执行（chat 转 responses 的历史往返也依赖这一点）。
 */
export function sanitizeResponsesToolPairs(items) {
  const callIds = new Set();
  for (const item of items) {
    if (isToolCallItem(item) && item.call_id) {
      callIds.add(item.call_id);
    }
  }
  return items.filter((item) => (
    !isToolOutputItem(item)
    || (item.call_id && callIds.has(item.call_id))
  ));
}

function isToolCallItem(item) {
  if (!item || typeof item !== 'object' || typeof item.type !== 'string') return false;
  return item.type === 'function_call'
    || item.type === 'custom_tool_call'
    || item.type.endsWith('_call');
}

function isToolOutputItem(item) {
  if (!item || typeof item !== 'object' || typeof item.type !== 'string') return false;
  return item.type === 'function_call_output'
    || item.type === 'custom_tool_call_output'
    || item.type.endsWith('_output');
}

function normalizeContent(content) {
  if (!Array.isArray(content)) return stripInternalFields(content);
  return content.map((part) => {
    if (part && typeof part === 'object' && part.type === 'output_text') {
      return { type: 'input_text', text: part.text ?? '' };
    }
    return stripInternalFields(part);
  });
}

function stripInternalFields(value) {
  if (Array.isArray(value)) return value.map(stripInternalFields);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'outputIndex' || key === 'output_index') continue;
    result[key] = stripInternalFields(child);
  }
  return result;
}
