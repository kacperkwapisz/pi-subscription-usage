import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UsageRecord } from "../stats/records.ts";
import { cachedShare, PERIODS, type PeriodId, type ProviderNaming, type Summary, summarize, type Totals, totalTokens } from "../stats/summary.ts";

type Color = Parameters<Theme["fg"]>[0];

/** 812, 12.4K, 94.2M, 4.21B. */
export function formatTokens(value: number): string {
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, unit] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}${unit}`;
    }
  }
  return String(Math.round(value));
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const formatUsd = (value: number) => usd.format(value);
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

const DAY = 86_400_000;
const shortDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const longDate = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });

function rangeLabel(summary: Summary): string {
  if (summary.period === "today") return longDate.format(summary.to);
  return shortDate.formatRange(summary.from, summary.to);
}

const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const CHART_ROWS = 5;

export interface StatsViewOptions {
  load: (onProgress: (done: number, total: number) => void) => Promise<UsageRecord[]>;
  naming: ProviderNaming;
  theme: Theme;
  requestRender: () => void;
  onClose: () => void;
  now?: () => number;
}

/**
 * Token use, cache share and API price for every priced provider, all accounts included,
 * over a period. Made to read well as a screenshot: no emails, no project paths.
 */
export class StatsView {
  private readonly options: StatsViewOptions;
  private readonly theme: Theme;
  private records?: UsageRecord[];
  private error?: string;
  private progress = { done: 0, total: 0 };
  private period: PeriodId = "week";
  private summaries = new Map<PeriodId, Summary>();
  private cache?: { width: number; lines: string[] };

  constructor(options: StatsViewOptions) {
    this.options = options;
    this.theme = options.theme;
    this.reload();
  }

  private reload(): void {
    this.records = undefined;
    this.error = undefined;
    this.summaries.clear();
    this.progress = { done: 0, total: 0 };
    this.changed();
    this.options
      .load((done, total) => {
        this.progress = { done, total };
        this.changed();
      })
      .then((records) => {
        this.records = records;
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => this.changed());
  }

  private changed(): void {
    this.cache = undefined;
    this.options.requestRender();
  }

  private summary(): Summary | undefined {
    if (!this.records) return undefined;
    let summary = this.summaries.get(this.period);
    if (!summary) {
      summary = summarize(this.records, this.period, this.options.naming, this.options.now?.() ?? Date.now());
      this.summaries.set(this.period, summary);
    }
    return summary;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
      this.options.onClose();
      return;
    }
    if (matchesKey(data, "r")) {
      this.reload();
      return;
    }
    const index = PERIODS.findIndex((period) => period.id === this.period);
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) this.period = PERIODS[(index + 1) % PERIODS.length]!.id;
    else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) this.period = PERIODS[(index - 1 + PERIODS.length) % PERIODS.length]!.id;
    else return;
    this.changed();
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const lines = this.build(width);
    this.cache = { width, lines };
    return lines;
  }

  private build(width: number): string[] {
    const t = this.theme;
    const outer = Math.max(48, Math.min(82, width));
    const inner = outer - 2;
    const pad = 3;
    const content = inner - pad * 2;
    const margin = " ".repeat(Math.max(0, Math.floor((width - outer) / 2)));
    const lines: string[] = [];
    const border = (text: string) => t.fg("border", text);
    const row = (text = "") => {
      const fitted = truncateToWidth(text, content, "…");
      lines.push(`${margin}${border("│")}${" ".repeat(pad)}${fitted}${" ".repeat(Math.max(0, content - visibleWidth(fitted)))}${" ".repeat(pad)}${border("│")}`);
    };
    const split = (left: string, right: string) => row(`${left}${" ".repeat(Math.max(1, content - visibleWidth(left) - visibleWidth(right)))}${right}`);

    lines.push(`${margin}${border(`╭${"─".repeat(inner)}╮`)}`);
    row();
    const summary = this.summary();
    const periodLabel = PERIODS.find((period) => period.id === this.period)!.label;
    split(t.fg("accent", t.bold("Pi usage")), summary ? t.fg("muted", `${periodLabel === "Today" ? "Today" : periodLabel === "All time" ? "All time" : `Last ${periodLabel}`} · ${rangeLabel(summary)}`) : "");
    row();

    if (this.error) {
      row(t.fg("error", `Couldn't read sessions: ${this.error}`));
      row();
    } else if (!summary) {
      const { done, total } = this.progress;
      row(t.fg("muted", total ? `Reading sessions… ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` : "Reading sessions…"));
      const barWidth = Math.min(40, content);
      const filled = total ? Math.round((done / total) * barWidth) : 0;
      row(`${t.fg("accent", "━".repeat(filled))}${t.fg("dim", "━".repeat(barWidth - filled))}`);
      row(t.fg("dim", "The first time takes a while; after that only new replies are read."));
      row();
    } else if (summary.totals.replies === 0) {
      row(t.fg("muted", "No priced usage in this period."));
      row();
    } else {
      this.renderHeadline(summary, content, row);
      row();
      this.renderChart(summary, content, row, split);
      row();
      this.renderTable("Provider", summary, content, row);
      row();
      this.renderModels(summary, content, row);
      row();
      const { totals } = summary;
      row(t.fg("dim", `In ${formatTokens(totals.input)} · Out ${formatTokens(totals.output)} · Cache read ${formatTokens(totals.cacheRead)} · Cache write ${formatTokens(totals.cacheWrite)}`));
      const subagents = summary.subagentShare > 0 ? ` · ${percent(summary.subagentShare)} from subagents` : "";
      row(t.fg("dim", `${totals.replies.toLocaleString("en-US")} replies${subagents} · API prices in USD`));
      row();
    }

    const tabs = PERIODS.map((period) =>
      period.id === this.period ? t.bg("selectedBg", t.fg("text", ` ${period.label} `)) : t.fg("muted", ` ${period.label} `),
    ).join(" ");
    split(tabs, t.fg("dim", "←→ · r · Esc"));
    row();
    lines.push(`${margin}${border(`╰${"─".repeat(inner)}╯`)}`);
    return lines;
  }

  private renderHeadline(summary: Summary, content: number, row: (text?: string) => void): void {
    const t = this.theme;
    const cells: [string, string, Color][] = [
      [formatTokens(totalTokens(summary.totals)), "tokens", "accent"],
      [percent(cachedShare(summary.totals)), "cached", "success"],
      [formatUsd(summary.totals.cost), "at API prices", "warning"],
    ];
    const cell = Math.floor(content / cells.length);
    const line = (pick: (entry: [string, string, Color]) => string) =>
      cells.map((entry) => {
        const text = pick(entry);
        return text + " ".repeat(Math.max(1, cell - visibleWidth(text)));
      }).join("");
    row(line(([value, , color]) => t.fg(color, t.bold(value))));
    row(line(([, label]) => t.fg("muted", label)));
  }

  private renderChart(summary: Summary, content: number, row: (text?: string) => void, split: (left: string, right: string) => void): void {
    const t = this.theme;
    let buckets = summary.chart.buckets;
    let bucketMs = summary.chart.bucketMs;
    // Too many buckets for the width: merge neighbours.
    while (buckets.length > content) {
      const merged: number[] = [];
      for (let i = 0; i < buckets.length; i += 2) merged.push(buckets[i]! + (buckets[i + 1] ?? 0));
      buckets = merged;
      bucketMs *= 2;
    }
    const slot = Math.max(1, Math.floor(content / buckets.length));
    const bar = slot >= 3 ? slot - 1 : slot;
    const max = Math.max(...buckets, 1);
    const peakIndex = buckets.indexOf(max);
    const peakAt = summary.chart.start + peakIndex * bucketMs;
    const peakWhen = summary.period === "today" ? `${new Date(peakAt).getHours()}:00` : bucketMs > DAY ? `week of ${shortDate.format(peakAt)}` : longDate.format(peakAt);
    split(t.fg("muted", "Tokens"), t.fg("dim", `peak ${formatTokens(max)} · ${peakWhen}`));

    for (let level = CHART_ROWS - 1; level >= 0; level--) {
      const cells = buckets.map((value) => {
        const eighths = Math.round((value / max) * CHART_ROWS * 8) - level * 8;
        const block = value > 0 && level === 0 && eighths <= 0 ? BLOCKS[1]! : BLOCKS[Math.max(0, Math.min(8, eighths))]!;
        const colored = block === " " ? " ".repeat(bar) : t.fg("accent", block.repeat(bar));
        return colored + " ".repeat(slot - bar);
      });
      row(cells.join(""));
    }
    row(t.fg("dim", "─".repeat(Math.min(content, slot * buckets.length))));

    // Labels under the bars.
    if (summary.period === "week" && slot >= 3) {
      row(t.fg("dim", buckets.map((_, i) => truncateToWidth(weekday.format(summary.chart.start + i * bucketMs), slot, "").padEnd(slot)).join("")));
    } else if (summary.period === "today") {
      const marks = [0, 6, 12, 18];
      let text = "";
      for (const hour of marks) text = text.padEnd(hour * slot) + `${hour}:00`;
      row(t.fg("dim", text));
    } else {
      const first = shortDate.format(summary.chart.start);
      const last = shortDate.format(summary.to);
      const span = Math.min(content, slot * buckets.length);
      row(t.fg("dim", `${first}${" ".repeat(Math.max(1, span - first.length - last.length))}${last}`));
    }
  }

  private columns(content: number) {
    const numbers = 8 + 2 + 7 + 2 + 11;
    const bar = content - numbers >= 32 ? 10 : 0;
    const name = content - numbers - (bar ? bar + 2 : 0) - 2;
    return { name, bar };
  }

  private tableRow(name: string, totals: Totals, share: number | undefined, content: number, style: { name: Color; numbers: Color; bold?: boolean }): string {
    const t = this.theme;
    const { name: nameWidth, bar } = this.columns(content);
    const label = truncateToWidth(name, nameWidth, "…").padEnd(nameWidth);
    const nums = `${formatTokens(totalTokens(totals)).padStart(8)}  ${percent(cachedShare(totals)).padStart(7)}  ${formatUsd(totals.cost).padStart(11)}`;
    const shareBar = bar && share !== undefined
      ? `  ${t.fg("accent", "■".repeat(Math.max(1, Math.round(share * bar))))}${t.fg("dim", "·".repeat(bar - Math.max(1, Math.round(share * bar))))}`
      : "";
    const styledName = style.bold ? t.bold(t.fg(style.name, label)) : t.fg(style.name, label);
    return `${styledName}  ${t.fg(style.numbers, nums)}${shareBar}`;
  }

  private header(title: string, content: number): string {
    const { name } = this.columns(content);
    return this.theme.fg("dim", `${title.padEnd(name)}  ${"Tokens".padStart(8)}  ${"Cached".padStart(7)}  ${"API price".padStart(11)}`);
  }

  private renderTable(title: string, summary: Summary, content: number, row: (text?: string) => void): void {
    row(this.header(title, content));
    const all = totalTokens(summary.totals);
    for (const provider of summary.providers) {
      row(this.tableRow(provider.label, provider.totals, totalTokens(provider.totals) / all, content, { name: "text", numbers: "text", bold: true }));
      if (provider.accounts.length > 1) {
        for (const account of provider.accounts) row(this.tableRow(`  ${account.label}`, account.totals, undefined, content, { name: "muted", numbers: "muted" }));
      }
    }
  }

  private renderModels(summary: Summary, content: number, row: (text?: string) => void): void {
    row(this.header("Model", content));
    const all = totalTokens(summary.totals);
    const shown = summary.models.slice(0, 5);
    for (const model of shown) row(this.tableRow(model.model, model.totals, totalTokens(model.totals) / all, content, { name: "text", numbers: "muted" }));
    const rest = summary.models.length - shown.length;
    if (rest > 0) row(this.theme.fg("dim", `and ${rest} more`));
  }
}
