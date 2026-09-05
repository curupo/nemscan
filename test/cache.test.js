import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkContext } from "../src/context.js";

// cache.js imports db.js, which opens both SQLite files at import time as a
// side effect. Point NEMSCAN_DB_DIR at a scratch directory before importing
// anything that reaches constants.js / db.js, so this test never touches the
// real cache.db / cache-testnet.db in the repo root (same pattern as
// test/db.test.js and test/nemApi.test.js).
process.env.NEMSCAN_DB_DIR = mkdtempSync(join(tmpdir(), "nemscan-cache-test-"));

const {
  fetchXemPriceFromCoinGecko,
  refreshNamespacesCache,
  scanBlockHeightsForDailyTx,
  refreshDailyTxStats,
  importMosaicTransferArchive,
  refreshMosaicTransfers,
  importTxTypeArchive,
  refreshTxTypeArchive,
  fetchUnconfirmedTxs,
  extractExchangeFlowsFromBlock,
  syncExchangeAddressesFromRichList,
  backfillNewExchangeAddresses,
  refreshRichListCache,
} = await import("../src/cache.js");
const {
  getCachedBlock,
  getCacheMeta,
  getMosaicTransfers,
  getMaxMosaicTransferNo,
  getTxTypeArchiveCount,
  getTxTypeArchive,
  upsertTxTypeArchive,
  upsertExchangeAddress,
  getExchangeDailyFlows,
  getCachedRichList,
  upsertRichListEntry,
  getExchangeAddresses,
  getExchangeAddressesNeedingBackfill,
  markExchangeAddressBackfilled,
  upsertBlock,
} = await import("../src/db.js");
// Dynamic import, not a static `import ... from` — a static import is
// hoisted ahead of *everything* in this module, including the
// NEMSCAN_DB_DIR assignment above, which would make constants.js (and
// db.js's NETWORKS through it) resolve against the real repo-root
// cache.db/cache-testnet.db instead of the scratch dir. See the file-top
// comment on NEMSCAN_DB_DIR.
const { TX_LIST_FILTER_TYPES, TX_TYPE_ARCHIVE_WINDOW } = await import("../src/constants.js");
const { addrFromPubKey } = await import("../src/helpers.js");

function mockFetchOnce(t, jsonBody, ok = true) {
  t.mock.method(global, "fetch", async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => jsonBody,
  }));
}

test("fetchXemPriceFromCoinGecko parses price and converts the 24h change percentage to a fraction", async (t) => {
  mockFetchOnce(t, { nem: { usd: 0.000511, usd_24h_change: 27.75 } });
  const result = await fetchXemPriceFromCoinGecko();
  assert.equal(result.price, 0.000511);
  assert.ok(Math.abs(result.changeRate - 0.2775) < 1e-9);
});

test("fetchXemPriceFromCoinGecko throws when the response has no nem entry", async (t) => {
  mockFetchOnce(t, {});
  await assert.rejects(() => fetchXemPriceFromCoinGecko(), /no ticker data/);
});

test("fetchXemPriceFromCoinGecko throws when the HTTP response is not ok", async (t) => {
  mockFetchOnce(t, {}, false);
  await assert.rejects(() => fetchXemPriceFromCoinGecko(), /status 500/);
});

test("refreshNamespacesCache guard flag is isolated per network — a slow mainnet refresh doesn't block a concurrent testnet refresh", { timeout: 5000 }, async (t) => {
  // fetchNamespacesFromNode uses nemFetch's `race: true` mode, which fires
  // every node in the pool in parallel (3 for mainnet, 2 for testnet by
  // default) rather than issuing a single fetch call per refresh. So "the
  // first call to fetch" isn't a reliable stand-in for "the mainnet call" —
  // we gate on an explicit phase switch made after the mainnet refresh has
  // started instead, and collect every hung mainnet fetch so all of them
  // (not just one) can be released at the end.
  const pendingMainnetFetches = [];
  let testnetFetchStarted = false;
  let phase = "mainnet";
  t.mock.method(global, "fetch", (url) => {
    if (phase === "mainnet" && String(url).includes("pagesize=25")) {
      // Mainnet calls: hang until we manually resolve them below.
      return new Promise((resolve) => {
        pendingMainnetFetches.push(() =>
          resolve({ ok: true, json: async () => ({ data: [] }) }),
        );
      });
    }
    testnetFetchStarted = true;
    return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
  });

  const mainnetPromise = networkContext.run("mainnet", () => refreshNamespacesCache());
  // Give the mainnet call's fetches a tick to register as "in flight" before
  // starting the testnet one.
  await new Promise((r) => setTimeout(r, 10));
  phase = "testnet";
  const testnetPromise = networkContext.run("testnet", () => refreshNamespacesCache());

  await testnetPromise;
  assert.ok(testnetFetchStarted, "testnet refresh should not be blocked by the in-flight mainnet refresh");

  pendingMainnetFetches.forEach((resolve) => resolve());
  await mainnetPromise;
});

test("scanBlockHeightsForDailyTx persists each fetched block to the blocks table", async (t) => {
  t.mock.method(global, "fetch", async (url, opts) => {
    const { height } = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ height, timeStamp: 1000 + height, transactions: [] }) };
  });

  await networkContext.run("mainnet", async () => {
    await scanBlockHeightsForDailyTx([100, 101, 102]);
    assert.deepEqual(getCachedBlock(101), { height: 101, timeStamp: 1101, transactions: [] });
  });
});

test("refreshDailyTxStats keeps walking backward past a small window, all the way to genesis, and persists blocks as it goes", async (t) => {
  t.mock.method(global, "fetch", async (url, opts) => {
    const u = String(url);
    if (u.includes("/chain/height")) {
      return { ok: true, json: async () => ({ height: 150 }) };
    }
    const { height } = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ height, timeStamp: height, transactions: [] }) };
  });

  // DAILY_TX_BACKFILL_CHUNK is 60 blocks per call; a chain height of 150
  // takes a few sequential calls to walk all the way back to genesis
  // (height 1). 6 calls is a comfortable margin over the ~4 actually needed.
  for (let i = 0; i < 6; i++) {
    await refreshDailyTxStats("mainnet");
  }

  networkContext.run("mainnet", () => {
    assert.equal(getCacheMeta("blocks_backfill_done"), "1");
    assert.ok(getCachedBlock(1), "expected the genesis block to have been persisted");
    assert.ok(getCachedBlock(150), "expected the chain tip to have been persisted");
  });
});

test("importMosaicTransferArchive pages through the mock archive, checkpoints its cursor, and sets the completed flag", async (t) => {
  // Three pages of 2 records each (well under the 50-per-page server clamp,
  // which is what ends real pagination) — the mock ends pagination the same
  // way the real server does: a batch shorter than pageSize.
  const pages = {
    // first call: no cursor
    null: [
      { no: 300, hash: "h3", namespace: "dim", mosaic: "coin", quantity: 1000, div: 6, sender: "SA", recipient: "RA", timeStamp: 300 },
      { no: 290, hash: "h2", namespace: "dim", mosaic: "coin", quantity: 2000, div: 6, sender: "SB", recipient: "RB", timeStamp: 290 },
    ],
    290: [
      { no: 280, hash: "h1", namespace: "other", mosaic: "thing", quantity: 5, div: 0, sender: "SC", recipient: "RC", timeStamp: 280 },
    ],
  };
  t.mock.method(global, "fetch", async (url, opts) => {
    const body = JSON.parse(opts.body);
    const batch = pages[body.no ?? "null"] || [];
    return { ok: true, json: async () => batch };
  });

  await networkContext.run("mainnet", async () => {
    await importMosaicTransferArchive();
    assert.equal(getCacheMeta("mosaic_transfers_archive_imported") != null, true);
    assert.equal(getCacheMeta("mosaic_transfer_archive_cursor"), null);
    const rows = getMosaicTransfers(10, 0);
    assert.deepEqual(rows.map((r) => r.no), [300, 290, 280]);
    assert.equal(getMaxMosaicTransferNo(), 300);
  });
});

test("importMosaicTransferArchive is a no-op once already imported", async (t) => {
  let calls = 0;
  t.mock.method(global, "fetch", async () => {
    calls++;
    return { ok: true, json: async () => [] };
  });
  await networkContext.run("mainnet", async () => {
    await importMosaicTransferArchive();
    assert.equal(calls, 0, "expected no fetch once mosaic_transfers_archive_imported is already set");
  });
});

test("refreshMosaicTransfers does nothing before the initial import has completed", async (t) => {
  let calls = 0;
  t.mock.method(global, "fetch", async () => {
    calls++;
    return { ok: true, json: async () => [] };
  });
  await networkContext.run("testnet", async () => {
    await refreshMosaicTransfers();
    assert.equal(calls, 0);
  });
});

test("refreshMosaicTransfers walks forward from the local max and stops once it reaches a known record", async (t) => {
  await networkContext.run("mainnet", async () => {
    // Seed the "already imported" state this test needs, independent of the
    // import test above (each test process/table state persists across
    // tests in this file, but this makes the precondition explicit).
    const { setCacheMeta } = await import("../src/db.js");
    setCacheMeta("mosaic_transfers_archive_imported", Date.now());

    const newPage = [
      { no: 320, hash: "hNew2", namespace: "dim", mosaic: "coin", quantity: 10, div: 6, sender: "SX", recipient: "RX", timeStamp: 320 },
      { no: 310, hash: "hNew1", namespace: "dim", mosaic: "coin", quantity: 20, div: 6, sender: "SY", recipient: "RY", timeStamp: 310 },
      { no: 300, hash: "h3", namespace: "dim", mosaic: "coin", quantity: 1000, div: 6, sender: "SA", recipient: "RA", timeStamp: 300 },
    ];
    t.mock.method(global, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.no ?? null, null, "refreshMosaicTransfers should always start from the newest page");
      return { ok: true, json: async () => newPage };
    });

    await refreshMosaicTransfers();
    assert.equal(getMaxMosaicTransferNo(), 320);
    const rows = getMosaicTransfers(10, 0);
    assert.ok(rows.some((r) => r.no === 310));
    assert.ok(!rows.some((r) => r.hash === "duplicate-should-not-happen"));
  });
});

test("refreshMosaicTransfers continues past a short intermediate page instead of stopping early", async (t) => {
  await networkContext.run("mainnet", async () => {
    const localMaxBefore = getMaxMosaicTransferNo();
    const page1 = [
      { no: localMaxBefore + 20, hash: "hFar2", namespace: "dim", mosaic: "coin", quantity: 1, div: 6, sender: "SP", recipient: "RP", timeStamp: 900 },
      { no: localMaxBefore + 10, hash: "hFar1", namespace: "dim", mosaic: "coin", quantity: 1, div: 6, sender: "SQ", recipient: "RQ", timeStamp: 800 },
    ];
    const page2 = [
      { no: localMaxBefore, hash: "hKnown", namespace: "dim", mosaic: "coin", quantity: 1, div: 6, sender: "SR", recipient: "RR", timeStamp: 700 },
    ];
    let calls = 0;
    t.mock.method(global, "fetch", async (url, opts) => {
      calls++;
      const body = JSON.parse(opts.body);
      const batch = (body.no ?? null) === null ? page1 : page2;
      return { ok: true, json: async () => batch };
    });

    await refreshMosaicTransfers();
    // page1's 2 records are upserted regardless of whether the loop then
    // continues (they're processed before the break check runs), so the
    // real signal that page2 was actually fetched is the call count, not
    // page1's own records.
    assert.equal(
      calls,
      2,
      "expected a second fetch for page2 even though page1 came back short (only 2 of the page-size-50 records)",
    );
    assert.equal(getMaxMosaicTransferNo(), localMaxBefore + 20);
    const rows = getMosaicTransfers(10, 0);
    assert.ok(
      rows.some((r) => r.no === localMaxBefore + 10),
      "expected the second (short, non-final) page to have been fetched and its record persisted",
    );
  });
});

test("refreshMosaicTransfers stops instead of looping forever if the server stalls on the same cursor", { timeout: 5000 }, async (t) => {
  await networkContext.run("mainnet", async () => {
    const localMaxBefore = getMaxMosaicTransferNo();
    const stuckPage = [
      { no: localMaxBefore + 5, hash: "hStuck", namespace: "dim", mosaic: "coin", quantity: 1, div: 6, sender: "SS", recipient: "RS", timeStamp: 999 },
    ];
    let calls = 0;
    t.mock.method(global, "fetch", async () => {
      calls++;
      return { ok: true, json: async () => stuckPage };
    });

    await refreshMosaicTransfers();
    assert.ok(calls <= 2, `expected the stalled-cursor guard to stop pagination quickly, got ${calls} fetch calls`);
  });
});

test("importTxTypeArchive fetches one page per filter_type (stopping on a short page) and marks each type's import flag", async (t) => {
  const requestedTypes = [];
  t.mock.method(global, "fetch", async (url, opts) => {
    const body = JSON.parse(opts.body);
    requestedTypes.push(body.type);
    return {
      ok: true,
      json: async () => [
        { hash: `h-${body.type}`, height: 100, sender: "S", recipient: "R", amount: 1, fee: 150000, timeStamp: 100, type: 257 },
      ],
    };
  });

  await networkContext.run("mainnet", async () => {
    const { getDb } = await import("../src/db.js");
    getDb().exec("DELETE FROM cache_meta WHERE key LIKE 'tx_type_archive_imported_%'");
    getDb().exec("DELETE FROM tx_type_archive");
    await importTxTypeArchive();
    assert.deepEqual(requestedTypes.slice().sort(), TX_LIST_FILTER_TYPES.slice().sort());
    for (const type of TX_LIST_FILTER_TYPES) {
      assert.equal(getCacheMeta(`tx_type_archive_imported_${type}`) != null, true);
    }
    assert.equal(getTxTypeArchiveCount("transfer"), 1);
  });
});

test("importTxTypeArchive skips a filter_type whose import flag is already set", async (t) => {
  let calls = 0;
  t.mock.method(global, "fetch", async () => {
    calls++;
    return { ok: true, json: async () => [] };
  });
  await networkContext.run("mainnet", async () => {
    const { setCacheMeta } = await import("../src/db.js");
    for (const type of TX_LIST_FILTER_TYPES) setCacheMeta(`tx_type_archive_imported_${type}`, Date.now());
    await importTxTypeArchive();
    assert.equal(calls, 0);
  });
});

test("importTxTypeArchive logs and continues past a failure for one filter_type instead of aborting the rest", async (t) => {
  await networkContext.run("mainnet", async () => {
    const { getDb } = await import("../src/db.js");
    getDb().exec("DELETE FROM cache_meta WHERE key LIKE 'tx_type_archive_imported_%'");

    const requestedTypes = [];
    t.mock.method(global, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      requestedTypes.push(body.type);
      if (body.type === "namespace") return { ok: false, status: 500, json: async () => [] };
      return { ok: true, json: async () => [{ hash: `h-${body.type}`, height: 1, sender: "S", recipient: "R", amount: 0, fee: 0, timeStamp: 1, type: 257 }] };
    });

    await importTxTypeArchive();
    assert.equal(requestedTypes.length, 6, "expected every filter_type to be attempted even after one fails");
    assert.equal(getCacheMeta("tx_type_archive_imported_namespace"), null);
    assert.equal(getCacheMeta("tx_type_archive_imported_transfer") != null, true);
  });
});

test("refreshTxTypeArchive only refreshes filter_types whose backfill has completed", async (t) => {
  await networkContext.run("mainnet", async () => {
    const { getDb, setCacheMeta } = await import("../src/db.js");
    getDb().exec("DELETE FROM cache_meta WHERE key LIKE 'tx_type_archive_imported_%'");
    setCacheMeta("tx_type_archive_imported_transfer", Date.now());

    const requestedTypes = [];
    t.mock.method(global, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      requestedTypes.push(body.type);
      return { ok: true, json: async () => [{ hash: "hRefresh", height: 500, sender: "S", recipient: "R", amount: 1, fee: 1, timeStamp: 500, type: 257 }] };
    });

    await refreshTxTypeArchive();
    assert.deepEqual(requestedTypes, ["transfer"]);
  });
});

test("refreshTxTypeArchive trims each filter_type back down to TX_TYPE_ARCHIVE_WINDOW after topping up", async (t) => {
  await networkContext.run("mainnet", async () => {
    const { getDb, setCacheMeta } = await import("../src/db.js");
    getDb().exec("DELETE FROM cache_meta WHERE key LIKE 'tx_type_archive_imported_%'");
    getDb().exec("DELETE FROM tx_type_archive WHERE filter_type = 'transfer'");
    setCacheMeta("tx_type_archive_imported_transfer", Date.now());
    for (let i = 0; i < TX_TYPE_ARCHIVE_WINDOW; i++) {
      upsertTxTypeArchive("transfer", `hOld${i}`, i, "S", "R", 1, 1, i, 257);
    }

    t.mock.method(global, "fetch", async () => ({
      ok: true,
      json: async () => [{ hash: "hNew", height: TX_TYPE_ARCHIVE_WINDOW + 1, sender: "S", recipient: "R", amount: 1, fee: 1, timeStamp: 999999, type: 257 }],
    }));

    await refreshTxTypeArchive();
    assert.equal(getTxTypeArchiveCount("transfer"), TX_TYPE_ARCHIVE_WINDOW);
    const rows = getTxTypeArchive("transfer", 1, 0);
    assert.equal(rows[0].hash, "hNew");
    assert.equal(
      getTxTypeArchive("transfer", TX_TYPE_ARCHIVE_WINDOW, 0).some((r) => r.hash === "hOld0"),
      false,
      "expected the oldest pre-existing row to have been trimmed",
    );
  });
});

test("refreshTxTypeArchive catches a failure for one filter_type and continues with the others", async (t) => {
  await networkContext.run("mainnet", async () => {
    const { getDb, setCacheMeta } = await import("../src/db.js");
    getDb().exec("DELETE FROM cache_meta WHERE key LIKE 'tx_type_archive_imported_%'");
    for (const type of TX_LIST_FILTER_TYPES) setCacheMeta(`tx_type_archive_imported_${type}`, Date.now());

    const requestedTypes = [];
    t.mock.method(global, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      requestedTypes.push(body.type);
      if (body.type === "namespace") return { ok: false, status: 500, json: async () => [] };
      return { ok: true, json: async () => [] };
    });

    await refreshTxTypeArchive();
    assert.equal(requestedTypes.length, 6, "expected every filter_type to be attempted even after one fails");
  });
});

test("fetchUnconfirmedTxs posts to nemtool's unconfirmedTXList endpoint and returns its array", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    assert.equal(String(url), "https://explorer.nemtool.com/tx/unconfirmedTXList");
    return { ok: true, json: async () => [{ hash: "hPending", type: 257 }] };
  });
  const items = await fetchUnconfirmedTxs();
  assert.deepEqual(items, [{ hash: "hPending", type: 257 }]);
});

test("fetchUnconfirmedTxs throws on a non-ok response", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 500, json: async () => [] }));
  await assert.rejects(() => fetchUnconfirmedTxs(), /status 500/);
});

test("extractExchangeFlowsFromBlock records outflow for a watched sender and inflow for a watched recipient", () => {
  networkContext.run("mainnet", () => {
    // Uses its own fixture pubkey (distinct from the one used by the
    // "scanBlockHeightsForDailyTx records exchange flows..." test below) —
    // exchange_addresses.address is a primary key, so two tests sharing one
    // derived address under different exchange_names would collide via
    // upsertExchangeAddress's INSERT OR IGNORE.
    const signerHex = "cc".repeat(32);
    const senderAddr = addrFromPubKey(signerHex);
    // getExchangeDailyFlows resolves by exchange_name via a JOIN against
    // exchange_addresses (see src/db.js), so the watched addresses must be
    // registered there for the assertions below to find the flows that
    // bumpExchangeDailyFlow writes by address.
    upsertExchangeAddress(senderAddr, "TestEx", "TestEx -- Exchange");
    upsertExchangeAddress("NRECIPIENT1", "OtherEx", "OtherEx -- Exchange");
    const watchMap = new Map([
      [senderAddr, "TestEx"],
      ["NRECIPIENT1", "OtherEx"],
    ]);
    const block = {
      timeStamp: 5000,
      transactions: [
        { type: 257, signer: signerHex, recipient: "NUNWATCHED", amount: 4_000_000 },
        { type: 257, signer: "aa".repeat(32), recipient: "NRECIPIENT1", amount: 2_000_000 },
        { type: 4100, signer: signerHex, recipient: "NRECIPIENT1", amount: 999 },
      ],
    };
    extractExchangeFlowsFromBlock(block, watchMap);
    const senderFlows = getExchangeDailyFlows("TestEx", 5);
    assert.equal(senderFlows.length, 1);
    assert.equal(senderFlows[0].outflow, 4_000_000);
    assert.equal(senderFlows[0].inflow, 0);
    const recipientFlows = getExchangeDailyFlows("OtherEx", 5);
    assert.equal(recipientFlows.length, 1);
    assert.equal(recipientFlows[0].inflow, 2_000_000);
    assert.equal(recipientFlows[0].outflow, 0);
  });
});

test("extractExchangeFlowsFromBlock is a no-op for an empty watch map", () => {
  assert.doesNotThrow(() =>
    extractExchangeFlowsFromBlock(
      { timeStamp: 1, transactions: [{ type: 257, signer: "aa".repeat(32), recipient: "N", amount: 1 }] },
      new Map(),
    ),
  );
});

test("extractExchangeFlowsFromBlock excludes mosaic-attached transfers (tx.amount is a multiplier, not XEM, when mosaics are present)", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NMOSAICWATCH1", "MosaicTestEx", "MosaicTestEx -- Exchange");
    const watchMap = new Map([["NMOSAICWATCH1", "MosaicTestEx"]]);

    // Mosaic-attached transfer: tx.amount here is a multiplier, not XEM — must be excluded.
    extractExchangeFlowsFromBlock(
      {
        timeStamp: 5500,
        transactions: [
          {
            type: 257,
            signer: "ee".repeat(32),
            recipient: "NMOSAICWATCH1",
            amount: 1_000_000,
            mosaics: [{ mosaicId: { namespaceId: "some", name: "mosaic" }, quantity: 5 }],
          },
        ],
      },
      watchMap,
    );
    assert.equal(
      getExchangeDailyFlows("MosaicTestEx", 5).reduce((sum, r) => sum + r.inflow, 0),
      0,
      "a mosaic-attached transfer must not be counted as XEM inflow",
    );

    // Control: the identical transaction WITHOUT a mosaics array is a plain
    // XEM transfer and MUST be recorded — proves the exclusion above is
    // actually exercising the mosaics check, not some unrelated reason
    // nothing got recorded (e.g. the address never being registered).
    extractExchangeFlowsFromBlock(
      {
        timeStamp: 5501,
        transactions: [
          { type: 257, signer: "ee".repeat(32), recipient: "NMOSAICWATCH1", amount: 2_000_000 },
        ],
      },
      watchMap,
    );
    assert.equal(
      getExchangeDailyFlows("MosaicTestEx", 5).reduce((sum, r) => sum + r.inflow, 0),
      2_000_000,
      "a plain (non-mosaic) transfer to the same watched address must still be recorded",
    );
  });
});

test("extractExchangeFlowsFromBlock does not double-book an intra-exchange transfer as both inflow and outflow", () => {
  networkContext.run("mainnet", () => {
    const signerHex = "ff".repeat(32);
    const senderAddr = addrFromPubKey(signerHex);
    upsertExchangeAddress(senderAddr, "SameEx", "SameEx -- Exchange hot wallet");
    upsertExchangeAddress("NSAMEEXCOLD1", "SameEx", "SameEx -- Exchange cold wallet");
    const watchMap = new Map([
      [senderAddr, "SameEx"],
      ["NSAMEEXCOLD1", "SameEx"],
    ]);
    const block = {
      timeStamp: 5600,
      transactions: [
        { type: 257, signer: signerHex, recipient: "NSAMEEXCOLD1", amount: 3_000_000 },
      ],
    };
    extractExchangeFlowsFromBlock(block, watchMap);
    const rows = getExchangeDailyFlows("SameEx", 5);
    assert.equal(rows.length, 0, "an internal transfer within the same exchange must not be recorded as inflow or outflow");
  });
});

test("scanBlockHeightsForDailyTx records exchange flows for a currently-watched address", async (t) => {
  const signerHex =
    "17013b69a0194ff6d2699e830509ef491e9bbd65cb9ffdc935edd677a4d37b29";
  await networkContext.run("mainnet", async () => {
    const exchangeAddr = addrFromPubKey(signerHex);
    upsertExchangeAddress(exchangeAddr, "LiveHookEx", "LiveHookEx -- Exchange");

    t.mock.method(global, "fetch", async (url, opts) => {
      const { height } = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          height,
          timeStamp: 6000,
          transactions: [
            { type: 257, signer: signerHex, recipient: "NSOMEONE", amount: 7_000_000 },
          ],
        }),
      };
    });

    await scanBlockHeightsForDailyTx([900]);
    const rows = getExchangeDailyFlows("LiveHookEx", 5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outflow, 7_000_000);
  });
});

test("syncExchangeAddressesFromRichList registers only richlist rows whose info matches a known exchange name", () => {
  networkContext.run("mainnet", () => {
    upsertRichListEntry(1, "NKNOWN1", 1_000_000, "Bittrex -- Exchange Wallet");
    upsertRichListEntry(2, "NUNKNOWN1", 2_000_000, "Protocol Treasury Account");
    upsertRichListEntry(3, "NKNOWN2", 3_000_000, "");
    syncExchangeAddressesFromRichList();
    const addrs = getExchangeAddresses().map((r) => r.address);
    assert.ok(addrs.includes("NKNOWN1"));
    assert.ok(!addrs.includes("NUNKNOWN1"));
    assert.ok(!addrs.includes("NKNOWN2"));
    const row = getExchangeAddresses().find((r) => r.address === "NKNOWN1");
    assert.equal(row.exchange_name, "Bittrex");
  });
});

test("syncExchangeAddressesFromRichList is idempotent — running it twice doesn't duplicate or reset rows", () => {
  networkContext.run("mainnet", () => {
    upsertRichListEntry(4, "NIDEMPOTENT1", 1, "Yobit");
    syncExchangeAddressesFromRichList();
    markExchangeAddressBackfilled("NIDEMPOTENT1");
    syncExchangeAddressesFromRichList();
    const row = getExchangeAddresses().find((r) => r.address === "NIDEMPOTENT1");
    assert.equal(row.backfilled, 1);
  });
});

test("backfillNewExchangeAddresses scans existing cached blocks for a newly-added address and marks it backfilled", async () => {
  await networkContext.run("mainnet", async () => {
    // A distinct fixture pubkey, not the one Task 3's tests already
    // registered in this same shared test/cache.test.js DB (as
    // "LiveHookEx") — reusing it would hit exchange_addresses' PRIMARY KEY
    // on `address` and upsertExchangeAddress's INSERT OR IGNORE would
    // silently keep "LiveHookEx" instead of registering "BackfillEx" here.
    const signerHex = "dd".repeat(32);
    const exchangeAddr = addrFromPubKey(signerHex);

    upsertBlock(2000, 8000, JSON.stringify({
      height: 2000,
      timeStamp: 8000,
      transactions: [{ type: 257, signer: signerHex, recipient: "NSOMEONE2", amount: 9_000_000 }],
    }));
    upsertBlock(2001, 8001, JSON.stringify({ height: 2001, timeStamp: 8001, transactions: [] }));

    upsertExchangeAddress(exchangeAddr, "BackfillEx", "BackfillEx -- Exchange");
    await backfillNewExchangeAddresses();

    const rows = getExchangeDailyFlows("BackfillEx", 5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outflow, 9_000_000);
    assert.equal(getExchangeAddressesNeedingBackfill().find((r) => r.address === exchangeAddr), undefined);
  });
});

test("backfillNewExchangeAddresses skips an unparseable cached block instead of aborting the whole backfill", async () => {
  await networkContext.run("mainnet", async () => {
    const signerHex = "22".repeat(32);
    const exchangeAddr = addrFromPubKey(signerHex);

    // A corrupt row (invalid JSON) alongside a valid one in the same
    // height range being backfilled — the corrupt row must be skipped
    // (and logged), not abort the whole backfill.
    upsertBlock(2002, 8002, "{not valid json");
    upsertBlock(2003, 8003, JSON.stringify({
      height: 2003,
      timeStamp: 8003,
      transactions: [{ type: 257, signer: signerHex, recipient: "NSOMEONE3", amount: 6_000_000 }],
    }));

    upsertExchangeAddress(exchangeAddr, "CorruptRowEx", "CorruptRowEx -- Exchange");
    await assert.doesNotReject(() => backfillNewExchangeAddresses());

    const rows = getExchangeDailyFlows("CorruptRowEx", 5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outflow, 6_000_000);
    assert.equal(
      getExchangeAddressesNeedingBackfill().find((r) => r.address === exchangeAddr),
      undefined,
      "the address must still be marked backfilled despite the corrupt row",
    );
  });
});

test("backfillNewExchangeAddresses is a no-op when there is nothing pending", async () => {
  await networkContext.run("mainnet", async () => {
    // Earlier tests in this shared-DB file register several exchange
    // addresses (via upsertExchangeAddress/extractExchangeFlowsFromBlock)
    // without backfilling them, so getExchangeAddressesNeedingBackfill()
    // would otherwise still be non-empty here — mark them all backfilled
    // first to genuinely reach the empty-pending state this test means to
    // exercise (the early-return path in backfillNewExchangeAddresses).
    for (const { address } of getExchangeAddressesNeedingBackfill()) {
      markExchangeAddressBackfilled(address);
    }
    assert.deepEqual(getExchangeAddressesNeedingBackfill(), []);
    await assert.doesNotReject(() => backfillNewExchangeAddresses());
    assert.deepEqual(getExchangeAddressesNeedingBackfill(), []);
  });
});

test("refreshRichListCache also syncs and backfills exchange addresses", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    status: 200,
    text: async () =>
      '<tr class="d0"><td>1</td><td>NWIRED1</td><td class="rght">x</td><td class="rght">123</td><td>Kuna -- Exchange</td></tr>',
  }));
  await networkContext.run("mainnet", async () => {
    await refreshRichListCache();
    const row = getExchangeAddresses().find((r) => r.address === "NWIRED1");
    assert.ok(row, "expected refreshRichListCache to have registered the Kuna address");
    assert.equal(row.exchange_name, "Kuna");
  });
});
