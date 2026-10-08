import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subscriptionUsage from "../src/extensions/core/index.ts";

test("/usage is an alias of /subscriptions", () => {
  const commands = new Map<string, { handler: unknown }>();
  subscriptionUsage({ registerCommand: (name: string, options: { handler: unknown }) => commands.set(name, options) } as unknown as ExtensionAPI);
  assert.deepEqual([...commands.keys()].sort(), ["subscriptions", "usage"]);
  assert.equal(commands.get("usage")?.handler, commands.get("subscriptions")?.handler);
});
