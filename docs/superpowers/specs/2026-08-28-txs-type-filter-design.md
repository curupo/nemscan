# Port explorer.nemtool.com's transaction-type filter to NEMSCAN's /txs

## Problem

`explorer.nemtool.com` lets you filter its global transaction list by type (`#/txlist?type=transfer|importance|aggregate|multisig|namespace|mosaic|apostille`) and has a separate "Pending Transactions" screen (`#/unconfirmedtxlist`) for the unconfirmed-tx mempool, both reachable from one "TRANSACTIONS" nav dropdown. NEMSCAN's `/txs` has neither — it only shows a live, unfiltered feed of the most recent transactions.

Confirmed live by probing `explorer.nemtool.com`'s own backend (it's an AngularJS app; `services/tx.client.service.js` calls these directly):

- `POST /tx/list` `{page, type}` — type-filtered transaction list. `type` is one of `""` (all), `"transfer"`, `"importance"`, `"aggregate"`, `"multisig"`, `"namespace"`, `"mosaic"`, `"apostille"`. Fixed page size of 10, real `page`-number pagination (verified: page 1/2/3 return distinct, non-overlapping hashes). Each record is flat — `hash, height, sender, recipient, amount, fee, timeStamp, signature, type` — plus a per-type extra flag (`aggregateFlag`, `mosaicTransferFlag`, `apostilleFlag`) on some records.
- `POST /tx/unconfirmedTXList` `{}` — the current unconfirmed-tx pool, no pagination.

What each `type` value actually selects (probed directly, and cross-checked against `tx.client.controller.js`'s `handleTX` labeling logic):

| `type` value | Underlying data |
|---|---|
| `transfer` | `tx.type === 257`, unconditionally |
| `importance` | `tx.type === 2049` |
| `aggregate` | `tx.type === 4097`, plus `tx.type === 4100` where `aggregateFlag === 1` |
| `multisig` | `tx.type === 4100` |
| `namespace` | `tx.type === 8193` |
| `mosaic` | `tx.type === 257` where `mosaicTransferFlag === 1` — i.e. a transfer carrying a mosaic, **not** a distinct protocol-level type |
| `apostille` | `tx.type === 257` where `apostilleFlag === 1` — a transfer with an apostille-style message, also not a distinct type |

NIS1 nodes have no endpoint for "recent transactions of type X network-wide" (the same gap `/mosaictransfer`, `/namespaces`, `/mosaics` already work around) — filtering by walking blocks live would work for `transfer` but is impractical for the rarer types, which can be hundreds of blocks apart.

`/transactions/unconfirmed` on a NIS1 node is **not** a list endpoint — confirmed live (`POST` returns `"expected value for property entity, but none was found"`, `GET` returns 405). `explorer.nemtool.com` runs its own backend that tracks the pool itself (subscribing to a node's websocket, per `sockjs`/`stomp` in its bundle) and exposes it via `/tx/unconfirmedTXList`. NEMSCAN has no equivalent and isn't taking on a persistent websocket subscription for this — it proxies nemtool's endpoint instead, same as it already depends on nemtool for namespace/mosaic/poll archives.

## Goal

- A "Type" dropdown on `/txs`: **All** (today's live view, unchanged), **Transfer / Importance / Aggregate / Multisig / Namespace / Apostille** (new, archive-backed), **Mosaic** (links to the existing `/mosaictransfer` page — no new data path), **Pending** (links to a new `/txs/unconfirmed` page).
- Selecting a type filter is a real page navigation (`<a href="/txs?type=...">`), not an AJAX swap — the dataset and pagination model genuinely change, and it makes filtered views shareable/bookmarkable, consistent with `/mosaictransfer`'s own `ns:m` search form (also a real navigation, not htmx).
- `/txs/unconfirmed` — its own page, same Type dropdown (with Pending active), showing the live unconfirmed-tx pool.

## Non-goals

- **No change to `/txs`'s default (no-`type`) behavior.** Still the live NIS1 block-walk (`getTxsFromBlocks`), unaffected by anything in this spec, and still works on testnet.
- **No full historical backfill per type.** Unlike `/mosaictransfer` (small dataset, backfilled to genesis), a "transfer" archive alone would mean mirroring nearly the entire chain's transaction history. Each type keeps only a bounded, continuously-refreshed rolling window of its newest transactions (see Architecture).
- **No new Mosaic archive.** `type=mosaic` is exactly the data `/mosaictransfer` already has (transfers carrying a mosaic). The dropdown links there instead of duplicating it.
- **No websocket / real-time push**, for either the type-filtered lists or the Pending page. Both load once per page visit (`hx-trigger="load"`), matching every other list page in the app — no `hx-trigger="every ...s"` polling exists anywhere in the codebase today, and this isn't the place to introduce it.
- **No multisig inner-transaction unwrapping for the type-filtered archive.** `/tx/list` already returns flat, top-level `sender`/`recipient`/`amount`/`fee` for every type including `multisig`/`aggregate` (confirmed live) — there is no `otherTrans` to unwrap there. (The **unconfirmed** feed is different — see below.)
- **No reuse of the raw NIS1 tx shape.** `getTxsFromBlocks`'s live path deals in raw node transaction objects (`tx.signer` as a public key, resolved to an address via `addrFromPubKey`); nemtool's `/tx/list` gives `sender`/`recipient` as address strings directly. These are different shapes, not interchangeable — the archive gets its own row renderer (see UI below) rather than forcing raw-tx-shaped data through `renderGlobalTxRow`.
- **Mainnet only**, same restriction as every other `explorer.nemtool.com`-backed feature (`/mosaictransfer`, `/namespaces`, `/mosaics`).

## Architecture

### Schema (`src/db.js`)

One new table, alongside the existing archive tables, created for both mainnet/testnet db files for schema consistency but only ever populated on mainnet:

```sql
CREATE TABLE IF NOT EXISTS tx_type_archive (
  filter_type TEXT NOT NULL,   -- 'transfer'|'importance'|'aggregate'|'multisig'|'namespace'|'apostille'
  hash TEXT NOT NULL,
  height INTEGER,
  sender TEXT,
  recipient TEXT,
  amount INTEGER,
  fee INTEGER,
  time_stamp INTEGER,
  type INTEGER,                -- raw NIS tx type (257/2049/4097/4100/8193)
  PRIMARY KEY (filter_type, hash)
);
CREATE INDEX IF NOT EXISTS idx_tx_type_archive_filter ON tx_type_archive(filter_type, height DESC);
```

`PRIMARY KEY (filter_type, hash)` rather than `hash` alone: a `type === 4100` transaction can legitimately appear under both `aggregate` and `multisig` (see the table above) — nemtool's own UI allows this, so the archive does too, one row per `(filter_type, hash)` pair.

New accessors, following existing `db.js` conventions (prepared statements, per-network `layer()` dispatch), mirroring `getMosaicTransfers`/`upsertMosaicTransfer`:

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

Exported as `getTxTypeArchive(filterType, limit, offset)`, `getTxTypeArchiveCount(filterType)`, `upsertTxTypeArchive(filterType, hash, height, sender, recipient, amount, fee, timeStamp, type)`, `trimTxTypeArchive(filterType, keep)` — all dispatching through `layer()` like every other accessor in the file.

### Constants (`src/constants.js`)

```js
export const TX_LIST_FILTER_TYPES = [
  "transfer", "importance", "aggregate", "multisig", "namespace", "apostille",
];
export const TX_TYPE_ARCHIVE_WINDOW = 500; // newest rows kept per filter_type
```

Reused by both the sync job (iterates the list) and the route/UI layer (validates `req.query.type`, builds the dropdown).

### Sync (`src/cache.js`)

```js
const NEMTOOL_TX_LIST_URL = "https://explorer.nemtool.com/tx/list";
```

**`importTxTypeArchive()`** — one-time backfill, guarded by `cache_meta.tx_type_archive_imported` like the other `import*Archive` functions. For each `filter_type` in `TX_LIST_FILTER_TYPES` (sequentially, not in parallel — same politeness as the existing archive importers): page from `page: 1` upward (10 records/page, fixed by the server), upserting each record with `upsertTxTypeArchive(filterType, ...)`, until either `TX_TYPE_ARCHIVE_WINDOW` records have been seen for that type or a page comes back empty. `ARCHIVE_PAGE_DELAY_MS` (150ms) between page requests, same pacing as every other archive importer. No resumable cursor needed (unlike `importMosaicTransferArchive`) — worst case ~50 requests per type × 6 types is a small, fast one-time cost, not the open-ended walk mosaic transfers required.

**`refreshTxTypeArchive()`** — incremental top-up, run only after the backfill completes. For each `filter_type`: fetch `page: 1` (newest 10), `upsertTxTypeArchive` each (idempotent via `INSERT OR REPLACE`), then `trimTxTypeArchive(filterType, TX_TYPE_ARCHIVE_WINDOW)` to drop anything that's aged out of the window. Unlike `refreshMosaicTransfers`, this doesn't need to walk forward hunting for "how far behind are we" — it only ever needs the newest page, since the window is bounded and trimmed anyway.

### Wiring (`index.js`)

Startup, alongside the existing mosaic-transfer job:

```js
runFor("mainnet", () => importTxTypeArchive().then(refreshTxTypeArchive));
```

New interval alongside the other 5-minute jobs:

```js
setInterval(() => runFor("mainnet", refreshTxTypeArchive), 5 * 60 * 1000);
```

### Routes (`index.js`)

- `GET /txs` — existing handler, gains one branch: if `req.query.type` is in `TX_LIST_FILTER_TYPES`, build `apiUrl` as `/api/txs?type=${type}` instead of `/api/txs`, and pass `type` into `heroTxs(type)` so the dropdown shows the right item active. Any other/missing `type` value is treated as absent (falls through to today's unfiltered behavior) — no 400.
- `GET /api/txs` — existing handler, gains the same branch: valid `type` → `getTxTypeArchive(type, limit, 0)` + `getTxTypeArchiveCount(type)`, rendered by a new `txTypeArchiveListHTML(items, type, limit, total)`. No `type` → today's `getTxsFromBlocks` path, byte-for-byte unchanged.
- `GET /api/txs/more` — same branch on `type`, using `offset`/`limit` against the archive instead of the existing `fromBlock` cursor. Bounded by `TX_TYPE_ARCHIVE_WINDOW` — once `offset + limit >= total`, the load-more row is omitted (unlike the live path's open-ended block walk).
- `GET /txs/unconfirmed` — new, same `shell(...)` structure as `/txs`, `heroTxs("pending")`.
- `GET /api/txs/unconfirmed` — new. On testnet, `unavailableOnTestnetHTML("Pending Transactions")`. On mainnet, `POST`s to nemtool's `/tx/unconfirmedTXList` at request time (no local storage — this is a live proxy, not an archive) and renders via a new `unconfirmedTxListHTML(items)`. On fetch failure, the existing `errorFrag(...)` / 503 pattern.

### UI (`src/html.js`)

**Type dropdown** — reuses the existing `rows-switch`/`rows-menu`/`rows-menu-item` CSS classes and the existing generic `toggleRowsMenu()` JS verbatim (it already scopes `.rows-menu` lookup to `btn.parentElement`, so a second independent instance on the same page needs no changes). No new CSS, no new JS. Menu items are plain `<a href="...">` (real navigation), not `hx-get` — unlike the existing rows-per-page instance of this same component, which stays htmx-driven and untouched.

```js
function typeSwitch(current) {
  const label = { transfer: "Transfer", importance: "Importance", aggregate: "Aggregate",
    multisig: "Multisig", namespace: "Namespace", apostille: "Apostille", pending: "Pending" }[current] || "All";
  const item = (href, text, active) =>
    `<a class="rows-menu-item${active ? " active" : ""}" href="${href}" role="menuitem">${text}</a>`;
  return `
    <div class="rows-ctrl">
      <span class="rows-ctrl-label">Type:</span>
      <div class="rows-switch">
        <button type="button" class="rows-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleRowsMenu(event)" title="Transaction type">
          <span class="rows-switch-label">${label}</span>
          <span class="rows-switch-caret">&#9662;</span>
        </button>
        <div class="rows-menu" role="menu" aria-label="Transaction type">
          ${item("/txs", "All", !current)}
          ${TX_LIST_FILTER_TYPES.map((t) => item(`/txs?type=${t}`, t[0].toUpperCase() + t.slice(1), current === t)).join("")}
          ${item("/mosaictransfer", "Mosaic", false)}
          ${item("/txs/unconfirmed", "Pending", current === "pending")}
        </div>
      </div>
    </div>`;
}
```

- `heroTxs(currentType = null)` — gains the dropdown, placed in the hero (not the card) so it's visible immediately on page load rather than popping in after the card's `hx-trigger="load"` fetch resolves. Used by both `/txs` and `/txs/unconfirmed` (passing `"pending"` for the latter).
- `txTypeArchiveListHTML(items, filterType, limit, total)` / a `*MoreRows` counterpart — modeled on `mosaicTransfersListHTML`'s structure (card-head, table, bounded load-more). `total` comes from `getTxTypeArchiveCount`, and the load-more row is omitted once exhausted (see Routes above).
- `renderTxTypeArchiveRow(row)` — new, small (same shape of markup as `renderGlobalTxRow`'s `<tr>`, same columns: Block/Sender/Recipient/Type/Amount/Fee/Timestamp/Age) but built for the archive's already-resolved fields instead of a raw NIS tx: `row.sender`/`row.recipient` are used directly (no `addrFromPubKey` — nemtool already gives addresses, not pubkeys), and `row.time_stamp` (snake_case, straight off the SQLite row — same convention `renderMosaicTransferRow` already uses, e.g. `nemDate(t.time_stamp)`). Confirmed live: `namespace`/`aggregate` records have `recipient: ""` and `amount: 0` (these tx types don't move XEM or name a recipient), while `importance`/`multisig` records do have a real `recipient`. So instead of `renderGlobalTxRow`'s `type === 257` gate, this renderer shows the Recipient/Amount cells whenever `row.recipient` is non-empty, `"—"` otherwise. Reuses the same formatting helpers `renderGlobalTxRow` already uses (`xem`, `nemDate`, `timeAgo`, `truncKey`, `TX_TYPES`).
- `unconfirmedTxListHTML(items)` / `renderUnconfirmedTxRow(tx)` — new. No block height (unconfirmed), no rows-per-page control (pool is inherently small), no load-more (nemtool's endpoint isn't paginated). For `type === 4100` (multisig), nemtool's unconfirmed payload nests the real transfer under `otherTrans` (confirmed in `UnconfirmedTXController.handleTX` — the *only* place `otherTrans` is used; the regular `/tx/list` records are flat) — `renderUnconfirmedTxRow` reads `tx.otherTrans.sender/recipient/amount/fee` when present, falling back to the top-level fields otherwise. Shows `deadline` in place of Age's usual "confirmed X ago" framing.
- `navHTML`'s `links` array is unaffected — the Type dropdown lives on `/txs` itself, not the top nav.

## Error handling

- `importTxTypeArchive()` / `refreshTxTypeArchive()` catch and `console.error` per filter_type (one type's failure doesn't abort the others), same best-effort pattern as every other background job in `cache.js`.
- `/api/txs?type=X` and `/api/txs/more?type=X` read only from local SQLite — nemtool being down doesn't affect these requests, only how stale the data can get.
- `/api/txs/unconfirmed` calls nemtool live per request; failure → 503 + `errorFrag(...)`, same as `/api/mosaictransfer`.
- Testnet: `/api/txs/unconfirmed` and any `/api/txs?type=X` request → `unavailableOnTestnetHTML(...)`, same as `/mosaictransfer`. Default `/txs` (no `type`) is untouched by this and keeps working on testnet.
- Archive not yet backfilled (fresh install) → `txTypeArchiveListHTML` just renders the existing `empty-state` div, no special-casing — same as `/mosaictransfer` before its own import completes.
- Invalid/unknown `type` query value → silently treated as absent (falls back to the default live view), not a 400.

## Storage

`TX_TYPE_ARCHIVE_WINDOW = 500` × 6 filter types = at most 3,000 rows, each a handful of small fixed-length fields — negligible compared to `mosaic_transfers` or `blocks`.

## Testing

- `test/db.test.js`: `upsertTxTypeArchive`/`getTxTypeArchive`/`getTxTypeArchiveCount` round-trip; `trimTxTypeArchive` keeps only the newest N rows for a given `filter_type` and leaves other `filter_type`s untouched; the same `hash` can coexist under two different `filter_type`s.
- `test/cache.test.js`: `importTxTypeArchive` (mocked `fetch`) stops paging a type once it hits the window or an empty page, and moves on to the next type; `refreshTxTypeArchive` upserts the newest page and trims; a failure fetching one type is caught and doesn't stop the others; both no-op cleanly when nemtool is unreachable.
- `test/html.test.js`: `typeSwitch()`/dropdown active-item marking for each type incl. `"pending"`; `renderTxTypeArchiveRow` for a normal transfer-shaped row and for a `recipient: ""`/`amount: 0` row (namespace/aggregate-style); `txTypeArchiveListHTML`'s load-more cutoff at `total`; `renderUnconfirmedTxRow` for both a plain transfer and a `type === 4100` record with `otherTrans`; empty states.
- Manual: start the dev server, click through `/txs` → each type in the dropdown → Mosaic (lands on `/mosaictransfer`) → Pending (lands on `/txs/unconfirmed`), confirm the active item matches in each case, and confirm testnet shows the "unavailable" message for both type filters and Pending while default `/txs` still works.
