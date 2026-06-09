import express from 'express';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';

const app = express();
const PORT = 3000;

// Carries the per-request "preferred connection node" (chosen via the navbar's
// node-switch dropdown and sent back as a cookie) through to nemFetch(), without
// threading it through every route handler and HTML builder by hand.
const nodeContext = new AsyncLocalStorage();

// ── Local cache (SQLite) ──────────────────────────────────────────────────────
// Some NEM NIS endpoints (e.g. /namespace/root/page) take ~10s to answer on
// every known node, which makes a per-request fetch feel sluggish. We instead
// keep a local SQLite cache that's refreshed in the background on a timer, so
// page requests are served instantly from disk.

const db = new DatabaseSync('./cache.db');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS namespaces (
    id INTEGER PRIMARY KEY,
    fqn TEXT NOT NULL,
    owner TEXT NOT NULL,
    height INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS namespaces_archive (
    no INTEGER PRIMARY KEY,
    fqn TEXT NOT NULL,
    owner TEXT NOT NULL,
    height INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_namespaces_archive_fqn ON namespaces_archive(fqn);
  CREATE TABLE IF NOT EXISTS mosaics (
    id INTEGER PRIMARY KEY,
    namespace TEXT NOT NULL,
    name TEXT NOT NULL,
    creator TEXT NOT NULL,
    description TEXT,
    divisibility INTEGER NOT NULL DEFAULT 0,
    supply INTEGER NOT NULL DEFAULT 0,
    transferable INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS mosaics_archive (
    no INTEGER PRIMARY KEY,
    namespace TEXT NOT NULL,
    name TEXT NOT NULL,
    creator TEXT NOT NULL,
    description TEXT,
    divisibility INTEGER NOT NULL DEFAULT 0,
    supply INTEGER NOT NULL DEFAULT 0,
    transferable INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    title TEXT NOT NULL,
    type INTEGER NOT NULL,
    doe INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS richlist (
    rank INTEGER PRIMARY KEY,
    address TEXT NOT NULL,
    balance INTEGER NOT NULL,
    info TEXT
  );
  CREATE TABLE IF NOT EXISTS cache_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
try { db.exec('ALTER TABLE mosaics ADD COLUMN height INTEGER'); } catch {}
try { db.exec('ALTER TABLE mosaics ADD COLUMN time_stamp INTEGER'); } catch {}
try { db.exec('ALTER TABLE mosaics_archive ADD COLUMN height INTEGER'); } catch {}
try { db.exec('ALTER TABLE mosaics_archive ADD COLUMN time_stamp INTEGER'); } catch {}
const _nsUpsertStmt = db.prepare('INSERT OR REPLACE INTO namespaces (id, fqn, owner, height) VALUES (?, ?, ?, ?)');
const _nsSelectStmt = db.prepare('SELECT id, fqn, owner, height FROM namespaces ORDER BY id DESC LIMIT ? OFFSET ?');
const _nsCountStmt = db.prepare('SELECT COUNT(*) AS c FROM namespaces');
const _nsArchUpsertStmt = db.prepare('INSERT OR REPLACE INTO namespaces_archive (no, fqn, owner, height) VALUES (?, ?, ?, ?)');
const _nsArchCountStmt = db.prepare('SELECT COUNT(*) AS c FROM namespaces_archive');
// Live cache only ever holds the newest ~25 root namespaces (NIS pagination is
// broken beyond page one — see fetchNamespacesFromNode), so for display we
// merge it with the historical archive imported from explorer.nemtool.com,
// preferring the live row whenever a namespace appears in both.
const _nsCombinedSelectStmt = db.prepare(`
  SELECT fqn, owner, height FROM (
    SELECT fqn, owner, height FROM namespaces
    UNION
    SELECT fqn, owner, height FROM namespaces_archive WHERE fqn NOT IN (SELECT fqn FROM namespaces)
  )
  ORDER BY height DESC LIMIT ? OFFSET ?
`);
const _nsCombinedCountStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM (
    SELECT fqn FROM namespaces
    UNION
    SELECT fqn FROM namespaces_archive WHERE fqn NOT IN (SELECT fqn FROM namespaces)
  )
`);
const _nsLiveByFqnStmt = db.prepare('SELECT fqn, owner, height FROM namespaces WHERE fqn = ?');
const _nsArchByFqnStmt = db.prepare('SELECT fqn, owner, height FROM namespaces_archive WHERE fqn = ?');
const _mosUpsertStmt = db.prepare('INSERT OR REPLACE INTO mosaics (id, namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const _mosSelectStmt = db.prepare('SELECT id, namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp FROM mosaics ORDER BY id DESC LIMIT ? OFFSET ?');
const _mosCountStmt = db.prepare('SELECT COUNT(*) AS c FROM mosaics');
const _mosArchUpsertStmt = db.prepare('INSERT OR REPLACE INTO mosaics_archive (no, namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const _mosArchCountStmt = db.prepare('SELECT COUNT(*) AS c FROM mosaics_archive');
// Live cache only ever covers mosaics under the ~25 most-recently-cached root
// namespaces (it's derived from getCachedNamespaces — see refreshMosaicsCache),
// so for display we merge it with the historical archive imported from
// explorer.nemtool.com, preferring the live row whenever a mosaic ID
// (namespace:name) appears in both.
const _mosCombinedSelectStmt = db.prepare(`
  SELECT namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp FROM (
    SELECT namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp FROM mosaics
    UNION
    SELECT namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp FROM mosaics_archive
      WHERE (namespace || ':' || name) NOT IN (SELECT namespace || ':' || name FROM mosaics)
  )
  ORDER BY height DESC LIMIT ? OFFSET ?
`);
const _mosCombinedCountStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM (
    SELECT namespace || ':' || name AS mid FROM mosaics
    UNION
    SELECT namespace || ':' || name AS mid FROM mosaics_archive WHERE (namespace || ':' || name) NOT IN (SELECT namespace || ':' || name FROM mosaics)
  )
`);
const _mosByNamespaceStmt = db.prepare(`
  SELECT namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp FROM (
    SELECT namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp FROM mosaics WHERE namespace = ?
    UNION
    SELECT namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp FROM mosaics_archive
      WHERE namespace = ? AND (namespace || ':' || name) NOT IN (SELECT namespace || ':' || name FROM mosaics)
  )
  ORDER BY name ASC
`);
const _mosByNsAndNameStmt = db.prepare(`
  SELECT namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp FROM (
    SELECT namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp FROM mosaics WHERE namespace = ? AND name = ?
    UNION
    SELECT namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp FROM mosaics_archive WHERE namespace = ? AND name = ?
  ) LIMIT 1
`);
const _pollUpsertStmt = db.prepare('INSERT OR REPLACE INTO polls (id, address, title, type, doe) VALUES (?, ?, ?, ?, ?)');
const _pollSelectStmt = db.prepare('SELECT id, address, title, type, doe FROM polls ORDER BY doe DESC LIMIT ? OFFSET ?');
const _pollCountStmt = db.prepare('SELECT COUNT(*) AS c FROM polls');
const _accUpsertStmt = db.prepare('INSERT OR REPLACE INTO richlist (rank, address, balance, info) VALUES (?, ?, ?, ?)');
const _accSelectStmt = db.prepare('SELECT rank, address, balance, info FROM richlist ORDER BY rank ASC LIMIT ? OFFSET ?');
const _accCountStmt = db.prepare('SELECT COUNT(*) AS c FROM richlist');
const _metaUpsertStmt = db.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)');
const _metaSelectStmt = db.prepare('SELECT value FROM cache_meta WHERE key = ?');

function getCachedNamespaces(limit = 25, offset = 0) {
  return _nsSelectStmt.all(limit, offset);
}

function getCachedNamespacesCount() {
  return _nsCountStmt.get().c;
}

function getArchivedNamespacesCount() {
  return _nsArchCountStmt.get().c;
}

function getNamespacesWithArchive(limit = 25, offset = 0) {
  return _nsCombinedSelectStmt.all(limit, offset);
}

function getNamespacesWithArchiveCount() {
  return _nsCombinedCountStmt.get().c;
}

function getNamespaceByFqn(fqn) {
  return _nsLiveByFqnStmt.get(fqn) || _nsArchByFqnStmt.get(fqn) || null;
}

function getCachedMosaics(limit = 25, offset = 0) {
  return _mosSelectStmt.all(limit, offset);
}

function getCachedMosaicsCount() {
  return _mosCountStmt.get().c;
}

function getArchivedMosaicsCount() {
  return _mosArchCountStmt.get().c;
}

function getMosaicsWithArchive(limit = 25, offset = 0) {
  return _mosCombinedSelectStmt.all(limit, offset);
}

function getMosaicsWithArchiveCount() {
  return _mosCombinedCountStmt.get().c;
}

function getMosaicsByNamespace(fqn) {
  return _mosByNamespaceStmt.all(fqn, fqn);
}

function getMosaicByNsAndName(namespace, name) {
  return _mosByNsAndNameStmt.get(namespace, name, namespace, name) || null;
}

function getCachedPolls(limit = 25, offset = 0) {
  return _pollSelectStmt.all(limit, offset);
}

function getCachedPollsCount() {
  return _pollCountStmt.get().c;
}

function getCachedRichList(limit = 25, offset = 0) {
  return _accSelectStmt.all(limit, offset);
}

function getCachedRichListCount() {
  return _accCountStmt.get().c;
}

function getCacheMeta(key) {
  return _metaSelectStmt.get(key)?.value ?? null;
}

function setCacheMeta(key, value) {
  _metaUpsertStmt.run(key, String(value));
}

const NEM_NODES = [
  'https://nebuta.kasanetalk.net:7891',
  'https://tanabata.kasanetalk.net:7891',
  'https://sanja.kasanetalk.net:7891',
  'https://kanda.kasanetalk.net:7891',
  'https://gion.kasanetalk.net:7891',
  'https://tenjin.kasanetalk.net:7891',
  'https://yosakoi.kasanetalk.net:7891',
  'https://yamakasa.kasanetalk.net:7891',
  'https://eisa.kasanetalk.net:7891',
  'https://hanabi.kasanetalk.net:7891',
];
const NEM_EPOCH_MS = 1427587585000;
const blockCache = new Map();

const TX_TYPES = {
  257: 'Transfer', 2049: 'Importance', 4097: 'Multisig Mod',
  4100: 'Multisig Sig', 4099: 'Multisig', 8193: 'Namespace',
  16385: 'Mosaic Def', 16386: 'Mosaic Supply',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function nemDate(ts) { return new Date(NEM_EPOCH_MS + ts * 1000); }

function timeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function nemFetch(path, options = {}, timeoutMs = 3000) {
  const preferred = nodeContext.getStore();
  const pool = preferred ? [preferred.endpoint, ...NEM_NODES.filter(n => n !== preferred.endpoint)] : NEM_NODES;
  for (const node of pool) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${node}${path}`, { ...options, signal: ctrl.signal });
        if (res.ok) {
          // Keep the abort timer alive through body parsing — a node can send
          // headers immediately and then stall mid-body, which would otherwise
          // hang forever once the timer is cleared.
          const json = await res.json();
          clearTimeout(t);
          return json;
        }
        clearTimeout(t);
        if (res.status === 429) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        break;
      } catch {
        clearTimeout(t);
        break;
      }
    }
  }
  throw new Error('All NEM nodes failed');
}

async function getHeight() {
  const d = await nemFetch('/chain/height');
  return d.height;
}

async function getBlock(height) {
  if (blockCache.has(height)) return blockCache.get(height);
  const block = await nemFetch('/block/at/public', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ height }),
  });
  blockCache.set(height, block);
  if (blockCache.size > 500) blockCache.delete(blockCache.keys().next().value);
  return block;
}

async function getAccount(address) {
  return nemFetch(`/account/get?address=${encodeURIComponent(address)}`);
}

async function getAccountTxs(address, id = null) {
  const extra = id ? `&id=${id}` : '';
  return nemFetch(`/account/transfers/all?address=${encodeURIComponent(address)}${extra}`);
}

async function getAccountHarvests(address) {
  return nemFetch(`/account/harvests?address=${encodeURIComponent(address)}`);
}

async function getAccountMosaics(address) {
  return nemFetch(`/account/mosaic/owned?address=${encodeURIComponent(address)}`);
}

async function getAccountNamespaces(address) {
  return nemFetch(`/account/namespace/page?address=${encodeURIComponent(address)}`);
}

// Some endpoints (e.g. /namespace/root/page) are slow on many individual
// nodes. Rather than trying nodes one-by-one (which pays the slow timeout
// for each laggard before reaching a fast one), query all nodes in parallel
// and use whichever responds first.
async function nemFetchRace(path, timeoutMs = 20000) {
  const attempts = NEM_NODES.map(async node => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${node}${path}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  });
  try {
    return await Promise.any(attempts);
  } catch {
    throw new Error('All NEM nodes failed');
  }
}

async function fetchNamespacesFromNode() {
  // NB: the official param name is the lowercase `pagesize` (not `pageSize`).
  // Cursor-based paging via `id` is unfortunately broken on every known node
  // (times out or "could not extract ResultSet"), so we only fetch page one.
  return nemFetchRace(`/namespace/root/page?pagesize=25`);
}

let _refreshingNamespaces = false;
async function refreshNamespacesCache() {
  if (_refreshingNamespaces) return;
  _refreshingNamespaces = true;
  try {
    const data = await fetchNamespacesFromNode();
    for (const item of data.data || []) {
      _nsUpsertStmt.run(item.meta.id, item.namespace.fqn, item.namespace.owner, item.namespace.height);
    }
    setCacheMeta('namespaces_updated_at', Date.now());
  } catch (err) {
    console.error('Namespace cache refresh failed:', err.message);
  } finally {
    _refreshingNamespaces = false;
  }
}

const NEMTOOL_NAMESPACE_LIST_URL = 'https://explorer.nemtool.com/namespace/rootNamespaceList';

// NIS nodes only ever return the newest ~25 root namespaces (pagination is
// broken beyond page one — see fetchNamespacesFromNode above), so anything
// older than that has fallen out of our live cache. explorer.nemtool.com
// keeps its own historical index reaching back to the network's early days,
// browsable via cursor pagination on its internal `no` field. We walk it
// once and persist the results locally (namespaces_archive) so the
// /namespaces page can show the fuller picture without depending on a
// third-party site at request time. This only needs to run once — the
// historical records it covers are immutable.
async function importNamespaceArchive() {
  if (getCacheMeta('namespaces_archive_imported')) return;
  let cursor = null;
  let imported = 0;
  try {
    for (let page = 0; page < 200; page++) {
      const body = cursor != null ? { pageSize: 50, no: cursor } : { pageSize: 50 };
      const res = await fetch(NEMTOOL_NAMESPACE_LIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const batch = await res.json();
      if (!Array.isArray(batch) || !batch.length) break;
      for (const item of batch) {
        _nsArchUpsertStmt.run(item.no, item.namespace, item.creator, item.height);
      }
      imported += batch.length;
      const last = batch[batch.length - 1].no;
      if (batch.length < 50 || last === cursor) break;
      cursor = last;
      await new Promise(r => setTimeout(r, 150));
    }
    setCacheMeta('namespaces_archive_imported', Date.now());
    console.log(`Namespace archive import complete: ${imported} records seen, ${getArchivedNamespacesCount()} stored (source: explorer.nemtool.com)`);
  } catch (err) {
    console.error('Namespace archive import failed:', err.message);
  }
}

const NEMTOOL_NAMESPACE_BY_ROOT_URL = 'https://explorer.nemtool.com/namespace/namespaceListbyNamespace';
const _subNamespacesCache = new Map(); // root fqn -> { items, fetchedAt }
const SUBNS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// There's no bulk endpoint for sub-namespaces (and walking namespaceListbyNamespace
// for ~3,000 known roots up front would be a heavy one-time cost for data that's
// only needed when someone actually opens a namespace detail page), so unlike the
// root-namespace archive we fetch this on demand from explorer.nemtool.com and
// cache the result in memory for a few hours.
async function fetchSubNamespaces(root) {
  const cached = _subNamespacesCache.get(root);
  if (cached && Date.now() - cached.fetchedAt < SUBNS_CACHE_TTL_MS) return cached.items;
  try {
    const res = await fetch(NEMTOOL_NAMESPACE_BY_ROOT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ns: root }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const list = await res.json();
    const items = Array.isArray(list)
      ? list.filter(x => x.namespace !== root).map(x => ({ fqn: x.namespace, owner: x.creator, height: x.height }))
      : [];
    _subNamespacesCache.set(root, { items, fetchedAt: Date.now() });
    return items;
  } catch (err) {
    if (cached) return cached.items;
    throw err;
  }
}

// The NEM SuperNode Program (nem.io/supernode) runs its own enrollment
// service — NIS1 nodes have no protocol-level concept of "supernode" status,
// so we query the program's public API directly rather than a NIS node.
const SUPERNODE_API = 'https://nem.io/supernode/api';

async function getActiveSupernodes() {
  const res = await fetch(`${SUPERNODE_API}/nodes?count=100&offset=0&status=active`);
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
let httpsNodeOptions = [];
let httpsNodeOptionsUpdatedAt = null;
let _refreshingHttpsNodeOptions = false;

async function probeHttpsNode(host, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${host}/chain/height`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const data = await res.json();
    return Number.isFinite(data?.height);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function refreshHttpsNodeOptions(batchSize = 12) {
  if (_refreshingHttpsNodeOptions) return;
  _refreshingHttpsNodeOptions = true;
  try {
    const nodes = await getActiveSupernodes();
    const candidates = [];
    for (const n of nodes) {
      let u;
      try { u = new URL(n.endpoint); } catch { continue; }
      const httpsPort = u.port ? String(Number(u.port) + 1) : '443';
      const host = `${u.hostname}:${httpsPort}`;
      candidates.push({ name: n.name || u.hostname, host, endpoint: `https://${host}` });
    }
    const verified = [];
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const ok = await Promise.all(batch.map(c => probeHttpsNode(c.host)));
      batch.forEach((c, idx) => { if (ok[idx]) verified.push(c); });
    }
    httpsNodeOptions = verified;
    httpsNodeOptionsUpdatedAt = Date.now();
  } catch (err) {
    console.error('Node options refresh failed:', err.message);
  } finally {
    _refreshingHttpsNodeOptions = false;
  }
}

function findNodeOption(endpoint) {
  return httpsNodeOptions.find(n => n.endpoint === endpoint) || null;
}

// NIS1 has no "all mosaics" endpoint — mosaic definitions are only listable
// per-namespace via /namespace/mosaic/definition/page. So we walk the
// namespaces we already have cached and pull each one's mosaic definitions
// (capped at 25 per namespace, same node-side limit as namespace listing).
async function fetchMosaicsForNamespace(fqn) {
  return nemFetch(`/namespace/mosaic/definition/page?namespace=${encodeURIComponent(fqn)}&pagesize=100`);
}

let _refreshingMosaics = false;
async function refreshMosaicsCache() {
  if (_refreshingMosaics) return;
  _refreshingMosaics = true;
  try {
    const namespaces = getCachedNamespaces(1000, 0);
    for (const ns of namespaces) {
      try {
        const data = await fetchMosaicsForNamespace(ns.fqn);
        for (const item of data.data || []) {
          const props = Object.fromEntries((item.mosaic.properties || []).map(p => [p.name, p.value]));
          _mosUpsertStmt.run(
            item.meta.id,
            item.mosaic.id.namespaceId,
            item.mosaic.id.name,
            item.mosaic.creator,
            item.mosaic.description || '',
            parseInt(props.divisibility) || 0,
            parseInt(props.initialSupply) || 0,
            props.transferable === 'false' ? 0 : 1,
            null,
            null
          );
        }
      } catch {
        // Skip namespaces whose mosaic query fails — keep building the cache from the rest.
      }
    }
    setCacheMeta('mosaics_updated_at', Date.now());
  } catch (err) {
    console.error('Mosaic cache refresh failed:', err.message);
  } finally {
    _refreshingMosaics = false;
  }
}

// Full deep mosaic refresh: scans every known namespace (live + archive) in
// parallel batches, updating supply and other live fields. Runs every 6 hours.
let _refreshingMosaicsDeep = false;
async function refreshAllMosaicsDeep() {
  if (_refreshingMosaicsDeep) return;
  _refreshingMosaicsDeep = true;
  try {
    // Union of all known namespace FQNs: live + archive namespaces + namespaces
    // that have mosaic records in the archive but may not appear in the namespace list.
    const nsSet = new Set();
    getNamespacesWithArchive(10000, 0).forEach(ns => nsSet.add(ns.fqn));
    db.prepare('SELECT DISTINCT namespace FROM mosaics_archive').all().forEach(r => nsSet.add(r.namespace));
    const namespaces = [...nsSet];
    const BATCH = 10;
    let updated = 0;
    for (let i = 0; i < namespaces.length; i += BATCH) {
      const batch = namespaces.slice(i, i + BATCH);
      await Promise.all(batch.map(async fqn => {
        try {
          const data = await fetchMosaicsForNamespace(fqn);
          for (const item of data.data || []) {
            const props = Object.fromEntries((item.mosaic.properties || []).map(p => [p.name, p.value]));
            _mosUpsertStmt.run(
              item.meta.id,
              item.mosaic.id.namespaceId,
              item.mosaic.id.name,
              item.mosaic.creator,
              item.mosaic.description || '',
              parseInt(props.divisibility) || 0,
              parseInt(props.initialSupply) || 0,
              props.transferable === 'false' ? 0 : 1,
              null,
              null
            );
            updated++;
          }
        } catch { /* namespace unavailable or no mosaics */ }
      }));
      await new Promise(r => setTimeout(r, 200));
    }
    setCacheMeta('mosaics_deep_updated_at', Date.now());
    console.log(`Deep mosaic refresh complete: ${updated} mosaics across ${namespaces.length} namespaces`);
  } catch (err) {
    console.error('Deep mosaic refresh failed:', err.message);
  } finally {
    _refreshingMosaicsDeep = false;
  }
}

const NEMTOOL_MOSAIC_LIST_URL = 'https://explorer.nemtool.com/mosaic/mosaicList';

// Same rationale as importNamespaceArchive: the live cache only ever covers
// mosaics minted under the handful of root namespaces our cache happens to
// know about right now, so older mosaics under since-dropped namespaces
// disappear from view. explorer.nemtool.com keeps a full historical mosaic
// index browsable via cursor pagination on its internal `no` field — we walk
// it once and persist the results locally (mosaics_archive). One-time only,
// since the historical records it covers are immutable.
async function importMosaicArchive() {
  if (getCacheMeta('mosaics_archive_imported')) {
    // Re-import if height data is missing (schema upgrade from older DB).
    const hasHeight = db.prepare('SELECT COUNT(*) AS c FROM mosaics_archive WHERE height IS NOT NULL').get().c;
    if (hasHeight) return;
    db.exec("DELETE FROM cache_meta WHERE key = 'mosaics_archive_imported'");
  }
  let cursor = null;
  let imported = 0;
  try {
    for (let page = 0; page < 600; page++) {
      const body = cursor != null ? { pageSize: 50, no: cursor } : { pageSize: 50 };
      const res = await fetch(NEMTOOL_MOSAIC_LIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const batch = await res.json();
      if (!Array.isArray(batch) || !batch.length) break;
      for (const item of batch) {
        _mosArchUpsertStmt.run(
          item.no,
          item.namespace,
          item.mosaicName,
          item.creator,
          item.description || '',
          item.divisibility || 0,
          item.initialSupply || 0,
          item.transferable ? 1 : 0,
          item.height || null,
          item.timeStamp || null
        );
      }
      imported += batch.length;
      const last = batch[batch.length - 1].no;
      if (batch.length < 50 || last === cursor) break;
      cursor = last;
      await new Promise(r => setTimeout(r, 150));
    }
    setCacheMeta('mosaics_archive_imported', Date.now());
    console.log(`Mosaic archive import complete: ${imported} records seen, ${getArchivedMosaicsCount()} stored (source: explorer.nemtool.com)`);
  } catch (err) {
    console.error('Mosaic archive import failed:', err.message);
  }
}

const NEMTOOL_POLL_LIST_URL = 'https://explorer.nemtool.com/poll/list';

// "Polls" aren't a NIS1 protocol concept — there's no on-chain data source for
// them at all. nemtool runs its own off-chain voting/poll service and serves
// the full list (~100 entries, no pagination) from a single POST. We mirror
// that list locally once; since closed polls never change, this is one-time.
async function importPollArchive() {
  if (getCacheMeta('polls_imported')) return;
  try {
    const res = await fetch(NEMTOOL_POLL_LIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('unexpected response shape');
    for (const item of list) {
      _pollUpsertStmt.run(item.id, item.address, item.title, item.type, item.doe);
    }
    setCacheMeta('polls_imported', Date.now());
    console.log(`Poll import complete: ${list.length} records stored (source: explorer.nemtool.com)`);
  } catch (err) {
    console.error('Poll import failed:', err.message);
  }
}

// NIS1 has no "list all accounts by balance" endpoint either — nemnodes.org
// publishes a static rich-list page (accounts with >10k XEM balance) that we
// scrape and cache. The source itself is only rebuilt occasionally, so there's
// no point refreshing more often than that.
const RICHLIST_URL = 'https://nemnodes.org/richlist/';
const RICHLIST_ROW_RE = /<tr class="d[01]"><td>(\d+)<\/td><td>([A-Z0-9]+)<\/td><td class="rght">[^<]*<\/td><td class="rght">(\d+)<\/td><td>([^<]*)<\/td><\/tr>/g;

async function fetchRichListFromSource() {
  const res = await fetch(RICHLIST_URL);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const html = await res.text();
  const rows = [];
  let m;
  while ((m = RICHLIST_ROW_RE.exec(html))) {
    rows.push({ rank: parseInt(m[1]), address: m[2], balance: parseInt(m[3]), info: m[4] || '' });
  }
  return rows;
}

let _refreshingRichList = false;
async function refreshRichListCache() {
  if (_refreshingRichList) return;
  _refreshingRichList = true;
  try {
    const rows = await fetchRichListFromSource();
    for (const r of rows) {
      _accUpsertStmt.run(r.rank, r.address, r.balance, r.info);
    }
    setCacheMeta('richlist_updated_at', Date.now());
  } catch (err) {
    console.error('Rich list cache refresh failed:', err.message);
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
let liveRichList = [];
let liveRichListUpdatedAt = null;
let _refreshingLiveRichList = false;

async function fetchAccountsLive(addresses, batchSize = 10) {
  const out = [];
  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    out.push(...await Promise.all(batch.map(addr => getAccount(addr).catch(() => null))));
  }
  return out;
}

async function refreshLiveRichList() {
  if (_refreshingLiveRichList) return;
  _refreshingLiveRichList = true;
  try {
    if (!getCachedRichListCount()) await refreshRichListCache();
    const pool = getCachedRichList(LIVE_RICHLIST_POOL);
    const accounts = await fetchAccountsLive(pool.map(p => p.address));
    const ranked = pool
      .map((p, i) => {
        const acc = accounts[i]?.account;
        return acc ? { address: p.address, balance: acc.balance, importance: acc.importance, info: p.info } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.balance - a.balance)
      .map((r, i) => ({ rank: i + 1, ...r }));
    if (ranked.length) {
      liveRichList = ranked;
      liveRichListUpdatedAt = Date.now();
    }
  } catch (err) {
    console.error('Live rich list refresh failed:', err.message);
  } finally {
    _refreshingLiveRichList = false;
  }
}

// XEM has no price on the NEM network itself — pull the USDT spot price and
// 24h change straight from KuCoin's public ticker so the navbar can show a
// live "XEM Price" readout like Etherscan/Arbiscan do for ETH.
const KUCOIN_TICKER_URL = 'https://api.kucoin.com/api/v1/market/stats?symbol=XEM-USDT';

async function fetchXemPriceFromKucoin() {
  const res = await fetch(KUCOIN_TICKER_URL);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const json = await res.json();
  const data = json.data;
  if (!data || data.last == null || data.changeRate == null) throw new Error('no ticker data');
  return { price: parseFloat(data.last), changeRate: parseFloat(data.changeRate) };
}

let _refreshingPrice = false;
async function refreshPriceCache() {
  if (_refreshingPrice) return;
  _refreshingPrice = true;
  try {
    const { price, changeRate } = await fetchXemPriceFromKucoin();
    setCacheMeta('xem_price', price);
    setCacheMeta('xem_change_rate', changeRate);
  } catch (err) {
    console.error('XEM price refresh failed:', err.message);
  } finally {
    _refreshingPrice = false;
  }
}

async function getTxsFromBlocks(fromHeight, limit = 25) {
  const items = [];
  let h = fromHeight;

  while (items.length < limit && h >= 1) {
    const batchSize = Math.min(5, h);
    const heights = Array.from({ length: batchSize }, (_, i) => h - i);
    const blocks = await Promise.all(heights.map(bh => getBlock(bh).catch(() => null)));

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block && Array.isArray(block.transactions)) {
        for (const tx of block.transactions) {
          items.push({ tx, height: heights[i], blockTime: block.timeStamp });
        }
      }
      if (items.length >= limit) break;
    }
    h -= batchSize;

    // Safety: if we've scanned many empty blocks, stop
    if (items.length === 0 && fromHeight - h > 200) break;
  }

  return { items, nextFromBlock: h };
}

function truncKey(k) { return k ? `${k.slice(0, 8)}…${k.slice(-4)}` : '—'; }
function truncHash(h) { return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—'; }

const _addrCache = new Map();
const _B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function _b32(buf) {
  let out = '', bits = 0, val = 0;
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += _B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += _B32[(val << (5 - bits)) & 31];
  return out;
}
function pubKeyToAddress(hex, net = 0x68) {
  if (!hex) return null;
  if (_addrCache.has(hex)) return _addrCache.get(hex);
  const s1 = keccak_256(Buffer.from(hex, 'hex'));
  const s2 = ripemd160(s1);
  const s3 = new Uint8Array(21); s3[0] = net; s3.set(s2, 1);
  const cs = keccak_256(s3);
  const raw = new Uint8Array(25); raw.set(s3); raw.set(cs.subarray(0, 4), 21);
  const addr = _b32(raw);
  _addrCache.set(hex, addr);
  return addr;
}
function xem(v) {
  if (!v) return '0.00';
  return (v / 1e6).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDiff(d) { return d ? `${(d / 1e12).toFixed(3)}T` : '—'; }
function formatImportance(v) { return v ? (v * 100).toFixed(6) + '%' : '0.000000%'; }
function esc(s) {
  return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'})[c]);
}
function decodeMsg(msg) {
  if (!msg?.payload) return '';
  if (msg.type === 2) return '[Encrypted]';
  try { return esc(Buffer.from(msg.payload, 'hex').toString('utf8')); } catch { return ''; }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.use(express.static('public'));

// Reads the navbar's node-switch cookie and, if it names one of the currently
// cached HTTPS supernodes, makes that node available to nemFetch() for the
// remainder of this request via AsyncLocalStorage. Anything else (missing
// cookie, stale/unknown endpoint) falls through to the default round-robin
// pool — the whitelist check also keeps a forged cookie from turning this
// into an open server-side fetch proxy.
app.use((req, res, next) => {
  const raw = req.headers.cookie || '';
  let selected = null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === 'nemscan-node') {
      selected = decodeURIComponent(part.slice(i + 1).trim());
      break;
    }
  }
  const node = selected ? findNodeOption(selected) : null;
  nodeContext.run(node, () => next());
});
app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  try {
    const height = await getHeight();
    const heights = [height, height-1, height-2, height-3, height-4];
    const blocks = await Promise.all(heights.map(h => getBlock(h)));
    const { items: txsRaw } = await getTxsFromBlocks(height, 5);
    const txs = txsRaw.slice(0, 5);
    const avgBlockSecs = blocks.length > 1
      ? (blocks[0].timeStamp - blocks[blocks.length - 1].timeStamp) / (blocks.length - 1)
      : null;
    res.send(homePageHTML({ height, blocks, txs, avgBlockSecs }));
  } catch (err) {
    res.status(503).send(homePageHTML({ error: err.message }));
  }
});

// Navbar search box: routes a query straight to the matching detail page.
// Block height and address both resolve reliably against the existing detail
// pages. A 64-char hex string is routed to the transaction-detail page too —
// note that NIS1 public nodes only retain hash lookups for very recent /
// unconfirmed transactions, so older hashes typed here may show "not found"
// unless reached via an in-app link that already knows the tx's block.
const NEM_ADDRESS_RE = /^[A-Z2-7]{40}$/;
const NEM_HASH_RE = /^[0-9a-f]{64}$/i;
const NAMESPACE_FQN_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

app.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (/^\d+$/.test(q)) return res.redirect(`/block/${q}`);
  const addr = q.replace(/[\s-]/g, '').toUpperCase();
  if (NEM_ADDRESS_RE.test(addr)) return res.redirect(`/account/${addr}`);
  if (NEM_HASH_RE.test(q)) return res.redirect(`/tx/${q.toLowerCase()}`);
  res.redirect('/blocks');
});

// Blocks list
app.get('/blocks', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(shell('Blocks - NEMSCAN', heroBlocks(), 'blocks-card',
    '/api/blocks?page=1&limit=25',
    `<div class="loading"><div class="spinner"></div><span>Fetching latest blocks…</span></div>`));
});

app.get('/api/blocks', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit)) ? parseInt(req.query.limit) : 25;
  try {
    const height = await getHeight();
    const startH = height - (page - 1) * limit;
    const endH = Math.max(1, startH - limit + 1);
    const heights = [];
    for (let h = startH; h >= endH; h--) heights.push(h);
    const blocks = await Promise.all(heights.map(h => getBlock(h)));
    res.setHeader('Content-Type', 'text/html');
    res.send(blocksTableHTML(blocks, page, Math.ceil(height / limit), limit, height));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, `/api/blocks?page=1&limit=25`, '#blocks-card'));
  }
});

// Block detail
app.get('/block/:height', (req, res) => {
  const height = parseInt(req.params.height);
  if (isNaN(height) || height < 1) return res.status(400).send('Invalid height');
  res.setHeader('Content-Type', 'text/html');
  res.send(shell(`Block #${height} - NEMSCAN`, heroBlock(height), 'block-detail',
    `/api/block/${height}`,
    `<div class="loading"><div class="spinner"></div><span>Loading block #${height}…</span></div>`));
});

app.get('/api/block/:height', async (req, res) => {
  const height = parseInt(req.params.height);
  try {
    const [block, chainHeight] = await Promise.all([getBlock(height), getHeight()]);
    res.setHeader('Content-Type', 'text/html');
    res.send(blockDetailHTML(block, chainHeight));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, `/api/block/${height}`, '#block-detail'));
  }
});

// Transaction detail
app.get('/tx/:hash', (req, res) => {
  const hash = (req.params.hash || '').trim().toLowerCase();
  if (!NEM_HASH_RE.test(hash)) return res.status(400).send('Invalid transaction hash');
  const qs = new URLSearchParams();
  if (req.query.height) qs.set('height', req.query.height);
  if (req.query.ts) qs.set('ts', req.query.ts);
  const apiUrl = `/api/tx/${hash}${qs.toString() ? '?' + qs.toString() : ''}`;
  res.setHeader('Content-Type', 'text/html');
  res.send(shell(`Transaction ${truncHash(hash)} - NEMSCAN`, heroTx(hash), 'tx-detail', apiUrl,
    `<div class="loading"><div class="spinner"></div><span>Loading transaction…</span></div>`, '/txs'));
});

app.get('/api/tx/:hash', async (req, res) => {
  const hash = (req.params.hash || '').trim().toLowerCase();
  const heightHint = parseInt(req.query.height);
  const tsHint = parseInt(req.query.ts);
  try {
    let tx = null, height = null;
    // Direct hash lookup only succeeds for very recent / unconfirmed transactions —
    // public NIS1 nodes don't retain a historical hash → transaction index.
    try {
      const direct = await nemFetch(`/transaction/get?hash=${encodeURIComponent(hash)}`);
      if (direct?.transaction) { tx = direct.transaction; height = direct.height || heightHint || null; }
    } catch {}
    // Fallback for links generated within this app: we already know which block
    // the tx lives in, so locate it there by matching its (effectively unique) timestamp.
    if (!tx && heightHint > 0) {
      const block = await getBlock(heightHint);
      const txns = Array.isArray(block.transactions) ? block.transactions : [];
      tx = txns.find(t => t.timeStamp === tsHint) || (txns.length === 1 ? txns[0] : null);
      if (tx) height = heightHint;
    }
    if (!tx) {
      res.setHeader('Content-Type', 'text/html');
      return res.send(txNotFoundHTML(hash));
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(txDetailHTML(tx, hash, height));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, `/api/tx/${hash}`, '#tx-detail'));
  }
});

// Account detail
app.get('/account/:address', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(accountShell(req.params.address));
});

app.get('/api/account/:address', async (req, res) => {
  const { address } = req.params;
  try {
    const data = await getAccount(address);
    if (data.code || !data.account) {
      return res.status(404).setHeader('Content-Type', 'text/html').send(`
        <div class="error-state">
          <div class="error-icon">⚠</div>
          <p class="error-title">Account not found</p>
          <p class="error-msg">${esc(data.message || address)}</p>
        </div>`);
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(accountOverviewHTML(data, address));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, `/api/account/${address}`, '#acct-overview'));
  }
});

app.get('/api/account/:address/txs', async (req, res) => {
  const { address } = req.params;
  try {
    const data = await getAccountTxs(address);
    res.setHeader('Content-Type', 'text/html');
    res.send(txTableHTML(data.data || [], address));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, `/api/account/${address}/txs`, '#tab-content'));
  }
});

app.get('/api/account/:address/txs/more', async (req, res) => {
  const { address } = req.params;
  const { id } = req.query;
  try {
    const data = await getAccountTxs(address, id);
    res.setHeader('Content-Type', 'text/html');
    res.send(txMoreRows(data.data || [], address));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send('');
  }
});

app.get('/api/account/:address/harvests', async (req, res) => {
  const { address } = req.params;
  try {
    const data = await getAccountHarvests(address);
    res.setHeader('Content-Type', 'text/html');
    res.send(harvestsHTML(data.data || []));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, `/api/account/${address}/harvests`, '#tab-content'));
  }
});

app.get('/api/account/:address/mosaics', async (req, res) => {
  const { address } = req.params;
  try {
    const data = await getAccountMosaics(address);
    res.setHeader('Content-Type', 'text/html');
    res.send(mosaicsHTML(data.data || []));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, `/api/account/${address}/mosaics`, '#tab-content'));
  }
});

app.get('/api/account/:address/namespaces', async (req, res) => {
  const { address } = req.params;
  try {
    const data = await getAccountNamespaces(address);
    res.setHeader('Content-Type', 'text/html');
    res.send(namespacesHTML(data.data || []));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, `/api/account/${address}/namespaces`, '#tab-content'));
  }
});

// Transactions list
app.get('/txs', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(shell('Transactions - NEMSCAN', heroTxs(), 'txs-card',
    '/api/txs',
    `<div class="loading"><div class="spinner"></div><span>Fetching latest transactions…</span></div>`,
    '/txs'));
});

app.get('/api/txs', async (req, res) => {
  try {
    const height = await getHeight();
    const fromHeight = parseInt(req.query.fromBlock) || height;
    const { items, nextFromBlock } = await getTxsFromBlocks(fromHeight);
    res.setHeader('Content-Type', 'text/html');
    res.send(globalTxTableHTML(items, height, nextFromBlock));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, '/api/txs', '#txs-card'));
  }
});

app.get('/api/txs/more', async (req, res) => {
  const fromBlock = parseInt(req.query.fromBlock) || 1;
  try {
    const { items, nextFromBlock } = await getTxsFromBlocks(fromBlock);
    res.setHeader('Content-Type', 'text/html');
    res.send(globalTxMoreRows(items, nextFromBlock));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send('');
  }
});

// Namespaces list
app.get('/namespaces', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(shell('Namespaces - NEMSCAN', heroNamespaces(), 'namespaces-card',
    '/api/namespaces',
    `<div class="loading"><div class="spinner"></div><span>Fetching namespaces…</span></div>`,
    '/namespaces'));
});

app.get('/api/namespaces', async (req, res) => {
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit)) ? parseInt(req.query.limit) : 25;
  try {
    let items = getCachedNamespaces(25);
    if (!items.length) {
      // First run — cache is empty, populate it before responding once.
      await refreshNamespacesCache();
      items = getCachedNamespaces(25);
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(namespacesListHTML(getNamespacesWithArchive(limit), getCacheMeta('namespaces_updated_at'), limit));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, '/api/namespaces', '#namespaces-card'));
  }
});

app.get('/api/namespaces/more', async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit)) ? parseInt(req.query.limit) : 25;
  try {
    const items = getNamespacesWithArchive(limit, offset);
    const total = getNamespacesWithArchiveCount();
    res.setHeader('Content-Type', 'text/html');
    res.send(namespaceMoreRows(items, offset, total, limit));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send('');
  }
});

// Namespace detail
app.get('/namespace/:fqn', (req, res) => {
  const fqn = decodeURIComponent(req.params.fqn || '').trim().toLowerCase();
  if (!NAMESPACE_FQN_RE.test(fqn)) return res.status(400).send('Invalid namespace');
  res.setHeader('Content-Type', 'text/html');
  res.send(shell(`Namespace ${fqn} - NEMSCAN`, heroNamespace(fqn), 'namespace-detail',
    `/api/namespace/${encodeURIComponent(fqn)}`,
    `<div class="loading"><div class="spinner"></div><span>Loading namespace…</span></div>`,
    '/namespaces'));
});

app.get('/api/namespace/:fqn', async (req, res) => {
  const fqn = decodeURIComponent(req.params.fqn || '').trim().toLowerCase();
  res.setHeader('Content-Type', 'text/html');
  try {
    const root = fqn.split('.')[0];
    let subNamespaces = [];
    try {
      subNamespaces = await fetchSubNamespaces(root);
    } catch { /* nemtool unreachable — fall back to local lookup only */ }
    const ns = fqn === root ? getNamespaceByFqn(fqn) : (subNamespaces.find(s => s.fqn === fqn) || null);
    if (!ns) return res.send(namespaceNotFoundHTML(fqn));
    const mosaics = getMosaicsByNamespace(fqn);
    res.send(namespaceDetailHTML(ns, root, subNamespaces.filter(s => s.fqn !== fqn), mosaics));
  } catch (err) {
    res.status(503).send(errorFrag(err.message, `/api/namespace/${encodeURIComponent(fqn)}`, '#namespace-detail'));
  }
});

// Mosaics list
app.get('/mosaics', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(shell('Mosaics - NEMSCAN', heroMosaics(), 'mosaics-card',
    '/api/mosaics',
    `<div class="loading"><div class="spinner"></div><span>Fetching mosaics…</span></div>`,
    '/mosaics'));
});

app.get('/api/mosaics', async (req, res) => {
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit)) ? parseInt(req.query.limit) : 25;
  try {
    let items = getCachedMosaics(25);
    if (!items.length) {
      // First run — cache is empty, populate it before responding once.
      await refreshMosaicsCache();
      items = getCachedMosaics(25);
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(mosaicsListHTML(getMosaicsWithArchive(limit), getCacheMeta('mosaics_updated_at'), limit));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, '/api/mosaics', '#mosaics-card'));
  }
});

app.get('/api/mosaics/more', async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit)) ? parseInt(req.query.limit) : 25;
  try {
    const items = getMosaicsWithArchive(limit, offset);
    const total = getMosaicsWithArchiveCount();
    res.setHeader('Content-Type', 'text/html');
    res.send(mosaicMoreRows(items, offset, total, limit));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send('');
  }
});

// Mosaic detail
app.get(/^\/mosaic\/(.+)$/, (req, res) => {
  const rawPath = req.params[0] || '';
  const parts = rawPath.split('/').filter(Boolean);
  if (parts.length < 2) return res.status(400).send('Invalid mosaic path');
  const name = parts[parts.length - 1];
  const namespace = parts.slice(0, -1).join('.');
  const title = `${namespace}:${name}`;
  res.setHeader('Content-Type', 'text/html');
  res.send(shell(`Mosaic ${title} - NEMSCAN`, heroMosaic(namespace, name), 'mosaic-detail',
    `/api/mosaic/${rawPath}`,
    `<div class="loading"><div class="spinner"></div><span>Loading mosaic…</span></div>`,
    '/mosaics'));
});

app.get(/^\/api\/mosaic\/(.+)$/, async (req, res) => {
  const rawPath = req.params[0] || '';
  const parts = rawPath.split('/').filter(Boolean);
  if (parts.length < 2) return res.status(400).send('Invalid mosaic path');
  const name = parts[parts.length - 1];
  const namespace = parts.slice(0, -1).join('.');
  res.setHeader('Content-Type', 'text/html');
  try {
    let m = getMosaicByNsAndName(namespace, name);
    let liveData = null;
    try {
      const data = await fetchMosaicsForNamespace(namespace);
      const found = (data.data || []).find(d => d.mosaic.id.name === name);
      if (found) {
        liveData = found.mosaic;
        if (!m) {
          const props = Object.fromEntries((liveData.properties || []).map(p => [p.name, p.value]));
          m = {
            namespace,
            name,
            creator: liveData.creator,
            description: liveData.description || '',
            divisibility: parseInt(props.divisibility) || 0,
            supply: parseInt(props.initialSupply) || 0,
            transferable: props.transferable !== 'false' ? 1 : 0,
          };
        }
      }
    } catch { /* live API unavailable, use DB only */ }
    if (!m) return res.send(mosaicNotFoundHTML(namespace, name));
    res.send(mosaicDetailHTML(m, liveData));
  } catch (err) {
    res.status(503).send(errorFrag(err.message, `/api/mosaic/${rawPath}`, '#mosaic-detail'));
  }
});

// Polls — unlike namespaces/mosaics, "polls" are not a NIS1 protocol concept;
// there's no on-chain data source for them at all. We mirror nemtool's own
// off-chain poll index locally (see importPollArchive) and serve it from there.
app.get('/polls', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(shell('Polls - NEMSCAN', heroPolls(), 'polls-card',
    '/api/polls',
    `<div class="loading"><div class="spinner"></div><span>Loading…</span></div>`,
    '/polls'));
});

app.get('/api/polls', async (req, res) => {
  try {
    const items = getCachedPolls(25);
    res.setHeader('Content-Type', 'text/html');
    res.send(pollsListHTML(items, getCachedPollsCount()));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, '/api/polls', '#polls-card'));
  }
});

app.get('/api/polls/more', (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  try {
    const items = getCachedPolls(25, offset);
    const total = getCachedPollsCount();
    res.setHeader('Content-Type', 'text/html');
    res.send(pollMoreRows(items, offset, total));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send('');
  }
});

// Supernodes — sourced from the NEM SuperNode Program's own API, not NIS1.
app.get('/nodes', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(shell('Supernodes - NEMSCAN', heroNodes(), 'nodes-card',
    '/api/nodes',
    `<div class="loading"><div class="spinner"></div><span>Fetching active supernodes…</span></div>`,
    '/nodes'));
});

app.get('/api/nodes', async (req, res) => {
  try {
    const nodes = await getActiveSupernodes();
    res.setHeader('Content-Type', 'text/html');
    res.send(nodesListHTML(nodes));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, '/api/nodes', '#nodes-card'));
  }
});

// Accounts (rich list)
app.get('/accounts', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(shell('Accounts - NEMSCAN', heroAccounts(), 'accounts-card',
    '/api/accounts',
    `<div class="loading"><div class="spinner"></div><span>Fetching rich list…</span></div>`,
    '/accounts'));
});

app.get('/api/accounts', async (req, res) => {
  try {
    if (!liveRichList.length) {
      // First run — live ranking is empty, build it before responding once.
      await refreshLiveRichList();
    }
    const items = liveRichList.slice(0, 25);
    res.setHeader('Content-Type', 'text/html');
    res.send(accountsListHTML(items, liveRichListUpdatedAt, liveRichList.length));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send(errorFrag(err.message, '/api/accounts', '#accounts-card'));
  }
});

app.get('/api/accounts/more', async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  try {
    const items = liveRichList.slice(offset, offset + 25);
    res.setHeader('Content-Type', 'text/html');
    res.send(accountMoreRows(items, offset, liveRichList.length));
  } catch (err) {
    res.status(503).setHeader('Content-Type', 'text/html');
    res.send('');
  }
});

// Keep the namespace, mosaic, rich-list and price caches warm: populate on
// boot, then refresh periodically in the background so page requests never
// have to wait on the slow NIS queries / large source pages. Mosaics are
// derived from cached namespaces, so its first run waits on that cache.
// The candidate-address pool changes rarely, so it's rebuilt only a few times
// a day; the live rich-list re-queries each candidate's *current* balance from
// the chain, so it refreshes much more often to stay accurate.
setTimeout(() => {
  refreshNamespacesCache().then(refreshMosaicsCache);
  importNamespaceArchive();
  importMosaicArchive();
  importPollArchive();
  refreshRichListCache().then(refreshLiveRichList);
  refreshPriceCache();
  refreshHttpsNodeOptions();
  setInterval(refreshNamespacesCache, 10 * 60 * 1000);
  setInterval(refreshMosaicsCache, 10 * 60 * 1000);
  setInterval(refreshRichListCache, 6 * 60 * 60 * 1000);
  setInterval(refreshLiveRichList, 5 * 60 * 1000);
  setInterval(refreshPriceCache, 60 * 1000);
  setInterval(refreshHttpsNodeOptions, 5 * 60 * 1000);
  // Deep mosaic refresh: first run 2 minutes after startup to avoid congestion,
  // then every 6 hours. Covers all known namespaces and refreshes current supply.
  setTimeout(refreshAllMosaicsDeep, 2 * 60 * 1000);
  setInterval(refreshAllMosaicsDeep, 6 * 60 * 60 * 1000);
}, 3000);

app.listen(PORT, '0.0.0.0', () => console.log(`NEMSCAN → http://localhost:${PORT}/`));

// ── Shared fragments ──────────────────────────────────────────────────────────

function errorFrag(msg, retryUrl, retryTarget) {
  return `<div class="error-state">
    <div class="error-icon">⚠</div>
    <p class="error-title">Unable to reach NEM network</p>
    <p class="error-msg">${esc(msg)}</p>
    <button class="retry-btn" hx-get="${retryUrl}" hx-target="${retryTarget}" hx-swap="innerHTML">Retry</button>
  </div>`;
}

// Sub-cent prices need more decimals to stay meaningful than the 2 places
// Etherscan/Arbiscan use for ETH — pick precision based on magnitude.
function formatUsdPrice(price) {
  if (price >= 1) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

function xemPriceHTML() {
  const priceRaw = getCacheMeta('xem_price');
  const changeRaw = getCacheMeta('xem_change_rate');
  if (priceRaw == null || changeRaw == null) return '';
  const price = parseFloat(priceRaw);
  const changePct = parseFloat(changeRaw) * 100;
  const up = changePct >= 0;
  const sign = up ? '+' : '';
  return `<div class="xem-price">XEM Price: <strong>$${formatUsdPrice(price)}</strong> <span class="${up ? 'price-up' : 'price-down'}">(${sign}${changePct.toFixed(2)}%)</span></div>`;
}

function nodeSwitchHTML() {
  const active = nodeContext.getStore();
  const activeEndpoint = active ? active.endpoint : '';
  const activeLabel = active ? active.name : 'Auto';
  const isActive = ep => ep === activeEndpoint ? ' active' : '';
  const items = [...httpsNodeOptions].sort((a, b) => a.name.localeCompare(b.name)).map(n => `
        <button type="button" class="node-menu-item${isActive(n.endpoint)}" data-node-endpoint="${esc(n.endpoint)}" data-node-name="${esc(n.name)}" role="menuitem" onclick="selectNode(this)">
          <span class="node-menu-dot"></span>
          <span class="node-menu-text"><span class="node-menu-name">${esc(n.name)}</span><span class="node-menu-sub">${esc(n.host)}</span></span>
        </button>`).join('');
  return `<div class="node-switch">
      <button type="button" class="node-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleNodeMenu(event)" title="Connection node">
        <span class="node-switch-dot is-live"></span>
        <span class="node-switch-label">${esc(activeLabel)}</span>
        <span class="node-switch-caret">&#9662;</span>
      </button>
      <div class="node-menu" role="menu" aria-label="Connection node">
        <div class="node-menu-head">Connect via <span class="node-menu-note">active HTTPS supernodes</span></div>
        <button type="button" class="node-menu-item${isActive('')}" data-node-endpoint="" data-node-name="Auto" role="menuitem" onclick="selectNode(this)">
          <span class="node-menu-dot"></span>
          <span class="node-menu-text"><span class="node-menu-name">Auto</span><span class="node-menu-sub">round-robin node pool</span></span>
        </button>
        <div class="node-menu-sep"></div>
        ${items || `<div class="node-menu-empty">${httpsNodeOptionsUpdatedAt ? 'No HTTPS-reachable supernodes right now' : 'Probing active supernodes for HTTPS…'}</div>`}
      </div>
    </div>`;
}

// Shared markup for the navbar's price/search/node/theme controls — rendered
// once into the wide-screen topbar and again inside the narrow-screen burger
// menu (CSS shows exactly one copy at a time, so dropdown JS keyed off
// btn.parentElement still resolves to the right sibling menu in both copies).
function navToolsHTML(showSearch = true) {
  return `${xemPriceHTML()}
    ${showSearch ? `<form class="nav-search" action="/search" method="get" role="search">
      <input type="text" name="q" placeholder="Search by Address / Block Height / Tx Hash" autocomplete="off" spellcheck="false">
      <button type="submit" aria-label="Search">&#128269;</button>
    </form>` : '<div style="flex:1 1 auto"></div>'}
    ${nodeSwitchHTML()}
    <div class="theme-switch">
      <button type="button" class="theme-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleThemeMenu(event)" title="Theme">
        <span class="theme-switch-icon" data-theme-icon>&#9728;</span>
        <span class="theme-switch-caret">&#9662;</span>
      </button>
      <div class="theme-menu" role="menu" aria-label="Theme">
        <button type="button" class="theme-menu-item" data-theme-choice="light" role="menuitem" title="Light" aria-label="Light" onclick="setTheme('light')"><span class="theme-menu-icon">&#9728;</span></button>
        <button type="button" class="theme-menu-item" data-theme-choice="dim" role="menuitem" title="Dim" aria-label="Dim" onclick="setTheme('dim')"><span class="theme-menu-icon">&#9680;</span></button>
        <button type="button" class="theme-menu-item" data-theme-choice="dark" role="menuitem" title="Dark" aria-label="Dark" onclick="setTheme('dark')"><span class="theme-menu-icon">&#9790;</span></button>
      </div>
    </div>`;
}

function navHTML(activeHref, hideSearch = false) {
  const links = [['/blocks','Blocks'],['/txs','Transactions'],['/accounts','Accounts'],['/namespaces','Namespaces'],['/mosaics','Mosaics'],['/nodes','Nodes'],['/polls','Polls']];
  return `<div class="topbar"><div class="topbar-inner">
    ${navToolsHTML(!hideSearch)}
  </div></div>
  <nav class="topnav"><div class="topnav-inner">
    <a href="/" class="logo">
      <img src="/nem_logo.png" width="32" height="32" alt="NEM" style="display:block;">
      NEMSCAN
    </a>
    <button type="button" class="nav-burger" aria-haspopup="true" aria-expanded="false" aria-label="Menu" onclick="toggleNavMenu(event)">
      <span class="nav-burger-bar"></span>
      <span class="nav-burger-bar"></span>
      <span class="nav-burger-bar"></span>
    </button>
    <div class="nav-menu">
      <ul class="nav-links">
        ${links.map(([h,l]) => `<li><a href="${h}"${h===activeHref?' class="active"':''}>${l}</a></li>`).join('')}
      </ul>
      <div class="nav-menu-tools">
        ${navToolsHTML(!hideSearch)}
      </div>
    </div>
  </div></nav>`;
}

function footerHTML() {
  const githubIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`;
  const discordIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.076.076 0 0 0-.04.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`;
  const xIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;
  const heartIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/></svg>`;
  return `<footer class="site-footer"><div class="site-footer-inner">
    <div class="footer-links">
      <a href="https://github.com/NemProject" target="_blank" rel="noopener">${githubIcon}GitHub</a>
      <a href="https://discord.gg/NMA9YQ55td" target="_blank" rel="noopener">${discordIcon}Discord</a>
      <a href="https://x.com/NEMofficial" target="_blank" rel="noopener">${xIcon}X (Twitter)</a>
    </div>
    <div class="footer-bottom">
      <div class="footer-copy">© NEM Community 2026</div>
      <a class="footer-donate" href="/account/NAYLN6AV23T63J3HDC2BTMJFS5WMFXYYZDOIWI5W" rel="noopener">Donations ${heartIcon}</a>
    </div>
  </div></footer>`;
}

// Sets data-theme on <html> before first paint (avoids a flash of the wrong theme)
// and exposes setTheme()/toggleThemeMenu() globally for the navbar's theme dropdown.
function themeInitScript() {
  return `<script>
(function() {
  var KEY = 'nemscan-theme';
  var THEMES = ['light','dim','dark'];
  var ICONS = { light: '&#9728;', dim: '&#9680;', dark: '&#9790;' };
  function sync(theme) {
    document.querySelectorAll('.theme-menu-item').forEach(function(b) {
      b.classList.toggle('active', b.dataset.themeChoice === theme);
    });
    document.querySelectorAll('[data-theme-icon]').forEach(function(el) { el.innerHTML = ICONS[theme]; });
  }
  // keepRoot: when closing menus to open a sub-menu that lives inside the
  // mobile burger panel (e.g. theme/node switch nested in .nav-menu), pass
  // its .topnav-inner so the panel itself and its burger stay open/expanded.
  function closeMenus(keepRoot) {
    document.querySelectorAll('.theme-menu.open, .node-menu.open, .rows-menu.open, .nav-menu.open').forEach(function(m) {
      if (keepRoot && m.classList.contains('nav-menu') && keepRoot.contains(m)) return;
      m.classList.remove('open');
    });
    document.querySelectorAll('.theme-switch-btn, .node-switch-btn, .rows-switch-btn, .nav-burger').forEach(function(b) {
      if (keepRoot && b.classList.contains('nav-burger') && keepRoot.contains(b)) return;
      b.setAttribute('aria-expanded', 'false');
    });
  }
  var theme;
  try { theme = localStorage.getItem(KEY); } catch (e) {}
  if (THEMES.indexOf(theme) === -1) theme = 'light';
  document.documentElement.setAttribute('data-theme', theme);
  window.setTheme = function(t) {
    if (THEMES.indexOf(t) === -1) return;
    try { localStorage.setItem(KEY, t); } catch (e) {}
    document.documentElement.setAttribute('data-theme', t);
    sync(t);
    closeMenus();
  };
  window.toggleThemeMenu = function(ev) {
    ev.stopPropagation();
    var btn = ev.currentTarget;
    var menu = btn.parentElement.querySelector('.theme-menu');
    var willOpen = !menu.classList.contains('open');
    closeMenus(btn.closest('.topnav-inner'));
    if (willOpen) {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  };
  var NODE_KEY = 'nemscan-node';
  window.toggleNodeMenu = function(ev) {
    ev.stopPropagation();
    var btn = ev.currentTarget;
    var menu = btn.parentElement.querySelector('.node-menu');
    var willOpen = !menu.classList.contains('open');
    closeMenus(btn.closest('.topnav-inner'));
    if (willOpen) {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  };
  window.toggleNavMenu = function(ev) {
    ev.stopPropagation();
    var btn = ev.currentTarget;
    var menu = document.querySelector('.nav-menu');
    var willOpen = !menu.classList.contains('open');
    closeMenus();
    if (willOpen) {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  };
  window.toggleRowsMenu = function(ev) {
    ev.stopPropagation();
    var btn = ev.currentTarget;
    var menu = btn.parentElement.querySelector('.rows-menu');
    var willOpen = !menu.classList.contains('open');
    closeMenus();
    if (willOpen) {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  };
  // The picker only ever offers endpoints the server already validated against
  // its live HTTPS-supernode cache, so we just hand the choice back as a cookie
  // and reload — nemFetch() on the server then prefers that node for this browser.
  window.selectNode = function(btn) {
    var endpoint = btn.dataset.nodeEndpoint || '';
    try {
      if (endpoint) document.cookie = NODE_KEY + '=' + encodeURIComponent(endpoint) + ';path=/;max-age=2592000;samesite=lax';
      else document.cookie = NODE_KEY + '=;path=/;max-age=0;samesite=lax';
    } catch (e) {}
    closeMenus();
    location.reload();
  };
  document.addEventListener('click', closeMenus);
  document.addEventListener('DOMContentLoaded', function() { sync(theme); });
})();
</script>`;
}

function heroBlocks() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Blocks</h1>
  </div></div>`;
}

function heroBlock(height) {
  return `<div class="hero"><div class="hero-inner">
    <div class="hero-row">
      <h1>Block <span class="hero-hl">${height}</span></h1>
      <div class="blk-nav">
        ${height > 1 ? `<a class="blk-nav-btn" href="/block/${height-1}">&#8249;</a>` : `<span class="blk-nav-btn disabled">&#8249;</span>`}
        <a class="blk-nav-btn" href="/block/${height+1}">&#8250;</a>
      </div>
    </div>
  </div></div>`;
}

function heroTxs() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Transactions</h1>
  </div></div>`;
}

function heroTx(hash) {
  return `<div class="hero"><div class="hero-inner">
    <h1 style="margin-bottom:10px;">Transaction Detail</h1>
    <div class="acct-addr-row">
      <span class="acct-addr-icon">#</span>
      <code class="acct-addr-text">${hash}</code>
      <button class="copy-btn-hero" onclick="copy('${hash}')">copy</button>
    </div>
  </div></div>`;
}

function heroNamespaces() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Namespaces</h1>
  </div></div>`;
}

function heroNamespace(fqn) {
  return `<div class="hero"><div class="hero-inner">
    <h1 style="margin-bottom:10px;">Namespace Detail</h1>
    <div class="acct-addr-row">
      <span class="acct-addr-icon">#</span>
      <code class="acct-addr-text">${esc(fqn)}</code>
      <button class="copy-btn-hero" onclick="copy('${esc(fqn)}')">copy</button>
    </div>
  </div></div>`;
}

function heroMosaics() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Mosaics</h1>
  </div></div>`;
}

function heroMosaic(namespace, name) {
  const id = `${esc(namespace)}:<strong>${esc(name)}</strong>`;
  return `<div class="hero"><div class="hero-inner">
    <h1 style="margin-bottom:10px;">Mosaic Detail</h1>
    <div class="acct-addr-row">
      <code class="acct-addr-text">${id}</code>
      <button class="copy-btn-hero" onclick="copy('${esc(namespace+':'+name)}')">copy</button>
    </div>
  </div></div>`;
}

function heroPolls() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Polls</h1>
  </div></div>`;
}

function heroAccounts() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Rich List</h1>
  </div></div>`;
}

function heroNodes() {
  return `<div class="hero"><div class="hero-inner">
    <div class="hero-row hero-row-between">
      <h1>Supernodes</h1>
      <a class="hero-link" href="https://nem.io/supernode/" target="_blank" rel="noopener">nem.io/supernode &#8599;</a>
    </div>
  </div></div>`;
}

function renderPollRow(p, num) {
  const expired = Date.now() > p.doe;
  const typeName = p.type === 1 ? 'White List' : 'POI';
  const expires = new Date(p.doe).toISOString().slice(0, 10);
  return `<tr>
    <td class="td-num">${num}</td>
    <td><a href="https://explorer.nemtool.com/#/poll?id=${esc(p.id)}" class="mono-link" target="_blank" rel="noopener" title="${esc(p.title)}">${esc(p.title)}</a></td>
    <td>${typeName}</td>
    <td><a href="/account/${p.address}" class="mono-link" title="${p.address}">${truncKey(p.address)}</a></td>
    <td>${expired ? '<span class="status-expired">● Expired</span>' : '<span class="status-ok">● Active</span>'}</td>
    <td class="mono-muted">${expires}</td>
  </tr>`;
}

function pollLoadMoreRow(offset, total) {
  if (offset >= total) return '';
  return `<tr id="poll-load-more-row"><td colspan="6" class="load-more-cell">
    <button class="load-more-btn" hx-get="/api/polls/more?offset=${offset}" hx-target="#poll-load-more-row" hx-swap="outerHTML">Load More</button>
  </td></tr>`;
}

function pollMoreRows(items, offset, total) {
  if (!items.length) return '';
  return items.map((p, i) => renderPollRow(p, offset + i + 1)).join('') + pollLoadMoreRow(offset + items.length, total);
}

function pollsListHTML(items, total) {
  if (!items.length) return `<div class="empty-state">No polls found</div>`;
  return `
  <div class="card-head">
    <div class="card-title">Community Polls</div>
    <span class="total-txt"><strong>${total}</strong> polls</span>
  </div>
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>Polls aren't a NEM (NIS1) protocol feature — there's no on-chain data source for them. This list mirrors <a href="https://explorer.nemtool.com/" target="_blank" rel="noopener">explorer.nemtool.com</a>'s own off-chain voting index (${total.toLocaleString('en')} records) and may not reflect newly created or recently updated polls.</p>
  <div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Title</th><th>Type</th><th>Created By</th><th>Status</th><th>Expires</th></tr></thead>
    <tbody>${items.map((p, i) => renderPollRow(p, i + 1)).join('')}${pollLoadMoreRow(items.length, total)}</tbody>
  </table></div>`;
}

// ── Home page ─────────────────────────────────────────────────────────────────

function homeHeroHTML() {
  return `<div class="home-hero"><div class="home-hero-inner">
    <p class="home-tagline">NEM (XEM) Blockchain Explorer</p>
    <form class="home-search" action="/search" method="get" role="search">
      <input type="text" name="q" placeholder="Search by Address / Block Height / Tx Hash" autocomplete="off" spellcheck="false">
      <button type="submit" aria-label="Search">&#128269;</button>
    </form>
  </div></div>`;
}

function homeStatsHTML(height, avgBlockSecs) {
  const priceRaw = getCacheMeta('xem_price');
  const changeRaw = getCacheMeta('xem_change_rate');
  let priceVal = '—';
  if (priceRaw != null && changeRaw != null) {
    const price = parseFloat(priceRaw);
    const changePct = parseFloat(changeRaw) * 100;
    const up = changePct >= 0;
    priceVal = `$${formatUsdPrice(price)} <span class="${up ? 'price-up' : 'price-down'}">(${up ? '+' : ''}${changePct.toFixed(2)}%)</span>`;
  }
  const stats = [
    ['XEM PRICE', priceVal],
    ['LATEST BLOCK', `<a href="/block/${height}" class="hero-hl">${height}</a>`],
    ['AVG BLOCK TIME', avgBlockSecs != null ? `${avgBlockSecs.toFixed(1)}s` : '—'],
    ['NETWORK', 'NEM Mainnet'],
  ];
  return `<div class="home-stats">${stats.map(([label, val]) => `
    <div class="home-stat"><div class="home-stat-label">${label}</div><div class="home-stat-val">${val}</div></div>`).join('')}
  </div>`;
}

function homeBlocksPanelHTML(blocks) {
  const rows = blocks.map(b => {
    const date = nemDate(b.timeStamp);
    const signer = pubKeyToAddress(b.signer) ?? b.signer;
    return `<tr>
      <td><a href="/block/${b.height}" class="blk-num">${b.height}</a></td>
      <td><div class="age-rel">${timeAgo(date)}</div></td>
      <td><a href="/account/${signer}" class="harv" title="${signer}">${truncKey(signer)}</a></td>
      <td class="td-right">${(b.transactions || []).length}</td>
    </tr>`;
  }).join('');
  return `<div class="card home-panel">
    <div class="card-head">
      <div class="card-title">Latest Blocks <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Block</th><th>Age</th><th>Harvester</th><th class="th-right">Txns</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="home-panel-foot"><a href="/blocks">View all blocks &rsaquo;</a></div>
  </div>`;
}

function homeTxsPanelHTML(txs) {
  const body = !txs.length
    ? `<div class="empty-state">No transactions found in recent blocks</div>`
    : `<div class="tbl-wrap"><table>
      <thead><tr><th>Sender</th><th class="th-right">Amount</th><th class="th-right">Age</th></tr></thead>
      <tbody>${txs.map(item => {
        const { tx, blockTime } = item;
        const date = nemDate(blockTime);
        const isTransfer = tx.type === 257;
        const senderAddr = pubKeyToAddress(tx.signer) ?? tx.signer;
        const amountCell = isTransfer ? `${xem(tx.amount)} XEM` : `<span class="muted">—</span>`;
        return `<tr>
          <td><a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${truncKey(senderAddr)}</a></td>
          <td class="td-right">${amountCell}</td>
          <td class="td-right"><div class="age-rel">${timeAgo(date)}</div></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  return `<div class="card home-panel">
    <div class="card-head">
      <div class="card-title">Latest Transactions <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    </div>
    ${body}
    <div class="home-panel-foot"><a href="/txs">View all transactions &rsaquo;</a></div>
  </div>`;
}

function homePageHTML({ height, blocks, txs, avgBlockSecs, error }) {
  const main = error
    ? `<div class="error-state"><div class="error-icon">⚠</div><div>${esc(error)}</div></div>`
    : `${homeStatsHTML(height, avgBlockSecs)}
  <div class="home-panels">
    ${homeBlocksPanelHTML(blocks)}
    ${homeTxsPanelHTML(txs)}
  </div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  ${themeInitScript()}
  <title>NEMSCAN - NEM (XEM) Blockchain Explorer</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <style>${sharedCSS()}</style>
</head>
<body>
${navHTML('/', true)}
${homeHeroHTML()}
<div class="container">
  ${main}
</div>
${footerHTML()}
</body></html>`;
}

// ── Page shells ───────────────────────────────────────────────────────────────

function shell(title, heroSection, cardId, apiUrl, placeholder, navActive = '/blocks') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  ${themeInitScript()}
  <title>${title}</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <style>${sharedCSS()}</style>
</head>
<body>
${navHTML(navActive)}
${heroSection}
<div class="container">
  <div class="card" id="${cardId}"
       hx-get="${apiUrl}" hx-trigger="load" hx-target="#${cardId}" hx-swap="innerHTML">
    ${placeholder}
  </div>
</div>
${footerHTML()}
</body></html>`;
}

function accountShell(address) {
  const shortAddr = `${address.slice(0,6)}…${address.slice(-4)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  ${themeInitScript()}
  <title>Account ${shortAddr} - NEMSCAN</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <style>${sharedCSS()}</style>
</head>
<body>
${navHTML('/blocks')}
<div class="hero"><div class="hero-inner">
  <h1 style="margin-bottom:10px;">Account Detail</h1>
  <div class="acct-addr-row">
    <code class="acct-addr-text">${address}</code>
    <button class="copy-btn-hero" onclick="copy('${address}')">copy</button>
  </div>
</div></div>

<div class="container">
  <!-- Overview -->
  <div id="acct-overview"
       hx-get="/api/account/${address}"
       hx-trigger="load" hx-target="#acct-overview" hx-swap="innerHTML">
    <div class="card"><div class="loading"><div class="spinner"></div><span>Loading account…</span></div></div>
  </div>

  <!-- Tabs -->
  <div class="card" style="margin-top:16px;">
    <div class="tab-nav">
      <button class="tab-btn active"
              hx-get="/api/account/${address}/txs"
              hx-target="#tab-content" hx-swap="innerHTML"
              onclick="setTab(this)">Transactions</button>
      <button class="tab-btn"
              hx-get="/api/account/${address}/harvests"
              hx-target="#tab-content" hx-swap="innerHTML"
              onclick="setTab(this)">Harvested Blocks</button>
      <button class="tab-btn"
              hx-get="/api/account/${address}/mosaics"
              hx-target="#tab-content" hx-swap="innerHTML"
              onclick="setTab(this)">Mosaics</button>
      <button class="tab-btn"
              hx-get="/api/account/${address}/namespaces"
              hx-target="#tab-content" hx-swap="innerHTML"
              onclick="setTab(this)">Namespaces</button>
    </div>
    <div id="tab-content"
         hx-get="/api/account/${address}/txs"
         hx-trigger="load" hx-target="#tab-content" hx-swap="innerHTML">
      <div class="loading"><div class="spinner"></div><span>Loading transactions…</span></div>
    </div>
  </div>
</div>
${footerHTML()}

<script>
  function setTab(el) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
  }
  function copy(text) {
    navigator.clipboard.writeText(text).then(() => {
      document.querySelectorAll('.copy-btn,.copy-btn-hero').forEach(b => {
        if (b.getAttribute('onclick')?.includes(text.slice(0,8))) {
          const orig = b.textContent;
          b.textContent = 'copied!';
          setTimeout(() => b.textContent = orig, 1500);
        }
      });
    });
  }
</script>
</body></html>`;
}

// ── Blocks list HTML ──────────────────────────────────────────────────────────

function blocksTableHTML(blocks, page, totalPages, limit, chainHeight) {
  const rows = blocks.map(b => {
    const date = nemDate(b.timeStamp);
    const txns = Array.isArray(b.transactions) ? b.transactions.length : 0;
    return `<tr>
      <td><div class="blk-cell">
        <a href="/block/${b.height}" class="blk-num">${b.height}</a>
      </div></td>
      <td><div class="age-rel">${timeAgo(date)}</div>
          <div class="age-abs">${date.toISOString().slice(0,19).replace('T',' ')} UTC</div></td>
      <td><span class="txn-pill ${txns>0?'txn-pos':'txn-zero'}">${txns}</span></td>
      <td>${(a => `<a href="/account/${a}" class="harv" title="${a}">${truncKey(a)}</a>`)(pubKeyToAddress(b.signer) ?? b.signer)}</td>
      <td class="diff-val">${formatDiff(b.difficulty)}</td>
      <td class="fee-val">${xem(b.totalFee)} XEM</td>
    </tr>`;
  }).join('');

  const htmx = p => `hx-get="/api/blocks?page=${p}&limit=${limit}" hx-target="#blocks-card" hx-swap="innerHTML"`;
  const pBtn = (lbl, p, off) => off ? `<span class="p-btn off">${lbl}</span>` : `<a class="p-btn" ${htmx(p)} href="#">${lbl}</a>`;
  const rItem = n => `<a class="rows-menu-item${n===limit ? ' active' : ''}" hx-get="/api/blocks?page=1&limit=${n}" hx-target="#blocks-card" hx-swap="innerHTML" href="#" role="menuitem">${n}</a>`;
  const rowsCtrl = `
      <div class="rows-ctrl">
        <span class="rows-ctrl-label">Show:</span>
        <div class="rows-switch">
          <button type="button" class="rows-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleRowsMenu(event)" title="Rows per page">
            <span class="rows-switch-label">${limit}</span>
            <span class="rows-switch-caret">&#9662;</span>
          </button>
          <div class="rows-menu" role="menu" aria-label="Rows per page">
            ${[10,25,50,100].map(rItem).join('')}
          </div>
        </div>
      </div>`;

  return `
  <div class="card-head">
    <div class="card-title">Latest Blocks <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    <div class="card-head-right">
      <span class="total-txt">Total of <strong>${chainHeight}</strong> blocks</span>
      ${rowsCtrl}
    </div>
  </div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>Block</th><th>Age</th><th>Txns</th><th>Harvester</th><th>Difficulty</th><th>Fee (XEM)</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <div class="tbl-foot">
    <div class="pag-ctrl">
      <span class="pg-info">Page <strong>${page}</strong> of <strong>${totalPages.toLocaleString()}</strong></span>
      ${pBtn('« First',1,page<=1)} ${pBtn('‹ Prev',page-1,page<=1)}
      ${pBtn('Next ›',page+1,page>=totalPages)} ${pBtn('Last »',totalPages,page>=totalPages)}
    </div>
  </div>`;
}

// ── Block detail HTML ─────────────────────────────────────────────────────────

function blockDetailHTML(block, chainHeight) {
  const date = nemDate(block.timeStamp);
  const txns = Array.isArray(block.transactions) ? block.transactions : [];
  const prevHash = block.prevBlockHash?.data ?? '—';

  const ovRows = [
    ['Block Height',    `<span class="mono">${block.height}</span>`],
    ['Status',          `<span class="status-ok">✓ Confirmed</span>`],
    ['Timestamp',       `${timeAgo(date)} <span class="muted">(${date.toISOString().slice(0,19).replace('T',' ')} UTC)</span>`],
    ['Transactions',    txns.length > 0 ? `<strong>${txns.length}</strong> <span class="muted">transaction${txns.length!==1?'s':''}</span>` : `<span class="muted">None</span>`],
    ['Harvester',       (() => { const a = pubKeyToAddress(block.signer) ?? block.signer; return `<a href="/account/${a}" class="mono-link" title="${a}">${truncKey(a)}</a> <button class="copy-btn" onclick="copy('${a}')">copy</button>`; })()],
    ['Difficulty',      `<span class="mono">${formatDiff(block.difficulty)}</span>`],
    ['Total Fee',       `<span class="fee-val">${xem(block.totalFee)} XEM</span>`],
    ['Block Type',      block.type===1?'Regular':`Type ${block.type}`],
    ['Signature',       `<span class="mono-muted">${truncHash(block.signature)}</span> <button class="copy-btn" onclick="copy('${block.signature}')">copy</button>`],
    ['Prev Block Hash', block.height>1 ? `<a href="/block/${block.height-1}" class="mono-link">${truncHash(prevHash)}</a> <button class="copy-btn" onclick="copy('${prevHash}')">copy</button>` : '<span class="muted">—</span>'],
  ].map(([l,v]) => `<div class="ov-row"><div class="ov-label">${l}</div><div class="ov-value">${v}</div></div>`).join('');

  const txSection = txns.length === 0 ? '' : (() => {
    const txRows = txns.map((tx, i) => {
      const isT = tx.type === 257;
      const senderAddr = pubKeyToAddress(tx.signer) ?? tx.signer;
      const recip = isT ? `<a href="/account/${tx.recipient}" class="mono-link">${truncKey(tx.recipient)}</a>` : '—';
      const amt = isT ? `${xem(tx.amount)} XEM` : '—';
      const msg = decodeMsg(tx.message);
      const d = {
        idx: i+1, type: TX_TYPES[tx.type] || `Type ${tx.type}`,
        sender: senderAddr, recipient: isT ? tx.recipient : '',
        amount: isT ? `${xem(tx.amount)} XEM` : '', fee: `${xem(tx.fee)} XEM`,
        time: `${nemDate(tx.timeStamp).toISOString().slice(0,19).replace('T',' ')} UTC`,
        message: msg, signature: tx.signature,
      };
      const attrs = Object.entries(d).map(([k,v]) => `data-${k}="${esc(v)}"`).join(' ');
      return `<tr class="tx-row" ${attrs} onclick="showTxDetail(this)">
        <td class="td-num">${i+1}</td>
        <td><span class="type-pill ${isT?'type-transfer':'type-other'}">${TX_TYPES[tx.type]||`Type ${tx.type}`}</span></td>
        <td><a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${truncKey(senderAddr)}</a></td>
        <td>${recip}</td>
        <td class="td-right mono">${amt}</td>
        <td class="td-right fee-val">${xem(tx.fee)} XEM</td>
        <td>${msg ? `<span class="msg-text" title="${msg}">${msg.length>24?msg.slice(0,24)+'…':msg}</span>` : ''}</td>
      </tr>`;
    }).join('');
    return `<div style="margin-top:16px;" class="card">
      <div class="card-head">
        <div class="card-title">Transactions <span class="count-badge">${txns.length}</span></div>
        <span class="total-txt">Click a row to view details</span>
      </div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>#</th><th>Type</th><th>Sender</th><th>Recipient</th><th class="th-right">Amount</th><th class="th-right">Fee</th><th>Message</th></tr></thead>
        <tbody>${txRows}</tbody>
      </table></div>
    </div>
    <div class="card tx-detail-card" id="txDetailCard" style="display:none; margin-top:16px;">
      <div class="card-head">
        <div class="card-title">Transaction Detail</div>
        <button type="button" class="copy-btn" onclick="document.getElementById('txDetailCard').style.display='none'; document.querySelectorAll('.tx-row.active').forEach(r=>r.classList.remove('active'));">close</button>
      </div>
      <div class="ov-list" id="txDetailBody"></div>
    </div>
    <script>
      function showTxDetail(row) {
        var d = row.dataset;
        document.querySelectorAll('.tx-row.active').forEach(function(r){ r.classList.remove('active'); });
        row.classList.add('active');
        var blockHeight = ${block.height};
        var rows = [
          ['#', '<span class="mono">'+d.idx+'</span>'],
          ['Block', '<a href="/block/'+blockHeight+'" class="mono-link">'+blockHeight.toLocaleString()+'</a>'],
          ['Timestamp', '<span class="mono-muted">'+d.time+'</span>'],
          ['Type', '<span class="type-pill '+(d.recipient ? 'type-transfer' : 'type-other')+'">'+d.type+'</span>'],
          ['Sender', '<a href="/account/'+d.sender+'" class="mono-link" title="'+d.sender+'">'+d.sender+'</a> <button class="copy-btn" onclick="copy(\\''+d.sender+'\\')">copy</button>'],
          ['Recipient', d.recipient ? ('<a href="/account/'+d.recipient+'" class="mono-link" title="'+d.recipient+'">'+d.recipient+'</a> <button class="copy-btn" onclick="copy(\\''+d.recipient+'\\')">copy</button>') : '<span class="muted">—</span>'],
          ['Amount', d.amount ? '<span class="mono">'+d.amount+'</span>' : '<span class="muted">—</span>'],
          ['Fee', '<span class="fee-val">'+d.fee+'</span>'],
          ['Message', d.message ? '<span class="msg-text">'+d.message+'</span>' : '<span class="muted">(no message)</span>'],
          ['Signature', '<span class="mono-muted">'+d.signature.slice(0,10)+'…'+d.signature.slice(-6)+'</span> <button class="copy-btn" onclick="copy(\\''+d.signature+'\\')">copy</button>'],
        ];
        document.getElementById('txDetailBody').innerHTML = rows.map(function(r){
          return '<div class="ov-row"><div class="ov-label">'+r[0]+'</div><div class="ov-value">'+r[1]+'</div></div>';
        }).join('');
        var card = document.getElementById('txDetailCard');
        card.style.display = 'block';
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    </script>`;
  })();

  return `
  <div class="card-head">
    <div class="card-title">Overview</div>
    <span class="total-txt">Block <strong>${block.height}</strong> of <strong>${chainHeight}</strong></span>
  </div>
  <div class="ov-list">${ovRows}</div>
  ${txSection}
  <script>
    function copy(text) {
      navigator.clipboard.writeText(text).then(() => {
        document.querySelectorAll('.copy-btn').forEach(b => {
          if (b.getAttribute('onclick')?.includes(text.slice(0,8))) { b.textContent='copied!'; setTimeout(()=>b.textContent='copy',1500); }
        });
      });
    }
  </script>`;
}

// ── Transaction detail HTML ───────────────────────────────────────────────────

function txDetailHTML(tx, hash, height) {
  const date = nemDate(tx.timeStamp);
  const isT = tx.type === 257;
  const senderAddr = pubKeyToAddress(tx.signer) ?? tx.signer;
  const msg = decodeMsg(tx.message);

  const rows = [
    ['Transaction Hash', `<span class="mono-muted">${hash}</span> <button class="copy-btn" onclick="copy('${hash}')">copy</button>`],
    ['Status',           `<span class="status-ok">✓ Confirmed</span>`],
    ['Block',            height ? `<a href="/block/${height}" class="mono-link">${height}</a>` : '<span class="muted">—</span>'],
    ['Timestamp',        `${timeAgo(date)} <span class="muted">(${date.toISOString().slice(0,19).replace('T',' ')} UTC)</span>`],
    ['Type',             `<span class="type-pill ${isT?'type-transfer':'type-other'}">${TX_TYPES[tx.type]||`Type ${tx.type}`}</span>`],
    ['Sender',           `<a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${senderAddr}</a> <button class="copy-btn" onclick="copy('${senderAddr}')">copy</button>`],
    ['Recipient',        isT ? `<a href="/account/${tx.recipient}" class="mono-link" title="${tx.recipient}">${tx.recipient}</a> <button class="copy-btn" onclick="copy('${tx.recipient}')">copy</button>` : '<span class="muted">—</span>'],
    ['Amount',           isT ? `<span class="mono">${xem(tx.amount)} XEM</span>` : '<span class="muted">—</span>'],
    ['Fee',              `<span class="fee-val">${xem(tx.fee)} XEM</span>`],
    ['Message',          msg ? `<span class="msg-text" style="white-space:normal; max-width:none;">${msg}</span>` : '<span class="muted">(no message)</span>'],
    ['Signature',        `<span class="mono-muted">${truncHash(tx.signature)}</span> <button class="copy-btn" onclick="copy('${tx.signature}')">copy</button>`],
  ].map(([l,v]) => `<div class="ov-row"><div class="ov-label">${l}</div><div class="ov-value">${v}</div></div>`).join('');

  return `
  <div class="card-head">
    <div class="card-title">Overview</div>
  </div>
  <div class="ov-list">${rows}</div>
  <script>
    function copy(text) {
      navigator.clipboard.writeText(text).then(() => {
        document.querySelectorAll('.copy-btn').forEach(b => {
          if (b.getAttribute('onclick')?.includes(text.slice(0,8))) { b.textContent='copied!'; setTimeout(()=>b.textContent='copy',1500); }
        });
      });
    }
  </script>`;
}

function txNotFoundHTML(hash) {
  return `<div class="error-state">
    <div class="error-icon">⚠</div>
    <p class="error-title">Transaction not found</p>
    <p class="error-msg">Hash <span class="mono">${truncHash(hash)}</span> wasn't found in the connected nodes' cache.
      Public NIS1 nodes only keep hash lookups for very recent / unconfirmed transactions — older
      transactions can't be located by hash alone without a dedicated indexing service. Try opening
      the transaction from its block or account page instead.</p>
  </div>`;
}

// ── Account overview HTML ─────────────────────────────────────────────────────

function accountOverviewHTML(data, address) {
  const a = data.account;
  const m = data.meta;

  const statusLabel = m.status === 'UNLOCKED'
    ? `<span class="status-ok">● Unlocked (Harvesting)</span>`
    : `<span class="status-lock">● Locked</span>`;

  const pkCell = a.publicKey
    ? `<span class="mono-muted">${truncHash(a.publicKey)}</span> <button class="copy-btn" onclick="copy('${a.publicKey}')">copy</button>`
    : `<span class="muted">Not yet published</span>`;

  const cosigRows = m.cosignatories?.length
    ? [['Cosignatories', m.cosignatories.map(c => `<a href="/account/${c.address}" class="mono-link">${truncKey(c.address)}</a>`).join('<br>')]]
    : [];

  const rows = [
    ['Address',        `<span class="mono">${a.address}</span> <button class="copy-btn" onclick="copy('${a.address}')">copy</button>`],
    ['Balance',        `<span class="bal-amount">${xem(a.balance)}</span> <span class="bal-unit">XEM</span>`],
    ['Vested Balance', `${xem(a.vestedBalance)} XEM`],
    ['Importance',     `<span class="importance-val">${formatImportance(a.importance)}</span>`],
    ['Harvested Blocks', (a.harvestedBlocks || 0).toLocaleString()],
    ['Public Key',     pkCell],
    ['Account Status', statusLabel],
    ...cosigRows,
  ].map(([l,v]) => `<div class="ov-row"><div class="ov-label">${l}</div><div class="ov-value">${v}</div></div>`).join('');

  return `
  <div class="card">
    <div class="acct-balance-hero">
      <div class="bal-panel">
        <div class="bal-label">XEM Balance</div>
        <div class="bal-amount-lg">${xem(a.balance)} <span class="bal-unit">XEM</span></div>
      </div>
      <div class="bal-panel">
        <div class="bal-label">Vested Balance</div>
        <div class="bal-amount-sm">${xem(a.vestedBalance)} XEM</div>
      </div>
      <div class="bal-panel">
        <div class="bal-label">Importance Score</div>
        <div class="importance-val-lg">${formatImportance(a.importance)}</div>
      </div>
    </div>
    <div class="ov-list">${rows}</div>
  </div>`;
}

// ── Transaction table HTML ────────────────────────────────────────────────────

function renderTxRow(pair, accountAddress) {
  const tx = pair.transaction;
  const meta = pair.meta;
  const date = nemDate(tx.timeStamp);
  const hash = meta.hash?.data || '';
  const isTransfer = tx.type === 257;
  const isIncoming = isTransfer && tx.recipient === accountAddress;

  const senderAddr = pubKeyToAddress(tx.signer) ?? tx.signer;
  let dirBadge, fromCell, toCell, amountCell;
  if (isTransfer) {
    if (isIncoming) {
      dirBadge = `<span class="dir-in">▼ IN</span>`;
      fromCell = `<a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${truncKey(senderAddr)}</a>`;
      toCell   = `<span class="mono self-addr" title="${accountAddress}">${truncKey(accountAddress)}</span>`;
      amountCell = `<span class="tx-in">+${xem(tx.amount)}</span>`;
    } else {
      dirBadge = `<span class="dir-out">▲ OUT</span>`;
      fromCell = `<span class="mono self-addr" title="${accountAddress}">${truncKey(accountAddress)}</span>`;
      toCell   = `<a href="/account/${tx.recipient}" class="mono-link" title="${tx.recipient}">${truncKey(tx.recipient)}</a>`;
      amountCell = `<span class="tx-out">-${xem(tx.amount)}</span>`;
    }
  } else {
    dirBadge = `<span class="dir-other">${TX_TYPES[tx.type]||`T${tx.type}`}</span>`;
    fromCell = `<a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${truncKey(senderAddr)}</a>`;
    toCell   = `<span class="muted">—</span>`;
    amountCell = `<span class="muted">—</span>`;
  }

  return `<tr>
    <td>${dirBadge}</td>
    <td><a href="/tx/${hash}?height=${meta.height}&ts=${tx.timeStamp}" class="tx-hash" title="${hash}">${truncHash(hash)}</a></td>
    <td><a href="/block/${meta.height}" class="blk-link">${meta.height||0}</a></td>
    <td><div class="age-rel">${timeAgo(date)}</div><div class="age-abs">${date.toISOString().slice(0,16).replace('T',' ')} UTC</div></td>
    <td>${fromCell}</td>
    <td>${toCell}</td>
    <td class="td-right">${amountCell}</td>
    <td class="td-right fee-val">${xem(tx.fee)} XEM</td>
  </tr>`;
}

function loadMoreRow(txs, address) {
  if (txs.length < 25) return '';
  const lastId = txs[txs.length - 1]?.meta?.id ?? '';
  return `<tr id="load-more-row"><td colspan="7" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/account/${address}/txs/more?id=${lastId}"
            hx-target="#load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

function txTableHTML(txs, address) {
  if (!txs.length) return `<div class="empty-state">No transactions found</div>`;
  return `<div class="tbl-wrap"><table>
    <thead><tr>
      <th>Type</th><th>Txn Hash</th><th>Block</th><th>Age</th>
      <th>From</th><th>To</th><th class="th-right">Amount (XEM)</th><th class="th-right">Fee</th>
    </tr></thead>
    <tbody>${txs.map(p => renderTxRow(p, address)).join('')}${loadMoreRow(txs, address)}</tbody>
  </table></div>`;
}

function txMoreRows(txs, address) {
  if (!txs.length) return '';
  return txs.map(p => renderTxRow(p, address)).join('') + loadMoreRow(txs, address);
}

// ── Global transactions list HTML ─────────────────────────────────────────────

function renderGlobalTxRow(item) {
  const { tx, height, blockTime } = item;
  const date = nemDate(blockTime);
  const isTransfer = tx.type === 257;
  const senderAddr = pubKeyToAddress(tx.signer) ?? tx.signer;

  const toCell = isTransfer
    ? `<a href="/account/${tx.recipient}" class="mono-link" title="${tx.recipient}">${truncKey(tx.recipient)}</a>`
    : `<span class="muted">—</span>`;
  const amountCell = isTransfer
    ? `${xem(tx.amount)} XEM`
    : `<span class="muted">—</span>`;

  return `<tr>
    <td><a href="/block/${height}" class="blk-link">${height}</a></td>
    <td><a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${truncKey(senderAddr)}</a></td>
    <td>${toCell}</td>
    <td><span class="type-pill ${isTransfer ? 'type-transfer' : 'type-other'}">${TX_TYPES[tx.type] || `Type ${tx.type}`}</span></td>
    <td class="td-right">${amountCell}</td>
    <td class="td-right fee-val">${xem(tx.fee)} XEM</td>
    <td class="mono-muted">${date.toISOString().slice(0,16).replace('T',' ')} UTC</td>
    <td>${timeAgo(date)}</td>
  </tr>`;
}

function globalLoadMoreRow(nextFromBlock) {
  if (nextFromBlock < 1) return '';
  return `<tr id="txs-load-more-row"><td colspan="7" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/txs/more?fromBlock=${nextFromBlock}"
            hx-target="#txs-load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

function globalTxTableHTML(items, chainHeight, nextFromBlock) {
  if (!items.length) return `<div class="empty-state">No transactions found in recent blocks</div>`;
  return `
  <div class="card-head">
    <div class="card-title">Latest Transactions <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    <span class="total-txt">Chain height: <strong>${chainHeight}</strong></span>
  </div>
  <div class="tbl-wrap"><table>
    <thead><tr>
      <th>Block</th><th>Sender</th><th>Recipient</th><th>Type</th>
      <th class="th-right">Amount (XEM)</th><th class="th-right">Fee</th><th>Timestamp</th><th>Age</th>
    </tr></thead>
    <tbody>${items.map(renderGlobalTxRow).join('')}${globalLoadMoreRow(nextFromBlock)}</tbody>
  </table></div>`;
}

function globalTxMoreRows(items, nextFromBlock) {
  if (!items.length) return '';
  return items.map(renderGlobalTxRow).join('') + globalLoadMoreRow(nextFromBlock);
}

// ── Harvests / Mosaics / Namespaces HTML ──────────────────────────────────────

function harvestsHTML(data) {
  if (!data.length) return `<div class="empty-state">No harvested blocks found</div>`;
  const rows = data.map(h => {
    const date = nemDate(h.timeStamp);
    return `<tr>
      <td><a href="/block/${h.height}" class="blk-link">${h.height}</a></td>
      <td><div class="age-rel">${timeAgo(date)}</div><div class="age-abs">${date.toISOString().slice(0,19).replace('T',' ')} UTC</div></td>
      <td class="diff-val">${formatDiff(h.difficulty)}</td>
      <td class="td-right fee-val">${xem(h.totalFee)} XEM</td>
    </tr>`;
  }).join('');
  return `<div class="tbl-wrap"><table>
    <thead><tr><th>Block</th><th>Age</th><th>Difficulty</th><th class="th-right">Fee (XEM)</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function mosaicsHTML(data) {
  if (!data.length) return `<div class="empty-state">No mosaics owned</div>`;
  const rows = data.map((m, i) => `<tr>
    <td class="td-num">${i+1}</td>
    <td><span class="mosaic-id">${esc(m.mosaicId.namespaceId)}:<strong>${esc(m.mosaicId.name)}</strong></span></td>
    <td class="td-right mono">${m.quantity.toLocaleString()}</td>
  </tr>`).join('');
  return `<div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Mosaic</th><th class="th-right">Quantity</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function namespacesHTML(data) {
  if (!data.length) return `<div class="empty-state">No namespaces owned</div>`;
  const rows = data.map((ns, i) => `<tr>
    <td class="td-num">${i+1}</td>
    <td><span class="mono">${esc(ns.fqn)}</span></td>
    <td><a href="/block/${ns.height}" class="blk-link">${ns.height}</a></td>
  </tr>`).join('');
  return `<div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Namespace</th><th>Registered at Block</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// ── Global namespaces list HTML ───────────────────────────────────────────────

function renderNamespaceRow(ns, num) {
  return `<tr>
    <td class="td-num">${num}</td>
    <td><a href="/namespace/${encodeURIComponent(ns.fqn)}" class="mono-link" title="${esc(ns.fqn)}">${esc(ns.fqn)}</a></td>
    <td><a href="/account/${ns.owner}" class="mono-link" title="${ns.owner}">${truncKey(ns.owner)}</a></td>
    <td><a href="/block/${ns.height}" class="blk-link">${ns.height}</a></td>
  </tr>`;
}

function namespaceLoadMoreRow(offset, total, limit) {
  if (offset >= total) return '';
  return `<tr id="ns-load-more-row"><td colspan="4" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/namespaces/more?offset=${offset}&limit=${limit}"
            hx-target="#ns-load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

function namespaceMoreRows(items, offset, total, limit) {
  if (!items.length) return '';
  return items.map((ns, i) => renderNamespaceRow(ns, offset + i + 1)).join('') + namespaceLoadMoreRow(offset + items.length, total, limit);
}

function namespacesListHTML(items, updatedAt, limit) {
  if (!items.length) return `<div class="empty-state">No namespaces found</div>`;
  const cacheNote = updatedAt ? `Cached ${timeAgo(new Date(Number(updatedAt)))}` : 'Cached just now';
  const total = getNamespacesWithArchiveCount();
  const rItem = n => `<a class="rows-menu-item${n===limit ? ' active' : ''}" hx-get="/api/namespaces?limit=${n}" hx-target="#namespaces-card" hx-swap="innerHTML" href="#" role="menuitem">${n}</a>`;
  const rowsCtrl = `
      <div class="rows-ctrl">
        <span class="rows-ctrl-label">Show:</span>
        <div class="rows-switch">
          <button type="button" class="rows-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleRowsMenu(event)" title="Rows per page">
            <span class="rows-switch-label">${limit}</span>
            <span class="rows-switch-caret">&#9662;</span>
          </button>
          <div class="rows-menu" role="menu" aria-label="Rows per page">
            ${[10,25,50,100].map(rItem).join('')}
          </div>
        </div>
      </div>`;
  return `
  <div class="card-head">
    <div class="card-title">Registered Namespaces</div>
    <div class="card-head-right">
      <span class="total-txt">${cacheNote} · <strong>${total}</strong> archived</span>
      ${rowsCtrl}
    </div>
  </div>
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>Older namespaces beyond the live node's recent window are backfilled from <a href="https://explorer.nemtool.com/" target="_blank" rel="noopener">explorer.nemtool.com</a>'s historical index (${getArchivedNamespacesCount().toLocaleString('en')} records) and may not reflect the current on-chain state.</p>
  <div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Namespace</th><th>Owner</th><th>Registered at Block</th></tr></thead>
    <tbody>${items.map((ns, i) => renderNamespaceRow(ns, i + 1)).join('')}${namespaceLoadMoreRow(items.length, total, limit)}</tbody>
  </table></div>`;
}

// ── Mosaic detail HTML ────────────────────────────────────────────────────────

function mosaicNotFoundHTML(namespace, name) {
  return `<div class="error-state">
    <div class="error-icon">⚠</div>
    <p class="error-title">Mosaic not found</p>
    <p class="error-msg">Mosaic <span class="mono">${esc(namespace)}:${esc(name)}</span> wasn't found in the live cache or the historical index.</p>
  </div>`;
}

function mosaicDetailHTML(m, liveData) {
  const owner = /^[0-9a-f]{64}$/i.test(m.creator) ? pubKeyToAddress(m.creator) : m.creator;
  const supply = (m.supply / Math.pow(10, m.divisibility)).toLocaleString('en', { minimumFractionDigits: m.divisibility, maximumFractionDigits: m.divisibility });
  const liveProps = liveData ? Object.fromEntries((liveData.properties || []).map(p => [p.name, p.value])) : null;
  const supplyMutable = liveProps ? (liveProps.supplyMutable === 'true' ? 'Yes' : 'No') : null;
  const levy = liveData?.levy;

  const mosaicUrl = `/mosaic/${m.namespace.split('.').join('/')}/${m.name}`;
  const ovRows = [
    ['Mosaic ID',    `<span class="mono">${esc(m.namespace)}:<strong>${esc(m.name)}</strong></span> <button class="copy-btn" onclick="copy('${esc(m.namespace+':'+m.name)}')">copy</button>`],
    ['Namespace',    `<a href="/namespace/${encodeURIComponent(m.namespace)}" class="mono-link">${esc(m.namespace)}</a>`],
    ['Creator',      `<a href="/account/${owner}" class="mono-link" title="${owner}">${truncKey(owner)}</a> <button class="copy-btn" onclick="copy('${owner}')">copy</button>`],
    ['Description',  m.description ? esc(m.description) : `<span class="muted">—</span>`],
    ['Supply',       `<span class="mono">${supply}</span>`],
    ['Divisibility', `<span class="mono">${m.divisibility}</span>`],
    ['Transferable', m.transferable ? `<span class="status-ok">Yes</span>` : `<span class="status-expired">No</span>`],
    ...(supplyMutable !== null ? [['Supply Mutable', supplyMutable === 'Yes' ? `<span class="status-ok">Yes</span>` : `<span class="status-expired">No</span>`]] : []),
    ...(levy ? [['Levy', `Type ${levy.type} · ${(levy.fee / 1e6).toFixed(6)} ${levy.mosaicId ? `${esc(levy.mosaicId.namespaceId)}:${esc(levy.mosaicId.name)}` : 'XEM'} → <a href="/account/${levy.recipient}" class="mono-link">${truncKey(levy.recipient)}</a>`]] : []),
    ...(m.height ? [['Registered at Block', `<a href="/block/${m.height}" class="mono-link">${m.height}</a>`]] : []),
    ...(m.time_stamp ? [['Create Time', nemDate(m.time_stamp).toLocaleString('en', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZoneName:'short' })]] : []),
  ].map(([l,v]) => `<div class="ov-row"><div class="ov-label">${l}</div><div class="ov-value">${v}</div></div>`).join('');

  return `
  <div class="card-head">
    <div class="card-title">Overview</div>
  </div>
  <div class="ov-list">${ovRows}</div>
  <script>
    function copy(text) {
      navigator.clipboard.writeText(text).then(() => {
        document.querySelectorAll('.copy-btn').forEach(b => {
          if (b.getAttribute('onclick')?.includes(text.slice(0,8))) { b.textContent='copied!'; setTimeout(()=>b.textContent='copy',1500); }
        });
      });
    }
  </script>`;
}

// ── Namespace detail HTML ─────────────────────────────────────────────────────

function namespaceNotFoundHTML(fqn) {
  return `<div class="error-state">
    <div class="error-icon">⚠</div>
    <p class="error-title">Namespace not found</p>
    <p class="error-msg">Namespace <span class="mono">${esc(fqn)}</span> wasn't found in the live cache or
      the historical index mirrored from explorer.nemtool.com. It may not exist, may have expired and
      been pruned, or may have been registered too recently to appear in either source yet.</p>
  </div>`;
}

function namespaceDetailHTML(ns, root, subNamespaces, mosaics) {
  const isRoot = ns.fqn === root;
  const ovRows = [
    ['Namespace',           `<span class="mono">${esc(ns.fqn)}</span> <button class="copy-btn" onclick="copy('${esc(ns.fqn)}')">copy</button>`],
    ['Root Namespace',      isRoot ? `<span class="mono">${esc(root)}</span>` : `<a href="/namespace/${encodeURIComponent(root)}" class="mono-link">${esc(root)}</a>`],
    ['Owner',               `<a href="/account/${ns.owner}" class="mono-link" title="${ns.owner}">${truncKey(ns.owner)}</a> <button class="copy-btn" onclick="copy('${ns.owner}')">copy</button>`],
    ['Registered at Block', `<a href="/block/${ns.height}" class="mono-link">${ns.height.toLocaleString()}</a>`],
    ['Sub-namespaces',      subNamespaces.length ? `<strong>${subNamespaces.length}</strong>` : `<span class="muted">None</span>`],
    ['Mosaics',             mosaics.length ? `<strong>${mosaics.length}</strong>` : `<span class="muted">None</span>`],
  ].map(([l,v]) => `<div class="ov-row"><div class="ov-label">${l}</div><div class="ov-value">${v}</div></div>`).join('');

  const subsSection = !subNamespaces.length ? '' : `<div class="card" style="margin-top:16px;">
    <div class="card-head">
      <div class="card-title">Sub-namespaces <span class="count-badge">${subNamespaces.length}</span></div>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Namespace</th><th>Owner</th><th>Registered at Block</th></tr></thead>
      <tbody>${subNamespaces.map((s, i) => renderNamespaceRow(s, i + 1)).join('')}</tbody>
    </table></div>
  </div>`;

  const mosaicsSection = !mosaics.length ? '' : `<div class="card" style="margin-top:16px;">
    <div class="card-head">
      <div class="card-title">Mosaics <span class="count-badge">${mosaics.length}</span></div>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Mosaic</th><th>Creator</th><th class="th-center">Transferable</th><th class="th-right">Supply</th><th class="th-right">Divisibility</th><th class="th-right">Create Time</th></tr></thead>
      <tbody>${mosaics.map((m, i) => renderMosaicRow(m, i + 1)).join('')}</tbody>
    </table></div>
  </div>`;

  return `
  <div class="card-head">
    <div class="card-title">Overview</div>
  </div>
  <div class="ov-list">${ovRows}</div>
  ${subsSection}
  ${mosaicsSection}
  <script>
    function copy(text) {
      navigator.clipboard.writeText(text).then(() => {
        document.querySelectorAll('.copy-btn').forEach(b => {
          if (b.getAttribute('onclick')?.includes(text.slice(0,8))) { b.textContent='copied!'; setTimeout(()=>b.textContent='copy',1500); }
        });
      });
    }
  </script>`;
}

// ── Global mosaics list HTML ──────────────────────────────────────────────────

function renderMosaicRow(m, num) {
  // Live rows store the creator as a hex public key; archive rows imported
  // from explorer.nemtool.com already give us the resolved address.
  const owner = /^[0-9a-f]{64}$/i.test(m.creator) ? pubKeyToAddress(m.creator) : m.creator;
  const supply = (m.supply / Math.pow(10, m.divisibility)).toLocaleString('en', { minimumFractionDigits: m.divisibility, maximumFractionDigits: m.divisibility });
  const detailUrl = `/mosaic/${m.namespace.split('.').join('/')}/${m.name}`;
  const transferable = m.transferable ? `<span class="badge-yes">Yes</span>` : `<span class="badge-no">No</span>`;
  const createTime = m.time_stamp ? nemDate(m.time_stamp).toLocaleDateString('en', { year:'numeric', month:'short', day:'numeric' }) : `<span class="muted">—</span>`;
  return `<tr>
    <td class="td-num">${num}</td>
    <td><a href="${detailUrl}" class="mosaic-id-link" title="${esc(m.namespace)}:${esc(m.name)}">${esc(m.namespace)}:<strong>${esc(m.name)}</strong></a></td>
    <td><a href="/account/${owner}" class="mono-link" title="${owner}">${truncKey(owner)}</a></td>
    <td class="td-center">${transferable}</td>
    <td class="td-right mono">${supply}</td>
    <td class="td-right mono">${m.divisibility}</td>
    <td class="td-right">${createTime}</td>
  </tr>`;
}

function mosaicLoadMoreRow(offset, total, limit) {
  if (offset >= total) return '';
  return `<tr id="mos-load-more-row"><td colspan="7" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/mosaics/more?offset=${offset}&limit=${limit}"
            hx-target="#mos-load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

function mosaicMoreRows(items, offset, total, limit) {
  if (!items.length) return '';
  return items.map((m, i) => renderMosaicRow(m, offset + i + 1)).join('') + mosaicLoadMoreRow(offset + items.length, total, limit);
}

function mosaicsListHTML(items, updatedAt, limit) {
  if (!items.length) return `<div class="empty-state">No mosaics found</div>`;
  const deepAt = getCacheMeta('mosaics_deep_updated_at');
  const cacheNote = (updatedAt ? `Quick ${timeAgo(new Date(Number(updatedAt)))}` : 'Quick: just now')
    + (deepAt ? ` · Deep ${timeAgo(new Date(Number(deepAt)))}` : ' · Deep: pending');
  const total = getMosaicsWithArchiveCount();
  const rItem = n => `<a class="rows-menu-item${n===limit ? ' active' : ''}" hx-get="/api/mosaics?limit=${n}" hx-target="#mosaics-card" hx-swap="innerHTML" href="#" role="menuitem">${n}</a>`;
  const rowsCtrl = `
      <div class="rows-ctrl">
        <span class="rows-ctrl-label">Show:</span>
        <div class="rows-switch">
          <button type="button" class="rows-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleRowsMenu(event)" title="Rows per page">
            <span class="rows-switch-label">${limit}</span>
            <span class="rows-switch-caret">&#9662;</span>
          </button>
          <div class="rows-menu" role="menu" aria-label="Rows per page">
            ${[10,25,50,100].map(rItem).join('')}
          </div>
        </div>
      </div>`;
  return `
  <div class="card-head">
    <div class="card-title">Mosaics</div>
    <div class="card-head-right">
      <span class="total-txt">${cacheNote} · <strong>${total}</strong> archived</span>
      ${rowsCtrl}
    </div>
  </div>
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>Older mosaics beyond the live node's recent window are backfilled from <a href="https://explorer.nemtool.com/" target="_blank" rel="noopener">explorer.nemtool.com</a>'s historical index (${getArchivedMosaicsCount().toLocaleString('en')} records) and may not reflect the current on-chain state.</p>
  <div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Mosaic</th><th>Creator</th><th class="th-center">Transferable</th><th class="th-right">Supply</th><th class="th-right">Divisibility</th><th class="th-right">Create Time</th></tr></thead>
    <tbody>${items.map((m, i) => renderMosaicRow(m, i + 1)).join('')}${mosaicLoadMoreRow(items.length, total, limit)}</tbody>
  </table></div>`;
}

// ── Supernodes list HTML ──────────────────────────────────────────────────────

function renderNodeRow(n, num) {
  let host = n.endpoint, link = n.endpoint;
  try {
    const u = new URL(n.endpoint);
    host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {}
  return `<tr>
    <td class="td-num">${num}</td>
    <td>${esc(n.name || '—')}</td>
    <td><a href="${esc(link)}" class="mono-link" target="_blank" rel="noopener">${esc(host)}</a></td>
    <td><span class="status-ok">● Active</span></td>
  </tr>`;
}

function nodesListHTML(nodes) {
  if (!nodes.length) return `<div class="empty-state">No active supernodes found</div>`;
  return `
  <div class="card-head">
    <div class="card-title">Active Supernodes <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    <span class="total-txt"><strong>${nodes.length}</strong> active</span>
  </div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Name</th><th>Endpoint</th><th>Status</th></tr></thead>
    <tbody>${nodes.map((n, i) => renderNodeRow(n, i + 1)).join('')}</tbody>
  </table></div>`;
}

// ── Rich list (accounts) HTML ─────────────────────────────────────────────────

function renderAccountRow(a, num) {
  return `<tr>
    <td class="td-num">${num}</td>
    <td><a href="/account/${a.address}" class="mono-link" title="${a.address}">${truncKey(a.address)}</a></td>
    <td class="td-right mono">${xem(a.balance)} XEM</td>
    <td class="td-right mono">${formatImportance(a.importance)}</td>
    <td>${a.info ? esc(a.info) : '<span class="muted">—</span>'}</td>
  </tr>`;
}

function accountLoadMoreRow(offset, total) {
  if (offset >= total) return '';
  return `<tr id="acc-load-more-row"><td colspan="5" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/accounts/more?offset=${offset}"
            hx-target="#acc-load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

function accountMoreRows(items, offset, total) {
  if (!items.length) return '';
  return items.map((a, i) => renderAccountRow(a, offset + i + 1)).join('') + accountLoadMoreRow(offset + items.length, total);
}

function accountsListHTML(items, updatedAt, total) {
  if (!items.length) return `<div class="empty-state">No accounts found</div>`;
  const liveNote = updatedAt ? `Live · ranking refreshed ${timeAgo(new Date(Number(updatedAt)))}` : 'Live · ranking refreshing…';
  return `
  <div class="card-head">
    <div class="card-title">Rich List</div>
    <span class="total-txt">${liveNote} · top <strong>${total.toLocaleString()}</strong> accounts by current on-chain balance</span>
  </div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Address</th><th class="th-right">Balance</th><th class="th-right">Importance</th><th>Info</th></tr></thead>
    <tbody>${items.map((a, i) => renderAccountRow(a, i + 1)).join('')}${accountLoadMoreRow(items.length, total)}</tbody>
  </table></div>`;
}

// ── Shared CSS ────────────────────────────────────────────────────────────────

function sharedCSS() { return `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  :root {
    --bg:#f3f4f6; --card:#fff; --border:#e5e7eb; --text:#111827; --muted:#6b7280;
    --link:#2a7ddd; --link-h:#3a7aa6; --th-bg:#f9fafb; --row-h:#f9fafb;
    --green:#0e9b87; --green-bg:#edf9f7; --green-bdr:#b0e5de;
    --blue-bg:#eff6ff; --blue-bdr:#bfdbfe; --nav:#fff; --nav-text:#0f172a; --nav-text-2:#64748b;
    --surface:#fff; --surface-2:#f3f4f6; --surface-3:#f9fafb;
    --text-2:#374151; --text-3:#4b5563; --text-4:#9ca3af;
    --red:#f38a00; --red-bg:#fffaef; --red-bdr:#ffebba;
    --hero-1:#fff; --hero-2:#eef2f7; --spinner-track:#e5e7eb;
  }
  [data-theme="dim"] {
    --bg:#1b2030; --card:#212838; --border:#2d3548; --text:#e2e8f0; --muted:#94a3b8;
    --link:#2a7ddd; --link-h:#8dc8ef; --th-bg:#1f2636; --row-h:#262e42;
    --green:#0e9b87; --green-bg:#1c3b44; --green-bdr:#1d716e;
    --blue-bg:#16243d; --blue-bdr:#264268; --nav:#161b29; --nav-text:#f8fafc; --nav-text-2:#94a3b8;
    --surface:#212838; --surface-2:#2a3245; --surface-3:#1f2636;
    --text-2:#cbd5e1; --text-3:#a8b3c4; --text-4:#7d8aa0;
    --red:#f38a00; --red-bg:#443e32; --red-bdr:#987b36;
    --hero-1:#212838; --hero-2:#161b29; --spinner-track:#2d3548;
  }
  [data-theme="dark"] {
    --bg:#0d1117; --card:#161b22; --border:#262c36; --text:#e6edf3; --muted:#8b949e;
    --link:#2a7ddd; --link-h:#96ccf0; --th-bg:#11161d; --row-h:#1c222b;
    --green:#0e9b87; --green-bg:#10292c; --green-bdr:#166b62;
    --blue-bg:#0c2440; --blue-bdr:#1c3f66; --nav:#010409; --nav-text:#f8fafc; --nav-text-2:#94a3b8;
    --surface:#161b22; --surface-2:#21262d; --surface-3:#181d24;
    --text-2:#c9d1d9; --text-3:#9da7b3; --text-4:#6e7681;
    --red:#f38a00; --red-bg:#312c1c; --red-bdr:#92752a;
    --hero-1:#161b22; --hero-2:#010409; --spinner-track:#262c36;
  }
  body, .card, .topnav, input, select, button { transition:background-color .15s ease, color .15s ease, border-color .15s ease; }
  body { font-family:"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:14px; background:var(--bg); color:var(--text); line-height:1.5; }
  a { text-decoration:none; }

  /* Topbar (price / search / theme — sits above the main navbar) */
  .topbar { background:var(--nav); border-bottom:1px solid color-mix(in srgb, var(--nav-text) 8%, transparent); }
  .topbar-inner { max-width:1280px; margin:0 auto; padding:8px 24px; display:flex; align-items:center; gap:16px; flex-wrap:wrap; row-gap:8px; }

  /* Navbar */
  .topnav { background:var(--nav); border-bottom:1px solid color-mix(in srgb, var(--nav-text) 9%, transparent); }
  .topnav-inner { max-width:1280px; margin:0 auto; padding:0 24px; display:flex; align-items:center; height:54px; gap:24px; }
  .logo { font-size:17px; font-weight:700; color:var(--nav-text); text-decoration:none; display:flex; align-items:center; gap:8px; }
  .nav-menu { display:contents; }
  .nav-links { display:flex; gap:2px; list-style:none; }
  .nav-links a { color:var(--nav-text-2); text-decoration:none; padding:6px 12px; border-radius:6px; font-size:13px; font-weight:500; }
  .nav-links a:hover, .nav-links a.active { color:var(--nav-text); background:color-mix(in srgb, var(--nav-text) 10%, transparent); }
  .nav-menu-tools { display:none; }
  .nav-burger { display:none; flex-direction:column; justify-content:center; align-items:center; gap:4px; width:34px; height:34px; padding:0; margin-left:auto; border:1px solid color-mix(in srgb, var(--nav-text) 12%, transparent); border-radius:8px; background:color-mix(in srgb, var(--nav-text) 6%, transparent); cursor:pointer; }
  .nav-burger:hover { background:color-mix(in srgb, var(--nav-text) 10%, transparent); }
  .nav-burger[aria-expanded="true"] { background:color-mix(in srgb, var(--nav-text) 14%, transparent); }
  .nav-burger-bar { display:block; width:16px; height:2px; background:var(--nav-text-2); border-radius:2px; }
  .xem-price { font-size:13px; color:var(--nav-text-2); white-space:nowrap; }
  .xem-price strong { color:var(--nav-text); font-weight:600; }
  .xem-price .price-up { color:var(--green); }
  .xem-price .price-down { color:var(--red); }
  .nav-search { margin-left:auto; display:flex; align-items:stretch; flex:1 1 280px; min-width:200px; max-width:340px; background:color-mix(in srgb, var(--nav-text) 8%, transparent); border:1px solid color-mix(in srgb, var(--nav-text) 14%, transparent); border-radius:8px; overflow:hidden; }
  .nav-search:focus-within { border-color:color-mix(in srgb, var(--nav-text) 32%, transparent); background:color-mix(in srgb, var(--nav-text) 12%, transparent); }
  .nav-search input { flex:1 1 auto; width:auto; min-width:0; background:transparent; border:none; color:var(--nav-text); font-size:13px; padding:7px 10px; outline:none; }
  .nav-search input::placeholder { color:var(--nav-text-2); }
  .nav-search button { display:inline-flex; align-items:center; justify-content:center; width:36px; flex:0 0 36px; background:transparent; border:none; border-left:1px solid color-mix(in srgb, var(--nav-text) 12%, transparent); color:var(--nav-text-2); font-size:14px; cursor:pointer; }
  .nav-search button:hover { color:var(--nav-text); background:color-mix(in srgb, var(--nav-text) 10%, transparent); }
  .theme-switch { position:relative; }
  .theme-switch-btn { display:flex; align-items:center; gap:6px; height:32px; padding:0 10px; background:color-mix(in srgb, var(--nav-text) 6%, transparent); border:1px solid color-mix(in srgb, var(--nav-text) 12%, transparent); border-radius:8px; color:var(--nav-text-2); font-size:13px; cursor:pointer; }
  .theme-switch-btn:hover { color:var(--nav-text); background:color-mix(in srgb, var(--nav-text) 10%, transparent); }
  .theme-switch-btn[aria-expanded="true"] { color:var(--nav-text); background:color-mix(in srgb, var(--nav-text) 14%, transparent); }
  .theme-switch-icon { font-size:14px; line-height:1; }
  .theme-switch-caret { font-size:10px; opacity:.7; }
  .theme-menu { position:absolute; top:calc(100% + 6px); right:0; min-width:0; width:max-content; background:var(--nav); border:1px solid color-mix(in srgb, var(--nav-text) 14%, transparent); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.18); padding:4px; display:none; flex-direction:column; gap:1px; z-index:50; }
  .theme-menu.open { display:flex; }
  .theme-menu-item { display:flex; align-items:center; justify-content:center; border:none; border-radius:6px; background:transparent; color:var(--nav-text-2); font-size:13px; padding:8px 10px; cursor:pointer; text-align:center; }
  .theme-menu-item:hover { color:var(--nav-text); background:color-mix(in srgb, var(--nav-text) 8%, transparent); }
  .theme-menu-item.active { color:var(--nav-text); background:color-mix(in srgb, var(--nav-text) 14%, transparent); font-weight:600; }
  .theme-menu-icon { display:inline-flex; justify-content:center; width:16px; font-size:14px; line-height:1; }

  /* Node-switch dropdown (navbar connection picker) */
  .node-switch { position:relative; }
  .node-switch-btn { display:flex; align-items:center; gap:7px; height:32px; padding:0 10px; background:color-mix(in srgb, var(--nav-text) 6%, transparent); border:1px solid color-mix(in srgb, var(--nav-text) 12%, transparent); border-radius:8px; color:var(--nav-text-2); font-size:13px; cursor:pointer; max-width:160px; }
  .node-switch-btn:hover { color:var(--nav-text); background:color-mix(in srgb, var(--nav-text) 10%, transparent); }
  .node-switch-btn[aria-expanded="true"] { color:var(--nav-text); background:color-mix(in srgb, var(--nav-text) 14%, transparent); }
  .node-switch-dot { width:8px; height:8px; border-radius:50%; background:color-mix(in srgb, var(--nav-text) 30%, transparent); flex-shrink:0; }
  .node-switch-dot.is-live { background:#22c55e; box-shadow:0 0 0 3px color-mix(in srgb, #22c55e 20%, transparent); }
  .node-switch-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .node-switch-caret { font-size:10px; opacity:.7; }
  .node-menu { position:absolute; top:calc(100% + 6px); right:0; min-width:260px; max-height:360px; overflow-y:auto; background:var(--nav); border:1px solid color-mix(in srgb, var(--nav-text) 14%, transparent); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.18); padding:4px; display:none; flex-direction:column; gap:1px; z-index:50; }
  .node-menu.open { display:flex; }
  .node-menu-head { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--nav-text-2); padding:8px 10px 4px; display:flex; align-items:baseline; gap:6px; }
  .node-menu-note { font-size:10px; font-weight:400; text-transform:none; letter-spacing:0; opacity:.7; }
  .node-menu-sep { height:1px; margin:3px 6px; background:color-mix(in srgb, var(--nav-text) 12%, transparent); }
  .node-menu-item { display:flex; align-items:center; gap:9px; width:100%; border:none; border-radius:6px; background:transparent; color:var(--nav-text-2); font-size:13px; padding:7px 10px; cursor:pointer; text-align:left; }
  .node-menu-item:hover { color:var(--nav-text); background:color-mix(in srgb, var(--nav-text) 8%, transparent); }
  .node-menu-item.active { color:var(--nav-text); background:color-mix(in srgb, var(--nav-text) 14%, transparent); font-weight:600; }
  .node-menu-dot { width:7px; height:7px; border-radius:50%; background:color-mix(in srgb, var(--nav-text) 25%, transparent); flex-shrink:0; }
  .node-menu-item.active .node-menu-dot { background:#22c55e; }
  .node-menu-text { display:flex; flex-direction:column; min-width:0; }
  .node-menu-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .node-menu-sub { font-size:11px; color:var(--nav-text-2); opacity:.75; font-family:"JetBrains Mono",monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .node-menu-empty { font-size:12px; color:var(--nav-text-2); padding:10px; text-align:center; }

  /* Footer */
  .site-footer { background:var(--nav); border-top:1px solid color-mix(in srgb, var(--nav-text) 7%, transparent); margin-top:32px; }
  .site-footer-inner { max-width:1280px; margin:0 auto; padding:30px 24px 26px; display:flex; flex-direction:column; align-items:center; gap:14px; text-align:center; }
  .footer-links { display:flex; gap:32px; flex-wrap:wrap; justify-content:center; }
  .footer-links a { display:inline-flex; align-items:center; gap:7px; color:var(--link); text-decoration:none; font-size:12.5px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
  .footer-links a svg { width:16px; height:16px; fill:currentColor; }
  .footer-links a:hover { color:var(--link-h); }
  .footer-bottom { display:flex; align-items:center; justify-content:space-between; gap:16px; width:100%; }
  .footer-copy { color:var(--nav-text-2); font-size:12px; text-align:left; }
  .footer-donate { display:inline-flex; align-items:center; gap:7px; color:var(--nav-text-2); text-decoration:none; font-size:12px; letter-spacing:.04em; text-align:right; font-style:normal; }
  .footer-donate svg { width:12px; height:12px; fill:#dc3545; }
  .footer-donate:hover { color:var(--text); }

  /* Hero */
  .hero { background:linear-gradient(180deg,var(--hero-1) 0%,var(--hero-2) 100%); border-bottom:1px solid color-mix(in srgb, var(--nav-text) 8%, transparent); }
  .hero-inner { max-width:1280px; margin:0 auto; padding:22px 24px; }
  .hero h1 { color:var(--nav-text); font-size:21px; font-weight:600; }
  .hero-row { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  .hero-row-between { justify-content:space-between; }
  .hero-hl { color:var(--link); }
  .hero-link { color:var(--link); font-size:13px; font-weight:600; }

  /* Home page */
  .home-hero { background:linear-gradient(180deg,var(--hero-1) 0%,var(--hero-2) 100%); border-bottom:1px solid color-mix(in srgb, var(--nav-text) 8%, transparent); text-align:center; }
  .home-hero-inner { max-width:640px; margin:0 auto; padding:48px 24px 40px; display:flex; flex-direction:column; align-items:center; }
  .home-tagline { font-size:14px; color:var(--nav-text-2); margin:4px 0 20px; }
  .home-search { display:flex; align-items:stretch; width:100%; max-width:560px; background:color-mix(in srgb, var(--nav-text) 8%, transparent); border:1px solid color-mix(in srgb, var(--nav-text) 14%, transparent); border-radius:10px; overflow:hidden; }
  .home-search:focus-within { border-color:color-mix(in srgb, var(--nav-text) 32%, transparent); background:color-mix(in srgb, var(--nav-text) 12%, transparent); }
  .home-search input { flex:1 1 auto; min-width:0; background:transparent; border:none; color:var(--nav-text); font-size:14px; padding:13px 16px; outline:none; }
  .home-search input::placeholder { color:var(--nav-text-2); }
  .home-search button { display:inline-flex; align-items:center; justify-content:center; width:50px; flex:0 0 50px; background:transparent; border:none; border-left:1px solid color-mix(in srgb, var(--nav-text) 12%, transparent); color:var(--nav-text-2); font-size:16px; cursor:pointer; }
  .home-search button:hover { color:var(--nav-text); background:color-mix(in srgb, var(--nav-text) 10%, transparent); }
  .home-stats { display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; margin:28px 0 22px; }
  .home-stat { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  .home-stat-label { font-size:11px; font-weight:600; letter-spacing:.05em; color:var(--muted); margin-bottom:6px; }
  .home-stat-val { font-size:17px; font-weight:600; color:var(--text); }
  .home-stat-val .price-up { color:var(--green); font-size:13px; font-weight:500; }
  .home-stat-val .price-down { color:var(--red); font-size:13px; font-weight:500; }
  .home-panels { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:28px; }
  .home-panel table { min-width:0; }
  .home-panel-foot { padding:12px 20px; border-top:1px solid var(--border); background:var(--surface-3); text-align:center; }
  .home-panel-foot a { color:var(--link); font-size:13px; font-weight:600; }
  @media (max-width:900px) {
    .home-stats { grid-template-columns:repeat(2, 1fr); }
    .home-panels { grid-template-columns:1fr; }
  }
  @media (max-width:480px) {
    .home-stats { grid-template-columns:1fr; }
  }

  .blk-nav { display:flex; gap:6px; }
  .blk-nav-btn { width:30px; height:30px; background:color-mix(in srgb, var(--nav-text) 10%, transparent); border:1px solid color-mix(in srgb, var(--nav-text) 15%, transparent); border-radius:6px; color:var(--nav-text-2); text-decoration:none; display:inline-flex; align-items:center; justify-content:center; font-size:16px; font-weight:600; }
  .blk-nav-btn:hover { background:color-mix(in srgb, var(--nav-text) 20%, transparent); color:var(--nav-text); text-decoration:none; }
  .blk-nav-btn.disabled { opacity:.3; pointer-events:none; }

  /* Account hero */
  .acct-addr-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:4px; }
  .acct-addr-icon { color:var(--link); font-size:16px; }
  .acct-addr-text { font-family:"JetBrains Mono",monospace; font-size:13px; color:var(--nav-text); word-break:break-all; }
  .copy-btn-hero { padding:3px 10px; border:1px solid color-mix(in srgb, var(--nav-text) 25%, transparent); border-radius:5px; background:color-mix(in srgb, var(--nav-text) 10%, transparent); color:var(--nav-text-2); font-size:11px; cursor:pointer; }
  .copy-btn-hero:hover { background:color-mix(in srgb, var(--nav-text) 20%, transparent); color:var(--nav-text); }

  /* Container & Card */
  .container { max-width:1280px; margin:0 auto; padding:20px 24px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.05); }
  .card-head { padding:13px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }
  .card-title { font-size:14px; font-weight:600; display:flex; align-items:center; gap:8px; }
  .card-head-right { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  .live-pill { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:500; color:var(--green); background:var(--green-bg); border:1px solid var(--green-bdr); border-radius:99px; padding:2px 8px; }
  .live-dot { width:6px; height:6px; background:#22c55e; border-radius:50%; animation:blink 2s ease-in-out infinite; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
  .total-txt { font-size:13px; color:var(--muted); }
  .total-txt strong { color:var(--text); }
  .archive-note { margin:0; padding:10px 20px; font-size:12.5px; line-height:1.5; color:#d97706; background:rgba(245,158,11,0.12); border-bottom:1px solid rgba(245,158,11,0.3); }
  .archive-note a { color:var(--link); }
  .archive-note .archive-note-icon { margin-right:4px; }

  /* Account balance hero */
  .acct-balance-hero { display:grid; grid-template-columns:repeat(3,1fr); gap:0; border-bottom:1px solid var(--border); }
  .bal-panel { padding:18px 24px; border-right:1px solid var(--border); }
  .bal-panel:last-child { border-right:none; }
  .bal-label { font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; margin-bottom:8px; }
  .bal-amount-lg { font-size:22px; font-weight:700; color:var(--text); }
  .bal-amount-sm { font-size:16px; font-weight:600; color:var(--text); }
  .bal-unit { font-size:13px; font-weight:400; color:var(--muted); }
  .importance-val-lg { font-size:18px; font-weight:700; color:var(--text); }
  .importance-val { color:var(--text); font-weight:600; }
  .status-lock { color:var(--text-4); font-size:13px; }

  /* Tabs */
  .tab-nav { display:flex; border-bottom:1px solid var(--border); padding:0 8px; overflow-x:auto; }
  .tab-btn { padding:11px 16px; font-size:13px; font-weight:500; color:var(--muted); background:transparent; border:none; border-bottom:2px solid transparent; margin-bottom:-1px; cursor:pointer; white-space:nowrap; }
  .tab-btn:hover { color:var(--text); }
  .tab-btn.active { color:var(--link); border-bottom-color:var(--link); }

  /* Table (shared) */
  .tbl-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; min-width:680px; }
  thead { background:var(--th-bg); }
  th { padding:9px 16px; font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; border-bottom:1px solid var(--border); white-space:nowrap; text-align:left; }
  td { padding:11px 16px; border-bottom:1px solid var(--border); vertical-align:middle; }
  tbody tr:last-child td { border-bottom:none; }
  tbody tr:hover td { background:var(--row-h); }
  .th-right,.td-right { text-align:right; }
  .td-num { color:var(--muted); font-size:12px; width:36px; }

  /* Blocks list */
  .blk-cell { display:flex; align-items:center; gap:9px; }
  .blk-num { font-weight:600; font-size:13px; color:var(--link); }
  .blk-num:hover { color:var(--link-h); }
  .blk-link { font-size:13px; color:var(--link); }
  .age-rel { font-weight:500; }
  .age-abs { font-size:11.5px; color:var(--muted); margin-top:1px; }
  .txn-pill { display:inline-flex; align-items:center; justify-content:center; min-width:30px; padding:2px 8px; border-radius:99px; font-size:12px; font-weight:600; border:1px solid; }
  .txn-pos { background:var(--green-bg); color:var(--green); border-color:var(--green-bdr); }
  .txn-zero { background:var(--surface-3); color:var(--text-4); border-color:var(--border); }
  .harv { font-family:"JetBrains Mono",monospace; font-size:12.5px; color:var(--link); }
  .harv:hover { color:var(--link-h); }
  .diff-val { color:var(--text-3); font-size:13px; }
  .fee-val { color:var(--green); font-size:13px; font-weight:500; }

  /* Pagination */
  .tbl-foot { padding:13px 20px; border-top:1px solid var(--border); display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:10px; background:var(--surface-3); }
  .rows-ctrl { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--muted); }
  .rows-switch { position:relative; }
  .rows-switch-btn { display:flex; align-items:center; gap:6px; height:28px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text-2); font-size:12.5px; font-weight:600; cursor:pointer; }
  .rows-switch-btn:hover { background:var(--surface-2); }
  .rows-switch-btn[aria-expanded="true"] { background:var(--surface-2); border-color:var(--link); }
  .rows-switch-caret { font-size:10px; opacity:.7; }
  .rows-menu { position:absolute; top:calc(100% + 6px); right:0; min-width:74px; background:var(--surface); border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.18); padding:4px; display:none; flex-direction:column; gap:1px; z-index:50; }
  .rows-menu.open { display:flex; }
  .rows-menu-item { padding:7px 12px; border-radius:6px; background:transparent; color:var(--text-2); font-size:13px; font-weight:500; text-decoration:none; text-align:center; cursor:pointer; }
  .rows-menu-item:hover { background:var(--surface-2); color:var(--text-2); text-decoration:none; }
  .rows-menu-item.active { background:var(--link); color:#fff; font-weight:600; }
  .pag-ctrl { display:flex; align-items:center; gap:8px; }
  .pg-info { font-size:13px; color:var(--muted); }
  .pg-info strong { color:var(--text); }
  .p-btn { padding:5px 11px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text-2); font-size:13px; font-weight:500; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; }
  .p-btn:hover { background:var(--surface-2); color:var(--text-2); text-decoration:none; }
  .p-btn.off { opacity:.38; pointer-events:none; }

  /* Block / Account overview rows */
  .ov-row { display:flex; align-items:flex-start; padding:12px 20px; border-bottom:1px solid var(--border); gap:0; }
  .ov-row:last-child { border-bottom:none; }
  .ov-label { flex:0 0 200px; font-size:13px; color:var(--muted); padding-top:2px; }
  .ov-value { flex:1; font-size:13px; color:var(--text); display:flex; align-items:center; gap:8px; flex-wrap:wrap; word-break:break-all; }
  .muted { color:var(--muted); }
  .mono { font-family:"JetBrains Mono",monospace; font-size:12.5px; }
  .mono-link { font-family:"JetBrains Mono",monospace; font-size:12.5px; color:var(--link); }
  .mono-link:hover { color:var(--link-h); }
  .mono-muted { font-family:"JetBrains Mono",monospace; font-size:12.5px; color:var(--muted); }
  .self-addr { color:var(--text-2); font-weight:500; }
  .copy-btn { padding:2px 7px; border:1px solid var(--border); border-radius:4px; background:var(--surface-3); color:var(--muted); font-size:11px; cursor:pointer; }
  .copy-btn:hover { background:var(--surface-2); color:var(--text); }
  .status-ok { display:inline-flex; align-items:center; gap:5px; font-size:12px; font-weight:500; color:var(--green); background:var(--green-bg); border:1px solid var(--green-bdr); border-radius:99px; padding:2px 10px; }
  .status-expired { display:inline-flex; align-items:center; gap:5px; font-size:12px; font-weight:500; color:var(--text-4); background:var(--surface-2); border:1px solid var(--border); border-radius:99px; padding:2px 10px; }
  .count-badge { display:inline-flex; align-items:center; justify-content:center; min-width:20px; padding:1px 6px; border-radius:99px; font-size:11px; font-weight:600; background:var(--blue-bg); color:var(--link); border:1px solid var(--blue-bdr); }
  .type-pill { display:inline-flex; align-items:center; padding:2px 8px; border-radius:4px; font-size:11.5px; font-weight:500; border:1px solid; white-space:nowrap; }
  .type-transfer { background:var(--blue-bg); color:var(--link); border-color:var(--blue-bdr); }
  .type-other { background:var(--surface-2); color:var(--muted); border-color:var(--border); }
  .msg-text { color:var(--text-2); font-size:12.5px; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:inline-block; }
  .tx-row { cursor:pointer; }
  .tx-row:hover { background:var(--surface-2); }
  .tx-row.active { background:var(--blue-bg); }
  .tx-detail-card .ov-value a.mono-link { font-size:12.5px; }

  /* Transaction direction */
  .dir-in { display:inline-flex; align-items:center; font-size:11px; font-weight:600; background:var(--green-bg); color:var(--green); border:1px solid var(--green-bdr); border-radius:4px; padding:2px 6px; white-space:nowrap; }
  .dir-out { display:inline-flex; align-items:center; font-size:11px; font-weight:600; background:var(--red-bg); color:var(--red); border:1px solid var(--red-bdr); border-radius:4px; padding:2px 6px; white-space:nowrap; }
  .dir-other { display:inline-flex; align-items:center; font-size:11px; font-weight:500; background:var(--surface-2); color:var(--muted); border:1px solid var(--border); border-radius:4px; padding:2px 6px; white-space:nowrap; }
  .tx-in { color:var(--green); font-weight:600; }
  .tx-out { color:var(--red); font-weight:600; }
  .tx-hash { font-family:"JetBrains Mono",monospace; font-size:12.5px; color:var(--link); }

  /* Load more */
  .load-more-cell { text-align:center; padding:14px; }
  .load-more-btn { padding:6px 24px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--link); font-size:13px; font-weight:500; cursor:pointer; display:inline-flex; align-items:center; gap:7px; }
  .load-more-btn:hover { background:var(--blue-bg); }
  .load-more-btn.htmx-request { pointer-events:none; opacity:.8; }
  .load-more-btn .lm-text { display:inline; }
  .load-more-btn.htmx-request .lm-text { display:none; }
  .load-more-btn .lm-spinner { display:none; width:14px; height:14px; border:2px solid var(--border); border-top-color:var(--link); border-radius:50%; animation:spin .7s linear infinite; }
  .load-more-btn.htmx-request .lm-spinner { display:inline-block; }

  /* Mosaic */
  .mosaic-id { font-family:"JetBrains Mono",monospace; font-size:12.5px; display:inline-block; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:middle; }
  .mosaic-id-link { font-family:"JetBrains Mono",monospace; font-size:12.5px; display:inline-block; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:middle; color:var(--link); text-decoration:none; }
  .mosaic-id-link:hover { color:var(--link-h); text-decoration:underline; }
  .desc-cell { font-size:12.5px; color:var(--text-3); }
  .badge-yes { display:inline-block; padding:1px 8px; border-radius:99px; font-size:11.5px; font-weight:500; background:color-mix(in srgb, #22c55e 12%, transparent); color:#16a34a; border:1px solid color-mix(in srgb, #22c55e 30%, transparent); }
  .badge-no  { display:inline-block; padding:1px 8px; border-radius:99px; font-size:11.5px; font-weight:500; background:color-mix(in srgb, #ef4444 10%, transparent); color:#dc2626; border:1px solid color-mix(in srgb, #ef4444 25%, transparent); }
  .td-center { text-align:center; }
  .th-center { text-align:center; }

  /* Empty / Loading / Error */
  .empty-state { padding:40px; text-align:center; color:var(--muted); }
  .loading { display:flex; align-items:center; justify-content:center; padding:64px; gap:12px; color:var(--muted); }
  @keyframes spin { to { transform:rotate(360deg); } }
  .spinner { width:20px; height:20px; flex-shrink:0; border:2px solid var(--spinner-track); border-top-color:var(--link); border-radius:50%; animation:spin .7s linear infinite; }
  .error-state { padding:52px; text-align:center; color:var(--red); }
  .error-icon { font-size:32px; margin-bottom:12px; }
  .error-title { font-size:15px; font-weight:600; }
  .error-msg { font-size:12px; color:var(--muted); margin-top:6px; }
  .retry-btn { margin-top:18px; padding:8px 20px; background:var(--link); color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:500; display:inline-block; }
  .retry-btn:hover { background:var(--link-h); }

  @media (max-width:760px) {
    /* Below this width, the topbar's tools move into the burger menu (see
       .nav-menu-tools below), so the standalone topbar row is dropped. */
    .topbar { display:none; }
    .topnav-inner { position:relative; }
    .nav-burger { display:flex; }
    .nav-menu { display:none; position:absolute; top:100%; left:0; right:0; flex-direction:column; gap:14px; margin:0; background:var(--nav); border-bottom:1px solid color-mix(in srgb, var(--nav-text) 9%, transparent); padding:10px 16px 16px; box-shadow:0 10px 24px rgba(0,0,0,.16); z-index:40; max-height:calc(100vh - 54px); overflow-y:auto; }
    .nav-menu.open { display:flex; }
    .nav-links { display:flex; flex-direction:column; gap:2px; }
    .nav-links a { display:block; padding:10px 12px; }
    .nav-menu-tools { display:flex; flex-direction:column; gap:10px; padding-top:12px; border-top:1px solid color-mix(in srgb, var(--nav-text) 9%, transparent); }
    .nav-menu-tools .xem-price,
    .nav-menu-tools .nav-search,
    .nav-menu-tools .node-switch,
    .nav-menu-tools .theme-switch { flex:none; margin-left:0; max-width:none; width:100%; }
    .nav-menu-tools .node-switch-btn,
    .nav-menu-tools .theme-switch-btn { width:100%; max-width:none; justify-content:space-between; }
    /* Nested theme/node dropdowns flow inline here (instead of floating
       absolutely) so they can't be clipped by .nav-menu's own scroll box. */
    .nav-menu-tools .theme-menu,
    .nav-menu-tools .node-menu { position:static; width:100%; max-width:none; min-width:0; margin-top:8px; box-shadow:none; }
  }

  @media (max-width:640px) {
    .acct-balance-hero { grid-template-columns:1fr; }
    .bal-panel { border-right:none; border-bottom:1px solid var(--border); }
    .ov-label { flex:0 0 130px; }
  }
`; }
