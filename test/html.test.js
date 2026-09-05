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
  globalTxTableHTML,
  globalTxMoreRows,
  renderNodeRow,
  nodeSwitchHTML,
  nodesListHTML,
  navHTML,
  heroMosaicTransfers,
  heroTxs,
  renderMosaicTransferRow,
  mosaicTransferMoreRows,
  mosaicTransfersListHTML,
  mosaicDetailHTML,
  typeSwitch,
  renderTxTypeArchiveRow,
  txTypeArchiveListHTML,
  txTypeArchiveMoreRows,
  renderUnconfirmedTxRow,
  unconfirmedTxListHTML,
  heroExchanges,
  exchangeMiniFlowChartHTML,
  exchangeOverviewHTML,
} = await import("../src/html.js");
const { refreshNodeOptions } = await import("../src/nodePool.js");
const { upsertMosaicTransfer, upsertTxTypeArchive, upsertExchangeAddress, bumpExchangeDailyFlow } = await import("../src/db.js");

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

test("globalTxTableHTML keeps paginating when the first scan window finds zero txs but the chain isn't exhausted", () => {
  // Same open-ended-scan caveat as globalTxMoreRows above, but for the very
  // first page: getTxsFromBlocks can legitimately return items: [] with
  // nextFromBlock >= 1 when the newest MAX_BLOCK_SCAN_DEPTH/MAX_BLOCK_SCAN_MS
  // window of the chain happens to be sparse (e.g. a real multi-hour lull in
  // mainnet activity). That must not be reported as a terminal "no
  // transactions found" — the caller can still page further back via
  // nextFromBlock.
  const html = globalTxTableHTML([], 5817885, 5817385);

  assert.doesNotMatch(
    html,
    /No transactions found/,
    "an unexhausted empty scan must not show the terminal empty state",
  );
  assert.match(html, /fromBlock=5817385/);
});

test("globalTxTableHTML shows the terminal empty state once the chain is exhausted", () => {
  const html = globalTxTableHTML([], 5817885, 0);
  assert.match(html, /No transactions found/);
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

test("renderMosaicTransferRow escapes sender/recipient/hash, which come from a third-party archive rather than this app's own validated addresses", () => {
  const html = renderMosaicTransferRow(
    {
      no: 1,
      hash: '"><script>1</script>',
      namespace: "dim",
      mosaic: "coin",
      quantity: 1,
      divisibility: 0,
      sender: '"><script>2</script>',
      recipient: '"><script>3</script>',
      time_stamp: 100,
    },
    1,
  );
  assert.doesNotMatch(html, /<script>/);
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

test("mosaicTransfersListHTML's search input carries a pattern for client-side validation and a hidden field to preserve the current rows-per-page on submit", () => {
  const html = mosaicTransfersListHTML([], 50, { ns: null, m: null });
  assert.match(html, /<input[^>]*name="q"[^>]*pattern="[^"]+"/);
  assert.match(html, /<input type="hidden" name="limit" value="50">/);
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

test("typeSwitch marks 'All' active when no type is given, and links straight to /txs", () => {
  const html = typeSwitch(null);
  assert.match(html, /class="rows-menu-item active" href="\/txs" role="menuitem">All</);
});

test("typeSwitch marks the matching item active for a given type", () => {
  const html = typeSwitch("importance");
  assert.match(html, /class="rows-menu-item active" href="\/txs\?type=importance" role="menuitem">Importance</);
  assert.doesNotMatch(html, /class="rows-menu-item active" href="\/txs" role/);
});

test("typeSwitch marks Pending active for the 'pending' pseudo-type", () => {
  const html = typeSwitch("pending");
  assert.match(html, /class="rows-menu-item active" href="\/txs\/unconfirmed" role="menuitem">Pending</);
});

test("typeSwitch links Mosaic to the existing /mosaictransfer page, never a type= query", () => {
  const html = typeSwitch(null);
  assert.match(html, /href="\/mosaictransfer" role="menuitem">Mosaic</);
});

test("typeSwitch's button label reflects the current selection", () => {
  assert.match(typeSwitch(null), /rows-switch-label">All</);
  assert.match(typeSwitch("apostille"), /rows-switch-label">Apostille</);
});

test("heroTxs embeds the type dropdown", () => {
  const html = heroTxs("transfer");
  assert.match(html, /rows-switch-label">Transfer</);
  assert.match(html, /<h1>Transactions<\/h1>/);
});

test("renderTxTypeArchiveRow shows an em-dash for Recipient/Amount when the row has no recipient (namespace/aggregate-style)", () => {
  const html = renderTxTypeArchiveRow({ hash: "h1", height: 100, sender: "SENDERADDR", recipient: "", amount: 0, fee: 150000, time_stamp: 100, type: 8193 });
  assert.match(html, /<span class="muted">—<\/span>/);
  assert.doesNotMatch(html, /href="\/account\/"/);
});

test("renderTxTypeArchiveRow links a real recipient and shows its amount (importance/multisig-style)", () => {
  const html = renderTxTypeArchiveRow({ hash: "h2", height: 100, sender: "S", recipient: "RECIPADDR", amount: 0, fee: 150000, time_stamp: 100, type: 2049 });
  assert.match(html, /href="\/account\/RECIPADDR"/);
});

test("renderTxTypeArchiveRow links Block to the block detail page", () => {
  const html = renderTxTypeArchiveRow({ hash: "h4", height: 12345, sender: "S", recipient: "R", amount: 1, fee: 1, time_stamp: 100, type: 257 });
  assert.match(html, /href="\/block\/12345"/);
});

test("renderTxTypeArchiveRow escapes sender/recipient, which come from a third-party archive rather than this app's own validated addresses", () => {
  const html = renderTxTypeArchiveRow({ hash: "h3", height: 100, sender: '"><script>1</script>', recipient: '"><script>2</script>', amount: 1, fee: 1, time_stamp: 100, type: 257 });
  assert.doesNotMatch(html, /<script>/);
});

test("txTypeArchiveListHTML shows a type-specific empty state", () => {
  assert.match(txTypeArchiveListHTML([], "apostille", 25), /No apostille transactions found/);
});

test("txTypeArchiveListHTML renders rows and reflects getTxTypeArchiveCount for the total", () => {
  networkContext.run("mainnet", () => {
    upsertTxTypeArchive("transfer", "hList", 500, "S", "R", 1_000_000, 150000, 500, 257);
    const html = txTypeArchiveListHTML([{ hash: "hList", height: 500, sender: "S", recipient: "R", amount: 1_000_000, fee: 150000, time_stamp: 500, type: 257 }], "transfer", 25);
    assert.match(html, /Transfer Transactions/);
    assert.match(html, /<strong>1<\/strong> total/);
  });
});

test("txTypeArchiveMoreRows drops the Load More control once offset reaches total", () => {
  const items = [{ hash: "h", height: 1, sender: "S", recipient: "R", amount: 1, fee: 1, time_stamp: 1, type: 257 }];
  const html = txTypeArchiveMoreRows(items, "transfer", 0, 1, 25);
  assert.doesNotMatch(html, /Load More/);
});

test("txTypeArchiveMoreRows keeps the Load More control, with the type and offset preserved in its URL, when more remain", () => {
  const items = [{ hash: "h", height: 1, sender: "S", recipient: "R", amount: 1, fee: 1, time_stamp: 1, type: 257 }];
  const html = txTypeArchiveMoreRows(items, "transfer", 0, 5, 25);
  assert.match(html, /Load More/);
  assert.match(html, /\/api\/txs\/more\?type=transfer&offset=1&limit=25/);
});

test("renderUnconfirmedTxRow unwraps a multisig (type 4100) record's otherTrans for sender/recipient/amount/fee", () => {
  const tx = {
    hash: "hUnconfirmed", type: 4100, timeStamp: 100,
    otherTrans: { sender: "INNERSENDER", recipient: "INNERRECIP", amount: 7_000_000, fee: 150000 },
  };
  const html = renderUnconfirmedTxRow(tx);
  assert.match(html, /href="\/account\/INNERSENDER"/);
  assert.match(html, /href="\/account\/INNERRECIP"/);
  assert.match(html, />7\.000000 XEM</);
});

test("renderUnconfirmedTxRow renders a plain transfer directly (no otherTrans)", () => {
  const tx = { hash: "hPlain", type: 257, sender: "S", recipient: "R", amount: 1_000_000, fee: 150000, timeStamp: 100 };
  const html = renderUnconfirmedTxRow(tx);
  assert.match(html, /href="\/account\/S"/);
  assert.match(html, /href="\/account\/R"/);
  assert.match(html, />1\.000000 XEM</);
});

test("renderUnconfirmedTxRow falls back to signature when hash is absent", () => {
  const tx = { signature: "sig123abc", type: 257, sender: "S", recipient: "R", amount: 1, fee: 1, timeStamp: 100 };
  const html = renderUnconfirmedTxRow(tx);
  assert.match(html, /sig123abc/);
});

test("renderUnconfirmedTxRow escapes sender/recipient, which come from a third-party feed", () => {
  const tx = { hash: "h", type: 257, sender: '"><script>1</script>', recipient: '"><script>2</script>', amount: 1, fee: 1, timeStamp: 100 };
  assert.doesNotMatch(renderUnconfirmedTxRow(tx), /<script>/);
});

test("unconfirmedTxListHTML shows an empty state when the pool is empty", () => {
  assert.match(unconfirmedTxListHTML([]), /No pending transactions right now/);
});

test("unconfirmedTxListHTML renders a row per item and the pending count", () => {
  const items = [
    { hash: "h1", type: 257, sender: "S", recipient: "R", amount: 1, fee: 1, timeStamp: 100 },
    { hash: "h2", type: 257, sender: "S2", recipient: "R2", amount: 1, fee: 1, timeStamp: 100 },
  ];
  const html = unconfirmedTxListHTML(items);
  assert.match(html, /<strong>2<\/strong> pending/);
  assert.match(html, /href="\/account\/S"/);
  assert.match(html, /href="\/account\/S2"/);
});

test("heroExchanges renders a simple title hero", () => {
  assert.match(heroExchanges(), /<h1>Exchanges<\/h1>/);
});

test("exchangeMiniFlowChartHTML shows a collecting-data placeholder for fewer than 2 days of data", () => {
  assert.match(exchangeMiniFlowChartHTML([]), /Collecting data/);
  assert.match(exchangeMiniFlowChartHTML([{ date: "2026-09-01", inflow: 1, outflow: 0 }]), /Collecting data/);
});

test("exchangeMiniFlowChartHTML renders one point per day of data as an SVG polyline", () => {
  const html = exchangeMiniFlowChartHTML([
    { date: "2026-09-01", inflow: 1_000_000, outflow: 200_000 },
    { date: "2026-09-02", inflow: 500_000, outflow: 900_000 },
    { date: "2026-09-03", inflow: 2_000_000, outflow: 0 },
  ]);
  assert.match(html, /<svg class="exchange-mini-chart"/);
  const points = html.match(/points="([^"]+)"/)[1].trim().split(/\s+/);
  assert.equal(points.length, 3);
});

test("exchangeOverviewHTML shows an empty state when no exchanges are tracked yet", () => {
  const html = exchangeOverviewHTML([]);
  assert.match(html, /class="empty-state"/);
});

test("exchangeOverviewHTML renders a card per exchange with its 7-day totals and a link to its detail page", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NCARD1", "Bitflyer", "Bitflyer -- Exchange");
    bumpExchangeDailyFlow("2026-09-01", "NCARD1", 5_000_000, 1_000_000);
    const html = exchangeOverviewHTML([
      { exchange_name: "Bitflyer", address_count: 1, inflow_7d: 5_000_000, outflow_7d: 1_000_000 },
    ]);
    assert.match(html, /Bitflyer/);
    assert.match(html, /href="\/exchange\/Bitflyer"/);
    assert.match(html, /5\.00/); // xem() formats 5,000,000 micro-XEM as "5.00"
    assert.match(html, /1\.00/);
  });
});
