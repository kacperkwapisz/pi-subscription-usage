import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Pi resolves its agent directory from this variable; point it at a scratch dir before loading.
const agentDir = mkdtempSync(join(tmpdir(), "psu-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { loadSubscriptionMeterSettings, saveSubscriptionMeterSettings } = await import("../src/extensions/core/settings.ts");

test("settings live in subscription-usage.json, and older subscription-meter.json settings carry over", () => {
  writeFileSync(join(agentDir, "subscription-meter.json"), JSON.stringify({ displayMode: "remaining" }));
  const carried = loadSubscriptionMeterSettings();
  assert.equal(carried.displayMode, "remaining");

  saveSubscriptionMeterSettings({ ...carried, resetTimeDisplayMode: "absolute" });
  const saved = JSON.parse(readFileSync(join(agentDir, "subscription-usage.json"), "utf-8"));
  assert.equal(saved.displayMode, "remaining");
  assert.equal(saved.resetTimeDisplayMode, "absolute");

  writeFileSync(join(agentDir, "subscription-meter.json"), JSON.stringify({ displayMode: "used" }));
  assert.equal(loadSubscriptionMeterSettings().displayMode, "remaining", "the new file wins once it exists");
  assert.ok(existsSync(join(agentDir, "subscription-usage.json")));
});
