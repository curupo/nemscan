import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync } from "node:fs";
import { networkContext } from "../src/context.js";

// db.js opens both SQLite files at import time as a side effect, so clean up
// any stale testnet DB from a previous run before importing it.
for (const f of ["./cache-testnet.db", "./cache-testnet.db-shm", "./cache-testnet.db-wal"]) {
  if (existsSync(f)) unlinkSync(f);
}

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
