import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import aiGatewayExtension, { configPath, loadConfig, saveConfig } from "../extensions/ai-gateway.ts";

// Optional host-level integration: no Pi dependency is needed for the ordinary unit tests.
const piPackage = process.env.PI_TEST_PACKAGE_DIR;

test("Speed/routing integration: real Pi session switches APIs and tiers on the next request without reselecting", {
  skip: piPackage ? false : "Set PI_TEST_PACKAGE_DIR to an installed pi-coding-agent package to run real HTTP tests",
  timeout: 30_000,
}, async (t) => {
  const sdk = await import(pathToFileURL(path.join(piPackage!, "dist/index.js")).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-gateway-speed-http-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const requests: Array<{ url: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "gpt-other" }] }));
      return;
    }
    if (req.url !== "/v1/responses" && req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push({ url: req.url!, headers: req.headers, body: JSON.parse(text) });
    res.setHeader("Content-Type", "text/event-stream");
    if (req.url === "/v1/responses") {
      res.end(`data: ${JSON.stringify({ type: "response.completed", response: {
        id: "resp_test", status: "completed", output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      } })}\n\n`);
    } else {
      res.end(`data: ${JSON.stringify({ id: "chat_test", object: "chat.completion.chunk", choices: [
        { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" },
      ], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  saveConfig({ gateways: [{
    name: "gw", baseUrl, apiKey: "sk-local-test", api: "openai-responses",
    headers: { "X-Gateway": "preserved" },
    overrides: { "gpt-5.5": { contextWindow: 272000, reasoning: true, thinkingLevelMap: { high: "high" } } },
  }] });
  const runtime = await sdk.ModelRuntime.create({
    authPath: path.join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  let requestsFromHooks = 0;
  let responsesFromHooks = 0;
  let streamEvents = 0;
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, transport: "sse",
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [aiGatewayExtension, (pi: Parameters<typeof aiGatewayExtension>[0]) => {
      pi.on("before_provider_request", (event) => {
        requestsFromHooks++;
        return { ...(event.payload as object), user: "hook-preserved" };
      });
      pi.on("after_provider_response", () => { responsesFromHooks++; });
      pi.on("provider_stream_event", () => { streamEvents++; });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime: runtime, resourceLoader: loader,
    settingsManager, sessionManager: sdk.SessionManager.inMemory(dir), tools: [], thinkingLevel: "high",
  });
  t.after(() => session.dispose());
  const notices: string[] = [];
  const statuses = new Map<string, string>();
  let routing = "Keep";
  await session.bindExtensions({ mode: "tui", uiContext: {
    async input() { return ""; },
    async select(title: string, choices: string[]) {
      return title.startsWith("API routing:") ? choices.find((s) => s.startsWith(routing)) : "Keep";
    },
    notify(message: string) { notices.push(message); },
    setStatus(key: string, value: string | undefined) {
      if (value === undefined) statuses.delete(key);
      else statuses.set(key, value);
    },
  } });
  await session.setModel(runtime.getModel("gw", "gpt-5.5"));
  session.setThinkingLevel("high");
  assert.equal(statuses.has("ai-gateway-speed"), false);
  for (const mode of ["ultrafast", "fast", "off", "ultrafast", "remove"] as const) {
    await session.prompt(mode === "remove" ? "/ai-gateway speed remove gpt-5.5" : `/ai-gateway speed add gpt-5.5 ${mode}`);
    assert.equal(statuses.get("ai-gateway-speed"), mode === "fast" ? "⚡ Fast" : mode === "ultrafast" ? "⚡⚡ Ultrafast" : undefined);
    const before = requests.length;
    await session.prompt("Reply OK");
    assert.equal(requests.length, before + 1, notices.join("\n"));
    const request = requests.at(-1)!;
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.body.model, "gpt-5.5");
    assert.equal(request.body.service_tier, mode === "ultrafast" ? "ultrafast" : mode === "fast" ? "priority" : undefined);
    assert.equal(request.headers["openai-service-tier"], mode === "ultrafast" ? "ultrafast" : undefined);
    assert.equal(request.headers["x-gateway"], "preserved");
    assert.match(String(request.headers["user-agent"]), /^pi \(/);
    assert.equal(request.body.user, "hook-preserved");
    assert.equal(session.model.id, "gpt-5.5");
    assert.equal(session.model.contextWindow, 272000);
    assert.equal(session.thinkingLevel, "high");
    assert.equal((request.body.reasoning as { effort: string }).effort, "high");
  }
  assert.equal(loadConfig().gateways[0].speed, undefined);
  assert.equal(fs.readFileSync(configPath(), "utf8").includes('"speed"'), false);
  await session.setModel(runtime.getModel("gw", "gpt-other"));
  await session.prompt("Reply OK");
  assert.equal(requests.at(-1)!.body.service_tier, undefined);
  assert.equal(requests.at(-1)!.headers["openai-service-tier"], undefined);
  await session.prompt("/ai-gateway speed add gpt-5.5 fast");
  assert.equal(statuses.has("ai-gateway-speed"), false);
  await session.setModel(runtime.getModel("gw", "gpt-5.5"));
  assert.equal(statuses.get("ai-gateway-speed"), "⚡ Fast");
  await session.setModel(runtime.getModel("gw", "gpt-other"));
  assert.equal(statuses.has("ai-gateway-speed"), false);

  // Fast also reaches Chat Completions without changing the selected gateway protocol.
  const config = loadConfig();
  saveConfig({ gateways: [{ ...config.gateways[0], api: "openai-completions" }] });
  await session.prompt("/ai-gateway speed add gpt-5.5 fast");
  await session.setModel(runtime.getModel("gw", "gpt-5.5"));
  await session.prompt("Reply OK");
  assert.equal(requests.at(-1)!.url, "/v1/chat/completions");
  assert.equal(requests.at(-1)!.body.service_tier, "priority");
  assert.equal(requests.at(-1)!.headers["openai-service-tier"], undefined);
  assert.equal(statuses.get("ai-gateway-speed"), "⚡ Fast");
  assert.match(String(requests.at(-1)!.headers["user-agent"]), /^pi \(/);

  // Only this model changes protocol; the selected model and thinking stay intact.
  session.setThinkingLevel("high");
  assert.equal(session.thinkingLevel, "high");
  for (const choice of ["Responses", "Chat Completions", "Responses", "Auto"] as const) {
    routing = choice;
    await session.prompt("/ai-gateway overrides add gpt-5.5");
    const responses = choice === "Responses";
    assert.equal(session.model.api, responses ? "openai-responses" : "openai-completions");
    assert.equal(runtime.getModel("gw", "gpt-other").api, "openai-completions");
    assert.equal(loadConfig().gateways[0].api, "openai-completions");
    assert.equal(loadConfig().gateways[0].overrides!["gpt-5.5"].api,
      choice === "Auto" ? undefined : responses ? "openai-responses" : "openai-completions");
    if (responses) await session.prompt("/ai-gateway speed add gpt-5.5 ultrafast");
    const before = requests.length;
    await session.prompt("Reply OK");
    assert.equal(requests.length, before + 1, notices.join("\n"));
    const request = requests.at(-1)!;
    assert.equal(request.url, responses ? "/v1/responses" : "/v1/chat/completions");
    assert.equal(request.body.service_tier, responses ? "ultrafast" : undefined);
    assert.equal(request.headers["openai-service-tier"], responses ? "ultrafast" : undefined);
    assert.match(String(request.headers["user-agent"]), /^pi \(/);
    assert.equal(request.headers["x-gateway"], "preserved");
    assert.equal(request.body.user, "hook-preserved");
    assert.equal(session.model.contextWindow, 272000);
    assert.equal(session.thinkingLevel, "high");
    assert.equal(responses ? (request.body.reasoning as { effort: string }).effort : request.body.reasoning_effort, "high");
    assert.equal(statuses.get("ai-gateway-speed"), responses ? "⚡⚡ Ultrafast" : undefined);
  }
  assert.equal(loadConfig().gateways[0].speed!["gpt-5.5"], "ultrafast");
  await session.setModel(runtime.getModel("gw", "gpt-other"));
  await session.prompt("Reply OK");
  assert.equal(requests.at(-1)!.url, "/v1/chat/completions");
  assert.equal(requests.at(-1)!.body.service_tier, undefined);
  assert.equal(requestsFromHooks, requests.length);
  assert.equal(responsesFromHooks, requests.length);
  assert.ok(streamEvents >= requests.length);
  await runtime.refresh({ allowNetwork: false });
});
