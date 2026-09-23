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
