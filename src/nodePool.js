import { NODE_PROBE_TIMEOUT_MS, NETWORKS } from "./constants.js";
import { currentNetwork } from "./context.js";

// ── Node discovery ────────────────────────────────────────────────────────────

// nodewatch.symbol.tools crawls the NEM network and publishes every node it
// discovers — not only nodes enrolled in any program. NIS1 nodes have no
// protocol-level concept of "supernode" status, so we query this
// third-party directory rather than a NIS node. It publishes a separate feed
// per network (NETWORKS.mainnet.nodeSourceApi / NETWORKS.testnet.nodeSourceApi).

const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^\[::1\]$/,
];

function isPrivateHostname(hostname) {
  return PRIVATE_HOSTNAME_PATTERNS.some((re) => re.test(hostname));
}

export async function getKnownNemNodes(network) {
  const res = await fetch(NETWORKS[network].nodeSourceApi);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

// ── Node verification ─────────────────────────────────────────────────────────

// nodewatch only ever lists each node's plain-HTTP REST endpoint (host:7890);
// it never lists an "https://" entry. By NIS1 convention the same host
// commonly answers HTTPS one port up (host:7891 — exactly how our fallback
// pools in constants.js are configured), so we derive that candidate and probe
// it directly rather than trusting the registry.
const state = {
  mainnet: { nodeOptions: [], nodeOptionsUpdatedAt: null, refreshing: false },
  testnet: { nodeOptions: [], nodeOptionsUpdatedAt: null, refreshing: false },
};

export function getNodeOptions(network = currentNetwork()) {
  return state[network].nodeOptions;
}

export function getNodeOptionsUpdatedAt(network = currentNetwork()) {
  return state[network].nodeOptionsUpdatedAt;
}

export async function probeNode(url, timeoutMs = NODE_PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/chain/height`, {
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
// (see index.js's setInterval calls) — once per network.
export async function refreshNodeOptions(network = currentNetwork(), batchSize = 12) {
  const s = state[network];
  if (s.refreshing) return;
  s.refreshing = true;
  try {
    const nodes = await getKnownNemNodes(network);
    const candidates = [];
    for (const n of nodes) {
      let u;
      try {
        u = new URL(n.endpoint);
      } catch {
        continue;
      }
      if (isPrivateHostname(u.hostname)) continue;
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
      const ok = await Promise.all(batch.map((c) => probeNode(c.endpoint)));
      batch.forEach((c, idx) => {
        if (ok[idx]) verified.push(c);
      });
    }
    if (verified.length > 0) {
      s.nodeOptions = verified;
    }
  } catch (err) {
    console.error(`Node options refresh failed (${network}):`, err.message);
  } finally {
    s.nodeOptionsUpdatedAt = Date.now();
    s.refreshing = false;
  }
}

export function findNodeOption(endpoint, network = currentNetwork()) {
  return state[network].nodeOptions.find((n) => n.endpoint === endpoint) || null;
}

// ── Shuffled pool for nemFetch ────────────────────────────────────────────────

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Returns a freshly shuffled copy of the current network's node pool: the
// dynamic, verified pool when it has at least one entry, else that
// network's hardcoded fallback (cold start, or a sustained nodewatch outage
// before any successful refresh has ever completed). Called fresh on every
// nemFetch() so load spreads across nodes instead of always starting from the
// same one.
//
// `nodes` defaults to the live pool for the current network; tests pass an
// explicit array instead of reaching into this module's internal state.
export function getShuffledNodePool(
  nodes = getNodeOptions(),
  network = currentNetwork(),
) {
  const base =
    nodes.length > 0 ? nodes.map((n) => n.endpoint) : NETWORKS[network].fallbackNodes;
  return shuffle([...base]);
}
