import { createSubscriptionAuthStorage, type SubscriptionAuthStorage } from "../auth.ts";
import type {
  SubscriptionProviderDefinition,
  SubscriptionProviderRuntimeState,
  SubscriptionUsageWindowDefinition,
} from "./types.ts";

// Undocumented xAI Grok CLI proxy; keep this integration isolated and fail closed on schema changes.
const XAI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const XAI_USAGE_TIMEOUT_MS = 20_000;
const XAI_MAX_RESPONSE_BYTES = 64 * 1024;
const XAI_CLIENT_VERSION = "0.2.101";

interface XaiCurrentPeriod {
  type?: string;
  start?: string;
  end?: string;
}

interface XaiProductUsage {
  product?: string;
  usagePercent?: number;
}

interface XaiUsageResponse {
  subscriptionTier?: string;
  config?: {
    creditUsagePercent?: number;
    currentPeriod?: XaiCurrentPeriod;
    billingPeriodStart?: string;
    billingPeriodEnd?: string;
    productUsage?: XaiProductUsage[];
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isOAuthCredential(value: unknown): boolean {
  const credential = asRecord(value);
  return credential?.type === "oauth" && typeof credential.access === "string" && credential.access.length > 0;
}

function xaiProxyHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": `grok-shell/${XAI_CLIENT_VERSION} (${process.platform === "darwin" ? "macos" : process.platform}; ${process.arch === "arm64" ? "aarch64" : process.arch})`,
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-version": XAI_CLIENT_VERSION,
    "x-grok-client-mode": "interactive",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > XAI_MAX_RESPONSE_BYTES) {
    throw new Error("xAI usage response exceeded the 64 KiB safety limit.");
  }

  if (!response.body) {
    throw new Error("xAI usage response had no body.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > XAI_MAX_RESPONSE_BYTES) {
        throw new Error("xAI usage response exceeded the 64 KiB safety limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("xAI usage response was not valid JSON.");
  }
}

function parseUserId(value: unknown): string {
  const userId = asRecord(value)?.userId;
  if (typeof userId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(userId)) {
    throw new Error("xAI account identity was not available; billing was not requested.");
  }
  return userId;
}

async function fetchXaiUsage(accessToken: string): Promise<XaiUsageResponse> {
  const headers = xaiProxyHeaders(accessToken);
  const userResponse = await fetch(`${XAI_PROXY_BASE_URL}/user`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(XAI_USAGE_TIMEOUT_MS),
  });

  if (!userResponse.ok) {
    throw new Error(`xAI account lookup returned HTTP ${userResponse.status}.`);
  }

  const userId = parseUserId(await readBoundedJson(userResponse));
  const billingResponse = await fetch(`${XAI_PROXY_BASE_URL}/billing?format=credits`, {
    headers: { ...headers, "x-userid": userId },
    redirect: "error",
    signal: AbortSignal.timeout(XAI_USAGE_TIMEOUT_MS),
  });

  if (!billingResponse.ok) {
    throw new Error(`xAI billing lookup returned HTTP ${billingResponse.status}.`);
  }

  const root = asRecord(await readBoundedJson(billingResponse));
  if (!root) {
    throw new Error("xAI billing response had an unexpected shape.");
  }

  const config = asRecord(root.config);
  if (root.config != null && !config) {
    throw new Error("xAI billing response had an invalid config object.");
  }

  const currentPeriod = asRecord(config?.currentPeriod);
  const productUsage = Array.isArray(config?.productUsage)
    ? config.productUsage.map(asRecord).filter((item): item is Record<string, unknown> => !!item)
    : undefined;

  return {
    subscriptionTier: typeof root.subscriptionTier === "string" ? root.subscriptionTier : undefined,
    config: config
      ? {
        creditUsagePercent: parseNumber(config.creditUsagePercent),
        currentPeriod: currentPeriod
          ? {
            type: typeof currentPeriod.type === "string" ? currentPeriod.type : undefined,
            start: typeof currentPeriod.start === "string" ? currentPeriod.start : undefined,
            end: typeof currentPeriod.end === "string" ? currentPeriod.end : undefined,
          }
          : undefined,
        billingPeriodStart: typeof config.billingPeriodStart === "string" ? config.billingPeriodStart : undefined,
        billingPeriodEnd: typeof config.billingPeriodEnd === "string" ? config.billingPeriodEnd : undefined,
        productUsage: productUsage?.map((item) => ({
          product: typeof item.product === "string" ? item.product : undefined,
          usagePercent: parseNumber(item.usagePercent),
        })),
      }
      : undefined,
  };
}

function usagePeriodLabel(type: string | undefined): string {
  if (type === "USAGE_PERIOD_TYPE_WEEKLY") {
    return "Weekly";
  }
  if (type === "USAGE_PERIOD_TYPE_MONTHLY") {
    return "Monthly";
  }
  return "Subscription usage";
}

function createUsageWindow(response: XaiUsageResponse): SubscriptionUsageWindowDefinition | undefined {
  const config = response.config;
  const period = config?.currentPeriod;
  const resetAt = parseDate(period?.end ?? config?.billingPeriodEnd);
  const startAt = parseDate(period?.start ?? config?.billingPeriodStart);
  const usedPercent = parseNumber(config?.creditUsagePercent);

  if (!period && usedPercent == null) {
    return undefined;
  }

  let pacePercent: number | undefined;
  if (startAt && resetAt) {
    const durationMs = resetAt.getTime() - startAt.getTime();
    if (durationMs > 0) {
      pacePercent = clampPercent(((Date.now() - startAt.getTime()) / durationMs) * 100);
    }
  }

  return {
    label: usagePeriodLabel(period?.type),
    usedPercent: usedPercent == null ? undefined : clampPercent(usedPercent),
    statusLabel: usedPercent == null ? "not reported" : undefined,
    detailLabel: pacePercent == null ? undefined : `${Math.round(pacePercent)}% of the period has passed`,
    resetAt,
    pacePercent,
    notches: [50, 75, 90],
  };
}

export async function loadXaiRuntimeState(
  authStorage: SubscriptionAuthStorage = createSubscriptionAuthStorage(),
): Promise<SubscriptionProviderRuntimeState> {
  const authStatus = authStorage.getAuthStatus("xai");
  const storedCredential = authStorage.get("xai");

  if (!isOAuthCredential(storedCredential)) {
    const apiKeyConfigured = authStatus.source === "environment" || asRecord(storedCredential)?.type === "api_key";
    return {
      state: "error",
      errorMessage: apiKeyConfigured
        ? "XAI_API_KEY is a pay-per-use key with no SuperGrok limits. Run /login xai and choose Use a subscription."
        : "Not logged in. Run /login xai and choose Use a subscription.",
      usageWindows: [],
    };
  }

  const accessToken = await authStorage.getApiKey("xai", { includeFallback: false });
  if (!accessToken) {
    return {
      state: "error",
      errorMessage: "The xAI login stopped working. Run /login xai again.",
      usageWindows: [],
    };
  }

  try {
    const response = await fetchXaiUsage(accessToken);
    const usageWindow = createUsageWindow(response);
    if (!usageWindow) {
      return {
        state: "error",
        errorMessage: "xAI sent usage in a format this version can't read.",
        usageWindows: [],
      };
    }

    return {
      state: "ready",
      usageWindows: [usageWindow],
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

export const xaiProvider: SubscriptionProviderDefinition = {
  id: "xai",
  label: "xAI SuperGrok",
  shortLabel: "xAI",
  enabledByDefault: true,
  authHint: "Run /login xai and choose Use a subscription. An XAI_API_KEY has no SuperGrok limits to show.",
  loadRuntimeState: loadXaiRuntimeState,
};
