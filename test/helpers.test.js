import { test } from "node:test";
import assert from "node:assert/strict";
import { pubKeyToAddress } from "../src/helpers.js";

test("pubKeyToAddress caches per network byte, not just per public key", () => {
  const hex =
    "17013b69a0194ff6d2699e830509ef491e9bbd65cb9ffdc935edd677a4d37b29";
  const mainnetAddr = pubKeyToAddress(hex, 0x68);
  const testnetAddr = pubKeyToAddress(hex, 0x98);
  assert.notEqual(mainnetAddr, testnetAddr);
});
