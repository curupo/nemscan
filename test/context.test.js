import { test } from "node:test";
import assert from "node:assert/strict";
import { networkContext, currentNetwork } from "../src/context.js";

test("currentNetwork defaults to mainnet outside any networkContext.run", () => {
  assert.equal(currentNetwork(), "mainnet");
});

test("currentNetwork returns testnet inside networkContext.run('testnet', ...)", () => {
  networkContext.run("testnet", () => {
    assert.equal(currentNetwork(), "testnet");
  });
});

test("currentNetwork falls back to mainnet for an unrecognized stored value", () => {
  networkContext.run("bogus", () => {
    assert.equal(currentNetwork(), "mainnet");
  });
});
