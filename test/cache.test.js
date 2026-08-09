import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchXemPriceFromCoinGecko } from "../src/cache.js";

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
