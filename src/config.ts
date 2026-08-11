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
export type VenueName = "stellar" | "xrpl";

/**
 * Which venues the monitor drives. Run one, or both.
 *
 * Venues are polled sequentially and their results never mix: opportunities are
 * cycles within a single venue, streaks are tracked per venue, and the CSV
 * carries a `venue` column. Enabling both does not look for cross-chain routes
 * and could not -- there is no bridge in this program and nothing to bridge
 * with.
 */
export const ENABLED_VENUES: readonly VenueName[] = ["stellar", "xrpl"];

/** Horizon base URL. Read-only REST; only GET requests are ever issued. */
export const HORIZON_URL = "https://horizon.stellar.org";

/** How often to poll every venue, in milliseconds. */
export const POLL_MS = 2000;

/**
 * Records per Horizon page. 200 is Horizon's maximum; a smaller value only
 * multiplies the number of round trips needed to see the same pool set.
 */
export const HORIZON_PAGE_LIMIT = 200;

/**
 * Hard stop on pages walked per fetchPools() call.
 *
 * Horizon's paging cursor always yields a `next` link, including on the empty
 * page past the end, so the loop's real terminator is the zero-record page.
 * This cap exists only so a Horizon bug or a cursor that fails to advance
 * cannot spin forever inside one tick. At 200 records a page it admits 60k
 * pools, comfortably above the live mainnet count -- if this cap is ever hit,
 * the pool set is truncated and the tick is reported as incomplete rather than
 * quietly under-counted.
 */
export const HORIZON_MAX_PAGES = 300;

/** Per-request timeout for Horizon GETs, in milliseconds. */
export const HORIZON_TIMEOUT_MS = 15_000;

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
 * WHAT IT CANNOT DO. The floor is measured on the pool's NATIVE side, so it
 * cannot be applied to token-to-token pools, which have no native side and no
 * depth measure comparable across assets without a price feed this repo does
 * not have. Those pools stay in the graph. A triangular cycle therefore still
 * has one leg that is not depth-checked, though both of its outer legs are.
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
 * Alternatives, both verified to answer correctly: wss://s1.ripple.com,
 * wss://s2.ripple.com. They matter more than they look: a public cluster will
 * IP rate-limit a heavy caller off itself, and `npm run seeds` is heavy enough
 * to trigger that. The scripts take an endpoint argument for exactly this; the
 * monitor does not, because a run should be attributable to one stated node.
 */
export const XRPL_WS_URL = "wss://xrplcluster.com";

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
