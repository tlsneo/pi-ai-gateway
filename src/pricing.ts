export interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCost extends CostRates {
  tiers?: Array<CostRates & { inputTokensAbove: number }>;
}

export type PriceCatalog = Map<string, ModelCost>;
export type PricePreset = "models-dev" | "basellm";

export const ZERO_COST: ModelCost = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export const BASELLM_PRICE_PRESET_URL =
  "https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json";
export const MODELS_DEV_PRICE_PRESET_URL = "https://models.dev/api.json";

const OFFICIAL_PRICE_PROVIDERS: ReadonlyArray<{ provider: string; pattern: RegExp }> = [
  { provider: "openai", pattern: /^(?:gpt-|o\d(?:-|$)|chatgpt-|text-embedding-|sora-|dall-e)/i },
  { provider: "anthropic", pattern: /^(?:claude-|anthropic\/)/i },
  { provider: "google", pattern: /^(?:gemini-|gemma-)/i },
  { provider: "deepseek", pattern: /^(?:deepseek-|deepseek\/)/i },
  { provider: "zai", pattern: /^(?:glm-|zai\/)/i },
  { provider: "moonshotai", pattern: /^(?:kimi-|moonshot)/i },
  { provider: "minimax", pattern: /^minimax-/i },
  { provider: "xiaomi", pattern: /^(?:mimo-|xiaomi\/)/i },
  { provider: "alibaba", pattern: /^(?:qwen|qwq-|qvq-)/i },
  { provider: "xai", pattern: /^(?:grok-|xai\/)/i },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeModelId(id: string): string {
  return id.toLowerCase();
}

function readMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    const number = finiteNumber(item);
    if (number !== undefined) output[key] = number;
  }
  return output;
}

function completeRates(partial: Partial<CostRates>): CostRates {
  return {
    input: partial.input ?? 0,
    output: partial.output ?? 0,
    cacheRead: partial.cacheRead ?? 0,
    cacheWrite: partial.cacheWrite ?? 0,
  };
}

export function normalizeCost(value: unknown): ModelCost | undefined {
  if (!isRecord(value)) return undefined;
  const input = finiteNumber(value.input);
  const output = finiteNumber(value.output);
  if (input === undefined || output === undefined) return undefined;

  const cost: ModelCost = {
    input,
    output,
    cacheRead: finiteNumber(value.cacheRead ?? value.cache_read) ?? 0,
    cacheWrite: finiteNumber(value.cacheWrite ?? value.cache_write) ?? 0,
  };

  if (Array.isArray(value.tiers)) {
    const tiers = value.tiers.flatMap((item) => {
      if (!isRecord(item)) return [];
      const threshold = finiteNumber(
        item.inputTokensAbove ?? (isRecord(item.tier) ? item.tier.size : undefined),
      );
      const tierInput = finiteNumber(item.input);
      const tierOutput = finiteNumber(item.output);
      if (threshold === undefined || tierInput === undefined || tierOutput === undefined) return [];
      return [{
        inputTokensAbove: threshold,
        input: tierInput,
        output: tierOutput,
        cacheRead: finiteNumber(item.cacheRead ?? item.cache_read) ?? 0,
        cacheWrite: finiteNumber(item.cacheWrite ?? item.cache_write) ?? 0,
      }];
    });
    if (tiers.length > 0) cost.tiers = tiers.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
  }

  return cost;
}

function parseLinearRates(expression: string): CostRates | undefined {
  const variables: Record<string, keyof CostRates> = {
    p: "input",
    c: "output",
    cr: "cacheRead",
    cc: "cacheWrite",
  };
  const rates: Partial<CostRates> = {};
  const compact = expression.replace(/\s+/g, "");
  if (compact === "0") return completeRates({});

  for (const term of compact.split("+")) {
    const match = term.match(/^(p|c|cr|cc)(?:\*([0-9]+(?:\.[0-9]+)?))?$/i) ??
      term.match(/^([0-9]+(?:\.[0-9]+)?)\*(p|c|cr|cc)$/i);
    if (!match) return undefined;

    const variableFirst = /^[a-z]/i.test(match[1] ?? "");
    const variable = (variableFirst ? match[1] : match[2])?.toLowerCase();
    const coefficient = Number(variableFirst ? (match[2] ?? "1") : match[1]);
    const key = variable ? variables[variable] : undefined;
    if (!key || !Number.isFinite(coefficient) || coefficient < 0) return undefined;
    rates[key] = coefficient;
  }

  return completeRates(rates);
}

function parseTierCall(expression: string): CostRates | undefined {
  const match = expression.trim().match(/^tier\(\s*(["']).*?\1\s*,\s*(.*?)\s*\)$/);
  return match ? parseLinearRates(match[2] ?? "") : undefined;
}

export function parseTieredBillingExpr(expression: string): ModelCost | undefined {
  const branches: Array<{ upperBound?: number; rates: CostRates }> = [];
  let rest = expression.trim();

  while (true) {
    const conditional = rest.match(/^len\s*<=\s*(\d+)\s*\?\s*(tier\([\s\S]*?\))\s*:\s*([\s\S]+)$/);
    if (!conditional) break;
    const rates = parseTierCall(conditional[2] ?? "");
    if (!rates) return undefined;
    branches.push({ upperBound: Number(conditional[1]), rates });
    rest = (conditional[3] ?? "").trim();
  }

  const finalRates = parseTierCall(rest);
  if (!finalRates || branches.length === 0) return undefined;
  branches.push({ rates: finalRates });

  const [base, ...higher] = branches;
  if (!base) return undefined;
  const tiers = higher.map((branch, index) => ({
    inputTokensAbove: branches[index]?.upperBound ?? 0,
    ...branch.rates,
  }));
  return tiers.length > 0 ? { ...base.rates, tiers } : base.rates;
}

export function parseNewApiPricing(json: unknown, quotaPerUnit = 500_000): PriceCatalog {
  const catalog: PriceCatalog = new Map();
  if (!isRecord(json) || json.success === false || !Array.isArray(json.data)) return catalog;
  const conversion = quotaPerUnit > 0 ? 1_000_000 / quotaPerUnit : 2;

  for (const item of json.data) {
    if (!isRecord(item) || typeof item.model_name !== "string") continue;
    let cost: ModelCost | undefined;
    if (item.billing_mode === "tiered_expr" && typeof item.billing_expr === "string") {
      cost = parseTieredBillingExpr(item.billing_expr);
    }
    if (!cost && finiteNumber(item.quota_type) !== 1) {
      const modelRatio = finiteNumber(item.model_ratio);
      if (modelRatio !== undefined) {
        cost = {
          input: modelRatio * conversion,
          output: modelRatio * (finiteNumber(item.completion_ratio) ?? 1) * conversion,
          cacheRead: modelRatio * (finiteNumber(item.cache_ratio) ?? 0) * conversion,
          cacheWrite: modelRatio * (finiteNumber(item.create_cache_ratio) ?? 0) * conversion,
        };
      }
    }
    if (cost) catalog.set(normalizeModelId(item.model_name), cost);
  }
  return catalog;
}

export function parseNewApiRatioCatalog(json: unknown, quotaPerUnit = 500_000): PriceCatalog {
  const catalog: PriceCatalog = new Map();
  if (!isRecord(json) || json.success === false || !isRecord(json.data)) return catalog;
  const data = json.data;
  const modelRatios = readMap(data.model_ratio);
  const completionRatios = readMap(data.completion_ratio);
  const cacheRatios = readMap(data.cache_ratio);
  const createCacheRatios = readMap(data.create_cache_ratio);
  const billingModes = isRecord(data.billing_mode) ? data.billing_mode : {};
  const billingExpressions = isRecord(data.billing_expr) ? data.billing_expr : {};
  const conversion = quotaPerUnit > 0 ? 1_000_000 / quotaPerUnit : 2;

  for (const [modelId, modelRatio] of Object.entries(modelRatios)) {
    let cost: ModelCost | undefined;
    if (billingModes[modelId] === "tiered_expr" && typeof billingExpressions[modelId] === "string") {
      cost = parseTieredBillingExpr(billingExpressions[modelId]);
    }
    cost ??= {
      input: modelRatio * conversion,
      output: modelRatio * (completionRatios[modelId] ?? 1) * conversion,
      cacheRead: modelRatio * (cacheRatios[modelId] ?? 0) * conversion,
      cacheWrite: modelRatio * (createCacheRatios[modelId] ?? 0) * conversion,
    };
    catalog.set(normalizeModelId(modelId), cost);
  }

  return catalog;
}

export function findCatalogCost(catalog: PriceCatalog, modelId: string): ModelCost | undefined {
  const normalized = normalizeModelId(modelId);
  const exact = catalog.get(normalized);
  if (exact) return exact;

  let best: { keyLength: number; cost: ModelCost } | undefined;
  for (const [key, cost] of catalog) {
    if (!normalized.startsWith(key)) continue;
    if (!best || key.length > best.keyLength) best = { keyLength: key.length, cost };
  }
  return best?.cost;
}

function modelDevCost(provider: unknown, modelId: string): ModelCost | undefined {
  if (!isRecord(provider) || !isRecord(provider.models)) return undefined;
  const models = provider.models;
  const direct = models[modelId];
  if (isRecord(direct)) return normalizeCost(direct.cost);

  const lower = normalizeModelId(modelId);
  for (const [id, model] of Object.entries(models)) {
    if (normalizeModelId(id) === lower && isRecord(model)) return normalizeCost(model.cost);
  }
  return undefined;
}

export function findModelsDevCost(json: unknown, modelId: string): ModelCost | undefined {
  if (!isRecord(json)) return undefined;

  for (const rule of OFFICIAL_PRICE_PROVIDERS) {
    if (!rule.pattern.test(modelId)) continue;
    const cost = modelDevCost(json[rule.provider], modelId);
    if (cost) return cost;
  }

  const candidates: ModelCost[] = [];
  for (const provider of Object.values(json)) {
    const cost = modelDevCost(provider, modelId);
    if (cost) candidates.push(cost);
  }
  return candidates.find((cost) => cost.input > 0 || cost.output > 0) ?? candidates[0];
}

export function buildModelsDevCatalog(json: unknown, modelIds: readonly string[]): PriceCatalog {
  const catalog: PriceCatalog = new Map();
  for (const modelId of modelIds) {
    const cost = findModelsDevCost(json, modelId);
    if (cost) catalog.set(normalizeModelId(modelId), cost);
  }
  return catalog;
}

export function resolveModelCost(
  modelId: string,
  gatewayPrices: PriceCatalog,
  presetPrices?: PriceCatalog,
  manualCost?: unknown,
): ModelCost {
  const normalizedManual = normalizeCost(manualCost);
  return normalizedManual ??
    findCatalogCost(gatewayPrices, modelId) ??
    (presetPrices ? findCatalogCost(presetPrices, modelId) : undefined) ??
    ZERO_COST;
}
