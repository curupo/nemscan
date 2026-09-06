# Tx Detail Payload Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/tx/:hash` render the real payload for every NIS1 transaction type — including a transaction wrapped in a multisig (type 4100) — instead of showing blank Recipient/Amount/Message rows for anything that isn't a plain type-257 transfer.

**Architecture:** A new `typeSpecificRows(tx)` function in `src/html.js` returns `[label, valueHtml]` pairs for one transaction's own payload, dispatched on `tx.type`. `txDetailHTML` unwraps a type-4100 wrapper's `otherTrans` and calls `typeSpecificRows` on the unwrapped transaction, so the same dispatch logic handles both a bare transaction and one wrapped in multisig, with no special-casing for what's inside the wrapper.

**Tech Stack:** Node.js (ESM), `node:test` + `node:assert/strict`, better-sqlite3 (via `src/db.js`), no new dependencies.

## Global Constraints

- **Never run any git command.** The user runs git themselves in this repo — no `git add`, `git commit`, or any other git invocation in any task below, even though the writing-plans template normally ends each task with a commit step. Every task below ends at "run tests, confirm pass" instead.
- Design doc: `docs/superpowers/specs/2026-09-06-tx-detail-payload-design.md` — read it if anything below is ambiguous; this plan implements it as-is except one field-path correction found while planning (see Task 3, Importance Transfer: the design doc says `tx.importanceTransfer.mode`/`tx.importanceTransfer.remoteAccount`, but NIS1's raw `ImportanceTransferTransaction` JSON has `mode` and `remoteAccount` as flat top-level fields, not nested under an `importanceTransfer` object — this plan uses the flat, correct field names).
- Test file: all new tests go in `test/html.test.js`, following its existing conventions exactly — `node:test`'s `test()`, `assert.match`/`assert.doesNotMatch`/`assert.equal`, `networkContext.run("mainnet", () => { ... })` around any assertion that depends on `getMosaicByNsAndName` finding a seeded row, and no wrapper at all when a test relies on the *default* (mainnet) network context to exercise the "mosaic not found" fallback.
- Run tests with: `node --test test/html.test.js`

---

### Task 1: Fix `TX_TYPES` NIS1 type codes

**Files:**
- Modify: `src/constants.js:23-32`
- Test: `test/html.test.js`

**Interfaces:**
- Produces: `TX_TYPES` (already exported, unchanged export name/shape — a `{ [typeCode: number]: string }` object) now has correct keys `4098` and `4100`, and no longer has a `4099` key. Every later task that reads `TX_TYPES[tx.type]` (unchanged call sites elsewhere in `html.js`) gets the corrected labels automatically.

- [ ] **Step 1: Write the failing test**

Add to `test/html.test.js` (anywhere among the other top-level `test(...)` calls — e.g. right after the existing `navHTML`/`heroMosaicTransfers` tests around line 170):

```js
test("TX_TYPES has the real NIS1 multisig codes, not the swapped/bogus ones", async () => {
  const { TX_TYPES } = await import("../src/constants.js");
  assert.equal(TX_TYPES[4098], "Multisig Signature");
  assert.equal(TX_TYPES[4100], "Multisig");
  assert.equal(TX_TYPES[4099], undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/html.test.js`
Expected: FAIL — `TX_TYPES[4098]` is `undefined` (not `"Multisig Signature"`), and `TX_TYPES[4100]` is `"Multisig Sig"` (not `"Multisig"`).

- [ ] **Step 3: Fix the constant**

In `src/constants.js`, replace:

```js
export const TX_TYPES = {
  257: "Transfer",
  2049: "Importance",
  4097: "Multisig Mod",
  4100: "Multisig Sig",
  4099: "Multisig",
  8193: "Namespace",
  16385: "Mosaic Def",
  16386: "Mosaic Supply",
};
```

with:

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

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/html.test.js`
Expected: PASS (all tests, including every pre-existing test that reads `TX_TYPES` — none of them assert on the `4099`/`4100` labels today, so none should break).

---

### Task 2: `typeSpecificRows` — Transfer (plain and mosaic-attached)

**Files:**
- Modify: `src/html.js` (add `getMosaicByNsAndName` to the existing `db.js` import block at the top of the file; add new exported `typeSpecificRows` function directly above `txDetailHTML`, currently at `src/html.js:1240`)
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: `getMosaicByNsAndName(namespace, name)` from `src/db.js` — returns a row object with a `.divisibility` (integer) field, or `undefined` if not found. `xem(v)`, `esc(s)`, `decodeMsg(msg)` from `src/helpers.js` (already imported in `html.js`).
- Produces: `export function typeSpecificRows(tx)` → `Array<[string, string]>`. For `tx.type === 257`: `["Recipient", ...]` always; then either `["Amount", ...]` (no mosaics) or `["Multiplier", ...]` + `["Mosaics", ...]` (mosaics present); then `["Message", ...]` always. For any other type: empty array for now (Task 3 fills in the rest — this task must not throw or produce garbage rows for unhandled types, since `txDetailHTML` isn't wired to call this yet).

- [ ] **Step 1: Write the failing tests**

Add to `test/html.test.js`, near the other type/tx-related tests (e.g. after the `renderUnconfirmedTxRow` tests around line 378).

First, add `typeSpecificRows` to the destructured import list at the top of the file. Change:

```js
  renderUnconfirmedTxRow,
  unconfirmedTxListHTML,
```

to:

```js
  renderUnconfirmedTxRow,
  unconfirmedTxListHTML,
  typeSpecificRows,
```

Then add `upsertMosaic` to the `db.js` import line. Change:

```js
const { upsertMosaicTransfer, upsertTxTypeArchive, upsertExchangeAddress, bumpExchangeDailyFlow } = await import("../src/db.js");
```

to:

```js
const { upsertMosaicTransfer, upsertTxTypeArchive, upsertExchangeAddress, bumpExchangeDailyFlow, upsertMosaic } = await import("../src/db.js");
```

Now add the test cases:

```js
test("typeSpecificRows shows Recipient/Amount/Message for a plain transfer with no mosaics", () => {
  const rows = typeSpecificRows({
    type: 257,
    recipient: "RECIPADDR",
    amount: 5_000_000,
    message: { type: 1, payload: Buffer.from("hi").toString("hex") },
  });
  const byLabel = Object.fromEntries(rows);
  assert.match(byLabel["Recipient"], /href="\/account\/RECIPADDR"/);
  assert.match(byLabel["Amount"], />5\.00 XEM</);
  assert.match(byLabel["Message"], />hi</);
  assert.equal(byLabel["Mosaics"], undefined);
  assert.equal(byLabel["Multiplier"], undefined);
});

test("typeSpecificRows shows Multiplier + Mosaics (divided by divisibility) for a mosaic-attached transfer", () => {
  networkContext.run("mainnet", () => {
    upsertMosaic(1, "dim", "coin", "CREATOR", "", 6, 1000, 1, 1, 1);
    const rows = typeSpecificRows({
      type: 257,
      recipient: "RECIPADDR",
      amount: 2_000_000, // multiplier: 2x
      message: { payload: "" },
      mosaics: [{ mosaicId: { namespaceId: "dim", name: "coin" }, quantity: 3_000_000 }],
    });
    const byLabel = Object.fromEntries(rows);
    assert.match(byLabel["Multiplier"], />2\.00</);
    // (3_000_000 * 2_000_000 / 1_000_000) / 10**6 = 6.000000
    assert.match(byLabel["Mosaics"], /dim:<strong>coin<\/strong> × 6\.000000/);
    assert.equal(byLabel["Amount"], undefined);
  });
});

test("typeSpecificRows falls back to raw quantity (divisibility 0) for a mosaic-attached transfer whose mosaic isn't in the local cache", () => {
  const rows = typeSpecificRows({
    type: 257,
    recipient: "RECIPADDR",
    amount: 1_000_000,
    message: { payload: "" },
    mosaics: [{ mosaicId: { namespaceId: "unknown-ns", name: "unknown-mosaic" }, quantity: 42 }],
  });
  const byLabel = Object.fromEntries(rows);
  // (42 * 1_000_000 / 1_000_000) / 10**0 = 42
  assert.match(byLabel["Mosaics"], /unknown-ns:<strong>unknown-mosaic<\/strong> × 42/);
});

test("typeSpecificRows shows the no-message placeholder when a transfer carries no message payload", () => {
  const rows = typeSpecificRows({ type: 257, recipient: "R", amount: 0, message: null });
  const byLabel = Object.fromEntries(rows);
  assert.match(byLabel["Message"], /\(no message\)/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/html.test.js`
Expected: FAIL — `typeSpecificRows is not a function` (not exported yet), and `upsertMosaic` is not in the destructured `db.js` import yet either.

- [ ] **Step 3: Add the `db.js` import and write the function**

In `src/html.js`, change the existing `db.js` import block:

```js
import {
  getCacheMeta,
  getArchivedNamespacesCount,
  getArchivedMosaicsCount,
  getDailyTxCounts,
  getNamespacesWithArchiveCount,
  getMosaicsWithArchiveCount,
  getMosaicTransfersCount,
  getTxTypeArchiveCount,
  getExchangeDailyFlows,
} from "./db.js";
```

to:

```js
import {
  getCacheMeta,
  getArchivedNamespacesCount,
  getArchivedMosaicsCount,
  getDailyTxCounts,
  getNamespacesWithArchiveCount,
  getMosaicsWithArchiveCount,
  getMosaicTransfersCount,
  getTxTypeArchiveCount,
  getExchangeDailyFlows,
  getMosaicByNsAndName,
} from "./db.js";
```

Then, directly above `export function txDetailHTML(tx, hash, height) {` (`src/html.js:1240`), add:

```js
// Returns [label, valueHtml] rows for one transaction's own type-specific
// payload. Takes an already-unwrapped transaction — a multisig (4100)
// wrapper's otherTrans, or any bare transaction — so the caller decides
// what "the transaction" means; this function only ever looks at tx.type.
export function typeSpecificRows(tx) {
  if (tx.type === 257) {
    const rows = [
      [
        "Recipient",
        `<a href="/account/${tx.recipient}" class="mono-link" title="${tx.recipient}">${tx.recipient}</a> <button class="copy-btn" onclick="copy('${tx.recipient}')">copy</button>`,
      ],
    ];
    if (tx.mosaics?.length) {
      rows.push(["Multiplier", `<span class="mono">${xem(tx.amount)}</span>`]);
      const mosaicLines = tx.mosaics.map((att) => {
        const ns = att.mosaicId.namespaceId;
        const name = att.mosaicId.name;
        const def = getMosaicByNsAndName(ns, name);
        const divisibility = def?.divisibility ?? 0;
        const qty = ((att.quantity * tx.amount) / 1_000_000 / Math.pow(10, divisibility)).toLocaleString(
          "en",
          { minimumFractionDigits: divisibility, maximumFractionDigits: divisibility },
        );
        return `${esc(ns)}:<strong>${esc(name)}</strong> × ${qty}`;
      });
      rows.push(["Mosaics", mosaicLines.join("<br>")]);
    } else {
      rows.push(["Amount", `<span class="mono">${xem(tx.amount)} XEM</span>`]);
    }
    const msg = decodeMsg(tx.message);
    rows.push([
      "Message",
      msg
        ? `<span class="msg-text" style="white-space:normal; max-width:none;">${msg}</span>`
        : '<span class="muted">(no message)</span>',
    ]);
    return rows;
  }

  return [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/html.test.js`
Expected: PASS.

---

### Task 3: `typeSpecificRows` — Importance Transfer, Aggregate Modification, Provision Namespace, Mosaic Definition, Mosaic Supply Change

**Files:**
- Modify: `src/html.js` (extend `typeSpecificRows`, added in Task 2)
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: same as Task 2, plus `addrFromPubKey(hex)` and `truncKey(k)` from `src/helpers.js` (already imported in `html.js`).
- Produces: `typeSpecificRows` now also handles `tx.type` values `2049`, `4097`, `8193`, `16385`, `16386`. Return shape unchanged (`Array<[string, string]>`). Any other type still returns `[]`.

- [ ] **Step 1: Write the failing tests**

Add to `test/html.test.js`:

```js
test("typeSpecificRows shows Mode and Remote Account for an importance transfer", () => {
  const rows = typeSpecificRows({
    type: 2049,
    mode: 1,
    remoteAccount: "a".repeat(64),
  });
  const byLabel = Object.fromEntries(rows);
  assert.equal(byLabel["Mode"], "Activate");
  assert.match(byLabel["Remote Account"], /href="\/account\//);
});

test("typeSpecificRows labels mode 2 as Deactivate", () => {
  const rows = typeSpecificRows({ type: 2049, mode: 2, remoteAccount: "a".repeat(64) });
  assert.equal(Object.fromEntries(rows)["Mode"], "Deactivate");
});

test("typeSpecificRows lists added and removed cosignatories for an aggregate modification, with a sign per entry", () => {
  const rows = typeSpecificRows({
    type: 4097,
    modifications: [
      { modificationType: 1, cosignatoryAccount: "a".repeat(64) },
      { modificationType: 2, cosignatoryAccount: "b".repeat(64) },
    ],
  });
  const byLabel = Object.fromEntries(rows);
  assert.match(byLabel["Modifications"], /^\+ <a/);
  assert.match(byLabel["Modifications"], /−.*<a/);
  assert.equal(byLabel["Min Cosignatories Change"], undefined);
});

test("typeSpecificRows shows a signed Min Cosignatories Change when minCosignatories is present", () => {
  const rows = typeSpecificRows({
    type: 4097,
    modifications: [],
    minCosignatories: { relativeChange: -1 },
  });
  assert.equal(Object.fromEntries(rows)["Min Cosignatories Change"], "-1");
});

test("typeSpecificRows shows the namespace (parent.newPart), rental fee, and sink for a provision namespace tx", () => {
  const rows = typeSpecificRows({
    type: 8193,
    parent: "dim",
    newPart: "coin",
    rentalFee: 5_000_000,
    rentalFeeSink: "SINKADDR",
  });
  const byLabel = Object.fromEntries(rows);
  assert.match(byLabel["Namespace"], />dim\.coin</);
  assert.match(byLabel["Rental Fee"], />5\.00 XEM</);
  assert.match(byLabel["Rental Fee Sink"], /href="\/account\/SINKADDR"/);
});

test("typeSpecificRows shows a root namespace (no parent) without a leading dot", () => {
  const rows = typeSpecificRows({
    type: 8193,
    parent: null,
    newPart: "dim",
    rentalFee: 500_000_000,
    rentalFeeSink: "SINKADDR",
  });
  assert.match(Object.fromEntries(rows)["Namespace"], />dim</);
});

test("typeSpecificRows shows mosaic id, description, and properties for a mosaic definition creation", () => {
  const rows = typeSpecificRows({
    type: 16385,
    creationFee: 5_000_000,
    mosaicDefinition: {
      id: { namespaceId: "dim", name: "coin" },
      description: "test mosaic",
      properties: [
        { name: "divisibility", value: "6" },
        { name: "initialSupply", value: "1000" },
        { name: "supplyMutable", value: "true" },
        { name: "transferable", value: "false" },
      ],
    },
  });
  const byLabel = Object.fromEntries(rows);
  assert.match(byLabel["Mosaic"], />dim:coin</);
  assert.equal(byLabel["Description"], "test mosaic");
  assert.equal(byLabel["Divisibility"], "6");
  assert.equal(byLabel["Initial Supply"], "1000");
  assert.equal(byLabel["Supply Mutable"], "Yes");
  assert.equal(byLabel["Transferable"], "No");
  assert.match(byLabel["Creation Fee"], />5\.00 XEM</);
});

test("typeSpecificRows shows an increase and its human-readable delta for a mosaic supply change", () => {
  networkContext.run("mainnet", () => {
    upsertMosaic(1, "dim", "coin", "CREATOR", "", 6, 1000, 1, 1, 1);
    const rows = typeSpecificRows({
      type: 16386,
      mosaicId: { namespaceId: "dim", name: "coin" },
      supplyType: 1,
      delta: 5_000_000,
    });
    const byLabel = Object.fromEntries(rows);
    assert.match(byLabel["Mosaic"], />dim:coin</);
    assert.match(byLabel["Supply Change"], /^\+5000000 \(\+5\.000000\)$/);
  });
});

test("typeSpecificRows shows a decrease without a human-readable delta when the mosaic isn't in the local cache", () => {
  const rows = typeSpecificRows({
    type: 16386,
    mosaicId: { namespaceId: "unknown-ns", name: "unknown-mosaic" },
    supplyType: 2,
    delta: 10,
  });
  assert.equal(Object.fromEntries(rows)["Supply Change"], "−10");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/html.test.js`
Expected: FAIL — all nine new tests fail because `typeSpecificRows` returns `[]` for types `2049`/`4097`/`8193`/`16385`/`16386` (so e.g. `byLabel["Mode"]` is `undefined`, not `"Activate"`).

- [ ] **Step 3: Extend the function**

In `src/html.js`, inside `typeSpecificRows`, replace the final `return [];` with:

```js
  if (tx.type === 2049) {
    const remoteAddr = addrFromPubKey(tx.remoteAccount) ?? tx.remoteAccount;
    return [
      ["Mode", tx.mode === 1 ? "Activate" : "Deactivate"],
      [
        "Remote Account",
        `<a href="/account/${remoteAddr}" class="mono-link" title="${remoteAddr}">${remoteAddr}</a> <button class="copy-btn" onclick="copy('${remoteAddr}')">copy</button>`,
      ],
    ];
  }

  if (tx.type === 4097) {
    const modLines = (tx.modifications || []).map((m) => {
      const addr = addrFromPubKey(m.cosignatoryAccount) ?? m.cosignatoryAccount;
      const sign = m.modificationType === 1 ? "+" : "−";
      return `${sign} <a href="/account/${addr}" class="mono-link" title="${addr}">${truncKey(addr)}</a>`;
    });
    const rows = [
      ["Modifications", modLines.join("<br>") || '<span class="muted">—</span>'],
    ];
    if (tx.minCosignatories) {
      const change = tx.minCosignatories.relativeChange;
      rows.push(["Min Cosignatories Change", change > 0 ? `+${change}` : `${change}`]);
    }
    return rows;
  }

  if (tx.type === 8193) {
    const namespace = tx.parent ? `${tx.parent}.${tx.newPart}` : tx.newPart;
    return [
      ["Namespace", `<span class="mono">${esc(namespace)}</span>`],
      ["Rental Fee", `<span class="mono">${xem(tx.rentalFee)} XEM</span>`],
      [
        "Rental Fee Sink",
        `<a href="/account/${tx.rentalFeeSink}" class="mono-link" title="${tx.rentalFeeSink}">${tx.rentalFeeSink}</a>`,
      ],
    ];
  }

  if (tx.type === 16385) {
    const def = tx.mosaicDefinition;
    const props = Object.fromEntries((def.properties || []).map((p) => [p.name, p.value]));
    return [
      ["Mosaic", `<span class="mono">${esc(def.id.namespaceId)}:${esc(def.id.name)}</span>`],
      ["Description", esc(def.description || "")],
      ["Divisibility", esc(props.divisibility ?? "0")],
      ["Initial Supply", esc(props.initialSupply ?? "0")],
      ["Supply Mutable", props.supplyMutable === "true" ? "Yes" : "No"],
      ["Transferable", props.transferable === "true" ? "Yes" : "No"],
      ["Creation Fee", `<span class="mono">${xem(tx.creationFee)} XEM</span>`],
    ];
  }

  if (tx.type === 16386) {
    const def = getMosaicByNsAndName(tx.mosaicId.namespaceId, tx.mosaicId.name);
    const sign = tx.supplyType === 1 ? "+" : "−";
    let text = `${sign}${tx.delta}`;
    if (def) {
      const human = (tx.delta / Math.pow(10, def.divisibility)).toLocaleString("en", {
        minimumFractionDigits: def.divisibility,
        maximumFractionDigits: def.divisibility,
      });
      text += ` (${sign}${human})`;
    }
    return [
      ["Mosaic", `<span class="mono">${esc(tx.mosaicId.namespaceId)}:${esc(tx.mosaicId.name)}</span>`],
      ["Supply Change", text],
    ];
  }

  return [];
```

(This sits between the closing `}` of the `if (tx.type === 257)` block and the function's final closing `}` — the `if (tx.type === 257) { ... }` block from Task 2 is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/html.test.js`
Expected: PASS.

---

### Task 4: Wire multisig unwrapping + Version/Deadline/Initiated By/Cosigners into `txDetailHTML`

**Files:**
- Modify: `src/html.js:1240-1314` (replace the entire current body of `txDetailHTML`)
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: `typeSpecificRows(tx)` from Tasks 2-3. `addrFromPubKey`, `truncKey`, `nemDate`, `timeAgo`, `truncHash`, `xem` (already imported in `html.js`). `TX_TYPES` (fixed in Task 1).
- Produces: `txDetailHTML(tx, hash, height)` — same exported name and signature as today, called from `index.js:354` (`res.send(txDetailHTML(tx, hash, height));`) with no changes needed there. For `tx.type === 4100` with a present `tx.otherTrans`, the returned HTML now reflects the inner transaction's Sender/Recipient/Amount/etc. and adds `Initiated By` (and `Cosigners`, if `tx.signatures` is non-empty) rows for the outer wrapper.

- [ ] **Step 1: Write the failing tests**

Add `txDetailHTML` to the destructured import list in `test/html.test.js` (it's already exported today, just not imported by the test file yet). Change:

```js
  renderUnconfirmedTxRow,
  unconfirmedTxListHTML,
  typeSpecificRows,
```

to:

```js
  renderUnconfirmedTxRow,
  unconfirmedTxListHTML,
  typeSpecificRows,
  txDetailHTML,
```

Then add `addrFromPubKey` via a **dynamic** import, alongside the other dynamic `db.js` import — never as a static top-of-file `import`, since `helpers.js` imports `constants.js`, which reads `NEMSCAN_DB_DIR` at module-evaluation time; a static import gets hoisted before this file's own `process.env.NEMSCAN_DB_DIR = mkdtempSync(...)` line runs and would silently point every test in this file at the real `cache.db`/`cache-testnet.db` in the repo root instead of the scratch directory. Change:

```js
const { upsertMosaicTransfer, upsertTxTypeArchive, upsertExchangeAddress, bumpExchangeDailyFlow, upsertMosaic } = await import("../src/db.js");
```

to:

```js
const { upsertMosaicTransfer, upsertTxTypeArchive, upsertExchangeAddress, bumpExchangeDailyFlow, upsertMosaic } = await import("../src/db.js");
const { addrFromPubKey } = await import("../src/helpers.js");
```

Now add the test cases:

```js
test("txDetailHTML shows Version and Deadline rows", () => {
  const html = txDetailHTML(
    {
      type: 257,
      version: 0x98000002, // NIS1 mainnet v2 transfer version word; low byte (the version number) is 2
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64),
      recipient: "R",
      amount: 0,
      message: null,
      fee: 100000,
      signature: "sig",
    },
    "hash1",
    12345,
  );
  assert.match(html, /<div class="ov-label">Version<\/div><div class="ov-value"><span class="mono">2<\/span>/);
  assert.match(html, /<div class="ov-label">Deadline<\/div>/);
});

test("txDetailHTML unwraps a multisig (type 4100) wrapper: Sender/Recipient/Amount come from otherTrans, and Initiated By shows the outer signer", () => {
  const html = txDetailHTML(
    {
      type: 4100,
      version: 1,
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64), // the cosigner who submitted the wrapper
      fee: 150000,
      signature: "outersig",
      otherTrans: {
        type: 257,
        signer: "b".repeat(64), // the multisig account
        recipient: "RECIPADDR",
        amount: 7_000_000,
        message: null,
        fee: 0,
      },
    },
    "hash2",
    12346,
  );
  const innerSenderAddr = addrFromPubKey("b".repeat(64));
  const outerSignerAddr = addrFromPubKey("a".repeat(64));
  assert.match(html, new RegExp(`<div class="ov-label">Sender</div><div class="ov-value"><a href="/account/${innerSenderAddr}"`));
  assert.match(html, new RegExp(`<div class="ov-label">Initiated By</div><div class="ov-value"><a href="/account/${outerSignerAddr}"`));
  assert.match(html, /href="\/account\/RECIPADDR"/);
  assert.match(html, />7\.00 XEM</);
});

test("txDetailHTML shows a Cosigners row when the multisig wrapper carries signatures, and omits it when there are none", () => {
  const withSigs = txDetailHTML(
    {
      type: 4100,
      version: 1,
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64),
      fee: 150000,
      signature: "outersig",
      signatures: [{ signer: "c".repeat(64) }],
      otherTrans: { type: 257, signer: "b".repeat(64), recipient: "R", amount: 0, message: null, fee: 0 },
    },
    "hash3",
    12347,
  );
  assert.match(withSigs, /<div class="ov-label">Cosigners<\/div>/);

  const noSigs = txDetailHTML(
    {
      type: 4100,
      version: 1,
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64),
      fee: 150000,
      signature: "outersig",
      otherTrans: { type: 257, signer: "b".repeat(64), recipient: "R", amount: 0, message: null, fee: 0 },
    },
    "hash4",
    12348,
  );
  assert.doesNotMatch(noSigs, /<div class="ov-label">Cosigners<\/div>/);
});

test("txDetailHTML shows a wrapped namespace registration's payload rows instead of blank Recipient/Amount", () => {
  const html = txDetailHTML(
    {
      type: 4100,
      version: 1,
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64),
      fee: 150000,
      signature: "outersig",
      otherTrans: {
        type: 8193,
        signer: "b".repeat(64),
        parent: null,
        newPart: "dim",
        rentalFee: 500_000_000,
        rentalFeeSink: "SINKADDR",
        fee: 0,
      },
    },
    "hash5",
    12349,
  );
  assert.match(html, /<div class="ov-label">Namespace<\/div>/);
  assert.doesNotMatch(html, /<div class="ov-label">Recipient<\/div>/);
});

test("txDetailHTML renders a plain (non-wrapped) transfer exactly as before: no Initiated By/Cosigners rows", () => {
  const html = txDetailHTML(
    {
      type: 257,
      version: 1,
      timeStamp: 100,
      deadline: 200,
      signer: "a".repeat(64),
      recipient: "RECIPADDR",
      amount: 1_000_000,
      message: null,
      fee: 100000,
      signature: "sig",
    },
    "hash6",
    12350,
  );
  assert.doesNotMatch(html, /Initiated By/);
  assert.doesNotMatch(html, /Cosigners/);
  assert.match(html, /href="\/account\/RECIPADDR"/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/html.test.js`
Expected: FAIL — no `Version`/`Deadline`/`Initiated By`/`Cosigners` rows exist yet, and the multisig-wrapped tests see blank Recipient/Amount (today's `isT = tx.type === 257` gate is `false` for type 4100).

- [ ] **Step 3: Rewrite `txDetailHTML`**

In `src/html.js`, replace the entire current function (`src/html.js:1240-1314`):

```js
export function txDetailHTML(tx, hash, height) {
  const date = nemDate(tx.timeStamp);
  const isWrapped = tx.type === 4100 && !!tx.otherTrans;
  const inner = isWrapped ? tx.otherTrans : tx;
  const senderAddr = addrFromPubKey(inner.signer) ?? inner.signer;

  const rows = [
    [
      "Transaction Hash",
      `<span class="mono-muted">${hash}</span> <button class="copy-btn" onclick="copy('${hash}')">copy</button>`,
    ],
    ["Status", `<span class="status-ok">✓ Confirmed</span>`],
    [
      "Block",
      height
        ? `<a href="/block/${height}" class="mono-link">${height}</a>`
        : '<span class="muted">—</span>',
    ],
    [
      "Timestamp",
      `${timeAgo(date)} <span class="muted">(${date.toISOString().slice(0, 19).replace("T", " ")} UTC)</span>`,
    ],
    [
      "Type",
      `<span class="type-pill ${tx.type === 257 ? "type-transfer" : "type-other"}">${TX_TYPES[tx.type] || `Type ${tx.type}`}</span>`,
    ],
    ["Version", `<span class="mono">${tx.version & 0xff}</span>`],
    [
      "Deadline",
      `${nemDate(tx.deadline).toISOString().slice(0, 19).replace("T", " ")} UTC`,
    ],
    [
      "Sender",
      `<a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${senderAddr}</a> <button class="copy-btn" onclick="copy('${senderAddr}')">copy</button>`,
    ],
  ];

  if (isWrapped) {
    const initiatorAddr = addrFromPubKey(tx.signer) ?? tx.signer;
    rows.push([
      "Initiated By",
      `<a href="/account/${initiatorAddr}" class="mono-link" title="${initiatorAddr}">${initiatorAddr}</a> <button class="copy-btn" onclick="copy('${initiatorAddr}')">copy</button>`,
    ]);
    if (tx.signatures?.length) {
      const cosignerLines = tx.signatures.map((s) => {
        const addr = addrFromPubKey(s.signer) ?? s.signer;
        return `<a href="/account/${addr}" class="mono-link" title="${addr}">${truncKey(addr)}</a>`;
      });
      rows.push(["Cosigners", cosignerLines.join("<br>")]);
    }
  }

  rows.push(...typeSpecificRows(inner));

  rows.push(["Fee", `<span class="fee-val">${xem(tx.fee)} XEM</span>`]);
  rows.push([
    "Signature",
    `<span class="mono-muted">${truncHash(tx.signature)}</span> <button class="copy-btn" onclick="copy('${tx.signature}')">copy</button>`,
  ]);

  const rowsHtml = rows
    .map(
      ([l, v]) =>
        `<div class="ov-row"><div class="ov-label">${l}</div><div class="ov-value">${v}</div></div>`,
    )
    .join("");

  return `
  <div class="card-head">
    <div class="card-title">Overview</div>
  </div>
  <div class="ov-list">${rowsHtml}</div>
  <script>
    function copy(text) {
      navigator.clipboard.writeText(text).then(() => {
        document.querySelectorAll('.copy-btn').forEach(b => {
          if (b.getAttribute('onclick')?.includes(text.slice(0,8))) { b.textContent='copied!'; setTimeout(()=>b.textContent='copy',1500); }
        });
      });
    }
  </script>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/html.test.js`
Expected: PASS — all tests, including every pre-existing test in the file (the rewritten function preserves the exact `.ov-row`/`.ov-label`/`.ov-value` markup and the `copy()` script, so nothing depending on those should have broken).

- [ ] **Step 5: Run the full test suite**

Run: `node --test`
Expected: PASS across every test file (`test/*.test.js`), confirming nothing outside `html.test.js` regressed (in particular `test/db.test.js`, since `getMosaicByNsAndName` is now called from a new place).
