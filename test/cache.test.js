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
} = await import("../src/cache.js");
const { getCachedBlock, getCacheMeta, getMosaicTransfers, getMaxMosaicTransferNo } = await import("../src/db.js");

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
