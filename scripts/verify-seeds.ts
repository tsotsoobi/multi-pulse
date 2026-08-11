import { Client } from "xrpl";

import {
  XRPL_PROBE_CONCURRENCY,
  XRPL_SEED_TOKENS,
  XRPL_TIMEOUT_MS,
  XRPL_WS_URL,
  type SeedToken,
} from "../src/config.js";
import { classifySeeds, decodeCurrency, parseAmount } from "../src/venues/xrpl.js";

/**
 * Check every entry in XRPL_SEED_TOKENS against the live ledger.
 *
 * WHY THIS EXISTS SEPARATELY FROM seeds.ts. seeds.ts GENERATES a list from
 * AMMs that demonstrably exist, so anything it prints is verified at the moment
 * it was printed. This script CHECKS a list that is already committed --
 * including entries somebody added by hand afterwards, which is exactly where
 * the failure this repo keeps warning about gets in.
 *
 * WHAT "VERIFIED" MEANS HERE, IN TWO SEPARATE QUESTIONS. They are separate
 * because they fail for different reasons and one is fatal while the other is
 * not:
 *
 *   1. DOES THE ISSUER ACCOUNT EXIST? (account_info) A mistyped or invented
 *      r-address is fatal and undetectable at runtime. The monitor does not
 *      error on it -- amm_info answers "no AMM", the pair is filed as absent,
 *      and the heartbeat reports a healthy probe count for a token nobody is
 *      watching. An address that fails here must not be in the list at all.
 *
 *   2. DOES THE TOKEN HAVE AN XRP AMM, AND HOW DEEP? (amm_info) A real issuer
 *      with no AMM today is not an error -- an AMM can be created tomorrow and
 *      the monitor's negative cache expires so it would be found -- but it is
 *      dead weight in a candidate set that is quadratic in the list length, and
 *      it contributes nothing to the venue's coverage right now.
 *
 * Question 1 is the one the user cannot answer by reading the output of the
 * monitor, which is the whole reason it is asked here instead.
 *
 * A token can also be reachable only through token-to-token pools, with no XRP
 * pool at all. That shows as "no XRP AMM" below and is not a failure; it just
 * cannot be ranked, since XRP-side depth is the only depth measure comparable
 * across tokens without a price feed, and this repo has no price feed.
 *
 * READ-ONLY, under the same rules as src/: `Client` is the only import from
 * `xrpl` and the only commands issued are `account_info` and `amm_info`, both
 * pure ledger reads. test/check.ts scans this directory alongside src/.
 *
 *   npm run verify-seeds
 *   npm run verify-seeds -- wss://s2.ripple.com   (which node to ask)
 *
 * The endpoint argument is an argv argument, not an environment variable, for
 * the reason config.ts gives at length. It exists because a public cluster can
 * IP rate-limit you off it, and being unable to reach ONE node is not evidence
 * about the seed list.
 */

interface AccountInfoReply {
  result?: { account_data?: { Account?: unknown } };
}

interface AmmInfoReply {
  result?: { amm?: { amount?: unknown; amount2?: unknown } };
}

type Verdict =
  | { kind: "malformed"; why: string }
  | { kind: "no-account" }
  | { kind: "no-amm" }
  | { kind: "amm"; xrpDepth: number }
  | { kind: "unknown"; why: string };

async function request<T>(
  client: Client,
  req: Record<string, unknown>,
): Promise<T> {
  return (await client.request(req as never)) as T;
}

function label(t: SeedToken): string {
  return `${decodeCurrency(t.currency)} / ${t.issuer}`;
}

/**
 * Shape check, borrowed from the venue rather than reimplemented.
 *
 * It has to be the SAME predicate the monitor uses, not an equivalent one: the
 * failure being checked for is "the monitor silently ignores this entry", so a
 * second copy that drifted would report a clean list while the venue quietly
 * dropped seeds from it. classifySeeds is the one place that decides.
 */
function malformed(t: SeedToken): string | null {
  return classifySeeds([t]).dropped[0]?.why ?? null;
}

async function verify(client: Client, t: SeedToken): Promise<Verdict> {
  const bad = malformed(t);
  if (bad) return { kind: "malformed", why: bad };

  // 1. The account. Pinned to the validated ledger so a reply cannot come from
  //    a not-yet-validated state.
  try {
    const reply = await request<AccountInfoReply>(client, {
      command: "account_info",
      account: t.issuer,
      ledger_index: "validated",
    });
    if (typeof reply?.result?.account_data?.Account !== "string") {
      return { kind: "no-account" };
    }
  } catch (e: any) {
    const code = e?.data?.error;
    if (code === "actNotFound") return { kind: "no-account" };
    // Anything else is a failure to ASK, not an answer. Reporting it as an
    // absent account would be the same lie this script exists to catch, in the
    // opposite direction.
    return { kind: "unknown", why: code ?? e?.message ?? String(e) };
  }

  // 2. The XRP pool, if any.
  try {
    const reply = await request<AmmInfoReply>(client, {
      command: "amm_info",
      asset: { currency: "XRP" },
      asset2: { currency: t.currency, issuer: t.issuer },
      ledger_index: "validated",
    });
    const amm = reply?.result?.amm;
    if (!amm) return { kind: "no-amm" };
    const x = parseAmount(amm.amount as never);
    const y = parseAmount(amm.amount2 as never);
    const xrpSide = x?.key === "XRP" ? x : y?.key === "XRP" ? y : null;
    return xrpSide
      ? { kind: "amm", xrpDepth: xrpSide.units }
      : { kind: "unknown", why: "AMM has no XRP side" };
  } catch (e: any) {
    const code = e?.data?.error;
    if (code === "actNotFound" || code === "ammNotFound" || code === "objectNotFound") {
      return { kind: "no-amm" };
    }
    return { kind: "unknown", why: code ?? e?.message ?? String(e) };
  }
}

async function main(): Promise<void> {
  const seeds = XRPL_SEED_TOKENS;
  const endpoint = process.argv[2] ?? XRPL_WS_URL;
  console.log(`verifying ${seeds.length} seed tokens against ${endpoint}\n`);

  const client = new Client(endpoint, {
    timeout: XRPL_TIMEOUT_MS,
    connectionTimeout: XRPL_TIMEOUT_MS,
  });
  await client.connect();

  const verdicts = new Array<Verdict>(seeds.length);
  try {
    await mapLimit(seeds, XRPL_PROBE_CONCURRENCY, async (t, i) => {
      verdicts[i] = await verify(client, t);
    });
  } finally {
    await client.disconnect();
  }

  let ok = 0;
  let dead = 0;
  let poolless = 0;
  let unresolved = 0;

  for (let i = 0; i < seeds.length; i++) {
    const t = seeds[i]!;
    const v = verdicts[i]!;
    switch (v.kind) {
      case "amm":
        ok++;
        console.log(
          `  OK        ${label(t)}  ${Math.round(v.xrpDepth).toLocaleString("en-US")} XRP`,
        );
        break;
      case "no-amm":
        poolless++;
        console.log(`  NO POOL   ${label(t)}  issuer exists, no XRP AMM`);
        break;
      case "no-account":
        dead++;
        console.log(`  FAIL      ${label(t)}  issuer does not exist on the ledger`);
        break;
      case "malformed":
        dead++;
        console.log(`  FAIL      ${label(t)}  ${v.why}`);
        break;
      case "unknown":
        unresolved++;
        console.log(`  ???       ${label(t)}  could not check: ${v.why}`);
        break;
    }
  }

  console.log(
    `\n${seeds.length} seeds: ${ok} with an XRP AMM, ${poolless} issuer-only,` +
      ` ${dead} invalid, ${unresolved} unresolved`,
  );

  // Invalid entries are the only fatal class. An issuer with no pool is honest
  // dead weight; an issuer that does not exist is a hole in the coverage that
  // the monitor will never report.
  if (dead > 0) {
    console.log(`\n${dead} entr${dead === 1 ? "y" : "ies"} must be removed`);
    process.exit(1);
  }
  if (unresolved > 0) {
    console.log(`\n${unresolved} could not be checked; rerun before trusting the list`);
    process.exit(1);
  }
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  };
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, worker));
}

main().catch((e) => {
  console.error("verify-seeds failed:", e?.message ?? e);
  process.exit(1);
});
