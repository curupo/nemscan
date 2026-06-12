import {
  db,
  getCachedNamespaces,
  getArchivedNamespacesCount,
  getArchivedMosaicsCount,
  getNamespacesWithArchive,
  getCacheMeta,
  setCacheMeta,
  getCachedRichListCount,
  getCachedRichList,
  bumpDailyTxCount,
  getOldestDailyTxDate,
  upsertNamespace,
  upsertNamespaceArchive,
  upsertMosaic,
  upsertMosaicArchive,
  upsertPoll,
  upsertRichListEntry,
} from "./db.js";
import {
  nemFetch,
  getAccount,
  fetchBlockRaw,
  getHeight,
  fetchNamespacesFromNode,
} from "./nemApi.js";
import { dateKeyFromTs } from "./helpers.js";
import {
  NEM_NODES,
  DAILY_TX_DAYS,
  DAILY_TX_BACKFILL_CHUNK,
  ARCHIVE_PAGE_DELAY_MS,
  DEEP_REFRESH_BATCH_DELAY_MS,
  NODE_PROBE_TIMEOUT_MS,
} from "./constants.js";

// ── Namespace cache ───────────────────────────────────────────────────────────

let _refreshingNamespaces = false;
export async function refreshNamespacesCache() {
  if (_refreshingNamespaces) return;
  _refreshingNamespaces = true;
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
    console.error("Namespace cache refresh failed:", err.message);
  } finally {
    _refreshingNamespaces = false;
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

// ── Supernode / HTTPS node options ────────────────────────────────────────────

// The NEM SuperNode Program (nem.io/supernode) runs its own enrollment
// service — NIS1 nodes have no protocol-level concept of "supernode" status,
// so we query the program's public API directly rather than a NIS node.
const SUPERNODE_API = "https://nem.io/supernode/api";

export async function getActiveSupernodes() {
  const res = await fetch(
    `${SUPERNODE_API}/nodes?count=100&offset=0&status=active`,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

// Connection-node picker (navbar dropdown) — restricted to active supernodes
// that actually speak HTTPS. The supernode directory only ever registers each
// node's plain-HTTP REST endpoint (host:7890); it never lists an "https://"
// entry. By NIS1 convention the same host commonly answers HTTPS one port up
// (host:7891 — exactly how our own NEM_NODES pool is configured), so we derive
// that candidate and probe it directly rather than trusting the registry.
// Refreshed on the same 5-minute cadence as the rest of the "live" data.
export let httpsNodeOptions = [];
export let httpsNodeOptionsUpdatedAt = null;
let _refreshingHttpsNodeOptions = false;

export async function probeHttpsNode(host, timeoutMs = NODE_PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${host}/chain/height`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Number.isFinite(data?.height);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function refreshHttpsNodeOptions(batchSize = 12) {
  if (_refreshingHttpsNodeOptions) return;
  _refreshingHttpsNodeOptions = true;
  try {
    const nodes = await getActiveSupernodes();
    const candidates = [];
    for (const n of nodes) {
      let u;
      try {
        u = new URL(n.endpoint);
      } catch {
        continue;
      }
      const httpsPort = u.port ? String(Number(u.port) + 1) : "443";
      const host = `${u.hostname}:${httpsPort}`;
      candidates.push({
        name: n.name || u.hostname,
        host,
        endpoint: `https://${host}`,
      });
    }
    const verified = [];
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const ok = await Promise.all(batch.map((c) => probeHttpsNode(c.host)));
      batch.forEach((c, idx) => {
        if (ok[idx]) verified.push(c);
      });
    }
    httpsNodeOptions = verified;
    httpsNodeOptionsUpdatedAt = Date.now();
  } catch (err) {
    console.error("Node options refresh failed:", err.message);
  } finally {
    _refreshingHttpsNodeOptions = false;
  }
}

export function findNodeOption(endpoint) {
  return httpsNodeOptions.find((n) => n.endpoint === endpoint) || null;
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

let _refreshingMosaics = false;
export async function refreshMosaicsCache() {
  if (_refreshingMosaics) return;
  _refreshingMosaics = true;
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
    console.error("Mosaic cache refresh failed:", err.message);
  } finally {
    _refreshingMosaics = false;
  }
}

// Full deep mosaic refresh: scans every known namespace (live + archive) in
// parallel batches, updating supply and other live fields. Runs every 6 hours.
let _refreshingMosaicsDeep = false;
export async function refreshAllMosaicsDeep() {
  if (_refreshingMosaicsDeep) return;
  _refreshingMosaicsDeep = true;
  try {
    // Union of all known namespace FQNs: live + archive namespaces + namespaces
    // that have mosaic records in the archive but may not appear in the namespace list.
    const nsSet = new Set();
    getNamespacesWithArchive(10000, 0).forEach((ns) => nsSet.add(ns.fqn));
    db.prepare("SELECT DISTINCT namespace FROM mosaics_archive")
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
    console.error("Deep mosaic refresh failed:", err.message);
  } finally {
    _refreshingMosaicsDeep = false;
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
    const hasHeight = db
      .prepare(
        "SELECT COUNT(*) AS c FROM mosaics_archive WHERE height IS NOT NULL",
      )
      .get().c;
    if (hasHeight) return;
    db.exec("DELETE FROM cache_meta WHERE key = 'mosaics_archive_imported'");
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
  } catch (err) {
    console.error("Rich list cache refresh failed:", err.message);
  } finally {
    _refreshingRichList = false;
  }
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

// XEM has no price on the NEM network itself — pull the USDT spot price and
// 24h change straight from KuCoin's public ticker so the navbar can show a
// live "XEM Price" readout like Etherscan/Arbiscan do for ETH.
const KUCOIN_TICKER_URL =
  "https://api.kucoin.com/api/v1/market/stats?symbol=XEM-USDT";

async function fetchXemPriceFromKucoin() {
  const res = await fetch(KUCOIN_TICKER_URL);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const json = await res.json();
  const data = json.data;
  if (!data || data.last == null || data.changeRate == null)
    throw new Error("no ticker data");
  return {
    price: parseFloat(data.last),
    changeRate: parseFloat(data.changeRate),
  };
}

let _refreshingPrice = false;
export async function refreshPriceCache() {
  if (_refreshingPrice) return;
  _refreshingPrice = true;
  try {
    const { price, changeRate } = await fetchXemPriceFromKucoin();
    setCacheMeta("xem_price", price);
    setCacheMeta("xem_change_rate", changeRate);
  } catch (err) {
    console.error("XEM price refresh failed:", err.message);
  } finally {
    _refreshingPrice = false;
  }
}

// ── Daily TX stats ────────────────────────────────────────────────────────────

// NIS1 has no endpoint for historical transaction counts, so we derive them
// ourselves by walking blocks one at a time and bucketing each block's
// transaction count by its UTC calendar date. A full DAILY_TX_DAYS window is
// far too many blocks to fetch in one pass, so each call advances the scanned
// range a little (forward to pick up new blocks, backward to backfill older
// days) and persists progress in cache_meta so it resumes across restarts.
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
    }
    if (i + BATCH < heights.length)
      await new Promise((r) => setTimeout(r, ARCHIVE_PAGE_DELAY_MS));
  }
}

let _refreshingDailyTxStats = false;
export async function refreshDailyTxStats() {
  if (_refreshingDailyTxStats) return;
  _refreshingDailyTxStats = true;
  try {
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

    if (!getCacheMeta("daily_tx_backfill_done")) {
      const cutoff = new Date(Date.now() - (DAILY_TX_DAYS - 1) * 86400000)
        .toISOString()
        .slice(0, 10);
      const oldest = getOldestDailyTxDate();
      if ((oldest && oldest <= cutoff) || minH <= 1) {
        setCacheMeta("daily_tx_backfill_done", "1");
      } else {
        const to = Math.max(1, minH - DAILY_TX_BACKFILL_CHUNK);
        const heights = [];
        for (let h = minH - 1; h >= to; h--) heights.push(h);
        await scanBlockHeightsForDailyTx(heights);
        minH = to;
        setCacheMeta("daily_tx_scan_min_height", minH);
      }
    }
  } catch (err) {
    console.error("Daily tx stats refresh failed:", err.message);
  } finally {
    _refreshingDailyTxStats = false;
  }
}

// Self-rescheduling rather than setInterval: backfill runs in quick
// succession (every 5s) until DAILY_TX_DAYS of history is covered, then
// settles into an infrequent catch-up poll (every 5min).
export function scheduleDailyTxStatsRefresh() {
  refreshDailyTxStats().finally(() => {
    const delay = getCacheMeta("daily_tx_backfill_done")
      ? 5 * 60 * 1000
      : 5 * 1000;
    setTimeout(scheduleDailyTxStatsRefresh, delay);
  });
}
