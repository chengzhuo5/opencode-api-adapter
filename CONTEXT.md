# Codex Router

This context translates OpenAI Responses requests across multiple upstream wire protocols while preserving one stable client-facing Responses contract.

## Language

**Router Request**:
The original `/v1/responses` request received from Codex or another client.
_Avoid_: API call, payload

**Route**:
The resolved model policy containing the upstream protocol, ordered Providers, credentials, and model-specific limits.
_Avoid_: mapping, endpoint config

**Provider**:
One concrete upstream endpoint and credential pair eligible to serve a Route.
_Avoid_: backend, base URL

**Provider Execution**:
The complete attempt lifecycle for a Route: Provider ordering, breaker checks, timeout, failover, response relay, and usage outcome.
_Avoid_: forwarding helper, fallback loop

**Protocol Adapter**:
The protocol-specific conversion between the Router Request and one upstream wire format: Responses, Chat Completions, or Anthropic Messages.
_Avoid_: converter, wrapper

**Display Model**:
The model name requested by the client and preserved in the client-facing response even when routing upgrades the upstream model.
_Avoid_: original model

**Chat Fallback**:
The configured transition from a failed Responses Provider chain to Chat Completions Providers.
_Avoid_: global fallback, legacy fallback

**Request Preparation**:
The ordered transformations applied before Provider Execution, including multimodal upgrade, historical image removal, history truncation, and optional context compression.
_Avoid_: preprocessing, normalization

**Provider Affinity**:
The bounded session/model binding that keeps a cache-sensitive conversation on one Provider and updates only after a successful failover.
_Avoid_: random routing, permanent pin

**Cache Diagnostics**:
Local HMAC fingerprints of the model-visible request, ordered tool schema, conversation key, and Provider endpoint. Raw prompts and tool output are never diagnostics.
_Avoid_: prompt logging, trace payload

**Compression Checkpoint**:
A content-addressed, disk-persisted compressed tool output reused byte-for-byte across turns, concurrent requests, cache eviction, and process restart.
_Avoid_: regenerated summary, transient compression
