import { hasEnv, hasStoredLogin } from "../setup.ts";
import { createSubscriptionAuthStorage, type SubscriptionAuthStorage } from "../auth.ts";
import type {
  SubscriptionProviderDefinition,
  SubscriptionProviderRuntimeState,
  SubscriptionUsageWindowDefinition,
} from "./types.ts";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const OPENROUTER_TIMEOUT_MS = 15_000;

interface OpenRouterKeyResponse {
  data?: {
    byok_usage?: number;
    byok_usage_daily?: number;
    byok_usage_monthly?: number;
    byok_usage_weekly?: number;
    creator_user_id?: string;
    expires_at?: string;
    include_byok_in_limit?: boolean;
    is_free_tier?: boolean;
    is_management_key?: boolean;
    is_provisioning_key?: boolean;
    label?: string;
    limit?: number;
    limit_remaining?: number;
    limit_reset?: string;
    usage?: number;
    usage_daily?: number;
    usage_monthly?: number;
    usage_weekly?: number;
  };
}

interface OpenRouterCreditsResponse {
  data?: {
    total_credits?: number;
    total_usage?: number;
  };
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function safePercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return 0;
  }

  return clampPercent((used / limit) * 100);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function parseDateish(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function nextUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
}

function nextUtcMonday(): Date {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday, 0, 0, 0));
}

function nextUtcMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}

async function fetchOpenRouterJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || response.statusText || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function fetchOpenRouterKeyData(accessToken: string): Promise<OpenRouterKeyResponse> {
  return fetchOpenRouterJson<OpenRouterKeyResponse>(OPENROUTER_KEY_URL, accessToken);
}

async function fetchOpenRouterCreditsData(accessToken: string): Promise<OpenRouterCreditsResponse> {
  return fetchOpenRouterJson<OpenRouterCreditsResponse>(OPENROUTER_CREDITS_URL, accessToken);
}

function buildOpenRouterUsageWindows(
  keyData: NonNullable<OpenRouterKeyResponse["data"]> | undefined,
  creditsData: NonNullable<OpenRouterCreditsResponse["data"]> | undefined,
): SubscriptionUsageWindowDefinition[] {
  const windows: SubscriptionUsageWindowDefinition[] = [];
  const totalCredits = parseNumber(creditsData?.total_credits);
  const totalUsage = parseNumber(creditsData?.total_usage) ?? 0;

  if (totalCredits != null && totalCredits > 0) {
    const remainingCredits = Math.max(0, totalCredits - totalUsage);
    windows.push({
      // The credits pool is not a time-based window. The bar fills in
      // proportion to credits used: 100% = total credits, x% = used so far.
      // No `resetAt` / `pacePercent` is set, so no "now" notch is rendered.
      label: "Credits",
      usedPercent: safePercent(totalUsage, totalCredits),
      statusLabel: `${formatCurrency(remainingCredits)} left`,
      detailLabel: `${formatCurrency(totalUsage)} of ${formatCurrency(totalCredits)} used`,
      notches: [50, 75, 90],
    });
  }

  if (!keyData) {
    return windows;
  }

  const limit = parseNumber(keyData.limit);
  const limitRemaining = parseNumber(keyData.limit_remaining);
  const usageDaily = parseNumber(keyData.usage_daily) ?? 0;
  const usageWeekly = parseNumber(keyData.usage_weekly) ?? 0;
  const usageMonthly = parseNumber(keyData.usage_monthly) ?? parseNumber(keyData.usage) ?? 0;

  if (limit != null && limit > 0) {
    const remaining = limitRemaining ?? Math.max(0, limit - usageMonthly);
    const resetAt = parseDateish(keyData.limit_reset) ?? nextUtcMonthStart();

    windows.push({
      label: "Monthly budget",
      usedPercent: safePercent(usageMonthly, limit),
      detailLabel: `${formatCurrency(usageMonthly)} of ${formatCurrency(limit)} used, ${formatCurrency(remaining)} left`,
      resetAt,
      notches: [50, 75, 90],
    });
  } else if (limitRemaining != null && totalCredits == null) {
    windows.push({
      label: "Key balance",
      statusLabel: `${formatCurrency(limitRemaining)} left`,
      notches: [50, 75, 90],
    });
  }

  const dailyResetAt = nextUtcMidnight();
  windows.push({
    label: "Spent today",
    statusLabel: formatCurrency(usageDaily),
    resetAt: dailyResetAt,
    notches: [50],
  });

  const weeklyResetAt = nextUtcMonday();
  windows.push({
    label: "Spent this week",
    statusLabel: formatCurrency(usageWeekly),
    resetAt: weeklyResetAt,
    notches: [50, 75],
  });

  const monthlyResetAt = nextUtcMonthStart();
  windows.push({
    label: "Spent this month",
    statusLabel: formatCurrency(usageMonthly),
    resetAt: monthlyResetAt,
    notches: [50, 75, 90],
  });

  return windows;
}

export async function loadOpenRouterRuntimeState(
  authStorage: SubscriptionAuthStorage = createSubscriptionAuthStorage(),
): Promise<SubscriptionProviderRuntimeState> {
  const apiKey = await authStorage.getApiKey("openrouter");

  if (!apiKey) {
    return {
      state: "error",
      errorMessage: "Not set up. Run /login and choose OpenRouter, or set OPENROUTER_API_KEY.",
      usageWindows: [],
    };
  }

  try {
    const [keyResult, creditsResult] = await Promise.allSettled([
      fetchOpenRouterKeyData(apiKey),
      fetchOpenRouterCreditsData(apiKey),
    ]);

    const keyData = keyResult.status === "fulfilled" ? keyResult.value.data : undefined;
    const creditsData = creditsResult.status === "fulfilled" ? creditsResult.value.data : undefined;

    if (!keyData && !creditsData) {
      const keyError = keyResult.status === "rejected" ? keyResult.reason : undefined;
      const creditsError = creditsResult.status === "rejected" ? creditsResult.reason : undefined;
      throw keyError instanceof Error
        ? keyError
        : creditsError instanceof Error
          ? creditsError
          : new Error("OpenRouter sent no usage this version can read.");
    }

    return {
      state: "ready",
      account: keyData?.is_free_tier ? { plan: "Free" } : undefined,
      usageWindows: buildOpenRouterUsageWindows(keyData, creditsData),
      lastUpdatedAt: new Date(),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "error",
      errorMessage: `Couldn't load usage: ${message}`,
      usageWindows: [],
    };
  }
}

export const openRouterProvider: SubscriptionProviderDefinition = {
  id: "openrouter",
  label: "OpenRouter",
  shortLabel: "OpenRouter",
  enabledByDefault: true,
  authHint: "Run /login and choose OpenRouter, or set OPENROUTER_API_KEY.",
  // An API key is all OpenRouter needs.
  isSetUp: (stored) => hasStoredLogin(stored, "openrouter") || hasEnv("OPENROUTER_API_KEY"),
  loadRuntimeState: loadOpenRouterRuntimeState,
};
