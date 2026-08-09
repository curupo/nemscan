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
  4100: "Multisig Sig",
  4099: "Multisig",
  8193: "Namespace",
  16385: "Mosaic Def",
  16386: "Mosaic Supply",
};

export const DAILY_TX_BACKFILL_CHUNK = 60;

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
// failed. Both paths shuffle before slicing, so repeated calls still spread
// across the whole pool over time — just fewer nodes per individual call.
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

// Timeout for probing whether a discovered node candidate speaks HTTPS.
export const NODE_PROBE_TIMEOUT_MS = 6000;
