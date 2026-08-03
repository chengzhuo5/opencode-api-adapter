import { once } from 'node:events';
import { execSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createRouter } from '../src/server.js';

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
const server = createRouter(config);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const res = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'reply with exactly: ok' }] }]
    })
  });
  const text = await res.text();
  console.log('STATUS', res.status);
  console.log('BODY_HEAD', text.slice(0, 240).replace(/\n/g, '\\n'));
  const fallbacks = logs.filter((e) => e.event === 'api_fallback');
  console.log('FALLBACKS', fallbacks.length === 0 ? 'none' : JSON.stringify(fallbacks));
} finally {
  server.close();
}
