# Port explorer.nemtool.com's "Mosaic Transfer" screen to NEMSCAN

## Problem

`explorer.nemtool.com` has a "Mosaic Transfer" screen (`#/mosaictransfer`, under the "NS & MOSAICS" nav menu) that NEMSCAN never got: a site-wide feed of Transfer transactions that carry a mosaic (not just XEM), with columns `MosaicID / Quantity / Sender / Recipient / Age`, a mosaic-ID search filter, and a per-mosaic transfer-history tab on the mosaic detail page.

NIS1 nodes have no endpoint for "all mosaic transfers network-wide" — the same gap that already forces `namespaces`/`mosaics`/`polls` to depend on `explorer.nemtool.com`'s own historical index (`src/cache.js`'s `importNamespaceArchive` / `importMosaicArchive` / `importPollArchive`). Confirmed live: `POST https://explorer.nemtool.com/mosaic/mosaicTransferList` is the exact endpoint backing the original screen — same `no`-cursor descending pagination as the other archives, `pageSize` clamped server-side to 50, each record already including `namespace`, `mosaic`, `quantity`, `div` (divisibility), `sender`, `recipient`, `hash`, `timeStamp`.

## Goal

- A `/mosaictransfer` list page matching the original screen's data (mosaic ID, quantity, sender, recipient, age), styled and paginated like NEMSCAN's existing `/mosaics` / `/namespaces` list pages.
- Mosaic-ID (`ns:m`) search filter on that page.
- A "Recent Transfers" section on the existing mosaic detail page (`/mosaic/:namespace/:name`), reusing the same data.
- Kept in sync going forward (unlike the namespace/mosaic/poll archives, mosaic transfers never stop happening — a one-time import isn't enough).

## Non-goals

- **No self-scan of blocks.** The existing block-persistence backfill (`scanBlockHeightsForDailyTx` / `refreshDailyTxStats`) walks blocks incrementally and won't reach genesis for days; even once it does, extracting mosaic transfers from it would only ever provide the same data `explorer.nemtool.com` already has, obtained far slower and with much more node load. Not pursued.
- **No mosaic rich-list tab.** The original mosaic detail page also has a "Mosaic RichList" tab (top holders of a given mosaic) — a distinct feature, not part of this port.
- **No multisig-wrapped-transfer unwrapping.** Consistent with the rest of NEMSCAN (`isTransfer = tx.type === 257` appears as-is throughout `html.js`), and moot here anyway since this feature's data comes entirely from `explorer.nemtool.com`'s own index, not from scanning raw transactions.
- **Mainnet only.** Same restriction as the namespace/mosaic/poll archives and the rich list — `explorer.nemtool.com` has no testnet equivalent.

## Architecture

### Schema (`src/db.js`)

One new table, added to `openDbLayer()` alongside the existing archive tables (created for both mainnet/testnet db files for schema consistency, but only ever populated on mainnet — same as `mosaics_archive` today):

```sql
CREATE TABLE IF NOT EXISTS mosaic_transfers (
  no INTEGER PRIMARY KEY,   -- nemtool.com's cursor value; descends with recency, used as the sort key
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

`divisibility` is stored per-row straight from the API's `div` field rather than joined against the `mosaics`/`mosaics_archive` tables at read time — it's already right there in the source data, and storing it directly means quantity formatting keeps working even for a mosaic that has since dropped out of the mosaic cache.

New accessors, following existing `db.js` conventions (prepared statements, per-network `layer()` dispatch):

```js
const _mtUpsertStmt = db.prepare(
  "INSERT OR REPLACE INTO mosaic_transfers (no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, time_stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const _mtSelectAllStmt = db.prepare(
  "SELECT * FROM mosaic_transfers ORDER BY no DESC LIMIT ? OFFSET ?",
);
const _mtSelectByMosaicStmt = db.prepare(
  "SELECT * FROM mosaic_transfers WHERE namespace = ? AND mosaic = ? ORDER BY no DESC LIMIT ? OFFSET ?",
);
const _mtCountAllStmt = db.prepare("SELECT COUNT(*) AS c FROM mosaic_transfers");
const _mtCountByMosaicStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM mosaic_transfers WHERE namespace = ? AND mosaic = ?",
);
const _mtMaxNoStmt = db.prepare("SELECT MAX(no) AS maxNo FROM mosaic_transfers");
```

Exported as `getMosaicTransfers(limit, offset, ns = null, m = null)`, `getMosaicTransfersCount(ns = null, m = null)`, `getMaxMosaicTransferNo()`, and `upsertMosaicTransfer(no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, timeStamp)` — dispatching through `layer()` like every other accessor in the file, mirroring the `getMosaicsByNamespace` / `upsertMosaic` pair already there.

### Sync (`src/cache.js`)

Two functions, modeled on `importNamespaceArchive` / `refreshLiveRichList` but adapted for a dataset that (a) is expected to be far larger than the namespace/mosaic/poll archives and (b) never stops growing:

**`importMosaicTransferArchive()`** — one-time historical backfill, guarded by `cache_meta.mosaic_transfers_archive_imported` exactly like the other `import*Archive` functions. Differences from those:

- **No 200-page cap.** `importNamespaceArchive`/`importMosaicArchive`/`importPollArchive` all stop after 200 pages (10,000 records) — fine for their datasets, but mosaic-transfer volume is expected to exceed that easily (e.g. the `rewards4earth` mosaic alone recurs almost daily across 10 years, and it's one of many). Loop until a page returns fewer than 50 records (the server's clamp) instead.
- **Resumable cursor.** Given the loop above can run for a long time, persist the current `no` cursor to `cache_meta.mosaic_transfer_archive_cursor` every page. On restart before completion, resume from that cursor instead of starting over from `no = null`. Clear the cursor key once `mosaic_transfers_archive_imported` is set.
- Same `ARCHIVE_PAGE_DELAY_MS` (150ms) pacing between page requests as the existing archive importers.

**`refreshMosaicTransfers()`** — incremental top-up, run only after the initial import has completed (`if (!getCacheMeta("mosaic_transfers_archive_imported")) return;`). Fetches the newest page (`no` cursor omitted), and if its top record's `no` is greater than `getMaxMosaicTransferNo()`, walks forward through pages (using each page's own cursor) upserting records until it reaches one with `no <=` the local max, then stops. Idempotent via `INSERT OR REPLACE`, so any overlap with a concurrent run is harmless.

### Wiring (`index.js`)

In the existing mainnet-only startup block:

```js
runFor("mainnet", () => importMosaicTransferArchive().then(refreshMosaicTransfers));
```

New interval alongside the other 5-minute jobs:

```js
setInterval(() => runFor("mainnet", refreshMosaicTransfers), 5 * 60 * 1000);
```

### Routes (`index.js`)

- `GET /mosaictransfer` — page shell, same `shell(...)` structure as `/mosaics`.
- `GET /api/mosaictransfer?limit=&ns=&m=` — initial fragment. `limit` restricted to `[10, 25, 50, 100]` like the existing list pages. When `ns`+`m` are both present, filters to that mosaic (this is also what the mosaic detail page's "View all transfers" link points at).
- `GET /api/mosaictransfer/more?offset=&limit=&ns=&m=` — continuation, same `hx-get` "load more" pattern as `mosaicMoreRows`/`namespaceMoreRows`.
- `GET /api/mosaic/:path` (existing route) gains a call to `getMosaicTransfers(10, 0, namespace, name)` + `getMosaicTransfersCount(namespace, name)`, passed into `mosaicDetailHTML`.

### UI (`src/html.js`)

- `navHTML`'s `links` array gains `["/mosaictransfer", "Mosaic Transfer"]` after `["/mosaics", "Mosaics"]`.
- `heroMosaicTransfers()` — same shape as `heroMosaics()`.
- `mosaicTransfersListHTML(items, limit, filter)` / `mosaicTransferMoreRows(items, offset, total, limit, filter)` / `renderMosaicTransferRow(t, num)` — modeled directly on `mosaicsListHTML`/`mosaicMoreRows`/`renderMosaicRow`: same `rows-ctrl` limit dropdown (htmx `hx-get`), same `tbl-wrap` table, same load-more row pattern. Columns: `# / MosaicID (→ /mosaic/ns/name) / Quantity / Sender (→ /account/:addr) / Recipient (→ /account/:addr) / Tx (→ /tx/:hash, truncated) / Age`. Quantity formatted the same way `renderMosaicRow` formats supply: `(quantity / 10**divisibility).toLocaleString("en", {minimumFractionDigits: divisibility, maximumFractionDigits: divisibility})`.
- A small mosaic-ID search input (`ns:m`, validated client-side with the same regex the original used) submits via `hx-get` to `/api/mosaictransfer?ns=&m=`, mirroring how the rows-per-page control already fires `hx-get` requests — no new JS pattern introduced.
- `mosaicDetailHTML` gains a "Recent Transfers" card below the Overview card: up to 10 rows via `renderMosaicTransferRow`, empty state if none, and a "View all transfers ›" link to `/mosaictransfer?ns=<namespace>&m=<name>` when `getMosaicTransfersCount(namespace, name)` exceeds 10.

## Error handling

- `importMosaicTransferArchive()` / `refreshMosaicTransfers()` catch and `console.error` on failure, same as every other background job in `cache.js` — best-effort, never propagates to a request path.
- `/api/mosaictransfer` and `/api/mosaictransfer/more` follow the existing `errorFrag(...)` / empty-string-on-error pattern used by `/api/mosaics` and `/api/mosaics/more`.
- Empty result set (e.g. archive import still running on a fresh install) renders the same `empty-state` div style already used by `mosaicsListHTML`.

## Storage

Expected to be the largest archive table in the app — plausibly hundreds of thousands of rows given 10 years of mosaic activity — but each row is small (two fixed-length addresses, a hash, a few integers), so total size should stay in the tens-of-MB range, well within what SQLite/WAL already handles for the `blocks` table.

## Testing

- `test/db.test.js`: `upsertMosaicTransfer` / `getMosaicTransfers` (unfiltered and `ns`+`m` filtered) / `getMosaicTransfersCount` / `getMaxMosaicTransferNo` round-trip; mainnet/testnet isolation (same pattern as existing mosaics tests).
- `test/cache.test.js`: `importMosaicTransferArchive` pages until a short batch, persists the resume cursor mid-run (mocked `fetch`), sets the completed flag and clears the cursor at the end; `refreshMosaicTransfers` no-ops before the import flag is set, and after it, stops walking once it reaches a known `no`.
- `test/html.test.js`: `mosaicTransfersListHTML` / `renderMosaicTransferRow` output shape (links, quantity formatting with divisibility); `mosaicDetailHTML`'s new Recent Transfers section (present with rows, empty state, "View all" link threshold at >10).
- Manual: start the server, confirm `/mosaictransfer` loads and paginates, the `ns:m` search filter narrows results, and a mosaic detail page shows its Recent Transfers section.
