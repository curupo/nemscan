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
  upsertMosaicTransfer,
  getMaxMosaicTransferNo,
  upsertTxTypeArchive,
  trimTxTypeArchive,
  getExchangeAddresses,
  bumpExchangeDailyFlow,
  upsertExchangeAddress,
  getExchangeAddressesNeedingBackfill,
  markExchangeAddressBackfilled,
  getBlocksHeightRange,
  getBlocksInRange,
} from "./db.js";
import {
  nemFetch,
  getAccount,
  fetchBlockRaw,
  getHeight,
  fetchNamespacesFromNode,
} from "./nemApi.js";
import { dateKeyFromTs, addrFromPubKey, matchExchangeName } from "./helpers.js";
import {
  DAILY_TX_BACKFILL_CHUNK,
  ARCHIVE_PAGE_DELAY_MS,
  DEEP_REFRESH_BATCH_DELAY_MS,
  TX_LIST_FILTER_TYPES,
  TX_TYPE_ARCHIVE_WINDOW,
  EXCHANGE_BACKFILL_CHUNK_HEIGHTS,
} from "./constants.js";
import { currentNetwork, networkContext } from "./context.js";

// ── Namespace cache ───────────────────────────────────────────────────────────

const _refreshingNamespaces = { mainnet: false, testnet: false };
export async function refreshNamespacesCache() {
  const network = currentNetwork();
  if (_refreshingNamespaces[network]) return;
  _refreshingNamespaces[network] = true;
  try {
    const data = await fetchNamespacesFromNode();
    for (const item of data.data || []) {
      upsertNamespace(
        item.meta.id,
        item.namespace.fqn,
        item.namespace.owner,
        item.namespace.height,
      );
    }
    setCacheMeta("namespaces_updated_at", Date.now());
  } catch (err) {
    console.error(`Namespace cache refresh failed (${network}):`, err.message);
  } finally {
    _refreshingNamespaces[network] = false;
  }
}

const NEMTOOL_NAMESPACE_LIST_URL =
  "https://explorer.nemtool.com/namespace/rootNamespaceList";

// NIS nodes only ever return the newest ~25 root namespaces (pagination is
// broken beyond page one — see fetchNamespacesFromNode above), so anything
// older than that has fallen out of our live cache. explorer.nemtool.com
// keeps its own historical index reaching back to the network's early days,
// browsable via cursor pagination on its internal `no` field. We walk it
// once and persist the results locally (namespaces_archive) so the
// /namespaces page can show the fuller picture without depending on a
// third-party site at request time. This only needs to run once — the
// historical records it covers are immutable.
export async function importNamespaceArchive() {
  if (getCacheMeta("namespaces_archive_imported")) return;
  let cursor = null;
  let imported = 0;
  try {
    for (let page = 0; page < 200; page++) {
      const body =
        cursor != null ? { pageSize: 50, no: cursor } : { pageSize: 50 };
      const res = await fetch(NEMTOOL_NAMESPACE_LIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const batch = await res.json();
      if (!Array.isArray(batch) || !batch.length) break;
      for (const item of batch) {
        upsertNamespaceArchive(
          item.no,
          item.namespace,
          item.creator,
          item.height,
        );
      }
      imported += batch.length;
      const last = batch[batch.length - 1].no;
      if (batch.length < 50 || last === cursor) break;
      cursor = last;
      await new Promise((r) => setTimeout(r, ARCHIVE_PAGE_DELAY_MS));
    }
    setCacheMeta("namespaces_archive_imported", Date.now());
    console.log(
      `Namespace archive import complete: ${imported} records seen, ${getArchivedNamespacesCount()} stored (source: explorer.nemtool.com)`,
    );
  } catch (err) {
    console.error("Namespace archive import failed:", err.message);
  }
}

const NEMTOOL_NAMESPACE_BY_ROOT_URL =
  "https://explorer.nemtool.com/namespace/namespaceListbyNamespace";
const _subNamespacesCache = new Map(); // root fqn -> { items, fetchedAt }
const SUBNS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// There's no bulk endpoint for sub-namespaces (and walking namespaceListbyNamespace
// for ~3,000 known roots up front would be a heavy one-time cost for data that's
// only needed when someone actually opens a namespace detail page), so unlike the
// root-namespace archive we fetch this on demand from explorer.nemtool.com and
// cache the result in memory for a few hours.
export async function fetchSubNamespaces(root) {
  const cached = _subNamespacesCache.get(root);
  if (cached && Date.now() - cached.fetchedAt < SUBNS_CACHE_TTL_MS)
    return cached.items;
  try {
    const res = await fetch(NEMTOOL_NAMESPACE_BY_ROOT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ns: root }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const list = await res.json();
    const items = Array.isArray(list)
      ? list
          .filter((x) => x.namespace !== root)
          .map((x) => ({
            fqn: x.namespace,
            owner: x.creator,
            height: x.height,
          }))
      : [];
    _subNamespacesCache.set(root, { items, fetchedAt: Date.now() });
    return items;
  } catch (err) {
    if (cached) return cached.items;
    throw err;
  }
}

// ── Mosaic cache ──────────────────────────────────────────────────────────────

// NIS1 has no "all mosaics" endpoint — mosaic definitions are only listable
// per-namespace via /namespace/mosaic/definition/page. So we walk the
// namespaces we already have cached and pull each one's mosaic definitions
// (capped at 25 per namespace, same node-side limit as namespace listing).
export async function fetchMosaicsForNamespace(fqn) {
  return nemFetch(
    `/namespace/mosaic/definition/page?namespace=${encodeURIComponent(fqn)}&pagesize=100`,
  );
}

const _refreshingMosaics = { mainnet: false, testnet: false };
export async function refreshMosaicsCache() {
  const network = currentNetwork();
  if (_refreshingMosaics[network]) return;
  _refreshingMosaics[network] = true;
  try {
    const namespaces = getCachedNamespaces(1000, 0);
    for (const ns of namespaces) {
      try {
        const data = await fetchMosaicsForNamespace(ns.fqn);
        for (const item of data.data || []) {
          const props = Object.fromEntries(
            (item.mosaic.properties || []).map((p) => [p.name, p.value]),
          );
          upsertMosaic(
            item.meta.id,
            item.mosaic.id.namespaceId,
            item.mosaic.id.name,
            item.mosaic.creator,
            item.mosaic.description || "",
            parseInt(props.divisibility) || 0,
            parseInt(props.initialSupply) || 0,
            props.transferable === "false" ? 0 : 1,
            null,
            null,
          );
        }
      } catch {
        // Skip namespaces whose mosaic query fails — keep building the cache from the rest.
      }
    }
    setCacheMeta("mosaics_updated_at", Date.now());
  } catch (err) {
    console.error(`Mosaic cache refresh failed (${network}):`, err.message);
  } finally {
    _refreshingMosaics[network] = false;
  }
}

// Full deep mosaic refresh: scans every known namespace (live + archive) in
// parallel batches, updating supply and other live fields. Runs every 6 hours.
const _refreshingMosaicsDeep = { mainnet: false, testnet: false };
export async function refreshAllMosaicsDeep() {
  const network = currentNetwork();
  if (_refreshingMosaicsDeep[network]) return;
  _refreshingMosaicsDeep[network] = true;
  try {
    // Union of all known namespace FQNs: live + archive namespaces + namespaces
    // that have mosaic records in the archive but may not appear in the namespace list.
    const nsSet = new Set();
    getNamespacesWithArchive(10000, 0).forEach((ns) => nsSet.add(ns.fqn));
    getDb()
      .prepare("SELECT DISTINCT namespace FROM mosaics_archive")
      .all()
      .forEach((r) => nsSet.add(r.namespace));
    const namespaces = [...nsSet];
    const BATCH = 10;
    let updated = 0;
    for (let i = 0; i < namespaces.length; i += BATCH) {
      const batch = namespaces.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (fqn) => {
          try {
            const data = await fetchMosaicsForNamespace(fqn);
            for (const item of data.data || []) {
              const props = Object.fromEntries(
                (item.mosaic.properties || []).map((p) => [p.name, p.value]),
              );
              upsertMosaic(
                item.meta.id,
                item.mosaic.id.namespaceId,
                item.mosaic.id.name,
                item.mosaic.creator,
                item.mosaic.description || "",
                parseInt(props.divisibility) || 0,
                parseInt(props.initialSupply) || 0,
                props.transferable === "false" ? 0 : 1,
                null,
                null,
              );
              updated++;
            }
          } catch {
            /* namespace unavailable or no mosaics */
          }
        }),
      );
      await new Promise((r) => setTimeout(r, DEEP_REFRESH_BATCH_DELAY_MS));
    }
    setCacheMeta("mosaics_deep_updated_at", Date.now());
    console.log(
      `Deep mosaic refresh complete: ${updated} mosaics across ${namespaces.length} namespaces`,
    );
  } catch (err) {
    console.error(`Deep mosaic refresh failed (${network}):`, err.message);
  } finally {
    _refreshingMosaicsDeep[network] = false;
  }
}

const NEMTOOL_MOSAIC_LIST_URL =
  "https://explorer.nemtool.com/mosaic/mosaicList";

// Same rationale as importNamespaceArchive: the live cache only ever covers
// mosaics minted under the handful of root namespaces our cache happens to
// know about right now, so older mosaics under since-dropped namespaces
// disappear from view. explorer.nemtool.com keeps a full historical mosaic
// index browsable via cursor pagination on its internal `no` field — we walk
// it once and persist the results locally (mosaics_archive). One-time only,
// since the historical records it covers are immutable.
export async function importMosaicArchive() {
  if (getCacheMeta("mosaics_archive_imported")) {
    // Re-import if height data is missing (schema upgrade from older DB).
    const hasHeight = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM mosaics_archive WHERE height IS NOT NULL",
      )
      .get().c;
    if (hasHeight) return;
    getDb().exec("DELETE FROM cache_meta WHERE key = 'mosaics_archive_imported'");
  }
  let cursor = null;
  let imported = 0;
  try {
    for (let page = 0; page < 600; page++) {
      const body =
        cursor != null ? { pageSize: 50, no: cursor } : { pageSize: 50 };
      const res = await fetch(NEMTOOL_MOSAIC_LIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const batch = await res.json();
      if (!Array.isArray(batch) || !batch.length) break;
      for (const item of batch) {
        upsertMosaicArchive(
          item.no,
          item.namespace,
          item.mosaicName,
          item.creator,
          item.description || "",
          item.divisibility || 0,
          item.initialSupply || 0,
          item.transferable ? 1 : 0,
          item.height || null,
          item.timeStamp || null,
        );
      }
      imported += batch.length;
      const last = batch[batch.length - 1].no;
      if (batch.length < 50 || last === cursor) break;
      cursor = last;
      await new Promise((r) => setTimeout(r, ARCHIVE_PAGE_DELAY_MS));
    }
    setCacheMeta("mosaics_archive_imported", Date.now());
    console.log(
      `Mosaic archive import complete: ${imported} records seen, ${getArchivedMosaicsCount()} stored (source: explorer.nemtool.com)`,
    );
  } catch (err) {
    console.error("Mosaic archive import failed:", err.message);
  }
}

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
// no page-count cap — loop until a page comes back empty (or the cursor
// stalls) — and progress is checkpointed to cache_meta every page so a
// restart mid-import resumes instead of starting over from scratch.
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
      if (last === cursor) break;
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
      const last = batch[batch.length - 1].no;
      if (reachedKnown || last === cursor) break;
      cursor = last;
      await new Promise((r) => setTimeout(r, ARCHIVE_PAGE_DELAY_MS));
    }
    if (fetched) console.log(`Mosaic transfer top-up: ${fetched} new records`);
  } catch (err) {
    console.error("Mosaic transfer top-up failed:", err.message);
  } finally {
    _refreshingMosaicTransfers[network] = false;
  }
}

// ── Poll archive ──────────────────────────────────────────────────────────────

const NEMTOOL_POLL_LIST_URL = "https://explorer.nemtool.com/poll/list";

// "Polls" aren't a NIS1 protocol concept — there's no on-chain data source for
// them at all. nemtool runs its own off-chain voting/poll service and serves
// the full list (~100 entries, no pagination) from a single POST. We mirror
// that list locally once; since closed polls never change, this is one-time.
export async function importPollArchive() {
  if (getCacheMeta("polls_imported")) return;
  try {
    const res = await fetch(NEMTOOL_POLL_LIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error("unexpected response shape");
    for (const item of list) {
      upsertPoll(item.id, item.address, item.title, item.type, item.doe);
    }
    setCacheMeta("polls_imported", Date.now());
    console.log(
      `Poll import complete: ${list.length} records stored (source: explorer.nemtool.com)`,
    );
  } catch (err) {
    console.error("Poll import failed:", err.message);
  }
}

// ── Rich list ─────────────────────────────────────────────────────────────────

// NIS1 has no "list all accounts by balance" endpoint either — nemnodes.org
// publishes a static rich-list page (accounts with >10k XEM balance) that we
// scrape and cache. The source itself is only rebuilt occasionally, so there's
// no point refreshing more often than that.
const RICHLIST_URL = "https://nemnodes.org/richlist/";
const RICHLIST_ROW_RE =
  /<tr class="d[01]"><td>(\d+)<\/td><td>([A-Z0-9]+)<\/td><td class="rght">[^<]*<\/td><td class="rght">(\d+)<\/td><td>([^<]*)<\/td><\/tr>/g;

async function fetchRichListFromSource() {
  const res = await fetch(RICHLIST_URL);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const html = await res.text();
  const rows = [];
  let m;
  while ((m = RICHLIST_ROW_RE.exec(html))) {
    rows.push({
      rank: parseInt(m[1]),
      address: m[2],
      balance: parseInt(m[3]),
      info: m[4] || "",
    });
  }
  return rows;
}

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
      try {
        extractExchangeFlowsFromBlock(JSON.parse(row.raw), watchMap);
      } catch (err) {
        console.error("Exchange backfill: skipping unparseable block", row.height, err.message);
      }
    }
    await new Promise((r) => setImmediate(r));
  }
  for (const { address } of pending) markExchangeAddressBackfilled(address);
}

// NIS1 has no "list accounts by balance" endpoint, so a candidate pool of
// addresses still has to come from somewhere — the nemnodes.org scrape above
// supplies that universe. But its balance figures go stale for long stretches
// (the source itself can sit unchanged for over a year), which is exactly why
// our rich list disagreed with live explorers. So balances/importance shown to
// users are never read from that cache: each candidate address is re-queried
// live via /account/get and the list is re-ranked by *current* chain balance.
const LIVE_RICHLIST_POOL = 150;
export let liveRichList = [];
export let liveRichListUpdatedAt = null;
let _refreshingLiveRichList = false;

async function fetchAccountsLive(addresses, batchSize = 10) {
  const out = [];
  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    out.push(
      ...(await Promise.all(
        batch.map((addr) => getAccount(addr).catch(() => null)),
      )),
    );
  }
  return out;
}

export async function refreshLiveRichList() {
  if (_refreshingLiveRichList) return;
  _refreshingLiveRichList = true;
  try {
    if (!getCachedRichListCount()) await refreshRichListCache();
    const pool = getCachedRichList(LIVE_RICHLIST_POOL);
    const accounts = await fetchAccountsLive(pool.map((p) => p.address));
    const ranked = pool
      .map((p, i) => {
        const acc = accounts[i]?.account;
        return acc
          ? {
              address: p.address,
              balance: acc.balance,
              importance: acc.importance,
              info: p.info,
            }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.balance - a.balance)
      .map((r, i) => ({ rank: i + 1, ...r }));
    if (ranked.length) {
      liveRichList = ranked;
      liveRichListUpdatedAt = Date.now();
    }
  } catch (err) {
    console.error("Live rich list refresh failed:", err.message);
  } finally {
    _refreshingLiveRichList = false;
  }
}

// ── XEM price ─────────────────────────────────────────────────────────────────

// XEM has no price on the NEM network itself — pull the USD spot price and
// 24h change straight from CoinGecko's public API so the navbar can show a
// live "XEM Price" readout like Etherscan/Arbiscan do for ETH. (KuCoin used
// to be the source here, but it delisted XEM entirely.)
const COINGECKO_TICKER_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=nem&vs_currencies=usd&include_24hr_change=true";

export async function fetchXemPriceFromCoinGecko() {
  const res = await fetch(COINGECKO_TICKER_URL);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const json = await res.json();
  const data = json.nem;
  if (!data || data.usd == null || data.usd_24h_change == null)
    throw new Error("no ticker data");
  return {
    price: parseFloat(data.usd),
    // CoinGecko reports the 24h change as a percentage (e.g. 27.75); keep
    // this function's contract as a fraction (0.2775) to match the rest of
    // the app, which multiplies by 100 for display.
    changeRate: parseFloat(data.usd_24h_change) / 100,
  };
}

let _refreshingPrice = false;
export async function refreshPriceCache() {
  if (_refreshingPrice) return;
  _refreshingPrice = true;
  try {
    const { price, changeRate } = await fetchXemPriceFromCoinGecko();
    setCacheMeta("xem_price", price);
    setCacheMeta("xem_change_rate", changeRate);
  } catch (err) {
    console.error("XEM price refresh failed:", err.message);
  } finally {
    _refreshingPrice = false;
  }
}

// ── Daily TX stats + block persistence ──────────────────────────────────────

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
    // A v2 transfer carrying attached mosaics uses tx.amount as a multiplier
    // applied to each mosaic's quantity, not as a XEM quantity itself —
    // counting it here would record a phantom XEM flow.
    if (tx.mosaics?.length) continue;
    const amount = tx.amount || 0;
    const sender = addrFromPubKey(tx.signer);
    const senderExchange = watchMap.get(sender);
    const recipientExchange = watchMap.get(tx.recipient);
    // Sender and recipient both belong to the same exchange (e.g. an
    // internal hot-wallet-to-cold-wallet move) — recording this as both an
    // outflow and an inflow would double-book a transfer that never left
    // the exchange.
    if (senderExchange && senderExchange === recipientExchange) continue;
    if (senderExchange) bumpExchangeDailyFlow(dateKey, sender, 0, amount);
    if (recipientExchange) bumpExchangeDailyFlow(dateKey, tx.recipient, amount, 0);
  }
}

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
      try {
        extractExchangeFlowsFromBlock(block, exchangeWatchMap);
      } catch (err) {
        console.error("Exchange flow extraction failed:", err.message);
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
  } catch (err) {
    console.error("Tx type archive refresh failed:", err.message);
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
