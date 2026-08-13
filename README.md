# multi-pulse

A read-only AMM observer for two mainnets: Stellar and XRPL.

It walks live automated market maker pools on both chains, prices a ladder of trade
sizes against exact constant product maths, and records any round trip that would clear
a net profit threshold after an assumed fee. It records them. It does not take them.

Results from an actual 28-hour run are in [FINDINGS.md](FINDINGS.md).

## What it deliberately does not do

This is the important part, so it goes first, and it is worth stating precisely because
the honest answer differs between the two venues.

**multi-pulse does not sign transactions and does not send them.** No code path in this
repository builds, signs, or submits anything to either chain.

**On Stellar the guarantee is structural.** `@stellar/stellar-sdk` is not a dependency.
It is not in `package.json` and it is not on disk, so `Keypair`, `TransactionBuilder`
and `Server.submitTransaction` are not in the Stellar adapter's reach at all. Stellar
pools are read over plain HTTP GETs against Horizon.

**On XRPL the guarantee is narrower, and the difference matters.** `xrpl` is a real
dependency, because it is how this program talks to rippled at all, and that package
ships `Wallet`, `sign`, `autofill` and `submitAndWait` in the same module as `Client`.
So the signing primitives *are* installed. The claim here is not that they are absent.
The claim is that nothing imports them and nothing calls them:

- `Client` is the only binding imported from `xrpl` anywhere under `src/`. Response
  shapes are declared locally rather than imported, so no transaction type is ever
  pulled into scope.
- The only rippled commands issued at runtime are `server_info`, `ledger` and
  `amm_info`. The offline scripts additionally use `ledger_data` and `account_info`.
  All five are ledger reads. `submit` is a rippled command name reachable through the
  same `Client.request()` this code does use, so the command literals are constrained
  as tightly as the imports.

**The venue interface has no execution surface.** A `Venue` exposes exactly `name`,
`nativeKey`, `feeNative`, `fetchPools()`, `simulate()` and `assetLabel()`. There is no
`execute`, no `submit`, no account, and no key material anywhere in the shape. Adding
the capability would mean editing `src/venue.ts` first, which is a visible change to a
file whose whole purpose is to deny it.

**No credentials are read.** There is no `.env`, no `dotenv`, and no `process.env` read
anywhere in the repository. Configuration is plain checked-in constants in
`src/config.ts`, so every row of output can be traced to a specific commit.

An opportunity in the output is an observation about what the ledger showed at a moment
in time. It is not an order, and nothing downstream acts on it. Profit figures are
estimates against an assumed flat fee, not fills.

## Verifying that yourself

Do not take the section above on trust. The boundary is enforced by the test suite
rather than by comment, and `npm run check` fails the build if it is ever broken:

```bash
npm run check
```

Among its assertions, by name:

```
PASS  only Client is imported from xrpl
PASS  import check sees every bad shape and no good one
PASS  no signing identifiers in executable code
PASS  every rippled command is a read-only literal
PASS  command allowlist contains no write command
PASS  no bracket access to a signing member
PASS  command check would catch a submit call
```

Those checks parse the source text of every file under `src/` and `scripts/`, strip
comments and string bodies so prose cannot satisfy or trip them, and verify their own
detectors against deliberately bad samples so a scanner that silently stops matching
cannot go on passing.

If you want a quick look without running anything, both of these return no output
against this tree:

```bash
# No call site for any signing or submitting API.
grep -rnE '\.(sign|autofill|submitAndWait|submitTransaction)\s*\(' src/

# No import from xrpl other than Client.
grep -rnE 'from "xrpl"' src/ | grep -v 'import { Client } from "xrpl";'
```

A plain search for words like `sign` or `submit` will *not* come back clean, and that is
expected rather than alarming: the source discusses the boundary at length in comments.
The two commands above and the test suite look at executable code only, which is the
distinction that matters.

## What it watches

**Stellar mainnet**, via `https://horizon.stellar.org`. Every liquidity pool the endpoint
will page out, walked to exhaustion each tick across 12 concurrent id shards. Pool ids
are fixed-width hex, so the id space is cut into contiguous slices up front and each
slice walked on its own cursor chain. This is not sampling and not a cache: the slices
tile the whole space and each runs to its own exhaustion, so the result is the same
complete pool set a serial walk produces.

**XRPL mainnet**, via `wss://s2.ripple.com`. XRPL has no "list every AMM" call, so
discovery runs backwards: 40 checked-in seed tokens generate candidate pairs, and each
pair is probed with `amm_info` to find out whether a live AMM exists. Discovery is
rationed to 150 probes per tick so the first sweep does not run for minutes, and a
"no AMM for this pair" answer is cached for 30 minutes rather than forever, so a pool
created after startup does not stay invisible.

> On the word "seeds": `scripts/seeds.ts` and `scripts/verify-seeds.ts` build and verify
> the list of **seed tokens** used for XRPL pair discovery. They have nothing to do with
> wallet seed phrases. This repository holds no keys.

The XRPL adapter can only see pools reachable from that seed list. A pool between two
tokens that are not both on it is not merely mispriced, it is invisible, and so is every
cycle with a leg in it. Read a quiet XRPL tick as "quiet among these tokens", never as
"quiet".

## How detection works

Two route shapes, both cycles that start and end in the venue's native asset:

- **Direct**, native to X and back, across two different pools quoting that pair at
  different prices.
- **Triangular**, native to X to Y to native, across three distinct pools.

Each candidate is priced at every rung of an eleven-rung size ladder, with the pool fee
applied per hop. Two floors apply and both are net rather than gross, because the network
fee is flat: break-even in gross terms is `10000 * fee / size` bps, which is very
different at the bottom and top of the ladder. A rung must clear both an absolute minimum
net profit and a minimum net basis point margin. The surviving rung with the largest
absolute net profit wins, not the best percentage, since on a constant product curve the
percentage edge shrinks monotonically with size.

Two filters keep this tractable and honest:

- **Depth floor.** Pools whose native-side reserve falls below `minPoolNative` are
  dropped before the graph is built, so a shallow pool cannot serve as a middle leg
  either. A pool with no native side returns null rather than zero and is kept, because
  "cannot be measured on this axis" is not the same as "no depth".
- **Cycle rate bound.** An exact upper bound on a cycle's rate in the limit of an
  infinitesimal trade, taken as the product of each hop's fee-adjusted reserve ratio. If
  it does not exceed 1, no rung can profit. This is a lossless prune, not a heuristic:
  the result set is identical with it and without it.

Routes are keyed on the issuer-qualified asset path and nothing else. Stellar mainnet
hosts many assets sharing a code, including deliberate copies of well known stablecoins
pointed at another issuer, so a key built from codes alone would merge a real route and
a counterfeit one into a single row.

### A known gap, stated plainly

A triangular cycle's middle leg is token-to-token, has no native side, and is **not**
depth-checked by anything in this repository. The outer legs are. A per-pool native floor
was tried on the middle leg and reverted: it cut Stellar's searchable graph from 29,485
pools to 153 and both venues went silent. The correct fix is a per-route, per-rung
slippage check inside the sizing function, and it is not implemented. Until it is, treat
a triangular route's chosen `size` as the honest signal of how much it could carry, and
read a triangle clearing only at the bottom of the ladder as evidence of a thin leg
rather than a rich opportunity.

## Running it

```bash
npm install
npm run monitor        # continuous read loop across both venues
npm run seeds          # rebuild the XRPL seed token list from a ledger walk
npm run verify-seeds   # check the committed seed list against the ledger
npm run check          # test suite, including the read-only assertions above
npm run typecheck      # tsc --noEmit
```

The only runtime dependency is `xrpl`. The project is ESM and runs through `tsx`.

## Configuration

All of it lives in `src/config.ts` as checked-in constants, each with its reasoning
recorded alongside it. The values that shape the output most:

| Setting | Stellar | XRPL |
| --- | --- | --- |
| Endpoint | `https://horizon.stellar.org` | `wss://s2.ripple.com` |
| Size ladder, 11 rungs | 1 to 1,000 XLM | 0.1 to 100 XRP |
| `minPoolNative`, depth floor | 10,000 XLM | 1,000 XRP |
| `minNetProfit`, absolute floor | 0.01 XLM | 0.001 XRP |
| `minProfitBps`, net, shared | 20 | 20 |
| Assumed flat round-trip fee | 0.001 XLM | 0.0001 XRP |
| Request timeout | 15,000 ms | 15,000 ms |

`POLL_MS` is 60,000 and bounds every venue's sampling interval. Ladders and floors are
split per venue because a size is meaningless without the asset it is denominated in;
`minProfitBps` is shared because a basis point is a ratio.

One caveat carries into how the output should be read: the ladders assume a 10:1 XLM to
XRP ratio, measured at 6.27:1 on 11 August 2026 and deliberately not retuned mid-run, so
Stellar probes roughly 1.6x deeper in dollar terms and the dollar figures in the comments
are stale by the same factor.

## Output

Observations are appended to `data/opportunities.csv`, which is gitignored. Columns:

```
timestamp, venue, kind, route_key, route_label, size, output,
gross_bps, fee_native, net_profit, first_seen, last_seen, tick_interval_ms
```

`kind` is one of `direct`, `triangular`, `heartbeat` or `error`. A heartbeat is written
every tick whether or not anything was found, so a quiet market and a stalled process are
distinguishable from the CSV alone; without it the two produce byte-identical files. An
`error` row is a heartbeat whose tick failed, kept separate because a gap caused by an
endpoint returning 503 is not evidence about the market.

## Findings

[FINDINGS.md](FINDINGS.md) reports what the two venues actually offered on 11 and 12
August 2026, counted from the collected CSVs rather than estimated. Short version: across
28 hours, roughly 39,000 Stellar pools and 71 XRPL AMMs produced 23 opportunity rows that
collapse to six repricing events, worth about $1.41 in total estimated net, none
surviving a single 60-second tick.

It also documents five measurement defects found by running the thing rather than reading
it, each of which produced confident output while wrong: silently dropped four-letter
currency codes, a truncated ledger scan formatted like a complete one, a test suite that
deleted the production CSV, two differently-configured monitors writing to one file, and
a 61-second tick that quantised every persistence figure to one minute. That section is
the part most likely to be useful elsewhere.

## Status

Observation and measurement only. Every absolute number this produces is an estimate
against an assumed fee, nothing here has been executed, and no figure in this repository
is a realised profit. Read the boundary section above before assuming otherwise.

## License

ISC. See [LICENSE](LICENSE).
