import { venueLimits } from "./config.js";
import { other, type Pool, type Venue } from "./venue.js";

/**
 * The search: probe a size ladder, rank on absolute net profit, and consider
 * only cycles that start and end in the venue's native asset.
 *
 * Route identity is issuer-qualified throughout. See routeKey below.
 */

export interface Opportunity {
  venue: string;
  kind: "direct" | "triangular";

  /**
   * Machine identity of the route: the full issuer-qualified asset path,
   * e.g. "native>USDC:GA5ZSEJY...>native".
   *
   * THIS IS THE ONLY THING THAT MAY BE USED AS A KEY. Stellar mainnet hosts
   * many assets sharing a code, including deliberate copies of well-known
   * stablecoins pointed at an attacker's issuer. A key built from codes would
   * merge the real USDC route and the counterfeit one into a single row: the
   * persistence measurement would average two unrelated edges, and a blacklist
   * entry meant for the fake would mute the real one (or, worse, an entry for
   * the real one would leave the fake live).
   *
   * The dedupe map, the CSV route_key column, the first_seen/last_seen tracker
   * and any future blacklist all key on this string.
   */
  routeKey: string;

  /** Human-readable rendering of the same path. DISPLAY ONLY, never a key. */
  routeLabel: string;

  /** The full cycle as canonical keys, native at both ends. */
  path: string[];
  /** Pools traversed, in order. Not part of routeKey; see the dedupe note. */
  poolIds: string[];

  /** Ladder rung with the best absolute net profit. */
  size: number;
  /** Native asset out, simulated at `size`. */
  output: number;

  /**
   * GROSS edge at `size`: (output - size) / size * 10000, before the network
   * fee. Reported, not acted on -- it is the readable description of the edge
   * itself, and it is paired with `size`, so neither may be recomputed at some
   * other rung. netProfit is the number that passed the floors and set the
   * ranking.
   */
  grossBps: number;

  /** Flat per-round-trip network cost this route was priced against. */
  feeNative: number;
  /** output - size - feeNative. */
  netProfit: number;
}

/**
 * What to search, and how selective to be, IN ONE VENUE'S NATIVE ASSET.
 *
 * Every number here except minProfitBps is denominated: a ladder rung and a
 * profit floor mean nothing without knowing what unit they are in. That is why
 * the ladder lives on this interface rather than as a module constant -- one
 * ladder shared across venues silently means "1000 of whatever this chain calls
 * its coin", which is not one economic size. See VENUE_LIMITS in config.ts.
 */
export interface SearchLimits {
  /** Input sizes to probe, in the venue's native asset. */
  sizeLadder: readonly number[];
  minProfitBps: number;
  minNetProfit: number;
  maxSize: number;
  /** Minimum native-side reserve for a pool to enter the graph. */
  minPoolNative: number;
}

/**
 * The venue's configured limits, in the shape bestSize wants.
 *
 * Throws for a venue with no configured limits rather than substituting
 * another's -- see venueLimits().
 */
export function limitsFor(venueName: string): SearchLimits {
  const l = venueLimits(venueName);
  return {
    sizeLadder: l.sizeLadder,
    minProfitBps: l.minProfitBps,
    minNetProfit: l.minNetProfit,
    maxSize: l.maxTradeSize,
    minPoolNative: l.minPoolNative,
  };
}

/**
 * This pool's reserve of the venue's native asset, or null if it holds none.
 *
 * Null is the honest answer for a token-to-token pool, and it is not the same
 * as zero: zero would mean "no depth" and get the pool dropped, when in fact
 * the pool simply cannot be measured on this axis. See MIN_POOL_NATIVE_NOTE.
 */
export function nativeReserve(venue: Venue, pool: Pool): number | null {
  if (pool.a === venue.nativeKey) return pool.ra;
  if (pool.b === venue.nativeKey) return pool.rb;
  return null;
}

/**
 * Split pools into those deep enough to trade against and those that are not.
 *
 * THE PREDICATE LIVES HERE AND ONLY HERE. findOpportunities filters with it so
 * that shallow pools never reach the graph, and monitor.ts counts with it so
 * the heartbeat can say how many were dropped. Two implementations of "deep
 * enough" would drift, and the drift would show up as a heartbeat that
 * confidently reports a number describing a filter nobody applied.
 *
 * A pool with no native side is KEPT: it cannot be measured, and dropping
 * everything unmeasurable would silently delete every triangular route.
 */
export function partitionByDepth(
  venue: Venue,
  pools: Pool[],
  minPoolNative: number,
): { deep: Pool[]; shallow: Pool[] } {
  const deep: Pool[] = [];
  const shallow: Pool[] = [];
  for (const p of pools) {
    const native = nativeReserve(venue, p);
    if (native !== null && native < minPoolNative) shallow.push(p);
    else deep.push(p);
  }
  return { deep, shallow };
}

/**
 * Probe every ladder rung for one route and keep the rung with the largest
 * absolute NET profit, not the best percentage.
 *
 * On a constant-product pool the percentage edge shrinks monotonically with
 * size, so ranking on percentage pins every route to the bottom rung and
 * reports a 300 bps edge worth 0.003 XLM ahead of a 40 bps edge worth 4.
 *
 * Acceptance is where net-vs-gross really bites. The fee is flat, so
 * break-even in gross terms is 10000 * fee / size bps -- 10 bps at size 1 and
 * 0.01 bps at size 1000 against a 0.001 XLM fee. One gross floor cannot
 * express that, and setting it low enough for the top of the ladder admits
 * guaranteed losers at the bottom. Both floors are therefore net, and the
 * ranking subtracts the fee too, so the quantity compared is the quantity
 * accepted on.
 *
 * Rungs failing either floor are discarded before the comparison rather than
 * clamped afterwards, which is what guarantees grossBps and output describe
 * the same trade as `size`.
 *
 * Returns null when no rung clears the floors.
 */
function bestSize(
  quote: (size: number) => number,
  limits: SearchLimits,
  feeNative: number,
): { size: number; output: number; grossBps: number; netProfit: number } | null {
  let best: {
    size: number;
    output: number;
    grossBps: number;
    netProfit: number;
  } | null = null;

  // Rungs above the ceiling are dropped here rather than at the ladder's
  // definition, and the drop is silent in one direction only: raising a ladder
  // without raising its venue's maxTradeSize is a no-op with no error and no
  // log line. Move them together.
  for (const size of limits.sizeLadder) {
    if (size > limits.maxSize) continue;

    const output = quote(size);
    if (!Number.isFinite(output)) continue;

    const grossBps = ((output - size) / size) * 10_000;
    const netProfit = output - size - feeNative;

    // Absolute floor first: a healthy percentage on a dust size is still dust.
    if (netProfit < limits.minNetProfit) continue;

    // Percentage floor, now a margin over break-even -- the fee is already out.
    const netBps = (netProfit / size) * 10_000;
    if (netBps < limits.minProfitBps) continue;

    if (!best || netProfit > best.netProfit) {
      best = { size, output, grossBps, netProfit };
    }
  }
  return best;
}

/**
 * Upper bound on the output/input rate of a cycle, evaluated in the limit of
 * an infinitesimal trade.
 *
 * This is a lossless prune, not a heuristic. For a constant-product pool the
 * realised rate output(dx)/dx is strictly decreasing in dx, so each hop's rate
 * at any real size is at most its rate at zero, which is
 * (1 - fee) * rOut / rIn. The composite rate is therefore at most the product
 * of those. If that product does not exceed 1, no rung on the ladder can turn
 * a profit and bestSize would reject all of them after paying for three
 * simulate() calls per rung.
 *
 * It exists because mainnet is large. Several thousand pools quote XLM and hub
 * assets carry hundreds each, so the triangular enumeration visits an enormous
 * number of triples, and pricing each one fully would not finish inside a
 * single poll interval. Being an exact bound rather than a filter means the
 * result set is identical with it and without it.
 *
 * The bound reads reserves directly, which is sound because Pool is defined as
 * a constant-product pool; a venue with different curve math would need to
 * hand back its own bound.
 */
function cycleRateBound(pools: Pool[], from: string[]): number {
  let rate = 1;
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i]!;
    const inKey = from[i]!;
    const fromIsA = inKey === p.a;
    const rIn = fromIsA ? p.ra : p.rb;
    const rOut = fromIsA ? p.rb : p.ra;
    rate *= (1 - p.feeBp / 10_000) * (rOut / rIn);
  }
  return rate;
}

/**
 * Find profitable cycles that start and end in the venue's native asset.
 *
 * direct:     native -> X -> native across two different pools quoting the
 *             same pair at different prices
 * triangular: native -> X -> Y -> native across three pools
 *
 * Pure and offline. `pools` is a snapshot and the whole snapshot is priced as
 * one instant; nothing in here does I/O or reads a clock.
 */
export function findOpportunities(
  venue: Venue,
  pools: Pool[],
  limits: SearchLimits = limitsFor(venue.name),
): Opportunity[] {
  const out: Opportunity[] = [];
  const native = venue.nativeKey;
  const fee = venue.feeNative;

  // Never let a caller widen the ceiling, only narrow it -- and the ceiling it
  // is measured against is THIS venue's, since a size is meaningless without
  // the asset it is denominated in.
  const capped: SearchLimits = {
    ...limits,
    maxSize: Math.min(limits.maxSize, venueLimits(venue.name).maxTradeSize),
  };

  // Depth floor FIRST, before the index is built, so a shallow pool is not
  // merely absent from the results but absent from the graph -- it cannot be
  // the middle leg of a triangle either. Filtering afterwards would leave the
  // dust routes enumerated and then discarded, which costs the same time and
  // still lets a puddle set the price of a cycle whose outer legs are deep.
  const { deep } = partitionByDepth(venue, pools, capped.minPoolNative);

  // Index by asset for neighbour lookup.
  const byAsset = new Map<string, Pool[]>();
  for (const p of deep) {
    for (const k of [p.a, p.b]) {
      const bucket = byAsset.get(k);
      if (bucket) bucket.push(p);
      else byAsset.set(k, [p]);
    }
  }

  const nativePools = byAsset.get(native) ?? [];

  // --- Direct: native -> X via p1, X -> native via p2 ---------------------
  for (const p1 of nativePools) {
    const x = other(p1, native);

    for (const p2 of nativePools) {
      if (p2.id === p1.id) continue;
      if (other(p2, native) !== x) continue;

      if (cycleRateBound([p1, p2], [native, x]) <= 1) continue;

      const pick = bestSize(
        (size) => venue.simulate(p2, x, venue.simulate(p1, native, size)),
        capped,
        fee,
      );
      if (!pick) continue;

      out.push(
        build(venue, "direct", [native, x, native], [p1.id, p2.id], pick, fee),
      );
    }
  }

  // --- Triangular: native -> X -> Y -> native -----------------------------
  for (const p1 of nativePools) {
    const x = other(p1, native);

    for (const p2 of byAsset.get(x) ?? []) {
      if (p2.id === p1.id) continue;
      const y = other(p2, x);
      if (y === native) continue; // that is the direct case above

      for (const p3 of byAsset.get(y) ?? []) {
        if (p3.id === p2.id || p3.id === p1.id) continue;
        if (other(p3, y) !== native) continue;

        if (cycleRateBound([p1, p2, p3], [native, x, y]) <= 1) continue;

        const pick = bestSize(
          (size) =>
            venue.simulate(
              p3,
              y,
              venue.simulate(p2, x, venue.simulate(p1, native, size)),
            ),
          capped,
          fee,
        );
        if (!pick) continue;

        out.push(
          build(
            venue,
            "triangular",
            [native, x, y, native],
            [p1.id, p2.id, p3.id],
            pick,
            fee,
          ),
        );
      }
    }
  }

  // Collapse to the best instance of each route, then rank.
  //
  // Both the collapse and the ranking use absolute net profit, matching how
  // the size was chosen. Routes now sit at different sizes, so a percentage
  // would rank a tiny rich edge above a larger richer one, and a gross figure
  // would rank a route above one that beats it after the fee.
  //
  // The key is the asset path, so several pool combinations spanning the same
  // issuer-qualified assets reduce to their best member. That is what makes
  // first_seen/last_seen answer a question worth asking -- "how long has this
  // route been profitable" is about the route, and a key that included pool
  // ids would restart the clock whenever a marginally better combination took
  // over. The winning combination's poolIds ride along on the row.
  const best = new Map<string, Opportunity>();
  for (const o of out) {
    const prev = best.get(o.routeKey);
    if (!prev || o.netProfit > prev.netProfit) best.set(o.routeKey, o);
  }
  return [...best.values()].sort((a, b) => b.netProfit - a.netProfit);
}

/** The issuer-qualified path, joined. The one legitimate route identity. */
export function routeKey(path: string[]): string {
  return path.join(">");
}

/** The same path, rendered for a human. Never used as a key. */
export function routeLabel(venue: Venue, path: string[]): string {
  return path.map((k) => venue.assetLabel(k)).join(" > ");
}

function build(
  venue: Venue,
  kind: "direct" | "triangular",
  path: string[],
  poolIds: string[],
  pick: { size: number; output: number; grossBps: number; netProfit: number },
  feeNative: number,
): Opportunity {
  return {
    venue: venue.name,
    kind,
    routeKey: routeKey(path),
    routeLabel: routeLabel(venue, path),
    path,
    poolIds,
    size: pick.size,
    output: pick.output,
    grossBps: pick.grossBps,
    feeNative,
    netProfit: pick.netProfit,
  };
}
