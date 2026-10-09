import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sessionsDir, statsNaming } from "../src/extensions/core/index.ts";
import { createDefaultSubscriptionProviderRegistry } from "../src/extensions/core/providers/index.ts";
import { loadRecords, parseLine, readFrom, type UsageRecord } from "../src/extensions/core/stats/records.ts";
import { cachedShare, summarize, totalTokens } from "../src/extensions/core/stats/summary.ts";
import { formatTokens, formatUsd, StatsView } from "../src/extensions/core/ui/stats-view.ts";

const plainTheme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;
const naming = statsNaming(createDefaultSubscriptionProviderRegistry().getAllProviders(), (id) => (id === "xai-oauth" ? "xAI" : id));

/** A session-file line for one model reply, as Pi writes it. */
function reply(options: { provider: string; model?: string; at: number; cost?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; id?: string }): string {
  const usage = {
    input: options.input ?? 100,
    output: options.output ?? 50,
    cacheRead: options.cacheRead ?? 800,
    cacheWrite: options.cacheWrite ?? 50,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: options.cost ?? 0.01 },
  };
  const message = {
    role: "assistant",
    content: [{ type: "text", text: 'said "role":"user" and {"usage": 1}' }],
    api: "anthropic-messages",
    provider: options.provider,
    model: options.model ?? "claude-opus-5-5",
    usage,
    stopReason: "stop",
    timestamp: options.at,
    ...(options.id ? { responseId: options.id } : {}),
  };
  return JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: new Date(options.at).toISOString(), message });
}

const user = JSON.stringify({ type: "message", id: "u", parentId: null, timestamp: "", message: { role: "user", content: "hi", timestamp: 1 } });
const toolResult = JSON.stringify({ type: "message", id: "t", parentId: null, timestamp: "", message: { role: "toolResult", content: [{ type: "text", text: '"role":"assistant" inside output' }] } });

test("a priced reply is read; unpriced replies and other lines are not", () => {
  const record = parseLine(reply({ provider: "anthropic-account-2", at: 1_000, id: "msg_1", cost: 0.5 }), false);
  assert.deepEqual(record, {
    at: 1_000, provider: "anthropic-account-2", model: "claude-opus-5-5", input: 100, output: 50, cacheRead: 800, cacheWrite: 50, cost: 0.5, subagent: false, key: "msg_1",
  });
  assert.equal(parseLine(reply({ provider: "cursor-agent", at: 1_000, cost: 0 }), false), undefined, "no API price");
  assert.equal(parseLine(user, false), undefined);
  assert.equal(parseLine(toolResult, false), undefined);
  assert.equal(parseLine("{broken", false), undefined);
  assert.equal(parseLine(reply({ provider: "xai-oauth", at: 5, output: 7 }), true)?.key, "5|xai-oauth|claude-opus-5-5|7", "no response id");
});

test("a line still being written is left for the next read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-read-"));
  const file = join(dir, "s.jsonl");
  const first = `${user}\n${reply({ provider: "anthropic", at: 1, id: "a" })}\n`;
  writeFileSync(file, `${first}${reply({ provider: "anthropic", at: 2, id: "b" }).slice(0, 40)}`);
  const one = await readFrom(file, 0, false);
  assert.deepEqual(one.records.map((r) => r.key), ["a"]);
  assert.equal(one.end, Buffer.byteLength(first));
  writeFileSync(file, `${first}${reply({ provider: "anthropic", at: 2, id: "b" })}\n`);
  const two = await readFrom(file, one.end, false);
  assert.deepEqual(two.records.map((r) => r.key), ["b"]);
  rmSync(dir, { recursive: true });
});

test("sessions and subagents are read once, then only what was added; a reply in two files counts once", async () => {
  const root = mkdtempSync(join(tmpdir(), "stats-load-"));
  const sessions = join(root, "sessions");
  const subagents = join(root, "subagents");
  mkdirSync(join(sessions, "--project--"), { recursive: true });
  mkdirSync(join(subagents, "parent"), { recursive: true });
  const main = join(sessions, "--project--", "a.jsonl");
  writeFileSync(main, `${user}\n${reply({ provider: "anthropic", at: 10, id: "m1" })}\n${toolResult}\n`);
  // A fork copies m1 and goes on.
  writeFileSync(join(sessions, "--project--", "fork.jsonl"), `${reply({ provider: "anthropic", at: 10, id: "m1" })}\n${reply({ provider: "anthropic-account-2", at: 20, id: "m2" })}\n`);
  writeFileSync(join(subagents, "parent", "scout.jsonl"), `${reply({ provider: "anthropic", model: "claude-haiku-5-5", at: 30, id: "s1" })}\n`);
  const options = { sources: [{ dir: sessions, subagent: false }, { dir: subagents, subagent: true }], cacheFile: join(root, "cache.bin") };

  const keys = (records: UsageRecord[]) => records.map((r) => `${r.provider}:${r.model}:${r.subagent ? "sub" : "main"}`).sort();
  const first = await loadRecords(options);
  assert.equal(first.length, 3, "m1 once");
  assert.deepEqual(keys(first), ["anthropic-account-2:claude-opus-5-5:main", "anthropic:claude-haiku-5-5:sub", "anthropic:claude-opus-5-5:main"]);

  appendFileSync(main, `${reply({ provider: "openai", model: "gpt-5.5", at: 40, id: "m3", cost: 2 })}\n`);
  const second = await loadRecords(options);
  assert.equal(second.length, 4);
  assert.equal(second.find((r) => r.provider === "openai")?.cost, 2);

  rmSync(join(subagents, "parent", "scout.jsonl"));
  assert.equal((await loadRecords(options)).length, 3, "a deleted session drops out");

  writeFileSync(options.cacheFile, "not a cache");
  assert.equal((await loadRecords(options)).length, 3, "a broken cache is read past");
  rmSync(root, { recursive: true });
});

test("a period groups each provider with all its accounts and works out the cache share", () => {
  const now = new Date(2026, 9, 9, 15, 0).getTime();
  const hour = 3_600_000;
  const at = (hoursAgo: number) => now - hoursAgo * hour;
  const r = (provider: string, hoursAgo: number, extra: Partial<UsageRecord> = {}): UsageRecord => ({
    at: at(hoursAgo), provider, model: "claude-opus-5-5", input: 10, output: 5, cacheRead: 80, cacheWrite: 10, cost: 1, subagent: false, key: `${provider}${hoursAgo}`, ...extra,
  });
  const records = [
    r("anthropic", 1),
    r("anthropic-account-3", 2, { subagent: true }),
    r("openai-codex", 3, { model: "gpt-5.5", cost: 3 }),
    r("openai", 4, { model: "gpt-5.5" }),
    r("xai-oauth", 30, { model: "grok-4.7" }),
    r("anthropic", 24 * 40),
  ];

  const today = summarize(records, "today", naming, now);
  assert.equal(today.totals.replies, 4);
  assert.deepEqual(today.providers.map((p) => [p.label, p.accounts.map((a) => a.label)]), [
    ["Anthropic", ["Account 1", "Account 3"]],
    ["ChatGPT", ["Account 1", "openai"]],
  ]);
  assert.equal(today.providers[1]!.totals.cost, 4);
  assert.equal(totalTokens(today.totals), 4 * 105);
  assert.equal(cachedShare(today.totals), 80 / 100);
  assert.equal(today.subagentShare, 0.25);
  assert.equal(today.chart.buckets.length, 24);
  assert.equal(today.chart.buckets[14], 105, "the reply an hour ago lands at 14:00");

  assert.equal(summarize(records, "week", naming, now).totals.replies, 5);
  assert.equal(summarize(records, "week", naming, now).chart.buckets.length, 7);
  assert.equal(summarize(records, "all", naming, now).totals.replies, 6);
});

test("numbers read compactly", () => {
  assert.deepEqual([812, 12_400, 94_200_000, 4_210_000_000, 26_500_000_000].map(formatTokens), ["812", "12.4K", "94.2M", "4.21B", "26.5B"]);
  assert.equal(formatUsd(18862.64), "$18,862.64");
});

test("the view: headline, chart, providers with accounts, models; no emails; one width throughout", async () => {
  const now = Date.now();
  const records: UsageRecord[] = [
    { at: now - 60_000, provider: "anthropic", model: "claude-opus-5-5", input: 1e6, output: 2e6, cacheRead: 9e8, cacheWrite: 1e7, cost: 400, subagent: false, key: "1" },
    { at: now - 120_000, provider: "anthropic-account-2", model: "claude-sonnet-5-5", input: 1e6, output: 1e6, cacheRead: 3e8, cacheWrite: 1e6, cost: 90, subagent: true, key: "2" },
    { at: now - 86_400_000 * 2, provider: "openai-codex", model: "gpt-5.5", input: 2e6, output: 1e6, cacheRead: 2e8, cacheWrite: 0, cost: 60, subagent: false, key: "3" },
  ];
  let renders = 0;
  const view = new StatsView({ load: async () => records, naming, theme: plainTheme, requestRender: () => renders++, onClose: () => {} });
  await new Promise((resolve) => setImmediate(resolve));
  const lines = view.render(100);
  const text = lines.join("\n");
  assert.match(text, /Pi usage +Last 7 days · /);
  assert.match(text, /1\.42B +98\.9% +\$550\.00/);
  assert.match(text, /tokens +cached +at API prices/);
  assert.match(text, /Anthropic +1\.22B +/);
  assert.match(text, / {2}Account 1 +913M/);
  assert.match(text, /ChatGPT +203M/);
  assert.match(text, /claude-opus-5-5 +913M/);
  assert.match(text, /3 replies · 21\.4% from subagents · API prices in USD/);
  assert.doesNotMatch(text, /@/);
  assert.equal(new Set(lines.map((line) => visibleWidth(line))).size, 1, "every line the same width");

  view.handleInput("\x1b[D"); // ← to Today
  assert.match(view.render(100).join("\n"), /Pi usage +Today · /);
  assert.doesNotMatch(view.render(100).join("\n"), /ChatGPT/, "two days ago isn't today");
});

test("while reading, the view shows progress", () => {
  let progress: (done: number, total: number) => void = () => {};
  const view = new StatsView({ load: (onProgress) => ((progress = onProgress), new Promise(() => {})), naming, theme: plainTheme, requestRender: () => {}, onClose: () => {} });
  progress(1240, 2582);
  assert.match(view.render(90).join("\n"), /Reading sessions… 1,240 of 2,582/);
});

test("sessions are where Pi keeps them", () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-dir-"));
  assert.equal(sessionsDir(dir), join(dir, "sessions"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ sessionDir: "/elsewhere/sessions" }));
  assert.equal(sessionsDir(dir), "/elsewhere/sessions");
  process.env.PI_CODING_AGENT_SESSION_DIR = "/from/env";
  try {
    assert.equal(sessionsDir(dir), "/from/env");
  } finally {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  }
  rmSync(dir, { recursive: true });
});
