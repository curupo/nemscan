# Transaction Type Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Type" dropdown to NEMSCAN's `/txs` page that filters to Transfer / Importance / Aggregate / Multisig / Namespace / Apostille (backed by a new bounded, continuously-refreshed local archive mirrored from `explorer.nemtool.com`), links out to the existing `/mosaictransfer` page for "Mosaic", and links to a new `/txs/unconfirmed` page (a live proxy of nemtool's pending-tx pool) for "Pending".

**Architecture:** Follows the exact same shape as the existing `/mosaictransfer` feature (`src/cache.js`'s `importMosaicTransferArchive`/`refreshMosaicTransfers`, `src/db.js`'s `mosaic_transfers` table): a background job mirrors `POST https://explorer.nemtool.com/tx/list` into a new `tx_type_archive` SQLite table, one row per `(filter_type, hash)`, trimmed every refresh to the newest `TX_TYPE_ARCHIVE_WINDOW` rows per type. `/txs`'s existing live NIS1 block-walk is untouched and stays the default (no `type` query param) view. `/txs/unconfirmed` proxies `POST https://explorer.nemtool.com/tx/unconfirmedTXList` live, per request, with no local storage.

**Tech Stack:** Node.js (`node:sqlite` via `DatabaseSync`), Express 5, server-rendered HTML + HTMX 2 (no client-side framework, no native `<select>` — dropdowns are hand-rolled button+menu components), `node:test` + `node:assert/strict`.

## Global Constraints

- **No git commands of any kind** (not `add`, not `commit`, not `status` — nothing). The user runs git themselves. Every task below ends at "run the tests," not a commit step.
- Mainnet only — this feature depends entirely on `explorer.nemtool.com`, which has no testnet equivalent (same restriction as `/mosaictransfer`, `/namespaces`, `/mosaics`).
- `/txs`'s existing no-`type` behavior (live NIS1 block-walk via `getTxsFromBlocks`) must remain byte-for-byte unchanged and must keep working on testnet.
- No native `<select>`; reuse the existing `rows-switch`/`rows-menu`/`rows-menu-item` CSS classes and the existing generic `window.toggleRowsMenu` JS (`src/html.js:346`) — no new CSS, no new client-side JS.
- No git-committed design doc changes — the approved spec lives at `docs/superpowers/specs/2026-08-28-txs-type-filter-design.md`; consult it if anything here is ambiguous, but this plan is the source of truth for implementation order.

---

## File Structure

| File | Change |
|---|---|
| `src/constants.js` | Add `TX_LIST_FILTER_TYPES`, `TX_TYPE_ARCHIVE_WINDOW`, `TX_TYPE_LIST_PAGE_SIZE`. |
| `src/db.js` | Add `tx_type_archive` table + `upsertTxTypeArchive`/`getTxTypeArchive`/`getTxTypeArchiveCount`/`trimTxTypeArchive` accessors. |
| `src/cache.js` | Add `importTxTypeArchive`/`refreshTxTypeArchive` (mirrors `/tx/list`) and `fetchUnconfirmedTxs` (live proxy of `/tx/unconfirmedTXList`). |
| `src/html.js` | Add `typeSwitch`, update `heroTxs` to take a `currentType` param, add `renderTxTypeArchiveRow`/`txTypeArchiveListHTML`/`txTypeArchiveMoreRows`/`txTypeArchiveLoadMoreRow`, add `renderUnconfirmedTxRow`/`unconfirmedTxListHTML`. |
| `index.js` | Branch `/txs`, `/api/txs`, `/api/txs/more` on `type`; add `/txs/unconfirmed` + `/api/txs/unconfirmed`; wire the new sync job into startup. |
| `test/db.test.js`, `test/cache.test.js`, `test/html.test.js` | New tests alongside each change. |

---

### Task 1: Constants + DB schema/accessors

**Files:**
- Modify: `src/constants.js`
- Modify: `src/db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Produces: `TX_LIST_FILTER_TYPES: string[]`, `TX_TYPE_ARCHIVE_WINDOW: number` (from `constants.js`); `upsertTxTypeArchive(filterType, hash, height, sender, recipient, amount, fee, timeStamp, type)`, `getTxTypeArchive(filterType, limit = 25, offset = 0)`, `getTxTypeArchiveCount(filterType)`, `trimTxTypeArchive(filterType, keep)` (from `db.js`) — all consumed by Tasks 2 and 4.

- [ ] **Step 1: Add the new constants**

In `src/constants.js`, after the `TX_TYPES` block (after line 32):

```js
// The six explorer.nemtool.com /tx/list "type" filter values that get their
// own local archive. "mosaic" isn't here — it's the same data /mosaictransfer
// already has (a transfer with a mosaic attachment), so the dropdown links
// there instead of duplicating it. "" (all) is the existing live /txs view.
export const TX_LIST_FILTER_TYPES = [
  "transfer",
  "importance",
  "aggregate",
  "multisig",
  "namespace",
  "apostille",
];

// Newest rows kept per filter_type in tx_type_archive — a bounded rolling
// window, not a full historical backfill (unlike mosaic_transfers). "transfer"
// alone is most of the chain's tx history, so an unbounded archive per type
// isn't viable the way it was for mosaic transfers.
export const TX_TYPE_ARCHIVE_WINDOW = 500;

// Fixed page size for the type-filtered /txs views (list + "load more").
// Unlike /mosaictransfer, this page has no rows-per-page control.
export const TX_TYPE_LIST_PAGE_SIZE = 25;
```

- [ ] **Step 2: Write the failing DB tests**

In `test/db.test.js`, add `upsertTxTypeArchive`, `getTxTypeArchive`, `getTxTypeArchiveCount`, `trimTxTypeArchive` to the destructured import block (alongside `upsertMosaicTransfer` etc. at the top of the file), then add:

```js
test("upsertTxTypeArchive/getTxTypeArchive round-trips and orders by height DESC", () => {
  networkContext.run("mainnet", () => {
    upsertTxTypeArchive("transfer", "hashA", 100, "SENDER1", "RECIP1", 5_000_000, 150000, 111, 257);
    upsertTxTypeArchive("transfer", "hashB", 200, "SENDER2", "RECIP2", 3_000_000, 150000, 222, 257);
    const rows = getTxTypeArchive("transfer", 10, 0);
    assert.deepEqual(rows.map((r) => r.hash), ["hashB", "hashA"]);
  });
});

test("a hash can be archived under two different filter_types independently", () => {
  networkContext.run("mainnet", () => {
    upsertTxTypeArchive("aggregate", "hashDual", 300, "S", "R", 0, 500000, 300, 4100);
    upsertTxTypeArchive("multisig", "hashDual", 300, "S", "R", 0, 500000, 300, 4100);
    assert.equal(getTxTypeArchiveCount("aggregate"), 1);
    assert.equal(getTxTypeArchiveCount("multisig"), 1);
  });
});

test("getTxTypeArchive supports offset for pagination", () => {
  networkContext.run("mainnet", () => {
    const page1 = getTxTypeArchive("transfer", 1, 0);
    const page2 = getTxTypeArchive("transfer", 1, 1);
    assert.notEqual(page1[0].hash, page2[0].hash);
  });
});

test("trimTxTypeArchive keeps only the newest `keep` rows for a filter_type and leaves other filter_types untouched", () => {
  networkContext.run("mainnet", () => {
    for (let i = 1; i <= 5; i++) {
      upsertTxTypeArchive("namespace", `hns${i}`, i * 10, "S", "", 0, 150000, i * 10, 8193);
    }
    upsertTxTypeArchive("importance", "hns-other", 999, "S", "R", 0, 150000, 999, 2049);
    trimTxTypeArchive("namespace", 3);
    assert.equal(getTxTypeArchiveCount("namespace"), 3);
    const rows = getTxTypeArchive("namespace", 10, 0);
    assert.deepEqual(rows.map((r) => r.height), [50, 40, 30]);
    assert.equal(getTxTypeArchiveCount("importance"), 1);
  });
});

test("tx_type_archive is isolated between mainnet and testnet", () => {
  networkContext.run("testnet", () => {
    assert.equal(getTxTypeArchiveCount("transfer"), 0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/db.test.js`
Expected: FAIL — `upsertTxTypeArchive is not a function` (or similar import errors).

- [ ] **Step 4: Add the schema and accessors**

In `src/db.js`, add the table to the `db.exec(...)` block right after the `mosaic_transfers` table (after line 81, before the closing `` ` `` at line 82):

```sql
    CREATE TABLE IF NOT EXISTS tx_type_archive (
      filter_type TEXT NOT NULL,
      hash TEXT NOT NULL,
      height INTEGER,
      sender TEXT,
      recipient TEXT,
      amount INTEGER,
      fee INTEGER,
      time_stamp INTEGER,
      type INTEGER,
      PRIMARY KEY (filter_type, hash)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_type_archive_filter ON tx_type_archive(filter_type, height DESC);
```

Add prepared statements after `_mtMaxNoStmt` (after line 230):

```js
  const _ttaUpsertStmt = db.prepare(
    "INSERT OR REPLACE INTO tx_type_archive (filter_type, hash, height, sender, recipient, amount, fee, time_stamp, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const _ttaSelectStmt = db.prepare(
    "SELECT hash, height, sender, recipient, amount, fee, time_stamp, type FROM tx_type_archive WHERE filter_type = ? ORDER BY height DESC, hash LIMIT ? OFFSET ?",
  );
  const _ttaCountStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM tx_type_archive WHERE filter_type = ?",
  );
  const _ttaTrimStmt = db.prepare(`
    DELETE FROM tx_type_archive
    WHERE filter_type = ?
      AND hash NOT IN (
        SELECT hash FROM tx_type_archive WHERE filter_type = ? ORDER BY height DESC, hash LIMIT ?
      )
  `);
```

Add to the returned object of `openDbLayer` (after `getMaxMosaicTransferNo`, currently line 254):

```js
    getTxTypeArchive: (filterType, limit = 25, offset = 0) =>
      _ttaSelectStmt.all(filterType, limit, offset),
    getTxTypeArchiveCount: (filterType) => _ttaCountStmt.get(filterType).c,
    trimTxTypeArchive: (filterType, keep) => _ttaTrimStmt.run(filterType, filterType, keep),
```

Add to the same returned object, alongside `upsertMosaicTransfer` (currently line 276-277):

```js
    upsertTxTypeArchive: (filterType, hash, height, sender, recipient, amount, fee, timeStamp, type) =>
      _ttaUpsertStmt.run(filterType, hash, height, sender, recipient, amount, fee, timeStamp, type),
```

Add the exported wrapper functions in the `// ── Read accessors ──` section, after `getMaxMosaicTransferNo` (after line 339):

```js
export function getTxTypeArchive(filterType, limit = 25, offset = 0) {
  return layer().getTxTypeArchive(filterType, limit, offset);
}
export function getTxTypeArchiveCount(filterType) {
  return layer().getTxTypeArchiveCount(filterType);
}
export function trimTxTypeArchive(filterType, keep) {
  layer().trimTxTypeArchive(filterType, keep);
}
```

And in the `// ── Write wrappers ──` section, after `upsertMosaicTransfer` (after line 393):

```js
export function upsertTxTypeArchive(filterType, hash, height, sender, recipient, amount, fee, timeStamp, type) {
  layer().upsertTxTypeArchive(filterType, hash, height, sender, recipient, amount, fee, timeStamp, type);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/db.test.js`
Expected: PASS (all tests in the file, including the 5 new ones).

---

### Task 2: Sync job (`importTxTypeArchive` / `refreshTxTypeArchive`) + unconfirmed proxy fetch

**Files:**
- Modify: `src/cache.js`
- Test: `test/cache.test.js`

**Interfaces:**
- Consumes: `TX_LIST_FILTER_TYPES`, `TX_TYPE_ARCHIVE_WINDOW`, `ARCHIVE_PAGE_DELAY_MS` (constants.js); `upsertTxTypeArchive`, `trimTxTypeArchive`, `getCacheMeta`, `setCacheMeta` (db.js, Task 1).
- Produces: `importTxTypeArchive(): Promise<void>`, `refreshTxTypeArchive(): Promise<void>`, `fetchUnconfirmedTxs(): Promise<Array>` — consumed by Task 6 (index.js wiring/routes).

- [ ] **Step 1: Write the failing sync-job tests**

In `test/cache.test.js`, add to the destructured `cache.js` import: `importTxTypeArchive`, `refreshTxTypeArchive`, `fetchUnconfirmedTxs`. Add to the destructured `db.js` import: `getTxTypeArchiveCount`, `getTxTypeArchive`, `upsertTxTypeArchive`. Add `TX_LIST_FILTER_TYPES`/`TX_TYPE_ARCHIVE_WINDOW` via a **dynamic** import placed with the other `await import(...)` lines, NOT a static `import ... from` — a static import is hoisted ahead of everything else in the module, including this file's `process.env.NEMSCAN_DB_DIR = mkdtempSync(...)` line, which would make constants.js (and db.js's `NETWORKS` through it) resolve against the real repo-root `cache.db`/`cache-testnet.db` instead of the scratch dir (confirmed live during this plan's own execution — see the corresponding progress-ledger incident note):

```js
const { TX_LIST_FILTER_TYPES, TX_TYPE_ARCHIVE_WINDOW } = await import("../src/constants.js");
```

Then add:

```js
test("importTxTypeArchive fetches one page per filter_type (stopping on a short page) and marks each type's import flag", async (t) => {
  const requestedTypes = [];
  t.mock.method(global, "fetch", async (url, opts) => {
    const body = JSON.parse(opts.body);
    requestedTypes.push(body.type);
    return {
      ok: true,
      json: async () => [
        { hash: `h-${body.type}`, height: 100, sender: "S", recipient: "R", amount: 1, fee: 150000, timeStamp: 100, type: 257 },
      ],
    };
  });

  await networkContext.run("mainnet", async () => {
    await importTxTypeArchive();
    assert.deepEqual(requestedTypes.slice().sort(), TX_LIST_FILTER_TYPES.slice().sort());
    for (const type of TX_LIST_FILTER_TYPES) {
      assert.equal(getCacheMeta(`tx_type_archive_imported_${type}`) != null, true);
    }
    assert.equal(getTxTypeArchiveCount("transfer"), 1);
  });
});

test("importTxTypeArchive skips a filter_type whose import flag is already set", async (t) => {
  let calls = 0;
  t.mock.method(global, "fetch", async () => {
    calls++;
    return { ok: true, json: async () => [] };
  });
  await networkContext.run("mainnet", async () => {
    const { setCacheMeta } = await import("../src/db.js");
    for (const type of TX_LIST_FILTER_TYPES) setCacheMeta(`tx_type_archive_imported_${type}`, Date.now());
    await importTxTypeArchive();
    assert.equal(calls, 0);
  });
});

test("importTxTypeArchive logs and continues past a failure for one filter_type instead of aborting the rest", async (t) => {
  await networkContext.run("mainnet", async () => {
    const { getDb } = await import("../src/db.js");
    getDb().exec("DELETE FROM cache_meta WHERE key LIKE 'tx_type_archive_imported_%'");

    const requestedTypes = [];
    t.mock.method(global, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      requestedTypes.push(body.type);
      if (body.type === "namespace") return { ok: false, status: 500, json: async () => [] };
      return { ok: true, json: async () => [{ hash: `h-${body.type}`, height: 1, sender: "S", recipient: "R", amount: 0, fee: 0, timeStamp: 1, type: 257 }] };
    });

    await importTxTypeArchive();
    assert.equal(requestedTypes.length, 6, "expected every filter_type to be attempted even after one fails");
    assert.equal(getCacheMeta("tx_type_archive_imported_namespace"), null);
    assert.equal(getCacheMeta("tx_type_archive_imported_transfer") != null, true);
  });
});

test("refreshTxTypeArchive only refreshes filter_types whose backfill has completed", async (t) => {
  await networkContext.run("mainnet", async () => {
    const { getDb, setCacheMeta } = await import("../src/db.js");
    getDb().exec("DELETE FROM cache_meta WHERE key LIKE 'tx_type_archive_imported_%'");
    setCacheMeta("tx_type_archive_imported_transfer", Date.now());

    const requestedTypes = [];
    t.mock.method(global, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      requestedTypes.push(body.type);
      return { ok: true, json: async () => [{ hash: "hRefresh", height: 500, sender: "S", recipient: "R", amount: 1, fee: 1, timeStamp: 500, type: 257 }] };
    });

    await refreshTxTypeArchive();
    assert.deepEqual(requestedTypes, ["transfer"]);
  });
});

test("refreshTxTypeArchive trims each filter_type back down to TX_TYPE_ARCHIVE_WINDOW after topping up", async (t) => {
  await networkContext.run("mainnet", async () => {
    const { getDb, setCacheMeta } = await import("../src/db.js");
    getDb().exec("DELETE FROM cache_meta WHERE key LIKE 'tx_type_archive_imported_%'");
    getDb().exec("DELETE FROM tx_type_archive WHERE filter_type = 'transfer'");
    setCacheMeta("tx_type_archive_imported_transfer", Date.now());
    for (let i = 0; i < TX_TYPE_ARCHIVE_WINDOW; i++) {
      upsertTxTypeArchive("transfer", `hOld${i}`, i, "S", "R", 1, 1, i, 257);
    }

    t.mock.method(global, "fetch", async () => ({
      ok: true,
      json: async () => [{ hash: "hNew", height: TX_TYPE_ARCHIVE_WINDOW + 1, sender: "S", recipient: "R", amount: 1, fee: 1, timeStamp: 999999, type: 257 }],
    }));

    await refreshTxTypeArchive();
    assert.equal(getTxTypeArchiveCount("transfer"), TX_TYPE_ARCHIVE_WINDOW);
    const rows = getTxTypeArchive("transfer", 1, 0);
    assert.equal(rows[0].hash, "hNew");
    assert.equal(
      getTxTypeArchive("transfer", TX_TYPE_ARCHIVE_WINDOW, 0).some((r) => r.hash === "hOld0"),
      false,
      "expected the oldest pre-existing row to have been trimmed",
    );
  });
});

test("refreshTxTypeArchive catches a failure for one filter_type and continues with the others", async (t) => {
  await networkContext.run("mainnet", async () => {
    const { getDb, setCacheMeta } = await import("../src/db.js");
    getDb().exec("DELETE FROM cache_meta WHERE key LIKE 'tx_type_archive_imported_%'");
    for (const type of TX_LIST_FILTER_TYPES) setCacheMeta(`tx_type_archive_imported_${type}`, Date.now());

    const requestedTypes = [];
    t.mock.method(global, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      requestedTypes.push(body.type);
      if (body.type === "namespace") return { ok: false, status: 500, json: async () => [] };
      return { ok: true, json: async () => [] };
    });

    await refreshTxTypeArchive();
    assert.equal(requestedTypes.length, 6, "expected every filter_type to be attempted even after one fails");
  });
});

test("fetchUnconfirmedTxs posts to nemtool's unconfirmedTXList endpoint and returns its array", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    assert.equal(String(url), "https://explorer.nemtool.com/tx/unconfirmedTXList");
    return { ok: true, json: async () => [{ hash: "hPending", type: 257 }] };
  });
  const items = await fetchUnconfirmedTxs();
  assert.deepEqual(items, [{ hash: "hPending", type: 257 }]);
});

test("fetchUnconfirmedTxs throws on a non-ok response", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 500, json: async () => [] }));
  await assert.rejects(() => fetchUnconfirmedTxs(), /status 500/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cache.test.js`
Expected: FAIL — `importTxTypeArchive is not a function` (or similar).

- [ ] **Step 3: Implement the sync job and proxy fetch**

In `src/cache.js`, add to the top-level import from `./db.js` (alongside `upsertMosaicTransfer`, `getMaxMosaicTransferNo`): `upsertTxTypeArchive`, `trimTxTypeArchive`. Add to the top-level import from `./constants.js`: `TX_LIST_FILTER_TYPES`, `TX_TYPE_ARCHIVE_WINDOW`.

Then add this new section after the mosaic-transfer block (after `refreshMosaicTransfers`'s closing brace, currently line 448):

```js
// ── Transaction type archive ─────────────────────────────────────────────────

const NEMTOOL_TX_LIST_URL = "https://explorer.nemtool.com/tx/list";
const NEMTOOL_TX_UNCONFIRMED_URL = "https://explorer.nemtool.com/tx/unconfirmedTXList";
// nemtool's /tx/list page size is fixed server-side at 10 regardless of any
// pageSize sent — confirmed live; only `page` and `type` actually affect the
// response. A page shorter than this means that filter_type is exhausted.
const NEMTOOL_TX_LIST_PAGE_SIZE = 10;

// One-time backfill per filter_type, each independently guarded by its own
// cache_meta flag (tx_type_archive_imported_<type>) rather than one flag for
// the whole function — so a transient failure fetching e.g. "namespace"
// doesn't also block "transfer" from ever completing, and a restart only
// retries the type(s) that didn't finish. Stops each type's backfill once
// TX_TYPE_ARCHIVE_WINDOW records have been seen or a page comes back
// shorter than NEMTOOL_TX_LIST_PAGE_SIZE (exhausted) — unlike
// importMosaicTransferArchive, no resumable cursor is needed: worst case is
// ~50 requests per type, a small one-time cost, not an open-ended walk.
export async function importTxTypeArchive() {
  for (const filterType of TX_LIST_FILTER_TYPES) {
    const metaKey = `tx_type_archive_imported_${filterType}`;
    if (getCacheMeta(metaKey)) continue;
    try {
      let seen = 0;
      let page = 1;
      while (seen < TX_TYPE_ARCHIVE_WINDOW) {
        const res = await fetch(NEMTOOL_TX_LIST_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page, type: filterType }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const batch = await res.json();
        if (!Array.isArray(batch) || !batch.length) break;
        for (const item of batch) {
          upsertTxTypeArchive(
            filterType,
            item.hash,
            item.height,
            item.sender,
            item.recipient,
            item.amount || 0,
            item.fee || 0,
            item.timeStamp,
            item.type,
          );
        }
        seen += batch.length;
        if (batch.length < NEMTOOL_TX_LIST_PAGE_SIZE) break;
        page++;
        await new Promise((r) => setTimeout(r, ARCHIVE_PAGE_DELAY_MS));
      }
      setCacheMeta(metaKey, Date.now());
    } catch (err) {
      console.error(`Tx type archive import failed for type=${filterType}:`, err.message);
    }
  }
}

const _refreshingTxTypeArchive = { mainnet: false, testnet: false };

// Ongoing top-up: fetches just the newest page (page: 1) per filter_type
// whose backfill has completed, upserts it (idempotent via INSERT OR
// REPLACE), then trims back to TX_TYPE_ARCHIVE_WINDOW. Unlike
// refreshMosaicTransfers, this never needs to walk forward hunting for "how
// far behind are we" — the window is bounded and trimmed every run
// regardless, so only the newest page is ever needed. Each filter_type is
// wrapped in its own try/catch so one failing type doesn't stop the others.
export async function refreshTxTypeArchive() {
  const network = currentNetwork();
  if (_refreshingTxTypeArchive[network]) return;
  _refreshingTxTypeArchive[network] = true;
  try {
    for (const filterType of TX_LIST_FILTER_TYPES) {
      if (!getCacheMeta(`tx_type_archive_imported_${filterType}`)) continue;
      try {
        const res = await fetch(NEMTOOL_TX_LIST_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page: 1, type: filterType }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const batch = await res.json();
        if (Array.isArray(batch)) {
          for (const item of batch) {
            upsertTxTypeArchive(
              filterType,
              item.hash,
              item.height,
              item.sender,
              item.recipient,
              item.amount || 0,
              item.fee || 0,
              item.timeStamp,
              item.type,
            );
          }
        }
        trimTxTypeArchive(filterType, TX_TYPE_ARCHIVE_WINDOW);
      } catch (err) {
        console.error(`Tx type archive refresh failed for type=${filterType}:`, err.message);
      }
    }
  } finally {
    _refreshingTxTypeArchive[network] = false;
  }
}

// Live proxy for the unconfirmed-tx pool — NIS1 has no "list all unconfirmed
// transactions" endpoint (confirmed live: POST /transactions/unconfirmed is
// actually the *announce* endpoint, not a list). nemtool runs its own
// backend that tracks the pool and exposes it via this POST. Unlike
// everything else in this file, this is never stored locally — the pool
// changes constantly and has no archival value, so every call to this
// function hits nemtool fresh.
export async function fetchUnconfirmedTxs() {
  const res = await fetch(NEMTOOL_TX_UNCONFIRMED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/cache.test.js`
Expected: PASS (all tests in the file, including the 8 new ones).

---

### Task 3: Type dropdown + `heroTxs` update

**Files:**
- Modify: `src/html.js`
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: `TX_LIST_FILTER_TYPES` (constants.js, Task 1).
- Produces: `typeSwitch(currentType: string|null): string`, `heroTxs(currentType: string|null = null): string` — consumed by Task 4 (list rendering) and Task 6 (routes).

- [ ] **Step 1: Write the failing tests**

In `test/html.test.js`, add `heroTxs` and `typeSwitch` to the destructured import from `../src/html.js`. Add:

```js
test("typeSwitch marks 'All' active when no type is given, and links straight to /txs", () => {
  const html = typeSwitch(null);
  assert.match(html, /class="rows-menu-item active" href="\/txs" role="menuitem">All</);
});

test("typeSwitch marks the matching item active for a given type", () => {
  const html = typeSwitch("importance");
  assert.match(html, /class="rows-menu-item active" href="\/txs\?type=importance" role="menuitem">Importance</);
  assert.doesNotMatch(html, /class="rows-menu-item active" href="\/txs" role/);
});

test("typeSwitch marks Pending active for the 'pending' pseudo-type", () => {
  const html = typeSwitch("pending");
  assert.match(html, /class="rows-menu-item active" href="\/txs\/unconfirmed" role="menuitem">Pending</);
});

test("typeSwitch links Mosaic to the existing /mosaictransfer page, never a type= query", () => {
  const html = typeSwitch(null);
  assert.match(html, /href="\/mosaictransfer" role="menuitem">Mosaic</);
});

test("typeSwitch's button label reflects the current selection", () => {
  assert.match(typeSwitch(null), /rows-switch-label">All</);
  assert.match(typeSwitch("apostille"), /rows-switch-label">Apostille</);
});

test("heroTxs embeds the type dropdown", () => {
  const html = heroTxs("transfer");
  assert.match(html, /rows-switch-label">Transfer</);
  assert.match(html, /<h1>Transactions<\/h1>/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/html.test.js`
Expected: FAIL — `typeSwitch is not a function` / `heroTxs is not defined` (it exists but the test import list will be wrong until Step 1's import edit — the assertions themselves fail with "does not match" since the dropdown doesn't exist yet).

- [ ] **Step 3: Implement `typeSwitch` and update `heroTxs`**

In `src/html.js`, add `TX_LIST_FILTER_TYPES` to the existing constants import (line 26):

```js
import { TX_TYPES, XEM_TOTAL_SUPPLY, DAILY_TX_DAYS, NETWORKS, TX_LIST_FILTER_TYPES } from "./constants.js";
```

Add this new function right before `heroTxs` (before line 402):

```js
const TX_TYPE_LABELS = {
  transfer: "Transfer",
  importance: "Importance",
  aggregate: "Aggregate",
  multisig: "Multisig",
  namespace: "Namespace",
  apostille: "Apostille",
  pending: "Pending",
};

// The "Type" filter dropdown on /txs and /txs/unconfirmed. Deliberately
// reuses the existing rows-switch/rows-menu/rows-menu-item CSS classes and
// the generic window.toggleRowsMenu JS (both already scoped per-instance via
// btn.parentElement, so a second independent dropdown needs no changes) —
// no new CSS or JS. Unlike the rows-per-page instance of this same
// component (which stays htmx-driven), these items are plain links: picking
// a type swaps the whole dataset/pagination model, so a real navigation
// (shareable URL) fits better than an in-page swap.
export function typeSwitch(currentType) {
  const label = TX_TYPE_LABELS[currentType] || "All";
  const item = (href, text, active) =>
    `<a class="rows-menu-item${active ? " active" : ""}" href="${href}" role="menuitem">${text}</a>`;
  const typeItems = TX_LIST_FILTER_TYPES.map((t) =>
    item(`/txs?type=${t}`, TX_TYPE_LABELS[t], currentType === t),
  ).join("");
  return `
    <div class="rows-ctrl">
      <span class="rows-ctrl-label">Type:</span>
      <div class="rows-switch">
        <button type="button" class="rows-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleRowsMenu(event)" title="Transaction type">
          <span class="rows-switch-label">${label}</span>
          <span class="rows-switch-caret">&#9662;</span>
        </button>
        <div class="rows-menu" role="menu" aria-label="Transaction type">
          ${item("/txs", "All", !currentType)}
          ${typeItems}
          ${item("/mosaictransfer", "Mosaic", false)}
          ${item("/txs/unconfirmed", "Pending", currentType === "pending")}
        </div>
      </div>
    </div>`;
}
```

Replace `heroTxs` (lines 402-406):

```js
export function heroTxs(currentType = null) {
  return `<div class="hero"><div class="hero-inner">
    <div class="hero-row">
      <h1>Transactions</h1>
      ${typeSwitch(currentType)}
    </div>
  </div></div>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/html.test.js`
Expected: PASS.

---

### Task 4: Type-filtered list rendering (`renderTxTypeArchiveRow` / `txTypeArchiveListHTML` / `txTypeArchiveMoreRows`)

**Files:**
- Modify: `src/html.js`
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: `getTxTypeArchiveCount` (db.js, Task 1).
- Produces: `renderTxTypeArchiveRow(row): string`, `txTypeArchiveListHTML(items, filterType, limit): string`, `txTypeArchiveMoreRows(items, filterType, offset, total, limit): string` — consumed by Task 6 (routes).

- [ ] **Step 1: Write the failing tests**

In `test/html.test.js`, add `getTxTypeArchiveCount`... actually that's a db.js export, not needed directly in the test — instead add `renderTxTypeArchiveRow`, `txTypeArchiveListHTML`, `txTypeArchiveMoreRows` to the destructured import from `../src/html.js`, and `upsertTxTypeArchive` to the destructured import from `../src/db.js` (it already imports `upsertMosaicTransfer` from there). Add:

```js
test("renderTxTypeArchiveRow shows an em-dash for Recipient/Amount when the row has no recipient (namespace/aggregate-style)", () => {
  const html = renderTxTypeArchiveRow({ hash: "h1", height: 100, sender: "SENDERADDR", recipient: "", amount: 0, fee: 150000, time_stamp: 100, type: 8193 });
  assert.match(html, /<span class="muted">—<\/span>/);
  assert.doesNotMatch(html, /href="\/account\/"/);
});

test("renderTxTypeArchiveRow links a real recipient and shows its amount (importance/multisig-style)", () => {
  const html = renderTxTypeArchiveRow({ hash: "h2", height: 100, sender: "S", recipient: "RECIPADDR", amount: 0, fee: 150000, time_stamp: 100, type: 2049 });
  assert.match(html, /href="\/account\/RECIPADDR"/);
});

test("renderTxTypeArchiveRow links Block to the block detail page", () => {
  const html = renderTxTypeArchiveRow({ hash: "h4", height: 12345, sender: "S", recipient: "R", amount: 1, fee: 1, time_stamp: 100, type: 257 });
  assert.match(html, /href="\/block\/12345"/);
});

test("renderTxTypeArchiveRow escapes sender/recipient, which come from a third-party archive rather than this app's own validated addresses", () => {
  const html = renderTxTypeArchiveRow({ hash: "h3", height: 100, sender: '"><script>1</script>', recipient: '"><script>2</script>', amount: 1, fee: 1, time_stamp: 100, type: 257 });
  assert.doesNotMatch(html, /<script>/);
});

test("txTypeArchiveListHTML shows a type-specific empty state", () => {
  assert.match(txTypeArchiveListHTML([], "apostille", 25), /No apostille transactions found/);
});

test("txTypeArchiveListHTML renders rows and reflects getTxTypeArchiveCount for the total", () => {
  networkContext.run("mainnet", () => {
    upsertTxTypeArchive("transfer", "hList", 500, "S", "R", 1_000_000, 150000, 500, 257);
    const html = txTypeArchiveListHTML([{ hash: "hList", height: 500, sender: "S", recipient: "R", amount: 1_000_000, fee: 150000, time_stamp: 500, type: 257 }], "transfer", 25);
    assert.match(html, /Transfer Transactions/);
    assert.match(html, /<strong>1<\/strong> total/);
  });
});

test("txTypeArchiveMoreRows drops the Load More control once offset reaches total", () => {
  const items = [{ hash: "h", height: 1, sender: "S", recipient: "R", amount: 1, fee: 1, time_stamp: 1, type: 257 }];
  const html = txTypeArchiveMoreRows(items, "transfer", 0, 1, 25);
  assert.doesNotMatch(html, /Load More/);
});

test("txTypeArchiveMoreRows keeps the Load More control, with the type and offset preserved in its URL, when more remain", () => {
  const items = [{ hash: "h", height: 1, sender: "S", recipient: "R", amount: 1, fee: 1, time_stamp: 1, type: 257 }];
  const html = txTypeArchiveMoreRows(items, "transfer", 0, 5, 25);
  assert.match(html, /Load More/);
  assert.match(html, /\/api\/txs\/more\?type=transfer&offset=1&limit=25/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/html.test.js`
Expected: FAIL — the new functions don't exist yet.

- [ ] **Step 3: Implement the row renderer and list HTML**

In `src/html.js`, add `getTxTypeArchiveCount` to the existing `./db.js` import block (line 3-11, alongside `getMosaicTransfersCount`).

Add these functions right after `renderGlobalTxRow` (after line 1318, before `globalLoadMoreRow`):

```js
// Row renderer for the type-filtered archive (mirrored from
// explorer.nemtool.com's /tx/list, see cache.js's importTxTypeArchive).
// Deliberately NOT a reuse of renderGlobalTxRow: that function works off a
// raw NIS1 tx object (tx.signer as a public key, resolved via
// addrFromPubKey), while the archive already has resolved address strings
// for sender/recipient — different shapes. It also can't gate
// Recipient/Amount on `type === 257` the way renderGlobalTxRow does:
// confirmed live, "importance" (2049) and "multisig" (4100) archive rows DO
// have a real recipient/amount, while "namespace" (8193) and "aggregate"
// (4097) rows have recipient: "" and amount: 0 (those tx types don't move
// XEM or name a recipient) — so the gate here is "does this row have a
// recipient", not "is this a plain transfer".
export function renderTxTypeArchiveRow(row) {
  const hasRecipient = !!row.recipient;
  const toCell = hasRecipient
    ? `<a href="/account/${esc(row.recipient)}" class="mono-link" title="${esc(row.recipient)}">${esc(truncKey(row.recipient))}</a>`
    : `<span class="muted">—</span>`;
  const amountCell = hasRecipient
    ? `${xem(row.amount)} XEM`
    : `<span class="muted">—</span>`;
  const date = nemDate(row.time_stamp);
  return `<tr>
    <td><a href="/block/${row.height}" class="blk-link">${row.height}</a></td>
    <td><a href="/account/${esc(row.sender)}" class="mono-link" title="${esc(row.sender)}">${esc(truncKey(row.sender))}</a></td>
    <td>${toCell}</td>
    <td><span class="type-pill ${row.type === 257 ? "type-transfer" : "type-other"}">${TX_TYPES[row.type] || `Type ${row.type}`}</span></td>
    <td class="td-right">${amountCell}</td>
    <td class="td-right fee-val">${xem(row.fee)} XEM</td>
    <td class="mono-muted">${date.toISOString().slice(0, 16).replace("T", " ")} UTC</td>
    <td>${timeAgo(date)}</td>
  </tr>`;
}

export function txTypeArchiveLoadMoreRow(offset, total, limit, filterType) {
  if (offset >= total) return "";
  return `<tr id="tta-load-more-row"><td colspan="8" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/txs/more?type=${filterType}&offset=${offset}&limit=${limit}"
            hx-target="#tta-load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

export function txTypeArchiveMoreRows(items, filterType, offset, total, limit) {
  if (!items.length) return "";
  return (
    items.map(renderTxTypeArchiveRow).join("") +
    txTypeArchiveLoadMoreRow(offset + items.length, total, limit, filterType)
  );
}

export function txTypeArchiveListHTML(items, filterType, limit) {
  if (!items.length)
    return `<div class="empty-state">No ${esc(filterType)} transactions found</div>`;
  const total = getTxTypeArchiveCount(filterType);
  const title = filterType[0].toUpperCase() + filterType.slice(1);
  return `
  <div class="card-head">
    <div class="card-title">${title} Transactions</div>
    <span class="total-txt"><strong>${total.toLocaleString("en")}</strong> total</span>
  </div>
  <div class="tbl-wrap"><table>
    <thead><tr>
      <th>Block</th><th>Sender</th><th>Recipient</th><th>Type</th>
      <th class="th-right">Amount (XEM)</th><th class="th-right">Fee</th><th>Timestamp</th><th>Age</th>
    </tr></thead>
    <tbody>${items.map(renderTxTypeArchiveRow).join("")}${txTypeArchiveLoadMoreRow(items.length, total, limit, filterType)}</tbody>
  </table></div>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/html.test.js`
Expected: PASS.

---

### Task 5: Unconfirmed-tx rendering (`renderUnconfirmedTxRow` / `unconfirmedTxListHTML`)

**Files:**
- Modify: `src/html.js`
- Test: `test/html.test.js`

**Interfaces:**
- Produces: `renderUnconfirmedTxRow(tx): string`, `unconfirmedTxListHTML(items): string` — consumed by Task 6 (routes).

- [ ] **Step 1: Write the failing tests**

In `test/html.test.js`, add `renderUnconfirmedTxRow`, `unconfirmedTxListHTML` to the destructured import from `../src/html.js`. Add:

```js
test("renderUnconfirmedTxRow unwraps a multisig (type 4100) record's otherTrans for sender/recipient/amount/fee", () => {
  const tx = {
    hash: "hUnconfirmed", type: 4100, timeStamp: 100,
    otherTrans: { sender: "INNERSENDER", recipient: "INNERRECIP", amount: 7_000_000, fee: 150000 },
  };
  const html = renderUnconfirmedTxRow(tx);
  assert.match(html, /href="\/account\/INNERSENDER"/);
  assert.match(html, /href="\/account\/INNERRECIP"/);
  assert.match(html, />7\.000000 XEM</);
});

test("renderUnconfirmedTxRow renders a plain transfer directly (no otherTrans)", () => {
  const tx = { hash: "hPlain", type: 257, sender: "S", recipient: "R", amount: 1_000_000, fee: 150000, timeStamp: 100 };
  const html = renderUnconfirmedTxRow(tx);
  assert.match(html, /href="\/account\/S"/);
  assert.match(html, /href="\/account\/R"/);
  assert.match(html, />1\.000000 XEM</);
});

test("renderUnconfirmedTxRow falls back to signature when hash is absent", () => {
  const tx = { signature: "sig123abc", type: 257, sender: "S", recipient: "R", amount: 1, fee: 1, timeStamp: 100 };
  const html = renderUnconfirmedTxRow(tx);
  assert.match(html, /sig123abc/);
});

test("renderUnconfirmedTxRow escapes sender/recipient, which come from a third-party feed", () => {
  const tx = { hash: "h", type: 257, sender: '"><script>1</script>', recipient: '"><script>2</script>', amount: 1, fee: 1, timeStamp: 100 };
  assert.doesNotMatch(renderUnconfirmedTxRow(tx), /<script>/);
});

test("unconfirmedTxListHTML shows an empty state when the pool is empty", () => {
  assert.match(unconfirmedTxListHTML([]), /No pending transactions right now/);
});

test("unconfirmedTxListHTML renders a row per item and the pending count", () => {
  const items = [
    { hash: "h1", type: 257, sender: "S", recipient: "R", amount: 1, fee: 1, timeStamp: 100 },
    { hash: "h2", type: 257, sender: "S2", recipient: "R2", amount: 1, fee: 1, timeStamp: 100 },
  ];
  const html = unconfirmedTxListHTML(items);
  assert.match(html, /<strong>2<\/strong> pending/);
  assert.match(html, /href="\/account\/S"/);
  assert.match(html, /href="\/account\/S2"/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/html.test.js`
Expected: FAIL — the new functions don't exist yet.

- [ ] **Step 3: Implement the unconfirmed-tx renderer**

In `src/html.js`, add these functions right after `unconfirmedTxListHTML`'s sibling `txTypeArchiveListHTML` (i.e. at the end of the block added in Task 4):

```js
// Row renderer for the live unconfirmed-tx pool (see cache.js's
// fetchUnconfirmedTxs). Unlike the type-archive rows (Task 4), nemtool's
// unconfirmed feed nests a type-4100 (multisig) record's real transfer
// under `otherTrans` — confirmed in nemtool's own
// UnconfirmedTXController.handleTX, the only place that field is used (the
// regular /tx/list records are flat). No block height yet (unconfirmed), so
// there's no Block column here, unlike renderTxTypeArchiveRow.
export function renderUnconfirmedTxRow(tx) {
  const inner = tx.type === 4100 && tx.otherTrans ? tx.otherTrans : tx;
  const sender = inner.sender || tx.sender || "";
  const recipient = inner.recipient || "";
  const amount = inner.amount || 0;
  const fee = inner.fee ?? tx.fee ?? 0;
  const hasRecipient = !!recipient;
  const toCell = hasRecipient
    ? `<a href="/account/${esc(recipient)}" class="mono-link" title="${esc(recipient)}">${esc(truncKey(recipient))}</a>`
    : `<span class="muted">—</span>`;
  const amountCell = hasRecipient ? `${xem(amount)} XEM` : `<span class="muted">—</span>`;
  const ident = tx.hash || tx.signature || "";
  return `<tr>
    <td><a href="/account/${esc(sender)}" class="mono-link" title="${esc(sender)}">${esc(truncKey(sender))}</a></td>
    <td>${toCell}</td>
    <td><span class="type-pill ${tx.type === 257 ? "type-transfer" : "type-other"}">${TX_TYPES[tx.type] || `Type ${tx.type}`}</span></td>
    <td class="td-right">${amountCell}</td>
    <td class="td-right fee-val">${xem(fee)} XEM</td>
    <td class="mono-muted" title="${esc(ident)}">${esc(truncHash(ident))}</td>
    <td>${timeAgo(nemDate(tx.timeStamp))}</td>
  </tr>`;
}

export function unconfirmedTxListHTML(items) {
  if (!items.length)
    return `<div class="empty-state">No pending transactions right now</div>`;
  return `
  <div class="card-head">
    <div class="card-title">Pending Transactions <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    <span class="total-txt"><strong>${items.length}</strong> pending</span>
  </div>
  <div class="tbl-wrap"><table>
    <thead><tr>
      <th>Sender</th><th>Recipient</th><th>Type</th>
      <th class="th-right">Amount (XEM)</th><th class="th-right">Fee</th><th>Hash</th><th>Age</th>
    </tr></thead>
    <tbody>${items.map(renderUnconfirmedTxRow).join("")}</tbody>
  </table></div>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/html.test.js`
Expected: PASS.

---

### Task 6: Routes — type-branch `/txs`/`/api/txs`/`/api/txs/more`, add `/txs/unconfirmed`, wire startup

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: everything produced by Tasks 1-5 (`TX_LIST_FILTER_TYPES`, `TX_TYPE_LIST_PAGE_SIZE`, `getTxTypeArchive`, `getTxTypeArchiveCount`, `importTxTypeArchive`, `refreshTxTypeArchive`, `fetchUnconfirmedTxs`, `heroTxs`, `txTypeArchiveListHTML`, `txTypeArchiveMoreRows`, `unconfirmedTxListHTML`).
- Produces: the working `/txs?type=...`, `/txs/unconfirmed` routes — this is the final integration task; there's no Task 7 consuming its output.

- [ ] **Step 1: Update imports**

In `index.js`, update the `./src/cache.js` import block (lines 5-22) to add `importTxTypeArchive`, `refreshTxTypeArchive`, `fetchUnconfirmedTxs` (alongside `importMosaicTransferArchive`, `refreshMosaicTransfers`):

```js
import {
  fetchSubNamespaces,
  fetchMosaicsForNamespace,
  refreshNamespacesCache,
  refreshMosaicsCache,
  refreshAllMosaicsDeep,
  importNamespaceArchive,
  importMosaicArchive,
  importMosaicTransferArchive,
  refreshMosaicTransfers,
  importTxTypeArchive,
  refreshTxTypeArchive,
  fetchUnconfirmedTxs,
  importPollArchive,
  refreshRichListCache,
  refreshLiveRichList,
  refreshPriceCache,
  scheduleDailyTxStatsRefresh,
  liveRichList,
  liveRichListUpdatedAt,
} from "./src/cache.js";
```

Update the `./src/constants.js` import (line 29) to add the two new constants:

```js
import { NETWORKS, TX_LIST_FILTER_TYPES, TX_TYPE_LIST_PAGE_SIZE } from "./src/constants.js";
```

Update the `./src/db.js` import block (lines 41-56) to add `getTxTypeArchive`, `getTxTypeArchiveCount` (alongside `getMosaicTransfers`, `getMosaicTransfersCount`):

```js
import {
  getCacheMeta,
  getCachedNamespaces,
  getNamespacesWithArchive,
  getNamespacesWithArchiveCount,
  getCachedMosaics,
  getMosaicsWithArchive,
  getMosaicsWithArchiveCount,
  getCachedPolls,
  getCachedPollsCount,
  getNamespaceByFqn,
  getMosaicsByNamespace,
  getMosaicByNsAndName,
  getMosaicTransfers,
  getMosaicTransfersCount,
  getTxTypeArchive,
  getTxTypeArchiveCount,
} from "./src/db.js";
```

Update the `./src/html.js` import block (lines 63-110) to add `txTypeArchiveListHTML`, `txTypeArchiveMoreRows`, `unconfirmedTxListHTML` (alongside `globalTxTableHTML`, `globalTxMoreRows`):

```js
  globalTxTableHTML,
  globalTxMoreRows,
  txTypeArchiveListHTML,
  txTypeArchiveMoreRows,
  unconfirmedTxListHTML,
```

(insert those three lines right after the existing `globalTxMoreRows,` line; `heroTxs` is already imported, no change needed there since only its signature changed, not its name).

- [ ] **Step 2: Branch `/txs` on `type`**

Replace the `/txs` route (lines 454-469):

```js
app.get("/txs", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  const type = TX_LIST_FILTER_TYPES.includes(req.query.type) ? req.query.type : null;
  const apiUrl = type ? `/api/txs?type=${type}` : "/api/txs";
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      "Transactions - NEMSCAN",
      heroTxs(type),
      "txs-card",
      apiUrl,
      `<div class="loading"><div class="spinner"></div><span>Fetching latest transactions…</span></div>`,
      "/txs",
      "Browse all NEM (XEM) blockchain transactions on NEMSCAN. View sender, recipient, amount, and block details.",
      `${base}/txs`,
    ),
  );
});
```

- [ ] **Step 3: Branch `/api/txs` on `type`**

Replace the `/api/txs` route (lines 471-482):

```js
app.get("/api/txs", async (req, res) => {
  const type = TX_LIST_FILTER_TYPES.includes(req.query.type) ? req.query.type : null;
  if (type) {
    res.setHeader("Content-Type", "text/html");
    if (currentNetwork() === "testnet") {
      return res.send(unavailableOnTestnetHTML("Transaction type filters"));
    }
    try {
      const items = getTxTypeArchive(type, TX_TYPE_LIST_PAGE_SIZE, 0);
      return res.send(txTypeArchiveListHTML(items, type, TX_TYPE_LIST_PAGE_SIZE));
    } catch (err) {
      res.status(503);
      return res.send(errorFrag(err.message, `/api/txs?type=${type}`, "#txs-card"));
    }
  }
  try {
    const height = await getHeight();
    const fromHeight = parseInt(req.query.fromBlock) || height;
    const { items, nextFromBlock } = await getTxsFromBlocks(fromHeight);
    res.setHeader("Content-Type", "text/html");
    res.send(globalTxTableHTML(items, height, nextFromBlock));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, "/api/txs", "#txs-card"));
  }
});
```

- [ ] **Step 4: Branch `/api/txs/more` on `type`**

Replace the `/api/txs/more` route (lines 484-494):

```js
app.get("/api/txs/more", async (req, res) => {
  const type = TX_LIST_FILTER_TYPES.includes(req.query.type) ? req.query.type : null;
  if (type) {
    res.setHeader("Content-Type", "text/html");
    if (currentNetwork() === "testnet") return res.send("");
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    try {
      const items = getTxTypeArchive(type, TX_TYPE_LIST_PAGE_SIZE, offset);
      const total = getTxTypeArchiveCount(type);
      return res.send(txTypeArchiveMoreRows(items, type, offset, total, TX_TYPE_LIST_PAGE_SIZE));
    } catch {
      return res.send("");
    }
  }
  const fromBlock = parseInt(req.query.fromBlock) || 1;
  try {
    const { items, nextFromBlock } = await getTxsFromBlocks(fromBlock);
    res.setHeader("Content-Type", "text/html");
    res.send(globalTxMoreRows(items, nextFromBlock));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send("");
  }
});
```

- [ ] **Step 5: Add the `/txs/unconfirmed` + `/api/txs/unconfirmed` routes**

Insert immediately after the `/api/txs/more` route (after the block added in Step 4, before the `// Namespaces list` comment):

```js
app.get("/txs/unconfirmed", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      "Pending Transactions - NEMSCAN",
      heroTxs("pending"),
      "txs-unconfirmed-card",
      "/api/txs/unconfirmed",
      `<div class="loading"><div class="spinner"></div><span>Fetching pending transactions…</span></div>`,
      "/txs",
      "Browse the current unconfirmed (pending) NEM transaction pool on NEMSCAN, mirrored from explorer.nemtool.com.",
      `${base}/txs/unconfirmed`,
    ),
  );
});

app.get("/api/txs/unconfirmed", async (req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (currentNetwork() === "testnet") {
    return res.send(unavailableOnTestnetHTML("Pending Transactions"));
  }
  try {
    const items = await fetchUnconfirmedTxs();
    res.send(unconfirmedTxListHTML(items));
  } catch (err) {
    res.status(503);
    res.send(errorFrag(err.message, "/api/txs/unconfirmed", "#txs-unconfirmed-card"));
  }
});
```

- [ ] **Step 6: Wire the sync job into startup**

In the mainnet-only startup block, add right after the existing mosaic-transfer line (currently line 1009):

```js
  runFor("mainnet", () => importTxTypeArchive().then(refreshTxTypeArchive));
```

And add a new interval alongside the existing `refreshMosaicTransfers` interval (currently line 1020):

```js
  setInterval(() => runFor("mainnet", refreshTxTypeArchive), 5 * 60 * 1000);
```

- [ ] **Step 7: Run the full test suite**

Run: `node --test`
Expected: PASS — every test file (`db.test.js`, `cache.test.js`, `html.test.js`, plus the untouched `context.test.js`, `helpers.test.js`, `nemApi.test.js`, `nodePool.test.js`).

- [ ] **Step 8: Manual verification**

Start the dev server (`node index.js`), then in a browser:

1. Open `/txs` — confirm it looks and behaves exactly as before (live feed, "Live" pill, chain height), with a new "Type: All" dropdown in the hero.
2. Click each of Transfer / Importance / Aggregate / Multisig / Namespace / Apostille in the dropdown — confirm the page navigates to `/txs?type=...`, the dropdown shows that type as active, and the table renders (or shows an empty state if the background backfill hasn't finished yet — check the server log for `Tx type archive import failed` errors if a table stays empty for more than a few minutes).
3. Click "Load More" on a filtered view — confirm it fetches another page and eventually the button disappears once the archive's window is exhausted.
4. Click "Mosaic" in the dropdown — confirm it lands on the existing `/mosaictransfer` page.
5. Click "Pending" in the dropdown — confirm it lands on `/txs/unconfirmed`, showing either a table of pending transactions or the "No pending transactions right now" empty state, with "Pending" active in its own dropdown.
6. Switch to testnet (network switcher in the topbar) and repeat steps 2 and 5 — confirm both show the "Not available on testnet" message, while plain `/txs` (no type) still works normally.

---

## Self-Review

**1. Spec coverage:**
- Schema/constants/sync job → Tasks 1-2. ✓
- Type dropdown, reused CSS/JS, `heroTxs` placement → Task 3. ✓
- Archive-backed list rendering (6 types), reuse via new row renderer (not `renderGlobalTxRow`), recipient/amount em-dash handling → Task 4. ✓
- Mosaic → links to `/mosaictransfer` → Task 3 (`typeSwitch`). ✓
- Pending page, `otherTrans` unwrapping → Task 5. ✓
- Route branching preserving the existing live path byte-for-byte, testnet gating, startup wiring → Task 6. ✓
- Manual verification checklist from the spec's Testing section → Task 6 Step 8. ✓
- "No git commands" constraint → stated in Global Constraints; no task includes a commit step. ✓

**2. Placeholder scan:** No TBD/TODO; every step has complete, real code.

**3. Type consistency:** Checked across tasks — `getTxTypeArchive(filterType, limit, offset)`, `getTxTypeArchiveCount(filterType)`, `trimTxTypeArchive(filterType, keep)`, `upsertTxTypeArchive(filterType, hash, height, sender, recipient, amount, fee, timeStamp, type)` are named and ordered identically in Task 1's implementation, Task 2's tests/usage, and Task 6's route usage. `txTypeArchiveListHTML(items, filterType, limit)` (no `total` param — self-queries) vs `txTypeArchiveMoreRows(items, filterType, offset, total, limit)` (receives `total` — matches the existing `mosaicTransfersListHTML`/`mosaicTransferMoreRows` split in `src/html.js`) is consistent between Task 4's implementation and Task 6's route calls.
