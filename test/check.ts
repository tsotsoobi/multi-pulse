import { findOpportunities } from "../src/arb.js";
import { StreakTracker, logHeartbeat, logOpportunity, LOG_PATH } from "../src/logger.js";
import { StellarVenue } from "../src/venues/stellar.js";
import type { Pool } from "../src/venue.js";
import { readFileSync, rmSync } from "node:fs";

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
check("size came off the ladder", [1,5,10,25,50,100,160,250,400,650,1000].includes(top.size), `size=${top.size}`);

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
rmSync(LOG_PATH, { force: true });
logOpportunity(top, s1, t0);
logHeartbeat("stellar", "pools=2 routes=1", t0);
logHeartbeat("stellar", "error: Horizon 503", t0, "error");
const csv = readFileSync(LOG_PATH, "utf8").trim().split("\n");
check("header matches spec",
  csv[0] === "timestamp,venue,kind,route_key,route_label,size,output,gross_bps,fee_native,net_profit,first_seen,last_seen",
  csv[0]);
check("opportunity row has 12 fields", (csv[1]!.match(/,/g) ?? []).length === 11, csv[1]);
check("heartbeat row present", csv[2]!.includes(",heartbeat,,"), csv[2]);
check("error row present", csv[3]!.includes(",error,,"), csv[3]);
rmSync(LOG_PATH, { force: true });

console.log(fail === 0 ? "\nall checks passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
