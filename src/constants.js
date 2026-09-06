// Small hardcoded safety net used only when the dynamic node pool
// (src/nodePool.js) has no verified entries yet — cold start before the
// first refresh completes, or a sustained nodewatch.symbol.tools outage.
export const NEM_NODES_FALLBACK = [
  "https://nebuta.kasanetalk.net:7891",
  "https://tanabata.kasanetalk.net:7891",
  "https://hanabi.kasanetalk.net:7891",
];

export const NEM_EPOCH_MS = 1427587585000;

// In-memory LRU cache for recently fetched blocks (avoids redundant node requests).
export const blockCache = new Map();

// Number of most-recent calendar days (UTC, including today) shown in the
// home page's "TXNS / DAY" chart.
export const DAILY_TX_DAYS = 7;

// NEM's total XEM supply was fixed at genesis and never changes — harvesting
// only redistributes transaction fees, it doesn't mint new XEM.
export const XEM_TOTAL_SUPPLY = 8_999_999_999;

export const TX_TYPES = {
  257: "Transfer",
  2049: "Importance",
  4097: "Multisig Mod",
  4098: "Multisig Signature",
  4100: "Multisig",
  8193: "Namespace",
  16385: "Mosaic Def",
  16386: "Mosaic Supply",
};

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

export const DAILY_TX_BACKFILL_CHUNK = 60;

// Hard cap on how many blocks getTxsFromBlocks() will walk backward looking
// for `limit` transactions. Real tx density near the chain tip can be sparse
// enough that reaching the default limit (25) takes hundreds of blocks —
// each an uncached network round-trip — so without a cap a single request
// can take minutes. Bounding total scan depth trades a possibly-short first
// page (caller paginates further via the returned nextFromBlock) for a
// bounded worst-case latency.
export const MAX_BLOCK_SCAN_DEPTH = 500;

// Wall-clock companion to MAX_BLOCK_SCAN_DEPTH. A block-count cap alone
// doesn't bound latency: nemFetch() falls back sequentially through up to
// SEQUENTIAL_MAX_NODES nodes (DEFAULT_FETCH_TIMEOUT_MS each) before a single
// getBlock() call fails, so one unhealthy node in the pool can stall a batch
// for many seconds — and a sparse-density scan repeats that exposure up to
// 100 times per request. Checked between batches, so it stops the walk from
// compounding many such stalls into a load that never finishes, though it
// doesn't preempt a batch already in flight.
export const MAX_BLOCK_SCAN_MS = 8000;

// ── Network / fetch ───────────────────────────────────────────────────────────

// Default per-request timeout for sequential nemFetch calls.
export const DEFAULT_FETCH_TIMEOUT_MS = 3000;

// When all nodes are queried in parallel (race mode), allow more time since
// we only need *one* to respond — the slowest node doesn't set the deadline.
export const RACE_FETCH_TIMEOUT_MS = 20000;

// How long to back off after receiving a 429 (Too Many Requests) from a node.
export const RATE_LIMIT_RETRY_MS = 1500;

// Cap on how many pool candidates a single nemFetch() call will try. The
// dynamic pool (src/nodePool.js) can have up to ~100 verified nodes — without
// a cap, race mode would fan out to all of them per call (multiplying load
// on the very endpoints this feature exists to protect) and a total-pool
// outage in sequential mode would take proportionally longer to report as
// failed. Race mode is still fully shuffled before slicing, so repeated
// calls spread across the whole pool over time. The sequential path's first
// slot is different: in Auto mode (no explicit node picked) it's the pinned
// autoBestNode (see nodePool.js), not a shuffle result — only the remaining
// fallback slots are drawn from a fresh shuffle.
export const RACE_MAX_NODES = 5;
export const SEQUENTIAL_MAX_NODES = 8;

// ── Block cache ───────────────────────────────────────────────────────────────

// Maximum number of blocks kept in the in-process LRU cache before eviction.
export const BLOCK_CACHE_MAX_SIZE = 500;

// ── Background refresh / archive import ──────────────────────────────────────

// Milliseconds to wait between paginated nemtool archive fetches to avoid
// hammering their API. Used in importNamespaceArchive, importMosaicArchive,
// and scanBlockHeightsForDailyTx.
export const ARCHIVE_PAGE_DELAY_MS = 150;

// Milliseconds to wait between batches during the deep mosaic refresh.
export const DEEP_REFRESH_BATCH_DELAY_MS = 200;

// Timeout for probing whether a discovered node candidate answers on a given protocol.
export const NODE_PROBE_TIMEOUT_MS = 6000;

// Minimum latency improvement (ms) a new candidate must show over the
// current autoBestNode's fresh measurement in the same refresh cycle before
// it replaces it — prevents flapping between near-identical nodes every
// 5-minute refresh. Does not apply when the current autoBestNode has
// dropped out of the verified pool entirely (see updateAutoBestNode in
// nodePool.js), which always replaces immediately.
export const AUTO_BEST_NODE_HYSTERESIS_MS = 150;

// ── Networks (mainnet / testnet) ────────────────────────────────────────────────

// Verified reachable over HTTPS (2026-08-09).
export const NEM_TESTNET_NODES_FALLBACK = [
  "https://ntn1.dusanjp.com:7891",
  "https://ntn2.dusanjp.com:7891",
];

// Directory holding the SQLite cache files. Overridable via
// NEMSCAN_DB_DIR (e.g. so tests can point at a throwaway temp directory
// instead of the real cache.db / cache-testnet.db in the repo root).
const DB_DIR = process.env.NEMSCAN_DB_DIR || ".";

export const NETWORKS = {
  mainnet: {
    label: "Mainnet",
    nodeSourceApi: "https://nodewatch.symbol.tools/api/nem/nodes",
    fallbackNodes: NEM_NODES_FALLBACK,
    addressNetworkByte: 0x68,
    dbFile: `${DB_DIR}/cache.db`,
  },
  testnet: {
    label: "Testnet",
    nodeSourceApi: "https://nodewatch.symbol.tools/testnet/api/nem/nodes",
    fallbackNodes: NEM_TESTNET_NODES_FALLBACK,
    addressNetworkByte: 0x98,
    dbFile: `${DB_DIR}/cache-testnet.db`,
  },
};

// Substring-matched (case-insensitive) against nemnodes.org richlist `info`
// labels (e.g. "Coincheck -- Exchange", "Zaif -- Cold Wallet") to identify
// which richlist addresses belong to a known exchange. Deliberately a fixed
// list rather than "any non-empty info value" — labels like "Protocol
// Treasury Account" or contributor names must not be picked up.
export const KNOWN_EXCHANGE_NAMES = [
  "Binance", "Bittrex", "Coincheck", "Zaif", "Poloniex", "HitBTC",
  "Kucoin", "Cryptopia", "Yobit", "Kuna", "Qryptos", "Coinsuper",
  "Upbit", "Huobi", "Bitflyer",
];

// Addresses for exchanges that nemnodes.org's richlist never labels (so
// syncExchangeAddressesFromRichList's substring match against
// KNOWN_EXCHANGE_NAMES can never find them). Pinned here instead and synced
// by syncManualExchangeAddresses, which runs alongside the richlist sync.
export const MANUAL_EXCHANGE_ADDRESSES = [
  {
    address: "NBAAWBHKCDASQBQLG6H2Z3IM4TS4QYKYJBRHL2JL",
    exchangeName: "Poloniex",
    label: "Poloniex (manual — unlabeled on nemnodes.org richlist)",
  },
  {
    address: "NAGJG3QFWYZ37LMI7IQPSGQNYADGSJZGJRD2DIYA",
    exchangeName: "Zaif",
    label: "Zaif (manual — unlabeled on nemnodes.org richlist)",
  },
];

// Height-range size for one chunk of the local blocks-table backfill scan
// that runs when a new exchange address is discovered (see
// backfillNewExchangeAddresses in cache.js). This is a local SQLite read,
// not a network call, so it can be far larger than the network-bound
// DAILY_TX_BACKFILL_CHUNK (60).
export const EXCHANGE_BACKFILL_CHUNK_HEIGHTS = 5000;
