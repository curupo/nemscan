# Exchange XEM Inflow/Outflow Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track daily XEM inflow/outflow for known exchange wallet addresses (auto-derived from the existing rich-list cache) and expose an `/exchanges` overview page plus a per-exchange `/exchange/:name` daily flow chart, with zero new external API calls.

**Architecture:** Exchange addresses are matched from the existing `richlist` table's `info` labels against a hardcoded known-exchange-name list. Daily inflow/outflow is derived entirely from data NEMSCAN already fetches: the existing block-persistence backfill (`scanBlockHeightsForDailyTx` in `src/cache.js`) already downloads and permanently stores every block from the chain tip back to genesis. This plan adds a small extraction step to that same function (checking each transfer transaction's sender/recipient against a small in-memory watch map) plus a local-only (no network) backfill scan of the already-cached `blocks` table for any exchange address added later. Two new SQLite tables persist the results; two new routes render them using the app's existing hand-rolled inline-SVG chart style (no charting library).

**Tech Stack:** Node.js (ES modules), Express 5, `node:sqlite` (`DatabaseSync`), `node:test` + `node:assert/strict`, no new npm dependencies.

## Global Constraints

- No new dependencies — everything is built with what's already in `package.json` (`express`, `compression`, `@noble/hashes`, built-in `node:sqlite`/`node:test`).
- No new outbound HTTP calls of any kind for this feature. Every value must come from data NEMSCAN already fetches for other reasons (`richlist`, `blocks`).
- Mainnet only. Testnet must render the existing `unavailableOnTestnetHTML(label)` fragment for both new API routes, exactly like `/api/polls`, `/api/mosaictransfer`, `/api/accounts` already do.
- Follow existing file conventions exactly: `db.js` prepared-statement + `layer()` dispatch pattern, `cache.js`'s `console.error`-and-continue error handling, `html.js`'s inline-SVG chart style (no gridlines/legend, minimal labels), `index.js`'s `shell(...)`/`errorFrag(...)` route pattern.
- All new/updated tests use `node:test` + `node:assert/strict`, follow the existing per-file `NEMSCAN_DB_DIR` scratch-directory + dynamic-`import()` pattern (see the comment at the top of `test/db.test.js`/`test/cache.test.js`/`test/html.test.js`) so they never touch the real `cache.db`/`cache-testnet.db`.
- Spec reference: `docs/superpowers/specs/2026-09-05-exchange-flow-tracking-design.md`.

---

## Task 1: Shared helpers — `addrFromPubKey`, `matchExchangeName`, new constants

**Files:**
- Modify: `src/constants.js`
- Modify: `src/helpers.js`
- Modify: `src/html.js` (remove the now-duplicated private `addrFromPubKey`, import it from `helpers.js` instead)
- Test: `test/helpers.test.js`

**Interfaces:**
- Produces: `export function addrFromPubKey(hex): string|null` from `src/helpers.js` (resolves via `NETWORKS[currentNetwork()].addressNetworkByte`, same behavior as the function it replaces).
- Produces: `export function matchExchangeName(info: string|null): string|null` from `src/helpers.js` (case-insensitive substring match against `KNOWN_EXCHANGE_NAMES`; returns the matched canonical name, or `null`).
- Produces: `export const KNOWN_EXCHANGE_NAMES: string[]` and `export const EXCHANGE_BACKFILL_CHUNK_HEIGHTS: number` from `src/constants.js`.

- [ ] **Step 1: Add the two new constants to `src/constants.js`**

Append at the end of the file, after the `NETWORKS` export:

```js
// Substring-matched (case-insensitive) against nemnodes.org richlist `info`
// labels (e.g. "Coincheck -- Exchange", "Zaif -- Cold Wallet") to identify
// which richlist addresses belong to a known exchange. Deliberately a fixed
// list rather than "any non-empty info value" — labels like "Protocol
// Treasury Account" or contributor names must not be picked up.
export const KNOWN_EXCHANGE_NAMES = [
  "Binance", "Bittrex", "Coincheck", "Zaif", "Poloniex", "HitBTC",
  "Kucoin", "Cryptopia", "Yobit", "Kuna", "Qryptos", "Coinsuper",
  "Upbit", "Huobi", "Bitflyer",
];

// Height-range size for one chunk of the local blocks-table backfill scan
// that runs when a new exchange address is discovered (see
// backfillNewExchangeAddresses in cache.js). This is a local SQLite read,
// not a network call, so it can be far larger than the network-bound
// DAILY_TX_BACKFILL_CHUNK (60).
export const EXCHANGE_BACKFILL_CHUNK_HEIGHTS = 5000;
```

- [ ] **Step 2: Write the failing test for `matchExchangeName`**

Add to `test/helpers.test.js` (after the existing imports, add `matchExchangeName` to the import list from `../src/helpers.js`):

```js
test("matchExchangeName matches a known exchange name case-insensitively inside a richlist label", () => {
  assert.equal(matchExchangeName("Coincheck -- Exchange"), "Coincheck");
  assert.equal(matchExchangeName("ZAIF -- Cold Wallet"), "Zaif");
});

test("matchExchangeName returns null for labels that don't name a known exchange", () => {
  assert.equal(matchExchangeName("Protocol Treasury Account"), null);
  assert.equal(matchExchangeName(""), null);
  assert.equal(matchExchangeName(null), null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/helpers.test.js`
Expected: FAIL — `matchExchangeName is not defined` (not yet exported).

- [ ] **Step 4: Implement `matchExchangeName` and move `addrFromPubKey` into `src/helpers.js`**

In `src/helpers.js`, add imports and the two functions. The top of the file currently reads:

```js
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { NEM_EPOCH_MS } from "./constants.js";
```

Change it to:

```js
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { NEM_EPOCH_MS, NETWORKS, KNOWN_EXCHANGE_NAMES } from "./constants.js";
import { currentNetwork } from "./context.js";
```

Directly below the existing `export function pubKeyToAddress(hex, net = 0x68) { ... }` function, add:

```js
// Resolves the correct NIS1 address network byte (mainnet 0x68 / testnet
// 0x98) for the request currently being rendered. Moved here from html.js
// so cache.js can also resolve tx.signer addresses when extracting
// exchange inflow/outflow from cached block data.
export function addrFromPubKey(hex) {
  return pubKeyToAddress(hex, NETWORKS[currentNetwork()].addressNetworkByte);
}

// Case-insensitive substring match of a richlist `info` label against
// KNOWN_EXCHANGE_NAMES. Returns the matched canonical name, or null if the
// label doesn't name a known exchange (or is empty).
export function matchExchangeName(info) {
  if (!info) return null;
  const lower = info.toLowerCase();
  return KNOWN_EXCHANGE_NAMES.find((name) => lower.includes(name.toLowerCase())) ?? null;
}
```

- [ ] **Step 5: Update `src/html.js` to import `addrFromPubKey` instead of defining its own copy**

In `src/html.js`, the import block currently reads (around line 13):

```js
import {
  nemDate,
  timeAgo,
  truncKey,
  truncHash,
  pubKeyToAddress,
  xem,
  formatDiff,
  formatImportance,
  esc,
  decodeMsg,
} from "./helpers.js";
```

Change `pubKeyToAddress` to `addrFromPubKey`:

```js
import {
  nemDate,
  timeAgo,
  truncKey,
  truncHash,
  addrFromPubKey,
  xem,
  formatDiff,
  formatImportance,
  esc,
  decodeMsg,
} from "./helpers.js";
```

Then delete the now-redundant private function (around line 86-91):

```js
// Resolves the correct NIS1 address network byte (mainnet 0x68 / testnet
// 0x98) for the request currently being rendered. Replaces direct
// pubKeyToAddress(...) calls throughout this file.
function addrFromPubKey(hex) {
  return pubKeyToAddress(hex, NETWORKS[currentNetwork()].addressNetworkByte);
}
```

(Leave the `NETWORKS`/`currentNetwork` imports in `html.js` alone — both are still used elsewhere in the file, e.g. `networkSwitchHTML`.)

- [ ] **Step 6: Run the full test suite to verify nothing broke and the new test passes**

Run: `node --test`
Expected: PASS — all existing tests (including every `html.test.js` test that depends on `addrFromPubKey`-derived addresses, e.g. block signer rendering) plus the two new `matchExchangeName` tests.

- [ ] **Step 7: Also add a direct test confirming `addrFromPubKey` resolves per-network**

Add to `test/helpers.test.js` (add `addrFromPubKey` and `pubKeyToAddress` to the import list — `pubKeyToAddress` is already imported; also add `import { networkContext } from "../src/context.js";` near the top):

```js
test("addrFromPubKey resolves using the current network's address byte", () => {
  const hex =
    "17013b69a0194ff6d2699e830509ef491e9bbd65cb9ffdc935edd677a4d37b29";
  networkContext.run("mainnet", () => {
    assert.equal(addrFromPubKey(hex), pubKeyToAddress(hex, 0x68));
  });
  networkContext.run("testnet", () => {
    assert.equal(addrFromPubKey(hex), pubKeyToAddress(hex, 0x98));
  });
});
```

- [ ] **Step 8: Run the test file again**

Run: `node --test test/helpers.test.js`
Expected: PASS (4 tests: the original `pubKeyToAddress` test, the new `addrFromPubKey` test, and the two `matchExchangeName` tests).

- [ ] **Step 9: Commit**

```bash
git add src/constants.js src/helpers.js src/html.js test/helpers.test.js
git commit -m "$(cat <<'EOF'
Move addrFromPubKey to helpers.js, add exchange-name matching

Prep for exchange inflow/outflow tracking: cache.js needs the same
pubkey-to-address resolution html.js already had, and a shared
KNOWN_EXCHANGE_NAMES matcher to identify exchange wallets from richlist
labels.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015N8J7gx4x7QZxBsAeP5SsX
EOF
)"
```

---

## Task 2: DB schema and accessors

**Files:**
- Modify: `src/db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Consumes: nothing new (uses existing `blocks` table, existing `layer()`/`openDbLayer()` machinery).
- Produces (all exported from `src/db.js`, dispatching through `layer()` exactly like every other accessor in the file):
  - `upsertExchangeAddress(address, exchangeName, label)` — `INSERT OR IGNORE`, never overwrites an existing row.
  - `getExchangeAddresses()` → `{ address, exchange_name, label, backfilled }[]`.
  - `getExchangeAddressesNeedingBackfill()` → `{ address, exchange_name }[]` where `backfilled = 0`.
  - `markExchangeAddressBackfilled(address)`.
  - `bumpExchangeDailyFlow(date, address, inflow, outflow)` — accumulates.
  - `getExchangeDailyFlows(exchangeName, days)` → `{ date, inflow, outflow }[]`, ascending by date, at most `days` rows.
  - `getExchangeList()` → `{ exchange_name, address_count, inflow_7d, outflow_7d }[]`, ascending by `exchange_name`.
  - `getBlocksHeightRange()` → `{ minHeight: number|null, maxHeight: number|null }`.
  - `getBlocksInRange(from, to)` → `{ height, time_stamp, raw }[]`, ascending by height.

- [ ] **Step 1: Write the failing tests**

Add to `test/db.test.js`. First, extend the destructured import block at the top of the file to include the new functions:

```js
const {
  setCacheMeta,
  getCacheMeta,
  upsertBlock,
  getCachedBlock,
  upsertMosaicTransfer,
  getMosaicTransfers,
  getMosaicTransfersCount,
  getMaxMosaicTransferNo,
  upsertTxTypeArchive,
  getTxTypeArchive,
  getTxTypeArchiveCount,
  trimTxTypeArchive,
  upsertExchangeAddress,
  getExchangeAddresses,
  getExchangeAddressesNeedingBackfill,
  markExchangeAddressBackfilled,
  bumpExchangeDailyFlow,
  getExchangeDailyFlows,
  getExchangeList,
  getBlocksHeightRange,
  getBlocksInRange,
} = await import("../src/db.js");
```

Then append these tests at the end of the file:

```js
test("upsertExchangeAddress inserts a new address and getExchangeAddresses returns it", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NEXCHANGE1", "Coincheck", "Coincheck -- Exchange");
    const rows = getExchangeAddresses();
    assert.deepEqual(rows, [
      { address: "NEXCHANGE1", exchange_name: "Coincheck", label: "Coincheck -- Exchange", backfilled: 0 },
    ]);
  });
});

test("upsertExchangeAddress does not overwrite an existing row (dedup on conflict)", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NEXCHANGE2", "Zaif", "Zaif -- Cold Wallet");
    markExchangeAddressBackfilled("NEXCHANGE2");
    upsertExchangeAddress("NEXCHANGE2", "Zaif", "Zaif -- Cold Wallet (updated)");
    const row = getExchangeAddresses().find((r) => r.address === "NEXCHANGE2");
    assert.equal(row.backfilled, 1, "a second upsert must not reset backfilled back to 0");
    assert.equal(row.label, "Zaif -- Cold Wallet", "a second upsert must not overwrite the original label");
  });
});

test("getExchangeAddressesNeedingBackfill returns only rows with backfilled = 0", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NPENDING1", "Bittrex", "Bittrex -- Exchange Wallet");
    upsertExchangeAddress("NDONE1", "Huobi", "Huobi -- Exchange");
    markExchangeAddressBackfilled("NDONE1");
    const pending = getExchangeAddressesNeedingBackfill().map((r) => r.address);
    assert.ok(pending.includes("NPENDING1"));
    assert.ok(!pending.includes("NDONE1"));
  });
});

test("bumpExchangeDailyFlow accumulates inflow/outflow across repeated calls for the same date+address", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NFLOW1", "Kucoin", "Kucoin -- Exchange");
    bumpExchangeDailyFlow("2026-09-01", "NFLOW1", 1_000_000, 0);
    bumpExchangeDailyFlow("2026-09-01", "NFLOW1", 500_000, 200_000);
    bumpExchangeDailyFlow("2026-09-02", "NFLOW1", 0, 300_000);
    const rows = getExchangeDailyFlows("Kucoin", 30);
    assert.deepEqual(rows, [
      { date: "2026-09-01", inflow: 1_500_000, outflow: 200_000 },
      { date: "2026-09-02", inflow: 0, outflow: 300_000 },
    ]);
  });
});

test("getExchangeDailyFlows sums across multiple addresses that share one exchange_name", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NMULTI1", "Poloniex", "Poloniex -- Exchange");
    upsertExchangeAddress("NMULTI2", "Poloniex", "Poloniex -- Cold Wallet");
    bumpExchangeDailyFlow("2026-09-03", "NMULTI1", 1_000_000, 0);
    bumpExchangeDailyFlow("2026-09-03", "NMULTI2", 2_000_000, 500_000);
    const rows = getExchangeDailyFlows("Poloniex", 30);
    assert.deepEqual(rows, [{ date: "2026-09-03", inflow: 3_000_000, outflow: 500_000 }]);
  });
});

test("getExchangeDailyFlows caps to the most recent `days` rows, ascending", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NCAP1", "Yobit", "Yobit");
    for (const d of ["2026-08-01", "2026-08-02", "2026-08-03"]) {
      bumpExchangeDailyFlow(d, "NCAP1", 1, 0);
    }
    const rows = getExchangeDailyFlows("Yobit", 2);
    assert.deepEqual(rows.map((r) => r.date), ["2026-08-02", "2026-08-03"]);
  });
});

test("getExchangeList returns one row per exchange_name with address_count and 7-day totals", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NLIST1", "Upbit", "Upbit -- Exchange");
    upsertExchangeAddress("NLIST2", "Upbit", "Upbit -- Cold Wallet");
    const today = new Date().toISOString().slice(0, 10);
    bumpExchangeDailyFlow(today, "NLIST1", 1_000_000, 100_000);
    bumpExchangeDailyFlow(today, "NLIST2", 2_000_000, 0);
    const row = getExchangeList().find((r) => r.exchange_name === "Upbit");
    assert.equal(row.address_count, 2);
    assert.equal(row.inflow_7d, 3_000_000);
    assert.equal(row.outflow_7d, 100_000);
  });
});

test("exchange_addresses and exchange_daily_flows are isolated between mainnet and testnet", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NISO1", "HitBTC", "HitBTC");
  });
  networkContext.run("testnet", () => {
    assert.equal(getExchangeAddresses().find((r) => r.address === "NISO1"), undefined);
  });
});

test("getBlocksHeightRange returns null/null when no blocks are cached, and the actual min/max otherwise", () => {
  networkContext.run("testnet", () => {
    assert.deepEqual(getBlocksHeightRange(), { minHeight: null, maxHeight: null });
  });
  networkContext.run("mainnet", () => {
    upsertBlock(500, 500, JSON.stringify({ height: 500 }));
    upsertBlock(510, 510, JSON.stringify({ height: 510 }));
    upsertBlock(505, 505, JSON.stringify({ height: 505 }));
    assert.deepEqual(getBlocksHeightRange(), { minHeight: 500, maxHeight: 510 });
  });
});

test("getBlocksInRange returns rows within [from, to] ascending by height", () => {
  networkContext.run("mainnet", () => {
    upsertBlock(700, 700, JSON.stringify({ height: 700, marker: "a" }));
    upsertBlock(705, 705, JSON.stringify({ height: 705, marker: "b" }));
    upsertBlock(710, 710, JSON.stringify({ height: 710, marker: "c" }));
    const rows = getBlocksInRange(701, 709);
    assert.deepEqual(rows.map((r) => r.height), [705]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/db.test.js`
Expected: FAIL — `upsertExchangeAddress is not a function` (not yet exported).

- [ ] **Step 3: Add the schema to `openDbLayer()` in `src/db.js`**

Inside the `db.exec(\`...\`)` template string in `openDbLayer()`, immediately after the existing `mosaic_transfers` / `idx_mosaic_transfers_ns_mosaic` block and before the `tx_type_archive` table, add:

```sql
    CREATE TABLE IF NOT EXISTS exchange_addresses (
      address TEXT PRIMARY KEY,
      exchange_name TEXT NOT NULL,
      label TEXT,
      backfilled INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_exchange_addresses_name ON exchange_addresses(exchange_name);
    CREATE TABLE IF NOT EXISTS exchange_daily_flows (
      date TEXT NOT NULL,
      address TEXT NOT NULL,
      inflow INTEGER NOT NULL DEFAULT 0,
      outflow INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, address)
    );
    CREATE INDEX IF NOT EXISTS idx_exchange_daily_flows_date ON exchange_daily_flows(date);
```

- [ ] **Step 4: Add prepared statements**

Inside `openDbLayer()`, after the existing `_ttaTrimStmt` declaration and before the `return { ... }` block, add:

```js
  const _exAddrUpsertStmt = db.prepare(
    "INSERT OR IGNORE INTO exchange_addresses (address, exchange_name, label, backfilled) VALUES (?, ?, ?, 0)",
  );
  const _exAddrAllStmt = db.prepare(
    "SELECT address, exchange_name, label, backfilled FROM exchange_addresses ORDER BY address ASC",
  );
  const _exAddrPendingStmt = db.prepare(
    "SELECT address, exchange_name FROM exchange_addresses WHERE backfilled = 0",
  );
  const _exAddrMarkBackfilledStmt = db.prepare(
    "UPDATE exchange_addresses SET backfilled = 1 WHERE address = ?",
  );
  const _exFlowBumpStmt = db.prepare(`
    INSERT INTO exchange_daily_flows (date, address, inflow, outflow) VALUES (?, ?, ?, ?)
    ON CONFLICT(date, address) DO UPDATE SET inflow = inflow + excluded.inflow, outflow = outflow + excluded.outflow
  `);
  const _exFlowByExchangeStmt = db.prepare(`
    SELECT f.date AS date, SUM(f.inflow) AS inflow, SUM(f.outflow) AS outflow
    FROM exchange_daily_flows f
    JOIN exchange_addresses a ON a.address = f.address
    WHERE a.exchange_name = ?
    GROUP BY f.date
    ORDER BY f.date DESC
    LIMIT ?
  `);
  const _exListStmt = db.prepare(`
    SELECT
      a.exchange_name AS exchange_name,
      COUNT(DISTINCT a.address) AS address_count,
      COALESCE(SUM(CASE WHEN f.date >= date('now', '-7 day') THEN f.inflow ELSE 0 END), 0) AS inflow_7d,
      COALESCE(SUM(CASE WHEN f.date >= date('now', '-7 day') THEN f.outflow ELSE 0 END), 0) AS outflow_7d
    FROM exchange_addresses a
    LEFT JOIN exchange_daily_flows f ON f.address = a.address
    GROUP BY a.exchange_name
    ORDER BY a.exchange_name ASC
  `);
  const _blocksRangeStmt = db.prepare(
    "SELECT MIN(height) AS minHeight, MAX(height) AS maxHeight FROM blocks",
  );
  const _blocksInRangeStmt = db.prepare(
    "SELECT height, time_stamp, raw FROM blocks WHERE height BETWEEN ? AND ? ORDER BY height ASC",
  );
```

- [ ] **Step 5: Add the accessors to the returned layer object**

Inside the `return { ... }` object literal in `openDbLayer()`, after the existing `upsertTxTypeArchive: (...) => ...,` line, add:

```js
    upsertExchangeAddress: (address, exchangeName, label) =>
      _exAddrUpsertStmt.run(address, exchangeName, label),
    getExchangeAddresses: () => _exAddrAllStmt.all(),
    getExchangeAddressesNeedingBackfill: () => _exAddrPendingStmt.all(),
    markExchangeAddressBackfilled: (address) => _exAddrMarkBackfilledStmt.run(address),
    bumpExchangeDailyFlow: (date, address, inflow, outflow) =>
      _exFlowBumpStmt.run(date, address, inflow, outflow),
    getExchangeDailyFlows: (exchangeName, days) =>
      _exFlowByExchangeStmt.all(exchangeName, days).reverse(),
    getExchangeList: () => _exListStmt.all(),
    getBlocksHeightRange: () => _blocksRangeStmt.get(),
    getBlocksInRange: (from, to) => _blocksInRangeStmt.all(from, to),
```

- [ ] **Step 6: Add the top-level exported wrapper functions**

At the end of `src/db.js` (after the existing `upsertTxTypeArchive` wrapper, before the final `getDb()` export), add:

```js
export function upsertExchangeAddress(address, exchangeName, label) {
  layer().upsertExchangeAddress(address, exchangeName, label);
}
export function getExchangeAddresses() {
  return layer().getExchangeAddresses();
}
export function getExchangeAddressesNeedingBackfill() {
  return layer().getExchangeAddressesNeedingBackfill();
}
export function markExchangeAddressBackfilled(address) {
  layer().markExchangeAddressBackfilled(address);
}
export function bumpExchangeDailyFlow(date, address, inflow, outflow) {
  layer().bumpExchangeDailyFlow(date, address, inflow, outflow);
}
export function getExchangeDailyFlows(exchangeName, days) {
  return layer().getExchangeDailyFlows(exchangeName, days);
}
export function getExchangeList() {
  return layer().getExchangeList();
}
export function getBlocksHeightRange() {
  return layer().getBlocksHeightRange();
}
export function getBlocksInRange(from, to) {
  return layer().getBlocksInRange(from, to);
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/db.test.js`
Expected: PASS (all new tests, plus every pre-existing test in the file).

- [ ] **Step 8: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "$(cat <<'EOF'
Add exchange_addresses and exchange_daily_flows tables

Schema and accessors for tracking known exchange wallet addresses and
their daily XEM inflow/outflow, plus getBlocksHeightRange/getBlocksInRange
for scanning the already-cached blocks table locally.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015N8J7gx4x7QZxBsAeP5SsX
EOF
)"
```

---

## Task 3: Live flow extraction hook in `scanBlockHeightsForDailyTx`

**Files:**
- Modify: `src/cache.js`
- Test: `test/cache.test.js`

**Interfaces:**
- Consumes: `getExchangeAddresses()`, `bumpExchangeDailyFlow(date, address, inflow, outflow)` (Task 2); `addrFromPubKey(hex)` (Task 1); `dateKeyFromTs(ts)` (already imported in `cache.js`).
- Produces: `export function extractExchangeFlowsFromBlock(block, watchMap)` from `src/cache.js` — `watchMap` is a `Map<address, exchangeName>`; scans `block.transactions` for `type === 257` entries and calls `bumpExchangeDailyFlow` for any sender/recipient present in `watchMap`. No-ops immediately if `watchMap.size === 0`. Later tasks (Task 4's backfill) reuse this exact function.
- Modifies: `scanBlockHeightsForDailyTx(heights)` — now builds one `watchMap` per call (via `getExchangeAddresses()`) and calls `extractExchangeFlowsFromBlock` for every successfully-fetched block, immediately after the existing `upsertBlock(...)` call.

- [ ] **Step 1: Write the failing tests**

Add `upsertExchangeAddress`, `getExchangeDailyFlows` to the dynamic `db.js` import block near the top of `test/cache.test.js` (currently `const { getCachedBlock, getCacheMeta, getMosaicTransfers, getMaxMosaicTransferNo, getTxTypeArchiveCount, getTxTypeArchive, upsertTxTypeArchive } = await import("../src/db.js");`):

```js
const {
  getCachedBlock,
  getCacheMeta,
  getMosaicTransfers,
  getMaxMosaicTransferNo,
  getTxTypeArchiveCount,
  getTxTypeArchive,
  upsertTxTypeArchive,
  upsertExchangeAddress,
  getExchangeDailyFlows,
} = await import("../src/db.js");
```

Add `extractExchangeFlowsFromBlock` to the top-of-file dynamic `cache.js` import block (add it alongside `scanBlockHeightsForDailyTx`, in the same destructure), and add a dynamic import of `helpers.js` right after the existing `constants.js` dynamic import (same hoisting reasoning — `helpers.js` imports `constants.js`, which reads `NEMSCAN_DB_DIR` at import time):

```js
const { addrFromPubKey } = await import("../src/helpers.js");
```

Then append these tests to `test/cache.test.js`:

```js
test("extractExchangeFlowsFromBlock records outflow for a watched sender and inflow for a watched recipient", () => {
  networkContext.run("mainnet", () => {
    const signerHex =
      "17013b69a0194ff6d2699e830509ef491e9bbd65cb9ffdc935edd677a4d37b29";
    const senderAddr = addrFromPubKey(signerHex);
    const watchMap = new Map([
      [senderAddr, "TestEx"],
      ["NRECIPIENT1", "OtherEx"],
    ]);
    const block = {
      timeStamp: 5000,
      transactions: [
        { type: 257, signer: signerHex, recipient: "NUNWATCHED", amount: 4_000_000 },
        { type: 257, signer: "aa".repeat(32), recipient: "NRECIPIENT1", amount: 2_000_000 },
        { type: 4100, signer: signerHex, recipient: "NRECIPIENT1", amount: 999 },
      ],
    };
    extractExchangeFlowsFromBlock(block, watchMap);
    const senderFlows = getExchangeDailyFlows("TestEx", 5);
    assert.equal(senderFlows.length, 1);
    assert.equal(senderFlows[0].outflow, 4_000_000);
    assert.equal(senderFlows[0].inflow, 0);
    const recipientFlows = getExchangeDailyFlows("OtherEx", 5);
    assert.equal(recipientFlows.length, 1);
    assert.equal(recipientFlows[0].inflow, 2_000_000);
    assert.equal(recipientFlows[0].outflow, 0);
  });
});

test("extractExchangeFlowsFromBlock is a no-op for an empty watch map", () => {
  assert.doesNotThrow(() =>
    extractExchangeFlowsFromBlock(
      { timeStamp: 1, transactions: [{ type: 257, signer: "aa".repeat(32), recipient: "N", amount: 1 }] },
      new Map(),
    ),
  );
});

test("scanBlockHeightsForDailyTx records exchange flows for a currently-watched address", async (t) => {
  const signerHex =
    "17013b69a0194ff6d2699e830509ef491e9bbd65cb9ffdc935edd677a4d37b29";
  await networkContext.run("mainnet", async () => {
    const exchangeAddr = addrFromPubKey(signerHex);
    upsertExchangeAddress(exchangeAddr, "LiveHookEx", "LiveHookEx -- Exchange");

    t.mock.method(global, "fetch", async (url, opts) => {
      const { height } = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          height,
          timeStamp: 6000,
          transactions: [
            { type: 257, signer: signerHex, recipient: "NSOMEONE", amount: 7_000_000 },
          ],
        }),
      };
    });

    await scanBlockHeightsForDailyTx([900]);
    const rows = getExchangeDailyFlows("LiveHookEx", 5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outflow, 7_000_000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cache.test.js`
Expected: FAIL — `extractExchangeFlowsFromBlock is not a function` (not yet exported from `src/cache.js`).

- [ ] **Step 3: Implement `extractExchangeFlowsFromBlock` in `src/cache.js`**

Add `addrFromPubKey` to the existing `helpers.js` import in `src/cache.js` (currently `import { dateKeyFromTs } from "./helpers.js";`):

```js
import { dateKeyFromTs, addrFromPubKey } from "./helpers.js";
```

Add `getExchangeAddresses, bumpExchangeDailyFlow` to the existing `db.js` import block at the top of `src/cache.js`.

Then, directly above `scanBlockHeightsForDailyTx` (before its existing comment block), add:

```js
// Scans one already-fetched block's Transfer transactions (type 257) for
// senders/recipients present in `watchMap` (Map<address, exchangeName>),
// recording outflow for a watched sender and inflow for a watched
// recipient. Shared by the live hook below and backfillNewExchangeAddresses
// (see the "Transaction type archive" section further down this file) —
// both just build a different watchMap and call this the same way. No
// mosaic-only transfers or multisig-wrapped transfers are unwrapped; only
// tx.amount (native XEM) on a bare type-257 transaction counts.
export function extractExchangeFlowsFromBlock(block, watchMap) {
  if (!watchMap.size) return;
  const dateKey = dateKeyFromTs(block.timeStamp);
  for (const tx of block.transactions || []) {
    if (tx.type !== 257) continue;
    const amount = tx.amount || 0;
    const sender = addrFromPubKey(tx.signer);
    if (watchMap.has(sender)) bumpExchangeDailyFlow(dateKey, sender, 0, amount);
    if (watchMap.has(tx.recipient)) bumpExchangeDailyFlow(dateKey, tx.recipient, amount, 0);
  }
}
```

- [ ] **Step 4: Wire it into `scanBlockHeightsForDailyTx`**

Change:

```js
export async function scanBlockHeightsForDailyTx(heights) {
  const BATCH = 10;
  for (let i = 0; i < heights.length; i += BATCH) {
    const batch = heights.slice(i, i + BATCH);
    const blocks = await Promise.all(
      batch.map((h) => fetchBlockRaw(h).catch(() => null)),
    );
    for (const block of blocks) {
      if (!block?.timeStamp) continue;
      bumpDailyTxCount(
        dateKeyFromTs(block.timeStamp),
        (block.transactions || []).length,
      );
      try {
        upsertBlock(block.height, block.timeStamp, JSON.stringify(block));
      } catch (err) {
        console.error("Block persistence failed:", err.message);
      }
    }
    if (i + BATCH < heights.length)
      await new Promise((r) => setTimeout(r, ARCHIVE_PAGE_DELAY_MS));
  }
}
```

to:

```js
export async function scanBlockHeightsForDailyTx(heights) {
  const BATCH = 10;
  const exchangeWatchMap = new Map(
    getExchangeAddresses().map((r) => [r.address, r.exchange_name]),
  );
  for (let i = 0; i < heights.length; i += BATCH) {
    const batch = heights.slice(i, i + BATCH);
    const blocks = await Promise.all(
      batch.map((h) => fetchBlockRaw(h).catch(() => null)),
    );
    for (const block of blocks) {
      if (!block?.timeStamp) continue;
      bumpDailyTxCount(
        dateKeyFromTs(block.timeStamp),
        (block.transactions || []).length,
      );
      try {
        upsertBlock(block.height, block.timeStamp, JSON.stringify(block));
      } catch (err) {
        console.error("Block persistence failed:", err.message);
      }
      extractExchangeFlowsFromBlock(block, exchangeWatchMap);
    }
    if (i + BATCH < heights.length)
      await new Promise((r) => setTimeout(r, ARCHIVE_PAGE_DELAY_MS));
  }
}
```

(`getExchangeAddresses()` is called once per `scanBlockHeightsForDailyTx` invocation, not per block — the table is always tiny (a few dozen rows at most), so this is cheap. On testnet the table is permanently empty since exchange addresses are only ever synced from the mainnet-only richlist, so `exchangeWatchMap` there is always empty and `extractExchangeFlowsFromBlock` no-ops immediately.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/cache.test.js`
Expected: PASS (all three new tests, plus every pre-existing test in the file — in particular `scanBlockHeightsForDailyTx persists each fetched block to the blocks table` and the genesis-backfill test must still pass unchanged).

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cache.js test/cache.test.js
git commit -m "$(cat <<'EOF'
Extract exchange inflow/outflow from the existing block-persistence hook

scanBlockHeightsForDailyTx already fetches and stores every block from tip
to genesis for daily_tx_counts/blocks. Piggyback exchange flow extraction
on that same pass instead of adding any new network calls: build a small
watch map from exchange_addresses once per call and record inflow/outflow
for any watched sender/recipient in each block's Transfer transactions.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015N8J7gx4x7QZxBsAeP5SsX
EOF
)"
```

---

## Task 4: Richlist-derived address sync + local backfill for new addresses

**Files:**
- Modify: `src/cache.js`
- Test: `test/cache.test.js`

**Interfaces:**
- Consumes: `matchExchangeName(info)` (Task 1); `getCachedRichList`, `getCachedRichListCount`, `upsertExchangeAddress`, `getExchangeAddressesNeedingBackfill`, `markExchangeAddressBackfilled`, `getBlocksHeightRange`, `getBlocksInRange` (Task 2); `extractExchangeFlowsFromBlock` (Task 3).
- Produces: `export function syncExchangeAddressesFromRichList()` and `export async function backfillNewExchangeAddresses()` from `src/cache.js`.
- Modifies: `refreshRichListCache()` to call both, in order, after its existing richlist-row upsert loop.

- [ ] **Step 1: Write the failing tests**

Add `matchExchangeName` to the dynamic `helpers.js` import added in Task 3 (`const { addrFromPubKey, matchExchangeName } = await import("../src/helpers.js");` — note `matchExchangeName` itself doesn't need testing again here, it already has direct unit tests in `test/helpers.test.js`).

Add `getCachedRichList, upsertRichListEntry, getExchangeAddresses, getExchangeAddressesNeedingBackfill` to the dynamic `db.js` import block in `test/cache.test.js`.

Add `syncExchangeAddressesFromRichList, backfillNewExchangeAddresses, refreshRichListCache` to the dynamic `cache.js` import block.

Then append:

```js
test("syncExchangeAddressesFromRichList registers only richlist rows whose info matches a known exchange name", () => {
  networkContext.run("mainnet", () => {
    upsertRichListEntry(1, "NKNOWN1", 1_000_000, "Bittrex -- Exchange Wallet");
    upsertRichListEntry(2, "NUNKNOWN1", 2_000_000, "Protocol Treasury Account");
    upsertRichListEntry(3, "NKNOWN2", 3_000_000, "");
    syncExchangeAddressesFromRichList();
    const addrs = getExchangeAddresses().map((r) => r.address);
    assert.ok(addrs.includes("NKNOWN1"));
    assert.ok(!addrs.includes("NUNKNOWN1"));
    assert.ok(!addrs.includes("NKNOWN2"));
    const row = getExchangeAddresses().find((r) => r.address === "NKNOWN1");
    assert.equal(row.exchange_name, "Bittrex");
  });
});

test("syncExchangeAddressesFromRichList is idempotent — running it twice doesn't duplicate or reset rows", () => {
  networkContext.run("mainnet", () => {
    upsertRichListEntry(4, "NIDEMPOTENT1", 1, "Yobit");
    syncExchangeAddressesFromRichList();
    markExchangeAddressBackfilled("NIDEMPOTENT1");
    syncExchangeAddressesFromRichList();
    const row = getExchangeAddresses().find((r) => r.address === "NIDEMPOTENT1");
    assert.equal(row.backfilled, 1);
  });
});

test("backfillNewExchangeAddresses scans existing cached blocks for a newly-added address and marks it backfilled", async () => {
  await networkContext.run("mainnet", async () => {
    const signerHex =
      "17013b69a0194ff6d2699e830509ef491e9bbd65cb9ffdc935edd677a4d37b29";
    const exchangeAddr = addrFromPubKey(signerHex);

    upsertBlock(2000, 8000, JSON.stringify({
      height: 2000,
      timeStamp: 8000,
      transactions: [{ type: 257, signer: signerHex, recipient: "NSOMEONE2", amount: 9_000_000 }],
    }));
    upsertBlock(2001, 8001, JSON.stringify({ height: 2001, timeStamp: 8001, transactions: [] }));

    upsertExchangeAddress(exchangeAddr, "BackfillEx", "BackfillEx -- Exchange");
    await backfillNewExchangeAddresses();

    const rows = getExchangeDailyFlows("BackfillEx", 5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outflow, 9_000_000);
    assert.equal(getExchangeAddressesNeedingBackfill().find((r) => r.address === exchangeAddr), undefined);
  });
});

test("backfillNewExchangeAddresses is a no-op when there is nothing pending", async () => {
  await networkContext.run("mainnet", async () => {
    await assert.doesNotReject(() => backfillNewExchangeAddresses());
  });
});

test("refreshRichListCache also syncs and backfills exchange addresses", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    status: 200,
    text: async () =>
      '<tr class="d0"><td>1</td><td>NWIRED1</td><td class="rght">x</td><td class="rght">123</td><td>Kuna -- Exchange</td></tr>',
  }));
  await networkContext.run("mainnet", async () => {
    await refreshRichListCache();
    const row = getExchangeAddresses().find((r) => r.address === "NWIRED1");
    assert.ok(row, "expected refreshRichListCache to have registered the Kuna address");
    assert.equal(row.exchange_name, "Kuna");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cache.test.js`
Expected: FAIL — `syncExchangeAddressesFromRichList is not a function`.

- [ ] **Step 3: Implement `syncExchangeAddressesFromRichList`**

Add `getCachedRichList` (already imported), `matchExchangeName` (new, from `helpers.js`), `upsertExchangeAddress`, `getExchangeAddressesNeedingBackfill`, `markExchangeAddressBackfilled`, `getBlocksHeightRange`, `getBlocksInRange` to `src/cache.js`'s import blocks:

```js
import { dateKeyFromTs, addrFromPubKey, matchExchangeName } from "./helpers.js";
```

And in the `db.js` import block, add: `upsertExchangeAddress, getExchangeAddressesNeedingBackfill, markExchangeAddressBackfilled, getBlocksHeightRange, getBlocksInRange` (alongside `getExchangeAddresses, bumpExchangeDailyFlow` from Task 3).

Also add `EXCHANGE_BACKFILL_CHUNK_HEIGHTS` to the `constants.js` import block in `src/cache.js`.

Then, directly below the existing `refreshRichListCache` function, add:

```js
// Derives exchange_addresses from the richlist cache's `info` labels
// (see matchExchangeName). Safe to call repeatedly — upsertExchangeAddress
// is INSERT OR IGNORE, so a row already marked backfilled stays that way.
export function syncExchangeAddressesFromRichList() {
  const total = getCachedRichListCount();
  if (!total) return;
  for (const row of getCachedRichList(total)) {
    const name = matchExchangeName(row.info);
    if (name) upsertExchangeAddress(row.address, name, row.info);
  }
}

// For every exchange address not yet backfilled, scans the *already
// locally cached* blocks table (no network calls) in fixed-size height
// chunks, extracting historical inflow/outflow the same way the live hook
// in scanBlockHeightsForDailyTx does, then marks each address backfilled.
// Chunked with a yield between ranges because node:sqlite's DatabaseSync
// is synchronous — a single unchunked full-table read would block the
// event loop for as long as deserializing every cached block takes.
export async function backfillNewExchangeAddresses() {
  const pending = getExchangeAddressesNeedingBackfill();
  if (!pending.length) return;
  const { minHeight, maxHeight } = getBlocksHeightRange();
  if (minHeight == null) return;
  const watchMap = new Map(pending.map((r) => [r.address, r.exchange_name]));
  for (let from = minHeight; from <= maxHeight; from += EXCHANGE_BACKFILL_CHUNK_HEIGHTS) {
    const to = Math.min(from + EXCHANGE_BACKFILL_CHUNK_HEIGHTS - 1, maxHeight);
    for (const row of getBlocksInRange(from, to)) {
      extractExchangeFlowsFromBlock(JSON.parse(row.raw), watchMap);
    }
    await new Promise((r) => setImmediate(r));
  }
  for (const { address } of pending) markExchangeAddressBackfilled(address);
}
```

- [ ] **Step 4: Wire both into `refreshRichListCache()`**

Change:

```js
let _refreshingRichList = false;
export async function refreshRichListCache() {
  if (_refreshingRichList) return;
  _refreshingRichList = true;
  try {
    const rows = await fetchRichListFromSource();
    for (const r of rows) {
      upsertRichListEntry(r.rank, r.address, r.balance, r.info);
    }
    setCacheMeta("richlist_updated_at", Date.now());
  } catch (err) {
    console.error("Rich list cache refresh failed:", err.message);
  } finally {
    _refreshingRichList = false;
  }
}
```

to:

```js
let _refreshingRichList = false;
export async function refreshRichListCache() {
  if (_refreshingRichList) return;
  _refreshingRichList = true;
  try {
    const rows = await fetchRichListFromSource();
    for (const r of rows) {
      upsertRichListEntry(r.rank, r.address, r.balance, r.info);
    }
    setCacheMeta("richlist_updated_at", Date.now());
    syncExchangeAddressesFromRichList();
    await backfillNewExchangeAddresses();
  } catch (err) {
    console.error("Rich list cache refresh failed:", err.message);
  } finally {
    _refreshingRichList = false;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/cache.test.js`
Expected: PASS (all new tests, plus every pre-existing test in the file).

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cache.js test/cache.test.js
git commit -m "$(cat <<'EOF'
Sync exchange addresses from richlist and backfill their history locally

refreshRichListCache now also derives exchange_addresses from the
richlist's info labels and, for any newly-discovered address, scans the
already-cached blocks table (no network calls) to backfill its historical
inflow/outflow before marking it backfilled.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015N8J7gx4x7QZxBsAeP5SsX
EOF
)"
```

---

## Task 5: HTML — exchange overview page content

**Files:**
- Modify: `src/html.js`
- Modify: `public/style.css`
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: `getExchangeList()`, `getExchangeDailyFlows(exchangeName, days)` (Task 2).
- Produces: `export function heroExchanges()`, `export function exchangeMiniFlowChartHTML(data)`, `export function exchangeOverviewHTML(list)` from `src/html.js`. `exchangeOverviewHTML` calls `getExchangeDailyFlows` itself (one call per exchange in `list`), matching how other list-HTML functions in this file read directly from `db.js` rather than being handed pre-fetched per-row data.

- [ ] **Step 1: Write the failing tests**

Add `heroExchanges, exchangeMiniFlowChartHTML, exchangeOverviewHTML` to the destructured import from `../src/html.js` in `test/html.test.js`, and `upsertExchangeAddress, bumpExchangeDailyFlow` to the `../src/db.js` import.

Append:

```js
test("heroExchanges renders a simple title hero", () => {
  assert.match(heroExchanges(), /<h1>Exchanges<\/h1>/);
});

test("exchangeMiniFlowChartHTML shows a collecting-data placeholder for fewer than 2 days of data", () => {
  assert.match(exchangeMiniFlowChartHTML([]), /Collecting data/);
  assert.match(exchangeMiniFlowChartHTML([{ date: "2026-09-01", inflow: 1, outflow: 0 }]), /Collecting data/);
});

test("exchangeMiniFlowChartHTML renders one point per day of data as an SVG polyline", () => {
  const html = exchangeMiniFlowChartHTML([
    { date: "2026-09-01", inflow: 1_000_000, outflow: 200_000 },
    { date: "2026-09-02", inflow: 500_000, outflow: 900_000 },
    { date: "2026-09-03", inflow: 2_000_000, outflow: 0 },
  ]);
  assert.match(html, /<svg class="exchange-mini-chart"/);
  const points = html.match(/points="([^"]+)"/)[1].trim().split(/\s+/);
  assert.equal(points.length, 3);
});

test("exchangeOverviewHTML shows an empty state when no exchanges are tracked yet", () => {
  const html = exchangeOverviewHTML([]);
  assert.match(html, /class="empty-state"/);
});

test("exchangeOverviewHTML renders a card per exchange with its 7-day totals and a link to its detail page", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NCARD1", "Bitflyer", "Bitflyer -- Exchange");
    bumpExchangeDailyFlow("2026-09-01", "NCARD1", 5_000_000, 1_000_000);
    const html = exchangeOverviewHTML([
      { exchange_name: "Bitflyer", address_count: 1, inflow_7d: 5_000_000, outflow_7d: 1_000_000 },
    ]);
    assert.match(html, /Bitflyer/);
    assert.match(html, /href="\/exchange\/Bitflyer"/);
    assert.match(html, /5\.00/); // xem() formats 5,000,000 micro-XEM as "5.00"
    assert.match(html, /1\.00/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/html.test.js`
Expected: FAIL — `heroExchanges is not defined`.

- [ ] **Step 3: Add `getExchangeList`/`getExchangeDailyFlows` to `src/html.js`'s `db.js` import**

Change the top-of-file `db.js` import block in `src/html.js` to also pull in `getExchangeDailyFlows` (note: `exchangeOverviewHTML` takes `list` as a parameter rather than calling `getExchangeList()` itself, so only `getExchangeDailyFlows` is needed here — the route handler in Task 7 calls `getExchangeList()`):

```js
import {
  getCacheMeta,
  getArchivedNamespacesCount,
  getArchivedMosaicsCount,
  getDailyTxCounts,
  getNamespacesWithArchiveCount,
  getMosaicsWithArchiveCount,
  getMosaicTransfersCount,
  getTxTypeArchiveCount,
  getExchangeDailyFlows,
} from "./db.js";
```

- [ ] **Step 4: Implement the three functions**

Add, near `heroAccounts()` (after it):

```js
export function heroExchanges() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Exchanges</h1>
  </div></div>`;
}
```

Add, near `dailyTxChartHTML` (after it) — a smaller single-line net-flow sparkline reusing that function's approach:

```js
// Same minimal-SVG-line approach as dailyTxChartHTML, plotting net flow
// (inflow - outflow) per day for one exchange's overview card.
export function exchangeMiniFlowChartHTML(data) {
  if (data.length < 2)
    return `<div class="daily-tx-empty">Collecting data&hellip;</div>`;
  const vals = data.map((d) => d.inflow - d.outflow);
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals, 0);
  const range = max - min || 1;
  const W = 260, padX = 4, top = 4, bottom = 46;
  const stepX = (W - padX * 2) / (data.length - 1);
  const points = vals
    .map((v, i) => {
      const x = padX + i * stepX;
      const y = bottom - ((v - min) / range) * (bottom - top);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="exchange-mini-chart" viewBox="0 0 ${W} 50" role="img" aria-label="Net flow trend">
    <polyline class="exchange-mini-line" points="${points}"/>
  </svg>`;
}

export function exchangeOverviewHTML(list) {
  if (!list.length) {
    return `<div class="empty-state">No known exchange addresses tracked yet.</div>`;
  }
  const cards = list
    .map((e) => {
      const daily = getExchangeDailyFlows(e.exchange_name, 14);
      return `<a class="exchange-card" href="/exchange/${encodeURIComponent(e.exchange_name)}">
      <div class="exchange-card-head">
        <div class="exchange-card-name">${esc(e.exchange_name)}</div>
        <div class="exchange-card-addrs">${e.address_count} address${e.address_count === 1 ? "" : "es"}</div>
      </div>
      <div class="exchange-card-stats">
        <div class="exchange-card-stat"><span class="exchange-stat-label">7D IN</span><span class="exchange-stat-val in">${xem(e.inflow_7d)} XEM</span></div>
        <div class="exchange-card-stat"><span class="exchange-stat-label">7D OUT</span><span class="exchange-stat-val out">${xem(e.outflow_7d)} XEM</span></div>
      </div>
      ${exchangeMiniFlowChartHTML(daily)}
    </a>`;
    })
    .join("");
  return `<div class="exchange-grid">${cards}</div>`;
}
```

- [ ] **Step 5: Add CSS**

Append to `public/style.css`, after the `.daily-tx-empty { ... }` block:

```css
.exchange-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 14px;
    padding: 16px;
}
.exchange-card {
    display: block;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    text-decoration: none;
    color: inherit;
    transition: border-color .15s;
}
.exchange-card:hover {
    border-color: var(--link);
}
.exchange-card-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 10px;
}
.exchange-card-name {
    font-weight: 600;
    font-size: 15px;
}
.exchange-card-addrs {
    font-size: 11px;
    color: var(--muted);
}
.exchange-card-stats {
    display: flex;
    gap: 16px;
    margin-bottom: 8px;
}
.exchange-card-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.exchange-stat-label {
    font-size: 10px;
    letter-spacing: .05em;
    color: var(--muted);
}
.exchange-stat-val.in {
    color: var(--green);
    font-weight: 600;
    font-size: 13px;
}
.exchange-stat-val.out {
    color: var(--red);
    font-weight: 600;
    font-size: 13px;
}
.exchange-mini-chart {
    display: block;
    width: 100%;
    height: auto;
}
.exchange-mini-chart .exchange-mini-line {
    fill: none;
    stroke: var(--link);
    stroke-width: 2;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/html.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/html.js public/style.css test/html.test.js
git commit -m "$(cat <<'EOF'
Add exchange overview page rendering (cards + mini net-flow sparkline)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015N8J7gx4x7QZxBsAeP5SsX
EOF
)"
```

---

## Task 6: HTML — exchange detail page (bar chart) + nav link

**Files:**
- Modify: `src/html.js`
- Modify: `public/style.css`
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: nothing new from other modules (`esc`, `xem` already imported in `html.js`).
- Produces: `export function heroExchange(name)`, `export function exchangeFlowChartHTML(data)`, `export function exchangeDetailHTML(name, data)`, `export function exchangeNotFoundHTML(name)` from `src/html.js`.
- Modifies: `navHTML`'s `links` array (adds `["/exchanges", "Exchanges"]`).

- [ ] **Step 1: Write the failing tests**

Add `heroExchange, exchangeFlowChartHTML, exchangeDetailHTML, exchangeNotFoundHTML` to the `../src/html.js` import in `test/html.test.js`.

Append:

```js
test("heroExchange renders the exchange name as the title", () => {
  assert.match(heroExchange("Coincheck"), /<h1>Coincheck<\/h1>/);
});

test("exchangeFlowChartHTML shows a collecting-data placeholder with no data", () => {
  assert.match(exchangeFlowChartHTML([]), /Collecting data/);
});

test("exchangeFlowChartHTML renders one inflow bar and one outflow bar per day", () => {
  const html = exchangeFlowChartHTML([
    { date: "2026-09-01", inflow: 1_000_000, outflow: 200_000 },
    { date: "2026-09-02", inflow: 0, outflow: 900_000 },
  ]);
  assert.equal((html.match(/class="flow-bar-in"/g) || []).length, 2);
  assert.equal((html.match(/class="flow-bar-out"/g) || []).length, 2);
});

test("exchangeDetailHTML includes the chart and the exchange name", () => {
  const html = exchangeDetailHTML("Zaif", [{ date: "2026-09-01", inflow: 1, outflow: 1 }]);
  assert.match(html, /Zaif/);
  assert.match(html, /class="exchange-flow-chart"/);
});

test("exchangeNotFoundHTML names the missing exchange", () => {
  assert.match(exchangeNotFoundHTML("Nope"), /Nope/);
});

test("navHTML includes an Exchanges link", () => {
  assert.match(navHTML("/exchanges"), /href="\/exchanges"[^>]*class="active"[^>]*>Exchanges</);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/html.test.js`
Expected: FAIL — `heroExchange is not defined`.

- [ ] **Step 3: Implement the functions**

Add, directly after `heroExchanges()`:

```js
export function heroExchange(name) {
  return `<div class="hero"><div class="hero-inner">
    <h1>${esc(name)}</h1>
  </div></div>`;
}
```

Add, directly after `exchangeMiniFlowChartHTML`:

```js
// Two bars per day (inflow up from a zero baseline, outflow down), no
// gridlines/legend/value labels — same minimal aesthetic as
// dailyTxChartHTML, adapted to a two-series bar layout.
export function exchangeFlowChartHTML(data) {
  if (!data.length)
    return `<div class="daily-tx-empty">Collecting data&hellip;</div>`;
  const W = 640, padX = 6, plotTop = 10, zeroY = 90, plotBottom = 170, axisY = 184;
  const maxVal = Math.max(...data.map((d) => Math.max(d.inflow, d.outflow)), 1);
  const n = data.length;
  const bandW = (W - padX * 2) / n;
  const barW = Math.min(bandW * 0.6, 18);
  const bars = data
    .map((d, i) => {
      const cx = padX + bandW * i + bandW / 2;
      const inH = (d.inflow / maxVal) * (zeroY - plotTop);
      const outH = (d.outflow / maxVal) * (plotBottom - zeroY);
      return `<rect class="flow-bar-in" x="${(cx - barW / 2).toFixed(1)}" y="${(zeroY - inH).toFixed(1)}" width="${barW.toFixed(1)}" height="${inH.toFixed(1)}"><title>${esc(d.date)} in: ${xem(d.inflow)} XEM</title></rect>
      <rect class="flow-bar-out" x="${(cx - barW / 2).toFixed(1)}" y="${zeroY.toFixed(1)}" width="${barW.toFixed(1)}" height="${outH.toFixed(1)}"><title>${esc(d.date)} out: ${xem(d.outflow)} XEM</title></rect>`;
    })
    .join("");
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const axisLabels = data
    .map((d, i) => {
      if (i % labelEvery !== 0) return "";
      const cx = padX + bandW * i + bandW / 2;
      const [, m, day] = d.date.split("-").map(Number);
      return `<text class="daily-tx-axis" x="${cx.toFixed(1)}" y="${axisY}">${m}/${day}</text>`;
    })
    .join("");
  return `<svg class="exchange-flow-chart" viewBox="0 0 ${W} 196" role="img" aria-label="Daily inflow and outflow">
    <line class="flow-baseline" x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}"/>
    ${bars}${axisLabels}
  </svg>`;
}

export function exchangeDetailHTML(name, data) {
  const totals = data.reduce(
    (acc, d) => ({ inflow: acc.inflow + d.inflow, outflow: acc.outflow + d.outflow }),
    { inflow: 0, outflow: 0 },
  );
  return `<div class="card-head">
    <div class="card-title">${esc(name)} <span class="count-badge">${data.length}d</span></div>
    <span class="total-txt">In: <strong>${xem(totals.inflow)} XEM</strong> &middot; Out: <strong>${xem(totals.outflow)} XEM</strong></span>
  </div>
  <div style="padding:16px;">${exchangeFlowChartHTML(data)}</div>`;
}

export function exchangeNotFoundHTML(name) {
  return `<div class="error-state">
    <div class="error-icon">⚠</div>
    <p class="error-title">Exchange not found</p>
    <p class="error-msg">No tracked exchange named <span class="mono">${esc(name)}</span>.</p>
  </div>`;
}
```

- [ ] **Step 4: Add the nav link**

In `navHTML`, change:

```js
  const links = [
    ["/blocks", "Blocks"],
    ["/txs", "Transactions"],
    ["/accounts", "Accounts"],
    ["/namespaces", "Namespaces"],
    ["/mosaics", "Mosaics"],
    ["/mosaictransfer", "Mosaic Transfer"],
    ["/nodes", "Nodes"],
    ["/polls", "Polls"],
  ];
```

to:

```js
  const links = [
    ["/blocks", "Blocks"],
    ["/txs", "Transactions"],
    ["/accounts", "Accounts"],
    ["/namespaces", "Namespaces"],
    ["/mosaics", "Mosaics"],
    ["/mosaictransfer", "Mosaic Transfer"],
    ["/exchanges", "Exchanges"],
    ["/nodes", "Nodes"],
    ["/polls", "Polls"],
  ];
```

- [ ] **Step 5: Add CSS**

Append to `public/style.css`, after the `.exchange-mini-chart .exchange-mini-line { ... }` block added in Task 5:

```css
.exchange-flow-chart {
    display: block;
    width: 100%;
    height: auto;
    overflow: visible;
}
.exchange-flow-chart .flow-bar-in {
    fill: var(--green);
}
.exchange-flow-chart .flow-bar-out {
    fill: var(--red);
}
.exchange-flow-chart .flow-baseline {
    stroke: var(--border);
    stroke-width: 1;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/html.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/html.js public/style.css test/html.test.js
git commit -m "$(cat <<'EOF'
Add exchange detail page (inflow/outflow bar chart) and nav link

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015N8J7gx4x7QZxBsAeP5SsX
EOF
)"
```

---

## Task 7: Routes

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: `getExchangeList`, `getExchangeDailyFlows`, `getExchangeAddresses` (Task 2); `heroExchanges`, `heroExchange`, `exchangeOverviewHTML`, `exchangeDetailHTML`, `exchangeNotFoundHTML`, `unavailableOnTestnetHTML`, `errorFrag`, `shell` (Tasks 5-6, existing).
- Produces: routes `GET /exchanges`, `GET /api/exchanges`, `GET /exchange/:name`, `GET /api/exchange/:name`.

- [ ] **Step 1: Add imports**

In `index.js`, add `getExchangeList, getExchangeDailyFlows, getExchangeAddresses` to the existing `db.js` import block (after `getTxTypeArchiveCount,`):

```js
  getTxTypeArchiveCount,
  getExchangeList,
  getExchangeDailyFlows,
  getExchangeAddresses,
} from "./src/db.js";
```

Add `heroExchanges, heroExchange, exchangeOverviewHTML, exchangeDetailHTML, exchangeNotFoundHTML` to the existing `html.js` import block (after `heroAccounts,`):

```js
  heroAccounts,
  heroExchanges,
  heroExchange,
  exchangeOverviewHTML,
  exchangeDetailHTML,
  exchangeNotFoundHTML,
```

- [ ] **Step 2: Add the routes**

In `index.js`, directly after the `/api/accounts/more` route (before `app.get("/robots.txt", ...)`), add:

```js
// Exchanges
app.get("/exchanges", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      "Exchanges - NEMSCAN",
      heroExchanges(),
      "exchanges-card",
      "/api/exchanges",
      `<div class="loading"><div class="spinner"></div><span>Loading exchange flows…</span></div>`,
      "/exchanges",
      "Track daily XEM inflow and outflow for known exchange wallets on NEMSCAN.",
      `${base}/exchanges`,
    ),
  );
});

app.get("/api/exchanges", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (currentNetwork() === "testnet") {
    return res.send(unavailableOnTestnetHTML("Exchanges"));
  }
  try {
    res.send(exchangeOverviewHTML(getExchangeList()));
  } catch (err) {
    res.status(503);
    res.send(errorFrag(err.message, "/api/exchanges", "#exchanges-card"));
  }
});

app.get("/exchange/:name", (req, res) => {
  const name = req.params.name;
  const base = `${req.protocol}://${req.get("host")}`;
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      `${name} - NEMSCAN`,
      heroExchange(name),
      "exchange-detail",
      `/api/exchange/${encodeURIComponent(name)}`,
      `<div class="loading"><div class="spinner"></div><span>Loading…</span></div>`,
      "/exchanges",
      `Daily XEM inflow and outflow for ${name} on NEMSCAN.`,
      `${base}/exchange/${encodeURIComponent(name)}`,
    ),
  );
});

app.get("/api/exchange/:name", (req, res) => {
  const name = req.params.name;
  res.setHeader("Content-Type", "text/html");
  if (currentNetwork() === "testnet") {
    return res.send(unavailableOnTestnetHTML("Exchanges"));
  }
  try {
    if (!getExchangeAddresses().some((a) => a.exchange_name === name)) {
      return res.send(exchangeNotFoundHTML(name));
    }
    const data = getExchangeDailyFlows(name, 30);
    res.send(exchangeDetailHTML(name, data));
  } catch (err) {
    res
      .status(503)
      .send(errorFrag(err.message, `/api/exchange/${encodeURIComponent(name)}`, "#exchange-detail"));
  }
});
```

- [ ] **Step 3: Run the full test suite**

Run: `node --test`
Expected: PASS (no route-level tests exist for other pages either — this app tests `db.js`/`cache.js`/`html.js` directly and verifies routing manually, per the existing project convention).

- [ ] **Step 4: Manual verification**

Run: `node index.js`

In another terminal:

```bash
curl -s http://localhost:3000/exchanges | grep -o '<title>[^<]*</title>'
curl -s http://localhost:3000/api/exchanges | head -5
```

Expected: the first command prints `<title>Exchanges - NEMSCAN</title>`; the second prints either the empty-state div (if `refreshRichListCache` hasn't run yet / found no matches) or an `exchange-grid` of cards. Then, once at least one exchange has been synced (wait for the richlist refresh, or check `sqlite3 cache.db "SELECT * FROM exchange_addresses;"` in a third terminal), visit `http://localhost:3000/exchange/<name>` in a browser and confirm the bar chart renders (it may show "Collecting data…" until `exchange_daily_flows` has at least one row for that exchange, which happens as soon as the block-persistence backfill/live-scan hook or `backfillNewExchangeAddresses` records its first transaction).

Stop the server (`Ctrl+C`) when done.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "$(cat <<'EOF'
Wire up /exchanges and /exchange/:name routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015N8J7gx4x7QZxBsAeP5SsX
EOF
)"
```

---

## Task 8: README update

**Files:**
- Modify: `README.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Document the new feature and its mainnet-only restriction**

In `README.md`, add a bullet to the `## 特徴` list (after `- リッチリスト（上位保有アドレス）`):

```markdown
- 取引所アドレスの日次XEM流入・流出トラッキング（既知の取引所ウォレットを自動検出してグラフ化）
```

In the `mainnet / testnet` section, extend the existing sentence that lists mainnet-only features:

Change:

```markdown
XEM 価格表示・ネームスペース/モザイクの歴史アーカイブ・ポール一覧・リッチリスト(Accounts)は mainnet 専用の外部データソースに依存しているため、testnet では利用できません。
```

to:

```markdown
XEM 価格表示・ネームスペース/モザイクの歴史アーカイブ・ポール一覧・リッチリスト(Accounts)・Exchanges（取引所フロー）は mainnet 専用の外部データソースに依存しているため、testnet では利用できません。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
Document the Exchanges feature in README

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015N8J7gx4x7QZxBsAeP5SsX
EOF
)"
```
