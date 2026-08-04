import { readFileSync } from 'node:fs';

const imagePath = process.argv[2] || 'd:\\cheng\\Pictures\\charAvatar_Lumine.png';
const routerBase = process.env.ROUTER_BASE || 'http://127.0.0.1:15722';
const mime = imagePath.toLowerCase().endsWith('.jpg') || imagePath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
const dataUrl = `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`;

async function send(model, label) {
  const body = {
    model,
    stream: true,
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe this image in one short sentence.' },
        { type: 'input_image', image_url: dataUrl }
      ]
    }]
  };
  const started = Date.now();
  try {
    const res = await fetch(`${routerBase}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    console.log(`--- ${label} ---`);
    console.log(`status=${res.status} ms=${Date.now() - started} bytes=${text.length}`);
    const events = [...text.matchAll(/"type":"([a-z_.]+)"/g)].map((m) => m[1]);
    console.log('event types:', [...new Set(events)].join(', '));
    const delta = text.match(/"delta":"([^"]*)"/)?.[1] || text.match(/"text":"([^"]*)"/)?.[1] || '';
    console.log('first text:', delta.slice(0, 120));
  } catch (error) {
    console.log(`--- ${label} --- NETWORK_ERROR: ${error.message}`);
  }
}

await send('deepseek-v4-flash', 'deepseek + image (multimodal upgrade path)');
await send('gpt-5.6-luna', 'luna + image (direct path)');
