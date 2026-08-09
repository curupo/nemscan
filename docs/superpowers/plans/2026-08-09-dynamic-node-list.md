# Dynamic NEM Node Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed 10-host `kasanetalk.net` node list with a shuffled, health-checked dynamic pool sourced from `nodewatch.symbol.tools`, so `nemFetch()` stops concentrating traffic on a single hardcoded node.

**Architecture:** Extract all node-discovery/health-check logic (currently split between `src/constants.js`'s static list and `src/cache.js`'s SuperNode-API polling) into a new `src/nodePool.js` module that both `src/nemApi.js` and `src/cache.js` can depend on without a circular import. `nemFetch()` calls a new `getShuffledNodePool()` on every invocation instead of reading the static `NEM_NODES` array.

**Tech Stack:** Node.js (ESM, `"type": "module"`), Express, native `fetch`, Node's built-in test runner (`node --test` / `node:test` / `node:assert/strict`) — no new dependencies.

## Global Constraints

- No new npm dependencies.
- No minimum-pool-size threshold in `getShuffledNodePool()` — any non-empty dynamic pool is used as-is; fallback list is used only when the dynamic pool is empty.
- The node-switch cookie / `nodeContext` preferred-node override must keep working unchanged: it always wins over the shuffled pool.
- `race` mode in `nemFetch()` must use the same dynamic pool as sequential mode.
- Every "supernode" reference in code comments and user-facing copy that describes the *new* nodewatch-sourced, non-enrollment-based data must be reworded to "node" (see Task 5) — do not leave mismatched wording on the same page.
- Full design rationale: `docs/superpowers/specs/2026-08-09-dynamic-node-list-design.md`.

---

## Task 1: Add the hardcoded fallback pool to `constants.js`

**Files:**
- Modify: `src/constants.js:1-12` (the `NEM_NODES` export), `src/constants.js:67` (comment)

**Interfaces:**
- Produces: `NEM_NODES_FALLBACK` (`string[]`) — consumed by Task 2's `src/nodePool.js`.

This task is purely additive. `NEM_NODES` (old name) is left in place so `src/nemApi.js` and `src/cache.js` keep working unmodified until Task 3/4 cut them over — the app must stay runnable after every task.

- [ ] **Step 1: Add `NEM_NODES_FALLBACK` above the existing `NEM_NODES` export**

In `src/constants.js`, insert immediately before line 1 (`export const NEM_NODES = [`):

```js
// Small hardcoded safety net used only when the dynamic node pool
// (src/nodePool.js) has no verified entries yet — cold start before the
// first refresh completes, or a sustained nodewatch.symbol.tools outage.
export const NEM_NODES_FALLBACK = [
  "https://nebuta.kasanetalk.net:7891",
  "https://tanabata.kasanetalk.net:7891",
  "https://hanabi.kasanetalk.net:7891",
];

```

Leave the existing `export const NEM_NODES = [...]` block below it untouched for now — it's removed in Task 4 once nothing imports it.

- [ ] **Step 2: Fix the now-inaccurate probe-timeout comment**

Change (`src/constants.js:67`, now shifted down by 8 lines from Step 1):

```js
// Timeout for probing whether a supernode candidate speaks HTTPS.
```

to:

```js
// Timeout for probing whether a discovered node candidate speaks HTTPS.
```

- [ ] **Step 3: Sanity-check the file still parses**

Run: `node --check src/constants.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/constants.js
git commit -m "Add NEM_NODES_FALLBACK safety-net constant

Additive only — old NEM_NODES stays in place until nemApi.js/cache.js
are cut over to the dynamic pool in later tasks."
```

---

## Task 2: Create `src/nodePool.js` with unit tests

**Files:**
- Create: `src/nodePool.js`
- Create: `test/nodePool.test.js`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `NEM_NODES_FALLBACK` (from Task 1's `src/constants.js`), `NODE_PROBE_TIMEOUT_MS` (already in `src/constants.js`).
- Produces (all consumed by later tasks):
  - `getKnownNemNodes(): Promise<Array<{endpoint: string, name?: string}>>`
  - `probeHttpsNode(host: string, timeoutMs?: number): Promise<boolean>`
  - `refreshHttpsNodeOptions(batchSize?: number): Promise<void>`
  - `httpsNodeOptions: Array<{name: string, host: string, endpoint: string}>` (live-binding export, starts `[]`)
  - `httpsNodeOptionsUpdatedAt: number | null` (live-binding export, starts `null`)
  - `findNodeOption(endpoint: string): {name, host, endpoint} | null`
  - `getShuffledNodePool(nodes?: Array<{endpoint: string}>): string[]` — defaults `nodes` to the live `httpsNodeOptions`; the optional parameter exists so tests can inject a pool without reaching into module-private state.

This module is entirely new and nothing imports it yet, so this task cannot break the running app — it's the TDD core of the feature.

- [ ] **Step 1: Write the failing tests**

Create `test/nodePool.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { getShuffledNodePool } from "../src/nodePool.js";
import { NEM_NODES_FALLBACK } from "../src/constants.js";

test("getShuffledNodePool falls back to NEM_NODES_FALLBACK when given an empty pool", () => {
  const result = getShuffledNodePool([]);
  assert.deepEqual([...result].sort(), [...NEM_NODES_FALLBACK].sort());
});

test("getShuffledNodePool returns the dynamic pool's endpoints when non-empty", () => {
  const dynamic = [
    { name: "a", host: "a:7891", endpoint: "https://a:7891" },
    { name: "b", host: "b:7891", endpoint: "https://b:7891" },
    { name: "c", host: "c:7891", endpoint: "https://c:7891" },
  ];
  const result = getShuffledNodePool(dynamic);
  assert.deepEqual(
    [...result].sort(),
    ["https://a:7891", "https://b:7891", "https://c:7891"].sort(),
  );
});

test("getShuffledNodePool shuffles using Math.random (Fisher-Yates)", (t) => {
  const seq = [0, 0, 0];
  let i = 0;
  t.mock.method(Math, "random", () => seq[i++]);
  const result = getShuffledNodePool([
    { endpoint: "A" },
    { endpoint: "B" },
    { endpoint: "C" },
    { endpoint: "D" },
  ]);
  assert.deepEqual(result, ["B", "C", "D", "A"]);
});

test("getShuffledNodePool does not mutate the array passed in", () => {
  const dynamic = [{ endpoint: "https://a:7891" }, { endpoint: "https://b:7891" }];
  const before = dynamic.map((n) => n.endpoint);
  getShuffledNodePool(dynamic);
  assert.deepEqual(dynamic.map((n) => n.endpoint), before);
});

test("findNodeOption returns null when no node matches", async () => {
  const { findNodeOption } = await import("../src/nodePool.js");
  assert.equal(findNodeOption("https://nonexistent:7891"), null);
});
```

- [ ] **Step 2: Add the test script to `package.json` and run the tests to verify they fail**

In `package.json`, change:

```json
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
```

to:

```json
  "scripts": {
    "test": "node --test"
  },
```

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/nodePool.js'` (file doesn't exist yet).

- [ ] **Step 3: Create `src/nodePool.js`**

```js
import { NODE_PROBE_TIMEOUT_MS, NEM_NODES_FALLBACK } from "./constants.js";

// ── Node discovery ────────────────────────────────────────────────────────────

// nodewatch.symbol.tools crawls the NEM network and publishes every node it
// discovers — not only nodes enrolled in any program. NIS1 nodes have no
// protocol-level concept of "supernode" status, so we query this
// third-party directory rather than a NIS node.
const NODE_SOURCE_API = "https://nodewatch.symbol.tools/api/nem/nodes";

export async function getKnownNemNodes() {
  const res = await fetch(NODE_SOURCE_API);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

// ── HTTPS node verification ───────────────────────────────────────────────────

// nodewatch only ever lists each node's plain-HTTP REST endpoint (host:7890);
// it never lists an "https://" entry. By NIS1 convention the same host
// commonly answers HTTPS one port up (host:7891 — exactly how our fallback
// pool in constants.js is configured), so we derive that candidate and probe
// it directly rather than trusting the registry.
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

// Refreshed on the same 5-minute cadence as the rest of the "live" data
// (see index.js's setInterval calls).
export async function refreshHttpsNodeOptions(batchSize = 12) {
  if (_refreshingHttpsNodeOptions) return;
  _refreshingHttpsNodeOptions = true;
  try {
    const nodes = await getKnownNemNodes();
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

// ── Shuffled pool for nemFetch ────────────────────────────────────────────────

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Returns a freshly shuffled copy of the current node pool: the dynamic,
// HTTPS-verified pool when it has at least one entry, else the hardcoded
// fallback (cold start, or a sustained nodewatch outage before any
// successful refresh has ever completed). Called fresh on every nemFetch()
// so load spreads across nodes instead of always starting from the same one.
//
// `nodes` defaults to the live httpsNodeOptions; tests pass an explicit
// array instead of reaching into this module's internal state.
export function getShuffledNodePool(nodes = httpsNodeOptions) {
  const base =
    nodes.length > 0 ? nodes.map((n) => n.endpoint) : NEM_NODES_FALLBACK;
  return shuffle([...base]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: `tests 5`, `pass 5`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/nodePool.js test/nodePool.test.js package.json
git commit -m "Add src/nodePool.js: dynamic node discovery + shuffled pool

New module, not yet wired into nemFetch(). Owns node discovery
(nodewatch.symbol.tools), HTTPS probing, and getShuffledNodePool() —
extracted ahead of moving the equivalent logic out of cache.js so the
circular-import-free ownership boundary is established first.

Also adds `npm test` (node --test) since this is the project's first
test file."
```

---

## Task 3: Cut `nemFetch()` over to the dynamic pool

**Files:**
- Modify: `src/nemApi.js:1-9` (imports), `src/nemApi.js:34-60` (`nemFetch` body)

**Interfaces:**
- Consumes: `getShuffledNodePool()` from Task 2's `src/nodePool.js`.

This is the actual behavior change: after this task, every `nemFetch()` call (both `race` and sequential paths) draws from the shuffled dynamic pool instead of the static `NEM_NODES` array. `src/constants.js` still exports the old `NEM_NODES` (untouched, unused after this task) — removed in Task 4.

- [ ] **Step 1: Update imports**

In `src/nemApi.js`, change:

```js
import { nodeContext } from "./context.js";
import {
  NEM_NODES,
  blockCache,
  DEFAULT_FETCH_TIMEOUT_MS,
  RACE_FETCH_TIMEOUT_MS,
  RATE_LIMIT_RETRY_MS,
  BLOCK_CACHE_MAX_SIZE,
} from "./constants.js";
```

to:

```js
import { nodeContext } from "./context.js";
import { getShuffledNodePool } from "./nodePool.js";
import {
  blockCache,
  DEFAULT_FETCH_TIMEOUT_MS,
  RACE_FETCH_TIMEOUT_MS,
  RATE_LIMIT_RETRY_MS,
  BLOCK_CACHE_MAX_SIZE,
} from "./constants.js";
```

- [ ] **Step 2: Replace the `race` path's node source**

Change:

```js
  if (useRace) {
    const attempts = NEM_NODES.map(async (node) => {
```

to:

```js
  if (useRace) {
    const attempts = getShuffledNodePool().map(async (node) => {
```

- [ ] **Step 3: Replace the sequential path's node source**

Change:

```js
  // Sequential: try preferred node first, then fall back through the pool.
  const preferred = nodeContext.getStore();
  const pool = preferred
    ? [preferred.endpoint, ...NEM_NODES.filter((n) => n !== preferred.endpoint)]
    : NEM_NODES;
```

to:

```js
  // Sequential: try preferred node first, then fall back through a freshly
  // shuffled pool so load spreads across nodes instead of always starting
  // from the same one.
  const preferred = nodeContext.getStore();
  const shuffled = getShuffledNodePool();
  const pool = preferred
    ? [preferred.endpoint, ...shuffled.filter((n) => n !== preferred.endpoint)]
    : shuffled;
```

- [ ] **Step 4: Run the test suite and a syntax check**

Run: `npm test && node --check src/nemApi.js`
Expected: existing 5 tests still pass (unaffected by this task); `node --check` prints nothing, exit 0.

- [ ] **Step 5: Manual smoke check**

Run: `node -e "import('./src/nodePool.js').then(async m => { await m.refreshHttpsNodeOptions(); console.log(m.httpsNodeOptions.length, 'verified nodes'); const { getHeight } = await import('./src/nemApi.js'); console.log('height:', await getHeight()); })"`

Expected: prints a verified-node count greater than 0 (may take a few seconds — it's probing live nodes) followed by `height: <a number>`. If it prints `0 verified nodes` the probe step may need more time on a slow connection; a `height` value still printing confirms the fallback pool works.

- [ ] **Step 6: Commit**

```bash
git add src/nemApi.js
git commit -m "Cut nemFetch() over to the shuffled dynamic node pool

Both race and sequential paths now draw from getShuffledNodePool()
instead of the static NEM_NODES array, so requests without a preferred
node no longer always start from the same hardcoded host."
```

---

## Task 4: Retire the old supernode code from `cache.js` and rewire consumers

**Files:**
- Modify: `src/cache.js:1-19` (imports), `src/cache.js:28-35` (imports), `src/cache.js:151-234` (delete block)
- Modify: `src/constants.js` (delete old `NEM_NODES` export)
- Modify: `index.js:5-23` (imports), `index.js:774-783` (`/api/nodes` route)
- Modify: `src/html.js:24` (import)

**Interfaces:**
- Consumes: `httpsNodeOptions`, `httpsNodeOptionsUpdatedAt`, `refreshHttpsNodeOptions`, `findNodeOption`, `getKnownNemNodes` — all now from `src/nodePool.js` (Task 2).

`src/cache.js` currently defines the SuperNode-derived pool; `src/nodePool.js` now duplicates that logic under new names. This task deletes the original from `cache.js` and points every consumer (`index.js`, `src/html.js`) at `nodePool.js` instead — all in one commit, since `cache.js`'s exports disappearing without updating its consumers in the same step would crash the app at import time.

This task also switches `/api/nodes` from a live, unverified `getKnownNemNodes()` call to the already-probed `httpsNodeOptions` cache: the route previously rendered a hardcoded "● Active" badge next to nodes nem.io had pre-filtered by `status=active`; nodewatch ignores that kind of filter and returns nodes regardless of whether they're actually reachable, so rendering straight from its response would make "● Active" false for dead nodes. `httpsNodeOptions` is the pool this project already verifies live via `probeHttpsNode()`, so reusing it keeps the badge honest and drops a redundant live external call on every page view.

- [ ] **Step 1: Delete the supernode/HTTPS block from `cache.js`**

Delete this entire block from `src/cache.js` (lines 151-235, immediately before `// ── Mosaic cache ──`) — it's now `src/nodePool.js`'s responsibility:

```js
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

```

After deletion, the file should flow directly from the namespace section's closing code into `// ── Mosaic cache ──`.

- [ ] **Step 2: Remove the now-unused imports from `cache.js`**

Change (`src/cache.js:1-19`):

```js
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
```

stays as-is. Change (`src/cache.js:28-35`):

```js
import {
  NEM_NODES,
  DAILY_TX_DAYS,
  DAILY_TX_BACKFILL_CHUNK,
  ARCHIVE_PAGE_DELAY_MS,
  DEEP_REFRESH_BATCH_DELAY_MS,
  NODE_PROBE_TIMEOUT_MS,
} from "./constants.js";
```

to:

```js
import {
  DAILY_TX_DAYS,
  DAILY_TX_BACKFILL_CHUNK,
  ARCHIVE_PAGE_DELAY_MS,
  DEEP_REFRESH_BATCH_DELAY_MS,
} from "./constants.js";
```

- [ ] **Step 3: Delete the old `NEM_NODES` export from `constants.js`**

Delete the (now-unused) block left over from Task 1:

```js
export const NEM_NODES = [
  "https://nebuta.kasanetalk.net:7891",
  "https://tanabata.kasanetalk.net:7891",
  "https://sanja.kasanetalk.net:7891",
  "https://kanda.kasanetalk.net:7891",
  "https://gion.kasanetalk.net:7891",
  "https://tenjin.kasanetalk.net:7891",
  "https://yosakoi.kasanetalk.net:7891",
  "https://yamakasa.kasanetalk.net:7891",
  "https://eisa.kasanetalk.net:7891",
  "https://hanabi.kasanetalk.net:7891",
];

```

- [ ] **Step 4: Rewire `index.js`'s imports**

Change (`index.js:5-23`):

```js
import {
  findNodeOption,
  fetchSubNamespaces,
  fetchMosaicsForNamespace,
  getActiveSupernodes,
  refreshNamespacesCache,
  refreshMosaicsCache,
  refreshAllMosaicsDeep,
  importNamespaceArchive,
  importMosaicArchive,
  importPollArchive,
  refreshRichListCache,
  refreshLiveRichList,
  refreshPriceCache,
  refreshHttpsNodeOptions,
  scheduleDailyTxStatsRefresh,
  liveRichList,
  liveRichListUpdatedAt,
} from "./src/cache.js";
```

to:

```js
import {
  fetchSubNamespaces,
  fetchMosaicsForNamespace,
  refreshNamespacesCache,
  refreshMosaicsCache,
  refreshAllMosaicsDeep,
  importNamespaceArchive,
  importMosaicArchive,
  importPollArchive,
  refreshRichListCache,
  refreshLiveRichList,
  refreshPriceCache,
  scheduleDailyTxStatsRefresh,
  liveRichList,
  liveRichListUpdatedAt,
} from "./src/cache.js";
import {
  findNodeOption,
  httpsNodeOptions,
  refreshHttpsNodeOptions,
} from "./src/nodePool.js";
```

- [ ] **Step 5: Switch the `/api/nodes` route to the verified pool**

Change (`index.js:774-783`):

```js
app.get("/api/nodes", async (req, res) => {
  try {
    const nodes = await getActiveSupernodes();
    res.setHeader("Content-Type", "text/html");
    res.send(nodesListHTML(nodes));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, "/api/nodes", "#nodes-card"));
  }
});
```

to:

```js
app.get("/api/nodes", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(nodesListHTML(httpsNodeOptions));
});
```

`httpsNodeOptions` entries have the shape `{name, host, endpoint}`, which is exactly what `renderNodeRow()` (`src/html.js:1737`) already expects (it reads `.endpoint` and `.name`) — no changes needed in `html.js`'s rendering functions themselves. The route is now synchronous (reading an in-memory array refreshed on its own 5-minute cadence), so the `try/catch`/503 path — which only existed to handle a live fetch failing — is no longer applicable and is removed.

- [ ] **Step 6: Rewire `src/html.js`'s import**

Change (`src/html.js:24`):

```js
import { httpsNodeOptions, httpsNodeOptionsUpdatedAt } from "./cache.js";
```

to:

```js
import { httpsNodeOptions, httpsNodeOptionsUpdatedAt } from "./nodePool.js";
```

- [ ] **Step 7: Run the test suite and syntax-check every touched file**

Run: `npm test && node --check src/cache.js && node --check src/constants.js && node --check index.js && node --check src/html.js`
Expected: `tests 5`, `pass 5`, `fail 0`; all four `node --check` calls print nothing and exit 0.

- [ ] **Step 8: Start the server and confirm it boots without import errors**

Run: `timeout 5 node index.js; echo "exit code: $?"`
Expected: no `ReferenceError`/`SyntaxError`/`Cannot find module` in the output. `timeout` will kill the still-running server after 5s, so `exit code: 124` (timeout's own signal-kill code) is the expected success case here — anything else printed *before* that (a stack trace) indicates a wiring bug.

- [ ] **Step 9: Commit**

```bash
git add src/cache.js src/constants.js index.js src/html.js
git commit -m "Move node-pool ownership from cache.js to nodePool.js

cache.js no longer defines the SuperNode/HTTPS-options block — it now
lives solely in nodePool.js (added in an earlier task). index.js and
html.js updated to import from there instead.

Also points /api/nodes at the already-probed httpsNodeOptions pool
instead of an unverified live fetch, so the page's hardcoded 'Active'
badge is no longer potentially false, and drops a redundant external
call per page view."
```

---

## Task 5: Update user-facing copy and comments from "supernode" to "node"

**Files:**
- Modify: `index.js:112-116` (comment), `index.js:756` (comment), `index.js:762,766,768` (page title/loading/meta text)
- Modify: `src/html.js:105,108,111` (node-switch dropdown copy), `src/html.js:315` (comment), `src/html.js:414` (`heroNodes()` `<h1>`), `src/html.js:1733` (section comment), `src/html.js:1769,1772,1775` (`nodesListHTML()` copy)

**Interfaces:** None — text-only changes, no behavior affected. Safe to review independently of Task 4's functional changes.

Now that the data source is nodewatch.symbol.tools (all discovered nodes, not an enrollment program) and selection is shuffled (not round-robin), every "supernode" and "round-robin" reference describing this data/mechanism needs to say what's actually happening — otherwise the `/nodes` page's own `<h1>` would contradict its card title, and the dropdown would claim a selection strategy the code no longer uses.

- [ ] **Step 1: Fix `index.js`'s node-switch middleware comment**

Change (`index.js:112-116`):

```js
// Reads the navbar's node-switch cookie and, if it names one of the currently
// cached HTTPS supernodes, makes that node available to nemFetch() for the
// remainder of this request via AsyncLocalStorage. Anything else (missing
// cookie, stale/unknown endpoint) falls through to the default round-robin
// pool — the whitelist check also keeps a forged cookie from turning this
// into an open server-side fetch proxy.
```

to:

```js
// Reads the navbar's node-switch cookie and, if it names one of the currently
// cached HTTPS node options, makes that node available to nemFetch() for the
// remainder of this request via AsyncLocalStorage. Anything else (missing
// cookie, stale/unknown endpoint) falls through to the default shuffled
// pool — the whitelist check also keeps a forged cookie from turning this
// into an open server-side fetch proxy.
```

- [ ] **Step 2: Fix `index.js`'s `/nodes` page copy**

Change (`index.js:756`):

```js
// Supernodes
```

to:

```js
// Nodes
```

Change (`index.js:762,766,768`):

```js
      "Supernodes - NEMSCAN",
      heroNodes(),
      "nodes-card",
      "/api/nodes",
      `<div class="loading"><div class="spinner"></div><span>Fetching active supernodes…</span></div>`,
      "/nodes",
      "Browse active NEM supernodes on NEMSCAN. View node hosts, versions, and network status.",
```

to:

```js
      "Nodes - NEMSCAN",
      heroNodes(),
      "nodes-card",
      "/api/nodes",
      `<div class="loading"><div class="spinner"></div><span>Fetching active nodes…</span></div>`,
      "/nodes",
      "Browse active NEM nodes on NEMSCAN. View node hosts, versions, and network status.",
```

- [ ] **Step 3: Fix the node-switch dropdown copy in `src/html.js`**

Change (`src/html.js:105`):

```js
        <div class="node-menu-head">Connect via <span class="node-menu-note">active HTTPS supernodes</span></div>
```

to:

```js
        <div class="node-menu-head">Connect via <span class="node-menu-note">active HTTPS nodes</span></div>
```

Change (`src/html.js:108`):

```js
          <span class="node-menu-text"><span class="node-menu-name">Auto</span><span class="node-menu-sub">round-robin node pool</span></span>
```

to:

```js
          <span class="node-menu-text"><span class="node-menu-name">Auto</span><span class="node-menu-sub">randomized node pool</span></span>
```

Change (`src/html.js:111`):

```js
        ${items || `<div class="node-menu-empty">${httpsNodeOptionsUpdatedAt ? "No HTTPS-reachable supernodes right now" : "Probing active supernodes for HTTPS…"}</div>`}
```

to:

```js
        ${items || `<div class="node-menu-empty">${httpsNodeOptionsUpdatedAt ? "No HTTPS-reachable nodes right now" : "Probing active nodes for HTTPS…"}</div>`}
```

- [ ] **Step 4: Fix the `selectNode` comment in `src/html.js`**

Change (`src/html.js:314-316`):

```js
  // The picker only ever offers endpoints the server already validated against
  // its live HTTPS-supernode cache, so we just hand the choice back as a cookie
  // and reload — nemFetch() on the server then prefers that node for this browser.
```

to:

```js
  // The picker only ever offers endpoints the server already validated against
  // its live HTTPS node cache, so we just hand the choice back as a cookie
  // and reload — nemFetch() on the server then prefers that node for this browser.
```

- [ ] **Step 5: Fix `heroNodes()`'s `<h1>`**

Change (`src/html.js:412-416`):

```js
export function heroNodes() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Supernodes</h1>
  </div></div>`;
}
```

to:

```js
export function heroNodes() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Nodes</h1>
  </div></div>`;
}
```

- [ ] **Step 6: Fix the section comment and `nodesListHTML()` copy**

Change (`src/html.js:1733`):

```js
// ── Supernodes list HTML ──────────────────────────────────────────────────────
```

to:

```js
// ── Nodes list HTML ───────────────────────────────────────────────────────────
```

Change (`src/html.js:1767-1775`):

```js
export function nodesListHTML(nodes) {
  if (!nodes.length)
    return `<div class="empty-state">No active supernodes found</div>`;
  return `
  <div class="card-head">
    <div class="card-title">Active Supernodes <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    <span class="total-txt"><strong>${nodes.length}</strong> active</span>
  </div>
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>The node information on this page is sourced from <a href="https://nem.io/supernodes/" target="_blank" rel="noopener">nem.io/supernode</a>.</p>
```

to:

```js
export function nodesListHTML(nodes) {
  if (!nodes.length)
    return `<div class="empty-state">No active nodes found</div>`;
  return `
  <div class="card-head">
    <div class="card-title">Active Nodes <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    <span class="total-txt"><strong>${nodes.length}</strong> active</span>
  </div>
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>The node information on this page is sourced from <a href="https://nodewatch.symbol.tools/" target="_blank" rel="noopener">nodewatch.symbol.tools</a>, a network crawler that lists all discovered NEM nodes, verified here by an HTTPS reachability check.</p>
```

- [ ] **Step 7: Run the test suite and syntax-check both files**

Run: `npm test && node --check index.js && node --check src/html.js`
Expected: `tests 5`, `pass 5`, `fail 0`; both `node --check` calls print nothing and exit 0.

- [ ] **Step 8: Grep to confirm no stray "supernode" references remain in app code**

Run: `grep -rin "supernode" index.js src/*.js`
Expected: only `src/html.js:212` (the footer's `nem.io/supernodes/` external resource link, intentionally left as-is per the design spec).

- [ ] **Step 9: Commit**

```bash
git add index.js src/html.js
git commit -m "Reword 'supernode'/'round-robin' copy to match the new node pool

The dynamic pool is no longer scoped to an enrollment program and
selection is shuffled, not round-robin — update page title, h1,
meta description, dropdown labels, and comments so the /nodes page
and node-switch dropdown describe what the code actually does."
```

---

## Task 6: Manual end-to-end verification

**Files:** None (verification only).

- [ ] **Step 1: Cold-start fallback check**

Run: `node index.js &` then immediately (before 5 seconds pass): `curl -s http://localhost:3000/ -o /dev/null -w "%{http_code}\n"`
Expected: `200` — confirms the home page renders using the `NEM_NODES_FALLBACK` safety net while `refreshHttpsNodeOptions()` is still running its first pass in the background (per `index.js`'s existing fire-and-forget startup call).

- [ ] **Step 2: Dynamic pool takes over**

Wait 15-20 seconds after starting the server (enough for the first `refreshHttpsNodeOptions()` to complete its probe batches), then run: `curl -s http://localhost:3000/api/nodes | grep -o 'Active Nodes'`
Expected: prints `Active Nodes` (confirms the renamed card title) — cross-check the row count shown on the page is > 0, confirming `httpsNodeOptions` populated from the live nodewatch probe.

- [ ] **Step 3: Node-switch dropdown**

Run: `curl -s http://localhost:3000/ | grep -o 'randomized node pool'`
Expected: prints `randomized node pool`, confirming the dropdown copy landed.

- [ ] **Step 4: Confirm no lingering fixed-list references**

Run: `grep -rn "kasanetalk" src/*.js index.js`
Expected: only `src/constants.js`'s `NEM_NODES_FALLBACK` block (3 hosts) — no other file should reference `kasanetalk.net` directly.

- [ ] **Step 5: Stop the server**

Run: `kill %1` (stops the background `node index.js` started in Step 1).

- [ ] **Step 6: Final full test run**

Run: `npm test`
Expected: `tests 5`, `pass 5`, `fail 0`.

No commit for this task — it's verification only, not a code change.
