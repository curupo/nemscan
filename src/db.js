import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("./cache.db");
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

// ── Prepared statements (private) ─────────────────────────────────────────────

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
const _dailyTxOldestStmt = db.prepare(
  "SELECT MIN(date) AS d FROM daily_tx_counts",
);

// ── Read accessors ─────────────────────────────────────────────────────────────

export function getCachedNamespaces(limit = 25, offset = 0) {
  return _nsSelectStmt.all(limit, offset);
}

export function getCachedNamespacesCount() {
  return _nsCountStmt.get().c;
}

export function getArchivedNamespacesCount() {
  return _nsArchCountStmt.get().c;
}

export function getNamespacesWithArchive(limit = 25, offset = 0) {
  return _nsCombinedSelectStmt.all(limit, offset);
}

export function getNamespacesWithArchiveCount() {
  return _nsCombinedCountStmt.get().c;
}

export function getNamespaceByFqn(fqn) {
  return _nsLiveByFqnStmt.get(fqn) || _nsArchByFqnStmt.get(fqn) || null;
}

export function getCachedMosaics(limit = 25, offset = 0) {
  return _mosSelectStmt.all(limit, offset);
}

export function getCachedMosaicsCount() {
  return _mosCountStmt.get().c;
}

export function getArchivedMosaicsCount() {
  return _mosArchCountStmt.get().c;
}

export function getMosaicsWithArchive(limit = 25, offset = 0) {
  return _mosCombinedSelectStmt.all(limit, offset);
}

export function getMosaicsWithArchiveCount() {
  return _mosCombinedCountStmt.get().c;
}

export function getMosaicsByNamespace(fqn) {
  return _mosByNamespaceStmt.all(fqn, fqn);
}

export function getMosaicByNsAndName(namespace, name) {
  return _mosByNsAndNameStmt.get(namespace, name, namespace, name) || null;
}

export function getCachedPolls(limit = 25, offset = 0) {
  return _pollSelectStmt.all(limit, offset);
}

export function getCachedPollsCount() {
  return _pollCountStmt.get().c;
}

export function getCachedRichList(limit = 25, offset = 0) {
  return _accSelectStmt.all(limit, offset);
}

export function getCachedRichListCount() {
  return _accCountStmt.get().c;
}

export function getCacheMeta(key) {
  return _metaSelectStmt.get(key)?.value ?? null;
}

export function setCacheMeta(key, value) {
  _metaUpsertStmt.run(key, String(value));
}

export function bumpDailyTxCount(dateStr, txCount) {
  _dailyTxBumpStmt.run(dateStr, txCount);
}

export function getDailyTxCounts(limit) {
  return _dailyTxRecentStmt.all(limit).reverse();
}

export function getOldestDailyTxDate() {
  return _dailyTxOldestStmt.get().d;
}

// ── Write wrappers (used by cache.js) ─────────────────────────────────────────

export function upsertNamespace(id, fqn, owner, height) {
  _nsUpsertStmt.run(id, fqn, owner, height);
}

export function upsertNamespaceArchive(no, fqn, owner, height) {
  _nsArchUpsertStmt.run(no, fqn, owner, height);
}

export function upsertMosaic(id, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp) {
  _mosUpsertStmt.run(id, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp);
}

export function upsertMosaicArchive(no, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp) {
  _mosArchUpsertStmt.run(no, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp);
}

export function upsertPoll(id, address, title, type, doe) {
  _pollUpsertStmt.run(id, address, title, type, doe);
}

export function upsertRichListEntry(rank, address, balance, info) {
  _accUpsertStmt.run(rank, address, balance, info);
}

// Exported for the rare cases where cache.js needs raw DB access
// (e.g. importMosaicArchive schema-upgrade check).
export { db };
