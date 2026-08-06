# pi-ai-gateway

> **[简体中文](README.zh-CN.md)**

Register any OpenAI-compatible gateway (newapi, one-api, self-hosted proxies, ...) as a [Pi](https://pi.dev) provider.

- **Automatic model discovery**: fetches `{baseUrl}/v1/models` at startup — new models added on the gateway appear automatically
- **Automatic metadata borrowing**: imports thinking support / thinking levels / context window / pricing / compat from Pi's built-in model catalog (the one refreshed by `pi update --models`) — no manual configuration
- **Zero noise**: automatically filters out non-chat models (image / embedding / tts / rerank)
- **Resilient**: a failing gateway never breaks Pi startup; falls back to a cached model list when offline
- **Zero dependencies**: pure extension, no third-party npm packages

## Install

```bash
pi install git:github.com/<your-username>/pi-ai-gateway
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
      "apiKey": "sk-your-key"
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Provider name; models appear as `newapi/gpt-5.6-sol`. Must not collide with built-in Pi providers |
| `baseUrl` | ✅ | Gateway URL; `/v1` is appended automatically if missing |
| `apiKey` | ✅ | Write the key directly (the `$ENV` reference syntax is also supported) |
| `api` | ❌ | Defaults to `openai-completions` |
| `headers` | ❌ | Extra request headers |
| `overrides` | ❌ | Per-model metadata overrides (see below) |

Restart Pi after configuring; all models will appear under `/model` with the `newapi/` prefix.

> Key security: the config file lives outside the repo and is chmod 600 automatically. Only `ai-gateway.example.json` (placeholders, zero secrets) is committed. Never commit the real config file.

### overrides: per-model metadata overrides (optional)

By default, context / thinking / pricing come automatically from Pi's built-in catalog. For individual models that need adjustment (e.g. capping GPT-5.6 at 272K tokens to stay in the cheap billing tier), override per model:

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

Supported fields: `contextWindow` / `maxTokens` / `reasoning` / `thinkingLevelMap` / `cost` / `compat` / `name`. Only listed models are affected; everything else stays automatic. When `contextWindow` is set, Pi auto-compacts before reaching the limit, so requests never exceed it.

## Commands

```
/ai-gateway add           Interactive wizard (name → baseUrl → apiKey)
/ai-gateway list          List configured gateways
/ai-gateway remove <name> Remove a gateway
/ai-gateway test <name>   Test connectivity + report model count
/ai-gateway overrides     Show current per-model overrides
/ai-gateway overrides add [modelID] [contextWindow] [maxTokens]
                          Interactively set an override (current catalog value shown as default)
/ai-gateway overrides remove <modelID>
                          Remove an override for a model
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
At startup, for each gateway:
  1. GET {baseUrl}/v1/models                  → model list
  2. Index Pi's built-in catalog providers/data/*.json → model knowledge base
  3. For each model id, borrow metadata:
     reasoning / thinkingLevelMap / contextWindow / maxTokens / cost / compat
     Not found → safe defaults (no thinking, 128K, price $0)
  4. Merge user overrides
  5. Filter out image/embedding/audio/tts/rerank models
  6. Register as provider: newapi/gpt-5.6-sol
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
| A model has no thinking levels | It's not in the built-in catalog — normal (defaults apply). Run `pi update --models` and restart |
