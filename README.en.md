# OpenCode API Adapter

`@minar-kotonoha/opencode-api-adapter` is a zero-dependency Node.js local adapter. It exposes one OpenAI Responses-compatible endpoint for Codex and routes model requests to OpenCode Go Responses, Chat Completions, or Anthropic Messages endpoints.

## Features

- One entry point: `POST /v1/responses`.
- Non-Anthropic models try `/responses` first and fall back automatically to `/chat/completions` on network errors, timeouts, or any non-2xx response.
- Chat Completions JSON and SSE responses are converted back to the Responses format.
- MiniMax/Qwen Anthropic Messages routing remains independent and is not included in Responses→Chat fallback.
- DeepSeek V4 Pro/Flash requests whose latest user message contains `input_image`, `image_url`, or `file_id` are automatically routed to `gpt-5.6-luna`; images in older history turns do not trigger the fallback.
- Cross-protocol history normalization preserves tool calls (including legacy `custom_tool_call`/`custom_tool_call_output` items) and reasoning, removes internal fields, repairs duplicated historical tool names, and re-pairs interrupted or interleaved tool rounds so every `tool_calls` message is answered before the next role. Stored item ids are dropped on replay because legacy `resp_..._msg` prefixed ids are rejected by some upstreams.
- Passive circuit breaker (disabled by default; enable via `circuitBreaker.enabled`): providers are skipped after consecutive failures or a sustained error rate, a half-open probe is allowed after the cooldown, and the provider recovers after enough probe successes. Complements the active health probes.
- Per-model context windows: the catalog declares `context_window` per model (353K for the ergou GPT family, template default 1M otherwise) so Codex compacts before the upstream limit is hit.
- Wildcard model config: `modelPatterns` applies one provider block to many models (`gpt-*`); exact `models` entries always win.
- Request log and usage stats: every request appends one JSONL line (model/provider/status/tokens/cache/latency), and `GET /v1/usage` returns totals plus per-model/provider/day breakdowns.
- Built-in admin UI and desktop app: open `http://127.0.0.1:15722/admin` in a browser, or run the ewvjs-packaged desktop shell, to view status, edit config, inspect usage, and hot-restart the router.
- Codex config management: one click adds a `minar_route` provider to `~/.codex/config.toml` and switches `model_provider`/`model`, keeping the originals as commented markers, backing up before every change, and restoring from markers first (timestamped backups only with explicit user confirmation).
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
  "limits": {
    "maxRequestBodyBytes": 67108864,
    "requestBodyIdleMs": 120000
  },
  "models": {}
}
```

`limits.maxRequestBodyBytes` checks both declared `Content-Length` and actual chunked bytes, returning 413 when exceeded. `requestBodyIdleMs` is the maximum idle gap between incoming body chunks and returns 408 on timeout. Defaults are 64 MiB / 120 seconds; normal long-context and image requests are not rewritten or given extra model-visible fields.

### Custom providers (per-model endpoints and wildcards)

By default every model is routed to `apiBaseUrl` (OpenCode Go). Any model can be overridden to another provider. **Once a model has a custom `endpoint`, only that provider is used (array entries are tried in order) and the global `apiBaseUrl` is no longer appended as a fallback** — for example, the gpt family only goes through ergou and never degrades to an opencode endpoint that does not support the model. When several models share a provider, `modelPatterns` covers them with a glob (`*` matches any run, `?` matches one character):

```json
{
  "modelPatterns": {
    "gpt-*": {
      "upstream": "responses",
      "endpoint": "https://ergouapi.com/v1",
      "apiKeyEnv": "ERGOUAPI_API_KEY",
      "maxHistoryMessages": 10,
      "contextWindow": 353000
    }
  }
}
```

- Priority: exact `models` entry > `modelPatterns` match (longest pattern wins) > default route.
- `endpoint`: base URL of the custom provider (the router appends `/responses`, `/chat/completions`, or `/messages` according to the protocol). Trailing slashes and already-suffixed full URLs are normalized to avoid duplicated paths.
- `apiKeyEnv`: environment variable holding the provider API key; falls back to the global `apiKeyEnv` when omitted. If explicitly configured but missing, startup fails immediately instead of sending an empty key.
- `maxHistoryMessages`: optional, keep only the latest N messages before forwarding (for providers with small context windows, e.g. ergou luna); no truncation by default
- `contextWindow`: optional, overrides the catalog `context_window` for this model (Codex uses it to decide when to compact). The ergou GPT family defaults to 353K.
- `pricing`: optional per-million-token prices: `cachedInputUsdPerMillion`, `uncachedInputUsdPerMillion`, and `outputUsdPerMillion`. Cost is estimated only when explicit hit/miss usage and all three prices are available; unknown values remain `null`.
- Priority: custom provider (exclusive when configured) → `apiBaseUrl` (only for models without a custom endpoint) → protocol fallback (chat/completions, only when `apiBaseUrl` exists; set `apiBaseUrl` to `null` to disable the global fallback entirely)

Both `endpoint` and the global `apiBaseUrl` accept a **string or an array**. Responses, Chat Completions, and Anthropic Messages routes all try providers in order with an independent timeout per attempt; the first successful response wins. Each element can be a string (uses the model/global default key) or an object `{ "url": "...", "apiKeyEnv": "..." }` to assign a dedicated key to that endpoint:

```json
{
  "endpoint": [
    { "url": "https://ergouapi.com/v1", "apiKeyEnv": "ERGOUAPI_API_KEY" },
    "https://backup.example/v1"
  ]
}
```

You can select a configuration file with an environment variable or CLI option:

```powershell
$env:OPENCODE_ROUTER_CONFIG = "C:\path\to\config.json"
opencode-api-adapter

opencode-api-adapter --config "C:\path\to\config.json"
```

### Provider stickiness, health checks, and circuit breaker

```json
{
  "providerStickiness": {
    "enabled": true,
    "ttlMs": 21600000,
    "maxEntries": 10000
  },
  "healthCheck": {
    "enabled": true,
    "intervalMs": 300000,
    "timeoutMs": 20000
  },
  "circuitBreaker": {
    "enabled": false,
    "failureThreshold": 3,
    "successThreshold": 2,
    "timeoutMs": 60000,
    "errorRateThreshold": 0.6,
    "minRequests": 5
  }
}
```

The layers complement each other:

- `providerStickiness` is enabled by default. A local HMAC affinity key keeps the same session/model on one Provider; a successful failover updates the binding for `ttlMs`. Provider recovery affects new sessions and does not switch an active long conversation back mid-session. No session, timestamp, or random field is injected into the model request.
- `healthCheck` sends protocol-correct probes in parallel every `intervalMs` (Responses/Chat/Messages use their own path, request body, and authentication headers); failed providers move to the end of the candidate order for new sessions (`provider_health` events).
- `circuitBreaker` is disabled by default (`enabled: false`); turn it on when needed. It is driven by real request outcomes, tracked per `model::endpoint`. A provider is tripped after `failureThreshold` consecutive failures, or once at least `minRequests` requests have an error rate above `errorRateThreshold`; after `timeoutMs` one half-open probe is allowed, and `successThreshold` consecutive probe successes close the breaker. State changes emit `provider_circuit` log events.

### Request log and usage stats

```json
{
  "usageLog": {
    "enabled": true,
    "file": "usage/requests.jsonl",
    "flushDelayMs": 10
  }
}
```

Each `/v1/responses` request appends one JSON line containing timestamp, model, provider, status, success, input/output/cache-hit/cache-miss/cache-write tokens, estimated cost, latency, streaming flag, and error. DeepSeek `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, OpenAI cached-token details, and Anthropic cache read/write fields are supported. Missing dimensions remain `null` instead of being counted as zero; legacy `cache_read_tokens` / `cache_creation_tokens` remain as aliases.

The log also contains local-HMAC `conversation_key_hash`, `model_visible_prefix_hash`, `tool_schema_hash`, and `provider_endpoint_hash` values plus route/translator versions. It never stores full prompts, API keys, images, or raw tool output.

The JSONL file is loaded once at startup. New records become visible to in-memory stats immediately and are appended to disk in asynchronous batches after `flushDelayMs`. Aggregates are version-cached, so admin polling no longer synchronously rereads and reparses the whole file; hot reload and graceful shutdown flush pending records.

Query the stats:

```text
GET /v1/usage?days=7
GET /v1/usage?days=7&model=gpt-5.6-luna
GET /v1/usage?days=7&provider=https://ergouapi.com/v1/responses
```

Returns request/success totals, token totals, `hit / (hit + miss)` cache ratio, cost coverage and estimates, compression-checkpoint reuse, average latency, and per-model/provider/day breakdowns. The `usage/` directory is gitignored.

### Admin UI and desktop app

The router ships a zero-dependency light-themed admin page under `admin/`; open `http://127.0.0.1:15722/admin` in a browser to use it:

- **Overview**: service status, PID/uptime, provider health (active probes), circuit breaker state (real-request driven);
- **Usage**: requests/success rate/tokens/cache hit+miss/cost coverage/checkpoint reuse/avg latency, a per-day bar chart, and per-model/provider breakdowns;
- **Config**: edit `config.json` directly, with "save and hot-reload" (validate, write file, restart the HTTP server in-process — Codex keeps working) and "restart service".

Admin APIs: `GET /api/status`, `GET /api/config`, `POST /api/reload` (raw config as body), `POST /api/restart`.

The desktop shell lives in `desktop/` (ewvjs = Node + the Windows built-in WebView2):

```powershell
cd desktop
npm install
npm start              # source mode: uses the repo config.json; only opens a window if the port is already taken
npm run package        # package: dist/CodexRouter.exe + assets/ (portable folder)
```

On first run the packaged exe seeds `%LOCALAPPDATA%\CodexRouter` (config/admin/catalog/usage/logs all live there) and runs the router inside the app process; closing the window stops it. If port 15722 is already in use (e.g. the watchdog is running), it attaches to the running router instead of starting another.

### Register as a Windows service (optional)

For start-before-login, auto-start on boot, and crash-restart, register the router as a Windows service (powered by [NSSM](https://nssm.cc)):

```powershell
# Run as Administrator:
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Code\AI\opencode-api-adapter\scripts\install-service.ps1
```

The installer downloads NSSM to `%LOCALAPPDATA%\CodexRouter\nssm`, creates the auto-start `CodexRouter` service (`node src/main.js`) with 5s restart delay and rotating logs, injects the three API keys from `HKCU\Environment` into the service environment (the service runs as LocalSystem, which cannot see per-user environment variables), and disables the `opencode-router-watchdog` scheduled task to avoid port conflicts.

The admin UI keeps working after installation (`http://127.0.0.1:15722/admin`); hot reload/restart from the page is still in-process. Service-level control:

```powershell
sc.exe stop CodexRouter
sc.exe start CodexRouter
sc.exe query CodexRouter
```

Uninstall and restore the watchdog:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Code\AI\opencode-api-adapter\scripts\uninstall-service.ps1
```

### Codex config management (minar_route)

The "Codex 配置" tab in the admin UI (or `POST /api/codex/apply`) switches Codex to the router:

- Adds `[model_providers.minar_route]` (`name = "米纳尔"`, base_url pointing at the router, `wire_api = "responses"`, `requires_openai_auth = true`, `experimental_bearer_token = "PROXY_MANAGED"`);
- Replaces the top-level `model_provider` / `model` with `minar_route` / the target model (default `gpt-5.6-luna`), keeping the originals as `# minar_route_original: ...` comment lines; every other setting (MCP servers, features, model_catalog_json, profiles) is left untouched;
- Backs up the current file as `config.toml.<timestamp>.minar_route.bak` before every change;
- Restore prefers the commented originals; if the markers are gone it lists backups and only overwrites after explicit user confirmation.

Configuration (`codex` block in `config.json`, disabled by default):

```json
{
  "codex": {
    "enabled": true,
    "configPath": "C:/Users/29302/.codex/config.toml",
    "providerName": "minar_route",
    "providerDisplayName": "米纳尔",
    "model": "gpt-5.6-luna",
    "baseUrl": "http://127.0.0.1:15722/v1",
    "wireApi": "responses",
    "authToken": "PROXY_MANAGED"
  }
}
```

Changes take effect on the next Codex start; the current session is unaffected. Admin APIs: `GET /api/codex`, `POST /api/codex/apply`, `POST /api/codex/restore` (with optional `{ "file": "...", "confirm": true }`).

## Context compression (lean-ctx)

The router compresses only `function_call_output` (tool outputs) in history, keeping the message structure and user/assistant instructions intact to avoid semantic loss. The backend is a local [lean-ctx](https://github.com/yvgude/lean-ctx) daemon.

- Install the daemon: `npm i -g lean-ctx-bin` then run `lean-ctx proxy enable` (or use the official installer).
- Configure:

```json
{
  "compress": {
    "enabled": true,
    "backend": "lean-ctx",
    "baseUrl": "http://127.0.0.1:4444",
    "token": "",
    "storeDir": "ctx-store",
    "cacheSize": 1000,
    "minOutputTokens": 2048,
    "timeoutMs": 30000
  }
}
```

- Granularity: only `function_call_output` items at or above the fixed `minOutputTokens` threshold are compressed; history remains append-only between thresholds and all other input items pass through verbatim.
- Cache safety: each output fingerprint maps to a disk-persisted checkpoint. The exact compressed text is reused after a restart or in-memory eviction instead of regenerating old history; `cache_safety_check` tracks prefix drift per conversation.
- Explicit CCR retrieval: a compressed item becomes `<compressed text> [[ctx:<sha256>|<absolute path>]]`, where `<absolute path>` points to the original JSON archive (SHA-256 addressed, under `storeDir`). To retrieve the full original, read that file with the shell:

```powershell
Get-Content -Raw "<absolute path>"
```

```bash
cat "<absolute path>"
```

- Logs: `context_compression` records checkpoint state and `tokens_before/after`. When a route has `pricing`, the final usage record uses actual cache hit/miss/output usage to estimate cost and cache savings instead of treating `tokens_saved` as money. Set `compress.logLevel` to `"verbose"` (default, includes `cache_safety_check`) or `"quiet"` (summary and errors only); when the daemon is unavailable, compression fails open and routing keeps working.


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

The adapter generates `catalog.json` at startup. DeepSeek advertises both `text` and `image`; images are routed to Luna only when an image is present in the latest user message.

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
