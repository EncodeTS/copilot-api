# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun install          # Install dependencies
bun run dev          # Dev mode with watch
bun run build        # Build to dist/ via tsdown
bun run start        # Production start (NODE_ENV=production)
bun run lint         # ESLint with cache (auto-fixes staged files pre-commit)
bun run lint:all     # ESLint on entire project
bun run typecheck    # tsc type check only (no emit)
bun test             # Run all tests
bun test tests/foo.test.ts  # Run a single test file
```

## Architecture

This is a reverse-engineered proxy that exposes the GitHub Copilot API as both an OpenAI-compatible and Anthropic-compatible HTTP service. The entry point is `src/main.ts` (CLI via `citty`), which dispatches to subcommands: `start`, `auth`, `check-usage`, `debug`.

### Request flow for `/v1/messages` (Anthropic path)

`src/routes/messages/handler.ts` is the core dispatch logic:

1. Rate limit check
2. Parse Anthropic payload
3. Detect subagent marker (`__SUBAGENT_MARKER__` in `<system-reminder>`) → sets `x-initiator: agent`
4. Detect compact requests (Claude Code context compaction)
5. Resolve model: detect `context-1m-2025-08-07` in `anthropic-beta` header → try `-1m` suffix first (e.g. `claude-opus-4-6` → `claude-opus-4.6-1m`), fallback to base model
6. Route to one of three upstream flows:
   - `handleWithMessagesApi` — Copilot native `/v1/messages` (Claude models, preferred)
   - `handleWithResponsesApi` — Copilot `/responses` (GPT models)
   - `handleWithChatCompletions` — fallback for everything else

### Adaptive thinking (Messages API path only)

`src/routes/messages/preprocess.ts` — `prepareMessagesApiPayload`: when the model supports `adaptive_thinking` and `tool_choice` is not `any`/`tool`:
- Injects `thinking: { type: "adaptive" }` only when client didn't specify thinking; preserves client's thinking config (enabled/adaptive/disabled/display) when set
- Uses client's `output_config.effort` if provided, defaults to `high`; preserves other `output_config` fields (e.g. `format`)
- Deletes `temperature` from payload when thinking is active (not disabled)
- `context-1m-2025-08-07` beta header is NOT forwarded to upstream (filtered by `allowedAnthropicBetas` whitelist)

### Key directories

| Path | Purpose |
|---|---|
| `src/server.ts` | Hono app, middleware stack, route registration |
| `src/lib/` | Shared utilities: config, state, auth, tokens, rate-limit, models, tokenizer, trace |
| `src/routes/` | Route handlers grouped by endpoint family |
| `src/services/` | Upstream API clients (Copilot, GitHub, providers) |
| `tests/` | All test files (`*.test.ts`), Bun built-in runner |

### Middleware stack (in order)

`traceIdMiddleware` → `logger(customPrintFn)` → `cors()` → `createAuthMiddleware` (API key validation via `x-api-key` or `Authorization: Bearer`; unauthenticated paths: `/`, `/usage-viewer`)

The custom logger appends model route info (e.g. `claude-opus-4-6 -> claude-opus-4.6-1m`) to response lines via `RequestContext.modelRoute`.

### Logging

- **`[req]`** (always): incoming request — model, thinking, effort, stream, tools, context1m
- **Response line** (always): `-->` line includes model route info when available
- **`--verbose` mode** enables additional console output:
  - `[route]` — model routing result, API flow, compact status
  - `[messages-api]` — thinking type, effort, temperature after payload preparation
- **Handler file logs**: written to `~/.local/share/copilot-api/logs/` via `createHandlerLogger`, debug-level details per request

### Model routing

`src/lib/models.ts` normalizes Claude model IDs via 5 regex patterns (handles variants like `claude-opus-4-6`, `claude-opus-4.6`). Supports an optional `suffix` parameter for context-window variants (e.g. `-1m`). The `useMessagesApi` config flag (default `true`) controls whether Claude-family models use the native Messages API or fall back to Chat Completions.

### Config and state

- `src/lib/config.ts` — `AppConfig` shape, disk read/write from `~/.local/share/copilot-api/config.json` (Linux/macOS) or `%USERPROFILE%\.local\share\copilot-api\config.json` (Windows). Also respects `COPILOT_API_HOME` env var.
- `src/lib/state.ts` — singleton mutable state: tokens, accountType, rate-limit, models cache.

### Token counting

`/v1/messages/count_tokens`: when `anthropicApiKey` is configured, forwards Claude model requests to Anthropic's free `/v1/messages/count_tokens` endpoint for exact counts. Otherwise falls back to GPT `o200k_base` tokenizer with 1.15x multiplier (`src/lib/tokenizer.ts`).

## Code Style

- **Imports:** Use `~/` alias for `src/` (e.g., `import { foo } from '~/lib/foo'`)
- **TypeScript:** Strict mode — no `any`, `noUnusedLocals`, `noUnusedParameters`
- **Modules:** ESNext only, no CommonJS
- **Naming:** `camelCase` for functions/variables, `PascalCase` for types/interfaces
- **Error handling:** Route handlers catch and call `forwardError(c, error)`; use `HTTPError` from `src/lib/error.ts`
- **Streaming:** All three API flows support both streaming (SSE via `streamSSE`) and non-streaming, switching on `payload.stream`

## Plugin Integrations

- **Claude Code plugin:** Install from marketplace with `/plugin marketplace add https://github.com/caozhiyuan/copilot-api.git` then `/plugin install claude-plugin@copilot-api-marketplace`. Injects `__SUBAGENT_MARKER__` on subagent starts.
- **Opencode plugin:** Copy `.opencode/plugins/subagent-marker.js` to `~/.config/opencode/plugins/`.
