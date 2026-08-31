# pi-ai-gateway

> **[简体中文](README.zh-CN.md)**

Register any OpenAI-compatible gateway (newapi, one-api, self-hosted proxies, ...) as a [Pi](https://pi.dev) provider.

- **Interactive TUI menu**: run `/ai-gateway` to manage gateways without memorizing subcommands
- **Automatic model discovery**: fetches `{baseUrl}/v1/models` at startup; run `/ai-gateway fetch` anytime to refresh models/prices without restart
- **Automatic protocol routing**: newly added gateways send canonical OpenAI models to `/v1/responses` and other models to `/v1/chat/completions`
- **Automatic metadata borrowing**: imports thinking support / thinking levels / context window / compat from Pi's built-in model catalog (the one refreshed by `pi update --models`)
- **Gateway-aware pricing**: uses NewAPI-compatible `{gatewayRoot}/api/pricing` whenever available, including context-length price tiers and pricing-only model IDs
- **Optional price presets**: when a gateway does not publish a model price, opt into Models.dev or BaseLLM defaults per gateway; manual prices always win
- **Zero noise**: automatically filters out non-chat models (image / embedding / tts / rerank)
- **Resilient**: a failing gateway never breaks Pi startup; falls back to a cached model list when offline
- **Zero dependencies**: pure extension, no third-party npm packages

## Install

```bash
pi install git:github.com/tlsneo/pi-ai-gateway
```

For local development, you can also install from a path (changes take effect on next Pi start):

```bash
pi install ./pi-ai-gateway
```

## Configuration

Create `~/.pi/agent/ai-gateway.json` (template: `ai-gateway.example.json`):

```json
{
  "gateways": [
    {
      "name": "newapi",
      "baseUrl": "https://your-gateway.example.com/v1",
      "apiKey": "sk-your-key",
      "apiRouting": "auto",
      "pricePreset": "models-dev"
    }
  ]
}
```

`apiRouting: "auto"` is the default written by `/ai-gateway add`: models declared as `openai-responses` in Pi's canonical `openai.json` use `/v1/responses`, while all other models continue to use `/v1/chat/completions`. `pricePreset` is optional; omit it if you only want prices published by the gateway itself.

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Provider name; models appear as `newapi/gpt-5.6-sol`. Must not collide with built-in Pi providers |
| `baseUrl` | ✅ | Gateway URL; `/v1` is appended automatically if missing |
| `apiKey` | ✅ | Write the key directly (the `$ENV` reference syntax is also supported) |
| `api` | ❌ | Force one Pi API type for the whole gateway; takes precedence over `apiRouting` |
| `apiRouting` | ❌ | `"auto"`: canonical OpenAI Responses models use `openai-responses`, other models use `openai-completions`; written by default for gateways created with `/ai-gateway add` |
| `headers` | ❌ | Extra request headers |
| `pricePreset` | ❌ | Missing-price fallback: `"models-dev"` or `"basellm"`; omitted means gateway prices only |
| `overrides` | ❌ | Per-model metadata and manual price overrides (see below) |

Protocol precedence:

```text
explicit api > apiRouting: "auto" > openai-completions
```

Automatic detection uses Pi's bundled `openai.json`, not a `gpt-` name prefix, so `gpt-oss-*` and unregistered gateway aliases stay on Chat Completions by default. Regular API-key gateways use `openai-responses`, not `openai-codex-responses`. If the gateway does not support `/v1/responses`, set `"api": "openai-completions"` explicitly.

Restart Pi after configuring; all models will appear under `/model` with the configured provider prefix.

> Key security: the config file lives outside the repo and is chmod 600 automatically. Only `ai-gateway.example.json` (placeholders, zero secrets) is committed. Never commit the real config file.

### overrides: per-model metadata overrides (optional)

By default, capabilities come from Pi's built-in catalog, while prices come from the gateway's `/api/pricing` endpoint when it is available. Individual models can still be adjusted manually:

```json
{
  "gateways": [
    {
      "name": "newapi",
      "baseUrl": "https://your-gateway.example.com/v1",
      "apiKey": "sk-xxx",
      "overrides": {
        "gpt-5.6-sol": { "contextWindow": 272000 },
        "gpt-5.6-terra": { "contextWindow": 272000, "maxTokens": 64000 },
        "hy3-preview": { "reasoning": true }
      }
    }
  ]
}
```

Supported fields: `contextWindow` / `maxTokens` / `reasoning` / `thinkingLevelMap` / `cost` / `compat` / `name`. A manual `cost` override has the highest priority. Only listed models are affected; everything else stays automatic. When `contextWindow` is set, Pi auto-compacts before reaching the limit, so requests never exceed it.

### Price resolution and presets

Prices are resolved independently for every gateway model:

```text
manual model cost > gateway /api/pricing > selected fallback preset > $0
```

No public preset is applied unless you select it for that gateway. This avoids pretending that an official reference price is the amount charged by an unrelated proxy.

```text
/ai-gateway set-price show
/ai-gateway set-price preset models-dev
/ai-gateway set-price preset basellm
/ai-gateway set-price preset none
```

- `models-dev` uses provider-specific reference prices from <https://models.dev/api.json> only when the gateway has no price for a model.
- `basellm` converts the NewAPI ratio preset at <https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json> into per-million-token prices.
- `none` restores the default: gateway prices only, then `$0` for missing prices.

Set a manual model price, in USD per one million tokens:

```text
/ai-gateway set-price manual gpt-5.6-sol 5 30 0.5 6.25
/ai-gateway set-price remove gpt-5.6-sol
```

With no arguments after `manual`, Pi prompts for the model and four rates. Manual prices are stored in the existing per-model `overrides.cost` field.

## Commands

```
/ai-gateway               Open the interactive TUI menu
/ai-gateway add           Interactive wizard (name → baseUrl → apiKey)
/ai-gateway list          List configured gateways
/ai-gateway fetch [name]  Refetch model list + prices for all gateways, or one gateway
/ai-gateway remove <name> Remove a gateway
/ai-gateway test <name>   Test connectivity + report model count
/ai-gateway overrides     Show current per-model overrides
/ai-gateway overrides add [modelID] [contextWindow] [maxTokens]
                          Interactively set an override (current catalog value shown as default)
/ai-gateway overrides remove <modelID>
                          Remove an override for a model
/ai-gateway set-price show
                          Show this gateway's fallback preset and manual model prices
/ai-gateway set-price preset <none|models-dev|basellm>
                          Select a missing-price fallback for this gateway
/ai-gateway set-price manual <modelID> <input> <output> [cacheRead] [cacheWrite]
                          Set a manual USD-per-1M-token price
/ai-gateway set-price remove <modelID>
                          Remove a manual model price
```

### Setting overrides interactively (no manual JSON editing)

```
/ai-gateway overrides add
  → enter model ID (e.g. gpt-5.6-sol)
  → context window? press Enter to keep the current catalog value, or enter 272000
  → max output tokens? press Enter to keep
  → thinking support? keep / true / false
  → saved and re-registered automatically — takes effect immediately
```

Or pass arguments directly to skip the prompts:

```
/ai-gateway overrides add gpt-5.6-sol 272000
/ai-gateway overrides add gpt-5.6-sol 272000 64000
```

## How it works

```
At startup, or when you run /ai-gateway fetch, for each gateway:
  1. GET {baseUrl}/v1/models                  → model list
  2. GET {gatewayRoot}/api/pricing            → gateway prices + any models missing from /v1/models (best effort)
  3. Index Pi's built-in catalog providers/data/*.json → capability knowledge base
  4. Build a Responses-model set from Pi's canonical openai.json
  5. For each model id, borrow capabilities:
     reasoning / thinkingLevelMap / contextWindow / maxTokens / compat
     Not found → safe defaults (no thinking, 128K)
  6. Resolve price: manual > gateway > selected preset > $0
  7. Merge remaining user overrides
  8. Choose protocol: canonical OpenAI Responses models → /v1/responses; other models → /v1/chat/completions
  9. Filter out image/embedding/audio/tts/rerank models
  10. Register as provider: newapi/gpt-5.6-sol
```

### Config file vs cache file

| | `~/.pi/agent/ai-gateway.json` | `~/.pi/agent/ai-gateway-cache.json` |
|---|---|---|
| Content | Gateway URL, key, overrides | Snapshot of the last fetched model list |
| Written by | You (or the `/ai-gateway` commands) | The extension, overwritten on every registration |
| Lifetime | Permanent (this is the config) | Ephemeral (rewritten anytime, safe to delete) |
| Purpose | Your intent, read at Pi startup | Offline fallback when the gateway is unreachable |

Overrides **must** live in the config file — the cache is rewritten on every model fetch and would wipe them.

### What a contextWindow override actually affects

`contextWindow` is not a request parameter sent to the gateway; it is a **local ruler Pi uses to manage context** — Pi auto-compacts before the limit, so requests never actually exceed it. For example, setting `272000` on gpt-5.6-sol keeps requests out of the long-context billing tier. Verify the new value in `/model`.

## Development

```bash
npm test        # node --test, pure-function unit tests
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Startup log says `未配置网关` / no gateways configured | Run `/ai-gateway add` or create the config file |
| `与 Pi 内置 provider 重名` / name collides with a built-in provider | Choose another `name` (e.g. `my-openai`) |
| Gateway failed to register but Pi started fine | Check the startup log; a cached model list is used automatically (marked "cache degraded") |
| Models/prices look stale | Run `/ai-gateway fetch` (or `/ai-gateway fetch <name>`) |
| A model has no thinking levels | It's not in the built-in catalog — normal (defaults apply). Run `pi update --models` and restart |
