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
