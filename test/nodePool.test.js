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
