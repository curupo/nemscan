# Testnet support (mainnet/testnet switcher)

## Problem

NEMSCAN only ever talks to NEM (NIS1) **mainnet**: the node pool (`src/nodePool.js`), the address-derivation network byte (`src/helpers.js`), and the SQLite cache (`src/db.js`, `cache.db`) all hard-assume mainnet. There's no way for a visitor to browse the NEM testnet.

## Goals

1. Add a **mainnet/testnet switcher** dropdown to the top-right navbar, next to the existing node-switch and theme-switch controls.
2. Per-visitor selection via a cookie (`nemscan-network`), mirroring the existing `nemscan-node` cookie mechanism — no server restart or separate deployment needed to serve both networks.
3. testnet gets its own SQLite DB file, its own dynamic node pool (sourced from `nodewatch.symbol.tools`'s testnet endpoint), and correct address derivation (testnet network byte).
4. testnet's background cache warmers (namespaces, mosaics, node pool, daily tx stats) run continuously alongside mainnet's, regardless of whether anyone is currently viewing testnet.
5. Features backed by mainnet-only external data sources (XEM price, nemtool.com archives, nemnodes.org rich list) are simply not invoked under a testnet context and show a "not available on testnet" state instead of misleading/borrowed mainnet data.

## Non-goals

- No data sharing/merging between mainnet and testnet.
- No support for more than these two networks.
- No alternative data source investigation for testnet price/archive/rich-list — those features are just unavailable on testnet.
- No change to mainnet's default behavior when no `nemscan-network` cookie is present (defaults to mainnet, identical to today).

## Architecture: network propagation

Mirrors the existing `nodeContext` (`AsyncLocalStorage`) pattern used for the per-request node-switch cookie.

```
src/context.js
  export const networkContext = new AsyncLocalStorage(); // "mainnet" | "testnet"
  export function currentNetwork() {
    return networkContext.getStore() || "mainnet";
  }
```

- **Per-request**: `index.js`'s existing cookie-reading middleware is extended to also read `nemscan-network`, then wraps the request in `networkContext.run(network, () => nodeContext.run(node, () => next()))`. The node-switch cookie lookup (`findNodeOption`) becomes network-aware (see below), so a mainnet-selected preferred node simply won't match while browsing testnet and falls through to the default shuffled pool — no explicit cleanup needed when switching networks.
- **Per-tick background jobs** (`setInterval`-based refreshers): each tick calls `networkContext.run(network, fn)` fresh, once per network. Since this is a brand-new `.run()` invocation from `index.js`'s top-level `setInterval` callback (not nested inside a previous request or timer's context), this does not depend on `AsyncLocalStorage` surviving indefinitely across chained timers — it's simply re-entered every tick.
- **Self-rescheduling job** (`scheduleDailyTxStatsRefresh`, which re-invokes itself via `setTimeout` from inside `cache.js` rather than being restarted fresh by `index.js` each time): this is the one place where relying on `AsyncLocalStorage` to persist across a long recursive timer chain would be fragile. Instead, `network` is threaded as an **explicit parameter** here only: `scheduleDailyTxStatsRefresh(network)` → `refreshDailyTxStats(network)`, which wraps its body in `networkContext.run(network, async () => { ... })` so its internal calls (`getHeight`, `fetchBlockRaw`/`nemFetch`, db accessors) still resolve the right network without changing their own signatures, and passes `network` explicitly to its own recursive `setTimeout` call.

All other modules (`nemApi.js`, `cache.js`'s other refreshers, `db.js`, `html.js`) read `currentNetwork()` internally and keep their existing exported function signatures — call sites in `index.js`/`cache.js`/`html.js` need no parameter changes for these.

## `src/constants.js`

```js
export const NEM_NODES_FALLBACK = [ /* existing 3 kasanetalk.net hosts, unchanged */ ];

// Verified reachable over HTTPS (2026-08-09).
export const NEM_TESTNET_NODES_FALLBACK = [
  "https://ntn1.dusanjp.com:7891",
  "https://ntn2.dusanjp.com:7891",
];

export const NETWORKS = {
  mainnet: {
    label: "Mainnet",
    nodeSourceApi: "https://nodewatch.symbol.tools/api/nem/nodes",
    fallbackNodes: NEM_NODES_FALLBACK,
    addressNetworkByte: 0x68,
    dbFile: "./cache.db",
  },
  testnet: {
    label: "Testnet",
    nodeSourceApi: "https://nodewatch.symbol.tools/testnet/api/nem/nodes",
    fallbackNodes: NEM_TESTNET_NODES_FALLBACK,
    addressNetworkByte: 0x98,
    dbFile: "./cache-testnet.db",
  },
};
export const DEFAULT_NETWORK = "mainnet";
```

Verified 2026-08-09: `https://nodewatch.symbol.tools/testnet/api/nem/nodes` returns the same shape (`endpoint`, `name`, top-level array) as the mainnet endpoint, so `nodePool.js`'s parsing/probing logic needs no format-specific changes.

## `src/nodePool.js`

Module state becomes keyed by network instead of flat module-level bindings:

```js
const state = {
  mainnet: { httpsNodeOptions: [], httpsNodeOptionsUpdatedAt: null, refreshing: false },
  testnet: { httpsNodeOptions: [], httpsNodeOptionsUpdatedAt: null, refreshing: false },
};

export function getHttpsNodeOptions(network = currentNetwork()) {
  return state[network].httpsNodeOptions;
}
export function getHttpsNodeOptionsUpdatedAt(network = currentNetwork()) {
  return state[network].httpsNodeOptionsUpdatedAt;
}
export async function refreshHttpsNodeOptions(network, batchSize = 12) { /* uses NETWORKS[network].nodeSourceApi, writes into state[network] */ }
export function findNodeOption(endpoint, network = currentNetwork()) {
  return state[network].httpsNodeOptions.find((n) => n.endpoint === endpoint) || null;
}
export function getShuffledNodePool(network = currentNetwork()) {
  const nodes = state[network].httpsNodeOptions;
  const base = nodes.length > 0 ? nodes.map((n) => n.endpoint) : NETWORKS[network].fallbackNodes;
  return shuffle([...base]);
}
```

`probeHttpsNode` and the private-hostname filter are unchanged (network-agnostic). Call sites that previously imported the live bindings `httpsNodeOptions`/`httpsNodeOptionsUpdatedAt` directly (`index.js`'s `/api/nodes` handler, `html.js`'s `nodeSwitchHTML()`) switch to calling `getHttpsNodeOptions()`/`getHttpsNodeOptionsUpdatedAt()` (no-arg form resolves from request context).

## `src/nemApi.js`

No signature changes. `nemFetch()` already calls `getShuffledNodePool()` with no arguments — that now resolves the current network via context automatically.

## `src/db.js`

Refactored into a factory so the schema/prepared-statements block runs once per network:

```js
function openDbLayer(file) {
  const db = new DatabaseSync(file);
  // ... existing PRAGMA + CREATE TABLE + prepared statements, unchanged ...
  return { db, getCachedNamespaces, getCachedNamespacesCount, /* ...all existing accessors... */ };
}

const layers = {
  mainnet: openDbLayer(NETWORKS.mainnet.dbFile),
  testnet: openDbLayer(NETWORKS.testnet.dbFile),
};
function layer() { return layers[currentNetwork()]; }

export function getCachedNamespaces(limit, offset) { return layer().getCachedNamespaces(limit, offset); }
// ... one thin wrapper per existing exported function, same name/signature ...
export function getDb() { return layer().db; } // replaces the raw `db` export
```

Every exported function keeps its exact name and signature — `cache.js`, `html.js`, `index.js` need no changes beyond the two spots in `cache.js` that reach into the raw `db` export directly (`db.prepare(...)` in `refreshAllMosaicsDeep` and `importMosaicArchive`), which switch to `getDb().prepare(...)`.

Both DB files get the identical schema (`CREATE TABLE IF NOT EXISTS` is harmless either way) — testnet's `namespaces_archive`, `mosaics_archive`, `polls`, and `richlist` tables simply stay empty since nothing ever writes to them under a testnet context (see feature-availability section below), and the existing `..._with_archive` combined queries degrade gracefully (an empty archive table just contributes nothing to the `UNION`).

## `src/cache.js`

Module-level mutable state (`liveRichList`, `liveRichListUpdatedAt`, the various `_refreshingX` guard flags, `_subNamespacesCache`) becomes per-network-keyed (e.g. `const _refreshingNamespaces = { mainnet: false, testnet: false }`), read/written via `currentNetwork()`. This matters because both networks' identical-interval jobs can be in-flight at overlapping times — a single shared boolean flag would incorrectly let one network's refresh block the other's.

`liveRichList`/`liveRichListUpdatedAt` (previously exported as live bindings, imported directly in `index.js`) become getter functions `getLiveRichList()`/`getLiveRichListUpdatedAt()`.

**Never invoked under a testnet context** (their data sources have no testnet equivalent — see table below): `importNamespaceArchive`, `importMosaicArchive`, `importPollArchive`, `refreshRichListCache`, `refreshLiveRichList`, `refreshPriceCache`. This is enforced simply by `index.js`'s background scheduler not calling them for `network === "testnet"` — no internal branching needed inside `cache.js` itself.

`scheduleDailyTxStatsRefresh(network)` / `refreshDailyTxStats(network)` / `scanBlockHeightsForDailyTx` take an explicit `network` parameter as described in the Architecture section above.

## `src/helpers.js`

`pubKeyToAddress(hex, net)` is unchanged (already takes a network byte parameter, default `0x68`). Call sites in `html.js` now resolve the byte from `NETWORKS[currentNetwork()].addressNetworkByte` instead of relying on the default.

## `src/html.js`

- New small helper (module-local) wrapping `pubKeyToAddress`, e.g. `addrFromPubKey(hex)`, resolving the network byte from `currentNetwork()`. Replaces the ~10 existing raw `pubKeyToAddress(...)` call sites.
- `nodeSwitchHTML()`: switches its two `httpsNodeOptions`/`httpsNodeOptionsUpdatedAt` references to `getHttpsNodeOptions()`/`getHttpsNodeOptionsUpdatedAt()`.
- New `networkSwitchHTML()`, following the exact structural pattern of `nodeSwitchHTML()`/the theme switch (button + dropdown menu, `Mainnet`/`Testnet` items, active item highlighted via `currentNetwork()`), added into `navToolsHTML()` alongside the node-switch and theme-switch controls.
- New client-side `window.selectNetwork(net)` (mirrors `window.selectNode`): sets the `nemscan-network` cookie (`max-age=2592000`) and always navigates to `/` (not `location.reload()`) — a block height, tx hash, or address on the current page is very likely meaningless on the other network.
- Small **testnet badge**: when `currentNetwork() === "testnet"`, a compact colored label rendered next to the network-switch button (e.g. `TESTNET` in an accent color), so it's visually obvious which network is active — the same convention explorers like Etherscan use for their testnets. No broader theme/layout changes.
- `xemPriceHTML()`: unchanged. It already returns `""` when `getCacheMeta("xem_price")` is null — since `refreshPriceCache` is never called under testnet, that DB layer's `cache_meta` simply never gets the key, so this resolves to hidden automatically with no explicit network check.
- Accounts (rich list) and Polls pages: when `currentNetwork() === "testnet"`, the `/api/accounts` and `/api/polls` route handlers (in `index.js`) return a small "not available on testnet" fragment instead of calling into `cache.js`/`db.js` — avoids wasted DB/network calls and avoids serving stale/misleading mainnet-shaped empty states.

## `src/index.js`

- Cookie-reading middleware extended: parse both `nemscan-network` and `nemscan-node` from the same `Cookie` header pass, then `networkContext.run(network, () => nodeContext.run(node, () => next()))`. `node` lookup uses `findNodeOption(endpoint, network)`.
- Background scheduler (the `setTimeout(() => { ... }, 3000)` block): loops over `Object.keys(NETWORKS)` for the network-agnostic jobs (namespaces, mosaics, deep mosaic refresh, node pool refresh, daily tx stats), each call wrapped in `networkContext.run(network, fn)`; the mainnet-only jobs (archive imports, rich list, price) stay as direct unwrapped calls exactly as today (implicitly mainnet since nothing overrides the context here — for clarity, wrap them in `networkContext.run("mainnet", fn)` explicitly too, so the "testnet-only-runs-what's-listed" invariant is visible directly in this block rather than implicit).
- `/api/accounts`, `/api/accounts/more`, `/api/polls`, `/api/polls/more`: early-return the "not available on testnet" fragment when `currentNetwork() === "testnet"`.

## `public/style.css`

Small addition: `.network-switch` control styling (matching `.node-switch`/`.theme-switch`) plus a `.network-badge` (or similar) style for the testnet indicator — accent color reused from the existing palette, not a new color system.

## Testing

- `test/nodePool.test.js`: update for per-network `state`; add a case that `getShuffledNodePool("testnet")` returns testnet fallback/dynamic nodes independently of mainnet's.
- `test/cache.test.js`: update any tests touching the now-per-network guard flags / `liveRichList` getters.
- New: a small `test/db.test.js`-style check (or extend an existing suite) confirming mainnet and testnet DB layers are independent — writing to one doesn't appear in the other.
- Manual:
  - Switch the navbar dropdown to Testnet, confirm the `nemscan-network` cookie is set and the page navigates to `/`.
  - Confirm testnet account addresses render starting with `T` (vs `N` on mainnet).
  - Confirm XEM price, namespace/mosaic archive counts, rich list (`/accounts`), and polls (`/polls`) show the "not available on testnet" state.
  - Confirm blocks/transactions/accounts/namespaces/mosaics/nodes pages work normally on testnet with independently-fresh data.
  - Confirm switching back to Mainnet restores prior mainnet behavior unchanged, and that mainnet data was never affected by testnet browsing.
  - Cold start: delete `cache-testnet.db*` and restart, confirm testnet tables/import behave like a fresh mainnet cold start (schema created, background warmers populate it) without needing to touch `cache.db`.

## Feature availability on testnet

| Feature | testnet behavior |
|---|---|
| Blocks / transactions / block & tx detail | Full support (independent live NIS queries) |
| Account overview / txs / harvests / mosaics / namespaces | Full support |
| Namespaces / Mosaics live list | Full support (own DB, no archive merge since archive stays empty) |
| Nodes list | Full support (own dynamic pool from `nodewatch.symbol.tools/testnet/...`) |
| Daily tx/day chart (home page) | Full support (own DB table) |
| XEM price ticker | Hidden (CoinGecko has no testnet XEM market) |
| Namespace/Mosaic historical archive | Not imported (nemtool.com has no testnet archive) |
| Polls | Not available (nemtool.com polls are a mainnet-only, off-chain feature) |
| Rich list / Accounts page | Not available (nemnodes.org candidate-address source is mainnet-only) |
