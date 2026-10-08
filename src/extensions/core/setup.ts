import { accountNumber } from "./accounts.ts";
import type { SubscriptionProviderDefinition } from "./providers/types.ts";

function credentialType(credential: unknown): string | undefined {
  const type = (credential as { type?: unknown } | undefined)?.type;
  return typeof type === "string" ? type : undefined;
}

/** A subscription (OAuth) login in Pi for the provider or any of its accounts. */
export function hasSubscriptionLogin(
  provider: Pick<SubscriptionProviderDefinition, "id" | "accountSources">,
  stored: Record<string, unknown>,
): boolean {
  const sources = provider.accountSources?.length ? provider.accountSources : [provider.id];
  return Object.entries(stored).some(
    ([providerId, credential]) =>
      credentialType(credential) === "oauth" && sources.some((source) => accountNumber(providerId, source) !== undefined),
  );
}

/** A stored Pi login of any kind (subscription or API key) under one of these ids. */
export function hasStoredLogin(stored: Record<string, unknown>, ...providerIds: string[]): boolean {
  return providerIds.some((id) => credentialType(stored[id]) !== undefined);
}

/** A non-empty value in one of these environment variables. */
export function hasEnv(...names: string[]): boolean {
  return names.some((name) => (process.env[name]?.trim() ?? "") !== "");
}

/**
 * Whether the user has what a provider's usage view needs. Providers say so themselves when
 * an API key or another app's login is enough; otherwise a subscription login is required.
 */
export function isProviderSetUp(provider: SubscriptionProviderDefinition, stored: Record<string, unknown>): boolean {
  return provider.isSetUp ? provider.isSetUp(stored) : hasSubscriptionLogin(provider, stored);
}
