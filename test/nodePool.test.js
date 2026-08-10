import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getShuffledNodePool,
  findNodeOption,
  getNodeOptions,
  getNodeOptionsUpdatedAt,
  refreshNodeOptions,
  probeNode,
  getAutoBestNode,
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
      t.mock.timers.tick(u.includes("://a:") ? 100 : round === 1 ? 400 : 80);
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
      t.mock.timers.tick(u.includes("://a:") ? 300 : round === 1 ? 1000 : 140);
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

test("refreshNodeOptions refreshes autoBestNode's latencyMs when the pin is kept (hysteresis)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let round = 1;
  t.mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      // Round 1: a=100ms, b=400ms → a wins
      // Round 2: a=120ms, b=400ms → a still wins (not beaten by 150ms margin), but latencyMs must refresh to 120
      const isNodeA = u.indexOf("://a:") !== -1;
      const tickAmount = isNodeA ? (round === 1 ? 100 : 120) : 400;
      t.mock.timers.tick(tickAmount);
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
  const after1 = getAutoBestNode("mainnet");
  assert.equal(after1.name, "a");
  assert.equal(after1.latencyMs, 100);

  round = 2;
  await refreshNodeOptions("mainnet", 1);
  // a is kept (not beaten by the 150ms margin), but its latencyMs must be refreshed to this cycle's measurement (120ms)
  const after2 = getAutoBestNode("mainnet");
  assert.equal(after2.name, "a");
  assert.equal(after2.latencyMs, 120);
});
