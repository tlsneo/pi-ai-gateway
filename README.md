# pi-ai-gateway

> **[简体中文](README.zh-CN.md)**

Register any OpenAI-compatible gateway (newapi, one-api, self-hosted proxies, ...) as a [Pi](https://pi.dev) provider.

- **Interactive TUI menu**: run `/ai-gateway` to manage gateways without memorizing subcommands
- **Automatic model discovery**: fetches `{baseUrl}/v1/models` at startup; run `/ai-gateway fetch` anytime to refresh models/prices without restart
- **Per-model protocol routing**: model API overrides take priority over gateway settings; newly added gateways default to `/v1/responses` for canonical OpenAI Responses models and `/v1/chat/completions` for others
- **Automatic metadata borrowing**: imports thinking support / thinking levels / context window / compat from Pi's built-in model catalog (the one refreshed by `pi update --models`)
- **Gateway-aware pricing**: uses NewAPI-compatible `{gatewayRoot}/api/pricing` whenever available, including context-length price tiers and pricing-only model IDs
- **Optional price presets**: when a gateway does not publish a model price, opt into Models.dev or BaseLLM defaults per gateway; manual prices always win
- **Per-model Speed requests**: a separate menu for Off / Fast / Ultrafast, off by default; requests a service tier without confirming backend acceleration
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

After upgrading the package, restart Pi so the new extension code is loaded.

## Quick start

Run the TUI menu:

```text
/ai-gateway
```

Then pick an action:

- `Add gateway` — save a new OpenAI-compatible gateway
- `Fetch models/prices` — refresh model list and prices without restarting Pi
- `Prices` — choose a fallback preset or set manual prices
- `Overrides` — choose per-model API routing and adjust context window, max output tokens, thinking support, etc.
- `Speed` — request Off / Fast / Ultrafast per model, independently of Overrides

Most users should use the menu. The subcommands below remain for scripting or quick one-off changes.

## Configuration

The menu writes `~/.pi/agent/ai-gateway.json` for you. You can also create it manually (template: `ai-gateway.example.json`):

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

`apiRouting: "auto"` is the default written by `/ai-gateway add`: unless a model or gateway `api` is explicit, models declared as `openai-responses` in Pi's canonical `openai.json` use `/v1/responses`, while all other models use `/v1/chat/completions`. `pricePreset` is optional; omit it if you only want prices published by the gateway itself.

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Provider name; models appear as `newapi/gpt-5.6-sol`. Must not collide with built-in Pi providers |
| `baseUrl` | ✅ | Gateway URL; `/v1` is appended automatically if missing |
| `apiKey` | ✅ | Write the key directly (the `$ENV` reference syntax is also supported) |
| `api` | ❌ | Gateway-wide Pi API type for models without `overrides[modelId].api`; takes precedence over `apiRouting` |
| `apiRouting` | ❌ | `"auto"`: when neither model nor gateway has an explicit `api`, canonical OpenAI Responses models use `openai-responses`, others use `openai-completions`; written by default for gateways created with `/ai-gateway add` |
| `headers` | ❌ | Extra request headers |
| `pricePreset` | ❌ | Missing-price fallback: `"models-dev"` or `"basellm"`; omitted means gateway prices only |
| `overrides` | ❌ | Per-model API routing, metadata, and manual price overrides (see below) |
| `speed` | ❌ | Per-model `"off"`, `"fast"`, or `"ultrafast"` requests, separate from `overrides` (see below) |

Protocol precedence:

```text
overrides[modelId].api > gateway api > apiRouting: "auto" (canonical catalog) > openai-completions
```

Automatic routing uses Pi's bundled `openai.json`, not a `gpt-` name prefix, so `gpt-oss-*` and unregistered gateway aliases stay on Chat Completions unless explicitly routed otherwise. Regular API-key gateways use `openai-responses`, not `openai-codex-responses`. If the gateway does not support `/v1/responses`, set `"api": "openai-completions"` on the model, or on the gateway for models without a model API override. Routing does not probe backend support or automatically fall back to another protocol; a configured API does not guarantee that the gateway supports it.

If you edit the JSON manually, restart Pi or run `/ai-gateway fetch`; all models then appear under `/model` with the configured provider prefix.

> Key security: the config file lives outside the repo and is chmod 600 automatically. Only `ai-gateway.example.json` (placeholders, zero secrets) is committed. Never commit the real config file.

### overrides: per-model API routing and metadata overrides (optional)

By default, capabilities come from Pi's built-in catalog, while prices come from the gateway's `/api/pricing` endpoint when it is available. Individual models can still be adjusted manually:

```json
{
  "gateways": [
    {
      "name": "newapi",
      "baseUrl": "https://your-gateway.example.com/v1",
      "apiKey": "sk-xxx",
      "overrides": {
        "gpt-5.6-sol": { "api": "openai-responses", "contextWindow": 272000 },
        "gpt-5.6-terra": { "contextWindow": 272000, "maxTokens": 64000 },
        "hy3-preview": { "reasoning": true }
      }
    }
  ]
}
```

Supported fields: `api` / `contextWindow` / `maxTokens` / `reasoning` / `thinkingLevelMap` / `cost` / `compat` / `name`. `GatewayConfig.overrides[modelId].api` is optional and accepts only `"openai-completions"` (`/v1/chat/completions`) or `"openai-responses"` (`/v1/responses`), keyed by exact model ID. Omit it to follow gateway routing; it takes precedence over the gateway's `api` when present. Explicit API choices are preserved even when they match the catalog default, not deduplicated away. A manual `cost` override has the highest priority. Only listed models receive these overrides; other models retain gateway routing and default metadata. When `contextWindow` is set, Pi auto-compacts before reaching the limit, so requests never exceed it.

### speed: per-model service-tier requests (optional)

Each gateway accepts `speed?: Record<modelId, "off" | "fast" | "ultrafast">`, keyed by exact model ID and stored separately from `overrides`. Speed is off by default; `ai-gateway.example.json` includes an opt-in placeholder.

| Mode | Effect at model registration (compatible model/API pairs) |
|---|---|
| `off` | Keeps an explicit record but adds no speed request parameters |
| `fast` | Sets `samplingParams.service_tier` to `"priority"` |
| `ultrafast` | Sets `samplingParams.service_tier` to `"ultrafast"` and the model header `OpenAI-Service-Tier: ultrafast` |

Fast and Ultrafast accept `gpt-` chat model IDs, excluding `gpt-oss` and non-chat models such as image models, without a hard-coded model allowlist. Compatibility is checked against each model's final API after routing precedence: Fast supports `openai-completions` and `openai-responses`; Ultrafast requires `openai-responses`. If a later API change makes the saved mode incompatible, the speed record is retained but no speed tier or header is sent; switching back to a compatible API (Responses for Ultrafast) enables it again. Speed does not change routing, probe backend capabilities, or automatically fall back.

The current model's registered tier appears as `⚡ Fast` or `⚡⚡ Ultrafast` in the footer; Off / no tier is hidden. It updates on save, removal, model switches, and session start/reload. With an updated [pi-cometix-footer](https://github.com/tlsneo/pi-cometix-footer), it sits beside the thinking level; Pi's default footer shows it as an extension status. Update both packages and run `/reload` to enable this placement. The status key is `ai-gateway-speed`; it reflects registered request parameters, not just a saved setting that may have failed to apply.

**These are requested tiers, not confirmed acceleration.** Gateways may discard or reject the parameters, or charge extra. Price resolution is unchanged: Pi displays estimates, not tier-accurate billing. Higher-priority configuration from other extensions or `models.json` can override the native parameters; Off does not guarantee that external settings are disabled.

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

## Subcommands

The interactive `/ai-gateway` menu is the default UI. These direct commands are optional:

```
/ai-gateway               Open the interactive TUI menu
/ai-gateway add           Interactive wizard (name → baseUrl → apiKey)
/ai-gateway list          List configured gateways
/ai-gateway fetch [name]  Refetch model list + prices for all gateways, or one gateway
/ai-gateway remove <name> Remove a gateway
/ai-gateway test <name>   Test connectivity + report model count
/ai-gateway overrides     Open the overrides menu (list overrides in non-interactive mode)
/ai-gateway overrides list
                          Show current per-model overrides
/ai-gateway overrides add [modelID] [contextWindow] [maxTokens]
                          Interactively set an override (current catalog value shown as default)
/ai-gateway overrides remove <modelID>
                          Remove an override for a model
/ai-gateway speed         Open the Speed menu (list saved settings without UI)
/ai-gateway speed list    List saved speed requests, not backend-confirmed tiers
/ai-gateway speed add [modelID] [off|fast|ultrafast]
                          Add or update a model's speed request
/ai-gateway speed remove [modelID]
                          Remove a saved speed entry
/ai-gateway set-price show
                          Show this gateway's fallback preset and manual model prices
/ai-gateway set-price preset <none|models-dev|basellm>
                          Select a missing-price fallback for this gateway
/ai-gateway set-price manual <modelID> <input> <output> [cacheRead] [cacheWrite]
                          Set a manual USD-per-1M-token price
/ai-gateway set-price remove <modelID>
                          Remove a manual model price
/ai-gateway help          Show command help, including speed
```

### Setting overrides interactively (no manual JSON editing)

```
/ai-gateway → Overrides → Add override (or /ai-gateway overrides add)
  → manually enter the exact model ID (e.g. gpt-5.6-sol)
  → API routing? Keep / Auto (follow gateway) /
      Chat Completions (/v1/chat/completions) / Responses (/v1/responses)
  → context window? press Enter to keep the current catalog value, or enter 272000
  → max output tokens? press Enter to keep
  → thinking support? keep / true / false
  → when thinking is enabled: keep / disable xhigh and max / xhigh only / max only / both
  → saved and re-registered automatically — the next request uses the new routing
```

API routing choices:

- `Keep` preserves the model's existing `api` field (or leaves it absent).
- `Auto (follow gateway)` deletes only the model's `api` field and follows gateway routing. It does **not** force automatic detection: an explicit gateway `api` still takes precedence over `apiRouting: "auto"`.
- `Chat Completions (/v1/chat/completions)` saves `"api": "openai-completions"` on the model.
- `Responses (/v1/responses)` saves `"api": "openai-responses"` on the model.

Among the last three choices, the saved per-model choice is marked `(current)`; an absent model `api` marks Auto, even when the gateway has an explicit API. Explicit choices are retained even if they match the catalog default. Numeric and thinking prompts are unchanged. Esc/cancellation at any step saves nothing.

Saving or removing an override re-registers the gateway. The currently selected model uses the updated API on its next request without reselecting it, while preserving the session's thinking level and other state; requests already in flight are unchanged. If re-registration fails, the configuration remains saved; retry `/ai-gateway fetch`.

Extended-level choices are saved as `thinkingLevelMap`, preserving lower-level restrictions and existing API mappings. Only enable levels your gateway/model actually supports: the plugin does not probe backend capabilities. After saving, use Pi's `/thinking` picker or Shift+Tab if you want to change the session's thinking level.

Or pass arguments directly to skip the corresponding numeric prompts. Existing non-UI command arguments are unchanged; no API routing argument is added. Without UI, set per-model `api` via the manual JSON configuration above, then run `/ai-gateway fetch` or restart Pi:

```
/ai-gateway overrides add gpt-5.6-sol 272000
/ai-gateway overrides add gpt-5.6-sol 272000 64000
```

### Setting speed interactively

`Speed` is a top-level menu alongside `Overrides`, not an override field:

```text
/ai-gateway → Speed (or /ai-gateway speed)
  → List speeds / Add / update speed / Remove speed
  → choose a gateway (skipped when only one is configured)
```

- `Add / update speed`: type the model ID manually, then choose Off / Fast / Ultrafast. The current value is marked `(current)` (Off when unset).
- `Remove speed`: choose from saved entries. Unlike Off, removal deletes the record; removing the last entry also removes the empty `speed` field.
- You can preset an undiscovered model ID, with a warning; the setting applies only after discovery on a compatible API.

For example, `/ai-gateway speed add gpt-5.6-sol fast` saves Fast, and `/ai-gateway speed remove gpt-5.6-sol` removes it. Without UI, `add` requires both model ID and mode; `remove` requires a model ID. With multiple gateways, non-UI commands ask you to use the interactive menu rather than choosing a gateway arbitrarily. There is no standalone `/fast` command.

Settings survive refreshes and restarts. Saving or removing re-registers the gateway in the current Pi process for the next request, with no effect on requests already in flight. If re-registration fails, the configuration remains saved; retry `/ai-gateway fetch`.

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
  8. Choose protocol: model overrides.api > gateway api > apiRouting: auto (canonical catalog) > openai-completions
  9. Filter out image/embedding/audio/tts/rerank models
  10. Check speed against each model's final API; apply compatible settings as native samplingParams and model headers
      Incompatible settings stay saved, but add no speed tier/header
  11. Register as provider: newapi/gpt-5.6-sol
```

### Config file vs cache file

| | `~/.pi/agent/ai-gateway.json` | `~/.pi/agent/ai-gateway-cache.json` |
|---|---|---|
| Content | Gateway URL, key, overrides, speed settings | Snapshot of the last fetched model list |
| Written by | You (or the `/ai-gateway` commands) | The extension, overwritten on every registration |
| Lifetime | Permanent (this is the config) | Ephemeral (rewritten anytime, safe to delete) |
| Purpose | Your intent, read at Pi startup | Offline fallback when the gateway is unreachable |

Overrides and speed settings **must** live in the config file — the cache is rewritten on every model fetch and would wipe them.

### What a contextWindow override actually affects

`contextWindow` is not a request parameter sent to the gateway; it is a **local ruler Pi uses to manage context** — Pi auto-compacts before the limit, so requests never actually exceed it. For example, setting `272000` on gpt-5.6-sol keeps requests out of the long-context billing tier. Verify the new value in `/model`.

## Development

```bash
npm test        # unit and mocked-menu tests; optional Pi integration is skipped
```

To also verify real HTTP requests against a local mock gateway (no paid API calls):

```bash
PI_TEST_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent npm test
```

The integration test uses Pi 1.3.0's SDK and checks tier parameters, header cleanup, request hooks, and immediate updates to the selected model.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Startup log says `未配置网关` / no gateways configured | Run `/ai-gateway`, choose `Add gateway`, or create the config file |
| `与 Pi 内置 provider 重名` / name collides with a built-in provider | Choose another `name` (e.g. `my-openai`) |
| Gateway failed to register but Pi started fine | Check the startup log; a cached model list is used automatically (marked "cache degraded") |
| Models/prices look stale | Run `/ai-gateway`, choose `Fetch models/prices`, or run `/ai-gateway fetch <name>` |
| A model has no thinking levels or is missing xhigh/max | `/ai-gateway overrides` → `Add override`, enable thinking and the extended levels supported by your backend, then select a level with `/thinking` |
