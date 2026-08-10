# Auto node selection: pin the fastest node instead of reshuffling every call

## Problem

`nemFetch()` (`src/nemApi.js`) currently calls `getShuffledNodePool()` fresh on **every single invocation**. When no explicit node is chosen (the navbar's "Auto" option — no `nemscan-node` cookie), the sequential fetch path tries a freshly randomized order of up to `SEQUENTIAL_MAX_NODES` (8) pool entries every time.

`/txs` makes this visible: `GET /api/txs` calls `getHeight()` then `getTxsFromBlocks()`, which calls `getBlock()` (→ `nemFetch()`) repeatedly, in batches of 5, until 25 transactions are collected or a scan-depth/wall-clock cap is hit (`src/nemApi.js:170-209`). Each of these `nemFetch()` calls independently re-shuffles the pool, so a single page load can land on a different random node — including slow or dead ones — many times over. An unlucky shuffle burns real time (up to `DEFAULT_FETCH_TIMEOUT_MS` × 2 attempts per dead/slow node before falling through), and this compounds across the many batched calls one `/txs` load makes. `probeNode()` (`src/nodePool.js`) only checks liveness (boolean) today — there's no concept of "fast" anywhere in the codebase.

## Goal

When no explicit node is selected (Auto), the app should consistently use the node that responds fastest, rather than gambling on a fresh random order every call. That choice should stay fixed until either the user explicitly picks a different node from the dropdown, or the pinned node is next re-evaluated and no longer clearly the fastest (see Hysteresis below) — not re-randomized on every fetch.

## Non-goals

- No change to explicit node selection (`nemscan-node` cookie) — it still always wins, unchanged.
- No change to race mode (`options.race = true`, used only by `fetchNamespacesFromNode()`) — it already fires several candidates in parallel via `Promise.any`, so a single slow node in the set doesn't stall it the way sequential fetch does.
- No change to the fallback slots (2nd attempt onward) in the sequential path — they keep using the existing random shuffle. Only the *first* attempt becomes deterministic.
- No change to `/nodes` page or dropdown protocol badges (separate, already in-flight `mixed-protocol-node-pool` work).
- No minimum-pool-size threshold, no weighting between HTTP/HTTPS candidates — unrelated to this change.

## Architecture

### Where the pinned node lives

`src/nodePool.js`'s existing 5-minute `refreshNodeOptions()` cycle (per network: mainnet/testnet) is extended to also measure response latency and derive a server-wide "auto best node," alongside its existing liveness probing:

```
state[network] = {
  nodeOptions: [...],            // unchanged: verified candidates
  nodeOptionsUpdatedAt: ...,     // unchanged
  refreshing: false,             // unchanged
  autoBestNode: null,            // new: { name, host, endpoint, protocol, latencyMs } | null
}
```

`getAutoBestNode(network = currentNetwork())` is a new export returning `state[network].autoBestNode`.

### Measuring latency

`probeNode(url, timeoutMs)` changes its return type from `boolean` to `{ ok: boolean, latencyMs: number | null }`, timing the existing `/chain/height` fetch it already performs (no extra network round trip):

```js
export async function probeNode(url, timeoutMs = NODE_PROBE_TIMEOUT_MS) {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/chain/height`, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, latencyMs: null };
    const data = await res.json();
    const ok = Number.isFinite(data?.height);
    return { ok, latencyMs: ok ? Date.now() - startedAt : null };
  } catch {
    return { ok: false, latencyMs: null };
  } finally {
    clearTimeout(t);
  }
}
```

`refreshNodeOptions()` stores `latencyMs` on each verified candidate and, after building `verified`, computes the fastest entry and updates `autoBestNode` per the hysteresis rule below.

### Hysteresis

A newly-measured fastest candidate only replaces the current `autoBestNode` if:

- there is no current `autoBestNode` (cold start / first successful refresh), **or**
- the current `autoBestNode`'s endpoint is no longer present in this refresh's `verified` list (it went down or dropped out — forced replacement, no margin required), **or**
- the new candidate's `latencyMs` is at least `AUTO_BEST_NODE_HYSTERESIS_MS` (150ms, new constant in `src/constants.js`) faster than the current `autoBestNode`'s recorded `latencyMs`.

Otherwise `autoBestNode` is left as-is, even if a slightly-faster node was measured this cycle. This avoids flapping between near-identical nodes every 5 minutes.

### `nemFetch()` changes (`src/nemApi.js`)

Sequential path only:

```js
const preferred = nodeContext.getStore();
const autoBest = !preferred ? getAutoBestNode() : null;
const primary = preferred?.endpoint || autoBest?.endpoint;
const shuffled = getShuffledNodePool().slice(0, SEQUENTIAL_MAX_NODES);
const pool = primary ? [primary, ...shuffled.filter((n) => n !== primary)] : shuffled;
```

- Explicit cookie (`preferred`) still always wins and is tried first, unchanged.
- With no cookie, `autoBestNode` (if known) is tried first instead of a random pool entry.
- Remaining slots (fallback if the primary fails) keep today's random-shuffle order, capped at `SEQUENTIAL_MAX_NODES` — unchanged resilience characteristics.
- Cold start (`autoBestNode` is `null`, before the first refresh completes): `primary` is `undefined`, so behavior is identical to today's pure shuffle.

Race path (`fetchNamespacesFromNode()`): unchanged, still uses `getShuffledNodePool()` directly.

## UI copy

`src/html.js:115` — the "Auto" dropdown item's sub-label currently reads `"randomized node pool"`, which becomes inaccurate. Update to `"fastest available node"`.

## Error handling

No new failure modes. If `autoBestNode`'s endpoint fails at request time (e.g. it degraded between refreshes), the existing sequential fallback logic already tries the next pool entry — unchanged from today's behavior when any first-choice node fails.

## Testing

`test/nodePool.test.js` (extend, following existing `t.mock.method(global, "fetch", ...)` patterns):

- `probeNode()` returns `{ ok: true, latencyMs: <number> }` on a successful response, and `{ ok: false, latencyMs: null }` on failure/timeout.
- After `refreshNodeOptions()`, `getAutoBestNode(network)` is the verified candidate with the lowest `latencyMs`.
- Hysteresis: a second `refreshNodeOptions()` run with a marginally faster candidate (< 150ms improvement) does not change `getAutoBestNode()`.
- Forced replacement: a second run where the previous `autoBestNode`'s endpoint is no longer in the verified set replaces `autoBestNode` immediately, regardless of margin.
- Per-network independence via `networkContext.run("testnet", ...)`, following the existing pattern.

`test/nemApi.test.js` (extend):

- With no `nodeContext` preferred node and a known `autoBestNode`, the sequential path's first fetch attempt targets `autoBestNode.endpoint`.
- With a `nodeContext` preferred node set, it is tried first regardless of `autoBestNode`.
- With `autoBestNode` as `null` (cold start), behavior matches today's pure-shuffle sequential path.
