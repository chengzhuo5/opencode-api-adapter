import { once } from 'node:events';
import { createRouter } from '../src/server.js';

const config = {
  apiKey: 'smoke',
  apiBaseUrl: 'https://opencode.ai/zen/go/v1',
  models: {},
  timeouts: { requestMs: 10000, streamIdleMs: 10000 },
  catalog: { models: [{ slug: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash' }] }
};

const server = createRouter(config);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const health = await fetch(`${base}/healthz`);
  const models = await fetch(`${base}/v1/models`);
  const healthBody = await health.json();
  const modelsBody = await models.json();
  if (!healthBody.ok || modelsBody.models[0]?.slug !== 'deepseek-v4-flash') {
    throw new Error('smoke check failed');
  }
  console.log('smoke ok:', health.status, models.status, modelsBody.models[0].slug);
} finally {
  server.close();
}
