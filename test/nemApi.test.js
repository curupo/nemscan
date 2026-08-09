import { test } from "node:test";
import assert from "node:assert/strict";
import { getTxsFromBlocks } from "../src/nemApi.js";
import { MAX_BLOCK_SCAN_DEPTH, MAX_BLOCK_SCAN_MS } from "../src/constants.js";

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
