import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { discoverAccounts } from "../src/extensions/core/accounts.ts";
import { createSubscriptionAuthStorage, scopeAuthStorage, type SubscriptionAuthStorage } from "../src/extensions/core/auth.ts";
import { anthropicAccountInfo, parseAnthropicWindows } from "../src/extensions/core/providers/anthropic.ts";
import { loadOpenAiCodexRuntimeState } from "../src/extensions/core/providers/openai-codex.ts";

const oauth = { type: "oauth", access: "a", refresh: "r", expires: 0 };
const apiKey = { type: "api_key", key: "k" };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a provider's own login is account 1, numbered logins follow in order", () => {
  const accounts = discoverAccounts(
    { id: "anthropic" },
    { "anthropic-account-3": oauth, anthropic: oauth, "anthropic-account-2": oauth, cursor: oauth, "anthropic-2": oauth },
  );
  assert.deepEqual(
    accounts.map((a) => [a.providerId, a.label, a.sourceId]),
    [
      ["anthropic", "Account 1", "anthropic"],
      ["anthropic-account-2", "Account 2", "anthropic"],
      ["anthropic-account-3", "Account 3", "anthropic"],
    ],
  );
});

test("account 1 is listed even before login, so the dialog can say it is missing", () => {
  assert.deepEqual(discoverAccounts({ id: "xai" }, {}).map((a) => a.providerId), ["xai"]);
});

test("extra sources count only subscription logins and read as the provider's own id", () => {
  const accounts = discoverAccounts(
    { id: "openai-codex", accountSources: ["openai-codex", "openai"] },
    { "openai-codex": oauth, openai: apiKey, "openai-account-2": oauth },
  );
  assert.deepEqual(
    accounts.map((a) => [a.providerId, a.label, a.sourceId]),
    [
      ["openai-codex", "Account 1", "openai-codex"],
      ["openai-account-2", "openai account 2", "openai-codex"],
    ],
  );
});

test("a scoped reader presents another login under the provider's own id", async () => {
  const seen: string[] = [];
  const storage: SubscriptionAuthStorage = {
    get: (id) => (seen.push(`get:${id}`), undefined),
    getAuthStatus: (id) => (seen.push(`status:${id}`), { configured: true }),
    getApiKey: async (id) => (seen.push(`key:${id}`), `token-for-${id}`),
  };
  const scoped = scopeAuthStorage(storage, "anthropic", "anthropic-account-2");
  assert.equal(await scoped.getApiKey("anthropic"), "token-for-anthropic-account-2");
  scoped.get("anthropic");
  scoped.getAuthStatus("github-copilot");
  assert.deepEqual(seen, ["key:anthropic-account-2", "get:anthropic-account-2", "status:github-copilot"]);
  assert.equal(scopeAuthStorage(storage, "x", "x"), storage);
});

test("the Pi-backed reader takes tokens from Pi (which refreshes them) and falls back for unknown providers", async () => {
  const registry = {
    getProvider: (id: string) => (id === "anthropic" ? ({} as never) : undefined),
    getProviderAuthStatus: () => ({ configured: true, source: "stored" as const }),
    getApiKeyForProvider: async (id: string) => `pi:${id}`,
  };
  const auth = createSubscriptionAuthStorage(registry);
  assert.equal(await auth.getApiKey("anthropic"), "pi:anthropic");
  assert.deepEqual(auth.getAuthStatus("anthropic"), { configured: true, source: "stored" });
  assert.notEqual(await auth.getApiKey("not-a-pi-provider"), "pi:not-a-pi-provider");
});

test("Claude: the limits list becomes 5h and per-model 7d windows", () => {
  const windows = parseAnthropicWindows({
    five_hour: { utilization: 25, resets_at: "2026-10-08T19:50:00Z" },
    limits: [
      { kind: "session", group: "session", percent: 25, resets_at: "2026-10-08T19:50:00Z" },
      { kind: "weekly_scoped", group: "weekly", percent: 4, resets_at: "2026-10-09T07:00:00Z", scope: { model: { display_name: "Fable" } } },
    ],
  });
  assert.deepEqual(windows.map((w) => [w.label, w.usedPercent]), [["5h", 25], ["7d Fable", 4]]);
});

test("Claude: responses without a limits list still use the fixed fields", () => {
  const windows = parseAnthropicWindows({
    five_hour: { utilization: 10, resets_at: "2026-10-08T19:50:00Z" },
    seven_day: { utilization: 30, resets_at: "2026-10-12T00:00:00Z" },
  });
  assert.deepEqual(windows.map((w) => w.label), ["5h", "7d"]);
});

test("Claude: plan and identity come from the profile", () => {
  assert.deepEqual(
    anthropicAccountInfo({
      account: { uuid: "acc", email: "me@example.com", has_claude_max: false, has_claude_pro: false },
      organization: { uuid: "org", organization_type: "claude_team", rate_limit_tier: "default_claude_max_5x" },
    }),
    { email: "me@example.com", plan: "Team · Max 5x", identity: "anthropic:acc:org" },
  );
  assert.equal(anthropicAccountInfo({ account: { has_claude_pro: true } }).plan, "Pro");
  assert.deepEqual(anthropicAccountInfo({}), { email: undefined, plan: undefined, identity: undefined });
});

test("ChatGPT: an account's own token names its account id, never the Codex CLI's", async () => {
  const claims = {
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-2", chatgpt_account_user_id: "user-2__acct-2", chatgpt_plan_type: "plus" },
    "https://api.openai.com/profile": { email: "two@example.com" },
  };
  const token = `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  let sentAccountId: string | undefined;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    sentAccountId = (init?.headers as Record<string, string>)["ChatGPT-Account-Id"];
    return new Response(JSON.stringify({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_891_000_000 } },
    }));
  }) as typeof fetch;
  const storage: SubscriptionAuthStorage = {
    get: () => ({ type: "oauth" }), // a Sign in with ChatGPT login stores no accountId
    getAuthStatus: () => ({ configured: true, source: "stored" }),
    getApiKey: async () => token,
  };

  const state = await loadOpenAiCodexRuntimeState(storage);
  assert.equal(sentAccountId, "acct-2");
  assert.equal(state.state, "ready");
  assert.deepEqual(state.account, { email: "two@example.com", plan: "Plus", identity: "chatgpt:user-2__acct-2" });
});

test("ChatGPT windows are named by their real length", async () => {
  const { labelForWindowSeconds } = await import("../src/extensions/core/providers/openai-codex.ts");
  const day = 86_400;
  assert.equal(labelForWindowSeconds(5 * 3600, "Weekly"), "Session");
  assert.equal(labelForWindowSeconds(7 * day, "Session"), "Weekly");
  assert.equal(labelForWindowSeconds(30 * day, "Weekly"), "Monthly", "a Free plan's 30-day window");
  assert.equal(labelForWindowSeconds(10 * day, "Weekly"), "10-day");
});
