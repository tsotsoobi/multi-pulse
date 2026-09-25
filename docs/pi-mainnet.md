# Pi mainnet

A phased plan for Pi mainnet, from read-only watching now to a funded liquidity decision
later. Written 23 September 2026. Nothing here has been built or executed.

Every statement is marked as one of four kinds, and they are kept apart on purpose:

- **Measured**: observed directly, with the date it was observed.
- **Inferred**: reasoning from measured facts or from Stellar's documented rules. It may be
  wrong, and each inference says what observation would test it.
- **Undecided**: a question this document does not answer, listed so that nobody mistakes
  silence for a decision.
- **Decided**: a question this document has answered, with the date and the reason, so a
  later reader knows it was chosen rather than overlooked.

## 1. Measured

| Date | Observation | Source |
|---|---|---|
| 2026-09-15 | Protocol 27 activated on Pi mainnet: AMM liquidity pools, smart contract authentication and RPC infrastructure. Described publicly as the final planned upgrade. | Public announcement |
| 2026-09-20 | `https://api.mainnet.minepi.com/assets` returns zero records. `/liquidity_pools` returns zero records. | Direct GET |
| 2026-09-22 | Same two endpoints, same result: zero and zero. | Direct GET |
| 2026-09-20 | Pi Testnet order books exist on all 21 deep pairs checked, but are priced far from the pools. | pi-pulse MAINNET-READINESS section 11 |
| 2026-09-20 | Horizon strict-send matched a pool-only simulation on 120 of 120 cycles. | pi-pulse MAINNET-READINESS section 11 |

**The machinery exists; nothing has been created with it.** Both endpoints answer, so the
Horizon routes are live, and both are empty. No asset has been issued on mainnet and no pool
has been deposited into, as of 22 September.

**The Pi Launchpad model, as described publicly:** proceeds from each token launch go into a
liquidity pool paired with the new ecosystem token. Testnet tokens, SLICE included, never
move to mainnet. Anything learned about specific testnet tokens therefore says nothing about
which tokens will exist on mainnet.

**Pi's public dates have slipped before.** The DEX was reported as targeted for March 2026
and arrived in September 2026. For that reason no phase below is scheduled by date. Each is
triggered by an observation from the phase before it.

## 2. The structural argument (inferred)

This is reasoning, not measurement. It is the claim Phase 2 exists to test.

**2.1 One pool per pair.** On Stellar, a liquidity pool's id is a hash of its two assets
and its fee, and the protocol fixes the fee at 30 bp for constant-product pools. There is
therefore exactly one pool per asset pair. If Pi keeps that rule, pi-pulse's direct route
family (two pools quoting the same pair) cannot exist on Pi mainnet.
*Needs verification on mainnet once a pool exists:* read the pool's `fee_bp`, and check
whether a second pool on the same pair ever appears.

**2.2 A star has no cycles.** If every Launchpad token receives one PI pool and no
token-to-token pool, the pool graph is a star with PI at the centre. A triangular route
needs a cycle of three pools, PI to A to B to PI, and a star has none. Arbitrage between
pools is then impossible regardless of how many tokens launch. The only ways a cycle
appears are:

- a token-to-token pool, A/B, created by someone; or
- order-book depth on some pair, so that a leg can be filled from offers instead of a pool.

The testnet measurement bears on the second: order books existed, but priced far from the
pools, and every strict-send cycle matched the pool-only simulation, so the books were not
filling legs.

**2.3 Consequence.** If 2.1 and 2.2 hold, the missing layer on Pi mainnet is token-to-token
liquidity and routing, not a faster detector. A better watcher finds nothing faster on a
graph that has no cycles.

**What would falsify this:** a token-to-token pool appearing on mainnet without anyone in
this project creating it; a second pool on an existing pair; or order books on mainnet
priced close enough to the pools that strict-send paths route through them.

## 3. Phase 0: read-only watcher (build now)

**Trigger:** none. This phase starts now, because the only thing to observe is the moment
something appears.

*Correction, 25 September 2026: the premise of the sentence above is wrong. A poll after a
gap still lists what was created during it, so a gap delays notice and does not lose the
observation. The sentence is left as written; see 3.7.*

### 3.1 Design

A separate script inside multi-pulse, `src/pi-watch.ts`, run as its own npm script
(`npm run pi-watch`), in its own process. It does not join the `monitor.ts` loop: with zero
assets and zero pools a venue in that loop would tick every 60 s pricing nothing, the Pi
native asset would be labelled "XLM" by `StellarVenue.assetLabel`, and a new process means
the running monitor is never restarted or touched.

It reuses the Stellar venue rather than copying it. Pi is a Stellar fork and its Horizon
serves the same routes, so the only change to `src/venues/stellar.ts` is to stop hardcoding
`HORIZON_URL`:

- `getJson` is exported unchanged. It already pins `GET`, sends no body and no
  Authorization header, retries 429, 5xx and transport failures, and honours `retry-after`.
- `walkShard` takes a base URL parameter, defaulting to `HORIZON_URL`, so the existing
  Stellar path is byte-for-byte the same request.
- `toPool` is exported so Phase 2 normalises Pi pools exactly as Stellar pools are
  normalised.
- `src/config.ts` gains `PI_HORIZON_URL = "https://api.mainnet.minepi.com"` and
  `PI_WATCH_MS`.

**Read-only by construction, as the rest of the repo is.** No key, no signer, no
`@stellar/stellar-sdk`, no submit endpoint. No new library: the watcher uses `fetch` and
`node:fs`, both already in use.

### 3.2 What it polls, assets before pools

A pool needs two assets, at least one non-native, and an asset appears in `/assets` once it
has trustlines. So a pool cannot exist while `/assets` is empty (inferred from Stellar's
rules; the hourly pools check below guards against this being wrong on Pi).

| Request | Interval | Why |
|---|---|---|
| `GET /assets?limit=200&order=asc`, walked to the zero-record page | every 10 min | The first thing that can appear. The full set is diffed against the last one seen, because `/assets` is ordered by code and issuer, not by creation time, so "newest first" is not available. |
| `GET /liquidity_pools?limit=200&order=asc`, walked the same way | every 60 min while `/assets` is empty; every 10 min once it is not | Guard against the inference above, then the real signal. |
| `GET /` (Horizon root) | every 60 min | Records `current_protocol_version` and `core_supported_protocol_version`, so a further upgrade is noticed. |

Termination is the zero-record page, as in `walkShard`, never a missing `next` link or a
short page.

### 3.3 Request cost per day

While both endpoints are empty, each walk is one request (the first page is already the
empty one):

| Request | Per day |
|---|---|
| `/assets`, 144 polls x 1 page | 144 |
| `/liquidity_pools`, 24 polls x 1 page | 24 |
| `/`, 24 polls | 24 |
| **Total** | **192** |

That is one request every 7.5 minutes. Once assets exist, each walk costs
`ceil(n / 200) + 1` requests, so up to 200 assets doubles the assets line to 288, and pools
move to every 10 minutes at the same per-walk cost. Retries are not counted; on Stellar they
ran at a few percent of requests (FINDINGS section 7.2).

### 3.4 What it writes

All under `data/`, which is already gitignored:

- `data/pi-watch.jsonl`: one line per poll. Timestamp, endpoint, record count, pages,
  milliseconds, and the error message if the poll failed. This is the coverage record: a gap
  in it is a gap in observation, as in FINDINGS section 7.1.
- `data/pi-assets.jsonl`: the raw Horizon record for each asset, written when first seen
  and again whenever any field changes.
- `data/pi-pools.jsonl`: the same for pools.
- `data/pi-protocol.jsonl`: the root endpoint's version fields, written on change.

Raw records are kept verbatim so that Phase 1 and Phase 2 can be answered from the files
without re-querying history that Horizon may not serve later.

### 3.5 What it alerts on

Every alert is a line on stdout prefixed `PI ALERT`, appended to `data/pi-alerts.log`, and
delivered nowhere else. This was decided on 23 September 2026 (below, and section 7).

- The first asset ever seen.
- Each new asset after that.
- The first pool ever seen.
- Each new pool, with its two assets and `fee_bp`.
- A second pool on a pair that already has one (tests 2.1 directly).
- A pool whose two assets are both non-native (tests 2.2 directly).
- An asset or pool disappearing from the walk.
- A change in protocol version.
- Six consecutive failed polls: the watcher is blind, and that has to be said, not
  logged quietly.

**Delivery: decided 23 September 2026, stdout and `data/pi-alerts.log` only.** No webhook.
multi-pulse keeps no secret and makes no outbound request.

The reason: while Pi mainnet has no pools and no cycles, there is nothing an alert could be
acted on in time for, so an alert read hours late costs nothing. The first asset is still
recorded the moment the watcher sees it, in `data/pi-assets.jsonl` with its timestamp, so
reading the alert late loses no data, only notice. Paying for a first secret and a first
POST, the costs set out below, is not worth it yet.

**What would reopen it, once pools appear:** a pool with real depth, or any other
observation that makes hours matter. Until one of those is seen, the decision stands.

The option considered was `ALERT_WEBHOOK`. It is not in multi-pulse; it is in the sibling
project pi-pulse, where it appears in `.env.example`, `src/config.ts`, `src/secure-url.ts` and
`src/redact.ts` (found by file search, 23 September 2026; the handling itself was not read
for this document). Using it here would cost:

- **An outbound request from an otherwise self-contained read-only tool.** Today
  multi-pulse only reads public chain endpoints. A webhook POST would be its first request
  that is not a GET, and the first to send data out, to a host that is not a chain. It
  would need its own helper, kept apart from `getJson`, so that `getJson` still pins `GET`
  and the only POST in the repo is the one that carries an alert.
- **A URL in config.** A webhook URL usually carries its own credential, so it cannot be
  committed to `src/config.ts`. multi-pulse reads no `process.env` anywhere (README, and
  the header of `src/config.ts`), so the URL would be either the repo's first environment
  read or a gitignored local file. Either one is a secret in a repo that currently holds
  none, and pi-pulse's `secure-url.ts` and `redact.ts` suggest it needed code to keep such
  a URL out of logs.

The alternative that avoids both costs is a local notification on this machine only, which
reaches nobody who is away from it, and so is no better than stdout.

FINDINGS section 7 traced nine unobserved hours to power loss. The watcher's value is in not
missing the first appearance, so it has the same dependency on mains power and network
continuity, and the same fix applies before its output is treated as evidence.

*Correction, 25 September 2026: the paragraph above is left as written, but its premise is
wrong. For the question Phase 0 answers, a gap costs latency of notice, not the observation,
and the power fix is not a precondition for treating its output as evidence. See 3.7.*

### 3.6 First results, 23 to 25 September 2026

Measured on 25 September 2026, read-only, from `data/pi-watch.jsonl` and
`data/pi-alerts.log`, up to and including the line at 2026-09-25T15:46:59.772Z. The watcher
kept running after that; later lines are not counted. Causes come from the Windows System
event log (Kernel-Power and Power-Troubleshooter events), from pi-pulse's
`data/keep-awake.log`, which records AC or battery every 5 minutes, and from multi-pulse's
own `data/opportunities.csv` for the same windows.

**State at the last poll.** The watcher started at 2026-09-23T15:14:56Z and ran as one
process with no restart: every poll id carries the same run id. At the last poll,
2026-09-25T15:46:59Z, `/assets` returned 0 classic assets and `/liquidity_pools` returned 0
pools. Every successful poll of either endpoint in the run returned zero. The root reported
protocol 27 on its first poll and never changed.

**Record files.**

| File | Lines |
|---|---|
| `data/pi-watch.jsonl` | 163 |
| `data/pi-alerts.log` | 8 |
| `data/pi-protocol.jsonl` | 1 |
| `data/pi-assets.jsonl` | does not exist |
| `data/pi-pools.jsonl` | does not exist |

The asset and pool files are created by the first record written to them, so their absence
is itself the record that nothing was ever seen.

**Polls per endpoint.**

| Endpoint | Attempted | Answered | Failed |
|---|---|---|---|
| `/assets` | 121 | 65 | 56 |
| `/liquidity_pools` | 21 | 10 | 11 |
| `/` | 21 | 10 | 11 |
| **Total** | **163** | **85** | **78** |

**Coverage, three states kept apart.** The span is 2026-09-23T15:14:56Z to
2026-09-25T15:46:59Z, 2,912 minutes (48.5 hours). Each `/assets` attempt is credited with
the time to the next attempt, capped at the 10-minute interval, under the outcome of that
attempt. Span credited to no attempt is time with no poll.

| State | Minutes | Hours | Share of span |
|---|---|---|---|
| Polled and answered | 639 | 10.65 | 22.0% |
| Polled and failed | 539 | 8.99 | 18.5% |
| Not polled at all | 1,734 | 28.90 | 59.5% |

About 22% of the span was observed.

**No-poll gaps over 25 minutes**, between consecutive `/assets` lines. Each length includes
the normal 10-minute interval.

| From | To | Minutes |
|---|---|---|
| 23 Sep 17:45:01 | 23 Sep 19:43:27 | 118.4 |
| 23 Sep 20:03:25 | 24 Sep 04:22:01 | 498.6 |
| 24 Sep 04:22:01 | 24 Sep 06:58:47 | 156.8 |
| 24 Sep 17:28:54 | 25 Sep 10:06:53 | 998.0 |

Four gaps, the largest 998 minutes, 1,772 minutes in total. The second and third are one
night, split by a single failed poll at 04:22 (below).

**Blindness episodes**, from `data/pi-alerts.log`. BLIND fired on the sixth consecutive
failed poll of an endpoint and RECOVERED on the next success, both as designed.

| Episode | Endpoint | Blind from | Recovered | Span | Failed polls | BLIND fired |
|---|---|---|---|---|---|---|
| 1 | `/assets` | 23 Sep 19:43:27 | 24 Sep 07:08:48 | 11 h 25 min | 6 | 24 Sep 06:59:08 |
| 2 | `/assets` | 24 Sep 08:29:07 | 24 Sep 14:48:55 | 6 h 20 min | 38 | 24 Sep 09:19:07 |
| 2 | `/liquidity_pools` | 24 Sep 08:29:27 | 24 Sep 15:28:55 | 6 h 59 min | 7 | 24 Sep 13:29:27 |
| 2 | `/` | 24 Sep 08:29:47 | 24 Sep 15:28:55 | 6 h 59 min | 7 | 24 Sep 13:29:47 |

- **Episode 1 is mostly not-polled time, not failed-poll time.** Six failed polls spread
  over 11 h 25 min, with the machine in standby or hibernation from 20:07 to 06:58. The
  alert counts consecutive failures, so its span mixes two of the three states above, and
  it fired only once the machine woke.
- **On the hourly endpoints BLIND fires five hours after the first failure,** and RECOVERED
  waits for the next hourly slot: `/assets` answered again from 14:48, pools and root were
  next tried at 15:28.
- A streak of five `/assets` failures on 25 September, 10:47 to 11:27, stayed below six and
  raised no alert, as designed.

**Causes of the failed polls.** All 78 carry the error "fetch failed". That text says only
that the request did not complete, not why. FINDINGS 7.2 lists it among connectivity
failures; FINDINGS 7.1 left grid outage versus unplugged charger undetermined. Here the
same text covers more than one cause:

| Failed polls | When | Machine | Cause |
|---|---|---|---|
| 52 | 24 Sep 08:29 to 14:39 | Awake, on AC throughout | No network at this machine. The main monitor failed on every tick of all three venues in the same window, 370 each, XRPL with `getaddrinfo ENOTFOUND`. Whether the router or the ISP was down is not determined. |
| 9 | 23 Sep 16:15 to 17:15 | Awake, on AC | The network at this machine, intermittently: the main monitor's venues failed on most ticks in the same hour. Cause upstream not determined. |
| 5 | 23 Sep 19:43 to 20:04 | Lid open, on battery since a power source change at 17:46 | The network at this machine: all monitor ticks failed too. Mains was off, which fits a grid outage taking the router down; not confirmed. |
| 7 | 25 Sep 10:47 to 11:27 | On battery; Modern Standby entered at 10:44:07, reason "Idle Timeout", exited 11:26:02 | Standby, although keep-awake logged `request=held` throughout. |
| 5 | 24 Sep 04:22, 06:58, 06:59; 25 Sep 10:06, 10:07 | Around sleep | Three polls began just before the machine slept and failed on waking, 2.6 to 11.5 hours later. Two began within 20 s of waking, before the network was back. |

In every window where the watcher failed, the main monitor's venues failed as well, so none
of the 78 failures is Pi's Horizon.

**Causes of the no-poll gaps: the lid was closed.** All four gaps fall inside three lid
closures, each starting at a Modern Standby entry with reason "Lid" and ending at an exit
with reason "Lid":

- 23 Sep 17:46:42 to 19:43:01, the 118-minute gap: the evening of 23 September.
- 23 Sep 20:07:20 to 24 Sep 06:58:32, overnight. The machine hibernated at 04:22:03
  ("Standby Battery Budget Exceeded"); the lone poll at 04:22:01 ran in the seconds it was
  up before hibernating.
- 24 Sep 17:32:02 to 25 Sep 10:06:45, overnight, hibernating from 22:36:25 for the same
  reason.

That is two overnight closures, as expected, and a third, shorter one in the evening of 23
September.

keep-awake (pi-pulse `scripts/keep-awake.ps1`, running since 2026-09-23T10:13:02Z) cannot
cover these. It prevents idle-timeout standby only, and its own start-up line says it
"CANNOT PREVENT: a user-initiated sleep, a lid-close action, a critical-battery shutdown, or
Windows overriding this under battery austerity". The 25 September standby at 10:44 is the
last of those: on battery, entered on idle timeout, while the request was held. The
script's header says the lid action was set to "Do nothing"; the "Lid" entries above show
that closing the lid did put this machine into standby.

### 3.7 Correction, 25 September 2026: a gap delays notice, it does not lose the observation

**What was written.** The trigger of section 3 ("the only thing to observe is the moment
something appears") and the last paragraph of 3.5 ("The watcher's value is in not missing
the first appearance") treat Phase 0's value as catching the first asset as it appears.
Both are left as written above, each with a note pointing here, in the way FINDINGS 8.5
records a gap without changing 8.3.

**Why that premise is wrong** (inferred from Stellar's documented rules; to be tested on the
first real record). `/assets` and `/liquidity_pools` list what exists now. An asset stays
listed while it has trustlines, a pool while it has trustlines to it. A poll after a gap
therefore lists everything created during the gap that still exists, and Horizon's history
routes can say when it was created. What thin coverage costs is latency of notice, not the
observation itself.

**Where the records carry the creation ledger, and where they do not.** The brief for this
correction said the records carry the ledger they were created in. By Horizon's documented
record shapes that holds only partly, and neither shape has been seen on Pi yet:

- A pool record carries `last_modified_ledger` and `last_modified_time`. That is the ledger
  of the pool's latest change, equal to its creation ledger only until its first deposit,
  trade or trustline change. The creation ledger itself is in the pool's history, its
  earliest operation or effect (`GET /liquidity_pools/{id}/operations?order=asc&limit=1`).
- An asset record carries no ledger or time field at all, and Horizon has no per-asset
  history route. The issuer account's history (`GET /accounts/{issuer}/operations?order=asc`)
  bounds it: when the issuer was created, and when it first paid the asset out.

Both depend on Pi's Horizon still serving that history when asked. Its retention has not
been measured.

**Consequences.**

1. **"Pi mainnet had zero assets and zero pools" holds for the whole span, as at the last
   successful poll (2026-09-25T15:46:59Z), not only for the 22% observed.** Anything created
   in between and still existing would have been listed. Two limits remain: it is zero
   classic assets (section 4.2), and something created and removed again inside a gap, an
   asset or pool whose last trustline was removed, would not be listed. On a chain that had
   none of either, that is unlikely, but these polls do not exclude it.
2. **Whether a gap matters depends on the question.** For a rate over time, as in FINDINGS
   section 8, a missed hour is a missed sample, which is why 8.3 counts observed hours
   rather than calendar hours. For "has this ever happened", one successful poll is as good
   as a hundred, provided the thing still exists. Phase 0's alerts are the second kind.
   Phase 2's depth, volume and per-tick measurements are the first kind, and coverage
   matters again there.
3. **Proposed as the next small change, not implemented: report the creation ledger.** When
   the watcher first sees a pool or asset, it would make one further read and put the
   creation ledger and its close time in the alert and in the record line, so that a late
   detection becomes an exactly dated one. Phase 0 does not capture this today. It keeps
   every record verbatim (`walkAll`, written as `record` in `data/pi-assets.jsonl` and
   `data/pi-pools.jsonl`), so a pool's `last_modified_ledger` would be kept, but that is the
   creation ledger only if nothing touched the pool before the poll, and an asset record has
   no such field. The change is one GET per new pool, or the issuer-history bound per new
   asset, to the same host through `getJson`, so the watcher stays read-only.
4. **Where Phase 0 runs is a smaller question than it looked.** The last paragraph of 3.5
   asked for the FINDINGS 7 power fix before Phase 0's output counts as evidence. For
   Phase 0's question it does not need it. A daily scan answers the same question as a
   held-open process, with worse notice. Recorded as undecided in section 7.

## 4. Phase 1: when assets appear

**Trigger:** the first `PI ALERT` for a new asset.

### 4.1 What to measure per asset

| Field | Where | What it answers |
|---|---|---|
| Issuer flags: `auth_required`, `auth_revocable`, `auth_immutable`, `auth_clawback_enabled` | `/assets` record, `flags` | Can the issuer freeze holders or take tokens back? |
| Whether the issuer is locked | `GET /accounts/{issuer}`: master key weight and thresholds | Can the issuer still sign anything at all, including new issuance? |
| Supply | `/assets` record, `balances` and `liquidity_pools_amount` | How much exists, and how much of it is in pools. |
| Holder count | `/assets` record, `accounts.authorized` and the unauthorized counts | How many accounts hold it. |
| Home domain | `GET /accounts/{issuer}`, `home_domain` | Who claims to be behind it. The domain string is recorded; fetching its `stellar.toml` is undecided (section 7). |

Each issuer account lookup is one request per new asset, made once, and again only if the
asset's record changes.

### 4.2 Why issuer control comes first

On a Stellar-style chain the issuer's powers decide whether anything else about a token is
worth measuring (Stellar's rules; each to be verified on Pi):

- **An unlocked issuer can issue more.** Supply, holder share and pool depth all describe a
  quantity the issuer can change at will. A locked issuer (master weight 0, no other
  signers) turns supply into a fixed fact.
- **Revocable means freezable.** On Stellar, revoking a holder's authorization also pulls
  their pool shares for that asset out of the pool. Liquidity in a revocable asset exists
  at the issuer's discretion.
- **Clawback-enabled assets** can be taken back from holders. On Stellar, a trustline with
  clawback enabled cannot deposit into a pool at all; whether Pi keeps that rule is itself
  a Phase 1 measurement.

So issuer control is recorded before depth, price or volume, and an asset whose issuer
retains these powers is flagged in every later table rather than filtered out silently.

**A known blind spot.** Protocol 27 brought smart contract authentication. If Pi tokens are
issued as contracts rather than as classic assets, they may not appear in `/assets` at all,
and this watcher would stay at zero while tokens exist. Whether Launchpad tokens are classic
assets is undecided (section 7). If the Launchpad is observed to launch a token while
`/assets` stays empty, that is the signal, and the watcher needs an RPC read path.

## 5. Phase 2: when pools appear

**Trigger:** the first `PI ALERT` for a new pool.

This phase tests section 2 with data. Pi is added to the monitor as a venue at this point,
reusing `toPool` and `simulate`, with its own depth floor and its own native label, so that
the same CSV and the same cycle search run over Pi pools.

### 5.1 What to measure

- **Depth:** reserves of each pool, in PI and in the token, per tick.
- **Fees:** `fee_bp` as each record reports it, never assumed to be 30 (the same rule as
  `simulate()` already follows).
- **Topology:** the full list of pairs. Specifically, the count of PI/token pools, the count
  of token/token pools, and whether any pair has more than one pool.
- **Cycles:** the number of three-pool cycles in the graph. Under 2.2 this is zero while
  the graph is a star.
- **Order books:** for each pair with a pool, whether offers exist and how far their best
  price sits from the pool's price. On testnet they sat far from the pools; whether mainnet
  repeats that is the second half of 2.2.
- **Strict-send agreement:** as on testnet, whether Horizon strict-send paths match the
  pool-only simulation. Disagreement would mean something other than pools is routing.
- **Volume:** trades per pool per day, from `/liquidity_pools/{id}/trades`.

### 5.2 What the data would say

| Observation | Meaning |
|---|---|
| Star topology, no cycles, strict-send matches pools | 2.2 holds. No detector can find anything; the missing layer is token-to-token liquidity. |
| Token-to-token pools appear, made by others | 2.2 is falsified for those tokens. The existing cycle search applies unchanged. |
| Order books priced near pools, strict-send diverges | Routes exist through books. The detector needs a book leg, which it does not have today. |
| More than one pool on a pair | 2.1 is falsified on Pi. The direct route family becomes possible. |

## 6. Phase 3: supplying token-to-token liquidity (a decision, not a build)

**Trigger:** Phase 2 data showing the preconditions below, collected over a period long
enough to see volume, not a single observation.

This section recommends nothing. It lists what the decision would involve and what would
have to be true before it is considered at all.

### 6.1 What it would require

- A funded Pi account and a signing key. This is the first point in this project where a key
  would exist, and it would live outside this repo: multi-pulse stays read-only, and the
  `Venue` interface stays without `execute` or `submit`.
- Trustlines to both tokens of the pair, and a deposit into a token-to-token pool, which
  means holding both tokens, which means buying both through their PI pools first and
  paying their fees and slippage.
- A way to exit: a withdrawal path that has been tested with a trivial amount before any
  real deposit.

### 6.2 Risks

- **Impermanent loss.** If the two tokens' prices diverge, the position ends up holding more
  of the one that fell. On new tokens with thin markets, divergence of that size is the
  expected case, not the tail.
- **Issuer clawback or freeze.** If either issuer can revoke authorization or claw back, the
  position exists at that issuer's discretion (section 4.2). Two tokens means two issuers.
- **Thin volume.** Fees accrue only from trades. A pool nobody routes through earns nothing
  and carries all of the risks above.
- **A token that fails.** A Launchpad project can be abandoned. Its token then trends to zero,
  and a token-to-token pool drains the other side into it.
- **Undoing the argument.** A token-to-token pool creates the cycles section 2 says are
  missing. Other watchers would see them too.

### 6.3 Preconditions, all from Phase 2 data

Every one of these must hold before the decision is opened, not merely most of them:

1. Section 2 is confirmed by data: star topology, no token-to-token pools, and order books
   not filling legs.
2. Both tokens' issuers are locked, and neither asset is revocable or clawback-enabled.

   *Note on precondition 2.* If Pi keeps Stellar's rule that a clawback-enabled asset
   cannot be deposited into a pool, then any token already in a pool satisfies the
   clawback half automatically. The revocable half is different. If Launchpad issuers keep
   `auth_revocable` set as standard practice, precondition 2 excludes every Launchpad
   token, and Phase 3 is closed by design. That is an acceptable outcome, but it must be
   visible now rather than discovered after Phase 2 has run. The first Phase 1 asset
   measurement settles it: the asset record's `flags` show `auth_revocable` directly.
3. Both tokens' PI pools have held depth above a floor, set before looking at the data, for
   a sustained period.
4. Both tokens' PI pools show real volume, trades from many accounts rather than a few,
   over that same period.
5. Both tokens have a holder count and a home domain that identify an active project.
6. A test deposit and withdrawal of a trivial amount has succeeded on mainnet, and the
   withdrawal returned what was expected.

### 6.4 Capital

- **Adokwei's own treasury only.** A fixed cap in PI, written down before any deposit, sized
  so that losing all of it is acceptable. The figure itself is undecided (section 7).
- **No pooled or staked user funds from any other project may be used.** Not as capital, not
  as collateral, not temporarily. This is a rule, not a precondition, and no Phase 2 result
  changes it.

## 7. Undecided and decided

### Undecided

- Whether Pi keeps Stellar's one-pool-per-pair rule and its 30 bp fee (section 2.1).
- Whether Launchpad tokens are classic assets visible in `/assets`, or contracts that need
  an RPC read path (section 4.2).
- Whether Pi keeps Stellar's rule that clawback-enabled trustlines cannot deposit into pools.
- The Pi Horizon rate limit. At one request every 7.5 minutes it should not matter, but it
  has not been measured.
- Whether to fetch each asset's `stellar.toml` from its home domain, which is a request to
  an arbitrary host chosen by the issuer.
- Pi's base fee, which a Pi venue's `feeNative` needs in Phase 2.
- The depth floor, volume threshold and observation period in 6.3, to be fixed before
  Phase 2 data is examined.
- The capital cap in 6.4.
- Whether Phase 3 is ever opened.
- Where Phase 0 runs (added 25 September 2026): a held-open process on this laptop, as
  since 23 September, or a daily scan from any machine. For the question Phase 0 answers,
  whether anything exists yet, a daily scan answers it as well as a held-open process
  (3.7). What it gives up is notice, up to a day, and, until the creation-ledger change in
  3.7 is made, the exact dating of what it finds. Dating a late find also relies on Pi's
  Horizon history retention, which is not measured. The question returns in Phase 2, where
  rates are measured and coverage counts.

### Decided

- **Alert delivery (section 3.5), 23 September 2026: stdout and `data/pi-alerts.log`
  only.** No webhook, so multi-pulse keeps no secret and makes no outbound request.
  Reason: while Pi mainnet has no pools and no cycles, an alert read hours late costs
  nothing, so the cost of a first secret and a first POST is not worth paying yet.
  Reopened by: a pool with real depth, or any observation that makes hours matter.

## 8. Phase triggers

| Phase | Starts when | Produces |
|---|---|---|
| 0 | Now | `data/pi-watch.jsonl` and alerts |
| 1 | First asset seen on `/assets` | Issuer control and supply per asset |
| 2 | First pool seen on `/liquidity_pools` | Depth, fees, topology, a test of section 2 |
| 3 | Phase 2 data meets every precondition in 6.3 | A decision, recorded, either way |

No row has a date.
