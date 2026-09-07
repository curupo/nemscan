# Per-address flow toggle on the exchange detail page

## Problem

`/exchange/:name` always sums daily inflow/outflow across every address
belonging to that exchange (`getExchangeDailyFlows`, `GROUP BY date,
SUM(...)`). There's no way to see a single address's own flow — useful
when an exchange has a hot wallet and a cold wallet with very different
behavior.

## Goal

- Default view stays the current combined total (no behavior change for
  existing links/bookmarks).
- For exchanges with 2+ tracked addresses, a tab switcher lets the viewer
  pick "Total" or any single address, re-rendering both the summary
  numbers and the chart for that selection.
- Exchanges with only one tracked address show no switcher (there is
  nothing to switch to).

## Non-goals

- No cross-address overlay/comparison chart (consistent with the existing
  "no combined/comparison chart across exchanges" non-goal from the
  original exchange-flow-tracking design).
- No day-range switcher; stays fixed at 30 days, same as today.
- No change to `/exchanges` (the overview page) or its per-exchange mini
  sparkline.

## Architecture

### DB (`src/db.js`)

New prepared statement, sibling to `_exFlowByExchangeStmt`:

```sql
SELECT date, inflow, outflow FROM exchange_daily_flows
WHERE address = ?
ORDER BY date DESC
LIMIT ?
```

New layer method + export `getExchangeDailyFlowsForAddress(address, days)`,
returning `{ date, inflow, outflow }[]` ordered ascending (same
`.reverse().map(r => ({ ...r }))` shape as `getExchangeDailyFlows`, since
`(date, address)` is the table's primary key there's exactly one row per
date for a given address — no `GROUP BY`/`SUM` needed).

### Route (`index.js`)

New route: `GET /api/exchange/:name/flows?address=<address>`

- Look up `getExchangeAddresses().filter(a => a.exchange_name === name)`.
- If `req.query.address` is present and is not one of those addresses,
  respond with the same error-fragment treatment `exchangeNotFoundHTML`
  gives an unknown `:name` (bad selection, nothing to render).
- Otherwise call `getExchangeDailyFlowsForAddress(address, 30)` when
  `address` is given, else `getExchangeDailyFlows(name, 30)` (unchanged
  total path).
- Render with the new `exchangeFlowSectionHTML(data)` (see below) — just
  the summary+chart section, not the full card.

Existing `GET /api/exchange/:name` is unchanged apart from what
`exchangeDetailHTML` now renders internally (see below); it remains the
full-card fragment used for the initial `hx-trigger="load"`.

### HTML (`src/html.js`)

- **`exchangeFlowSectionHTML(data)`** — extracted from the current
  `exchangeDetailHTML` body: the `card-head` totals line (`In: X · Out:
  Y`) plus the `exchangeFlowChartHTML(data)` div. Used both for the
  initial full-card render and as the htmx swap target's content, so the
  totals line and chart always change together.
- **`exchangeAddressTabsHTML(name, addresses)`** — returns `""` when
  `addresses.length <= 1`. Otherwise renders `.tab-nav`/`.tab-btn`
  buttons (same classes as the account-detail page's transaction tabs):
  - `Total` button (active by default): `hx-get="/api/exchange/:name/flows"`.
  - One button per address: `hx-get="/api/exchange/:name/flows?address=<address>"`,
    label = `truncKey(address)` (existing helper), `title` = full address
    + label (same convention as `exchangeAddressListHTML`).
  - All buttons: `hx-target="#exchange-flow-section" hx-swap="innerHTML"
    onclick="setExchangeTab(this)"`.
- **`exchangeDetailHTML(name, data, addresses)`** — gains
  `exchangeAddressTabsHTML(name, addresses)` above the flow section, and
  wraps the section in `<div id="exchange-flow-section">${exchangeFlowSectionHTML(data)}</div>`.
  The existing "Tracked Addresses" list below is untouched.
- A small inline `<script>` is added to the fragment (same
  swapped-fragment-executes-inline-script pattern already used by
  `showTxDetail` in the block-detail fragment):

  ```html
  <script>
    function setExchangeTab(el) {
      el.closest('.tab-nav').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
    }
  </script>
  ```

  Named `setExchangeTab` (not `setTab`) because the account page's
  `setTab` is defined inline in `accountShell`'s own script block, not in
  a shared/global scope — no collision, but also no accidental reuse
  across unrelated pages.

No new CSS; `.tab-nav`/`.tab-btn`/`.tab-btn.active` are reused as-is.

## Error handling

- `address` query param not belonging to the exchange named in `:name` →
  same "not found"-style error fragment as an unknown `:name` today.
- Zero-data states (new address just added, still backfilling) fall
  through to `exchangeFlowChartHTML`'s existing "Collecting data…"
  placeholder unchanged.

## Testing

- `test/db.test.js`: `getExchangeDailyFlowsForAddress` returns only the
  rows for the given address (not other addresses sharing the same
  exchange_name), ordered ascending by date.
- `test/html.test.js`:
  - `exchangeFlowSectionHTML` renders the totals line + chart for a given
    dataset.
  - `exchangeAddressTabsHTML` returns `""` for 0 or 1 addresses, and
    renders a Total tab + one tab per address (with correct `hx-get`
    URLs) for 2+.
  - `exchangeDetailHTML` includes the tabs when given 2+ addresses and
    omits them for 1, and wraps the flow section in
    `id="exchange-flow-section"`.
- Manual: open `/exchange/:name` for an exchange with 2+ tracked
  addresses, confirm the tab row appears, and that clicking an address
  tab swaps both the totals line and the chart to that address's data
  (and back via "Total").
