import express from "express";
import compression from "compression";

import { nodeContext } from "./src/context.js";
import {
  findNodeOption,
  fetchSubNamespaces,
  fetchMosaicsForNamespace,
  getActiveSupernodes,
  refreshNamespacesCache,
  refreshMosaicsCache,
  refreshAllMosaicsDeep,
  importNamespaceArchive,
  importMosaicArchive,
  importPollArchive,
  refreshRichListCache,
  refreshLiveRichList,
  refreshPriceCache,
  refreshHttpsNodeOptions,
  scheduleDailyTxStatsRefresh,
  liveRichList,
  liveRichListUpdatedAt,
} from "./src/cache.js";
import {
  getHeight,
  getBlock,
  getAccount,
  getAccountTxs,
  getAccountHarvests,
  getAccountMosaics,
  getAccountNamespaces,
  getTxsFromBlocks,
  nemFetch,
} from "./src/nemApi.js";
import {
  getCacheMeta,
  getCachedNamespaces,
  getNamespacesWithArchive,
  getNamespacesWithArchiveCount,
  getCachedMosaics,
  getMosaicsWithArchive,
  getMosaicsWithArchiveCount,
  getCachedPolls,
  getCachedPollsCount,
  getNamespaceByFqn,
  getMosaicsByNamespace,
  getMosaicByNsAndName,
} from "./src/db.js";
import { truncHash, esc } from "./src/helpers.js";
import {
  shell,
  accountShell,
  homePageHTML,
  heroBlocks,
  heroBlock,
  heroTxs,
  heroTx,
  heroNamespaces,
  heroNamespace,
  heroMosaics,
  heroMosaic,
  heroPolls,
  heroNodes,
  heroAccounts,
  blocksTableHTML,
  blockDetailHTML,
  txDetailHTML,
  txNotFoundHTML,
  accountOverviewHTML,
  txTableHTML,
  txMoreRows,
  globalTxTableHTML,
  globalTxMoreRows,
  harvestsHTML,
  mosaicsHTML,
  namespacesHTML,
  namespacesListHTML,
  namespaceMoreRows,
  namespaceNotFoundHTML,
  namespaceDetailHTML,
  mosaicsListHTML,
  mosaicMoreRows,
  mosaicNotFoundHTML,
  mosaicDetailHTML,
  pollsListHTML,
  pollMoreRows,
  nodesListHTML,
  accountsListHTML,
  accountMoreRows,
  errorFrag,
} from "./src/html.js";

// ── Express setup ─────────────────────────────────────────────────────────────

const app = express();
const PORT = 3000;

app.disable("x-powered-by");
app.use(compression());
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(express.static("public"));

// Reads the navbar's node-switch cookie and, if it names one of the currently
// cached HTTPS supernodes, makes that node available to nemFetch() for the
// remainder of this request via AsyncLocalStorage. Anything else (missing
// cookie, stale/unknown endpoint) falls through to the default round-robin
// pool — the whitelist check also keeps a forged cookie from turning this
// into an open server-side fetch proxy.
app.use((req, res, next) => {
  const raw = req.headers.cookie || "";
  let selected = null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === "nemscan-node") {
      selected = decodeURIComponent(part.slice(i + 1).trim());
      break;
    }
  }
  const node = selected ? findNodeOption(selected) : null;
  nodeContext.run(node, () => next());
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/", async (req, res) => {
  res.setHeader("Content-Type", "text/html");
  try {
    const height = await getHeight();
    const heights = [height, height - 1, height - 2, height - 3, height - 4];
    const blocks = await Promise.all(heights.map((h) => getBlock(h)));
    const { items: txsRaw } = await getTxsFromBlocks(height, 5);
    const txs = txsRaw.slice(0, 5);
    const avgBlockSecs =
      blocks.length > 1
        ? (blocks[0].timeStamp - blocks[blocks.length - 1].timeStamp) /
          (blocks.length - 1)
        : null;
    res.send(homePageHTML({ height, blocks, txs, avgBlockSecs }));
  } catch (err) {
    res.status(503).send(homePageHTML({ error: err.message }));
  }
});

// Navbar search box: routes a query straight to the matching detail page.
// Block height and address both resolve reliably against the existing detail
// pages. A 64-char hex string is routed to the transaction-detail page too —
// note that NIS1 public nodes only retain hash lookups for very recent /
// unconfirmed transactions, so older hashes typed here may show "not found"
// unless reached via an in-app link that already knows the tx's block.
const NEM_ADDRESS_RE = /^[A-Z2-7]{40}$/;
const NEM_HASH_RE = /^[0-9a-f]{64}$/i;
const NAMESPACE_FQN_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

app.get("/search", (req, res) => {
  const q = (req.query.q || "").trim();
  if (/^\d+$/.test(q)) return res.redirect(`/block/${q}`);
  const addr = q.replace(/[\s-]/g, "").toUpperCase();
  if (NEM_ADDRESS_RE.test(addr)) return res.redirect(`/account/${addr}`);
  if (NEM_HASH_RE.test(q)) return res.redirect(`/tx/${q.toLowerCase()}`);
  res.redirect("/blocks");
});

// Blocks list
app.get("/blocks", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      "Blocks - NEMSCAN",
      heroBlocks(),
      "blocks-card",
      "/api/blocks?page=1&limit=25",
      `<div class="loading"><div class="spinner"></div><span>Fetching latest blocks…</span></div>`,
    ),
  );
});

app.get("/api/blocks", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit))
    ? parseInt(req.query.limit)
    : 25;
  try {
    const height = await getHeight();
    const startH = height - (page - 1) * limit;
    const endH = Math.max(1, startH - limit + 1);
    const heights = [];
    for (let h = startH; h >= endH; h--) heights.push(h);
    const blocks = await Promise.all(heights.map((h) => getBlock(h)));
    res.setHeader("Content-Type", "text/html");
    res.send(
      blocksTableHTML(blocks, page, Math.ceil(height / limit), limit, height),
    );
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(
      errorFrag(err.message, `/api/blocks?page=1&limit=25`, "#blocks-card"),
    );
  }
});

// Block detail
app.get("/block/:height", (req, res) => {
  const height = parseInt(req.params.height);
  if (isNaN(height) || height < 1)
    return res.status(400).send("Invalid height");
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      `Block #${height} - NEMSCAN`,
      heroBlock(height),
      "block-detail",
      `/api/block/${height}`,
      `<div class="loading"><div class="spinner"></div><span>Loading block #${height}…</span></div>`,
    ),
  );
});

app.get("/api/block/:height", async (req, res) => {
  const height = parseInt(req.params.height);
  try {
    const [block, chainHeight] = await Promise.all([
      getBlock(height),
      getHeight(),
    ]);
    res.setHeader("Content-Type", "text/html");
    res.send(blockDetailHTML(block, chainHeight));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, `/api/block/${height}`, "#block-detail"));
  }
});

// Transaction detail
app.get("/tx/:hash", (req, res) => {
  const hash = (req.params.hash || "").trim().toLowerCase();
  if (!NEM_HASH_RE.test(hash))
    return res.status(400).send("Invalid transaction hash");
  const qs = new URLSearchParams();
  if (req.query.height) qs.set("height", req.query.height);
  if (req.query.ts) qs.set("ts", req.query.ts);
  const apiUrl = `/api/tx/${hash}${qs.toString() ? "?" + qs.toString() : ""}`;
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      `Transaction ${truncHash(hash)} - NEMSCAN`,
      heroTx(hash),
      "tx-detail",
      apiUrl,
      `<div class="loading"><div class="spinner"></div><span>Loading transaction…</span></div>`,
      "/txs",
    ),
  );
});

app.get("/api/tx/:hash", async (req, res) => {
  const hash = (req.params.hash || "").trim().toLowerCase();
  const heightHint = parseInt(req.query.height);
  const tsHint = parseInt(req.query.ts);
  try {
    let tx = null,
      height = null;
    // Direct hash lookup only succeeds for very recent / unconfirmed transactions —
    // public NIS1 nodes don't retain a historical hash → transaction index.
    try {
      const direct = await nemFetch(
        `/transaction/get?hash=${encodeURIComponent(hash)}`,
      );
      if (direct?.transaction) {
        tx = direct.transaction;
        height = direct.height || heightHint || null;
      }
    } catch {}
    // Fallback for links generated within this app: we already know which block
    // the tx lives in, so locate it there by matching its (effectively unique) timestamp.
    if (!tx && heightHint > 0) {
      const block = await getBlock(heightHint);
      const txns = Array.isArray(block.transactions) ? block.transactions : [];
      tx =
        txns.find((t) => t.timeStamp === tsHint) ||
        (txns.length === 1 ? txns[0] : null);
      if (tx) height = heightHint;
    }
    if (!tx) {
      res.setHeader("Content-Type", "text/html");
      return res.send(txNotFoundHTML(hash));
    }
    res.setHeader("Content-Type", "text/html");
    res.send(txDetailHTML(tx, hash, height));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, `/api/tx/${hash}`, "#tx-detail"));
  }
});

// Account detail
app.get("/account/:address", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(accountShell(req.params.address));
});

app.get("/api/account/:address", async (req, res) => {
  const { address } = req.params;
  try {
    const data = await getAccount(address);
    if (data.code || !data.account) {
      return res.status(404).setHeader("Content-Type", "text/html").send(`
        <div class="error-state">
          <div class="error-icon">⚠</div>
          <p class="error-title">Account not found</p>
          <p class="error-msg">${esc(data.message || address)}</p>
        </div>`);
    }
    res.setHeader("Content-Type", "text/html");
    res.send(accountOverviewHTML(data, address));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(
      errorFrag(err.message, `/api/account/${address}`, "#acct-overview"),
    );
  }
});

app.get("/api/account/:address/txs", async (req, res) => {
  const { address } = req.params;
  try {
    const data = await getAccountTxs(address);
    res.setHeader("Content-Type", "text/html");
    res.send(txTableHTML(data.data || [], address));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(
      errorFrag(err.message, `/api/account/${address}/txs`, "#tab-content"),
    );
  }
});

app.get("/api/account/:address/txs/more", async (req, res) => {
  const { address } = req.params;
  const { id } = req.query;
  try {
    const data = await getAccountTxs(address, id);
    res.setHeader("Content-Type", "text/html");
    res.send(txMoreRows(data.data || [], address));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send("");
  }
});

app.get("/api/account/:address/harvests", async (req, res) => {
  const { address } = req.params;
  try {
    const data = await getAccountHarvests(address);
    res.setHeader("Content-Type", "text/html");
    res.send(harvestsHTML(data.data || []));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(
      errorFrag(
        err.message,
        `/api/account/${address}/harvests`,
        "#tab-content",
      ),
    );
  }
});

app.get("/api/account/:address/mosaics", async (req, res) => {
  const { address } = req.params;
  try {
    const data = await getAccountMosaics(address);
    res.setHeader("Content-Type", "text/html");
    res.send(mosaicsHTML(data.data || []));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(
      errorFrag(err.message, `/api/account/${address}/mosaics`, "#tab-content"),
    );
  }
});

app.get("/api/account/:address/namespaces", async (req, res) => {
  const { address } = req.params;
  try {
    const data = await getAccountNamespaces(address);
    res.setHeader("Content-Type", "text/html");
    res.send(namespacesHTML(data.data || []));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(
      errorFrag(
        err.message,
        `/api/account/${address}/namespaces`,
        "#tab-content",
      ),
    );
  }
});

// Transactions list
app.get("/txs", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      "Transactions - NEMSCAN",
      heroTxs(),
      "txs-card",
      "/api/txs",
      `<div class="loading"><div class="spinner"></div><span>Fetching latest transactions…</span></div>`,
      "/txs",
    ),
  );
});

app.get("/api/txs", async (req, res) => {
  try {
    const height = await getHeight();
    const fromHeight = parseInt(req.query.fromBlock) || height;
    const { items, nextFromBlock } = await getTxsFromBlocks(fromHeight);
    res.setHeader("Content-Type", "text/html");
    res.send(globalTxTableHTML(items, height, nextFromBlock));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, "/api/txs", "#txs-card"));
  }
});

app.get("/api/txs/more", async (req, res) => {
  const fromBlock = parseInt(req.query.fromBlock) || 1;
  try {
    const { items, nextFromBlock } = await getTxsFromBlocks(fromBlock);
    res.setHeader("Content-Type", "text/html");
    res.send(globalTxMoreRows(items, nextFromBlock));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send("");
  }
});

// Namespaces list
app.get("/namespaces", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      "Namespaces - NEMSCAN",
      heroNamespaces(),
      "namespaces-card",
      "/api/namespaces",
      `<div class="loading"><div class="spinner"></div><span>Fetching namespaces…</span></div>`,
      "/namespaces",
    ),
  );
});

app.get("/api/namespaces", async (req, res) => {
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit))
    ? parseInt(req.query.limit)
    : 25;
  try {
    let items = getCachedNamespaces(25);
    if (!items.length) {
      await refreshNamespacesCache();
      items = getCachedNamespaces(25);
    }
    res.setHeader("Content-Type", "text/html");
    res.send(
      namespacesListHTML(
        getNamespacesWithArchive(limit),
        getCacheMeta("namespaces_updated_at"),
        limit,
      ),
    );
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, "/api/namespaces", "#namespaces-card"));
  }
});

app.get("/api/namespaces/more", async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit))
    ? parseInt(req.query.limit)
    : 25;
  try {
    const items = getNamespacesWithArchive(limit, offset);
    const total = getNamespacesWithArchiveCount();
    res.setHeader("Content-Type", "text/html");
    res.send(namespaceMoreRows(items, offset, total, limit));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send("");
  }
});

// Namespace detail
app.get("/namespace/:fqn", (req, res) => {
  const fqn = decodeURIComponent(req.params.fqn || "")
    .trim()
    .toLowerCase();
  if (!NAMESPACE_FQN_RE.test(fqn))
    return res.status(400).send("Invalid namespace");
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      `Namespace ${fqn} - NEMSCAN`,
      heroNamespace(fqn),
      "namespace-detail",
      `/api/namespace/${encodeURIComponent(fqn)}`,
      `<div class="loading"><div class="spinner"></div><span>Loading namespace…</span></div>`,
      "/namespaces",
    ),
  );
});

app.get("/api/namespace/:fqn", async (req, res) => {
  const fqn = decodeURIComponent(req.params.fqn || "")
    .trim()
    .toLowerCase();
  res.setHeader("Content-Type", "text/html");
  try {
    const root = fqn.split(".")[0];
    let subNamespaces = [];
    try {
      subNamespaces = await fetchSubNamespaces(root);
    } catch {
      /* nemtool unreachable — fall back to local lookup only */
    }
    const ns =
      fqn === root
        ? getNamespaceByFqn(fqn)
        : subNamespaces.find((s) => s.fqn === fqn) || null;
    if (!ns) return res.send(namespaceNotFoundHTML(fqn));
    const mosaics = getMosaicsByNamespace(fqn);
    res.send(
      namespaceDetailHTML(
        ns,
        root,
        subNamespaces.filter((s) => s.fqn !== fqn),
        mosaics,
      ),
    );
  } catch (err) {
    res
      .status(503)
      .send(
        errorFrag(
          err.message,
          `/api/namespace/${encodeURIComponent(fqn)}`,
          "#namespace-detail",
        ),
      );
  }
});

// Mosaics list
app.get("/mosaics", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      "Mosaics - NEMSCAN",
      heroMosaics(),
      "mosaics-card",
      "/api/mosaics",
      `<div class="loading"><div class="spinner"></div><span>Fetching mosaics…</span></div>`,
      "/mosaics",
    ),
  );
});

app.get("/api/mosaics", async (req, res) => {
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit))
    ? parseInt(req.query.limit)
    : 25;
  try {
    let items = getCachedMosaics(25);
    if (!items.length) {
      await refreshMosaicsCache();
      items = getCachedMosaics(25);
    }
    res.setHeader("Content-Type", "text/html");
    res.send(
      mosaicsListHTML(
        getMosaicsWithArchive(limit),
        getCacheMeta("mosaics_updated_at"),
        limit,
      ),
    );
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, "/api/mosaics", "#mosaics-card"));
  }
});

app.get("/api/mosaics/more", async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit))
    ? parseInt(req.query.limit)
    : 25;
  try {
    const items = getMosaicsWithArchive(limit, offset);
    const total = getMosaicsWithArchiveCount();
    res.setHeader("Content-Type", "text/html");
    res.send(mosaicMoreRows(items, offset, total, limit));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send("");
  }
});

// Mosaic detail
app.get(/^\/mosaic\/(.+)$/, (req, res) => {
  const rawPath = req.params[0] || "";
  const parts = rawPath.split("/").filter(Boolean);
  if (parts.length < 2) return res.status(400).send("Invalid mosaic path");
  const name = parts[parts.length - 1];
  const namespace = parts.slice(0, -1).join(".");
  const title = `${namespace}:${name}`;
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      `Mosaic ${title} - NEMSCAN`,
      heroMosaic(namespace, name),
      "mosaic-detail",
      `/api/mosaic/${rawPath}`,
      `<div class="loading"><div class="spinner"></div><span>Loading mosaic…</span></div>`,
      "/mosaics",
    ),
  );
});

app.get(/^\/api\/mosaic\/(.+)$/, async (req, res) => {
  const rawPath = req.params[0] || "";
  const parts = rawPath.split("/").filter(Boolean);
  if (parts.length < 2) return res.status(400).send("Invalid mosaic path");
  const name = parts[parts.length - 1];
  const namespace = parts.slice(0, -1).join(".");
  res.setHeader("Content-Type", "text/html");
  try {
    let m = getMosaicByNsAndName(namespace, name);
    let liveData = null;
    try {
      const data = await fetchMosaicsForNamespace(namespace);
      const found = (data.data || []).find((d) => d.mosaic.id.name === name);
      if (found) {
        liveData = found.mosaic;
        if (!m) {
          const props = Object.fromEntries(
            (liveData.properties || []).map((p) => [p.name, p.value]),
          );
          m = {
            namespace,
            name,
            creator: liveData.creator,
            description: liveData.description || "",
            divisibility: parseInt(props.divisibility) || 0,
            supply: parseInt(props.initialSupply) || 0,
            transferable: props.transferable !== "false" ? 1 : 0,
          };
        }
      }
    } catch {
      /* live API unavailable, use DB only */
    }
    if (!m) return res.send(mosaicNotFoundHTML(namespace, name));
    res.send(mosaicDetailHTML(m, liveData));
  } catch (err) {
    res
      .status(503)
      .send(errorFrag(err.message, `/api/mosaic/${rawPath}`, "#mosaic-detail"));
  }
});

// Polls
app.get("/polls", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      "Polls - NEMSCAN",
      heroPolls(),
      "polls-card",
      "/api/polls",
      `<div class="loading"><div class="spinner"></div><span>Loading…</span></div>`,
      "/polls",
    ),
  );
});

app.get("/api/polls", async (req, res) => {
  try {
    const items = getCachedPolls(25);
    res.setHeader("Content-Type", "text/html");
    res.send(pollsListHTML(items, getCachedPollsCount()));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, "/api/polls", "#polls-card"));
  }
});

app.get("/api/polls/more", (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  try {
    const items = getCachedPolls(25, offset);
    const total = getCachedPollsCount();
    res.setHeader("Content-Type", "text/html");
    res.send(pollMoreRows(items, offset, total));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send("");
  }
});

// Supernodes
app.get("/nodes", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      "Supernodes - NEMSCAN",
      heroNodes(),
      "nodes-card",
      "/api/nodes",
      `<div class="loading"><div class="spinner"></div><span>Fetching active supernodes…</span></div>`,
      "/nodes",
    ),
  );
});

app.get("/api/nodes", async (req, res) => {
  try {
    const nodes = await getActiveSupernodes();
    res.setHeader("Content-Type", "text/html");
    res.send(nodesListHTML(nodes));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, "/api/nodes", "#nodes-card"));
  }
});

// Accounts (rich list)
app.get("/accounts", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(
    shell(
      "Accounts - NEMSCAN",
      heroAccounts(),
      "accounts-card",
      "/api/accounts",
      `<div class="loading"><div class="spinner"></div><span>Fetching rich list…</span></div>`,
      "/accounts",
    ),
  );
});

app.get("/api/accounts", async (req, res) => {
  try {
    if (!liveRichList.length) {
      await refreshLiveRichList();
    }
    const items = liveRichList.slice(0, 25);
    res.setHeader("Content-Type", "text/html");
    res.send(
      accountsListHTML(items, liveRichListUpdatedAt, liveRichList.length),
    );
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send(errorFrag(err.message, "/api/accounts", "#accounts-card"));
  }
});

app.get("/api/accounts/more", async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  try {
    const items = liveRichList.slice(offset, offset + 25);
    res.setHeader("Content-Type", "text/html");
    res.send(accountMoreRows(items, offset, liveRichList.length));
  } catch (err) {
    res.status(503).setHeader("Content-Type", "text/html");
    res.send("");
  }
});

app.get("/robots.txt", (req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.send(
    "User-agent: *\nAllow: /\nSitemap: http://localhost:3000/sitemap.xml\n",
  );
});

app.get("/sitemap.xml", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  const urls = [
    "/",
    "/blocks",
    "/txs",
    "/namespaces",
    "/mosaics",
    "/accounts",
    "/nodes",
    "/polls",
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${base}${u}</loc></url>`).join("\n")}\n</urlset>`;
  res.setHeader("Content-Type", "application/xml");
  res.send(xml);
});

app.use((req, res) => {
  res.status(404).setHeader("Content-Type", "text/html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <link rel="icon" type="image/png" href="/nem_logo.png">
  <title>404 - Page Not Found | NEMSCAN</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:16px;text-align:center;padding:40px 20px;">
  <img src="/nem_logo.png" width="56" height="56" alt="NEM" style="opacity:.5;">
  <h1 style="font-size:64px;font-weight:700;margin:0;opacity:.2;">404</h1>
  <p style="font-size:18px;font-weight:600;margin:0;">Page not found</p>
  <p style="color:var(--text-2);margin:0;">The page you're looking for doesn't exist.</p>
  <a href="/" style="margin-top:8px;padding:10px 24px;background:var(--link);color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Go Home</a>
</div>
</body></html>`);
});

// ── Background cache warmers ───────────────────────────────────────────────────
// Keep the namespace, mosaic, rich-list and price caches warm: populate on
// boot, then refresh periodically in the background so page requests never
// have to wait on the slow NIS queries / large source pages. Mosaics are
// derived from cached namespaces, so its first run waits on that cache.
// The candidate-address pool changes rarely, so it's rebuilt only a few times
// a day; the live rich-list re-queries each candidate's *current* balance from
// the chain, so it refreshes much more often to stay accurate.
setTimeout(() => {
  refreshNamespacesCache().then(refreshMosaicsCache);
  importNamespaceArchive();
  importMosaicArchive();
  importPollArchive();
  refreshRichListCache().then(refreshLiveRichList);
  refreshPriceCache();
  refreshHttpsNodeOptions();
  setInterval(refreshNamespacesCache, 10 * 60 * 1000);
  setInterval(refreshMosaicsCache, 10 * 60 * 1000);
  setInterval(refreshRichListCache, 6 * 60 * 60 * 1000);
  setInterval(refreshLiveRichList, 5 * 60 * 1000);
  setInterval(refreshPriceCache, 60 * 1000);
  setInterval(refreshHttpsNodeOptions, 5 * 60 * 1000);
  // Deep mosaic refresh: first run 2 minutes after startup to avoid congestion,
  // then every 6 hours. Covers all known namespaces and refreshes current supply.
  setTimeout(refreshAllMosaicsDeep, 2 * 60 * 1000);
  setInterval(refreshAllMosaicsDeep, 6 * 60 * 60 * 1000);
  scheduleDailyTxStatsRefresh();
}, 3000);

app.listen(PORT, "0.0.0.0", () =>
  console.log(`NEMSCAN → http://localhost:${PORT}/`),
);
