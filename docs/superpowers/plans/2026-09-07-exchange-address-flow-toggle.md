# Exchange Address Flow Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `/exchange/:name`, let the viewer switch the inflow/outflow chart (and its totals line) between the combined total and any single tracked address, via a tab row that only appears when the exchange has 2+ addresses.

**Architecture:** A new DB accessor (`getExchangeDailyFlowsForAddress`) reads one address's rows directly (no `SUM`, since `(date, address)` is the table's primary key). `exchangeDetailHTML`'s existing totals+chart block is extracted into a reusable `exchangeFlowSectionHTML(name, data)`, wrapped in `<div id="exchange-flow-section">`, with a new `exchangeAddressTabsHTML(name, addresses)` tab row above it (empty string for 0-1 addresses). Tab buttons reuse the existing `.tab-nav`/`.tab-btn` CSS and `hx-get`/`hx-target`/`hx-swap` pattern already used on the account-detail page, pointed at a new `GET /api/exchange/:name/flows?address=` route that renders just `exchangeFlowSectionHTML`.

**Tech Stack:** Node.js (ESM), Express, `node:sqlite`, htmx (server-rendered fragments), `node:test` + `node:assert/strict`.

## Global Constraints

- **Never run any git command.** The user runs git themselves in this repo — no `git add`, `git commit`, or any other git invocation in any task below. Every task below ends at "run tests, confirm pass" instead.
- Design doc: `docs/superpowers/specs/2026-09-07-exchange-address-flow-toggle-design.md` — read it if anything below is ambiguous.
- DB tests go in `test/db.test.js`; HTML tests go in `test/html.test.js` — both following each file's existing conventions exactly (`node:test`'s `test()`, `assert.deepEqual`/`assert.match`/`assert.doesNotMatch`, `networkContext.run("mainnet", () => { ... })` around any assertion touching the DB).
- Run tests with: `node --test test/db.test.js` and `node --test test/html.test.js` (or `node --test` for the whole suite).
- No new CSS. No new npm dependencies.
- This repo has no route-level (`index.js`) automated tests today (confirmed: no `supertest`/`app.listen` usage anywhere in `test/`) — the new route in Task 3 is verified manually, matching the rest of the codebase's testing boundary.

---

### Task 1: `getExchangeDailyFlowsForAddress` in `src/db.js`

**Files:**
- Modify: `src/db.js:310-318` (add a sibling prepared statement right after `_exFlowByExchangeStmt`), `src/db.js:399-401` (add the layer method next to `getExchangeDailyFlows`), `src/db.js:550-552` (add the exported wrapper next to `getExchangeDailyFlows`)
- Test: `test/db.test.js`

**Interfaces:**
- Consumes: nothing new — reads the existing `exchange_daily_flows` table (schema: `date TEXT, address TEXT, inflow INTEGER, outflow INTEGER`, `PRIMARY KEY (date, address)`).
- Produces: `getExchangeDailyFlowsForAddress(address: string, days: number) => { date: string, inflow: number, outflow: number }[]`, ascending by date, at most `days` rows — same return shape as the existing `getExchangeDailyFlows(exchangeName, days)`. Task 3 calls this directly.

- [ ] **Step 1: Write the failing test**

Add to `test/db.test.js`, right after the existing `"getExchangeDailyFlows caps to the most recent \`days\` rows, ascending"` test (around line 259):

```js
test("getExchangeDailyFlowsForAddress returns only rows for the given address, ascending by date", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NADDR1", "Binance", "Binance -- Exchange");
    upsertExchangeAddress("NADDR2", "Binance", "Binance -- Cold Wallet");
    bumpExchangeDailyFlow("2026-09-02", "NADDR1", 500_000, 200_000);
    bumpExchangeDailyFlow("2026-09-01", "NADDR1", 1_000_000, 0);
    bumpExchangeDailyFlow("2026-09-01", "NADDR2", 9_000_000, 9_000_000);
    const rows = getExchangeDailyFlowsForAddress("NADDR1", 30);
    assert.deepEqual(rows, [
      { date: "2026-09-01", inflow: 1_000_000, outflow: 0 },
      { date: "2026-09-02", inflow: 500_000, outflow: 200_000 },
    ]);
  });
});

test("getExchangeDailyFlowsForAddress caps to the most recent `days` rows, ascending", () => {
  networkContext.run("mainnet", () => {
    upsertExchangeAddress("NADDR3", "Cryptopia", "Cryptopia -- Exchange");
    for (const d of ["2026-08-01", "2026-08-02", "2026-08-03"]) {
      bumpExchangeDailyFlow(d, "NADDR3", 1, 0);
    }
    const rows = getExchangeDailyFlowsForAddress("NADDR3", 2);
    assert.deepEqual(rows.map((r) => r.date), ["2026-08-02", "2026-08-03"]);
  });
});
```

Also add `getExchangeDailyFlowsForAddress` to the destructured import block at the top of `test/db.test.js` (currently lines 15-38), right after `getExchangeDailyFlows`:

```js
  getExchangeDailyFlows,
  getExchangeDailyFlowsForAddress,
  getExchangeList,
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db.test.js`
Expected: FAIL with `TypeError: getExchangeDailyFlowsForAddress is not a function` (or similar — it isn't exported yet).

- [ ] **Step 3: Implement**

In `src/db.js`, right after the existing `_exFlowByExchangeStmt` definition (lines 310-318):

```js
  const _exFlowByExchangeStmt = db.prepare(`
    SELECT f.date AS date, SUM(f.inflow) AS inflow, SUM(f.outflow) AS outflow
    FROM exchange_daily_flows f
    JOIN exchange_addresses a ON a.address = f.address
    WHERE a.exchange_name = ?
    GROUP BY f.date
    ORDER BY f.date DESC
    LIMIT ?
  `);
  const _exFlowByAddressStmt = db.prepare(`
    SELECT date, inflow, outflow
    FROM exchange_daily_flows
    WHERE address = ?
    ORDER BY date DESC
    LIMIT ?
  `);
```

In the object returned by `openDbLayer()`, right after `getExchangeDailyFlows` (lines 399-400):

```js
    getExchangeDailyFlows: (exchangeName, days) =>
      _exFlowByExchangeStmt.all(exchangeName, days).reverse().map(r => ({ ...r })),
    getExchangeDailyFlowsForAddress: (address, days) =>
      _exFlowByAddressStmt.all(address, days).reverse().map(r => ({ ...r })),
```

In the top-level exports, right after `getExchangeDailyFlows` (lines 550-552):

```js
export function getExchangeDailyFlows(exchangeName, days) {
  return layer().getExchangeDailyFlows(exchangeName, days);
}
export function getExchangeDailyFlowsForAddress(address, days) {
  return layer().getExchangeDailyFlowsForAddress(address, days);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db.test.js`
Expected: PASS (all tests, including every pre-existing `db.test.js` test — this only adds new statements/exports, it doesn't touch existing ones).

---

### Task 2: `exchangeFlowSectionHTML` + `exchangeAddressTabsHTML` in `src/html.js`

**Files:**
- Modify: `src/html.js:712-724` (replace the body of `exchangeDetailHTML`, adding two new exported functions above it)
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: `exchangeFlowChartHTML(data)` (existing, unchanged, `src/html.js:667`), `esc`/`xem`/`truncKey` (existing imports, already at the top of `src/html.js`).
- Produces:
  - `exchangeFlowSectionHTML(name: string, data: {date,inflow,outflow}[]) => string` — the totals line + chart, keyed by `id="exchange-flow-section"` by its caller (not by this function itself — see `exchangeDetailHTML` below). Task 3's new route renders this directly as its response body.
  - `exchangeAddressTabsHTML(name: string, addresses: {address: string, label: string|null}[]) => string` — `""` for `addresses.length <= 1`; otherwise a `.tab-nav` block with a `Total` button (`hx-get="/api/exchange/<name>/flows"`) plus one button per address (`hx-get="/api/exchange/<name>/flows?address=<address>"`), each `hx-target="#exchange-flow-section" hx-swap="innerHTML" onclick="setExchangeTab(this)"`.
  - `exchangeDetailHTML(name, data, addresses)` — same signature as today, now composed from the two functions above plus the untouched `exchangeAddressListHTML(addresses)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/html.test.js`, right after the existing `"exchangeFlowChartHTML renders one inflow bar and one outflow bar per day"` test (around line 774, before the current `exchangeDetailHTML` tests):

```js
test("exchangeFlowSectionHTML renders the exchange name, totals, and chart", () => {
  const html = exchangeFlowSectionHTML("Zaif", [
    { date: "2026-09-01", inflow: 1_000_000, outflow: 500_000 },
  ]);
  assert.match(html, /Zaif/);
  assert.match(html, /class="exchange-flow-chart"/);
  assert.match(html, /1\.00 XEM/);
  assert.match(html, /0\.50 XEM/);
});

test("exchangeAddressTabsHTML returns nothing for 0 or 1 tracked addresses", () => {
  assert.equal(exchangeAddressTabsHTML("Zaif", []), "");
  assert.equal(
    exchangeAddressTabsHTML("Zaif", [{ address: "NABCDEF1", label: "Zaif -- Hot Wallet" }]),
    "",
  );
});

test("exchangeAddressTabsHTML renders a Total tab plus one tab per address for 2+ addresses", () => {
  const html = exchangeAddressTabsHTML("Zaif", [
    { address: "NABCDEF1", label: "Zaif -- Hot Wallet" },
    { address: "NABCDEF2", label: null },
  ]);
  assert.match(html, /class="tab-nav"/);
  assert.match(html, /class="tab-btn active"[^>]*hx-get="\/api\/exchange\/Zaif\/flows"[^>]*>Total</);
  assert.match(html, /hx-get="\/api\/exchange\/Zaif\/flows\?address=NABCDEF1"/);
  assert.match(html, /hx-get="\/api\/exchange\/Zaif\/flows\?address=NABCDEF2"/);
  assert.match(html, /hx-target="#exchange-flow-section"/);
});
```

Replace the existing `"exchangeDetailHTML links each tracked address to its account page"` test's neighbors by adding two new tests right after `"exchangeDetailHTML labels the count badge as active days, not calendar days"` (around line 795):

```js
test("exchangeDetailHTML wraps the flow section and includes tabs for 2+ addresses", () => {
  const html = exchangeDetailHTML(
    "Zaif",
    [{ date: "2026-09-01", inflow: 1, outflow: 1 }],
    [
      { address: "NABCDEF1", label: "Zaif -- Hot Wallet" },
      { address: "NABCDEF2", label: null },
    ],
  );
  assert.match(html, /id="exchange-flow-section"/);
  assert.match(html, /class="tab-nav"/);
});

test("exchangeDetailHTML omits tabs when only one address is tracked", () => {
  const html = exchangeDetailHTML(
    "Zaif",
    [{ date: "2026-09-01", inflow: 1, outflow: 1 }],
    [{ address: "NABCDEF1", label: "Zaif -- Hot Wallet" }],
  );
  assert.doesNotMatch(html, /class="tab-nav"/);
});
```

Also add `exchangeFlowSectionHTML` and `exchangeAddressTabsHTML` to the destructured import block at the top of `test/html.test.js` (currently lines 17-45), right after `exchangeFlowChartHTML`:

```js
  exchangeFlowChartHTML,
  exchangeFlowSectionHTML,
  exchangeAddressTabsHTML,
  exchangeDetailHTML,
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/html.test.js`
Expected: FAIL — `exchangeFlowSectionHTML is not a function` / `exchangeAddressTabsHTML is not a function` (neither exists yet).

- [ ] **Step 3: Implement**

In `src/html.js`, replace the current `exchangeDetailHTML` (lines 712-724):

```js
export function exchangeDetailHTML(name, data, addresses) {
  const totals = data.reduce(
    (acc, d) => ({ inflow: acc.inflow + d.inflow, outflow: acc.outflow + d.outflow }),
    { inflow: 0, outflow: 0 },
  );
  return `<div class="card-head">
    <div class="card-title">${esc(name)} <span class="count-badge">${data.length} active day${data.length === 1 ? "" : "s"}</span></div>
    <span class="total-txt">In: <strong>${xem(totals.inflow)} XEM</strong> &middot; Out: <strong>${xem(totals.outflow)} XEM</strong></span>
  </div>
  <div style="padding:16px;">${exchangeFlowChartHTML(data)}</div>
  <div class="card-head"><div class="card-title">Tracked Addresses</div></div>
  <div style="padding:16px;">${exchangeAddressListHTML(addresses)}</div>`;
}
```

with:

```js
export function exchangeFlowSectionHTML(name, data) {
  const totals = data.reduce(
    (acc, d) => ({ inflow: acc.inflow + d.inflow, outflow: acc.outflow + d.outflow }),
    { inflow: 0, outflow: 0 },
  );
  return `<div class="card-head">
    <div class="card-title">${esc(name)} <span class="count-badge">${data.length} active day${data.length === 1 ? "" : "s"}</span></div>
    <span class="total-txt">In: <strong>${xem(totals.inflow)} XEM</strong> &middot; Out: <strong>${xem(totals.outflow)} XEM</strong></span>
  </div>
  <div style="padding:16px;">${exchangeFlowChartHTML(data)}</div>`;
}

// Empty for 0-1 tracked addresses (nothing to switch to). For 2+, a Total
// tab plus one tab per address, reusing the account-detail page's
// .tab-nav/.tab-btn CSS and hx-get/hx-target/hx-swap pattern — picking a
// tab re-fetches just #exchange-flow-section from the new
// /api/exchange/:name/flows route, so the totals line and chart change
// together.
export function exchangeAddressTabsHTML(name, addresses) {
  if (addresses.length <= 1) return "";
  const encodedName = encodeURIComponent(name);
  const totalBtn = `<button class="tab-btn active" hx-get="/api/exchange/${encodedName}/flows" hx-target="#exchange-flow-section" hx-swap="innerHTML" onclick="setExchangeTab(this)">Total</button>`;
  const addrBtns = addresses
    .map((a) => {
      const title = a.label ? `${a.address} — ${a.label}` : a.address;
      return `<button class="tab-btn" hx-get="/api/exchange/${encodedName}/flows?address=${encodeURIComponent(a.address)}" hx-target="#exchange-flow-section" hx-swap="innerHTML" onclick="setExchangeTab(this)" title="${esc(title)}">${truncKey(a.address)}</button>`;
    })
    .join("");
  return `<div class="tab-nav">${totalBtn}${addrBtns}</div>`;
}

export function exchangeDetailHTML(name, data, addresses) {
  return `${exchangeAddressTabsHTML(name, addresses)}
  <div id="exchange-flow-section">${exchangeFlowSectionHTML(name, data)}</div>
  <div class="card-head"><div class="card-title">Tracked Addresses</div></div>
  <div style="padding:16px;">${exchangeAddressListHTML(addresses)}</div>
  <script>
    function setExchangeTab(el) {
      el.closest('.tab-nav').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
    }
  </script>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/html.test.js`
Expected: PASS (all tests, including the pre-existing `exchangeDetailHTML` tests — `"includes the chart and the exchange name"`, `"labels the count badge as active days"`, `"links each tracked address to its account page"`, `"shows a message when no addresses are tracked yet"` — none of them assert the tab row's absence, so the now-added tabs for the 2-address fixture don't break them).

---

### Task 3: `GET /api/exchange/:name/flows` route in `index.js`

**Files:**
- Modify: `index.js:61-64` (add `getExchangeDailyFlowsForAddress` to the `./src/db.js` import block), `index.js:89-91` (add `exchangeFlowSectionHTML` to the `./src/html.js` import block), `index.js:1060-1078` (add the new route right after the existing `/api/exchange/:name` route)

**Interfaces:**
- Consumes: `getExchangeAddresses()` (existing), `getExchangeDailyFlows(name, days)` (existing), `getExchangeDailyFlowsForAddress(address, days)` (Task 1), `exchangeFlowSectionHTML(name, data)` (Task 2), `exchangeNotFoundHTML(name)` (existing), `errorFrag(msg, retryUrl, retryTarget)` (existing), `unavailableOnTestnetHTML(label)` (existing, already used by the neighboring route).
- Produces: `GET /api/exchange/:name/flows` — an HTML fragment response consumed by the `hx-get`/`hx-target="#exchange-flow-section"` buttons rendered in Task 2's `exchangeAddressTabsHTML`. No other task depends on this route directly.

- [ ] **Step 1: Add the imports**

In `index.js`, in the `./src/db.js` import block (lines 61-64):

```js
  getExchangeList,
  getExchangeDailyFlows,
  getExchangeDailyFlowsForAddress,
  getExchangeAddresses,
} from "./src/db.js";
```

In the `./src/html.js` import block, right after `exchangeDetailHTML` (lines 89-91):

```js
  exchangeOverviewHTML,
  exchangeDetailHTML,
  exchangeFlowSectionHTML,
  exchangeNotFoundHTML,
```

- [ ] **Step 2: Add the route**

In `index.js`, right after the existing `/api/exchange/:name` route (ends at line 1078):

```js
app.get("/api/exchange/:name/flows", (req, res) => {
  const name = req.params.name;
  const address = req.query.address;
  res.setHeader("Content-Type", "text/html");
  if (currentNetwork() === "testnet") {
    return res.send(unavailableOnTestnetHTML("Exchanges"));
  }
  try {
    const addresses = getExchangeAddresses().filter((a) => a.exchange_name === name);
    if (!addresses.length || (address && !addresses.some((a) => a.address === address))) {
      return res.send(exchangeNotFoundHTML(name));
    }
    const data = address
      ? getExchangeDailyFlowsForAddress(address, 30)
      : getExchangeDailyFlows(name, 30);
    res.send(exchangeFlowSectionHTML(name, data));
  } catch (err) {
    res
      .status(503)
      .send(
        errorFrag(
          err.message,
          `/api/exchange/${encodeURIComponent(name)}/flows${address ? `?address=${encodeURIComponent(address)}` : ""}`,
          "#exchange-flow-section",
        ),
      );
  }
});
```

- [ ] **Step 3: Run the full test suite to confirm nothing broke**

Run: `node --test`
Expected: PASS — this task adds no new automated tests (no route-level test harness exists in this repo), but must not regress `test/db.test.js`, `test/html.test.js`, or any other suite.

- [ ] **Step 4: Manual verification**

Start the server (mainnet) and confirm end-to-end:

1. Find an exchange with 2+ tracked addresses: open `/exchanges`, pick one whose card shows "2 addresses" (or more) — e.g. Zaif or Poloniex, per `MANUAL_EXCHANGE_ADDRESSES` in `src/constants.js`, if a richlist-derived address has also been synced for the same name.
2. Open `/exchange/<that name>`. Confirm a tab row ("Total" + one tab per address, address text truncated like `NBAAWBHK…HL2JL`) appears above the chart.
3. Click an address tab. Confirm both the "In: … · Out: …" totals line and the bar chart change to that address's data, and the clicked tab becomes visually active (underlined).
4. Click "Total". Confirm it reverts to the combined view.
5. Open `/exchange/<name with only 1 tracked address>` (if one exists). Confirm no tab row is rendered.

---

## Self-Review Notes

- **Spec coverage:** Default = combined total (Task 2, `exchangeDetailHTML` renders `exchangeFlowSectionHTML(name, data)` with the unfiltered `data` on first load) ✓. Tab switcher for 2+ addresses (Task 2 `exchangeAddressTabsHTML`, Task 3 route) ✓. No switcher for exactly 1 address (Task 2 `addresses.length <= 1` guard, tested) ✓. Totals + chart update together (both live inside `exchangeFlowSectionHTML`, swapped as one `hx-target`) ✓. No cross-address overlay, no day-range switcher, no `/exchanges` changes — none added ✓.
- **Placeholder scan:** no TBD/TODO; every step has complete, runnable code.
- **Type/name consistency:** `exchangeFlowSectionHTML(name, data)` and `exchangeAddressTabsHTML(name, addresses)` are named and called identically across Tasks 2 and 3; `getExchangeDailyFlowsForAddress(address, days)` signature matches between Task 1's definition and Task 3's call site.
