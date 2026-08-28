import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkContext } from "../src/context.js";

// db.js opens both SQLite files at import time as a side effect, and resolves
// their paths from NETWORKS[*].dbFile, which honours NEMSCAN_DB_DIR. Point it
// at a fresh scratch directory so this test never touches the real
// cache.db / cache-testnet.db in the repo root. The env var must be set
// before importing db.js (or constants.js indirectly via db.js).
process.env.NEMSCAN_DB_DIR = mkdtempSync(join(tmpdir(), "nemscan-db-test-"));

const {
  setCacheMeta,
  getCacheMeta,
  upsertBlock,
  getCachedBlock,
  upsertMosaicTransfer,
  getMosaicTransfers,
  getMosaicTransfersCount,
  getMaxMosaicTransferNo,
  upsertTxTypeArchive,
  getTxTypeArchive,
  getTxTypeArchiveCount,
  trimTxTypeArchive,
} = await import("../src/db.js");

test("mainnet and testnet DB layers are independent", () => {
  networkContext.run("mainnet", () => {
    setCacheMeta("test_marker", "mainnet-value");
  });
  networkContext.run("testnet", () => {
    setCacheMeta("test_marker", "testnet-value");
  });
  networkContext.run("mainnet", () => {
    assert.equal(getCacheMeta("test_marker"), "mainnet-value");
  });
  networkContext.run("testnet", () => {
    assert.equal(getCacheMeta("test_marker"), "testnet-value");
  });
});

test("outside any networkContext.run, db.js defaults to the mainnet layer", () => {
  assert.equal(getCacheMeta("test_marker"), "mainnet-value");
});

test("upsertBlock/getCachedBlock round-trips the raw JSON exactly", () => {
  networkContext.run("mainnet", () => {
    const raw = { height: 123, timeStamp: 456, transactions: [{ type: 257 }] };
    upsertBlock(123, 456, JSON.stringify(raw));
    assert.deepEqual(getCachedBlock(123), raw);
  });
});

test("getCachedBlock returns null for a height that was never persisted", () => {
  networkContext.run("mainnet", () => {
    assert.equal(getCachedBlock(999_999_999), null);
  });
});

test("blocks table is isolated between mainnet and testnet", () => {
  networkContext.run("mainnet", () => {
    upsertBlock(500, 111, JSON.stringify({ network: "mainnet" }));
  });
  networkContext.run("testnet", () => {
    upsertBlock(500, 222, JSON.stringify({ network: "testnet" }));
  });
  networkContext.run("mainnet", () => {
    assert.equal(getCachedBlock(500).network, "mainnet");
  });
  networkContext.run("testnet", () => {
    assert.equal(getCachedBlock(500).network, "testnet");
  });
});

test("upsertMosaicTransfer/getMosaicTransfers round-trips and orders by no DESC", () => {
  networkContext.run("mainnet", () => {
    upsertMosaicTransfer(100, "hashA", "dim", "coin", 5_000_000, 6, "SENDER1", "RECIP1", 111);
    upsertMosaicTransfer(200, "hashB", "dim", "coin", 3_000_000, 6, "SENDER2", "RECIP2", 222);
    const rows = getMosaicTransfers(10, 0);
    assert.equal(rows[0].no, 200);
    assert.equal(rows[0].hash, "hashB");
    assert.equal(rows[1].no, 100);
  });
});

test("getMosaicTransfers filters to a single namespace+mosaic when both are given", () => {
  networkContext.run("mainnet", () => {
    upsertMosaicTransfer(300, "hashC", "other", "thing", 1, 0, "S", "R", 300);
    const rows = getMosaicTransfers(10, 0, "dim", "coin");
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.namespace === "dim" && r.mosaic === "coin"));
    assert.ok(!rows.some((r) => r.no === 300));
  });
});

test("getMosaicTransfers supports offset for pagination", () => {
  networkContext.run("mainnet", () => {
    const page1 = getMosaicTransfers(1, 0, "dim", "coin");
    const page2 = getMosaicTransfers(1, 1, "dim", "coin");
    assert.equal(page1[0].no, 200);
    assert.equal(page2[0].no, 100);
  });
});

test("getMosaicTransfersCount matches filtered and unfiltered result sets", () => {
  networkContext.run("mainnet", () => {
    assert.equal(getMosaicTransfersCount("dim", "coin"), 2);
    assert.ok(getMosaicTransfersCount() >= 3);
  });
});

test("getMaxMosaicTransferNo returns the highest stored no", () => {
  networkContext.run("mainnet", () => {
    assert.equal(getMaxMosaicTransferNo(), 300);
  });
});

test("getMaxMosaicTransferNo returns null when the table is empty", () => {
  networkContext.run("testnet", () => {
    assert.equal(getMaxMosaicTransferNo(), null);
  });
});

test("mosaic_transfers table is isolated between mainnet and testnet", () => {
  networkContext.run("testnet", () => {
    upsertMosaicTransfer(1, "hashT", "t", "coin", 1, 0, "S", "R", 1);
    assert.equal(getMosaicTransfersCount(), 1);
  });
  networkContext.run("mainnet", () => {
    assert.ok(getMosaicTransfersCount() >= 3);
  });
});

test("upsertTxTypeArchive/getTxTypeArchive round-trips and orders by height DESC", () => {
  networkContext.run("mainnet", () => {
    upsertTxTypeArchive("transfer", "hashA", 100, "SENDER1", "RECIP1", 5_000_000, 150000, 111, 257);
    upsertTxTypeArchive("transfer", "hashB", 200, "SENDER2", "RECIP2", 3_000_000, 150000, 222, 257);
    const rows = getTxTypeArchive("transfer", 10, 0);
    assert.deepEqual(rows.map((r) => r.hash), ["hashB", "hashA"]);
  });
});

test("a hash can be archived under two different filter_types independently", () => {
  networkContext.run("mainnet", () => {
    upsertTxTypeArchive("aggregate", "hashDual", 300, "S", "R", 0, 500000, 300, 4100);
    upsertTxTypeArchive("multisig", "hashDual", 300, "S", "R", 0, 500000, 300, 4100);
    assert.equal(getTxTypeArchiveCount("aggregate"), 1);
    assert.equal(getTxTypeArchiveCount("multisig"), 1);
  });
});

test("getTxTypeArchive supports offset for pagination", () => {
  networkContext.run("mainnet", () => {
    const page1 = getTxTypeArchive("transfer", 1, 0);
    const page2 = getTxTypeArchive("transfer", 1, 1);
    assert.notEqual(page1[0].hash, page2[0].hash);
  });
});

test("trimTxTypeArchive keeps only the newest `keep` rows for a filter_type and leaves other filter_types untouched", () => {
  networkContext.run("mainnet", () => {
    for (let i = 1; i <= 5; i++) {
      upsertTxTypeArchive("namespace", `hns${i}`, i * 10, "S", "", 0, 150000, i * 10, 8193);
    }
    upsertTxTypeArchive("importance", "hns-other", 999, "S", "R", 0, 150000, 999, 2049);
    trimTxTypeArchive("namespace", 3);
    assert.equal(getTxTypeArchiveCount("namespace"), 3);
    const rows = getTxTypeArchive("namespace", 10, 0);
    assert.deepEqual(rows.map((r) => r.height), [50, 40, 30]);
    assert.equal(getTxTypeArchiveCount("importance"), 1);
  });
});

test("tx_type_archive is isolated between mainnet and testnet", () => {
  networkContext.run("testnet", () => {
    assert.equal(getTxTypeArchiveCount("transfer"), 0);
  });
});
