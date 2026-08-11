import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { Client } from "xrpl";

import {
  XRPL_PROBE_CONCURRENCY,
  XRPL_WS_URL,
} from "../src/config.js";
import { decodeCurrency, parseAmount } from "../src/venues/xrpl.js";

/**
 * Print a seed token list for XRPL_SEED_TOKENS, built from the ledger.
 *
 * WHY THIS EXISTS. The monitor's XRPL coverage is exactly its seed list, and a
 * wrong issuer address in that list is the one error the design cannot report:
 * amm_info answers "no AMM", the pair is filed as absent, and the heartbeat
 * prints a healthy probe count for a token nobody is watching. Typing r-addresses
 * from memory produces precisely that failure. So the list is generated from
 * AMMs that demonstrably exist instead.
 *
 * WHY THE MONITOR DOES NOT DO THIS ITSELF. This walks every AMM object in the
 * ledger with ledger_data. That is thousands of pages, it is rejected outright
 * by some public clusters, and it takes minutes -- fine for a thing you run by
 * hand every few months, impossible inside a 2000 ms tick. Hence the seeded
 * design at runtime and the heavy scan here.
 *
 * READ-ONLY, under the same rules as src/. `Client` is the only import from
 * `xrpl`, the only commands issued are `ledger_data` and `amm_info`, and
 * test/check.ts scans this directory alongside src/.
 *
 *   npm run seeds
 *   npm run seeds -- 40                        (tokens to print; default 35)
 *   npm run seeds -- 40 wss://s1.ripple.com    (which node to walk)
 *
 * THE ENDPOINT ARGUMENT IS NOT A CONFIG KNOB, and it is deliberately an argv
 * argument rather than anything resembling an environment variable -- config.ts
 * explains at length why nothing in this repo reads process.env. It exists
 * because this walk is heavy enough to get an IP rate-limited off a public
 * cluster mid-scan, which is not a hypothetical: a run of this script died at
 * page 6307 with "Connection (public) IP limit reached" after some forty
 * minutes of walking. When that happens the only way forward is a different
 * node. XRPL_WS_URL remains the default and remains what the MONITOR uses; this
 * argument moves one offline scan, not the thing that produces the CSV.
 */

const DEFAULT_LIMIT = 35;

/**
 * Hard stop on ledger_data pages, so a stuck marker cannot loop forever.
 *
 * This has to be far larger than it looks like it needs to be. rippled applies
 * `limit` to the objects it SCANS, not to the ones the `type` filter lets
 * through, so a walk for AMMs pages through the entire ledger -- millions of
 * trust lines and offers -- to find a few thousand AMMs. The first run of this
 * script capped out at 4000 pages having seen maybe three quarters of mainnet,
 * and truncation here is not a smaller answer but a wrong one: the tokens in
 * the unscanned tail are missing from the ranking entirely, so the list reads
 * as "the deepest AMMs" when it is only "the deepest AMMs in the part we
 * reached". 20000 pages at 2000 objects admits 40M objects, well above mainnet;
 * if this cap is ever hit the WARNING below is the only honest reading.
 */
const MAX_PAGES = 20_000;

/** Objects per ledger_data page. */
const PAGE_LIMIT = 2000;

/**
 * Per-request timeout for this script, overriding XRPL_TIMEOUT_MS.
 *
 * The monitor's 15s is right for the monitor: an amm_info that has not answered
 * in 15 seconds has missed its 2-second tick many times over and the tick is
 * better off without it. A ledger_data page is a different request -- it scans
 * two thousand ledger objects on a shared public cluster -- and 15s is inside
 * the range where a healthy node simply takes a while. A run that dies on one
 * slow page discards the whole walk up to that point.
 */
const SCAN_TIMEOUT_MS = 60_000;

/**
 * Attempts per ledger_data page, and the backoff between them.
 *
 * A walk of this length WILL hit a transient timeout or a throttle -- the first
 * attempt at this script died on one, thousands of pages in. Retrying matters
 * here more than it would elsewhere because the marker is a position in a
 * pinned ledger: there is no way to resume a failed walk later, so a page that
 * cannot be re-asked costs the rest of the scan.
 *
 * 8 attempts with linear backoff is about 84 seconds of tolerance. That figure
 * is not arbitrary: a 5-attempt/20-second budget was not enough to ride out a
 * DNS blip on s1.ripple.com, which ended a walk at page 174. Skipping a page is
 * never an option -- it would drop whatever AMMs were in it and leave a ranking
 * that looks complete -- so the choice is only between waiting longer and
 * stopping early with the truncation clearly reported.
 */
const RETRIES = 8;
const RETRY_BASE_MS = 3000;

/**
 * Where the walk checkpoints the AMMs it has found, one JSON object per line.
 *
 * WHY THE WALK WRITES TO DISK AT ALL. Everything above is about surviving a
 * failure the script can SEE. It cannot see being killed: a SIGKILL from an
 * impatient operator, a session teardown, or an OOM runs no catch block and no
 * finally, and every AMM found so far lives only in an array in memory. That
 * has now cost several complete walks, one of them 2813 pages and 1116 AMMs
 * deep. Appending each page's findings means the expensive half of this script
 * -- forty minutes of paging -- is never lost twice for the same reason.
 *
 * Under data/, which is gitignored: this is a scratch artefact of one run, not
 * a source file, and it is superseded by the entries pasted into config.ts.
 */
const CHECKPOINT_PATH = "data/amm-scan.jsonl";

interface LedgerDataReply {
  result?: { state?: unknown[]; marker?: unknown; ledger_index?: unknown };
}

interface AmmInfoReply {
  result?: { amm?: { amount?: unknown; amount2?: unknown } };
}

type WireCurrency = { currency?: unknown; issuer?: unknown };

async function request<T>(
  client: Client,
  req: Record<string, unknown>,
): Promise<T> {
  return (await client.request(req as never)) as T;
}

/**
 * One request, retried on transient failure with linear backoff.
 *
 * Used for the ledger_data walk only. The pricing loop below deliberately does
 * NOT retry: a pool that will not answer is left out of the ranking, which is
 * the honest outcome for a single token, whereas a page that will not answer
 * ends the walk.
 */
async function requestWithRetry<T>(
  client: Client,
  req: Record<string, unknown>,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await request<T>(client, req);
    } catch (e) {
      last = e;
      if (attempt === RETRIES) break;
      const waitMs = RETRY_BASE_MS * attempt;
      process.stderr.write(
        `\nledger_data attempt ${attempt}/${RETRIES} failed` +
          ` (${(e as any)?.message ?? e}); retrying in ${waitMs}ms\n`,
      );
      await sleep(waitMs);
      // A dropped socket is the common cause; reconnect before trying again.
      if (!client.isConnected()) await client.connect();
    }
  }
  throw last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One issued asset, keyed exactly as the ledger encodes it. */
function assetKey(a: WireCurrency): string | null {
  if (typeof a?.currency !== "string" || a.currency.length === 0) return null;
  if (a.currency === "XRP") return "XRP";
  if (typeof a.issuer !== "string" || a.issuer.length === 0) return null;
  return `${a.currency}:${a.issuer}`;
}

/** One AMM as the checkpoint file stores it. */
interface ScannedAmm {
  account: string;
  a: string;
  b: string;
}

/** Append this page's AMMs to the checkpoint, so a kill cannot erase them. */
function checkpoint(rows: ScannedAmm[]): void {
  if (rows.length === 0) return;
  appendFileSync(
    CHECKPOINT_PATH,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
}

/** Read back a checkpoint, skipping any half-written trailing line. */
function readCheckpoint(): { ledgerIndex: number; amms: ScannedAmm[] } {
  const lines = readFileSync(CHECKPOINT_PATH, "utf8").split("\n");
  let ledgerIndex = 0;
  const amms: ScannedAmm[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: any;
    // A kill can land mid-write, so the last line may be truncated JSON. That
    // is expected, not an error: drop it and keep everything before it.
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row?.ledgerIndex === "number") ledgerIndex = row.ledgerIndex;
    else if (typeof row?.account === "string") amms.push(row as ScannedAmm);
  }
  return { ledgerIndex, amms };
}

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
  const endpoint = process.argv[3] ?? XRPL_WS_URL;

  // Price a checkpoint left behind by a walk that was killed. The walk is the
  // expensive half; this is what makes losing the process cost minutes rather
  // than the whole scan.
  const priceOnly = process.argv.includes("--price-only");

  const client = new Client(endpoint, {
    timeout: SCAN_TIMEOUT_MS,
    connectionTimeout: SCAN_TIMEOUT_MS,
  });
  await client.connect();

  try {
    if (priceOnly) {
      const saved = readCheckpoint();
      process.stderr.write(
        `pricing ${saved.amms.length} AMMs from ${CHECKPOINT_PATH}` +
          ` (ledger ${saved.ledgerIndex}); walk NOT re-run\n`,
      );
      await priceAndPrint(client, saved.amms, saved.ledgerIndex, limit, endpoint, {
        pages: 0,
        incomplete: true,
        walkError: "not walked in this run; priced from an earlier checkpoint",
        cappedOut: false,
      });
      return;
    }

    process.stderr.write(`walking ${endpoint}\n`);
    mkdirSync(dirname(CHECKPOINT_PATH), { recursive: true });
    // A fresh walk is a fresh ledger, and mixing two ledgers' AMMs would smear
    // the snapshot the whole script exists to take.
    rmSync(CHECKPOINT_PATH, { force: true });

    // --- 1. Every AMM object in the validated ledger -----------------------
    //
    // Pinned to one ledger index so the walk is a single state rather than a
    // smear across however many ledgers close while it runs. A marker taken
    // from one ledger is not valid against another.
    const first = await requestWithRetry<LedgerDataReply>(client, {
      command: "ledger_data",
      ledger_index: "validated",
      type: "amm",
      binary: false,
      limit: PAGE_LIMIT,
    });

    const ledgerIndex = Number(first?.result?.ledger_index);
    if (!Number.isInteger(ledgerIndex) || ledgerIndex <= 0) {
      throw new Error("ledger_data did not report a ledger index");
    }
    // First line of the checkpoint records which ledger it is a snapshot of.
    appendFileSync(CHECKPOINT_PATH, JSON.stringify({ ledgerIndex }) + "\n", "utf8");

    const amms: ScannedAmm[] = [];
    let marker: unknown = undefined;
    let page = first;
    let pages = 0;
    /** Set when the walk ends early because a page could not be fetched. */
    let walkError: string | null = null;

    while (true) {
      pages++;
      const state = Array.isArray(page?.result?.state) ? page.result.state : [];
      const found: ScannedAmm[] = [];

      for (const raw of state) {
        const o = raw as {
          LedgerEntryType?: unknown;
          Account?: unknown;
          Asset?: WireCurrency;
          Asset2?: WireCurrency;
        };
        // The `type` filter is honoured by current rippled, but re-checking
        // costs nothing and a node that ignores it would otherwise hand back
        // the entire ledger as AMMs.
        if (o?.LedgerEntryType !== "AMM") continue;
        if (typeof o.Account !== "string") continue;
        const a = assetKey(o.Asset ?? {});
        const b = assetKey(o.Asset2 ?? {});
        if (!a || !b) continue;
        found.push({ account: o.Account, a, b });
      }

      amms.push(...found);
      checkpoint(found);

      marker = page?.result?.marker;
      process.stderr.write(
        `\rledger ${ledgerIndex}: page ${pages}, ${amms.length} AMMs`,
      );
      if (marker === undefined || marker === null || pages >= MAX_PAGES) break;

      // A walk that dies mid-way must not throw away what it already has.
      //
      // This is the second lesson this script has taught, after the page cap.
      // A full mainnet walk is roughly 6500 pages and forty minutes, and it
      // ends by being IP rate-limited off a public cluster as often as it ends
      // by finishing -- at which point retrying is useless, because the ban is
      // the answer. Throwing here discarded six thousand pages of successful
      // work twice. So the walk stops, says exactly where it stopped, and the
      // AMMs already in hand still get priced and ranked.
      //
      // The result is then a TRUNCATED ranking, which is a different and weaker
      // claim than a complete one: every token it prints is real and its depth
      // is measured, but "the deepest 40" becomes "the deepest 40 of the
      // portion walked". The WARNING below is what keeps those two apart, and
      // it is why this is a degradation and not a fallback.
      try {
        page = await requestWithRetry<LedgerDataReply>(client, {
          command: "ledger_data",
          ledger_index: ledgerIndex,
          type: "amm",
          binary: false,
          limit: PAGE_LIMIT,
          marker,
        });
      } catch (e: any) {
        walkError = e?.message ?? String(e);
        break;
      }
    }
    process.stderr.write("\n");

    const cappedOut = pages >= MAX_PAGES && !!marker;
    const incomplete = cappedOut || walkError !== null;

    if (cappedOut) {
      process.stderr.write(
        `WARNING: stopped at the ${MAX_PAGES}-page cap; the scan is incomplete\n`,
      );
    }
    if (walkError) {
      process.stderr.write(
        `WARNING: the walk failed at page ${pages}: ${walkError}\n` +
          `WARNING: ranking the ${amms.length} AMMs found so far; it is a` +
          ` PARTIAL view of the ledger, not the deepest pools on it\n`,
      );
    }

    await priceAndPrint(client, amms, ledgerIndex, limit, endpoint, {
      pages,
      incomplete,
      walkError,
      cappedOut,
    });
  } finally {
    await client.disconnect();
  }
}

/** What the walk managed, carried into the output so the reader can judge it. */
interface WalkStatus {
  pages: number;
  incomplete: boolean;
  walkError: string | null;
  cappedOut: boolean;
}

/**
 * Price every XRP-quoting AMM, rank by depth, and print entries for config.ts.
 *
 * Separate from the walk so that a checkpoint left by a killed run can be
 * priced without repeating forty minutes of paging -- see CHECKPOINT_PATH.
 */
async function priceAndPrint(
  client: Client,
  amms: ScannedAmm[],
  ledgerIndex: number,
  limit: number,
  endpoint: string,
  status: WalkStatus,
): Promise<void> {
  {
    // --- 2. Rank tokens by the XRP depth behind them -----------------------
    //
    // "Liquid" here means one specific thing: how much XRP sits in that token's
    // XRP pool. It is the only depth measure that is comparable across tokens
    // without a price feed, and this repo has no price feed and should not grow
    // one. Token-to-token pools are counted for presence but cannot be ranked.
    const xrpPools = amms.filter((p) => p.a === "XRP" || p.b === "XRP");
    process.stderr.write(`${xrpPools.length} of them quote XRP; pricing...\n`);

    // The walk is what kills the socket, and pricing is what needs it next.
    // Without this, a walk that ended on a dropped connection prices exactly
    // nothing and the degradation above buys nothing at all -- which is what
    // happened on the run that ended "70 AMMs seen ... only 0 tokens priced".
    if (!client.isConnected()) {
      process.stderr.write("reconnecting before pricing...\n");
      try {
        await client.connect();
      } catch (e: any) {
        process.stderr.write(
          `WARNING: could not reconnect to price: ${e?.message ?? e}\n`,
        );
      }
    }

    const depths = new Map<string, number>();
    let done = 0;

    await mapLimit(xrpPools, XRPL_PROBE_CONCURRENCY, async (p) => {
      const token = p.a === "XRP" ? p.b : p.a;
      const [currency, issuer] = splitKey(token);
      if (!currency || !issuer) return;

      try {
        const reply = await request<AmmInfoReply>(client, {
          command: "amm_info",
          ledger_index: ledgerIndex,
          asset: { currency: "XRP" },
          asset2: { currency, issuer },
        });
        const x = parseAmount(reply?.result?.amm?.amount as never);
        const y = parseAmount(reply?.result?.amm?.amount2 as never);
        const xrpSide = x?.key === "XRP" ? x : y?.key === "XRP" ? y : null;
        if (xrpSide) {
          depths.set(token, Math.max(depths.get(token) ?? 0, xrpSide.units));
        }
      } catch {
        // A pool that will not price is a pool we cannot rank. Leaving it out
        // is the honest outcome; guessing a depth would put it in the list on
        // the strength of a number nobody measured.
      } finally {
        done++;
        if (done % 25 === 0) {
          process.stderr.write(`\rpriced ${done}/${xrpPools.length}`);
        }
      }
    });
    process.stderr.write(`\rpriced ${done}/${xrpPools.length}\n\n`);

    // --- 3. Emit ------------------------------------------------------------
    const ranked = [...depths.entries()]
      .sort((p, q) => q[1] - p[1])
      .slice(0, limit);

    // The header is part of the output because the list gets pasted into
    // config.ts and then read months later by someone deciding whether to trust
    // it. "Which ledger, which node, and did the walk finish" are exactly the
    // questions they will have, and a complete walk and a truncated one produce
    // lists that look identical without this.
    console.log(`// Generated by scripts/seeds.ts against ledger ${ledgerIndex}.`);
    console.log(`// Node: ${endpoint}`);
    console.log(
      `// Walk: ${status.pages} pages, ${status.incomplete ? "INCOMPLETE" : "complete"}` +
        `${status.walkError ? ` (failed: ${status.walkError})` : ""}` +
        `${status.cappedOut ? " (hit the page cap)" : ""}.`,
    );
    console.log(`// ${amms.length} AMMs seen, ${xrpPools.length} quoting XRP.`);
    console.log(`// Depth shown is the XRP side of that token's XRP pool.`);
    if (status.incomplete) {
      console.log(
        `// WARNING: these are the deepest tokens IN THE PORTION WALKED, not on`,
      );
      console.log(`// the ledger. Every entry is real; the ranking is partial.`);
    }
    for (const [token, depth] of ranked) {
      const [currency, issuer] = splitKey(token);
      const label = decodeCurrency(currency!);
      const note = label === currency ? label : `${label} (hex-encoded)`;
      console.log(
        `  {\n` +
          `    currency: "${currency}",\n` +
          `    issuer: "${issuer}",\n` +
          `    note: "${note} -- ${Math.round(depth).toLocaleString("en-US")} XRP",\n` +
          `  },`,
      );
    }

    if (ranked.length < limit) {
      process.stderr.write(
        `\nonly ${ranked.length} tokens priced; asked for ${limit}\n`,
      );
    }
  }
}

function splitKey(key: string): [string | null, string | null] {
  const sep = key.indexOf(":");
  if (sep < 0) return [null, null];
  return [key.slice(0, sep), key.slice(sep + 1)];
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  };
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, worker));
}

main().catch((e) => {
  console.error("seeds failed:", e?.message ?? e);
  process.exit(1);
});
