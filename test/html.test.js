import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkContext } from "../src/context.js";

// html.js imports db.js (for archive-count accessors like
// getMosaicTransfersCount), which opens both SQLite files at import time as
// a side effect. Point NEMSCAN_DB_DIR at a scratch directory before
// importing anything that reaches constants.js / db.js — including
// nodePool.js, which is why that import is dynamic below too — so this test
// never touches the real cache.db / cache-testnet.db in the repo root (same
// pattern as test/db.test.js, test/cache.test.js, test/nemApi.test.js).
process.env.NEMSCAN_DB_DIR = mkdtempSync(join(tmpdir(), "nemscan-html-test-"));

const {
  globalTxMoreRows,
  renderNodeRow,
  nodeSwitchHTML,
  nodesListHTML,
  navHTML,
  heroMosaicTransfers,
  renderMosaicTransferRow,
  mosaicTransferMoreRows,
  mosaicTransfersListHTML,
  mosaicDetailHTML,
} = await import("../src/html.js");
const { refreshNodeOptions } = await import("../src/nodePool.js");
const { upsertMosaicTransfer } = await import("../src/db.js");

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
    [{ name: "onlyhttp", host: "onlyhttp:7890", endpoint: "http://onlyhttp:7890", protocol: "http" }],
    1,
  );
  assert.match(html, /proto-badge">HTTP<\/span>/);
});

test("renderNodeRow shows an HTTPS badge for a protocol:https node", () => {
  const html = renderNodeRow(
    [{ name: "onlyhttps", host: "onlyhttps:7891", endpoint: "https://onlyhttps:7891", protocol: "https" }],
    1,
  );
  assert.match(html, /proto-badge">HTTPS<\/span>/);
});

test("renderNodeRow merges http and https variants of the same host into one row with both badges", () => {
  const html = renderNodeRow(
    [
      { name: "mixed", host: "mixed:7891", endpoint: "https://mixed:7891", protocol: "https" },
      { name: "mixed", host: "mixed:7890", endpoint: "http://mixed:7890", protocol: "http" },
    ],
    1,
  );
  assert.match(html, /proto-badge">HTTPS<\/span>/);
  assert.match(html, /proto-badge">HTTP<\/span>/);
  assert.equal((html.match(/<tr>/g) || []).length, 1);
});

test("nodesListHTML groups the same host's http and https entries into a single row", () => {
  const html = nodesListHTML(
    [
      { name: "mixed", host: "mixed:7891", endpoint: "https://mixed:7891", protocol: "https" },
      { name: "mixed", host: "mixed:7890", endpoint: "http://mixed:7890", protocol: "http" },
    ],
    true,
  );
  assert.match(html, /<strong>1<\/strong> active/);
  assert.equal((html.match(/td-num/g) || []).length, 1);
});

test("nodeSwitchHTML renders one HTTP badge and one HTTPS badge when the pool has one http and one https entry for the same host", async (t) => {
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
  const httpBadgeCount = (html.match(/proto-badge">HTTP<\/span>/g) || []).length;
  const httpsBadgeCount = (html.match(/proto-badge">HTTPS<\/span>/g) || []).length;
  assert.equal(httpBadgeCount, 1);
  assert.equal(httpsBadgeCount, 1);
  assert.match(html, /mixed:7890/);
  assert.match(html, /mixed:7891/);
});

test("nodeSwitchHTML describes Auto as picking the fastest node, not a random one", () => {
  const html = nodeSwitchHTML();
  assert.match(html, /fastest available node/);
  assert.doesNotMatch(html, /randomized node pool/);
});

test("navHTML lists a Mosaic Transfer link and marks it active on /mosaictransfer", () => {
  const html = navHTML("/mosaictransfer");
  assert.match(html, /href="\/mosaictransfer"[^>]*class="active"[^>]*>Mosaic Transfer</);
});

test("heroMosaicTransfers renders a Mosaic Transfer heading", () => {
  assert.match(heroMosaicTransfers(), /<h1>Mosaic Transfer<\/h1>/);
});

test("renderMosaicTransferRow formats quantity using the row's own divisibility and links sender/recipient/mosaic", () => {
  const html = renderMosaicTransferRow(
    { no: 1, hash: "abc123", namespace: "dim", mosaic: "coin", quantity: 5_000_000, divisibility: 6, sender: "SENDERADDR", recipient: "RECIPADDR", time_stamp: 100 },
    1,
  );
  assert.match(html, />5\.000000</);
  assert.match(html, /href="\/mosaic\/dim\/coin"/);
  assert.match(html, /href="\/account\/SENDERADDR"/);
  assert.match(html, /href="\/account\/RECIPADDR"/);
});

test("renderMosaicTransferRow formats a zero-divisibility mosaic as a whole number", () => {
  const html = renderMosaicTransferRow(
    { no: 1, hash: "abc123", namespace: "smart-uq", mosaic: "dig", quantity: 800, divisibility: 0, sender: "S", recipient: "R", time_stamp: 100 },
    1,
  );
  assert.match(html, />800</);
});

test("mosaicTransferMoreRows drops the Load More control once offset reaches total", () => {
  const items = [{ no: 1, hash: "h", namespace: "n", mosaic: "m", quantity: 1, divisibility: 0, sender: "S", recipient: "R", time_stamp: 1 }];
  const html = mosaicTransferMoreRows(items, 0, 1, 25, { ns: null, m: null });
  assert.doesNotMatch(html, /Load More/);
});

test("mosaicTransferMoreRows keeps the Load More control, with the ns/m filter preserved in its URL, when more remain", () => {
  const items = [{ no: 1, hash: "h", namespace: "dim", mosaic: "coin", quantity: 1, divisibility: 0, sender: "S", recipient: "R", time_stamp: 1 }];
  const html = mosaicTransferMoreRows(items, 0, 5, 25, { ns: "dim", m: "coin" });
  assert.match(html, /Load More/);
  assert.match(html, /ns=dim&m=coin/);
});

test("mosaicTransfersListHTML shows an empty state naming the filter when a search finds nothing", () => {
  const html = mosaicTransfersListHTML([], 25, { ns: "nope", m: "nope" });
  assert.match(html, /No transfers found for "nope:nope"/);
});

test("mosaicTransfersListHTML renders rows and reflects getMosaicTransfersCount for the total", () => {
  networkContext.run("mainnet", () => {
    upsertMosaicTransfer(500, "h500", "dim", "coin", 1_000_000, 6, "S", "R", 500);
    const html = mosaicTransfersListHTML([{ no: 500, hash: "h500", namespace: "dim", mosaic: "coin", quantity: 1_000_000, divisibility: 6, sender: "S", recipient: "R", time_stamp: 500 }], 25, { ns: null, m: null });
    assert.match(html, /Mosaic Transfer/);
    assert.match(html, /dim:<strong>coin<\/strong>/);
    assert.match(html, /<strong>1<\/strong> transfers/);
  });
});

test("mosaicDetailHTML omits the Recent Transfers section for a mosaic with no indexed transfers", () => {
  networkContext.run("mainnet", () => {
    const html = mosaicDetailHTML(
      { namespace: "untouched", name: "coin", creator: "CREATOR", description: "", divisibility: 0, supply: 1, transferable: 1 },
      null,
      [],
    );
    assert.doesNotMatch(html, /Recent Transfers/);
  });
});

test("mosaicDetailHTML renders a Recent Transfers section and a View all link once its count exceeds the passed-in rows", () => {
  networkContext.run("mainnet", () => {
    upsertMosaicTransfer(600, "h600", "dim", "coin", 1, 6, "S", "R", 600);
    upsertMosaicTransfer(601, "h601", "dim", "coin", 1, 6, "S", "R", 601);
    const oneRow = [{ no: 601, hash: "h601", namespace: "dim", mosaic: "coin", quantity: 1, divisibility: 6, sender: "S", recipient: "R", time_stamp: 601 }];
    const html = mosaicDetailHTML(
      { namespace: "dim", name: "coin", creator: "CREATOR", description: "", divisibility: 6, supply: 1, transferable: 1 },
      null,
      oneRow,
    );
    assert.match(html, /Recent Transfers/);
    assert.match(html, /View all transfers/);
    assert.match(html, /\/mosaictransfer\?ns=dim&m=coin/);
  });
});
