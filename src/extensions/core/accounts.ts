import type { SubscriptionProviderDefinition } from "./providers/types.ts";

/** One login of a provider, e.g. `anthropic-account-2`. */
export interface SubscriptionAccount {
  /** Pi provider id holding the login. */
  providerId: string;
  /** The id the provider's code is written for, e.g. `anthropic`. */
  sourceId: string;
  /** 1 for the source itself, N for `<source>-account-N`. */
  number: number;
  /** Short name shown in the dialog. */
  label: string;
}

function credentialType(credential: unknown): string | undefined {
  const type = (credential as { type?: unknown } | undefined)?.type;
  return typeof type === "string" ? type : undefined;
}

function accountNumber(providerId: string, source: string): number | undefined {
  if (providerId === source) {
    return 1;
  }
  const match = providerId.match(/^(.+)-account-(\d+)$/);
  const number = match?.[1] === source ? Number(match[2]) : undefined;
  return number !== undefined && Number.isSafeInteger(number) && number >= 2 ? number : undefined;
}

/**
 * Finds every account of a provider from Pi's stored logins.
 *
 * The provider's own id is always listed first (even when not logged in, so the dialog can
 * say so). Numbered `<id>-account-N` logins — created by pi-multi-account or any extension
 * following the same convention — are added in number order. Additional sources (such as
 * `openai` for ChatGPT) only count when they hold a subscription (OAuth) login.
 */
export function discoverAccounts(
  provider: Pick<SubscriptionProviderDefinition, "id" | "accountSources">,
  stored: Record<string, unknown>,
): SubscriptionAccount[] {
  const sources = provider.accountSources?.length ? provider.accountSources : [provider.id];
  const accounts: SubscriptionAccount[] = [];

  sources.forEach((source, sourceIndex) => {
    const primary = sourceIndex === 0;
    const found = Object.keys(stored)
      .map((providerId) => ({ providerId, number: accountNumber(providerId, source) }))
      .filter((entry): entry is { providerId: string; number: number } => entry.number !== undefined)
      .filter((entry) => (primary ? entry.number > 1 : credentialType(stored[entry.providerId]) === "oauth"));

    if (primary) {
      found.push({ providerId: source, number: 1 });
    }

    for (const { providerId, number } of found.sort((a, b) => a.number - b.number)) {
      const label = primary ? `Account ${number}` : number === 1 ? source : `${source} account ${number}`;
      accounts.push({ providerId, sourceId: sources[0]!, number, label });
    }
  });

  return accounts;
}
