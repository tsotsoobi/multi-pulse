import { Client } from "xrpl";

import {
  XRPL_BASE_FEE_DROPS,
  XRPL_DISCOVERY_BATCH,
  XRPL_FEE_SAFETY_MULTIPLIER,
  XRPL_NEGATIVE_RECHECK_MS,
  XRPL_PROBE_CONCURRENCY,
  XRPL_SEED_TOKENS,
  XRPL_TIMEOUT_MS,
  XRPL_WS_URL,
  type SeedToken,
} from "../config.js";
import type { Pool, Venue } from "../venue.js";

/**
 * XRPL mainnet, read through rippled's public API.
 *
 * READ-ONLY, AND WHY THAT NEEDS SAYING LOUDER HERE THAN IT DID FOR STELLAR.
 * The Stellar adapter is safe by omission: @stellar/stellar-sdk is not a
 * dependency, so Keypair and TransactionBuilder are not on disk and the module
 * has nothing to sign with. That argument is unavailable here. `xrpl` is a real
 * dependency -- it is how we talk to rippled at all -- and it ships Wallet,
 * sign, autofill and submitAndWait in the same package as Client.
 *
 * So the guarantee is narrowed by hand and then enforced by the test suite:
 *
 *   1. `Client` is the only binding imported from `xrpl` anywhere under src/.
 *      Response shapes are declared locally, below, rather than imported, so
 *      that no transaction type is ever pulled into scope.
 *   2. The only rippled commands issued are `server_info`, `ledger` and
 *      `amm_info`. All three are ledger reads. `submit` is a rippled command
 *      name too, reachable through the same Client.request() we do use, so the
 *      command literals are checked as tightly as the imports.
 *
 * Both are asserted by test/check.ts against the source text. See the
 * read-only property block there -- that test, not this comment, is what makes
 * the claim survive the next edit.
 */

/** Canonical key for the native asset. */
const NATIVE = "XRP";

/** 1 XRP = 1e6 drops. XRP amounts arrive from rippled as drops, always. */
const DROPS_PER_XRP = 1_000_000;

/**
 * Denominator of the AMM `trading_fee` field. XLS-30 quotes the fee in
 * 1/100,000, so 462 is 0.462%. Basis points are 1/10,000, hence feeBp = tf/10.
 */
const TRADING_FEE_UNIT = 100_000;

/** Standard currency codes are 3 bytes ASCII; everything else is 20 bytes hex. */
const STD_CODE = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;
const HEX_CODE = /^[0-9A-Fa-f]{40}$/;
const R_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

/** rippled error codes that mean "this AMM does not exist". */
const ABSENT_CODES = new Set(["actNotFound", "ammNotFound", "objectNotFound"]);

type PairState = "live" | "absent";

interface CacheEntry {
  state: PairState;
  checkedAtMs: number;
}

/** A candidate pair, in the form the probe asks about. */
interface Candidate {
  /** Stable identity for the cache. Derived from the request, not the reply. */
  cacheKey: string;
  a: CurrencySpec;
  b: CurrencySpec;
}

/** rippled's `Currency` object: XRP is `{currency:"XRP"}`, tokens carry issuer. */
type CurrencySpec = { currency: "XRP" } | { currency: string; issuer: string };

/** What the last fetchPools() did, for the heartbeat. */
export interface XrplFetchStats {
  /** Total candidate pairs in the enumeration. */
  pairs: number;
  /** Discovery probes issued this tick (pairs whose state was unknown/stale). */
  probed: number;
  /** Candidate pairs currently known to have an AMM. */
  live: number;
  /** Candidate pairs currently known to have none. */
  absent: number;
  /** Candidate pairs never successfully resolved either way, yet. */
  unknown: number;
  /** Probes that failed for a reason other than "no such AMM". */
  errors: number;
  /** Live pools that could not be normalised into a Pool. */
  skipped: number;
  /** Ledger index every returned pool was priced at, or 0 if unpinned. */
  ledgerIndex: number;
}

export class XrplVenue implements Venue {
  readonly name = "xrpl";
  readonly nativeKey = NATIVE;

  /**
   * Flat round-trip cost in XRP.
   *
   * Not `readonly` on the class even though the interface declares it so:
   * start() overwrites it once with the live reference fee from server_info.
   * The declared value is the config fallback, used if the network never
   * answers.
   *
   * XRPL_FEE_SAFETY_MULTIPLIER is applied in BOTH places, and that is the whole
   * point of it -- a reference fee is one transaction at the current floor,
   * whichever way it was obtained, and a cycle is two or three transactions at
   * whatever the fee has risen to since. See the constant for why erring the
   * same way as the Stellar adapter matters more here than the exact figure.
   */
  feeNative = (XRPL_BASE_FEE_DROPS * XRPL_FEE_SAFETY_MULTIPLIER) / DROPS_PER_XRP;

  /** True once the fee above came from the ledger rather than from config. */
  feeIsLive = false;

  lastFetch: XrplFetchStats = {
    pairs: 0,
    probed: 0,
    live: 0,
    absent: 0,
    unknown: 0,
    errors: 0,
    skipped: 0,
    ledgerIndex: 0,
  };

  /**
   * Seeds that never reach the network, and why. Never silently empty-handled:
   * see classifySeeds for the incident that put this here.
   */
  readonly droppedSeeds: DroppedSeed[];

  private client: Client | null = null;
  private readonly candidates: Candidate[];
  private readonly cache = new Map<string, CacheEntry>();

  /** Rotating cursor into `candidates`, so discovery sweeps the whole set. */
  private discoveryCursor = 0;

  constructor(seeds: readonly SeedToken[] = XRPL_SEED_TOKENS) {
    const { dropped } = classifySeeds(seeds);
    this.droppedSeeds = dropped;
    this.candidates = buildCandidates(seeds);
  }

  /**
   * Connect and read the live reference fee. Called once before the poll loop.
   *
   * The fee is read rather than hardcoded because XRPL raises it under load,
   * and a monitor pricing against a stale floor calls edges takeable that the
   * network would have eaten. It is read ONCE, at startup, not per tick: the
   * whole point of feeNative is that every row in the CSV was priced against a
   * stated constant, and a figure that drifted mid-run would make two rows
   * incomparable without saying so. If the network is busy enough for the
   * reference fee to have moved, restart.
   */
  async start(): Promise<void> {
    // Loudly, by name, before anything else. A seed that cannot be probed is a
    // hole in this venue's coverage, and the coverage IS the seed list.
    for (const d of this.droppedSeeds) {
      console.error(
        `xrpl: SEED DROPPED ${d.seed.currency}/${d.seed.issuer}: ${d.why}`,
      );
    }

    const client = await this.connect();

    // server_info also carries the validated ledger index, but that is read
    // fresh per tick; only the fee is taken here.
    const info = await request<ServerInfoReply>(client, {
      command: "server_info",
    });

    const baseFeeXrp = info?.result?.info?.validated_ledger?.base_fee_xrp;
    if (typeof baseFeeXrp === "number" && Number.isFinite(baseFeeXrp)) {
      // server_info reports the fee in XRP, not drops. Round-trip through drops
      // so the stored value is an exact whole number of drops rather than
      // whatever float the JSON parser produced, and reject anything that is
      // not a sane fee -- a zero here would silently make every edge free.
      // Sanity-checked BEFORE the multiplier, so the bounds stay bounds on what
      // the network actually said rather than on our own padding of it.
      const drops = Math.round(baseFeeXrp * DROPS_PER_XRP);
      if (drops >= 1 && drops <= 1_000_000) {
        this.feeNative = (drops * XRPL_FEE_SAFETY_MULTIPLIER) / DROPS_PER_XRP;
        this.feeIsLive = true;
      }
    }
  }

  /** Close the socket. Called on shutdown; there is nothing else to unwind. */
  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client?.isConnected()) await client.disconnect();
  }

  /**
   * The pools reachable from the seed list, priced at one ledger.
   *
   * This does NOT satisfy the "walked to exhaustion" reading of
   * Venue.fetchPools, and cannot: rippled has no call that lists AMMs. The
   * honest statement of what comes back is "every AMM among the seeded pairs",
   * and the gap between that and "every AMM" is the seed list. See
   * XRPL_SEED_TOKENS.
   *
   * The tick runs in two phases, which exist for different reasons and must not
   * be merged:
   *
   *   Discovery -- ask about pairs whose state is unknown or whose "absent"
   *   answer has expired. Rationed to XRPL_DISCOVERY_BATCH per tick, because
   *   the candidate set is quadratic in the seed list and the first sweep is
   *   several hundred requests. Results update the cache and nothing else.
   *
   *   Pricing -- ask about every pair known to be live, pinned to a single
   *   ledger index. These are the pools returned. Never rationed: a pool
   *   omitted for budget reasons removes every cycle through it, which is a
   *   silent wrong answer rather than a slower one.
   *
   * Pricing repeats the requests discovery just made on a sweep tick. That
   * waste is deliberate -- discovery is unpinned and spread across whatever
   * ledgers close while it runs, so its reserves cannot be mixed into a
   * snapshot that arb.ts is entitled to treat as one instant.
   */
  async fetchPools(): Promise<Pool[]> {
    const client = await this.connect();
    const nowMs = Date.now();

    // --- Phase 1: discovery -------------------------------------------------
    const due = this.dueForDiscovery(nowMs);
    let errors = 0;

    const discovered = await mapLimit(due, XRPL_PROBE_CONCURRENCY, (c) =>
      probe(client, c, 0),
    );
    for (let i = 0; i < due.length; i++) {
      const r = discovered[i]!;
      if (r.kind === "error") errors++;
      else {
        this.cache.set(due[i]!.cacheKey, {
          state: r.kind === "pool" ? "live" : "absent",
          checkedAtMs: nowMs,
        });
      }
    }

    // --- Phase 2: pricing ---------------------------------------------------
    const ledgerIndex = await currentLedgerIndex(client);
    const livePairs = this.candidates.filter(
      (c) => this.cache.get(c.cacheKey)?.state === "live",
    );

    const priced = await mapLimit(livePairs, XRPL_PROBE_CONCURRENCY, (c) =>
      probe(client, c, ledgerIndex),
    );

    // Keyed by AMM account: two seed entries can name the same asset in
    // different encodings and resolve to one pool, and arb.ts treats pool ids
    // as distinct trading venues -- a duplicate would look like two pools
    // quoting identical prices, which is a cycle of exactly zero edge but still
    // thousands of wasted simulate() calls.
    const byId = new Map<string, Pool>();
    let skipped = 0;

    for (let i = 0; i < livePairs.length; i++) {
      const r = priced[i]!;
      if (r.kind === "error") {
        errors++;
        continue;
      }
      if (r.kind === "absent") {
        // An AMM that existed a moment ago and does not now. Believe it, but do
        // not count it as an error.
        this.cache.set(livePairs[i]!.cacheKey, {
          state: "absent",
          checkedAtMs: nowMs,
        });
        continue;
      }
      const pool = toPool(r.amm);
      if (pool) byId.set(pool.id, pool);
      else skipped++;
    }

    this.lastFetch = {
      ...this.tally(),
      probed: due.length,
      errors,
      skipped,
      ledgerIndex,
    };

    return [...byId.values()];
  }

  /**
   * Constant product with the pool's OWN trading_fee, converted to bp in
   * toPool(). There is no fee constant in this function and must not be one:
   * XLS-30 pools are voted on by their LPs and sit anywhere from 0 to 1%, which
   * spans more than the edges being hunted.
   *
   * Identical arithmetic to the Stellar adapter, because XLS-30 is the same
   * curve: the fee comes off the input, and the output is whatever keeps the
   * product of reserves constant. Both reserves are in whole units of their own
   * asset by the time they reach here -- drops were converted in toPool() and
   * appear nowhere below.
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
   * This is where hex currency codes are decoded, and the ONLY place. The key
   * keeps whatever encoding the ledger uses, exactly as the Stellar adapter
   * keeps Horizon's own CODE:ISSUER string. Decoding into the key would be
   * worse than useless: hex codes exist precisely because they can hold things
   * a 3-char code cannot, including a 40-hex encoding of a name that some other
   * issuer uses as plain ASCII, so a decoded key would let two different assets
   * collide on one string and arb.ts would route straight through the seam.
   */
  assetLabel(key: string): string {
    if (key === NATIVE) return "XRP";

    const sep = key.indexOf(":");
    if (sep < 0) return key;

    const code = decodeCurrency(key.slice(0, sep));
    const issuer = key.slice(sep + 1);
    if (issuer.length <= 12) return `${code}(${issuer})`;
    return `${code}(${issuer.slice(0, 4)}..${issuer.slice(-4)})`;
  }

  /** Heartbeat fragment. Reports the two numbers the probe budget turns on. */
  fetchNote(): string {
    const f = this.lastFetch;
    return (
      ` pairs=${f.pairs} probed=${f.probed} live=${f.live}` +
      ` absent=${f.absent} unknown=${f.unknown}` +
      ` ledger=${f.ledgerIndex || "unpinned"}` +
      (f.skipped > 0 ? ` skipped=${f.skipped}` : "") +
      (f.errors > 0 ? ` probe_errors=${f.errors}` : "") +
      // In every heartbeat row, not just at startup: the CSV outlives the
      // console, and a reader asking why a token is absent should not have to
      // find the terminal the run happened in.
      (this.droppedSeeds.length > 0
        ? ` SEEDS_DROPPED=${this.droppedSeeds.length}`
        : "") +
      (this.feeIsLive ? "" : " FEE_FALLBACK")
    );
  }

  /** Candidate pairs, exposed for tests and for the startup banner. */
  get candidateCount(): number {
    return this.candidates.length;
  }

  /**
   * The next slice of pairs to ask about: never-resolved ones first, then any
   * whose "absent" answer has gone stale. The cursor rotates so that a
   * candidate set larger than the batch is still covered completely, just
   * across several ticks.
   */
  private dueForDiscovery(nowMs: number): Candidate[] {
    const out: Candidate[] = [];
    const n = this.candidates.length;

    for (let i = 0; i < n && out.length < XRPL_DISCOVERY_BATCH; i++) {
      const c = this.candidates[(this.discoveryCursor + i) % n]!;
      const entry = this.cache.get(c.cacheKey);
      if (!entry) out.push(c);
      else if (
        entry.state === "absent" &&
        nowMs - entry.checkedAtMs >= XRPL_NEGATIVE_RECHECK_MS
      ) {
        out.push(c);
      }
    }

    this.discoveryCursor = (this.discoveryCursor + XRPL_DISCOVERY_BATCH) % n;
    return out;
  }

  private tally(): XrplFetchStats {
    let live = 0;
    let absent = 0;
    let unknown = 0;
    for (const c of this.candidates) {
      const entry = this.cache.get(c.cacheKey);
      if (!entry) unknown++;
      else if (entry.state === "live") live++;
      else absent++;
    }
    return {
      pairs: this.candidates.length,
      probed: 0,
      live,
      absent,
      unknown,
      errors: 0,
      skipped: 0,
      ledgerIndex: 0,
    };
  }

  private async connect(): Promise<Client> {
    if (this.client?.isConnected()) return this.client;
    const client = this.client ?? new Client(XRPL_WS_URL, {
      timeout: XRPL_TIMEOUT_MS,
      connectionTimeout: XRPL_TIMEOUT_MS,
    });
    this.client = client;
    if (!client.isConnected()) await client.connect();
    return client;
  }
}

// ---------------------------------------------------------------------------
// Wire shapes, declared here rather than imported
// ---------------------------------------------------------------------------
//
// These duplicate types that `xrpl` exports. That duplication is the point: the
// import list from `xrpl` is exactly `Client`, so no transaction type is ever
// in scope in this module, and the check in test/check.ts can assert that as a
// flat string property instead of having to reason about which imports are
// type-only and therefore harmless.

/** rippled's `Amount`: a drops string for XRP, an object for issued currency. */
type WireAmount = string | { currency?: unknown; issuer?: unknown; value?: unknown };

interface WireAmm {
  account?: unknown;
  amount?: WireAmount;
  amount2?: WireAmount;
  trading_fee?: unknown;
}

interface AmmInfoReply {
  result?: { amm?: WireAmm };
}

interface ServerInfoReply {
  result?: { info?: { validated_ledger?: { base_fee_xrp?: number; seq?: number } } };
}

interface LedgerReply {
  result?: { ledger_index?: unknown };
}

/**
 * One read-only rippled call.
 *
 * The cast is here and nowhere else. xrpl 5.x types Client.request() against a
 * closed union of Request interfaces, and its AMMInfoRequest omits
 * `ledger_index` even though rippled accepts it -- so a correctly pinned
 * amm_info does not typecheck. The alternative is importing the request types,
 * which is exactly what this module refuses to do. Every caller below passes a
 * literal `command`, and test/check.ts enforces that the set of literals is
 * read-only, so nothing is loosened by the cast that the command allowlist does
 * not close again.
 */
async function request<T>(
  client: Client,
  req: Record<string, unknown>,
): Promise<T> {
  return (await client.request(req as never)) as T;
}

type ProbeResult =
  | { kind: "pool"; amm: WireAmm }
  | { kind: "absent" }
  | { kind: "error"; message: string };

/**
 * Ask whether an AMM exists for one pair, and read its reserves if it does.
 *
 * The three-way return is load-bearing. "No such AMM" is a durable fact worth
 * caching for half an hour; a timeout or a disconnect is not, and caching one
 * as the other would file a real pool as absent and hide it until the process
 * restarts. Only the codes in ABSENT_CODES are treated as absence -- everything
 * else, including a malformed request, is surfaced as an error and counted in
 * the heartbeat, so a broken seed entry shows up as a persistent nonzero
 * probe_errors rather than as silence.
 */
async function probe(
  client: Client,
  c: Candidate,
  ledgerIndex: number,
): Promise<ProbeResult> {
  const req: Record<string, unknown> = {
    command: "amm_info",
    asset: c.a,
    asset2: c.b,
  };
  if (ledgerIndex > 0) req.ledger_index = ledgerIndex;

  try {
    const reply = await request<AmmInfoReply>(client, req);
    const amm = reply?.result?.amm;
    return amm ? { kind: "pool", amm } : { kind: "absent" };
  } catch (e: any) {
    const code = e?.data?.error;
    if (typeof code === "string" && ABSENT_CODES.has(code)) {
      return { kind: "absent" };
    }
    return { kind: "error", message: code ?? e?.message ?? String(e) };
  }
}

/**
 * The ledger index every pool in this tick is priced at.
 *
 * arb.ts is explicit that a snapshot must be priced as one instant, and the
 * pricing phase is dozens of round trips spanning several ledger closes. Left
 * unpinned, one leg of a cycle can be read before a close and another after it,
 * and the "edge" is then partly an artefact of the gap rather than a fact about
 * any single state of the ledger.
 *
 * Returns 0 if the index cannot be read, which makes probe() fall back to
 * whatever rippled considers current. The tick still runs; fetchNote() prints
 * ledger=unpinned so the weaker snapshot is visible rather than assumed.
 */
async function currentLedgerIndex(client: Client): Promise<number> {
  try {
    const reply = await request<LedgerReply>(client, {
      command: "ledger",
      ledger_index: "validated",
    });
    const n = Number(reply?.result?.ledger_index);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** A seed that will never reach the network, and the reason it will not. */
export interface DroppedSeed {
  seed: SeedToken;
  why: string;
}

/**
 * Split the seed list into what the probe can use and what it cannot.
 *
 * WHY THIS IS SEPARATE FROM buildCandidates, AND REPORTED. Dropping a malformed
 * seed before it reaches the network is right -- a bad code or r-address would
 * come back as an error on every sweep forever, and that reads as a flaky
 * endpoint rather than a typo. But dropping it SILENTLY reproduces exactly the
 * failure this venue's docs warn about at length: the candidate set quietly
 * shrinks, the heartbeat reports a healthy `pairs` count, and the monitor is
 * blind to a token nobody knows is missing.
 *
 * That is not hypothetical. The first version of XRPL_SEED_TOKENS carried USDC,
 * SOLO and CORE as plain 4-letter codes. Four letters is neither a 3-char ASCII
 * code nor 40 hex, so all three were dropped here without a word -- and all
 * three turned out to have XRP AMMs in the tens of thousands of XRP, among the
 * deepest on the venue. Three of thirteen seeds, invisible, with nothing in the
 * output saying so. Hence: dropped seeds are counted, named at startup, and
 * carried in the heartbeat.
 */
export function classifySeeds(seeds: readonly SeedToken[]): {
  valid: SeedToken[];
  dropped: DroppedSeed[];
} {
  const valid: SeedToken[] = [];
  const dropped: DroppedSeed[] = [];
  const seen = new Set<string>();

  for (const s of seeds) {
    const drop = (why: string) => dropped.push({ seed: s, why });

    if (typeof s?.currency !== "string" || typeof s?.issuer !== "string") {
      drop("currency and issuer must both be strings");
      continue;
    }
    // XRP is the native side and is added to every pair automatically; a seed
    // claiming to be an issued "XRP" is not a thing the ledger permits.
    if (s.currency === "XRP") {
      drop("XRP is the native side, not a seed token");
      continue;
    }
    if (!STD_CODE.test(s.currency) && !HEX_CODE.test(s.currency)) {
      // Named specifically because it is the trap that has already been hit: a
      // 4-letter code looks perfectly reasonable written down and is not a
      // thing the ledger has.
      drop(
        s.currency.length === 4
          ? "4-letter codes must be written as 40-char hex, not ASCII"
          : "currency is neither a 3-char code nor 40 hex",
      );
      continue;
    }
    if (!R_ADDRESS.test(s.issuer)) {
      drop("issuer is not a classic r-address");
      continue;
    }

    const key = `${s.currency}:${s.issuer}`;
    if (seen.has(key)) {
      drop("duplicate of an earlier seed");
      continue;
    }
    seen.add(key);
    valid.push(s);
  }

  return { valid, dropped };
}

/**
 * Every seeded token against XRP, plus every token-to-token combination.
 *
 * Unordered pairs, so {A,B} is enumerated once rather than twice -- an AMM has
 * no side. For n tokens that is n + n(n-1)/2 candidates, which is why discovery
 * is rationed: 35 tokens is 630 questions, 40 is 820.
 *
 * Malformed seeds are dropped here rather than sent to the network. A bad
 * currency code or r-address would come back as an error on every sweep
 * forever, and the failure would read as a flaky endpoint instead of a typo.
 */
export function buildCandidates(seeds: readonly SeedToken[]): Candidate[] {
  const { valid } = classifySeeds(seeds);

  const out: Candidate[] = [];
  const xrp: CurrencySpec = { currency: "XRP" };

  for (let i = 0; i < valid.length; i++) {
    const ti = valid[i]!;
    const si: CurrencySpec = { currency: ti.currency, issuer: ti.issuer };
    out.push({ cacheKey: pairCacheKey(NATIVE, specKey(si)), a: xrp, b: si });

    for (let j = i + 1; j < valid.length; j++) {
      const tj = valid[j]!;
      const sj: CurrencySpec = { currency: tj.currency, issuer: tj.issuer };
      out.push({ cacheKey: pairCacheKey(specKey(si), specKey(sj)), a: si, b: sj });
    }
  }

  return out;
}

/** Canonical key for one currency spec, in the form the request names it. */
function specKey(s: CurrencySpec): string {
  return s.currency === "XRP" && !("issuer" in s)
    ? NATIVE
    : `${s.currency}:${(s as { issuer: string }).issuer}`;
}

/** Order-independent identity for a pair, for the discovery cache only. */
function pairCacheKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Normalise one amm_info result, or null if it cannot be priced.
 *
 * Rejection, never repair, for the same reason as the Stellar adapter: an
 * invented reserve or fee does not announce itself in the CSV, it just shifts
 * every route through the pool by the size of the guess. Skips are counted so a
 * jump is visible in the heartbeat.
 */
export function toPool(amm: WireAmm): Pool | null {
  if (typeof amm?.account !== "string" || amm.account.length === 0) return null;

  const tf = Number(amm.trading_fee);
  // trading_fee is in 1/100,000. XLS-30 caps it at 1000 (1%), but the ceiling
  // enforced here is only "a fee, and less than everything" -- the protocol cap
  // is a fact about today's protocol, not about the record in hand.
  if (!Number.isFinite(tf) || tf < 0 || tf >= TRADING_FEE_UNIT) return null;
  const feeBp = (tf / TRADING_FEE_UNIT) * 10_000;

  const x = parseAmount(amm.amount);
  const y = parseAmount(amm.amount2);
  if (!x || !y || x.key === y.key) return null;

  return { id: amm.account, a: x.key, b: y.key, ra: x.units, rb: y.units, feeBp };
}

/**
 * One reserve, as a canonical key plus an amount in WHOLE UNITS of that asset.
 *
 * This is the only place drops exist. rippled hands back XRP as a bare string
 * of drops and issued currencies as `{currency, issuer, value}` where value is
 * already a decimal string in whole tokens -- two different encodings on the
 * same field, distinguishable only by JSON type. Converting here means Pool.ra
 * and Pool.rb are always in whole units and simulate() never has to know which
 * side it is holding. Nothing downstream of this function sees a drop.
 *
 * Issued values carry up to 15 significant decimal digits, which a JS double
 * represents exactly at that precision; the exponent range (1e-81 to 1e80) is
 * the part that does not survive, so absurd reserves are rejected rather than
 * rounded into a plausible-looking number.
 */
export function parseAmount(
  amount: WireAmount | undefined,
): { key: string; units: number } | null {
  // XRP: a bare string of DROPS. Never a number, never already in XRP.
  if (typeof amount === "string") {
    const drops = Number(amount);
    if (!Number.isFinite(drops) || drops <= 0) return null;
    return { key: NATIVE, units: drops / DROPS_PER_XRP };
  }

  if (!amount || typeof amount !== "object") return null;

  const { currency, issuer, value } = amount;
  if (typeof currency !== "string" || currency.length === 0) return null;
  if (typeof issuer !== "string" || issuer.length === 0) return null;

  // Already whole tokens. No scaling, no drops.
  const units = Number(value);
  if (!Number.isFinite(units) || units <= 0) return null;
  // Below this a reserve is dust that only produces division noise; above it
  // the double has stopped tracking the ledger's decimal exactly.
  if (units < 1e-12 || units > 1e15) return null;

  // Taken verbatim from the reply, not rebuilt from the request that produced
  // it. The reply is the ledger's own encoding of the asset, and every
  // comparison downstream is an === on this string.
  return { key: `${currency}:${issuer}`, units };
}

/**
 * Hex currency code to its ASCII name. DISPLAY ONLY -- never call this on
 * anything that becomes a key.
 *
 * Returns the input unchanged for standard 3-char codes and for anything that
 * does not decode to clean printable ASCII, including the 0x01/0x02 leading
 * bytes XRPL reserves for demurrage and XLS-15 codes, which are structured data
 * rather than a name.
 */
export function decodeCurrency(code: string): string {
  if (!HEX_CODE.test(code)) return code;
  if (code.startsWith("01") || code.startsWith("02")) {
    return `0x${code.slice(0, 8)}..`;
  }

  let out = "";
  for (let i = 0; i < code.length; i += 2) {
    const byte = Number.parseInt(code.slice(i, i + 2), 16);
    if (byte === 0) break; // trailing NUL padding
    if (byte < 0x20 || byte > 0x7e) return `0x${code.slice(0, 8)}..`;
    out += String.fromCharCode(byte);
  }

  // A code that decoded to nothing, or to trailing junk after its NUL run, is
  // not a name -- show the hex rather than a misleading fragment.
  if (out.length === 0) return `0x${code.slice(0, 8)}..`;
  const reencoded = Buffer.from(out, "ascii").toString("hex").toUpperCase();
  const padded = reencoded.padEnd(40, "0");
  return padded === code.toUpperCase() ? out : `0x${code.slice(0, 8)}..`;
}

/**
 * Map with bounded concurrency, preserving input order.
 *
 * Order matters: callers zip the results back against the input array to know
 * which pair each answer belongs to.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };

  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
