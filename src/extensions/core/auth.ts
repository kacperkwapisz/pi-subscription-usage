import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";

export interface SubscriptionAuthStatus {
  configured: boolean;
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  label?: string;
}

export interface SubscriptionAuthStorage {
  get(provider: string): unknown;
  getAuthStatus(provider: string): SubscriptionAuthStatus;
  getApiKey(provider: string, options?: { includeFallback?: boolean }): Promise<string | undefined>;
}

interface OAuthCredential {
  type: "oauth";
  access?: string;
}

interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: Record<string, string>;
}

type StoredCredential = OAuthCredential | ApiKeyCredential | Record<string, unknown>;
type AuthStorageFactory = {
  create?: (authPath?: string) => SubscriptionAuthStorage;
};

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  "github-copilot": ["GITHUB_COPILOT_TOKEN", "GITHUB_TOKEN"],
  "kimi-coding": ["KIMI_API_KEY", "KIMI_CODE_API_KEY", "MOONSHOT_API_KEY"],
  kilo: ["KILO_API_KEY", "KILOCODE_API_KEY", "KILO_CODE_API_KEY", "KILO_TOKEN", "KILOCODE_TOKEN", "KILO_CODE_TOKEN"],
  kilocode: ["KILO_API_KEY", "KILOCODE_API_KEY", "KILO_CODE_API_KEY", "KILO_TOKEN", "KILOCODE_TOKEN", "KILO_CODE_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  "openai-codex": ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "CHATGPT_ACCESS_TOKEN"],
  opencode: ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  xai: ["XAI_API_KEY"],
};

class FallbackAuthStorage implements SubscriptionAuthStorage {
  private readonly data: Record<string, StoredCredential>;

  constructor() {
    this.data = readCompatAuthFile();
  }

  get(provider: string): unknown {
    return this.data[provider];
  }

  getAuthStatus(provider: string): SubscriptionAuthStatus {
    if (this.data[provider]) {
      return { configured: true, source: "stored" };
    }

    const envKey = findProviderEnvKey(provider);
    if (envKey) {
      return { configured: false, source: "environment", label: envKey };
    }

    return { configured: false };
  }

  async getApiKey(provider: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
    const credential = this.data[provider];

    if (credential && typeof credential === "object") {
      if (credential.type === "oauth") {
        const oauthCredential = credential as OAuthCredential;
        return typeof oauthCredential.access === "string" && oauthCredential.access.length > 0
          ? oauthCredential.access
          : undefined;
      }

      if (credential.type === "api_key") {
        const apiKeyCredential = credential as ApiKeyCredential;
        return resolveConfigValue(apiKeyCredential.key, apiKeyCredential.env);
      }
    }

    if (options?.includeFallback === false) {
      return undefined;
    }

    const envKey = findProviderEnvKey(provider);
    return envKey ? process.env[envKey] : undefined;
  }
}

function getAgentDirCompat(): string {
  if (typeof PiCodingAgent.getAgentDir === "function") {
    return PiCodingAgent.getAgentDir();
  }

  return join(homedir(), ".pi", "agent");
}

function readCompatAuthFile(): Record<string, StoredCredential> {
  const authPath = join(getAgentDirCompat(), "auth.json");
  if (!existsSync(authPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, StoredCredential>
      : {};
  } catch {
    return {};
  }
}

function resolveConfigValue(value: unknown, env?: Record<string, string>): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  if (value.startsWith("${") && value.endsWith("}")) {
    const envKey = value.slice(2, -1);
    return env?.[envKey] ?? process.env[envKey];
  }

  if (value.startsWith("$") && value.length > 1) {
    const envKey = value.slice(1);
    return env?.[envKey] ?? process.env[envKey];
  }

  return value;
}

function findProviderEnvKey(provider: string): string | undefined {
  for (const envKey of PROVIDER_ENV_KEYS[provider] ?? []) {
    if (typeof process.env[envKey] === "string" && process.env[envKey]!.length > 0) {
      return envKey;
    }
  }

  return undefined;
}

export function getPiAgentDir(): string {
  return getAgentDirCompat();
}

type ModelRegistryLike = Pick<
  PiCodingAgent.ModelRegistry,
  "getProvider" | "getProviderAuthStatus" | "getApiKeyForProvider"
>;

const readStoredCredential = (PiCodingAgent as {
  readStoredCredential?: (providerId: string) => unknown;
}).readStoredCredential;

/**
 * Pi 1.x: stored credentials, auth status and access tokens all come from Pi itself, so
 * expired OAuth tokens are refreshed (and saved) by Pi exactly as they are for requests.
 * Providers Pi does not know fall back to reading auth.json and the environment.
 */
class PiAuthStorage implements SubscriptionAuthStorage {
  private readonly registry: ModelRegistryLike;
  private readonly fallback: SubscriptionAuthStorage;

  constructor(registry: ModelRegistryLike, fallback: SubscriptionAuthStorage) {
    this.registry = registry;
    this.fallback = fallback;
  }

  get(provider: string): unknown {
    return readStoredCredential?.(provider) ?? this.fallback.get(provider);
  }

  getAuthStatus(provider: string): SubscriptionAuthStatus {
    return this.registry.getProvider(provider)
      ? this.registry.getProviderAuthStatus(provider)
      : this.fallback.getAuthStatus(provider);
  }

  async getApiKey(provider: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
    if (options?.includeFallback === false && !this.get(provider)) {
      return undefined;
    }
    if (this.registry.getProvider(provider)) {
      const key = await this.registry.getApiKeyForProvider(provider);
      if (key || options?.includeFallback === false) {
        return key;
      }
    }
    return this.fallback.getApiKey(provider, options);
  }
}

export function createSubscriptionAuthStorage(registry?: ModelRegistryLike): SubscriptionAuthStorage {
  if (registry) {
    return new PiAuthStorage(registry, new FallbackAuthStorage());
  }

  const authStorageFactory = (PiCodingAgent as { AuthStorage?: AuthStorageFactory }).AuthStorage;
  if (authStorageFactory?.create) {
    return authStorageFactory.create();
  }

  return new FallbackAuthStorage();
}

/**
 * Presents another Pi provider's login under a provider's own id, so a provider written for
 * `anthropic` reads `anthropic-account-2` without knowing about accounts.
 */
export function scopeAuthStorage(storage: SubscriptionAuthStorage, from: string, to: string): SubscriptionAuthStorage {
  if (from === to) {
    return storage;
  }
  const map = (provider: string) => (provider === from ? to : provider);
  return {
    get: (provider) => storage.get(map(provider)),
    getAuthStatus: (provider) => storage.getAuthStatus(map(provider)),
    getApiKey: (provider, options) => storage.getApiKey(map(provider), options),
  };
}

/** Every stored login in Pi's auth.json, keyed by provider id (read-only snapshot). */
export function readStoredCredentials(): Record<string, unknown> {
  return readCompatAuthFile();
}
