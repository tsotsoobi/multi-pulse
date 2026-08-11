import {
  findOpportunities,
  limitsFor,
  partitionByDepth,
  type SearchLimits,
  type Opportunity,
} from "./arb.js";
import {
  ENABLED_VENUES,
  POLL_MS,
  SUMMARY_TOP_N,
  type VenueName,
} from "./config.js";
import {
  LOG_PATH,
  StreakTracker,
  logHeartbeat,
  logOpportunity,
  type Streak,
} from "./logger.js";
import { StellarVenue } from "./venues/stellar.js";
import { XrplVenue } from "./venues/xrpl.js";
import type { Venue } from "./venue.js";

/**
 * The poll loop: fetch, detect, log, print. That is the entire program.
 *
 * There is nothing to switch on and nothing to arm. The loop has no wallet, no
 * signer and no code path to a submitted transaction -- the venues it drives
 * expose fetchPools/simulate/assetLabel and nothing else, so "would take" is
 * the only thing this can express.
 */

/**
 * Built from ENABLED_VENUES, so which chains are watched is a property of the
 * committed config rather than of this file. The switch is exhaustive on
 * VenueName: adding a venue to the union without building it here is a compile
 * error, not a venue that silently never runs.
 */
function buildVenue(name: VenueName): Venue {
  switch (name) {
    case "stellar":
      return new StellarVenue();
    case "xrpl":
      return new XrplVenue();
  }
}

/**
 * A venue and the limits its search runs under, paired at startup.
 *
 * The pairing is explicit rather than left to findOpportunities' default
 * because the limits are denominated in the venue's own asset: a ladder rung is
 * 1000 XLM on one venue and 100 XRP on the other, and those are the same size
 * only in the sense that matters here -- dollars. Binding them here means the
 * banner can print what each venue was actually searched with, so a reader of
 * data/opportunities.csv can see the sizing that produced it.
 */
interface Watched {
  venue: Venue;
  limits: SearchLimits;
}

const VENUES: Watched[] = ENABLED_VENUES.map((name) => ({
  venue: buildVenue(name),
  limits: limitsFor(name),
}));

if (VENUES.length === 0) {
  console.error("config: ENABLED_VENUES is empty, nothing to observe");
  process.exit(1);
}

/** One tracker per venue: route keys are only unique within a venue. */
const trackers = new Map<string, StreakTracker>(
  VENUES.map(({ venue }) => [venue.name, new StreakTracker()]),
);

let running = true;

async function tick(): Promise<void> {
  for (const { venue, limits } of VENUES) {
    const tracker = trackers.get(venue.name)!;

    // Advanced before the fetch, so a tick that fails still counts as a tick
    // and still breaks streaks. An unobserved interval is not evidence that
    // an edge held through it.
    tracker.beginTick();

    const startedAt = Date.now();
    try {
      const pools = await venue.fetchPools();

      // Counted with the same predicate findOpportunities filters on, so this
      // number always describes the filter that actually ran.
      const { deep, shallow } = partitionByDepth(venue, pools, limits.minPoolNative);

      const ops = findOpportunities(venue, pools, limits);
      const at = new Date();

      const streaks = new Map<string, Streak>();
      for (const op of ops) {
        const streak = tracker.mark(op.routeKey, at);
        streaks.set(op.routeKey, streak);
        logOpportunity(op, streak, at);
      }

      const elapsed = Date.now() - startedAt;
      // `pools` is what the venue saw; `searched` is what the graph was built
      // from. Reporting these, always -- including zeros -- is the point: a
      // reader comparing venues has to be able to see how much of one venue's
      // quiet is the depth floor rather than the market.
      //
      // `shallow` counts only pools with a native side. Token-to-token pools
      // are not depth-checked at all -- see the gap note on partitionByDepth --
      // so this number is "abandoned native pools removed", not "everything
      // thin removed", and must not be read as the latter.
      const status =
        `pools=${pools.length} searched=${deep.length}` +
        ` shallow=${shallow.length} routes=${ops.length}` +
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

/**
 * A venue whose coverage story is its own. Stellar's is "how many Horizon pages
 * did we walk"; XRPL's is "how many candidate pairs did we probe and how many
 * had an AMM". Those do not reduce to a common shape, so a venue that has
 * something specific to say says it itself.
 */
interface SelfReportingVenue {
  fetchNote(): string;
}

function hasFetchStats(v: Venue): v is Venue & PagedVenue {
  return typeof (v as Partial<PagedVenue>).lastFetch?.pages === "number";
}

function hasOwnNote(v: Venue): v is Venue & SelfReportingVenue {
  return typeof (v as Partial<SelfReportingVenue>).fetchNote === "function";
}

function fetchNote(venue: Venue): string {
  if (hasOwnNote(venue)) return venue.fetchNote();
  if (!hasFetchStats(venue)) return "";
  const { pages, skipped, truncated } = venue.lastFetch;
  return (
    ` pages=${pages}` +
    (skipped > 0 ? ` skipped=${skipped}` : "") +
    (truncated ? " TRUNCATED" : "")
  );
}

/**
 * A venue that has to open something before it can read, and close it after.
 *
 * Optional for the same reason PagedVenue is: Horizon is stateless HTTP and has
 * nothing to open. XRPL holds a WebSocket, and reads its reference fee once
 * before the loop starts rather than per tick, so that every row in a run was
 * priced against the same stated number.
 */
interface LifecycleVenue {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function hasLifecycle(v: Venue): v is Venue & LifecycleVenue {
  const c = v as Partial<LifecycleVenue>;
  return typeof c.start === "function" && typeof c.stop === "function";
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
  console.log(
    `multi-pulse: observing ${VENUES.map(({ venue }) => venue.name).join(", ")}`,
  );
  console.log(`poll=${POLL_MS}ms  log=${LOG_PATH}`);
  console.log("read-only: this process cannot sign or submit anything\n");

  // Before the loop, not inside it. A venue that reads a network constant at
  // startup must read it once, or two rows of the same CSV end up priced
  // against different fees with nothing in the file saying so.
  for (const { venue, limits } of VENUES) {
    if (hasLifecycle(venue)) await venue.start();
    // The ladder is printed because it is denominated: "size=250" in the CSV
    // means 250 XLM on one venue and 250 XRP on another, and the two ladders
    // are only comparable under an exchange rate assumption stated in
    // config.ts. Printing the range each venue was searched over puts that
    // assumption in the run's own output rather than only in a source comment.
    console.log(
      `${venue.name}: ready  fee=${venue.feeNative}` +
        ` sizes=${limits.sizeLadder[0]}..${limits.maxSize}` +
        ` min_net=${limits.minNetProfit} min_bps=${limits.minProfitBps}` +
        ` min_pool=${limits.minPoolNative}` +
        fetchNote(venue),
    );
  }

  try {
    // Scheduled after each tick completes rather than on a fixed interval: a
    // slow Horizon page would otherwise stack overlapping ticks, and two ticks
    // in flight at once would corrupt the streak counters they share.
    while (running) {
      const started = Date.now();
      await tick();
      const wait = Math.max(0, POLL_MS - (Date.now() - started));
      if (running && wait > 0) await sleep(wait);
    }
  } finally {
    for (const { venue } of VENUES) {
      if (hasLifecycle(venue)) await venue.stop().catch(() => {});
    }
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
