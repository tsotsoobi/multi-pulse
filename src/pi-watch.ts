import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HORIZON_MAX_PAGES,
  HORIZON_PAGE_LIMIT,
  PI_BLIND_AFTER,
  PI_HORIZON_URL,
  PI_SLOW_EVERY,
  PI_WATCH_MS,
} from "./config.js";
import { getJson } from "./venues/stellar.js";

/**
 * Pi mainnet, watched read-only. Phase 0 of docs/pi-mainnet.md.
 *
 * A separate process, never part of the monitor loop: with zero assets and zero
 * pools on Pi mainnet a venue would tick every minute pricing nothing, and a new
 * process means the running monitor is never restarted or touched.
 *
 * Read-only by construction, as the rest of the repo is. Every request goes
 * through getJson from the Stellar venue, which pins GET, sends no body and no
 * Authorization header. There is no key, no Stellar SDK, no endpoint that
 * writes, and no new library. Alerts go to stdout and data/pi-alerts.log and
 * nowhere else (decided 23 September 2026, section 3.5).
 *
 * The Stellar venue's walkShard is deliberately NOT what walks Pi here. It
 * normalises every record through toPool and discards the raw one, and toPool
 * rejects a pool whose reserves are zero. A pool exists with zero reserves
 * from the moment it is created until its first deposit, so walking Pi with
 * walkShard would hide exactly the first-pool event Phase 2 is triggered by.
 * walkAll below keeps records verbatim and keeps the same termination rule.
 */

export type GetJson = (url: string) => Promise<any>;
export type Endpoint = "assets" | "pools" | "root";
type Kind = "assets" | "pools";

export interface PiPaths {
  /** One line per poll: the coverage record. */
  watch: string;
  assets: string;
  pools: string;
  protocol: string;
  alerts: string;
}

export const PI_PATHS: PiPaths = {
  watch: "data/pi-watch.jsonl",
  assets: "data/pi-assets.jsonl",
  pools: "data/pi-pools.jsonl",
  protocol: "data/pi-protocol.jsonl",
  alerts: "data/pi-alerts.log",
};

/**
 * Top-level record fields left out when deciding whether a record CHANGED.
 * The record is still written verbatim; only the comparison skips them.
 *
 * Empty on purpose: nothing has been observed to churn yet, and every field
 * of a real record is assumed to mean something until a poll shows otherwise.
 * If a SUSPECT CHURN alert names a field that changes on every poll without
 * saying anything (a ledger number, a timestamp), the fix is to add it here.
 * Until then every poll writes a "changed" line for every record, and the
 * files grow without limit while recording nothing.
 */
const IGNORED_FIELDS: Record<Kind, readonly string[]> = {
  assets: [],
  pools: [],
};

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

export interface WalkResult {
  records: unknown[];
  pages: number;
  truncated: boolean;
}

/**
 * Walk a Horizon collection to exhaustion, keeping every record verbatim.
 *
 * Termination is the zero-record page, as in walkShard, never a missing `next`
 * link and never a short page. Two things are stricter than walkShard, because
 * here a silent zero is the failure that matters most:
 *
 *   - a page with no `_embedded.records` array throws instead of counting as
 *     empty. Otherwise an error document served with a 200 would read as "no
 *     assets exist", which is the one answer this watcher reports on.
 *   - a non-empty page with no `next` link throws instead of ending the walk,
 *     so a walk cannot quietly stop partway.
 *
 * A paging link to any origin other than the first URL's is refused. Horizon
 * builds `next` from its own idea of its host name, which has not been checked
 * on Pi, and this watcher talks to one host only.
 */
export async function walkAll(
  firstUrl: string,
  get: GetJson = getJson,
  maxPages: number = HORIZON_MAX_PAGES,
): Promise<WalkResult> {
  const origin = new URL(firstUrl).origin;
  const out: WalkResult = { records: [], pages: 0, truncated: false };
  let url = firstUrl;

  for (;;) {
    if (out.pages >= maxPages) {
      out.truncated = true;
      break;
    }
    if (new URL(url).origin !== origin) {
      throw new Error(`refusing paging link to another origin: ${url}`);
    }

    const page = await get(url);
    out.pages++;

    const records = page?._embedded?.records;
    if (!Array.isArray(records)) {
      throw new Error(`no _embedded.records in the page from ${url}`);
    }
    // The terminator. An empty page means the cursor has run off the end.
    if (records.length === 0) break;
    out.records.push(...records);

    const next = page?._links?.next?.href;
    if (typeof next !== "string" || next.length === 0) {
      throw new Error(`non-empty page without a next link from ${url}`);
    }
    url = next;
  }
  return out;
}

/**
 * Which endpoints a tick polls, given what /assets showed on this same tick.
 *
 * /assets is not in the result because it is polled on every tick, first.
 * Pools follow it: hourly while no asset exists, since a pool needs a
 * non-native asset (section 3.2, inferred; the hourly poll guards against the
 * inference being wrong on Pi), and every tick once one does.
 */
export function duePolls(tick: number, assetsEmpty: boolean): Endpoint[] {
  const slow = tick % PI_SLOW_EVERY === 0;
  const due: Endpoint[] = [];
  if (!assetsEmpty || slow) due.push("pools");
  if (slow) due.push("root");
  return due;
}

/**
 * Requests per day while /assets and /liquidity_pools are both empty: each
 * walk is one page, /assets every tick, pools and root every PI_SLOW_EVERY
 * ticks. 144 + 24 + 24 = 192 at the configured values (section 3.3).
 */
export function idleRequestsPerDay(): number {
  const ticks = Math.floor(86_400_000 / PI_WATCH_MS);
  return ticks + 2 * Math.ceil(ticks / PI_SLOW_EVERY);
}

// ---------------------------------------------------------------------------
// Keys, comparison and diffing
// ---------------------------------------------------------------------------

/** "CODE:ISSUER", the same form Horizon uses in a pool's reserves[].asset. */
export function assetKeyOf(r: unknown): string | null {
  const code = (r as any)?.asset_code;
  const issuer = (r as any)?.asset_issuer;
  return typeof code === "string" && code.length > 0 &&
    typeof issuer === "string" && issuer.length > 0
    ? `${code}:${issuer}`
    : null;
}

export function poolKeyOf(r: unknown): string | null {
  const id = (r as any)?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The pool's two reserve assets, sorted, joined with "|". */
export function pairOf(r: unknown): string | null {
  const assets = poolAssets(r);
  return assets ? [...assets].sort().join("|") : null;
}

function poolAssets(r: unknown): [string, string] | null {
  const reserves = (r as any)?.reserves;
  if (!Array.isArray(reserves) || reserves.length !== 2) return null;
  const a = reserves[0]?.asset;
  const b = reserves[1]?.asset;
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return null;
  return [a, b];
}

/** JSON with object keys sorted, so field order alone is never a change. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function comparable(r: unknown, ignored: readonly string[]): string {
  if (ignored.length === 0 || r === null || typeof r !== "object") {
    return stableJson(r);
  }
  const copy: Record<string, unknown> = { ...(r as Record<string, unknown>) };
  for (const f of ignored) delete copy[f];
  return stableJson(copy);
}

export interface KindState {
  /** Key to the last record written for it. */
  current: Map<string, unknown>;
  /** Whether the files have ever held a record of this kind. */
  everSeen: boolean;
}

export interface Diff {
  added: string[];
  changed: string[];
  gone: string[];
  /** Records the key function could not read. Never counted as gone. */
  unkeyed: unknown[];
  /** The walk's records by key: the state after this poll. */
  next: Map<string, unknown>;
}

/**
 * What a complete walk says has changed since the known set.
 *
 * `gone` is only meaningful for a complete walk. The caller discards it for a
 * truncated one, where an absent key means "not reached", not "removed".
 */
export function diffRecords(
  known: Map<string, unknown>,
  walked: unknown[],
  keyOf: (r: unknown) => string | null,
  ignored: readonly string[] = [],
): Diff {
  const next = new Map<string, unknown>();
  const unkeyed: unknown[] = [];
  for (const r of walked) {
    const k = keyOf(r);
    if (k === null) unkeyed.push(r);
    else next.set(k, r);
  }

  const added: string[] = [];
  const changed: string[] = [];
  for (const [k, r] of next) {
    if (!known.has(k)) added.push(k);
    else if (comparable(known.get(k), ignored) !== comparable(r, ignored)) {
      changed.push(k);
    }
  }
  const gone = [...known.keys()].filter((k) => !next.has(k));
  return { added, changed, gone, unkeyed, next };
}

/**
 * For each top-level field, how many of the changed records differ in it.
 * Sorted most frequent first, so a field that churns on every record leads.
 */
export function changedFields(
  before: Map<string, unknown>,
  after: Map<string, unknown>,
  changed: string[],
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const k of changed) {
    const a = (before.get(k) ?? {}) as Record<string, unknown>;
    const b = (after.get(k) ?? {}) as Record<string, unknown>;
    const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const f of fields) {
      if (stableJson(a[f]) !== stableJson(b[f])) {
        counts.set(f, (counts.get(f) ?? 0) + 1);
      }
    }
  }
  return [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
}

/**
 * The SUSPECT CHURN rule: more than half of the records known before this poll
 * report a change on this one poll.
 *
 * This guards the assumption that a Horizon record holds no field that moves
 * on every request. If one does, every record logs a "changed" line on every
 * poll forever. The alert names the fields that differed so the one doing the
 * churning can be read off it; the fix is to exclude that field in
 * IGNORED_FIELDS. It can also fire on real activity, for instance a single
 * known pool taking its first deposit, which is why it names fields rather
 * than suppressing anything: every changed record is still written.
 */
export function churnSuspect(knownBefore: number, changedCount: number): boolean {
  return knownBefore > 0 && changedCount * 2 > knownBefore;
}

// ---------------------------------------------------------------------------
// Alert text
// ---------------------------------------------------------------------------

/** DISPLAY ONLY. "native" is PI here, never XLM. Both issuer ends are shown. */
export function piLabel(key: string): string {
  if (key === "native") return "PI";
  const sep = key.indexOf(":");
  if (sep < 0) return key;
  const code = key.slice(0, sep);
  const issuer = key.slice(sep + 1);
  if (issuer.length <= 12) return `${code}(${issuer})`;
  return `${code}(${issuer.slice(0, 4)}..${issuer.slice(-4)})`;
}

export function assetAlerts(
  diff: Diff,
  everSeenBefore: boolean,
  includeGone: boolean,
): string[] {
  const out: string[] = [];
  if (diff.added.length > 0 && !everSeenBefore) {
    out.push(`FIRST ASSET EVER SEEN: ${diff.added.length} classic asset(s) on /assets`);
  }
  for (const k of diff.added) {
    const flags = (diff.next.get(k) as any)?.flags;
    out.push(
      `NEW ASSET ${piLabel(k)} ${k}` +
        (flags !== undefined ? ` flags=${stableJson(flags)}` : ""),
    );
  }
  if (includeGone) {
    for (const k of diff.gone) out.push(`ASSET GONE ${piLabel(k)} ${k}: no longer in the /assets walk`);
  }
  return out;
}

/** Pool ids per pair, for the pools known before a poll. */
export function pairIndex(pools: Map<string, unknown>): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const [id, r] of pools) {
    const pair = pairOf(r);
    if (pair === null) continue;
    const ids = idx.get(pair) ?? [];
    ids.push(id);
    idx.set(pair, ids);
  }
  return idx;
}

export function poolAlerts(
  diff: Diff,
  everSeenBefore: boolean,
  includeGone: boolean,
  pairsBefore: Map<string, string[]>,
): string[] {
  const out: string[] = [];
  if (diff.added.length > 0 && !everSeenBefore) {
    out.push(`FIRST POOL EVER SEEN: ${diff.added.length} pool(s) on /liquidity_pools`);
  }

  // Copied so that two new pools on one pair in the same walk still count as
  // a second pool, which is the event section 2.1 says cannot happen.
  const pairs = new Map([...pairsBefore].map(([p, ids]) => [p, [...ids]]));

  for (const id of diff.added) {
    const r = diff.next.get(id) as any;
    const assets = poolAssets(r);
    if (!assets) {
      out.push(`NEW POOL ${id}: reserves unreadable, fee_bp=${r?.fee_bp}`);
      continue;
    }
    const [a, b] = assets;
    out.push(`NEW POOL ${id} ${piLabel(a)}/${piLabel(b)} fee_bp=${r?.fee_bp} (${a} / ${b})`);

    const pair = [a, b].sort().join("|");
    const others = pairs.get(pair) ?? [];
    if (others.length > 0) {
      out.push(
        `SECOND POOL ON PAIR ${piLabel(a)}/${piLabel(b)}: ${id} joins ${others.join(", ")}` +
          " (tests section 2.1: one pool per pair)",
      );
    }
    pairs.set(pair, [...others, id]);

    if (a !== "native" && b !== "native") {
      out.push(
        `TOKEN/TOKEN POOL ${id} ${piLabel(a)}/${piLabel(b)}` +
          " (tests section 2.2: the graph is no longer a star)",
      );
    }
  }
  if (includeGone) {
    for (const id of diff.gone) out.push(`POOL GONE ${id}: no longer in the /liquidity_pools walk`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** The Horizon root fields recorded. Absent fields are recorded as absent. */
const PROTOCOL_FIELDS = [
  "current_protocol_version",
  "core_supported_protocol_version",
  "horizon_version",
  "core_version",
  "network_passphrase",
] as const;

/** A change in either of these raises an alert; the rest are only recorded. */
const ALERTING_PROTOCOL_FIELDS = [
  "current_protocol_version",
  "core_supported_protocol_version",
] as const;

export type ProtocolFields = Record<(typeof PROTOCOL_FIELDS)[number], unknown>;

export function protocolFieldsOf(root: unknown): ProtocolFields {
  const out = {} as ProtocolFields;
  for (const f of PROTOCOL_FIELDS) out[f] = (root as any)?.[f] ?? null;
  return out;
}

// ---------------------------------------------------------------------------
// Restart: replaying the files
// ---------------------------------------------------------------------------

export interface Loaded {
  assets: KindState;
  pools: KindState;
  protocol: ProtocolFields | null;
  /** Lines that could not be read, per file. A half-written last line is one. */
  skippedLines: Record<string, number>;
  /** Files that did not exist. */
  missing: string[];
}

/**
 * Rebuild what the watcher knew from its own files, so that a restart does not
 * alert again on anything already recorded.
 *
 * Record files are replayed in order: "seen" and "changed" set the key's
 * record, "gone" deletes it. A line that does not parse is skipped and
 * counted, and the count is printed at startup. If the skipped line was the
 * only record of something, that thing is reported as NEW again: loud and
 * duplicated, rather than silently missed.
 */
export function loadState(paths: PiPaths): Loaded {
  const loaded: Loaded = {
    assets: { current: new Map(), everSeen: false },
    pools: { current: new Map(), everSeen: false },
    protocol: null,
    skippedLines: {},
    missing: [],
  };

  const lines = (path: string): Array<Record<string, any>> => {
    if (!existsSync(path)) {
      loaded.missing.push(path);
      return [];
    }
    const out: Array<Record<string, any>> = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row !== null && typeof row === "object") {
          out.push(row);
          continue;
        }
      } catch {
        // counted below
      }
      loaded.skippedLines[path] = (loaded.skippedLines[path] ?? 0) + 1;
    }
    return out;
  };

  for (const kind of ["assets", "pools"] as const) {
    const path = paths[kind];
    const state = loaded[kind];
    for (const row of lines(path)) {
      if (row.event === "unkeyed") continue;
      if (typeof row.key !== "string" ||
          (row.event !== "seen" && row.event !== "changed" && row.event !== "gone")) {
        loaded.skippedLines[path] = (loaded.skippedLines[path] ?? 0) + 1;
        continue;
      }
      state.everSeen = true;
      if (row.event === "gone") state.current.delete(row.key);
      else state.current.set(row.key, row.record);
    }
  }

  for (const row of lines(paths.protocol)) {
    if (row.fields && typeof row.fields === "object") loaded.protocol = row.fields;
    else loaded.skippedLines[paths.protocol] = (loaded.skippedLines[paths.protocol] ?? 0) + 1;
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

export interface PiWatchOptions {
  paths: PiPaths;
  get?: GetJson;
  now?: () => Date;
  out?: (line: string) => void;
  /** Page cap per walk. HORIZON_MAX_PAGES unless a test needs to reach it. */
  maxPages?: number;
}

export class PiWatch {
  readonly failures: Record<Endpoint, number> = { assets: 0, pools: 0, root: 0 };
  readonly loaded: Loaded;

  private readonly paths: PiPaths;
  private readonly get: GetJson;
  private readonly maxPages: number;
  private readonly now: () => Date;
  private readonly out: (line: string) => void;
  private readonly assets: KindState;
  private readonly pools: KindState;
  private protocol: ProtocolFields | null;
  private readonly failingSince: Partial<Record<Endpoint, string>> = {};
  /** Churn and unreadable-record alerts already raised by this process. */
  private readonly raised = new Set<string>();
  /** Files already checked, on first write, for a half-written last line. */
  private readonly filesReady = new Set<string>();

  /**
   * Every poll gets an id, `<process start>#<n>`, written on its pi-watch.jsonl
   * line AND on every record line it produced. Joining the two tells a replay
   * which records came from a truncated or partial walk.
   */
  private readonly runId: string;
  private seq = 0;
  private tickNo = 0;

  constructor(opts: PiWatchOptions) {
    this.paths = opts.paths;
    this.get = opts.get ?? getJson;
    this.maxPages = opts.maxPages ?? HORIZON_MAX_PAGES;
    this.now = opts.now ?? (() => new Date());
    this.out = opts.out ?? ((line) => console.log(line));
    this.loaded = loadState(this.paths);
    this.assets = this.loaded.assets;
    this.pools = this.loaded.pools;
    this.protocol = this.loaded.protocol;
    this.runId = this.now().toISOString();
  }

  banner(): string[] {
    const p = this.paths;
    const L = this.loaded;
    const missing = L.missing.length === 0 ? "none" : L.missing.join(", ");
    const lines = [
      "pi-watch: read-only Pi mainnet watcher, Phase 0 of docs/pi-mainnet.md",
      `  horizon     ${PI_HORIZON_URL}  (GET only; no key, no SDK, no other host)`,
      `  polls       /assets every ${PI_WATCH_MS / 60_000} min;` +
        ` /liquidity_pools every ${(PI_WATCH_MS * PI_SLOW_EVERY) / 60_000} min while classic_assets=0,` +
        ` else every ${PI_WATCH_MS / 60_000} min; / every ${(PI_WATCH_MS * PI_SLOW_EVERY) / 60_000} min`,
      `  budget      ${idleRequestsPerDay()} requests/day while both are empty; retries not counted`,
      `  writes      ${p.watch}, ${p.assets}, ${p.pools}, ${p.protocol}`,
      `  alerts      stdout and ${p.alerts} only; nothing is sent anywhere`,
      `  state       read back ${this.assets.current.size} classic assets,` +
        ` ${this.pools.current.size} pools, protocol ${this.protocol?.current_protocol_version ?? "unknown"};` +
        ` files missing: ${missing}`,
    ];
    for (const [file, n] of Object.entries(L.skippedLines)) {
      lines.push(`              skipped ${n} unreadable line(s) in ${file}`);
    }
    if (!this.assets.everSeen) {
      lines.push("              no prior asset record: the next asset seen will be reported as the FIRST ever");
    }
    if (!this.pools.everSeen) {
      lines.push("              no prior pool record: the next pool seen will be reported as the FIRST ever");
    }
    lines.push(
      "  CANNOT SEE  tokens issued as contracts. /assets lists classic assets only, so",
      "              classic_assets=0 means zero CLASSIC assets, NOT zero tokens (section 4.2).",
      "              A Launchpad token announced while this stays 0 is the signal to add an RPC path.",
      "  CANNOT SEE  anything while this process, this machine or the network is down.",
      `              A gap in ${p.watch} is a gap in observation.`,
    );
    return lines;
  }

  /** One tick. Never throws: a failed poll is a recorded, counted outcome. */
  async tick(): Promise<void> {
    const tick = this.tickNo++;
    const polled: string[] = [];
    const errors: string[] = [];

    // Assets first, so that the tick on which the first asset appears also
    // switches pools to every tick (section 3.2).
    const note = (ep: Endpoint, ok: boolean) => {
      polled.push(ep);
      if (!ok) errors.push(ep);
    };
    note("assets", await this.pollKind("assets"));
    for (const ep of duePolls(tick, this.assets.current.size === 0)) {
      note(ep, ep === "root" ? await this.pollRoot() : await this.pollKind("pools"));
    }

    const nextPools = duePolls(tick + 1, this.assets.current.size === 0).includes("pools")
      ? "next_tick"
      : `${(PI_SLOW_EVERY - ((tick + 1) % PI_SLOW_EVERY)) * (PI_WATCH_MS / 60_000)}m`;
    this.out(
      `${this.now().toISOString()} pi-watch tick=${tick}` +
        ` classic_assets=${this.assets.current.size} pools=${this.pools.current.size}` +
        ` protocol=${this.protocol?.current_protocol_version ?? "unknown"}` +
        ` polled=${polled.join(",")} pools_next=${nextPools}` +
        (errors.length > 0 ? ` FAILED=${errors.join(",")}` : " ok"),
    );
  }

  private async pollKind(kind: Kind): Promise<boolean> {
    const endpoint: Endpoint = kind;
    const path = kind === "assets" ? "/assets" : "/liquidity_pools";
    const url = `${PI_HORIZON_URL}${path}?limit=${HORIZON_PAGE_LIMIT}&order=asc`;
    const poll = this.nextPollId();
    const started = Date.now();

    let walk: WalkResult;
    try {
      walk = await walkAll(url, this.get, this.maxPages);
    } catch (e: any) {
      this.pollFailed(endpoint, poll, started, e);
      return false;
    }

    const state = kind === "assets" ? this.assets : this.pools;
    const keyOf = kind === "assets" ? assetKeyOf : poolKeyOf;
    const diff = diffRecords(state.current, walk.records, keyOf, IGNORED_FIELDS[kind]);

    // The coverage line first, so every record line below has a poll to join to.
    this.append(this.paths.watch, {
      ts: this.now().toISOString(),
      poll,
      endpoint,
      ...(kind === "assets" ? { scope: "classic" } : {}),
      records: walk.records.length,
      pages: walk.pages,
      ms: Date.now() - started,
      truncated: walk.truncated,
      unkeyed: diff.unkeyed.length,
    });
    this.pollSucceeded(endpoint);

    const ts = this.now().toISOString();
    const file = this.paths[kind];
    for (const k of diff.added) this.append(file, { ts, poll, event: "seen", key: k, record: diff.next.get(k) });
    for (const k of diff.changed) this.append(file, { ts, poll, event: "changed", key: k, record: diff.next.get(k) });
    // A truncated walk did not reach every key, so absence proves nothing.
    const includeGone = !walk.truncated;
    if (includeGone) {
      for (const k of diff.gone) this.append(file, { ts, poll, event: "gone", key: k, record: null });
    }

    const alerts: string[] = [];
    if (kind === "assets") {
      alerts.push(...assetAlerts(diff, state.everSeen, includeGone));
    } else {
      alerts.push(...poolAlerts(diff, state.everSeen, includeGone, pairIndex(state.current)));
    }

    if (churnSuspect(state.current.size, diff.changed.length)) {
      const fields = changedFields(state.current, diff.next, diff.changed);
      const id = `churn:${kind}:${fields.map(([f]) => f).join(",")}`;
      if (!this.raised.has(id)) {
        this.raised.add(id);
        alerts.push(
          `SUSPECT CHURN ${kind}: ${diff.changed.length} of ${state.current.size} known records` +
            ` changed on one poll; fields differing: ` +
            fields.map(([f, n]) => `${f} (${n}/${diff.changed.length})`).join(", ") +
            ". If a field changes on every poll without meaning anything, exclude it in" +
            " IGNORED_FIELDS in src/pi-watch.ts.",
        );
      }
    }

    if (diff.unkeyed.length > 0 && !this.raised.has(`unkeyed:${kind}`)) {
      // Once per process: the record shape is not what this watcher expects,
      // and the examples are kept so the shape can be read off the file.
      this.raised.add(`unkeyed:${kind}`);
      for (const r of diff.unkeyed) this.append(file, { ts, poll, event: "unkeyed", key: null, record: r });
      alerts.push(
        `UNREADABLE RECORDS ${kind}: ${diff.unkeyed.length} record(s) on ${path} had no readable key;` +
          ` they are written to ${file} as "unkeyed" and are not tracked`,
      );
    }

    if (diff.added.length > 0) state.everSeen = true;
    if (includeGone) {
      state.current = diff.next;
    } else {
      for (const k of [...diff.added, ...diff.changed]) state.current.set(k, diff.next.get(k));
    }
    for (const a of alerts) this.alert(a);
    return true;
  }

  private async pollRoot(): Promise<boolean> {
    const poll = this.nextPollId();
    const started = Date.now();
    let root: unknown;
    try {
      root = await this.get(`${PI_HORIZON_URL}/`);
      if (root === null || typeof root !== "object") throw new Error("root is not a JSON object");
    } catch (e: any) {
      this.pollFailed("root", poll, started, e);
      return false;
    }

    this.append(this.paths.watch, {
      ts: this.now().toISOString(),
      poll,
      endpoint: "root",
      records: 1,
      pages: 1,
      ms: Date.now() - started,
      truncated: false,
    });
    this.pollSucceeded("root");

    const fields = protocolFieldsOf(root);
    const before = this.protocol;
    if (before !== null && stableJson(before) === stableJson(fields)) return true;

    this.append(this.paths.protocol, { ts: this.now().toISOString(), poll, fields });
    this.protocol = fields;
    if (before === null) {
      this.out(
        `${this.now().toISOString()} pi-watch root: network_passphrase=${JSON.stringify(fields.network_passphrase)}` +
          ` current_protocol_version=${fields.current_protocol_version}` +
          ` core_supported_protocol_version=${fields.core_supported_protocol_version}`,
      );
      return true;
    }
    for (const f of ALERTING_PROTOCOL_FIELDS) {
      if (stableJson(before[f]) !== stableJson(fields[f])) {
        this.alert(`PROTOCOL CHANGED ${f} ${before[f]} -> ${fields[f]}`);
      }
    }
    return true;
  }

  private pollFailed(endpoint: Endpoint, poll: string, started: number, e: any): void {
    const ts = this.now().toISOString();
    this.append(this.paths.watch, {
      ts,
      poll,
      endpoint,
      records: null,
      pages: null,
      ms: Date.now() - started,
      truncated: null,
      error: String(e?.message ?? e),
    });
    if (this.failures[endpoint] === 0) this.failingSince[endpoint] = ts;
    this.failures[endpoint]++;
    if (this.failures[endpoint] === PI_BLIND_AFTER) {
      this.alert(
        `BLIND ${endpoint}: ${PI_BLIND_AFTER} consecutive failed polls since ${this.failingSince[endpoint]};` +
          ` nothing on this endpoint is being observed. Last error: ${String(e?.message ?? e)}`,
      );
    }
  }

  private pollSucceeded(endpoint: Endpoint): void {
    const n = this.failures[endpoint];
    if (n >= PI_BLIND_AFTER) {
      this.alert(
        `RECOVERED ${endpoint} after ${n} consecutive failed polls;` +
          ` blind from ${this.failingSince[endpoint]} to ${this.now().toISOString()}`,
      );
    }
    this.failures[endpoint] = 0;
    delete this.failingSince[endpoint];
  }

  private nextPollId(): string {
    return `${this.runId}#${++this.seq}`;
  }

  private alert(text: string): void {
    const line = `${this.now().toISOString()} PI ALERT ${text}`;
    this.out(line);
    this.appendLine(this.paths.alerts, line);
  }

  private append(path: string, row: unknown): void {
    this.appendLine(path, JSON.stringify(row));
  }

  /**
   * Append one line. The first time this process writes a file, a file that
   * does not end in a newline gets one first. A power cut can leave a
   * half-written last line with no newline, and without this the next line
   * would be glued onto it: replay would then skip BOTH, and the lost one
   * could be the "gone" record that stops a restart alerting again.
   */
  private appendLine(path: string, line: string): void {
    if (!this.filesReady.has(path)) {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      if (existsSync(path)) {
        const text = readFileSync(path);
        if (text.length > 0 && text[text.length - 1] !== 0x0a) appendFileSync(path, "\n", "utf8");
      }
      this.filesReady.add(path);
    }
    appendFileSync(path, line + "\n", "utf8");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Whether this module is the script being run, rather than imported by the
 * tests. Compared as resolved paths, case-folded on Windows, where the drive
 * letter's case can differ between process.argv and import.meta.url.
 */
export function isEntry(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  const norm = (p: string) =>
    process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  return norm(fileURLToPath(metaUrl)) === norm(argv1);
}

async function main(): Promise<void> {
  const watch = new PiWatch({ paths: PI_PATHS });
  for (const line of watch.banner()) console.log(line);
  process.on("SIGINT", () => {
    console.log("pi-watch: stopped");
    process.exit(0);
  });

  // Each tick starts PI_WATCH_MS after the previous one started. One that
  // overruns is followed at once; ticks never overlap.
  for (;;) {
    const started = Date.now();
    await watch.tick();
    const waitMs = Math.max(0, started + PI_WATCH_MS - Date.now());
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

if (isEntry(import.meta.url, process.argv[1])) {
  main().catch((e) => {
    console.error("pi-watch: fatal", e);
    process.exit(1);
  });
}
