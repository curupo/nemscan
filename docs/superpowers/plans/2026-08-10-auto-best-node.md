# Auto Best Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When no explicit node is chosen (the navbar's "Auto" option), `nemFetch()` should try the fastest known-responsive node first instead of a fresh random node on every call, so it stays fixed until the user explicitly switches or the pinned node stops being the clear fastest.

**Architecture:** `src/nodePool.js`'s existing 5-minute `refreshNodeOptions()` cycle is extended to time each candidate's health probe (`probeNode()` starts returning `{ ok, latencyMs }` instead of a bare boolean) and derive a per-network `autoBestNode` from the fastest verified candidate, replacing it only when a new candidate is decisively faster (hysteresis) or the current one drops out of the verified pool entirely (forced replacement). `src/nemApi.js`'s sequential fetch path tries `autoBestNode` first whenever there's no explicit cookie-based preferred node, leaving the existing random-shuffle fallback chain (2nd attempt onward) and race-mode path untouched.

**Tech Stack:** Node.js (`node --test` / `node:assert/strict`), Express — no new dependencies.

## Global Constraints

- Explicit node selection (`nemscan-node` cookie / `nodeContext`) always wins over `autoBestNode` — zero behavior change there.
- Race mode (`options.race = true`, used only by `fetchNamespacesFromNode()`) is unchanged.
- Fallback slots (2nd attempt onward) in the sequential path keep today's random-shuffle order — only the first attempt changes.
- Hysteresis margin: `AUTO_BEST_NODE_HYSTERESIS_MS = 150` (new constant in `src/constants.js`) — a new candidate only replaces the current `autoBestNode` if it is at least 150ms faster than the current node's own fresh measurement in that same refresh cycle.
- Forced replacement: if the current `autoBestNode`'s endpoint is absent from the newly verified pool (it went down / got delisted), replace immediately regardless of margin.
- Cold start: before the first successful `refreshNodeOptions()` completes, `autoBestNode` is `null` and the sequential path behaves exactly as it does today (pure shuffle).
- Test framework/conventions: `node:test` + `node:assert/strict`, one file per module under `test/`, `t.mock.method(global, "fetch", ...)` to fake network calls, `t.mock.timers.enable({ apis: ["Date"] })` + `t.mock.timers.tick(ms)` to fake elapsed time deterministically (see `test/nemApi.test.js`'s existing wall-clock test for the established pattern).

---

### Task 1: `probeNode()` measures and returns latency

**Files:**
- Modify: `src/nodePool.js:56-71` (the `probeNode` function)
- Test: `test/nodePool.test.js` (add new tests; add `probeNode` to the existing import from `../src/nodePool.js`)

**Interfaces:**
- Produces: `probeNode(url, timeoutMs?)` now resolves to `{ ok: boolean, latencyMs: number | null }` (was `boolean`). `latencyMs` is the elapsed wall-clock time from just before the `fetch` call to just after `res.json()` resolves, present only when `ok` is `true`.
- Consumed by: Task 2's `refreshNodeOptions()` (in the same file).

- [ ] **Step 1: Write the failing tests**

Add `probeNode` to the existing `nodePool.js` import at the top of `test/nodePool.test.js`:

```js
import {
  getShuffledNodePool,
  findNodeOption,
  getNodeOptions,
  getNodeOptionsUpdatedAt,
  refreshNodeOptions,
  probeNode,
} from "../src/nodePool.js";
```

Append these tests to `test/nodePool.test.js`:

```js
test("probeNode resolves to { ok: true, latencyMs } measuring elapsed time on success", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  t.mock.method(global, "fetch", async () => {
    t.mock.timers.tick(42);
    return { ok: true, json: async () => ({ height: 1 }) };
  });
  const result = await probeNode("https://node:7891");
  assert.equal(result.ok, true);
  assert.equal(result.latencyMs, 42);
});

test("probeNode resolves to { ok: false, latencyMs: null } when the response is not ok", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: false }));
  const result = await probeNode("https://node:7891");
  assert.deepEqual(result, { ok: false, latencyMs: null });
});

test("probeNode resolves to { ok: false, latencyMs: null } when the height field isn't finite", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    json: async () => ({ height: "not a number" }),
  }));
  const result = await probeNode("https://node:7891");
  assert.deepEqual(result, { ok: false, latencyMs: null });
});

test("probeNode resolves to { ok: false, latencyMs: null } when fetch throws", async (t) => {
  t.mock.method(global, "fetch", async () => {
    throw new Error("network error");
  });
  const result = await probeNode("https://node:7891");
  assert.deepEqual(result, { ok: false, latencyMs: null });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/nodePool.test.js`
Expected: the 4 new tests FAIL — `result.latencyMs` is `undefined` (current `probeNode` resolves to a plain `boolean`, so `result.ok` / `result.latencyMs` read off a boolean primitive).

- [ ] **Step 3: Implement the minimal change**

Replace `probeNode` in `src/nodePool.js` (currently lines 56-71):

```js
export async function probeNode(url, timeoutMs = NODE_PROBE_TIMEOUT_MS) {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/chain/height`, {
      signal: ctrl.signal,
    });
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

- [ ] **Step 4: Fix `refreshNodeOptions()`'s call site so the module still compiles/behaves correctly**

`refreshNodeOptions()` (`src/nodePool.js:75-122`) currently treats `probeNode`'s result as a boolean directly (`ok[idx]`). Update just the consuming lines so the rest of the test suite (which exercises `refreshNodeOptions` end-to-end) keeps passing with the new return shape — replace:

```js
    const verified = [];
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const ok = await Promise.all(batch.map((c) => probeNode(c.endpoint)));
      batch.forEach((c, idx) => {
        if (ok[idx]) verified.push(c);
      });
    }
```

with:

```js
    const verified = [];
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((c) => probeNode(c.endpoint)));
      batch.forEach((c, idx) => {
        if (results[idx].ok) verified.push({ ...c, latencyMs: results[idx].latencyMs });
      });
    }
```

- [ ] **Step 5: Run the full test file to verify everything passes**

Run: `node --test test/nodePool.test.js`
Expected: PASS — the 4 new `probeNode` tests, plus all pre-existing tests in the file (they only assert on `host`/`protocol`/`name`/array length, so the added `latencyMs` field on verified candidates doesn't break them).

- [ ] **Step 6: Commit**

```bash
git add src/nodePool.js test/nodePool.test.js
git commit -m "nodePool: measure latency in probeNode"
```

---

### Task 2: Compute and expose the server-wide `autoBestNode`

**Files:**
- Modify: `src/constants.js` (add `AUTO_BEST_NODE_HYSTERESIS_MS`)
- Modify: `src/nodePool.js` (state shape, new `updateAutoBestNode` helper, new `getAutoBestNode` export, wire into `refreshNodeOptions`)
- Test: `test/nodePool.test.js`

**Interfaces:**
- Consumes: `probeNode()`'s `{ ok, latencyMs }` from Task 1.
- Produces: `getAutoBestNode(network = currentNetwork())` → `{ name, host, endpoint, protocol, latencyMs } | null`. Consumed by Task 3 (`src/nemApi.js`).

- [ ] **Step 1: Write the failing tests**

Add `getAutoBestNode` to the `nodePool.js` import in `test/nodePool.test.js` (alongside `probeNode` added in Task 1):

```js
import {
  getShuffledNodePool,
  findNodeOption,
  getNodeOptions,
  getNodeOptionsUpdatedAt,
  refreshNodeOptions,
  probeNode,
  getAutoBestNode,
} from "../src/nodePool.js";
```

Append these tests to `test/nodePool.test.js`:

```js
test("refreshNodeOptions sets getAutoBestNode to the fastest verified candidate", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      t.mock.timers.tick(u.includes("slow") ? 300 : 50);
      return { ok: true, json: async () => ({ height: 1 }) };
    }
    return {
      ok: true,
      json: async () => [
        { endpoint: "http://fast:7890", name: "fast" },
        { endpoint: "http://slow:7890", name: "slow" },
      ],
    };
  });
  // batchSize=1 makes probing fully sequential, so the shared fake clock's
  // ticks aren't interleaved across concurrent probeNode() calls.
  await refreshNodeOptions("mainnet", 1);
  const best = getAutoBestNode("mainnet");
  assert.equal(best.name, "fast");
  assert.equal(best.latencyMs, 50);
});

test("refreshNodeOptions keeps the current autoBestNode when a new candidate is only marginally faster (hysteresis)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let round = 1;
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      t.mock.timers.tick(u.includes("a") ? 100 : round === 1 ? 400 : 80);
      return { ok: true, json: async () => ({ height: 1 }) };
    }
    return {
      ok: true,
      json: async () => [
        { endpoint: "http://a:7890", name: "a" },
        { endpoint: "http://b:7890", name: "b" },
      ],
    };
  });
  await refreshNodeOptions("mainnet", 1);
  assert.equal(getAutoBestNode("mainnet").name, "a"); // round 1: a=100ms, b=400ms

  round = 2;
  await refreshNodeOptions("mainnet", 1);
  // round 2: a is still 100ms, b improved to 80ms — only 20ms faster than
  // a's fresh measurement this round, well under the 150ms margin.
  assert.equal(getAutoBestNode("mainnet").name, "a");
});

test("refreshNodeOptions switches autoBestNode once a candidate is faster than the margin", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let round = 1;
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      t.mock.timers.tick(u.includes("a") ? 300 : round === 1 ? 1000 : 140);
      return { ok: true, json: async () => ({ height: 1 }) };
    }
    return {
      ok: true,
      json: async () => [
        { endpoint: "http://a:7890", name: "a" },
        { endpoint: "http://b:7890", name: "b" },
      ],
    };
  });
  await refreshNodeOptions("mainnet", 1);
  assert.equal(getAutoBestNode("mainnet").name, "a"); // round 1: a=300ms, b=1000ms

  round = 2;
  await refreshNodeOptions("mainnet", 1);
  // round 2: a is still 300ms, b improved to 140ms — 160ms faster than a's
  // fresh measurement this round, over the 150ms margin.
  assert.equal(getAutoBestNode("mainnet").name, "b");
});

test("refreshNodeOptions forces a switch when the current autoBestNode drops out of the verified pool", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let round = 1;
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      t.mock.timers.tick(round === 1 ? 100 : 500);
      return { ok: true, json: async () => ({ height: 1 }) };
    }
    return {
      ok: true,
      json: async () =>
        round === 1
          ? [{ endpoint: "http://a:7890", name: "a" }]
          : [{ endpoint: "http://b:7890", name: "b" }],
    };
  });
  await refreshNodeOptions("mainnet", 1);
  assert.equal(getAutoBestNode("mainnet").name, "a");

  round = 2; // "a" is no longer reported by nodewatch at all this cycle
  await refreshNodeOptions("mainnet", 1);
  // "b" is much slower (500ms) than "a" ever was, but "a" is gone, so the
  // margin check doesn't apply — must switch anyway.
  assert.equal(getAutoBestNode("mainnet").name, "b");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/nodePool.test.js`
Expected: the 4 new tests FAIL — `getAutoBestNode` is not exported yet (`TypeError: getAutoBestNode is not a function` or `undefined`).

- [ ] **Step 3: Add the hysteresis constant**

In `src/constants.js`, add near `NODE_PROBE_TIMEOUT_MS` (after line 93):

```js
// Minimum latency improvement (ms) a new candidate must show over the
// current autoBestNode's fresh measurement in the same refresh cycle before
// it replaces it — prevents flapping between near-identical nodes every
// 5-minute refresh. Does not apply when the current autoBestNode has
// dropped out of the verified pool entirely (see updateAutoBestNode in
// nodePool.js), which always replaces immediately.
export const AUTO_BEST_NODE_HYSTERESIS_MS = 150;
```

- [ ] **Step 4: Wire up `autoBestNode` in `src/nodePool.js`**

Update the import at the top of `src/nodePool.js`:

```js
import { NODE_PROBE_TIMEOUT_MS, AUTO_BEST_NODE_HYSTERESIS_MS, NETWORKS } from "./constants.js";
```

Update the `state` initializer (currently lines 43-46) to add `autoBestNode`:

```js
const state = {
  mainnet: { nodeOptions: [], nodeOptionsUpdatedAt: null, refreshing: false, autoBestNode: null },
  testnet: { nodeOptions: [], nodeOptionsUpdatedAt: null, refreshing: false, autoBestNode: null },
};
```

Add this new export right after `getNodeOptionsUpdatedAt` (after line 54):

```js
export function getAutoBestNode(network = currentNetwork()) {
  return state[network].autoBestNode;
}
```

Add this helper right after `findNodeOption` (after line 126, before the "Shuffled pool" section comment):

```js
// Picks the fastest verified candidate and only lets it replace the current
// autoBestNode if it's a decisive improvement (or the current one is gone
// entirely) — see AUTO_BEST_NODE_HYSTERESIS_MS.
function updateAutoBestNode(s, verified) {
  const fastest = verified.reduce(
    (best, n) => (!best || n.latencyMs < best.latencyMs ? n : best),
    null,
  );
  const current = s.autoBestNode;
  const currentFresh = current
    ? verified.find((n) => n.endpoint === current.endpoint)
    : null;
  if (
    !currentFresh ||
    fastest.latencyMs <= currentFresh.latencyMs - AUTO_BEST_NODE_HYSTERESIS_MS
  ) {
    s.autoBestNode = fastest;
  }
}
```

Finally, call it from `refreshNodeOptions()` — replace:

```js
    if (verified.length > 0) {
      s.nodeOptions = verified;
    }
```

with:

```js
    if (verified.length > 0) {
      s.nodeOptions = verified;
      updateAutoBestNode(s, verified);
    }
```

- [ ] **Step 5: Run the full test file to verify everything passes**

Run: `node --test test/nodePool.test.js`
Expected: PASS — all tests in the file, including the 4 new ones.

- [ ] **Step 6: Commit**

```bash
git add src/constants.js src/nodePool.js test/nodePool.test.js
git commit -m "nodePool: track a hysteresis-gated autoBestNode per network"
```

---

### Task 3: `nemFetch()` tries `autoBestNode` first when there's no explicit preferred node

**Files:**
- Modify: `src/nemApi.js:1-2, 60-67` (imports + sequential path)
- Test: `test/nemApi.test.js`

**Interfaces:**
- Consumes: `getAutoBestNode(network?)` from Task 2 (`src/nodePool.js`).
- No new exports — `nemFetch()`'s external signature is unchanged.

- [ ] **Step 1: Write the failing test**

Add this test to `test/nemApi.test.js` (uses the same `refreshNodeOptions` + `t.mock.timers` technique as `test/nodePool.test.js`, then calls `getHeight()` — a thin wrapper around `nemFetch("/chain/height")` — to observe which node the sequential path hits first).

Replace the existing import line:

```js
import { getTxsFromBlocks, getBlock } from "../src/nemApi.js";
```

with:

```js
import { getTxsFromBlocks, getBlock, getHeight } from "../src/nemApi.js";
import { refreshNodeOptions } from "../src/nodePool.js";
```

(`networkContext` is already imported in this file from `../src/context.js` — no change needed there.)

```js
test("nemFetch tries the auto-selected fastest node first when no preferred node is set", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  // Both refreshNodeOptions' probes and the later getHeight() call hit the
  // exact same `{endpoint}/chain/height` URL shape, so a `probing` flag
  // (not URL content) is what tells the mock which phase it's in.
  let probing = true;
  const requestedUrls = [];
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      if (probing) {
        t.mock.timers.tick(u.includes("fast") ? 10 : 500);
        return { ok: true, json: async () => ({ height: 1 }) };
      }
      requestedUrls.push(u);
      return { ok: true, json: async () => ({ height: 999 }) };
    }
    return {
      ok: true,
      json: async () => [
        { endpoint: "http://fast:7890", name: "fast" },
        { endpoint: "http://slowpoke:7890", name: "slowpoke" },
      ],
    };
  });

  await refreshNodeOptions("mainnet", 1);
  probing = false;

  const height = await getHeight();

  assert.equal(height, 999);
  assert.equal(requestedUrls.length, 1, "expected the fastest node to answer on the first attempt");
  assert.match(requestedUrls[0], /^https:\/\/fast:7891\//);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/nemApi.test.js`
Expected: FAIL, at least most of the time — since every node in this test answers `getHeight()` successfully once `probing` is `false`, `nemFetch` always succeeds on its very first attempt regardless of which node that is. Today's sequential path (`getShuffledNodePool()`, unmodified) puts a random pool entry first, so `requestedUrls[0]` is `fast:7891`'s endpoint only when the shuffle happens to land it there (1-in-4 chance across the two nodes' HTTP/HTTPS candidates) — the `assert.match` on `fast:7891` fails the rest of the time. This flakiness is itself evidence of the bug being fixed: there is currently no deterministic "use the fastest node" behavior. Re-run a few times if needed to see it fail; proceed to Step 3 regardless.

- [ ] **Step 3: Implement the minimal change**

In `src/nemApi.js`, update the import (currently line 2):

```js
import { getShuffledNodePool, getAutoBestNode } from "./nodePool.js";
```

Replace the sequential path's node-ordering block (currently lines 60-67):

```js
  // Sequential: try preferred node first, then fall back through a freshly
  // shuffled pool so load spreads across nodes instead of always starting
  // from the same one.
  const preferred = nodeContext.getStore();
  const shuffled = getShuffledNodePool().slice(0, SEQUENTIAL_MAX_NODES);
  const pool = preferred
    ? [preferred.endpoint, ...shuffled.filter((n) => n !== preferred.endpoint)]
    : shuffled;
```

with:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/nemApi.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `node --test`
Expected: PASS — in particular, confirm the pre-existing `test/nemApi.test.js` tests (`getTxsFromBlocks` scan-depth/wall-clock tests, `getBlock` cross-network cache test) still pass. Those tests never call `refreshNodeOptions`, so `getAutoBestNode()` returns `null` for them and `primary` falls through to `undefined` — identical to today's behavior.

- [ ] **Step 6: Commit**

```bash
git add src/nemApi.js test/nemApi.test.js
git commit -m "nemApi: try the auto-selected fastest node before falling back to shuffle"
```

---

### Task 4: Update the "Auto" dropdown label copy

**Files:**
- Modify: `src/html.js:116`
- Test: `test/html.test.js`

**Interfaces:** None — pure copy change, no new exports or signatures.

- [ ] **Step 1: Write the failing test**

Append to `test/html.test.js`:

```js
test("nodeSwitchHTML describes Auto as picking the fastest node, not a random one", () => {
  const html = nodeSwitchHTML();
  assert.match(html, /fastest available node/);
  assert.doesNotMatch(html, /randomized node pool/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/html.test.js`
Expected: FAIL — the current copy still reads "randomized node pool".

- [ ] **Step 3: Update the copy**

In `src/html.js`, replace line 116:

```js
          <span class="node-menu-text"><span class="node-menu-name">Auto</span><span class="node-menu-sub">randomized node pool</span></span>
```

with:

```js
          <span class="node-menu-text"><span class="node-menu-name">Auto</span><span class="node-menu-sub">fastest available node</span></span>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/html.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/html.js test/html.test.js
git commit -m "html: describe Auto as fastest-node selection instead of randomized"
```

---

### Task 5: Full regression pass

**Files:** none modified — verification only.

- [ ] **Step 1: Run the entire test suite**

Run: `node --test`
Expected: PASS, zero failures, across every `test/*.test.js` file (not just the ones touched above — `test/cache.test.js`, `test/db.test.js`, `test/context.test.js`, `test/helpers.test.js` should be unaffected but must still pass).

- [ ] **Step 2: Manual smoke check (optional but recommended given this changes live node-selection behavior)**

Start the server locally, let it run past one `refreshNodeOptions` cycle (5 minutes) or temporarily lower the interval for a local check, then:
- Visit `/txs` with no `nemscan-node` cookie set (Auto) and confirm it loads without the "Unable to reach NEM network" error state.
- Open the node-switch dropdown and confirm the "Auto" item now reads "fastest available node".
- Set an explicit node via the dropdown, reload, and confirm that node (not `autoBestNode`) is used — e.g. via temporary logging of the chosen node in `nemFetch()`, removed before committing.
