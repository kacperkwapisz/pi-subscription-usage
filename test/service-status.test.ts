import assert from "node:assert/strict";
import { test } from "node:test";
import { providerForPiId } from "../src/extensions/core/index.ts";
import { createDefaultSubscriptionProviderRegistry } from "../src/extensions/core/providers/index.ts";
import { describeStatus, parseSummary, ServiceStatusReader } from "../src/extensions/core/service-status.ts";

// Shaped like status.claude.com's real summary.json.
const degraded = {
  status: { indicator: "minor", description: "Partially Degraded Service" },
  components: [
    { name: "claude.ai", status: "operational" },
    { name: "Claude Console (platform.claude.com)", status: "degraded_performance" },
    { name: "Claude API (api.anthropic.com)", status: "operational" },
    { name: "Group", status: "major_outage", group: true },
  ],
  incidents: [
    { name: "Elevated errors on platform.claude.com", status: "monitoring", impact: "major" },
    { name: "Old one", status: "resolved", impact: "minor" },
  ],
  scheduled_maintenances: [{ name: "Database upgrade", status: "scheduled" }],
};

test("a status page summary becomes a level, its own description and what is affected", () => {
  const status = parseSummary("status.claude.com", degraded);
  assert.equal(status.level, "minor");
  assert.deepEqual(status.problems, [
    "Elevated errors on platform.claude.com (monitoring)",
    "Claude Console (platform.claude.com): slow",
  ]);
  assert.equal(
    describeStatus({ ok: true, status }),
    "status.claude.com: Partially Degraded Service. Elevated errors on platform.claude.com (monitoring); Claude Console (platform.claude.com): slow",
  );

  const fine = parseSummary("status.openai.com", { status: { indicator: "none", description: "All Systems Operational" }, components: [] });
  assert.equal(describeStatus({ ok: true, status: fine }), "status.openai.com: All systems operational");

  const maintenance = parseSummary("status.claude.com", { status: { indicator: "none" }, scheduled_maintenances: [{ name: "Upgrade", status: "in_progress" }] });
  assert.equal(maintenance.level, "maintenance");
  assert.deepEqual(maintenance.problems, ["Maintenance: Upgrade"]);
});

test("pages are fetched at most once a minute; failures are not kept", async () => {
  let calls = 0;
  let fail = true;
  const reader = new ServiceStatusReader((async (url: string) => {
    calls++;
    assert.equal(url, "https://status.claude.com/api/v2/summary.json");
    if (fail) throw new Error("offline");
    return new Response(JSON.stringify(degraded));
  }) as typeof fetch);

  const failed = await reader.read("status.claude.com");
  assert.deepEqual(failed, { ok: false, page: "status.claude.com", error: "offline" });
  assert.equal(describeStatus(failed), "Couldn't check status.claude.com");

  fail = false;
  const first = await reader.read("status.claude.com");
  assert.equal(first.ok && first.status.level, "minor");
  await reader.read("status.claude.com");
  assert.equal(calls, 2, "the second look within a minute came from the cache");
  await reader.read("status.claude.com", { fresh: true });
  assert.equal(calls, 3, "refresh asks again");
});

test("Pi provider ids, including numbered accounts, map to their status page", () => {
  const providers = createDefaultSubscriptionProviderRegistry().getAllProviders();
  const page = (id: string) => providerForPiId(providers, id)?.statusPage;
  assert.equal(page("anthropic"), "status.claude.com");
  assert.equal(page("anthropic-account-3"), "status.claude.com");
  assert.equal(page("openai"), "status.openai.com");
  assert.equal(page("openai-account-2"), "status.openai.com");
  assert.equal(page("openai-codex"), "status.openai.com");
  assert.equal(page("xai"), undefined);
  assert.equal(page("something-else"), undefined);
});

test("other extensions can ask for a provider's status over pi.events", async (t) => {
  const { default: subscriptionUsage, STATUS_EVENT } = await import("../src/extensions/core/index.ts");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(degraded)));
  const handlers = new Map<string, (data: unknown) => void>();
  subscriptionUsage({
    registerCommand: () => {},
    events: { on: (name: string, handler: (data: unknown) => void) => handlers.set(name, handler), emit: () => {} },
  } as never);
  const ask = (provider: string) =>
    new Promise<unknown>((resolve) => handlers.get(STATUS_EVENT)!({ provider, reply: resolve }));

  const claude = (await ask("anthropic-account-3")) as Parameters<typeof describeStatus>[0];
  assert.match(describeStatus(claude), /^status\.claude\.com: Partially Degraded Service\./);
  assert.equal(await ask("xai"), undefined, "no status page");
});
