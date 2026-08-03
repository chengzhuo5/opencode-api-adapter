import { ProxyClient } from 'lean-ctx-sdk';

export function createLeanCtxClient(options = {}) {
  const client = new ProxyClient({
    baseUrl: options.baseUrl,
    token: options.token,
    timeoutMs: options.timeoutMs ?? 30000
  });
  return {
    async compress(messages, model) {
      const result = await client.compress(messages, model);
      return { messages: result.messages, stats: result.stats || {} };
    },
    _client: client
  };
}
