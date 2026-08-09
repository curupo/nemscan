import { test } from "node:test";
import assert from "node:assert/strict";
import { globalTxMoreRows } from "../src/html.js";

test("globalTxMoreRows keeps the Load More control when a scan window finds zero txs but the chain isn't exhausted", () => {
  // getTxsFromBlocks legitimately returns items: [] with nextFromBlock >= 1
  // whenever a scan batch is capped (MAX_BLOCK_SCAN_DEPTH / MAX_BLOCK_SCAN_MS)
  // before finding a transaction — e.g. a sparse stretch of the chain, or an
  // unhealthy node in the "Auto" pool causing getBlock() calls to fail and
  // be swallowed as null. Unlike the other *MoreRows helpers (which paginate
  // a fixed, fully-known list where items.length === 0 truly means
  // exhausted), this is an open-ended scan: nextFromBlock >= 1 means there
  // is still more chain to walk, regardless of whether this batch found
  // anything.
  const html = globalTxMoreRows([], 12345);

  assert.notEqual(
    html,
    "",
    "Load More button must survive an empty batch so the user can keep paginating",
  );
  assert.match(html, /fromBlock=12345/);
});

test("globalTxMoreRows drops the Load More control once the chain is exhausted", () => {
  const html = globalTxMoreRows([], 0);
  assert.equal(html, "");
});
