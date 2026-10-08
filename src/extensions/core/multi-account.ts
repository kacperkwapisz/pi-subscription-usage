import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Optional link to pi-multi-account over Pi's `pi.events` bus. Neither package imports the
 * other: when pi-multi-account is loaded it answers this request immediately, and the usage
 * view offers switching accounts; otherwise nothing answers and the view stays read-only.
 */
export const MULTI_ACCOUNT_CHANNEL = "pi-multi-account:connect";

export interface MultiAccountApi {
  readonly version: number;
  /** Switches the session to an account (Pi provider id); resolves to whether it happened. */
  useAccount(providerId: string, ctx: ExtensionContext): Promise<boolean>;
}

interface EventBusLike {
  emit(channel: string, data: unknown): void;
}

export function connectMultiAccount(events: EventBusLike): MultiAccountApi | undefined {
  let api: MultiAccountApi | undefined;
  events.emit(MULTI_ACCOUNT_CHANNEL, {
    reply: (reply: unknown) => {
      const candidate = reply as Partial<MultiAccountApi> | undefined;
      if (candidate?.version === 1 && typeof candidate.useAccount === "function") {
        api = candidate as MultiAccountApi;
      }
    },
  });
  return api;
}
