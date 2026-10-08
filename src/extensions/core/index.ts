import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { discoverAccounts, type SubscriptionAccount } from "./accounts.ts";
import { createSubscriptionAuthStorage, readStoredCredentials, scopeAuthStorage } from "./auth.ts";
import { connectMultiAccount } from "./multi-account.ts";
import { isProviderSetUp } from "./setup.ts";
import {
  createDefaultSubscriptionProviderRegistry,
  type SubscriptionProviderDefinition,
  type SubscriptionProviderId,
} from "./providers/index.ts";
import { loadSubscriptionMeterSettings, saveSubscriptionMeterSettings } from "./settings.ts";
import { ProviderSettingsDialog } from "./ui/provider-settings-dialog.ts";
import { SubscriptionsDialog } from "./ui/subscriptions-dialog.ts";

export default function (pi: ExtensionAPI) {
  const providerRegistry = createDefaultSubscriptionProviderRegistry();
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

  pi.registerCommand("subscriptions", command);
  pi.registerCommand("usage", command);
}
