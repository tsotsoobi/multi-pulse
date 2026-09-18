import {
  AERODROME_POOL_FACTORY,
  BASE_CHAIN_ID,
  BASE_FEE_NATIVE,
  BASE_QUOTE_MIN_RAW,
  BASE_QUOTE_PROBE_DIVISOR,
  BASE_QUOTE_TOLERANCE,
  BASE_RPC_URL,
  BASE_SEED_TOKENS,
  BASE_TICK_TIMEOUT_MS,
  MULTICALL3,
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
 * ONE eth_call PER TICK. The public endpoint allows roughly five eth_call per
 * time window (see MULTICALL3 in config.ts), so every contract read is wrapped
 * in a single Multicall3 aggregate3 call, pinned to the tick's block: exactly
 * one eth_call per normal tick, at most three in start(). test/check.ts counts
 * them. aggregate3 is the only Multicall3 function this file may use.
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
  aggregate3: "82ad56cb", // aggregate3((address,bool,bytes)[])
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
  private readonly transport: Transport;
  private nextId = 1;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * THE ONLY PATH TO THE NETWORK. Every method is checked against RPC_METHODS
   * before anything is sent, and one bad method refuses the whole call rather
   * than sending the good ones first.
   *
   * Each call is one HTTP POST of a single JSON-RPC object, in order. There is
   * no JSON-RPC batching: since every contract read travels inside one
   * aggregate3 eth_call, no caller has more than one call to send at a time.
   * A reply whose id does not match its request is answered as an error.
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
    for (const c of calls) {
      const id = this.nextId++;
      const res = await this.transport(
        JSON.stringify({ jsonrpc: "2.0", id, method: c.method, params: c.params }),
        abort,
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`base: HTTP ${res.status} for ${c.method}`);
      }
      const replyId = (res.json as { id?: unknown } | null)?.id;
      out.push(
        replyId === id
          ? toReply(res.json)
          : {
              ok: false,
              code: null,
              message: `reply id ${JSON.stringify(replyId)}, expected ${id}`,
            },
      );
    }
    return out;
  }
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

/** One contract read inside an aggregate3 call. `data` is hex without 0x. */
export interface SubCall {
  target: string;
  data: string;
}

function sub(target: string, selector: string, args: string[] = []): SubCall {
  return { target, data: selector + args.join("") };
}

/**
 * Calldata for Multicall3 aggregate3((address,bool,bytes)[]), by hand.
 *
 *   selector
 *   0x20                    offset of the array
 *   n                       array length
 *   n offsets               each from the word after the length to its element
 *   n elements              target, allowFailure, 0x60 (offset of the bytes
 *                           within the element), bytes length, bytes padded
 *                           right to a whole word
 *
 * allowFailure is always 1 and is not a parameter: a read that reverts must
 * come back as success = false, never take the other reads down with it.
 */
export function encodeAggregate3(calls: readonly SubCall[]): string {
  const heads: string[] = [];
  const tails: string[] = [];
  let offset = calls.length * 32;
  for (const c of calls) {
    const bytes = c.data.length / 2;
    const padded = c.data.toLowerCase().padEnd(Math.ceil(bytes / 32) * 64, "0");
    const element =
      encAddress(c.target) + encBool(true) + encUint(0x60n) + encUint(BigInt(bytes)) + padded;
    heads.push(encUint(BigInt(offset)));
    tails.push(element);
    offset += element.length / 2;
  }
  const head = SEL.aggregate3 + encUint(0x20n) + encUint(BigInt(calls.length));
  return "0x" + head + heads.join("") + tails.join("");
}

/**
 * The (bool success, bytes returnData)[] an aggregate3 call returns, as one
 * entry per sub-call: the returnData hex (without 0x, possibly empty) where
 * success is true, null where it is false.
 *
 * Every offset and length is checked against the payload, each success word
 * must be exactly 0 or 1, and there must be exactly `n` entries. Anything else
 * THROWS: a reply we cannot read is a failure of the whole call, retried next
 * time, never a set of individual reverts.
 */
export function decodeAggregate3(hex: string, n: number): Array<string | null> {
  const bad = (why: string): never => {
    throw new Error(`base: aggregate3 result malformed: ${why}`);
  };
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) bad("not hex");
  const size = hex.length / 2;

  // A word at a byte position, which must lie inside the payload and, since
  // every word read here is an offset, a length or a bool, be no larger than it.
  const at = (byte: number): number => {
    if (byte + 32 > size) bad(`word at byte ${byte} is past the end (${size} bytes)`);
    const w = BigInt("0x" + hex.slice(byte * 2, byte * 2 + 64));
    if (w > BigInt(size)) bad(`word at byte ${byte} is ${w}, larger than the payload`);
    return Number(w);
  };

  const array = at(0);
  const len = at(array);
  if (len !== n) bad(`${len} results for ${n} calls`);
  const heads = array + 32;

  const out: Array<string | null> = [];
  for (let i = 0; i < n; i++) {
    const element = heads + at(heads + 32 * i);
    const success = at(element);
    if (success > 1) bad(`success word ${success} in entry ${i}`);
    const dataAt = element + at(element + 32);
    const dataLen = at(dataAt);
    if (dataAt + 32 + dataLen > size) bad(`returnData of entry ${i} runs past the end`);
    out.push(success === 1 ? hex.slice((dataAt + 32) * 2, (dataAt + 32 + dataLen) * 2) : null);
  }
  return out;
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
  /** Pools returned, per dex. */
  uni: number;
  aero: number;
  /** Sub-calls that reverted this tick; their pools are missing from it. */
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
      ` block=${r.block || "none"}` +
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
   * Every read in `calls` as ONE eth_call to Multicall3 aggregate3, pinned to
   * `tag`. Returns one entry per sub-call: its returnData hex, or null where it
   * reverted (success = false).
   *
   * An error on the eth_call itself, "over rate limit" included, or a result
   * that does not decode, THROWS: it says nothing about any one token or pool,
   * so the whole verification or tick fails and is retried next time. An empty
   * list sends nothing.
   */
  private async multicall(
    calls: readonly SubCall[],
    tag: string,
    abort: AbortSignal,
  ): Promise<Array<string | null>> {
    if (calls.length === 0) return [];
    const [r] = await this.rpc.send(
      [{ method: "eth_call", params: [{ to: MULTICALL3, data: encodeAggregate3(calls) }, tag] }],
      abort,
    );
    const hex = r ? payload(r) : null;
    if (hex === null) {
      throw new Error(
        `base: aggregate3 of ${calls.length} reads failed: ${r ? describe(r) : "no reply"}`,
      );
    }
    return decodeAggregate3(hex, calls.length);
  }

  /**
   * Startup verification, pinned to one block, in at most three eth_calls:
   *
   *   1. eth_chainId is 8453 (not an eth_call).
   *   2. first aggregate3: every seed token's symbol() and decimals(), AND the
   *      factory lookups for every pair of seeds. The lookups do not depend on
   *      the token checks, so they ride in the same call; a pool involving a
   *      token that fails its check is discarded afterwards. A zero address
   *      means no pool and is not an error.
   *   3. second aggregate3: each pool's token0/token1 are the pair it was found
   *      by, its factory() is the factory that returned it, and an Aerodrome
   *      pool is not stable. Aerodrome getReserves() and getFee() ride along;
   *      they are used only for pools that pass.
   *   4. third aggregate3: each Aerodrome pool's own getAmountOut agrees with
   *      our simulate() to within BASE_QUOTE_TOLERANCE. This also proves
   *      getFee's units.
   *
   * A reverted read or a mismatch drops that token or pool and is reported. A
   * failed eth_call throws, and the whole verification runs again next tick.
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

    // 2. tokens and pool lookups, every unordered pair of seeds, both factories
    const seeds = BASE_SEED_TOKENS.filter((s) => {
      if (ADDRESS_RE.test(s.address)) return true;
      drop(`token ${s.symbol} ${s.address}`, "not a 20-byte hex address");
      return false;
    });
    const seedPairs: Array<[number, number]> = [];
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) seedPairs.push([i, j]);
    }
    const first = await this.multicall(
      [
        ...seeds.flatMap((s) => [sub(s.address, SEL.symbol), sub(s.address, SEL.decimals)]),
        ...seedPairs.flatMap(([i, j]) => {
          const a = encAddress(seeds[i]!.address);
          const b = encAddress(seeds[j]!.address);
          return [
            sub(UNISWAP_V2_FACTORY, SEL.getPair, [a, b]),
            sub(AERODROME_POOL_FACTORY, SEL.getPool, [a, b, encBool(false)]),
          ];
        }),
      ],
      tag,
      abort,
    );

    const tokens: Token[] = [];
    const bySeed = new Map<number, Token>();
    seeds.forEach((s, i) => {
      const what = `token ${s.symbol} ${s.address}`;
      const symHex = first[2 * i] ?? null;
      const decHex = first[2 * i + 1] ?? null;
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
        const token = { key, symbol: s.symbol, decimals: s.decimals };
        tokens.push(token);
        bySeed.set(i, token);
      }
    });

    if (!tokens.some((t) => t.key === NATIVE)) {
      throw new Error("base: WETH failed verification, so there is no cycle anchor");
    }

    const found: Array<{ dex: Dex; address: string; a: Token; b: Token }> = [];
    let absent = 0;
    const lookupsAt = 2 * seeds.length;
    seedPairs.forEach(([i, j], p) => {
      const a = bySeed.get(i);
      const b = bySeed.get(j);
      if (!a || !b) return; // a token in this pair failed its check: not a pool of ours
      (["uniswap-v2", "aerodrome"] as const).forEach((dex, k) => {
        const what = `${dex} ${a.symbol}/${b.symbol}`;
        const hex = first[lookupsAt + 2 * p + k] ?? null;
        const address = hex === null ? null : wordAddress(hex, 0);
        if (address === null) drop(what, "factory lookup returned no address");
        else if (address === ZERO_ADDRESS) absent++;
        else found.push({ dex, address, a, b });
      });
    });

    // 3. identity of each pool, plus Aerodrome reserves and fee
    const second = await this.multicall(
      found.flatMap((f) => [
        sub(f.address, SEL.token0),
        sub(f.address, SEL.token1),
        sub(f.address, SEL.factory),
        ...(f.dex === "aerodrome"
          ? [
              sub(f.address, SEL.stable),
              sub(f.address, SEL.getReserves),
              sub(AERODROME_POOL_FACTORY, SEL.getFee, [encAddress(f.address), encBool(false)]),
            ]
          : []),
      ]),
      tag,
      abort,
    );

    const identified: TrackedPool[] = [];
    const probes: Array<{ pool: TrackedPool; priced: Pool; amountIn: bigint; what: string }> = [];
    const refused = new Set<string>();
    let at = 0;
    for (const f of found) {
      const what = `${f.dex} ${f.a.symbol}/${f.b.symbol} ${f.address}`;
      const addr = (hex: string | null): string | null =>
        hex === null ? null : wordAddress(hex, 0);
      const t0 = addr(second[at++] ?? null);
      const t1 = addr(second[at++] ?? null);
      const factory = addr(second[at++] ?? null);
      const stableHex = f.dex === "aerodrome" ? second[at++] ?? null : null;
      const reservesHex = f.dex === "aerodrome" ? second[at++] ?? null : null;
      const feeHex = f.dex === "aerodrome" ? second[at++] ?? null : null;

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
      const token0 = t0 === f.a.key ? f.a : f.b;
      const token1 = token0 === f.a ? f.b : f.a;
      const pool: TrackedPool = { dex: f.dex, address: f.address, token0, token1 };

      if (f.dex === "uniswap-v2") {
        identified.push(pool);
        continue;
      }

      // Aerodrome: not stable, priceable, and probed against its own quote below.
      const stable = stableHex === null ? null : word(stableHex, 0);
      if (stable !== 0n) {
        drop(what, `stable() answered ${stable}, expected false`);
        continue;
      }
      const priced = reservesHex === null ? null : priceFrom(pool, reservesHex, feeHex);
      if (priced === null || "why" in priced) {
        drop(what, priced?.why ?? "getReserves() reverted");
        continue;
      }
      // Both rounding bounds must hold: on the input after the pool's own fee
      // deduction, and on the output below. See BASE_QUOTE_MIN_RAW.
      const amountIn = priced.r0 / BigInt(BASE_QUOTE_PROBE_DIVISOR);
      const netIn = amountIn - (amountIn * BigInt(priced.pool.feeBp)) / 10_000n;
      if (netIn < BigInt(BASE_QUOTE_MIN_RAW)) {
        drop(
          what,
          `probe of ${netIn} raw units after fee cannot resolve ${BASE_QUOTE_TOLERANCE * 100}%`,
        );
        continue;
      }
      identified.push(pool);
      probes.push({ pool, priced: priced.pool, amountIn, what });
    }

    // 4. Aerodrome: our arithmetic against the pool's own quote
    const quotes = await this.multicall(
      probes.map((q) =>
        sub(q.pool.address, SEL.getAmountOut, [encUint(q.amountIn), encAddress(q.pool.token0.key)]),
      ),
      tag,
      abort,
    );

    probes.forEach((q, i) => {
      const hex = quotes[i] ?? null;
      const out = hex === null ? null : word(hex, 0);
      if (out === null) {
        drop(q.what, "getAmountOut() reverted");
        refused.add(q.pool.address);
        return;
      }
      if (out < BigInt(BASE_QUOTE_MIN_RAW)) {
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

  /**
   * One tick's worth of reserves and fees, pinned to a single block: one
   * eth_blockNumber and exactly one eth_call, whatever the number of pools.
   */
  private async read(abort: AbortSignal): Promise<Pool[]> {
    const block = await this.blockNumber(abort);
    const tag = hexTag(block);

    const replies = await this.multicall(
      this.pools.flatMap((p) => [
        sub(p.address, SEL.getReserves),
        ...(p.dex === "aerodrome"
          ? [sub(AERODROME_POOL_FACTORY, SEL.getFee, [encAddress(p.address), encBool(false)])]
          : []),
      ]),
      tag,
      abort,
    );

    const out: Pool[] = [];
    let at = 0;
    let errors = 0;
    let skipped = 0;
    let uni = 0;
    let aero = 0;

    for (const p of this.pools) {
      const reservesHex = replies[at++] ?? null;
      const feeHex = p.dex === "aerodrome" ? replies[at++] ?? null : null;
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

    this.lastRead = { block, uni, aero, errors, skipped };
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
