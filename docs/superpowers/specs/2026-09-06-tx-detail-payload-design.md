# Render full transaction payloads on the `/tx/:hash` detail page

## Problem

`txDetailHTML` (`src/html.js:1240`) renders a fixed row set (Hash, Status, Block,
Timestamp, Type, Sender, Recipient, Amount, Fee, Message, Signature) gated by a
single `isT = tx.type === 257` flag. Compared against `nemscan.io` and
`explorer.nemtool.com`'s own transaction detail pages, this drops real data in
three ways:

1. **Multisig wrapper (type 4100) isn't unwrapped.** The real transfer (or
   whatever transaction the multisig account is executing) lives in
   `tx.otherTrans`. `renderUnconfirmedTxRow` (`src/html.js:1592`) already
   unwraps `otherTrans` for the pending-tx list, but the detail page doesn't —
   Recipient/Amount/Message all render as `—` for a multisig-wrapped
   transaction, and "Sender" shows the cosigner who submitted it rather than
   the multisig account that actually sent funds.
2. **Mosaic-attached transfers show nothing about the mosaics.** When `tx.mosaics`
   is present, `tx.amount` is a multiplier applied to each attachment's
   `quantity` (documented at `src/cache.js:702-705`), not a XEM amount — the
   page nonetheless prints it as `"${xem(tx.amount)} XEM"`, and the attached
   mosaics themselves aren't shown at all.
3. **Every non-Transfer type renders no payload.** Importance Transfer (2049),
   Aggregate Modification (4097), Provision Namespace (8193), Mosaic
   Definition (16385), and Mosaic Supply Change (16386) all fall through
   `isT === false`, leaving Recipient/Amount/Message blank with nothing in
   their place.

Separately, `TX_TYPES` (`src/constants.js:23`) has wrong NIS1 type codes:
`4099` doesn't exist as a NIS1 transaction type, and the real codes are
`4098 = Multisig Signature` / `4100 = Multisig` — currently swapped/mislabeled.
The detail page also never shows `tx.version` or `tx.deadline`, both present
on every raw transaction.

## Goal

- `/tx/:hash` shows the real payload for every NIS1 transaction type,
  including a transaction wrapped in a multisig (type 4100), no matter what
  type it wraps.
- Mosaic-attached transfers show each attached mosaic's human-readable
  quantity, not a misleading XEM amount.
- A multisig wrapper additionally shows who actually executed it (the
  multisig account) vs. who submitted it (the initiating cosigner), plus the
  list of cosigners who signed it.
- `TX_TYPES` codes match the real NIS1 spec.

## Non-goals

- No changes to the list-row renderers (`renderTxRow`, `renderGlobalTxRow`,
  `renderTxTypeArchiveRow`, `renderUnconfirmedTxRow`) beyond the `TX_TYPES`
  label fix, which they already consume via the shared constant. Their
  columns stay as-is.
- No Apostille-specific decoding. Apostille transactions are ordinary type-257
  transfers with a convention-based message payload; `TX_LIST_FILTER_TYPES`
  already treats them as a `tx/list` filter name, not a distinct NIS1 type,
  and that's unaffected by this work.
- No mosaic levy display on Mosaic Definition Creation. Levies are optional,
  rarely set in practice, and adding them is a small follow-up if ever
  needed — not blocking this feature.
- No testnet-specific behavior. Mosaic divisibility lookups use whichever
  network's `mosaics`/`mosaics_archive` tables `db.js`'s existing `layer()`
  dispatch resolves to, same as every other per-network accessor in the file.

## Architecture

### `typeSpecificRows(tx)` (`src/html.js`, new function)

Returns an array of `[label, valueHtml]` pairs for exactly one transaction's
own type-specific payload — no knowledge of multisig wrapping. Dispatches on
`tx.type`:

- **257 (Transfer):**
  - `Recipient`: existing address-link markup.
  - If `tx.mosaics?.length`:
    - `Amount` row is replaced with `Multiplier`: `${xem(tx.amount)}`
      (no "XEM" unit — it isn't one).
    - `Mosaics` row: one `<br>`-joined value cell, one line per attachment,
      `namespace:mosaic × qty` where
      `qty = (attachment.quantity * tx.amount / 1_000_000) / 10**divisibility`,
      formatted via `toLocaleString` with `divisibility` fraction digits.
      `divisibility` comes from `getMosaicByNsAndName(namespaceId, name)`
      (already imported into `html.js` elsewhere in the file); falls back to
      `0` (raw integer quantity) when the mosaic isn't in the local cache.
    - Otherwise (no mosaics): `Amount` row unchanged from today
      (`${xem(tx.amount)} XEM`).
  - `Message`: existing `decodeMsg` markup, unchanged.
- **2049 (Importance Transfer):**
  - `Mode`: `tx.importanceTransfer.mode === 1 ? "Activate" : "Deactivate"`.
  - `Remote Account`: `addrFromPubKey(tx.importanceTransfer.remoteAccount)`,
    address-link markup matching the existing Sender/Recipient cells.
- **4097 (Aggregate Modification):**
  - `Modifications`: one line per `tx.modifications` entry, `+` (type 1) or
    `−` (type 2) prefix followed by the address-link for
    `addrFromPubKey(m.cosignatoryAccount)`.
  - `Min Cosignatories Change`: only when `tx.minCosignatories` is present,
    rendered as its signed `relativeChange` (e.g. `+1`).
- **8193 (Provision Namespace):**
  - `Namespace`: `tx.parent ? \`${tx.parent}.${tx.newPart}\` : tx.newPart`.
  - `Rental Fee`: `${xem(tx.rentalFee)} XEM`.
  - `Rental Fee Sink`: address-link markup for `tx.rentalFeeSink`.
- **16385 (Mosaic Definition):**
  - `Mosaic`: `${tx.mosaicDefinition.id.namespaceId}:${tx.mosaicDefinition.id.name}`.
  - `Description`: `tx.mosaicDefinition.description` (escaped).
  - `Divisibility` / `Initial Supply` / `Supply Mutable` / `Transferable`:
    read off `tx.mosaicDefinition.properties` (array of `{name, value}`) by
    matching `name`.
  - `Creation Fee`: `${xem(tx.creationFee)} XEM`.
- **16386 (Mosaic Supply Change):**
  - `Mosaic`: `${tx.mosaicId.namespaceId}:${tx.mosaicId.name}`.
  - `Supply Change`: `+`/`−` (from `tx.supplyType`, 1=increase/2=decrease)
    followed by `tx.delta`; if `getMosaicByNsAndName` resolves a divisibility
    for this mosaic, also shows the human-readable delta in parentheses.
- **Anything else (including 4100 itself, and any future/unknown type):**
  returns `[]` — no type-specific rows, same as today's fallback.

### Multisig unwrapping in `txDetailHTML`

`txDetailHTML` computes:

```js
const isWrapped = tx.type === 4100 && tx.otherTrans;
const inner = isWrapped ? tx.otherTrans : tx;
```

- Common rows (Hash, Status, Block, Timestamp, Version, Deadline, Fee,
  Signature) always come from the outer `tx` — these describe the
  transaction actually recorded on the block, whichever account submitted it.
- `Type` row: label comes from the outer `tx.type` (so a multisig wrapper
  still visibly reads "Multisig"); no change to today's behavior there.
- `Sender` row: `addrFromPubKey(inner.signer)` — the account that effectively
  sent the transaction (the multisig account itself, when wrapped).
- When `isWrapped`, an additional `Initiated By` row is inserted right after
  `Sender`: address-link for `addrFromPubKey(tx.signer)` (the cosigner who
  submitted the wrapper).
- When `isWrapped` and `tx.signatures?.length`: a `Cosigners` row, one
  `<br>`-joined address-link per entry via `addrFromPubKey(s.signer)`.
- Type-specific rows come from `typeSpecificRows(inner)` — so a
  multisig-wrapped transfer shows Recipient/Amount/Mosaics/Message exactly as
  an unwrapped one would, and a multisig-wrapped namespace registration shows
  the Namespace/Rental Fee rows, with no special-casing needed for what's
  inside.

### `TX_TYPES` fix (`src/constants.js`)

```js
export const TX_TYPES = {
  257: "Transfer",
  2049: "Importance",
  4097: "Multisig Mod",
  4098: "Multisig Signature",
  4100: "Multisig",
  8193: "Namespace",
  16385: "Mosaic Def",
  16386: "Mosaic Supply",
};
```

(`4099` removed — not a real NIS1 type; every list-row renderer already
falls back to `Type ${tx.type}` for anything not in this map, so removing the
bogus entry is safe.)

### New generic rows in `txDetailHTML`

- `Version`: `tx.version & 0xFF` (the low byte is the actual version number;
  the network byte lives in the upper bits and isn't shown — `NETWORKS`
  already distinguishes network elsewhere in the app via `currentNetwork()`,
  not by inspecting individual transactions).
- `Deadline`: same `nemDate` + ISO-string formatting `Timestamp` already uses.

## Error handling

- `getMosaicByNsAndName` returning `undefined` (mosaic not in local cache) is
  the expected/common case for less-active mosaics — every quantity
  computation falls back to divisibility `0` rather than throwing or hiding
  the row.
- Any payload field NIS1 guarantees present for a given type
  (`tx.mosaicDefinition`, `tx.modifications`, etc.) is read directly without
  additional guards, consistent with how the file already treats `tx.amount`/
  `tx.recipient` as always-present for type 257.
- `typeSpecificRows` returning `[]` for an unrecognized type keeps
  `txDetailHTML` rendering the common rows only — same graceful-degradation
  behavior as today's `isT === false` branch.

## Testing

- `test/html.test.js`:
  - `typeSpecificRows` for each of the six handled types, using representative
    fixture payloads (plain transfer, mosaic-attached transfer with a mosaic
    present/absent from the local cache, importance transfer, aggregate
    modification with an add and a remove, provision namespace with and
    without a parent, mosaic definition, mosaic supply change increase and
    decrease).
  - `txDetailHTML` with a type-4100 wrapper around a type-257 inner
    transaction: asserts Sender resolves to the inner signer, an `Initiated
    By` row appears with the outer signer, a `Cosigners` row appears when
    `signatures` is present and is absent when it isn't, and Recipient/Amount
    come from the inner transaction.
  - `txDetailHTML` with a type-4100 wrapper around a non-transfer inner type
    (e.g. provision namespace), confirming the wrapped type's rows appear
    instead of Recipient/Amount placeholders.
  - `Version`/`Deadline` rows present and correctly formatted.
- `test/constants` coverage (or extend `helpers.test.js`/`html.test.js` where
  `TX_TYPES` is already exercised): confirms `4098`/`4100` map correctly and
  `4099` is absent.
- Manual: load a known multisig-wrapped transfer and a mosaic-attached
  transfer on `/tx/:hash` against a live node, confirm the new rows render
  and match the transaction's actual on-chain payload.
