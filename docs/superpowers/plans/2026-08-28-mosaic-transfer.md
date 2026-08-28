# Mosaic Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `explorer.nemtool.com`'s "Mosaic Transfer" screen to NEMSCAN — a `/mosaictransfer` list page of mosaic (non-XEM) transfer transactions, plus a "Recent Transfers" section on the mosaic detail page.

**Architecture:** New `mosaic_transfers` sqlite table, populated by mirroring `explorer.nemtool.com`'s own `POST /mosaic/mosaicTransferList` archive endpoint (the same pattern already used for namespaces/mosaics/polls) — a one-time resumable historical backfill plus an ongoing 5-minute incremental poll, since (unlike those other archives) mosaic transfers never stop happening. New routes and HTML render the table with the site's existing htmx list-page conventions (rows-per-page dropdown, "Load More" pagination).

**Tech Stack:** Node.js (`node:sqlite`, `node:test`), Express 5, htmx (already vendored via CDN `<script>` tag in `shell()`), no new dependencies.

## Global Constraints

- Mainnet only — `mosaic_transfers` is created in both the mainnet and testnet db files (schema parity, matching `mosaics_archive`/`namespaces_archive`), but only ever populated on mainnet. No testnet-specific code paths.
- No new npm dependencies.
- Follow existing conventions exactly: prepared statements + `layer()` dispatch in `db.js`, `console.error`-and-continue for background job failures in `cache.js`, htmx `hx-get`/`hx-target`/`hx-swap` for pagination in `html.js`, `errorFrag(...)` for route-level failures in `index.js`.
- Every new test file/section that imports anything reaching `src/constants.js` or `src/db.js` must set `process.env.NEMSCAN_DB_DIR` to a fresh `mkdtempSync` directory **before** any (static or dynamic) import reaches those modules — see Task 3, Step 1 for why this matters even for imports that don't look database-related.

---

### Task 1: `mosaic_transfers` table and accessors

**Files:**
- Modify: `src/db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Produces: `getMosaicTransfers(limit = 25, offset = 0, ns = null, m = null)` → array of rows `{ no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, time_stamp }`, newest (`no`) first; filtered to `namespace = ns AND mosaic = m` when both are given, otherwise unfiltered.
- Produces: `getMosaicTransfersCount(ns = null, m = null)` → integer, same filtering rule.
- Produces: `getMaxMosaicTransferNo()` → integer, or `null` if the table is empty.
- Produces: `upsertMosaicTransfer(no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, timeStamp)` → void.
- These four are consumed by Task 2 (`cache.js`) and Task 4 (`index.js`); `getMosaicTransfersCount` is also consumed directly by Task 3 (`html.js`).

- [ ] **Step 1: Write the failing tests**

Open `test/db.test.js`. First, change line 15 (the existing destructure of the dynamic `db.js` import) to also pull in the four new functions:

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
} = await import("../src/db.js");
```

Then append these tests at the end of the file:

```js
test("upsertMosaicTransfer/getMosaicTransfers round-trips and orders by no DESC", () => {
  networkContext.run("mainnet", () => {
    upsertMosaicTransfer(100, "hashA", "dim", "coin", 5_000_000, 6, "SENDER1", "RECIP1", 111);
    upsertMosaicTransfer(200, "hashB", "dim", "coin", 3_000_000, 6, "SENDER2", "RECIP2", 222);
    const rows = getMosaicTransfers(10, 0);
    assert.equal(rows[0].no, 200);
    assert.equal(rows[0].hash, "hashB");
    assert.equal(rows[1].no, 100);
  });
});

test("getMosaicTransfers filters to a single namespace+mosaic when both are given", () => {
  networkContext.run("mainnet", () => {
    upsertMosaicTransfer(300, "hashC", "other", "thing", 1, 0, "S", "R", 300);
    const rows = getMosaicTransfers(10, 0, "dim", "coin");
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.namespace === "dim" && r.mosaic === "coin"));
    assert.ok(!rows.some((r) => r.no === 300));
  });
});

test("getMosaicTransfers supports offset for pagination", () => {
  networkContext.run("mainnet", () => {
    const page1 = getMosaicTransfers(1, 0, "dim", "coin");
    const page2 = getMosaicTransfers(1, 1, "dim", "coin");
    assert.equal(page1[0].no, 200);
    assert.equal(page2[0].no, 100);
  });
});

test("getMosaicTransfersCount matches filtered and unfiltered result sets", () => {
  networkContext.run("mainnet", () => {
    assert.equal(getMosaicTransfersCount("dim", "coin"), 2);
    assert.ok(getMosaicTransfersCount() >= 3);
  });
});

test("getMaxMosaicTransferNo returns the highest stored no", () => {
  networkContext.run("mainnet", () => {
    assert.equal(getMaxMosaicTransferNo(), 300);
  });
});

test("getMaxMosaicTransferNo returns null when the table is empty", () => {
  networkContext.run("testnet", () => {
    assert.equal(getMaxMosaicTransferNo(), null);
  });
});

test("mosaic_transfers table is isolated between mainnet and testnet", () => {
  networkContext.run("testnet", () => {
    upsertMosaicTransfer(1, "hashT", "t", "coin", 1, 0, "S", "R", 1);
    assert.equal(getMosaicTransfersCount(), 1);
  });
  networkContext.run("mainnet", () => {
    assert.ok(getMosaicTransfersCount() >= 3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/db.test.js`
Expected: FAIL — `upsertMosaicTransfer is not a function` (or similar `undefined is not a function`), since none of the four functions exist yet.

- [ ] **Step 3: Add the schema, prepared statements, and accessors**

In `src/db.js`, inside `openDbLayer()`'s initial `db.exec(...)` template literal, insert immediately after the `blocks` table definition (which currently ends the template literal just before the closing `` ` ``):

```sql
    CREATE TABLE IF NOT EXISTS mosaic_transfers (
      no INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      namespace TEXT NOT NULL,
      mosaic TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      divisibility INTEGER NOT NULL DEFAULT 0,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      time_stamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mosaic_transfers_ns_mosaic ON mosaic_transfers(namespace, mosaic);
```

Directly below the existing `_blockSelectStmt` declaration (just before the `return {` line), add:

```js
  const _mtUpsertStmt = db.prepare(
    "INSERT OR REPLACE INTO mosaic_transfers (no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, time_stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const _mtSelectAllStmt = db.prepare(
    "SELECT no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, time_stamp FROM mosaic_transfers ORDER BY no DESC LIMIT ? OFFSET ?",
  );
  const _mtSelectByMosaicStmt = db.prepare(
    "SELECT no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, time_stamp FROM mosaic_transfers WHERE namespace = ? AND mosaic = ? ORDER BY no DESC LIMIT ? OFFSET ?",
  );
  const _mtCountAllStmt = db.prepare("SELECT COUNT(*) AS c FROM mosaic_transfers");
  const _mtCountByMosaicStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM mosaic_transfers WHERE namespace = ? AND mosaic = ?",
  );
  const _mtMaxNoStmt = db.prepare("SELECT MAX(no) AS maxNo FROM mosaic_transfers");
```

Inside the object returned by `openDbLayer()` (alongside `getMosaicByNsAndName` / `upsertMosaic`), add:

```js
    getMosaicTransfers: (limit = 25, offset = 0, ns = null, m = null) =>
      ns && m
        ? _mtSelectByMosaicStmt.all(ns, m, limit, offset)
        : _mtSelectAllStmt.all(limit, offset),
    getMosaicTransfersCount: (ns = null, m = null) =>
      (ns && m ? _mtCountByMosaicStmt.get(ns, m) : _mtCountAllStmt.get()).c,
    getMaxMosaicTransferNo: () => _mtMaxNoStmt.get().maxNo,
    upsertMosaicTransfer: (no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, timeStamp) =>
      _mtUpsertStmt.run(no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, timeStamp),
```

Finally, add the module-level exported wrappers. Near `getMosaicByNsAndName` (in the "Read accessors" section):

```js
export function getMosaicTransfers(limit = 25, offset = 0, ns = null, m = null) {
  return layer().getMosaicTransfers(limit, offset, ns, m);
}
export function getMosaicTransfersCount(ns = null, m = null) {
  return layer().getMosaicTransfersCount(ns, m);
}
export function getMaxMosaicTransferNo() {
  return layer().getMaxMosaicTransferNo();
}
```

And near `upsertMosaic` (in the "Write wrappers" section):

```js
export function upsertMosaicTransfer(no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, timeStamp) {
  layer().upsertMosaicTransfer(no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, timeStamp);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/db.test.js`
Expected: PASS — all tests, including the pre-existing ones, green.

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "$(cat <<'EOF'
Add mosaic_transfers table and accessors

Backing store for the Mosaic Transfer feature: one row per mosaic
transfer mirrored from explorer.nemtool.com's archive, keyed by its
`no` cursor value (which also sorts by recency).
EOF
)"
```

---

### Task 2: Archive backfill + incremental sync (`cache.js`)

**Files:**
- Modify: `src/cache.js`
- Test: `test/cache.test.js`

**Interfaces:**
- Consumes: `upsertMosaicTransfer(...)`, `getMaxMosaicTransferNo()` from Task 1 (`src/db.js`); `getCacheMeta`/`setCacheMeta` (already imported in `cache.js`); `ARCHIVE_PAGE_DELAY_MS` (already imported from `src/constants.js`).
- Produces: `importMosaicTransferArchive()` → `Promise<void>`, one-time resumable backfill, guarded by `cache_meta.mosaic_transfers_archive_imported`.
- Produces: `refreshMosaicTransfers()` → `Promise<void>`, incremental top-up; no-ops until the import above has completed. Consumed by Task 4 (`index.js`'s startup/interval wiring).

- [ ] **Step 1: Write the failing tests**

Open `test/cache.test.js`. Change line 15-20 (the existing destructure of the dynamic `cache.js` import) to also pull in the two new functions:

```js
const {
  fetchXemPriceFromCoinGecko,
  refreshNamespacesCache,
  scanBlockHeightsForDailyTx,
  refreshDailyTxStats,
  importMosaicTransferArchive,
  refreshMosaicTransfers,
} = await import("../src/cache.js");
```

Change line 21 (the existing destructure of the dynamic `db.js` import) to:

```js
const { getCachedBlock, getCacheMeta, getMosaicTransfers, getMaxMosaicTransferNo } = await import("../src/db.js");
```

Then append these tests at the end of the file:

```js
test("importMosaicTransferArchive pages through the mock archive, checkpoints its cursor, and sets the completed flag", async (t) => {
  // Three pages of 2 records each (well under the 50-per-page server clamp,
  // which is what ends real pagination) — the mock ends pagination the same
  // way the real server does: a batch shorter than pageSize.
  const pages = {
    // first call: no cursor
    null: [
      { no: 300, hash: "h3", namespace: "dim", mosaic: "coin", quantity: 1000, div: 6, sender: "SA", recipient: "RA", timeStamp: 300 },
      { no: 290, hash: "h2", namespace: "dim", mosaic: "coin", quantity: 2000, div: 6, sender: "SB", recipient: "RB", timeStamp: 290 },
    ],
    290: [
      { no: 280, hash: "h1", namespace: "other", mosaic: "thing", quantity: 5, div: 0, sender: "SC", recipient: "RC", timeStamp: 280 },
    ],
  };
  t.mock.method(global, "fetch", async (url, opts) => {
    const body = JSON.parse(opts.body);
    const batch = pages[body.no ?? "null"] || [];
    return { ok: true, json: async () => batch };
  });

  await networkContext.run("mainnet", async () => {
    await importMosaicTransferArchive();
    assert.equal(getCacheMeta("mosaic_transfers_archive_imported") != null, true);
    assert.equal(getCacheMeta("mosaic_transfer_archive_cursor"), null);
    const rows = getMosaicTransfers(10, 0);
    assert.deepEqual(rows.map((r) => r.no), [300, 290, 280]);
    assert.equal(getMaxMosaicTransferNo(), 300);
  });
});

test("importMosaicTransferArchive is a no-op once already imported", async (t) => {
  let calls = 0;
  t.mock.method(global, "fetch", async () => {
    calls++;
    return { ok: true, json: async () => [] };
  });
  await networkContext.run("mainnet", async () => {
    await importMosaicTransferArchive();
    assert.equal(calls, 0, "expected no fetch once mosaic_transfers_archive_imported is already set");
  });
});

test("refreshMosaicTransfers does nothing before the initial import has completed", async (t) => {
  let calls = 0;
  t.mock.method(global, "fetch", async () => {
    calls++;
    return { ok: true, json: async () => [] };
  });
  await networkContext.run("testnet", async () => {
    await refreshMosaicTransfers();
    assert.equal(calls, 0);
  });
});

test("refreshMosaicTransfers walks forward from the local max and stops once it reaches a known record", async (t) => {
  await networkContext.run("mainnet", async () => {
    // Seed the "already imported" state this test needs, independent of the
    // import test above (each test process/table state persists across
    // tests in this file, but this makes the precondition explicit).
    const { setCacheMeta } = await import("../src/db.js");
    setCacheMeta("mosaic_transfers_archive_imported", Date.now());

    const newPage = [
      { no: 320, hash: "hNew2", namespace: "dim", mosaic: "coin", quantity: 10, div: 6, sender: "SX", recipient: "RX", timeStamp: 320 },
      { no: 310, hash: "hNew1", namespace: "dim", mosaic: "coin", quantity: 20, div: 6, sender: "SY", recipient: "RY", timeStamp: 310 },
      { no: 300, hash: "h3", namespace: "dim", mosaic: "coin", quantity: 1000, div: 6, sender: "SA", recipient: "RA", timeStamp: 300 },
    ];
    t.mock.method(global, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.no ?? null, null, "refreshMosaicTransfers should always start from the newest page");
      return { ok: true, json: async () => newPage };
    });

    await refreshMosaicTransfers();
    assert.equal(getMaxMosaicTransferNo(), 320);
    const rows = getMosaicTransfers(10, 0);
    assert.ok(rows.some((r) => r.no === 310));
    assert.ok(!rows.some((r) => r.hash === "duplicate-should-not-happen"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cache.test.js`
Expected: FAIL — `importMosaicTransferArchive is not a function`.

- [ ] **Step 3: Implement the sync functions**

In `src/cache.js`, add to the top import from `./db.js`:

```js
  upsertMosaicTransfer,
  getMaxMosaicTransferNo,
```

Then add, after `importMosaicArchive()`:

```js
const NEMTOOL_MOSAIC_TRANSFER_LIST_URL =
  "https://explorer.nemtool.com/mosaic/mosaicTransferList";

// Mosaic transfers have no NIS1 endpoint at all (not even a recent-window
// one, unlike namespaces/mosaics) — explorer.nemtool.com's own historical
// index (POST /mosaic/mosaicTransferList, no-cursor descending pagination,
// pageSize clamped server-side to 50) is the only source. Unlike
// importNamespaceArchive/importMosaicArchive, this dataset keeps growing
// forever, so it's split into a one-time historical backfill (this
// function) plus an ongoing top-up (refreshMosaicTransfers below). It's
// also expected to be far larger than the namespace/mosaic archives (a
// single active mosaic can recur almost daily across 10 years), so there's
// no page-count cap — loop until a page comes back short — and progress is
// checkpointed to cache_meta every page so a restart mid-import resumes
// instead of starting over from scratch.
export async function importMosaicTransferArchive() {
  if (getCacheMeta("mosaic_transfers_archive_imported")) return;
  let cursor = parseInt(getCacheMeta("mosaic_transfer_archive_cursor")) || null;
  let imported = 0;
  try {
    for (;;) {
      const body =
        cursor != null ? { pageSize: 50, no: cursor } : { pageSize: 50 };
      const res = await fetch(NEMTOOL_MOSAIC_TRANSFER_LIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const batch = await res.json();
      if (!Array.isArray(batch) || !batch.length) break;
      for (const item of batch) {
        upsertMosaicTransfer(
          item.no,
          item.hash,
          item.namespace,
          item.mosaic,
          item.quantity || 0,
          item.div || 0,
          item.sender,
          item.recipient,
          item.timeStamp,
        );
      }
      imported += batch.length;
      const last = batch[batch.length - 1].no;
      if (batch.length < 50 || last === cursor) break;
      cursor = last;
      setCacheMeta("mosaic_transfer_archive_cursor", cursor);
      await new Promise((r) => setTimeout(r, ARCHIVE_PAGE_DELAY_MS));
    }
    setCacheMeta("mosaic_transfers_archive_imported", Date.now());
    getDb().exec("DELETE FROM cache_meta WHERE key = 'mosaic_transfer_archive_cursor'");
    console.log(
      `Mosaic transfer archive import complete: ${imported} records imported (source: explorer.nemtool.com)`,
    );
  } catch (err) {
    console.error("Mosaic transfer archive import failed:", err.message);
  }
}

const _refreshingMosaicTransfers = { mainnet: false, testnet: false };

// Ongoing top-up: unlike the namespace/mosaic/poll archives (immutable once
// imported), mosaic transfers never stop happening, and there's no NIS1
// equivalent to fall back on for "what's new since last time" the way
// refreshNamespacesCache/refreshMosaicsCache can. Only runs once the
// historical backfill above has completed, since "the local max `no`"
// isn't a meaningful cursor until then. Idempotent via upsertMosaicTransfer's
// INSERT OR REPLACE, so overlap with a concurrent run is harmless.
export async function refreshMosaicTransfers() {
  const network = currentNetwork();
  if (_refreshingMosaicTransfers[network]) return;
  if (!getCacheMeta("mosaic_transfers_archive_imported")) return;
  _refreshingMosaicTransfers[network] = true;
  try {
    const localMax = getMaxMosaicTransferNo() || 0;
    let cursor = null;
    let fetched = 0;
    for (;;) {
      const body =
        cursor != null ? { pageSize: 50, no: cursor } : { pageSize: 50 };
      const res = await fetch(NEMTOOL_MOSAIC_TRANSFER_LIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const batch = await res.json();
      if (!Array.isArray(batch) || !batch.length) break;
      let reachedKnown = false;
      for (const item of batch) {
        if (item.no <= localMax) {
          reachedKnown = true;
          break;
        }
        upsertMosaicTransfer(
          item.no,
          item.hash,
          item.namespace,
          item.mosaic,
          item.quantity || 0,
          item.div || 0,
          item.sender,
          item.recipient,
          item.timeStamp,
        );
        fetched++;
      }
      if (reachedKnown || batch.length < 50) break;
      cursor = batch[batch.length - 1].no;
      await new Promise((r) => setTimeout(r, ARCHIVE_PAGE_DELAY_MS));
    }
    if (fetched) console.log(`Mosaic transfer top-up: ${fetched} new records`);
  } catch (err) {
    console.error("Mosaic transfer top-up failed:", err.message);
  } finally {
    _refreshingMosaicTransfers[network] = false;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/cache.test.js`
Expected: PASS — all tests, including the pre-existing ones, green.

- [ ] **Step 5: Commit**

```bash
git add src/cache.js test/cache.test.js
git commit -m "$(cat <<'EOF'
Sync mosaic transfers from explorer.nemtool.com's archive

One-time resumable backfill (importMosaicTransferArchive) plus a
5-minute incremental top-up (refreshMosaicTransfers), mirroring the
same archive-mirror pattern already used for namespaces/mosaics/polls
— mosaic transfers have no NIS1 endpoint at all.
EOF
)"
```

---

### Task 3: Rendering — list page, detail-page section, nav link (`html.js`)

**Files:**
- Modify: `src/html.js`
- Modify: `public/style.css`
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: `getMosaicTransfersCount(ns, m)` from Task 1 (`src/db.js`, imported into `html.js`'s existing `db.js` import block).
- Produces: `heroMosaicTransfers()` → HTML string.
- Produces: `renderMosaicTransferRow(t, num)` → `<tr>` HTML string, where `t` is a row shaped like `{ no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, time_stamp }` (i.e. exactly what `getMosaicTransfers` rows look like).
- Produces: `mosaicTransferLoadMoreRow(offset, total, limit, filter)` → HTML string (`""` when exhausted), where `filter` is `{ ns, m }` or `{ ns: null, m: null }`.
- Produces: `mosaicTransferMoreRows(items, offset, total, limit, filter)` → HTML string (`total` supplied by the caller, matching the existing `mosaicMoreRows(items, offset, total, limit)` convention), consumed by Task 4's `/api/mosaictransfer/more` route.
- Produces: `mosaicTransfersListHTML(items, limit, filter)` → HTML string, consumed by Task 4's `/api/mosaictransfer` route.
- Modifies: `mosaicDetailHTML(m, liveData, transfers = [])` — new third parameter, backward compatible (existing 2-arg call sites keep working; Task 4 updates the one real call site to pass real data).
- Modifies: `navHTML`'s `links` array — adds a `Mosaic Transfer` entry, consumed implicitly by every page (nav is shared chrome).

- [ ] **Step 1: Write the failing tests**

`test/html.test.js` currently has a static top-level `import { refreshNodeOptions } from "../src/nodePool.js";`. Since ES module static imports are hoisted and evaluated *before* any other code in the file runs, and `nodePool.js` transitively imports `src/constants.js` (which reads `process.env.NEMSCAN_DB_DIR` at module-evaluation time to compute `NETWORKS[*].dbFile`), that static import would freeze `constants.js`'s db-path resolution before this task's new `process.env.NEMSCAN_DB_DIR` line ever ran — the same trap `test/nemApi.test.js` already avoids by importing `nodePool.js` dynamically. Rewrite the whole top of the file to match that pattern:

Replace the file's current top section:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { globalTxMoreRows, renderNodeRow, nodeSwitchHTML, nodesListHTML } from "../src/html.js";
import { refreshNodeOptions } from "../src/nodePool.js";
```

with:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkContext } from "../src/context.js";

// html.js imports db.js (for archive-count accessors like
// getMosaicTransfersCount), which opens both SQLite files at import time as
// a side effect. Point NEMSCAN_DB_DIR at a scratch directory before
// importing anything that reaches constants.js / db.js — including
// nodePool.js, which is why that import is dynamic below too — so this test
// never touches the real cache.db / cache-testnet.db in the repo root (same
// pattern as test/db.test.js, test/cache.test.js, test/nemApi.test.js).
process.env.NEMSCAN_DB_DIR = mkdtempSync(join(tmpdir(), "nemscan-html-test-"));

const {
  globalTxMoreRows,
  renderNodeRow,
  nodeSwitchHTML,
  nodesListHTML,
  navHTML,
  heroMosaicTransfers,
  renderMosaicTransferRow,
  mosaicTransferMoreRows,
  mosaicTransfersListHTML,
  mosaicDetailHTML,
} = await import("../src/html.js");
const { refreshNodeOptions } = await import("../src/nodePool.js");
const { upsertMosaicTransfer } = await import("../src/db.js");
```

Then append these tests at the end of the file:

```js
test("navHTML lists a Mosaic Transfer link and marks it active on /mosaictransfer", () => {
  const html = navHTML("/mosaictransfer");
  assert.match(html, /href="\/mosaictransfer"[^>]*class="active"[^>]*>Mosaic Transfer</);
});

test("heroMosaicTransfers renders a Mosaic Transfer heading", () => {
  assert.match(heroMosaicTransfers(), /<h1>Mosaic Transfer<\/h1>/);
});

test("renderMosaicTransferRow formats quantity using the row's own divisibility and links sender/recipient/mosaic", () => {
  const html = renderMosaicTransferRow(
    { no: 1, hash: "abc123", namespace: "dim", mosaic: "coin", quantity: 5_000_000, divisibility: 6, sender: "SENDERADDR", recipient: "RECIPADDR", time_stamp: 100 },
    1,
  );
  assert.match(html, />5\.000000</);
  assert.match(html, /href="\/mosaic\/dim\/coin"/);
  assert.match(html, /href="\/account\/SENDERADDR"/);
  assert.match(html, /href="\/account\/RECIPADDR"/);
});

test("renderMosaicTransferRow formats a zero-divisibility mosaic as a whole number", () => {
  const html = renderMosaicTransferRow(
    { no: 1, hash: "abc123", namespace: "smart-uq", mosaic: "dig", quantity: 800, divisibility: 0, sender: "S", recipient: "R", time_stamp: 100 },
    1,
  );
  assert.match(html, />800</);
});

test("mosaicTransferMoreRows drops the Load More control once offset reaches total", () => {
  const items = [{ no: 1, hash: "h", namespace: "n", mosaic: "m", quantity: 1, divisibility: 0, sender: "S", recipient: "R", time_stamp: 1 }];
  const html = mosaicTransferMoreRows(items, 0, 1, 25, { ns: null, m: null });
  assert.doesNotMatch(html, /Load More/);
});

test("mosaicTransferMoreRows keeps the Load More control, with the ns/m filter preserved in its URL, when more remain", () => {
  const items = [{ no: 1, hash: "h", namespace: "dim", mosaic: "coin", quantity: 1, divisibility: 0, sender: "S", recipient: "R", time_stamp: 1 }];
  const html = mosaicTransferMoreRows(items, 0, 5, 25, { ns: "dim", m: "coin" });
  assert.match(html, /Load More/);
  assert.match(html, /ns=dim&m=coin/);
});

test("mosaicTransfersListHTML shows an empty state naming the filter when a search finds nothing", () => {
  const html = mosaicTransfersListHTML([], 25, { ns: "nope", m: "nope" });
  assert.match(html, /No transfers found for "nope:nope"/);
});

test("mosaicTransfersListHTML renders rows and reflects getMosaicTransfersCount for the total", () => {
  networkContext.run("mainnet", () => {
    upsertMosaicTransfer(500, "h500", "dim", "coin", 1_000_000, 6, "S", "R", 500);
    const html = mosaicTransfersListHTML([{ no: 500, hash: "h500", namespace: "dim", mosaic: "coin", quantity: 1_000_000, divisibility: 6, sender: "S", recipient: "R", time_stamp: 500 }], 25, { ns: null, m: null });
    assert.match(html, /Mosaic Transfer/);
    assert.match(html, /dim:<strong>coin<\/strong>/);
    assert.match(html, /<strong>1<\/strong> transfers/);
  });
});

test("mosaicDetailHTML omits the Recent Transfers section for a mosaic with no indexed transfers", () => {
  networkContext.run("mainnet", () => {
    const html = mosaicDetailHTML(
      { namespace: "untouched", name: "coin", creator: "CREATOR", description: "", divisibility: 0, supply: 1, transferable: 1 },
      null,
      [],
    );
    assert.doesNotMatch(html, /Recent Transfers/);
  });
});

test("mosaicDetailHTML renders a Recent Transfers section and a View all link once its count exceeds the passed-in rows", () => {
  networkContext.run("mainnet", () => {
    upsertMosaicTransfer(600, "h600", "dim", "coin", 1, 6, "S", "R", 600);
    upsertMosaicTransfer(601, "h601", "dim", "coin", 1, 6, "S", "R", 601);
    const oneRow = [{ no: 601, hash: "h601", namespace: "dim", mosaic: "coin", quantity: 1, divisibility: 6, sender: "S", recipient: "R", time_stamp: 601 }];
    const html = mosaicDetailHTML(
      { namespace: "dim", name: "coin", creator: "CREATOR", description: "", divisibility: 6, supply: 1, transferable: 1 },
      null,
      oneRow,
    );
    assert.match(html, /Recent Transfers/);
    assert.match(html, /View all transfers/);
    assert.match(html, /\/mosaictransfer\?ns=dim&m=coin/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/html.test.js`
Expected: FAIL — `navHTML is not a function` (it isn't exported from the destructure yet in the old file, and none of the new functions exist).

- [ ] **Step 3: Implement the rendering functions**

In `src/html.js`, add `getMosaicTransfersCount` to the existing `./db.js` import block at the top of the file:

```js
import {
  getCacheMeta,
  getArchivedNamespacesCount,
  getArchivedMosaicsCount,
  getDailyTxCounts,
  getNamespacesWithArchiveCount,
  getMosaicsWithArchiveCount,
  getMosaicTransfersCount,
} from "./db.js";
```

In `navHTML`'s `links` array, add the new entry after `Mosaics`:

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

Near `heroMosaics()`, add:

```js
export function heroMosaicTransfers() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Mosaic Transfer</h1>
  </div></div>`;
}
```

After `mosaicsListHTML` (before the `// ── Nodes list HTML ──` comment), add the whole new section:

```js
// ── Mosaic transfer list HTML ─────────────────────────────────────────────────

export function renderMosaicTransferRow(t, num) {
  const qty = (t.quantity / Math.pow(10, t.divisibility)).toLocaleString("en", {
    minimumFractionDigits: t.divisibility,
    maximumFractionDigits: t.divisibility,
  });
  const detailUrl = `/mosaic/${t.namespace.split(".").join("/")}/${t.mosaic}`;
  return `<tr>
    <td class="td-num">${num}</td>
    <td><a href="${detailUrl}" class="mosaic-id-link" title="${esc(t.namespace)}:${esc(t.mosaic)}">${esc(t.namespace)}:<strong>${esc(t.mosaic)}</strong></a></td>
    <td class="td-right mono">${qty}</td>
    <td><a href="/account/${t.sender}" class="mono-link" title="${t.sender}">${truncKey(t.sender)}</a></td>
    <td><a href="/account/${t.recipient}" class="mono-link" title="${t.recipient}">${truncKey(t.recipient)}</a></td>
    <td><span class="mono-muted" title="${t.hash}">${truncHash(t.hash)}</span></td>
    <td><div class="age-rel">${timeAgo(nemDate(t.time_stamp))}</div></td>
  </tr>`;
}

function mosaicTransferFilterQs(filter) {
  return filter?.ns && filter?.m
    ? `&ns=${encodeURIComponent(filter.ns)}&m=${encodeURIComponent(filter.m)}`
    : "";
}

export function mosaicTransferLoadMoreRow(offset, total, limit, filter) {
  if (offset >= total) return "";
  const qs = mosaicTransferFilterQs(filter);
  return `<tr id="mt-load-more-row"><td colspan="7" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/mosaictransfer/more?offset=${offset}&limit=${limit}${qs}"
            hx-target="#mt-load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

export function mosaicTransferMoreRows(items, offset, total, limit, filter) {
  if (!items.length) return "";
  return (
    items.map((t, i) => renderMosaicTransferRow(t, offset + i + 1)).join("") +
    mosaicTransferLoadMoreRow(offset + items.length, total, limit, filter)
  );
}

export function mosaicTransfersListHTML(items, limit, filter) {
  const total = getMosaicTransfersCount(filter?.ns, filter?.m);
  const currentQ = filter?.ns && filter?.m ? `${filter.ns}:${filter.m}` : "";
  const qs = mosaicTransferFilterQs(filter);
  const rItem = (n) =>
    `<a class="rows-menu-item${n === limit ? " active" : ""}" hx-get="/api/mosaictransfer?limit=${n}${qs}" hx-target="#mosaictransfer-card" hx-swap="innerHTML" href="#" role="menuitem">${n}</a>`;
  const rowsCtrl = `
      <div class="rows-ctrl">
        <span class="rows-ctrl-label">Show:</span>
        <div class="rows-switch">
          <button type="button" class="rows-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleRowsMenu(event)" title="Rows per page">
            <span class="rows-switch-label">${limit}</span>
            <span class="rows-switch-caret">&#9662;</span>
          </button>
          <div class="rows-menu" role="menu" aria-label="Rows per page">
            ${[10, 25, 50, 100].map(rItem).join("")}
          </div>
        </div>
      </div>`;
  const searchForm = `
    <form method="GET" action="/mosaictransfer" class="mt-search">
      <input type="text" name="q" value="${esc(currentQ)}" placeholder="mosaicID e.g. dim:coin">
      <button type="submit" class="mt-search-btn">Search</button>
      ${currentQ ? `<a href="/mosaictransfer" class="mt-search-clear">&times; Clear</a>` : ""}
    </form>`;
  const body = !items.length
    ? `<div class="empty-state">${currentQ ? `No transfers found for "${esc(currentQ)}"` : "No mosaic transfers found"}</div>`
    : `<div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Mosaic</th><th class="th-right">Quantity</th><th>Sender</th><th>Recipient</th><th>Tx</th><th>Age</th></tr></thead>
      <tbody>${items.map((t, i) => renderMosaicTransferRow(t, i + 1)).join("")}${mosaicTransferLoadMoreRow(items.length, total, limit, filter)}</tbody>
    </table></div>`;
  return `
  <div class="card-head">
    <div class="card-title">Mosaic Transfer</div>
    <div class="card-head-right">
      <span class="total-txt"><strong>${total.toLocaleString("en")}</strong> transfers</span>
      ${rowsCtrl}
    </div>
  </div>
  ${searchForm}
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>Mosaic transfer history is mirrored from <a href="https://explorer.nemtool.com/" target="_blank" rel="noopener">explorer.nemtool.com</a>'s historical index and refreshed every few minutes.</p>
  ${body}`;
}
```

Finally, extend `mosaicDetailHTML`. Change its signature from `export function mosaicDetailHTML(m, liveData) {` to `export function mosaicDetailHTML(m, liveData, transfers = []) {`. Then, immediately before its `return` statement, add:

```js
  const transfersTotal = getMosaicTransfersCount(m.namespace, m.name);
  const transfersSection = !transfersTotal
    ? ""
    : `<div class="card" style="margin-top:16px;">
    <div class="card-head">
      <div class="card-title">Recent Transfers <span class="count-badge">${transfersTotal.toLocaleString("en")}</span></div>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Mosaic</th><th class="th-right">Quantity</th><th>Sender</th><th>Recipient</th><th>Tx</th><th>Age</th></tr></thead>
      <tbody>${transfers.map((t, i) => renderMosaicTransferRow(t, i + 1)).join("")}</tbody>
    </table></div>
    ${transfersTotal > transfers.length ? `<div class="home-panel-foot"><a href="/mosaictransfer?ns=${encodeURIComponent(m.namespace)}&m=${encodeURIComponent(m.name)}">View all transfers &rsaquo;</a></div>` : ""}
  </div>`;
```

And change its `return` statement from:

```js
  return `
  <div class="card-head">
    <div class="card-title">Overview</div>
  </div>
  <div class="ov-list">${ovRows}</div>
  <script>
```

to:

```js
  return `
  <div class="card-head">
    <div class="card-title">Overview</div>
  </div>
  <div class="ov-list">${ovRows}</div>
  ${transfersSection}
  <script>
```

(the rest of that `<script>` block, defining `copy()`, is unchanged).

In `public/style.css`, immediately after the existing `.archive-note .archive-note-icon { margin-right: 4px; }` rule, add:

```css
.mt-search {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 14px 20px 0;
}
.mt-search input {
    flex: 1 1 240px;
    max-width: 320px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
}
.mt-search-btn {
    padding: 7px 16px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-3);
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
}
.mt-search-btn:hover {
    background: var(--surface-2);
}
.mt-search-clear {
    font-size: 13px;
    color: var(--muted);
}
.mt-search-clear:hover {
    color: var(--text);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/html.test.js`
Expected: PASS — all tests, including the pre-existing ones, green.

- [ ] **Step 5: Run the full test suite to check nothing else broke**

Run: `node --test`
Expected: PASS — every test file green (the `html.test.js` rewrite in Step 1 changed how that file bootstraps its imports; this confirms it didn't regress the pre-existing node/tx tests in that same file).

- [ ] **Step 6: Commit**

```bash
git add src/html.js public/style.css test/html.test.js
git commit -m "$(cat <<'EOF'
Render the Mosaic Transfer list page and mosaic detail history section

mosaicTransfersListHTML/mosaicTransferMoreRows follow the existing
mosaicsListHTML pagination conventions (rows-per-page dropdown, Load
More); mosaicDetailHTML gains a "Recent Transfers" card, shown only
when the mosaic has indexed transfers, with a "View all" link to the
filtered list page once there are more than were passed in.
EOF
)"
```

---

### Task 4: Routes and background-job wiring (`index.js`)

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: `getMosaicTransfers`, `getMosaicTransfersCount` (Task 1); `importMosaicTransferArchive`, `refreshMosaicTransfers` (Task 2); `heroMosaicTransfers`, `mosaicTransfersListHTML`, `mosaicTransferMoreRows`, `mosaicDetailHTML` (Task 3, `mosaicDetailHTML`'s existing import already present — only its call site changes).
- Produces: `GET /mosaictransfer`, `GET /api/mosaictransfer`, `GET /api/mosaictransfer/more` — the three routes a browser/htmx actually hits; nothing downstream in this codebase depends on their internals, so no further "Produces" beyond the running server.

This task has no unit test of its own (it's pure route wiring over already-tested functions) — verification is a manual smoke test against the running server, per the project's existing convention for route-only changes (see `README.md`'s lack of route-level tests for the other `/api/*` handlers).

- [ ] **Step 1: Add the new imports**

In `index.js`, add to the existing `./src/db.js` import block (alongside `getMosaicByNsAndName`):

```js
  getMosaicTransfers,
  getMosaicTransfersCount,
```

Add to the existing `./src/cache.js` import block (alongside `importMosaicArchive`):

```js
  importMosaicTransferArchive,
  refreshMosaicTransfers,
```

Add to the existing `./src/html.js` import block (alongside `heroMosaics`, `mosaicsListHTML`, `mosaicMoreRows`):

```js
  heroMosaicTransfers,
  mosaicTransfersListHTML,
  mosaicTransferMoreRows,
```

- [ ] **Step 2: Add the mosaic-ID query parser and the three routes**

Near the top of `index.js`, alongside the other module-level regexes (`NEM_ADDRESS_RE`, `NEM_HASH_RE`, `NAMESPACE_FQN_RE`), add:

```js
// Parses "namespace:mosaic" from the /mosaictransfer page's search form
// (?q=dim:coin) into { ns, m }, or null if it doesn't look like a mosaic ID.
function parseMosaicIdQuery(q) {
  const raw = (q || "").trim().toLowerCase();
  const idx = raw.indexOf(":");
  if (idx < 1 || idx === raw.length - 1) return null;
  return { ns: raw.slice(0, idx).trim(), m: raw.slice(idx + 1).trim() };
}

// Reads ns/m query params directly (used by the two /api/mosaictransfer*
// routes, which receive them pre-split rather than as a single "ns:m" string).
function mosaicFilterFromQuery(query) {
  const ns = (query.ns || "").trim().toLowerCase() || null;
  const m = (query.m || "").trim().toLowerCase() || null;
  return ns && m ? { ns, m } : { ns: null, m: null };
}
```

Immediately after the `/api/mosaics/more` route (and before the `// Mosaic detail` comment), add the three new routes:

```js
// Mosaic Transfer
app.get("/mosaictransfer", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  const parsed = parseMosaicIdQuery(req.query.q);
  const apiQs = parsed
    ? `?ns=${encodeURIComponent(parsed.ns)}&m=${encodeURIComponent(parsed.m)}`
    : "";
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      "Mosaic Transfer - NEMSCAN",
      heroMosaicTransfers(),
      "mosaictransfer-card",
      `/api/mosaictransfer${apiQs}`,
      `<div class="loading"><div class="spinner"></div><span>Fetching mosaic transfers…</span></div>`,
      "/mosaictransfer",
      "Browse mosaic (non-XEM asset) transfer transactions on the NEM blockchain, mirrored from explorer.nemtool.com's historical index.",
      `${base}/mosaictransfer`,
    ),
  );
});

app.get("/api/mosaictransfer", async (req, res) => {
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit))
    ? parseInt(req.query.limit)
    : 25;
  const filter = mosaicFilterFromQuery(req.query);
  try {
    const items = getMosaicTransfers(limit, 0, filter.ns, filter.m);
    res.setHeader("Content-Type", "text/html");
    res.send(mosaicTransfersListHTML(items, limit, filter));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, "/api/mosaictransfer", "#mosaictransfer-card"));
  }
});

app.get("/api/mosaictransfer/more", async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit))
    ? parseInt(req.query.limit)
    : 25;
  const filter = mosaicFilterFromQuery(req.query);
  try {
    const items = getMosaicTransfers(limit, offset, filter.ns, filter.m);
    const total = getMosaicTransfersCount(filter.ns, filter.m);
    res.setHeader("Content-Type", "text/html");
    res.send(mosaicTransferMoreRows(items, offset, total, limit, filter));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send("");
  }
});
```

- [ ] **Step 3: Feed transfer history into the mosaic detail route**

In the existing `app.get(/^\/api\/mosaic\/(.+)$/, ...)` handler, change:

```js
    if (!m) return res.send(mosaicNotFoundHTML(namespace, name));
    res.send(mosaicDetailHTML(m, liveData));
```

to:

```js
    if (!m) return res.send(mosaicNotFoundHTML(namespace, name));
    const transfers = getMosaicTransfers(10, 0, namespace, name);
    res.send(mosaicDetailHTML(m, liveData, transfers));
```

- [ ] **Step 4: Wire up the background jobs**

In the mainnet-only startup block (alongside `runFor("mainnet", importMosaicArchive);`), add:

```js
  runFor("mainnet", () => importMosaicTransferArchive().then(refreshMosaicTransfers));
```

Alongside the other 5-minute `setInterval` jobs, add:

```js
  setInterval(() => runFor("mainnet", refreshMosaicTransfers), 5 * 60 * 1000);
```

- [ ] **Step 5: Run the full test suite**

Run: `node --test`
Expected: PASS — `index.js` has no dedicated tests, but this confirms the import/wiring changes didn't break module loading for anything that transitively imports it indirectly (none of the test files import `index.js` directly, but this is a cheap sanity check before the manual smoke test).

- [ ] **Step 6: Manual smoke test**

Run: `node index.js`
Expected console output: `NEMSCAN → http://localhost:3000/` (plus background-job startup logs after ~3s).

With the server running, in another terminal:

```bash
curl -s http://localhost:3000/mosaictransfer | grep -o '<title>[^<]*</title>'
```
Expected: `<title>Mosaic Transfer - NEMSCAN</title>`

```bash
curl -s http://localhost:3000/api/mosaictransfer
```
Expected: either a rendered (possibly empty, if the background import hasn't finished yet) `Mosaic Transfer` card fragment, or (if hit before the 3-second startup delay) valid HTML with no server error.

Then in a browser, visit `http://localhost:3000/mosaictransfer`, confirm the page loads without a console error, and — once the background import has had a few minutes to run — confirm rows appear, "Load More" paginates, the rows-per-page dropdown works, and searching `dim:coin` in the filter box narrows the list. Visit `http://localhost:3000/mosaic/dim/coin` and confirm a "Recent Transfers" card appears once that mosaic has indexed transfers.

Stop the server (`Ctrl+C`) when done.

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "$(cat <<'EOF'
Wire up /mosaictransfer routes and the mosaic-transfer sync jobs

Adds the list page, its htmx fragment + pagination endpoints, feeds
transfer history into the existing mosaic detail route, and starts
the archive backfill + 5-minute incremental sync on mainnet.
EOF
)"
```
