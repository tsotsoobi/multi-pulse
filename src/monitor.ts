import { findOpportunities, type Opportunity } from "./arb.js";
import { POLL_MS, SUMMARY_TOP_N } from "./config.js";
import {
  LOG_PATH,
  StreakTracker,
  logHeartbeat,
  logOpportunity,
  type Streak,
} from "./logger.js";
import { StellarVenue } from "./venues/stellar.js";
import type { Venue } from "./venue.js";

/**
 * The poll loop: fetch, detect, log, print. That is the entire program.
 *
 * There is nothing to switch on and nothing to arm. The loop has no wallet, no
 * signer and no code path to a submitted transaction -- the venues it drives
 * expose fetchPools/simulate/assetLabel and nothing else, so "would take" is
 * the only thing this can express.
 */

const VENUES: Venue[] = [new StellarVenue()];

/** One tracker per venue: route keys are only unique within a venue. */
const trackers = new Map<string, StreakTracker>(
  VENUES.map((v) => [v.name, new StreakTracker()]),
);

let running = true;

async function tick(): Promise<void> {
  for (const venue of VENUES) {
    const tracker = trackers.get(venue.name)!;

    // Advanced before the fetch, so a tick that fails still counts as a tick
    // and still breaks streaks. An unobserved interval is not evidence that
    // an edge held through it.
    tracker.beginTick();

    const startedAt = Date.now();
    try {
      const pools = await venue.fetchPools();
      const ops = findOpportunities(venue, pools);
      const at = new Date();

      const streaks = new Map<string, Streak>();
      for (const op of ops) {
        const streak = tracker.mark(op.routeKey, at);
        streaks.set(op.routeKey, streak);
        logOpportunity(op, streak, at);
      }

      const elapsed = Date.now() - startedAt;
      const status =
        `pools=${pools.length} routes=${ops.length}` +
        ` streaks=${tracker.activeCount} tick_ms=${elapsed}` +
        fetchNote(venue);

      // Written whatever happened, including ops.length === 0. Without this
      // row a quiet market and a dead process produce the same empty file.
      logHeartbeat(venue.name, status, at);
      printTick(venue, ops, streaks, status);
    } catch (e: any) {
      const at = new Date();
      const message = e?.message ?? String(e);
      logHeartbeat(
        venue.name,
        `error: ${message} tick_ms=${Date.now() - startedAt}`,
        at,
        "error",
      );
      console.error(`[${stamp(at)}] ${venue.name} tick failed: ${message}`);
    } finally {
      tracker.endTick();
    }
  }
}

/**
 * Reports how much of the venue was actually seen.
 *
 * Optional because it is not part of the Venue contract: a venue that pages
 * differently, or not at all, has nothing to report here and says so by not
 * having the field. A truncated walk is shouted about because it removes whole
 * cycles rather than degrading the numbers -- a tick that saw 90% of the pools
 * is not 90% accurate, it is silently missing every route with a leg in the
 * other 10%.
 */
interface PagedVenue {
  lastFetch: { pages: number; skipped: number; truncated: boolean };
}

function hasFetchStats(v: Venue): v is Venue & PagedVenue {
  return typeof (v as Partial<PagedVenue>).lastFetch?.pages === "number";
}

function fetchNote(venue: Venue): string {
  if (!hasFetchStats(venue)) return "";
  const { pages, skipped, truncated } = venue.lastFetch;
  return (
    ` pages=${pages}` +
    (skipped > 0 ? ` skipped=${skipped}` : "") +
    (truncated ? " TRUNCATED" : "")
  );
}

function printTick(
  venue: Venue,
  ops: Opportunity[],
  streaks: Map<string, Streak>,
  status: string,
): void {
  console.log(`[${stamp(new Date())}] ${venue.name} ${status}`);

  for (const op of ops.slice(0, SUMMARY_TOP_N)) {
    // age is the headline: a route that has been profitable for 0.0s has been
    // profitable for less than one poll interval, which is the finding.
    const age = streaks.get(op.routeKey)?.seconds ?? 0;
    console.log(
      `    ${op.kind.padEnd(10)} ${op.routeLabel}` +
        `  size=${op.size} net=${op.netProfit.toFixed(7)}` +
        ` gross=${op.grossBps.toFixed(1)}bps age=${age.toFixed(1)}s`,
    );
  }
}

function stamp(d: Date): string {
  return d.toISOString().slice(11, 19);
}

async function main(): Promise<void> {
  console.log(`multi-pulse: observing ${VENUES.map((v) => v.name).join(", ")}`);
  console.log(`poll=${POLL_MS}ms  log=${LOG_PATH}`);
  console.log("read-only: this process cannot sign or submit anything\n");

  // Scheduled after each tick completes rather than on a fixed interval: a
  // slow Horizon page would otherwise stack overlapping ticks, and two ticks
  // in flight at once would corrupt the streak counters they share.
  while (running) {
    const started = Date.now();
    await tick();
    const wait = Math.max(0, POLL_MS - (Date.now() - started));
    if (running && wait > 0) await sleep(wait);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

process.on("SIGINT", () => {
  running = false;
  console.log("\nstopping after current tick");
});

main().catch((e) => {
  console.error("fatal:", e?.message ?? e);
  process.exit(1);
});
