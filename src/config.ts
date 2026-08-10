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
 * Largest single trade the search will consider, in the venue's native asset.
 *
 * This is not a safety limit -- nothing here can trade -- it is a realism
 * limit. Sizes far above what anyone would actually route produce "edges" that
 * exist only in the tail of a curve nobody would touch, and they would
 * dominate a ranking that sorts on absolute profit.
 *
 * Keep this and SIZE_LADDER in step. arb.ts drops ladder rungs above the
 * ceiling silently, so raising the ladder alone is a no-op with no error.
 */
export const MAX_TRADE_SIZE = 1000;

/** Input sizes probed for every candidate route, in the native asset. */
export const SIZE_LADDER = [1, 5, 10, 25, 50, 100, 160, 250, 400, 650, 1000];

/**
 * Minimum NET edge, in basis points of trade size, for a route to be logged.
 *
 * Net means after pool fees (already inside every quote) and after the flat
 * network fee, so this is a pure margin over break-even rather than a fee
 * coverage rule. A gross threshold cannot express fee coverage at all: the fee
 * is flat, so break-even is 10000 * fee / size bps -- very different at the
 * bottom and top of the ladder.
 */
export const MIN_PROFIT_BPS = 20;

/**
 * Absolute floor on net profit per route, in the native asset.
 *
 * A percentage floor alone still admits dust: 20 net bps at size 1 is 0.002
 * XLM. Applied alongside MIN_PROFIT_BPS, both must clear.
 */
export const MIN_NET_PROFIT = 0.01;

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
 */
export const STELLAR_BASE_FEE_STROOPS = 10_000;

/** Rows of detail printed per tick. The CSV keeps everything regardless. */
export const SUMMARY_TOP_N = 3;
