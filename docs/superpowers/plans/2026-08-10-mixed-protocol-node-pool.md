# Mixed-Protocol Node Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mix HTTP nodes into nemscan's dynamic node pool alongside HTTPS nodes, so `nemFetch()` load-balances across both instead of discarding every node that doesn't answer on HTTPS.

**Architecture:** `src/nodePool.js`'s `refreshNodeOptions()` (renamed from `refreshHttpsNodeOptions()`) builds two independently-probed candidates per nodewatch-reported node — the original plain-HTTP endpoint and a derived HTTPS-one-port-up endpoint — and admits whichever ones respond, each tagged with a `protocol` field. `getShuffledNodePool()` / `nemFetch()` need no changes since they already treat the pool as opaque endpoint strings. The two places nodes are shown to users (`/nodes` list, node-switch dropdown) get a small `HTTP` badge on protocol:`"http"` entries.

**Tech Stack:** Node.js (`node --test` for tests), Express, no new dependencies.

## Global Constraints

- Full uniform mixing in the shuffle — no weighting HTTPS over HTTP (spec decision).
- `NEM_NODES_FALLBACK` / `NEM_TESTNET_NODES_FALLBACK` in `src/constants.js` stay HTTPS-only and unmodified — they're the cold-start safety net, not part of this change.
- `nemFetch()`, `getShuffledNodePool()`, the 429/race/retry logic, and the node-switch cookie whitelist (`findNodeOption`) get zero code changes — already protocol-agnostic.
- HTTPS pool entries get no badge (stay the unmarked default); only `protocol: "http"` entries get a small `HTTP` badge, styled as a neutral/muted tag, not a warning/error color.
- Rename table (protocol-neutral naming), applied everywhere the old names appear:
  - `httpsNodeOptions` (state field) → `nodeOptions`
  - `httpsNodeOptionsUpdatedAt` (state field) → `nodeOptionsUpdatedAt`
  - `getHttpsNodeOptions()` → `getNodeOptions()`
  - `getHttpsNodeOptionsUpdatedAt()` → `getNodeOptionsUpdatedAt()`
  - `refreshHttpsNodeOptions()` → `refreshNodeOptions()`
  - `probeHttpsNode(host)` → `probeNode(url)` (also changes signature: takes the full candidate URL instead of a bare host, since it must work for both `https://` and `http://` candidates)
  - `findNodeOption()` — name unchanged (already protocol-neutral)

---

### Task 1: Rename to protocol-neutral names (behavior-preserving refactor)

**Files:**
- Modify: `src/nodePool.js` (full file)
- Modify: `index.js:21-26, 118, 793, 914, 930`
- Modify: `src/html.js:24, 95, 118`
- Test: `test/nodePool.test.js` (full file — renames only, no new assertions)

**Interfaces:**
- Produces: `getNodeOptions(network?)`, `getNodeOptionsUpdatedAt(network?)`, `refreshNodeOptions(network?, batchSize?)`, `probeNode(url, timeoutMs?)` — same call signatures as their `*Https*` predecessors except `probeNode` takes a full URL string instead of a bare host.
- Unchanged: `getShuffledNodePool(nodes?, network?)`, `findNodeOption(endpoint, network?)`.

This task only renames symbols and generalizes `probeNode`'s parameter from `host` to a full `url` — candidate generation still produces HTTPS-only entries, so all existing test assertions keep their current expected values (just renamed).

- [ ] **Step 1: Update `test/nodePool.test.js` to use the new names**

Replace the entire file with:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getShuffledNodePool,
  findNodeOption,
  getNodeOptions,
  getNodeOptionsUpdatedAt,
  refreshNodeOptions,
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

test("getNodeOptions defaults to the current network and mainnet/testnet pools are independent", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    // probeNode makes a second, separate fetch call to /chain/height —
    // answer that too, so candidates actually verify as healthy and each
    // network's pool gets populated (a shared/buggy pool would still make
    // this pass if we only checked that *a* refresh happened, so this test
    // asserts the resulting pools' actual contents instead).
    if (u.includes("/chain/height")) {
      return { ok: true, json: async () => ({ height: 12345 }) };
    }
    const isTestnet = u.includes("/testnet/");
    return {
      ok: true,
      json: async () =>
        isTestnet
          ? [{ endpoint: "http://tnode:7890", name: "tnode" }]
          : [{ endpoint: "http://mnode:7890", name: "mnode" }],
    };
  });
  await refreshNodeOptions("mainnet");
  await refreshNodeOptions("testnet");

  const mainnetPool = getNodeOptions("mainnet");
  const testnetPool = getNodeOptions("testnet");
  assert.equal(mainnetPool.length, 1);
  assert.equal(testnetPool.length, 1);
  assert.notEqual(mainnetPool[0].endpoint, testnetPool[0].endpoint);
  // refreshNodeOptions derives the HTTPS candidate one port up from the
  // plain-HTTP endpoint nodewatch listed (7890 -> 7891).
  assert.equal(mainnetPool[0].host, "mnode:7891");
  assert.equal(testnetPool[0].host, "tnode:7891");

  networkContext.run("testnet", () => {
    const pool = getNodeOptions();
    assert.equal(pool[0].host, "tnode:7891");
  });

  assert.ok(getNodeOptionsUpdatedAt("mainnet") !== null);
  assert.ok(getNodeOptionsUpdatedAt("testnet") !== null);
});
```

- [ ] **Step 2: Run the test file to confirm it fails**

Run: `node --test test/nodePool.test.js`
Expected: FAIL — `SyntaxError` / import error, because `src/nodePool.js` doesn't yet export `getNodeOptions`, `getNodeOptionsUpdatedAt`, or `refreshNodeOptions`.

- [ ] **Step 3: Rename in `src/nodePool.js`**

Replace the entire file with:

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

// ── Node verification ─────────────────────────────────────────────────────────

// nodewatch only ever lists each node's plain-HTTP REST endpoint (host:7890);
// it never lists an "https://" entry. By NIS1 convention the same host
// commonly answers HTTPS one port up (host:7891 — exactly how our fallback
// pools in constants.js are configured), so we derive that candidate and probe
// it directly rather than trusting the registry.
const state = {
  mainnet: { nodeOptions: [], nodeOptionsUpdatedAt: null, refreshing: false },
  testnet: { nodeOptions: [], nodeOptionsUpdatedAt: null, refreshing: false },
};

export function getNodeOptions(network = currentNetwork()) {
  return state[network].nodeOptions;
}

export function getNodeOptionsUpdatedAt(network = currentNetwork()) {
  return state[network].nodeOptionsUpdatedAt;
}

export async function probeNode(url, timeoutMs = NODE_PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/chain/height`, {
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
export async function refreshNodeOptions(network = currentNetwork(), batchSize = 12) {
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
      const ok = await Promise.all(batch.map((c) => probeNode(c.endpoint)));
      batch.forEach((c, idx) => {
        if (ok[idx]) verified.push(c);
      });
    }
    if (verified.length > 0) {
      s.nodeOptions = verified;
    }
  } catch (err) {
    console.error(`Node options refresh failed (${network}):`, err.message);
  } finally {
    s.nodeOptionsUpdatedAt = Date.now();
    s.refreshing = false;
  }
}

export function findNodeOption(endpoint, network = currentNetwork()) {
  return state[network].nodeOptions.find((n) => n.endpoint === endpoint) || null;
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
// dynamic, verified pool when it has at least one entry, else that
// network's hardcoded fallback (cold start, or a sustained nodewatch outage
// before any successful refresh has ever completed). Called fresh on every
// nemFetch() so load spreads across nodes instead of always starting from the
// same one.
//
// `nodes` defaults to the live pool for the current network; tests pass an
// explicit array instead of reaching into this module's internal state.
export function getShuffledNodePool(
  nodes = getNodeOptions(),
  network = currentNetwork(),
) {
  const base =
    nodes.length > 0 ? nodes.map((n) => n.endpoint) : NETWORKS[network].fallbackNodes;
  return shuffle([...base]);
}
```

- [ ] **Step 4: Update `index.js` call sites**

Replace:
```js
import {
  findNodeOption,
  getHttpsNodeOptions,
  getHttpsNodeOptionsUpdatedAt,
  refreshHttpsNodeOptions,
} from "./src/nodePool.js";
```
with:
```js
import {
  findNodeOption,
  getNodeOptions,
  getNodeOptionsUpdatedAt,
  refreshNodeOptions,
} from "./src/nodePool.js";
```

Replace the comment above the cookie-whitelist middleware:
```js
// Reads the navbar's node-switch cookie and, if it names one of the currently
// cached HTTPS node options, makes that node available to nemFetch() for the
```
with:
```js
// Reads the navbar's node-switch cookie and, if it names one of the currently
// cached node options, makes that node available to nemFetch() for the
```

Replace:
```js
  res.send(nodesListHTML(getHttpsNodeOptions(), getHttpsNodeOptionsUpdatedAt() !== null));
```
with:
```js
  res.send(nodesListHTML(getNodeOptions(), getNodeOptionsUpdatedAt() !== null));
```

Replace:
```js
  runForEachNetwork(refreshHttpsNodeOptions);
```
with:
```js
  runForEachNetwork(refreshNodeOptions);
```

Replace:
```js
  setInterval(() => runForEachNetwork(refreshHttpsNodeOptions), 5 * 60 * 1000);
```
with:
```js
  setInterval(() => runForEachNetwork(refreshNodeOptions), 5 * 60 * 1000);
```

- [ ] **Step 5: Update `src/html.js` call sites**

Replace:
```js
import { getHttpsNodeOptions, getHttpsNodeOptionsUpdatedAt } from "./nodePool.js";
```
with:
```js
import { getNodeOptions, getNodeOptionsUpdatedAt } from "./nodePool.js";
```

Replace:
```js
  const items = [...getHttpsNodeOptions()]
```
with:
```js
  const items = [...getNodeOptions()]
```

Replace:
```js
        ${items || `<div class="node-menu-empty">${getHttpsNodeOptionsUpdatedAt() ? "No HTTPS-reachable nodes right now" : "Probing active nodes for HTTPS…"}</div>`}
```
with:
```js
        ${items || `<div class="node-menu-empty">${getNodeOptionsUpdatedAt() ? "No HTTPS-reachable nodes right now" : "Probing active nodes for HTTPS…"}</div>`}
```

(This copy text still says "HTTPS" — that's corrected in Task 4, which touches this same line again. Leaving it as-is here keeps this step a pure rename with no behavior/copy change, matching the task's scope.)

- [ ] **Step 6: Run the full test suite to confirm it passes**

Run: `node --test`
Expected: PASS — all tests green, including the renamed `test/nodePool.test.js`.

- [ ] **Step 7: Commit**

```bash
git add src/nodePool.js index.js src/html.js test/nodePool.test.js
git commit -m "Rename node-pool API to protocol-neutral names ahead of HTTP support"
```

---

### Task 2: Add HTTP candidate generation and probing

**Files:**
- Modify: `src/nodePool.js` (the `refreshNodeOptions` candidate-building loop, and its header comment)
- Test: `test/nodePool.test.js`

**Interfaces:**
- Consumes: `probeNode(url, timeoutMs?)` from Task 1 (unchanged signature).
- Produces: `refreshNodeOptions()` now populates `getNodeOptions()` entries with a `protocol: "https" | "http"` field. Later tasks (3, 4) read `n.protocol` to decide whether to render a badge.

- [ ] **Step 1: Update `test/nodePool.test.js`'s last test and add three new tests**

Replace the final test (`"getNodeOptions defaults to the current network..."`) with:

```js
test("getNodeOptions defaults to the current network and mainnet/testnet pools are independent", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    // probeNode makes a second, separate fetch call to /chain/height for
    // both the HTTPS and HTTP candidate — answer both as healthy, so each
    // network's pool ends up with one entry per protocol.
    if (u.includes("/chain/height")) {
      return { ok: true, json: async () => ({ height: 12345 }) };
    }
    const isTestnet = u.includes("/testnet/");
    return {
      ok: true,
      json: async () =>
        isTestnet
          ? [{ endpoint: "http://tnode:7890", name: "tnode" }]
          : [{ endpoint: "http://mnode:7890", name: "mnode" }],
    };
  });
  await refreshNodeOptions("mainnet");
  await refreshNodeOptions("testnet");

  const mainnetPool = getNodeOptions("mainnet");
  const testnetPool = getNodeOptions("testnet");
  assert.equal(mainnetPool.length, 2);
  assert.equal(testnetPool.length, 2);
  // refreshNodeOptions pushes the derived HTTPS candidate before the
  // original HTTP candidate for each nodewatch entry, so with a single
  // source node per network, pool order is deterministic here.
  assert.equal(mainnetPool[0].host, "mnode:7891");
  assert.equal(mainnetPool[0].protocol, "https");
  assert.equal(mainnetPool[1].host, "mnode:7890");
  assert.equal(mainnetPool[1].protocol, "http");
  assert.equal(testnetPool[0].host, "tnode:7891");
  assert.equal(testnetPool[1].host, "tnode:7890");

  networkContext.run("testnet", () => {
    const pool = getNodeOptions();
    assert.equal(pool[0].host, "tnode:7891");
  });

  assert.ok(getNodeOptionsUpdatedAt("mainnet") !== null);
  assert.ok(getNodeOptionsUpdatedAt("testnet") !== null);
});

test("refreshNodeOptions admits only the HTTPS candidate when the HTTP endpoint fails its probe", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.startsWith("https://") && u.includes("/chain/height")) {
      return { ok: true, json: async () => ({ height: 1 }) };
    }
    if (u.startsWith("http://") && u.includes("/chain/height")) {
      return { ok: false };
    }
    return {
      ok: true,
      json: async () => [{ endpoint: "http://onlyhttps:7890", name: "onlyhttps" }],
    };
  });
  await refreshNodeOptions("mainnet");
  const pool = getNodeOptions("mainnet");
  assert.equal(pool.length, 1);
  assert.equal(pool[0].protocol, "https");
  assert.equal(pool[0].host, "onlyhttps:7891");
});

test("refreshNodeOptions admits only the HTTP candidate when the HTTPS endpoint fails its probe", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.startsWith("http://") && u.includes("/chain/height")) {
      return { ok: true, json: async () => ({ height: 1 }) };
    }
    if (u.startsWith("https://") && u.includes("/chain/height")) {
      return { ok: false };
    }
    return {
      ok: true,
      json: async () => [{ endpoint: "http://onlyhttp:7890", name: "onlyhttp" }],
    };
  });
  await refreshNodeOptions("mainnet");
  const pool = getNodeOptions("mainnet");
  assert.equal(pool.length, 1);
  assert.equal(pool[0].protocol, "http");
  assert.equal(pool[0].host, "onlyhttp:7890");
});

test("refreshNodeOptions admits both candidates when a host answers on both protocols", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      return { ok: true, json: async () => ({ height: 1 }) };
    }
    return {
      ok: true,
      json: async () => [{ endpoint: "http://both:7890", name: "both" }],
    };
  });
  await refreshNodeOptions("mainnet");
  const pool = getNodeOptions("mainnet");
  assert.equal(pool.length, 2);
  assert.deepEqual(pool.map((n) => n.protocol).sort(), ["http", "https"]);
  assert.ok(pool.some((n) => n.protocol === "http" && n.host === "both:7890"));
  assert.ok(pool.some((n) => n.protocol === "https" && n.host === "both:7891"));
});
```

- [ ] **Step 2: Run the test file to confirm the new/updated tests fail**

Run: `node --test test/nodePool.test.js`
Expected: FAIL — the updated "pools are independent" test expects `mainnetPool.length === 2` but the current implementation still only produces 1 (HTTPS-only) entry per node; the three new tests fail because no entry ever has a `protocol` field yet.

- [ ] **Step 3: Update `src/nodePool.js`'s candidate generation**

Replace the header comment above `const state = {`:
```js
// nodewatch only ever lists each node's plain-HTTP REST endpoint (host:7890);
// it never lists an "https://" entry. By NIS1 convention the same host
// commonly answers HTTPS one port up (host:7891 — exactly how our fallback
// pools in constants.js are configured), so we derive that candidate and probe
// it directly rather than trusting the registry.
```
with:
```js
// nodewatch only ever lists each node's plain-HTTP REST endpoint (host:7890).
// NIS1 has no protocol requirement, so that endpoint is itself one candidate
// — and since the same host commonly also answers HTTPS one port up
// (host:7891, exactly how our fallback pools in constants.js are
// configured), we derive a second HTTPS candidate. Both are probed and
// admitted independently: a host can contribute one or two pool entries
// depending on which protocol(s) it actually answers on.
```

Replace the candidate-building loop inside `refreshNodeOptions`:
```js
      if (isPrivateHostname(u.hostname)) continue;
      const httpsPort = u.port ? String(Number(u.port) + 1) : "443";
      const host = `${u.hostname}:${httpsPort}`;
      candidates.push({
        name: n.name || u.hostname,
        host,
        endpoint: `https://${host}`,
      });
    }
```
with:
```js
      if (isPrivateHostname(u.hostname)) continue;
      const httpsPort = u.port ? String(Number(u.port) + 1) : "443";
      const httpsHost = `${u.hostname}:${httpsPort}`;
      candidates.push({
        name: n.name || u.hostname,
        host: httpsHost,
        endpoint: `https://${httpsHost}`,
        protocol: "https",
      });
      candidates.push({
        name: n.name || u.hostname,
        host: u.host,
        endpoint: `http://${u.host}`,
        protocol: "http",
      });
    }
```

Replace the doc comment above `getShuffledNodePool`:
```js
// Returns a freshly shuffled copy of the current network's node pool: the
// dynamic, verified pool when it has at least one entry, else that
```
with:
```js
// Returns a freshly shuffled copy of the current network's node pool: the
// dynamic, verified pool (HTTPS and HTTP entries mixed together, uniformly
// shuffled) when it has at least one entry, else that
```

- [ ] **Step 4: Run the test file to confirm it passes**

Run: `node --test test/nodePool.test.js`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/nodePool.js test/nodePool.test.js
git commit -m "Probe and admit HTTP node candidates alongside HTTPS ones"
```

---

### Task 3: Show an HTTP badge on the `/nodes` list

**Files:**
- Modify: `public/style.css` (new `.proto-badge` class)
- Modify: `src/html.js` (`renderNodeRow`, and `nodesListHTML`'s attribution copy)
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: `n.protocol` (`"https" | "http"`) on the node objects `renderNodeRow(n, num)` receives, produced by Task 2's `refreshNodeOptions`.
- Produces: `.proto-badge` CSS class, reused as-is by Task 4.

- [ ] **Step 1: Add failing tests to `test/html.test.js`**

Update the top import line:
```js
import { globalTxMoreRows } from "../src/html.js";
```
to:
```js
import { globalTxMoreRows, renderNodeRow } from "../src/html.js";
```

Append these two tests to the file:

```js
test("renderNodeRow shows an HTTP badge for a protocol:http node", () => {
  const html = renderNodeRow(
    { name: "onlyhttp", host: "onlyhttp:7890", endpoint: "http://onlyhttp:7890", protocol: "http" },
    1,
  );
  assert.match(html, /proto-badge">HTTP<\/span>/);
});

test("renderNodeRow shows no protocol badge for a protocol:https node", () => {
  const html = renderNodeRow(
    { name: "onlyhttps", host: "onlyhttps:7891", endpoint: "https://onlyhttps:7891", protocol: "https" },
    1,
  );
  assert.doesNotMatch(html, /proto-badge/);
});
```

- [ ] **Step 2: Run the test file to confirm it fails**

Run: `node --test test/html.test.js`
Expected: FAIL — `renderNodeRow` isn't exported/imported error, or (once import is fixed) no `proto-badge` string in the output for the first test.

- [ ] **Step 3: Add the CSS class**

In `public/style.css`, insert immediately after the `.network-badge { ... }` block (before the `/* Footer */` comment):

```css
.proto-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--muted);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 2px 5px;
    line-height: 1;
    white-space: nowrap;
}
```

- [ ] **Step 4: Update `renderNodeRow` in `src/html.js`**

Replace (the source literally contains the JS escape sequences `\u2014` and `\u25cf` as text — match it exactly, character for character, do not substitute the rendered em-dash/bullet glyphs):
```js
export function renderNodeRow(n, num) {
  return `<tr>
    <td class="td-num">${num}</td>
    <td>${esc(n.name || "\u2014")}</td>
    <td><div class="node-endpoint-cell"><a href="${esc(n.endpoint)}/node/info" class="mono-link" target="_blank" rel="noopener">${esc(n.host || n.endpoint)}</a></div></td>
    <td><span class="status-ok">\u25cf Active</span></td>
  </tr>`;
}
```
with:
```js
export function renderNodeRow(n, num) {
  const badge = n.protocol === "http" ? ` <span class="proto-badge">HTTP</span>` : "";
  return `<tr>
    <td class="td-num">${num}</td>
    <td>${esc(n.name || "\u2014")}</td>
    <td><div class="node-endpoint-cell"><a href="${esc(n.endpoint)}/node/info" class="mono-link" target="_blank" rel="noopener">${esc(n.host || n.endpoint)}</a>${badge}</div></td>
    <td><span class="status-ok">\u25cf Active</span></td>
  </tr>`;
}
```

Also update the attribution copy in `nodesListHTML` (same file) to stop claiming an HTTPS-only check. Replace:
```js
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>The node information on this page is sourced from <a href="https://nodewatch.symbol.tools/" target="_blank" rel="noopener">nodewatch.symbol.tools</a>, a network crawler that lists all discovered NEM nodes, verified here by an HTTPS reachability check.</p>
```
with:
```js
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>The node information on this page is sourced from <a href="https://nodewatch.symbol.tools/" target="_blank" rel="noopener">nodewatch.symbol.tools</a>, a network crawler that lists all discovered NEM nodes, verified here by a live reachability check over HTTPS or HTTP.</p>
```

- [ ] **Step 5: Run the test file to confirm it passes**

Run: `node --test test/html.test.js`
Expected: PASS — both new tests green, plus the two pre-existing `globalTxMoreRows` tests still pass.

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public/style.css src/html.js test/html.test.js
git commit -m "Show an HTTP badge on mixed-protocol node rows in the /nodes list"
```

---

### Task 4: Show an HTTP badge in the node-switch dropdown

**Files:**
- Modify: `src/html.js` (`nodeSwitchHTML`, and the `selectNode` client-script comment)
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: `.proto-badge` CSS class from Task 3; `n.protocol` on entries from `getNodeOptions()` (Task 2); `refreshNodeOptions(network?)` from Task 1/2 (used only in the test, to populate the pool).

- [ ] **Step 1: Add a failing test to `test/html.test.js`**

Update the top import lines:
```js
import { globalTxMoreRows, renderNodeRow } from "../src/html.js";
```
to:
```js
import { globalTxMoreRows, renderNodeRow, nodeSwitchHTML } from "../src/html.js";
import { refreshNodeOptions } from "../src/nodePool.js";
```

Append:

```js
test("nodeSwitchHTML renders exactly one HTTP badge when the pool has one http and one https entry for the same host", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      return { ok: true, json: async () => ({ height: 1 }) };
    }
    return {
      ok: true,
      json: async () => [{ endpoint: "http://mixed:7890", name: "mixed" }],
    };
  });
  await refreshNodeOptions("mainnet");
  const html = nodeSwitchHTML();
  const badgeCount = (html.match(/proto-badge">HTTP<\/span>/g) || []).length;
  assert.equal(badgeCount, 1);
  assert.match(html, /mixed:7890/);
  assert.match(html, /mixed:7891/);
});
```

- [ ] **Step 2: Run the test file to confirm it fails**

Run: `node --test test/html.test.js`
Expected: FAIL — `badgeCount` is 0 (no badge markup exists yet in `nodeSwitchHTML`'s output).

- [ ] **Step 3: Update `nodeSwitchHTML` in `src/html.js`**

Replace:
```js
export function nodeSwitchHTML() {
  const active = nodeContext.getStore();
  const activeEndpoint = active ? active.endpoint : "";
  const activeLabel = active ? active.name : "Auto";
  const isActive = (ep) => (ep === activeEndpoint ? " active" : "");
  const items = [...getNodeOptions()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (n) => `
        <button type="button" class="node-menu-item${isActive(n.endpoint)}" data-node-endpoint="${esc(n.endpoint)}" data-node-name="${esc(n.name)}" role="menuitem" onclick="selectNode(this)">
          <span class="node-menu-dot"></span>
          <span class="node-menu-text"><span class="node-menu-name">${esc(n.name)}</span><span class="node-menu-sub">${esc(n.host)}</span></span>
        </button>`,
    )
    .join("");
  return `<div class="node-switch">
      <button type="button" class="node-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleNodeMenu(event)" title="Connection node">
        <span class="node-switch-dot is-live"></span>
        <span class="node-switch-label">${esc(activeLabel)}</span>
        <span class="node-switch-caret">&#9662;</span>
      </button>
      <div class="node-menu" role="menu" aria-label="Connection node">
        <div class="node-menu-head">Connect via <span class="node-menu-note">active HTTPS nodes</span></div>
        <button type="button" class="node-menu-item${isActive("")}" data-node-endpoint="" data-node-name="Auto" role="menuitem" onclick="selectNode(this)">
          <span class="node-menu-dot"></span>
          <span class="node-menu-text"><span class="node-menu-name">Auto</span><span class="node-menu-sub">randomized node pool</span></span>
        </button>
        <div class="node-menu-sep"></div>
        ${items || `<div class="node-menu-empty">${getNodeOptionsUpdatedAt() ? "No HTTPS-reachable nodes right now" : "Probing active nodes for HTTPS…"}</div>`}
      </div>
    </div>`;
}
```
with:
```js
export function nodeSwitchHTML() {
  const active = nodeContext.getStore();
  const activeEndpoint = active ? active.endpoint : "";
  const activeLabel = active ? active.name : "Auto";
  const isActive = (ep) => (ep === activeEndpoint ? " active" : "");
  const items = [...getNodeOptions()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => {
      const badge = n.protocol === "http" ? ` <span class="proto-badge">HTTP</span>` : "";
      return `
        <button type="button" class="node-menu-item${isActive(n.endpoint)}" data-node-endpoint="${esc(n.endpoint)}" data-node-name="${esc(n.name)}" role="menuitem" onclick="selectNode(this)">
          <span class="node-menu-dot"></span>
          <span class="node-menu-text"><span class="node-menu-name">${esc(n.name)}</span><span class="node-menu-sub">${esc(n.host)}${badge}</span></span>
        </button>`;
    })
    .join("");
  return `<div class="node-switch">
      <button type="button" class="node-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleNodeMenu(event)" title="Connection node">
        <span class="node-switch-dot is-live"></span>
        <span class="node-switch-label">${esc(activeLabel)}</span>
        <span class="node-switch-caret">&#9662;</span>
      </button>
      <div class="node-menu" role="menu" aria-label="Connection node">
        <div class="node-menu-head">Connect via <span class="node-menu-note">active nodes</span></div>
        <button type="button" class="node-menu-item${isActive("")}" data-node-endpoint="" data-node-name="Auto" role="menuitem" onclick="selectNode(this)">
          <span class="node-menu-dot"></span>
          <span class="node-menu-text"><span class="node-menu-name">Auto</span><span class="node-menu-sub">randomized node pool</span></span>
        </button>
        <div class="node-menu-sep"></div>
        ${items || `<div class="node-menu-empty">${getNodeOptionsUpdatedAt() ? "No active nodes right now" : "Probing active nodes…"}</div>`}
      </div>
    </div>`;
}
```

Also update the client-script comment above `selectNode` (still in `src/html.js`), which currently mischaracterizes the pool as HTTPS-only. Replace:
```js
  // The picker only ever offers endpoints the server already validated against
  // its live HTTPS node cache, so we just hand the choice back as a cookie
  // and reload — nemFetch() on the server then prefers that node for this browser.
```
with:
```js
  // The picker only ever offers endpoints the server already validated against
  // its live node cache, so we just hand the choice back as a cookie
  // and reload — nemFetch() on the server then prefers that node for this browser.
```

- [ ] **Step 4: Run the test file to confirm it passes**

Run: `node --test test/html.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/html.js test/html.test.js
git commit -m "Show an HTTP badge in the node-switch dropdown for mixed-protocol entries"
```

---

### Task 5: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `node index.js`
Expected: starts without errors, logs listening port.

- [ ] **Step 2: Wait for the first node-pool refresh, then check `/nodes`**

The first `refreshNodeOptions` run fires shortly after startup (see `index.js`'s `setTimeout` block). Once it's completed (check server logs, or wait ~10s), open `http://localhost:3000/nodes` in a browser.

Expected:
- Table renders with active nodes.
- Any node that only answers on HTTP shows a small `HTTP` badge next to its host in the Endpoint column; HTTPS-only nodes show no badge.
- Clicking an HTTP node's endpoint link opens `.../node/info` in a new tab with no error/blocked-request shown in the nemscan page's own devtools console (mixed-content blocking does not apply to plain link navigation — see the design doc's Problem section).

- [ ] **Step 3: Check the node-switch dropdown**

Click the node-switch control in the navbar.

Expected: same `HTTP` badge appears next to any HTTP-only entry's host subtext; selecting one sets the cookie and reloads the page successfully (confirms `nemFetch()` on the server can actually complete requests against an HTTP node end-to-end, not just that the UI renders correctly).

- [ ] **Step 4: Confirm no leftover stale "HTTPS-only" copy**

Visually scan the `/nodes` page and the dropdown (including the dropdown's empty state — trigger it by temporarily renaming `NETWORKS.mainnet.nodeSourceApi` or just check the copy in `src/html.js` directly) for any remaining text implying HTTPS-only. Task 1 Step 5 intentionally left `nodeSwitchHTML`'s empty-state copy saying "HTTPS" as a placeholder; Task 4 Step 3 already replaced it with the protocol-neutral "No active nodes right now" / "Probing active nodes…". Confirm that replacement is in place (`grep -n "HTTPS" src/html.js` should no longer show either string) — if it somehow wasn't applied, apply it now, re-run `node --test`, and commit.
