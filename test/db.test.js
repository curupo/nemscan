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

const { setCacheMeta, getCacheMeta } = await import("../src/db.js");

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
