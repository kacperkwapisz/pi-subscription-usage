import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One priced model reply, as Pi stored it in a session file. */
export interface UsageRecord {
  /** When the reply was made (ms). */
  at: number;
  /** Pi provider id, e.g. "anthropic-account-3". */
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** What the reply would cost at the model's API prices, in USD. */
  cost: number;
  /** Made by a subagent (pi-subagents keeps those sessions separately). */
  subagent: boolean;
  /** Identifies the reply, so the same one in two files (forked sessions copy history) counts once. */
  key: string;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * A reply from one session-file line, or undefined. Replies without an API price (cost 0, as
 * for providers Pi has no prices for) are left out.
 */
export function parseLine(line: string, subagent: boolean): UsageRecord | undefined {
  // Cheap checks first: most lines are tool results, user messages and other entries.
  if (!line.includes('"role":"assistant"') || !line.includes('"usage"')) return undefined;
  let entry: { type?: string; message?: Record<string, unknown> };
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const message = entry.message;
  if (entry.type !== "message" || message?.role !== "assistant") return undefined;
  const usage = message.usage as Record<string, unknown> | undefined;
  const cost = num((usage?.cost as Record<string, unknown> | undefined)?.total);
  if (!usage || cost <= 0) return undefined;
  const at = num(message.timestamp);
  const provider = typeof message.provider === "string" ? message.provider : "";
  const model = typeof message.model === "string" ? message.model : "";
  if (!at || !provider) return undefined;
  const output = num(usage.output);
  const key = typeof message.responseId === "string" && message.responseId ? message.responseId : `${at}|${provider}|${model}|${output}`;
  return { at, provider, model, input: num(usage.input), output, cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite), cost, subagent, key };
}

const MARKER = Buffer.from('"role":"assistant"');

/**
 * Replies in `file` from byte `from` on, and where complete lines end (the next start). Reads in
 * chunks and lets Pi breathe between them, since a session file can be hundreds of megabytes.
 * Only lines holding an assistant message are decoded; tool output and the rest are skipped.
 */
export async function readFrom(file: string, from: number, subagent: boolean): Promise<{ records: UsageRecord[]; end: number }> {
  const handle = await open(file, "r");
  const records: UsageRecord[] = [];
  let end = from;
  try {
    const size = (await handle.stat()).size;
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    let offset = from;
    let carry = Buffer.alloc(0);
    while (offset < size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const lastNewline = data.lastIndexOf(10);
      const complete = lastNewline + 1;
      for (let hit = data.indexOf(MARKER); hit !== -1 && hit < complete; ) {
        const lineStart = data.lastIndexOf(10, hit) + 1;
        const lineEnd = data.indexOf(10, hit);
        const record = parseLine(data.toString("utf8", lineStart, lineEnd), subagent);
        if (record) records.push(record);
        hit = data.indexOf(MARKER, lineEnd + 1);
      }
      end = offset - (data.length - complete);
      carry = Buffer.from(data.subarray(complete));
      await yieldToUi();
    }
  } finally {
    await handle.close();
  }
  // A last line without a newline is still being written: it's read next time.
  return { records, end };
}

export interface SessionSource {
  dir: string;
  subagent: boolean;
}

/** Every session file under the sources: `<dir>/<group>/*.jsonl`, listed in parallel. */
export async function listSessionFiles(sources: SessionSource[]): Promise<{ file: string; subagent: boolean }[]> {
  const lists = await Promise.all(
    sources.map(async (source) => {
      const groups = await readdir(source.dir, { withFileTypes: true }).catch(() => []);
      const inGroups = await Promise.all(
        groups
          .filter((group) => group.isDirectory())
          .map(async (group) => {
            const names = await readdir(join(source.dir, group.name)).catch(() => [] as string[]);
            return names.filter((name) => name.endsWith(".jsonl")).map((name) => ({ file: join(source.dir, group.name, name), subagent: source.subagent }));
          }),
      );
      return inGroups.flat();
    }),
  );
  return lists.flat().sort((a, b) => (a.file < b.file ? -1 : 1));
}

const yieldToUi = () => new Promise((resolve) => setImmediate(resolve));

/** A 53-bit hash of a reply's key, for spotting the same reply in two files. */
export function hashKey(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * The cache: a small JSON header (files, their sizes, where their replies are) followed by every
 * reply as ten numbers, so opening /stats needs no parsing of a large file.
 */
const FIELDS = 10;
const CACHE_VERSION = 2;

interface CachedFile {
  size: number;
  mtimeMs: number;
  /** Where the next unread line starts. */
  end: number;
  /** Replies of this file, FIELDS numbers each. */
  data: Float64Array;
}

interface Header {
  version: number;
  strings: string[];
  files: Record<string, { size: number; mtimeMs: number; end: number; count: number }>;
}

function readCache(cacheFile: string): { strings: string[]; files: Map<string, CachedFile> } {
  const empty = { strings: [] as string[], files: new Map<string, CachedFile>() };
  let raw: Buffer;
  try {
    raw = readFileSync(cacheFile);
  } catch {
    return empty;
  }
  try {
    const headerLength = raw.readUInt32LE(0);
    const header = JSON.parse(raw.toString("utf8", 4, 4 + headerLength)) as Header;
    if (header.version !== CACHE_VERSION) return empty;
    const dataStart = 4 + headerLength;
    const all = new Float64Array(raw.buffer.slice(raw.byteOffset + dataStart, raw.byteOffset + raw.length));
    const files = new Map<string, CachedFile>();
    let at = 0;
    for (const [file, entry] of Object.entries(header.files)) {
      files.set(file, { size: entry.size, mtimeMs: entry.mtimeMs, end: entry.end, data: all.subarray(at, at + entry.count * FIELDS) });
      at += entry.count * FIELDS;
    }
    return { strings: header.strings, files };
  } catch {
    return empty;
  }
}

function writeCache(cacheFile: string, strings: string[], files: Map<string, CachedFile>): void {
  const header: Header = { version: CACHE_VERSION, strings, files: {} };
  let total = 0;
  for (const [file, entry] of files) {
    header.files[file] = { size: entry.size, mtimeMs: entry.mtimeMs, end: entry.end, count: entry.data.length / FIELDS };
    total += entry.data.length;
  }
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  // Data starts on an 8-byte boundary so it can be read back as Float64Array directly.
  const padded = Math.ceil((4 + headerBytes.length) / 8) * 8 - 4;
  const out = Buffer.alloc(4 + padded + total * 8);
  out.writeUInt32LE(padded, 0);
  headerBytes.copy(out, 4);
  out.fill(0x20, 4 + headerBytes.length, 4 + padded);
  let at = 4 + padded;
  for (const entry of files.values()) {
    Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength).copy(out, at);
    at += entry.data.byteLength;
  }
  mkdirSync(dirname(cacheFile), { recursive: true });
  const temp = `${cacheFile}.${process.pid}.tmp`;
  writeFileSync(temp, out, { mode: 0o600 });
  renameSync(temp, cacheFile);
}

/**
 * Reads every reply from the session files, reusing what an earlier read cached: a file that
 * only grew is read from where it left off (Pi only appends), a changed one again in full.
 * The same reply in two files (a forked session copies its history) is counted once.
 */
export async function loadRecords(options: {
  sources: SessionSource[];
  cacheFile: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<UsageRecord[]> {
  const cache = readCache(options.cacheFile);
  const strings = cache.strings;
  const stringIndex = new Map(strings.map((value, index) => [value, index]));
  const intern = (value: string) => {
    let index = stringIndex.get(value);
    if (index === undefined) {
      index = strings.length;
      strings.push(value);
      stringIndex.set(value, index);
    }
    return index;
  };
  const encode = (records: UsageRecord[]) => {
    const data = new Float64Array(records.length * FIELDS);
    records.forEach((r, i) => {
      data.set([r.at, intern(r.provider), intern(r.model), r.input, r.output, r.cacheRead, r.cacheWrite, r.cost, r.subagent ? 1 : 0, hashKey(r.key)], i * FIELDS);
    });
    return data;
  };

  const files = await listSessionFiles(options.sources);
  const stats = await Promise.all(files.map(({ file }) => stat(file).catch(() => undefined)));
  const next = new Map<string, CachedFile>();
  let changed = [...cache.files.keys()].some((file) => !files.some((entry) => entry.file === file));
  let lastYield = Date.now();
  for (const [index, { file, subagent }] of files.entries()) {
    const info = stats[index];
    if (!info) continue;
    const cached = cache.files.get(file);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      next.set(file, cached);
    } else {
      const grew = cached !== undefined && info.size > cached.size && cached.end <= info.size;
      try {
        const { records, end } = await readFrom(file, grew ? cached.end : 0, subagent);
        const fresh = encode(records);
        const data = grew ? new Float64Array(cached.data.length + fresh.length) : fresh;
        if (grew) {
          data.set(cached.data);
          data.set(fresh, cached.data.length);
        }
        next.set(file, { size: info.size, mtimeMs: info.mtimeMs, end, data });
      } catch {
        continue;
      }
      changed = true;
    }
    // Keep Pi responsive and show progress during a long first read.
    if (Date.now() - lastYield > 30) {
      options.onProgress?.(index + 1, files.length);
      await yieldToUi();
      lastYield = Date.now();
    }
  }
  options.onProgress?.(files.length, files.length);

  if (changed) {
    try {
      writeCache(options.cacheFile, strings, next);
    } catch {
      // The cache only saves time; reading works without it.
    }
  }

  const seen = new Set<number>();
  const records: UsageRecord[] = [];
  for (const entry of next.values()) {
    const d = entry.data;
    for (let i = 0; i < d.length; i += FIELDS) {
      const key = d[i + 9]!;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({
        at: d[i]!, provider: strings[d[i + 1]!]!, model: strings[d[i + 2]!]!, input: d[i + 3]!, output: d[i + 4]!,
        cacheRead: d[i + 5]!, cacheWrite: d[i + 6]!, cost: d[i + 7]!, subagent: d[i + 8] === 1, key: String(key),
      });
    }
  }
  return records;
}
