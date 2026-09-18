import {
  AERODROME_POOL_FACTORY,
  BASE_BATCH_MAX,
  BASE_CHAIN_ID,
  BASE_FEE_NATIVE,
  BASE_QUOTE_MIN_OUT_RAW,
  BASE_QUOTE_PROBE_DIVISOR,
  BASE_QUOTE_TOLERANCE,
  BASE_RPC_URL,
  BASE_SEED_TOKENS,
  BASE_TICK_TIMEOUT_MS,
  UNISWAP_V2_FACTORY,
  UNISWAP_V2_FEE_BP,
} from "../config.js";
import type { Pool, Venue } from "../venue.js";

/**
 * Base mainnet (chain id 8453), read over plain JSON-RPC.
 *
 * READ-ONLY BY OMISSION AND BY GATE. No Ethereum library is imported -- not
 * viem, not ethers, not even a hashing package -- so nothing able to build or
 * send a transaction is within reach of this module. Everything needed is
 * three JSON-RPC methods, listed in RPC_METHODS, and every request goes through
 * Rpc.send(), which throws before a byte leaves the process if any method in it
 * is not on that list. test/check.ts pins the list, scans this file for write
 * vocabulary, and fails if it imports any package at all.
 *
 * The transport is HTTP POST, unlike Horizon's GET, because that is how
 * JSON-RPC is carried. As on XRPL, the method name is what makes a request a
 * read, not the HTTP verb.
 *
 * Pools: Uniswap V2 pairs and Aerodrome VOLATILE pools, both constant product.
 * Aerodrome stable pools, Uniswap v3 and concentrated-liquidity pools are out of
 * scope: Pool, simulate() and the cycle bound in arb.ts all assume x*y=k.
 *
 * Coverage is a seed list, as on XRPL: the pools between BASE_SEED_TOKENS and
 * no others. See the note on that constant.
 */

/** The complete set of JSON-RPC methods this venue may send. All are reads. */
export const RPC_METHODS: readonly string[] = [
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
];

/**
 * Four-byte selectors, hard-coded. Each comment is the exact prototype whose
 * keccak-256 the selector is the first four bytes of.
 */
const SEL = {
  getPair: "e6a43905", // getPair(address,address)
  getPool: "79bc57d5", // getPool(address,address,bool)
  getFee: "cc56b2c5", // getFee(address,bool)
  getReserves: "0902f1ac", // getReserves()
  token0: "0dfe1681", // token0()
  token1: "d21220a7", // token1()
  factory: "c45a0155", // factory()
  stable: "22be3de1", // stable()
  getAmountOut: "f140a35a", // getAmountOut(uint256,address)
  symbol: "95d89b41", // symbol()
  decimals: "313ce567", // decimals()
} as const;

/** WETH, the cycle anchor. A protocol predeploy; also first in the seed list. */
const NATIVE = "0x4200000000000000000000000000000000000006";

/**
 * Aerodrome PoolFactory.MAX_FEE. getFee() answers in basis points of 10,000
 * (30 = 0.30%) and the factory refuses to store more than this. A larger answer
 * means the reply is not what we think it is, so the pool is not priced.
 */
const AERODROME_MAX_FEE_BP = 300;

const ZERO_ADDRESS = "0x" + "0".repeat(40);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------
// The RPC gate
// ---------------------------------------------------------------------------

export interface RpcCall {
  method: string;
  params: unknown[];
}

export type RpcReply =
  | { ok: true; result: unknown }
  | { ok: false; code: number | null; message: string };

/** One HTTP POST of a JSON body. Replaceable so tests run with no network. */
export type Transport = (
  body: string,
  abort: AbortSignal,
) => Promise<{ status: number; json: unknown }>;

export type RpcMode = "batch" | "sequential";

function httpTransport(url: string): Transport {
  return async (body, abort) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      signal: abort,
    });
    const json = await res.json().catch(() => undefined);
    return { status: res.status, json };
  };
}

export class Rpc {
  /** "sequential" once any batch since the last resetMode() was refused. */
  mode: RpcMode = "batch";

  private readonly transport: Transport;
  private nextId = 1;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  resetMode(): void {
    this.mode = "batch";
  }

  /**
   * THE ONLY PATH TO THE NETWORK. Every method is checked against RPC_METHODS
   * before anything is sent, and one bad method refuses the whole call rather
   * than sending the good ones first.
   *
   * Calls go out as JSON-RPC batches of up to BASE_BATCH_MAX. If the endpoint
   * refuses a batch -- an HTTP error, a reply that is not an array, or one whose
   * ids do not match -- the same calls are resent one at a time and the mode
   * becomes "sequential". A per-call error inside an accepted batch (a revert,
   * say) is that call's answer, not a refusal of batching.
   *
   * Replies come back in the order of `calls`, whatever order the endpoint
   * used.
   */
  async send(calls: readonly RpcCall[], abort: AbortSignal): Promise<RpcReply[]> {
    for (const c of calls) {
      if (!RPC_METHODS.includes(c.method)) {
        throw new Error(
          `base: RPC method "${c.method}" is not on the read-only allow-list`,
        );
      }
    }

    const out: RpcReply[] = [];
    for (let start = 0; start < calls.length; start += BASE_BATCH_MAX) {
      const envelopes = calls.slice(start, start + BASE_BATCH_MAX).map((c) => ({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: c.method,
        params: c.params,
      }));

      const batch = await this.transport(JSON.stringify(envelopes), abort);
      const matched = matchBatch(batch, envelopes.map((e) => e.id));
      if (matched) {
        out.push(...matched);
        continue;
      }

      this.mode = "sequential";
      for (const e of envelopes) {
        const one = await this.transport(JSON.stringify(e), abort);
        if (one.status < 200 || one.status >= 300) {
          throw new Error(`base: HTTP ${one.status} for ${e.method}`);
        }
        out.push(toReply(one.json));
      }
    }
    return out;
  }
}

/** The batch reply in request order, or null if the batch was refused. */
function matchBatch(
  res: { status: number; json: unknown },
  ids: number[],
): RpcReply[] | null {
  if (res.status < 200 || res.status >= 300) return null;
  if (!Array.isArray(res.json) || res.json.length !== ids.length) return null;

  const byId = new Map<number, unknown>();
  for (const r of res.json) {
    const id = (r as { id?: unknown } | null)?.id;
    if (typeof id === "number") byId.set(id, r);
  }
  if (!ids.every((id) => byId.has(id))) return null;
  return ids.map((id) => toReply(byId.get(id)));
}

function toReply(x: unknown): RpcReply {
  const r = x as { result?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  if (r && typeof r === "object" && "result" in r) return { ok: true, result: r.result };
  if (r?.error && typeof r.error === "object") {
    return {
      ok: false,
      code: typeof r.error.code === "number" ? r.error.code : null,
      message: typeof r.error.message === "string" ? r.error.message : "error",
    };
  }
  return { ok: false, code: null, message: "malformed JSON-RPC reply" };
}

/**
 * Run `fn` under a hard deadline. On expiry every request still in flight is
 * aborted through the controller and the returned promise rejects, even if the
 * transport ignores the abort.
 */
async function withDeadline<T>(
  ms: number,
  label: string,
  fn: (abort: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`base: ${label} exceeded ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// ABI encoding and decoding, by hand
// ---------------------------------------------------------------------------

function pad(hex: string): string {
  return hex.padStart(64, "0");
}
function encAddress(a: string): string {
  return pad(a.slice(2).toLowerCase());
}
function encUint(n: bigint): string {
  return pad(n.toString(16));
}
function encBool(b: boolean): string {
  return pad(b ? "1" : "0");
}

function hexTag(n: number): string {
  return "0x" + n.toString(16);
}

function ethCall(to: string, selector: string, args: string[], blockTag: string): RpcCall {
  return {
    method: "eth_call",
    params: [{ to, data: "0x" + selector + args.join("") }, blockTag],
  };
}

/** The hex payload of a reply without its 0x, or null if it is not hex. */
function payload(r: RpcReply): string | null {
  if (!r.ok || typeof r.result !== "string") return null;
  if (!/^0x([0-9a-fA-F]{2})*$/.test(r.result)) return null;
  return r.result.slice(2);
}

/** A JSON-RPC quantity such as "0x2105", as a number, or null. */
function quantity(r: RpcReply): number | null {
  if (!r.ok || typeof r.result !== "string") return null;
  if (!/^0x[0-9a-fA-F]+$/.test(r.result)) return null;
  const n = Number(BigInt(r.result));
  return Number.isSafeInteger(n) ? n : null;
}

function describe(r: RpcReply): string {
  return r.ok ? JSON.stringify(r.result) : `error ${r.code}: ${r.message}`;
}

function word(hex: string, i: number): bigint | null {
  const w = hex.slice(i * 64, i * 64 + 64);
  return w.length === 64 ? BigInt("0x" + w) : null;
}

function wordAddress(hex: string, i: number): string | null {
  const w = hex.slice(i * 64, i * 64 + 64);
  if (w.length !== 64 || !/^0{24}/.test(w)) return null;
  return "0x" + w.slice(24).toLowerCase();
}

/**
 * A symbol() reply as text. Handles the ABI `string` form and the older bytes32
 * form some tokens still return. Null if it is neither.
 */
export function decodeText(hex: string): string | null {
  if (hex.length === 64) {
    const bytes = Buffer.from(hex, "hex");
    const end = bytes.indexOf(0);
    return bytes.subarray(0, end < 0 ? 32 : end).toString("utf8");
  }
  const offset = word(hex, 0);
  if (offset === null || offset % 32n !== 0n) return null;
  const at = Number(offset / 32n);
  const len = word(hex, at);
  if (len === null || len > 256n) return null;
  const from = (at + 1) * 64;
  const data = hex.slice(from, from + Number(len) * 2);
  if (data.length !== Number(len) * 2) return null;
  return Buffer.from(data, "hex").toString("utf8");
}

/**
 * A raw integer token amount in WHOLE UNITS of the token, using its on-chain
 * decimals. This is the only place raw amounts exist; Pool.ra and Pool.rb are
 * always whole units, as on the other venues.
 *
 * The integer and fractional parts are converted separately so a large raw
 * value keeps its precision rather than being rounded as one huge double.
 */
export function toUnits(raw: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`base: unusable decimals ${decimals}`);
  }
  const scale = 10n ** BigInt(decimals);
  return Number(raw / scale) + Number(raw % scale) / Number(scale);
}

/**
 * The payload of a reply during verification, or null for a DEFINITE "no"
 * (a revert). Any other error is transient and throws, so verification fails
 * as a whole and is retried next tick, rather than a timeout permanently
 * dropping a pool or token that is actually fine.
 */
function definite(r: RpcReply, what: string): string | null {
  if (r.ok) return payload(r);
  if (r.code === 3 || /revert/i.test(r.message)) return null;
  throw new Error(`base: ${what} failed: ${r.message}`);
}

// ---------------------------------------------------------------------------
// The venue
// ---------------------------------------------------------------------------

type Dex = "uniswap-v2" | "aerodrome";

interface Token {
  /** Lowercase address. The canonical asset key. */
  key: string;
  symbol: string;
  decimals: number;
}

interface TrackedPool {
  dex: Dex;
  /** Pool contract address, lowercase. Also the Pool id. */
  address: string;
  token0: Token;
  token1: Token;
}

/** What the last fetchPools() did, for the heartbeat. */
export interface BaseReadStats {
  /** Block every reply in the tick was pinned to, or 0 before the first tick. */
  block: number;
  mode: RpcMode | "none";
  /** Pools returned, per dex. */
  uni: number;
  aero: number;
  /** Calls that failed this tick; their pools are missing from it. */
  errors: number;
  /** Pools whose reply could not be priced (empty, bad fee). */
  skipped: number;
}

/** A token or pool start() refused, and why. */
export interface BaseDrop {
  what: string;
  why: string;
}

export interface BaseVenueOptions {
  transport?: Transport;
  tickTimeoutMs?: number;
}

export class BaseVenue implements Venue {
  readonly name = "base";
  readonly nativeKey = NATIVE;
  readonly feeNative = BASE_FEE_NATIVE;

  lastRead: BaseReadStats = {
    block: 0,
    mode: "none",
    uni: 0,
    aero: 0,
    errors: 0,
    skipped: 0,
  };

  /** Everything the last verification refused. Named at startup, counted in every heartbeat. */
  dropped: BaseDrop[] = [];

  private tokens: Token[] = [];
  private pools: TrackedPool[] = [];
  private absent = 0;
  private verified = false;
  private readonly rpc: Rpc;
  private readonly tickTimeoutMs: number;
  private readonly seedSymbols = new Map<string, string>(
    BASE_SEED_TOKENS.map((s) => [s.address.toLowerCase(), s.symbol]),
  );

  constructor(opts: BaseVenueOptions = {}) {
    this.rpc = new Rpc(opts.transport ?? httpTransport(BASE_RPC_URL));
    this.tickTimeoutMs = opts.tickTimeoutMs ?? BASE_TICK_TIMEOUT_MS;
  }

  /** Verify chain, tokens and pools once, before the poll loop. */
  async start(): Promise<void> {
    await withDeadline(this.tickTimeoutMs, "start", (abort) => this.verify(abort));
  }

  /** Nothing to close: every request is a stateless HTTP POST. */
  async stop(): Promise<void> {}

  /**
   * Reserves and fees of every verified pool, all pinned to one block read at
   * the top of the tick, under a hard deadline.
   *
   * If start() failed -- monitor.ts keeps a venue whose start() threw -- the
   * verification runs here first, inside the same deadline. An unverified
   * pool is never priced.
   */
  async fetchPools(): Promise<Pool[]> {
    return withDeadline(this.tickTimeoutMs, "tick", async (abort) => {
      if (!this.verified) await this.verify(abort);
      return this.read(abort);
    });
  }

  /** Constant product with the pool's own fee: identical to the other venues. */
  simulate(pool: Pool, fromAssetKey: string, amountIn: number): number {
    const fromIsA = fromAssetKey === pool.a;
    const rIn = fromIsA ? pool.ra : pool.rb;
    const rOut = fromIsA ? pool.rb : pool.ra;

    const inNet = amountIn * (1 - pool.feeBp / 10_000);
    if (!(inNet > 0)) return 0;
    return (inNet * rOut) / (rIn + inNet);
  }

  /** DISPLAY ONLY -- see the warning on Venue.assetLabel. */
  assetLabel(key: string): string {
    const symbol =
      this.tokens.find((t) => t.key === key)?.symbol ?? this.seedSymbols.get(key) ?? "?";
    return `${symbol}(${key.slice(0, 6)}..${key.slice(-4)})`;
  }

  /** Heartbeat fragment. */
  fetchNote(): string {
    const r = this.lastRead;
    return (
      ` block=${r.block || "none"} rpc=${r.mode}` +
      ` tokens=${this.tokens.length}/${BASE_SEED_TOKENS.length}` +
      ` uni=${r.uni} aero=${r.aero} absent=${this.absent}` +
      ` dropped=${this.dropped.length}` +
      (r.skipped > 0 ? ` skipped=${r.skipped}` : "") +
      (r.errors > 0 ? ` call_errors=${r.errors}` : "") +
      (this.verified ? "" : " NOT_VERIFIED")
    );
  }

  private async blockNumber(abort: AbortSignal): Promise<number> {
    const [r] = await this.rpc.send([{ method: "eth_blockNumber", params: [] }], abort);
    const n = r ? quantity(r) : null;
    if (n === null || n <= 0) {
      throw new Error(`base: eth_blockNumber answered ${r ? describe(r) : "nothing"}`);
    }
    return n;
  }

  /**
   * Startup verification, pinned to one block:
   *
   *   1. eth_chainId is 8453.
   *   2. every seed token's symbol() and decimals() match the seed list.
   *   3. pools are looked up for every pair of surviving tokens; a zero address
   *      means no pool and is not an error.
   *   4. each pool's token0/token1 are the pair it was found by, its factory()
   *      is the factory that returned it, and an Aerodrome pool is not stable.
   *   5. each Aerodrome pool's own getAmountOut agrees with our simulate() to
   *      within BASE_QUOTE_TOLERANCE. This also proves getFee's units.
   *
   * A mismatch drops that token or pool and is reported. A transient failure
   * throws, and the whole verification runs again next tick.
   */
  private async verify(abort: AbortSignal): Promise<void> {
    this.verified = false;
    const dropped: BaseDrop[] = [];
    const drop = (what: string, why: string): void => {
      dropped.push({ what, why });
    };

    // 1. chain
    const [chainReply] = await this.rpc.send([{ method: "eth_chainId", params: [] }], abort);
    const chainId = chainReply ? quantity(chainReply) : null;
    if (chainId !== BASE_CHAIN_ID) {
      throw new Error(
        `base: eth_chainId answered ${chainReply ? describe(chainReply) : "nothing"}, expected ${BASE_CHAIN_ID}`,
      );
    }

    const tag = hexTag(await this.blockNumber(abort));

    // 2. tokens
    const seeds = BASE_SEED_TOKENS.filter((s) => {
      if (ADDRESS_RE.test(s.address)) return true;
      drop(`token ${s.symbol} ${s.address}`, "not a 20-byte hex address");
      return false;
    });
    const tokenReplies = await this.rpc.send(
      seeds.flatMap((s) => [
        ethCall(s.address, SEL.symbol, [], tag),
        ethCall(s.address, SEL.decimals, [], tag),
      ]),
      abort,
    );

    const tokens: Token[] = [];
    seeds.forEach((s, i) => {
      const what = `token ${s.symbol} ${s.address}`;
      const symHex = definite(tokenReplies[2 * i]!, `${what} symbol()`);
      const decHex = definite(tokenReplies[2 * i + 1]!, `${what} decimals()`);
      const symbol = symHex === null ? null : decodeText(symHex);
      const decimals = decHex === null ? null : word(decHex, 0);
      const key = s.address.toLowerCase();

      if (symbol !== s.symbol) {
        drop(what, `symbol() answered ${JSON.stringify(symbol)}, expected "${s.symbol}"`);
      } else if (decimals === null || decimals !== BigInt(s.decimals)) {
        drop(what, `decimals() answered ${decimals}, expected ${s.decimals}`);
      } else if (tokens.some((t) => t.key === key)) {
        drop(what, "duplicate of an earlier seed");
      } else {
        tokens.push({ key, symbol: s.symbol, decimals: s.decimals });
      }
    });

    if (!tokens.some((t) => t.key === NATIVE)) {
      throw new Error("base: WETH failed verification, so there is no cycle anchor");
    }

    // 3. pool lookup, every unordered pair, both factories
    const pairs: Array<[Token, Token]> = [];
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) pairs.push([tokens[i]!, tokens[j]!]);
    }
    const lookups = await this.rpc.send(
      pairs.flatMap(([a, b]) => [
        ethCall(UNISWAP_V2_FACTORY, SEL.getPair, [encAddress(a.key), encAddress(b.key)], tag),
        ethCall(
          AERODROME_POOL_FACTORY,
          SEL.getPool,
          [encAddress(a.key), encAddress(b.key), encBool(false)],
          tag,
        ),
      ]),
      abort,
    );

    const found: Array<{ dex: Dex; address: string; a: Token; b: Token }> = [];
    let absent = 0;
    pairs.forEach(([a, b], i) => {
      (["uniswap-v2", "aerodrome"] as const).forEach((dex, k) => {
        const what = `${dex} ${a.symbol}/${b.symbol}`;
        const hex = definite(lookups[2 * i + k]!, `${what} lookup`);
        const address = hex === null ? null : wordAddress(hex, 0);
        if (address === null) drop(what, "factory lookup returned no address");
        else if (address === ZERO_ADDRESS) absent++;
        else found.push({ dex, address, a, b });
      });
    });

    // 4. identity of each pool
    const idReplies = await this.rpc.send(
      found.flatMap((f) => [
        ethCall(f.address, SEL.token0, [], tag),
        ethCall(f.address, SEL.token1, [], tag),
        ethCall(f.address, SEL.factory, [], tag),
        ...(f.dex === "aerodrome" ? [ethCall(f.address, SEL.stable, [], tag)] : []),
      ]),
      abort,
    );

    const identified: TrackedPool[] = [];
    let at = 0;
    for (const f of found) {
      const what = `${f.dex} ${f.a.symbol}/${f.b.symbol} ${f.address}`;
      const addr = (r: RpcReply, fn: string): string | null => {
        const hex = definite(r, `${what} ${fn}`);
        return hex === null ? null : wordAddress(hex, 0);
      };
      const t0 = addr(idReplies[at++]!, "token0()");
      const t1 = addr(idReplies[at++]!, "token1()");
      const factory = addr(idReplies[at++]!, "factory()");
      const stableHex =
        f.dex === "aerodrome" ? definite(idReplies[at++]!, `${what} stable()`) : null;

      const expectedFactory = (
        f.dex === "aerodrome" ? AERODROME_POOL_FACTORY : UNISWAP_V2_FACTORY
      ).toLowerCase();
      const sameTokens =
        (t0 === f.a.key && t1 === f.b.key) || (t0 === f.b.key && t1 === f.a.key);

      if (!sameTokens) {
        drop(what, `token0/token1 are ${t0}/${t1}, not the pair it was found by`);
        continue;
      }
      if (factory !== expectedFactory) {
        drop(what, `factory() is ${factory}, not ${expectedFactory}`);
        continue;
      }
      if (f.dex === "aerodrome") {
        const stable = stableHex === null ? null : word(stableHex, 0);
        if (stable !== 0n) {
          drop(what, `stable() answered ${stable}, expected false`);
          continue;
        }
      }
      const token0 = t0 === f.a.key ? f.a : f.b;
      const token1 = token0 === f.a ? f.b : f.a;
      identified.push({ dex: f.dex, address: f.address, token0, token1 });
    }

    // 5. Aerodrome: our arithmetic against the pool's own quote
    const aero = identified.filter((p) => p.dex === "aerodrome");
    const state = await this.rpc.send(
      aero.flatMap((p) => [
        ethCall(p.address, SEL.getReserves, [], tag),
        ethCall(AERODROME_POOL_FACTORY, SEL.getFee, [encAddress(p.address), encBool(false)], tag),
      ]),
      abort,
    );

    const probes: Array<{ pool: TrackedPool; priced: Pool; amountIn: bigint; what: string }> = [];
    const refused = new Set<string>();
    aero.forEach((p, i) => {
      const what = `aerodrome ${p.token0.symbol}/${p.token1.symbol} ${p.address}`;
      const reservesHex = definite(state[2 * i]!, `${what} getReserves()`);
      const feeHex = definite(state[2 * i + 1]!, `${what} getFee()`);
      const priced = reservesHex === null ? null : priceFrom(p, reservesHex, feeHex);

      if (priced === null || "why" in priced) {
        drop(what, priced?.why ?? "getReserves() reverted");
        refused.add(p.address);
        return;
      }
      const amountIn = priced.r0 / BigInt(BASE_QUOTE_PROBE_DIVISOR);
      if (amountIn === 0n) {
        drop(what, "reserve0 too small to probe");
        refused.add(p.address);
        return;
      }
      probes.push({ pool: p, priced: priced.pool, amountIn, what });
    });

    const quotes = await this.rpc.send(
      probes.map((q) =>
        ethCall(
          q.pool.address,
          SEL.getAmountOut,
          [encUint(q.amountIn), encAddress(q.pool.token0.key)],
          tag,
        ),
      ),
      abort,
    );

    probes.forEach((q, i) => {
      const hex = definite(quotes[i]!, `${q.what} getAmountOut()`);
      const out = hex === null ? null : word(hex, 0);
      if (out === null) {
        drop(q.what, "getAmountOut() reverted");
        refused.add(q.pool.address);
        return;
      }
      if (out < BigInt(BASE_QUOTE_MIN_OUT_RAW)) {
        drop(q.what, `quote of ${out} raw units cannot resolve ${BASE_QUOTE_TOLERANCE * 100}%`);
        refused.add(q.pool.address);
        return;
      }
      const ours = this.simulate(
        q.priced,
        q.pool.token0.key,
        toUnits(q.amountIn, q.pool.token0.decimals),
      );
      const theirs = toUnits(out, q.pool.token1.decimals);
      const gap = Math.abs(ours - theirs) / theirs;
      if (gap > BASE_QUOTE_TOLERANCE) {
        drop(q.what, `simulate() differs from getAmountOut() by ${(gap * 100).toFixed(4)}%`);
        refused.add(q.pool.address);
      }
    });

    for (const d of dropped) console.error(`base: DROPPED ${d.what}: ${d.why}`);

    this.tokens = tokens;
    this.pools = identified.filter((p) => !refused.has(p.address));
    this.absent = absent;
    this.dropped = dropped;
    this.verified = true;
  }

  /** One tick's worth of reserves and fees, pinned to a single block. */
  private async read(abort: AbortSignal): Promise<Pool[]> {
    this.rpc.resetMode();
    const block = await this.blockNumber(abort);
    const tag = hexTag(block);

    const replies = await this.rpc.send(
      this.pools.flatMap((p) => [
        ethCall(p.address, SEL.getReserves, [], tag),
        ...(p.dex === "aerodrome"
          ? [ethCall(AERODROME_POOL_FACTORY, SEL.getFee, [encAddress(p.address), encBool(false)], tag)]
          : []),
      ]),
      abort,
    );

    const out: Pool[] = [];
    let at = 0;
    let errors = 0;
    let skipped = 0;
    let uni = 0;
    let aero = 0;

    for (const p of this.pools) {
      const reservesHex = payload(replies[at++]!);
      const feeHex = p.dex === "aerodrome" ? payload(replies[at++]!) : null;
      if (reservesHex === null || (p.dex === "aerodrome" && feeHex === null)) {
        errors++;
        continue;
      }
      const priced = priceFrom(p, reservesHex, feeHex);
      if ("why" in priced) {
        skipped++;
        continue;
      }
      out.push(priced.pool);
      if (p.dex === "aerodrome") aero++;
      else uni++;
    }

    this.lastRead = { block, mode: this.rpc.mode, uni, aero, errors, skipped };
    return out;
  }
}

/**
 * One pool from its getReserves() reply and, for Aerodrome, its getFee() reply.
 *
 * Rejection, never repair, as on the other venues: an empty reserve or a fee
 * outside what the factory can store is not priced with a guess.
 */
function priceFrom(
  p: TrackedPool,
  reservesHex: string,
  feeHex: string | null,
): { pool: Pool; r0: bigint } | { why: string } {
  const r0 = word(reservesHex, 0);
  const r1 = word(reservesHex, 1);
  if (r0 === null || r1 === null) return { why: "getReserves() reply malformed" };
  if (r0 === 0n || r1 === 0n) return { why: "empty reserves" };

  let feeBp = UNISWAP_V2_FEE_BP;
  if (p.dex === "aerodrome") {
    const fee = feeHex === null ? null : word(feeHex, 0);
    if (fee === null || fee > BigInt(AERODROME_MAX_FEE_BP)) {
      return { why: `getFee() answered ${fee}` };
    }
    feeBp = Number(fee);
  }

  return {
    pool: {
      id: p.address,
      a: p.token0.key,
      b: p.token1.key,
      ra: toUnits(r0, p.token0.decimals),
      rb: toUnits(r1, p.token1.decimals),
      feeBp,
    },
    r0,
  };
}
