# Mix HTTP nodes into the node pool for load balancing

## Problem

`src/nodePool.js`'s dynamic node pool only ever verifies and keeps HTTPS candidates: for every node nodewatch.symbol.tools reports (as `host:7890`, plain HTTP), `refreshHttpsNodeOptions()` derives a same-host HTTPS candidate one port up (`host:7891`) and drops the node entirely if that HTTPS candidate doesn't answer `/chain/height`. NIS1 has no protocol requirement — a node's plain-HTTP REST endpoint is exactly as usable as its HTTPS one — so this discards every reachable node that only speaks HTTP, shrinking the pool nemFetch() load-balances across for no protocol-correctness reason.

There is no browser-side reason for the HTTPS restriction either: all NIS1 node communication happens server-side (`nemFetch()` in `src/nemApi.js`, called from the Node.js process). The browser never talks to a node endpoint directly — the node-switch dropdown only sets a cookie and reloads, and the `/nodes` page's endpoint links are plain `<a target="_blank">` navigations, which browsers don't subject to Mixed Content blocking (that only applies to a page's own automatically-loaded active content: script/fetch/XHR/iframe/etc).

## Goals

1. Verify and admit both HTTPS and HTTP candidates per node into the dynamic pool, each independently health-checked.
2. Keep `getShuffledNodePool()` / `nemFetch()` unchanged — mixing happens by growing the candidate list they already consume uniformly.
3. Surface protocol in the two places nodes are shown to users (`/nodes` list, node-switch dropdown) so an HTTP entry is visually distinguishable, without treating it as an error state.
4. Rename the pool's internal names away from "Https"-specific naming now that it holds both protocols.

## Non-goals

- No weighting/preference of HTTPS over HTTP in the shuffle — full uniform mixing, per user decision.
- No change to `constants.js`'s hardcoded `NEM_NODES_FALLBACK` / `NEM_TESTNET_NODES_FALLBACK` (cold-start safety net stays HTTPS-only; it's a separate, tiny, manually-curated list, not rendered in `/nodes` or the dropdown).
- No change to `nemFetch()`, `getShuffledNodePool()`, retry/429/race logic, or the node-switch cookie/whitelist mechanism (`findNodeOption`) — all already protocol-agnostic since they operate on plain endpoint strings.
- No TLS/security messaging beyond the protocol badge (no interstitial warning, no blocking of HTTP selection).

## Architecture

### Candidate generation & probing (`src/nodePool.js`)

`refreshNodeOptions()` (renamed from `refreshHttpsNodeOptions()`) builds **two** candidates per nodewatch entry instead of one:

```js
for (const n of nodes) {
  const u = new URL(n.endpoint); // http://host:7890
  if (isPrivateHostname(u.hostname)) continue;

  const httpsPort = u.port ? String(Number(u.port) + 1) : "443";
  candidates.push({ name: n.name || u.hostname, host: `${u.hostname}:${httpsPort}`, endpoint: `https://${u.hostname}:${httpsPort}`, protocol: "https" });
  candidates.push({ name: n.name || u.hostname, host: u.host, endpoint: `http://${u.host}`, protocol: "http" });
}
```

Both candidates for a host are probed independently and admitted independently — if only one protocol answers, only that one enters the pool; if both answer, both enter as separate pool entries (same host reachable twice, which is fine — it simply gets proportionally more of the shuffle's traffic share, no different from two distinct healthy hosts).

`probeHttpsNode(host)` is generalized to `probeNode(url)`: takes the full candidate URL instead of a bare host and hardcoding `https://` itself.

```js
export async function probeNode(url, timeoutMs = NODE_PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/chain/height`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const data = await res.json();
    return Number.isFinite(data?.height);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
```

Call site updates from `probeHttpsNode(c.host)` to `probeNode(c.endpoint)`.

### Renames (protocol-neutral naming)

| Current | New |
|---|---|
| `state[network].httpsNodeOptions` | `state[network].nodeOptions` |
| `state[network].httpsNodeOptionsUpdatedAt` | `state[network].nodeOptionsUpdatedAt` |
| `getHttpsNodeOptions()` | `getNodeOptions()` |
| `getHttpsNodeOptionsUpdatedAt()` | `getNodeOptionsUpdatedAt()` |
| `refreshHttpsNodeOptions()` | `refreshNodeOptions()` |
| `probeHttpsNode()` | `probeNode()` |

`findNodeOption()` is unchanged (name was already protocol-neutral). Call sites to update: `index.js`, `src/html.js`, `test/nodePool.test.js`.

### Pool consumption — unchanged

`getShuffledNodePool()` and `nemFetch()` require no code changes: both already operate on `.endpoint` strings without inspecting protocol, so doubling the candidate list and mixing protocols flows through as-is. This is also why there's no separate "weighting" mechanism to build — uniform mixing falls out of the existing Fisher-Yates shuffle over a list that now happens to contain both protocols.

## UI changes

HTTPS stays the unmarked default (no badge); only HTTP entries get a small `HTTP` badge, so the common case stays visually quiet and the exception is what's flagged — not styled as an error/warning color, since an HTTP node here isn't a fault state.

- **`/nodes` list** (`renderNodeRow`, `src/html.js:1790`): badge rendered next to the host text in the endpoint cell when `n.protocol === "http"`.
- **Node-switch dropdown** (`nodeSwitchHTML`, `src/html.js:95`): same badge next to `node-menu-sub` (the host subtext under each entry's name) when `n.protocol === "http"`.
- **CSS** (`public/style.css`): new `.proto-badge` class, styled distinctly from `.network-badge` (which uses `var(--red)` for the TESTNET warning) — a neutral/muted tone since this isn't a warning state.

## Error handling

- Per-candidate probe failure: unchanged behavior, that single candidate (one protocol, one host) is simply excluded from `verified`; the other protocol for the same host is unaffected since they're probed and pushed independently.
- `nodewatch.symbol.tools` unreachable during refresh: unchanged — caught, logged, last-known-good `nodeOptions` retained (see existing `2026-08-09-dynamic-node-list-design.md` Error handling section, still applies as-is).
- No new failure modes introduced — this change only widens what's already a filter-then-admit pipeline.

## Testing

`test/nodePool.test.js`:
- Update all references to renamed functions/state.
- New test: a nodewatch entry whose HTTPS candidate probes healthy but HTTP candidate does not → pool contains exactly one entry, `protocol: "https"`.
- New test (mirror of above): HTTP healthy / HTTPS unhealthy → pool contains exactly one entry, `protocol: "http"`.
- New test: both protocols healthy for the same host → pool contains two entries for that host, one per protocol.

`test/html.test.js`:
- `renderNodeRow` with a `protocol: "http"` node includes the badge markup; with `protocol: "https"` it does not.
- `nodeSwitchHTML` likewise for dropdown items.

Manual:
- Cold start still serves `NEM_NODES_FALLBACK` (HTTPS-only, unaffected by this change) until first refresh completes.
- After a refresh, visit `/nodes` and confirm HTTP-only nodes appear with the badge and their `/node/info` link opens (in a new tab) over plain HTTP without any nemscan-page console warnings.
