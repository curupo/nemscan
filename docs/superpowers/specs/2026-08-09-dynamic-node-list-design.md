# Dynamic NEM node pool (replace fixed kasanetalk.net list)

## Problem

`src/constants.js` hardcodes `NEM_NODES`, a fixed list of 10 `kasanetalk.net` HTTPS endpoints. `nemFetch()` (`src/nemApi.js`) walks this array **in fixed order** whenever no per-request preferred node is set (i.e. no `nemscan-node` cookie), which is true for:

- Every visitor without a node-switch cookie.
- Every background refresh job (`refreshNamespacesCache`, `refreshMosaicsCache`, `refreshLiveRichList`, `refreshAllMosaicsDeep`, `refreshDailyTxStats`, …) — these run outside request scope, so `nodeContext.getStore()` is always empty for them.

Both cases always try `NEM_NODES[0]` (`nebuta.kasanetalk.net`) first and only fail over to the next node on error/timeout/429. In practice this concentrates almost all traffic on one operator-owned node instead of spreading it across the pool, and ties the app's reliability to 10 specific hosts we don't control.

Separately, `src/cache.js` already has a **dynamic**, verified node pool (`httpsNodeOptions`) used only for the navbar's node-switch dropdown — sourced from the NEM SuperNode Program API (`nem.io/supernode/api`), refreshed every 5 minutes, HTTPS-probed via `/chain/height` before being trusted.

## Goals

1. Remove `NEM_NODES` as the primary node pool for `nemFetch()`; use a dynamic, health-checked pool instead.
2. Randomize (shuffle) node selection order on every `nemFetch()` call, so load spreads across the pool instead of always hitting the same node first.
3. Switch the dynamic pool's data source from `nem.io/supernode/api` to `https://nodewatch.symbol.tools/api/nem/nodes`.
4. Keep a small hardcoded fallback list for resilience when the dynamic source is unavailable (cold start, third-party API outage).
5. No behavior change to: per-request node-switch cookie override, per-node retry/429/timeout handling, `race` mode semantics (still fires all pool candidates in parallel).

## Non-goals

- No minimum-pool-size threshold — any number of verified nodes (including 1) is used as-is; no merging with the fallback list "just in case."
- No change to how individual node failures are retried within `nemFetch` (429 retry, 2-attempt-per-node logic stays as-is).
- No blocking of server startup on the first dynamic-pool refresh (stays fire-and-forget, same as today).

## Architecture

New module `src/nodePool.js` owns all node-discovery/health logic, moved out of `src/cache.js` to avoid a circular import (`cache.js` already imports `nemFetch` etc. from `nemApi.js`; `nemApi.js` needs the dynamic pool, so that logic can't live in `cache.js`).

```
src/nodePool.js  (new)
  ├─ NODE_SOURCE_API = "https://nodewatch.symbol.tools/api/nem/nodes"
  ├─ getKnownNemNodes()          — renamed from getActiveSupernodes(); GET NODE_SOURCE_API
  ├─ probeHttpsNode(host)        — moved from cache.js, unchanged
  ├─ refreshHttpsNodeOptions()   — moved from cache.js, unchanged logic
  ├─ httpsNodeOptions / httpsNodeOptionsUpdatedAt — moved from cache.js
  ├─ findNodeOption(endpoint)    — moved from cache.js, unchanged
  └─ getShuffledNodePool()       — new

src/nemApi.js
  └─ nemFetch() uses getShuffledNodePool() instead of importing NEM_NODES directly

src/cache.js, index.js
  └─ import httpsNodeOptions / refreshHttpsNodeOptions / findNodeOption from ./nodePool.js instead of ./cache.js (function names unchanged, just relocated)

src/constants.js
  └─ NEM_NODES renamed to NEM_NODES_FALLBACK, trimmed to 2-3 kasanetalk.net hosts (safety net only, no longer the primary pool)
```

### `getShuffledNodePool()`

```js
export function getShuffledNodePool() {
  const base = httpsNodeOptions.length > 0
    ? httpsNodeOptions.map((n) => n.endpoint)
    : NEM_NODES_FALLBACK;
  return shuffle([...base]); // Fisher-Yates, fresh copy each call
}
```

- Uses the dynamic, HTTPS-probed pool whenever it has at least one entry — no minimum-size threshold.
- Falls back to `NEM_NODES_FALLBACK` only when `httpsNodeOptions` is empty (cold start before first successful refresh, or sustained `nodewatch.symbol.tools` outage where no cached pool exists yet).
- Called fresh on every `nemFetch()` invocation, so each call gets an independently shuffled order — this is what spreads load across the pool instead of always starting from the same node.

### `nemFetch()` changes (`src/nemApi.js`)

Both the sequential path and the `race` path replace their direct `NEM_NODES` reference with `getShuffledNodePool()`:

```js
const pool = getShuffledNodePool();
const finalPool = preferred
  ? [preferred.endpoint, ...pool.filter((n) => n !== preferred.endpoint)]
  : pool;
```

The node-switch cookie / `nodeContext` preferred-node override is unchanged — it still always wins when present.

## Data source change: `nem.io/supernode/api` → `nodewatch.symbol.tools`

Verified against live responses from both APIs (2026-08-09):

| | `nem.io/supernode/api` (current) | `nodewatch.symbol.tools/api/nem/nodes` (new) |
|---|---|---|
| Shape | top-level array | top-level array (same) |
| Fields used by our code | `endpoint`, `name` | `endpoint`, `name` (same names, same format `http://host:7890`) |
| Filtering | `?status=active` param respected, 85 nodes | query params silently ignored, always returns full set (102 nodes) |
| Scope | only nodes enrolled in the SuperNode Program | all nodes the crawler has discovered on the network, enrolled or not |

Since `refreshHttpsNodeOptions()` only reads `.endpoint` and `.name`, and still runs every candidate through `probeHttpsNode()` (live `/chain/height` check) before trusting it, dead or non-API nodes returned by the broader nodewatch dataset are filtered out the same way dead supernodes are today. The larger, more diverse candidate set (102 vs 85, not limited to one incentive program) is a net positive for load spread, which is the actual goal here.

Renaming to reflect the new semantics (was: "the SuperNode Program's enrollment service"; now: "a third-party crawler's known-node list"):

- `SUPERNODE_API` → `NODE_SOURCE_API`
- `getActiveSupernodes()` → `getKnownNemNodes()`
- Doc comment above these updated to describe nodewatch.symbol.tools instead of the SuperNode Program.

## UI copy affected

The word "supernode" appears throughout the `/nodes` page and its supporting chrome, all describing the same underlying data that's changing source and scope. Fixing only `nodesListHTML()`'s card title would leave it contradicting the page's own `<h1>` and browser tab title. Full set of copy to update, all "supernode(s)" → "node(s)":

| File:line | Current | New |
|---|---|---|
| `index.js:762` (page `<title>`) | `"Supernodes - NEMSCAN"` | `"Nodes - NEMSCAN"` |
| `index.js:766` (loading placeholder) | `"Fetching active supernodes…"` | `"Fetching active nodes…"` |
| `index.js:768` (meta description) | `"Browse active NEM supernodes on NEMSCAN. View node hosts, versions, and network status."` | `"Browse active NEM nodes on NEMSCAN. View node hosts, versions, and network status."` |
| `html.js:414` (`heroNodes()` `<h1>`) | `"Supernodes"` | `"Nodes"` |
| `html.js:105` (dropdown head) | `"Connect via active HTTPS supernodes"` | `"Connect via active HTTPS nodes"` |
| `html.js:111` (dropdown empty states) | `"No HTTPS-reachable supernodes right now"` / `"Probing active supernodes for HTTPS…"` | `"No HTTPS-reachable nodes right now"` / `"Probing active nodes for HTTPS…"` |
| `html.js:1772` (card title) | `"Active Supernodes"` | `"Active Nodes"` |
| `html.js:1769` (empty state) | `"No active supernodes found"` | `"No active nodes found"` |
| `html.js:1775` (attribution note) | links/credits `nem.io/supernode` | links/credits `nodewatch.symbol.tools` (`https://nodewatch.symbol.tools`), wording updated to "crawled node list" instead of "supernode" |

Route/section comments referencing "Supernode(s)" (`index.js:756`, `cache.js:151/153-154/166-167` → moved to `nodePool.js`) are updated for accuracy as part of the `nodePool.js` extraction (see Architecture section) — they described the old `nem.io` SuperNode Program semantics, which no longer apply.

Footer "Resources" link to `nem.io/supernodes/` (html.js:212) is left as-is — it's a general external link, not a data-provenance claim.

## Error handling

- Individual node failure inside `nemFetch` (timeout, non-2xx, 429 retry): unchanged from current behavior.
- Pool exhausted: unchanged, still throws `"All NEM nodes failed"`.
- `nodewatch.symbol.tools` unreachable during a scheduled `refreshHttpsNodeOptions()` run: caught and logged (existing `catch` block), `httpsNodeOptions` keeps its last-known-good value, so `getShuffledNodePool()` keeps serving the last verified dynamic pool. Only falls back to `NEM_NODES_FALLBACK` if this happens before any successful refresh has ever completed (cold start).

## Testing

- Unit test `getShuffledNodePool()`: returns fallback when `httpsNodeOptions` is empty; returns dynamic endpoints when populated; output is a shuffled permutation (same element set, order varies across calls).
- Unit/manual check on `nemFetch()`'s preferred-node composition: preferred endpoint always first, remainder shuffled, no duplicates.
- Manual: start server cold (before first `refreshHttpsNodeOptions` completes) and confirm pages load using `NEM_NODES_FALLBACK`; after refresh completes, confirm requests use the dynamic pool (e.g. via temporary logging of the chosen node).
- Manual: visit `/nodes` (or wherever `nodesListHTML` renders) and confirm updated copy/link.
