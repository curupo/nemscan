import { test } from "node:test";
import assert from "node:assert/strict";
import { globalTxMoreRows, renderNodeRow, nodeSwitchHTML } from "../src/html.js";
import { refreshNodeOptions } from "../src/nodePool.js";

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

test("nodeSwitchHTML describes Auto as picking the fastest node, not a random one", () => {
  const html = nodeSwitchHTML();
  assert.match(html, /fastest available node/);
  assert.doesNotMatch(html, /randomized node pool/);
});
