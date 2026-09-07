import { DatabaseSync } from "node:sqlite";
import { NETWORKS } from "./constants.js";
import { currentNetwork } from "./context.js";

// NODE_TEST_CONTEXT is set by Node itself in every process spawned by
// `node --test`, regardless of how a test file's imports are ordered — so
// unlike relying on import order, this check can't be defeated by a test
// file accidentally reaching this module (e.g. via a stray static import)
// before it sets NEMSCAN_DB_DIR. Every test/*.test.js file that imports
// this module (directly, or transitively via cache.js/html.js/nemApi.js/
// index.js) is expected to set NEMSCAN_DB_DIR first; if one doesn't, fail
// loudly here instead of silently opening (and writing test data into) the
// real cache.db / cache-testnet.db in the repo root — this happened in
// practice (see docs/superpowers/plans/2026-09-06-tx-detail-payload.md).
if (process.env.NODE_TEST_CONTEXT && !process.env.NEMSCAN_DB_DIR) {
  throw new Error(
    "NEMSCAN_DB_DIR is not set while running under node --test, and this " +
      "module is about to open cache.db / cache-testnet.db. Set " +
      "process.env.NEMSCAN_DB_DIR to a throwaway directory (mkdtempSync) " +
      "before this test file imports anything that reaches db.js.",
  );
}

function openDbLayer(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
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
  `);
  try {
    db.exec("ALTER TABLE mosaics ADD COLUMN height INTEGER");
  } catch {}
  try {
    db.exec("ALTER TABLE mosaics ADD COLUMN time_stamp INTEGER");
  } catch {}
  try {
    db.exec("ALTER TABLE mosaics_archive ADD COLUMN height INTEGER");
  } catch {}
  try {
    db.exec("ALTER TABLE mosaics_archive ADD COLUMN time_stamp INTEGER");
  } catch {}

  const _nsUpsertStmt = db.prepare(
    "INSERT OR REPLACE INTO namespaces (id, fqn, owner, height) VALUES (?, ?, ?, ?)",
  );
  const _nsSelectStmt = db.prepare(
    "SELECT id, fqn, owner, height FROM namespaces ORDER BY id DESC LIMIT ? OFFSET ?",
  );
  const _nsCountStmt = db.prepare("SELECT COUNT(*) AS c FROM namespaces");
  const _nsArchUpsertStmt = db.prepare(
    "INSERT OR REPLACE INTO namespaces_archive (no, fqn, owner, height) VALUES (?, ?, ?, ?)",
  );
  const _nsArchCountStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM namespaces_archive",
  );
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
  const _nsLiveByFqnStmt = db.prepare(
    "SELECT fqn, owner, height FROM namespaces WHERE fqn = ?",
  );
  const _nsArchByFqnStmt = db.prepare(
    "SELECT fqn, owner, height FROM namespaces_archive WHERE fqn = ?",
  );
  const _mosUpsertStmt = db.prepare(
    "INSERT OR REPLACE INTO mosaics (id, namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const _mosSelectStmt = db.prepare(
    "SELECT id, namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp FROM mosaics ORDER BY id DESC LIMIT ? OFFSET ?",
  );
  const _mosCountStmt = db.prepare("SELECT COUNT(*) AS c FROM mosaics");
  const _mosArchUpsertStmt = db.prepare(
    "INSERT OR REPLACE INTO mosaics_archive (no, namespace, name, creator, description, divisibility, supply, transferable, height, time_stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const _mosArchCountStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM mosaics_archive",
  );
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
  const _pollUpsertStmt = db.prepare(
    "INSERT OR REPLACE INTO polls (id, address, title, type, doe) VALUES (?, ?, ?, ?, ?)",
  );
  const _pollSelectStmt = db.prepare(
    "SELECT id, address, title, type, doe FROM polls ORDER BY doe DESC LIMIT ? OFFSET ?",
  );
  const _pollCountStmt = db.prepare("SELECT COUNT(*) AS c FROM polls");
  const _accUpsertStmt = db.prepare(
    "INSERT OR REPLACE INTO richlist (rank, address, balance, info) VALUES (?, ?, ?, ?)",
  );
  const _accSelectStmt = db.prepare(
    "SELECT rank, address, balance, info FROM richlist ORDER BY rank ASC LIMIT ? OFFSET ?",
  );
  const _accCountStmt = db.prepare("SELECT COUNT(*) AS c FROM richlist");
  const _metaUpsertStmt = db.prepare(
    "INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)",
  );
  const _metaSelectStmt = db.prepare(
    "SELECT value FROM cache_meta WHERE key = ?",
  );
  const _dailyTxBumpStmt = db.prepare(`
    INSERT INTO daily_tx_counts (date, tx_count, block_count) VALUES (?, ?, 1)
    ON CONFLICT(date) DO UPDATE SET tx_count = tx_count + excluded.tx_count, block_count = block_count + 1
  `);
  const _dailyTxRecentStmt = db.prepare(
    "SELECT date, tx_count FROM daily_tx_counts ORDER BY date DESC LIMIT ?",
  );
  const _blockUpsertStmt = db.prepare(
    "INSERT OR REPLACE INTO blocks (height, time_stamp, raw) VALUES (?, ?, ?)",
  );
  const _blockSelectStmt = db.prepare(
    "SELECT raw FROM blocks WHERE height = ?",
  );
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
  const _exFlowByAddressStmt = db.prepare(`
    SELECT date, inflow, outflow
    FROM exchange_daily_flows
    WHERE address = ?
    ORDER BY date DESC
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

  return {
    db,
    getCachedNamespaces: (limit = 25, offset = 0) => _nsSelectStmt.all(limit, offset),
    getCachedNamespacesCount: () => _nsCountStmt.get().c,
    getArchivedNamespacesCount: () => _nsArchCountStmt.get().c,
    getNamespacesWithArchive: (limit = 25, offset = 0) => _nsCombinedSelectStmt.all(limit, offset),
    getNamespacesWithArchiveCount: () => _nsCombinedCountStmt.get().c,
    getNamespaceByFqn: (fqn) => _nsLiveByFqnStmt.get(fqn) || _nsArchByFqnStmt.get(fqn) || null,
    getCachedMosaics: (limit = 25, offset = 0) => _mosSelectStmt.all(limit, offset),
    getCachedMosaicsCount: () => _mosCountStmt.get().c,
    getArchivedMosaicsCount: () => _mosArchCountStmt.get().c,
    getMosaicsWithArchive: (limit = 25, offset = 0) => _mosCombinedSelectStmt.all(limit, offset),
    getMosaicsWithArchiveCount: () => _mosCombinedCountStmt.get().c,
    getMosaicsByNamespace: (fqn) => _mosByNamespaceStmt.all(fqn, fqn),
    getMosaicByNsAndName: (namespace, name) =>
      _mosByNsAndNameStmt.get(namespace, name, namespace, name) || null,
    getMosaicTransfers: (limit = 25, offset = 0, ns = null, m = null) =>
      ns && m
        ? _mtSelectByMosaicStmt.all(ns, m, limit, offset)
        : _mtSelectAllStmt.all(limit, offset),
    getMosaicTransfersCount: (ns = null, m = null) =>
      (ns && m ? _mtCountByMosaicStmt.get(ns, m) : _mtCountAllStmt.get()).c,
    getMaxMosaicTransferNo: () => _mtMaxNoStmt.get().maxNo,
    getTxTypeArchive: (filterType, limit = 25, offset = 0) =>
      _ttaSelectStmt.all(filterType, limit, offset),
    getTxTypeArchiveCount: (filterType) => _ttaCountStmt.get(filterType).c,
    trimTxTypeArchive: (filterType, keep) => _ttaTrimStmt.run(filterType, filterType, keep),
    getCachedPolls: (limit = 25, offset = 0) => _pollSelectStmt.all(limit, offset),
    getCachedPollsCount: () => _pollCountStmt.get().c,
    getCachedRichList: (limit = 25, offset = 0) => _accSelectStmt.all(limit, offset),
    getCachedRichListCount: () => _accCountStmt.get().c,
    getCacheMeta: (key) => _metaSelectStmt.get(key)?.value ?? null,
    setCacheMeta: (key, value) => _metaUpsertStmt.run(key, String(value)),
    bumpDailyTxCount: (dateStr, txCount) => _dailyTxBumpStmt.run(dateStr, txCount),
    getDailyTxCounts: (limit) => _dailyTxRecentStmt.all(limit).reverse(),
    getCachedBlock: (height) => {
      const row = _blockSelectStmt.get(height);
      return row ? JSON.parse(row.raw) : null;
    },
    upsertBlock: (height, timeStamp, raw) => _blockUpsertStmt.run(height, timeStamp, raw),
    upsertNamespace: (id, fqn, owner, height) => _nsUpsertStmt.run(id, fqn, owner, height),
    upsertNamespaceArchive: (no, fqn, owner, height) => _nsArchUpsertStmt.run(no, fqn, owner, height),
    upsertMosaic: (id, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp) =>
      _mosUpsertStmt.run(id, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp),
    upsertMosaicArchive: (no, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp) =>
      _mosArchUpsertStmt.run(no, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp),
    upsertPoll: (id, address, title, type, doe) => _pollUpsertStmt.run(id, address, title, type, doe),
    upsertRichListEntry: (rank, address, balance, info) => _accUpsertStmt.run(rank, address, balance, info),
    upsertMosaicTransfer: (no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, timeStamp) =>
      _mtUpsertStmt.run(no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, timeStamp),
    upsertTxTypeArchive: (filterType, hash, height, sender, recipient, amount, fee, timeStamp, type) =>
      _ttaUpsertStmt.run(filterType, hash, height, sender, recipient, amount, fee, timeStamp, type),
    upsertExchangeAddress: (address, exchangeName, label) =>
      _exAddrUpsertStmt.run(address, exchangeName, label),
    // node:sqlite returns null-prototype rows; spread into a plain object so
    // assert.deepEqual (prototype-sensitive under node:assert/strict) can
    // compare them against plain object literals in tests.
    getExchangeAddresses: () => _exAddrAllStmt.all().map(r => ({ ...r })),
    getExchangeAddressesNeedingBackfill: () => _exAddrPendingStmt.all().map(r => ({ ...r })),
    markExchangeAddressBackfilled: (address) => _exAddrMarkBackfilledStmt.run(address),
    bumpExchangeDailyFlow: (date, address, inflow, outflow) =>
      _exFlowBumpStmt.run(date, address, inflow, outflow),
    getExchangeDailyFlows: (exchangeName, days) =>
      _exFlowByExchangeStmt.all(exchangeName, days).reverse().map(r => ({ ...r })),
    getExchangeDailyFlowsForAddress: (address, days) =>
      _exFlowByAddressStmt.all(address, days).reverse().map(r => ({ ...r })),
    getExchangeList: () => _exListStmt.all().map(r => ({ ...r })),
    getBlocksHeightRange: () => {
      const row = _blocksRangeStmt.get();
      return row ? { minHeight: row.minHeight, maxHeight: row.maxHeight } : { minHeight: null, maxHeight: null };
    },
    getBlocksInRange: (from, to) => _blocksInRangeStmt.all(from, to),
  };
}

const layers = {
  mainnet: openDbLayer(NETWORKS.mainnet.dbFile),
  testnet: openDbLayer(NETWORKS.testnet.dbFile),
};

function layer() {
  return layers[currentNetwork()];
}

// ── Read accessors ─────────────────────────────────────────────────────────────

export function getCachedNamespaces(limit = 25, offset = 0) {
  return layer().getCachedNamespaces(limit, offset);
}
export function getCachedNamespacesCount() {
  return layer().getCachedNamespacesCount();
}
export function getArchivedNamespacesCount() {
  return layer().getArchivedNamespacesCount();
}
export function getNamespacesWithArchive(limit = 25, offset = 0) {
  return layer().getNamespacesWithArchive(limit, offset);
}
export function getNamespacesWithArchiveCount() {
  return layer().getNamespacesWithArchiveCount();
}
export function getNamespaceByFqn(fqn) {
  return layer().getNamespaceByFqn(fqn);
}
export function getCachedMosaics(limit = 25, offset = 0) {
  return layer().getCachedMosaics(limit, offset);
}
export function getCachedMosaicsCount() {
  return layer().getCachedMosaicsCount();
}
export function getArchivedMosaicsCount() {
  return layer().getArchivedMosaicsCount();
}
export function getMosaicsWithArchive(limit = 25, offset = 0) {
  return layer().getMosaicsWithArchive(limit, offset);
}
export function getMosaicsWithArchiveCount() {
  return layer().getMosaicsWithArchiveCount();
}
export function getMosaicsByNamespace(fqn) {
  return layer().getMosaicsByNamespace(fqn);
}
export function getMosaicByNsAndName(namespace, name) {
  return layer().getMosaicByNsAndName(namespace, name);
}
export function getMosaicTransfers(limit = 25, offset = 0, ns = null, m = null) {
  return layer().getMosaicTransfers(limit, offset, ns, m);
}
export function getMosaicTransfersCount(ns = null, m = null) {
  return layer().getMosaicTransfersCount(ns, m);
}
export function getMaxMosaicTransferNo() {
  return layer().getMaxMosaicTransferNo();
}
export function getTxTypeArchive(filterType, limit = 25, offset = 0) {
  return layer().getTxTypeArchive(filterType, limit, offset);
}
export function getTxTypeArchiveCount(filterType) {
  return layer().getTxTypeArchiveCount(filterType);
}
export function trimTxTypeArchive(filterType, keep) {
  layer().trimTxTypeArchive(filterType, keep);
}
export function getCachedPolls(limit = 25, offset = 0) {
  return layer().getCachedPolls(limit, offset);
}
export function getCachedPollsCount() {
  return layer().getCachedPollsCount();
}
export function getCachedRichList(limit = 25, offset = 0) {
  return layer().getCachedRichList(limit, offset);
}
export function getCachedRichListCount() {
  return layer().getCachedRichListCount();
}
export function getCacheMeta(key) {
  return layer().getCacheMeta(key);
}
export function setCacheMeta(key, value) {
  layer().setCacheMeta(key, value);
}
export function bumpDailyTxCount(dateStr, txCount) {
  layer().bumpDailyTxCount(dateStr, txCount);
}
export function getDailyTxCounts(limit) {
  return layer().getDailyTxCounts(limit);
}
export function getCachedBlock(height) {
  return layer().getCachedBlock(height);
}
export function upsertBlock(height, timeStamp, raw) {
  layer().upsertBlock(height, timeStamp, raw);
}

// ── Write wrappers (used by cache.js) ─────────────────────────────────────────

export function upsertNamespace(id, fqn, owner, height) {
  layer().upsertNamespace(id, fqn, owner, height);
}
export function upsertNamespaceArchive(no, fqn, owner, height) {
  layer().upsertNamespaceArchive(no, fqn, owner, height);
}
export function upsertMosaic(id, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp) {
  layer().upsertMosaic(id, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp);
}
export function upsertMosaicArchive(no, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp) {
  layer().upsertMosaicArchive(no, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp);
}
export function upsertPoll(id, address, title, type, doe) {
  layer().upsertPoll(id, address, title, type, doe);
}
export function upsertRichListEntry(rank, address, balance, info) {
  layer().upsertRichListEntry(rank, address, balance, info);
}
export function upsertMosaicTransfer(no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, timeStamp) {
  layer().upsertMosaicTransfer(no, hash, namespace, mosaic, quantity, divisibility, sender, recipient, timeStamp);
}
export function upsertTxTypeArchive(filterType, hash, height, sender, recipient, amount, fee, timeStamp, type) {
  layer().upsertTxTypeArchive(filterType, hash, height, sender, recipient, amount, fee, timeStamp, type);
}
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
export function getExchangeDailyFlowsForAddress(address, days) {
  return layer().getExchangeDailyFlowsForAddress(address, days);
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

// Exported for the rare cases where cache.js needs raw DB access
// (e.g. importMosaicArchive schema-upgrade check, refreshAllMosaicsDeep's
// distinct-namespace scan). Resolves to the current network's DatabaseSync
// instance — call it fresh each time rather than caching the result, since
// the current network can change between calls.
export function getDb() {
  return layer().db;
}
