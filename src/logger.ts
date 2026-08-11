import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Opportunity } from "./arb.js";

// Resolved against this file rather than cwd, so the CSV lands in the repo's
// data/ directory no matter where the process was started from.
const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "data");
export const LOG_PATH = resolve(DATA_DIR, "opportunities.csv");

const COLUMNS = [
  "timestamp",
  "venue",
  "kind",
  "route_key",
  "route_label",
  "size",
  "output",
  "gross_bps",
  "fee_native",
  "net_profit",
  "first_seen",
  "last_seen",
  "tick_interval_ms",
] as const;

/**
 * `heartbeat` is written every tick regardless of what was found, so a quiet
 * market and a stalled process are distinguishable in the CSV alone. Without
 * it the two produce byte-identical files: no rows.
 *
 * `error` is a heartbeat whose tick failed. It is a separate kind rather than
 * a heartbeat with an odd status because a gap caused by Horizon returning 503
 * is not evidence about the market, and any later analysis of edge lifetimes
 * has to exclude those ticks -- a streak cannot be said to have "continued"
 * across a tick during which nothing was observed.
 */
export type RowKind = "direct" | "triangular" | "heartbeat" | "error";

interface Row {
  venue: string;
  kind: RowKind;
  route_key: string;
  route_label: string;
  size: string;
  output: string;
  gross_bps: string;
  fee_native: string;
  net_profit: string;
  first_seen: string;
  last_seen: string;
  /**
   * Milliseconds between this venue's previous tick and this one.
   *
   * THE RESOLUTION first_seen/last_seen WERE MEASURED AT. A streak is counted
   * in ticks, and "three consecutive ticks" is a duration only once you know
   * how long a tick is -- so the file now carries it rather than leaving a
   * reader to assume POLL_MS, which is a floor the venues leave far behind.
   *
   * The obvious worry is that this differs per venue, making cross-venue
   * persistence incomparable. Measured, it does not: monitor.ts polls every
   * venue once per iteration of a single loop, so all venues share one interval
   * -- ~12s after the Stellar walk was parallelised, ~70s before it. The value
   * is logged per row anyway, because that lockstep is a property of a loop
   * somebody could restructure, and a column that measures the claim outlives a
   * comment that asserts it.
   *
   * Compare `seconds` between first_seen and last_seen for a duration; use this
   * to know how coarsely that duration was sampled. 0 is a venue's first tick,
   * which has no preceding tick to measure from.
   */
  tick_interval_ms: string;
}

/** RFC 4180: quote when the value contains a comma, quote or newline. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Append one row, creating the directory and header as needed. Failures are
 * swallowed with a warning: logging must never take down the poll loop.
 *
 * `path` exists so the TEST SUITE can exercise the CSV format without writing
 * to the file a live monitor is appending to. It is not a config knob and
 * nothing in src/ passes it.
 *
 * This is not hypothetical tidiness. test/check.ts used to assert the CSV shape
 * against LOG_PATH itself, rm-ing it before and after -- so running `npm run
 * check` while a monitor was polling DELETED that run's accumulated rows, and
 * the monitor, which only ever appends, silently rebuilt the file with a fresh
 * header on its next tick. Hours of collection could vanish with no error
 * anywhere, and the resulting file looked perfectly healthy.
 */
function appendRow(row: Row, atIso: string, path: string = LOG_PATH): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const isNew = !existsSync(path);

    const line = [
      atIso,
      row.venue,
      row.kind,
      row.route_key,
      row.route_label,
      row.size,
      row.output,
      row.gross_bps,
      row.fee_native,
      row.net_profit,
      row.first_seen,
      row.last_seen,
      row.tick_interval_ms,
    ]
      .map(csvField)
      .join(",");

    appendFileSync(
      path,
      (isNew ? COLUMNS.join(",") + "\n" : "") + line + "\n",
      "utf8",
    );
  } catch (e: any) {
    console.error("csv log failed:", e?.message ?? e);
  }
}

/** How long a route has been continuously profitable, as of this tick. */
export interface Streak {
  /** ISO time of the first tick in the current unbroken run. */
  firstSeen: string;
  /** ISO time of the most recent tick in that run. */
  lastSeen: string;
  /** Consecutive qualifying ticks, including this one. */
  ticks: number;
  /** lastSeen - firstSeen in seconds. 0 on the first sighting. */
  seconds: number;
}

/**
 * Tracks how long each route_key has been CONTINUOUSLY profitable.
 *
 * This is the measurement the project exists to produce. Detection quality is
 * irrelevant if edges close faster than anyone could act on them, and the only
 * way to tell those two situations apart is to know whether a route survived
 * one tick or forty. A count of sightings cannot answer it: a route that
 * qualifies on alternating ticks has been profitable forty times and never
 * once for longer than a poll interval, and those are opposite findings.
 *
 * So continuity is strict. A route resumes its streak only if it also
 * qualified on the immediately preceding tick; any gap starts a new run and
 * first_seen is reset. Ticks that failed (Horizon down) are still ticks, which
 * means an outage breaks streaks -- correctly, since an unobserved tick is not
 * evidence the edge held.
 *
 * Keyed on the issuer-qualified routeKey, never on a label. Two routes whose
 * labels both read "XLM > USDC > XLM" can be a real edge and a counterfeit
 * one, and merging their streaks would invent persistence that neither has.
 *
 * State is in memory only: absolute timestamps in the CSV mean a restart
 * costs the in-flight streaks but nothing already written.
 */
export class StreakTracker {
  private tick = 0;
  private runs = new Map<
    string,
    { firstSeen: string; firstMs: number; startTick: number; lastTick: number }
  >();

  /** Call once at the top of every tick, including ticks that then fail. */
  beginTick(): void {
    this.tick++;
  }

  /** Record that `routeKey` qualified in the current tick. */
  mark(routeKey: string, at: Date): Streak {
    const nowIso = at.toISOString();
    const nowMs = at.getTime();
    const prev = this.runs.get(routeKey);

    // Continuous only across adjacent ticks. `=== this.tick` covers a second
    // mark within the same tick, which must extend nothing.
    const continues =
      prev !== undefined &&
      (prev.lastTick === this.tick || prev.lastTick === this.tick - 1);

    if (!continues) {
      this.runs.set(routeKey, {
        firstSeen: nowIso,
        firstMs: nowMs,
        startTick: this.tick,
        lastTick: this.tick,
      });
      return { firstSeen: nowIso, lastSeen: nowIso, ticks: 1, seconds: 0 };
    }

    const run = prev!;
    run.lastTick = this.tick;

    return {
      firstSeen: run.firstSeen,
      lastSeen: nowIso,
      ticks: this.tick - run.startTick + 1,
      seconds: (nowMs - run.firstMs) / 1000,
    };
  }

  /**
   * Call at the end of every tick. Drops routes that did not qualify, which
   * bounds memory; continuity is enforced by the tick numbers, not by this.
   */
  endTick(): void {
    for (const [key, run] of this.runs) {
      if (run.lastTick < this.tick) this.runs.delete(key);
    }
  }

  /** Routes currently on an unbroken run. */
  get activeCount(): number {
    return this.runs.size;
  }
}

export function logOpportunity(
  op: Opportunity,
  streak: Streak,
  at: Date,
  tickIntervalMs: number,
  path?: string,
): void {
  appendRow(
    {
      venue: op.venue,
      kind: op.kind,
      route_key: op.routeKey,
      route_label: op.routeLabel,
      size: op.size.toFixed(7),
      output: op.output.toFixed(7),
      gross_bps: op.grossBps.toFixed(2),
      fee_native: op.feeNative.toFixed(7),
      net_profit: op.netProfit.toFixed(7),
      first_seen: streak.firstSeen,
      last_seen: streak.lastSeen,
      tick_interval_ms: String(tickIntervalMs),
    },
    at.toISOString(),
    path,
  );
}

/**
 * One row per venue per tick, whatever happened.
 *
 * `status` rides in route_label because heartbeats have no route, and
 * route_key is left empty on purpose: a heartbeat must never collide with a
 * real route identity in the dedupe map, the streak tracker, or a future
 * blacklist, and an empty key cannot.
 */
export function logHeartbeat(
  venue: string,
  status: string,
  at: Date,
  kind: "heartbeat" | "error" = "heartbeat",
  tickIntervalMs = 0,
  path?: string,
): void {
  appendRow(
    {
      venue,
      kind,
      route_key: "",
      route_label: status,
      size: "",
      output: "",
      gross_bps: "",
      fee_native: "",
      net_profit: "",
      first_seen: "",
      last_seen: "",
      tick_interval_ms: String(tickIntervalMs),
    },
    at.toISOString(),
    path,
  );
}
