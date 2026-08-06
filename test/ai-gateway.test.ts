import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyOverrides,
  borrowMeta,
  buildCatalogIndex,
  configPath,
  filterModelIds,
  loadConfig,
  normalizeBaseUrl,
  parseGatewayConfig,
  saveConfig,
  toPositiveInt,
  validateGateway,
} from "../extensions/ai-gateway.ts";

// ---------------------------------------------------------------------------
// parseGatewayConfig
// ---------------------------------------------------------------------------

test("parseGatewayConfig: accepts a valid config", () => {
  const r = parseGatewayConfig(JSON.stringify({ gateways: [{ name: "newapi", baseUrl: "https://x/v1", apiKey: "sk-1" }] }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.gateways.length, 1);
});

test("parseGatewayConfig: rejects broken JSON", () => {
  const r = parseGatewayConfig("{ not json");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /JSON/);
});

test("parseGatewayConfig: rejects non-object top level", () => {
  assert.equal(parseGatewayConfig("[1,2]").ok, false);
  assert.equal(parseGatewayConfig("null").ok, false);
});

test("parseGatewayConfig: rejects non-array gateways", () => {
  assert.equal(parseGatewayConfig('{"gateways": "x"}').ok, false);
});

test("parseGatewayConfig: missing gateways defaults to empty array", () => {
  const r = parseGatewayConfig("{}");
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value.gateways, []);
});

// ---------------------------------------------------------------------------
// validateGateway
// ---------------------------------------------------------------------------

test("validateGateway: accepts a valid gateway", () => {
  assert.equal(validateGateway({ name: "newapi", baseUrl: "https://x/v1", apiKey: "sk-1" }), null);
});

test("validateGateway: rejects invalid names", () => {
  assert.ok(validateGateway({ name: "bad name!", baseUrl: "https://x/v1", apiKey: "sk-1" }));
  assert.ok(validateGateway({ name: "", baseUrl: "https://x/v1", apiKey: "sk-1" }));
});

test("validateGateway: rejects names colliding with built-in providers", () => {
  assert.match(validateGateway({ name: "openai", baseUrl: "https://x/v1", apiKey: "sk-1" }), /collides with a built-in/);
  assert.match(validateGateway({ name: "deepseek", baseUrl: "https://x/v1", apiKey: "sk-1" }), /collides with a built-in/);
});

test("validateGateway: rejects bad baseUrl / empty key", () => {
  assert.ok(validateGateway({ name: "gw", baseUrl: "ftp://x", apiKey: "sk-1" }));
  assert.ok(validateGateway({ name: "gw", baseUrl: "https://x/v1", apiKey: "" }));
});

// ---------------------------------------------------------------------------
// normalizeBaseUrl
// ---------------------------------------------------------------------------

test("normalizeBaseUrl: appends /v1 and strips trailing slashes", () => {
  assert.equal(normalizeBaseUrl("https://x.com"), "https://x.com/v1");
  assert.equal(normalizeBaseUrl("https://x.com/"), "https://x.com/v1");
  assert.equal(normalizeBaseUrl("https://x.com/v1/"), "https://x.com/v1");
  assert.equal(normalizeBaseUrl("https://x.com/v1"), "https://x.com/v1");
});

// ---------------------------------------------------------------------------
// filterModelIds
// ---------------------------------------------------------------------------

test("filterModelIds: removes noise models", () => {
  const ids = ["gpt-5.6-sol", "gpt-image-2", "text-embedding-3", "tts-1", "whisper-1", "rerank-model"];
  assert.deepEqual(filterModelIds(ids), ["gpt-5.6-sol"]);
});

// ---------------------------------------------------------------------------
// buildCatalogIndex / borrowMeta
// ---------------------------------------------------------------------------

function makeFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-gateway-test-"));
  fs.writeFileSync(
    path.join(dir, "a.json"),
    JSON.stringify({
      "openai-completions": [
        {
          id: "alpha",
          reasoning: true,
          input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        },
        { id: "beta", reasoning: false },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "b.json"),
    JSON.stringify({
      "openai-completions": [
        {
          id: "alpha",
          reasoning: true,
          thinkingLevelMap: { high: "high", max: "max" },
          compat: { thinkingFormat: "deepseek" },
          contextWindow: 272000,
          maxTokens: 16384,
          cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(dir, "bad.json"), "{ broken json");
  fs.writeFileSync(path.join(dir, "weird.json"), JSON.stringify({ "openai-completions": "not-an-array" }));
  fs.writeFileSync(
    path.join(dir, "obj.json"),
    JSON.stringify({
      "openai-completions": {
        "gamma": { id: "gamma", reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 32768, cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } },
      },
    }),
  );
  return dir;
}

test("buildCatalogIndex: picks the fullest entry for duplicate ids", () => {
  const catalog = buildCatalogIndex(makeFixtureDir());
  const alpha = catalog.get("alpha");
  assert.ok(alpha);
  assert.equal(alpha.contextWindow, 272000);
  assert.ok(alpha.thinkingLevelMap);
  assert.ok(alpha.compat && alpha.compat.thinkingFormat === "deepseek");
  assert.ok(catalog.has("beta"));
});

test("buildCatalogIndex: silently skips broken files", () => {
  const catalog = buildCatalogIndex(makeFixtureDir());
  assert.ok(catalog.has("alpha"));
  assert.equal(catalog.size, 3);
});

test("buildCatalogIndex: supports object shape { apiType: { id: entry } }", () => {
  const catalog = buildCatalogIndex(makeFixtureDir());
  const gamma = catalog.get("gamma");
  assert.ok(gamma);
  assert.equal(gamma.contextWindow, 262144);
  assert.equal(gamma.reasoning, true);
});

test("buildCatalogIndex: missing directory returns empty", () => {
  assert.equal(buildCatalogIndex("/nonexistent/dir").size, 0);
});

test("borrowMeta: borrows metadata for known models", () => {
  const catalog = buildCatalogIndex(makeFixtureDir());
  const meta = borrowMeta(catalog, "alpha");
  assert.equal(meta.reasoning, true);
  assert.equal(meta.maxTokens, 16384);
});

test("borrowMeta: falls back to safe defaults for unknown models", () => {
  const catalog = buildCatalogIndex(makeFixtureDir());
  const meta = borrowMeta(catalog, "hy3-preview");
  assert.equal(meta.reasoning, false);
  assert.equal(meta.contextWindow, 128000);
  assert.equal(meta.cost.input, 0);
});

// ---------------------------------------------------------------------------
// applyOverrides
// ---------------------------------------------------------------------------

test("applyOverrides: overrides fields of the specified model", () => {
  const base = { reasoning: true, input: ["text"] as const, cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 128000 };
  const meta = applyOverrides("gpt-5.6-sol", base, { "gpt-5.6-sol": { contextWindow: 272000 } });
  assert.equal(meta.contextWindow, 272000);
  assert.equal(meta.maxTokens, 128000);
  assert.equal(meta.reasoning, true);
});

test("applyOverrides: leaves unspecified models untouched", () => {
  const base = { reasoning: false, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 };
  const meta = applyOverrides("other-model", base, { "gpt-5.6-sol": { contextWindow: 272000 } });
  assert.equal(meta.contextWindow, 128000);
});

test("applyOverrides: returns base unchanged when overrides are undefined", () => {
  const base = { reasoning: false, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 };
  assert.equal(applyOverrides("x", base, undefined), base);
});

test("validateGateway: rejects invalid overrides", () => {
  const gw = { name: "gw", baseUrl: "https://x/v1", apiKey: "sk-1", overrides: "bad" } as unknown as Parameters<typeof validateGateway>[0];
  assert.ok(validateGateway(gw));
});

// ---------------------------------------------------------------------------
// toPositiveInt
// ---------------------------------------------------------------------------

test("toPositiveInt: valid and invalid inputs", () => {
  assert.equal(toPositiveInt("272000"), 272000);
  assert.equal(toPositiveInt("  123  "), 123);
  assert.equal(toPositiveInt("0"), null);
  assert.equal(toPositiveInt("-5"), null);
  assert.equal(toPositiveInt("abc"), null);
  assert.equal(toPositiveInt("1.5"), null);
  assert.equal(toPositiveInt(""), null);
});

// ---------------------------------------------------------------------------
// loadConfig / saveConfig (isolated via PI_CODING_AGENT_DIR)
// ---------------------------------------------------------------------------

test("saveConfig/loadConfig round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-gateway-cfg-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const gw = { name: "newapi", baseUrl: "https://x/v1", apiKey: "sk-secret" };
    saveConfig({ gateways: [gw] });
    assert.equal(fs.existsSync(configPath()), true);
    assert.deepEqual(loadConfig(), { gateways: [gw] });
    const mode = fs.statSync(configPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: missing file returns empty config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-gateway-cfg-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    assert.deepEqual(loadConfig(), { gateways: [] });
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
