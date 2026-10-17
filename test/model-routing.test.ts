import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configPath, gatewayCommand, loadConfig, registerGateway, resolveModelApi, saveConfig, validateGateway,
  type GatewayConfig,
} from "../extensions/ai-gateway.ts";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

const gateway: GatewayConfig = {
  name: "gw", baseUrl: "https://gateway.example/v1", apiKey: "sk-test", api: "openai-completions",
  headers: { "X-Gateway": "kept" },
  overrides: { "gpt-alias": { contextWindow: 272000, reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } },
  speed: { "gpt-alias": "fast" },
};

function fixture(t: TestContext, gateways: GatewayConfig[] = [gateway]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-gateway-routing-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  saveConfig({ gateways });
  t.mock.method(globalThis, "fetch", async (input: unknown) => String(input).endsWith("/v1/models")
    ? Response.json({ data: [{ id: "gpt-alias" }, { id: "gpt-other" }] })
    : new Response("not found", { status: 404 }));
  const answers: Array<string | undefined> = [];
  const prompts: Array<{ title: string; choices?: string[] }> = [];
  const notices: string[] = [];
  const registrations: Array<{ name: string; config: ProviderConfig }> = [];
  const pi = {
    registerProvider(name: string, config: ProviderConfig) { registrations.push({ name, config }); },
  } as Parameters<typeof gatewayCommand>[0];
  const ctx = {
    hasUI: true,
    ui: {
      async input(title: string) { prompts.push({ title }); return answers.shift(); },
      async select(title: string, choices: string[]) {
        prompts.push({ title, choices });
        const answer = answers.shift();
        return answer === undefined ? undefined : choices.find((c) => c.startsWith(answer));
      },
      notify(message: string) { notices.push(message); }, setStatus() {},
    },
  } as unknown as Parameters<typeof gatewayCommand>[2];
  return { pi, ctx, answers, prompts, notices, registrations };
}

test("model API: validates overrides without accepting unknown protocols or malformed entries", () => {
  for (const api of [undefined, "openai-completions", "openai-responses"] as const) {
    assert.equal(validateGateway({ ...gateway, overrides: { "gpt-alias": { api } } }), null);
  }
  for (const override of [null, [], "responses", { api: null }, { api: "auto" }, { api: "openai-codex-responses" }, { api: 5 }]) {
    assert.ok(validateGateway({ ...gateway, overrides: { "gpt-alias": override } } as unknown as GatewayConfig));
  }
  for (const id of ["", " gpt-alias", "gpt-alias "]) {
    assert.ok(validateGateway({ ...gateway, overrides: { [id]: { api: "openai-responses" } } }));
  }
});

test("model API: exact model override beats gateway and auto, absent overrides retain existing defaults", () => {
  const ids = new Set(["gpt-alias"]);
  const responses: GatewayConfig = { ...gateway, overrides: { "gpt-alias": { api: "openai-responses" } } };
  assert.equal(resolveModelApi(responses, "gpt-alias", new Set()), "openai-responses");
  assert.equal(resolveModelApi(responses, "gpt-other", ids), "openai-completions");
  assert.equal(resolveModelApi({ ...responses, overrides: {} }, "gpt-alias", ids), "openai-completions");
  assert.equal(resolveModelApi({ api: "openai-responses", apiRouting: "auto", overrides: {
    "gpt-alias": { api: "openai-completions" },
  } }, "gpt-alias", ids), "openai-completions");
  assert.equal(resolveModelApi({ apiRouting: "auto" }, "gpt-alias", ids), "openai-responses");
  assert.equal(resolveModelApi({}, "gpt-alias", ids), "openai-completions");
});

test("model API TUI: API-only change saves, re-registers and preserves metadata, Speed and gateway", async (t) => {
  const f = fixture(t);
  f.answers.push("gpt-alias", "Responses", "", "", "Keep", "Keep");
  await gatewayCommand(f.pi, "overrides add", f.ctx);
  assert.match(f.prompts[0].title, /^Model ID/);
  assert.match(f.prompts[1].title, /effective: openai-completions/);
  assert.deepEqual(f.prompts[1].choices, ["Keep", "Auto (follow gateway) (current)", "Chat Completions (/v1/chat/completions)", "Responses (/v1/responses)"]);
  const saved = loadConfig().gateways[0];
  assert.deepEqual(saved, { ...gateway, overrides: {
    ...gateway.overrides, "gpt-alias": { ...gateway.overrides!["gpt-alias"], api: "openai-responses" },
  } });
  const config = f.registrations.at(-1)!.config;
  assert.equal(config.api, "openai-completions");
  const model = config.models!.find((m) => m.id === "gpt-alias")!;
  assert.equal(model.api, "openai-responses");
  assert.equal("contextWindow" in model && model.contextWindow, 272000);
  assert.deepEqual(model.cost, gateway.overrides!["gpt-alias"].cost);
  assert.equal(config.models!.find((m) => m.id === "gpt-other")!.api, undefined);
  assert.deepEqual(config.headers, gateway.headers);
  assert.match(f.notices.at(-1)!, /Subsequent requests/);

  f.answers.push("Keep", "", "", "Keep", "Keep");
  const before = fs.readFileSync(configPath(), "utf8");
  await gatewayCommand(f.pi, "overrides add gpt-alias", f.ctx);
  assert.match(f.prompts.at(-5)!.choices!.at(-1)!, /Responses.*\(current\)/);
  assert.equal(fs.readFileSync(configPath(), "utf8"), before);
  assert.equal(f.registrations.length, 1);
});

test("model API TUI: Auto removes only the api field, keeps explicit choices even when matching defaults", async (t) => {
  const f = fixture(t, [{ ...gateway, overrides: { "gpt-alias": { api: "openai-responses" } } }]);
  f.answers.push("Auto", "", "", "Keep");
  await gatewayCommand(f.pi, "overrides add gpt-alias", f.ctx);
  assert.equal(loadConfig().gateways[0].overrides, undefined);
  assert.equal(f.registrations.at(-1)!.config.api, "openai-completions");
  assert.equal(f.registrations.at(-1)!.config.models![0].api, undefined);
  assert.deepEqual(loadConfig().gateways[0].speed, gateway.speed);

  f.answers.push("Chat Completions", "", "", "Keep");
  await gatewayCommand(f.pi, "overrides add gpt-alias", f.ctx);
  assert.deepEqual(loadConfig().gateways[0].overrides, { "gpt-alias": { api: "openai-completions" } });
  f.answers.push("Keep", "", "", "Keep");
  await gatewayCommand(f.pi, "overrides add gpt-other 200000", f.ctx);
  assert.equal(loadConfig().gateways[0].overrides!["gpt-alias"].api, "openai-completions");
});

test("model API TUI: API-only edits never clean other metadata, even fields equal to catalog defaults", async (t) => {
  const original: GatewayConfig = { ...gateway, overrides: {
    "gpt-alias": { api: "openai-responses", contextWindow: 128000, maxTokens: 16384, reasoning: false },
    "gpt-other": { contextWindow: 128000, reasoning: false },
  } };
  const f = fixture(t, [original]);
  f.answers.push("Auto", "", "", "Keep");
  await gatewayCommand(f.pi, "overrides add gpt-alias", f.ctx);
  assert.deepEqual(loadConfig().gateways[0].overrides, {
    "gpt-alias": { contextWindow: 128000, maxTokens: 16384, reasoning: false },
    "gpt-other": original.overrides!["gpt-other"],
  });
  f.answers.push("Responses", "", "", "Keep");
  await gatewayCommand(f.pi, "overrides add gpt-alias", f.ctx);
  assert.deepEqual(loadConfig().gateways[0], original);
  f.answers.push("Keep", "", "Keep");
  await gatewayCommand(f.pi, "overrides add gpt-alias 300000", f.ctx);
  assert.deepEqual(loadConfig().gateways[0].overrides!["gpt-other"], original.overrides!["gpt-other"]);
  assert.equal(loadConfig().gateways[0].overrides!["gpt-alias"].api, "openai-responses");
});

test("model API TUI: cancelling any later dialog never persists the pending protocol change", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(configPath(), "utf8");
  for (const answers of [
    [undefined], ["Responses", undefined], ["Responses", "", undefined],
    ["Responses", "", "", undefined], ["Responses", "", "", "Keep", undefined],
  ]) {
    f.answers.push(...answers);
    await gatewayCommand(f.pi, "overrides add gpt-alias", f.ctx);
    assert.equal(fs.readFileSync(configPath(), "utf8"), before);
    assert.equal(f.registrations.length, 0);
  }
});

test("model API TUI: Auto keeps metadata and exact gateway isolation, while non-UI numeric edits keep routing", async (t) => {
  const second: GatewayConfig = { ...gateway, name: "second", overrides: {
    "gpt-alias": { ...gateway.overrides!["gpt-alias"], api: "openai-responses" },
  } };
  const f = fixture(t, [gateway, second]);
  f.answers.push("second", "Auto", "", "", "Keep", "Keep");
  await gatewayCommand(f.pi, "overrides add gpt-alias", f.ctx);
  assert.deepEqual(loadConfig().gateways, [gateway, { ...gateway, name: "second" }]);
  assert.deepEqual(f.registrations.map((r) => r.name), ["second"]);
  saveConfig({ gateways: [second] });
  f.ctx.hasUI = false;
  const count = f.prompts.length;
  await gatewayCommand(f.pi, "overrides add gpt-alias 300000 32000", f.ctx);
  assert.equal(f.prompts.length, count);
  assert.deepEqual(loadConfig().gateways[0].overrides!["gpt-alias"], {
    ...second.overrides!["gpt-alias"], contextWindow: 300000, maxTokens: 32000,
  });
  await gatewayCommand(f.pi, "set-price remove gpt-alias", f.ctx);
  assert.equal(loadConfig().gateways[0].overrides!["gpt-alias"].api, "openai-responses");
  assert.equal(loadConfig().gateways[0].overrides!["gpt-alias"].cost, undefined);
  await gatewayCommand(f.pi, "overrides remove gpt-alias", f.ctx);
  assert.equal(loadConfig().gateways[0].overrides, undefined);
  assert.deepEqual(loadConfig().gateways[0].speed, gateway.speed);
  assert.equal(f.registrations.at(-1)!.config.models![0].api, undefined);
});

test("model API: Ultrafast validation uses explicit protocol even before model discovery", async (t) => {
  const f = fixture(t, [{ ...gateway, overrides: {
    "gpt-future": { api: "openai-responses" }, "gpt-blocked": { api: "openai-completions" },
  } }]);
  await gatewayCommand(f.pi, "speed add gpt-future ultrafast", f.ctx);
  assert.equal(loadConfig().gateways[0].speed!["gpt-future"], "ultrafast");
  assert.equal(f.registrations[0].config.models!.some((m) => m.id === "gpt-future"), false);
  await gatewayCommand(f.pi, "speed add gpt-blocked ultrafast", f.ctx);
  assert.match(f.notices.at(-1)!, /Ultrafast requires openai-responses/);
  assert.equal(loadConfig().gateways[0].speed!["gpt-blocked"], undefined);
});

test("model API registration: overrides route independently and remove incompatible speed headers", async (t) => {
  const f = fixture(t);
  t.mock.method(console, "warn", () => {});
  for (const [api, speed] of [["openai-responses", "ultrafast"], ["openai-completions", "ultrafast"], ["openai-completions", "fast"]] as const) {
    await registerGateway(f.pi, { ...gateway, api: "openai-responses", overrides: {
      ...gateway.overrides, "gpt-alias": { ...gateway.overrides!["gpt-alias"], api },
    }, speed: { "gpt-alias": speed } }, new Map(), {});
    const config = f.registrations.at(-1)!.config;
    const selected = config.models!.find((m) => m.id === "gpt-alias")!;
    assert.equal(selected.api ?? config.api, api);
    assert.equal(config.models!.find((m) => m.id === "gpt-other")!.api ?? config.api, "openai-responses");
    const tier = "samplingParams" in selected ? selected.samplingParams?.service_tier : undefined;
    assert.equal(tier, speed === "fast" ? "priority" : api === "openai-responses" ? "ultrafast" : undefined);
    assert.deepEqual(selected.headers, api === "openai-responses" ? { "OpenAI-Service-Tier": "ultrafast" } : undefined);
  }
});

test("model API: save and apply failures give accurate feedback without losing other fields", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(configPath(), "utf8");
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("disk full"); });
  f.answers.push("Responses", "", "", "Keep", "Keep");
  await gatewayCommand(f.pi, "overrides add gpt-alias", f.ctx);
  assert.equal(fs.readFileSync(configPath(), "utf8"), before);
  assert.equal(f.registrations.length, 0);
  assert.match(f.notices.at(-1)!, /not saved.*disk full/);
  rename.mock.restore();
  t.mock.method(f.pi, "registerProvider", () => { throw new Error("registration failed"); });
  f.answers.push("Responses", "", "", "Keep", "Keep");
  await gatewayCommand(f.pi, "overrides add gpt-alias", f.ctx);
  assert.equal(loadConfig().gateways[0].overrides!["gpt-alias"].api, "openai-responses");
  assert.deepEqual(loadConfig().gateways[0].speed, gateway.speed);
  assert.match(f.notices.at(-1)!, /saved, but could not be applied/);
});
