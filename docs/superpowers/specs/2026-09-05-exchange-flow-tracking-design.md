# Exchange XEM inflow/outflow tracking

## Problem

There's no way to see how much XEM is moving in and out of known exchange
wallets on a daily basis. NIS1 has no concept of "exchange address" and no
endpoint for it — this has to be built entirely from data NEMSCAN already
has or already collects.

## Goal

- A curated (auto-derived, not hand-maintained) list of known exchange
  addresses.
- Daily inflow/outflow (in XEM) tracked per address, rolled up per exchange.
- `/exchanges` — overview of all tracked exchanges with recent totals and a
  mini sparkline each.
- `/exchange/:name` — a detail page with a 30-day daily inflow/outflow bar
  chart for that exchange.

## Non-goals

- **No new NIS/external API calls.** The block-persistence backfill
  (`scanBlockHeightsForDailyTx`) already fetches and permanently stores
  every block (all transactions included) from the chain tip down to
  genesis, for `daily_tx_counts`/`blocks`. This feature reads that same
  data as a side effect of the existing hook — it does not poll per-address
  transaction history via `/account/transfers/all` or any other endpoint.
- **No multisig-wrapped-transfer unwrapping.** Consistent with the rest of
  NEMSCAN (`isTransfer = tx.type === 257` appears as-is throughout
  `html.js`). Major exchange hot wallets are rarely multisig; if one turns
  out to be, its multisig-cosigned transfers simply won't be counted.
- **No mosaic-attached amounts.** Only the transfer's native `amount`
  field (XEM, in micro-XEM) is counted. A transfer that moves only a
  mosaic (amount 0) contributes nothing.
- **No manual address management UI.** Addresses are derived automatically
  from the existing `richlist` cache's `info` labels, matched against a
  hardcoded known-exchange-name list in `constants.js`. Adding an
  exchange later means adding its name to that list, not a DB edit screen.
- **Mainnet only.** Same restriction as XEM price, rich list, and the
  namespace/mosaic/poll archives — there's no meaningful "exchange" concept
  on testnet.
- **No combined/comparison chart across exchanges.** Each exchange gets its
  own detail page; no overlay view.

## Architecture

### Known-exchange matching (`src/constants.js`)

```js
// Substring-matched (case-insensitive) against nemnodes.org richlist `info`
// labels (e.g. "Coincheck -- Exchange", "Zaif -- Cold Wallet") to identify
// which richlist addresses belong to a known exchange. Deliberately a
// fixed list rather than "any info value" — labels like "Protocol Treasury
// Account" or contributor names must not be picked up.
export const KNOWN_EXCHANGE_NAMES = [
  "Binance", "Bittrex", "Coincheck", "Zaif", "Poloniex", "HitBTC",
  "Kucoin", "Cryptopia", "Yobit", "Kuna", "Qryptos", "Coinsuper",
  "Upbit", "Huobi", "Bitflyer",
];

// Height-range size for one chunk of the local blocks-table backfill scan
// (see "Backfill for newly-added addresses" below). A local SQLite read,
// so this can be larger than DAILY_TX_BACKFILL_CHUNK's network-bound 60.
export const EXCHANGE_BACKFILL_CHUNK_HEIGHTS = 5000;
```

### Schema (`src/db.js`)

Two new tables, added to `openDbLayer()` (created on both network files for
schema consistency; only ever populated on mainnet, same as `richlist`):

```sql
CREATE TABLE IF NOT EXISTS exchange_addresses (
  address TEXT PRIMARY KEY,
  exchange_name TEXT NOT NULL,   -- matched entry from KNOWN_EXCHANGE_NAMES
  label TEXT,                    -- original richlist info string, for display
  backfilled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_exchange_addresses_name ON exchange_addresses(exchange_name);

CREATE TABLE IF NOT EXISTS exchange_daily_flows (
  date TEXT NOT NULL,            -- UTC yyyy-mm-dd, from dateKeyFromTs
  address TEXT NOT NULL,
  inflow INTEGER NOT NULL DEFAULT 0,   -- micro-XEM, sum of amount where recipient = address
  outflow INTEGER NOT NULL DEFAULT 0,  -- micro-XEM, sum of amount where sender = address
  PRIMARY KEY (date, address)
);
CREATE INDEX IF NOT EXISTS idx_exchange_daily_flows_date ON exchange_daily_flows(date);
```

New accessors in `db.js`, following existing prepared-statement /
`layer()` dispatch conventions:

- `getExchangeAddresses()` → all rows (used to build the in-memory watch
  set).
- `getExchangeAddressesNeedingBackfill()` → rows with `backfilled = 0`.
- `upsertExchangeAddress(address, exchangeName, label)` — `INSERT OR
  IGNORE` (never overwrite an existing row's `backfilled` state; if the
  label text changes on a later richlist refresh that's not worth
  chasing).
- `markExchangeAddressBackfilled(address)`.
- `bumpExchangeDailyFlow(date, address, inflow, outflow)` — same
  `ON CONFLICT ... DO UPDATE SET x = x + excluded.x` pattern as
  `bumpDailyTxCount`.
- `getExchangeDailyFlows(exchangeName, days)` → joins
  `exchange_addresses` to `exchange_daily_flows`, `GROUP BY date`,
  `SUM(inflow)`/`SUM(outflow)`, ordered ascending, limited to the most
  recent `days` calendar dates.
- `getExchangeList()` → distinct `exchange_name` values from
  `exchange_addresses` plus each one's most recent flow date and trailing
  totals (for the `/exchanges` overview cards).
- `getBlocksHeightRange()` → `{ minHeight, maxHeight }` from
  `MIN(height)`/`MAX(height)` on `blocks` (null-safe: no rows yet →
  `{ minHeight: null, maxHeight: null }`, backfill step no-ops in that
  case).
- `getBlocksInRange(from, to)` → rows from `blocks` with `height BETWEEN
  ? AND ?`, ascending.

### Shared helper (`src/helpers.js`)

`addrFromPubKey` currently lives as a private function in `html.js`
(wraps `pubKeyToAddress` with the request's current network byte).
`cache.js` needs the same resolution when reading `tx.signer` out of
cached block JSON, so it moves to `helpers.js` as an exported function;
`html.js` imports it from there instead of defining its own copy. No
behavior change, just deduplication forced by the new caller.

```js
// src/helpers.js
export function addrFromPubKey(hex) {
  return pubKeyToAddress(hex, NETWORKS[currentNetwork()].addressNetworkByte);
}
```

(`pubKeyToAddress` and `currentNetwork`/`NETWORKS` are already imported
into `helpers.js`/available to it, or added.)

### Flow extraction (`src/cache.js`)

**In-memory watch set**: a `Map<address, exchangeName>` built from
`getExchangeAddresses()`, rebuilt whenever `exchange_addresses` changes
(right after the richlist-derived sync step below runs). Rebuilding is
cheap (tens of rows).

**Hook point**: inside `scanBlockHeightsForDailyTx`, immediately after the
existing `upsertBlock(...)` call, for each `block.transactions` entry with
`type === 257`:

```js
const sender = addrFromPubKey(tx.signer);
const recipient = tx.recipient;
const dateKey = dateKeyFromTs(block.timeStamp);
if (watchSet.has(sender)) bumpExchangeDailyFlow(dateKey, sender, 0, tx.amount);
if (watchSet.has(recipient)) bumpExchangeDailyFlow(dateKey, recipient, tx.amount, 0);
```

This rides the existing backfill/live scan entirely — no new scheduling,
no new network calls. Genesis backfill is already in progress
independently of this feature; until it completes, exchange history is
only as complete as however far back `blocks` currently reaches, and it
fills in automatically as backfill progresses (documented as a known
limitation, not something this feature needs to solve).

**Richlist → exchange_addresses sync**: a new
`syncExchangeAddressesFromRichList()`, called at the end of
`refreshRichListCache()` (after the existing `upsertRichListEntry` loop).
For each richlist row whose `info` contains (case-insensitive) one of
`KNOWN_EXCHANGE_NAMES`, `upsertExchangeAddress(address, matchedName,
info)`. Then rebuilds the in-memory watch set.

**Backfill for newly-added addresses**: after the sync above, for each
row from `getExchangeAddressesNeedingBackfill()`, scan the local `blocks`
table in fixed-size height ranges (`EXCHANGE_BACKFILL_CHUNK_HEIGHTS`, a
new `constants.js` value, same order of magnitude as
`DAILY_TX_BACKFILL_CHUNK`) rather than one `SELECT * FROM blocks`:

```js
const db = getDb();
const { minHeight, maxHeight } = getBlocksHeightRange(); // new db.js accessor: MIN/MAX(height) FROM blocks
for (let from = minHeight; from <= maxHeight; from += EXCHANGE_BACKFILL_CHUNK_HEIGHTS) {
  const to = Math.min(from + EXCHANGE_BACKFILL_CHUNK_HEIGHTS - 1, maxHeight);
  const rows = getBlocksInRange(from, to); // new db.js accessor
  for (const row of rows) {
    const block = JSON.parse(row.raw);
    // same type-257 extraction as the live hook, scoped to this one address
  }
  await new Promise((r) => setImmediate(r)); // yield between chunks
}
markExchangeAddressBackfilled(address);
```

`node:sqlite`'s `DatabaseSync` is synchronous, so a full-table read in one
call would block the event loop for as long as `blocks` takes to
deserialize — noticeable once it holds a large fraction of the chain.
Chunking with a yield between each range keeps this responsive to other
requests, the same concern `ARCHIVE_PAGE_DELAY_MS`/
`DEEP_REFRESH_BATCH_DELAY_MS` address for their own (network-bound) loops,
here applied to a CPU/IO-bound local scan instead. Runs right after
`refreshRichListCache()` resolves (that job already runs on its own
6-hour interval; this adds bounded local work to it, no new schedule).

### Wiring (`index.js`)

No new intervals. `syncExchangeAddressesFromRichList()` (and its backfill
step) is called from inside `refreshRichListCache()` itself, so it's
already covered by the existing richlist scheduling.

New mainnet-only routes:

- `GET /exchanges` — page shell.
- `GET /api/exchanges` — overview fragment: `getExchangeList()` rendered
  as cards, each with a small sparkline (last 14 days, reusing the visual
  language of `dailyTxChartHTML` but fed inflow-minus-outflow net values).
- `GET /exchange/:name` — page shell.
- `GET /api/exchange/:name?days=` — detail fragment:
  `getExchangeDailyFlows(name, days || 30)` rendered as the bar chart
  below.

### UI (`src/html.js`)

- `navHTML`'s `links` array gains `["/exchanges", "Exchanges"]`, rendered
  only when `currentNetwork() === "mainnet"` (same conditional already
  used for price/richlist nav entries).
- `exchangeOverviewHTML(list)` — one card per exchange: name, trailing
  totals (e.g. last 7 days inflow/outflow in XEM), a mini net-flow
  sparkline, links to `/exchange/:name`.
- `exchangeFlowChartHTML(name, data)` — new SVG chart type (first of its
  kind in the app): one vertical bar pair per day, inflow bar extending
  up from a zero baseline (green), outflow bar extending down (red), X
  axis labeled with `m/d` every few days like `dailyTxChartHTML`'s axis
  labels, no gridlines/legend — same minimal aesthetic as the existing
  chart. Empty/short-data state mirrors `dailyTxChartHTML`'s "Collecting
  data…" placeholder.

## Error handling

- `syncExchangeAddressesFromRichList()` and the backfill step catch and
  `console.error`, same as every other background job in `cache.js` —
  best-effort, never blocks `refreshRichListCache()`'s other work.
- `/api/exchanges` and `/api/exchange/:name` follow the existing
  `errorFrag(...)` pattern used by other API routes.
- Unknown `:name` in `/exchange/:name` → same "not found" treatment as
  `/mosaic/:path` for an unknown mosaic.
- Empty result set (no exchange addresses matched yet, or backfill still
  running) renders the same `empty-state` div style used elsewhere.

## Storage

`exchange_daily_flows` is at most `(days tracked) × (addresses)` rows —
trivial. `exchange_addresses` is a handful of rows. No meaningful storage
impact; the real cost already exists (`blocks` table).

## Testing

- `test/db.test.js`: `upsertExchangeAddress` (dedup on conflict),
  `markExchangeAddressBackfilled`, `bumpExchangeDailyFlow` accumulation
  across repeated calls, `getExchangeDailyFlows` grouping/summing across
  multiple addresses under one exchange name, `getExchangeList` shape,
  `getBlocksHeightRange`/`getBlocksInRange` (including the no-rows-yet
  case); mainnet/testnet isolation.
- `test/cache.test.js`: `syncExchangeAddressesFromRichList` matches known
  names case-insensitively and ignores non-matching labels; the live
  extraction hook in `scanBlockHeightsForDailyTx` correctly attributes
  inflow vs outflow for a mocked block containing a type-257 transaction
  to/from a watched address and ignores non-257 types; the backfill step
  processes existing `blocks` rows for a newly-added address and sets
  `backfilled = 1`.
- `test/helpers.test.js`: `addrFromPubKey` moved/re-exported correctly
  (existing `html.test.js` coverage of address-dependent rendering should
  continue to pass unchanged).
- `test/html.test.js`: `exchangeOverviewHTML` / `exchangeFlowChartHTML`
  output shape, including the empty-state cases.
- Manual: start the server, confirm `/exchanges` lists at least one
  richlist-derived exchange once `refreshRichListCache` has run, and
  `/exchange/:name` renders a bar chart once `exchange_daily_flows` has
  data for it.
