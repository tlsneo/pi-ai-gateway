/**
 * ai-gateway — generic OpenAI-compatible gateway provider registration extension.
 *
 * Registers any OpenAI-compatible gateway (newapi, one-api, etc.) as a Pi provider:
 *   - Automatically fetches {baseUrl}/v1/models at startup for the model list
 *   - Borrows capabilities from Pi's built-in model catalog
 *   - Uses gateway-published /api/pricing when available; optional presets fill missing prices
 *   - Optionally routes canonical OpenAI models through the Responses API
 *   - Models missing from the catalog get safe defaults without blocking registration
 *   - Automatically filters out non-chat models (image/embedding/audio/tts/rerank)
 *   - Per-gateway failure isolation + cache fallback, Pi startup never breaks
 *
 * Config: ~/.pi/agent/ai-gateway.json (see ai-gateway.example.json)
 * Commands: /ai-gateway add|list|fetch|remove|test|overrides|set-price
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  BASELLM_PRICE_PRESET_URL,
  MODELS_DEV_PRICE_PRESET_URL,
  ZERO_COST,
  buildModelsDevCatalog,
  normalizeCost,
  parseNewApiPricing,
  parseNewApiPricingModelIds,
  parseNewApiRatioCatalog,
  resolveModelCost,
  type ModelCost,
  type PriceCatalog,
  type PricePreset,
} from "../src/pricing.ts";

// ===========================================================================
// Constants
// ===========================================================================

const CONFIG_FILENAME = "ai-gateway.json";
const CACHE_FILENAME = "ai-gateway-cache.json";
const DEFAULT_AGENT_DIR = path.join(".pi", "agent");
const FETCH_TIMEOUT_MS = 8000;
const NOISE_PATTERN = /image|embedding|audio|tts|rerank|dall-e|whisper/i;
const DEFAULT_API = "openai-completions";
const OPENAI_RESPONSES_API = "openai-responses";
const OPENAI_CATALOG_FILENAME = "openai.json";
const DEFAULT_API_ROUTING = "auto";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const PRICING_FETCH_TIMEOUT_MS = 5000;
const PRESET_FETCH_TIMEOUT_MS = 8000;

/** Gateway names colliding with built-in providers are rejected (prevents accidental replacement). */
const BUILTIN_PROVIDERS = new Set([
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
]);

// ===========================================================================
// Section 1: config — read/write ~/.pi/agent/ai-gateway.json
// ===========================================================================

export type ApiRoutingMode = "auto";

export interface GatewayConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Optional gateway-wide API override. Takes precedence over apiRouting. */
  api?: string;
  /** Per-model protocol routing. New gateways default to "auto". */
  apiRouting?: ApiRoutingMode;
  headers?: Record<string, string>;
  /** Optional fallback source used only when the gateway does not publish a model price. */
  pricePreset?: PricePreset;
  /** Optional per-model metadata overrides, e.g. { "gpt-5.6-sol": { "contextWindow": 272000 } } */
  overrides?: Record<string, Partial<ModelMeta>>;
}

export interface GatewayFile {
  gateways: GatewayConfig[];
}

/** Agent config directory: PI_CODING_AGENT_DIR takes precedence, default ~/.pi/agent */
export function agentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir.replace(/^~/, os.homedir());
  return path.join(os.homedir(), DEFAULT_AGENT_DIR);
}

export function configPath(): string {
  return path.join(agentDir(), CONFIG_FILENAME);
}

export function cachePath(): string {
  return path.join(agentDir(), CACHE_FILENAME);
}

export function parseGatewayConfig(raw: string): { ok: true; value: GatewayFile } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "top level must be an object with a gateways array" };
  }
  const gateways = (parsed as { gateways?: unknown }).gateways ?? [];
  if (!Array.isArray(gateways)) {
    return { ok: false, error: "gateways must be an array" };
  }
  return { ok: true, value: { gateways: gateways as GatewayConfig[] } };
}

/** Validate a single gateway; returns an error message, or null when valid. */
export function validateGateway(gw: GatewayConfig): string | null {
  if (!gw.name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(gw.name)) {
    return `name "${gw.name}" invalid: must start with an alphanumeric and may contain - _`;
  }
  if (BUILTIN_PROVIDERS.has(gw.name)) {
    return `name "${gw.name}" collides with a built-in Pi provider; rejected to prevent accidental replacement`;
  }
  if (!gw.baseUrl || !/^https?:\/\//.test(gw.baseUrl)) {
    return `baseUrl "${gw.baseUrl}" invalid: must start with http(s)://`;
  }
  if (!gw.apiKey) {
    return "apiKey must not be empty";
  }
  if (gw.api !== undefined && typeof gw.api !== "string") {
    return "api must be a string";
  }
  if (gw.apiRouting !== undefined && gw.apiRouting !== "auto") {
    return 'apiRouting must be "auto"';
  }
  if (gw.pricePreset !== undefined && gw.pricePreset !== "models-dev" && gw.pricePreset !== "basellm") {
    return 'pricePreset must be "models-dev" or "basellm"';
  }
  if (gw.overrides !== undefined) {
    if (gw.overrides === null || typeof gw.overrides !== "object" || Array.isArray(gw.overrides)) {
      return "overrides must be an object { modelId: { contextWindow?: number, ... } }";
    }
  }
  return null;
}

/** Normalize baseUrl: strip trailing slashes, append /v1 when missing. */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (!/\/v1$/i.test(u)) u += "/v1";
  return u;
}

export function loadConfig(): GatewayFile {
  const p = configPath();
  if (!fs.existsSync(p)) return { gateways: [] };
  const parsed = parseGatewayConfig(fs.readFileSync(p, "utf8"));
  return parsed.ok ? parsed.value : { gateways: [] };
}

/** Atomic config write (tmp + rename), permissions tightened to 600. */
export function saveConfig(file: GatewayFile): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // chmod failure must not block (e.g. Windows)
  }
}

// ===========================================================================
// Section 2: catalog — borrow metadata from Pi's built-in model catalog
// ===========================================================================

export interface ModelMeta {
  name?: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

const DEFAULT_META: ModelMeta = {
  reasoning: false,
  input: ["text"],
  cost: ZERO_COST,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
};

/** Locate pi-ai's built-in model data directory; returns null when not found (all defaults then apply). */
export function findPiAiDataDir(): string | null {
  const candidates: string[] = [];

  // 1) Derive the package root from the pi process entry
  //    (under npm/npx, argv[1] is the bin symlink — resolve it first)
  try {
    const entryRaw = process.argv[1];
    if (entryRaw) {
      const entry = fs.realpathSync(entryRaw);
      const idx = entry.indexOf("pi-coding-agent");
      if (idx !== -1) {
        const pkgRoot = entry.slice(0, idx + "pi-coding-agent".length);
        candidates.push(
          path.join(pkgRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"),
        );
      }
    }
  } catch {
    // ignore
  }

  // 2) import.meta.resolve (hit when pi's extension loader provides a package map)
  try {
    const resolved = import.meta.resolve("@earendil-works/pi-ai/package.json");
    if (typeof resolved === "string" && resolved.startsWith("file:")) {
      candidates.push(path.join(fileURLToPath(resolved), "dist", "providers", "data"));
    }
  } catch {
    // ignore
  }

  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(dir)) return dir;
    } catch {
      // ignore
    }
  }
  return null;
}

/** Read canonical OpenAI model ids that Pi declares for the standard Responses API. */
export function buildOpenAIResponsesModelIds(dataDir: string): Set<string> {
  const ids = new Set<string>();
  const file = path.join(dataDir, OPENAI_CATALOG_FILENAME);
  if (!fs.existsSync(file)) return ids;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return ids;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return ids;

  for (const bucket of Object.values(raw as Record<string, unknown>)) {
    const entries = Array.isArray(bucket)
      ? bucket
      : bucket !== null && typeof bucket === "object"
        ? Object.values(bucket as Record<string, unknown>)
        : [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const model = entry as { id?: unknown; api?: unknown; provider?: unknown };
      if (model.provider === "openai" && model.api === OPENAI_RESPONSES_API && typeof model.id === "string") {
        ids.add(model.id);
      }
    }
  }
  return ids;
}

/** Metadata completeness score: when the same id appears under multiple providers, pick the fullest entry. */
export function metaCompleteness(m: ModelMeta): number {
  let score = 0;
  const tlm = m.thinkingLevelMap;
  if (tlm) {
    for (const v of Object.values(tlm)) {
      if (v !== null && v !== undefined) {
        score += 3;
        break;
      }
    }
  }
  if (m.compat && typeof m.compat.thinkingFormat === "string") score += 2;
  if (m.reasoning) score += 2;
  if (m.cost && m.cost.input > 0) score += 1;
  return score;
}

function toMeta(m: Record<string, unknown>): ModelMeta {
  const cost = m.cost as Partial<ModelMeta["cost"]> | undefined;
  const input = m.input as ModelMeta["input"] | undefined;
  return {
    name: typeof m.name === "string" ? m.name : undefined,
    reasoning: m.reasoning === true,
    thinkingLevelMap: m.thinkingLevelMap as ModelMeta["thinkingLevelMap"] | undefined,
    input: Array.isArray(input) && input.length > 0 ? input : DEFAULT_META.input,
    cost: normalizeCost(cost) ?? ZERO_COST,
    contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : DEFAULT_CONTEXT_WINDOW,
    maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : DEFAULT_MAX_TOKENS,
    compat: m.compat as Record<string, unknown> | undefined,
  };
}

/** Build an id → metadata index. Supports both file shapes:
 *  { "<api-type>": [model...] }          (array form)
 *  { "<api-type>": { "<model-id>": m } } (object form, used by the real built-in catalog) */
export function buildCatalogIndex(dataDir: string): Map<string, ModelMeta> {
  const index = new Map<string, ModelMeta>();
  if (!fs.existsSync(dataDir)) return index;

  const indexEntry = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string") return;
    const meta = toMeta(entry as Record<string, unknown>);
    const existing = index.get(id);
    if (!existing || metaCompleteness(meta) > metaCompleteness(existing)) {
      index.set(id, meta);
    }
  };

  for (const f of fs.readdirSync(dataDir)) {
    if (!f.endsWith(".json")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
    } catch {
      continue;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      const value = (raw as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const entry of value) indexEntry(entry);
      } else if (value !== null && typeof value === "object") {
        for (const id of Object.keys(value as Record<string, unknown>)) {
          indexEntry((value as Record<string, unknown>)[id]);
        }
      }
    }
  }
  return index;
}

/** Borrow metadata: use the catalog entry when present, otherwise safe defaults. */
export function borrowMeta(catalog: Map<string, ModelMeta>, id: string): ModelMeta {
  const found = catalog.get(id);
  return found ?? DEFAULT_META;
}

/** Apply user overrides: shallow-merge the configured fields onto the base metadata. */
export function applyOverrides(
  id: string,
  base: ModelMeta,
  overrides: Record<string, Partial<ModelMeta>> | undefined,
): ModelMeta {
  if (!overrides) return base;
  const o = overrides[id];
  return o && typeof o === "object" ? { ...base, ...o } : base;
}

// ===========================================================================
// Section 3: gateway — fetch model list + filter + cache fallback
// ===========================================================================

export function mergeModelIds(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const id of [...primary, ...secondary]) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(id);
  }
  return merged;
}

/** Remove non-chat noise models (image/embedding/audio/tts/rerank...). */
export function filterModelIds(ids: string[]): string[] {
  return ids.filter((id) => !NOISE_PATTERN.test(id));
}

/** Remove the OpenAI-compatible /v1 suffix to address gateway-owned REST endpoints. */
export function gatewayRootUrl(url: string): string {
  return normalizeBaseUrl(url).replace(/\/v1$/i, "");
}

async function fetchJson(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

interface GatewayPriceInfo {
  prices: PriceCatalog;
  modelIds: string[];
}

async function fetchGatewayPriceInfo(gw: GatewayConfig): Promise<GatewayPriceInfo> {
  const root = gatewayRootUrl(gw.baseUrl);
  try {
    const [pricingResult, statusResult] = await Promise.allSettled([
      fetchJson(`${root}/api/pricing`, PRICING_FETCH_TIMEOUT_MS),
      fetchJson(`${root}/api/status`, PRICING_FETCH_TIMEOUT_MS),
    ]);
    if (pricingResult.status !== "fulfilled") return { prices: new Map(), modelIds: [] };
    const status = statusResult.status === "fulfilled" && statusResult.value && typeof statusResult.value === "object"
      ? statusResult.value as { data?: { quota_per_unit?: unknown } }
      : undefined;
    const quotaPerUnit = typeof status?.data?.quota_per_unit === "number" && status.data.quota_per_unit > 0
      ? status.data.quota_per_unit
      : 500_000;
    return {
      prices: parseNewApiPricing(pricingResult.value, quotaPerUnit),
      modelIds: parseNewApiPricingModelIds(pricingResult.value),
    };
  } catch {
    return { prices: new Map(), modelIds: [] };
  }
}

const presetPayloads = new Map<PricePreset, Promise<unknown>>();

export function clearPresetPriceCache(): void {
  presetPayloads.clear();
}

async function fetchPresetPayload(preset: PricePreset): Promise<unknown> {
  const existing = presetPayloads.get(preset);
  if (existing) return existing;
  const url = preset === "models-dev" ? MODELS_DEV_PRICE_PRESET_URL : BASELLM_PRICE_PRESET_URL;
  const request = fetchJson(url, PRESET_FETCH_TIMEOUT_MS).catch((error) => {
    presetPayloads.delete(preset);
    throw error;
  });
  presetPayloads.set(preset, request);
  return request;
}

async function fetchPresetPrices(preset: PricePreset | undefined, modelIds: string[]): Promise<PriceCatalog> {
  if (!preset) return new Map();
  try {
    const payload = await fetchPresetPayload(preset);
    return preset === "models-dev"
      ? buildModelsDevCatalog(payload, modelIds)
      : parseNewApiRatioCatalog(payload);
  } catch (error) {
    console.warn(`[ai-gateway] Price preset ${preset} unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
}

export async function fetchModelIds(gw: GatewayConfig): Promise<string[]> {
  const url = `${normalizeBaseUrl(gw.baseUrl)}/models`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${gw.apiKey}`,
    ...(gw.headers ?? {}),
  };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? [])
    .map((m) => m.id)
    .filter((x): x is string => typeof x === "string");
  return ids;
}

export function loadCache(): Record<string, string[]> {
  try {
    const p = cachePath();
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

export function saveCache(cache: Record<string, string[]>): void {
  try {
    const p = cachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, p);
  } catch {
    // cache write failure must not block
  }
}

export function resolveModelApi(
  gateway: Pick<GatewayConfig, "api" | "apiRouting">,
  modelId: string,
  openAIResponsesModelIds: ReadonlySet<string>,
): ProviderConfig["api"] {
  if (gateway.api !== undefined) return gateway.api as ProviderConfig["api"];
  if (gateway.apiRouting === "auto" && openAIResponsesModelIds.has(modelId)) return OPENAI_RESPONSES_API;
  return DEFAULT_API;
}

function toProviderModel(
  id: string,
  meta: ModelMeta,
  apiOverride?: ProviderConfig["api"],
): ProviderModelConfig {
  return {
    id,
    name: meta.name ?? id,
    ...(apiOverride ? { api: apiOverride } : {}),
    reasoning: meta.reasoning,
    ...(meta.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
    input: meta.input,
    cost: meta.cost,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    ...(meta.compat ? { compat: meta.compat } : {}),
  };
}

export interface RegisterResult {
  ok: boolean;
  gateway: string;
  modelCount: number;
  degraded: boolean;
  error?: string;
}

/**
 * Register a gateway as a Pi provider. On failure, prefer the cached model list;
 * with no usable cache, return an error (caller decides whether to skip).
 */
export async function registerGateway(
  pi: ExtensionAPI,
  gw: GatewayConfig,
  catalog: Map<string, ModelMeta>,
  cache: Record<string, string[]>,
  openAIResponsesModelIds: ReadonlySet<string> = new Set(),
): Promise<RegisterResult> {
  const gatewayPriceInfoPromise = fetchGatewayPriceInfo(gw);
  let ids: string[];
  let degraded = false;
  try {
    ids = await fetchModelIds(gw);
  } catch (e) {
    const cached = cache[gw.name];
    if (cached && cached.length > 0) {
      ids = cached;
      degraded = true;
    } else {
      return {
        ok: false,
        gateway: gw.name,
        modelCount: 0,
        degraded: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const gatewayPriceInfo = await gatewayPriceInfoPromise;
  const filtered = filterModelIds(mergeModelIds(ids, gatewayPriceInfo.modelIds));
  const presetPrices = await fetchPresetPrices(gw.pricePreset, filtered);
  const gatewayPrices = gatewayPriceInfo.prices;
  const providerApi = (gw.api as ProviderConfig["api"]) ?? DEFAULT_API;
  const models = filtered.map((id) => {
    const override = gw.overrides?.[id];
    const meta = applyOverrides(id, borrowMeta(catalog, id), gw.overrides);
    const modelApi = resolveModelApi(gw, id, openAIResponsesModelIds);
    return toProviderModel(id, {
      ...meta,
      cost: resolveModelCost(id, gatewayPrices, presetPrices, override?.cost),
    }, modelApi === providerApi ? undefined : modelApi);
  });

  const config: ProviderConfig = {
    name: gw.name,
    baseUrl: normalizeBaseUrl(gw.baseUrl),
    apiKey: gw.apiKey,
    api: providerApi,
    ...(gw.headers && Object.keys(gw.headers).length > 0 ? { headers: gw.headers } : {}),
    models,
  };

  pi.registerProvider(gw.name, config);

  saveCache({ ...loadCache(), [gw.name]: filtered });

  return { ok: true, gateway: gw.name, modelCount: models.length, degraded };
}

// ===========================================================================
// Section 4: index — extension entry point
// ===========================================================================

async function gatewayCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { ui } = ctx;
  const [sub, ...rest] = args.trim().split(/\s+/);

  switch (sub ?? "") {
    case "add":
      return addGateway(pi, ctx);
    case "list":
      return listGateways(ctx);
    case "fetch":
    case "update":
    case "refresh":
      await refreshGateways(pi, ctx, rest[0]);
      return;
    case "remove": {
      const name = rest[0];
      if (!name) {
        ui.notify("Usage: /ai-gateway remove <name>", "warning");
        return;
      }
      const config = loadConfig();
      const next = config.gateways.filter((g) => g.name !== name);
      if (next.length === config.gateways.length) {
        ui.notify(`Gateway "${name}" does not exist`, "warning");
        return;
      }
      saveConfig({ gateways: next });
      ui.notify(`Removed gateway "${name}". Restart Pi for it to fully take effect`, "info");
      return;
    }
    case "test": {
      const name = rest[0];
      if (!name) {
        ui.notify("Usage: /ai-gateway test <name>", "warning");
        return;
      }
      const gw = loadConfig().gateways.find((g) => g.name === name);
      if (!gw) {
        ui.notify(`Gateway "${name}" is not in the config`, "warning");
        return;
      }
      ui.setStatus("ai-gateway", `Testing ${name}...`);
      try {
        const ids = await fetchModelIds(gw);
        const filtered = filterModelIds(ids);
        ui.notify(`Gateway "${name}" OK: ${ids.length} models total, ${filtered.length} usable`, "info");
      } catch (e) {
        ui.notify(`Gateway "${name}" connection failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        ui.setStatus("ai-gateway", undefined);
      }
      return;
    }
    case "overrides":
      return overridesCommand(pi, ctx, rest.join(" "));
    case "set-price":
      return setPriceCommand(pi, ctx, rest);
    default:
      ui.notify("Usage: /ai-gateway add | list | fetch [name] | remove <name> | test <name> | overrides [...] | set-price [...]", "info");
  }
}

export interface RefreshResult {
  requested: number;
  ok: number;
  failed: number;
  modelCount: number;
}

export async function refreshGateways(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name?: string,
): Promise<RefreshResult> {
  const config = loadConfig();
  if (config.gateways.length === 0) {
    ctx.ui.notify("No gateways configured. Run /ai-gateway add first", "warning");
    return { requested: 0, ok: 0, failed: 0, modelCount: 0 };
  }

  const targetName = name?.trim();
  const targets = targetName ? config.gateways.filter((g) => g.name === targetName) : config.gateways;
  if (targetName && targets.length === 0) {
    ctx.ui.notify(`Gateway "${targetName}" is not in the config`, "warning");
    return { requested: 0, ok: 0, failed: 0, modelCount: 0 };
  }

  clearPresetPriceCache();
  const dataDir = findPiAiDataDir() ?? "";
  const catalog = buildCatalogIndex(dataDir);
  const openAIResponsesModelIds = buildOpenAIResponsesModelIds(dataDir);
  const summary: RefreshResult = { requested: targets.length, ok: 0, failed: 0, modelCount: 0 };

  ctx.ui.setStatus("ai-gateway", `Fetching ${targetName ?? `${targets.length} gateways`}...`);
  try {
    for (const gw of targets) {
      const err = validateGateway(gw);
      if (err) {
        summary.failed += 1;
        ctx.ui.notify(`Skipping gateway "${gw.name ?? "(unnamed)"}": ${err}`, "error");
        continue;
      }

      const result = await registerGateway(pi, gw, catalog, loadCache(), openAIResponsesModelIds);
      if (result.ok) {
        summary.ok += 1;
        summary.modelCount += result.modelCount;
        ctx.ui.notify(
          `Gateway "${result.gateway}" refreshed: ${result.modelCount} models/prices` +
            (result.degraded ? " (models from cache)" : ""),
          result.degraded ? "warning" : "info",
        );
      } else {
        summary.failed += 1;
        ctx.ui.notify(`Gateway "${result.gateway}" refresh failed: ${result.error}`, "error");
      }
    }

    if (targets.length > 1) {
      ctx.ui.notify(
        `Fetch complete: ${summary.ok}/${summary.requested} gateways, ${summary.modelCount} models` +
          (summary.failed ? `, ${summary.failed} failed` : ""),
        summary.failed ? "warning" : "info",
      );
    }
    return summary;
  } finally {
    ctx.ui.setStatus("ai-gateway", undefined);
  }
}

// ---------------------------------------------------------------------------
// /ai-gateway set-price — configure gateway price discovery and fallbacks
// ---------------------------------------------------------------------------

function updateGateway(gateway: GatewayConfig): void {
  const config = loadConfig();
  saveConfig({ gateways: config.gateways.map((item) => (item.name === gateway.name ? gateway : item)) });
}

function parseNonNegativeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const number = Number(trimmed);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function setPriceCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<void> {
  const gw = await pickGateway(ctx);
  if (!gw) return;
  const [action = "show", ...rest] = args;

  switch (action) {
    case "show": {
      const manual = Object.entries(gw.overrides ?? {}).filter(([, override]) => override.cost !== undefined);
      const lines = [
        `Gateway: ${gw.name}`,
        `Fallback preset: ${gw.pricePreset ?? "none"}`,
        `Manual model prices: ${manual.length}`,
        ...manual.map(([id, override]) => `• ${id}: ${JSON.stringify(override.cost)}`),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }
    case "preset": {
      let value: string | undefined = rest[0]?.toLowerCase();
      if (!value && ctx.hasUI) {
        value = (await ctx.ui.select("Price fallback preset", ["none", "models-dev", "basellm"])) ?? undefined;
      }
      if (value !== "none" && value !== "models-dev" && value !== "basellm") {
        ctx.ui.notify("Usage: /ai-gateway set-price preset <none|models-dev|basellm>", "warning");
        return;
      }
      const next: GatewayConfig = { ...gw, pricePreset: value === "none" ? undefined : value };
      updateGateway(next);
      ctx.ui.notify(`Price fallback for "${gw.name}" set to ${value}; re-registering...`, "info");
      await reregister(pi, next, ctx);
      return;
    }
    case "manual": {
      let [modelId, inputRaw, outputRaw, cacheReadRaw, cacheWriteRaw] = rest as Array<string | undefined>;
      if (!modelId && ctx.hasUI) modelId = (await ctx.ui.input("Model ID (e.g. gpt-5.6-sol)")) ?? undefined;
      if (!modelId) return;

      if (inputRaw === undefined && ctx.hasUI) inputRaw = (await ctx.ui.input("Input USD per 1M tokens", "0")) ?? undefined;
      if (outputRaw === undefined && ctx.hasUI) outputRaw = (await ctx.ui.input("Output USD per 1M tokens", "0")) ?? undefined;
      if (cacheReadRaw === undefined && ctx.hasUI) cacheReadRaw = (await ctx.ui.input("Cache read USD per 1M tokens", "0")) ?? undefined;
      if (cacheWriteRaw === undefined && ctx.hasUI) cacheWriteRaw = (await ctx.ui.input("Cache write USD per 1M tokens", "0")) ?? undefined;

      const parsed = [inputRaw, outputRaw, cacheReadRaw ?? "0", cacheWriteRaw ?? "0"].map((value) =>
        parseNonNegativeNumber(value ?? ""),
      );
      if (parsed.some((value) => value === null)) {
        ctx.ui.notify("Prices must be non-negative numbers", "error");
        return;
      }
      const [input, output, cacheRead, cacheWrite] = parsed as number[];
      const overrides = { ...(gw.overrides ?? {}) };
      overrides[modelId] = {
        ...(overrides[modelId] ?? {}),
        cost: { input, output, cacheRead, cacheWrite },
      };
      const next = { ...gw, overrides };
      updateGateway(next);
      ctx.ui.notify(`Saved manual price for "${modelId}"; re-registering...`, "info");
      await reregister(pi, next, ctx);
      return;
    }
    case "remove": {
      const modelId = rest[0];
      if (!modelId) {
        ctx.ui.notify("Usage: /ai-gateway set-price remove <modelID>", "warning");
        return;
      }
      const overrides = { ...(gw.overrides ?? {}) };
      const current = overrides[modelId];
      if (!current?.cost) {
        ctx.ui.notify(`No manual price configured for "${modelId}"`, "warning");
        return;
      }
      const { cost: _cost, ...metadataOverride } = current;
      if (Object.keys(metadataOverride).length > 0) overrides[modelId] = metadataOverride;
      else delete overrides[modelId];
      const next = { ...gw, overrides: Object.keys(overrides).length > 0 ? overrides : undefined };
      updateGateway(next);
      ctx.ui.notify(`Removed manual price for "${modelId}"; re-registering...`, "info");
      await reregister(pi, next, ctx);
      return;
    }
    default:
      ctx.ui.notify(
        "Usage: /ai-gateway set-price [show|preset <none|models-dev|basellm>|manual <modelID> <input> <output> [cacheRead] [cacheWrite]|remove <modelID>]",
        "info",
      );
  }
}

// ---------------------------------------------------------------------------
// /ai-gateway overrides — interactively configure per-model metadata overrides
// ---------------------------------------------------------------------------

/** Parse a positive integer; returns null when invalid. */
export function toPositiveInt(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Pick the target gateway: return it directly when there's only one, otherwise show a selector. */
async function pickGateway(ctx: ExtensionCommandContext): Promise<GatewayConfig | null> {
  const config = loadConfig();
  if (config.gateways.length === 0) {
    ctx.ui.notify("No gateways configured. Run /ai-gateway add first", "warning");
    return null;
  }
  if (config.gateways.length === 1) return config.gateways[0];
  const picked = await ctx.ui.select("Select gateway", config.gateways.map((g) => g.name));
  if (!picked) return null;
  return config.gateways.find((g) => g.name === picked) ?? null;
}

async function overridesCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const { ui } = ctx;
  const gw = await pickGateway(ctx);
  if (!gw) return;
  const [sub, ...rest] = args.trim().split(/\s+/);
  const config = loadConfig();
  const current = config.gateways.find((g) => g.name === gw.name) ?? gw;

  switch (sub ?? "list") {
    case "list": {
      const ov = current.overrides ?? {};
      const keys = Object.keys(ov);
      if (keys.length === 0) {
        ui.notify(`No overrides configured for gateway "${current.name}". Run /ai-gateway overrides add`, "info");
        return;
      }
      const lines = keys.map((id) => `• ${id}: ${JSON.stringify(ov[id])}`);
      ui.notify(`Overrides for gateway "${current.name}":\n${lines.join("\n")}`, "info");
      return;
    }
    case "remove": {
      const modelId = rest[0];
      if (!modelId) {
        ui.notify("Usage: /ai-gateway overrides remove <modelID>", "warning");
        return;
      }
      const ov = { ...(current.overrides ?? {}) };
      if (!(modelId in ov)) {
        ui.notify(`No override configured for model "${modelId}"`, "warning");
        return;
      }
      delete ov[modelId];
      const next = { ...current, overrides: Object.keys(ov).length > 0 ? ov : undefined };
      saveConfig({ gateways: config.gateways.map((g) => (g.name === next.name ? next : g)) });
      ui.notify(`Removed override for "${modelId}", re-registering...`, "info");
      await reregister(pi, next, ctx);
      return;
    }
    case "add":
      return overridesAdd(pi, ctx, current, rest);
    default:
      ui.notify("Usage: /ai-gateway overrides list | add [modelID] [contextWindow] [maxTokens] | remove <modelID>", "info");
  }
}

/** Re-register a gateway so override changes take effect immediately (no restart needed). */
async function reregister(pi: ExtensionAPI, gw: GatewayConfig, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.setStatus("ai-gateway", `Re-registering ${gw.name}...`);
  try {
    const dataDir = findPiAiDataDir() ?? "";
    const catalog = buildCatalogIndex(dataDir);
    const result = await registerGateway(pi, gw, catalog, loadCache(), buildOpenAIResponsesModelIds(dataDir));
    if (result.ok) {
      ctx.ui.notify(
        `Gateway "${gw.name}" re-registered: ${result.modelCount} models` + (result.degraded ? " (cache degraded)" : ""),
        "info",
      );
    } else {
      ctx.ui.notify(`Re-registration failed: ${result.error}`, "error");
    }
  } finally {
    ctx.ui.setStatus("ai-gateway", undefined);
  }
}

async function overridesAdd(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  gw: GatewayConfig,
  args: string[],
): Promise<void> {
  const { ui } = ctx;
  const catalog = buildCatalogIndex(findPiAiDataDir() ?? "");
  const currentOv = { ...(gw.overrides ?? {}) };

  // Argument form: /ai-gateway overrides add <modelID> [contextWindow] [maxTokens]
  let modelId: string | undefined = args[0];
  const argCtx = toPositiveInt(args[1] ?? "");
  const argMax = toPositiveInt(args[2] ?? "");

  if (!modelId) {
    modelId = (await ui.input("Model ID (e.g. gpt-5.6-sol)")) ?? undefined;
    if (!modelId) return;
  }
  modelId = modelId.trim();

  const catalogBase = borrowMeta(catalog, modelId);
  const existingOverride = currentOv[modelId] ?? {};
  const base = applyOverrides(modelId, catalogBase, currentOv);
  const curCtx = base.contextWindow;
  const curMax = base.maxTokens;
  const curReasoning = base.reasoning;

  let contextWindow: number | undefined;
  if (argCtx !== null) {
    contextWindow = argCtx;
  } else if (ctx.hasUI) {
    const input = await ui.input(
      `Context window (current ${curCtx}, Enter to keep, e.g. 272000)`,
      String(curCtx),
    );
    if (input !== undefined && input.trim() !== "") {
      const n = toPositiveInt(input);
      if (n === null) {
        ui.notify("Context window must be a positive integer", "error");
        return;
      }
      contextWindow = n;
    }
  }

  let maxTokens: number | undefined;
  if (argMax !== null) {
    maxTokens = argMax;
  } else if (ctx.hasUI) {
    const input = await ui.input(`Max output tokens (current ${curMax}, Enter to keep)`, String(curMax));
    if (input !== undefined && input.trim() !== "") {
      const n = toPositiveInt(input);
      if (n === null) {
        ui.notify("maxTokens must be a positive integer", "error");
        return;
      }
      maxTokens = n;
    }
  }

  let reasoning: boolean | undefined;
  if (ctx.hasUI) {
    const choice = await ui.select("Thinking support", [
      "Keep",
      `true (current ${curReasoning})`,
      `false (current ${curReasoning})`,
    ]);
    if (choice?.startsWith("true")) reasoning = true;
    else if (choice?.startsWith("false")) reasoning = false;
  }

  const ov: Partial<ModelMeta> = {};
  if (contextWindow !== undefined) ov.contextWindow = contextWindow;
  if (maxTokens !== undefined) ov.maxTokens = maxTokens;
  if (reasoning !== undefined) ov.reasoning = reasoning;
  currentOv[modelId] = { ...existingOverride, ...ov };
  const cleaned = stripRedundant(currentOv, catalog);

  const config = loadConfig();
  const next = { ...gw, overrides: Object.keys(cleaned).length > 0 ? cleaned : undefined };
  saveConfig({ gateways: config.gateways.map((g) => (g.name === gw.name ? next : g)) });

  const changed = Object.keys(ov).length > 0;
  ui.notify(
    changed
      ? `Saved override for "${modelId}": ${JSON.stringify(ov)}, re-registering...`
      : `No changes`,
    "info",
  );
  if (changed) await reregister(pi, next, ctx);
}

/** Drop overrides that match the catalog value, keeping the config clean. */
function stripRedundant(
  overrides: Record<string, Partial<ModelMeta>>,
  catalog: Map<string, ModelMeta>,
): Record<string, Partial<ModelMeta>> {
  const cleaned: Record<string, Partial<ModelMeta>> = {};
  for (const [id, ov] of Object.entries(overrides)) {
    const base = borrowMeta(catalog, id);
    const diff: Partial<ModelMeta> = {};
    for (const key of Object.keys(ov) as Array<keyof ModelMeta>) {
      if (key === "cost") {
        if (ov.cost !== undefined) diff.cost = ov.cost;
        continue;
      }
      if (key === "name" && ov.name !== undefined && ov.name !== base.name) diff.name = ov.name;
      else if (key === "reasoning" && ov.reasoning !== undefined && ov.reasoning !== base.reasoning) diff.reasoning = ov.reasoning;
      else if (key === "thinkingLevelMap" && ov.thinkingLevelMap !== undefined && ov.thinkingLevelMap !== base.thinkingLevelMap) diff.thinkingLevelMap = ov.thinkingLevelMap;
      else if (key === "input" && ov.input !== undefined && ov.input !== base.input) diff.input = ov.input;
      else if (key === "contextWindow" && ov.contextWindow !== undefined && ov.contextWindow !== base.contextWindow) diff.contextWindow = ov.contextWindow;
      else if (key === "maxTokens" && ov.maxTokens !== undefined && ov.maxTokens !== base.maxTokens) diff.maxTokens = ov.maxTokens;
      else if (key === "compat" && ov.compat !== undefined && ov.compat !== base.compat) diff.compat = ov.compat;
    }
    if (Object.keys(diff).length > 0) cleaned[id] = diff;
  }
  return cleaned;
}

export function createGatewayConfig(name: string, baseUrl: string, apiKey: string): GatewayConfig {
  return {
    name: name.trim(),
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    apiRouting: DEFAULT_API_ROUTING,
  };
}

async function addGateway(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const { ui } = ctx;
  if (!ctx.hasUI) {
    ui.notify("Interactive wizard is not supported in this mode. Edit ~/.pi/agent/ai-gateway.json directly", "warning");
    return;
  }

  const name = await ui.input("Gateway name (models will show as name/modelID, e.g. newapi)");
  if (!name) return;

  const baseUrlInput = await ui.input("Base URL (e.g. https://your-gateway.com/v1)");
  if (!baseUrlInput) return;

  const apiKey = await ui.input("API Key (written to the local config file, permissions 600)");
  if (!apiKey) return;

  const gw = createGatewayConfig(name, baseUrlInput, apiKey);
  const err = validateGateway(gw);
  if (err) {
    ui.notify(`Invalid config: ${err}`, "error");
    return;
  }

  const config = loadConfig();
  if (config.gateways.some((g) => g.name === gw.name)) {
    const replace = await ui.confirm("Gateway already exists", `Overwrite "${gw.name}"?`);
    if (!replace) return;
    config.gateways = config.gateways.filter((g) => g.name !== gw.name);
  }
  config.gateways.push(gw);
  saveConfig(config);
  ui.notify(`Saved to ~/.pi/agent/ai-gateway.json`, "info");

  ui.setStatus("ai-gateway", `Registering ${gw.name}...`);
  try {
    const dataDir = findPiAiDataDir() ?? "";
    const catalog = buildCatalogIndex(dataDir);
    const result = await registerGateway(pi, gw, catalog, loadCache(), buildOpenAIResponsesModelIds(dataDir));
    if (result.ok) {
      ui.notify(
        `Gateway "${gw.name}" registered: ${result.modelCount} models` + (result.degraded ? " (using cache, gateway currently unreachable)" : ""),
        "info",
      );
    } else {
      ui.notify(`Gateway "${gw.name}" registration failed: ${result.error}`, "error");
    }
  } finally {
    ui.setStatus("ai-gateway", undefined);
  }
}

async function listGateways(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  if (config.gateways.length === 0) {
    ctx.ui.notify("No gateways configured. Run /ai-gateway add, or edit ~/.pi/agent/ai-gateway.json", "info");
    return;
  }
  const cache = loadCache();
  const lines = config.gateways.map((g) => {
    const cached = cache[g.name];
    const modelInfo = cached && cached.length > 0 ? `${cached.length} models (cached)` : "not fetched";
    const priceInfo = g.pricePreset ? `price fallback ${g.pricePreset}` : "gateway prices only";
    return `• ${g.name} → ${normalizeBaseUrl(g.baseUrl)}（${modelInfo}; ${priceInfo}; fetch: /ai-gateway fetch ${g.name}）`;
  });
  ctx.ui.notify(`${config.gateways.length} gateways configured:\n${lines.join("\n")}`, "info");
}

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerCommand("ai-gateway", {
    description: "Manage gateways, metadata overrides, and model prices",
    handler: (args, ctx) => gatewayCommand(pi, args, ctx),
  });

  const config = loadConfig();
  if (config.gateways.length === 0) {
    console.warn("[ai-gateway] No gateways configured: run /ai-gateway add or create ~/.pi/agent/ai-gateway.json");
    return;
  }

  const dataDir = findPiAiDataDir();
  if (!dataDir) {
    console.warn("[ai-gateway] pi-ai built-in model catalog not found; all models will use default metadata");
  }
  const catalog = buildCatalogIndex(dataDir ?? "");
  const openAIResponsesModelIds = buildOpenAIResponsesModelIds(dataDir ?? "");
  const cache = loadCache();

  for (const gw of config.gateways) {
    const err = validateGateway(gw);
    if (err) {
      console.error(`[ai-gateway] Skipping gateway "${gw.name ?? "(unnamed)"}": ${err}`);
      continue;
    }
    try {
      const result = await registerGateway(pi, gw, catalog, cache, openAIResponsesModelIds);
      if (result.ok) {
        console.log(
          `[ai-gateway] Registered "${result.gateway}": ${result.modelCount} models` +
            (result.degraded ? " (cache degraded)" : ""),
        );
      } else {
        console.error(`[ai-gateway] Gateway "${result.gateway}" registration failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`[ai-gateway] Gateway "${gw.name}" error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
