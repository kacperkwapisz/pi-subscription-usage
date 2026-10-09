import { createSubscriptionAuthStorage, type SubscriptionAuthStorage } from "../auth.ts";
import type {
  SubscriptionAccountInfo,
  SubscriptionProviderDefinition,
  SubscriptionProviderRuntimeState,
  SubscriptionUsageWindowDefinition,
} from "./types.ts";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const ANTHROPIC_TIMEOUT_MS = 20_000;
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;

interface AnthropicUsageEntry {
  utilization?: number | string;
  resets_at?: string | number;
}

interface AnthropicExtraUsage {
  is_enabled?: boolean;
  monthly_limit?: number | string;
  used_credits?: number | string;
  currency?: string;
  utilization?: number | string;
}

/** Newer response shape: one entry per active limit. */
interface AnthropicLimit {
  kind?: string;
  group?: string;
  percent?: number | string;
  resets_at?: string | number;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

interface AnthropicProfile {
  account?: { uuid?: string; email?: string; has_claude_max?: boolean; has_claude_pro?: boolean };
  organization?: { uuid?: string; organization_type?: string; rate_limit_tier?: string };
}

interface AnthropicUsageResponse {
  limits?: AnthropicLimit[];
  five_hour?: AnthropicUsageEntry;
  seven_day?: AnthropicUsageEntry;
  seven_day_sonnet?: AnthropicUsageEntry;
  seven_day_omelette?: AnthropicUsageEntry;
  seven_day_opus?: AnthropicUsageEntry;
  extra_usage?: AnthropicExtraUsage;
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

function formatPercent(percent: number | undefined): string {
  return `${Math.round(percent ?? 0)}%`;
}

function formatCurrency(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}


function parseDateish(value: unknown): Date | undefined {
  const numeric = parseNumber(value);
  if (numeric != null) {
    const millis = numeric < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  return undefined;
}

function nextUtcMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}

function currentUtcMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
}

function createAnthropicPercentWindow(
  label: string,
  entry: AnthropicUsageEntry | undefined,
  windowSeconds: number,
): SubscriptionUsageWindowDefinition | undefined {
  const usedPercent = clampPercent(parseNumber(entry?.utilization) ?? 0);
  if (!entry || parseNumber(entry.utilization) == null) {
    return undefined;
  }

  const resetAt = parseDateish(entry.resets_at);
  let detailLabel: string | undefined;
  let pacePercent: number | undefined;

  if (resetAt) {
    const remainingSeconds = Math.max(0, Math.round((resetAt.getTime() - Date.now()) / 1000));
    const elapsedSeconds = Math.max(0, windowSeconds - remainingSeconds);
    pacePercent = clampPercent((elapsedSeconds / windowSeconds) * 100);
    detailLabel = `${formatPercent(pacePercent)} of the period has passed`;
  }

  return {
    label,
    usedPercent,
    detailLabel,
    resetAt,
    pacePercent,
    notches: [25, 50, 75],
  };
}

function createAnthropicExtraWindow(extra: AnthropicExtraUsage | undefined): SubscriptionUsageWindowDefinition | undefined {
  if (!extra?.is_enabled) {
    return undefined;
  }

  const monthlyLimitCents = parseNumber(extra.monthly_limit);
  if (monthlyLimitCents == null || monthlyLimitCents <= 0) {
    return undefined;
  }

  const usedCreditsCents = parseNumber(extra.used_credits) ?? 0;
  const currency = typeof extra.currency === "string" && extra.currency.length > 0 ? extra.currency : "USD";
  const limitValue = monthlyLimitCents / 100;
  const usedValue = usedCreditsCents / 100;
  const usedPercent = clampPercent(parseNumber(extra.utilization) ?? safePercent(usedValue, limitValue));
  const resetAt = nextUtcMonthStart();
  const startAt = currentUtcMonthStart();
  const totalSeconds = Math.max(1, Math.round((resetAt.getTime() - startAt.getTime()) / 1000));
  const remainingSeconds = Math.max(0, Math.round((resetAt.getTime() - Date.now()) / 1000));
  const elapsedSeconds = Math.max(0, totalSeconds - remainingSeconds);
  const pacePercent = clampPercent((elapsedSeconds / totalSeconds) * 100);

  return {
    label: `Extra (${currency})`,
    usedPercent,
    detailLabel: [
      `${formatCurrency(usedValue, currency)}/${formatCurrency(limitValue, currency)}`,
      `${formatPercent(pacePercent)} of the period has passed`,
    ].join(" • "),
    resetAt,
    pacePercent,
    notches: [50, 75, 90],
  };
}

export function anthropicAccountInfo(profile: AnthropicProfile): SubscriptionAccountInfo {
  const account = profile.account ?? {};
  const org = profile.organization ?? {};
  const kind = org.organization_type === "claude_team"
    ? "Team"
    : org.organization_type === "claude_enterprise"
      ? "Enterprise"
      : undefined;
  const size = org.rate_limit_tier?.match(/max_(\d+x)/)?.[1];
  const level = size ? `Max ${size}` : account.has_claude_max ? "Max" : account.has_claude_pro ? "Pro" : undefined;
  const plan = [kind, level].filter(Boolean).join(" \u00b7 ") || undefined;
  return {
    email: account.email,
    plan,
    identity: account.uuid ? `anthropic:${account.uuid}:${org.uuid ?? ""}` : undefined,
  };
}

/** Email, plan and identity. Optional: usage is still shown when this fails. */
async function fetchAnthropicProfile(accessToken: string): Promise<AnthropicProfile> {
  try {
    const response = await fetch(ANTHROPIC_PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
      signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
    });
    return response.ok ? ((await response.json()) as AnthropicProfile) : {};
  } catch {
    return {};
  }
}

async function fetchAnthropicUsage(accessToken: string): Promise<AnthropicUsageResponse> {
  const response = await fetch(ANTHROPIC_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || response.statusText || `HTTP ${response.status}`);
  }

  return response.json() as Promise<AnthropicUsageResponse>;
}

function createAnthropicLimitWindow(limit: AnthropicLimit): SubscriptionUsageWindowDefinition | undefined {
  const group = limit.group ?? limit.kind;
  const model = limit.scope?.model?.display_name?.trim();
  const base = group === "session" ? "5h" : group === "weekly" ? "7d" : group ?? "Limit";
  const windowSeconds = group === "session" ? FIVE_HOUR_SECONDS : SEVEN_DAY_SECONDS;
  return createAnthropicPercentWindow(
    model ? `${base} ${model}` : base,
    { utilization: limit.percent, resets_at: limit.resets_at },
    windowSeconds,
  );
}

export function parseAnthropicWindows(response: AnthropicUsageResponse): SubscriptionUsageWindowDefinition[] {
  const windows: SubscriptionUsageWindowDefinition[] = [];

  // Prefer the `limits` list: it is the only place some accounts report their weekly limit.
  const limitWindows = (Array.isArray(response.limits) ? response.limits : [])
    .map(createAnthropicLimitWindow)
    .filter((window): window is SubscriptionUsageWindowDefinition => !!window);
  if (limitWindows.length > 0) {
    windows.push(...limitWindows);
    const extra = createAnthropicExtraWindow(response.extra_usage);
    if (extra) {
      windows.push(extra);
    }
    return windows;
  }

  const baseWindows = [
    createAnthropicPercentWindow("5h", response.five_hour, FIVE_HOUR_SECONDS),
    createAnthropicPercentWindow("7d", response.seven_day, SEVEN_DAY_SECONDS),
    createAnthropicPercentWindow("7d Sonnet", response.seven_day_sonnet, SEVEN_DAY_SECONDS),
    createAnthropicPercentWindow("7d Opus", response.seven_day_omelette, SEVEN_DAY_SECONDS),
    createAnthropicPercentWindow("7d Opus (legacy)", response.seven_day_opus, SEVEN_DAY_SECONDS),
  ].filter((window): window is SubscriptionUsageWindowDefinition => !!window);

  windows.push(...baseWindows);

  const extraWindow = createAnthropicExtraWindow(response.extra_usage);
  if (extraWindow) {
    windows.push(extraWindow);
  }

  return windows;
}

export async function loadAnthropicRuntimeState(
  authStorage: SubscriptionAuthStorage = createSubscriptionAuthStorage(),
): Promise<SubscriptionProviderRuntimeState> {
  const authStatus = authStorage.getAuthStatus("anthropic");
  const accessToken = await authStorage.getApiKey("anthropic");

  if (!accessToken) {
    return {
      state: "error",
      errorMessage: "Not logged in. Run /login and choose Anthropic (Claude Pro/Max).",
      usageWindows: [],
    };
  }

  try {
    const [response, profile] = await Promise.all([
      fetchAnthropicUsage(accessToken),
      fetchAnthropicProfile(accessToken),
    ]);
    const usageWindows = parseAnthropicWindows(response);

    if (usageWindows.length === 0) {
      return {
        state: "error",
        errorMessage: "Claude sent usage in a format this version can't read.",
        usageWindows: [],
      };
    }

    return {
      state: "ready",
      account: anthropicAccountInfo(profile),
      usageWindows,
      lastUpdatedAt: new Date(),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const invalidBearer = message.includes("Invalid bearer token");
    const apiKeyMismatch = invalidBearer && authStatus.source === "environment" && authStatus.label === "ANTHROPIC_API_KEY";

    return {
      state: "error",
      errorMessage: apiKeyMismatch
        ? "This is an API key (ANTHROPIC_API_KEY), which has no usage limits to show. Run /login and choose Anthropic (Claude Pro/Max)."
        : `Couldn't load usage: ${message}`,
      usageWindows: [],
    };
  }
}

export const anthropicProvider: SubscriptionProviderDefinition = {
  id: "anthropic",
  label: "Anthropic",
  shortLabel: "Anthropic",
  enabledByDefault: true,
  authHint: "Run /login and choose Anthropic (Claude Pro/Max). An API key has no usage limits to show.",
  statusPage: "status.claude.com",
  loadRuntimeState: loadAnthropicRuntimeState,
};
