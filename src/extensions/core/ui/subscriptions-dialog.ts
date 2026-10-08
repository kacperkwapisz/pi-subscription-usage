import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  SubscriptionProviderDefinition,
  SubscriptionProviderId,
  SubscriptionProviderRuntimeState,
  SubscriptionUsageWindowDefinition,
} from "../providers/index.ts";
import type { SubscriptionAccount } from "../accounts.ts";
import type { SubscriptionResetTimeDisplayMode, SubscriptionUsageDisplayMode } from "../settings.ts";
import { renderProgressBar } from "./progress-bar.ts";

interface SubscriptionsDialogOptions {
  providers: SubscriptionProviderDefinition[];
  /** Every account of a provider; re-read when the user refreshes. */
  loadAccounts: (provider: SubscriptionProviderDefinition) => SubscriptionAccount[];
  loadAccountState: (
    provider: SubscriptionProviderDefinition,
    account: SubscriptionAccount,
  ) => Promise<SubscriptionProviderRuntimeState>;
  /** Pi provider id of the session's current model, marked "in use". */
  currentProviderId?: string;
  /** Present when accounts can be switched (pi-multi-account is loaded). */
  onUseAccount?: (account: SubscriptionAccount) => void;
  displayMode: SubscriptionUsageDisplayMode;
  resetTimeDisplayMode: SubscriptionResetTimeDisplayMode;
  showThresholdNotches: boolean;
  showNowNotch: boolean;
  theme: Theme;
  onClose: () => void;
  onOpenSettings: () => void;
  requestRender: () => void;
}

function pad2(value: number): string {
  return String(Math.max(0, value)).padStart(2, "0");
}

function formatRelativeResetTime(resetAt: Date): string {
  const totalSeconds = Math.max(0, Math.ceil((resetAt.getTime() - Date.now()) / 1000));

  if (totalSeconds >= 24 * 60 * 60) {
    const days = Math.floor(totalSeconds / (24 * 60 * 60));
    const hours = Math.floor((totalSeconds % (24 * 60 * 60)) / (60 * 60));
    return `${days}d ${pad2(hours)}h`;
  }

  if (totalSeconds >= 60 * 60) {
    const hours = Math.floor(totalSeconds / (60 * 60));
    const minutes = Math.floor((totalSeconds % (60 * 60)) / 60);
    return `${pad2(hours)}h ${pad2(minutes)}m`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(minutes)}m ${pad2(seconds)}s`;
}

function formatAbsoluteResetTime(resetAt: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(resetAt);
}

function formatResetDetail(resetAt: Date, mode: SubscriptionResetTimeDisplayMode): string {
  return mode === "absolute"
    ? `Resets ${formatAbsoluteResetTime(resetAt)}`
    : `Resets in ${formatRelativeResetTime(resetAt)}`;
}

function projectPercentForDisplayMode(percent: number, displayMode: SubscriptionUsageDisplayMode): number {
  return displayMode === "remaining" ? Math.max(0, 100 - percent) : percent;
}

function getThresholdNotches(
  notches: number[] | undefined,
  displayMode: SubscriptionUsageDisplayMode,
): number[] {
  if (!notches?.length) {
    return [];
  }

  return [...new Set(
    notches
      .filter((notch) => notch === 50 || notch === 75)
      .map((notch) => projectPercentForDisplayMode(notch, displayMode)),
  )];
}

function getNowMarkerColor(
  usedPercent: number | undefined,
  pacePercent: number | undefined,
): Parameters<Theme["fg"]>[0] {
  if (usedPercent == null || pacePercent == null) {
    return "accent";
  }

  const delta = usedPercent - pacePercent;
  if (delta > 1) {
    return "error";
  }
  if (delta < -1) {
    return "success";
  }
  return "accent";
}

const STABLE_DIALOG_MIN_TOTAL_LINES = 32;
const FOOTER_LINE_COUNT = 3;

export class SubscriptionsDialog {
  private providers: SubscriptionProviderDefinition[];
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly onOpenSettings: () => void;
  private readonly requestRender: () => void;
  private readonly loadAccounts: (provider: SubscriptionProviderDefinition) => SubscriptionAccount[];
  private readonly loadAccountState: SubscriptionsDialogOptions["loadAccountState"];
  private readonly currentProviderId?: string;
  private readonly onUseAccount?: (account: SubscriptionAccount) => void;
  private readonly selectedAccount = new Map<SubscriptionProviderId, number>();
  private displayMode: SubscriptionUsageDisplayMode;
  private resetTimeDisplayMode: SubscriptionResetTimeDisplayMode;
  private showThresholdNotches: boolean;
  private showNowNotch: boolean;
  private activeIndex = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly accounts = new Map<SubscriptionProviderId, SubscriptionAccount[]>();
  private readonly runtimeStates = new Map<string, SubscriptionProviderRuntimeState>();
  private readonly loading = new Set<string>();
  private liveUpdateTicker?: ReturnType<typeof setInterval>;

  constructor(options: SubscriptionsDialogOptions) {
    this.providers = options.providers;
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.onOpenSettings = options.onOpenSettings;
    this.requestRender = options.requestRender;
    this.loadAccounts = options.loadAccounts;
    this.loadAccountState = options.loadAccountState;
    this.currentProviderId = options.currentProviderId;
    this.onUseAccount = options.onUseAccount;
    this.displayMode = options.displayMode;
    this.resetTimeDisplayMode = options.resetTimeDisplayMode;
    this.showThresholdNotches = options.showThresholdNotches;
    this.showNowNotch = options.showNowNotch;
    const current = this.providers.findIndex((provider) =>
      this.accountsOf(provider).some((account) => account.providerId === this.currentProviderId),
    );
    this.activeIndex = Math.max(0, current);
    this.syncLiveUpdateTicker();
    this.ensureActiveProviderLoaded();
  }

  setProviders(providers: SubscriptionProviderDefinition[]): void {
    this.providers = [...providers];
    if (this.providers.length === 0) {
      this.activeIndex = 0;
    } else if (this.activeIndex >= this.providers.length) {
      this.activeIndex = this.providers.length - 1;
    }
    this.syncLiveUpdateTicker();
    this.invalidate();
    this.ensureActiveProviderLoaded();
  }

  setDisplayMode(displayMode: SubscriptionUsageDisplayMode): void {
    this.displayMode = displayMode;
    this.invalidate();
  }

  setResetTimeDisplayMode(resetTimeDisplayMode: SubscriptionResetTimeDisplayMode): void {
    this.resetTimeDisplayMode = resetTimeDisplayMode;
    this.syncLiveUpdateTicker();
    this.invalidate();
  }

  setShowThresholdNotches(showThresholdNotches: boolean): void {
    this.showThresholdNotches = showThresholdNotches;
    this.invalidate();
  }

  setShowNowNotch(showNowNotch: boolean): void {
    this.showNowNotch = showNowNotch;
    this.syncLiveUpdateTicker();
    this.invalidate();
  }

  dispose(): void {
    if (this.liveUpdateTicker) {
      clearInterval(this.liveUpdateTicker);
      this.liveUpdateTicker = undefined;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
      this.onClose();
      return;
    }

    if (matchesKey(data, "s")) {
      this.onOpenSettings();
      return;
    }

    if (matchesKey(data, "r")) {
      this.refreshActiveProvider();
      return;
    }

    if (this.providers.length === 0) {
      return;
    }

    if (this.handleAccountInput(data)) {
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.activeIndex = (this.activeIndex + 1) % this.providers.length;
    } else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.activeIndex = (this.activeIndex - 1 + this.providers.length) % this.providers.length;
    } else if (matchesKey(data, Key.home)) {
      this.activeIndex = 0;
    } else if (matchesKey(data, Key.end)) {
      this.activeIndex = this.providers.length - 1;
    } else {
      return;
    }
    this.invalidate();
    this.ensureActiveProviderLoaded();
  }

  /** ↑↓ select an account and Enter switches to it, when switching is available. */
  private handleAccountInput(data: string): boolean {
    const provider = this.providers[this.activeIndex];
    if (!provider || !this.onUseAccount) {
      return false;
    }
    const accounts = this.accountsOf(provider);
    if (accounts.length < 2) {
      return false;
    }
    const index = this.selectedIndex(provider, accounts);
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const step = matchesKey(data, Key.up) ? -1 : 1;
      this.selectedAccount.set(provider.id, (index + step + accounts.length) % accounts.length);
      this.invalidate();
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      const account = accounts[index];
      if (account) {
        this.onUseAccount(account);
      }
      return true;
    }
    return false;
  }

  private selectedIndex(provider: SubscriptionProviderDefinition, accounts: SubscriptionAccount[]): number {
    const chosen = this.selectedAccount.get(provider.id);
    if (chosen !== undefined && chosen < accounts.length) {
      return chosen;
    }
    return Math.max(0, accounts.findIndex((account) => account.providerId === this.currentProviderId));
  }

  private accountsOf(provider: SubscriptionProviderDefinition, reload = false): SubscriptionAccount[] {
    let accounts = this.accounts.get(provider.id);
    if (!accounts || reload) {
      accounts = this.loadAccounts(provider);
      this.accounts.set(provider.id, accounts);
    }
    return accounts;
  }

  private stateKey(provider: SubscriptionProviderDefinition, account: SubscriptionAccount): string {
    return `${provider.id}\u0000${account.providerId}`;
  }

  private stateOf(provider: SubscriptionProviderDefinition, account: SubscriptionAccount): SubscriptionProviderRuntimeState | undefined {
    return this.runtimeStates.get(this.stateKey(provider, account));
  }

  private syncLiveUpdateTicker(): void {
    const needsLiveUpdates = this.resetTimeDisplayMode === "relative" || this.showNowNotch;

    if (!needsLiveUpdates) {
      if (this.liveUpdateTicker) {
        clearInterval(this.liveUpdateTicker);
        this.liveUpdateTicker = undefined;
      }
      return;
    }

    if (this.liveUpdateTicker) {
      return;
    }

    this.liveUpdateTicker = setInterval(() => {
      this.invalidate();
      this.requestRender();
    }, 1000);
  }

  private ensureActiveProviderLoaded(force = false): void {
    const provider = this.providers[this.activeIndex];
    if (!provider?.loadRuntimeState) {
      return;
    }

    for (const account of this.accountsOf(provider, force)) {
      const key = this.stateKey(provider, account);
      if (!force && (this.runtimeStates.has(key) || this.loading.has(key))) {
        continue;
      }

      this.loading.add(key);
      this.runtimeStates.set(key, {
        state: "loading",
        implementationStatus: provider.implementationStatus,
        statusLine: "loading live data",
        description: provider.description,
        notes: provider.notes,
        usageWindows: provider.usageWindows,
      });

      void this.loadAccountState(provider, account)
        .then((state) => {
          this.runtimeStates.set(key, state);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.runtimeStates.set(key, {
            state: "error",
            implementationStatus: provider.implementationStatus,
            statusLine: "fetch failed",
            description: provider.description,
            notes: provider.notes,
            usageWindows: provider.usageWindows,
            errorMessage: message,
          });
        })
        .finally(() => {
          this.loading.delete(key);
          this.invalidate();
          this.requestRender();
        });
    }

    this.invalidate();
    this.requestRender();
  }

  private refreshActiveProvider(): void {
    const provider = this.providers[this.activeIndex];
    if (!provider?.loadRuntimeState) {
      return;
    }

    for (const key of [...this.runtimeStates.keys()]) {
      if (key.startsWith(`${provider.id}\u0000`) && !this.loading.has(key)) {
        this.runtimeStates.delete(key);
      }
    }
    this.ensureActiveProviderLoaded(true);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const totalWidth = Math.max(36, Math.min(96, width));
    const contentWidth = Math.max(10, totalWidth - 2);
    const leftPadding = " ".repeat(Math.max(0, Math.floor((width - totalWidth) / 2)));

    const padLine = (value: string) => {
      const truncated = truncateToWidth(value, contentWidth, "");
      return `${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}`;
    };

    const addBorder = (left: string, fill: string, right: string) => {
      lines.push(`${leftPadding}${this.theme.fg("accent", `${left}${fill.repeat(contentWidth)}${right}`)}`);
    };

    const addContentLine = (value = "") => {
      lines.push(
        `${leftPadding}${this.theme.fg("accent", "│")}${padLine(value)}${this.theme.fg("accent", "│")}`,
      );
    };

    const addWrappedBlock = (value: string, indent = "") => {
      const availableWidth = Math.max(1, contentWidth - visibleWidth(indent));
      for (const wrapped of wrapTextWithAnsi(value, availableWidth)) {
        addContentLine(`${indent}${wrapped}`);
      }
    };

    const addCompactLine = (left: string, right: string) => {
      const truncatedLeft = truncateToWidth(left, Math.max(1, contentWidth - visibleWidth(right) - 1), "…");
      const spacing = " ".repeat(Math.max(1, contentWidth - visibleWidth(truncatedLeft) - visibleWidth(right)));
      addContentLine(`${truncatedLeft}${spacing}${right}`);
    };

    const addBlankLine = () => addContentLine();

    const usageTone = (percent: number | undefined, mode: SubscriptionUsageDisplayMode): Parameters<Theme["fg"]>[0] => {
      if (percent == null) return "accent";
      if (mode === "remaining") {
        if (percent <= 10) return "error";
        if (percent <= 25) return "warning";
        return "success";
      }
      if (percent >= 90) return "error";
      if (percent >= 75) return "warning";
      return "success";
    };

    const formatStatusLine = (provider: SubscriptionProviderDefinition, runtimeState?: SubscriptionProviderRuntimeState) => {
      const parts = [runtimeState?.implementationStatus ?? provider.implementationStatus, `${provider.stability} source`];

      if (runtimeState?.state === "loading") {
        parts.push(runtimeState.statusLine ?? "loading live data");
      } else if (runtimeState?.state === "ready") {
        parts.push(runtimeState.statusLine ?? "live data");
      } else if (runtimeState?.state === "error") {
        parts.push(runtimeState.statusLine ?? "live fetch failed");
      } else if (provider.loadRuntimeState) {
        parts.push("live fetch available");
      } else {
        parts.push("live fetch pending");
      }

      return parts.join(" • ");
    };

    const getUsageWindows = (
      provider: SubscriptionProviderDefinition,
      runtimeState?: SubscriptionProviderRuntimeState,
    ): SubscriptionUsageWindowDefinition[] => {
      if (runtimeState?.usageWindows && runtimeState.usageWindows.length > 0) {
        return runtimeState.usageWindows;
      }
      return provider.usageWindows;
    };

    /** The pieces of one usage window, shared by the full and the compact layout. */
    const describeWindow = (usageWindow: SubscriptionUsageWindowDefinition, barWidth: number) => {
      const displayPercent = usageWindow.usedPercent == null
        ? undefined
        : projectPercentForDisplayMode(usageWindow.usedPercent, this.displayMode);
      const thresholdNotches = this.showThresholdNotches
        ? getThresholdNotches(usageWindow.notches, this.displayMode)
        : [];
      const timelineNotch = this.showNowNotch && usageWindow.pacePercent != null
        ? projectPercentForDisplayMode(usageWindow.pacePercent, this.displayMode)
        : undefined;
      const tone = usageTone(displayPercent, this.displayMode);
      const statusText = usageWindow.statusLabel
        ? this.theme.fg(tone, usageWindow.statusLabel)
        : displayPercent == null
          ? this.theme.fg(tone, "pending")
          : this.theme.fg(
              tone,
              this.displayMode === "remaining"
                ? `${Math.round(displayPercent)}% left`
                : `${Math.round(displayPercent)}% used`,
            );
      const bar = displayPercent != null || thresholdNotches.length > 0 || timelineNotch != null
        ? renderProgressBar(this.theme, {
            width: barWidth,
            usedPercent: displayPercent ?? 0,
            notches: thresholdNotches,
            markerNotches: timelineNotch == null ? undefined : [timelineNotch],
            filledColor: tone,
            emptyColor: "dim",
            notchColor: "muted",
            markerColor: getNowMarkerColor(usageWindow.usedPercent, usageWindow.pacePercent),
          })
        : undefined;
      return { statusText, bar };
    };

    addBorder("┌", "─", "┐");
    addContentLine(this.theme.fg("accent", this.theme.bold(" Subscriptions")));

    const subtitle =
      this.providers.length > 0
        ? this.theme.fg(
            "muted",
            ` ${this.providers.length} provider tab(s) • ${this.displayMode} • reset ${this.resetTimeDisplayMode}`,
          )
        : this.theme.fg("warning", " No providers enabled");
    addContentLine(subtitle);
    addBlankLine();

    if (this.providers.length > 0) {
      const tabTokens = this.providers.map((provider, index) => {
        const count = this.accountsOf(provider).length;
        const tabText = count > 1 ? ` ${provider.shortLabel} (${count}) ` : ` ${provider.shortLabel} `;
        if (index === this.activeIndex) {
          return this.theme.bg("selectedBg", this.theme.fg("text", tabText));
        }
        return this.theme.fg("muted", tabText);
      });

      addWrappedBlock(tabTokens.join(" "));
      addBlankLine();

      const activeProvider = this.providers[this.activeIndex]!;
      const accounts = this.accountsOf(activeProvider);

      if (accounts.length <= 1) {
        // One account: the full single-provider layout.
        const account = accounts[0];
        const runtimeState = account ? this.stateOf(activeProvider, account) : undefined;
        const usageWindows = getUsageWindows(activeProvider, runtimeState);

        addWrappedBlock(this.theme.fg("accent", this.theme.bold(activeProvider.label)));
        addWrappedBlock(this.theme.fg("muted", formatStatusLine(activeProvider, runtimeState)));
        const who = [runtimeState?.account?.email, runtimeState?.account?.plan].filter(Boolean).join(" · ");
        if (who) {
          addWrappedBlock(this.theme.fg("muted", who));
        }

        if (runtimeState?.lastUpdatedAt instanceof Date) {
          addWrappedBlock(
            this.theme.fg("dim", `Updated ${runtimeState.lastUpdatedAt.toLocaleTimeString()}`),
          );
        }

        addBlankLine();

        if (runtimeState?.state === "loading") {
          addWrappedBlock(this.theme.fg("warning", "Fetching latest provider data…"));
          addBlankLine();
        }

        if (runtimeState?.state === "error" && runtimeState.errorMessage) {
          addWrappedBlock(this.theme.fg("error", runtimeState.errorMessage));
          addBlankLine();
        }

        if (usageWindows.length > 0) {
          const barWidth = contentWidth >= 80 ? 60 : contentWidth >= 56 ? 40 : 20;

          for (const usageWindow of usageWindows) {
            const { statusText, bar } = describeWindow(usageWindow, barWidth);
            addCompactLine(this.theme.fg("text", usageWindow.label), statusText);

            if (bar) {
              addContentLine(` ${bar}`);
            }

            if (usageWindow.detailLabel) {
              addWrappedBlock(this.theme.fg("dim", usageWindow.detailLabel), " ");
            }

            if (usageWindow.resetAt instanceof Date) {
              addWrappedBlock(
                this.theme.fg("dim", formatResetDetail(usageWindow.resetAt, this.resetTimeDisplayMode)),
                " ",
              );
            }

            addBlankLine();
          }
        } else {
          addWrappedBlock(this.theme.fg("warning", "No usage windows configured for this provider yet."));
          addBlankLine();
        }
      } else {
        // Several accounts: one compact section each, one line per usage window.
        addWrappedBlock(this.theme.fg("accent", this.theme.bold(activeProvider.label)));
        addWrappedBlock(this.theme.fg("muted", `${accounts.length} accounts • ${activeProvider.stability} source`));
        addBlankLine();

        const firstWithIdentity = new Map<string, string>();
        const selected = this.onUseAccount ? this.selectedIndex(activeProvider, accounts) : -1;
        const barWidth = contentWidth >= 80 ? 24 : contentWidth >= 56 ? 16 : 10;

        for (const [accountIndex, account] of accounts.entries()) {
          const runtimeState = this.stateOf(activeProvider, account);
          const identity = runtimeState?.account?.identity;
          const sameAs = identity ? firstWithIdentity.get(identity) : undefined;
          if (identity && sameAs === undefined) {
            firstWithIdentity.set(identity, account.label);
          }

          const inUse = account.providerId === this.currentProviderId;
          const name = [account.label, runtimeState?.account?.email, runtimeState?.account?.plan].filter(Boolean).join(" · ");
          const badge = sameAs
            ? this.theme.fg("warning", `same account as ${sameAs}`)
            : inUse
              ? this.theme.fg("accent", "in use")
              : "";
          const pointer = accountIndex === selected ? this.theme.fg("accent", ">") : selected >= 0 ? " " : "";
          addCompactLine(
            `${pointer}${inUse ? this.theme.fg("accent", "● ") : "  "}${this.theme.fg("accent", this.theme.bold(name))}`,
            badge,
          );

          if (runtimeState?.state === "loading") {
            addContentLine(`    ${this.theme.fg("warning", "Fetching…")}`);
          } else if (runtimeState?.state === "error") {
            addWrappedBlock(this.theme.fg("error", runtimeState.errorMessage ?? "fetch failed"), "    ");
          } else {
            const usageWindows = runtimeState?.usageWindows ?? [];
            if (usageWindows.length === 0) {
              addContentLine(`    ${this.theme.fg("dim", "No usage reported.")}`);
            }
            const labelWidth = Math.max(...usageWindows.map((usageWindow) => visibleWidth(usageWindow.label)));
            for (const usageWindow of usageWindows) {
              const { statusText, bar } = describeWindow(usageWindow, barWidth);
              const reset = usageWindow.resetAt instanceof Date
                ? this.theme.fg("dim", ` · ${formatResetDetail(usageWindow.resetAt, this.resetTimeDisplayMode)}`)
                : "";
              const label = this.theme.fg("text", usageWindow.label.padEnd(labelWidth));
              addContentLine(`    ${label}  ${bar ?? ""}  ${statusText}${reset}`);
            }
          }
          addBlankLine();
        }
      }
    } else {
      addWrappedBlock(
        this.theme.fg(
          "warning",
          "No providers are currently enabled. Press s to open provider settings and enable one or more subscription tabs.",
        ),
      );
      addBlankLine();
    }

    while (lines.length < STABLE_DIALOG_MIN_TOTAL_LINES - FOOTER_LINE_COUNT) {
      addBlankLine();
    }

    addWrappedBlock(this.theme.fg("dim", "/subscriptions close • s settings"));
    const canSwitch = this.onUseAccount !== undefined
      && this.providers[this.activeIndex] !== undefined
      && this.accountsOf(this.providers[this.activeIndex]!).length > 1;
    addContentLine(this.theme.fg(
      "dim",
      canSwitch ? "Tab/←→ switch • ↑↓ select • Enter use account • r refresh • Esc close" : "Tab/←→ switch • r refresh • Esc close",
    ));
    addBorder("└", "─", "┘");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

