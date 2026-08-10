import {
  HORIZON_MAX_PAGES,
  HORIZON_PAGE_LIMIT,
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

interface HorizonPoolRecord {
  id?: unknown;
  fee_bp?: unknown;
  type?: unknown;
  reserves?: unknown;
}

/** What one page of pools told us, kept so the caller can report truncation. */
export interface FetchStats {
  pages: number;
  records: number;
  skipped: number;
  truncated: boolean;
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
    const pools: Pool[] = [];
    const stats: FetchStats = {
      pages: 0,
      records: 0,
      skipped: 0,
      truncated: false,
    };

    let url =
      `${HORIZON_URL}/liquidity_pools` +
      `?limit=${HORIZON_PAGE_LIMIT}&order=asc`;

    while (url) {
      if (stats.pages >= HORIZON_MAX_PAGES) {
        stats.truncated = true;
        break;
      }

      const page = await getJson(url);
      stats.pages++;

      const records = Array.isArray(page?._embedded?.records)
        ? (page._embedded.records as HorizonPoolRecord[])
        : [];

      // The terminator. An empty page means the cursor has run off the end.
      if (records.length === 0) break;

      stats.records += records.length;
      for (const r of records) {
        const pool = toPool(r);
        if (pool) pools.push(pool);
        else stats.skipped++;
      }

      const next = page?._links?.next?.href;
      url = typeof next === "string" ? next : "";
    }

    this.lastFetch = stats;
    return pools;
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

/**
 * One read-only GET.
 *
 * The method is pinned explicitly rather than left to fetch's default so that
 * any future edit that tries to POST through this helper has to say so in
 * writing. There is no request body, no Authorization header, and no other
 * transport in this repo.
 */
async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Horizon ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
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
function toPool(r: HorizonPoolRecord): Pool | null {
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
