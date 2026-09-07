# Exchange Delisted Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a small "Delisted" badge for exchanges that no longer list XEM, on both the `/exchanges` overview card (top-right corner) and the `/exchange/:name` detail heading (inline next to the name).

**Architecture:** A new hardcoded `DELISTED_EXCHANGE_NAMES` array in `src/constants.js` (same convention as the existing `KNOWN_EXCHANGE_NAMES`). Two existing `src/html.js` functions (`exchangeOverviewHTML`, `heroExchange`) each do a plain `.includes()` check against it and conditionally render a `<span class="badge-no">Delisted</span>` (reusing the existing red-pill CSS class). One new CSS rule positions the overview-card instance in the corner.

**Tech Stack:** Node.js (ESM), plain server-rendered HTML strings, `node:test` + `node:assert/strict`.

## Global Constraints

- **Never run any git command.** The user runs git themselves in this repo — no `git add`, `git commit`, or any other git invocation. End at "run tests, confirm pass."
- Design doc: `docs/superpowers/specs/2026-09-07-exchange-delisted-badge-design.md` — read it if anything below is ambiguous.
- Tests go in `test/html.test.js`, following its existing conventions exactly (`node:test`'s `test()`, `assert.match`/`assert.doesNotMatch`).
- Run tests with: `node --test test/html.test.js`
- No new color/shape CSS — reuse the existing `.badge-no` class as-is; only add positioning CSS.

---

### Task 1: Delisted badge on overview card and detail heading

**Files:**
- Modify: `src/constants.js` (add `DELISTED_EXCHANGE_NAMES`, near the existing `KNOWN_EXCHANGE_NAMES` at lines 164-168)
- Modify: `src/html.js:30` (import), `src/html.js:526-530` (`heroExchange`), `src/html.js:746-761` (`exchangeOverviewHTML`'s per-card template, inside the `.map()`)
- Modify: `public/style.css:878-887` (`.exchange-card` — add `position: relative;`) and add a new `.exchange-delisted-flag` rule nearby
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: nothing new from other files.
- Produces: `DELISTED_EXCHANGE_NAMES: string[]` exported from `src/constants.js`. No other task depends on this (this plan has only one task).

- [ ] **Step 1: Write the failing tests**

Add to `test/html.test.js`, right after the existing `"exchangeOverviewHTML renders a card per exchange with its 7-day totals and a link to its detail page"` test:

```js
test("exchangeOverviewHTML shows a Delisted badge for a delisted exchange", () => {
  const html = exchangeOverviewHTML([
    { exchange_name: "Coincheck", address_count: 1, inflow_7d: 0, outflow_7d: 0 },
  ]);
  assert.match(html, /class="badge-no exchange-delisted-flag">Delisted</);
});

test("exchangeOverviewHTML omits the Delisted badge for an active exchange", () => {
  const html = exchangeOverviewHTML([
    { exchange_name: "Zaif", address_count: 1, inflow_7d: 0, outflow_7d: 0 },
  ]);
  assert.doesNotMatch(html, /Delisted/);
});
```

Add right after the existing `"heroExchange renders the exchange name as the title"` test:

```js
test("heroExchange shows a Delisted badge for a delisted exchange", () => {
  const html = heroExchange("Coincheck");
  assert.match(html, /<h1>Coincheck<\/h1>/);
  assert.match(html, /class="badge-no">Delisted</);
});

test("heroExchange omits the Delisted badge for an active exchange", () => {
  assert.doesNotMatch(heroExchange("Zaif"), /Delisted/);
});
```

No import-list changes needed — `exchangeOverviewHTML` and `heroExchange` are already imported in `test/html.test.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/html.test.js`
Expected: FAIL — the "shows a Delisted badge" tests fail (no `Delisted` text is rendered yet); the "omits" tests already pass vacuously (nothing to fix there, they just confirm the starting state).

- [ ] **Step 3: Implement**

In `src/constants.js`, right after the closing `];` of `KNOWN_EXCHANGE_NAMES` (currently ending at line 168):

```js
// Exchanges NEMSCAN still tracks XEM flow history for, but that no longer
// list XEM for trading. Purely a UI label — flow tracking/display is
// unaffected. Hardcoded per user-supplied list, same convention as
// KNOWN_EXCHANGE_NAMES.
export const DELISTED_EXCHANGE_NAMES = [
  "Binance", "Bittrex", "Coincheck", "Coinsuper", "Cryptopia", "Huobi",
  "Kuna", "Qryptos", "Yobit",
];
```

In `src/html.js`, change the constants import (line 30) from:

```js
import { TX_TYPES, XEM_TOTAL_SUPPLY, DAILY_TX_DAYS, NETWORKS, TX_LIST_FILTER_TYPES } from "./constants.js";
```

to:

```js
import { TX_TYPES, XEM_TOTAL_SUPPLY, DAILY_TX_DAYS, NETWORKS, TX_LIST_FILTER_TYPES, DELISTED_EXCHANGE_NAMES } from "./constants.js";
```

In `src/html.js`, change `heroExchange` (lines 526-530) from:

```js
export function heroExchange(name) {
  return `<div class="hero"><div class="hero-inner">
    <h1>${esc(name)}</h1>
  </div></div>`;
}
```

to:

```js
export function heroExchange(name) {
  const badge = DELISTED_EXCHANGE_NAMES.includes(name) ? ' <span class="badge-no">Delisted</span>' : "";
  return `<div class="hero"><div class="hero-inner">
    <h1>${esc(name)}${badge}</h1>
  </div></div>`;
}
```

In `src/html.js`, inside `exchangeOverviewHTML`'s card-building `.map()` (currently around lines 746-761), change:

```js
  const cards = list
    .map((e) => {
      const daily = getExchangeDailyFlows(e.exchange_name, 14);
      return `<a class="exchange-card" href="/exchange/${encodeURIComponent(e.exchange_name)}">
      <div class="exchange-card-head">
```

to:

```js
  const cards = list
    .map((e) => {
      const daily = getExchangeDailyFlows(e.exchange_name, 14);
      const badge = DELISTED_EXCHANGE_NAMES.includes(e.exchange_name)
        ? '<span class="badge-no exchange-delisted-flag">Delisted</span>'
        : "";
      return `<a class="exchange-card" href="/exchange/${encodeURIComponent(e.exchange_name)}">
      ${badge}
      <div class="exchange-card-head">
```

(Everything else in that template literal — the rest of the card markup — is unchanged; only the opening two lines shown above gain the `badge` variable and its insertion point.)

In `public/style.css`, change the `.exchange-card` rule (lines 878-887) from:

```css
.exchange-card {
    display: block;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    text-decoration: none;
    color: inherit;
    transition: border-color .15s;
}
```

to:

```css
.exchange-card {
    position: relative;
    display: block;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    text-decoration: none;
    color: inherit;
    transition: border-color .15s;
}
```

And add this new rule immediately after the `.exchange-card:hover` rule (currently lines 888-890):

```css
.exchange-delisted-flag {
    position: absolute;
    top: -8px;
    right: 12px;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/html.test.js`
Expected: PASS (all tests, including every pre-existing test in the file — this only adds a new constant, two conditional spans, and one CSS rule; no existing markup structure changes for non-delisted, non-hero-badge cases).

## Self-Review Notes

- **Spec coverage:** badge on overview card top-right corner ✓ (Step 3, `.exchange-delisted-flag` absolute-positioned CSS). Badge inline on detail heading ✓ (Step 3, `heroExchange`). Exact 9-name list with "Houbi"→"Huobi" correction ✓ (Step 3, `DELISTED_EXCHANGE_NAMES`). Reuses `.badge-no` color, no new color CSS ✓. No change to tracked data/charts for delisted exchanges — nothing in this task touches flow logic ✓.
- **Placeholder scan:** no TBD/TODO; complete code in every step.
- **Type/name consistency:** `DELISTED_EXCHANGE_NAMES` name matches between `constants.js` definition and both `html.js` call sites.
