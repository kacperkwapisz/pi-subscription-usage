import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubscriptionAccount } from "../src/extensions/core/accounts.ts";
import type { SubscriptionProviderDefinition, SubscriptionProviderRuntimeState } from "../src/extensions/core/providers/types.ts";
import { SubscriptionsDialog } from "../src/extensions/core/ui/subscriptions-dialog.ts";

const plainTheme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;
const hour = 3_600_000;

const provider = (id: "anthropic" | "xai", label: string): SubscriptionProviderDefinition => ({
  id,
  label,
  shortLabel: label,
  enabledByDefault: true,
  implementationStatus: "implemented",
  description: "",
  authHint: "",
  usageHint: "",
  stability: "mixed",
  notes: [],
  usageWindows: [],
  loadRuntimeState: async () => ({ state: "ready" }),
});
const account = (providerId: string, number: number): SubscriptionAccount => ({
  providerId,
  sourceId: "anthropic",
  number,
  label: `Account ${number}`,
});
const ready = (email: string, identity: string, used: number): SubscriptionProviderRuntimeState => ({
  state: "ready",
  account: { email, plan: "Team · Max 5x", identity },
  usageWindows: [
    { label: "5h", usedPercent: used, resetAt: new Date(Date.now() + 2 * hour) },
    { label: "7d Fable", usedPercent: 0, resetAt: new Date(Date.now() + 30 * hour) },
  ],
});

async function openDialog(options: {
  displayMode: "used" | "remaining";
  accounts: SubscriptionAccount[];
  onUseAccount?: (account: SubscriptionAccount) => void;
}) {
  const states: Record<string, SubscriptionProviderRuntimeState> = {
    anthropic: ready("kacper@example.com", "anthropic:a", 27),
    "anthropic-account-2": ready("kacper@example.com", "anthropic:a", 27),
    "anthropic-account-3": ready("nadia@example.com", "anthropic:b", 2),
  };
  let pending = options.accounts.length;
  let settled!: () => void;
  const done = new Promise<void>((resolve) => (settled = resolve));
  const dialog = new SubscriptionsDialog({
    providers: [provider("anthropic", "Anthropic"), provider("xai", "xAI")],
    loadAccounts: (p) => (p.id === "anthropic" ? options.accounts : [account("xai", 1)]),
    loadAccountState: async (_p, a) => states[a.providerId]!,
    currentProviderId: "anthropic",
    onUseAccount: options.onUseAccount,
    displayMode: options.displayMode,
    resetTimeDisplayMode: "relative",
    showThresholdNotches: false,
    showNowNotch: false,
    theme: plainTheme,
    onClose: () => {},
    onOpenSettings: () => {},
    requestRender: () => {
      if (--pending === 0) settled();
    },
  });
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  dialog.dispose();
  return dialog;
}

test("several accounts: one section each, with who they are, usage on one line, and duplicates flagged", async () => {
  const dialog = await openDialog({
    displayMode: "remaining",
    accounts: [account("anthropic", 1), account("anthropic-account-2", 2), account("anthropic-account-3", 3)],
  });
  const width = 100;
  const lines = dialog.render(width);
  const text = lines.join("\n");

  assert.ok(lines.every((line) => visibleWidth(line) <= width), "fits the terminal");
  assert.match(text, / Anthropic \(3\) /, "tab shows the account count");
  assert.match(text, /● Account 1 · kacper@example\.com · Team · Max 5x +in use/);
  assert.match(text, /Account 2 · kacper@example\.com · Team · Max 5x +same account as Account 1/);
  assert.match(text, /Account 3 · nadia@example\.com/);
  assert.match(text, /5h +\S+ +73% left · Resets in 0[12]h \d\dm/);
  assert.match(text, /7d Fable +\S+ +100% left/);
});

test("used/remaining is a display setting", async () => {
  const dialog = await openDialog({ displayMode: "used", accounts: [account("anthropic", 1), account("anthropic-account-3", 3)] });
  const text = dialog.render(100).join("\n");
  assert.match(text, /5h +\S+ +27% used/);
  assert.doesNotMatch(text, /% left/);
});

test("a single account keeps the original full layout", async () => {
  const dialog = await openDialog({ displayMode: "used", accounts: [account("anthropic", 1)] });
  const text = dialog.render(100).join("\n");
  assert.match(text, / Anthropic  /, "no account count on the tab");
  assert.match(text, /kacper@example\.com · Team · Max 5x/);
  assert.doesNotMatch(text, /Account 1/);
});

test("with pi-multi-account, arrows pick an account and Enter switches to it", async () => {
  const used: string[] = [];
  const accounts = [account("anthropic", 1), account("anthropic-account-2", 2), account("anthropic-account-3", 3)];
  const dialog = await openDialog({ displayMode: "remaining", accounts, onUseAccount: (a) => used.push(a.providerId) });

  let text = dialog.render(100).join("\n");
  assert.match(text, />● Account 1 · kacper@example\.com/, "starts on the account in use");
  assert.match(text, /↑↓ select • Enter use account/);

  dialog.handleInput("\x1b[B");
  dialog.handleInput("\x1b[B");
  text = dialog.render(100).join("\n");
  assert.match(text, />  Account 3 · nadia@example\.com/);
  dialog.handleInput("\r");
  dialog.handleInput("\x1b[A");
  dialog.handleInput("\r");
  assert.deepEqual(used, ["anthropic-account-3", "anthropic-account-2"]);
});

test("without pi-multi-account the view stays read-only", async () => {
  const accounts = [account("anthropic", 1), account("anthropic-account-3", 3)];
  const dialog = await openDialog({ displayMode: "remaining", accounts });
  dialog.handleInput("\x1b[B");
  dialog.handleInput("\r");
  const text = dialog.render(100).join("\n");
  assert.doesNotMatch(text, /Enter use account/);
  assert.doesNotMatch(text, /^.{3}>/m, "no selection pointer");
});

