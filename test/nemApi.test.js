import { test } from "node:test";
import assert from "node:assert/strict";
import { getTxsFromBlocks, getBlock, getHeight } from "../src/nemApi.js";
import { refreshNodeOptions, getAutoBestNode } from "../src/nodePool.js";
import { MAX_BLOCK_SCAN_DEPTH, MAX_BLOCK_SCAN_MS } from "../src/constants.js";
import { networkContext, nodeContext } from "../src/context.js";

// Builds a mock global.fetch that answers POST /block/at/public with a
// synthetic block for whatever height was requested. `hasTx(height)`
// decides whether that block carries one transaction or none.
function mockBlockFetch(t, hasTx) {
  t.mock.method(global, "fetch", async (url, opts) => {
    const { height } = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        timeStamp: 0,
        transactions: hasTx(height) ? [{ type: 257 }] : [],
      }),
    };
  });
}

test("getTxsFromBlocks stops within MAX_BLOCK_SCAN_DEPTH even when it never reaches `limit`", async (t) => {
  // Only the 10 blocks nearest the tip carry a transaction; every block
  // below that is empty all the way down to height 1. Without a scan-depth
  // cap, the walk would continue past MAX_BLOCK_SCAN_DEPTH looking for 15
  // more transactions that don't exist in this synthetic chain.
  const fromHeight = 10_000;
  mockBlockFetch(t, (h) => h > fromHeight - 10);

  const { items, nextFromBlock } = await getTxsFromBlocks(fromHeight, 25);

  assert.equal(items.length, 10);
  assert.ok(
    fromHeight - nextFromBlock <= MAX_BLOCK_SCAN_DEPTH,
    `scanned ${fromHeight - nextFromBlock} blocks, expected <= ${MAX_BLOCK_SCAN_DEPTH}`,
  );
});

test("getTxsFromBlocks stops early when the wall-clock budget is exceeded, even under MAX_BLOCK_SCAN_DEPTH", async (t) => {
  // Simulate a pool with an unhealthy node: every block fetch is empty (no
  // tx found) and eats several seconds of wall clock, as a real getBlock()
  // call does when it has to fall back through slow/dead nodes. Without a
  // time budget, the walk would keep going for the full MAX_BLOCK_SCAN_DEPTH
  // regardless of how long that actually takes.
  t.mock.timers.enable({ apis: ["Date"] });
  const fromHeight = 100_000;
  t.mock.method(global, "fetch", async () => {
    t.mock.timers.tick(2000);
    return { ok: true, json: async () => ({ timeStamp: 0, transactions: [] }) };
  });

  const { items, nextFromBlock } = await getTxsFromBlocks(fromHeight, 25);

  assert.equal(items.length, 0);
  const scanned = fromHeight - nextFromBlock;
  assert.ok(
    scanned < MAX_BLOCK_SCAN_DEPTH,
    `expected to stop early on time budget (${MAX_BLOCK_SCAN_MS}ms), but scanned the full ${scanned} blocks`,
  );
});

test("getTxsFromBlocks still returns exactly `limit` items when density is high enough", async (t) => {
  const fromHeight = 20_000;
  mockBlockFetch(t, () => true);

  const { items, nextFromBlock } = await getTxsFromBlocks(fromHeight, 5);

  assert.equal(items.length, 5);
  assert.equal(nextFromBlock, fromHeight - 5);
});

test("getBlock caches mainnet and testnet separately for the same height (no cross-network collision)", async (t) => {
  // Both chains number blocks from 1, so the same height is valid on both
  // networks. Each network's fetch returns a distinguishable payload so we
  // can tell whether the cache served the wrong network's data.
  let calls = 0;
  t.mock.method(global, "fetch", async (url, opts) => {
    calls++;
    const { height } = JSON.parse(opts.body);
    const network = calls === 1 ? "mainnet" : "testnet";
    return {
      ok: true,
      json: async () => ({
        timeStamp: 0,
        transactions: [],
        network,
        height,
      }),
    };
  });

  const height = 750_000;
  const mainnetBlock = await networkContext.run("mainnet", () => getBlock(height));
  const testnetBlock = await networkContext.run("testnet", () => getBlock(height));

  assert.equal(calls, 2, "expected a separate fetch per network for the same height");
  assert.notEqual(mainnetBlock.network, testnetBlock.network);
  assert.equal(mainnetBlock.network, "mainnet");
  assert.equal(testnetBlock.network, "testnet");

  // Re-fetching the same height under the same network context should now
  // hit the cache rather than issuing a third fetch call.
  const mainnetAgain = await networkContext.run("mainnet", () => getBlock(height));
  assert.equal(calls, 2, "expected the second mainnet call to be served from cache");
  assert.deepEqual(mainnetAgain, mainnetBlock);
});

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
  // Intentionally protocol-agnostic: both the https-derived and original
  // http "fast" candidates tick the same latency, so which variant wins the
  // reduce() tie-break is an implementation detail (first-seen wins) rather
  // than something this test cares about — the intent is "the fastest-named
  // node wins," not "specifically the https variant."
  assert.match(requestedUrls[0], /^https?:\/\/fast:789[01]\//);
});

test("nemFetch prefers an explicit preferred node over a populated autoBestNode", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
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
      if (u.startsWith("https://explicit:7891")) {
        return { ok: true, json: async () => ({ height: 999 }) };
      }
      return { ok: false };
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
  assert.ok(getAutoBestNode("mainnet"), "expected autoBestNode to be populated before the request");

  const height = await nodeContext.run(
    { endpoint: "https://explicit:7891", name: "explicit" },
    () => getHeight(),
  );

  assert.equal(height, 999);
  assert.equal(requestedUrls.length, 1, "expected the explicit preferred node to answer on the first attempt");
  assert.match(requestedUrls[0], /^https:\/\/explicit:7891\//);
});

test("nemFetch demotes the auto-selected node when it fails a request, and falls back to the shuffled pool", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let probing = true;
  let failingEndpoint;
  const requestedUrls = [];
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      if (probing) {
        t.mock.timers.tick(u.includes("fast") ? 10 : 500);
        return { ok: true, json: async () => ({ height: 1 }) };
      }
      requestedUrls.push(u);
      if (u.startsWith(failingEndpoint)) {
        return { ok: false };
      }
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
  failingEndpoint = getAutoBestNode("mainnet").endpoint;

  const height = await getHeight();

  assert.equal(height, 999, "expected the sequential path to fall back to the rest of the pool");
  assert.equal(requestedUrls.length, 2, "expected exactly one failed attempt against the dead pin, then one success");
  assert.ok(
    requestedUrls[0].startsWith(failingEndpoint),
    "expected the pinned autoBestNode to be tried first",
  );
  assert.equal(
    getAutoBestNode("mainnet"),
    null,
    "expected the dead autoBestNode to be demoted after its failed request",
  );
});

test("nemFetch does not demote autoBestNode when the failing node was the user's explicit preferred node", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let probing = true;
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      if (probing) {
        t.mock.timers.tick(u.includes("fast") ? 10 : 500);
        return { ok: true, json: async () => ({ height: 1 }) };
      }
      if (u.startsWith("https://explicit:7891")) {
        return { ok: false };
      }
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
  const autoBestBefore = getAutoBestNode("mainnet");
  assert.ok(autoBestBefore, "expected autoBestNode to be populated before the request");

  const height = await nodeContext.run(
    { endpoint: "https://explicit:7891", name: "explicit" },
    () => getHeight(),
  );

  assert.equal(height, 999, "expected fallback through the shuffled pool to succeed");
  assert.deepEqual(
    getAutoBestNode("mainnet"),
    autoBestBefore,
    "an explicit preferred node's failure must never touch the autoBestNode pin",
  );
});
