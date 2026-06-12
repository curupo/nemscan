import { nodeContext } from "./context.js";
import {
  NEM_NODES,
  blockCache,
  DEFAULT_FETCH_TIMEOUT_MS,
  RACE_FETCH_TIMEOUT_MS,
  RATE_LIMIT_RETRY_MS,
  BLOCK_CACHE_MAX_SIZE,
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
    const attempts = NEM_NODES.map(async (node) => {
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

  // Sequential: try preferred node first, then fall back through the pool.
  const preferred = nodeContext.getStore();
  const pool = preferred
    ? [preferred.endpoint, ...NEM_NODES.filter((n) => n !== preferred.endpoint)]
    : NEM_NODES;
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
  if (blockCache.has(height)) return blockCache.get(height);
  const block = await fetchBlockRaw(height);
  blockCache.set(height, block);
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

    // Safety: if we've scanned many empty blocks, stop
    if (items.length === 0 && fromHeight - h > 200) break;
  }

  return { items, nextFromBlock: h };
}
