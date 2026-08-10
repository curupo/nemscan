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

const { setCacheMeta, getCacheMeta, upsertBlock, getCachedBlock } = await import("../src/db.js");

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
