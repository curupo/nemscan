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
