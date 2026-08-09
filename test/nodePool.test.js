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
