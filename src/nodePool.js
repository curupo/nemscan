import { NODE_PROBE_TIMEOUT_MS, NEM_NODES_FALLBACK } from "./constants.js";

// ── Node discovery ────────────────────────────────────────────────────────────

// nodewatch.symbol.tools crawls the NEM network and publishes every node it
// discovers — not only nodes enrolled in any program. NIS1 nodes have no
// protocol-level concept of "supernode" status, so we query this
// third-party directory rather than a NIS node.
const NODE_SOURCE_API = "https://nodewatch.symbol.tools/api/nem/nodes";

export async function getKnownNemNodes() {
  const res = await fetch(NODE_SOURCE_API);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

// ── HTTPS node verification ───────────────────────────────────────────────────

// nodewatch only ever lists each node's plain-HTTP REST endpoint (host:7890);
// it never lists an "https://" entry. By NIS1 convention the same host
// commonly answers HTTPS one port up (host:7891 — exactly how our fallback
// pool in constants.js is configured), so we derive that candidate and probe
// it directly rather than trusting the registry.
export let httpsNodeOptions = [];
export let httpsNodeOptionsUpdatedAt = null;
let _refreshingHttpsNodeOptions = false;

export async function probeHttpsNode(host, timeoutMs = NODE_PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${host}/chain/height`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Number.isFinite(data?.height);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Refreshed on the same 5-minute cadence as the rest of the "live" data
// (see index.js's setInterval calls).
export async function refreshHttpsNodeOptions(batchSize = 12) {
  if (_refreshingHttpsNodeOptions) return;
  _refreshingHttpsNodeOptions = true;
  try {
    const nodes = await getKnownNemNodes();
    const candidates = [];
    for (const n of nodes) {
      let u;
      try {
        u = new URL(n.endpoint);
      } catch {
        continue;
      }
      const httpsPort = u.port ? String(Number(u.port) + 1) : "443";
      const host = `${u.hostname}:${httpsPort}`;
      candidates.push({
        name: n.name || u.hostname,
        host,
        endpoint: `https://${host}`,
      });
    }
    const verified = [];
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const ok = await Promise.all(batch.map((c) => probeHttpsNode(c.host)));
      batch.forEach((c, idx) => {
        if (ok[idx]) verified.push(c);
      });
    }
    httpsNodeOptions = verified;
    httpsNodeOptionsUpdatedAt = Date.now();
  } catch (err) {
    console.error("Node options refresh failed:", err.message);
  } finally {
    _refreshingHttpsNodeOptions = false;
  }
}

export function findNodeOption(endpoint) {
  return httpsNodeOptions.find((n) => n.endpoint === endpoint) || null;
}

// ── Shuffled pool for nemFetch ────────────────────────────────────────────────

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Returns a freshly shuffled copy of the current node pool: the dynamic,
// HTTPS-verified pool when it has at least one entry, else the hardcoded
// fallback (cold start, or a sustained nodewatch outage before any
// successful refresh has ever completed). Called fresh on every nemFetch()
// so load spreads across nodes instead of always starting from the same one.
//
// `nodes` defaults to the live httpsNodeOptions; tests pass an explicit
// array instead of reaching into this module's internal state.
export function getShuffledNodePool(nodes = httpsNodeOptions) {
  const base =
    nodes.length > 0 ? nodes.map((n) => n.endpoint) : NEM_NODES_FALLBACK;
  return shuffle([...base]);
}
