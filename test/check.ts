import {
  findOpportunities,
  limitsFor,
  nativeReserve,
  partitionByDepth,
} from "../src/arb.js";
import {
  MIN_PROFIT_BPS,
  VENUE_LIMITS,
  XRPL_BASE_FEE_DROPS,
  XRPL_FEE_SAFETY_MULTIPLIER,
  venueLimits,
} from "../src/config.js";
import { StreakTracker, logHeartbeat, logOpportunity, LOG_PATH } from "../src/logger.js";
import { StellarVenue, shardBounds } from "../src/venues/stellar.js";
import {
  XrplVenue,
  buildCandidates,
  classifySeeds,
  decodeCurrency,
  parseAmount,
  toPool,
} from "../src/venues/xrpl.js";
import {
  BaseVenue,
  RPC_METHODS,
  Rpc,
  decodeAggregate3,
  encodeAggregate3,
  toUnits,
  type RpcReply,
  type Transport,
} from "../src/venues/base.js";
import {
  AERODROME_POOL_FACTORY,
  BASE_FEE_NATIVE,
  BASE_QUOTE_MIN_RAW,
  BASE_QUOTE_PROBE_DIVISOR,
  BASE_QUOTE_TOLERANCE,
  MULTICALL3,
  UNISWAP_V2_FACTORY,
  quoteMinRaw,
} from "../src/config.js";
import type { Pool, Venue } from "../src/venue.js";
import { readFileSync, readdirSync, rmSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REAL = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const FAKE = "USDC:GBFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEX";
const v = new StellarVenue();

const p = (id: string, b: string, ra: number, rb: number, feeBp = 30): Pool => ({
  id, a: "native", b, ra, rb, feeBp,
});

let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) fail++;
};

// 1. A genuine direct edge across two real-USDC pools.
const P1 = p("p1", REAL, 1_000_000, 100_000);
const P2 = p("p2", REAL, 1_000_000, 90_000);
const real = findOpportunities(v, [P1, P2]);
check("direct edge found", real.length > 0, `n=${real.length}`);
const top = real[0]!;
check("routeKey carries the issuer", top.routeKey.includes(REAL), top.routeKey);
check("routeLabel is code-only", top.routeLabel === "XLM > USDC(GA5Z..KZVN) > XLM", top.routeLabel);
check("net = output - size - fee",
  Math.abs(top.netProfit - (top.output - top.size - v.feeNative)) < 1e-9);
check("size came off the STELLAR ladder", VENUE_LIMITS.stellar.sizeLadder.includes(top.size), `size=${top.size}`);

// 2. THE ISSUER TEST. Same code, different issuer, prices that would look like
//    a fat edge to anything keying on codes. Must find nothing.
const P3 = p("p3", FAKE, 1_000_000, 90_000);
const spoof = findOpportunities(v, [P1, P3]);
check("real+fake USDC is NOT a cycle", spoof.length === 0, `n=${spoof.length}`);

// 3. With all three present, only the issuer-matched pair survives.
const mixed = findOpportunities(v, [P1, P2, P3]);
check("mixed set finds only real route", mixed.length === 1 && mixed[0]!.routeKey === `native>${REAL}>native`,
  mixed.map((o) => o.routeKey).join(" | "));

// 4. Per-pool fee is honoured, not assumed to be 30.
const hi = findOpportunities(v, [p("h1", REAL, 1_000_000, 100_000, 900), p("h2", REAL, 1_000_000, 90_000, 900)]);
check("high-fee pools kill the edge", hi.length === 0, `n=${hi.length}`);

// 5. Ranking is on absolute net profit, descending.
const many = findOpportunities(v, [P1, P2, p("p4", "AQUA:GBNZ", 500_000, 700_000), p("p5", "AQUA:GBNZ", 500_000, 600_000)]);
check("ranked by net profit desc",
  many.every((o, i) => i === 0 || many[i - 1]!.netProfit >= o.netProfit),
  many.map((o) => o.netProfit.toFixed(4)).join(" >= "));

// 6. Streak continuity.
const t = new StreakTracker();
const t0 = new Date("2026-08-10T00:00:00Z");
const t2 = new Date("2026-08-10T00:00:02Z");
const t4 = new Date("2026-08-10T00:00:04Z");
t.beginTick(); const s1 = t.mark("R", t0); t.endTick();
t.beginTick(); const s2 = t.mark("R", t2); t.endTick();
check("streak continues across ticks", s2.firstSeen === s1.firstSeen && s2.seconds === 2 && s2.ticks === 2,
  JSON.stringify(s2));
t.beginTick(); t.endTick();                       // a tick where R did not qualify
t.beginTick(); const s3 = t.mark("R", t4); t.endTick();
check("gap resets first_seen", s3.firstSeen === t4.toISOString() && s3.seconds === 0 && s3.ticks === 1,
  JSON.stringify(s3));
check("dropped route is forgotten", t.activeCount === 1);

// 7. CSV shape.
//
// Written to a SCRATCH path, never LOG_PATH. This test rm's the file it writes,
// and when it used the real one, running `npm run check` against a live monitor
// deleted that run's accumulated rows -- silently, because the monitor only
// appends and simply rebuilt the header on its next tick.
const TEST_CSV = resolve(tmpdir(), "multi-pulse-check-opportunities.csv");
rmSync(TEST_CSV, { force: true });
logOpportunity(top, s1, t0, 61177, TEST_CSV);
logHeartbeat("stellar", "pools=2 routes=1", t0, "heartbeat", 61177, TEST_CSV);
logHeartbeat("stellar", "error: Horizon 503", t0, "error", 61177, TEST_CSV);
const csv = readFileSync(TEST_CSV, "utf8").trim().split("\n");
check("header matches spec",
  csv[0] === "timestamp,venue,kind,route_key,route_label,size,output,gross_bps,fee_native,net_profit,first_seen,last_seen,tick_interval_ms",
  csv[0]);
check("opportunity row has 13 fields", (csv[1]!.match(/,/g) ?? []).length === 12, csv[1]);
// The resolution a streak was measured at must ride on every row, including
// heartbeats -- a reader comparing venues needs it wherever persistence is.
check("tick interval is carried on the opportunity row",
  csv[1]!.endsWith(",61177"), csv[1]);
check("tick interval is carried on heartbeats too",
  csv[2]!.endsWith(",61177") && csv[3]!.endsWith(",61177"), csv[2]);
check("heartbeat row present", csv[2]!.includes(",heartbeat,,"), csv[2]);
check("error row present", csv[3]!.includes(",error,,"), csv[3]);
rmSync(TEST_CSV, { force: true });

// Guard the guard: prove this test cannot reach the production CSV again.
//
// The needle is assembled rather than written out, because this check reads its
// OWN source -- spelled literally it would match itself and fail forever.
const FORBIDDEN = "rmSync(" + "LOG_PATH";
check("the CSV test never touches the live log path",
  TEST_CSV !== LOG_PATH &&
    !readFileSync(fileURLToPath(import.meta.url), "utf8").includes(FORBIDDEN),
  TEST_CSV);

// ---------------------------------------------------------------------------
// 8. XRPL adapter
// ---------------------------------------------------------------------------

const x = new XrplVenue([]);
const RIPPLE_USD_ISSUER = "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B";
const OTHER_USD_ISSUER = "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq";
const XOGE_HEX = "586F676500000000000000000000000000000000";

check("xrpl native key is XRP", x.nativeKey === "XRP", x.nativeKey);
check("xrpl fallback fee is the reference fee TIMES the safety multiplier",
  x.feeNative === (XRPL_BASE_FEE_DROPS * XRPL_FEE_SAFETY_MULTIPLIER) / 1e6 && x.feeNative === 0.0001,
  String(x.feeNative));
check("fallback fee is flagged as not live", x.feeIsLive === false);

// Drops in, XRP out. The only place the two units meet.
const drops = parseAmount("1000000");
check("XRP amount converts drops to XRP", drops?.key === "XRP" && drops.units === 1,
  JSON.stringify(drops));
const halfDrop = parseAmount("500000");
check("half an XRP is 500000 drops", halfDrop?.units === 0.5, JSON.stringify(halfDrop));
check("zero drops is not a reserve", parseAmount("0") === null);

// Issued currency values are already whole tokens. No scaling.
const tok = parseAmount({ currency: "USD", issuer: RIPPLE_USD_ISSUER, value: "123.456789012345" });
check("token amount is whole units, not scaled",
  tok?.units === 123.456789012345, JSON.stringify(tok));
check("token key is CURRENCY:ISSUER",
  tok?.key === `USD:${RIPPLE_USD_ISSUER}`, tok?.key);

// trading_fee is 1/100,000, so 462 -> 46.2 bp -> 0.462%.
const amm = toPool({
  account: "rAMMxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1",
  amount: "2000000000",                                     // 2000 XRP in drops
  amount2: { currency: "USD", issuer: RIPPLE_USD_ISSUER, value: "1000" },
  trading_fee: 462,
});
check("trading_fee 462 becomes 46.2 bp", amm?.feeBp === 46.2, String(amm?.feeBp));
check("pool reserves are in whole units", amm?.ra === 2000 && amm?.rb === 1000,
  `ra=${amm?.ra} rb=${amm?.rb}`);
check("pool id is the AMM account", amm?.id === "rAMMxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1", amm?.id);
check("zero trading_fee is legal", toPool({
  account: "rA2", amount: "1000000", trading_fee: 0,
  amount2: { currency: "USD", issuer: RIPPLE_USD_ISSUER, value: "1" },
})?.feeBp === 0);
check("missing trading_fee is rejected, not defaulted", toPool({
  account: "rA3", amount: "1000000",
  amount2: { currency: "USD", issuer: RIPPLE_USD_ISSUER, value: "1" },
}) === null);

// Hex codes stay hex in the key and decode only for the label.
const hexPool = toPool({
  account: "rA4",
  amount: "1000000",
  amount2: { currency: XOGE_HEX, issuer: RIPPLE_USD_ISSUER, value: "1" },
  trading_fee: 500,
});
check("hex currency stays hex in the key",
  hexPool?.b === `${XOGE_HEX}:${RIPPLE_USD_ISSUER}`, hexPool?.b);
check("hex currency decodes in the label",
  x.assetLabel(hexPool!.b) === "Xoge(rvYA..s59B)", x.assetLabel(hexPool!.b));
check("standard code labels unchanged",
  x.assetLabel(`USD:${RIPPLE_USD_ISSUER}`) === "USD(rvYA..s59B)",
  x.assetLabel(`USD:${RIPPLE_USD_ISSUER}`));
check("native labels as XRP", x.assetLabel("XRP") === "XRP");
check("non-ascii hex is not decoded into a fake name",
  decodeCurrency("FFFF000000000000000000000000000000000000").startsWith("0x"),
  decodeCurrency("FFFF000000000000000000000000000000000000"));
check("XLS-15 / demurrage codes are not decoded",
  decodeCurrency("01" + "41".repeat(19)).startsWith("0x"));

// THE ISSUER TEST, again, on this venue. Same code, two issuers, fat spread.
const xp = (id: string, b: string, ra: number, rb: number, feeBp = 30): Pool => ({
  id, a: "XRP", b, ra, rb, feeBp,
});
const xReal = `USD:${RIPPLE_USD_ISSUER}`;
const xFake = `USD:${OTHER_USD_ISSUER}`;
check("xrpl: two issuers of USD are not a cycle",
  findOpportunities(x, [xp("x1", xReal, 1_000_000, 100_000), xp("x2", xFake, 1_000_000, 90_000)]).length === 0);
check("xrpl: matched issuers are a cycle",
  findOpportunities(x, [xp("x1", xReal, 1_000_000, 100_000), xp("x2", xReal, 1_000_000, 90_000)]).length > 0);

// simulate() uses the pool's fee, and never sees a drop.
const zeroFee = x.simulate(xp("s1", xReal, 1000, 1000, 0), "XRP", 1);
check("zero-fee constant product is exact", Math.abs(zeroFee - 1000 / 1001) < 1e-12,
  String(zeroFee));
const withFee = x.simulate(xp("s2", xReal, 1000, 1000, 46.2), "XRP", 1);
check("pool fee reduces the output", withFee < zeroFee && withFee > 0.99 * zeroFee,
  String(withFee));
check("simulate is symmetric on direction",
  x.simulate(xp("s3", xReal, 1000, 2000, 0), xReal, 1) ===
    x.simulate({ id: "s3", a: xReal, b: "XRP", ra: 2000, rb: 1000, feeBp: 0 }, xReal, 1));

// Candidate enumeration: n + n(n-1)/2, unordered, malformed entries dropped.
const seeds = [
  { currency: "USD", issuer: RIPPLE_USD_ISSUER },
  { currency: "EUR", issuer: OTHER_USD_ISSUER },
  { currency: XOGE_HEX, issuer: RIPPLE_USD_ISSUER },
];
check("candidates = tokens + all token pairs", buildCandidates(seeds).length === 3 + 3,
  String(buildCandidates(seeds).length));
check("bad currency code is dropped before the network sees it",
  buildCandidates([...seeds, { currency: "TOOLONG", issuer: RIPPLE_USD_ISSUER }]).length === 6);
check("bad issuer address is dropped",
  buildCandidates([...seeds, { currency: "AAA", issuer: "not-an-address" }]).length === 6);
check("duplicate seed is dropped",
  buildCandidates([...seeds, { currency: "USD", issuer: RIPPLE_USD_ISSUER }]).length === 6);
check("issued XRP is refused", buildCandidates([{ currency: "XRP", issuer: RIPPLE_USD_ISSUER }]).length === 0);

// A dropped seed is a hole in this venue's coverage, so it must be reportable
// rather than merely absent. The 4-letter case is called out on its own because
// it is the one that has actually bitten: USDC, SOLO and CORE all shipped in
// the first seed list as plain ASCII and were dropped without a word.
const classified = classifySeeds([
  { currency: "USD", issuer: RIPPLE_USD_ISSUER },
  { currency: "USDC", issuer: RIPPLE_USD_ISSUER },      // 4 letters, must be hex
  { currency: "AAA", issuer: "not-an-address" },
  { currency: "XRP", issuer: RIPPLE_USD_ISSUER },
  { currency: "USD", issuer: RIPPLE_USD_ISSUER },       // duplicate
]);
check("classifySeeds keeps only the usable seed", classified.valid.length === 1,
  String(classified.valid.length));
check("every unusable seed is reported, not just omitted",
  classified.dropped.length === 4, String(classified.dropped.length));
check("a 4-letter code says so specifically",
  classified.dropped.some((d) => d.seed.currency === "USDC" && /4-letter/.test(d.why)),
  classified.dropped.map((d) => `${d.seed.currency}: ${d.why}`).join(" | "));
check("classifySeeds and buildCandidates agree on what is valid",
  buildCandidates([
    { currency: "USD", issuer: RIPPLE_USD_ISSUER },
    { currency: "USDC", issuer: RIPPLE_USD_ISSUER },
  ]).length === 1);

// The venue must carry the drops where a reader will actually see them.
const dropped = new XrplVenue([{ currency: "SOLO", issuer: RIPPLE_USD_ISSUER }]);
check("the venue exposes its dropped seeds", dropped.droppedSeeds.length === 1);
check("the heartbeat shouts about dropped seeds",
  dropped.fetchNote().includes("SEEDS_DROPPED=1"), dropped.fetchNote());
check("a clean seed list says nothing about drops",
  !new XrplVenue([{ currency: "USD", issuer: RIPPLE_USD_ISSUER }]).fetchNote().includes("SEEDS_DROPPED"));

// ---------------------------------------------------------------------------
// 8b. SHARDED POOL WALK.
//
// The Stellar walk was split into concurrent id ranges because 99.93% of a
// 61-second tick was serial HTTP wait. The whole correctness question is
// whether the ranges TILE the id space: a gap silently loses pools, which does
// not degrade the answer but removes whole cycles, and an overlap would feed
// arb.ts the same pool twice as if it were two venues quoting identically.
//
// These checks are on the arithmetic alone -- no network -- because that is
// where a tiling bug would live.
// ---------------------------------------------------------------------------

const idOf = (hex: string) => hex.padEnd(64, "0");

for (const n of [1, 2, 3, 12, 16, 37]) {
  const bounds = shardBounds(n);
  const ok =
    bounds.length === n &&
    bounds[0]!.after === "" &&                       // starts before the lowest id
    bounds[n - 1]!.upTo === null &&                  // last shard has no ceiling
    bounds.every((b, i) => i === 0 || b.after === bounds[i - 1]!.upTo);
  check(`shardBounds(${n}) tiles the id space with no gap`, ok,
    JSON.stringify(bounds.map((b) => [b.after.slice(0, 4), b.upTo?.slice(0, 4) ?? "END"])));
}

// Every id must fall in exactly one shard, boundary values included. A shard
// covers (after, upTo], so an id landing exactly on a cut point belongs to the
// LOWER shard -- Horizon's cursor is exclusive, so the upper shard skips it.
const bounds12 = shardBounds(12);
const owns = (id: string): number =>
  bounds12.findIndex(
    (b) => (b.after === "" || id > b.after) && (b.upTo === null || id <= b.upTo),
  );
const probeIds = [
  idOf("0000"), idOf("0001"), idOf("1555"), idOf("2aaa"), idOf("5555"),
  idOf("aaaa"), idOf("ffff"), "f".repeat(64),
  ...bounds12.slice(1).map((b) => b.upTo ?? ""),   // exact cut points
  ...bounds12.slice(1).map((b) => b.after),
].filter(Boolean);
check("every id belongs to exactly one shard",
  probeIds.every((id) => {
    const hits = bounds12.filter(
      (b) => (b.after === "" || id > b.after) && (b.upTo === null || id <= b.upTo),
    );
    return hits.length === 1;
  }),
  probeIds.map((id) => `${id.slice(0, 4)}->${owns(id)}`).join(" "));

// The lowest and highest possible ids must be covered.
check("the id space is covered end to end",
  owns("0".repeat(64)) === 0 && owns("f".repeat(64)) === bounds12.length - 1,
  `lo=${owns("0".repeat(64))} hi=${owns("f".repeat(64))}`);

// A single shard degenerates to the original serial walk: no cursor, no ceiling.
const one = shardBounds(1);
check("one shard is the whole space, unbounded",
  one.length === 1 && one[0]!.after === "" && one[0]!.upTo === null);

// String comparison is exact only because ids are fixed-width lowercase hex.
check("shard bounds are full-width 64-char hex",
  shardBounds(12).every((b) => b.after === "" || b.after.length === 64) &&
    shardBounds(12).every((b) => b.upTo === null || b.upTo.length === 64));

// ---------------------------------------------------------------------------
// 9. PER-VENUE SIZING.
//
// The ladder and the net-profit floor are denominated in each venue's own
// asset, so one shared set of numbers is not one economic size: 1000 XLM and
// 1000 XRP differ by roughly an order of magnitude in dollars, and a shared
// ladder therefore probes a much deeper slice of one venue than the other while
// a shared floor filters one much harder. Route counts would then differ
// between venues for reasons that live entirely in config.ts, which would
// corrupt the only comparison this repo produces.
//
// These checks pin the SHAPE of the split, not the specific rungs -- the rungs
// are a judgement call about exchange rates that will need retuning, and a test
// asserting them would just have to be edited alongside. What must not drift is
// that the two ladders are different, that they mean the same thing in dollars,
// and that the ratio-valued threshold is NOT split.
// ---------------------------------------------------------------------------

const S = VENUE_LIMITS.stellar;
const X = VENUE_LIMITS.xrpl;

/** The XLM-per-XRP ratio the ladders in config.ts are sized against. */
const ASSUMED_XLM_PER_XRP = 10;

check("the two ladders are actually different",
  S.sizeLadder.join(",") !== X.sizeLadder.join(","));
check("both ladders have the same number of rungs",
  S.sizeLadder.length === X.sizeLadder.length,
  `stellar=${S.sizeLadder.length} xrpl=${X.sizeLadder.length}`);
check("rung by rung, the ladders match in dollar terms",
  S.sizeLadder.every((s, i) => Math.abs(s / ASSUMED_XLM_PER_XRP - X.sizeLadder[i]!) < 1e-9),
  S.sizeLadder.map((s, i) => `${s}/${X.sizeLadder[i]}`).join(" "));
check("each ceiling is its own ladder's top rung",
  S.maxTradeSize === S.sizeLadder[S.sizeLadder.length - 1] &&
    X.maxTradeSize === X.sizeLadder[X.sizeLadder.length - 1],
  `stellar=${S.maxTradeSize} xrpl=${X.maxTradeSize}`);
check("the net-profit floors match in dollar terms",
  Math.abs(S.minNetProfit / ASSUMED_XLM_PER_XRP - X.minNetProfit) < 1e-12,
  `stellar=${S.minNetProfit} xrpl=${X.minNetProfit}`);
check("the bps floor is NOT split -- a ratio needs no unit",
  S.minProfitBps === X.minProfitBps && S.minProfitBps === MIN_PROFIT_BPS);

// The flat fee is the other denominated number, and it is what fix 2 addresses:
// both venues must err the same way by roughly the same factor, or the
// comparison is priced against assumptions pointing in opposite directions.
const stellarFee = new StellarVenue().feeNative;
const xrplFee = x.feeNative;
check("the two network-fee assumptions match in dollar terms",
  Math.abs(stellarFee / ASSUMED_XLM_PER_XRP - xrplFee) < 1e-12,
  `stellar=${stellarFee} xrpl=${xrplFee}`);
check("the fee costs the same bps at the bottom rung of each ladder",
  Math.abs((stellarFee / S.sizeLadder[0]!) - (xrplFee / X.sizeLadder[0]!)) < 1e-12,
  `stellar=${(stellarFee / S.sizeLadder[0]!) * 10000}bps xrpl=${(xrplFee / X.sizeLadder[0]!) * 10000}bps`);
check("the safety multiplier is above 1, or it is not doing anything",
  XRPL_FEE_SAFETY_MULTIPLIER > 1, String(XRPL_FEE_SAFETY_MULTIPLIER));

// Wiring: findOpportunities must pick up the venue's own limits by default.
check("limitsFor(stellar) carries the stellar ladder",
  limitsFor("stellar").sizeLadder === S.sizeLadder && limitsFor("stellar").maxSize === S.maxTradeSize);
check("limitsFor(xrpl) carries the xrpl ladder",
  limitsFor("xrpl").sizeLadder === X.sizeLadder && limitsFor("xrpl").maxSize === X.maxTradeSize);

// An unconfigured venue must throw rather than inherit someone else's ladder --
// a silent fallback would produce a full CSV of rows sized in the wrong asset.
let threw = false;
try { venueLimits("solana"); } catch { threw = true; }
check("an unconfigured venue throws instead of borrowing a ladder", threw);

// And the sizes actually chosen come off the right ladder. Same pool shape on
// both venues, so only the configured ladder can explain the difference.
const ladderProbe = (venue: Venue, native: string): number[] => {
  const tok = "TOK:rProbeIssuerAddressxxxxxxxxxxxx";
  const mk = (id: string, ra: number, rb: number): Pool => ({
    id, a: native, b: tok, ra, rb, feeBp: 30,
  });
  return findOpportunities(venue, [
    mk("l1", 1_000_000, 100_000),
    mk("l2", 1_000_000, 90_000),
  ]).map((o) => o.size);
};
const stellarSizes = ladderProbe(v, "native");
const xrplSizes = ladderProbe(x, "XRP");
check("stellar sizes come off the stellar ladder",
  stellarSizes.length > 0 && stellarSizes.every((s) => S.sizeLadder.includes(s)),
  stellarSizes.join(","));
check("xrpl sizes come off the xrpl ladder",
  xrplSizes.length > 0 && xrplSizes.every((s) => X.sizeLadder.includes(s)),
  xrplSizes.join(","));
check("the xrpl ceiling is respected",
  xrplSizes.every((s) => s <= X.maxTradeSize), xrplSizes.join(","));

// --- The depth floor -------------------------------------------------------
//
// The motivating evidence: a 39,807-pool Stellar scan found the deepest XLM
// pool at 13.2m XLM, while every route flagged over eight hours ran through
// pools under 60 XLM. Those cycles were real and correctly priced; they were
// also unroutable. And because XrplVenue only ever sees a seed list that was
// ranked on depth, leaving Stellar unfiltered compares a complete enumeration
// against a curated shortlist. These checks pin the filter's SHAPE.
check("both venues have a depth floor above zero",
  S.minPoolNative > 0 && X.minPoolNative > 0,
  `stellar=${S.minPoolNative} xrpl=${X.minPoolNative}`);
check("the depth floors match in dollar terms",
  Math.abs(S.minPoolNative / ASSUMED_XLM_PER_XRP - X.minPoolNative) < 1e-9,
  `stellar=${S.minPoolNative} xrpl=${X.minPoolNative}`);
check("each floor is 10x that venue's top ladder rung",
  S.minPoolNative === 10 * S.maxTradeSize && X.minPoolNative === 10 * X.maxTradeSize);

// The 60-XLM pool from the evidence, against the 13.2m one. Prices that would
// look like a fat edge to an unfiltered search.
const DUSTY = "DUST:GDUSTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const dustPools = [p("d1", DUSTY, 60, 6_000), p("d2", DUSTY, 60, 5_400)];
check("a dust-pool cycle IS found with no floor",
  findOpportunities(v, dustPools, { ...limitsFor("stellar"), minPoolNative: 0 }).length > 0);
check("the same cycle is gone at the configured floor",
  findOpportunities(v, dustPools).length === 0,
  findOpportunities(v, dustPools).map((o) => o.routeKey).join(" | "));

// Deep pools must still be searched -- the floor must not simply mute a venue.
const deepPools = [p("D1", REAL, 1_000_000, 100_000), p("D2", REAL, 1_000_000, 90_000)];
check("deep pools are unaffected by the floor",
  findOpportunities(v, deepPools).length > 0);

// Shallow NATIVE pools leave the GRAPH, not just the results.
const partitioned = partitionByDepth(v, [...dustPools, ...deepPools], S.minPoolNative);
check("partition puts dust in shallow and depth in deep",
  partitioned.shallow.length === 2 && partitioned.deep.length === 2,
  `deep=${partitioned.deep.length} shallow=${partitioned.shallow.length}`);

check("nativeReserve finds the native side whichever way round it is",
  nativeReserve(v, p("n1", REAL, 42, 1)) === 42 &&
    nativeReserve(v, { id: "n2", a: REAL, b: "native", ra: 1, rb: 42, feeBp: 30 }) === 42);

// --- The middle-leg gap, pinned as DELIBERATE ------------------------------
//
// A token-to-token pool has no native side and is kept however thin it is.
// This is a known unmeasured gap, not an oversight, and these checks exist so
// that the gap stays a decision somebody made rather than a surprise.
//
// Closing it with a per-pool native floor was tried and reverted: on Stellar
// mainnet it cut the searchable graph from 29,485 pools to 153 and drove both
// venues to routes=0. minPoolNative is justified by capital passing THROUGH a
// pool, which is the right question for an outer leg carrying the whole trade
// in native terms, and the wrong one for a middle leg carrying only what the
// first hop produced. The correct fix is a per-route, per-rung slippage check
// inside bestSize(); see the gap note on partitionByDepth.
const OTHER = "OTHR:GOTHERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const t2t = (id: string, ra: number, rb: number): Pool =>
  ({ id, a: REAL, b: OTHER, ra, rb, feeBp: 30 });

const thinMiddle = partitionByDepth(v, [t2t("thin", 1, 1)], S.minPoolNative);
check("a token-to-token pool is KEPT however thin -- the known gap",
  thinMiddle.deep.length === 1 && thinMiddle.shallow.length === 0,
  `deep=${thinMiddle.deep.length}`);
check("nativeReserve reports null for a token-to-token pool",
  nativeReserve(v, t2t("t", 1, 1)) === null);

// The gap has a visible consequence, and `size` is what makes it visible: a
// triangle over a thin middle leg is still reported, but only at the bottom of
// the ladder. That is the signal a reader is meant to use.
const outerDeep = [
  p("o1", REAL, 1_000_000, 100_000),
  p("o2", OTHER, 1_000_000, 90_000),
];
const thinTri = findOpportunities(v, [...outerDeep, t2t("thinmid", 50, 50)])
  .filter((o) => o.kind === "triangular");
const fatTri = findOpportunities(v, [...outerDeep, t2t("fatmid", 500_000, 500_000)])
  .filter((o) => o.kind === "triangular");
check("a thin middle leg caps the route near the bottom of the ladder",
  thinTri.length > 0 && thinTri[0]!.size <= 25,
  `size=${thinTri[0]?.size}`);
check("a deep middle leg lets the same route reach far higher",
  fatTri.length > 0 && fatTri[0]!.size > thinTri[0]!.size,
  `thin=${thinTri[0]?.size} fat=${fatTri[0]?.size}`);

// The heartbeat's count and the search's filter must come from one predicate.
const mixed2 = [...dustPools, ...deepPools];
const split2 = partitionByDepth(v, mixed2, S.minPoolNative);
check("every pool lands in exactly one bucket",
  split2.deep.length + split2.shallow.length === mixed2.length,
  `${split2.deep.length}+${split2.shallow.length} of ${mixed2.length}`);
check("what the search drops is exactly what the heartbeat counts as dropped",
  findOpportunities(v, mixed2).every((o) =>
    o.poolIds.every((id) => split2.deep.some((q) => q.id === id))));

// A caller may narrow the ceiling but never widen it past the venue's own.
const widened = findOpportunities(x, [
  xp("w1", xReal, 1_000_000, 100_000), xp("w2", xReal, 1_000_000, 90_000),
], { ...limitsFor("xrpl"), maxSize: 1_000_000 });
check("a caller cannot widen the ceiling past the venue's own",
  widened.every((o) => o.size <= X.maxTradeSize),
  widened.map((o) => o.size).join(","));

// ---------------------------------------------------------------------------
// 10. THE READ-ONLY PROPERTY.
//
// Until now this repo was read-only by omission: no signing library was on
// disk, so no amount of editing could have produced a transaction without
// first adding a dependency. `xrpl` ends that. It is a real dependency, we need
// it for Client, and the same package exports Wallet, sign, autofill and
// submitAndWait -- one import line away from every file under src/.
//
// So the property has to be asserted rather than assumed, and it is asserted
// against the source text, because that is the only thing that stays true when
// someone who has not read venue.ts adds a feature. Four separate claims, each
// closing a hole the others leave open:
//
//   (a) IMPORTS. `Client` is the only binding taken from `xrpl`, anywhere.
//       Blocks `import { Wallet } from "xrpl"` and, just as importantly,
//       `import * as xrpl` -- a namespace binding hands over the whole package
//       while naming none of it.
//
//   (b) IDENTIFIERS. None of the banned names appear in executable code.
//       Comments and the contents of quoted strings are removed first: this
//       file is enforcing a property of the program, and venue.ts explaining in
//       prose that it must never sign is the property being kept, not broken.
//       Template literals are NOT blanked, because they can contain real code.
//
//   (c) COMMAND VOCABULARY. This is the hole (a) and (b) leave wide open, and
//       on XRPL it is the dangerous one. `submit` is a rippled COMMAND, not
//       just a library function: Client.request({command: "submit", ...}) sends
//       a signed blob to the network while importing nothing but Client and
//       writing none of the banned words as identifiers. So every `command:`
//       in the tree must carry a literal from a read-only allowlist.
//
//   (d) DYNAMIC ACCESS. client["sub" + "mit"] is beyond a text check, but the
//       blunt form client["submit"] is not, and (b) cannot see it because the
//       name lives in a string. Checked on the raw source.
//
// None of this stops a determined author -- nothing textual can. It stops the
// accident, and it makes the deliberate version something you have to do on
// purpose, in a diff, with this comment in it.
// ---------------------------------------------------------------------------

const SRC_ROOTS = [
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "src"),
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts"),
];

/** Names that must never appear as executable identifiers under src/. */
const BANNED = [
  "Wallet",
  "wallet",
  "sign",
  "submit",
  "submitAndWait",
  "autofill",
  "Transaction",
];

/** rippled commands this repo is allowed to issue. All are ledger reads. */
const ALLOWED_COMMANDS = new Set([
  "server_info",
  "ledger",
  "ledger_data",
  "amm_info",
  "account_info",
]);

/** The only binding that may be imported from `xrpl`. */
const ALLOWED_XRPL_IMPORTS = new Set(["Client"]);

function tsFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Source with comments removed and the contents of '...' and "..." blanked,
 * leaving quote pairs in place so the result still parses by eye.
 *
 * Regex literals are recognised so that a quote inside one -- logger.ts has
 * /[",\r\n]/ -- does not open a phantom string and swallow the rest of the
 * line. The tell is the previous significant token: after an operator, an
 * opening bracket or a keyword like `return`, a slash begins a regex; after a
 * value it is division.
 */
function codeOnly(src: string, keepStrings = false): string {
  // Note the absence of `}`. It would be legitimate before a regex at the end
  // of a block, but it is also what precedes every `${...}/path` inside a
  // template literal, and templates are left as code -- so admitting it turns
  // ordinary URL building into a phantom regex that swallows the line.
  const REGEX_OK_PUNCT = /[(,=:[!&|?{;+\-*%~^<>]$/;
  const REGEX_OK_WORD = /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;

  let out = "";
  let i = 0;
  const n = src.length;

  const regexAllowedHere = (): boolean => {
    const tail = out.replace(/\s+$/, "");
    if (tail.length === 0) return true;
    return REGEX_OK_PUNCT.test(tail) || REGEX_OK_WORD.test(tail);
  };

  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];

    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "/" && regexAllowedHere()) {
      out += "/";
      i++;
      let inClass = false;
      while (i < n) {
        const r = src[i]!;
        if (r === "\\") { i += 2; continue; }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        else if (r === "\n") break;
        i++;
      }
      out += "/";
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      out += c;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      if (keepStrings) out += src.slice(start + 1, i);
      out += c;
      i++;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

const sources = SRC_ROOTS.flatMap(tsFiles).map((path) => ({
  path,
  raw: readFileSync(path, "utf8"),
}));

check("read-only scan found source to scan", sources.length >= 5,
  `${sources.length} files`);

// (a) imports from xrpl -----------------------------------------------------
function xrplImportViolations(path: string, raw: string): string[] {
  const out: string[] = [];

  // Strings kept: the module specifier IS a string, and blanking it makes
  // every import look like it came from "" -- which is not a loud failure, it
  // is the check quietly matching nothing at all and reporting a pass.
  const code = codeOnly(raw, true);

  // `import * as ns from "xrpl"`, `import x from "xrpl"`, `import {a,b} ...`,
  // and the type-only forms of each.
  const re = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(re)) {
    const spec = m[2]!;
    if (spec !== "xrpl" && !spec.startsWith("xrpl/")) continue;

    const clause = m[1]!.trim();
    if (clause.startsWith("*")) {
      // A namespace binding hands over the whole package while naming none of
      // it, so it is a violation regardless of what is used through it.
      out.push(`${path}: namespace import of ${spec}`);
      continue;
    }
    const names = clause
      .replace(/[{}]/g, " ")
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean);
    for (const name of names) {
      if (!ALLOWED_XRPL_IMPORTS.has(name)) {
        out.push(`${path}: imports ${name} from ${spec}`);
      }
    }
  }

  // require("xrpl") and dynamic import("xrpl") bypass the syntax above.
  if (/(?:require|import)\s*\(\s*["']xrpl/.test(code)) {
    out.push(`${path}: dynamic load of xrpl`);
  }
  return out;
}

const importViolations = sources.flatMap((s) =>
  xrplImportViolations(s.path, s.raw),
);
check("only Client is imported from xrpl", importViolations.length === 0,
  importViolations.join(" | "));

// Guard the guard. This check reads a module specifier out of a string
// literal, which is exactly the kind of thing that can start matching nothing
// and go on passing forever. Prove it still sees each shape it is meant to.
const importProbe = xrplImportViolations("probe", [
  'import { Client } from "xrpl";',
  'import { Client, Wallet } from "xrpl";',
  'import * as everything from "xrpl";',
  'import type { Transaction } from "xrpl";',
  'const x = require("xrpl");',
  'import { Something } from "xrpl/dist/npm/Wallet";',
  'import { anything } from "./local.js";',
].join("\n"));
check("import check sees every bad shape and no good one",
  importProbe.length === 5 &&
    importProbe.some((v) => v.includes("Wallet from xrpl")) &&
    importProbe.some((v) => v.includes("namespace import")) &&
    importProbe.some((v) => v.includes("Transaction")) &&
    importProbe.some((v) => v.includes("dynamic load")) &&
    importProbe.some((v) => v.includes("xrpl/dist")),
  importProbe.join(" | "));

// (b) banned identifiers in executable code ---------------------------------
const identViolations: string[] = [];
for (const { path, raw } of sources) {
  const code = codeOnly(raw);
  for (const name of BANNED) {
    // Word-boundaried and case-insensitive, which covers Wallet/wallet in one
    // pass and does NOT fire on signal, AbortSignal, assign or design.
    const re = new RegExp(`\\b${name}\\b`, "gi");
    for (const m of code.matchAll(re)) {
      const line = code.slice(0, m.index).split("\n").length;
      identViolations.push(`${path}:${line} ${m[0]}`);
    }
  }
}
check("no signing identifiers in executable code", identViolations.length === 0,
  identViolations.slice(0, 6).join(" | "));

// (c) rippled command vocabulary --------------------------------------------
const commandViolations: string[] = [];
for (const { path, raw } of sources) {
  // Strings KEPT here, unlike (b). The command name is the string -- blanking
  // it turns every legitimate call into an unreadable one and, far worse, would
  // have hidden the writer this check exists to catch. Comments are still
  // stripped, so prose describing a command is not a violation.
  const code = codeOnly(raw, true);
  for (const m of code.matchAll(/\bcommand\s*:\s*(.{0,40})/g)) {
    const lit = /^["']([a-z_]+)["']/.exec(m[1]!.trim());
    const line = code.slice(0, m.index).split("\n").length;
    if (!lit) {
      // A computed command name defeats the whole check.
      commandViolations.push(`${path}:${line} non-literal command`);
    } else if (!ALLOWED_COMMANDS.has(lit[1]!)) {
      commandViolations.push(`${path}:${line} command ${lit[1]}`);
    }
  }
}
check("every rippled command is a read-only literal", commandViolations.length === 0,
  commandViolations.join(" | "));

// Guard the guard: the allowlist must not have quietly acquired a writer.
check("command allowlist contains no write command",
  !["submit", "submit_multisigned", "sign", "sign_for"].some((c) => ALLOWED_COMMANDS.has(c)));

// (d) dynamic member access to a banned name --------------------------------
const dynViolations: string[] = [];
for (const { path, raw } of sources) {
  const re = new RegExp(`\\[\\s*["\`']\\s*(${BANNED.join("|")})\\s*["\`']\\s*\\]`, "gi");
  for (const m of raw.matchAll(re)) {
    dynViolations.push(`${path}: ${m[0]}`);
  }
}
check("no bracket access to a signing member", dynViolations.length === 0,
  dynViolations.join(" | "));

// The scanner is load-bearing for (b) and (c); a broken scanner passes them
// both by returning nothing. Prove it still finds what it is looking for.
const PROBE = [
  'const a = 1; // sign this',
  '/* submit that */',
  'const url = "https://x/submit";',
  'const re = /[",\\r\\n]/.test(v);',
  'const bad = client.submit(tx);',
].join("\n");
const probed = codeOnly(PROBE);
check("scanner ignores comments and string bodies",
  !/\bsign\b/i.test(probed) && (probed.match(/\bsubmit\b/gi) ?? []).length === 1,
  JSON.stringify(probed));
check("scanner survives a regex literal containing a quote",
  probed.includes("client.submit(tx)"), JSON.stringify(probed));

// And the string-keeping mode, which is what (c) runs on: it must still drop
// comments but must NOT drop the command name, or a writer sails through.
const kept = codeOnly(
  '// command: "submit"\nawait c.request({ command: "submit", tx_blob: b });',
  true,
);
check("string-keeping scanner drops comments, keeps command names",
  (kept.match(/command\s*:/g) ?? []).length === 1 && kept.includes('"submit"'),
  JSON.stringify(kept));
const wouldCatch = [...kept.matchAll(/\bcommand\s*:\s*(.{0,40})/g)].filter((m) => {
  const lit = /^["']([a-z_]+)["']/.exec(m[1]!.trim());
  return !lit || !ALLOWED_COMMANDS.has(lit[1]!);
});
check("command check would catch a submit call", wouldCatch.length === 1);

// ---------------------------------------------------------------------------
// 11. BASE ADAPTER, AND ITS READ-ONLY PROPERTY.
//
// Base is read over plain JSON-RPC with no Ethereum library, so the boundary is
// the same "safe by omission" argument as Stellar plus an explicit method gate
// like XRPL's command allowlist. Every check here runs offline: the transport
// is replaced with a fake wherever the venue has to be exercised.
// ---------------------------------------------------------------------------

const BASE_TS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "venues", "base.ts");
const baseRaw = readFileSync(BASE_TS, "utf8");

/**
 * Write vocabulary banned from base.ts as plain case-insensitive SUBSTRINGS,
 * comments included -- stricter than the whole-word scan in section 10.
 */
const BASE_BANNED_SUBSTRINGS = [
  "eth_sendrawtransaction",
  "eth_sendtransaction",
  "eth_sign",
  "personal_sign",
  "signtypeddata",
  "privatekey",
  "mnemonic",
  "account",
  "wallet",
  "sign",
];

/**
 * The only exemption: the exact whole-word, case-sensitive tokens `AbortSignal`
 * and `signal`, which the per-tick deadline needs (fetch's abort option is
 * spelled `signal`). They are REMOVED from the text before the substring scan,
 * rather than excused by a lookahead, so a longer name that merely starts with
 * "sign" -- signAllTransactions, signer, signature -- is still caught.
 */
function baseBannedHits(text: string): string[] {
  const scrubbed = text
    .replace(/\bAbortSignal\b/g, "")
    .replace(/\bsignal\b/g, "")
    .toLowerCase();
  return BASE_BANNED_SUBSTRINGS.filter((s) => scrubbed.includes(s));
}

const baseHits = baseBannedHits(baseRaw);
check("base.ts contains no write vocabulary, even as a substring",
  baseHits.length === 0, baseHits.join(", "));

// Negative controls: prove the scrub exempts exactly what it says.
check("scrub still catches a name that starts with signAll",
  baseBannedHits("await provider.signAllTransactions(txs)").includes("sign"));
check("scrub does not flag signal on its own",
  baseBannedHits("fetch(url, { signal: abort }); controller.signal; x: AbortSignal").length === 0);
check("scrub is case-sensitive: SIGNAL is not the exempt token",
  baseBannedHits("SIGNAL").includes("sign"));

check("the RPC allow-list is exactly eth_chainId, eth_blockNumber, eth_call",
  RPC_METHODS.length === 3 &&
    ["eth_chainId", "eth_blockNumber", "eth_call"].every((m) => RPC_METHODS.includes(m)),
  RPC_METHODS.join(","));

// Imports: node:* and project-relative paths only. A package import is how a
// signing library would arrive, and the hashing package already in
// node_modules (via xrpl) is not an exception -- selectors are hard-coded.
function nonLocalImports(src: string): string[] {
  const code = codeOnly(src, true);
  const specs = [
    ...[...code.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]!),
    ...[...code.matchAll(/\bimport\s*["']([^"']+)["']/g)].map((m) => m[1]!),
    ...[...code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]!),
  ];
  return specs.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && !s.startsWith("../"));
}
const baseImports = nonLocalImports(baseRaw);
check("base.ts imports only node:* and project-relative modules",
  baseImports.length === 0, baseImports.join(", "));
const importProbeBase = nonLocalImports([
  'import { keccak_256 } from "@noble/hashes/sha3.js";',
  'import { createPublicClient } from "viem";',
  'const e = await import("ethers");',
  'import type { Pool } from "../venue.js";',
  'import { readFileSync } from "node:fs";',
].join("\n"));
check("the import check catches packages and passes local and node: imports",
  importProbeBase.length === 3 && importProbeBase.includes("@noble/hashes/sha3.js"),
  importProbeBase.join(", "));

// Every JSON-RPC method name written as code anywhere under src/ or scripts/
// must be on the allow-list. Comments are stripped; strings are kept, because
// the method name IS a string.
const RPC_NAME = /\b(eth_\w+|personal_\w+)\b/g;
const rpcNameViolations: string[] = [];
for (const { path, raw } of sources) {
  for (const m of codeOnly(raw, true).matchAll(RPC_NAME)) {
    if (!RPC_METHODS.includes(m[1]!)) rpcNameViolations.push(`${path}: ${m[1]}`);
  }
}
check("every JSON-RPC method named in code is on the allow-list",
  rpcNameViolations.length === 0, rpcNameViolations.join(" | "));
const rpcProbe = [...codeOnly(
  '// eth_sendRawTransaction in a comment is fine\nrpc.send([{ method: "eth_sendRawTransaction", params: [] }]);',
  true,
).matchAll(RPC_NAME)].filter((m) => !RPC_METHODS.includes(m[1]!));
check("method-name check would catch eth_sendRawTransaction in code", rpcProbe.length === 1);

// No Ethereum library as a dependency.
const pkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const allDeps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
check("runtime dependencies are exactly xrpl",
  Object.keys(pkg.dependencies ?? {}).join(",") === "xrpl",
  Object.keys(pkg.dependencies ?? {}).join(","));
check("no Ethereum library in package.json",
  !allDeps.some((d) => /^(viem|ethers|web3|ox|@ethersproject\/.*|web3-.*)$/.test(d)),
  allDeps.join(","));

// The gate refuses before anything is sent -- including the good calls that
// share a request with the bad one.
let gateSent = 0;
const recording: Transport = async () => {
  gateSent++;
  return { status: 200, json: [] };
};
let gateThrew = false;
try {
  await new Rpc(recording).send(
    [{ method: "eth_blockNumber", params: [] }, { method: "eth_sendRawTransaction", params: ["0x00"] }],
    new AbortController().signal,
  );
} catch {
  gateThrew = true;
}
check("the RPC gate throws on a method off the allow-list", gateThrew);
check("and nothing at all reached the transport", gateSent === 0, `sent=${gateSent}`);

// No JSON-RPC batching: each call is one POST of a single object, in order,
// and its reply is matched by id.
const posted: unknown[] = [];
const echoing: Transport = async (body) => {
  const req = JSON.parse(body) as { id: number; method: string };
  posted.push(req);
  return { status: 200, json: { jsonrpc: "2.0", id: req.id, result: req.method } };
};
const singleReplies: RpcReply[] = await new Rpc(echoing).send(
  [{ method: "eth_chainId", params: [] }, { method: "eth_blockNumber", params: [] }],
  new AbortController().signal,
);
check("send() posts one single JSON-RPC object per call, never an array",
  posted.length === 2 && posted.every((p) => !Array.isArray(p) && typeof p === "object"),
  JSON.stringify(posted));
check("each reply is matched to its call by id, in call order",
  singleReplies.map((r) => (r.ok ? r.result : "ERR")).join(",") === "eth_chainId,eth_blockNumber",
  JSON.stringify(singleReplies));

// A reply carrying some other request's id is an error, not an answer.
const wrongId: Transport = async (body) => {
  const req = JSON.parse(body) as { id: number };
  return { status: 200, json: { jsonrpc: "2.0", id: req.id + 1000, result: "0x2105" } };
};
const [mismatched] = await new Rpc(wrongId).send(
  [{ method: "eth_chainId", params: [] }],
  new AbortController().signal,
);
check("a reply with the wrong id is an error",
  mismatched !== undefined && !mismatched.ok,
  JSON.stringify(mismatched));

// The whole tick is under a hard deadline, including a transport that never
// answers at all.
const hanging: Transport = () => new Promise(() => {});
let timeoutMessage = "";
const tStart = Date.now();
try {
  await new BaseVenue({ transport: hanging, tickTimeoutMs: 50 }).fetchPools();
} catch (e: any) {
  timeoutMessage = e?.message ?? String(e);
}
check("a hung Base tick rejects at its deadline",
  /tick exceeded 50 ms/.test(timeoutMessage) && Date.now() - tStart < 2_000,
  timeoutMessage);

// Arithmetic: constant product with a non-30 bp fee, from both directions.
const bv = new BaseVenue({ transport: hanging });
const WETH_KEY = "0x4200000000000000000000000000000000000006";
const USDC_KEY = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const bp = (feeBp: number): Pool => ({ id: "0xpool", a: WETH_KEY, b: USDC_KEY, ra: 100, rb: 300_000, feeBp });
const expected = (amt: number, rIn: number, rOut: number, fee: number) => {
  const net = amt * (1 - fee / 10_000);
  return (net * rOut) / (rIn + net);
};
check("base simulate: 5 bp fee, WETH in",
  Math.abs(bv.simulate(bp(5), WETH_KEY, 1) - expected(1, 100, 300_000, 5)) < 1e-9,
  String(bv.simulate(bp(5), WETH_KEY, 1)));
check("base simulate: 100 bp fee, USDC in",
  Math.abs(bv.simulate(bp(100), USDC_KEY, 3_000) - expected(3_000, 300_000, 100, 100)) < 1e-12,
  String(bv.simulate(bp(100), USDC_KEY, 3_000)));
check("base simulate: a lower fee gives more out",
  bv.simulate(bp(5), WETH_KEY, 1) > bv.simulate(bp(30), WETH_KEY, 1));
check("base native key is WETH and fee is BASE_FEE_NATIVE",
  bv.nativeKey === WETH_KEY && bv.feeNative === BASE_FEE_NATIVE);

// Reserve conversion at 18 (WETH) and 6 (USDC) decimals.
check("toUnits: 1e18 raw at 18 decimals is 1 WETH", toUnits(10n ** 18n, 18) === 1);
check("toUnits: 1.5 WETH", toUnits(1_500_000_000_000_000_000n, 18) === 1.5);
check("toUnits: 1,500,000 raw at 6 decimals is 1.5 USDC", toUnits(1_500_000n, 6) === 1.5);
check("toUnits: 123,456,789 raw at 6 decimals",
  Math.abs(toUnits(123_456_789n, 6) - 123.456789) < 1e-12,
  String(toUnits(123_456_789n, 6)));
check("toUnits: a large 18-decimal reserve keeps its precision",
  Math.abs(toUnits(123_456_789_123_456_789_123_456_789n, 18) - 123_456_789.123456789) < 1e-6,
  String(toUnits(123_456_789_123_456_789_123_456_789n, 18)));
check("toUnits: 0 decimals is the raw integer", toUnits(42n, 0) === 42);

// Sizing: the Base venue is searched with its own ladder.
const B = VENUE_LIMITS.base;
check("limitsFor(base) carries the base ladder",
  limitsFor("base").sizeLadder === B.sizeLadder && limitsFor("base").maxSize === B.maxTradeSize);
check("base depth floor is 10x its top rung", B.minPoolNative === 10 * B.maxTradeSize,
  `floor=${B.minPoolNative} top=${B.maxTradeSize}`);
const baseSizes = ladderProbe(bv, WETH_KEY);
check("base sizes come off the base ladder",
  baseSizes.length > 0 && baseSizes.every((s) => B.sizeLadder.includes(s)),
  baseSizes.join(","));

// ---------------------------------------------------------------------------
// 11b. MULTICALL3 AND THE eth_call BUDGET.
//
// mainnet.base.org allows roughly five eth_call per time window (FINDINGS.md
// section 6), so every contract read goes through one aggregate3 call. These
// checks pin the encoding by hand, pin the only Multicall3 function allowed,
// and count eth_calls against a fake chain so a later edit cannot quietly
// raise the budget: start() at most 3, start plus first tick at most 4, an
// unverified tick at most 4, a normal tick exactly 1.
// ---------------------------------------------------------------------------

const w = (hex: string): string => hex.padStart(64, "0");
const wa = (addr: string): string => w(addr.slice(2).toLowerCase());

// Encoding, laid out word by word by hand: WETH.decimals() (4 bytes of data)
// and UniswapV2Factory.getPair(WETH, USDC) (4 + 64 = 68 = 0x44 bytes).
const GET_PAIR_WETH_USDC = "e6a43905" + wa(WETH_KEY) + wa(USDC_KEY);
const expectedCalldata = "0x82ad56cb" + [
  w("20"), // offset of the array
  w("2"), // two sub-calls
  w("40"), // element 0 starts right after the two offset words
  w("e0"), // element 1: 0x40 + element 0's five words (0xa0)
  // element 0
  wa(WETH_KEY), w("1"), w("60"), w("4"), "313ce567".padEnd(64, "0"),
  // element 1: 0x44 bytes of data, padded to three words
  wa(UNISWAP_V2_FACTORY), w("1"), w("60"), w("44"), GET_PAIR_WETH_USDC.padEnd(192, "0"),
].join("");
const encoded = encodeAggregate3([
  { target: WETH_KEY, data: "313ce567" },
  { target: UNISWAP_V2_FACTORY, data: GET_PAIR_WETH_USDC },
]);
check("aggregate3 encoding of two sub-calls matches the hand-built hex",
  encoded === expectedCalldata, encoded);

// Decoding: one success carrying a word, one failure with empty returnData.
const RESULT_HEX = [
  w("20"), w("2"), w("40"), w("c0"),
  w("1"), w("40"), w("20"), w("12"), // entry 0: success, 32 bytes
  w("0"), w("40"), w("0"), // entry 1: failure, empty returnData
].join("");
const decoded = decodeAggregate3(RESULT_HEX, 2);
check("aggregate3 decoding: a success and a failure with empty returnData",
  decoded.length === 2 && decoded[0] === w("12") && decoded[1] === null,
  JSON.stringify(decoded));
const emptySuccess = decodeAggregate3([w("20"), w("1"), w("20"), w("1"), w("40"), w("0")].join(""), 1);
check("aggregate3 decoding: success with empty returnData is \"\", not null",
  emptySuccess.length === 1 && emptySuccess[0] === "", JSON.stringify(emptySuccess));

const throwsOn = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
check("aggregate3 decoding throws on a truncated result",
  throwsOn(() => decodeAggregate3(RESULT_HEX.slice(0, -64), 2)));
check("aggregate3 decoding throws on a success word of 2",
  throwsOn(() => decodeAggregate3(RESULT_HEX.replace(w("0") + w("40") + w("0"), w("2") + w("40") + w("0")), 2)));
check("aggregate3 decoding throws when the entry count is not the call count",
  throwsOn(() => decodeAggregate3(RESULT_HEX, 3)));

// aggregate3 is the only Multicall3 function base.ts may use. Every other
// Multicall3 selector, each computed from the prototype beside it.
const MULTICALL3_OTHER_SELECTORS = [
  "252dba42", // aggregate((address,bytes)[])
  "174dea71", // aggregate3Value((address,bool,uint256,bytes)[])
  "c3077fa9", // blockAndAggregate((address,bytes)[])
  "3e64a696", // getBasefee()
  "ee82ac5e", // getBlockHash(uint256)
  "42cbb15c", // getBlockNumber()
  "3408e470", // getChainId()
  "a8b0574e", // getCurrentBlockCoinbase()
  "72425d9d", // getCurrentBlockDifficulty()
  "86d516e8", // getCurrentBlockGasLimit()
  "0f28c97d", // getCurrentBlockTimestamp()
  "4d2301cc", // getEthBalance(address)
  "27e86d6e", // getLastBlockHash()
  "bce38bd7", // tryAggregate(bool,(address,bytes)[])
  "399542e9", // tryBlockAndAggregate(bool,(address,bytes)[])
];
const baseLower = baseRaw.toLowerCase();
const otherSelectors = MULTICALL3_OTHER_SELECTORS.filter((s) => baseLower.includes(s));
check("aggregate3 (82ad56cb) is the only Multicall3 selector in base.ts",
  baseLower.includes("82ad56cb") && otherSelectors.length === 0, otherSelectors.join(","));
const otherNames = ["aggregate3Value", "aggregate(", "tryAggregate"].filter((s) =>
  baseLower.includes(s.toLowerCase()),
);
check("base.ts never names aggregate3Value, aggregate( or tryAggregate",
  otherNames.length === 0, otherNames.join(", "));

// A fake Base chain behind a counting transport. It reads aggregate3 calldata
// with its own decoder, not base.ts's, and answers each sub-call from a table.
const CBBTC_KEY = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const AERO_KEY = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
const UNI_F = UNISWAP_V2_FACTORY.toLowerCase();
const AERO_F = AERODROME_POOL_FACTORY.toLowerCase();
const POOL_UNI = "0x" + "a1".repeat(20);
const POOL_AERO_1 = "0x" + "b1".repeat(20);
const POOL_AERO_2 = "0x" + "b2".repeat(20);
const FAKE_BLOCK = "0x100";

const FAKE_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [WETH_KEY]: { symbol: "WETH", decimals: 18 },
  [USDC_KEY]: { symbol: "USDC", decimals: 6 },
  [CBBTC_KEY]: { symbol: "cbBTC", decimals: 8 },
  [AERO_KEY]: { symbol: "AERO", decimals: 18 },
};
type FakePools = Record<string, { aero: boolean; t0: string; t1: string; r0: bigint; r1: bigint }>;
const FAKE_POOLS: FakePools = {
  [POOL_UNI]: { aero: false, t0: WETH_KEY, t1: USDC_KEY, r0: 1_000n * 10n ** 18n, r1: 3_000_000n * 10n ** 6n },
  [POOL_AERO_1]: { aero: true, t0: WETH_KEY, t1: USDC_KEY, r0: 500n * 10n ** 18n, r1: 1_500_000n * 10n ** 6n },
  [POOL_AERO_2]: { aero: true, t0: USDC_KEY, t1: AERO_KEY, r0: 1_000_000n * 10n ** 6n, r1: 2_000_000n * 10n ** 18n },
};
const FAKE_FEE_BP = 30n;

interface FakeSub {
  target: string;
  allowFailure: boolean;
  data: string;
}

function readAggregate3(data: string): FakeSub[] {
  const hex = data.slice(2);
  if (hex.slice(0, 8) !== "82ad56cb") throw new Error(`fake: selector ${hex.slice(0, 8)}`);
  const body = hex.slice(8);
  const num = (byte: number): number => Number(BigInt("0x" + body.slice(byte * 2, byte * 2 + 64)));
  const array = num(0);
  const heads = array + 32;
  const subs: FakeSub[] = [];
  for (let i = 0; i < num(array); i++) {
    const el = heads + num(heads + 32 * i);
    const dataAt = el + num(el + 64);
    subs.push({
      target: "0x" + body.slice(el * 2 + 24, el * 2 + 64),
      allowFailure: num(el + 32) === 1,
      data: body.slice((dataAt + 32) * 2, (dataAt + 32 + num(dataAt)) * 2),
    });
  }
  return subs;
}

function writeResults(results: Array<string | null>): string {
  const heads: string[] = [];
  const tails: string[] = [];
  let offset = results.length * 32;
  for (const r of results) {
    const data = r ?? "";
    const el = w(r === null ? "0" : "1") + w("40") + w((data.length / 2).toString(16)) +
      data.padEnd(Math.ceil(data.length / 64) * 64, "0");
    heads.push(w(offset.toString(16)));
    tails.push(el);
    offset += el.length / 2;
  }
  return "0x" + w("20") + w(results.length.toString(16)) + heads.join("") + tails.join("");
}

function fakeAnswer(s: FakeSub, reverts: Set<string>, pools: FakePools): string | null {
  const target = s.target.toLowerCase();
  const sel = s.data.slice(0, 8);
  const args = s.data.slice(8);
  const argAddr = (i: number): string => "0x" + args.slice(i * 64 + 24, i * 64 + 64);
  const argUint = (i: number): bigint => BigInt("0x" + args.slice(i * 64, i * 64 + 64));
  if (reverts.has(`${target}:${sel}`)) return null;

  const token = FAKE_TOKENS[target];
  if (token && sel === "95d89b41") {
    const text = Buffer.from(token.symbol, "utf8").toString("hex");
    return w("20") + w((text.length / 2).toString(16)) + text.padEnd(64, "0");
  }
  if (token && sel === "313ce567") return w(token.decimals.toString(16));

  const lookup = (aero: boolean): string => {
    const [a, b] = [argAddr(0), argAddr(1)];
    const hit = Object.entries(pools).find(([, p]) =>
      p.aero === aero && ((p.t0 === a && p.t1 === b) || (p.t0 === b && p.t1 === a)),
    );
    return wa(hit ? hit[0] : "0x" + "0".repeat(40));
  };
  if (target === UNI_F && sel === "e6a43905") return lookup(false);
  if (target === AERO_F && sel === "79bc57d5") return argUint(2) === 0n ? lookup(true) : wa("0x" + "0".repeat(40));
  if (target === AERO_F && sel === "cc56b2c5") return w(FAKE_FEE_BP.toString(16));

  const pool = pools[target];
  if (!pool) return null;
  if (sel === "0dfe1681") return wa(pool.t0);
  if (sel === "d21220a7") return wa(pool.t1);
  if (sel === "c45a0155") return wa(pool.aero ? AERO_F : UNI_F);
  if (sel === "0902f1ac") return w(pool.r0.toString(16)) + w(pool.r1.toString(16)) + w("1");
  if (pool.aero && sel === "22be3de1") return w("0");
  if (pool.aero && sel === "f140a35a") {
    const tokenIn = argAddr(1);
    const [rIn, rOut] = tokenIn === pool.t0 ? [pool.r0, pool.r1] : [pool.r1, pool.r0];
    const inNet = argUint(0) - (argUint(0) * FAKE_FEE_BP) / 10_000n;
    return w(((inNet * rOut) / (rIn + inNet)).toString(16));
  }
  return null;
}

function fakeBase(pools: FakePools = FAKE_POOLS) {
  const state = {
    counts: {} as Record<string, number>,
    calls: [] as Array<{ to: string; selector: string; tag: string; subs: FakeSub[] }>,
    rateLimited: false,
    reverts: new Set<string>(),
  };
  const transport: Transport = async (body) => {
    const req = JSON.parse(body) as { id: number; method: string; params: any[] };
    state.counts[req.method] = (state.counts[req.method] ?? 0) + 1;
    const reply = (x: object) => ({ status: 200, json: { jsonrpc: "2.0", id: req.id, ...x } });
    if (req.method === "eth_chainId") return reply({ result: "0x2105" });
    if (req.method === "eth_blockNumber") return reply({ result: FAKE_BLOCK });
    if (state.rateLimited) return reply({ error: { code: -32016, message: "over rate limit" } });
    const [{ to, data }, tag] = req.params as [{ to: string; data: string }, string];
    const subs = readAggregate3(data);
    state.calls.push({ to, selector: data.slice(2, 10), tag, subs });
    return reply({ result: writeResults(subs.map((s) => fakeAnswer(s, state.reverts, pools))) });
  };
  return { state, transport };
}

const ethCalls = (s: { counts: Record<string, number> }): number => s.counts["eth_call"] ?? 0;

// The budget, on a fake chain with one Uniswap pool and two Aerodrome pools.
const fb = fakeBase();
const fbv = new BaseVenue({ transport: fb.transport });
await fbv.start();
const startCalls = ethCalls(fb.state);
check("start() makes at most 3 eth_calls", startCalls > 0 && startCalls <= 3, `eth_call=${startCalls}`);
const firstTick = await fbv.fetchPools();
check("start() plus the first tick make at most 4 eth_calls",
  ethCalls(fb.state) <= 4, `eth_call=${ethCalls(fb.state)}`);
check("the fake chain verifies and prices all three pools",
  firstTick.length === 3 && fbv.dropped.length === 0 && !fbv.fetchNote().includes("NOT_VERIFIED"),
  `${firstTick.length} pools; ${JSON.stringify(fbv.dropped)}`);

const countsBefore = { ...fb.state.counts };
await fbv.fetchPools();
const delta = (m: string): number => (fb.state.counts[m] ?? 0) - (countsBefore[m] ?? 0);
check("a normal tick makes exactly 1 eth_call and 1 eth_blockNumber",
  delta("eth_call") === 1 && delta("eth_blockNumber") === 1 && delta("eth_chainId") === 0,
  `eth_call=${delta("eth_call")} eth_blockNumber=${delta("eth_blockNumber")}`);
check("every eth_call is aggregate3 on MULTICALL3, pinned to the block just read",
  fb.state.calls.every((c) =>
    c.to.toLowerCase() === MULTICALL3.toLowerCase() && c.selector === "82ad56cb" && c.tag === FAKE_BLOCK),
  JSON.stringify(fb.state.calls.map((c) => [c.to, c.selector, c.tag])));
check("every sub-call is sent with allowFailure = true",
  fb.state.calls.every((c) => c.subs.length > 0 && c.subs.every((s) => s.allowFailure)));

// A tick that has to verify first (start() failed) stays inside the allowance too.
const fu = fakeBase();
const unverifiedTick = await new BaseVenue({ transport: fu.transport }).fetchPools();
check("an unverified tick makes at most 4 eth_calls",
  ethCalls(fu.state) <= 4 && unverifiedTick.length === 3,
  `eth_call=${ethCalls(fu.state)} pools=${unverifiedTick.length}`);

// success = false is a revert: that token is dropped and named, and the pool
// lookups that rode in the same call for it are discarded, not tracked.
const fr = fakeBase();
fr.state.reverts.add(`${AERO_KEY}:95d89b41`);
const frv = new BaseVenue({ transport: fr.transport });
await frv.start();
const frPools = await frv.fetchPools();
check("a reverted symbol() drops that token by name",
  frv.dropped.some((d) => d.what.startsWith("token AERO")), JSON.stringify(frv.dropped));
check("and no pool involving the dropped token is tracked",
  frPools.length === 2 && frPools.every((p) => p.a !== AERO_KEY && p.b !== AERO_KEY),
  frPools.map((p) => p.id).join(","));

// A reverted read during a tick loses that pool for the tick only.
fb.state.reverts.add(`${POOL_UNI}:0902f1ac`);
const revertedTick = await fbv.fetchPools();
check("a reverted getReserves() in a tick is counted and its pool left out",
  revertedTick.length === 2 && fbv.lastRead.errors === 1 && fbv.fetchNote().includes("call_errors=1"),
  fbv.fetchNote());
fb.state.reverts.clear();

// An error on the eth_call itself, "over rate limit" included, fails the whole
// verification or tick, and the next tick verifies again.
const fl = fakeBase();
fl.state.rateLimited = true;
const flv = new BaseVenue({ transport: fl.transport });
let startError = "";
try {
  await flv.start();
} catch (e: any) {
  startError = e?.message ?? String(e);
}
check("a rate-limited start() rejects and leaves the venue unverified",
  /over rate limit/.test(startError) && flv.fetchNote().includes("NOT_VERIFIED"), startError);
let tickError = "";
fb.state.rateLimited = true;
try {
  await fbv.fetchPools();
} catch (e: any) {
  tickError = e?.message ?? String(e);
}
fb.state.rateLimited = false;
check("a rate-limited tick rejects as a whole rather than returning a partial tick",
  /over rate limit/.test(tickError), tickError);
fl.state.rateLimited = false;
const recovered = await flv.fetchPools();
check("the next tick after a rate-limited start() verifies and prices",
  recovered.length === 3 && !flv.fetchNote().includes("NOT_VERIFIED"), flv.fetchNote());

// ---------------------------------------------------------------------------
// 11c. THE QUOTE CHECK'S RESOLUTION THRESHOLD.
//
// Derived from the tolerance, never hard-coded: see BASE_QUOTE_MIN_RAW. The
// boundary is exercised end to end, through start() on the fake chain.
// ---------------------------------------------------------------------------

check("quoteMinRaw: 0.01% tolerance gives 40,000 raw units", quoteMinRaw(0.0001) === 40_000,
  String(quoteMinRaw(0.0001)));
check("quoteMinRaw: doubling the tolerance halves the threshold", quoteMinRaw(0.0002) === 20_000,
  String(quoteMinRaw(0.0002)));
check("BASE_QUOTE_MIN_RAW is derived from BASE_QUOTE_TOLERANCE",
  BASE_QUOTE_MIN_RAW === quoteMinRaw(BASE_QUOTE_TOLERANCE) && BASE_QUOTE_MIN_RAW === 40_000,
  String(BASE_QUOTE_MIN_RAW));

// An Aerodrome WETH/cbBTC pool whose probe quote is EXACTLY `target` raw cbBTC
// units, with 1,000 WETH on the input side. The smallest reserveB giving
// floor(net * rB / (rA + net)) >= target gives exactly target, because
// net < rA + net.
const POOL_EDGE = "0x" + "c1".repeat(20);
function edgePools(target: bigint): FakePools {
  const rA = 1_000n * 10n ** 18n;
  const amountIn = rA / BigInt(BASE_QUOTE_PROBE_DIVISOR);
  const net = amountIn - (amountIn * FAKE_FEE_BP) / 10_000n;
  const denom = rA + net;
  const rB = (BigInt(target) * denom + net - 1n) / net;
  return { ...FAKE_POOLS, [POOL_EDGE]: { aero: true, t0: WETH_KEY, t1: CBBTC_KEY, r0: rA, r1: rB } };
}
async function edgeRun(pools: FakePools): Promise<{ pools: Pool[]; dropped: string[] }> {
  const venue = new BaseVenue({ transport: fakeBase(pools).transport });
  await venue.start();
  const priced = await venue.fetchPools();
  return { pools: priced, dropped: venue.dropped.map((d) => `${d.what}: ${d.why}`) };
}

const atMin = await edgeRun(edgePools(BigInt(BASE_QUOTE_MIN_RAW)));
check("a probe quote of exactly the threshold is accepted and priced",
  atMin.pools.some((p) => p.id === POOL_EDGE) && atMin.dropped.length === 0,
  atMin.dropped.join(" | "));
const belowMin = await edgeRun(edgePools(BigInt(BASE_QUOTE_MIN_RAW) - 1n));
check("a probe quote one raw unit below the threshold is dropped as unresolvable",
  !belowMin.pools.some((p) => p.id === POOL_EDGE) &&
    belowMin.dropped.length === 1 &&
    belowMin.dropped[0]!.includes(POOL_EDGE) &&
    belowMin.dropped[0]!.includes("quote of 39999 raw units cannot resolve"),
  belowMin.dropped.join(" | "));

// The input side: a USDC/cbBTC pool with 40 USDC in reserve probes 40,000 raw
// units, 39,880 after the 30 bp fee, below the threshold.
const thinIn = await edgeRun({
  ...FAKE_POOLS,
  [POOL_EDGE]: { aero: true, t0: USDC_KEY, t1: CBBTC_KEY, r0: 40_000_000n, r1: 10n ** 8n },
});
check("a probe input below the threshold after fee is dropped before quoting",
  !thinIn.pools.some((p) => p.id === POOL_EDGE) &&
    thinIn.dropped.length === 1 &&
    thinIn.dropped[0]!.includes("probe of 39880 raw units after fee cannot resolve"),
  thinIn.dropped.join(" | "));

console.log(fail === 0 ? "\nall checks passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
