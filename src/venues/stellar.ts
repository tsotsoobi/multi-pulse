import {
  HORIZON_BACKOFF_BASE_MS,
  HORIZON_MAX_BACKOFF_MS,
  HORIZON_MAX_PAGES,
  HORIZON_PAGE_LIMIT,
  HORIZON_RETRIES,
  HORIZON_SHARDS,
  HORIZON_TIMEOUT_MS,
  HORIZON_URL,
  STELLAR_BASE_FEE_STROOPS,
} from "../config.js";
import type { Pool, Venue } from "../venue.js";

/**
 * Stellar mainnet, read via Horizon's REST API.
 *
 * This file deliberately does not import @stellar/stellar-sdk. Everything
 * needed to watch pools is a GET against /liquidity_pools, and the SDK's other
 * half is Keypair, TransactionBuilder and Server.submitTransaction. Not
 * importing it means the signing primitives are not in this module's reach at
 * all, which is a stronger guarantee than a flag that says not to use them.
 */

/** Canonical key for XLM. Matches Horizon's own `reserves[].asset` value. */
const NATIVE = "native";

const STROOPS_PER_XLM = 1e7;

interface HorizonReserve {
  asset?: unknown;
  amount?: unknown;
}

export interface HorizonPoolRecord {
  id?: unknown;
  fee_bp?: unknown;
  type?: unknown;
  reserves?: unknown;
}

/** What one page of pools told us, kept so the caller can report truncation. */
export interface FetchStats {
  pages: number;
  /** Records Horizon returned, BEFORE normalisation dropped any. */
  records: number;
  /** Records that could not be turned into a Pool. records - skipped = pools. */
  skipped: number;
  truncated: boolean;
  /** Id-range slices walked concurrently. */
  shards: number;
  /** Wall-clock of the walk itself, in ms. */
  walkMs: number;
}

export class StellarVenue implements Venue {
  readonly name = "stellar";
  readonly nativeKey = NATIVE;
  readonly feeNative = STELLAR_BASE_FEE_STROOPS / STROOPS_PER_XLM;

  /** Stats from the most recent fetchPools(), for the tick summary. */
  lastFetch: FetchStats = {
    pages: 0,
    records: 0,
    skipped: 0,
    truncated: false,
    shards: 0,
    walkMs: 0,
  };

  /**
   * Every liquidity pool on the network, walked to exhaustion.
   *
   * Termination is the zero-record page, not the presence of a `next` link and
   * not a short page. Horizon hands back a `next` cursor unconditionally --
   * including one page past the end -- so following links until they run out
   * never terminates. Stopping on a short page is the opposite failure: a page
   * can come back under the limit for reasons that have nothing to do with
   * being last, and treating that as the end silently truncates the pool set.
   * A truncated pool set does not degrade gracefully here: a cycle is only
   * visible when every leg of it is present, so missing pools remove whole
   * opportunities rather than making the numbers slightly worse.
   */
  async fetchPools(): Promise<Pool[]> {
    const startedAt = Date.now();
    const bounds = shardBounds(HORIZON_SHARDS);

    // Every shard walks its own cursor chain to its own exhaustion, and the
    // shards tile the whole id space, so this is still an exhaustive walk --
    // just not a serial one. See HORIZON_SHARDS.
    const walked = await Promise.all(bounds.map((b) => walkShard(b)));

    // Keyed by pool id rather than concatenated. The shard boundaries are
    // half-open and should not overlap, but a duplicate would be indeterminate
    // rather than harmless: arb.ts treats two pool ids as two independent
    // venues, so the same pool twice reads as a pair of pools quoting identical
    // prices -- a zero-edge cycle that still costs thousands of simulate()
    // calls. Deduping here makes the boundary arithmetic non-load-bearing.
    const byId = new Map<string, Pool>();
    const stats: FetchStats = {
      pages: 0,
      records: 0,
      skipped: 0,
      truncated: false,
      shards: bounds.length,
      walkMs: 0,
    };

    for (const w of walked) {
      stats.pages += w.pages;
      stats.records += w.records;
      stats.skipped += w.skipped;
      stats.truncated ||= w.truncated;
      for (const pool of w.pools) byId.set(pool.id, pool);
    }

    stats.walkMs = Date.now() - startedAt;
    this.lastFetch = stats;
    return [...byId.values()];
  }

  /**
   * Constant product with the pool's OWN fee.
   *
   * feeBp comes off the record every time; there is no 30 bp default anywhere
   * in this file. Stellar's protocol currently fixes constant-product pools at
   * 30, but that is a fact about today's protocol, not about the record we are
   * holding, and a quote priced against the wrong fee is wrong by roughly the
   * size of the edges we are hunting.
   */
  simulate(pool: Pool, fromAssetKey: string, amountIn: number): number {
    const fromIsA = fromAssetKey === pool.a;
    const rIn = fromIsA ? pool.ra : pool.rb;
    const rOut = fromIsA ? pool.rb : pool.ra;

    const inNet = amountIn * (1 - pool.feeBp / 10_000);
    if (!(inNet > 0)) return 0;
    return (inNet * rOut) / (rIn + inNet);
  }

  /**
   * DISPLAY ONLY -- see the warning on Venue.assetLabel.
   *
   * The issuer fragment is not decoration. "USDC" on mainnet is issued by the
   * real Circle account and by an open-ended number of impostors, and a label
   * that printed only the code would render a route through a forgery
   * identically to a route through the real thing. Both ends of the issuer are
   * shown because Stellar addresses share a low-entropy prefix.
   */
  assetLabel(key: string): string {
    if (key === NATIVE) return "XLM";

    const sep = key.indexOf(":");
    if (sep < 0) return key;

    const code = key.slice(0, sep);
    const issuer = key.slice(sep + 1);
    if (issuer.length <= 12) return `${code}(${issuer})`;
    return `${code}(${issuer.slice(0, 4)}..${issuer.slice(-4)})`;
  }
}

/** Half-open id range for one shard: (after, upTo]. */
interface ShardBound {
  /** Exclusive lower bound, as a cursor. Empty means "from the beginning". */
  after: string;
  /** Inclusive upper bound. Null on the last shard, which has no ceiling. */
  upTo: string | null;
}

/** Pool ids are 64 lowercase hex characters, always. */
const ID_HEX_LEN = 64;

/**
 * Cut the pool-id space into `count` contiguous ranges.
 *
 * The cut points are the first four hex characters scaled across 0x0000..0xffff
 * and zero-padded to full width. That works because a pool id is a hash: the
 * ids are spread evenly across the space, so equal slices of the SPACE are
 * roughly equal slices of the POOL SET, without anyone having to know what the
 * ids are beforehand. Four characters is 65,536 cut points, far finer than any
 * shard count worth using.
 *
 * The ranges are half-open, (after, upTo], and they tile the space with no gap
 * and no overlap:
 *
 *   - shard 0 has an empty `after`, so it starts before the lowest id rather
 *     than after some cut point.
 *   - shard k > 0 starts with cursor = the cut point, and Horizon's cursor is
 *     EXCLUSIVE, so it begins strictly after it.
 *   - shard k-1 stops once it sees an id strictly GREATER than that same cut
 *     point, so an id landing exactly on a boundary is kept by k-1 rather than
 *     falling into the gap between the two.
 *   - the last shard has no ceiling and walks to the end of the space.
 */
export function shardBounds(count: number): ShardBound[] {
  const n = Math.max(1, Math.floor(count));
  const cut = (i: number): string =>
    Math.floor((i * 0x1_0000) / n)
      .toString(16)
      .padStart(4, "0")
      .padEnd(ID_HEX_LEN, "0");

  const out: ShardBound[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      after: i === 0 ? "" : cut(i),
      upTo: i === n - 1 ? null : cut(i + 1),
    });
  }
  return out;
}

interface ShardResult {
  pools: Pool[];
  pages: number;
  records: number;
  skipped: number;
  truncated: boolean;
}

/**
 * Walk one id range to exhaustion.
 *
 * Termination is unchanged from the serial walk -- the zero-record page, never
 * a missing `next` link and never a short page -- with one addition: a shard
 * also stops when it walks past its own ceiling, because the records beyond it
 * belong to the next shard and are being fetched there concurrently.
 *
 * `baseUrl` defaults to HORIZON_URL, so every existing call issues exactly the
 * request it always did. It exists so that another Horizon, Pi's in Phase 2 of
 * docs/pi-mainnet.md, can be walked by the same code rather than a copy.
 */
async function walkShard(
  bound: ShardBound,
  baseUrl: string = HORIZON_URL,
): Promise<ShardResult> {
  const out: ShardResult = {
    pools: [],
    pages: 0,
    records: 0,
    skipped: 0,
    truncated: false,
  };

  let url =
    `${baseUrl}/liquidity_pools` +
    `?limit=${HORIZON_PAGE_LIMIT}&order=asc` +
    (bound.after ? `&cursor=${bound.after}` : "");

  while (url) {
    if (out.pages >= HORIZON_MAX_PAGES) {
      out.truncated = true;
      break;
    }

    const page = await getJson(url);
    out.pages++;

    const records = Array.isArray(page?._embedded?.records)
      ? (page._embedded.records as HorizonPoolRecord[])
      : [];

    // The terminator. An empty page means the cursor has run off the end.
    if (records.length === 0) break;

    let crossed = false;
    for (const r of records) {
      // Compared as plain strings, which is exact here and not a shortcut: ids
      // are fixed-width lowercase hex, so lexicographic order and Horizon's
      // `order=asc` are the same order. A variable-width or numeric token would
      // need real parsing, and this would silently mis-slice.
      if (bound.upTo !== null && typeof r.id === "string" && r.id > bound.upTo) {
        crossed = true;
        break;
      }
      out.records++;
      const pool = toPool(r);
      if (pool) out.pools.push(pool);
      else out.skipped++;
    }
    if (crossed) break;

    const next = page?._links?.next?.href;
    url = typeof next === "string" ? next : "";
  }

  return out;
}

/**
 * One read-only GET.
 *
 * The method is pinned explicitly rather than left to fetch's default so that
 * any future edit that tries to POST through this helper has to say so in
 * writing. There is no request body, no Authorization header, and no other
 * transport in this repo.
 */
export async function getJson(url: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS),
      });
    } catch (e: any) {
      // A TRANSPORT failure -- a timeout, a dropped connection, a DNS blip --
      // rather than an answer from Horizon. It has to be retried for the same
      // reason a 429 does, and leaving it out was half a fix: the walk issues
      // ~206 requests, so one stalled request threw away all 206, the tick was
      // logged as an error, and StreakTracker correctly treated the whole
      // interval as unobserved. Measured persistence was therefore capped by
      // local network weather rather than by the market. Seen in the wild at
      // ~19% of Stellar ticks in an hour, all "aborted due to timeout" or
      // "fetch failed", with no 429 among them.
      if (attempt > HORIZON_RETRIES) throw e;
      await sleep(Math.min(HORIZON_BACKOFF_BASE_MS * attempt, HORIZON_MAX_BACKOFF_MS));
      continue;
    }

    if (res.ok) return res.json();

    // 429 and 5xx are "ask again later", not "this request was wrong". They
    // must not fail the tick: monitor.ts logs a failed tick as an error row and
    // StreakTracker treats it as an unobserved interval, which BREAKS EVERY
    // STREAK. A transient rate limit would therefore not just cost one sample,
    // it would silently cap measured persistence at one tick -- destroying the
    // one measurement this repo exists to produce, while the CSV still looked
    // healthy. Retrying here keeps the tick whole.
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt > HORIZON_RETRIES) {
      const body = await res.text().catch(() => "");
      throw new Error(`Horizon ${res.status} for ${url}: ${body.slice(0, 200)}`);
    }

    // Horizon states how long to wait when it rate-limits. Honour it rather
    // than guessing; guessing low is what caused the limit in the first place.
    const header = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(header) && header > 0
      ? Math.min(header * 1000, HORIZON_MAX_BACKOFF_MS)
      : Math.min(HORIZON_BACKOFF_BASE_MS * attempt, HORIZON_MAX_BACKOFF_MS);
    await res.text().catch(() => {});
    await sleep(waitMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Normalise one Horizon record, or null if it cannot be priced.
 *
 * Everything here is a rejection rather than a repair. A record with a missing
 * or unparseable fee cannot be quoted without inventing a number, and the
 * invented number would not announce itself in the CSV -- it would just shift
 * every route through the pool by the size of the guess. Skipped records are
 * counted so a sudden jump is visible in the heartbeat.
 */
export function toPool(r: HorizonPoolRecord): Pool | null {
  if (typeof r.id !== "string" || r.id.length === 0) return null;

  // Only constant-product pools; simulate() prices nothing else.
  if (r.type !== undefined && r.type !== "constant_product") return null;

  const feeBp = Number(r.fee_bp);
  if (!Number.isFinite(feeBp) || feeBp < 0 || feeBp >= 10_000) return null;

  if (!Array.isArray(r.reserves) || r.reserves.length !== 2) return null;
  const x = r.reserves[0] as HorizonReserve;
  const y = r.reserves[1] as HorizonReserve;

  const a = assetKey(x);
  const b = assetKey(y);
  if (!a || !b || a === b) return null;

  const ra = Number(x.amount);
  const rb = Number(y.amount);
  // Empty pools quote a zero or a division by zero, never an opportunity.
  if (!Number.isFinite(ra) || !Number.isFinite(rb) || ra <= 0 || rb <= 0) {
    return null;
  }

  return { id: r.id, a, b, ra, rb, feeBp };
}

/**
 * Canonical asset key, taken verbatim from Horizon.
 *
 * Horizon already emits exactly the form we want -- "native", or
 * "CODE:ISSUER" -- so this reformats nothing. Re-deriving the key would risk
 * disagreeing with the string Horizon uses, and every comparison downstream is
 * an === on this value.
 */
function assetKey(reserve: HorizonReserve): string | null {
  return typeof reserve?.asset === "string" && reserve.asset.length > 0
    ? reserve.asset
    : null;
}
