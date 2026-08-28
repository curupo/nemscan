import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pubKeyToAddress,
  parseMosaicIdQuery,
  mosaicFilterFromQuery,
} from "../src/helpers.js";

test("pubKeyToAddress caches per network byte, not just per public key", () => {
  const hex =
    "17013b69a0194ff6d2699e830509ef491e9bbd65cb9ffdc935edd677a4d37b29";
  const mainnetAddr = pubKeyToAddress(hex, 0x68);
  const testnetAddr = pubKeyToAddress(hex, 0x98);
  assert.notEqual(mainnetAddr, testnetAddr);
});

test("parseMosaicIdQuery splits a valid ns:m query and lowercases it", () => {
  assert.deepEqual(parseMosaicIdQuery("DIM:COIN"), { ns: "dim", m: "coin" });
});

test("parseMosaicIdQuery returns null for a query with no colon", () => {
  assert.equal(parseMosaicIdQuery("dimcoin"), null);
});

test("parseMosaicIdQuery returns null when either side of the colon is empty", () => {
  assert.equal(parseMosaicIdQuery(":coin"), null);
  assert.equal(parseMosaicIdQuery("dim:"), null);
});

test("parseMosaicIdQuery does not throw when given an array (repeated query param)", () => {
  assert.doesNotThrow(() => parseMosaicIdQuery(["dim:coin", "other:mosaic"]));
});

test("mosaicFilterFromQuery returns a lowercased filter when both ns and m are present", () => {
  assert.deepEqual(mosaicFilterFromQuery({ ns: "DIM", m: "COIN" }), {
    ns: "dim",
    m: "coin",
  });
});

test("mosaicFilterFromQuery returns an empty filter when only one of ns/m is present", () => {
  assert.deepEqual(mosaicFilterFromQuery({ ns: "dim" }), { ns: null, m: null });
  assert.deepEqual(mosaicFilterFromQuery({ m: "coin" }), { ns: null, m: null });
});

test("mosaicFilterFromQuery does not throw when ns or m is an array (repeated query param)", () => {
  assert.doesNotThrow(() =>
    mosaicFilterFromQuery({ ns: ["dim", "other"], m: "coin" }),
  );
});

test("mosaicFilterFromQuery round-trips the ns/m a mosaicDetailHTML 'View all transfers' link encodes", () => {
  // Regression test for the bug where mosaicDetailHTML linked to
  // /mosaictransfer?ns=<namespace>&m=<name> but the page route only read
  // ?q=, silently dropping the filter. This locks in that a URL built the
  // same way mosaicDetailHTML builds it round-trips through
  // mosaicFilterFromQuery to the original { ns, m }.
  const namespace = "dim";
  const name = "coin";
  const link = `/mosaictransfer?ns=${encodeURIComponent(namespace)}&m=${encodeURIComponent(name)}`;
  const query = Object.fromEntries(new URL(link, "http://localhost").searchParams);
  assert.deepEqual(mosaicFilterFromQuery(query), { ns: namespace, m: name });
});
