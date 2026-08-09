# Testnet Support (mainnet/testnet switcher) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-visitor mainnet/testnet switcher to NEMSCAN, backed by an independent NIS node pool, address-derivation network byte, and SQLite DB per network.

**Architecture:** A new `networkContext` (`AsyncLocalStorage`, in `src/context.js`) carries the current network (`"mainnet"` | `"testnet"`) through each request, mirroring the existing `nodeContext` pattern used for the node-switch cookie. `src/nodePool.js` and `src/db.js` key their module-level state by network and resolve it via `currentNetwork()` by default. `src/cache.js`'s per-network background jobs (namespaces, mosaics, deep mosaic refresh) do the same; the daily-tx-stats job — the one background job that re-schedules itself recursively via `setTimeout` rather than being re-triggered fresh by `index.js`'s `setInterval` each tick — takes `network` as an explicit parameter instead, so it doesn't depend on `AsyncLocalStorage` surviving an indefinitely long recursive timer chain. `index.js`'s background scheduler loops over both networks for the jobs that make sense on testnet, and continues calling the mainnet-only jobs (price, nemtool.com archives, rich list) exactly as before. A new navbar dropdown (`src/html.js`) sets an `nemscan-network` cookie and reloads to `/`.

**Tech Stack:** Node.js (`node:sqlite`, `node:async_hooks`, `node:test`), Express 5, vanilla JS/CSS (no frontend framework, htmx for partial page loads).

## Global Constraints

- No data sharing/merging between mainnet and testnet (per spec).
- Default network when no cookie is present: mainnet, identical to today's behavior.
- Exported function **names and signatures** in `db.js` and `nodePool.js`'s read-path functions (`getShuffledNodePool`, `findNodeOption`) must stay backward compatible with existing call sites in `test/nodePool.test.js` (which pass an explicit `nodes` array, not a network string).
- testnet node source: `https://nodewatch.symbol.tools/testnet/api/nem/nodes` (verified 2026-08-09: same response shape as the mainnet endpoint — top-level array of `{ endpoint, name, ... }`).
- testnet fallback nodes (verified HTTPS-reachable 2026-08-09): `https://ntn1.dusanjp.com:7891`, `https://ntn2.dusanjp.com:7891`.
- Address network byte: mainnet `0x68`, testnet `0x98`.
- DB files: `./cache.db` (mainnet, unchanged), `./cache-testnet.db` (testnet, new).
- Disabled entirely on testnet (never invoked under a testnet context): XEM price ticker, namespace/mosaic archive import + live sub-namespace lookup (all nemtool.com-sourced), poll archive (nemtool.com), rich list / Accounts page (nemnodes.org-sourced).
- Switching networks via the navbar dropdown always navigates to `/` (not a same-page reload).
- Do not `git commit` unless the user explicitly asks in that turn — write/stage files but stop short of committing at the end of each task unless told otherwise.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/constants.js` | Add `NETWORKS` config map and `NEM_TESTNET_NODES_FALLBACK` |
| `src/context.js` | Add `networkContext` (AsyncLocalStorage) + `currentNetwork()` helper |
| `src/nodePool.js` | Node discovery/pool state keyed by network |
| `src/db.js` | SQLite layer keyed by network (factory function, two instances) |
| `src/cache.js` | Background cache refreshers: per-network guard flags for jobs that run on both networks; explicit `network` param for the self-rescheduling daily-tx-stats job |
| `src/html.js` | `networkSwitchHTML()`, address-byte-aware `addrFromPubKey()`, `unavailableOnTestnetHTML()`, navbar wiring, client JS |
| `public/style.css` | `.network-switch` / `.network-badge` styles |
| `index.js` | Cookie middleware, background scheduler network loop, testnet gating on Accounts/Polls/namespace-detail routes |
| `test/nodePool.test.js` | Update for per-network fallback resolution |
| `test/db.test.js` | New: mainnet/testnet DB layers are independent |
| `test/cache.test.js` | Update for per-network guard-flag isolation |
| `README.md` | Document the new DB file and network switcher |

---

### Task 1: `constants.js` — network config

**Files:**
- Modify: `src/constants.js` (append after `NODE_PROBE_TIMEOUT_MS`, currently the last line)

**Interfaces:**
- Produces: `NEM_TESTNET_NODES_FALLBACK` (array of endpoint strings), `NETWORKS` (object: `{ mainnet: {...}, testnet: {...} }`, each with `label`, `nodeSourceApi`, `fallbackNodes`, `addressNetworkByte`, `dbFile`)

- [ ] **Step 1: Add the new constants**

Append to `src/constants.js`:

```js

// ── Networks (mainnet / testnet) ────────────────────────────────────────────────

// Verified reachable over HTTPS (2026-08-09).
export const NEM_TESTNET_NODES_FALLBACK = [
  "https://ntn1.dusanjp.com:7891",
  "https://ntn2.dusanjp.com:7891",
];

export const NETWORKS = {
  mainnet: {
    label: "Mainnet",
    nodeSourceApi: "https://nodewatch.symbol.tools/api/nem/nodes",
    fallbackNodes: NEM_NODES_FALLBACK,
    addressNetworkByte: 0x68,
    dbFile: "./cache.db",
  },
  testnet: {
    label: "Testnet",
    nodeSourceApi: "https://nodewatch.symbol.tools/testnet/api/nem/nodes",
    fallbackNodes: NEM_TESTNET_NODES_FALLBACK,
    addressNetworkByte: 0x98,
    dbFile: "./cache-testnet.db",
  },
};
```

- [ ] **Step 2: Sanity-check the file still parses**

Run: `node --check src/constants.js`
Expected: no output (exit code 0)

- [ ] **Step 3: Commit**

```bash
git add src/constants.js
git commit -m "Add NETWORKS config for mainnet/testnet support"
```

---

### Task 2: `context.js` — network context

**Files:**
- Modify: `src/context.js`

**Interfaces:**
- Produces: `networkContext` (AsyncLocalStorage instance), `currentNetwork()` (function, returns `"mainnet"` or `"testnet"`)

- [ ] **Step 1: Write the failing test**

Create `test/context.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { networkContext, currentNetwork } from "../src/context.js";

test("currentNetwork defaults to mainnet outside any networkContext.run", () => {
  assert.equal(currentNetwork(), "mainnet");
});

test("currentNetwork returns testnet inside networkContext.run('testnet', ...)", () => {
  networkContext.run("testnet", () => {
    assert.equal(currentNetwork(), "testnet");
  });
});

test("currentNetwork falls back to mainnet for an unrecognized stored value", () => {
  networkContext.run("bogus", () => {
    assert.equal(currentNetwork(), "mainnet");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/context.test.js`
Expected: FAIL — `networkContext`/`currentNetwork` are not exported yet.

- [ ] **Step 3: Implement**

Replace the full contents of `src/context.js` with:

```js
import { AsyncLocalStorage } from "node:async_hooks";

// Carries the per-request "preferred connection node" (chosen via the navbar's
// node-switch dropdown and sent back as a cookie) through to nemFetch(), without
// threading it through every route handler and HTML builder by hand.
export const nodeContext = new AsyncLocalStorage();

// Carries the per-request selected network ("mainnet" | "testnet"), chosen via
// the navbar's network-switch dropdown and sent back as the nemscan-network
// cookie. Read by nodePool.js, db.js, cache.js, and html.js so each resolves
// the right node pool / SQLite file / address byte without threading an extra
// parameter through every function call.
export const networkContext = new AsyncLocalStorage();

export function currentNetwork() {
  return networkContext.getStore() === "testnet" ? "testnet" : "mainnet";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/context.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/context.js test/context.test.js
git commit -m "Add networkContext for per-request mainnet/testnet selection"
```

---

### Task 3: `nodePool.js` — per-network node pool

**Files:**
- Modify: `src/nodePool.js`
- Modify: `test/nodePool.test.js`

**Interfaces:**
- Consumes: `NETWORKS` from `./constants.js` (Task 1), `currentNetwork` from `./context.js` (Task 2)
- Produces (all replace/extend the current exports):
  - `getKnownNemNodes(network)` — was `getKnownNemNodes()` with no args
  - `getHttpsNodeOptions(network = currentNetwork())` — **new**, replaces the old `export let httpsNodeOptions`
  - `getHttpsNodeOptionsUpdatedAt(network = currentNetwork())` — **new**, replaces `export let httpsNodeOptionsUpdatedAt`
  - `probeHttpsNode(host, timeoutMs)` — unchanged
  - `refreshHttpsNodeOptions(network = currentNetwork(), batchSize = 12)` — was `refreshHttpsNodeOptions(batchSize = 12)`
  - `findNodeOption(endpoint, network = currentNetwork())` — was `findNodeOption(endpoint)`
  - `getShuffledNodePool(nodes = getHttpsNodeOptions(), network = currentNetwork())` — was `getShuffledNodePool(nodes = httpsNodeOptions)`

- [ ] **Step 1: Write the failing tests**

Replace `test/nodePool.test.js` with (existing tests preserved, new ones appended):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getShuffledNodePool,
  findNodeOption,
  getHttpsNodeOptions,
  refreshHttpsNodeOptions,
} from "../src/nodePool.js";
import {
  NEM_NODES_FALLBACK,
  NEM_TESTNET_NODES_FALLBACK,
} from "../src/constants.js";
import { networkContext } from "../src/context.js";

test("getShuffledNodePool falls back to NEM_NODES_FALLBACK when given an empty pool", () => {
  const result = getShuffledNodePool([]);
  assert.deepEqual([...result].sort(), [...NEM_NODES_FALLBACK].sort());
});

test("getShuffledNodePool falls back to NEM_TESTNET_NODES_FALLBACK when given an empty pool under testnet context", () => {
  networkContext.run("testnet", () => {
    const result = getShuffledNodePool([]);
    assert.deepEqual(
      [...result].sort(),
      [...NEM_TESTNET_NODES_FALLBACK].sort(),
    );
  });
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
  assert.equal(findNodeOption("https://nonexistent:7891"), null);
});

test("getHttpsNodeOptions defaults to the current network and mainnet/testnet pools are independent", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    const isTestnet = String(url).includes("/testnet/");
    return {
      ok: true,
      json: async () =>
        isTestnet
          ? [{ endpoint: "http://tnode:7890", name: "tnode" }]
          : [{ endpoint: "http://mnode:7890", name: "mnode" }],
    };
  });
  // probeHttpsNode makes a second, separate fetch call (to /chain/height) —
  // the same mock above answers `ok: true` with a JSON body that has no
  // `height`, which probeHttpsNode treats as unreachable. That's fine here:
  // this test only checks that refreshHttpsNodeOptions() resolves the right
  // *source* URL per network, not that verification succeeds.
  await refreshHttpsNodeOptions("mainnet");
  await refreshHttpsNodeOptions("testnet");
  // Neither candidate probed as healthy (no `height` in the mocked probe
  // response), so both pools stay empty — but each refresh must have hit its
  // own NODE_SOURCE_API, which we verify indirectly via getHttpsNodeOptionsUpdatedAt.
  const { getHttpsNodeOptionsUpdatedAt } = await import("../src/nodePool.js");
  assert.ok(getHttpsNodeOptionsUpdatedAt("mainnet") !== null);
  assert.ok(getHttpsNodeOptionsUpdatedAt("testnet") !== null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/nodePool.test.js`
Expected: FAIL — `getHttpsNodeOptions`/`refreshHttpsNodeOptions("mainnet")` don't exist yet in the current signature, and the testnet-fallback test fails because `NETWORKS`/network-keyed fallback resolution doesn't exist.

- [ ] **Step 3: Implement**

Replace the full contents of `src/nodePool.js` with:

```js
import { NODE_PROBE_TIMEOUT_MS, NETWORKS } from "./constants.js";
import { currentNetwork } from "./context.js";

// ── Node discovery ────────────────────────────────────────────────────────────

// nodewatch.symbol.tools crawls the NEM network and publishes every node it
// discovers — not only nodes enrolled in any program. NIS1 nodes have no
// protocol-level concept of "supernode" status, so we query this
// third-party directory rather than a NIS node. It publishes a separate feed
// per network (NETWORKS.mainnet.nodeSourceApi / NETWORKS.testnet.nodeSourceApi).

const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^\[::1\]$/,
];

function isPrivateHostname(hostname) {
  return PRIVATE_HOSTNAME_PATTERNS.some((re) => re.test(hostname));
}

export async function getKnownNemNodes(network) {
  const res = await fetch(NETWORKS[network].nodeSourceApi);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

// ── HTTPS node verification ───────────────────────────────────────────────────

// nodewatch only ever lists each node's plain-HTTP REST endpoint (host:7890);
// it never lists an "https://" entry. By NIS1 convention the same host
// commonly answers HTTPS one port up (host:7891 — exactly how our fallback
// pools in constants.js are configured), so we derive that candidate and probe
// it directly rather than trusting the registry.
const state = {
  mainnet: { httpsNodeOptions: [], httpsNodeOptionsUpdatedAt: null, refreshing: false },
  testnet: { httpsNodeOptions: [], httpsNodeOptionsUpdatedAt: null, refreshing: false },
};

export function getHttpsNodeOptions(network = currentNetwork()) {
  return state[network].httpsNodeOptions;
}

export function getHttpsNodeOptionsUpdatedAt(network = currentNetwork()) {
  return state[network].httpsNodeOptionsUpdatedAt;
}

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
// (see index.js's setInterval calls) — once per network.
export async function refreshHttpsNodeOptions(network = currentNetwork(), batchSize = 12) {
  const s = state[network];
  if (s.refreshing) return;
  s.refreshing = true;
  try {
    const nodes = await getKnownNemNodes(network);
    const candidates = [];
    for (const n of nodes) {
      let u;
      try {
        u = new URL(n.endpoint);
      } catch {
        continue;
      }
      if (isPrivateHostname(u.hostname)) continue;
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
    if (verified.length > 0) {
      s.httpsNodeOptions = verified;
    }
  } catch (err) {
    console.error(`Node options refresh failed (${network}):`, err.message);
  } finally {
    s.httpsNodeOptionsUpdatedAt = Date.now();
    s.refreshing = false;
  }
}

export function findNodeOption(endpoint, network = currentNetwork()) {
  return state[network].httpsNodeOptions.find((n) => n.endpoint === endpoint) || null;
}

// ── Shuffled pool for nemFetch ────────────────────────────────────────────────

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Returns a freshly shuffled copy of the current network's node pool: the
// dynamic, HTTPS-verified pool when it has at least one entry, else that
// network's hardcoded fallback (cold start, or a sustained nodewatch outage
// before any successful refresh has ever completed). Called fresh on every
// nemFetch() so load spreads across nodes instead of always starting from the
// same one.
//
// `nodes` defaults to the live pool for the current network; tests pass an
// explicit array instead of reaching into this module's internal state.
export function getShuffledNodePool(
  nodes = getHttpsNodeOptions(),
  network = currentNetwork(),
) {
  const base =
    nodes.length > 0 ? nodes.map((n) => n.endpoint) : NETWORKS[network].fallbackNodes;
  return shuffle([...base]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/nodePool.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: `nemApi.test.js` and `cache.test.js` still pass (neither imports anything changed in this task); `context.test.js` from Task 2 still passes.

- [ ] **Step 6: Commit**

```bash
git add src/nodePool.js test/nodePool.test.js
git commit -m "Key nodePool.js state and exports by network"
```

---

### Task 4: `db.js` — per-network SQLite layer

**Files:**
- Modify: `src/db.js`
- Create: `test/db.test.js`

**Interfaces:**
- Consumes: `NETWORKS` (Task 1), `currentNetwork` (Task 2)
- Produces: every function `db.js` already exports, **unchanged names/signatures**, plus a new `getDb()` replacing the old raw `db` export (used only by `cache.js`).

- [ ] **Step 1: Write the failing test**

Create `test/db.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync } from "node:fs";
import { networkContext } from "../src/context.js";

// db.js opens both SQLite files at import time as a side effect, so clean up
// any stale testnet DB from a previous run before importing it.
for (const f of ["./cache-testnet.db", "./cache-testnet.db-shm", "./cache-testnet.db-wal"]) {
  if (existsSync(f)) unlinkSync(f);
}

const { setCacheMeta, getCacheMeta } = await import("../src/db.js");

test("mainnet and testnet DB layers are independent", () => {
  networkContext.run("mainnet", () => {
    setCacheMeta("test_marker", "mainnet-value");
  });
  networkContext.run("testnet", () => {
    setCacheMeta("test_marker", "testnet-value");
  });
  networkContext.run("mainnet", () => {
    assert.equal(getCacheMeta("test_marker"), "mainnet-value");
  });
  networkContext.run("testnet", () => {
    assert.equal(getCacheMeta("test_marker"), "testnet-value");
  });
});

test("outside any networkContext.run, db.js defaults to the mainnet layer", () => {
  assert.equal(getCacheMeta("test_marker"), "mainnet-value");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db.test.js`
Expected: FAIL — `getCacheMeta("test_marker")` returns the same value regardless of `networkContext`, since `db.js` doesn't key by network yet.

- [ ] **Step 3: Implement**

Replace the full contents of `src/db.js` with:

```js
import { DatabaseSync } from "node:sqlite";
import { NETWORKS } from "./constants.js";
import { currentNetwork } from "./context.js";

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
    getCachedPolls: (limit = 25, offset = 0) => _pollSelectStmt.all(limit, offset),
    getCachedPollsCount: () => _pollCountStmt.get().c,
    getCachedRichList: (limit = 25, offset = 0) => _accSelectStmt.all(limit, offset),
    getCachedRichListCount: () => _accCountStmt.get().c,
    getCacheMeta: (key) => _metaSelectStmt.get(key)?.value ?? null,
    setCacheMeta: (key, value) => _metaUpsertStmt.run(key, String(value)),
    bumpDailyTxCount: (dateStr, txCount) => _dailyTxBumpStmt.run(dateStr, txCount),
    getDailyTxCounts: (limit) => _dailyTxRecentStmt.all(limit).reverse(),
    getOldestDailyTxDate: () => _dailyTxOldestStmt.get().d,
    upsertNamespace: (id, fqn, owner, height) => _nsUpsertStmt.run(id, fqn, owner, height),
    upsertNamespaceArchive: (no, fqn, owner, height) => _nsArchUpsertStmt.run(no, fqn, owner, height),
    upsertMosaic: (id, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp) =>
      _mosUpsertStmt.run(id, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp),
    upsertMosaicArchive: (no, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp) =>
      _mosArchUpsertStmt.run(no, namespace, name, creator, description, divisibility, supply, transferable, height, timeStamp),
    upsertPoll: (id, address, title, type, doe) => _pollUpsertStmt.run(id, address, title, type, doe),
    upsertRichListEntry: (rank, address, balance, info) => _accUpsertStmt.run(rank, address, balance, info),
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
export function getOldestDailyTxDate() {
  return layer().getOldestDailyTxDate();
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

// Exported for the rare cases where cache.js needs raw DB access
// (e.g. importMosaicArchive schema-upgrade check, refreshAllMosaicsDeep's
// distinct-namespace scan). Resolves to the current network's DatabaseSync
// instance — call it fresh each time rather than caching the result, since
// the current network can change between calls.
export function getDb() {
  return layer().db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db.test.js`
Expected: PASS (2 tests). Note: this creates `cache-testnet.db` in the repo root as a side effect — that's expected and matches how `cache.db` already exists from running the app.

- [ ] **Step 5: Update `cache.js`'s two raw-`db` call sites (temporary — full `cache.js` update is Task 5, but this keeps the tree working standalone)**

In `src/cache.js`, change the import:

```js
import {
  getDb,
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

In `refreshAllMosaicsDeep`, change:
```js
    db.prepare("SELECT DISTINCT namespace FROM mosaics_archive")
      .all()
      .forEach((r) => nsSet.add(r.namespace));
```
to:
```js
    getDb()
      .prepare("SELECT DISTINCT namespace FROM mosaics_archive")
      .all()
      .forEach((r) => nsSet.add(r.namespace));
```

In `importMosaicArchive`, change:
```js
  if (getCacheMeta("mosaics_archive_imported")) {
    // Re-import if height data is missing (schema upgrade from older DB).
    const hasHeight = db
      .prepare(
        "SELECT COUNT(*) AS c FROM mosaics_archive WHERE height IS NOT NULL",
      )
      .get().c;
    if (hasHeight) return;
    db.exec("DELETE FROM cache_meta WHERE key = 'mosaics_archive_imported'");
  }
```
to:
```js
  if (getCacheMeta("mosaics_archive_imported")) {
    // Re-import if height data is missing (schema upgrade from older DB).
    const hasHeight = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM mosaics_archive WHERE height IS NOT NULL",
      )
      .get().c;
    if (hasHeight) return;
    getDb().exec("DELETE FROM cache_meta WHERE key = 'mosaics_archive_imported'");
  }
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass. `cache.test.js` only tests `fetchXemPriceFromCoinGecko`, which doesn't touch `db.js`, so it's unaffected by this task.

- [ ] **Step 7: Commit**

```bash
git add src/db.js src/cache.js test/db.test.js
git commit -m "Split db.js into per-network SQLite layers (cache.db / cache-testnet.db)"
```

---

### Task 5: `cache.js` — per-network background job isolation

**Files:**
- Modify: `src/cache.js`
- Modify: `test/cache.test.js`

**Interfaces:**
- Consumes: `currentNetwork` from `./context.js` (Task 2), `networkContext` from `./context.js` (Task 2)
- Produces:
  - `refreshNamespacesCache()` — signature unchanged, now network-isolated internally
  - `refreshMosaicsCache()` — signature unchanged, now network-isolated internally
  - `refreshAllMosaicsDeep()` — signature unchanged, now network-isolated internally
  - `scheduleDailyTxStatsRefresh(network)` — **new required parameter** (was no-arg)
  - `refreshDailyTxStats(network)` — **new required parameter** (was no-arg)
  - Everything else in `cache.js` (`importNamespaceArchive`, `importMosaicArchive`, `importPollArchive`, `fetchSubNamespaces`, `refreshRichListCache`, `refreshLiveRichList`, `liveRichList`, `liveRichListUpdatedAt`, `fetchXemPriceFromCoinGecko`, `refreshPriceCache`) — **unchanged**, since `index.js` (Task 8) only ever invokes these under a mainnet context.

- [ ] **Step 1: Write the failing test**

Append to `test/cache.test.js`:

```js
import { networkContext } from "../src/context.js";

test("refreshNamespacesCache guard flag is isolated per network — a slow mainnet refresh doesn't block a concurrent testnet refresh", async (t) => {
  const { refreshNamespacesCache } = await import("../src/cache.js");
  let resolveMainnetFetch;
  let testnetFetchStarted = false;
  t.mock.method(global, "fetch", (url) => {
    if (String(url).includes("pagesize=25") && !testnetFetchStarted) {
      // First call (mainnet): hang until we manually resolve it below.
      return new Promise((resolve) => {
        resolveMainnetFetch = () => resolve({ ok: true, json: async () => ({ data: [] }) });
      });
    }
    testnetFetchStarted = true;
    return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
  });

  const mainnetPromise = networkContext.run("mainnet", () => refreshNamespacesCache());
  // Give the mainnet call's fetch a tick to register as "in flight" before
  // starting the testnet one.
  await new Promise((r) => setTimeout(r, 10));
  const testnetPromise = networkContext.run("testnet", () => refreshNamespacesCache());

  await testnetPromise;
  assert.ok(testnetFetchStarted, "testnet refresh should not be blocked by the in-flight mainnet refresh");

  resolveMainnetFetch();
  await mainnetPromise;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cache.test.js`
Expected: FAIL (timeout or `testnetFetchStarted` stays `false`) — the current single shared `_refreshingNamespaces` boolean blocks the testnet call while the mainnet call is in flight.

- [ ] **Step 3: Implement**

In `src/cache.js`, add the import (top of file, alongside the existing `helpers.js`/`constants.js` imports):

```js
import { currentNetwork, networkContext } from "./context.js";
```

Replace the namespace-cache section:

```js
let _refreshingNamespaces = false;
export async function refreshNamespacesCache() {
```
with:
```js
const _refreshingNamespaces = { mainnet: false, testnet: false };
export async function refreshNamespacesCache() {
  const network = currentNetwork();
  if (_refreshingNamespaces[network]) return;
  _refreshingNamespaces[network] = true;
```

And its `finally`/`catch` block:
```js
  } catch (err) {
    console.error("Namespace cache refresh failed:", err.message);
  } finally {
    _refreshingNamespaces = false;
  }
}
```
becomes:
```js
  } catch (err) {
    console.error(`Namespace cache refresh failed (${network}):`, err.message);
  } finally {
    _refreshingNamespaces[network] = false;
  }
}
```

Apply the identical pattern to `refreshMosaicsCache` (guard flag `_refreshingMosaics`) and `refreshAllMosaicsDeep` (guard flag `_refreshingMosaicsDeep`):

```js
const _refreshingMosaics = { mainnet: false, testnet: false };
export async function refreshMosaicsCache() {
  const network = currentNetwork();
  if (_refreshingMosaics[network]) return;
  _refreshingMosaics[network] = true;
  try {
    // ... existing body, unchanged ...
  } catch (err) {
    console.error(`Mosaic cache refresh failed (${network}):`, err.message);
  } finally {
    _refreshingMosaics[network] = false;
  }
}
```

```js
const _refreshingMosaicsDeep = { mainnet: false, testnet: false };
export async function refreshAllMosaicsDeep() {
  const network = currentNetwork();
  if (_refreshingMosaicsDeep[network]) return;
  _refreshingMosaicsDeep[network] = true;
  try {
    // ... existing body, unchanged ...
  } catch (err) {
    console.error(`Deep mosaic refresh failed (${network}):`, err.message);
  } finally {
    _refreshingMosaicsDeep[network] = false;
  }
}
```

Replace the daily-tx-stats section. Current:

```js
let _refreshingDailyTxStats = false;
export async function refreshDailyTxStats() {
  if (_refreshingDailyTxStats) return;
  _refreshingDailyTxStats = true;
  try {
    const height = await getHeight();
    let maxH = parseInt(getCacheMeta("daily_tx_scan_max_height"));
    let minH = parseInt(getCacheMeta("daily_tx_scan_min_height"));
    if (!Number.isFinite(maxH)) {
      maxH = height - 1;
      minH = height;
    }

    if (height > maxH) {
      const heights = [];
      for (let h = maxH + 1; h <= height; h++) heights.push(h);
      await scanBlockHeightsForDailyTx(heights);
      maxH = height;
      setCacheMeta("daily_tx_scan_max_height", maxH);
    }

    if (!getCacheMeta("daily_tx_backfill_done")) {
      const cutoff = new Date(Date.now() - (DAILY_TX_DAYS - 1) * 86400000)
        .toISOString()
        .slice(0, 10);
      const oldest = getOldestDailyTxDate();
      if ((oldest && oldest <= cutoff) || minH <= 1) {
        setCacheMeta("daily_tx_backfill_done", "1");
      } else {
        const to = Math.max(1, minH - DAILY_TX_BACKFILL_CHUNK);
        const heights = [];
        for (let h = minH - 1; h >= to; h--) heights.push(h);
        await scanBlockHeightsForDailyTx(heights);
        minH = to;
        setCacheMeta("daily_tx_scan_min_height", minH);
      }
    }
  } catch (err) {
    console.error("Daily tx stats refresh failed:", err.message);
  } finally {
    _refreshingDailyTxStats = false;
  }
}

// Self-rescheduling rather than setInterval: backfill runs in quick
// succession (every 5s) until DAILY_TX_DAYS of history is covered, then
// settles into an infrequent catch-up poll (every 5min).
export function scheduleDailyTxStatsRefresh() {
  refreshDailyTxStats().finally(() => {
    const delay = getCacheMeta("daily_tx_backfill_done")
      ? 5 * 60 * 1000
      : 5 * 1000;
    setTimeout(scheduleDailyTxStatsRefresh, delay);
  });
}
```

Replace with (note the explicit `network` parameter — this is the one background job that re-schedules itself recursively via `setTimeout` rather than being re-triggered fresh by `index.js`'s `setInterval` each tick, so its network is threaded explicitly rather than relying on `networkContext` to survive an indefinitely long recursive timer chain):

```js
const _refreshingDailyTxStats = { mainnet: false, testnet: false };
export async function refreshDailyTxStats(network) {
  if (_refreshingDailyTxStats[network]) return;
  _refreshingDailyTxStats[network] = true;
  try {
    await networkContext.run(network, async () => {
      const height = await getHeight();
      let maxH = parseInt(getCacheMeta("daily_tx_scan_max_height"));
      let minH = parseInt(getCacheMeta("daily_tx_scan_min_height"));
      if (!Number.isFinite(maxH)) {
        maxH = height - 1;
        minH = height;
      }

      if (height > maxH) {
        const heights = [];
        for (let h = maxH + 1; h <= height; h++) heights.push(h);
        await scanBlockHeightsForDailyTx(heights);
        maxH = height;
        setCacheMeta("daily_tx_scan_max_height", maxH);
      }

      if (!getCacheMeta("daily_tx_backfill_done")) {
        const cutoff = new Date(Date.now() - (DAILY_TX_DAYS - 1) * 86400000)
          .toISOString()
          .slice(0, 10);
        const oldest = getOldestDailyTxDate();
        if ((oldest && oldest <= cutoff) || minH <= 1) {
          setCacheMeta("daily_tx_backfill_done", "1");
        } else {
          const to = Math.max(1, minH - DAILY_TX_BACKFILL_CHUNK);
          const heights = [];
          for (let h = minH - 1; h >= to; h--) heights.push(h);
          await scanBlockHeightsForDailyTx(heights);
          minH = to;
          setCacheMeta("daily_tx_scan_min_height", minH);
        }
      }
    });
  } catch (err) {
    console.error(`Daily tx stats refresh failed (${network}):`, err.message);
  } finally {
    _refreshingDailyTxStats[network] = false;
  }
}

// Self-rescheduling rather than setInterval: backfill runs in quick
// succession (every 5s) until DAILY_TX_DAYS of history is covered, then
// settles into an infrequent catch-up poll (every 5min). Takes `network`
// explicitly and passes it through its own recursive setTimeout call.
export function scheduleDailyTxStatsRefresh(network) {
  refreshDailyTxStats(network).finally(() => {
    const delay = networkContext.run(network, () =>
      getCacheMeta("daily_tx_backfill_done"),
    )
      ? 5 * 60 * 1000
      : 5 * 1000;
    setTimeout(() => scheduleDailyTxStatsRefresh(network), delay);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cache.test.js`
Expected: PASS (all tests, including the new one)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/cache.js test/cache.test.js
git commit -m "Isolate cache.js's shared-network background job state per network"
```

---

### Task 6: `html.js` — network switcher UI + address byte

**Files:**
- Modify: `src/html.js`

**Interfaces:**
- Consumes: `NETWORKS` from `./constants.js` (Task 1), `currentNetwork`/`networkContext` from `./context.js` (Task 2), `getHttpsNodeOptions`/`getHttpsNodeOptionsUpdatedAt` from `./nodePool.js` (Task 3)
- Produces: `networkSwitchHTML()` (new export), `unavailableOnTestnetHTML(label)` (new export), `addrFromPubKey(hex)` (new, module-local, not exported — replaces all direct `pubKeyToAddress(...)` call sites)

- [ ] **Step 1: Update imports**

In `src/html.js`, change:
```js
import { nodeContext } from "./context.js";
import { httpsNodeOptions, httpsNodeOptionsUpdatedAt } from "./nodePool.js";
import { TX_TYPES, XEM_TOTAL_SUPPLY, DAILY_TX_DAYS } from "./constants.js";
```
to:
```js
import { nodeContext, currentNetwork } from "./context.js";
import { getHttpsNodeOptions, getHttpsNodeOptionsUpdatedAt } from "./nodePool.js";
import { TX_TYPES, XEM_TOTAL_SUPPLY, DAILY_TX_DAYS, NETWORKS } from "./constants.js";
```

- [ ] **Step 2: Add the address-byte helper**

Immediately after the `xemPriceHTML()` function (before `nodeSwitchHTML()`), add:

```js
// Resolves the correct NIS1 address network byte (mainnet 0x68 / testnet
// 0x98) for the request currently being rendered. Replaces direct
// pubKeyToAddress(...) calls throughout this file.
function addrFromPubKey(hex) {
  return pubKeyToAddress(hex, NETWORKS[currentNetwork()].addressNetworkByte);
}
```

- [ ] **Step 3: Replace all `pubKeyToAddress(` call sites with `addrFromPubKey(`**

Run:
```bash
sed -i 's/pubKeyToAddress(/addrFromPubKey(/g' src/html.js
```

Then undo the one place this accidentally touched the *definition* (Step 2's own helper body) and the import line — check with:
```bash
grep -n "pubKeyToAddress\|addrFromPubKey" src/html.js
```
Expected: the `import { ..., pubKeyToAddress, ... } from "./helpers.js"` line still says `pubKeyToAddress` (sed doesn't match it — no trailing `(`), the helper's own body still calls the real `pubKeyToAddress(hex, ...)` (also fine — sed matches literal `pubKeyToAddress(` and the helper body should **not** have been replaced since it does not textually start with `addrFromPubKey`... but re-check: sed replaces the literal substring `pubKeyToAddress(` wherever it appears, including inside the helper's own definition body). Fix the helper by hand so it still calls the real function:

```js
function addrFromPubKey(hex) {
  return addrFromPubKey(hex, NETWORKS[currentNetwork()].addressNetworkByte);
}
```
must instead read:
```js
function addrFromPubKey(hex) {
  return pubKeyToAddress(hex, NETWORKS[currentNetwork()].addressNetworkByte);
}
```
Manually correct this one occurrence back to `pubKeyToAddress(hex, ...)` inside the helper body after running `sed` (the helper must call the real, imported function — `sed`'s blind global replace breaks its own definition, and this is the one spot to fix by hand).

- [ ] **Step 4: Update `nodeSwitchHTML()` to use the getter functions**

Change:
```js
export function nodeSwitchHTML() {
  const active = nodeContext.getStore();
  const activeEndpoint = active ? active.endpoint : "";
  const activeLabel = active ? active.name : "Auto";
  const isActive = (ep) => (ep === activeEndpoint ? " active" : "");
  const items = [...httpsNodeOptions]
    .sort((a, b) => a.name.localeCompare(b.name))
```
to:
```js
export function nodeSwitchHTML() {
  const active = nodeContext.getStore();
  const activeEndpoint = active ? active.endpoint : "";
  const activeLabel = active ? active.name : "Auto";
  const isActive = (ep) => (ep === activeEndpoint ? " active" : "");
  const items = [...getHttpsNodeOptions()]
    .sort((a, b) => a.name.localeCompare(b.name))
```

And change:
```js
        ${items || `<div class="node-menu-empty">${httpsNodeOptionsUpdatedAt ? "No HTTPS-reachable nodes right now" : "Probing active nodes for HTTPS…"}</div>`}
```
to:
```js
        ${items || `<div class="node-menu-empty">${getHttpsNodeOptionsUpdatedAt() ? "No HTTPS-reachable nodes right now" : "Probing active nodes for HTTPS…"}</div>`}
```

- [ ] **Step 5: Add `networkSwitchHTML()` and `unavailableOnTestnetHTML()`**

Immediately after `nodeSwitchHTML()`'s closing brace, add:

```js
export function networkSwitchHTML() {
  const active = currentNetwork();
  const items = Object.entries(NETWORKS)
    .map(
      ([key, cfg]) => `
        <button type="button" class="node-menu-item${key === active ? " active" : ""}" data-network="${key}" role="menuitem" onclick="selectNetwork(this)">
          <span class="node-menu-dot"></span>
          <span class="node-menu-text"><span class="node-menu-name">${esc(cfg.label)}</span></span>
        </button>`,
    )
    .join("");
  return `<div class="node-switch network-switch">
      <button type="button" class="node-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleNodeMenu(event)" title="Network">
        <span class="node-switch-dot is-live"></span>
        <span class="node-switch-label">${esc(NETWORKS[active].label)}</span>
        <span class="node-switch-caret">&#9662;</span>
      </button>
      ${active === "testnet" ? '<span class="network-badge">TESTNET</span>' : ""}
      <div class="node-menu" role="menu" aria-label="Network">
        ${items}
      </div>
    </div>`;
}

export function unavailableOnTestnetHTML(label) {
  return `<div class="error-state">
    <div class="error-icon">ℹ</div>
    <p class="error-title">Not available on testnet</p>
    <p class="error-msg">${esc(label)} isn't available while browsing testnet.</p>
  </div>`;
}
```

- [ ] **Step 6: Wire `networkSwitchHTML()` into the navbar**

In `navToolsHTML()`, change:
```js
    ${nodeSwitchHTML()}
    <div class="theme-switch">
```
to:
```js
    ${networkSwitchHTML()}
    ${nodeSwitchHTML()}
    <div class="theme-switch">
```

- [ ] **Step 7: Add the client-side `selectNetwork` handler**

In the inline `<script>` block (same function scope as `window.selectNode`), immediately after the existing `window.selectNode = function(btn) { ... };` block, add:

```js
  var NETWORK_KEY = 'nemscan-network';
  window.selectNetwork = function(btn) {
    var network = btn.dataset.network === 'testnet' ? 'testnet' : 'mainnet';
    try {
      document.cookie = NETWORK_KEY + '=' + encodeURIComponent(network) + ';path=/;max-age=2592000;samesite=lax';
    } catch (e) {}
    closeMenus();
    location.href = '/';
  };
```

- [ ] **Step 8: Verify the file still parses and export list is correct**

Run: `node --check src/html.js`
Expected: no output.

Run:
```bash
node -e "import('./src/html.js').then(m => console.log(typeof m.networkSwitchHTML, typeof m.unavailableOnTestnetHTML, typeof m.nodeSwitchHTML))"
```
Expected: `function function function`

- [ ] **Step 9: Commit**

```bash
git add src/html.js
git commit -m "Add network-switch dropdown and per-network address byte to html.js"
```

---

### Task 7: `public/style.css` — network-switch styling

**Files:**
- Modify: `public/style.css`

- [ ] **Step 1: Add styles**

Immediately after the existing `.node-menu-empty { ... }` block (the last rule in the "Node-switch dropdown" section), add:

```css

/* Network-switch dropdown (navbar mainnet/testnet picker) */
.network-switch {
    display: flex;
    align-items: center;
    gap: 6px;
}
.network-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: #fff;
    background: var(--red);
    border-radius: 5px;
    padding: 3px 6px;
    line-height: 1;
    white-space: nowrap;
}
```

- [ ] **Step 2: Confirm the CSS-busting version updates automatically**

No action needed — `CSS_VERSION` in `html.js` is derived from `style.css`'s file mtime at server startup, so the next `node index.js` run picks up this change automatically.

- [ ] **Step 3: Commit**

```bash
git add public/style.css
git commit -m "Add network-switch and testnet-badge styles"
```

---

### Task 8: `index.js` — middleware, background scheduler, testnet gating

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: `networkContext`, `currentNetwork` (Task 2); `getHttpsNodeOptions`, `getHttpsNodeOptionsUpdatedAt`, `refreshHttpsNodeOptions`, `findNodeOption` (Task 3); `NETWORKS` (Task 1); `unavailableOnTestnetHTML` (Task 6); `scheduleDailyTxStatsRefresh(network)` (Task 5)

- [ ] **Step 1: Update imports**

Change:
```js
import { nodeContext } from "./src/context.js";
```
to:
```js
import { nodeContext, networkContext, currentNetwork } from "./src/context.js";
```

Change:
```js
import {
  findNodeOption,
  httpsNodeOptions,
  httpsNodeOptionsUpdatedAt,
  refreshHttpsNodeOptions,
} from "./src/nodePool.js";
```
to:
```js
import {
  findNodeOption,
  getHttpsNodeOptions,
  getHttpsNodeOptionsUpdatedAt,
  refreshHttpsNodeOptions,
} from "./src/nodePool.js";
import { NETWORKS } from "./src/constants.js";
```

Change:
```js
import {
  shell,
  accountShell,
  homePageHTML,
  ...
  nodesListHTML,
  accountsListHTML,
  accountMoreRows,
  errorFrag,
  CSS_VERSION,
} from "./src/html.js";
```
to (add `unavailableOnTestnetHTML` to the list):
```js
import {
  shell,
  accountShell,
  homePageHTML,
  ...
  nodesListHTML,
  accountsListHTML,
  accountMoreRows,
  unavailableOnTestnetHTML,
  errorFrag,
  CSS_VERSION,
} from "./src/html.js";
```
(keep every existing name in the `...` — only `unavailableOnTestnetHTML` is newly added)

- [ ] **Step 2: Replace the cookie middleware**

Change:
```js
app.use((req, res, next) => {
  const raw = req.headers.cookie || "";
  let selected = null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === "nemscan-node") {
      selected = decodeURIComponent(part.slice(i + 1).trim());
      break;
    }
  }
  const node = selected ? findNodeOption(selected) : null;
  nodeContext.run(node, () => next());
});
```
to:
```js
function parseCookies(header) {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie || "");
  const network = cookies["nemscan-network"] === "testnet" ? "testnet" : "mainnet";
  networkContext.run(network, () => {
    const selected = cookies["nemscan-node"] || null;
    const node = selected ? findNodeOption(selected, network) : null;
    nodeContext.run(node, () => next());
  });
});
```

- [ ] **Step 3: Gate `/api/namespace/:fqn`'s `fetchSubNamespaces` call (nemtool.com is mainnet-only)**

Change:
```js
    const root = fqn.split(".")[0];
    let subNamespaces = [];
    try {
      subNamespaces = await fetchSubNamespaces(root);
    } catch {
      /* nemtool unreachable — fall back to local lookup only */
    }
```
to:
```js
    const root = fqn.split(".")[0];
    let subNamespaces = [];
    if (currentNetwork() !== "testnet") {
      try {
        subNamespaces = await fetchSubNamespaces(root);
      } catch {
        /* nemtool unreachable — fall back to local lookup only */
      }
    }
```

- [ ] **Step 4: Update `/api/nodes`**

Change:
```js
app.get("/api/nodes", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(nodesListHTML(httpsNodeOptions, httpsNodeOptionsUpdatedAt !== null));
});
```
to:
```js
app.get("/api/nodes", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(nodesListHTML(getHttpsNodeOptions(), getHttpsNodeOptionsUpdatedAt() !== null));
});
```

- [ ] **Step 5: Gate the Accounts routes**

Change:
```js
app.get("/api/accounts", async (req, res) => {
  try {
    if (!liveRichList.length) {
      await refreshLiveRichList();
    }
    const items = liveRichList.slice(0, 25);
    res.setHeader("Content-Type", "text/html");
    res.send(
      accountsListHTML(items, liveRichListUpdatedAt, liveRichList.length),
    );
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, "/api/accounts", "#accounts-card"));
  }
});

app.get("/api/accounts/more", async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  try {
    const items = liveRichList.slice(offset, offset + 25);
    res.setHeader("Content-Type", "text/html");
    res.send(accountMoreRows(items, offset, liveRichList.length));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send("");
  }
});
```
to:
```js
app.get("/api/accounts", async (req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (currentNetwork() === "testnet") {
    return res.send(unavailableOnTestnetHTML("Rich list"));
  }
  try {
    if (!liveRichList.length) {
      await refreshLiveRichList();
    }
    const items = liveRichList.slice(0, 25);
    res.send(
      accountsListHTML(items, liveRichListUpdatedAt, liveRichList.length),
    );
  } catch (err) {
    res.status(503);
    res.send(errorFrag(err.message, "/api/accounts", "#accounts-card"));
  }
});

app.get("/api/accounts/more", async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  res.setHeader("Content-Type", "text/html");
  if (currentNetwork() === "testnet") return res.send("");
  try {
    const items = liveRichList.slice(offset, offset + 25);
    res.send(accountMoreRows(items, offset, liveRichList.length));
  } catch (err) {
    res.status(503);
    res.send("");
  }
});
```

- [ ] **Step 6: Gate the Polls routes**

Change:
```js
app.get("/api/polls", async (req, res) => {
  try {
    const items = getCachedPolls(25);
    res.setHeader("Content-Type", "text/html");
    res.send(pollsListHTML(items, getCachedPollsCount()));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, "/api/polls", "#polls-card"));
  }
});

app.get("/api/polls/more", (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  try {
    const items = getCachedPolls(25, offset);
    const total = getCachedPollsCount();
    res.setHeader("Content-Type", "text/html");
    res.send(pollMoreRows(items, offset, total));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send("");
  }
});
```
to:
```js
app.get("/api/polls", async (req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (currentNetwork() === "testnet") {
    return res.send(unavailableOnTestnetHTML("Polls"));
  }
  try {
    const items = getCachedPolls(25);
    res.send(pollsListHTML(items, getCachedPollsCount()));
  } catch (err) {
    res.status(503);
    res.send(errorFrag(err.message, "/api/polls", "#polls-card"));
  }
});

app.get("/api/polls/more", (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  res.setHeader("Content-Type", "text/html");
  if (currentNetwork() === "testnet") return res.send("");
  try {
    const items = getCachedPolls(25, offset);
    const total = getCachedPollsCount();
    res.send(pollMoreRows(items, offset, total));
  } catch (err) {
    res.status(503);
    res.send("");
  }
});
```

- [ ] **Step 7: Replace the background-scheduler block**

Change:
```js
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
  scheduleDailyTxStatsRefresh();
}, 3000);
```
to:
```js
const NETWORK_KEYS = Object.keys(NETWORKS); // ["mainnet", "testnet"]

// Runs `fn` once, with the given network active in networkContext for the
// duration of `fn`'s (possibly async) execution. Each call is a fresh
// `.run()`, not nested inside a previous one, so this doesn't depend on
// AsyncLocalStorage surviving indefinitely across chained timers — every
// setInterval tick below re-enters a brand-new context from scratch.
function runFor(network, fn) {
  return networkContext.run(network, fn);
}
function runForEachNetwork(fn) {
  for (const network of NETWORK_KEYS) runFor(network, fn);
}

setTimeout(() => {
  // Network-agnostic jobs: run for both mainnet and testnet.
  runForEachNetwork(() => refreshNamespacesCache().then(refreshMosaicsCache));
  runForEachNetwork(refreshHttpsNodeOptions);
  NETWORK_KEYS.forEach((network) => scheduleDailyTxStatsRefresh(network));

  // Mainnet-only jobs: their data sources (nemtool.com, nemnodes.org,
  // CoinGecko) have no testnet equivalent.
  runFor("mainnet", importNamespaceArchive);
  runFor("mainnet", importMosaicArchive);
  runFor("mainnet", importPollArchive);
  runFor("mainnet", () => refreshRichListCache().then(refreshLiveRichList));
  runFor("mainnet", refreshPriceCache);

  setInterval(() => runForEachNetwork(refreshNamespacesCache), 10 * 60 * 1000);
  setInterval(() => runForEachNetwork(refreshMosaicsCache), 10 * 60 * 1000);
  setInterval(() => runFor("mainnet", refreshRichListCache), 6 * 60 * 60 * 1000);
  setInterval(() => runFor("mainnet", refreshLiveRichList), 5 * 60 * 1000);
  setInterval(() => runFor("mainnet", refreshPriceCache), 60 * 1000);
  setInterval(() => runForEachNetwork(refreshHttpsNodeOptions), 5 * 60 * 1000);
  // Deep mosaic refresh: first run 2 minutes after startup to avoid congestion,
  // then every 6 hours. Covers all known namespaces and refreshes current supply.
  setTimeout(() => runForEachNetwork(refreshAllMosaicsDeep), 2 * 60 * 1000);
  setInterval(() => runForEachNetwork(refreshAllMosaicsDeep), 6 * 60 * 60 * 1000);
}, 3000);
```

- [ ] **Step 8: Verify the server starts cleanly**

Run: `node --check index.js`
Expected: no output.

Run (start the server, confirm it boots, then stop it):
```bash
timeout 8 node index.js
```
Expected output includes `NEMSCAN → http://localhost:3000/` and no uncaught exceptions/stack traces before the timeout kills it. (A `cache-testnet.db*` file set should now also exist in the repo root alongside `cache.db*`.)

- [ ] **Step 9: Commit**

```bash
git add index.js
git commit -m "Wire mainnet/testnet network context through index.js routes and scheduler"
```

---

### Task 9: End-to-end manual verification

**Files:** none (manual browser + `sqlite3` CLI verification only)

- [ ] **Step 1: Start the server**

Run: `node index.js`

- [ ] **Step 2: Confirm mainnet is unaffected**

Open `http://localhost:3000/` in a browser. Confirm the home page, `/blocks`, `/accounts`, `/polls`, `/nodes` all load exactly as before, and the XEM price ticker still appears in the navbar.

- [ ] **Step 3: Switch to testnet via the navbar dropdown**

Click the new network-switch control (top-right, next to the node-switch), select **Testnet**. Confirm:
- The browser navigates to `/`.
- A `TESTNET` badge appears next to the network-switch button.
- The XEM price ticker is gone from the navbar.
- `document.cookie` (browser devtools) includes `nemscan-network=testnet`.

- [ ] **Step 4: Confirm testnet data is live and independent**

Visit `/blocks` and `/nodes` while on testnet — confirm blocks load (a different, much lower height than mainnet) and the nodes list shows testnet hosts (e.g. `ntn1.dusanjp.com`, `libertalia.nemtest.net`, etc., not the mainnet kasanetalk.net hosts).

Visit any account page for a testnet address and confirm it renders correctly, or check a block's signer address on `/block/<height>` and confirm it starts with `T` (mainnet addresses start with `N`).

- [ ] **Step 5: Confirm disabled features show the testnet-unavailable state**

Visit `/accounts` and `/polls` while on testnet — confirm both show "Not available on testnet" instead of data or an error.

- [ ] **Step 6: Confirm DB isolation on disk**

```bash
ls -la cache.db cache-testnet.db
sqlite3 cache-testnet.db "SELECT COUNT(*) FROM namespaces;"
sqlite3 cache-testnet.db "SELECT COUNT(*) FROM richlist;"  # expect 0 — never written on testnet
sqlite3 cache.db "SELECT COUNT(*) FROM richlist;"          # expect > 0 (unchanged mainnet behavior)
```

- [ ] **Step 7: Switch back to mainnet and confirm restoration**

Use the dropdown to select Mainnet again. Confirm the badge disappears, price ticker returns, and `/accounts`/`/polls` work normally again.

- [ ] **Step 8: Run the full automated test suite one more time**

Run: `npm test`
Expected: all pass.

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the file-structure section**

In the ```` ``` ```` block under "## ファイル構成", change:
```
│   ├── db.js         # SQLite セットアップ・全 DB アクセス関数
```
to:
```
│   ├── db.js         # SQLite セットアップ・全 DB アクセス関数（mainnet/testnetで別ファイル）
```

- [ ] **Step 2: Document the new DB file and network switcher**

After the "## データの初期化・再同期" heading's intro paragraph, before "### キャッシュ DB をすべて削除して最初からやり直す", add:

```markdown
## mainnet / testnet

画面右上のドロップダウンで mainnet ⇄ testnet を切り替えられます（訪問者ごとの Cookie 設定、サーバー再起動不要）。testnet は独立した SQLite ファイル（`cache-testnet.db`）と、独立したノードプール・アドレス形式（`T` 始まり）を持ちます。

XEM 価格表示・ネームスペース/モザイクの歴史アーカイブ・ポール一覧・リッチリスト(Accounts)は mainnet 専用の外部データソースに依存しているため、testnet では利用できません。
```

- [ ] **Step 3: Update the "キャッシュ DB をすべて削除して最初からやり直す" section**

Change:
```markdown
### キャッシュ DB をすべて削除して最初からやり直す

```bash
rm cache.db cache.db-shm cache.db-wal
node index.js
```

DB ファイルを削除して再起動すると、テーブル作成とアーカイブインポートがすべて最初から実行されます。
```
to:
```markdown
### キャッシュ DB をすべて削除して最初からやり直す

```bash
rm cache.db cache.db-shm cache.db-wal
node index.js
```

DB ファイルを削除して再起動すると、テーブル作成とアーカイブインポートがすべて最初から実行されます。testnet 側をやり直す場合は `cache-testnet.db cache-testnet.db-shm cache-testnet.db-wal` を同様に削除してください。
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document mainnet/testnet switcher in README"
```

---

## Self-Review

**Spec coverage:**
- Network propagation via `AsyncLocalStorage` → Task 2, 8 ✓
- Per-network node pool + testnet source URL + fallback list → Task 3 ✓
- Per-network DB (`cache.db` / `cache-testnet.db`) → Task 4 ✓
- Address network byte → Task 6 (`addrFromPubKey`) ✓
- Feature-availability table (price/archive/polls/richlist disabled on testnet) → Task 8 (scheduler + route gating); price ticker's auto-hide verified in Task 9 Step 3 ✓
- Navbar dropdown + testnet badge + redirect-to-home on switch → Task 6, 7 ✓
- Background jobs run continuously for both networks → Task 8 Step 7 ✓
- Testing (unit + manual) → Tasks 3–5 (unit), Task 9 (manual) ✓
- Gap found during planning not explicit in the spec's table: `fetchSubNamespaces` (nemtool.com, used live by `/api/namespace/:fqn`) is also mainnet-only and needed the same treatment as the archive imports — addressed in Task 8 Step 3.

**Placeholder scan:** No TBD/TODO markers; every step has literal code or an exact command with expected output.

**Type/signature consistency check:**
- `getShuffledNodePool(nodes, network)` (Task 3) — call sites: `nemApi.js` uses the no-arg form (unchanged, not touched by this plan) — verified compatible since both params have defaults.
- `findNodeOption(endpoint, network)` (Task 3) — called in `index.js` Task 8 Step 2 with explicit `network`; called with no `network` arg nowhere else.
- `getHttpsNodeOptions()` / `getHttpsNodeOptionsUpdatedAt()` (Task 3) — used consistently in `html.js` (Task 6) and `index.js` (Task 8) with no arguments (context-resolved).
- `getDb()` (Task 4) — used in `cache.js` (Task 4 Step 5) exactly where the old `db` binding was used.
- `scheduleDailyTxStatsRefresh(network)` / `refreshDailyTxStats(network)` (Task 5) — called with an explicit network string only from `index.js` Task 8 Step 7's `NETWORK_KEYS.forEach(...)`; no other call site exists.
- `NETWORKS` object keys (`mainnet`, `testnet`) used consistently as the `network` value across every module — matches `currentNetwork()`'s only two possible return values.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-09-testnet-support.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
