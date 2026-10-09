import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { accountNumber, discoverAccounts, type SubscriptionAccount } from "./accounts.ts";
import { createSubscriptionAuthStorage, readStoredCredentials, scopeAuthStorage } from "./auth.ts";
import { connectMultiAccount } from "./multi-account.ts";
import { isProviderSetUp } from "./setup.ts";
import {
  createDefaultSubscriptionProviderRegistry,
  type SubscriptionProviderDefinition,
  type SubscriptionProviderId,
} from "./providers/index.ts";
import { ServiceStatusReader, type ServiceStatusResult } from "./service-status.ts";
import { loadSubscriptionMeterSettings, saveSubscriptionMeterSettings } from "./settings.ts";
import { loadRecords } from "./stats/records.ts";
import type { ProviderNaming } from "./stats/summary.ts";
import { ProviderSettingsDialog } from "./ui/provider-settings-dialog.ts";
import { StatsView } from "./ui/stats-view.ts";
import { SubscriptionsDialog } from "./ui/subscriptions-dialog.ts";

/**
 * For other extensions, over pi.events: emit with `{ provider, reply, accept? }`, where
 * `provider` is a Pi provider id such as "anthropic" or "anthropic-account-3". `accept` is
 * called during emit, so the asker knows a reply is coming; `reply` is called once with the
 * provider's status page result (see service-status.ts), or with undefined when it has none.
 */
export const STATUS_EVENT = "pi-subscription-usage:status";

/** The provider definition a Pi provider id (or one of its numbered accounts) belongs to. */
export function providerForPiId(providers: SubscriptionProviderDefinition[], piProviderId: string): SubscriptionProviderDefinition | undefined {
  return providers.find((provider) =>
    (provider.accountSources?.length ? provider.accountSources : [provider.id]).some((source) => accountNumber(piProviderId, source) !== undefined),
  );
}

/** Where Pi keeps sessions: --session-dir / PI_CODING_AGENT_SESSION_DIR, the sessionDir setting, or the default. */
export function sessionsDir(agentDir = getAgentDir()): string {
  const fromEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (fromEnv) return fromEnv;
  try {
    const settingsFile = join(agentDir, "settings.json");
    const setting = existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")) as { sessionDir?: unknown }).sessionDir : undefined;
    if (typeof setting === "string" && isAbsolute(setting)) return setting;
  } catch {
    // Unreadable settings: the default.
  }
  return join(agentDir, "sessions");
}

/**
 * How /stats names things: a provider and all its numbered accounts form one group ("Anthropic"
 * with Account 1, 2, 3; ChatGPT logins from openai-codex and openai together).
 */
export function statsNaming(providers: SubscriptionProviderDefinition[], displayName: (id: string) => string): ProviderNaming {
  const base = (providerId: string) => providerId.replace(/-account-\d+$/, "");
  const number = (providerId: string) => Number(providerId.match(/-account-(\d+)$/)?.[1] ?? 1);
  return {
    group: (providerId) => providerForPiId(providers, providerId)?.id ?? base(providerId),
    groupLabel: (group) => providers.find((provider) => provider.id === group)?.label ?? displayName(group),
    accountLabel: (providerId) => {
      const provider = providerForPiId(providers, providerId);
      const sources = provider?.accountSources?.length ? provider.accountSources : [provider?.id ?? base(providerId)];
      const source = base(providerId);
      if (source === sources[0]) return `Account ${number(providerId)}`;
      return number(providerId) === 1 ? source : `${source} account ${number(providerId)}`;
    },
  };
}

function registerStats(pi: ExtensionAPI, providers: () => SubscriptionProviderDefinition[]): void {
  pi.registerCommand("stats", {
    description: "Tokens, cache share and API price across your providers and accounts",
    handler: async (_args, ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/stats needs the interactive terminal.", "warning");
        return;
      }
      const agentDir = getAgentDir();
      let view: StatsView | undefined;
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          view = new StatsView({
            load: (onProgress) =>
              loadRecords({
                sources: [
                  { dir: sessionsDir(agentDir), subagent: false },
                  { dir: join(agentDir, "subagents"), subagent: true },
                ],
                cacheFile: join(agentDir, "subscription-usage-stats.cache"),
                onProgress,
              }),
            naming: statsNaming(providers(), (id) => ctx.modelRegistry.getProviderDisplayName(id) || id),
            theme,
            requestRender: () => tui.requestRender(),
            onClose: () => done(undefined),
          });
          return {
            render: (width: number) => view?.render(width) ?? [],
            invalidate: () => view?.invalidate(),
            handleInput: (data: string) => {
              view?.handleInput(data);
              tui.requestRender();
            },
          };
        },
        { overlay: true, overlayOptions: { anchor: "center", width: 82, maxHeight: "95%", margin: 1 } },
      );
    },
  });
}

export default function (pi: ExtensionAPI) {
  const providerRegistry = createDefaultSubscriptionProviderRegistry();
  const statusReader = new ServiceStatusReader();

  pi.events.on(STATUS_EVENT, (data) => {
    const { provider: piProviderId, reply, accept } = (data ?? {}) as { provider?: unknown; reply?: unknown; accept?: unknown };
    if (typeof reply !== "function") return;
    // Tells the asker, during emit, that a reply is coming (it may take a moment to fetch).
    if (typeof accept === "function") accept();
    const provider = typeof piProviderId === "string" ? providerForPiId(providerRegistry.getAllProviders(), piProviderId) : undefined;
    if (!provider?.statusPage) {
      reply(undefined);
      return;
    }
    void statusReader.read(provider.statusPage).then((result: ServiceStatusResult) => reply(result));
  });
  // Providers whose logins turned out to have no subscription; hidden for the rest of the session.
  const withoutSubscription = new Set<SubscriptionProviderId>();
  let subscriptionsOverlayHandle: OverlayHandle | null = null;
  let closeSubscriptionsOverlay: (() => void) | null = null;

  const command: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "Show subscription usage for every account",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/subscriptions requires TUI mode", "error");
        return;
      }

      const normalizedArgs = args.trim().toLowerCase();

      if (normalizedArgs === "close") {
        if (closeSubscriptionsOverlay) {
          closeSubscriptionsOverlay();
        }
        return;
      }

      if (subscriptionsOverlayHandle) {
        if (!subscriptionsOverlayHandle.isFocused()) {
          subscriptionsOverlayHandle.focus();
          ctx.ui.notify("Subscriptions overlay focused.", "info");
        } else {
          ctx.ui.notify("Subscriptions overlay is already open and focused.", "info");
        }
        return;
      }

      let currentSettings = loadSubscriptionMeterSettings();
      providerRegistry.setEnabledProviders(currentSettings.enabledProviders);

      let dialog: SubscriptionsDialog | undefined;
      // Tabs appear for providers that are enabled in settings and set up (logged in or keyed).
      const isSetUp = (provider: SubscriptionProviderDefinition) => isProviderSetUp(provider, readStoredCredentials());
      const visibleProviders = () =>
        providerRegistry.getEnabledProviders().filter((provider) => isSetUp(provider) && !withoutSubscription.has(provider.id));
      // With pi-multi-account loaded, Enter on an account switches to it (after the overlay closes).
      const multiAccount = connectMultiAccount(pi.events);
      let accountToUse: SubscriptionAccount | undefined;
      let settingsOverlayOpen = false;

      void ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const saveAndApplySettings = (nextSettings: {
          enabledProviders?: SubscriptionProviderId[];
          displayMode?: "used" | "remaining";
          resetTimeDisplayMode?: "absolute" | "relative";
          showThresholdNotches?: boolean;
          showNowNotch?: boolean;
        }) => {
          try {
            const savedSettings = saveSubscriptionMeterSettings({
              version: 1,
              enabledProviders: nextSettings.enabledProviders ?? currentSettings.enabledProviders,
              displayMode: nextSettings.displayMode ?? currentSettings.displayMode,
              resetTimeDisplayMode: nextSettings.resetTimeDisplayMode ?? currentSettings.resetTimeDisplayMode,
              showThresholdNotches: nextSettings.showThresholdNotches ?? currentSettings.showThresholdNotches,
              showNowNotch: nextSettings.showNowNotch ?? currentSettings.showNowNotch,
            });

            currentSettings = savedSettings;
            providerRegistry.setEnabledProviders(savedSettings.enabledProviders);
            dialog?.setProviders(visibleProviders());
            dialog?.setDisplayMode(savedSettings.displayMode);
            dialog?.setResetTimeDisplayMode(savedSettings.resetTimeDisplayMode);
            dialog?.setShowThresholdNotches(savedSettings.showThresholdNotches);
            dialog?.setShowNowNotch(savedSettings.showNowNotch);
            tui.requestRender();
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Failed to save subscription settings: ${message}`, "error");
          }
        };

        const openSettings = () => {
          if (settingsOverlayOpen) {
            return;
          }

          settingsOverlayOpen = true;

          void ctx.ui
            .custom<void>(
              (overlayTui, overlayTheme, _overlayKeybindings, overlayDone) => {
                const settingsDialog = new ProviderSettingsDialog({
                  theme: overlayTheme,
                  providers: providerRegistry.getAllProviders(),
                  enabledProviderIds: providerRegistry.getEnabledProviders().map((provider) => provider.id),
                  setUpProviderIds: providerRegistry.getAllProviders().filter(isSetUp).map((provider) => provider.id),
                  noSubscriptionProviderIds: [...withoutSubscription],
                  displayMode: currentSettings.displayMode,
                  resetTimeDisplayMode: currentSettings.resetTimeDisplayMode,
                  showThresholdNotches: currentSettings.showThresholdNotches,
                  showNowNotch: currentSettings.showNowNotch,
                  onEnabledProvidersChange: (enabledProviderIds) => {
                    saveAndApplySettings({ enabledProviders: enabledProviderIds });
                    overlayTui.requestRender();
                  },
                  onDisplayModeChange: (displayMode) => {
                    saveAndApplySettings({ displayMode });
                    overlayTui.requestRender();
                  },
                  onResetTimeDisplayModeChange: (resetTimeDisplayMode) => {
                    saveAndApplySettings({ resetTimeDisplayMode });
                    overlayTui.requestRender();
                  },
                  onShowThresholdNotchesChange: (showThresholdNotches) => {
                    saveAndApplySettings({ showThresholdNotches });
                    overlayTui.requestRender();
                  },
                  onShowNowNotchChange: (showNowNotch) => {
                    saveAndApplySettings({ showNowNotch });
                    overlayTui.requestRender();
                  },
                  onClose: () => overlayDone(undefined),
                });

                return {
                  render(width: number) {
                    return settingsDialog.render(width);
                  },
                  invalidate() {
                    settingsDialog.invalidate();
                  },
                  handleInput(data: string) {
                    settingsDialog.handleInput(data);
                    overlayTui.requestRender();
                  },
                };
              },
              {
                overlay: true,
                overlayOptions: {
                  width: "70%",
                  minWidth: 60,
                  maxHeight: "80%",
                  anchor: "center",
                  margin: 2,
                },
              },
            )
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(`Failed to open subscription settings: ${message}`, "error");
            })
            .finally(() => {
              settingsOverlayOpen = false;
              dialog?.invalidate();
              tui.requestRender();
            });
        };

        closeSubscriptionsOverlay = () => done(undefined);

        // Pi-backed: tokens are refreshed by Pi, exactly as they are for requests.
        const auth = createSubscriptionAuthStorage(ctx.modelRegistry);

        dialog = new SubscriptionsDialog({
          providers: visibleProviders(),
          loadAccounts: (provider) => discoverAccounts(provider, readStoredCredentials()),
          loadAccountState: async (provider, account) => {
            if (!provider.loadRuntimeState) {
              throw new Error(`${provider.label} has no live usage source.`);
            }
            return provider.loadRuntimeState(scopeAuthStorage(auth, account.sourceId, account.providerId));
          },
          currentProviderId: ctx.model?.provider,
          readStatus: (provider, fresh) => statusReader.read(provider.statusPage!, { fresh }),
          onUseAccount: multiAccount
            ? (account) => {
                accountToUse = account;
                done(undefined);
              }
            : undefined,
          onNoSubscription: (provider) => withoutSubscription.add(provider.id),
          displayMode: currentSettings.displayMode,
          resetTimeDisplayMode: currentSettings.resetTimeDisplayMode,
          showThresholdNotches: currentSettings.showThresholdNotches,
          showNowNotch: currentSettings.showNowNotch,
          theme,
          onClose: () => done(undefined),
          onOpenSettings: openSettings,
          requestRender: () => tui.requestRender(),
        });

        return {
          render(width: number) {
            return dialog?.render(width) ?? [];
          },
          invalidate() {
            dialog?.invalidate();
          },
          handleInput(data: string) {
            dialog?.handleInput(data);
            tui.requestRender();
          },
        };
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "75%",
          minWidth: 44,
          maxHeight: "85%",
          margin: 2,
        },
        onHandle: (handle) => {
          subscriptionsOverlayHandle = handle;
        },
      })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to open subscriptions overlay: ${message}`, "error");
        })
        .finally(() => {
          dialog?.dispose();
          subscriptionsOverlayHandle = null;
          closeSubscriptionsOverlay = null;
          if (accountToUse && multiAccount) {
            void multiAccount.useAccount(accountToUse.providerId, ctx);
          }
        });

    },
  };

  registerStats(pi, () => providerRegistry.getAllProviders());
  pi.registerCommand("subscriptions", command);
  pi.registerCommand("usage", command);
}
