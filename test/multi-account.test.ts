import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { connectMultiAccount, MULTI_ACCOUNT_CHANNEL } from "../src/extensions/core/multi-account.ts";

test("no pi-multi-account: nothing answers and switching is not offered", () => {
  assert.equal(connectMultiAccount(createEventBus()), undefined);
});

test("pi-multi-account answers immediately with its API", async () => {
  const events = createEventBus();
  const used: string[] = [];
  events.on(MULTI_ACCOUNT_CHANNEL, (request) => {
    (request as { reply: (api: unknown) => void }).reply({
      version: 1,
      useAccount: async (providerId: string) => (used.push(providerId), true),
    });
  });
  const api = connectMultiAccount(events);
  assert.equal(await api?.useAccount("anthropic-account-2", {} as never), true);
  assert.deepEqual(used, ["anthropic-account-2"]);
});

test("an answer in a format this version does not know is ignored", () => {
  for (const reply of [{ version: 2, useAccount: async () => true }, { version: 1 }, undefined]) {
    const events = createEventBus();
    events.on(MULTI_ACCOUNT_CHANNEL, (request) => (request as { reply: (api: unknown) => void }).reply(reply));
    assert.equal(connectMultiAccount(events), undefined);
  }
});
