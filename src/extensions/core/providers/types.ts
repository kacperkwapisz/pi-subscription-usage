import type { SubscriptionAuthStorage } from "../auth.ts";

export type SubscriptionProviderId =
  | "openai-codex"
  | "github-copilot"
  | "anthropic"
  | "openrouter"
  | "kilocode"
  | "kimi-coding"
  | "opencode"
  | "xai";

export type SubscriptionProviderStability = "official" | "unofficial" | "mixed" | "unknown";
export type SubscriptionProviderImplementationStatus = "scaffold" | "implemented";
export type SubscriptionProviderRuntimeLoadState = "loading" | "ready" | "error";

export interface SubscriptionUsageWindowDefinition {
  label: string;
  usedPercent?: number;
  statusLabel?: string;
  detailLabel?: string;
  resetAt?: Date;
  notches?: number[];
  pacePercent?: number;
}

/** Who an account is, when the provider reports it. */
export interface SubscriptionAccountInfo {
  email?: string;
  /** Human-readable plan, e.g. "Team \u00b7 Max 5x" or "Pro". */
  plan?: string;
  /** Stable identity used to spot the same account logged in twice. */
  identity?: string;
}

export interface SubscriptionProviderRuntimeState {
  state: SubscriptionProviderRuntimeLoadState;
  account?: SubscriptionAccountInfo;
  /** The login works, but there is no subscription behind it to show; the tab is dropped. */
  noSubscription?: boolean;
  implementationStatus?: SubscriptionProviderImplementationStatus;
  statusLine?: string;
  description?: string;
  authHint?: string;
  usageHint?: string;
  notes?: string[];
  usageWindows?: SubscriptionUsageWindowDefinition[];
  errorMessage?: string;
  lastUpdatedAt?: Date;
}

export interface SubscriptionProviderDefinition {
  id: SubscriptionProviderId;
  label: string;
  shortLabel: string;
  enabledByDefault: boolean;
  implementationStatus: SubscriptionProviderImplementationStatus;
  description: string;
  authHint: string;
  usageHint: string;
  stability: SubscriptionProviderStability;
  notes: string[];
  usageWindows: SubscriptionUsageWindowDefinition[];
  /**
   * Pi provider ids whose logins are accounts of this provider. The first is the provider's
   * own id; numbered extra accounts (`<id>-account-N`) are found for every entry.
   * Defaults to `[id]`.
   */
  accountSources?: readonly string[];
  /**
   * Whether the user has what this provider needs, from Pi's stored logins (and anything else
   * the provider reads). Tabs only appear for providers that are set up. Defaults to a
   * subscription (OAuth) login for the provider or one of its accounts.
   */
  isSetUp?: (stored: Record<string, unknown>) => boolean;
  /** Loads one account. Without `auth`, the provider's own Pi login is used. */
  loadRuntimeState?: (auth?: SubscriptionAuthStorage) => Promise<SubscriptionProviderRuntimeState>;
}
