/**
 * A venue is one AMM the monitor watches. Everything chain-specific lives
 * behind this interface so arb.ts, logger.ts and monitor.ts never learn what
 * chain they are looking at.
 *
 * OBSERVATION ONLY. Nothing in this interface, or in anything implementing it,
 * may sign, submit, or build a transaction. A venue reads public state and
 * prices it offline; that is the whole contract. There is deliberately no
 * `execute`, no `submit`, no account, and no key material anywhere in the
 * shape -- an implementation with nothing to sign with cannot be talked into
 * signing, and adding the capability would mean editing this file first.
 */

/**
 * A two-asset constant-product pool, normalised across venues.
 *
 * `a` and `b` are CANONICAL ASSET KEYS, not codes. On Stellar mainnet the same
 * code is issued by many different accounts -- including deliberate forgeries
 * of well-known stablecoins -- so a key that dropped the issuer would silently
 * merge a real USDC pool with a fake one and quote a route across both. Keys
 * are compared with `===` throughout arb.ts and must therefore be unique per
 * asset, not per code. Use assetLabel() when a human has to read one.
 */
export interface Pool {
  /** Venue-native pool identifier, unique within the venue. */
  id: string;
  /** Canonical asset key for the first reserve. */
  a: string;
  /** Canonical asset key for the second reserve. */
  b: string;
  /** Reserve of asset `a`, in whole units of `a`. */
  ra: number;
  /** Reserve of asset `b`, in whole units of `b`. */
  rb: number;
  /**
   * This pool's own swap fee in basis points, as the venue reports it.
   *
   * Per-pool, never a constant: a venue is free to host pools at different fee
   * tiers, and assuming 30 bp on a pool that charges more overstates every
   * quote through it by the difference -- which is exactly the size of the
   * edges we are looking for.
   */
  feeBp: number;
}

export interface Venue {
  /** Short identifier for logs and the CSV `venue` column. */
  readonly name: string;

  /**
   * Canonical key of the asset every cycle starts and ends in (the venue's
   * gas/native asset). arb.ts uses this as the cycle anchor, and fees are
   * denominated in it.
   */
  readonly nativeKey: string;

  /**
   * Flat cost of one round trip on this venue, in native units, used ONLY to
   * price whether an edge would have been worth taking.
   *
   * It is a property of the venue rather than a config knob because it is a
   * fact about the chain, and it is flat rather than proportional because the
   * chains we watch charge per transaction: as a fraction of size it is
   * 10000 * fee / size bps, so it buries small sizes and rounds to nothing at
   * large ones. That asymmetry is why net profit, not gross bps, decides both
   * acceptance and ranking in arb.ts.
   */
  readonly feeNative: number;

  /**
   * Every pool on the venue, fully paginated.
   *
   * Implementations MUST walk the venue's paging links to exhaustion rather
   * than returning the first page. A partial pool set does not produce a
   * partial answer -- it produces confident wrong answers, because a cycle is
   * only detectable when every leg of it is present, and the pools that are
   * missing are unknowable from the pools that are not.
   *
   * Read-only HTTP GET only.
   */
  fetchPools(): Promise<Pool[]>;

  /**
   * Output of swapping `amountIn` of `fromAssetKey` through `pool`, priced
   * against the reserves in hand.
   *
   * Pure and offline: no I/O, no clock, no shared state. arb.ts calls this
   * tens of thousands of times per tick over a snapshot of pools, and the
   * whole snapshot must be priced as one instant.
   *
   * `fromAssetKey` is a canonical key and must be `pool.a` or `pool.b`.
   */
  simulate(pool: Pool, fromAssetKey: string, amountIn: number): number;

  /**
   * Human-readable name for a canonical asset key. DISPLAY ONLY.
   *
   * Labels are lossy by design -- two different issuers of "USDC" both label
   * as "USDC" -- so a label must never be used as a map key, a dedupe key, or
   * a blacklist entry. Route identity is the full issuer-qualified key; see
   * routeKey vs routeLabel in arb.ts.
   */
  assetLabel(key: string): string;
}

/** The asset on the other side of a pool from `key`. */
export function other(pool: Pool, key: string): string {
  return key === pool.a ? pool.b : pool.a;
}
