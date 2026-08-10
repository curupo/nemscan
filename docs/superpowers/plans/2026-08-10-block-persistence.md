# Block Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist fetched NEM blocks to sqlite so `/txs`, `/blocks`, `/block/:height`, and hinted `/tx/:hash` stop live re-scanning the chain on every request, and backfill full chain history in the background.

**Architecture:** One new `blocks` table (raw JSON per height) per network db. `getBlock()` in `src/nemApi.js` becomes DB-aware (memory → sqlite → live fetch, write-through on a live fetch). The existing background block-walker in `src/cache.js` (`scanBlockHeightsForDailyTx` / `refreshDailyTxStats`), which already fetches every new block live to bump a daily tx-count chart, is extended to also persist blocks and to keep walking backward all the way to genesis instead of stopping after 7 days.

**Tech Stack:** Node.js (`node:sqlite`, `node:test`), Express, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-10-block-persistence-design.md`

## Global Constraints

- No transaction-hash index and no change to `/tx/:hash`'s cold hash-search behavior — out of scope (see spec's Non-goals).
- No separate `transactions` table — `getTxsFromBlocks()`'s existing flatten-blocks algorithm is reused unchanged against cached blocks.
- No pruning — every synced block is kept forever (full history, deliberately).
- No change to `MAX_BLOCK_SCAN_MS` (8000) / `MAX_BLOCK_SCAN_DEPTH` (500) in `src/constants.js`.
- No change to `index.js` route handlers or any `src/html.js` rendering function — all output shapes stay identical; only `getBlock()`'s internal data source changes.
- Blocks are stored as verbatim raw JSON (`raw TEXT` column), not normalized SQL columns.
- The new backward-backfill-to-genesis completion flag is `blocks_backfill_done` — a **new** cache_meta key, kept separate from the existing `daily_tx_backfill_done` semantics to avoid a live deployment's already-set 7-day flag being misread as "full history backfilled" (migration hazard, see spec).
- Every new/modified test file that (transitively) imports `src/db.js` must set `process.env.NEMSCAN_DB_DIR` to a fresh temp directory *before* any such import, exactly like the existing `test/db.test.js` pattern — otherwise it silently writes into the real `cache.db` / `cache-testnet.db` in the repo root. Static top-level `import` statements are hoisted and evaluated before any of the importing module's own code runs, so any static import that transitively reaches `src/constants.js` locks in the wrong DB directory — these must become `await import(...)` calls placed *after* the `NEMSCAN_DB_DIR` assignment.

---

## Task 1: `blocks` table in `src/db.js`

**Files:**
- Modify: `src/db.js:56-65` (schema), `src/db.js:194-196` (prepared statements), `src/db.js:198-231` (returned accessor object), `src/db.js:296-310` (exported wrappers)
- Test: `test/db.test.js`

**Interfaces:**
- Produces: `upsertBlock(height: number, timeStamp: number, raw: string): void` and `getCachedBlock(height: number): object | null` — both exported from `src/db.js`, dispatching through the existing per-network `layer()` (mainnet/testnet), consumed by Task 2 and Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `test/db.test.js` (after the existing two tests, which already set up `NEMSCAN_DB_DIR` before dynamically importing `db.js` — this file's pattern doesn't need to change, only its import list and new tests):

Change line 15 from:
```js
const { setCacheMeta, getCacheMeta } = await import("../src/db.js");
```
to:
```js
const { setCacheMeta, getCacheMeta, upsertBlock, getCachedBlock } = await import("../src/db.js");
```

Then append at the end of the file:

```js

test("upsertBlock/getCachedBlock round-trips the raw JSON exactly", () => {
  networkContext.run("mainnet", () => {
    const raw = { height: 123, timeStamp: 456, transactions: [{ type: 257 }] };
    upsertBlock(123, 456, JSON.stringify(raw));
    assert.deepEqual(getCachedBlock(123), raw);
  });
});

test("getCachedBlock returns null for a height that was never persisted", () => {
  networkContext.run("mainnet", () => {
    assert.equal(getCachedBlock(999_999_999), null);
  });
});

test("blocks table is isolated between mainnet and testnet", () => {
  networkContext.run("mainnet", () => {
    upsertBlock(500, 111, JSON.stringify({ network: "mainnet" }));
  });
  networkContext.run("testnet", () => {
    upsertBlock(500, 222, JSON.stringify({ network: "testnet" }));
  });
  networkContext.run("mainnet", () => {
    assert.equal(getCachedBlock(500).network, "mainnet");
  });
  networkContext.run("testnet", () => {
    assert.equal(getCachedBlock(500).network, "testnet");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/db.test.js`
Expected: FAIL — `upsertBlock is not a function` (or similar `TypeError`), since neither `upsertBlock` nor `getCachedBlock` exist yet.

- [ ] **Step 3: Add the schema**

In `src/db.js`, the `db.exec(...)` template literal currently ends with the `daily_tx_counts` table (lines 60-64) right before the closing backtick on line 65:

```js
    CREATE TABLE IF NOT EXISTS daily_tx_counts (
      date TEXT PRIMARY KEY,
      tx_count INTEGER NOT NULL DEFAULT 0,
      block_count INTEGER NOT NULL DEFAULT 0
    );
  `);
```

Insert a new table right after `daily_tx_counts` and before the closing backtick:

```js
    CREATE TABLE IF NOT EXISTS daily_tx_counts (
      date TEXT PRIMARY KEY,
      tx_count INTEGER NOT NULL DEFAULT 0,
      block_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS blocks (
      height INTEGER PRIMARY KEY,
      time_stamp INTEGER NOT NULL,
      raw TEXT NOT NULL
    );
  `);
```

- [ ] **Step 4: Add prepared statements**

In `src/db.js`, right after `_dailyTxOldestStmt` (lines 194-196):

```js
  const _dailyTxOldestStmt = db.prepare(
    "SELECT MIN(date) AS d FROM daily_tx_counts",
  );
```

add:

```js
  const _dailyTxOldestStmt = db.prepare(
    "SELECT MIN(date) AS d FROM daily_tx_counts",
  );
  const _blockUpsertStmt = db.prepare(
    "INSERT OR REPLACE INTO blocks (height, time_stamp, raw) VALUES (?, ?, ?)",
  );
  const _blockSelectStmt = db.prepare(
    "SELECT raw FROM blocks WHERE height = ?",
  );
```

- [ ] **Step 5: Add accessors to the returned object**

In `src/db.js`, the returned object currently has (lines 220-223):

```js
    getOldestDailyTxDate: () => _dailyTxOldestStmt.get().d,
    upsertNamespace: (id, fqn, owner, height) => _nsUpsertStmt.run(id, fqn, owner, height),
```

Insert between them:

```js
    getOldestDailyTxDate: () => _dailyTxOldestStmt.get().d,
    getCachedBlock: (height) => {
      const row = _blockSelectStmt.get(height);
      return row ? JSON.parse(row.raw) : null;
    },
    upsertBlock: (height, timeStamp, raw) => _blockUpsertStmt.run(height, timeStamp, raw),
    upsertNamespace: (id, fqn, owner, height) => _nsUpsertStmt.run(id, fqn, owner, height),
```

- [ ] **Step 6: Add exported wrapper functions**

In `src/db.js`, right after `getOldestDailyTxDate` (lines 308-310):

```js
export function getOldestDailyTxDate() {
  return layer().getOldestDailyTxDate();
}
```

add:

```js
export function getOldestDailyTxDate() {
  return layer().getOldestDailyTxDate();
}
export function getCachedBlock(height) {
  return layer().getCachedBlock(height);
}
export function upsertBlock(height, timeStamp, raw) {
  layer().upsertBlock(height, timeStamp, raw);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/db.test.js`
Expected: PASS (5 tests: the original 2 plus the 3 new ones).

- [ ] **Step 8: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "db: add blocks table for raw block persistence"
```

---

## Task 2: Make `getBlock()` sqlite-aware in `src/nemApi.js`

**Files:**
- Modify: `src/nemApi.js:1-13` (imports), `src/nemApi.js:132-140` (`getBlock`)
- Test: `test/nemApi.test.js` (import section restructured, 2 new tests appended)

**Interfaces:**
- Consumes: `getCachedBlock(height)`, `upsertBlock(height, timeStamp, raw)` from Task 1.
- Produces: `getBlock(height)` keeps its existing signature and return shape (a live NIS block object or a value previously stored via `upsertBlock`) — no consumer of `getBlock` (in `index.js`, `getTxsFromBlocks`, `src/cache.js`) needs to change.

- [ ] **Step 1: Restructure `test/nemApi.test.js`'s imports for DB isolation**

`getBlock()` will import `src/db.js` after this task, and `src/nemApi.js` already imports `src/nodePool.js` and `src/constants.js`, both of which reach `src/constants.js`'s `NETWORKS` (which resolves `NEMSCAN_DB_DIR` at module-evaluation time). Static top-level imports are hoisted and run before any other code in the file, so setting `process.env.NEMSCAN_DB_DIR` after a static `import ... from "../src/nemApi.js"` would be too late — the wrong (real, repo-root) DB paths would already be locked in. Follow `test/db.test.js`'s pattern: defer every import that reaches `constants.js`/`db.js` until after the env var is set.

Replace the current top of `test/nemApi.test.js` (lines 1-6):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTxsFromBlocks, getBlock, getHeight } from "../src/nemApi.js";
import { refreshNodeOptions, getAutoBestNode } from "../src/nodePool.js";
import { MAX_BLOCK_SCAN_DEPTH, MAX_BLOCK_SCAN_MS } from "../src/constants.js";
import { networkContext, nodeContext } from "../src/context.js";
```

with:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkContext, nodeContext } from "../src/context.js";

// nemApi.js now imports db.js (to persist fetched blocks), which opens both
// SQLite files at import time as a side effect. Point NEMSCAN_DB_DIR at a
// scratch directory before importing anything that reaches constants.js /
// db.js, so this test never touches the real cache.db / cache-testnet.db in
// the repo root (same pattern as test/db.test.js).
process.env.NEMSCAN_DB_DIR = mkdtempSync(join(tmpdir(), "nemscan-nemapi-test-"));

const { getTxsFromBlocks, getBlock, getHeight } = await import("../src/nemApi.js");
const { refreshNodeOptions, getAutoBestNode } = await import("../src/nodePool.js");
const { MAX_BLOCK_SCAN_DEPTH, MAX_BLOCK_SCAN_MS } = await import("../src/constants.js");
const { getCachedBlock, upsertBlock } = await import("../src/db.js");
```

(`src/context.js` has no dependency on `constants.js`/`db.js` — it stays a static import.)

- [ ] **Step 2: Write the failing tests**

Append to `test/nemApi.test.js`, after the last existing test:

```js

test("getBlock reads from sqlite before making a live fetch", async (t) => {
  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ timeStamp: 0, transactions: [] }) };
  });

  const height = 42_000;
  await networkContext.run("mainnet", async () => {
    upsertBlock(
      height,
      555,
      JSON.stringify({ height, timeStamp: 555, transactions: [], fromDb: true }),
    );
    const block = await getBlock(height);
    assert.equal(block.fromDb, true);
    assert.equal(
      fetchCalled,
      false,
      "expected the sqlite-cached block to be used instead of a live fetch",
    );
  });
});

test("getBlock writes a live-fetched block through to sqlite", async (t) => {
  t.mock.method(global, "fetch", async (url, opts) => {
    const { height } = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ height, timeStamp: 777, transactions: [] }) };
  });

  const height = 42_001;
  await networkContext.run("mainnet", async () => {
    await getBlock(height);
    const persisted = getCachedBlock(height);
    assert.ok(persisted, "expected the live-fetched block to be persisted to sqlite");
    assert.equal(persisted.timeStamp, 777);
  });
});
```

(Heights `42_000`/`42_001` are chosen to not collide with any height used by the existing tests in this file, since `blockCache` is an in-process singleton shared across the whole test file.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/nemApi.test.js`
Expected: the two new tests FAIL (`getBlock` doesn't consult sqlite yet, so the first test sees a live `fetch` call, and the second finds nothing persisted). The restructured import section should not itself cause failures — if it does, fix the import restructuring before proceeding.

- [ ] **Step 4: Implement**

In `src/nemApi.js`, add the import (after the existing `constants.js` import block, i.e. after line 13):

```js
import { getCachedBlock, upsertBlock } from "./db.js";
```

Replace `getBlock` (lines 132-140):

```js
export async function getBlock(height) {
  const key = `${currentNetwork()}:${height}`;
  if (blockCache.has(key)) return blockCache.get(key);
  const block = await fetchBlockRaw(height);
  blockCache.set(key, block);
  if (blockCache.size > BLOCK_CACHE_MAX_SIZE)
    blockCache.delete(blockCache.keys().next().value);
  return block;
}
```

with:

```js
export async function getBlock(height) {
  const key = `${currentNetwork()}:${height}`;
  if (blockCache.has(key)) return blockCache.get(key);
  const cached = getCachedBlock(height);
  if (cached) {
    blockCache.set(key, cached);
    return cached;
  }
  const block = await fetchBlockRaw(height);
  blockCache.set(key, block);
  try {
    upsertBlock(height, block.timeStamp, JSON.stringify(block));
  } catch (err) {
    console.error("Block persistence failed:", err.message);
  }
  if (blockCache.size > BLOCK_CACHE_MAX_SIZE)
    blockCache.delete(blockCache.keys().next().value);
  return block;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/nemApi.test.js`
Expected: PASS (all tests in the file, including the pre-existing ones — the import restructuring must not break them).

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS. This confirms the restructured imports didn't regress anything and no other test file was relying on `nemApi.js` NOT touching sqlite.

- [ ] **Step 7: Commit**

```bash
git add src/nemApi.js test/nemApi.test.js
git commit -m "nemApi: make getBlock() check and write through sqlite"
```

---

## Task 3: Extend the background walker to persist blocks and backfill to genesis

**Files:**
- Modify: `src/cache.js:1-19` (imports), `src/cache.js:500-587` (daily-tx-stats section)
- Modify: `src/db.js:194-196`, `src/db.js:222`, `src/db.js:308-310` (remove now-dead `getOldestDailyTxDate`)
- Test: `test/cache.test.js` (import section restructured, 2 new tests appended)

**Interfaces:**
- Consumes: `upsertBlock(height, timeStamp, raw)`, `getCachedBlock(height)` from Task 1; `getBlock`'s write-through behavior is not used here directly (this task calls `fetchBlockRaw` + `upsertBlock` itself, matching the existing `scanBlockHeightsForDailyTx` structure).
- Produces: no new exports; `scanBlockHeightsForDailyTx` and `refreshDailyTxStats` keep their existing signatures. New cache_meta key `blocks_backfill_done` (see Global Constraints).

- [ ] **Step 1: Restructure `test/cache.test.js`'s imports for DB isolation**

`test/cache.test.js` currently statically imports `fetchXemPriceFromCoinGecko` from `../src/cache.js` at the top of the file — and `cache.js` already imports `db.js` today, so this file has *always* been writing into the real `cache.db` / `cache-testnet.db` in the repo root (a known, previously-noted gap). Since this task adds new tests here that call `db.js` accessors directly, fix the whole file's isolation now, following the same pattern as Tasks 1 and 2.

Replace the current top of `test/cache.test.js` (lines 1-4):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchXemPriceFromCoinGecko } from "../src/cache.js";
import { networkContext } from "../src/context.js";
```

with:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkContext } from "../src/context.js";

// cache.js imports db.js, which opens both SQLite files at import time as a
// side effect. Point NEMSCAN_DB_DIR at a scratch directory before importing
// anything that reaches constants.js / db.js, so this test never touches the
// real cache.db / cache-testnet.db in the repo root (same pattern as
// test/db.test.js and test/nemApi.test.js).
process.env.NEMSCAN_DB_DIR = mkdtempSync(join(tmpdir(), "nemscan-cache-test-"));

const {
  fetchXemPriceFromCoinGecko,
  refreshNamespacesCache,
  scanBlockHeightsForDailyTx,
  refreshDailyTxStats,
} = await import("../src/cache.js");
const { getCachedBlock, getCacheMeta } = await import("../src/db.js");
```

Then, in the existing test `"refreshNamespacesCache guard flag is isolated per network..."`, remove this now-redundant line (currently line 32):

```js
  const { refreshNamespacesCache } = await import("../src/cache.js");
```

(`refreshNamespacesCache` is already in scope from the top-level import above.)

- [ ] **Step 2: Run existing tests to verify the restructuring didn't break anything**

Run: `node --test test/cache.test.js`
Expected: PASS (same 4 tests as before — this step is a pure refactor, no new tests yet).

- [ ] **Step 3: Write the failing tests**

Append to `test/cache.test.js`:

```js

test("scanBlockHeightsForDailyTx persists each fetched block to the blocks table", async (t) => {
  t.mock.method(global, "fetch", async (url, opts) => {
    const { height } = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ height, timeStamp: 1000 + height, transactions: [] }) };
  });

  await networkContext.run("mainnet", async () => {
    await scanBlockHeightsForDailyTx([100, 101, 102]);
    assert.deepEqual(getCachedBlock(101), { height: 101, timeStamp: 1101, transactions: [] });
  });
});

test("refreshDailyTxStats keeps walking backward past a small window, all the way to genesis, and persists blocks as it goes", async (t) => {
  t.mock.method(global, "fetch", async (url, opts) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      return { ok: true, json: async () => ({ height: 150 }) };
    }
    const { height } = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ height, timeStamp: height, transactions: [] }) };
  });

  // DAILY_TX_BACKFILL_CHUNK is 60 blocks per call; a chain height of 150
  // takes a few sequential calls to walk all the way back to genesis
  // (height 1). 6 calls is a comfortable margin over the ~4 actually needed.
  for (let i = 0; i < 6; i++) {
    await refreshDailyTxStats("mainnet");
  }

  networkContext.run("mainnet", () => {
    assert.equal(getCacheMeta("blocks_backfill_done"), "1");
    assert.ok(getCachedBlock(1), "expected the genesis block to have been persisted");
    assert.ok(getCachedBlock(150), "expected the chain tip to have been persisted");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --test test/cache.test.js`
Expected: the two new tests FAIL — `scanBlockHeightsForDailyTx` doesn't call `upsertBlock` yet, so `getCachedBlock(101)` returns `null`; `refreshDailyTxStats` still stops backfilling after the old 7-day cutoff and never sets `blocks_backfill_done`.

- [ ] **Step 5: Implement — `src/db.js` cleanup**

`getOldestDailyTxDate` becomes unused once Step 6 removes its only caller. Remove it now so the diff lands together:

In `src/db.js`, remove the prepared statement (lines 194-196):

```js
  const _dailyTxOldestStmt = db.prepare(
    "SELECT MIN(date) AS d FROM daily_tx_counts",
  );
```

Remove the returned-object entry (line 222):

```js
    getOldestDailyTxDate: () => _dailyTxOldestStmt.get().d,
```

Remove the exported wrapper (lines 308-310):

```js
export function getOldestDailyTxDate() {
  return layer().getOldestDailyTxDate();
}
```

- [ ] **Step 6: Implement — `src/cache.js`**

Add `upsertBlock` to the existing `db.js` import list (line 1-19); remove `getOldestDailyTxDate` from it (it's no longer exported by `db.js` after Step 5):

```js
import {
  getDb,
  getCachedNamespaces,
  getArchivedNamespacesCount,
  getArchivedMosaicsCount,
  getNamespacesWithArchive,
  getCacheMeta,
  setCacheMeta,
  getCachedRichListCount,
  getCachedRichList,
  bumpDailyTxCount,
  upsertNamespace,
  upsertNamespaceArchive,
  upsertMosaic,
  upsertMosaicArchive,
  upsertPoll,
  upsertRichListEntry,
  upsertBlock,
} from "./db.js";
```

`DAILY_TX_DAYS` also becomes unused once Step 6 below removes its only two call sites (the 7-day cutoff computation, and a couple of comments that no longer name it). Remove it from the `constants.js` import list (near the top of `src/cache.js`):

```js
import {
  DAILY_TX_DAYS,
  DAILY_TX_BACKFILL_CHUNK,
  ARCHIVE_PAGE_DELAY_MS,
  DEEP_REFRESH_BATCH_DELAY_MS,
} from "./constants.js";
```

becomes:

```js
import {
  DAILY_TX_BACKFILL_CHUNK,
  ARCHIVE_PAGE_DELAY_MS,
  DEEP_REFRESH_BATCH_DELAY_MS,
} from "./constants.js";
```

(`DAILY_TX_DAYS` stays exported from `src/constants.js` and in use elsewhere — `src/html.js:527` still reads it for the chart's display window. Only this now-dead import in `cache.js` is removed.)

Replace the daily-tx-stats section (lines 500-587) — the comment block, `scanBlockHeightsForDailyTx`, `refreshDailyTxStats`, and `scheduleDailyTxStatsRefresh` — in full:

```js
// ── Daily TX stats + block persistence ──────────────────────────────────────

// NIS1 has no endpoint for historical transaction counts, so we derive them
// ourselves by walking blocks one at a time and bucketing each block's
// transaction count by its UTC calendar date. The full chain is far too many
// blocks to fetch in one pass, so each call advances the scanned range a
// little (forward to pick up new blocks, backward to backfill older ones)
// and persists progress in cache_meta so it resumes across restarts. Each
// fetched block is also persisted to the `blocks` table (see db.js) as a
// side effect, at no extra node-request cost — this is what lets /txs,
// /blocks, and /block/:height stop live-scanning the chain on every request
// once a given range has been synced (see getBlock() in nemApi.js).
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

const _refreshingDailyTxStats = { mainnet: false, testnet: false };
export async function refreshDailyTxStats(network) {
  if (_refreshingDailyTxStats[network]) return;
  _refreshingDailyTxStats[network] = true;
  try {
    await networkContext.run(network, async () => {
      const height = await getHeight();
      let maxH = parseInt(getCacheMeta("daily_tx_scan_max_height"));
      let minH = parseInt(getCacheMeta("daily_tx_scan_min_height"));
      if (!Number.isFinite(maxH)) {
        maxH = height - 1;
        minH = height;
      }

      if (height > maxH) {
        const heights = [];
        for (let h = maxH + 1; h <= height; h++) heights.push(h);
        await scanBlockHeightsForDailyTx(heights);
        maxH = height;
        setCacheMeta("daily_tx_scan_max_height", maxH);
      }

      // Unlike the daily-tx chart (which only ever needed DAILY_TX_DAYS of
      // history), block persistence backfills all the way to genesis so
      // /txs, /blocks, and /block/:height can eventually serve any height
      // from sqlite. This uses its own cache_meta key rather than reusing
      // the old 7-day "daily_tx_backfill_done" concept, so that a
      // deployment which already reached the old 7-day mark doesn't get
      // misread as having finished a full genesis backfill it never ran.
      if (!getCacheMeta("blocks_backfill_done")) {
        if (minH <= 1) {
          setCacheMeta("blocks_backfill_done", "1");
        } else {
          const to = Math.max(1, minH - DAILY_TX_BACKFILL_CHUNK);
          const heights = [];
          for (let h = minH - 1; h >= to; h--) heights.push(h);
          await scanBlockHeightsForDailyTx(heights);
          minH = to;
          setCacheMeta("daily_tx_scan_min_height", minH);
        }
      }
    });
  } catch (err) {
    console.error(`Daily tx stats refresh failed (${network}):`, err.message);
  } finally {
    _refreshingDailyTxStats[network] = false;
  }
}

// Self-rescheduling rather than setInterval: backfill runs in quick
// succession (every 5s) until the full chain has been backfilled down to
// genesis (blocks_backfill_done), then settles into an infrequent catch-up
// poll (every 5min) that still keeps up with new blocks every cycle. At
// current mainnet chain length (~5.8M blocks), full genesis backfill takes
// on the order of days at this pace. Takes `network` explicitly and passes
// it through its own recursive setTimeout call.
export function scheduleDailyTxStatsRefresh(network) {
  refreshDailyTxStats(network).finally(() => {
    const delay = networkContext.run(network, () =>
      getCacheMeta("blocks_backfill_done"),
    )
      ? 5 * 60 * 1000
      : 5 * 1000;
    setTimeout(() => scheduleDailyTxStatsRefresh(network), delay);
  });
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/cache.test.js`
Expected: PASS (all 6 tests: the original 4 plus the 2 new ones).

- [ ] **Step 8: Run the full suite**

Run: `node --test`
Expected: PASS across every test file (`db.test.js`, `nemApi.test.js`, `cache.test.js`, `nodePool.test.js`, `html.test.js`, `context.test.js`, `helpers.test.js`).

- [ ] **Step 9: Commit**

```bash
git add src/cache.js src/db.js test/cache.test.js
git commit -m "cache: persist blocks in the daily-tx walker; backfill to genesis"
```

---

## Manual verification (after Task 3)

Not a substitute for the automated tests above, but worth doing once before considering this done, since full-history backfill (days) can't be exercised end-to-end in a unit test:

```bash
rm -f cache.db cache.db-shm cache.db-wal   # fresh DB, don't touch a real deployment's data
node index.js
```

1. Watch the log for `Namespace cache refresh failed` etc. settling down after ~3s (existing startup behavior, unchanged).
2. Hit `curl -s -o /dev/null -w '%{time_total}\n' http://localhost:3000/api/blocks?page=1&limit=25` twice in a row. Both should be fast (network-fetch-bound the first time, since nothing is backfilled yet on a fresh DB) — this alone doesn't prove persistence.
3. Better: hit `curl -s -o /dev/null -w '%{time_total}\n' http://localhost:3000/api/block/<height>` for some height twice — the second call should be noticeably faster than the first, confirming the write-through cache from Task 2 is working end-to-end through the real HTTP path (not just the unit-test mocks).
4. Let the server run for a minute or two, then check `sqlite3 cache.db "SELECT COUNT(*) FROM blocks;"` — the count should be growing (forward catch-up + backward backfill both running).
