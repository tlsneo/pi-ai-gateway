import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import aiGatewayExtension, {
  configPath,
  gatewayCommand,
  loadConfig,
  refreshGateways,
  registerGateway,
  saveCache,
  saveConfig,
  updateSpeedStatus,
  validateGateway,
  type GatewayConfig,
} from "../extensions/ai-gateway.ts";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

const gateway: GatewayConfig = {
  name: "gw", baseUrl: "https://gateway.example/v1", apiKey: "sk-test", api: "openai-responses",
  headers: { "X-Gateway": "preserved" },
  overrides: { "gpt-5.5": { contextWindow: 272000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } },
};

function fixture(t: TestContext, gateways: GatewayConfig[] = [gateway]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-gateway-speed-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  saveConfig({ gateways });
  const models = ["gpt-5.5", "gpt-6.1-sol", "gpt-other", "claude-sonnet"];
  t.mock.method(globalThis, "fetch", async (input: unknown) => String(input).endsWith("/v1/models")
    ? Response.json({ data: models.map((id) => ({ id })) })
    : new Response("not found", { status: 404 }));
  const registrations: Array<{ name: string; config: ProviderConfig }> = [];
  const notices: string[] = [];
  const prompts: Array<{ title: string; choices?: string[] }> = [];
  const answers: Array<string | undefined> = [];
  const statuses = new Map<string, string>();
  const handlers = new Map<string, (event: unknown, ctx: Parameters<typeof gatewayCommand>[2]) => void>();
  const pi = {
    registerCommand() {},
    on(name: string, handler: (event: unknown, ctx: Parameters<typeof gatewayCommand>[2]) => void) {
      handlers.set(name, handler);
    },
    registerProvider(name: string, config: ProviderConfig) {
      registrations.push({ name, config });
      if (ctx.model?.provider !== name) return;
      const model = config.models?.find((m) => m.id === ctx.model?.id);
      if (model) ctx.model = { ...model, provider: name, api: model.api ?? config.api } as typeof ctx.model;
    },
  } as unknown as Parameters<typeof gatewayCommand>[0];
  const ctx = {
    hasUI: true,
    ui: {
      async input(title: string) { prompts.push({ title }); return answers.shift(); },
      async select(title: string, choices: string[]) { prompts.push({ title, choices }); return answers.shift(); },
      notify(message: string) { notices.push(message); },
      setStatus(key: string, value: string | undefined) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
    },
  } as unknown as Parameters<typeof gatewayCommand>[2];
  return { pi, ctx, answers, notices, prompts, registrations, statuses, handlers, dir };
}

test("speed config: validates shape, modes, ids, and GPT scope", () => {
  for (const speed of [{}, { "gpt-5.5": "fast", "gpt-6.1-sol": "ultrafast", "gpt-other": "off" }]) {
    assert.equal(validateGateway({ ...gateway, speed } as GatewayConfig), null);
  }
  for (const speed of [null, [], "fast", { "": "fast" }, { " gpt-5.5": "fast" },
    { "gpt-5.5": "priority" }, { "gpt-5.5": true }, { "gpt-5.5": {} },
    { "claude-sonnet": "fast" }, { "gpt-oss-120b": "fast" }, { "gpt-image-2": "fast" }]) {
    assert.ok(validateGateway({ ...gateway, speed } as unknown as GatewayConfig), JSON.stringify(speed));
  }
});

test("Speed main menu: add manually, mark current mode, update and persist without touching overrides", async (t) => {
  const f = fixture(t);
  f.answers.push("Speed", "Add / update speed", "  gpt-5.5  ", "Fast");
  await gatewayCommand(f.pi, "", f.ctx);
  assert.ok(f.prompts[0].choices?.includes("Speed"));
  assert.deepEqual(f.prompts[1].choices, ["List speeds", "Add / update speed", "Remove speed"]);
  assert.match(f.prompts[2].title, /^Model ID/);
  assert.deepEqual(f.prompts[3].choices, ["Off (current)", "Fast", "Ultrafast"]);
  assert.deepEqual(loadConfig().gateways[0].speed, { "gpt-5.5": "fast" });
  assert.deepEqual(loadConfig().gateways[0].overrides, gateway.overrides);
  assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
  const model = f.registrations.at(-1)!.config.models!.find((m) => m.id === "gpt-5.5")!;
  assert.deepEqual("samplingParams" in model && model.samplingParams, { service_tier: "priority" });
  assert.equal("contextWindow" in model && model.contextWindow, 272000);
  assert.deepEqual(f.registrations.at(-1)!.config.headers, gateway.headers);

  f.answers.push("Add / update speed", "gpt-5.5", "Ultrafast");
  await gatewayCommand(f.pi, "speed", f.ctx);
  assert.deepEqual(f.prompts.at(-1)!.choices, ["Off", "Fast (current)", "Ultrafast"]);
  assert.deepEqual(loadConfig().gateways[0].speed, { "gpt-5.5": "ultrafast" });
  assert.ok(f.notices.some((s) => s.includes("backend tier application is not confirmed")));
});

test("Speed list: shows only saved settings including explicit Off without re-registering", async (t) => {
  const f = fixture(t, [{ ...gateway, speed: { "gpt-5.5": "fast", "gpt-6.1-sol": "ultrafast", "gpt-other": "off" } }]);
  f.answers.push("List speeds");
  await gatewayCommand(f.pi, "speed", f.ctx);
  assert.match(f.notices.at(-1)!, /gw.*requested[\s\S]*gpt-5\.5: Fast[\s\S]*gpt-6\.1-sol: Ultrafast[\s\S]*gpt-other: Off/);
  assert.equal(f.registrations.length, 0);
  saveConfig({ gateways: [gateway] });
  await gatewayCommand(f.pi, "speed list", f.ctx);
  assert.match(f.notices.at(-1)!, /No speed settings/);
});

test("Speed remove: deletes only the selected setting, and clears an empty speed map", async (t) => {
  const f = fixture(t, [{ ...gateway, speed: { "gpt-5.5": "fast", "gpt-6.1-sol": "ultrafast" } }]);
  f.answers.push("Remove speed", "gpt-6.1-sol — Ultrafast");
  await gatewayCommand(f.pi, "speed", f.ctx);
  assert.deepEqual(loadConfig().gateways[0].speed, { "gpt-5.5": "fast" });
  assert.deepEqual(f.prompts.at(-1)!.choices, ["gpt-5.5 — Fast", "gpt-6.1-sol — Ultrafast"]);
  await gatewayCommand(f.pi, "speed remove gpt-5.5", f.ctx);
  assert.equal(Object.hasOwn(loadConfig().gateways[0], "speed"), false);
  assert.deepEqual(loadConfig().gateways[0].overrides, gateway.overrides);
  const before = fs.readFileSync(configPath(), "utf8");
  await gatewayCommand(f.pi, "speed remove gpt-5.5", f.ctx);
  assert.equal(fs.readFileSync(configPath(), "utf8"), before);
  assert.match(f.notices.at(-1)!, /No speed setting/);
});

test("Speed cancellation: gateway, model input, mode, and deletion leave config untouched", async (t) => {
  const f = fixture(t, [{ ...gateway, speed: { "gpt-5.5": "fast" } }, { ...gateway, name: "other" }]);
  const before = fs.readFileSync(configPath(), "utf8");
  for (const answers of [
    ["Add / update speed", undefined],
    ["Add / update speed", "gw", undefined],
    ["Add / update speed", "gw", "gpt-5.5", undefined],
    ["Remove speed", "gw", undefined],
    ["Add / update speed", "gw", "   "],
  ]) {
    f.answers.push(...answers);
    await gatewayCommand(f.pi, "speed", f.ctx);
    assert.equal(fs.readFileSync(configPath(), "utf8"), before);
    assert.equal(f.registrations.length, 0);
  }
});

test("Speed gateway isolation: changing one gateway never changes a second gateway's same model", async (t) => {
  const second = { ...gateway, name: "second", speed: { "gpt-5.5": "off" as const } };
  const f = fixture(t, [gateway, second]);
  f.answers.push("second");
  await gatewayCommand(f.pi, "speed add gpt-5.5 fast", f.ctx);
  assert.deepEqual(f.prompts[0].choices, ["gw", "second"]);
  assert.deepEqual(loadConfig().gateways, [gateway, { ...second, speed: { "gpt-5.5": "fast" } }]);
  assert.deepEqual(f.registrations.map((r) => r.name), ["second"]);
});

test("Speed compatibility: rejects non-GPT, gpt-oss and Ultrafast on Completions without changing routing", async (t) => {
  const f = fixture(t, [{ ...gateway, api: "openai-completions" }]);
  saveCache({ gw: ["gpt-5.5"] });
  const before = fs.readFileSync(configPath(), "utf8");
  for (const command of ["speed add claude-sonnet fast", "speed add gpt-oss-120b fast", "speed add gpt-5.5 ultrafast", "speed add gpt-5.5 priority"]) {
    await gatewayCommand(f.pi, command, f.ctx);
    assert.equal(fs.readFileSync(configPath(), "utf8"), before);
  }
  f.ctx.modelRegistry = { find: () => ({ api: "openai-responses" }) } as unknown as typeof f.ctx.modelRegistry;
  await gatewayCommand(f.pi, "speed add gpt-5.5 ultrafast", f.ctx);
  assert.equal(fs.readFileSync(configPath(), "utf8"), before);
  assert.ok(f.notices.some((s) => s.includes("Ultrafast requires openai-responses")));
  assert.equal(f.registrations.length, 0);
  await gatewayCommand(f.pi, "speed add gpt-5.5 fast", f.ctx);
  assert.equal(f.registrations.at(-1)!.config.api, "openai-completions");
});

test("Speed pending model: saves without inventing models and applies after discovery", async (t) => {
  const f = fixture(t);
  await gatewayCommand(f.pi, "speed add gpt-future ultrafast", f.ctx);
  assert.ok(f.notices.some((s) => s.includes("has not been discovered")));
  assert.deepEqual(loadConfig().gateways[0].speed, { "gpt-future": "ultrafast" });
  assert.equal(f.registrations.at(-1)!.config.models!.some((m) => m.id === "gpt-future"), false);
  t.mock.method(globalThis, "fetch", async (input: unknown) => String(input).endsWith("/v1/models")
    ? Response.json({ data: [{ id: "gpt-future" }] }) : new Response("missing", { status: 404 }));
  await refreshGateways(f.pi, f.ctx, "gw");
  const model = f.registrations.at(-1)!.config.models![0];
  assert.deepEqual("samplingParams" in model && model.samplingParams, { service_tier: "ultrafast" });
});

test("Speed application failure: keeps saved config and reports failure, not success", async (t) => {
  const f = fixture(t);
  t.mock.method(f.pi, "registerProvider", () => { throw new Error("registration failed"); });
  await gatewayCommand(f.pi, "speed add gpt-5.5 fast", f.ctx);
  assert.deepEqual(loadConfig().gateways[0].speed, { "gpt-5.5": "fast" });
  assert.match(f.notices.at(-1)!, /Configuration saved, but could not be applied/);
  assert.ok(f.notices.some((s) => s.includes("registration failed")));
});

test("Speed registration: tiers are exact, metadata is unchanged, and switching/removal leaves no generated header", async (t) => {
  const f = fixture(t);
  for (const mode of ["ultrafast", "fast", "off", undefined] as const) {
    const gw = { ...gateway, speed: mode ? { "gpt-5.5": mode } : undefined };
    const result = await registerGateway(f.pi, gw, new Map(), {});
    assert.equal(result.ok, true);
    const models = f.registrations.at(-1)!.config.models!;
    const selected = models.find((m) => m.id === "gpt-5.5")!;
    assert.deepEqual("samplingParams" in selected ? selected.samplingParams : undefined,
      mode === "ultrafast" ? { service_tier: "ultrafast" } : mode === "fast" ? { service_tier: "priority" } : undefined);
    assert.deepEqual(selected.headers, mode === "ultrafast" ? { "OpenAI-Service-Tier": "ultrafast" } : undefined);
    assert.equal("contextWindow" in selected && selected.contextWindow, 272000);
    assert.deepEqual(selected.cost, gateway.overrides!["gpt-5.5"].cost);
    for (const model of models.filter((m) => m.id !== "gpt-5.5")) {
      assert.equal("samplingParams" in model, false);
      assert.equal(model.headers, undefined);
    }
  }
});

test("Speed registration: automatic per-model Responses routing carries Ultrafast without changing other APIs", async (t) => {
  const f = fixture(t);
  await registerGateway(f.pi, {
    ...gateway, api: undefined, apiRouting: "auto", speed: { "gpt-6.1-sol": "ultrafast", "gpt-5.5": "fast" },
  }, new Map(), {}, new Set(["gpt-6.1-sol"]));
  const config = f.registrations.at(-1)!.config;
  assert.equal(config.api, "openai-completions");
  const ultra = config.models!.find((m) => m.id === "gpt-6.1-sol")!;
  assert.equal(ultra.api, "openai-responses");
  assert.deepEqual("samplingParams" in ultra && ultra.samplingParams, { service_tier: "ultrafast" });
  assert.deepEqual(ultra.headers, { "OpenAI-Service-Tier": "ultrafast" });
  const fast = config.models!.find((m) => m.id === "gpt-5.5")!;
  assert.equal(fast.api, undefined);
  assert.deepEqual("samplingParams" in fast && fast.samplingParams, { service_tier: "priority" });
  assert.equal(fast.headers, undefined);
});

test("Speed registration: later incompatible routing warns and does not send Ultrafast", async (t) => {
  const f = fixture(t);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  await registerGateway(f.pi, { ...gateway, api: "openai-completions", speed: { "gpt-5.5": "ultrafast" } }, new Map(), {});
  assert.match(warnings[0], /Speed not applied.*Ultrafast requires openai-responses/);
  const model = f.registrations.at(-1)!.config.models![0];
  assert.equal("samplingParams" in model, false);
  assert.equal(model.headers, undefined);
});

test("Speed offline: cached models still apply saved modes and retain independent settings", async (t) => {
  const f = fixture(t);
  saveCache({ gw: ["gpt-5.5", "gpt-other"] });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  await gatewayCommand(f.pi, "speed add gpt-5.5 fast", f.ctx);
  assert.deepEqual(loadConfig().gateways[0].speed, { "gpt-5.5": "fast" });
  const selected = f.registrations.at(-1)!.config.models![0];
  assert.deepEqual("samplingParams" in selected && selected.samplingParams, { service_tier: "priority" });
  assert.ok(f.notices.some((s) => s.includes("cache degraded")));
  assert.ok(f.notices.at(-1)!.includes("Subsequent requests"));
  await gatewayCommand(f.pi, "speed add gpt-5.5 off", f.ctx);
  assert.deepEqual(loadConfig().gateways[0].speed, { "gpt-5.5": "off" });
  assert.equal("samplingParams" in f.registrations.at(-1)!.config.models![0], false);
  assert.deepEqual(loadConfig().gateways[0].overrides, gateway.overrides);
});

test("Speed malformed commands: reject extra arguments without writing or opening dialogs", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(configPath(), "utf8");
  for (const args of ["speed invalid", "speed list gpt-5.5", "speed remove gpt-5.5 fast", "speed add gpt-5.5 fast extra"]) {
    await gatewayCommand(f.pi, args, f.ctx);
    assert.match(f.notices.at(-1)!, /Usage/);
    assert.equal(fs.readFileSync(configPath(), "utf8"), before);
  }
  assert.equal(f.prompts.length, 0);
  assert.equal(f.registrations.length, 0);
});

test("Speed save failure: reports the error without changing config or registering", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(configPath(), "utf8");
  t.mock.method(fs, "renameSync", () => { throw new Error("disk full"); });
  await gatewayCommand(f.pi, "speed add gpt-5.5 fast", f.ctx);
  assert.equal(fs.readFileSync(configPath(), "utf8"), before);
  assert.equal(f.registrations.length, 0);
  assert.match(f.notices.at(-1)!, /not saved.*disk full/);
});

test("Speed status: uses the current registered model, not saved or other-provider settings", (t) => {
  const f = fixture(t, [{ ...gateway, speed: { "gpt-5.5": "ultrafast" } }]);
  f.statuses.set("other-extension", "kept");
  for (const [provider, tier, expected] of [
    ["gw", "priority", "⚡ Fast"], ["gw", "ultrafast", "⚡⚡ Ultrafast"],
    ["gw", undefined, undefined], ["gw", "default", undefined],
    ["other-gateway", "priority", undefined], ["openai", "ultrafast", undefined],
  ] as const) {
    f.ctx.model = { provider, id: "gpt-5.5", samplingParams: { service_tier: tier } } as unknown as typeof f.ctx.model;
    updateSpeedStatus(f.ctx);
    assert.equal(f.statuses.get("ai-gateway-speed"), expected);
    assert.equal(f.statuses.get("other-extension"), "kept");
  }
  f.ctx.model = undefined;
  updateSpeedStatus(f.ctx);
  assert.equal(f.statuses.has("ai-gateway-speed"), false);
});

test("Speed status: restores on session start/reload and clears on model switches", async (t) => {
  const f = fixture(t, [{ ...gateway, speed: { "gpt-5.5": "fast" } }]);
  await aiGatewayExtension(f.pi);
  const model = f.registrations.at(-1)!.config.models!.find((m) => m.id === "gpt-5.5")!;
  f.ctx.model = { ...model, provider: "gw" } as typeof f.ctx.model;
  for (const reason of ["startup", "reload", "resume"]) {
    f.statuses.clear();
    f.handlers.get("session_start")!({ reason }, f.ctx);
    assert.equal(f.statuses.get("ai-gateway-speed"), "⚡ Fast");
  }
  f.ctx.model = { id: "gpt-5.5", provider: "other" } as typeof f.ctx.model;
  f.handlers.get("model_select")!({}, f.ctx);
  assert.equal(f.statuses.has("ai-gateway-speed"), false);
});

test("Speed status: save, Off, removal and gateway removal update immediately without reselecting", async (t) => {
  const f = fixture(t);
  f.ctx.model = { provider: "gw", id: "gpt-5.5" } as typeof f.ctx.model;
  for (const [command, expected] of [
    ["speed add gpt-5.5 fast", "⚡ Fast"], ["speed add gpt-5.5 ultrafast", "⚡⚡ Ultrafast"],
    ["speed add gpt-5.5 off", undefined], ["speed add gpt-5.5 fast", "⚡ Fast"],
    ["speed remove gpt-5.5", undefined], ["speed add gpt-5.5 ultrafast", "⚡⚡ Ultrafast"],
    ["remove gw", undefined],
  ] as const) {
    await gatewayCommand(f.pi, command, f.ctx);
    assert.equal(f.statuses.get("ai-gateway-speed"), expected, command);
  }
});

test("Speed status: editing a different model or gateway does not display its tier", async (t) => {
  const f = fixture(t, [gateway, { ...gateway, name: "other" }]);
  f.ctx.model = { provider: "gw", id: "gpt-5.5" } as typeof f.ctx.model;
  f.answers.push("other");
  await gatewayCommand(f.pi, "speed add gpt-5.5 fast", f.ctx);
  assert.equal(f.statuses.has("ai-gateway-speed"), false);
  f.answers.push("gw");
  await gatewayCommand(f.pi, "speed add gpt-other ultrafast", f.ctx);
  assert.equal(f.statuses.has("ai-gateway-speed"), false);
});

test("Speed status: failed application preserves the tier of the still-active model", async (t) => {
  const f = fixture(t);
  f.ctx.model = { provider: "gw", id: "gpt-5.5", samplingParams: { service_tier: "priority" } } as unknown as typeof f.ctx.model;
  updateSpeedStatus(f.ctx);
  t.mock.method(f.pi, "registerProvider", () => { throw new Error("registration failed"); });
  await gatewayCommand(f.pi, "speed add gpt-5.5 ultrafast", f.ctx);
  assert.equal(f.statuses.get("ai-gateway-speed"), "⚡ Fast");
  f.ctx.model = { provider: "gw", id: "gpt-5.5" } as typeof f.ctx.model;
  await gatewayCommand(f.pi, "speed add gpt-5.5 fast", f.ctx);
  assert.equal(f.statuses.has("ai-gateway-speed"), false);
});

test("Speed status: refresh reflects manual config edits and incompatible API cleanup", async (t) => {
  const f = fixture(t, [{ ...gateway, speed: { "gpt-5.5": "ultrafast" } }]);
  f.ctx.model = { provider: "gw", id: "gpt-5.5" } as typeof f.ctx.model;
  await refreshGateways(f.pi, f.ctx);
  assert.equal(f.statuses.get("ai-gateway-speed"), "⚡⚡ Ultrafast");
  saveConfig({ gateways: [{ ...gateway, api: "openai-completions", speed: { "gpt-5.5": "ultrafast" } }] });
  t.mock.method(console, "warn", () => {});
  await refreshGateways(f.pi, f.ctx);
  assert.equal(f.statuses.has("ai-gateway-speed"), false);
});

test("Speed non-UI: no hidden selectors, and multiple gateways require interactive selection", async (t) => {
  const f = fixture(t, [gateway, { ...gateway, name: "other" }]);
  f.ctx.hasUI = false;
  await gatewayCommand(f.pi, "speed", f.ctx);
  assert.match(f.notices.at(-1)!, /Multiple gateways/);
  assert.equal(f.prompts.length, 0);
  saveConfig({ gateways: [gateway] });
  await gatewayCommand(f.pi, "speed add gpt-5.5 fast", f.ctx);
  await gatewayCommand(f.pi, "speed", f.ctx);
  assert.match(f.notices.at(-1)!, /gpt-5\.5: Fast/);
  assert.equal(f.prompts.length, 0);
});
