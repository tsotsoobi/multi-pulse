/**
 * All configuration for multi-pulse, as plain checked-in constants.
 *
 * There is no .env, no dotenv, and no process.env read anywhere in this repo.
 * That is deliberate and it is not a style preference: an environment-driven
 * config is how a read-only tool quietly acquires the one credential that would
 * make it a writing tool, and how two people end up disagreeing about what the
 * monitor was actually configured to do when they compare CSVs a week later.
 * Constants in a committed file mean every row in data/opportunities.csv can be
 * traced to a specific commit of this file.
 *
 * Note what is absent and must stay absent: no key material, no account, no
 * network passphrase, no submit endpoint, no "dry run" switch. There is no dry
 * run here because there is no wet run to distinguish it from.
 */

/** Every venue this repo knows how to build. */
export type VenueName = "stellar" | "xrpl" | "base";

/**
 * Which venues the monitor drives. Run any subset.
 *
 * Venues are polled sequentially and their results never mix: opportunities are
 * cycles within a single venue, streaks are tracked per venue, and the CSV
 * carries a `venue` column. Enabling several does not look for cross-chain
 * routes and could not -- there is no bridge in this program and nothing to
 * bridge with.
 *
 * All venues share one loop, so every venue's tick is part of every other
 * venue's iteration. The interval stays at POLL_MS only while the ticks
 * together fit inside it; Base's is capped at BASE_TICK_TIMEOUT_MS.
 */
export const ENABLED_VENUES: readonly VenueName[] = ["stellar", "xrpl", "base"];

/** Horizon base URL. Read-only REST; only GET requests are ever issued. */
export const HORIZON_URL = "https://horizon.stellar.org";

/**
 * Minimum length of one loop iteration, in milliseconds. Every venue is polled
 * once per iteration, so this is the floor on every venue's sampling interval.
 *
 * WHY THIS IS NOT 2000 ANY MORE, AND WHY THE OLD VALUE WAS NEVER TESTED. It was
 * 2000 when a Stellar tick took 61 seconds, so it never bound anything: the
 * loop ran as fast as Horizon allowed and the interval was ~70s whatever this
 * said. Parallelising the walk cut the tick to ~7s, POLL_MS became the actual
 * governor for the first time, and the request rate went up about ninefold --
 * not because the walk got bigger, but because it repeated nine times as often.
 *
 * Measured consequence: ~206 requests per walk at an ~8s interval is ~26 req/s,
 * or ~92,700 requests an hour against a shared public Horizon, which answered
 * with sustained 429s -- 60-70% of Stellar ticks failing. The serial walk's
 * ~2.9 req/s (~10,300/hour) had drawn no 429 at all, so the tolerated rate is
 * somewhere between the two and nearer the lower.
 *
 * 60000 puts the walk back to roughly the rate that was demonstrably accepted
 * while KEEPING the part of the parallel walk that actually mattered: a
 * snapshot assembled in ~7s (as measured when the sharded walk was
 * introduced, commit 99e8ab8; the 11 August 2026 run measured a 9.3 s median)
 * instead of ~61s. Resolution returns to about what it was; internal
 * consistency of each snapshot is 8x better and stays that way. Those two are
 * independent, and it was the second one that was a correctness problem rather
 * than a comfort.
 *
 * RAISING RESOLUTION FROM HERE COSTS REQUESTS, and there is no way around that
 * while the venue must enumerate 39,000 pools to see any of them. Halving this
 * doubles the request rate. If a faster Stellar sample is ever needed, the
 * honest routes are a Horizon instance that is not shared, or per-venue
 * cadences so XRPL can stay fast while Stellar does not have to.
 */
export const POLL_MS = 60_000;

/**
 * Retries for a Horizon request that failed in a way worth asking again about.
 *
 * A retryable failure that is NOT retried does not cost one sample, it breaks
 * every streak: monitor.ts records a failed tick as an error row and
 * StreakTracker treats an unobserved interval as evidence of nothing, which is
 * correct and is exactly why a transient 429 must never reach it.
 */
export const HORIZON_RETRIES = 4;

/** Backoff between Horizon retries when no Retry-After header is offered. */
export const HORIZON_BACKOFF_BASE_MS = 2000;

/** Ceiling on one backoff wait, including a Retry-After Horizon asks for. */
export const HORIZON_MAX_BACKOFF_MS = 20_000;

/**
 * Records per Horizon page. 200 is Horizon's maximum; a smaller value only
 * multiplies the number of round trips needed to see the same pool set.
 */
export const HORIZON_PAGE_LIMIT = 200;

/**
 * Hard stop on pages walked PER SHARD, per fetchPools() call.
 *
 * Horizon's paging cursor always yields a `next` link, including on the empty
 * page past the end, so the loop's real terminator is the zero-record page.
 * This cap exists only so a Horizon bug or a cursor that fails to advance
 * cannot spin forever inside one tick. At 200 records a page it admits 60k
 * pools per shard, comfortably above the live mainnet count for the whole
 * network -- if this cap is ever hit, the pool set is truncated and the tick is
 * reported as incomplete rather than quietly under-counted.
 *
 * Per shard rather than per call since the walk was split: a shard covers about
 * 1/HORIZON_SHARDS of the id space, so mainnet's ~201 pages is ~17 per shard
 * and this is roughly 18x the headroom it was before.
 */
export const HORIZON_MAX_PAGES = 300;

/** Per-request timeout for Horizon GETs, in milliseconds. */
export const HORIZON_TIMEOUT_MS = 15_000;

/**
 * How many id-ranges the pool walk is split into and fetched concurrently.
 *
 * WHY THIS EXISTS. Measured on mainnet: a serial walk is 201 pages at ~300ms
 * each, and 99.93% of the 61-second tick was waiting on HTTP -- 60,687ms of
 * network against 43ms of parsing and searching combined. Horizon caps a page
 * at 200 records and its paging is cursor-based, so page N+1's URL only arrives
 * inside page N's response: the walk cannot be made faster by asking for more
 * per request, and it cannot be pipelined along a single cursor chain.
 *
 * It CAN be split. A liquidity pool's paging_token is its id, which is a
 * fixed-width 64-char lowercase hex hash, so Horizon's `order=asc` is plain
 * lexicographic order over a uniformly distributed space. That means the id
 * range can be cut into N contiguous slices up front, with no prior knowledge
 * of what is in them, and each slice walked on its own cursor chain in
 * parallel. Hashes spread evenly, so the slices come out about the same size.
 *
 * This is NOT sampling and it is NOT a cache. Every slice still walks to its
 * own exhaustion and the slices tile the whole id space, so the result is the
 * same complete pool set the serial walk produced -- Venue.fetchPools requires
 * exhaustion and this preserves it exactly.
 *
 * 12 is chosen over something larger because the gain is sub-linear (the walk
 * is bounded by the slowest slice, not the average) while the cost to a shared
 * public Horizon is linear in concurrency. See HORIZON_MAX_PAGES for what the
 * per-slice page cap now means.
 */
export const HORIZON_SHARDS = 12;

/**
 * Minimum NET edge, in basis points of trade size, for a route to be logged.
 *
 * Net means after pool fees (already inside every quote) and after the flat
 * network fee, so this is a pure margin over break-even rather than a fee
 * coverage rule. A gross threshold cannot express fee coverage at all: the fee
 * is flat, so break-even is 10000 * fee / size bps -- very different at the
 * bottom and top of the ladder.
 *
 * THIS ONE IS SHARED ACROSS VENUES, AND DELIBERATELY SO. Everything else in
 * VENUE_LIMITS below is split per venue because it is denominated in a native
 * asset and 1 XLM is not 1 XRP. A basis point is a ratio: 20 bps is the same
 * economic hurdle whatever the unit, so splitting it would introduce exactly
 * the asymmetry the split is there to remove.
 */
export const MIN_PROFIT_BPS = 20;

// ---------------------------------------------------------------------------
// Per-venue search limits
// ---------------------------------------------------------------------------

/**
 * The size ladder and profit floors for one venue, in that venue's NATIVE
 * asset. Passed to findOpportunities as its SearchLimits argument.
 */
export interface VenueLimits {
  /** Input sizes probed for every candidate route, in the native asset. */
  sizeLadder: readonly number[];
  /**
   * Largest single trade the search will consider, in the native asset.
   *
   * Not a safety limit -- nothing here can trade -- but a realism limit. Sizes
   * far above what anyone would actually route produce "edges" that exist only
   * in the tail of a curve nobody would touch, and they would dominate a
   * ranking that sorts on absolute profit.
   *
   * Keep this and sizeLadder in step. arb.ts drops ladder rungs above the
   * ceiling silently, so raising the ladder alone is a no-op with no error.
   */
  maxTradeSize: number;
  /**
   * Absolute floor on net profit per route, in the native asset.
   *
   * A percentage floor alone still admits dust: 20 net bps at the bottom rung
   * is a fraction of a cent. Applied alongside minProfitBps, both must clear.
   */
  minNetProfit: number;
  /** Copy of MIN_PROFIT_BPS. Shared by construction; see the note there. */
  minProfitBps: number;
  /**
   * Minimum native-side reserve for a pool to enter the graph at all, in the
   * native asset. Pools below it are dropped before cycle enumeration, not
   * filtered out of the results afterwards.
   *
   * See MIN_POOL_NATIVE_NOTE below for why this exists and why it is the thing
   * that makes the two venues comparable.
   */
  minPoolNative: number;
}

/**
 * WHY THESE ARE SPLIT PER VENUE.
 *
 * One ladder applied to both venues is not one economic size. 1000 XLM and
 * 1000 XRP differ by roughly an order of magnitude in dollar terms, so a shared
 * ladder probes a materially deeper slice of one venue's pools than of the
 * other's, and a shared minNetProfit is a much stricter filter on the cheaper
 * unit. Route counts would then differ between venues for reasons that are
 * entirely an artefact of this file, and a cross-venue comparison is the only
 * thing this project exists to produce.
 *
 * THE EXCHANGE RATES ASSUMED, AND WHY THEY ARE WRONG.
 *
 *   1 XLM ~ $0.30
 *   1 XRP ~ $3.00
 *   => 1 XRP ~ 10 XLM, which is the only figure actually used below.
 *
 * These are round numbers typed by hand from rough market levels around the
 * time this file was written (2026-08). They are STALE BY CONSTRUCTION and
 * cannot be otherwise: they are checked-in constants, this repo has no price
 * feed, and it should not grow one -- a monitor that reached for a price oracle
 * to size its own probes would make every row in the CSV depend on a third
 * party nobody logged. So the honest statement is that the ladders are
 * comparable in dollar terms AT THE 10:1 RATIO ABOVE and drift out of
 * comparability as the real ratio moves.
 *
 * What that means for reading the output: at 10:1 the two ladders span the same
 * ~$0.30 to ~$300 band, so route counts are comparable. If the real ratio has
 * moved to 15:1, the XRPL ladder is probing a band 1.5x deeper in dollars than
 * the Stellar one and the comparison is skewed by that much -- a distortion of
 * tens of percent, not the order of magnitude a shared ladder produced. Adjust
 * the rungs, in a commit, when the ratio has moved enough to care about.
 *
 * ---------------------------------------------------------------------------
 * MEASURED 2026-08-11: THE RATIO IS 6.27:1, NOT 10:1.
 *
 * Not a guess this time. Both figures are read off the deepest stablecoin pool
 * on each venue, which is the only numeraire available without a price feed --
 * a stablecoin pool's own reserve ratio IS the chain's opinion of what its
 * native asset is worth, and it costs one request per venue to ask.
 *
 *   XLM  Horizon /liquidity_pools, native <-> USDC:GA5ZSEJY...KZVN
 *        13,256,961.2409614 XLM / 2,129,305.2453931 USDC  =>  $0.16062
 *
 *   XRP  rippled amm_info, XRP <-> RLUSD (rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De)
 *        1,977,192 XRP / 1,991,246 RLUSD                  =>  $1.00711
 *
 *   ratio 1.00711 / 0.16062 = 6.27 XLM per XRP
 *
 * NOTE THE DIRECTION. The paragraph above anticipated the ratio widening --
 * "if the real ratio has moved to 15:1, the XRPL ladder is probing deeper". It
 * moved the other way, so it is STELLAR that now probes deeper, by about 1.6x:
 *
 *   top rung        Stellar $160.62   XRPL $100.71
 *   minNetProfit    Stellar $0.0016   XRPL $0.0010
 *   minPoolNative   Stellar $1,606    XRPL $1,007
 *
 * Every dollar figure written elsewhere in this file is also about 1.9x too
 * high in absolute terms: the depth floor is ~$1,606, not the "~$3,000" its own
 * comment claims, and the fee assumptions are ~$0.00016 rather than ~$0.0003.
 * The RELATIVE symmetry between the venues survives; only the labels are stale.
 *
 * Left unretuned deliberately. A collection run was in progress when this was
 * measured, and changing the ladders mid-run makes the rows before and after
 * incomparable in exactly the way this whole block exists to prevent -- with
 * nothing in the CSV marking where the change happened. Retune between runs.
 *
 * THE REAL FIX IS TO STOP HARDCODING IT. Both venues already fetch the pool
 * that answers this question: StellarVenue walks every Horizon pool including
 * XLM/USDC, and XrplVenue probes every seeded pair including XRP/RLUSD. So the
 * rate could be derived at startup from data already in hand -- read once,
 * printed in the banner, and stamped into the CSV so every row states the rate
 * it was sized against -- with no price feed, no third party, and no extra
 * request. That would make the ladders self-calibrating and this comment
 * unnecessary.
 *
 * It was not done now for the same reason the rungs were not retuned: it
 * changes what is measured, mid-run. It also needs a decision this file cannot
 * make on its own -- a derived rate moves between runs, so two CSVs would no
 * longer share a ladder unless the rate is pinned per run and recorded. That is
 * the right design; it is not a comment-sized change.
 * ---------------------------------------------------------------------------
 *
 * The rungs are the same eleven relative steps on both venues, so a rung index
 * means the same thing on each side and the two ladders can be compared
 * position by position.
 *
 * ---------------------------------------------------------------------------
 * MIN_POOL_NATIVE_NOTE -- the depth floor, and why it is not optional.
 *
 * THE EVIDENCE. A full Stellar scan of 39,807 pools found the deepest XLM pool
 * holding 13.2m XLM (USDC). Every route the Stellar monitor flagged over eight
 * hours ran through pools holding under 60 XLM. The detection was not wrong --
 * those cycles were really there and really priced -- but a 60 XLM pool cannot
 * absorb a trade anyone would make, so the output was dust: correct arithmetic
 * about markets that do not exist at any size worth having.
 *
 * WHY THIS IS THE THING THAT MAKES THE VENUES COMPARABLE. It is not just noise
 * reduction, and this is the important part. THE XRPL SEED LIST IS LIQUID BY
 * CONSTRUCTION. XrplVenue can only see pools reachable from XRPL_SEED_TOKENS,
 * and that list was built by ranking tokens on measured XRP-side depth -- its
 * shallowest entry holds ~600 XRP and its deepest ~2m. The Stellar adapter has
 * no such filter: it walks Horizon to exhaustion and sees every pool that
 * exists, including tens of thousands of abandoned ones holding a few XLM.
 *
 * So an unfiltered comparison is not like-for-like in the slightest. It reads
 * as "Stellar has far more opportunities than XRPL" when what it actually
 * measures is "Stellar's pool enumeration is complete and XRPL's is a curated
 * shortlist". The dust routes are an artefact of the difference in DISCOVERY
 * METHOD between the two adapters, not a fact about either market. Applying a
 * depth floor to both puts Stellar on the same footing the seed list already
 * imposes on XRPL, and only then does a route-count difference mean anything.
 *
 * THE THRESHOLDS, on the same 10:1 rate assumed above and equally stale:
 *
 *   Stellar  10000 XLM ~ $3,000
 *   XRPL      1000 XRP ~ $3,000
 *
 * Both are 10x that venue's top ladder rung, which is the property to preserve
 * if the ladders are retuned: a pool must be able to absorb ten times the
 * largest trade probed through it before it is allowed into the graph at all.
 * That bounds how much of any reported edge is slippage against a puddle.
 *
 * WHAT IT DOES NOT DO, AND WHY NOT. The floor applies ONLY to pools with a
 * native side, which means every triangle's middle leg is unchecked. That gap
 * is real and there is evidence for it -- see the gap note on partitionByDepth
 * in arb.ts, which records the SCOP cluster capping at 5 XLM and the measured
 * cost of trying to close it with a per-pool filter (Stellar's searchable graph
 * fell from 29,485 pools to 153, and both venues went to routes=0).
 *
 * The short version: this threshold is justified by capital PASSING THROUGH a
 * pool, which is the right question for an outer leg, where the trade enters
 * and leaves in native terms. A middle leg carries only what the first hop
 * produced, so an absolute native floor is the wrong instrument there. The
 * correct fix is a per-route, per-rung slippage check inside bestSize(), not a
 * per-pool filter, and it is not implemented.
 * ---------------------------------------------------------------------------
 */
export const VENUE_LIMITS: Record<VenueName, VenueLimits> = {
  // ~$0.30 to ~$300 at $0.30/XLM.
  stellar: {
    sizeLadder: [1, 5, 10, 25, 50, 100, 160, 250, 400, 650, 1000],
    maxTradeSize: 1000,
    // 0.01 XLM ~ $0.003.
    minNetProfit: 0.01,
    minProfitBps: MIN_PROFIT_BPS,
    // ~$3,000, and 10x the 1000 XLM top rung. See MIN_POOL_NATIVE_NOTE.
    minPoolNative: 10_000,
  },
  // The same dollar band at $3.00/XRP: every rung is the Stellar rung / 10.
  xrpl: {
    sizeLadder: [0.1, 0.5, 1, 2.5, 5, 10, 16, 25, 40, 65, 100],
    maxTradeSize: 100,
    // 0.001 XRP ~ $0.003, matching the Stellar floor at the assumed rates.
    minNetProfit: 0.001,
    minProfitBps: MIN_PROFIT_BPS,
    // ~$3,000 at 10:1, and 10x the 100 XRP top rung. See MIN_POOL_NATIVE_NOTE.
    minPoolNative: 1_000,
  },
  // PROVISIONAL, all in ETH. These are starting values to be tuned from
  // collected data, not a dollar match for the two ladders above: no XLM/ETH or
  // XRP/ETH ratio has been measured, and the network fee on this venue is far
  // larger in dollar terms (see BASE_FEE_NATIVE), so the bottom rungs will
  // rarely clear. Retune between runs, never mid-run.
  base: {
    sizeLadder: [0.01, 0.05, 0.1, 0.25, 0.5],
    maxTradeSize: 0.5,
    // 0.000001 ETH ~ $0.003 at an assumed ~$3,000/ETH, in the style of the
    // floors above. BASE_FEE_NATIVE dominates it at every rung.
    minNetProfit: 0.000001,
    minProfitBps: MIN_PROFIT_BPS,
    // 10x the 0.5 ETH top rung. See MIN_POOL_NATIVE_NOTE.
    minPoolNative: 5,
  },
};

/**
 * Limits for one venue by name.
 *
 * Throws rather than falling back to a default. A venue whose limits nobody
 * configured would otherwise be searched with someone else's ladder, which is
 * the precise failure this whole block exists to end -- and it would do it
 * silently, producing a full CSV of rows sized in the wrong asset.
 */
export function venueLimits(name: string): VenueLimits {
  const limits = (VENUE_LIMITS as Record<string, VenueLimits | undefined>)[name];
  if (!limits) throw new Error(`config: no search limits for venue "${name}"`);
  return limits;
}

/**
 * Stellar base fee assumed per round trip, in stroops (1e7 stroops = 1 XLM).
 *
 * The protocol minimum is 100 stroops, but mainnet surge-prices, so the honest
 * figure is "at least 100 and sometimes far more". This assumes 10000 stroops
 * (0.001 XLM) because the error here is one-sided: assuming too little makes
 * marginal edges look takeable when they are not, which is precisely the
 * mistake this project exists to avoid making. Assuming too much only drops a
 * few dust rungs.
 *
 * The cost is concentrated where it matters and rounds to nothing where it
 * does not: 0.001 XLM is 10 bps at size 1, 0.4 bps at size 25, and 0.01 bps at
 * the size-1000 ceiling.
 *
 * XRPL_FEE_SAFETY_MULTIPLIER below exists to make the XRPL fee err in this same
 * direction by the same factor. Do not retune one of these without the other.
 */
export const STELLAR_BASE_FEE_STROOPS = 10_000;

/** Rows of detail printed per tick. The CSV keeps everything regardless. */
export const SUMMARY_TOP_N = 3;

// ---------------------------------------------------------------------------
// XRPL mainnet
// ---------------------------------------------------------------------------

/**
 * Public XRPL mainnet WebSocket endpoint.
 *
 * Read-only is not enforced by the transport here the way it is for Horizon --
 * a WebSocket carries requests in both directions, so "GET only" has no meaning
 * on it. It is enforced by the command set instead: the only rippled commands
 * this repo issues are `server_info`, `ledger` and `amm_info` at runtime, plus
 * `ledger_data` and `account_info` in the offline scripts, all of which are pure
 * ledger reads, and test/check.ts fails the build if any other command literal
 * appears under src/ or scripts/.
 *
 * WHICH NODE, AND WHY IT IS THIS ONE. A public cluster will IP rate-limit a
 * heavy caller off itself, and `npm run seeds` is heavy enough to trigger that:
 * a full AMM walk is several thousand ledger_data pages. Both xrplcluster.com
 * and xrpl.ws answered "Connection (public) IP limit reached" for hours
 * afterwards, which took the whole XRPL venue offline while Stellar collected
 * normally -- half a comparison is not a comparison.
 *
 * s2.ripple.com answered correctly throughout, so it is the default. This is a
 * checked-in constant rather than an argument the monitor accepts, so every run
 * is attributable to one stated node by reading the commit it ran from. The
 * offline SCRIPTS do take an endpoint argument, because being unable to reach
 * one node says nothing about the seed list they are checking.
 *
 * Alternatives, all verified to answer at some point: wss://s1.ripple.com,
 * wss://xrplcluster.com, wss://xrpl.ws. Prefer a node that is not shared if the
 * poll interval is ever tightened; see POLL_MS on what request rate cost here.
 */
export const XRPL_WS_URL = "wss://s2.ripple.com";

/**
 * Fallback reference fee for one XRPL transaction, in DROPS. 1e6 drops = 1 XRP,
 * so 10 drops is 0.00001 XRP.
 *
 * This is only the fallback. XrplVenue reads the live figure from server_info's
 * `validated_ledger.base_fee_xrp` when it connects and uses that instead; the
 * constant exists so a venue that cannot reach server_info still prices with a
 * defensible number rather than a zero.
 *
 * This is the REFERENCE fee only, and on its own it understates the cost of a
 * round trip in two ways -- see XRPL_FEE_SAFETY_MULTIPLIER below, which is what
 * corrects for both. Nothing should use this constant without that multiplier.
 */
export const XRPL_BASE_FEE_DROPS = 10;

/**
 * Multiplier applied to the XRPL reference fee -- both the fallback above and
 * the live figure read from server_info -- to get the flat round-trip cost the
 * search prices against.
 *
 * WHY A MULTIPLIER AT ALL. The reference fee understates a round trip twice
 * over:
 *
 * 1. It is ONE transaction. A direct cycle is two swaps and a triangular cycle
 *    is three, so unless they are folded into a single path payment the real
 *    round trip costs 2-3x the reference.
 * 2. XRPL RAISES the reference fee under load. 10 drops is the floor, not the
 *    expectation, and the live read in XrplVenue.start() happens once at
 *    startup -- a run that spans a busy hour is priced against a quiet-hour
 *    number for its whole length.
 *
 * 3x for the legs and ~3x of headroom for load gives 10. At the fallback that
 * is 100 drops, or 0.0001 XRP.
 *
 * WHY SYMMETRY IS THE POINT HERE, SPECIFICALLY. STELLAR_BASE_FEE_STROOPS
 * assumes 100x the protocol minimum and says plainly that it over-assumes,
 * because the error is one-sided: assuming too little makes marginal edges look
 * takeable when they are not. Left uncorrected, XRPL would have erred the other
 * way, and the two venues would then have been priced against assumptions
 * pointing in OPPOSITE directions -- Stellar edges shaved by a deliberately
 * pessimistic fee while XRPL edges were flattered by an optimistic one. Every
 * absolute number in this repo is already an estimate and nobody should read
 * one as a real profit; the cross-venue COMPARISON is the output that is meant
 * to survive, and it is exactly what an asymmetric fee assumption destroys. A
 * fee that is wrong by the same factor in the same direction on both venues
 * leaves the comparison intact. This constant buys that and nothing else.
 *
 * At the assumed 10:1 XLM/XRP rate in VENUE_LIMITS the two now match almost
 * exactly, which is the property to preserve if either is ever retuned:
 *
 *   Stellar  0.001 XLM  ~ $0.0003   10 bps at rung 1 (1 XLM),   0.01 bps at rung 11
 *   XRPL     0.0001 XRP ~ $0.0003   10 bps at rung 1 (0.1 XRP), 0.01 bps at rung 11
 */
export const XRPL_FEE_SAFETY_MULTIPLIER = 10;

/** Per-request timeout for rippled calls, in milliseconds. */
export const XRPL_TIMEOUT_MS = 15_000;

/**
 * Concurrent in-flight amm_info requests.
 *
 * The candidate set is quadratic in the seed list, so this is the difference
 * between a sweep that finishes and one that does not. Kept modest because the
 * endpoint is a shared public cluster and being rate-limited off it costs more
 * ticks than the extra parallelism saves.
 */
export const XRPL_PROBE_CONCURRENCY = 8;

/**
 * Discovery probes issued per tick.
 *
 * The first sweep has to ask about every candidate pair, and the candidate set
 * is n + n(n-1)/2 in the seed list: at the 40 tokens committed below that is
 * 820 questions -- far more than fits in a POLL_MS tick. Rather than let the
 * first tick run for minutes, discovery is chipped through this many pairs at a
 * time and the remaining count is reported in the heartbeat. At 150 a tick the
 * first full sweep takes six ticks, or about twelve seconds.
 *
 * Pricing of already-known pools is never rationed; only discovery is.
 */
export const XRPL_DISCOVERY_BATCH = 150;

/**
 * How long a "there is no AMM for this pair" answer is trusted, in ms.
 *
 * Most candidate pairs have no pool and never will, and re-asking about all of
 * them every tick is most of the request budget spent learning nothing.
 * But caching absence forever means an AMM created after startup is invisible
 * until the process restarts, and a monitor that is silently blind to new pools
 * is exactly the failure this repo keeps warning about. So absence expires:
 * every 30 minutes the unresolved pairs are asked again, spread over ticks by
 * XRPL_DISCOVERY_BATCH.
 */
export const XRPL_NEGATIVE_RECHECK_MS = 30 * 60_000;

/** One issued currency on XRPL, as the pair-probe asks about it. */
export interface SeedToken {
  /** Currency code exactly as the ledger stores it: 3-char ASCII, or 40 hex. */
  currency: string;
  /** Issuing account (classic r-address). */
  issuer: string;
  /** Free-text provenance. Display and review only; never parsed. */
  note?: string;
}

/**
 * Seed tokens probed for AMM pools against XRP and against each other.
 *
 * WHY A LIST AT ALL. rippled has no "list every AMM" call. amm_info answers
 * about one pair you already name, and the AMM ledger objects can only be
 * reached by walking the whole ledger with ledger_data -- thousands of pages,
 * routinely refused by public clusters, and far too heavy for a single tick.
 * So discovery is inverted: we name the pairs and ask about each one.
 *
 * WHAT THIS COSTS. Unlike the Stellar adapter, which walks Horizon to
 * exhaustion and therefore sees every pool that exists, this venue sees exactly
 * the pools reachable from this list and no others. A pool between two tokens
 * that are not both below is not merely mispriced, it is invisible, and so is
 * every cycle with a leg in it. Read a quiet XRPL tick as "quiet among these
 * tokens", never as "quiet".
 *
 * HOW TO EXTEND IT. Add {currency, issuer} entries. Currency is whatever form
 * the ledger uses -- 3-char ASCII for standard codes, 40-char hex for the rest
 * -- and is not case-normalised or re-encoded anywhere, because the pool key
 * has to match what amm_info hands back.
 *
 * The reliable way to extend it is `npm run seeds`, a read-only script that
 * enumerates the AMMs actually on the ledger, ranks their tokens by XRP-side
 * depth, and prints entries ready to paste here. Prefer that to typing an
 * issuer from memory: a wrong issuer does not error, it just never matches a
 * pool, so the monitor reports a healthy probe count while being blind to that
 * token. Then run `npm run verify-seeds`, which checks whatever is committed
 * here against the ledger and exits nonzero on anything that cannot be probed.
 *
 * FOUR-LETTER CODES ARE THE TRAP. XRPL has 3-character ASCII codes and 40-char
 * hex codes and nothing in between, so USDC, SOLO and CORE must be written as
 * hex. All three were originally committed here as plain ASCII, and all three
 * were silently discarded by buildCandidates -- no error, no skipped-record
 * count, just three of thirteen seeds quietly absent while the heartbeat
 * reported a healthy probe count. They are hex below, and classifySeeds now
 * names anything it drops at startup and counts it in every heartbeat row.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE OF WHAT IS BELOW. Read this before treating an XRPL row in the CSV
 * as a measurement.
 *
 * The list is 40 tokens from two sources, merged and ranked by measured XRP
 * depth. EVERY entry has been confirmed against the live ledger -- the issuer
 * account exists (account_info) and the token has a real XRP AMM whose depth is
 * the figure in its note (amm_info). None of it is typed from memory.
 *
 *   Source A -- `npm run seeds`, ledger 106214777, node wss://xrplcluster.com.
 *   INCOMPLETE: the walk stopped at the 4000-page cap with the ledger's marker
 *   still advancing, having seen 1247 AMMs of which 952 quoted XRP. That cap
 *   has since been raised to 20000, but this list was built from the capped
 *   run.
 *
 *   Source B -- the 13 hand-written gateway entries this file used to carry,
 *   each re-checked individually with `npm run verify-seeds`. 13 of 13 issuer
 *   accounts exist; 3 needed the hex correction described above. These are the
 *   entries a depth ranking would otherwise have buried, and the reason they
 *   are kept explicitly: RLUSD alone is 1.97M XRP deep and was missing from
 *   Source A entirely, which is the clearest possible demonstration of what the
 *   4000-page truncation actually cost.
 *
 * WHAT THE TRUNCATION MEANS. Every token below is real and its depth is
 * measured. What is NOT established is that these are the 40 deepest tokens on
 * the ledger: Source A saw roughly the first two thirds of mainnet's AMM
 * objects, so a deeper pool in the unscanned tail would simply be absent, and
 * absent here means invisible to the monitor. Read this list as "40 verified,
 * deep-ish tokens", never as "the top 40".
 *
 * ON THE FAILURE LOG IN scripts/seeds.ts. That file's comments cite several
 * aborted walks as justification for its retry budget, page cap and
 * checkpointing. Two of those aborts -- a DNS resolution failure against
 * s1.ripple.com at page 174, and a walk killed by the surrounding tooling at
 * page 2813 -- were LOCAL CONNECTIVITY AND ENVIRONMENT FAILURES, not the
 * endpoints misbehaving. They say nothing about whether s1 or s2 are good nodes
 * to walk, and must not be read as evidence that they are not; both answered
 * correctly when probed directly. Only the xrplcluster.com aborts (a page-cap
 * truncation and an IP rate limit) are actually about endpoint behaviour.
 * ---------------------------------------------------------------------------
 */
export const XRPL_SEED_TOKENS: readonly SeedToken[] = [
  // Ordered by measured XRP-side depth, deepest first. [B] = re-verified from
  // the original hand-written list; the rest are from the ledger walk.
  {
    currency: "524C555344000000000000000000000000000000",
    issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
    note: "[B] RLUSD (Ripple USD), hex -- 1,972,336 XRP",
  },
  {
    currency: "41524D5900000000000000000000000000000000",
    issuer: "rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC",
    note: "ARMY (hex-encoded) -- 221,952 XRP",
  },
  {
    currency: "BTC",
    issuer: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
    note: "[B] Bitstamp BTC -- 107,082 XRP",
  },
  {
    currency: "5553444300000000000000000000000000000000",
    issuer: "rcEGREd8NmkKRE8GE424sksyt1tJVFZwu",
    note: "[B] GateHub USDC, hex (was 4-letter ASCII) -- 47,291 XRP",
  },
  {
    currency: "534F4C4F00000000000000000000000000000000",
    issuer: "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz",
    note: "[B] Sologenic SOLO, hex (was 4-letter ASCII) -- 37,337 XRP",
  },
  {
    currency: "CSC",
    issuer: "rCSCManTZ8ME9EoLrSHHYKW8PPwWMgkwr",
    note: "[B] CasinoCoin -- 30,350 XRP",
  },
  {
    currency: "5363686D65636B6C657300000000000000000000",
    issuer: "rPxw83ZP6thv7KmG5DpAW4cDW55DZRZ9wu",
    note: "Schmeckles (hex-encoded) -- 15,414 XRP",
  },
  {
    currency: "434F524500000000000000000000000000000000",
    issuer: "rcoreNywaoz2ZCQ8Lg2EbSLnGuRBmun6D",
    note: "[B] Coreum CORE, hex (was 4-letter ASCII) -- 13,210 XRP",
  },
  {
    currency: "504947454F4E5300000000000000000000000000",
    issuer: "rfQVVT7X5FynwK87EczgP2T8RQXmQcQSf",
    note: "PIGEONS (hex-encoded) -- 10,403 XRP",
  },
  {
    currency: "USD",
    issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq",
    note: "[B] GateHub USD -- 10,267 XRP",
  },
  {
    currency: "BTC",
    issuer: "rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL",
    note: "[B] GateHub BTC -- 9,833 XRP. Same code as Bitstamp BTC above, different issuer: the two are distinct assets and never merge, see routeKey.",
  },
  {
    currency: "586F676500000000000000000000000000000000",
    issuer: "rJMtvf5B3GbuFMrqybh5wYVXEH4QE8VyU1",
    note: "[B] Xoge (hex-encoded) -- 7,328 XRP",
  },
  {
    currency: "ETH",
    issuer: "rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h",
    note: "[B] GateHub ETH -- 6,325 XRP",
  },
  {
    currency: "4445414C53000000000000000000000000000000",
    issuer: "rfnKKs998kvuVvJSW4jZ1MDxMSiCjhs9su",
    note: "DEALS (hex-encoded) -- 5,671 XRP",
  },
  {
    currency: "2442555253540000000000000000000000000000",
    issuer: "rLeGXSzGpGDxBnEPzCbYiUofRTcnHMnGif",
    note: "$BURST (hex-encoded) -- 5,066 XRP",
  },
  {
    currency: "4655525900000000000000000000000000000000",
    issuer: "rfuryz1gyiTtkEGzXcwghjkKxRHGgXCiZq",
    note: "FURY (hex-encoded) -- 4,835 XRP",
  },
  {
    currency: "4F41520000000000000000000000000000000000",
    issuer: "rJf7VZxBt6g2rBTan6uve89U8PRzSUy8bS",
    note: "OAR (hex-encoded) -- 4,821 XRP",
  },
  {
    currency: "USD",
    issuer: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
    note: "[B] Bitstamp USD -- 4,132 XRP",
  },
  {
    currency: "524F434B00000000000000000000000000000000",
    issuer: "rM2LZ53PobDBpEWZJp9cCAZhViRyy1TbyL",
    note: "ROCK (hex-encoded) -- 3,138 XRP",
  },
  {
    currency: "4254434C00000000000000000000000000000000",
    issuer: "rUgeZXZvcXX9UstkspHr1gHJKj89PqogtU",
    note: "BTCL (hex-encoded) -- 2,611 XRP",
  },
  {
    currency: "4D544D5852500000000000000000000000000000",
    issuer: "r4jpwRde6FFs1QrQPDhn6jKTiqh4KWZKgL",
    note: "MTMXRP (hex-encoded) -- 2,299 XRP",
  },
  {
    currency: "WRP",
    issuer: "rwG5ZvAREQYCEoupsTm8wQvVXmKfRBuEPX",
    note: "WRP -- 1,956 XRP",
  },
  {
    currency: "ELS",
    issuer: "rHXuEaRYnnJHbDeuBH5w8yPh5uwNVh5zAg",
    note: "[B] Elysian -- 1,858 XRP",
  },
  {
    currency: "RUG",
    issuer: "rUbeFouxmztTtzhnC1kHrEk8JAwAGqkweu",
    note: "RUG -- 1,572 XRP",
  },
  {
    currency: "46555A5A59420000000000000000000000000000",
    issuer: "rCiqVyZRZsdEAcoitSeE5Hqd6dxmkX5Kp",
    note: "FUZZYB (hex-encoded) -- 1,382 XRP",
  },
  {
    currency: "424C415A45000000000000000000000000000000",
    issuer: "rC6oCZwv3m8HzqXgMZka6HebibYs6AumY",
    note: "BLAZE (hex-encoded) -- 1,342 XRP",
  },
  {
    currency: "EUR",
    issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq",
    note: "[B] GateHub EUR -- 1,275 XRP",
  },
  {
    currency: "4245415200000000000000000000000000000000",
    issuer: "r3PkzwzNN9LA2g4dvUsno4w2QW3rXgSjxp",
    note: "BEAR (hex-encoded) -- 1,033 XRP",
  },
  {
    currency: "4C697A6100000000000000000000000000000000",
    issuer: "r98e45ShFJaDrZqHAmsqqMSRteSx3e9Rp7",
    note: "Liza (hex-encoded) -- 940 XRP",
  },
  {
    currency: "4354415050000000000000000000000000000000",
    issuer: "rE6xrMvAbwQBrvppjRXC5d6riNjSquTJvU",
    note: "CTAPP (hex-encoded) -- 908 XRP",
  },
  {
    currency: "4465587270000000000000000000000000000000",
    issuer: "rBMCUQ3TLLatmv2MMErQJKu1XBDWFeTcUQ",
    note: "DeXrp (hex-encoded) -- 895 XRP",
  },
  {
    currency: "5048415345520000000000000000000000000000",
    issuer: "rQLfUoZNafhTTJCoCt64isgCcmXdL5a5cp",
    note: "PHASER (hex-encoded) -- 894 XRP",
  },
  {
    currency: "EGO",
    issuer: "rMdoHcW7fy9Pn5RhuZc29qCMUMV35LzDLP",
    note: "EGO -- 861 XRP",
  },
  {
    currency: "4D454B4100000000000000000000000000000000",
    issuer: "rLV8xCAWvSp2WNY7tPade21KHUxtcUCYPs",
    note: "MEKA (hex-encoded) -- 766 XRP",
  },
  {
    currency: "244257545A000000000000000000000000000000",
    issuer: "rrpQUEKXBBtRtxFNCGev1PTJ8FQn51GMHS",
    note: "$BWTZ (hex-encoded) -- 743 XRP",
  },
  {
    currency: "506570537573656A000000000000000000000000",
    issuer: "r9KWVa58BRxwprYzaXoZZjcfKvHHPjosLu",
    note: "PepSusej (hex-encoded) -- 703 XRP",
  },
  {
    currency: "444F4B5800000000000000000000000000000000",
    issuer: "rUjky6A4swzxzPfjememgTQxEJzPSJRgEi",
    note: "DOKX (hex-encoded) -- 664 XRP",
  },
  {
    currency: "5354000000000000000000000000000000000000",
    issuer: "rpdKbneZAENphhVGTgiteRmwbkrHMaBbCH",
    note: "ST (hex-encoded) -- 642 XRP",
  },
  {
    currency: "FIN",
    issuer: "rEJqyQCiqJgqWXLMMJ8cyLwBJUvBA9xmUA",
    note: "FIN -- 622 XRP",
  },
  {
    currency: "424F464C00000000000000000000000000000000",
    issuer: "rGYZ4rUwVAsKa2oThX62pC9fiw8kZBmtyi",
    note: "BOFL (hex-encoded) -- 604 XRP",
  },
];

// ---------------------------------------------------------------------------
// Base mainnet (Ethereum L2, chain id 8453)
// ---------------------------------------------------------------------------

/**
 * Public Base mainnet JSON-RPC endpoint.
 *
 * Read-only is enforced by method vocabulary, as on XRPL: BaseVenue sends only
 * eth_chainId, eth_blockNumber and eth_call, through one gate that throws on
 * anything else, and test/check.ts asserts the allow-list and scans the source.
 * A checked-in constant like every other endpoint here, so each run is
 * attributable to one stated node. No API key, and none may be added: a keyed
 * provider would be the first process.env read in this repo.
 */
export const BASE_RPC_URL = "https://mainnet.base.org";

/** eth_chainId must answer this (0x2105) or the venue refuses to run. */
export const BASE_CHAIN_ID = 8453;

/**
 * Flat round-trip cost assumed for one Base cycle, in ETH.
 *
 * Deliberately an overestimate, erring the same way as
 * STELLAR_BASE_FEE_STROOPS and XRPL_FEE_SAFETY_MULTIPLIER:
 *
 *   gas       a worst-case cycle is three separate swaps at ~130k gas each,
 *             ~390k, rounded to 400k, priced at 0.1 gwei -- well above typical
 *             Base execution prices -- is 0.00004 ETH.
 *   L1 data   the blob-era data fee for a swap is normally far below 1e-6 ETH;
 *             0.00001 ETH of headroom is added for it.
 *
 * Total 0.00005 ETH. It cannot match the other venues in dollars (~$0.15 at an
 * assumed $3,000/ETH against ~$0.0003) because Base gas really is dearer; what
 * is kept is the direction of the error. It is 50 bps of the 0.01 ETH bottom
 * rung, so the bottom of the ladder will rarely clear.
 *
 * Not measured: eth_gasPrice is outside the RPC allow-list. The L1 part could
 * later be read through eth_call to the GasPriceOracle predeploy.
 */
export const BASE_FEE_NATIVE = 0.00005;

/**
 * Hard deadline on one Base tick, and separately on start(), in ms. When it
 * passes every in-flight request is aborted and the tick throws, which
 * monitor.ts records as an error row.
 */
export const BASE_TICK_TIMEOUT_MS = 15_000;

/** Calls per JSON-RPC batch. A normal tick needs at most 19. */
export const BASE_BATCH_MAX = 20;

/**
 * Largest relative gap allowed at startup between our simulate() and an
 * Aerodrome pool's own getAmountOut quote: 0.01%. A pool outside it is dropped.
 */
export const BASE_QUOTE_TOLERANCE = 0.0001;

/** The startup quote check swaps reserve0 / this, in raw units of token0. */
export const BASE_QUOTE_PROBE_DIVISOR = 10_000;

/**
 * Below this many raw output units, integer rounding alone can exceed
 * BASE_QUOTE_TOLERANCE, so the check cannot resolve and the pool is dropped.
 */
export const BASE_QUOTE_MIN_OUT_RAW = 1_000_000;

/** Uniswap V2 pairs charge a fixed 30 bp, in the pair code itself (997/1000). */
export const UNISWAP_V2_FEE_BP = 30;

/** Uniswap V2 factory on Base. UNVERIFIED: owner to check on basescan. */
export const UNISWAP_V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";

/** Aerodrome PoolFactory on Base. UNVERIFIED: owner to check on basescan. */
export const AERODROME_POOL_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

/** One seeded ERC-20, with what start() expects symbol() and decimals() to say. */
export interface BaseSeedToken {
  symbol: string;
  address: string;
  decimals: number;
  /** Free-text provenance. Display and review only; never parsed. */
  note?: string;
}

/**
 * Tokens BaseVenue looks up pools between. No pair walking: every unordered
 * pair of these is asked of the Uniswap V2 factory (getPair) and the Aerodrome
 * factory (getPool, volatile only), which yields WETH pools for direct cycles
 * and token-to-token pools for triangular ones.
 *
 * As on XRPL, the venue sees exactly the pools among these tokens and no
 * others. Read a quiet Base tick as "quiet among these four tokens".
 *
 * symbol and decimals are expectations, checked on-chain in start(); a token
 * that disagrees is dropped and counted, never trusted.
 */
export const BASE_SEED_TOKENS: readonly BaseSeedToken[] = [
  {
    symbol: "WETH",
    address: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    note: "native side, predeploy",
  },
  {
    symbol: "USDC",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
  },
  {
    symbol: "cbBTC",
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    decimals: 8,
    note: "UNVERIFIED: owner to check on basescan",
  },
  {
    symbol: "AERO",
    address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    decimals: 18,
    note: "UNVERIFIED: owner to check on basescan",
  },
];
