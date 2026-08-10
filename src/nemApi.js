import { nodeContext, currentNetwork } from "./context.js";
import { getShuffledNodePool, getAutoBestNode, demoteAutoBestNode } from "./nodePool.js";
import {
  blockCache,
  DEFAULT_FETCH_TIMEOUT_MS,
  RACE_FETCH_TIMEOUT_MS,
  RATE_LIMIT_RETRY_MS,
  BLOCK_CACHE_MAX_SIZE,
  RACE_MAX_NODES,
  SEQUENTIAL_MAX_NODES,
  MAX_BLOCK_SCAN_DEPTH,
  MAX_BLOCK_SCAN_MS,
} from "./constants.js";

// ── Core fetch ────────────────────────────────────────────────────────────────

/**
 * Fetch a NEM NIS endpoint, returning parsed JSON.
 *
 * Two strategies are available via `options.race`:
 *
 * - **Sequential (default)**: tries each node in the pool one by one,
 *   honouring the user's preferred node (set via the node-switch cookie) and
 *   retrying once on HTTP 429.  Good for all normal API calls.
 *
 * - **Race** (`options.race = true`): fires every node in parallel and returns
 *   whichever responds first.  Used for notoriously slow endpoints like
 *   `/namespace/root/page` where sequential retries would pay the full
 *   `timeoutMs` cost for each laggard before reaching a fast node.
 */
export async function nemFetch(
  path,
  options = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
) {
  const { race: useRace, ...fetchOptions } = options;

  if (useRace) {
    const attempts = getShuffledNodePool().slice(0, RACE_MAX_NODES).map(async (node) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${node}${path}`, {
          ...fetchOptions,
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(t);
      }
    });
    try {
      return await Promise.any(attempts);
    } catch {
      throw new Error("All NEM nodes failed");
    }
  }

  // Sequential: try the user's explicit preferred node first if set,
  // otherwise the auto-selected fastest node (autoBestNode — stays fixed
  // across calls until the next refresh decisively beats it or it drops out
  // of the pool, see nodePool.js). Either way, fall back through a freshly
  // shuffled pool for subsequent attempts so a single dead first choice
  // doesn't need a second refresh cycle to route around.
  const preferred = nodeContext.getStore();
  const autoBest = preferred ? null : getAutoBestNode();
  const primary = preferred?.endpoint || autoBest?.endpoint;
  const shuffled = getShuffledNodePool().slice(0, SEQUENTIAL_MAX_NODES);
  const pool = primary
    ? [primary, ...shuffled.filter((n) => n !== primary)]
    : shuffled;
  for (const node of pool) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${node}${path}`, {
          ...fetchOptions,
          signal: ctrl.signal,
        });
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
          await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
          continue;
        }
        break;
      } catch {
        clearTimeout(t);
        break;
      }
    }
    // This node exhausted its attempts without succeeding. If it was the
    // pinned autoBestNode, demote it immediately rather than waiting up to
    // 5 minutes for the next refreshNodeOptions() cycle to notice — every
    // Auto-mode call would otherwise keep paying a full failed-attempt cost
    // against a dead pin until then. Only ever matches on the first
    // outer-loop iteration: `primary` (which equals autoBest?.endpoint
    // whenever preferred is unset) is filtered out of the rest of `pool`.
    // Never fires when an explicit preferred node is set, since autoBest is
    // null in that case.
    if (node === autoBest?.endpoint) {
      demoteAutoBestNode(node);
    }
  }
  throw new Error("All NEM nodes failed");
}

// ── Chain ─────────────────────────────────────────────────────────────────────

export async function getHeight() {
  const d = await nemFetch("/chain/height");
  return d.height;
}

export async function fetchBlockRaw(height) {
  return nemFetch("/block/at/public", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ height }),
  });
}

export async function getBlock(height) {
  const key = `${currentNetwork()}:${height}`;
  if (blockCache.has(key)) return blockCache.get(key);
  const block = await fetchBlockRaw(height);
  blockCache.set(key, block);
  if (blockCache.size > BLOCK_CACHE_MAX_SIZE)
    blockCache.delete(blockCache.keys().next().value);
  return block;
}

export async function fetchNamespacesFromNode() {
  // NB: the official param name is the lowercase `pagesize` (not `pageSize`).
  // Cursor-based paging via `id` is unfortunately broken on every known node
  // (times out or "could not extract ResultSet"), so we only fetch page one.
  // Race mode is used here because this endpoint is very slow on most nodes.
  return nemFetch(
    `/namespace/root/page?pagesize=25`,
    { race: true },
    RACE_FETCH_TIMEOUT_MS,
  );
}

// ── Account ───────────────────────────────────────────────────────────────────

export async function getAccount(address) {
  return nemFetch(`/account/get?address=${encodeURIComponent(address)}`);
}

export async function getAccountTxs(address, id = null) {
  const extra = id ? `&id=${id}` : "";
  return nemFetch(
    `/account/transfers/all?address=${encodeURIComponent(address)}${extra}`,
  );
}

export async function getAccountHarvests(address) {
  return nemFetch(`/account/harvests?address=${encodeURIComponent(address)}`);
}

export async function getAccountMosaics(address) {
  return nemFetch(
    `/account/mosaic/owned?address=${encodeURIComponent(address)}`,
  );
}

export async function getAccountNamespaces(address) {
  return nemFetch(
    `/account/namespace/page?address=${encodeURIComponent(address)}`,
  );
}

// ── Block scanning ────────────────────────────────────────────────────────────

// Walks blocks downward from `fromHeight`, collecting transactions until
// `limit` is reached or the chain bottom is hit.
export async function getTxsFromBlocks(fromHeight, limit = 25) {
  const items = [];
  let h = fromHeight;
  const startedAt = Date.now();

  while (items.length < limit && h >= 1) {
    const batchSize = Math.min(5, h);
    const heights = Array.from({ length: batchSize }, (_, i) => h - i);
    const blocks = await Promise.all(
      heights.map((bh) => getBlock(bh).catch(() => null)),
    );

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

    // Safety: cap total scan depth regardless of how many transactions
    // we've found so far — sparse tx density can otherwise keep this
    // walking (and round-tripping to a node) for hundreds of blocks past
    // any reasonable page-load budget. Caller paginates further via
    // nextFromBlock.
    if (fromHeight - h >= MAX_BLOCK_SCAN_DEPTH) break;

    // Safety: also cap wall-clock time. A block-count cap alone assumes
    // every batch is fast, but one unhealthy node in the pool can stall a
    // single batch for many seconds (nemFetch falls back through several
    // nodes before giving up) — and this loop repeats that exposure up to
    // 100 times when density is sparse. Bail out on elapsed time too so a
    // few slow batches can't compound into a request that never finishes.
    if (Date.now() - startedAt >= MAX_BLOCK_SCAN_MS) break;
  }

  return { items, nextFromBlock: h };
}
