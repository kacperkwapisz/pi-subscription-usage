import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { subscriptionProviders } from "../src/extensions/core/providers/index.ts";
import { isProviderSetUp } from "../src/extensions/core/setup.ts";

const oauth = { type: "oauth", access: "a", refresh: "r", expires: 0 };
const apiKey = { type: "api_key", key: "k" };
const provider = (id: string) => subscriptionProviders.find((p) => p.id === id)!;
const setUp = (stored: Record<string, unknown>) =>
  subscriptionProviders.filter((p) => isProviderSetUp(p, stored)).map((p) => p.id).sort();

// Nothing from this machine (env keys, OpenCode's own login) may leak into these checks.
const savedEnv = { ...process.env };
const home = mkdtempSync(join(tmpdir(), "psu-home-"));
for (const name of Object.keys(process.env)) if (/OPENROUTER|OPENCODE/.test(name)) delete process.env[name];
process.env.HOME = home;
process.env.XDG_DATA_HOME = join(home, "data");
afterEach(() => {
  for (const name of Object.keys(process.env)) if (/OPENROUTER|OPENCODE/.test(name) && !(name in savedEnv)) delete process.env[name];
});

test("with nothing logged in, no tab is shown", () => {
  assert.deepEqual(setUp({}), []);
});

test("subscription providers need a subscription login, for the provider or any of its accounts", () => {
  assert.deepEqual(setUp({ anthropic: oauth, "github-copilot": oauth, "kimi-coding": oauth, xai: oauth }), [
    "anthropic", "github-copilot", "kimi-coding", "xai",
  ]);
  assert.ok(isProviderSetUp(provider("anthropic"), { "anthropic-account-3": oauth }), "only an extra account");
  assert.ok(isProviderSetUp(provider("openai-codex"), { openai: oauth }), "Sign in with ChatGPT");
  assert.ok(!isProviderSetUp(provider("anthropic"), { anthropic: apiKey }), "an API key has no subscription usage");
  assert.ok(!isProviderSetUp(provider("openai-codex"), { openai: apiKey }));
  assert.ok(!isProviderSetUp(provider("xai"), { "xai-oauth": oauth }), "another extension's login is not Pi's xai");
});

test("OpenRouter is set up by a stored key or OPENROUTER_API_KEY", () => {
  assert.ok(isProviderSetUp(provider("openrouter"), { openrouter: apiKey }));
  assert.ok(!isProviderSetUp(provider("openrouter"), {}));
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  assert.ok(isProviderSetUp(provider("openrouter"), {}));
});

test("OpenCode is set up by a Pi login, its environment variables, or OpenCode's own login", () => {
  assert.ok(isProviderSetUp(provider("opencode"), { "opencode-go": apiKey }));
  assert.ok(isProviderSetUp(provider("opencode"), { opencode: apiKey }));
  assert.ok(!isProviderSetUp(provider("opencode"), {}));

  process.env.OPENCODE_GO_API_KEY = "go-test";
  assert.ok(isProviderSetUp(provider("opencode"), {}));
  delete process.env.OPENCODE_GO_API_KEY;

  mkdirSync(join(home, "data", "opencode"), { recursive: true });
  writeFileSync(join(home, "data", "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "go-file" } }));
  assert.ok(isProviderSetUp(provider("opencode"), {}));
});

test("OpenCode says there is no subscription when its key has no Go plan and no Zen cookie is set", async () => {
  const { loadOpenCodeRuntimeState } = await import("../src/extensions/core/providers/opencode.ts");
  const realFetch = globalThis.fetch;
  const storage = {
    get: () => undefined,
    getAuthStatus: () => ({ configured: true, source: "stored" as const }),
    getApiKey: async (id: string) => (id === "opencode-go" ? "zen-only-key" : undefined),
  };
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } }), {
        status: 403,
      })) as typeof fetch;
    const state = await loadOpenCodeRuntimeState(storage);
    assert.equal(state.state, "error");
    assert.equal(state.noSubscription, true);

    globalThis.fetch = (async () => new Response("server error", { status: 500 })) as typeof fetch;
    assert.notEqual((await loadOpenCodeRuntimeState(storage)).noSubscription, true, "other failures keep the tab");
  } finally {
    globalThis.fetch = realFetch;
  }
});
