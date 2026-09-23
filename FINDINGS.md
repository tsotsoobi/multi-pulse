# FINDINGS

What two mainnet AMM venues actually offered, 11 and 12 August 2026. A read-only
measurement study of live automated market maker pools on Stellar and XRPL. Not a
backtest; nothing was executed.

Every count is taken from the rotated CSVs in `data/`; nothing is estimated. Figures
from elsewhere (commit messages, issuer lookups) are marked. `data/opportunities.csv`
was read at `2026-08-12T21:19:37Z` while still collecting, so its totals are a cut.

## 1. What was measured

Two venues, polled read-only in one sequential loop. No executor, no signer, no keys, no
submit endpoint. Every net figure is an estimate against an assumed fee.

**Stellar mainnet, `https://horizon.stellar.org`.** Every pool the endpoint will page
out, walked to exhaustion each tick over 12 concurrent id shards, 206 pages. A 12 August
tick returned 39,820 to 39,825 records, dropped 420 to 422 emptied pools (both reserves
zero), leaving 39,400 to 39,405 quotable.

**XRPL mainnet, `wss://s2.ripple.com`.** No "list every AMM" call exists, so discovery is
inverted: 40 verified seed tokens generate 820 candidate pairs, each asked about with
`amm_info`. 71 pairs have a live AMM, 749 are absent.

| | Stellar | XRPL |
|---|---|---|
| `minPoolNative` (depth floor) | 10,000 XLM | 1,000 XRP |
| `minNetProfit` (absolute floor) | 0.01 XLM | 0.001 XRP |
| `minProfitBps` (net, shared) | 20 | 20 |
| size ladder, 11 rungs | 1 to 1,000 XLM | 0.1 to 100 XRP |
| assumed flat round-trip fee | 0.001 XLM | 0.0001 XRP |
| poll interval | 60,000 ms | 60,000 ms |

Both floors must clear, and the depth floor drops pools before cycle enumeration, so a
shallow pool cannot be a middle leg either. Per tick on 12 August, Stellar searched
29,491 to 29,495 and dropped 9,908 to 9,911; XRPL searched 59 of 71, dropped 12.

The ladders assume 10:1 XLM/XRP. Measured on 11 August it was 6.27:1, so Stellar probed
about 1.6x deeper in dollar terms throughout and the floors were about $1,606 and
$1,007, not the $3,000 each their comments claim. Not retuned mid-run.

## 2. Results per venue

Thresholds changed several times on 11 August, so rows from different configs are not
comparable and the rotated files mark where the changes happened. A to F are
development, G and H are collection.

| Run | File | Window (UTC) | Config |
|---|---|---|---|
| A | `...-mixed-config.csv` | 11 Aug 07:42:57 to 08:21:16 | **No depth floor.** Serial walk, 201 pages, poll 2,000 ms. Also carries a second process, see 4.4 |
| B | `...-0930-pre-middleleg.csv` | 11 Aug 09:22:15 to 09:22:17 | Floor on, serial walk. One tick each venue |
| C | `...-0930-middleleg-trial.csv` | 11 Aug 09:28:26 to 09:51:20 | **Middle-leg depth filter trial.** Graph fell to 153 pools |
| D | `...-1000-serial-walk.csv` | 11 Aug 09:53:00 to 10:50:37 | Floor on, serial walk, median tick 61,380 ms |
| E | `...-1051-rate-limited.csv` | 11 Aug 10:51:49 to 11:02:32 | Sharded walk, poll still 2,000 ms. Rate limited off Horizon |
| F | `...-1107-xrpl-offline.csv` | 11 Aug 11:07:38 to 11:12:37 | XRPL endpoint refusing, Stellar healthy |
| G | `...-run2.csv` | 11 Aug 11:13:41 to 22:15:05 | **Final config.** 12 shards, poll 60,000 ms |
| H | `opportunities.csv` | 12 Aug 04:22:43 to 21:19:06 | As G, plus transport retry (`30d9a8a`) |

`...-1113-first-6h.csv` (837 rows) and `...-eod.csv` (969) are earlier snapshots of run G
(989) and strict subsets of it, so they are not counted separately.

| Run | Venue | Ticks | Successful | Errors | Opportunity rows |
|---|---|---|---|---|---|
| A | stellar | 58 | 40 | 18 (31.0%) | **168** |
| A | xrpl | 12 | 12 | 0 | 0 |
| C | stellar | 21 | 21 | 0 | 0 |
| C | xrpl | 21 | 21 | 0 | 0 |
| D | stellar | 55 | 54 | 1 (1.8%) | **1** |
| D | xrpl | 55 | 55 | 0 | 0 |
| E | stellar | 163 | 28 | 135 (82.8%) | 0 |
| E | xrpl | 163 | 137 | 26 (16.0%) | 0 |
| G | stellar | 483 | 420 | 63 (13.0%) | **22** |
| G | xrpl | 483 | 456 | 27 (5.6%) | **1** |
| H | stellar | 705 | 634 | 71 (10.1%) | **0** |
| H | xrpl | 705 | 676 | 29 (4.1%) | **0** |

Run A's 40 successful Stellar ticks are two concurrent processes: 28 unfiltered, 12 on
the depth-floor build (4.4). B and F are too short to carry a rate.

**Stellar, run G** (11.02 h): 22 rows on 19 route keys, from **5 of 420 successful
ticks** (1.19%). Sizes cleared 1, 5, 10, 25, 50, 250 XLM; each row is the best rung for
that route in that tick, and five of the 22 peaked at 1 XLM, eight at 5 XLM or below.
Net per row 0.0106316 to 7.7483149 XLM, summing to 8.8018641 XLM, about $1.41 at the
measured $0.16062. Gross 22.98 to 309.97 bps. **No persistence:** every row has
`first_seen == last_seen`, at a measured resolution of 60,007 ms.

**XRPL, runs G and H** (28 h combined): one opportunity in total.

```
2026-08-11T15:58:10.206Z  triangular  XRP > BTC(rchG..MYcL) > USDC(rcEG..FZwu) > XRP
size 0.5 XRP   output 0.5012789   gross 25.58 bps   fee 0.0001   net 0.0011789 XRP
first_seen == last_seen: one tick.
```

About $0.0012 at the measured $1.00711, clearing the 20 bps floor by 5.58 bps and the
absolute floor by 18%. The other 1,131 successful XRPL ticks all reported `routes=0`.

## 3. Findings worth keeping

### 3.1 One pool repricing looks like eight opportunities

At `2026-08-11T11:28:41.570Z` the Stellar heartbeat read `routes=8 streaks=8` and eight
rows landed in the same millisecond:

```
250 XLM  XLM > yUSDC(GDGT..TTFF) > AQUA(GBNZ..AQUA) > XLM   309.97 bps  net 7.7483149
 50 XLM  XLM > USDC(GA5Z..KZVN)  > yUSDC(GDGT..TTFF) > XLM   28.49 bps  net 0.1414495
 10 XLM  XLM > yETH(GDYQ..RQFD)  > yUSDC(GDGT..TTFF) > XLM   54.01 bps  net 0.0530145
 10 XLM  XLM > GOLD(GBC5..GOLD)  > yUSDC(GDGT..TTFF) > XLM   39.59 bps  net 0.0385936
 10 XLM  XLM > SLVR(GBZV..SLVR)  > yUSDC(GDGT..TTFF) > XLM   33.81 bps  net 0.0328107
 10 XLM  XLM > GQX(GD7T..DAQF)   > yUSDC(GDGT..TTFF) > XLM   28.75 bps  net 0.0277522
  5 XLM  XLM > XAU(GBCB..LXAU)   > yUSDC(GDGT..TTFF) > XLM   34.29 bps  net 0.0161472
  5 XLM  XLM > SSLX(GBHF..37UR)  > yUSDC(GDGT..TTFF) > XLM   25.21 bps  net 0.0116067
```

Decomposed into pool legs the eight touch nine distinct native-side pools and share
exactly one, `native + yUSDC:GDGT...TTFF`. One pool moved off its cross rate and the
search found it again through every counterparty it could reach. Over all five Stellar
opportunity ticks in run G:

| Tick | Rows | Pool shared by every row |
|---|---|---|
| 11:28:41 | 8 | `native + yUSDC:GDGT..TTFF` |
| 15:07:06 | 3 | `SCOP:GC6O..H3VQ + native` |
| 15:36:08 | 2 | `SCOP:GC6O..H3VQ + native` |
| 16:13:32 | 1 | `RIO + native`, `AFR + RIO`, `AFR + native` |
| 16:34:29 | 8 | `SCOP:GC6O..H3VQ + native` |

**22 rows reduce to 5 repricing events, and 21 of the 22 pivot on just two pools.**
Counting rows, or reading `routes=8` off the heartbeat, overstates activity by roughly
four times on exactly the ticks that look most exciting. Nothing in the CSV counts pivot
pools per tick, which is the figure that would not mislead.

### 3.2 What persisted, before the depth floor, was worthless

Run A carried no depth floor. Its unfiltered process logged six routes, only ever those
six, on every one of its 28 ticks:

| Route | Size | Net (XLM) over 28 ticks | Gross | Moved at all? |
|---|---|---|---|---|
| XLM > AQUA(GBNZ..AQUA) > **AXLM**(GCIA..NVPS) > XLM | 10 | 7.1617816 to 7.1625252 | 7,163 bps | by 0.0007 XLM |
| XLM > SGB(GAME..HN6B) > **AXLM**(GCIA..NVPS) > XLM | 5 | 2.4843173 to 2.4937217 | 4,989 bps | by 0.009 XLM |
| XLM > SGB(GAME..HN6B) > LIBRE(GAYC..F5CY) > XLM | 5 | 1.4810802 to 1.4955536 | 2,993 bps | by 0.014 XLM |
| XLM > yXLM(GARD..5T55) > **AXLM**(GCIA..NVPS) > XLM | 1 | 0.4924701 | 4,935 bps | **no, bit for bit** |
| XLM > **AXRP**(GCIA..NVPS) > **AXLM**(GCIA..NVPS) > XLM | 1 | 0.4902202 | 4,912 bps | **no, bit for bit** |
| XLM > **yUSDC**(GCIA..NVPS) > **AXLM**(GCIA..NVPS) > XLM | 1 | 0.2167861 | 2,178 bps | **no, bit for bit** |

Five of the six run through assets issued by one account, shown truncated as
`GCIA..NVPS` in the table above, and all five share the same middle asset, `AXLM`.

Three of the six produced byte-identical net profit on 28 consecutive ticks spanning 39
minutes: the pools did not move at all. Per `cae3bab` and `MIN_POOL_NATIVE_NOTE` in
`src/config.ts`, every route flagged while unfiltered ran through pools holding under
60 XLM, on a venue whose deepest XLM pool held 13.2m XLM. A 4,900 bps edge nobody takes
for 39 minutes is a price nobody is quoting against: they persist because nobody wants
them, not because nobody noticed.

They were also the only thing that persisted. All six carry `first_seen` of
`2026-08-11T06:29:35.092Z` and were still logged at `08:21:16.453Z`: at least
1 h 51 m 41 s of continuous presence in the surviving rows. The eight-hour figure for the
full unfiltered window is recorded in `cae3bab`; rows covering its earlier part were
deleted by the test suite (4.3). Under the final config, no route in 28 hours survived a
single tick.

Ticker collision is live: `yUSDC:GCIA..NVPS` here and `yUSDC:GDGT..TTFF` in 3.1 are
different assets printing the same four characters, distinguishable only because routes
are keyed on `CODE:ISSUER`.

### 3.3 The depth floor is not over-filtering

It removes about 25% of Stellar pools (9,910 of 39,400) and 12 of 71 XRPL AMMs.

**It removed exactly the dust, at the same minute, on identical inputs.** Between
`08:02:48` and `08:15:53` on 11 August two monitors on different configs were both
appending to what is now `mixed-config.csv` (4.4), heartbeats interleaving minute by
minute. The unfiltered process reported `pools=39388 routes=6` on every one of its 28
ticks; the depth-floor process reported `pools=39388 searched=29481 shallow=9907
routes=0` on every one of its 12. Same pool set, same minutes: six routes without the
floor, zero with it, and the six are the sub-60-XLM routes above.

**Genuine routes still come through.** With the floor on, runs D and G logged 24
opportunity rows on 21 distinct routes, through USDC (the 13.2m XLM pool), AQUA, SHX,
SCOP, XAU, GOLD, yETH and yUSDC.

**Over-filtering looks nothing like this.** Run C extended the depth check to triangular
middle legs with a per-pool filter. Stellar's searchable graph fell from 29,485 pools to
**153** (`shallow_native=9910 shallow_token=7441 unpriced=21891`), XRPL fell from 59 to
28, and both venues reported `routes=0` for all 21 ticks. Reverted in `077f538`.

The middle-leg gap it was trying to close is still open and still binding: eight of run
G's 22 rows peaked at 5 XLM or below on a ladder reaching 1,000, though every outer leg
held at least 10,000 XLM by construction. Treat every small-size row here as unvetted on
its middle leg.

### 3.4 12 August: nothing at all

At `21:07:08`, sixteen and three quarter hours in, the run had logged **1,287 successful
ticks and zero opportunities on either venue.** Continuing to the snapshot cut at
`21:19:06`: 1,310 successful ticks (634 Stellar, 676 XRPL), still zero. Not one row
cleared 20 net bps plus the absolute floor, on either chain, at any of the eleven sizes.
Same code as run G, same thresholds, same endpoints; the only change is `30d9a8a`, which
loses fewer ticks, not more.

## 4. Measurement defects found and fixed

Each was found by running the thing, not by reading it, and each produced confident
output while wrong. All five are fixed.

**4.1 Four-letter currency codes were silently discarded.** XRPL codes are 3-character
ASCII or 40-character hex and nothing between. `USDC`, `SOLO` and `CORE` were committed
as four-letter ASCII and dropped with no error, no skipped count and no log line, while
the heartbeat reported a healthy probe count. Ranked by measured XRP depth, the original
thirteen hand-written seeds top out at RLUSD (1,972,336 XRP), Bitstamp BTC (107,082),
USDC (47,291), SOLO (37,337), CSC (30,350), CORE (13,210): **three of the six deepest
were invisible**, about 98,000 XRP of depth. A discovery adapter that does not report
what it discarded has an unfalsifiable coverage number.

**4.2 A truncated ledger scan produced a confident but wrong ranking.** The seed list
came from a walk that stopped at a 4,000-page cap with the marker still advancing, having
seen 1,247 AMMs of which 952 quoted XRP (`PROVENANCE` block, `src/config.ts`). It printed
a ranking anyway, formatted exactly like a complete one. **RLUSD was absent from it** at
1,972,336 XRP, deepest on the venue by nine times over the runner-up, and reached the
seed list only because it was already in the hand-written thirteen. The retained
checkpoint `data/amm-scan.jsonl` (later walk, ledger 106216783, 814 AMM objects of which
637 quote XRP) likewise holds XRP AMMs for two RLUSD lookalike issuers and none for the
genuine `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`. The cap is now 20,000 pages and a truncated
walk is labelled partial. A partial scan formatted like a complete one is worse than one
that fails, because it gets believed.

**4.3 The test suite deleted the production CSV.** `test/check.ts` asserted the CSV
format against `LOG_PATH` and `rmSync`'d it, so `npm run check` against a live monitor
deleted that run's rows; the monitor only appends, so it rebuilt the file with a fresh
header on its next tick and the result looked healthy. It destroyed four route rows from
a live run. This is why run A's rows begin at `07:42:57` while their `first_seen` reads
`06:29:35`: the streak tracker held the true first observation in memory and the rows
proving it had gone from disk.

**4.4 Two monitors on different configs wrote to one file.** Between `08:02:48` and
`08:15:53` on 11 August, one process on the pre-floor build and one on the depth-floor
build were both appending to `data/opportunities.csv`. The rows interleave minute by
minute and the file contradicts itself: `routes=6` and `routes=0` alternating over the
same `pools=39388`. It was detectable only because the two builds emit different
heartbeat fields, the older lacking `searched=` and `shallow=`; had the config change not
altered the heartbeat shape, the file would have been silently mixed and unreadable. A
CSV needs to carry the config that produced each row, or process identity at minimum.
This one still does not.

**4.5 Stellar tick was 61 seconds, so persistence was measured at one-minute
resolution.** A tick took 58 to 88 seconds (median 61,380 ms in run D, 77,539 ms in run
A), of which 99.93% was network wait: 60,687 ms in `fetch` against 43 ms of parsing and
searching combined. A streak of N ticks spanned N times about 70 seconds, so any edge
lasting under a minute was invisible and every persistence figure from before the change
is quantised to that. Worse, a serial walk assembled triangular cycles from legs read up
to 61 seconds apart, against a search that requires one instant. Splitting the id range
into 12 concurrent shards took 60,730 ms to 7,030 ms, verified at 39,397 pools, 39,397
unique ids, zero duplicates, `records - skipped == pools`, no truncation. The 12 August
median is 8,202 ms.

That fix caused its own regression: sharding cut wall time, not request count, so the
poll loop repeated about nine times as often.

```
serial    201 requests per ~70s interval   ~2.9 req/s   ~10,300/hour   no 429
sharded   206 requests per  ~8s interval   ~26  req/s   ~92,700/hour   82.8% of ticks 429ing
```

That 82.8% is run E measured: 135 of 163 Stellar ticks failed with HTTP 429 in eleven
minutes. `POLL_MS` had been 2,000 from the start and never bound anything, because a
61-second tick always overran it; parallelising made it the governor for the first time,
and it is now 60,000. The measurement consequence is the point: an unobserved interval is
evidence of nothing, so at an 82.8% error rate no streak can exceed a tick or two, and
measured persistence was capped by the rate limiter rather than by the market, in a CSV
that looked healthy.

## 5. Error profile

Runs G and H are the comparable long runs: same config, 11.02 and 16.94 hours, 966 and
1,410 venue-ticks.

| Cause | 11 Aug (G) | share | 12 Aug (H) | share |
|---|---|---|---|---|
| request timeout (Horizon and rippled) | 35 | 3.6% | 61 | 4.3% |
| `fetch failed` / `terminated` (local) | 30 | 3.1% | 18 | 1.3% |
| `getaddrinfo ENOTFOUND` (local DNS) | 18 | 1.9% | 17 | 1.2% |
| WebSocket closed before established | 7 | 0.7% | 4 | 0.3% |
| HTTP 429 | 0 | 0 | 0 | 0 |
| **total** | **90** | **9.3%** | **100** | **7.1%** |

By venue: Stellar 63 of 483 (13.0%) then 71 of 705 (10.1%); XRPL 27 of 483 (5.6%) then
29 of 705 (4.1%).

**Timeouts rose while local failures fell.** Endpoint-side timeouts went from 3.6% to
4.3% of ticks while failures attributable to this machine's own network (`fetch failed`,
`ENOTFOUND`, WebSocket setup) fell from 5.7% to 2.8%. The total fell, so the composition
shifted: 39% of errors were timeouts on 11 August, 61% on 12 August. Zero 429s in 2,376
venue-ticks.

**Blindness, two numbers, and the smaller one misleads.** By tick, **7.1%** on 12 August
(100 of 1,410). By wall clock, **38.2% on Stellar and 33.8% on XRPL**: summing every gap
between successful ticks longer than three minutes, the run was unobserved for 6.47 of
its 16.94 hours on Stellar. Two outages dominate, 194.7 minutes from `16:17:13` and
81.0 minutes from `13:56:41`, both single hung requests rather than crash loops: the
first closed with a Stellar error reading `tick_ms=4262995`, one `fetch` that hung for
71 minutes. 11 August was comparable at 37.1% and 32.5%, with a 99.3-minute outage from
`17:53:35`.

Why this does not explain the zero:

1. Coverage scales an expected count, it does not zero it. On 11 August 5 of 420
   successful Stellar ticks carried routes, a rate of 1.19%; at that rate 12 August's 634
   successful Stellar ticks would be expected to carry about seven or eight.
2. The instrument was not quieter on 12 August. 11 August lost 13.0% of Stellar ticks and
   37.1% of wall clock and still produced 23 rows across six ticks; 12 August lost fewer
   ticks (10.1%) and a comparable share of wall clock (38.2%, concentrated in two hangs
   rather than spread thinly) and produced none.
3. XRPL needs no blindness argument: 676 successful ticks at 4.1% loss, against 456 at
   5.6% the day before, and one opportunity across both.

What blindness does bound is persistence: this run cannot see an edge that opened and
closed inside one of those gaps. The claim that survives is about the 1,310 sampled
instants, not the continuous interval.

## 6. 18 September 2026: Base added to the shared loop

A third venue, Base mainnet (chain id 8453), was added and enabled in `ENABLED_VENUES`
alongside Stellar and XRPL. It is read over plain JSON-RPC (`eth_chainId`,
`eth_blockNumber`, `eth_call` only) with no Ethereum library, and watches Uniswap V2
pairs and Aerodrome volatile pools among four seed tokens. Nothing in sections 1 to 5
includes Base; no Base data had been collected when this entry was written.

What changes for the existing venues, and what does not:

- **Their code, constants and limits are unchanged.** Stellar and XRPL are searched with
  exactly the ladders, floors and fees in section 1.
- **They now share the loop with Base.** Venues are polled one after another in a single
  loop, so every iteration now includes Base's fetch. `tick_interval_ms` stays at about
  `POLL_MS` (60,000 ms) unless Stellar, XRPL and Base together take longer than that.
  Tick durations were last measured in the two-venue run of 11 August 2026
  (`data/monitor.log`, `tick_ms` field; `data/` is gitignored, so the log is not
  committed): Stellar median 9.3 s, range 7.1 to 32.4 s; XRPL median 4.1 s, typically
  3.6 to 4.2 s after warm-up, with warm-up ticks up to 11.6 s and two mid-run ticks of
  96 s and 146 s that logged probe errors. Base's tick is hard-capped at 15,000 ms
  (`BASE_TICK_TIMEOUT_MS`). At the medians the three fit inside `POLL_MS`; the XRPL
  maximum alone already exceeded it before Base was added, so an occasional long
  `tick_interval_ms` is not by itself evidence against Base. No run with all three
  venues has been timed yet; `tick_interval_ms` and `tick_ms` will show it.
- **Startup can take up to 15 s longer**, because Base's `start()` verifies its chain id,
  tokens and pools before the loop begins, under the same 15-second deadline.

**`net_profit` is in each venue's own native asset:** XLM on `stellar` rows, XRP on
`xrpl` rows, ETH on `base` rows. The same is true of `size`, `output` and `fee_native`.
These columns must not be summed or compared across venues without first converting them
at a stated rate. A CSV that now mixes three units in one column is easy to misread.

The Base ladder (0.01 to 0.5 ETH), floors and the 0.00005 ETH fee assumption are
provisional, sized independently of the XLM/XRP dollar symmetry in section 1, and are to
be tuned from collected data. The Uniswap V2 and Aerodrome factory addresses and the
cbBTC and AERO token addresses were entered unverified; the adapter checks them on-chain
at startup and drops, by name, anything that does not match.

### 6.1 The public Base endpoint rate-limits eth_call; every read now goes through Multicall3

**The first live run never verified.** Every tick failed at the 6th `eth_call` of
start-up verification (cbBTC `decimals()`), so no Base pool was ever priced.

**Measured 18 September 2026 against `https://mainnet.base.org`:**

- A batch of 10 `eth_chainId` calls: all 10 succeed.
- A batch of 10 `eth_blockNumber` calls: all 10 succeed.
- A batch of 10 `eth_call` (WETH `decimals()`): calls 1 to 5 succeed, 6 to 10 return
  "over rate limit".
- Batch A of 5 `eth_call` succeeds; batch B of 5, seconds later, fails entirely; batch C,
  after a further 2+ seconds, also fails entirely. The allowance came back after about
  60 s idle.

Conclusion: roughly 5 `eth_call` per time window, the window being somewhere between
several seconds and 60 s. `eth_chainId` and `eth_blockNumber` are not counted against it.
A monitor running in parallel shared the allowance during these tests, so the window
length is approximate.

**The fix: one `eth_call` per tick.** Every contract read is now wrapped in a single call
to Multicall3 `aggregate3((address,bool,bytes)[])` at
`0xcA11bde05977b3631167028862bE2a173976CA11` (`MULTICALL3` in `src/config.ts`), with
`allowFailure` set for every sub-call and the call pinned to the tick's block, as before.
No other Multicall3 function is used. The calldata is encoded and the result decoded by
hand in `src/venues/base.ts`, and the RPC allow-list is unchanged.

| | `eth_call`s | not counted |
|---|---|---|
| normal tick | exactly 1 | 1 `eth_blockNumber` |
| `start()` | at most 3 | 1 `eth_chainId`, 1 `eth_blockNumber` |
| `start()` plus first tick | at most 4 | |
| tick that must verify first | at most 4 | |

`start()` makes three calls: tokens together with every factory lookup, then pool checks
together with Aerodrome reserves and fees, then Aerodrome quote checks. `test/check.ts`
asserts all four figures against a counting fake transport.

**What a failure means now:**

- **A reverted sub-call** (`success = false`) is treated as a revert was before: that
  token or pool is dropped and named at start-up, or left out of the tick and counted in
  `call_errors`.
- **An error on the `eth_call` itself**, "over rate limit" included, is transient. It fails
  the whole verification or tick, which is retried next time. This is a change for ticks:
  a failed read used to cost only its own pool, and now a refused `eth_call` fails the
  tick.
- **The `rpc=` heartbeat field is gone** along with JSON-RPC batching. No request ever
  carries more than one call now, so batching had nothing left to do.

**The margin is thin.** `start()` plus the first tick is 4 `eth_call`s against a measured
allowance of about 5. Anything else on the same IP spending that allowance can still
cause a refusal. The result is a retried tick, never a wrong price.

### 6.2 First verified run: three Aerodrome pools dropped by a quote threshold set too high

**The first verified live run (18 September 2026)** reported tokens 4/4, uni=5, aero=3,
absent=1, dropped=3, with Base `tick_ms` from 716 to 3265. The counts add up: 6 token
pairs in 2 factories is 12 lookups, which found 5 Uniswap V2 pairs and 6 Aerodrome pools,
with 1 absent. Three of the Aerodrome pools were dropped by the start-up quote check:

```
aerodrome WETH/cbBTC 0x2578365b3dfa7ffe60108e181efb79feddec2319: quote of 56314 raw units cannot resolve 0.01%
aerodrome USDC/cbBTC 0x9c38b55f9a9aba91bbcedeb12bf4428f47a6a0b8: quote of 12359 raw units cannot resolve 0.01%
aerodrome cbBTC/AERO 0x1244264aec147f26b056d00d265eea0bc46db83c: quote of 74 raw units cannot resolve 0.01%
```

All three quotes are in cbBTC, which has 8 decimals, because cbBTC's address sorts above
the other three tokens and so is token1 in every pool, the side the probe buys. The pool
labels in these messages are in seed-list order, not token0/token1 order. They appear only
in drop messages and never reach `route_key`, `route_label`, pool ids, deduplication or
streaks.

**Diagnosis.** The check refused any quote below a hard-coded `BASE_QUOTE_MIN_OUT_RAW` of
1,000,000 raw units. Nothing derived that figure, and it hit hardest where the output token
has few decimals. Aerodrome's volatile `getAmountOut` has exactly two integer floors: the
fee deduction, which leaves the net input up to 1 raw unit high, and the constant-product
division, which leaves the output up to 1 raw unit low. Against our exact `simulate()`,
they move the answer by under `1/amountIn` and `1/out` respectively. `simulate()`'s own
floating-point error is around 1e-15 relative and negligible.

**Fix.**

- **The threshold is derived:** `BASE_QUOTE_MIN_RAW = quoteMinRaw(BASE_QUOTE_TOLERANCE)`,
  which is 2 floors times a margin of 2, divided by the tolerance: 40,000 raw units at
  0.01%. The two floors' worst cases are added, although their signs are opposite in
  practice. The margin of 2 means rounding can use at most half the tolerance, leaving the
  rest for a real disagreement in formula or fee. The old 1,000,000 was 25x stricter.
- **It applies to the probe input too**, after the pool's fee is deducted. The input floor
  is relative to the input, and when a raw unit of the input token is worth many raw units
  of the output token, a bound on the output alone is not enough.
- **The probe is 0.1% of reserveIn** (`BASE_QUOTE_PROBE_DIVISOR` 1,000, was 10,000). At
  0.01% the constant-product curvature was about the size of the tolerance, so a quote that
  ignored price impact would nearly have passed. At 0.1% it is ten times the tolerance.
  0.1% of a reserve is still nowhere near draining the pool.

**Expected effect on the three pools**, estimated because reserves will have moved since the
logged run. A 10x larger probe scales the output by about 9.991.

| Pool | Logged quote (1/10,000) | Estimated quote (1/1,000) | Against 40,000 |
|---|---|---|---|
| WETH/cbBTC | 56,314 | about 562,600 | passes |
| USDC/cbBTC | 12,359 | about 123,500 | passes |
| cbBTC/AERO | 74 | about 740 | still dropped |

cbBTC/AERO holds roughly 0.0074 cbBTC and would need a probe of about 1/18 of its reserve
to resolve 0.01%. It stays dropped, which is also the right outcome for a pool that small.
The next run will confirm or correct these estimates.

## 7. 18 to 19 September 2026: first full run with Base

All three venues, Stellar, XRPL and Base, ran together in one process. The figures below
are measured from `data/opportunities.csv`, rows from `2026-09-18T09:26:33Z` to
`2026-09-19T15:01:53Z`.

### 7.1 Coverage

**The run spans 29.6 hours, of which about 9 were unobserved.** Every gap over 2 minutes
affects all venues together, and all of them fall inside the same process; none is a
restart:

| Gap | Length |
|---|---|
| 17:43 to 20:18 on 18 September | 9,312 s |
| 23:03 on 18 September to 03:30 on 19 September | 15,984 s |
| 10:50 to 11:48 on 19 September | 3,450 s |
| 14 shorter gaps | 121 to 1,827 s each |

**Cause: the laptop lost mains power and slept on battery.** The Windows System event log
shows repeated "power source change" events, followed by sleep on battery: Modern Standby
on idle timeout at 22:47, hibernation from 23:17 to 03:30, and a critical-battery sleep
from 10:51 to 11:48. Whether the power losses were grid outages or an unplugged charger
was not determined. The sleep-never setting evidently applied to mains power only.

### 7.2 Errors

Error rows over all tick rows, per venue:

| Venue | Errors | Share | Breakdown |
|---|---|---|---|
| stellar | 175 / 1,217 | 14.4% | 130 "operation aborted due to timeout", 44 "fetch failed", 1 "terminated" |
| xrpl | 60 / 1,217 | 4.9% | 41 "getaddrinfo ENOTFOUND", 11 connect timeouts, 6 "Websocket connection never cleaned up", 1 closed before connecting, 1 "server too busy" |
| base | 98 / 1,217 | 8.1% | 84 "fetch failed", 14 "tick exceeded 15000 ms" |

**Zero "over rate limit" errors on Base.** The Multicall3 design in section 6.1 held for
the whole run.

**Every error type is a connectivity failure.** The DNS failures in particular are
consistent with the network itself going down, likely with the same power losses. No
error points at venue code.

### 7.3 Base behaviour

**Start-up and pool set were stable.** Every successful Base tick verified all 4 tokens
with exactly 1 expected drop (Aerodrome cbBTC/AERO, unresolvable quote, as predicted in
section 6.2). No token or pool dropped out mid-run.

**Zero Base routes** in about 20 hours of actual observation over 8 searchable pools (10
priced, 2 of them below the 5 ETH depth floor). No cycle among WETH, USDC, cbBTC and AERO
on Uniswap V2 or Aerodrome volatile pools cleared `BASE_FEE_NATIVE` plus the 20 bp floor.

**This zero has a known limit.** `BASE_FEE_NATIVE` was set as a deliberate overestimate:
it assumes a gas price of 0.1 gwei, where basescan showed about 0.005 gwei on 18
September. An edge larger than the true cost but smaller than that assumption would not
have been reported. This is a limit of the result, not a finding of edges.

### 7.4 Loop timing

Intervals between ticks, counting only those under 120 s so that the gaps in 7.1 are
excluded:

| Venue | Median | 90th percentile |
|---|---|---|
| stellar | 60,007 ms | 60,015 ms |
| xrpl | 59,997 ms | 78,134 ms |
| base | 60,034 ms | 80,999 ms |

The loop holds `POLL_MS` at the median with all three venues in it. The longer tail on
XRPL and Base follows passes stretched by network timeouts earlier in the same pass.

### 7.5 Other venues in the same window

Stellar logged 23 triangular rows and XRPL 2 in this window. They have not yet been
examined, and nothing is claimed about them here.

### 7.6 Conclusion

The Base module is operationally sound and was merged into `main` on 19 September 2026.
The measurement's main weakness is environmental: power and network. Any future run
intended as evidence needs mains power and network continuity addressed first.

## 8. XRPL order books next to the AMM: pre-registered hypothesis

Written on 19 September 2026, before any run of the order-book observation. Nothing in
this section is a result. Results will be added below after the run, and this text will
not be edited to fit them.

### 8.1 Hypothesis

XRPL interleaves AMM and order-book liquidity in every payment and every offer, and
auction-slot holders trade against the AMM at a reduced or zero fee. Therefore gaps
between the order book and the AMM that clear the fee floor will be rare and short-lived:
mostly single-tick sightings at small rungs.

### 8.2 What is measured

- **Pairs.** The 10 deepest XRP pools that pass the 1,000 XRP depth floor, ranked by XRP
  reserve, one per counter-asset. The selection is recomputed every 30 XRPL ticks (about
  30 minutes) and printed to the console on each selection.
- **Reads.** Both order books of each pair, 20 `book_offers` per tick, pinned to the same
  ledger as that tick's `amm_info` reads. Each issuer's `TransferRate` is read with
  `account_info` on each selection. If that read fails, it is retried on each following
  tick, one `account_info` per missing issuer, until it succeeds; meanwhile that issuer's
  pairs are skipped. A tick with every rate known makes no `account_info` call.
- **Cycles.** At each rung of the XRPL ladder (0.1 to 100 XRP), four round trips from XRP
  back to XRP: AMM only, book only, book then AMM, AMM then book. Books are walked level by
  level using funded amounts. A rung the book cannot fill has no book figure, never a
  mid-price stand-in.
- **The mixed figures are lower bounds.** The payment engine blends AMM and book within a
  single hop. These cycles use one venue per hop, so the engine would do at least as well.
- **Costs.** The AMM's full `trading_fee` (not an auction-slot discount), the same flat
  network fee as the AMM search, and the issuer's transfer fee charged once per cycle on
  the hop that spends the token, for book and AMM legs alike. Whether the transfer fee
  applies when the AMM is the counterparty is unverified; it is charged regardless.
- **Double count.** Offers whose `Account` is the pair's own AMM account are counted
  (`amm_in_book`) and excluded from the walk.
- **Rows.** One row in `data/book-gaps.csv` per pair per tick, only when a mixed cycle
  clears the AMM search's floors (net profit of at least 0.001 XRP and 20 bps after the
  network fee), at the qualifying rung and direction with the largest net profit.
- **Streaks count observed ticks only.** A tick in which a pair was not read (failed read,
  no pinned ledger, missing pool or transfer rate) neither extends nor resets its streak.
  Only a pinned tick in which the pair was read and did not qualify resets it. Such ticks
  are counted per tick as `book_skipped` in the heartbeat.

### 8.3 Verdict criteria, fixed now

- **Mid-ladder** means rungs from 5 to 40 XRP.
- **Refuted** if any pair and direction shows a run of 3 or more consecutive observed ticks
  at a mid-ladder rung, on 3 or more occasions separated by at least 1 hour.
- **Supported** if at least 90% of rows have `streak_ticks` = 1, with the remainder
  described.
- **Neither** otherwise.
- **No verdict either way from less than 48 hours of actual observation.** Gaps in
  collection and failed ticks are excluded from that total.

### 8.4 Results

#### Interim status, 21 September 2026 (not a verdict)

Measured from `data/opportunities.csv`, XRPL heartbeats from 2026-09-19T16:28:01Z to
2026-09-21T16:52:38Z.

- **Heartbeats.** 1,735 heartbeats, 1,685 with books read.
- **Observed time.** 29.0 observed hours of the 48 required, summing `tick_interval_ms`
  over ticks with books read and an interval under 120 s. Grid power outages account for
  most of the difference from calendar time.
- **Book-gap rows.** 0.
- **Double count.** `amm_in_book`: 0 in total.
- **Capped walks.** `book_capped`: 0 in total.
- **Read time.** `book_ms`: median 9,692 ms, p90 15,542 ms, 103 ticks over 20 s.

The run continues until 48 observed hours. The verdict will be added then, under the
criteria in 8.3.

#### Verdict, 23 September 2026

Measured from `data/opportunities.csv`, XRPL heartbeats from 2026-09-19T16:28:01Z to
2026-09-23T13:19:51Z.

- **Heartbeats.** 3,142 heartbeats, 3,058 with books read.
- **Observed time.** 52.2 observed hours, above the 48 required, summing
  `tick_interval_ms` over XRPL heartbeats where books were read and the interval was under
  120 s, so gaps in collection and failed ticks are excluded. The calendar span is
  longer because of grid power outages and one machine hibernation on 22 September that
  stopped both monitors.
- **Book-gap rows.** 0.
- **Double count.** `amm_in_book`: 0 in total.
- **Capped walks.** `book_capped`: 0 in total.
- **Read time.** `book_ms`: median 9,575 ms, p90 15,099 ms, 163 ticks over 20 s.

Verdict under the 8.3 criteria, which were fixed before the run:

- **Rarity: satisfied, in the strongest form.** No mixed cycle cleared the floors once in
  52.2 observed hours across 10 pairs.
- **Short-lived: not testable.** No gap occurred whose duration could be measured.
- **The 90%-of-rows criterion does not apply.** With zero rows there is no share of rows
  to compute. 8.5 anticipated this outcome and stated this wording in advance.
- **Refutation did not occur.** No pair and direction showed 3 or more consecutive
  observed ticks at a mid-ladder rung.

Secondary results:

- **No AMM offers in the books.** XRPL order books never contained the pair's own AMM
  account as an offer: `amm_in_book` was 0 throughout.
- **No truncated replies.** No `book_offers` reply was truncated at the 200-offer limit.

Limits on the result:

- **Sub-floor gaps are invisible.** Rows are written only when a mixed cycle clears the
  floors, so the data cannot show how close sub-floor gaps came.
- **Coverage.** The measurement covers the 10 deepest XRP pairs, not every pair.

Interpretation, not measurement: the result is consistent with the design of XLS-30, in
which the payment engine blends AMM and order-book liquidity within a hop and
auction-slot holders can arbitrage the difference at a reduced or zero fee.

### 8.5 A gap in the criteria, noted before the verdict

The supported criterion in 8.3 (at least 90% of rows with `streak_ticks` = 1) presumes at
least some rows. It does not cover a zero-row outcome. This is recorded here, before the
run completes and without changing 8.3.

If the run ends with zero rows, the verdict will be stated as: consistent with the
hypothesis on rarity; the "short-lived" part untestable, because no gap occurred whose
duration could be measured; the 8.3 criteria did not anticipate this outcome.

A further limitation: rows are written only when a mixed cycle clears the floors, so the
data cannot show how close sub-floor gaps came.
