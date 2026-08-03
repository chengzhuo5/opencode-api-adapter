# Codex OpenCode Go Router Design

Date: 2026-08-03
Status: Approved by user

## Goal

Replace `cc-switch` on the Codex side with a small local Node.js router that:

- accepts Codex Responses API requests at `127.0.0.1:15721/v1/responses`;
- uses one OpenCode Go API key from `OPENCODE_GO_API_KEY`;
- routes each model to the upstream endpoint listed in the official OpenCode Go docs;
- translates between the Responses wire format and the upstream wire format;
- serves a stable model catalog for Codex.

Claude Code is out of scope. The router must not rewrite user configuration files.

## Architecture

The router is a zero-dependency Node.js HTTP server using built-in `node:http` and the
global `fetch` API. It listens on `127.0.0.1:15721` by default.

Endpoints:

- `POST /v1/responses` - Codex inference requests.
- `GET /v1/models` - Codex model catalog.
- `GET /healthz` - liveness check.

All upstream requests include `Authorization: Bearer $OPENCODE_GO_API_KEY`. Inbound
authorization is ignored.

## Routing Table

The official endpoint table is encoded in `config.json` and grouped by protocol:

### Responses passthrough

Endpoint: `https://opencode.ai/zen/go/v1/responses`

- `gpt-5.6-luna`

### Chat Completions

Endpoint: `https://opencode.ai/zen/go/v1/chat/completions`

- `grok-4.5`
- `glm-5.2`
- `glm-5.1`
- `kimi-k3`
- `kimi-k2.7-code`
- `kimi-k2.6`
- `deepseek-v4-pro`
- `deepseek-v4-flash`
- `mimo-v2.5`
- `mimo-v2.5-pro`
- `hy3`

### Anthropic Messages

Endpoint: `https://opencode.ai/zen/go/v1/messages`

- `minimax-m3`
- `minimax-m2.7`
- `minimax-m2.5`
- `qwen3.7-max`
- `qwen3.7-plus`
- `qwen3.6-plus`

Unknown models return HTTP 400 with a clear JSON error.

## Configuration

`config.json` contains:

- `host` and `port`;
- `apiBaseUrl` (`https://opencode.ai/zen/go/v1`);
- `apiKeyEnv` (`OPENCODE_GO_API_KEY`);
- `models` map from model id to `{ "upstream": "responses" | "chat" | "messages" }`;
- `catalogFile` path used to write the Codex model catalog;
- `timeouts` with `requestMs` and `streamIdleMs`.

The API key is never stored in `config.json`. Startup fails with a clear message when
the environment variable is missing. The router only reads `config.json`; the only file
it writes is the generated model catalog at `catalogFile`.

## Protocol Translation

### Responses to Chat Completions

- Map `instructions`, developer, user, and assistant messages to Chat messages.
- Convert Responses function tools to Chat function tools.
- Convert tool results into Chat tool messages.
- For streaming, convert Chat `data:` deltas into Responses events such as
  `response.output_text.delta` and `response.function_call_arguments.delta`.
- Convert the final Chat completion into a Responses object with `message` and
  `function_call` outputs.

### Responses to Anthropic Messages

- Map instructions and developer content into `system`.
- Convert Responses function tools to Anthropic `tools`.
- Convert tool results into `user` messages with `tool_result` blocks.
- For streaming, convert Anthropic events (`content_block_start`,
  `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) into
  Responses events.
- Convert the final message into a Responses object.

### Responses passthrough

For `gpt-5.6-luna`, forward the request body to `/v1/responses` and relay the response
body or SSE stream unchanged.

## Error Handling

- Upstream HTTP errors are relayed with the same status code and a sanitized JSON body.
- Streaming errors emit `response.failed` before closing the stream.
- Timeouts use `AbortController` with configurable non-streaming and streaming idle
  limits.
- Missing API key and unknown model produce actionable startup/request errors.

## Model Catalog

The router writes a `catalog.json` file at the path in `config.json`. The file follows
the Codex model catalog shape used by the current cc-switch catalog and contains only
models present in the routing table. `GET /v1/models` returns the same list.

## Testing

- Unit tests cover non-streaming and streaming conversion for all three protocols.
- Smoke test starts the server and verifies `/healthz` and `/v1/models`.
- Live verification uses `OPENCODE_GO_API_KEY` against `/v1/models`.
- Manual rollout: stop cc-switch, start router, point Codex `model_catalog_json` at the
  generated catalog, and restart Codex.

## Non-Goals

- Claude Code proxying.
- Web UI or automatic config management.
- Auto-start or Windows service registration for the first version.
- Models not listed in the official endpoint table.
