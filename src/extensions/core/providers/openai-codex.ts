import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSubscriptionAuthStorage, type SubscriptionAuthStorage } from "../auth.ts";
import { openAiClaim } from "../jwt.ts";
import type {
  SubscriptionAccountInfo,
  SubscriptionProviderDefinition,
  SubscriptionProviderRuntimeState,
  SubscriptionUsageWindowDefinition,
} from "./types.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_TIMEOUT_MS = 20_000;

interface CodexUsageLimitWindow {
  used_percent?: number;
  percent_left?: number;
  remaining_percent?: number;
  reset_at?: number | string;
  reset_time_ms?: number | string;
  reset_after_seconds?: number | string;
  limit_window_seconds?: number | string;
}

interface CodexUsageArrayLimit {
  type?: string;
  unit?: number | string;
  percentage?: number | string;
  nextResetTime?: number | string;
}

interface CodexUsageResponse {
  user_id?: string;
  account_id?: string;
  plan_type?: string;
  email?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: CodexUsageLimitWindow;
    secondary_window?: CodexUsageLimitWindow;
    primary?: CodexUsageLimitWindow;
    secondary?: CodexUsageLimitWindow;
    five_hour_limit?: CodexUsageLimitWindow;
    weekly_limit?: CodexUsageLimitWindow;
    five_hour?: CodexUsageLimitWindow;
    weekly?: CodexUsageLimitWindow;
  };
  rate_limits?: {
    primary_window?: CodexUsageLimitWindow;
    secondary_window?: CodexUsageLimitWindow;
    primary?: CodexUsageLimitWindow;
    secondary?: CodexUsageLimitWindow;
    five_hour_limit?: CodexUsageLimitWindow;
    weekly_limit?: CodexUsageLimitWindow;
    five_hour?: CodexUsageLimitWindow;
    weekly?: CodexUsageLimitWindow;
  };
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    overage_limit_reached?: boolean;
    balance?: number | string;
    approx_local_messages?: number | string | Array<number | string>;
    approx_cloud_messages?: number | string | Array<number | string>;
  };
  spend_control?: {
    reached?: boolean;
    individual_limit?: number | string | null;
  };
  data?: {
    limits?: CodexUsageArrayLimit[];
    level?: string;
  };
  rate_limit_reset_credits?: {
    available_count?: number | string;
  };
}

interface AccountResolution {
  accountId?: string;
}

type CodexWindowKind = "session" | "weekly";

interface CodexWindowParseResult {
  sessionWindow?: SubscriptionUsageWindowDefinition;
  weeklyWindow?: SubscriptionUsageWindowDefinition;
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

function usedPercentFromLimit(limit: CodexUsageLimitWindow | CodexUsageArrayLimit | undefined): number | undefined {
  const percentLeft = parseNumber((limit as CodexUsageLimitWindow | undefined)?.percent_left);
  if (percentLeft != null) {
    return clampPercent(100 - percentLeft);
  }

  const remainingPercent = parseNumber((limit as CodexUsageLimitWindow | undefined)?.remaining_percent);
  if (remainingPercent != null) {
    return clampPercent(100 - remainingPercent);
  }

  const usedPercent = parseNumber((limit as CodexUsageLimitWindow | undefined)?.used_percent);
  if (usedPercent != null) {
    return clampPercent(usedPercent);
  }

  const percentage = parseNumber((limit as CodexUsageArrayLimit | undefined)?.percentage);
  if (percentage != null) {
    return clampPercent(percentage);
  }

  return undefined;
}

function formatPercent(percent: number | undefined): string {
  return `${Math.round(percent ?? 0)}%`;
}

function windowKindLabel(kind: CodexWindowKind): string {
  return kind === "session" ? "Session" : "Weekly";
}

function fallbackSecondsForWindowKind(kind: CodexWindowKind): number {
  return kind === "session" ? 5 * 60 * 60 : 7 * 24 * 60 * 60;
}

const CHATGPT_PLAN_NAMES: Record<string, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

function codexAccountInfo(response: { plan_type?: string; email?: string }, accessToken: string): SubscriptionAccountInfo {
  const auth = openAiClaim(accessToken, "auth");
  const profile = openAiClaim(accessToken, "profile");
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const planType = text(response.plan_type) ?? text(auth.chatgpt_plan_type);
  const userId = text(auth.chatgpt_account_user_id)
    ?? (text(auth.chatgpt_user_id) && text(auth.chatgpt_account_id)
      ? `${text(auth.chatgpt_user_id)}:${text(auth.chatgpt_account_id)}`
      : undefined);
  return {
    email: text(response.email) ?? text(profile.email),
    plan: planType ? (CHATGPT_PLAN_NAMES[planType] ?? planType) : undefined,
    identity: userId ? `chatgpt:${userId}` : undefined,
  };
}

function resolveCodexAccountId(authStorage: SubscriptionAuthStorage, accessToken?: string): AccountResolution {
  const credential = authStorage.get("openai-codex") as Record<string, unknown> | undefined;
  const storedAccountId =
    typeof credential?.accountId === "string"
      ? credential.accountId
      : typeof credential?.account_id === "string"
        ? credential.account_id
        : undefined;

  if (storedAccountId) {
    return {
      accountId: storedAccountId,
    };
  }

  // The token names its own account. Checked before ~/.codex, which belongs to the Codex CLI's
  // login and would pair this token with another account's id.
  const tokenAccountId = openAiClaim(accessToken, "auth").chatgpt_account_id;
  if (typeof tokenAccountId === "string" && tokenAccountId) {
    return {
      accountId: tokenAccountId,
    };
  }

  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as {
      tokens?: { account_id?: string; accountId?: string };
    };
    const fallbackAccountId = parsed.tokens?.account_id ?? parsed.tokens?.accountId;
    if (fallbackAccountId) {
      return {
        accountId: fallbackAccountId,
      };
    }
  } catch {
    // ignore fallback read errors
  }

  return {};
}

function parseResetAt(limit: CodexUsageLimitWindow | CodexUsageArrayLimit | undefined): Date | undefined {
  const resetAtValue =
    (limit as CodexUsageLimitWindow | undefined)?.reset_at ??
    (limit as CodexUsageLimitWindow | undefined)?.reset_time_ms ??
    (limit as CodexUsageArrayLimit | undefined)?.nextResetTime;
  const numericReset = parseNumber(resetAtValue);

  if (numericReset != null) {
    const millis = numericReset < 1e12 ? numericReset * 1000 : numericReset;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  if (typeof resetAtValue === "string") {
    const date = new Date(resetAtValue);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  const resetAfterSeconds = parseNumber((limit as CodexUsageLimitWindow | undefined)?.reset_after_seconds);
  if (resetAfterSeconds != null) {
    return new Date(Date.now() + resetAfterSeconds * 1000);
  }

  return undefined;
}

function parseWindowSeconds(limit: CodexUsageLimitWindow | CodexUsageArrayLimit | undefined, fallbackSeconds: number): number {
  return Math.max(1, parseNumber((limit as CodexUsageLimitWindow | undefined)?.limit_window_seconds) ?? fallbackSeconds);
}

/** Names a window by its real length, e.g. a 30-day window is "Monthly", not "Weekly". */
export function labelForWindowSeconds(seconds: number, fallback: string): string {
  const day = 24 * 60 * 60;
  if (seconds <= 8 * 60 * 60) return "Session";
  if (seconds >= 6 * day && seconds <= 8 * day) return "Weekly";
  if (seconds >= 28 * day && seconds <= 31 * day) return "Monthly";
  if (seconds >= day) return `${Math.round(seconds / day)}-day`;
  return fallback;
}

function createCodexWindow(
  label: string,
  limit: CodexUsageLimitWindow | CodexUsageArrayLimit | undefined,
  fallbackSeconds: number,
): SubscriptionUsageWindowDefinition | undefined {
  const usedPercent = usedPercentFromLimit(limit);
  if (usedPercent == null) {
    return undefined;
  }

  const resetAt = parseResetAt(limit);
  const windowSeconds = parseWindowSeconds(limit, fallbackSeconds);
  let detailLabel: string | undefined;
  let pacePercent: number | undefined;

  if (resetAt) {
    const remainingSeconds = Math.max(0, Math.round((resetAt.getTime() - Date.now()) / 1000));
    const elapsedSeconds = Math.max(0, windowSeconds - remainingSeconds);
    pacePercent = clampPercent((elapsedSeconds / windowSeconds) * 100);
    detailLabel = `${formatPercent(pacePercent)} of the period has passed`;
  }

  const reportedSeconds = parseNumber((limit as CodexUsageLimitWindow | undefined)?.limit_window_seconds);
  return {
    label: reportedSeconds != null ? labelForWindowSeconds(reportedSeconds, label) : label,
    usedPercent,
    detailLabel,
    resetAt,
    pacePercent,
  };
}

function inferCodexWindowKind(
  limit: CodexUsageLimitWindow | CodexUsageArrayLimit | undefined,
  fallbackKind: CodexWindowKind,
): CodexWindowKind {
  const unit = String((limit as CodexUsageArrayLimit | undefined)?.unit ?? "");
  if (unit === "3") {
    return "session";
  }
  if (unit === "6") {
    return "weekly";
  }
  const windowSeconds = parseNumber((limit as CodexUsageLimitWindow | undefined)?.limit_window_seconds);
  if (windowSeconds != null) {
    if (windowSeconds <= 8 * 60 * 60) {
      return "session";
    }
    if (windowSeconds >= 6 * 24 * 60 * 60) {
      return "weekly";
    }
  }
  return fallbackKind;
}

function parseCodexLimitsArray(limits: unknown): CodexWindowParseResult {
  if (!Array.isArray(limits) || limits.length === 0) {
    return {};
  }

  const normalized = limits
    .map((limit) => (limit && typeof limit === "object" ? limit as CodexUsageArrayLimit : undefined))
    .filter((limit): limit is CodexUsageArrayLimit => !!limit);

  const sessionCandidate = normalized.find((limit) => String(limit.unit) === "3") ?? normalized[0];
  const weeklyCandidate = normalized.find((limit) => String(limit.unit) === "6") ?? normalized[1];

  return {
    sessionWindow: createCodexWindow("Session", sessionCandidate, 5 * 60 * 60),
    weeklyWindow: createCodexWindow("Weekly", weeklyCandidate, 7 * 24 * 60 * 60),
  };
}

function parseCodexUsageWindows(response: CodexUsageResponse): CodexWindowParseResult {
  const rateLimit = response.rate_limit ?? response.rate_limits ?? {};
  const resolvedWindows: Partial<Record<CodexWindowKind, SubscriptionUsageWindowDefinition>> = {};
  const candidates = [
    {
      fallbackKind: "session" as const,
      limit: rateLimit.primary_window ?? rateLimit.primary ?? rateLimit.five_hour_limit ?? rateLimit.five_hour,
    },
    {
      fallbackKind: "weekly" as const,
      limit: rateLimit.secondary_window ?? rateLimit.secondary ?? rateLimit.weekly_limit ?? rateLimit.weekly,
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.limit) {
      continue;
    }

    let targetKind = inferCodexWindowKind(candidate.limit, candidate.fallbackKind);
    if (resolvedWindows[targetKind]) {
      if (resolvedWindows[candidate.fallbackKind]) {
        continue; // a duplicate of a window already shown
      }
      targetKind = candidate.fallbackKind;
    }

    const window = createCodexWindow(
      windowKindLabel(targetKind),
      candidate.limit,
      fallbackSecondsForWindowKind(targetKind),
    );

    if (window) {
      resolvedWindows[targetKind] = window;
    }
  }

  if (resolvedWindows.session || resolvedWindows.weekly) {
    return {
      sessionWindow: resolvedWindows.session,
      weeklyWindow: resolvedWindows.weekly,
    };
  }

  return parseCodexLimitsArray(response.data?.limits);
}

async function fetchCodexUsage(accessToken: string, accountId: string): Promise<CodexUsageResponse> {
  const response = await fetch(CODEX_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
      "User-Agent": "Mozilla/5.0",
    },
    signal: AbortSignal.timeout(CODEX_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || response.statusText || `HTTP ${response.status}`);
  }

  return response.json() as Promise<CodexUsageResponse>;
}

export async function loadOpenAiCodexRuntimeState(
  authStorage: SubscriptionAuthStorage = createSubscriptionAuthStorage(),
): Promise<SubscriptionProviderRuntimeState> {
  const accessToken = await authStorage.getApiKey("openai-codex");
  const accountResolution = resolveCodexAccountId(authStorage, accessToken);

  if (!accessToken) {
    return {
      state: "error",
      errorMessage: "Not logged in. Run /login and choose OpenAI (ChatGPT subscription).",
      usageWindows: [],
    };
  }

  if (!accountResolution.accountId) {
    return {
      state: "error",
      errorMessage: "Couldn't tell which ChatGPT account this login belongs to. Run /login again.",
      usageWindows: [],
    };
  }

  try {
    const response = await fetchCodexUsage(accessToken, accountResolution.accountId);
    const { sessionWindow, weeklyWindow } = parseCodexUsageWindows(response);
    const usageWindows = [sessionWindow, weeklyWindow].filter(
      (window): window is SubscriptionUsageWindowDefinition => !!window,
    );

    if (usageWindows.length === 0) {
      return {
        state: "error",
        errorMessage: "ChatGPT sent usage in a format this version can't read.",
        usageWindows: [],
      };
    }

    return {
      state: "ready",
      account: codexAccountInfo(response, accessToken),
      usageWindows,
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

export const openAiCodexProvider: SubscriptionProviderDefinition = {
  id: "openai-codex",
  // Pi 1.x "Sign in with ChatGPT" logins live on the openai provider; same usage endpoint.
  accountSources: ["openai-codex", "openai"],
  label: "ChatGPT",
  shortLabel: "ChatGPT",
  enabledByDefault: true,
  authHint: "Run /login and choose OpenAI (ChatGPT subscription).",
  statusPage: "status.openai.com",
  loadRuntimeState: loadOpenAiCodexRuntimeState,
};
