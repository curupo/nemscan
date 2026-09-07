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
  typeSpecificRows,
  txDetailHTML,
  heroExchanges,
  exchangeMiniFlowChartHTML,
  exchangeOverviewHTML,
  heroExchange,
  exchangeFlowChartHTML,
  exchangeFlowSectionHTML,
  exchangeAddressTabsHTML,
  exchangeDetailHTML,
  exchangeNotFoundHTML,
  exchangeAddressNotFoundHTML,
} = await import("../src/html.js");
const { refreshNodeOptions } = await import("../src/nodePool.js");
const { upsertMosaicTransfer, upsertTxTypeArchive, upsertExchangeAddress, bumpExchangeDailyFlow, upsertMosaic } = await import("../src/db.js");
const { addrFromPubKey } = await import("../src/helpers.js");

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

test("TX_TYPES has the real NIS1 multisig codes, not the swapped/bogus ones", async () => {
  const { TX_TYPES } = await import("../src/constants.js");
  assert.equal(TX_TYPES[4098], "Multisig Signature");
  assert.equal(TX_TYPES[4100], "Multisig");
  assert.equal(TX_TYPES[4099], undefined);
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

test("typeSpecificRows shows Recipient/Amount/Message for a plain transfer with no mosaics", () => {
  const rows = typeSpecificRows({
    type: 257,
    recipient: "RECIPADDR",
    amount: 5_000_000,
    message: { type: 1, payload: Buffer.from("hi").toString("hex") },
  });
  const byLabel = Object.fromEntries(rows);
  assert.match(byLabel["Recipient"], /href="\/account\/RECIPADDR"/);
  assert.match(byLabel["Amount"], />5\.00 XEM</);
  assert.match(byLabel["Message"], />hi</);
  assert.equal(byLabel["Mosaics"], undefined);
  assert.equal(byLabel["Multiplier"], undefined);
});

test("typeSpecificRows shows Multiplier + Mosaics (divided by divisibility) for a mosaic-attached transfer", () => {
  networkContext.run("mainnet", () => {
    upsertMosaic(1, "dim", "coin", "CREATOR", "", 6, 1000, 1, 1, 1);
    const rows = typeSpecificRows({
      type: 257,
      recipient: "RECIPADDR",
      amount: 2_000_000, // multiplier: 2x
      message: { payload: "" },
      mosaics: [{ mosaicId: { namespaceId: "dim", name: "coin" }, quantity: 3_000_000 }],
    });
    const byLabel = Object.fromEntries(rows);
    assert.match(byLabel["Multiplier"], />2\.00</);
    // (3_000_000 * 2_000_000 / 1_000_000) / 10**6 = 6.000000
    assert.match(byLabel["Mosaics"], /dim:<strong>coin<\/strong> × 6\.000000/);
    assert.equal(byLabel["Amount"], undefined);
  });
});

test("typeSpecificRows falls back to raw quantity (divisibility 0) for a mosaic-attached transfer whose mosaic isn't in the local cache", () => {
  const rows = typeSpecificRows({
    type: 257,
    recipient: "RECIPADDR",
    amount: 1_000_000,
    message: { payload: "" },
    mosaics: [{ mosaicId: { namespaceId: "unknown-ns", name: "unknown-mosaic" }, quantity: 42 }],
  });
  const byLabel = Object.fromEntries(rows);
  // (42 * 1_000_000 / 1_000_000) / 10**0 = 42
  assert.match(byLabel["Mosaics"], /unknown-ns:<strong>unknown-mosaic<\/strong> × 42/);
});

test("typeSpecificRows shows the no-message placeholder when a transfer carries no message payload", () => {
  const rows = typeSpecificRows({ type: 257, recipient: "R", amount: 0, message: null });
  const byLabel = Object.fromEntries(rows);
  assert.match(byLabel["Message"], /\(no message\)/);
});

test("typeSpecificRows shows Mode and Remote Account for an importance transfer", () => {
  const rows = typeSpecificRows({
    type: 2049,
    mode: 1,
    remoteAccount: "a".repeat(64),
  });
  const byLabel = Object.fromEntries(rows);
  assert.equal(byLabel["Mode"], "Activate");
  assert.match(byLabel["Remote Account"], /href="\/account\//);
});

test("typeSpecificRows labels mode 2 as Deactivate", () => {
  const rows = typeSpecificRows({ type: 2049, mode: 2, remoteAccount: "a".repeat(64) });
  assert.equal(Object.fromEntries(rows)["Mode"], "Deactivate");
});

test("typeSpecificRows lists added and removed cosignatories for an aggregate modification, with a sign per entry", () => {
  const rows = typeSpecificRows({
    type: 4097,
    modifications: [
      { modificationType: 1, cosignatoryAccount: "a".repeat(64) },
      { modificationType: 2, cosignatoryAccount: "b".repeat(64) },
    ],
  });
  const byLabel = Object.fromEntries(rows);
  assert.match(byLabel["Modifications"], /^\+ <a/);
  assert.match(byLabel["Modifications"], /−.*<a/);
  assert.equal(byLabel["Min Cosignatories Change"], undefined);
});

test("typeSpecificRows shows a signed Min Cosignatories Change when minCosignatories is present", () => {
  const rows = typeSpecificRows({
    type: 4097,
    modifications: [],
    minCosignatories: { relativeChange: -1 },
  });
  assert.equal(Object.fromEntries(rows)["Min Cosignatories Change"], "-1");
});

test("typeSpecificRows shows the namespace (parent.newPart), rental fee, and sink for a provision namespace tx", () => {
  const rows = typeSpecificRows({
    type: 8193,
    parent: "dim",
    newPart: "coin",
    rentalFee: 5_000_000,
    rentalFeeSink: "SINKADDR",
  });
  const byLabel = Object.fromEntries(rows);
  assert.match(byLabel["Namespace"], />dim\.coin</);
  assert.match(byLabel["Rental Fee"], />5\.00 XEM</);
  assert.match(byLabel["Rental Fee Sink"], /href="\/account\/SINKADDR"/);
});

test("typeSpecificRows shows a root namespace (no parent) without a leading dot", () => {
  const rows = typeSpecificRows({
    type: 8193,
    parent: null,
    newPart: "dim",
    rentalFee: 500_000_000,
    rentalFeeSink: "SINKADDR",
  });
  assert.match(Object.fromEntries(rows)["Namespace"], />dim</);
});

test("typeSpecificRows shows mosaic id, description, and properties for a mosaic definition creation", () => {
  const rows = typeSpecificRows({
    type: 16385,
    creationFee: 5_000_000,
    mosaicDefinition: {
      id: { namespaceId: "dim", name: "coin" },
      description: "test mosaic",
      properties: [
        { name: "divisibility", value: "6" },
        { name: "initialSupply", value: "1000" },
        { name: "supplyMutable", value: "true" },
        { name: "transferable", value: "false" },
      ],
    },
  });
  const byLabel = Object.fromEntries(rows);
  assert.match(byLabel["Mosaic"], />dim:coin</);
  assert.equal(byLabel["Description"], "test mosaic");
  assert.equal(byLabel["Divisibility"], "6");
  assert.equal(byLabel["Initial Supply"], "1000");
  assert.equal(byLabel["Supply Mutable"], "Yes");
  assert.equal(byLabel["Transferable"], "No");
  assert.match(byLabel["Creation Fee"], />5\.00 XEM</);
});

test("typeSpecificRows shows an increase and its human-readable delta for a mosaic supply change", () => {
  networkContext.run("mainnet", () => {
    upsertMosaic(1, "dim", "coin", "CREATOR", "", 6, 1000, 1, 1, 1);
    const rows = typeSpecificRows({
      type: 16386,
      mosaicId: { namespaceId: "dim", name: "coin" },
      supplyType: 1,
      delta: 5_000_000,
    });
    const byLabel = Object.fromEntries(rows);
    assert.match(byLabel["Mosaic"], />dim:coin</);
    assert.match(byLabel["Supply Change"], /^\+5000000 \(\+5\.000000\)$/);
  });
});

test("typeSpecificRows shows a decrease without a human-readable delta when the mosaic isn't in the local cache", () => {
  const rows = typeSpecificRows({
    type: 16386,
    mosaicId: { namespaceId: "unknown-ns", name: "unknown-mosaic" },
    supplyType: 2,
    delta: 10,
  });
  assert.equal(Object.fromEntries(rows)["Supply Change"], "−10");
});

test("txDetailHTML shows Version and Deadline rows", () => {
  const html = txDetailHTML(
    {
      type: 257,
      version: 0x98000002, // NIS1 mainnet v2 transfer version word; low byte (the version number) is 2
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64),
      recipient: "R",
      amount: 0,
      message: null,
      fee: 100000,
      signature: "sig",
    },
    "hash1",
    12345,
  );
  assert.match(html, /<div class="ov-label">Version<\/div><div class="ov-value"><span class="mono">2<\/span>/);
  assert.match(html, /<div class="ov-label">Deadline<\/div>/);
});

test("txDetailHTML unwraps a multisig (type 4100) wrapper: Sender/Recipient/Amount come from otherTrans, and Initiated By shows the outer signer", () => {
  const html = txDetailHTML(
    {
      type: 4100,
      version: 1,
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64), // the cosigner who submitted the wrapper
      fee: 150000,
      signature: "outersig",
      otherTrans: {
        type: 257,
        signer: "b".repeat(64), // the multisig account
        recipient: "RECIPADDR",
        amount: 7_000_000,
        message: null,
        fee: 0,
      },
    },
    "hash2",
    12346,
  );
  const innerSenderAddr = addrFromPubKey("b".repeat(64));
  const outerSignerAddr = addrFromPubKey("a".repeat(64));
  assert.match(html, new RegExp(`<div class="ov-label">Sender</div><div class="ov-value"><a href="/account/${innerSenderAddr}"`));
  assert.match(html, new RegExp(`<div class="ov-label">Initiated By</div><div class="ov-value"><a href="/account/${outerSignerAddr}"`));
  assert.match(html, /href="\/account\/RECIPADDR"/);
  assert.match(html, />7\.00 XEM</);
});

test("txDetailHTML shows a Cosigners row when the multisig wrapper carries signatures, and omits it when there are none", () => {
  const withSigs = txDetailHTML(
    {
      type: 4100,
      version: 1,
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64),
      fee: 150000,
      signature: "outersig",
      signatures: [{ signer: "c".repeat(64) }],
      otherTrans: { type: 257, signer: "b".repeat(64), recipient: "R", amount: 0, message: null, fee: 0 },
    },
    "hash3",
    12347,
  );
  assert.match(withSigs, /<div class="ov-label">Cosigners<\/div>/);

  const noSigs = txDetailHTML(
    {
      type: 4100,
      version: 1,
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64),
      fee: 150000,
      signature: "outersig",
      otherTrans: { type: 257, signer: "b".repeat(64), recipient: "R", amount: 0, message: null, fee: 0 },
    },
    "hash4",
    12348,
  );
  assert.doesNotMatch(noSigs, /<div class="ov-label">Cosigners<\/div>/);
});

test("txDetailHTML shows a wrapped namespace registration's payload rows instead of blank Recipient/Amount", () => {
  const html = txDetailHTML(
    {
      type: 4100,
      version: 1,
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64),
      fee: 150000,
      signature: "outersig",
      otherTrans: {
        type: 8193,
        signer: "b".repeat(64),
        parent: null,
        newPart: "dim",
        rentalFee: 500_000_000,
        rentalFeeSink: "SINKADDR",
        fee: 0,
      },
    },
    "hash5",
    12349,
  );
  assert.match(html, /<div class="ov-label">Namespace<\/div>/);
  assert.doesNotMatch(html, /<div class="ov-label">Recipient<\/div>/);
});

test("txDetailHTML renders a plain (non-wrapped) transfer exactly as before: no Initiated By/Cosigners rows", () => {
  const html = txDetailHTML(
    {
      type: 257,
      version: 1,
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64),
      recipient: "RECIPADDR",
      amount: 1_000_000,
      message: null,
      fee: 100000,
      signature: "sig",
    },
    "hash6",
    12350,
  );
  assert.doesNotMatch(html, /Initiated By/);
  assert.doesNotMatch(html, /Cosigners/);
  assert.match(html, /href="\/account\/RECIPADDR"/);
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

test("exchangeOverviewHTML shows a Delisted badge for a delisted exchange", () => {
  const html = exchangeOverviewHTML([
    { exchange_name: "Coincheck", address_count: 1, inflow_7d: 0, outflow_7d: 0 },
  ]);
  assert.match(html, /class="badge-no exchange-delisted-flag">Delisted</);
});

test("exchangeOverviewHTML omits the Delisted badge for an active exchange", () => {
  const html = exchangeOverviewHTML([
    { exchange_name: "Zaif", address_count: 1, inflow_7d: 0, outflow_7d: 0 },
  ]);
  assert.doesNotMatch(html, /Delisted/);
});

test("exchangeOverviewHTML shows a combined 7-day IN/OUT total across all tracked exchanges", () => {
  const html = exchangeOverviewHTML([
    { exchange_name: "Bitflyer", address_count: 1, inflow_7d: 5_000_000, outflow_7d: 1_000_000 },
    { exchange_name: "Zaif", address_count: 2, inflow_7d: 2_000_000, outflow_7d: 3_000_000 },
  ]);
  assert.match(html, /class="exchange-totals"/);
  assert.match(html, />7\.00 XEM</); // combined 7D IN: 5.00 + 2.00
  assert.match(html, />4\.00 XEM</); // combined 7D OUT: 1.00 + 3.00
});

test("exchangeOverviewHTML omits the combined total when no exchanges are tracked", () => {
  const html = exchangeOverviewHTML([]);
  assert.doesNotMatch(html, /class="exchange-totals"/);
});

test("heroExchange renders the exchange name as the title", () => {
  assert.match(heroExchange("Zaif"), /<h1>Zaif<\/h1>/);
});

test("heroExchange shows a Delisted badge for a delisted exchange", () => {
  const html = heroExchange("Coincheck");
  assert.match(html, /<h1>Coincheck/);
  assert.match(html, /class="badge-no">Delisted</);
});

test("heroExchange omits the Delisted badge for an active exchange", () => {
  assert.doesNotMatch(heroExchange("Zaif"), /Delisted/);
});

test("exchangeFlowChartHTML shows a collecting-data placeholder with no data", () => {
  assert.match(exchangeFlowChartHTML([]), /Collecting data/);
});

test("exchangeFlowChartHTML renders one inflow bar and one outflow bar per day", () => {
  const html = exchangeFlowChartHTML([
    { date: "2026-09-01", inflow: 1_000_000, outflow: 200_000 },
    { date: "2026-09-02", inflow: 0, outflow: 900_000 },
  ]);
  assert.equal((html.match(/class="flow-bar-in"/g) || []).length, 2);
  assert.equal((html.match(/class="flow-bar-out"/g) || []).length, 2);
});

test("exchangeFlowSectionHTML renders the exchange name, totals, and chart", () => {
  const html = exchangeFlowSectionHTML("Zaif", [
    { date: "2026-09-01", inflow: 1_000_000, outflow: 500_000 },
  ]);
  assert.match(html, /Zaif/);
  assert.match(html, /class="exchange-flow-chart"/);
  assert.match(html, /1\.00 XEM/);
  assert.match(html, /0\.50 XEM/);
  assert.doesNotMatch(html, /tab-nav/, "the flow section must not nest its own tab row on a tab swap");
});

test("exchangeAddressTabsHTML returns nothing for 0 or 1 tracked addresses", () => {
  assert.equal(exchangeAddressTabsHTML("Zaif", []), "");
  assert.equal(
    exchangeAddressTabsHTML("Zaif", [{ address: "NABCDEF1", label: "Zaif -- Hot Wallet" }]),
    "",
  );
});

test("exchangeAddressTabsHTML renders a Total tab plus one tab per address for 2+ addresses", () => {
  const html = exchangeAddressTabsHTML("Zaif", [
    { address: "NABCDEF1", label: "Zaif -- Hot Wallet" },
    { address: "NABCDEF2", label: null },
  ]);
  assert.match(html, /class="tab-nav"/);
  assert.match(html, /class="tab-btn active"[^>]*hx-get="\/api\/exchange\/Zaif\/flows"[^>]*>Total</);
  assert.match(html, /hx-get="\/api\/exchange\/Zaif\/flows\?address=NABCDEF1"/);
  assert.match(html, /hx-get="\/api\/exchange\/Zaif\/flows\?address=NABCDEF2"/);
  assert.match(html, /hx-target="#exchange-flow-section"/);
});

test("exchangeDetailHTML includes the chart and the exchange name", () => {
  const html = exchangeDetailHTML("Zaif", [{ date: "2026-09-01", inflow: 1, outflow: 1 }], []);
  assert.match(html, /Zaif/);
  assert.match(html, /class="exchange-flow-chart"/);
});

test("exchangeDetailHTML labels the count badge as active days, not calendar days", () => {
  // The backing query returns the most recent N *rows with recorded flow*,
  // not the most recent N calendar days, so "Nd" misleadingly implies a
  // fixed time window when the data can span far more than N days.
  const html = exchangeDetailHTML(
    "Zaif",
    [
      { date: "2026-01-13", inflow: 1, outflow: 0 },
      { date: "2026-06-01", inflow: 0, outflow: 1 },
    ],
    [],
  );
  assert.match(html, /class="count-badge">2 active days</);
});

test("exchangeDetailHTML wraps the flow section and includes tabs for 2+ addresses", () => {
  const html = exchangeDetailHTML(
    "Zaif",
    [{ date: "2026-09-01", inflow: 1, outflow: 1 }],
    [
      { address: "NABCDEF1", label: "Zaif -- Hot Wallet" },
      { address: "NABCDEF2", label: null },
    ],
  );
  assert.match(html, /id="exchange-flow-section"/);
  assert.match(html, /class="tab-nav"/);
  assert.match(html, /function setExchangeTab/, "the tab buttons' onclick depends on this being emitted alongside them");
});

test("exchangeDetailHTML omits tabs when only one address is tracked", () => {
  const html = exchangeDetailHTML(
    "Zaif",
    [{ date: "2026-09-01", inflow: 1, outflow: 1 }],
    [{ address: "NABCDEF1", label: "Zaif -- Hot Wallet" }],
  );
  assert.doesNotMatch(html, /class="tab-nav"/);
});

test("exchangeDetailHTML links each tracked address to its account page", () => {
  const html = exchangeDetailHTML(
    "Zaif",
    [{ date: "2026-09-01", inflow: 1, outflow: 1 }],
    [
      { address: "NABCDEF1", label: "Zaif -- Hot Wallet" },
      { address: "NABCDEF2", label: null },
    ],
  );
  assert.match(html, /href="\/account\/NABCDEF1"/);
  assert.match(html, /href="\/account\/NABCDEF2"/);
  assert.match(html, /class="exchange-addr-label">Zaif -- Hot Wallet</);
});

test("exchangeDetailHTML shows a message when no addresses are tracked yet for the exchange", () => {
  const html = exchangeDetailHTML("Zaif", [{ date: "2026-09-01", inflow: 1, outflow: 1 }], []);
  assert.match(html, /No tracked addresses/);
});

test("exchangeNotFoundHTML names the missing exchange", () => {
  assert.match(exchangeNotFoundHTML("Nope"), /Nope/);
});

test("exchangeAddressNotFoundHTML names both the exchange and the untracked address", () => {
  const html = exchangeAddressNotFoundHTML("Zaif", "NBOGUS1");
  assert.match(html, /Zaif/);
  assert.match(html, /NBOGUS1/);
  assert.match(html, /not tracked/);
});

test("navHTML includes an Exchanges link", () => {
  assert.match(navHTML("/exchanges"), /href="\/exchanges"[^>]*class="active"[^>]*>Exchanges/);
});
