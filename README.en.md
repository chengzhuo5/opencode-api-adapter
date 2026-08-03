# OpenCode API Adapter

`@minar-kotonoha/opencode-api-adapter` is a zero-dependency Node.js local adapter. It exposes one OpenAI Responses-compatible endpoint for Codex and routes model requests to OpenCode Go Responses, Chat Completions, or Anthropic Messages endpoints.

## Features

- One entry point: `POST /v1/responses`.
- Non-Anthropic models try `/responses` first and fall back automatically to `/chat/completions` on network errors, timeouts, or any non-2xx response.
- Chat Completions JSON and SSE responses are converted back to the Responses format.
- MiniMax/Qwen Anthropic Messages routing remains independent and is not included in Responses→Chat fallback.
- DeepSeek V4 Pro/Flash requests containing `input_image`, `image_url`, or `file_id` are automatically routed to `gpt-5.6-luna`.
- Cross-protocol history normalization preserves tool calls and reasoning, removes internal fields, and repairs duplicated historical tool names.
- Structured console logs report multimodal and API fallback events without logging API keys, full prompts, or image data.
- Usable as a CLI or imported as a Node HTTP server.

## Architecture

```text
Codex Responses request
        |
        +-- DeepSeek + image --> gpt-5.6-luna
        |
        +-- /responses
        |      |
        |      +-- 2xx ----------------------> relay Responses
        |      |
        |      `-- error/timeout/network -----> /chat/completions
        |                                            |
        |                                            `--> convert Chat response to Responses
        |
        `-- Anthropic model ------------------> /messages
```

The adapter never stores the API key in its configuration. All upstream requests use `OPENCODE_GO_API_KEY`.

## Installation

```powershell
npm install -g @minar-kotonoha/opencode-api-adapter
```

Requires Node.js 18 or newer.

## Configuration

Copy the example configuration:

```powershell
Copy-Item (npm root -g)\@minar-kotonoha\opencode-api-adapter\config.example.json .\config.json
$env:OPENCODE_GO_API_KEY = "your OpenCode Go API key"
```

Minimal configuration:

```json
{
  "host": "127.0.0.1",
  "port": 15722,
  "apiBaseUrl": "https://opencode.ai/zen/go/v1",
  "apiKeyEnv": "OPENCODE_GO_API_KEY",
  "catalogFile": "catalog.json",
  "timeouts": {
    "requestMs": 600000,
    "streamIdleMs": 180000
  },
  "models": {}
}
```

You can select a configuration file with an environment variable or CLI option:

```powershell
$env:OPENCODE_ROUTER_CONFIG = "C:\path\to\config.json"
opencode-api-adapter

opencode-api-adapter --config "C:\path\to\config.json"
```

## Starting the adapter

```powershell
opencode-api-adapter
```

Or from a source checkout:

```powershell
npm start
```

Health check:

```powershell
Invoke-WebRequest http://127.0.0.1:15722/healthz
```

## Codex configuration

```toml
model_provider = "custom"
model = "gpt-5.6-luna"
model_catalog_json = "C:/path/to/catalog.json"

[model_providers.custom]
name = "opencode_go"
base_url = "http://127.0.0.1:15722/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "PROXY_MANAGED"
```

The adapter generates `catalog.json` at startup. DeepSeek advertises both `text` and `image`; images are routed to Luna only when an image is actually present in the request.

## Structured logs

Events are written as one JSON object per line to the adapter console:

```json
{"event":"multimodal_fallback","model":"deepseek-v4-flash","fallback_model":"gpt-5.6-luna","reason":"image_input"}
{"event":"api_fallback","model":"deepseek-v4-flash","reason":"http_error","primary_status":503,"fallback_endpoint":"chat/completions"}
{"event":"api_fallback_result","model":"deepseek-v4-flash","success":true,"status":200}
```

When embedding or testing the adapter, pass `config.logger = (event) => { ... }` to capture structured events.

## Testing

```powershell
npm test
npm run smoke
npm run switch:gpt-ds-gpt-ds
npm run switch:ds-gpt-ds-gpt
```

Both switching scripts support `--mock` and can target a running adapter:

```powershell
node scripts/switch-gpt-deepseek-gpt-deepseek.mjs --base http://127.0.0.1:15722
node scripts/switch-deepseek-gpt-deepseek-gpt.mjs --base http://127.0.0.1:15722
```

## Library usage

```js
import { createRouter } from "@minar-kotonoha/opencode-api-adapter";

const server = createRouter({
  apiKey: process.env.OPENCODE_GO_API_KEY,
  apiBaseUrl: "https://opencode.ai/zen/go/v1",
  models: {}
});

server.listen(15722, "127.0.0.1");
```

## Security

- Never put the API key in `config.json`, README files, or Git history.
- Images are sent to the model that actually handles the request; do not upload data that must remain local.
- Fallback logs contain routing metadata only, not full request bodies.

## License

MIT
