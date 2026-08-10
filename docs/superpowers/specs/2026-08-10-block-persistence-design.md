# Persist blocks to sqlite so /txs, /blocks, and detail pages stop re-scanning the live chain

## Problem

`/txs` feels consistently slow. Measured against production: the page shell (`/txs`) returns in ~0.1s (already fixed to use the shell+htmx pattern), but the htmx fragment it loads, `/api/txs`, took **8–11 seconds** across repeated measurements.

`/api/txs` calls `getTxsFromBlocks(fromHeight)` (`src/nemApi.js`), which walks the chain backward **live**, 5 blocks at a time via parallel node fetches, collecting transactions until it finds 25 or hits a safety cap (`MAX_BLOCK_SCAN_DEPTH=500` blocks or `MAX_BLOCK_SCAN_MS=8000ms`). NEM blocks are frequently empty, so most `/txs` loads walk dozens of blocks live and burn the full 8-second wall-clock cap.

The user's mental model was that "once fetched, data is saved to sqlite" — this is only true for namespaces, mosaics, polls, the rich list, and daily tx counts (`src/db.js`). **Blocks and transactions are never persisted.** The only cache is `blockCache`, an in-process `Map` capped at 500 entries (`src/constants.js`) that's lost on every restart and only helps when the exact same block height is requested again soon.

Separately, `src/cache.js`'s `scanBlockHeightsForDailyTx()` already fetches **every new block** live, purely to bump a daily transaction-count chart — then discards the block data. This is the same data `/txs` and `/blocks` need; it's just being thrown away.

## Goal

Persist fetched blocks (raw NIS `/block/at/public` JSON) to sqlite, so that:

- `/api/txs`, `/api/blocks`, `/api/block/:height`, and hinted `/api/tx/:hash` (the height/timestamp fallback path used by in-app links) become fast for any block that's already been synced, without changing their output shape.
- The existing background block-walker (`scanBlockHeightsForDailyTx` / `refreshDailyTxStats`) is extended to persist full blocks instead of discarding them, at zero additional node-request cost.
- Full chain history is eventually backfilled down to genesis (height 1), not just a recent window.

## Non-goals

- **No transaction-hash index / no fix for cold hash search.** Raw block JSON (`/block/at/public`) does not include a `hash` field per transaction (only account-scoped endpoints like `/account/transfers/all` return `meta.hash.data`). Computing a real NIS1 transaction hash requires re-implementing NIS1's per-type binary serialization + SHA3-256 hashing from scratch — a substantial, error-prone, self-contained feature unrelated to this caching work. `/tx/:hash` keeps its current behavior unchanged: live reverse-lookup for very recent/unconfirmed transactions, plus the existing height/timestamp-hint fallback for in-app links (which *does* benefit here, transparently, once the referenced block is cached).
- **No separate `transactions` table.** `getTxsFromBlocks()`'s existing algorithm (walk blocks, flatten `.transactions`) is reused as-is against cached blocks — no schema or algorithm change needed for tx listing.
- **No rolling-window pruning.** Every synced block is kept forever (full history was chosen deliberately, accepting the storage cost below).
- **No change to `MAX_BLOCK_SCAN_MS` / `MAX_BLOCK_SCAN_DEPTH`.** These remain as a safety net for the live-fetch fallback (unsynced tip gap, or before backfill reaches a given range) — DB-backed scans finish in milliseconds and won't hit them in practice.
- **No change to `index.js` routes or `html.js` rendering.** All output shapes are unchanged; only `getBlock()`'s internal data source changes.

## Architecture

### Schema (`src/db.js`)

One new table per network db (`cache.db` / `cache-testnet.db`, via the existing `layer()` mainnet/testnet split):

```sql
CREATE TABLE IF NOT EXISTS blocks (
  height     INTEGER PRIMARY KEY,
  time_stamp INTEGER NOT NULL,
  raw        TEXT NOT NULL   -- verbatim /block/at/public JSON
);
```

Raw JSON, not normalized columns: NEM transaction types (transfer, multisig, importance transfer, provision namespace, mosaic definition/supply change, multisig aggregate modification, multisig signature) have entirely different field layouts. `html.js`'s rendering functions already consume the raw NIS shape directly, so storing it verbatim means **zero changes to any rendering function** — only the fetch layer changes where data comes from.

New accessors, following existing `db.js` conventions (prepared statements, per-network `layer()` dispatch):

```js
const _blockUpsertStmt = db.prepare(
  "INSERT OR REPLACE INTO blocks (height, time_stamp, raw) VALUES (?, ?, ?)",
);
const _blockSelectStmt = db.prepare("SELECT raw FROM blocks WHERE height = ?");
// ...
upsertBlock: (height, timeStamp, raw) => _blockUpsertStmt.run(height, timeStamp, raw),
getCachedBlock: (height) => {
  const row = _blockSelectStmt.get(height);
  return row ? JSON.parse(row.raw) : null;
},
```

Exported as `upsertBlock(height, timeStamp, raw)` and `getCachedBlock(height)`, dispatching through `layer()` exactly like every other accessor in the file.

### Write path 1: extend the existing background walker (`src/cache.js`)

`scanBlockHeightsForDailyTx(heights)` already fetches every block in `heights` live. Add persistence alongside the existing daily-count bump — no new node requests:

```js
export async function scanBlockHeightsForDailyTx(heights) {
  // ... existing batching ...
  for (const block of blocks) {
    if (!block?.timeStamp) continue;
    bumpDailyTxCount(dateKeyFromTs(block.timeStamp), (block.transactions || []).length);
    upsertBlock(block.height, block.timeStamp, JSON.stringify(block)); // new
  }
}
```

`refreshDailyTxStats()`'s backward walk currently stops at a 7-day cutoff (`DAILY_TX_DAYS`) and sets `daily_tx_backfill_done`. Change the stop condition to "reached genesis" (`minH <= 1`), tracked under a **new** cache_meta flag (e.g. `blocks_backfill_done`) so existing deployments don't misinterpret their already-set `daily_tx_backfill_done` (7-day completion) as full-history completion. The existing cursors (`daily_tx_scan_max_height` / `daily_tx_scan_min_height`) are reused as-is — backfill resumes from wherever it already was, no rework.

Pacing is unchanged: `DAILY_TX_BACKFILL_CHUNK=60` blocks per 5-second tick (while backfilling), `ARCHIVE_PAGE_DELAY_MS=150ms` between sub-batches. At current mainnet height (~5.79M), full genesis backfill takes on the order of **5–6 days** of continuous background walking, at the same load on public nodes the app already generates today. Forward catch-up (new blocks) keeps running every cycle regardless of backward-backfill progress, so freshness is unaffected by how far back backfill has reached.

### Write path 2: write-through in `getBlock()` (`src/nemApi.js`)

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
  if (blockCache.size > BLOCK_CACHE_MAX_SIZE) blockCache.delete(blockCache.keys().next().value);
  return block;
}
```

Lookup order: in-memory `blockCache` (hot path, unchanged) → sqlite (new) → live fetch, with write-through to both memory and sqlite on a live fetch. This closes gaps immediately regardless of which code path triggered the fetch — homepage, `/block/:height`, a `/txs` scan hitting the unsynced tip, or the background walker — not only the formal backfill.

**No call sites change.** `index.js`'s route handlers and `getTxsFromBlocks()` already call `getBlock(height)` and consume its return value the same way regardless of where the data came from. This is the core reason the change stays surgical: one new table, one extended background function, and one function (`getBlock`) made DB-aware.

New dependency: `nemApi.js` → `db.js` (previously zero). No cycle: `db.js` has no dependency on `nemApi.js`. This mirrors `cache.js`'s existing dependency on both.

## Error handling

- `upsertBlock()` failures (disk full, etc.) are caught and logged (`console.error`), never propagated — persistence is best-effort. A live-fetched block is still returned to the caller even if the DB write fails.
- Follows the existing `console.error` + continue pattern already used in `refreshNodeOptions()` / `refreshDailyTxStats()`.

## Storage

Raw JSON size per block is expected to be mostly in the low hundreds of bytes to a few KB (most blocks carry 0–1 transactions). At ~5.79M mainnet blocks, full history is roughly **a few GB** on disk — a deliberate trade-off given the full-backfill choice. Testnet's chain is much shorter and backfills quickly; no special-casing needed.

WAL mode is already enabled (`PRAGMA journal_mode = WAL` in `db.js`), which suits this workload well: the background writer and concurrent HTTP read paths don't block each other.

## Testing

- `test/db.test.js`: `upsertBlock` / `getCachedBlock` round-trip; mainnet/testnet isolation (same pattern as existing namespaces/mosaics tests).
- `test/nemApi.test.js`: `getBlock()` checks memory → sqlite → live fetch in order; a live fetch writes through to sqlite (mocked `fetch`, following existing patterns).
- `test/cache.test.js`: `scanBlockHeightsForDailyTx` persists blocks alongside the daily-count bump; `refreshDailyTxStats` continues backward past the old 7-day cutoff toward genesis and sets `blocks_backfill_done` only once `minH <= 1`.
