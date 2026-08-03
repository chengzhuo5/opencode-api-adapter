export function inputItems(input) {
  if (Array.isArray(input)) return input;
  if (input === undefined || input === null) return [];
  return [input];
}

export function normalizeResponsesRequest(body) {
  const request = { ...body };
  if (body.input !== undefined) {
    request.input = inputItems(body.input)
      .map(normalizeResponsesItem)
      .filter((item) => item !== null);
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
    copyIfPresent(message, item, 'id');
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
    copyIfPresent(call, item, 'id');
    return call;
  }

  if (item.type === 'function_call_output') {
    const output = {
      type: 'function_call_output',
      call_id: item.call_id,
      output: item.output
    };
    copyIfPresent(output, item, 'id');
    return output;
  }

  if (item.type === 'reasoning') {
    const reasoning = { type: 'reasoning' };
    copyIfPresent(reasoning, item, 'id');
    copyIfPresent(reasoning, item, 'summary');
    copyIfPresent(reasoning, item, 'encrypted_content');
    return reasoning;
  }

  return stripInternalFields(item);
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

function copyIfPresent(target, source, key) {
  if (source[key] !== undefined) target[key] = stripInternalFields(source[key]);
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
