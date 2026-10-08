import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasStoredLogin } from "../setup.ts";
import { createSubscriptionAuthStorage, type SubscriptionAuthStorage } from "../auth.ts";
import type {
  SubscriptionProviderDefinition,
  SubscriptionProviderRuntimeState,
  SubscriptionUsageWindowDefinition,
} from "./types.ts";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_CONSOLE_URL = "https://opencode.ai/";
const REQUEST_TIMEOUT_MS = 15_000;
const OPENCODE_AUTH_RELATIVE_PATH = join(".local", "share", "opencode", "auth.json");

/** Unofficial console billing page. 1e8 units = $1 for balance and monthlyUsage. */
const ZEN_BILLING_UNITS_PER_DOLLAR = 100_000_000;

/**
 * Official documented OpenCode Go spend limits.
 * @see https://opencode.ai/docs/go/
 */
const GO_WINDOW_LIMITS_USD = {
  rolling: 12,
  weekly: 30,
  monthly: 60,
} as const;

const GO_WINDOW_META = [
  { key: "rolling", label: "5h", limitUsd: GO_WINDOW_LIMITS_USD.rolling },
  { key: "weekly", label: "Weekly", limitUsd: GO_WINDOW_LIMITS_USD.weekly },
  { key: "monthly", label: "Monthly", limitUsd: GO_WINDOW_LIMITS_USD.monthly },
] as const;

const GO_API_KEY_ENV = ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"] as const;
const ZEN_COOKIE_ENV = ["OPENCODE_AUTH_COOKIE", "OPENCODE_ZEN_COOKIE", "OPENCODE_COOKIE"] as const;
const ZEN_WORKSPACE_ENV = ["OPENCODE_WORKSPACE_ID", "OPENCODE_ZEN_WORKSPACE_ID"] as const;

interface OpenCodeResolvedAuth {
  goApiKey?: string;
  zenApiKey?: string;
  authCookie?: string;
  workspaceId?: string;
}

interface GoUsageWindowPayload {
  status?: unknown;
  percent?: unknown;
  resetsAt?: unknown;
}

interface GoUsageResponse {
  usage?: {
    rolling?: GoUsageWindowPayload;
    weekly?: GoUsageWindowPayload;
    monthly?: GoUsageWindowPayload;
  };
}

interface GoUsageResult {
  windows: SubscriptionUsageWindowDefinition[];
  weeklyRemainingLabel?: string;
  note: string;
}

interface ZenCredits {
  balanceUsd: number;
  usedUsd?: number;
  monthlyLimitUsd?: number;
}

interface ZenUsageResult {
  window: SubscriptionUsageWindowDefinition;
  remainingLabel: string;
  note: string;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function safePercent(used: number, limit: number): number | undefined {
  if (limit <= 0) {
    return undefined;
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

function formatRemainingPercent(usedPercent: number): string {
  const remaining = 100 - usedPercent;
  return `${remaining.toFixed(remaining % 1 === 0 ? 0 : 1)}% left`;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function firstEnv(names: readonly string[]): { value: string; name: string } | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return { value, name };
    }
  }
  return undefined;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractApiKey(credential: unknown): string | undefined {
  const record = asRecord(credential);
  if (!record) {
    return undefined;
  }
  if (typeof record.key === "string" && record.key.trim().length > 0) {
    return record.key.trim();
  }
  if (typeof record.apiKey === "string" && record.apiKey.trim().length > 0) {
    return record.apiKey.trim();
  }
  return undefined;
}

function readOpenCodeAuthFile(): Record<string, unknown> | undefined {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const candidates = [
    xdg ? join(xdg, "opencode", "auth.json") : undefined,
    join(homedir(), OPENCODE_AUTH_RELATIVE_PATH),
  ].filter((path): path is string => Boolean(path));

  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }
    const parsed = asRecord(readJsonFile(path));
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function resolveOpenCodeAuth(): OpenCodeResolvedAuth {
  const resolved: OpenCodeResolvedAuth = {};
  const localAuth = readOpenCodeAuthFile();
  const localGoKey = extractApiKey(localAuth?.["opencode-go"]);
  const localZenKey = extractApiKey(localAuth?.opencode);

  const goEnv = firstEnv(GO_API_KEY_ENV);
  if (goEnv) {
    resolved.goApiKey = goEnv.value;
  } else if (localGoKey) {
    resolved.goApiKey = localGoKey;
  } else if (localZenKey) {
    resolved.goApiKey = localZenKey;
  }

  if (localZenKey) {
    resolved.zenApiKey = localZenKey;
  }

  const cookie = firstEnv(ZEN_COOKIE_ENV);
  if (cookie) {
    resolved.authCookie = cookie.value;
  }

  const workspace = firstEnv(ZEN_WORKSPACE_ENV);
  if (workspace) {
    resolved.workspaceId = workspace.value;
  }

  return resolved;
}

async function attachPiOpenCodeKey(
  resolved: OpenCodeResolvedAuth,
  auth: SubscriptionAuthStorage,
): Promise<void> {
  // Pi's own OpenCode Go login holds exactly the key Go usage needs.
  if (!resolved.goApiKey) {
    const goKey = (await auth.getApiKey("opencode-go", { includeFallback: false }))?.trim();
    if (goKey) {
      resolved.goApiKey = goKey;
    }
  }

  const piKey = (await auth.getApiKey("opencode", { includeFallback: true }))?.trim();
  if (!piKey) {
    return;
  }
  if (!resolved.goApiKey) {
    resolved.goApiKey = piKey;
  }
  if (!resolved.zenApiKey) {
    resolved.zenApiKey = piKey;
  }
}

function cookieHeader(rawCookie: string): string {
  const trimmed = rawCookie.trim();
  if (/^auth\s*=/i.test(trimmed) || trimmed.includes("=")) {
    return trimmed;
  }
  return `auth=${trimmed}`;
}

function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

function sanitizeError(error: unknown, secrets: Array<string | undefined>): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "OpenCode didn't answer in time.";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return redactSecrets(error.message.replace(/\s+/g, " ").trim(), secrets);
  }
  return "OpenCode request failed.";
}

async function fetchText(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; finalUrl: string }> {
  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "follow",
  });
  return {
    status: response.status,
    body: await response.text(),
    finalUrl: response.url,
  };
}

function parseGoUsageWindow(
  payload: GoUsageWindowPayload | undefined,
  label: string,
  limitUsd: number,
): SubscriptionUsageWindowDefinition | undefined {
  const usedPercent = parseNumber(payload?.percent);
  if (usedPercent === undefined) {
    return undefined;
  }

  const clamped = clampPercent(usedPercent);
  const usedUsd = (limitUsd * clamped) / 100;
  const remainingUsd = Math.max(0, limitUsd - usedUsd);
  const rateLimited = payload?.status === "rate-limited";

  return {
    label,
    usedPercent: clamped,
    resetAt: parseDate(payload?.resetsAt),
    statusLabel: rateLimited ? "limit reached" : `${formatCurrency(remainingUsd)} left`,
    detailLabel: `${formatCurrency(usedUsd)}/${formatCurrency(limitUsd)} · ${formatRemainingPercent(clamped)}`,
    notches: [50, 75, 90],
  };
}

async function loadGoUsage(apiKey: string): Promise<GoUsageResult> {
  const { status, body } = await fetchText(OPENCODE_GO_USAGE_URL, {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": "pi-subscription-usage",
  });

  if (status === 401 || status === 403) {
    let detail = body.replace(/\s+/g, " ").trim().slice(0, 240);
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
      const message = parsed.error?.message ?? parsed.message;
      if (typeof message === "string" && message.trim().length > 0) {
        detail = message.trim();
      }
    } catch {
      // keep raw body snippet
    }
    if (status === 403 && /subscription required|entitlement/i.test(detail)) {
      throw new Error(detail || "OpenCode Go subscription required.");
    }
    throw new Error(detail ? `Go usage request failed (HTTP ${status}): ${detail}` : `Go usage request failed (HTTP ${status}).`);
  }

  if (status < 200 || status >= 300) {
    throw new Error(`Go usage request failed (HTTP ${status}).`);
  }

  const parsed = JSON.parse(body) as GoUsageResponse;
  const usage = parsed.usage;
  if (!usage || typeof usage !== "object") {
    throw new Error("OpenCode sent Go usage in a format this version can't read.");
  }

  const windows: SubscriptionUsageWindowDefinition[] = [];
  for (const meta of GO_WINDOW_META) {
    const window = parseGoUsageWindow(usage[meta.key], meta.label, meta.limitUsd);
    if (window) {
      windows.push(window);
    }
  }

  if (windows.length === 0) {
    throw new Error("OpenCode sent Go usage in a format this version can't read.");
  }

  const weekly = windows.find((window) => window.label === "Weekly");
  return {
    windows,
    weeklyRemainingLabel: weekly?.statusLabel,
    note: "Go usage is official GET /zen/go/v1/usage. Dollar remaining uses published $12 / $30 / $60 limits.",
  };
}

function unitsToUsd(value: number): number {
  return value / ZEN_BILLING_UNITS_PER_DOLLAR;
}

function monthlyLimitToUsd(value: number): number {
  return value >= 1_000_000 ? unitsToUsd(value) : value;
}

function extractWorkspaceId(text: string): string | undefined {
  return text.match(/\/workspace\/(wrk_[A-Za-z0-9]+)/)?.[1];
}

function parseJsonObjectFromText(text: string, startIndex: number): Record<string, unknown> | undefined {
  const start = text.indexOf("{", startIndex);
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return asRecord(JSON.parse(text.slice(start, index + 1)));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function parseZenBillingHtml(html: string): ZenCredits | undefined {
  const billingMarker = html.search(/billing\.get|monthlyUsage|monthlyLimit/);
  const object = billingMarker >= 0 ? parseJsonObjectFromText(html, billingMarker) : undefined;
  const balanceRaw = parseNumber(object?.balance);
  const usageRaw = parseNumber(object?.monthlyUsage);
  const limitRaw = parseNumber(object?.monthlyLimit);

  if (balanceRaw === undefined) {
    const balanceMatch = html.match(/"balance"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/);
    const usageMatch = html.match(/"monthlyUsage"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/);
    const limitMatch = html.match(/"monthlyLimit"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/);
    if (!balanceMatch) {
      return undefined;
    }
    return {
      balanceUsd: unitsToUsd(Number(balanceMatch[1])),
      usedUsd: usageMatch ? unitsToUsd(Number(usageMatch[1])) : undefined,
      monthlyLimitUsd: limitMatch ? monthlyLimitToUsd(Number(limitMatch[1])) : undefined,
    };
  }

  return {
    balanceUsd: unitsToUsd(balanceRaw),
    usedUsd: usageRaw === undefined ? undefined : unitsToUsd(usageRaw),
    monthlyLimitUsd: limitRaw === undefined ? undefined : monthlyLimitToUsd(limitRaw),
  };
}

async function discoverWorkspaceId(cookie: string): Promise<string | undefined> {
  const { body, finalUrl } = await fetchText(OPENCODE_CONSOLE_URL, {
    Cookie: cookieHeader(cookie),
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": "pi-subscription-usage",
  });
  return extractWorkspaceId(finalUrl) ?? extractWorkspaceId(body);
}

async function loadZenUsage(cookie: string, workspaceId: string): Promise<ZenUsageResult> {
  const url = `https://opencode.ai/workspace/${workspaceId}/billing`;
  const { status, body } = await fetchText(url, {
    Cookie: cookieHeader(cookie),
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": "pi-subscription-usage",
  });

  if (status === 401 || status === 403) {
    throw new Error("The Zen console cookie was rejected. Copy a fresh one into OPENCODE_AUTH_COOKIE.");
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Zen balance request failed (HTTP ${status}).`);
  }

  const credits = parseZenBillingHtml(body);
  if (!credits) {
    throw new Error("OpenCode's billing page changed, so the Zen balance can't be read.");
  }

  const usedPercent =
    credits.usedUsd !== undefined && credits.monthlyLimitUsd !== undefined
      ? safePercent(credits.usedUsd, credits.monthlyLimitUsd)
      : undefined;

  const remainingLabel = `${formatCurrency(credits.balanceUsd)} left`;
  const detailLabel =
    credits.usedUsd !== undefined && credits.monthlyLimitUsd !== undefined
      ? `${formatCurrency(credits.usedUsd)}/${formatCurrency(credits.monthlyLimitUsd)} used`
      : credits.usedUsd !== undefined
        ? `${formatCurrency(credits.usedUsd)} used`
        : remainingLabel;

  return {
    remainingLabel,
    note: "Zen dollars are unofficial workspace billing HTML scrape (1e8 units = $1). No official Zen balance API exists yet.",
    window: {
      label: "Zen balance",
      usedPercent,
      statusLabel: remainingLabel,
      detailLabel,
      notches: [50, 75, 90],
    },
  };
}

function joinStatus(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part?.trim())).join(" • ");
}

export async function loadOpenCodeRuntimeState(
  authStorage: SubscriptionAuthStorage = createSubscriptionAuthStorage(),
): Promise<SubscriptionProviderRuntimeState> {
  const resolved = resolveOpenCodeAuth();
  await attachPiOpenCodeKey(resolved, authStorage);
  const secrets = [resolved.goApiKey, resolved.zenApiKey, resolved.authCookie];

  if (!resolved.goApiKey && !resolved.authCookie) {
    return {
      state: "error",
      errorMessage:
        "Not set up. Run /login and choose OpenCode Go, or set OPENCODE_GO_API_KEY.",
      usageWindows: [],
    };
  }

  const [goResult, zenResult] = await Promise.all([
    (async (): Promise<{ go?: GoUsageResult; goError?: string }> => {
      if (!resolved.goApiKey) {
        return {};
      }
      try {
        return { go: await loadGoUsage(resolved.goApiKey) };
      } catch (error) {
        return { goError: sanitizeError(error, secrets) };
      }
    })(),
    (async (): Promise<{ zen?: ZenUsageResult; zenError?: string; workspaceId?: string }> => {
      if (!resolved.authCookie) {
        return {
          zenError:
            "A Zen balance needs OPENCODE_AUTH_COOKIE and OPENCODE_WORKSPACE_ID.",
        };
      }
      try {
        const workspaceId = resolved.workspaceId ?? (await discoverWorkspaceId(resolved.authCookie));
        if (!workspaceId) {
          return { zenError: "A Zen balance needs OPENCODE_WORKSPACE_ID." };
        }
        return {
          zen: await loadZenUsage(resolved.authCookie, workspaceId),
          workspaceId,
        };
      } catch (error) {
        return { zenError: sanitizeError(error, secrets) };
      }
    })(),
  ]);

  const go = goResult.go;
  const goError = goResult.goError;
  const zen = zenResult.zen;
  const zenError = zenResult.zenError;
  if (zenResult.workspaceId && !resolved.workspaceId) {
    resolved.workspaceId = zenResult.workspaceId;
  }

  const usageWindows = [...(zen ? [zen.window] : []), ...(go?.windows ?? [])];
  if (usageWindows.length === 0) {
    return {
      state: "error",
      // A key without a Go subscription and no Zen cookie: nothing this tab could ever show.
      noSubscription: !resolved.authCookie && /subscription required|entitlement/i.test(goError ?? ""),
      errorMessage: joinStatus([goError, zenError]),
      usageWindows: [],
    };
  }

  return {
    state: "ready",
    usageWindows,
    lastUpdatedAt: new Date(),
  };
}

export const opencodeProvider: SubscriptionProviderDefinition = {
  id: "opencode",
  label: "OpenCode",
  shortLabel: "OpenCode",
  enabledByDefault: true,
  authHint: "Run /login and choose OpenCode Go, or set OPENCODE_GO_API_KEY. A Zen balance needs OPENCODE_AUTH_COOKIE and OPENCODE_WORKSPACE_ID.",
  // A Pi login, OpenCode's own login or its environment variables.
  isSetUp: (stored) => {
    if (hasStoredLogin(stored, "opencode", "opencode-go")) {
      return true;
    }
    const resolved = resolveOpenCodeAuth();
    return Boolean(resolved.goApiKey || resolved.authCookie);
  },
  loadRuntimeState: loadOpenCodeRuntimeState,
};
