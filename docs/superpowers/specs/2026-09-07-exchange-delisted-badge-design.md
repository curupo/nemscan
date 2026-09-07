# Delisted-exchange badge

## Problem

Some exchanges NEMSCAN still tracks XEM flow for no longer list XEM for
trading. There's no visual indicator of this on `/exchanges` or
`/exchange/:name` — a viewer has no way to tell a delisted exchange's flow
numbers apart from an active one's.

## Goal

- A small red "Delisted" badge on the `/exchanges` overview card and the
  `/exchange/:name` detail page heading, for these exchanges: Binance,
  Bittrex, Coincheck, Coinsuper, Cryptopia, Huobi, Kuna, Qryptos, Yobit
  (list supplied by the user; matches the existing `KNOWN_EXCHANGE_NAMES`
  spelling in `src/constants.js`, correcting "Houbi" to "Huobi").
- Overview card: badge sits as a small pill overlapping the card's
  top-right corner.
- Detail page: badge sits inline next to the `<h1>` exchange name (the
  hero has no bounded card to anchor a corner-overlap badge to).

## Non-goals

- No change to what data is tracked/displayed for delisted exchanges —
  flow numbers, charts, and the address-tab toggle all keep working
  exactly as for any other exchange. This is a label only.
- No admin UI to manage the delisted list — same convention as
  `KNOWN_EXCHANGE_NAMES`, a hardcoded array in `constants.js`.

## Architecture

### Data (`src/constants.js`)

```js
export const DELISTED_EXCHANGE_NAMES = [
  "Binance", "Bittrex", "Coincheck", "Coinsuper", "Cryptopia", "Huobi",
  "Kuna", "Qryptos", "Yobit",
];
```

### HTML (`src/html.js`)

- Import `DELISTED_EXCHANGE_NAMES` alongside the file's existing
  `constants.js` import.
- `exchangeOverviewHTML`: inside the per-exchange card template, add
  `DELISTED_EXCHANGE_NAMES.includes(e.exchange_name) ? '<span class="badge-no exchange-delisted-flag">Delisted</span>' : ""`
  right after the opening `<a class="exchange-card" ...>` tag.
- `heroExchange(name)`: add
  `DELISTED_EXCHANGE_NAMES.includes(name) ? ' <span class="badge-no">Delisted</span>' : ""`
  next to the `<h1>`.

Both reuse the existing `.badge-no` class (red pill, already used
elsewhere) for color — no new color logic.

### CSS (`public/style.css`)

- `.exchange-card` gains `position: relative;` (currently has none of its
  children positioned, so this is side-effect-free).
- New `.exchange-delisted-flag { position: absolute; top: -8px; right:
  12px; }` — positioning only; `.badge-no` (already applied alongside it)
  supplies the color/shape.

## Testing

- `test/html.test.js`: `exchangeOverviewHTML` shows the badge for a
  delisted exchange name and omits it for a non-delisted one;
  `heroExchange` shows the badge for a delisted name and omits it
  otherwise.
