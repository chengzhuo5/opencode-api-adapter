import { once } from 'node:events';
import { execSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createRouter } from '../src/server.js';
import { resolveRoute } from '../src/routes.js';

function userEnv(name) {
  const out = execSync(`reg query HKCU\\Environment /v ${name}`).toString();
  const match = out.match(/REG_SZ\s+(.+)\r?$/m);
  return match ? match[1].trim() : undefined;
}

process.env.ERGOUAPI_API_KEY = userEnv('ERGOUAPI_API_KEY');
process.env.OPENCODE_GO_API_KEY = userEnv('OPENCODE_GO_API_KEY');

const logs = [];
const config = loadConfig({ configPath: 'config.json' });
config.logger = (e) => logs.push(e);

function maskRoute(route) {
  return { ...route, apiKey: route.apiKey ? `***${route.apiKey.slice(-4)}` : undefined, fallbackApiKey: route.fallbackApiKey ? `***${route.fallbackApiKey.slice(-4)}` : undefined };
}

console.log('ROUTE_LUNA', JSON.stringify(maskRoute(resolveRoute(config, 'gpt-5.6-luna'))));
console.log('ROUTE_DS', JSON.stringify(maskRoute(resolveRoute(config, 'deepseek-v4-flash'))));

const server = createRouter(config);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const res = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is in this image? answer briefly' },
          { type: 'input_image', image_url: 'https://raw.githubusercontent.com/github/explore/main/topics/javascript/javascript.png' }
        ]
      }]
    })
  });
  const text = await res.text();
  console.log('STATUS', res.status);
  console.log('BODY_HEAD', text.slice(0, 200).replace(/\n/g, '\\n'));
} finally {
  console.log('EVENTS');
  for (const e of logs) {
    const pick = { event: e.event, model: e.model, fallback_model: e.fallback_model, reason: e.reason, primary_endpoint: e.primary_endpoint, primary_status: e.primary_status, fallback_endpoint: e.fallback_endpoint };
    console.log(JSON.stringify(pick));
  }
  server.close();
}
