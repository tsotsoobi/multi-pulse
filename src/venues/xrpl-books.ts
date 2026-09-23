import { nativeReserve, partitionByDepth, type SearchLimits } from "../arb.js";
import { other, type Pool, type Venue } from "../venue.js";

/**
 * XRPL order books, priced next to the AMM for the same pair. OBSERVATION ONLY.
 *
 * Nothing in this module feeds findOpportunities, the main CSV, route keys,
 * dedupe or the route streaks. It answers one question and writes the answer to
 * data/book-gaps.csv: does a cycle that uses the order book on one hop and the
 * AMM on the other clear the same floors the AMM search is held to? See
 * FINDINGS.md section 8 for the pre-registered hypothesis.
 *
 * Pure and offline, like arb.ts: no I/O, no clock. The reads live in
 * XrplVenue.observeBooks, and the wire parsing next to the other wire shapes in
 * xrpl.ts, so that every function here can be tested against hand-built levels.
 *
 * THE MIXED FIGURES ARE LOWER BOUNDS. XRPL's payment engine does not choose
 * between the AMM and the book per hop: within a single hop it takes whichever
 * is better at each increment and blends the two. The cycles priced here use
 * one venue per hop, so the engine would do at least as well as each of them.
 * A gap reported here is therefore something the ledger could deliver or beat,
 * and a gap the engine could exploit may be missing.
 */

/**
 * One offer, as the taker sees it: `pays` of the book's input asset buys `gets`
 * of its output asset. Both in whole units; drops were converted in xrpl.ts.
 * When rippled reports the owner as underfunded, these are the *_funded amounts.
 */
export interface BookLevel {
  /** Offer owner. Kept so the AMM-account check can see it. */
  account: string;
  gets: number;
  pays: number;
}

export interface WalkResult {
  /** Output asset received. */
  out: number;
  /** Levels touched, including a partly filled last one. */
  levelsUsed: number;
}

/**
 * Tolerance on the input left over after the last level, relative to the
 * input. Filling several levels exactly can leave a remainder of a few ulps,
 * and that must not read as "the book ran out".
 */
const WALK_EPSILON = 1e-12;

/**
 * Take `amountIn` of the book's input asset through the levels, best price
 * first, and return what comes out.
 *
 * `inTransferRate` is the issuer's TransferRate on the input asset (1 for XRP):
 * spending an issued token costs the sender `rate` times what arrives, so only
 * amountIn / rate reaches the book.
 *
 * Returns null if the book runs out before the input is spent. Never a partial
 * fill, and never a mid-price stand-in: a size the book cannot carry has no
 * book price at all.
 */
export function walkBook(
  levels: readonly BookLevel[],
  amountIn: number,
  inTransferRate = 1,
): WalkResult | null {
  if (!(amountIn > 0) || !Number.isFinite(amountIn)) return null;
  if (!(inTransferRate >= 1) || !Number.isFinite(inTransferRate)) return null;

  // rippled already returns offers in quality order. Sorted again anyway,
  // stably, because the walk is only correct in price order and that should
  // not rest on a reply format.
  const sorted = levels
    .filter((l) => l.gets > 0 && l.pays > 0)
    .map((l, i) => ({ l, i }))
    .sort((p, q) => p.l.pays / p.l.gets - q.l.pays / q.l.gets || p.i - q.i)
    .map((p) => p.l);

  const delivered = amountIn / inTransferRate;
  let remaining = delivered;
  let out = 0;
  let levelsUsed = 0;

  for (const l of sorted) {
    if (remaining <= delivered * WALK_EPSILON) break;
    levelsUsed++;
    if (remaining >= l.pays) {
      out += l.gets;
      remaining -= l.pays;
    } else {
      out += (remaining * l.gets) / l.pays;
      remaining = 0;
    }
  }

  if (remaining > delivered * WALK_EPSILON) return null;
  return { out, levelsUsed };
}

/**
 * An issuer's TransferRate as a multiplier, or null if the field is not one.
 *
 * The ledger stores it as an integer in billionths: 1,000,000,000 is no fee and
 * 2,000,000,000 (a 100% fee) is the protocol maximum. Absent or 0 both mean no
 * fee. Anything else is rejected rather than guessed, and the pair is skipped
 * until a later read succeeds: a wrong fee would shift every figure for the
 * pair by exactly the size of the error.
 */
export function transferRateOf(field: unknown): number | null {
  if (field === undefined || field === null || field === 0) return 1;
  if (typeof field !== "number" || !Number.isInteger(field)) return null;
  if (field < 1_000_000_000 || field > 2_000_000_000) return null;
  return field / 1_000_000_000;
}

/** A counter-asset whose XRP pair is observed. */
export interface BookPair {
  /** Canonical key of the counter-asset, `CURRENCY:issuer`. */
  counterKey: string;
  currency: string;
  issuer: string;
  /** The pool's AMM account at selection time. */
  ammAccount: string;
  /** Native reserve at selection time, which is what it was ranked on. */
  nativeReserve: number;
}

/**
 * The `n` deepest native-side pools, one per counter-asset.
 *
 * Only pools that survive partitionByDepth are eligible, so a pair the AMM
 * search would not look at is not observed either. Token-to-token pools have
 * no native side and are skipped. XRPL permits one AMM per pair, so merging by
 * counter-asset only matters if two seed encodings resolved to the same asset;
 * the deeper one is kept.
 *
 * Deterministic: ranked by native reserve, ties broken by counter key, so the
 * same pools in any order give the same selection.
 */
export function selectBookPairs(
  venue: Venue,
  pools: readonly Pool[],
  minPoolNative: number,
  n: number,
): BookPair[] {
  const { deep } = partitionByDepth(venue, [...pools], minPoolNative);
  const best = new Map<string, { pool: Pool; native: number }>();

  for (const p of deep) {
    const native = nativeReserve(venue, p);
    if (native === null) continue;
    const counter = other(p, venue.nativeKey);
    if (counter === venue.nativeKey) continue;
    const prev = best.get(counter);
    if (!prev || native > prev.native) best.set(counter, { pool: p, native });
  }

  const out: BookPair[] = [];
  for (const [counterKey, { pool, native }] of best) {
    const sep = counterKey.indexOf(":");
    if (sep <= 0) continue;
    out.push({
      counterKey,
      currency: counterKey.slice(0, sep),
      issuer: counterKey.slice(sep + 1),
      ammAccount: pool.id,
      nativeReserve: native,
    });
  }

  out.sort(
    (a, b) =>
      b.nativeReserve - a.nativeReserve ||
      (a.counterKey < b.counterKey ? -1 : a.counterKey > b.counterKey ? 1 : 0),
  );
  return out.slice(0, Math.max(0, n));
}

/** Which mixed cycle a row describes. */
export type BookDirection = "book>amm" | "amm>book";

export const BOOK_DIRECTIONS: readonly BookDirection[] = ["book>amm", "amm>book"];

/**
 * The four round trips for one pair at one rung, XRP in and XRP out.
 *
 * null means a book leg ran out at this size; the AMM figures are never null.
 */
export interface RungFigures {
  rung: number;
  /** XRP -> T on the AMM, T -> XRP on the same AMM. */
  ammOut: number;
  /** XRP -> T on the book, T -> XRP on the opposite book. */
  bookOut: number | null;
  /** XRP -> T on the book, T -> XRP on the AMM. */
  bookThenAmm: number | null;
  /** XRP -> T on the AMM, T -> XRP on the book. */
  ammThenBook: number | null;
  /** Levels of the XRP -> T book used by bookThenAmm. */
  buyLevels: number;
  /** Levels of the T -> XRP book used by ammThenBook. */
  sellLevels: number;
}

/**
 * Price one rung of one pair.
 *
 * `buyT` is the book that sells T for XRP (taker pays XRP, gets T); `sellT` is
 * the book that buys T for XRP (taker pays T, gets XRP).
 *
 * TRANSFER FEE. `rate` is charged once per cycle, on the hop where the cycle
 * spends T, for book and AMM legs alike. On XRPL the sender of an issued token
 * pays the issuer's fee, and in each of these cycles our side sends T exactly
 * once. Whether the ledger actually charges it when the AMM is the counterparty
 * is unverified; it is charged anyway, so AMM legs are understated rather than
 * overstated. The receiving hop is not charged: there the offer owner or the
 * AMM is the sender.
 */
export function priceRung(
  venue: Venue,
  pool: Pool,
  buyT: readonly BookLevel[],
  sellT: readonly BookLevel[],
  rung: number,
  rate: number,
): RungFigures {
  const native = venue.nativeKey;
  const counter = other(pool, native);

  const ammT = venue.simulate(pool, native, rung);
  const bookT = walkBook(buyT, rung);

  const ammOut = venue.simulate(pool, counter, ammT / rate);
  const bookThenAmm = bookT ? venue.simulate(pool, counter, bookT.out / rate) : null;
  const sellAfterAmm = walkBook(sellT, ammT, rate);
  const bookOut = bookT ? (walkBook(sellT, bookT.out, rate)?.out ?? null) : null;

  return {
    rung,
    ammOut,
    bookOut,
    bookThenAmm,
    ammThenBook: sellAfterAmm?.out ?? null,
    buyLevels: bookT?.levelsUsed ?? 0,
    sellLevels: sellAfterAmm?.levelsUsed ?? 0,
  };
}

/** The rung and direction a book-gaps row is written for. */
export interface GapPick {
  figures: RungFigures;
  direction: BookDirection;
  /** The chosen mixed cycle's XRP out. */
  mixedOut: number;
  /** mixedOut - rung - fee. */
  netProfit: number;
  /** netProfit / rung, in bps. */
  netBps: number;
  /** (mixedOut - ammOut) / rung, in bps. */
  mixedVsAmmBps: number;
  /** Book levels used on the chosen direction's book leg. */
  levelsUsed: number;
}

/**
 * THE ROW RULE, and the streak inputs.
 *
 * A (rung, direction) qualifies when its mixed cycle clears the same two floors
 * bestSize() in arb.ts holds the AMM search to: net profit of at least
 * minNetProfit and net bps of at least minProfitBps, after the flat network
 * fee. Rungs above maxSize are ignored, as they are there.
 *
 * `qualifying` lists every direction with at least one qualifying rung; it
 * drives the streaks. `pick` is the single qualifying (rung, direction) with
 * the largest net profit, ties to the smaller rung; it is the one row written
 * for this pair this tick. At most one row per pair per tick keeps the file to
 * at most XRPL_BOOK_PAIRS rows a tick.
 *
 * "Beats the AMM-only cycle" is deliberately NOT a trigger. A round trip through
 * one AMM always loses about twice its fee, so any book quoting inside that band
 * beats it at nearly every rung on nearly every tick. It rides along on every
 * written row as mixedVsAmmBps instead.
 */
export function pickGapRow(
  figs: readonly RungFigures[],
  feeNative: number,
  limits: SearchLimits,
): { qualifying: BookDirection[]; pick: GapPick | null } {
  const qualifying = new Set<BookDirection>();
  let pick: GapPick | null = null;

  for (const f of figs) {
    if (f.rung > limits.maxSize) continue;

    for (const direction of BOOK_DIRECTIONS) {
      const mixedOut = direction === "book>amm" ? f.bookThenAmm : f.ammThenBook;
      if (mixedOut === null || !Number.isFinite(mixedOut)) continue;

      const netProfit = mixedOut - f.rung - feeNative;
      const netBps = (netProfit / f.rung) * 10_000;
      if (netProfit < limits.minNetProfit) continue;
      if (netBps < limits.minProfitBps) continue;

      qualifying.add(direction);

      const better =
        !pick ||
        netProfit > pick.netProfit ||
        (netProfit === pick.netProfit && f.rung < pick.figures.rung);
      if (better) {
        pick = {
          figures: f,
          direction,
          mixedOut,
          netProfit,
          netBps,
          mixedVsAmmBps: ((mixedOut - f.ammOut) / f.rung) * 10_000,
          levelsUsed: direction === "book>amm" ? f.buyLevels : f.sellLevels,
        };
      }
    }
  }

  return { qualifying: BOOK_DIRECTIONS.filter((d) => qualifying.has(d)), pick };
}

/** One row of data/book-gaps.csv, before the streak columns are attached. */
export interface BookGap {
  ledger: number;
  /** `XRP/CURRENCY:issuer`, in the ledger's own encoding. A key, not a label. */
  pairKey: string;
  /** DISPLAY ONLY. */
  pairLabel: string;
  direction: BookDirection;
  rung: number;
  ammOut: number;
  bookOut: number | null;
  bookThenAmm: number | null;
  ammThenBook: number | null;
  feeNative: number;
  netProfit: number;
  netBps: number;
  mixedVsAmmBps: number;
  levelsUsed: number;
  transferRate: number;
  ammFeeBp: number;
}

/** What one pair's observation produced this tick. Only pairs actually read. */
export interface BookOutcome {
  pairKey: string;
  /** Directions that cleared the floors at some rung. The rest reset. */
  qualifying: BookDirection[];
  /** The row to write, if any direction qualified. */
  row: BookGap | null;
}

/** The streak key for one pair and direction. */
export function bookStreakKey(pairKey: string, direction: BookDirection): string {
  return `${pairKey}|${direction}`;
}
