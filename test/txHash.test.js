import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTransferTxHash } from "../src/txHash.js";

// Test vectors pulled live from a mainnet NIS node (block/at/public for the
// raw tx, account/transfers/all for the real meta.hash to compare against).

test("computeTransferTxHash matches a real v1 transfer with no message", () => {
  const tx = {
    timeStamp: 360348990,
    amount: 308998700000,
    fee: 1300000,
    recipient: "NCQZSXFB6JVUYBMNIKSYXFOS7COICL2LPXULRD6K",
    type: 257,
    deadline: 360435390,
    message: {},
    version: 1744830465,
    signer:
      "5d69bdb5f4cf6b6167c3efb97b1e19d4a984b0bcfb0d48e376ce849beae36234",
  };
  assert.equal(
    computeTransferTxHash(tx),
    "c81af60ad1f55ef3b5603f984dd1d27209a0d9d196e270ae0174a98d8f268fc7",
  );
});

test("computeTransferTxHash matches a real v1 transfer with a plain-text message", () => {
  const tx = {
    timeStamp: 360305294,
    amount: 322000000,
    fee: 150000,
    recipient: "NDWT3POZXW4FC7LSC43OLVS4BCXCFB2NTFSEGBRH",
    type: 257,
    deadline: 360308894,
    message: {
      payload:
        "6e6f64652072657761726473207061796f757420666f7220726f756e6473203531343920746f2035313532",
      type: 1,
    },
    version: 1744830465,
    signer:
      "4b1451054a825b2501b877ef1eb26e6c1009c5e935851a679f75321123a742db",
  };
  assert.equal(
    computeTransferTxHash(tx),
    "20b3749e60d8148c27df37bd0e5304daae439774d6021946152f6fd006867b13",
  );
});

test("computeTransferTxHash matches a real v2 transfer with mosaic attachments", () => {
  const tx = {
    timeStamp: 360232428,
    amount: 400000000,
    fee: 300000,
    recipient: "NBULIZKC2WRSSBRBJF7K6VOO2ZJBKBFUMBKQLSB3",
    mosaics: [
      { quantity: 0, mosaicId: { namespaceId: "nem", name: "xem" } },
      { quantity: 1, mosaicId: { namespaceId: "smart-uq", name: "dig" } },
    ],
    type: 257,
    deadline: 360236028,
    message: {
      payload:
        "5b5b5be5b9b4e6aca1e69c89e7b5a6e794b3e8ab8b5d5d5de69c89e7b5a6e4bc91e69a87e697a5efbc9a323032362d30382d32383c62723ee4bc91e69a87e69c9fe99693efbc9a34e69982e99693203c62723ee38090e58299e88083e380913c62723ee7a781e794a8e381aee782ba",
      type: 1,
    },
    version: 1744830466,
    signer:
      "5b9ecc63cfbda8ae4d80ecdcd6f1c5691bb7653f62a401a380ab89ac88e614be",
  };
  assert.equal(
    computeTransferTxHash(tx),
    "a75053b5820e1140586f41465a5d7ea4c305670d0ad81ea618d26df096949c34",
  );
});

test("computeTransferTxHash returns null for non-transfer types", () => {
  assert.equal(computeTransferTxHash({ type: 2049 }), null);
});

test("computeTransferTxHash returns null for missing input", () => {
  assert.equal(computeTransferTxHash(null), null);
});
