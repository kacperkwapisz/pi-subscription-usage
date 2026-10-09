import type { UsageRecord } from "./records.ts";

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  replies: number;
}

export const emptyTotals = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, replies: 0 });

function add(totals: Totals, record: UsageRecord): void {
  totals.input += record.input;
  totals.output += record.output;
  totals.cacheRead += record.cacheRead;
  totals.cacheWrite += record.cacheWrite;
  totals.cost += record.cost;
  totals.replies += 1;
}

/** Every token the model read or wrote. */
export const totalTokens = (t: Totals) => t.input + t.output + t.cacheRead + t.cacheWrite;

/** Share of the prompt that came from the cache, 0–1. */
export function cachedShare(t: Totals): number {
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  return prompt > 0 ? t.cacheRead / prompt : 0;
}

export type PeriodId = "today" | "week" | "month" | "all";

export const PERIODS: { id: PeriodId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "7 days" },
  { id: "month", label: "30 days" },
  { id: "all", label: "All time" },
];

const DAY = 86_400_000;

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Where a period starts: local midnight today, 7 or 30 days back (today included), or the first reply. */
export function periodStart(period: PeriodId, now: number, first: number): number {
  const today = startOfDay(now);
  if (period === "today") return today;
  if (period === "week") return today - 6 * DAY;
  if (period === "month") return today - 29 * DAY;
  return startOfDay(first);
}

export interface Account {
  providerId: string;
  label: string;
  totals: Totals;
}

export interface ProviderGroup {
  /** e.g. "anthropic". */
  id: string;
  label: string;
  totals: Totals;
  /** Its accounts, busiest first (one entry when it has a single account). */
  accounts: Account[];
}

export interface Summary {
  period: PeriodId;
  from: number;
  to: number;
  totals: Totals;
  providers: ProviderGroup[];
  models: { model: string; totals: Totals }[];
  /** Tokens per bucket for the chart: hours for today, days otherwise (weeks past 90 days). */
  chart: { buckets: number[]; bucketMs: number; start: number };
  /** Share of tokens from subagents, 0–1. */
  subagentShare: number;
}

export interface ProviderNaming {
  /** The group a Pi provider id belongs to, e.g. "anthropic-account-3" → "anthropic". */
  group(providerId: string): string;
  groupLabel(group: string): string;
  accountLabel(providerId: string): string;
}

export function summarize(records: UsageRecord[], period: PeriodId, naming: ProviderNaming, now = Date.now()): Summary {
  const first = records.reduce((min, record) => Math.min(min, record.at), now);
  const from = periodStart(period, now, first);
  const inPeriod = records.filter((record) => record.at >= from && record.at <= now);

  const totals = emptyTotals();
  const groups = new Map<string, { totals: Totals; accounts: Map<string, Totals> }>();
  const models = new Map<string, Totals>();
  let subagentTokens = 0;

  const span = now - from;
  const bucketMs = period === "today" ? 3_600_000 : span > 90 * DAY ? 7 * DAY : DAY;
  const bucketCount = period === "today" ? 24 : Math.max(1, Math.ceil((startOfDay(now) + DAY - from) / bucketMs));
  const buckets = new Array<number>(bucketCount).fill(0);

  for (const record of inPeriod) {
    add(totals, record);
    const id = naming.group(record.provider);
    let group = groups.get(id);
    if (!group) groups.set(id, (group = { totals: emptyTotals(), accounts: new Map() }));
    add(group.totals, record);
    let account = group.accounts.get(record.provider);
    if (!account) group.accounts.set(record.provider, (account = emptyTotals()));
    add(account, record);
    let model = models.get(record.model);
    if (!model) models.set(record.model, (model = emptyTotals()));
    add(model, record);
    const tokens = record.input + record.output + record.cacheRead + record.cacheWrite;
    if (record.subagent) subagentTokens += tokens;
    const index = Math.min(bucketCount - 1, Math.floor((record.at - from) / bucketMs));
    buckets[index]! += tokens;
  }

  const byTokens = (a: { totals: Totals }, b: { totals: Totals }) => totalTokens(b.totals) - totalTokens(a.totals);
  const providers = [...groups.entries()]
    .map(([id, group]) => ({
      id,
      label: naming.groupLabel(id),
      totals: group.totals,
      accounts: [...group.accounts.entries()]
        .map(([providerId, accountTotals]) => ({ providerId, label: naming.accountLabel(providerId), totals: accountTotals }))
        .sort(byTokens),
    }))
    .sort(byTokens);

  return {
    period,
    from,
    to: now,
    totals,
    providers,
    models: [...models.entries()].map(([model, modelTotals]) => ({ model, totals: modelTotals })).sort(byTokens),
    chart: { buckets, bucketMs, start: from },
    subagentShare: totalTokens(totals) > 0 ? subagentTokens / totalTokens(totals) : 0,
  };
}
