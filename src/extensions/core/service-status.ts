/**
 * A provider's public status page (Atlassian Statuspage: status.claude.com, status.openai.com),
 * so a failed usage load or a failed request can be told apart from an outage.
 */

export type ServiceStatusLevel = "operational" | "maintenance" | "minor" | "major" | "critical";

export interface ServiceStatus {
  /** e.g. "status.claude.com". */
  page: string;
  level: ServiceStatusLevel;
  /** The page's own summary, e.g. "Partially Degraded Service". */
  description: string;
  /** Open incidents and parts not working, e.g. "Elevated errors on platform.claude.com (monitoring)". */
  problems: string[];
  checkedAt: Date;
}

export type ServiceStatusResult = { ok: true; status: ServiceStatus } | { ok: false; page: string; error: string };

const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;

interface Component {
  name?: string;
  status?: string;
  group?: boolean;
}
interface Incident {
  name?: string;
  status?: string;
  impact?: string;
}
interface Summary {
  status?: { indicator?: string; description?: string };
  components?: Component[];
  incidents?: Incident[];
  scheduled_maintenances?: Incident[];
}

const COMPONENT_WORDS: Record<string, string> = {
  degraded_performance: "slow",
  partial_outage: "partial outage",
  major_outage: "outage",
  under_maintenance: "maintenance",
};

/** Reads a Statuspage summary into what the dialog and error messages show. */
export function parseSummary(page: string, summary: Summary, checkedAt = new Date()): ServiceStatus {
  const indicator = summary.status?.indicator ?? "none";
  const incidents = (summary.incidents ?? []).filter((incident) => incident.status !== "resolved" && incident.status !== "postmortem");
  const maintenances = (summary.scheduled_maintenances ?? []).filter((maintenance) => maintenance.status === "in_progress");
  const broken = (summary.components ?? []).filter((component) => !component.group && component.status && component.status !== "operational");

  const problems = [
    ...incidents.map((incident) => `${incident.name ?? "Incident"}${incident.status ? ` (${incident.status.replace(/_/g, " ")})` : ""}`),
    ...maintenances.map((maintenance) => `Maintenance: ${maintenance.name ?? "in progress"}`),
    ...broken.map((component) => `${component.name}: ${COMPONENT_WORDS[component.status!] ?? component.status!.replace(/_/g, " ")}`),
  ];

  let level: ServiceStatusLevel =
    indicator === "critical" ? "critical" : indicator === "major" ? "major" : indicator === "minor" ? "minor" : indicator === "maintenance" ? "maintenance" : "operational";
  if (level === "operational" && maintenances.length > 0) level = "maintenance";
  if (level === "operational" && (incidents.length > 0 || broken.length > 0)) level = "minor";

  return {
    page,
    level,
    description: level === "operational" ? "All systems operational" : (summary.status?.description ?? "Some systems affected"),
    problems,
    checkedAt,
  };
}

/** One line: "status.claude.com: Partially Degraded Service. Elevated errors on … (monitoring)". */
export function describeStatus(result: ServiceStatusResult): string {
  if (!result.ok) return `Couldn't check ${result.page}`;
  const { page, description, problems } = result.status;
  return problems.length > 0 ? `${page}: ${description}. ${problems.join("; ")}` : `${page}: ${description}`;
}

type Fetch = typeof fetch;

/** Fetches status pages, at most once a minute per page. */
export class ServiceStatusReader {
  private readonly cache = new Map<string, { at: number; result: Promise<ServiceStatusResult> }>();
  private readonly fetchImpl: Fetch;

  constructor(fetchImpl: Fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  read(page: string, options: { fresh?: boolean } = {}): Promise<ServiceStatusResult> {
    const cached = this.cache.get(page);
    if (cached && !options.fresh && Date.now() - cached.at < CACHE_MS) return cached.result;
    const result = this.load(page);
    this.cache.set(page, { at: Date.now(), result });
    return result;
  }

  private async load(page: string): Promise<ServiceStatusResult> {
    try {
      const response = await this.fetchImpl(`https://${page}/api/v2/summary.json`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) return { ok: false, page, error: `HTTP ${response.status}` };
      return { ok: true, status: parseSummary(page, (await response.json()) as Summary) };
    } catch (error) {
      // A failed check isn't kept: the next look tries again.
      this.cache.delete(page);
      return { ok: false, page, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
