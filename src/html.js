import {
  getCacheMeta,
  getArchivedNamespacesCount,
  getArchivedMosaicsCount,
  getDailyTxCounts,
  getNamespacesWithArchiveCount,
  getMosaicsWithArchiveCount,
} from "./db.js";
import {
  nemDate,
  timeAgo,
  truncKey,
  truncHash,
  pubKeyToAddress,
  xem,
  formatDiff,
  formatImportance,
  esc,
  decodeMsg,
} from "./helpers.js";
import { nodeContext } from "./context.js";
import { httpsNodeOptions, httpsNodeOptionsUpdatedAt } from "./cache.js";
import { TX_TYPES, XEM_TOTAL_SUPPLY, DAILY_TX_DAYS } from "./constants.js";

// ── Shared fragments ──────────────────────────────────────────────────────────

export function errorFrag(msg, retryUrl, retryTarget) {
  return `<div class="error-state">
    <div class="error-icon">⚠</div>
    <p class="error-title">Unable to reach NEM network</p>
    <p class="error-msg">${esc(msg)}</p>
    <button class="retry-btn" hx-get="${retryUrl}" hx-target="${retryTarget}" hx-swap="innerHTML">Retry</button>
  </div>`;
}

// Sub-cent prices need more decimals to stay meaningful than the 2 places
// Etherscan/Arbiscan use for ETH — pick precision based on magnitude.
export function formatUsdPrice(price) {
  if (price >= 1)
    return price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

export function formatMarketCap(price) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(price * XEM_TOTAL_SUPPLY);
}

export function xemPriceHTML() {
  const priceRaw = getCacheMeta("xem_price");
  const changeRaw = getCacheMeta("xem_change_rate");
  if (priceRaw == null || changeRaw == null) return "";
  const price = parseFloat(priceRaw);
  const changePct = parseFloat(changeRaw) * 100;
  const up = changePct >= 0;
  const sign = up ? "+" : "";
  return `<div class="xem-price">XEM Price: <strong>$${formatUsdPrice(price)}</strong> <span class="${up ? "price-up" : "price-down"}">(${sign}${changePct.toFixed(2)}%)</span></div>`;
}

export function nodeSwitchHTML() {
  const active = nodeContext.getStore();
  const activeEndpoint = active ? active.endpoint : "";
  const activeLabel = active ? active.name : "Auto";
  const isActive = (ep) => (ep === activeEndpoint ? " active" : "");
  const items = [...httpsNodeOptions]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (n) => `
        <button type="button" class="node-menu-item${isActive(n.endpoint)}" data-node-endpoint="${esc(n.endpoint)}" data-node-name="${esc(n.name)}" role="menuitem" onclick="selectNode(this)">
          <span class="node-menu-dot"></span>
          <span class="node-menu-text"><span class="node-menu-name">${esc(n.name)}</span><span class="node-menu-sub">${esc(n.host)}</span></span>
        </button>`,
    )
    .join("");
  return `<div class="node-switch">
      <button type="button" class="node-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleNodeMenu(event)" title="Connection node">
        <span class="node-switch-dot is-live"></span>
        <span class="node-switch-label">${esc(activeLabel)}</span>
        <span class="node-switch-caret">&#9662;</span>
      </button>
      <div class="node-menu" role="menu" aria-label="Connection node">
        <div class="node-menu-head">Connect via <span class="node-menu-note">active HTTPS supernodes</span></div>
        <button type="button" class="node-menu-item${isActive("")}" data-node-endpoint="" data-node-name="Auto" role="menuitem" onclick="selectNode(this)">
          <span class="node-menu-dot"></span>
          <span class="node-menu-text"><span class="node-menu-name">Auto</span><span class="node-menu-sub">round-robin node pool</span></span>
        </button>
        <div class="node-menu-sep"></div>
        ${items || `<div class="node-menu-empty">${httpsNodeOptionsUpdatedAt ? "No HTTPS-reachable supernodes right now" : "Probing active supernodes for HTTPS…"}</div>`}
      </div>
    </div>`;
}

// Shared markup for the navbar's price/search/node/theme controls — rendered
// once into the wide-screen topbar and again inside the narrow-screen burger
// menu (CSS shows exactly one copy at a time, so dropdown JS keyed off
// btn.parentElement still resolves to the right sibling menu in both copies).
export function navToolsHTML(showSearch = true) {
  return `${xemPriceHTML()}
    ${
      showSearch
        ? `<form class="nav-search" action="/search" method="get" role="search">
      <input type="text" name="q" placeholder="Search by Address / Block Height / Tx Hash" autocomplete="off" spellcheck="false">
      <button type="submit" aria-label="Search">&#128269;</button>
    </form>`
        : '<div style="flex:1 1 auto"></div>'
    }
    ${nodeSwitchHTML()}
    <div class="theme-switch">
      <button type="button" class="theme-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleThemeMenu(event)" title="Theme">
        <span class="theme-switch-icon" data-theme-icon>&#9728;</span>
        <span class="theme-switch-caret">&#9662;</span>
      </button>
      <div class="theme-menu" role="menu" aria-label="Theme">
        <button type="button" class="theme-menu-item" data-theme-choice="light" role="menuitem" title="Light" aria-label="Light" onclick="setTheme('light')"><span class="theme-menu-icon">&#9728;</span></button>
        <button type="button" class="theme-menu-item" data-theme-choice="dim" role="menuitem" title="Dim" aria-label="Dim" onclick="setTheme('dim')"><span class="theme-menu-icon">&#9680;</span></button>
        <button type="button" class="theme-menu-item" data-theme-choice="dark" role="menuitem" title="Dark" aria-label="Dark" onclick="setTheme('dark')"><span class="theme-menu-icon">&#9790;</span></button>
      </div>
    </div>`;
}

export function navHTML(activeHref, hideSearch = false) {
  const links = [
    ["/blocks", "Blocks"],
    ["/txs", "Transactions"],
    ["/accounts", "Accounts"],
    ["/namespaces", "Namespaces"],
    ["/mosaics", "Mosaics"],
    ["/nodes", "Nodes"],
    ["/polls", "Polls"],
  ];
  return `<div class="topbar"><div class="topbar-inner">
    ${navToolsHTML(!hideSearch)}
  </div></div>
  <nav class="topnav"><div class="topnav-inner">
    <a href="/" class="logo">
      <img src="/nem_logo.png" width="32" height="32" alt="NEM" style="display:block;">
      NEMSCAN
    </a>
    <button type="button" class="nav-burger" aria-haspopup="true" aria-expanded="false" aria-label="Menu" onclick="toggleNavMenu(event)">
      <span class="nav-burger-bar"></span>
      <span class="nav-burger-bar"></span>
      <span class="nav-burger-bar"></span>
    </button>
    <div class="nav-menu">
      <ul class="nav-links">
        ${links.map(([h, l]) => `<li><a href="${h}"${h === activeHref ? ' class="active"' : ""}>${l}</a></li>`).join("")}
      </ul>
      <div class="nav-menu-tools">
        ${navToolsHTML(!hideSearch)}
      </div>
    </div>
  </div></nav>`;
}

export function footerHTML() {
  const githubIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`;
  const discordIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.076.076 0 0 0-.04.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`;
  const xIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;
  const heartIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/></svg>`;
  const symbolIcon = `<svg viewBox="0 0 400 400" aria-hidden="true"><path fill="currentColor" d="M270.08,95.59q.75-1.61,1.44-3.27l0,0v0a.16.16,0,0,1,0,.07,87.34,87.34,0,0,1-6.24,9,74.2,74.2,0,0,1-7.2,8,70.2,70.2,0,0,1-8.09,6.8,41.19,41.19,0,0,1-8.83,5A35.6,35.6,0,0,1,222,124.15a34.43,34.43,0,0,1-9.19-2.46l-2.17-1-.48-.25-.14,0,67-40.79a7.73,7.73,0,0,1,6.85-1,8.1,8.1,0,0,1,3.83,2.71,146.75,146.75,0,0,1,13.69,20.22,96.71,96.71,0,0,1,9.44,23.93A8.76,8.76,0,0,1,307,135L236.2,178h0l-7,4.29c-12.69,7.64-17.92,18-19.55,31-2,15,2.53,32.16,12.13,46.9.64,1,1.3,2,2,2.93a.56.56,0,0,0-.05-.08,90.18,90.18,0,0,1-4.31-10.14,83.46,83.46,0,0,1-4.68-21.31,46.57,46.57,0,0,1,.21-10.58,40.51,40.51,0,0,1,7-18.94,37,37,0,0,1,6.57-7.2l1.89-1.5c.13-.08.25-.17.37-.26,0,10.15-.14,81.27-.14,81.82a8.55,8.55,0,0,1-.43,2.82,8.13,8.13,0,0,1-6.33,5.63,142.38,142.38,0,0,1-23.56,2.33,85.86,85.86,0,0,1-24.41-3.35,8.53,8.53,0,0,1-5.86-8.22l-.09-94.43h0c.05-15.39-5.88-25.34-15.71-33.3-12-10-29.94-14.32-48-12h.08a79.71,79.71,0,0,1,10.49,1.12A69.74,69.74,0,0,1,126.94,138a67,67,0,0,1,9.66,3.9,41.38,41.38,0,0,1,8.6,5.47,39.2,39.2,0,0,1,12.09,15.86,39.9,39.9,0,0,1,2.64,9.59l.28,2.48c0,.18,0,.37,0,.56L93,134.75a8.22,8.22,0,0,1-2.11-1.81,8.76,8.76,0,0,1-1.47-8.59,161.57,161.57,0,0,1,9.86-22.65,94.49,94.49,0,0,1,14.95-20.59,7.83,7.83,0,0,1,9.69-1.23S175.33,111,195.25,123l6.85,4.23c12.58,7.84,23.74,7.5,35.23,2.6C250.7,124.36,262.65,111.67,270.08,95.59ZM385,58.47s-.12,15.85-.35,21.22a395.44,395.44,0,0,1-48.26,173.79c-31.75,57.72-77.35,105.64-132.23,139L200,394.9l-4.11-2.46C141,359.09,95.46,311.16,63.72,253.45A396.34,396.34,0,0,1,15.05,63.56V58.5L19.16,56a346.24,346.24,0,0,1,361.39,0ZM374,64.84c-53.58-31.75-112.56-50-174-50s-120.46,18.22-174,50c.7,129.73,67.42,245.38,173.79,310.81l.17-.13C306.57,310.22,373.38,194.91,374,64.84Z"/></svg>`;
  const upArrowIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l-8 8h5v8h6v-8h5z"/></svg>`;
  return `<footer class="site-footer"><div class="site-footer-inner">
    <div class="footer-top-row">
      <a class="footer-back-to-top" href="#" onclick="window.scrollTo({top:0,behavior:'smooth'});return false;">${upArrowIcon}Back to Top</a>
    </div>
    <hr class="footer-hr">
    <div class="footer-content">
      <div class="footer-col footer-col-brand">
        <a class="footer-brand" href="https://nem.io" target="_blank" rel="noopener">
          <img src="/nem_logo.png" width="28" height="28" alt="NEM">
          <span>Powered by NEM (XEM)</span>
        </a>
        <p class="footer-desc">NEMSCAN is a Block Explorer and Analytics Platform for the NEM (XEM) blockchain.</p>
      </div>
      <div class="footer-col">
        <h4 class="footer-col-title">Community</h4>
        <ul class="footer-col-list">
          <li><a href="https://github.com/NemProject" target="_blank" rel="noopener">${githubIcon}GitHub</a></li>
          <li><a href="https://discord.gg/NMA9YQ55td" target="_blank" rel="noopener">${discordIcon}Discord</a></li>
          <li><a href="https://x.com/NEMofficial" target="_blank" rel="noopener">${xIcon}X (Twitter)</a></li>
          <li><a href="https://symbol-community.com/" target="_blank" rel="noopener">${symbolIcon}Symbol Community</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4 class="footer-col-title">Resources</h4>
        <ul class="footer-col-list">
          <li><a href="https://nem.io" target="_blank" rel="noopener">nem.io</a></li>
          <li><a href="https://nemnodes.org/" target="_blank" rel="noopener">nemnodes.org</a></li>
          <li><a href="https://nem.io/supernodes/" target="_blank" rel="noopener">Supernodes</a></li>
          <li><a href="https://explorer.nemtool.com/" target="_blank" rel="noopener">explorer.nemtool.com</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4 class="footer-col-title">Project</h4>
        <ul class="footer-col-list">
          <li><a href="https://github.com/curupo/nemscan" target="_blank" rel="noopener">${githubIcon}Source Code</a></li>
          <li><a class="footer-donate" href="/account/NAYLN6AV23T63J3HDC2BTMJFS5WMFXYYZDOIWI5W" rel="noopener">${heartIcon}Donations</a></li>
        </ul>
      </div>
    </div>
    <hr class="footer-hr">
    <div class="footer-bottom">
      <div class="footer-copy">© NEM Community 2026</div>
    </div>
  </div></footer>`;
}

// Sets data-theme on <html> before first paint (avoids a flash of the wrong theme)
// and exposes setTheme()/toggleThemeMenu() globally for the navbar's theme dropdown.
export function themeInitScript() {
  return `<script>
(function() {
  var KEY = 'nemscan-theme';
  var THEMES = ['light','dim','dark'];
  var ICONS = { light: '&#9728;', dim: '&#9680;', dark: '&#9790;' };
  function sync(theme) {
    document.querySelectorAll('.theme-menu-item').forEach(function(b) {
      b.classList.toggle('active', b.dataset.themeChoice === theme);
    });
    document.querySelectorAll('[data-theme-icon]').forEach(function(el) { el.innerHTML = ICONS[theme]; });
  }
  // keepRoot: when closing menus to open a sub-menu that lives inside the
  // mobile burger panel (e.g. theme/node switch nested in .nav-menu), pass
  // its .topnav-inner so the panel itself and its burger stay open/expanded.
  function closeMenus(keepRoot) {
    document.querySelectorAll('.theme-menu.open, .node-menu.open, .rows-menu.open, .nav-menu.open').forEach(function(m) {
      if (keepRoot && m.classList.contains('nav-menu') && keepRoot.contains(m)) return;
      m.classList.remove('open');
    });
    document.querySelectorAll('.theme-switch-btn, .node-switch-btn, .rows-switch-btn, .nav-burger').forEach(function(b) {
      if (keepRoot && b.classList.contains('nav-burger') && keepRoot.contains(b)) return;
      b.setAttribute('aria-expanded', 'false');
    });
  }
  var theme;
  try { theme = localStorage.getItem(KEY); } catch (e) {}
  if (THEMES.indexOf(theme) === -1) theme = 'light';
  document.documentElement.setAttribute('data-theme', theme);
  window.setTheme = function(t) {
    if (THEMES.indexOf(t) === -1) return;
    try { localStorage.setItem(KEY, t); } catch (e) {}
    document.documentElement.setAttribute('data-theme', t);
    sync(t);
    closeMenus();
  };
  window.toggleThemeMenu = function(ev) {
    ev.stopPropagation();
    var btn = ev.currentTarget;
    var menu = btn.parentElement.querySelector('.theme-menu');
    var willOpen = !menu.classList.contains('open');
    closeMenus(btn.closest('.topnav-inner'));
    if (willOpen) {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  };
  var NODE_KEY = 'nemscan-node';
  window.toggleNodeMenu = function(ev) {
    ev.stopPropagation();
    var btn = ev.currentTarget;
    var menu = btn.parentElement.querySelector('.node-menu');
    var willOpen = !menu.classList.contains('open');
    closeMenus(btn.closest('.topnav-inner'));
    if (willOpen) {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  };
  window.toggleNavMenu = function(ev) {
    ev.stopPropagation();
    var btn = ev.currentTarget;
    var menu = document.querySelector('.nav-menu');
    var willOpen = !menu.classList.contains('open');
    closeMenus();
    if (willOpen) {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  };
  window.toggleRowsMenu = function(ev) {
    ev.stopPropagation();
    var btn = ev.currentTarget;
    var menu = btn.parentElement.querySelector('.rows-menu');
    var willOpen = !menu.classList.contains('open');
    closeMenus();
    if (willOpen) {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  };
  // The picker only ever offers endpoints the server already validated against
  // its live HTTPS-supernode cache, so we just hand the choice back as a cookie
  // and reload — nemFetch() on the server then prefers that node for this browser.
  window.selectNode = function(btn) {
    var endpoint = btn.dataset.nodeEndpoint || '';
    try {
      if (endpoint) document.cookie = NODE_KEY + '=' + encodeURIComponent(endpoint) + ';path=/;max-age=2592000;samesite=lax';
      else document.cookie = NODE_KEY + '=;path=/;max-age=0;samesite=lax';
    } catch (e) {}
    closeMenus();
    location.reload();
  };
  document.addEventListener('click', closeMenus);
  document.addEventListener('DOMContentLoaded', function() { sync(theme); });
})();
</script>`;
}

export function heroBlocks() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Blocks</h1>
  </div></div>`;
}

export function heroBlock(height) {
  return `<div class="hero"><div class="hero-inner">
    <div class="hero-row">
      <h1>Block <span class="hero-hl">${height}</span></h1>
      <div class="blk-nav">
        ${height > 1 ? `<a class="blk-nav-btn" href="/block/${height - 1}">&#8249;</a>` : `<span class="blk-nav-btn disabled">&#8249;</span>`}
        <a class="blk-nav-btn" href="/block/${height + 1}">&#8250;</a>
      </div>
    </div>
  </div></div>`;
}

export function heroTxs() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Transactions</h1>
  </div></div>`;
}

export function heroTx(hash) {
  return `<div class="hero"><div class="hero-inner">
    <h1 style="margin-bottom:10px;">Transaction Detail</h1>
    <div class="acct-addr-row">
      <span class="acct-addr-icon">#</span>
      <code class="acct-addr-text">${hash}</code>
      <button class="copy-btn-hero" onclick="copy('${hash}')">copy</button>
    </div>
  </div></div>`;
}

export function heroNamespaces() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Namespaces</h1>
  </div></div>`;
}

export function heroNamespace(fqn) {
  return `<div class="hero"><div class="hero-inner">
    <h1 style="margin-bottom:10px;">Namespace Detail</h1>
    <div class="acct-addr-row">
      <code class="acct-addr-text">${esc(fqn)}</code>
      <button class="copy-btn-hero" onclick="copy('${esc(fqn)}')">copy</button>
    </div>
  </div></div>`;
}

export function heroMosaics() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Mosaics</h1>
  </div></div>`;
}

export function heroMosaic(namespace, name) {
  const id = `${esc(namespace)}:<strong>${esc(name)}</strong>`;
  return `<div class="hero"><div class="hero-inner">
    <h1 style="margin-bottom:10px;">Mosaic Detail</h1>
    <div class="acct-addr-row">
      <code class="acct-addr-text">${id}</code>
      <button class="copy-btn-hero" onclick="copy('${esc(namespace + ":" + name)}')">copy</button>
    </div>
  </div></div>`;
}

export function heroPolls() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Polls</h1>
  </div></div>`;
}

export function heroAccounts() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Rich List</h1>
  </div></div>`;
}

export function heroNodes() {
  return `<div class="hero"><div class="hero-inner">
    <h1>Supernodes</h1>
  </div></div>`;
}

export function renderPollRow(p, num) {
  const expired = Date.now() > p.doe;
  const typeName = p.type === 1 ? "White List" : "POI";
  const expires = new Date(p.doe).toISOString().slice(0, 10);
  return `<tr>
    <td class="td-num">${num}</td>
    <td><a href="https://explorer.nemtool.com/#/poll?id=${esc(p.id)}" class="mono-link" target="_blank" rel="noopener" title="${esc(p.title)}">${esc(p.title)}</a></td>
    <td>${typeName}</td>
    <td><a href="/account/${p.address}" class="mono-link" title="${p.address}">${truncKey(p.address)}</a></td>
    <td>${expired ? '<span class="status-expired">● Expired</span>' : '<span class="status-ok">● Active</span>'}</td>
    <td class="mono-muted">${expires}</td>
  </tr>`;
}

export function pollLoadMoreRow(offset, total) {
  if (offset >= total) return "";
  return `<tr id="poll-load-more-row"><td colspan="6" class="load-more-cell">
    <button class="load-more-btn" hx-get="/api/polls/more?offset=${offset}" hx-target="#poll-load-more-row" hx-swap="outerHTML">Load More</button>
  </td></tr>`;
}

export function pollMoreRows(items, offset, total) {
  if (!items.length) return "";
  return (
    items.map((p, i) => renderPollRow(p, offset + i + 1)).join("") +
    pollLoadMoreRow(offset + items.length, total)
  );
}

export function pollsListHTML(items, total) {
  if (!items.length) return `<div class="empty-state">No polls found</div>`;
  return `
  <div class="card-head">
    <div class="card-title">Community Polls</div>
    <span class="total-txt"><strong>${total}</strong> polls</span>
  </div>
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>Polls aren't a NEM (NIS1) protocol feature — there's no on-chain data source for them. This list mirrors <a href="https://explorer.nemtool.com/" target="_blank" rel="noopener">explorer.nemtool.com</a>'s own off-chain voting index (${total.toLocaleString("en")} records) and may not reflect newly created or recently updated polls.</p>
  <div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Title</th><th>Type</th><th>Created By</th><th>Status</th><th>Expires</th></tr></thead>
    <tbody>${items.map((p, i) => renderPollRow(p, i + 1)).join("")}${pollLoadMoreRow(items.length, total)}</tbody>
  </table></div>`;
}

// ── Home page ─────────────────────────────────────────────────────────────────

export function homeHeroHTML() {
  return `<div class="home-hero"><div class="home-hero-inner">
    <p class="home-tagline">NEM (XEM) Blockchain Explorer</p>
    <form class="home-search" action="/search" method="get" role="search">
      <input type="text" name="q" placeholder="Search by Address / Block Height / Tx Hash" autocomplete="off" spellcheck="false">
      <button type="submit" aria-label="Search">&#128269;</button>
    </form>
  </div></div>`;
}

// shadcn "Line Chart - Label" style: a bare line with a value label above
// each point and a date label below — no axes, gridlines or legend, sized to
// fit inside a home-stat card.
export function dailyTxChartHTML() {
  const data = getDailyTxCounts(DAILY_TX_DAYS);
  if (data.length < 2)
    return `<div class="daily-tx-empty">Collecting data&hellip;</div>`;

  const vals = data.map((d) => d.tx_count);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const W = 280,
    padX = 6,
    plotTop = 20,
    plotBottom = 74,
    axisY = 88;
  const stepX = (W - padX * 2) / (data.length - 1);
  const points = data.map((d, i) => ({
    x: padX + i * stepX,
    y: plotBottom - ((d.tx_count - min) / range) * (plotBottom - plotTop),
    ...d,
  }));
  const fmt = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const line = points
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const dots = points
    .map(
      (p) =>
        `<circle class="daily-tx-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5"/>`,
    )
    .join("");
  const valLabels = points
    .map(
      (p) =>
        `<text class="daily-tx-val" x="${p.x.toFixed(1)}" y="${(p.y - 6).toFixed(1)}">${fmt.format(p.tx_count)}</text>`,
    )
    .join("");
  const axisLabels = points
    .map((p) => {
      const [, m, d] = p.date.split("-").map(Number);
      return `<text class="daily-tx-axis" x="${p.x.toFixed(1)}" y="${axisY}">${m}/${d}</text>`;
    })
    .join("");
  return `<svg class="daily-tx-chart" viewBox="0 0 ${W} 96" role="img" aria-label="Daily transaction count">
    <polyline class="daily-tx-line" points="${line}"/>
    ${dots}${valLabels}${axisLabels}
  </svg>`;
}

export function homeStatsHTML(height, avgBlockSecs) {
  const priceRaw = getCacheMeta("xem_price");
  const changeRaw = getCacheMeta("xem_change_rate");
  let priceVal = "—",
    marketCapVal = "—";
  if (priceRaw != null && changeRaw != null) {
    const price = parseFloat(priceRaw);
    const changePct = parseFloat(changeRaw) * 100;
    const up = changePct >= 0;
    priceVal = `$${formatUsdPrice(price)} <span class="${up ? "price-up" : "price-down"}">(${up ? "+" : ""}${changePct.toFixed(2)}%)</span>`;
    marketCapVal = `$${formatMarketCap(price)}`;
  }
  const leftCol = [
    ["XEM PRICE", priceVal],
    ["MARKET CAP", marketCapVal],
  ];
  const midCol = [
    [
      "LATEST BLOCK",
      `<a href="/block/${height}" class="hero-hl">${height}</a>`,
    ],
    [
      "AVG BLOCK TIME",
      avgBlockSecs != null ? `${avgBlockSecs.toFixed(1)}s` : "—",
    ],
  ];
  const renderStat = ([label, val]) => `
    <div class="home-stat"><div class="home-stat-label">${label}</div><div class="home-stat-val">${val}</div></div>`;
  const renderCol = (stats) =>
    `<div class="home-stat-col">${stats.map(renderStat).join("")}</div>`;
  const networkStat = `
    <div class="home-stat home-stat-chart"><div class="home-stat-label">TXNS / DAY</div>${dailyTxChartHTML()}</div>`;
  return `<div class="home-stats">${renderCol(leftCol)}${renderCol(midCol)}${networkStat}</div>`;
}

export function homeBlocksPanelHTML(blocks) {
  const rows = blocks
    .map((b) => {
      const date = nemDate(b.timeStamp);
      const signer = pubKeyToAddress(b.signer) ?? b.signer;
      return `<tr>
      <td><a href="/block/${b.height}" class="blk-num">${b.height}</a></td>
      <td><div class="age-rel">${timeAgo(date)}</div></td>
      <td><a href="/account/${signer}" class="harv" title="${signer}">${truncKey(signer)}</a></td>
      <td class="td-right">${(b.transactions || []).length}</td>
    </tr>`;
    })
    .join("");
  return `<div class="card home-panel">
    <div class="card-head">
      <div class="card-title">Latest Blocks <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Block</th><th>Age</th><th>Harvester</th><th class="th-right">Txns</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="home-panel-foot"><a href="/blocks">View all blocks &rsaquo;</a></div>
  </div>`;
}

export function homeTxsPanelHTML(txs) {
  const body = !txs.length
    ? `<div class="empty-state">No transactions found in recent blocks</div>`
    : `<div class="tbl-wrap"><table>
      <thead><tr><th>Sender</th><th class="th-right">Amount</th><th class="th-right">Age</th></tr></thead>
      <tbody>${txs
        .map((item) => {
          const { tx, blockTime } = item;
          const date = nemDate(blockTime);
          const isTransfer = tx.type === 257;
          const senderAddr = pubKeyToAddress(tx.signer) ?? tx.signer;
          const amountCell = isTransfer
            ? `${xem(tx.amount)} XEM`
            : `<span class="muted">—</span>`;
          return `<tr>
          <td><a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${truncKey(senderAddr)}</a></td>
          <td class="td-right">${amountCell}</td>
          <td class="td-right"><div class="age-rel">${timeAgo(date)}</div></td>
        </tr>`;
        })
        .join("")}</tbody>
    </table></div>`;
  return `<div class="card home-panel">
    <div class="card-head">
      <div class="card-title">Latest Transactions <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    </div>
    ${body}
    <div class="home-panel-foot"><a href="/txs">View all transactions &rsaquo;</a></div>
  </div>`;
}

export function homePageHTML({ height, blocks, txs, avgBlockSecs, error }) {
  const main = error
    ? `<div class="error-state"><div class="error-icon">⚠</div><div>${esc(error)}</div></div>`
    : `${homeStatsHTML(height, avgBlockSecs)}
  <div class="home-panels">
    ${homeBlocksPanelHTML(blocks)}
    ${homeTxsPanelHTML(txs)}
  </div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <link rel="icon" type="image/png" href="/nem_logo.png">
  <link rel="apple-touch-icon" href="/nem_logo.png">
  <link rel="manifest" href="/manifest.json">
  <meta name="description" content="NEMSCAN - NEM (XEM) blockchain explorer. Browse blocks, transactions, accounts, mosaics, and namespaces on the NEM blockchain.">
  <meta property="og:title" content="NEMSCAN - NEM (XEM) Blockchain Explorer">
  <meta property="og:description" content="Browse blocks, transactions, accounts, mosaics, and namespaces on the NEM blockchain.">
  <meta property="og:type" content="website">
  <meta property="og:image" content="/nem_logo.png">
  <meta name="twitter:card" content="summary">
  ${themeInitScript()}
  <title>NEMSCAN - NEM (XEM) Blockchain Explorer</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
${navHTML("/", true)}
${homeHeroHTML()}
<div class="container">
  ${main}
</div>
${footerHTML()}
</body></html>`;
}

// ── Page shells ───────────────────────────────────────────────────────────────

export function shell(
  title,
  heroSection,
  cardId,
  apiUrl,
  placeholder,
  navActive = "/blocks",
) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <link rel="icon" type="image/png" href="/nem_logo.png">
  <link rel="apple-touch-icon" href="/nem_logo.png">
  <link rel="manifest" href="/manifest.json">
  ${themeInitScript()}
  <title>${title}</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
${navHTML(navActive)}
${heroSection}
<div class="container">
  <div class="card" id="${cardId}"
       hx-get="${apiUrl}" hx-trigger="load" hx-target="#${cardId}" hx-swap="innerHTML">
    ${placeholder}
  </div>
</div>
${footerHTML()}
</body></html>`;
}

export function accountShell(address) {
  const shortAddr = `${address.slice(0, 6)}…${address.slice(-4)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <link rel="icon" type="image/png" href="/nem_logo.png">
  <link rel="apple-touch-icon" href="/nem_logo.png">
  <link rel="manifest" href="/manifest.json">
  ${themeInitScript()}
  <title>Account ${shortAddr} - NEMSCAN</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
${navHTML("/blocks")}
<div class="hero"><div class="hero-inner">
  <h1 style="margin-bottom:10px;">Account Detail</h1>
  <div class="acct-addr-row">
    <code class="acct-addr-text">${address}</code>
    <button class="copy-btn-hero" onclick="copy('${address}')">copy</button>
  </div>
</div></div>

<div class="container">
  <!-- Overview -->
  <div id="acct-overview"
       hx-get="/api/account/${address}"
       hx-trigger="load" hx-target="#acct-overview" hx-swap="innerHTML">
    <div class="card"><div class="loading"><div class="spinner"></div><span>Loading account…</span></div></div>
  </div>

  <!-- Tabs -->
  <div class="card" style="margin-top:16px;">
    <div class="tab-nav">
      <button class="tab-btn active"
              hx-get="/api/account/${address}/txs"
              hx-target="#tab-content" hx-swap="innerHTML"
              onclick="setTab(this)">Transactions</button>
      <button class="tab-btn"
              hx-get="/api/account/${address}/harvests"
              hx-target="#tab-content" hx-swap="innerHTML"
              onclick="setTab(this)">Harvested Blocks</button>
      <button class="tab-btn"
              hx-get="/api/account/${address}/mosaics"
              hx-target="#tab-content" hx-swap="innerHTML"
              onclick="setTab(this)">Mosaics</button>
      <button class="tab-btn"
              hx-get="/api/account/${address}/namespaces"
              hx-target="#tab-content" hx-swap="innerHTML"
              onclick="setTab(this)">Namespaces</button>
    </div>
    <div id="tab-content"
         hx-get="/api/account/${address}/txs"
         hx-trigger="load" hx-target="#tab-content" hx-swap="innerHTML">
      <div class="loading"><div class="spinner"></div><span>Loading transactions…</span></div>
    </div>
  </div>
</div>
${footerHTML()}

<script>
  function setTab(el) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
  }
  function copy(text) {
    navigator.clipboard.writeText(text).then(() => {
      document.querySelectorAll('.copy-btn,.copy-btn-hero').forEach(b => {
        if (b.getAttribute('onclick')?.includes(text.slice(0,8))) {
          const orig = b.textContent;
          b.textContent = 'copied!';
          setTimeout(() => b.textContent = orig, 1500);
        }
      });
    });
  }
</script>
</body></html>`;
}

// ── Blocks list HTML ──────────────────────────────────────────────────────────

export function blocksTableHTML(blocks, page, totalPages, limit, chainHeight) {
  const rows = blocks
    .map((b) => {
      const date = nemDate(b.timeStamp);
      const txns = Array.isArray(b.transactions) ? b.transactions.length : 0;
      return `<tr>
      <td><div class="blk-cell">
        <a href="/block/${b.height}" class="blk-num">${b.height}</a>
      </div></td>
      <td><div class="age-rel">${timeAgo(date)}</div>
          <div class="age-abs">${date.toISOString().slice(0, 19).replace("T", " ")} UTC</div></td>
      <td><span class="txn-pill ${txns > 0 ? "txn-pos" : "txn-zero"}">${txns}</span></td>
      <td>${((a) => `<a href="/account/${a}" class="harv" title="${a}">${truncKey(a)}</a>`)(pubKeyToAddress(b.signer) ?? b.signer)}</td>
      <td class="diff-val">${formatDiff(b.difficulty)}</td>
      <td class="fee-val">${xem(b.totalFee)} XEM</td>
    </tr>`;
    })
    .join("");

  const htmx = (p) =>
    `hx-get="/api/blocks?page=${p}&limit=${limit}" hx-target="#blocks-card" hx-swap="innerHTML"`;
  const pBtn = (lbl, p, off) =>
    off
      ? `<span class="p-btn off">${lbl}</span>`
      : `<a class="p-btn" ${htmx(p)} href="#"><span class="lm-text">${lbl}</span><span class="lm-spinner"></span></a>`;
  const rItem = (n) =>
    `<a class="rows-menu-item${n === limit ? " active" : ""}" hx-get="/api/blocks?page=1&limit=${n}" hx-target="#blocks-card" hx-swap="innerHTML" href="#" role="menuitem">${n}</a>`;
  const rowsCtrl = `
      <div class="rows-ctrl">
        <span class="rows-ctrl-label">Show:</span>
        <div class="rows-switch">
          <button type="button" class="rows-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleRowsMenu(event)" title="Rows per page">
            <span class="rows-switch-label">${limit}</span>
            <span class="rows-switch-caret">&#9662;</span>
          </button>
          <div class="rows-menu" role="menu" aria-label="Rows per page">
            ${[10, 25, 50, 100].map(rItem).join("")}
          </div>
        </div>
      </div>`;

  return `
  <div class="card-head">
    <div class="card-title">Latest Blocks <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    <div class="card-head-right">
      <span class="total-txt">Total of <strong>${chainHeight}</strong> blocks</span>
      ${rowsCtrl}
    </div>
  </div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>Block</th><th>Age</th><th>Txns</th><th>Harvester</th><th>Difficulty</th><th>Fee (XEM)</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <div class="tbl-foot">
    <div class="pag-ctrl">
      <span class="pg-info">Page <strong>${page}</strong> of <strong>${totalPages.toLocaleString()}</strong></span>
      ${pBtn("« First", 1, page <= 1)} ${pBtn("‹ Prev", page - 1, page <= 1)}
      ${pBtn("Next ›", page + 1, page >= totalPages)} ${pBtn("Last »", totalPages, page >= totalPages)}
    </div>
  </div>`;
}

// ── Block detail HTML ─────────────────────────────────────────────────────────

export function blockDetailHTML(block, chainHeight) {
  const date = nemDate(block.timeStamp);
  const txns = Array.isArray(block.transactions) ? block.transactions : [];
  const prevHash = block.prevBlockHash?.data ?? "—";

  const ovRows = [
    ["Block Height", `<span class="mono">${block.height}</span>`],
    ["Status", `<span class="status-ok">✓ Confirmed</span>`],
    [
      "Timestamp",
      `${timeAgo(date)} <span class="muted">(${date.toISOString().slice(0, 19).replace("T", " ")} UTC)</span>`,
    ],
    [
      "Transactions",
      txns.length > 0
        ? `<strong>${txns.length}</strong> <span class="muted">transaction${txns.length !== 1 ? "s" : ""}</span>`
        : `<span class="muted">None</span>`,
    ],
    [
      "Harvester",
      (() => {
        const a = pubKeyToAddress(block.signer) ?? block.signer;
        return `<a href="/account/${a}" class="mono-link" title="${a}">${truncKey(a)}</a> <button class="copy-btn" onclick="copy('${a}')">copy</button>`;
      })(),
    ],
    ["Difficulty", `<span class="mono">${formatDiff(block.difficulty)}</span>`],
    ["Total Fee", `<span class="fee-val">${xem(block.totalFee)} XEM</span>`],
    ["Block Type", block.type === 1 ? "Regular" : `Type ${block.type}`],
    [
      "Signature",
      `<span class="mono-muted">${truncHash(block.signature)}</span> <button class="copy-btn" onclick="copy('${block.signature}')">copy</button>`,
    ],
    [
      "Prev Block Hash",
      block.height > 1
        ? `<a href="/block/${block.height - 1}" class="mono-link">${truncHash(prevHash)}</a> <button class="copy-btn" onclick="copy('${prevHash}')">copy</button>`
        : '<span class="muted">—</span>',
    ],
  ]
    .map(
      ([l, v]) =>
        `<div class="ov-row"><div class="ov-label">${l}</div><div class="ov-value">${v}</div></div>`,
    )
    .join("");

  const txSection =
    txns.length === 0
      ? ""
      : (() => {
          const txRows = txns
            .map((tx, i) => {
              const isT = tx.type === 257;
              const senderAddr = pubKeyToAddress(tx.signer) ?? tx.signer;
              const recip = isT
                ? `<a href="/account/${tx.recipient}" class="mono-link">${truncKey(tx.recipient)}</a>`
                : "—";
              const amt = isT ? `${xem(tx.amount)} XEM` : "—";
              const msg = decodeMsg(tx.message);
              const d = {
                idx: i + 1,
                type: TX_TYPES[tx.type] || `Type ${tx.type}`,
                sender: senderAddr,
                recipient: isT ? tx.recipient : "",
                amount: isT ? `${xem(tx.amount)} XEM` : "",
                fee: `${xem(tx.fee)} XEM`,
                time: `${nemDate(tx.timeStamp).toISOString().slice(0, 19).replace("T", " ")} UTC`,
                message: msg,
                signature: tx.signature,
              };
              const attrs = Object.entries(d)
                .map(([k, v]) => `data-${k}="${esc(v)}"`)
                .join(" ");
              return `<tr class="tx-row" ${attrs} onclick="showTxDetail(this)">
        <td class="td-num">${i + 1}</td>
        <td><span class="type-pill ${isT ? "type-transfer" : "type-other"}">${TX_TYPES[tx.type] || `Type ${tx.type}`}</span></td>
        <td><a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${truncKey(senderAddr)}</a></td>
        <td>${recip}</td>
        <td class="td-right mono">${amt}</td>
        <td class="td-right fee-val">${xem(tx.fee)} XEM</td>
        <td>${msg ? `<span class="msg-text" title="${msg}">${msg.length > 24 ? msg.slice(0, 24) + "…" : msg}</span>` : ""}</td>
      </tr>`;
            })
            .join("");
          return `<div style="margin-top:16px;" class="card">
      <div class="card-head">
        <div class="card-title">Transactions <span class="count-badge">${txns.length}</span></div>
        <span class="total-txt">Click a row to view details</span>
      </div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>#</th><th>Type</th><th>Sender</th><th>Recipient</th><th class="th-right">Amount</th><th class="th-right">Fee</th><th>Message</th></tr></thead>
        <tbody>${txRows}</tbody>
      </table></div>
    </div>
    <div class="card tx-detail-card" id="txDetailCard" style="display:none; margin-top:16px;">
      <div class="card-head">
        <div class="card-title">Transaction Detail</div>
        <button type="button" class="copy-btn" onclick="document.getElementById('txDetailCard').style.display='none'; document.querySelectorAll('.tx-row.active').forEach(r=>r.classList.remove('active'));">close</button>
      </div>
      <div class="ov-list" id="txDetailBody"></div>
    </div>
    <script>
      function showTxDetail(row) {
        var d = row.dataset;
        document.querySelectorAll('.tx-row.active').forEach(function(r){ r.classList.remove('active'); });
        row.classList.add('active');
        var blockHeight = ${block.height};
        var rows = [
          ['#', '<span class="mono">'+d.idx+'</span>'],
          ['Block', '<a href="/block/'+blockHeight+'" class="mono-link">'+blockHeight.toLocaleString()+'</a>'],
          ['Timestamp', '<span class="mono-muted">'+d.time+'</span>'],
          ['Type', '<span class="type-pill '+(d.recipient ? 'type-transfer' : 'type-other')+'">'+d.type+'</span>'],
          ['Sender', '<a href="/account/'+d.sender+'" class="mono-link" title="'+d.sender+'">'+d.sender+'</a> <button class="copy-btn" onclick="copy(\\''+d.sender+'\\')">copy</button>'],
          ['Recipient', d.recipient ? ('<a href="/account/'+d.recipient+'" class="mono-link" title="'+d.recipient+'">'+d.recipient+'</a> <button class="copy-btn" onclick="copy(\\''+d.recipient+'\\')">copy</button>') : '<span class="muted">—</span>'],
          ['Amount', d.amount ? '<span class="mono">'+d.amount+'</span>' : '<span class="muted">—</span>'],
          ['Fee', '<span class="fee-val">'+d.fee+'</span>'],
          ['Message', d.message ? '<span class="msg-text">'+d.message+'</span>' : '<span class="muted">(no message)</span>'],
          ['Signature', '<span class="mono-muted">'+d.signature.slice(0,10)+'…'+d.signature.slice(-6)+'</span> <button class="copy-btn" onclick="copy(\\''+d.signature+'\\')">copy</button>'],
        ];
        document.getElementById('txDetailBody').innerHTML = rows.map(function(r){
          return '<div class="ov-row"><div class="ov-label">'+r[0]+'</div><div class="ov-value">'+r[1]+'</div></div>';
        }).join('');
        var card = document.getElementById('txDetailCard');
        card.style.display = 'block';
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    </script>`;
        })();

  return `
  <div class="card-head">
    <div class="card-title">Overview</div>
    <span class="total-txt">Block <strong>${block.height}</strong> of <strong>${chainHeight}</strong></span>
  </div>
  <div class="ov-list">${ovRows}</div>
  ${txSection}
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

// ── Transaction detail HTML ───────────────────────────────────────────────────

export function txDetailHTML(tx, hash, height) {
  const date = nemDate(tx.timeStamp);
  const isT = tx.type === 257;
  const senderAddr = pubKeyToAddress(tx.signer) ?? tx.signer;
  const msg = decodeMsg(tx.message);

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
      `<span class="type-pill ${isT ? "type-transfer" : "type-other"}">${TX_TYPES[tx.type] || `Type ${tx.type}`}</span>`,
    ],
    [
      "Sender",
      `<a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${senderAddr}</a> <button class="copy-btn" onclick="copy('${senderAddr}')">copy</button>`,
    ],
    [
      "Recipient",
      isT
        ? `<a href="/account/${tx.recipient}" class="mono-link" title="${tx.recipient}">${tx.recipient}</a> <button class="copy-btn" onclick="copy('${tx.recipient}')">copy</button>`
        : '<span class="muted">—</span>',
    ],
    [
      "Amount",
      isT
        ? `<span class="mono">${xem(tx.amount)} XEM</span>`
        : '<span class="muted">—</span>',
    ],
    ["Fee", `<span class="fee-val">${xem(tx.fee)} XEM</span>`],
    [
      "Message",
      msg
        ? `<span class="msg-text" style="white-space:normal; max-width:none;">${msg}</span>`
        : '<span class="muted">(no message)</span>',
    ],
    [
      "Signature",
      `<span class="mono-muted">${truncHash(tx.signature)}</span> <button class="copy-btn" onclick="copy('${tx.signature}')">copy</button>`,
    ],
  ]
    .map(
      ([l, v]) =>
        `<div class="ov-row"><div class="ov-label">${l}</div><div class="ov-value">${v}</div></div>`,
    )
    .join("");

  return `
  <div class="card-head">
    <div class="card-title">Overview</div>
  </div>
  <div class="ov-list">${rows}</div>
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

export function txNotFoundHTML(hash) {
  return `<div class="error-state">
    <div class="error-icon">⚠</div>
    <p class="error-title">Transaction not found</p>
    <p class="error-msg">Hash <span class="mono">${truncHash(hash)}</span> wasn't found in the connected nodes' cache.
      Public NIS1 nodes only keep hash lookups for very recent / unconfirmed transactions — older
      transactions can't be located by hash alone without a dedicated indexing service. Try opening
      the transaction from its block or account page instead.</p>
  </div>`;
}

// ── Account overview HTML ─────────────────────────────────────────────────────

export function accountOverviewHTML(data, address) {
  const a = data.account;
  const m = data.meta;

  const statusLabel =
    m.status === "UNLOCKED"
      ? `<span class="status-ok">● Unlocked (Harvesting)</span>`
      : `<span class="status-lock">● Locked</span>`;

  const pkCell = a.publicKey
    ? `<span class="mono-muted">${truncHash(a.publicKey)}</span> <button class="copy-btn" onclick="copy('${a.publicKey}')">copy</button>`
    : `<span class="muted">Not yet published</span>`;

  const cosigRows = m.cosignatories?.length
    ? [
        [
          "Cosignatories",
          m.cosignatories
            .map(
              (c) =>
                `<a href="/account/${c.address}" class="mono-link">${truncKey(c.address)}</a>`,
            )
            .join("<br>"),
        ],
      ]
    : [];

  const rows = [
    [
      "Address",
      `<span class="mono">${a.address}</span> <button class="copy-btn" onclick="copy('${a.address}')">copy</button>`,
    ],
    [
      "Balance",
      `<span class="bal-amount">${xem(a.balance)}</span> <span class="bal-unit">XEM</span>`,
    ],
    ["Vested Balance", `${xem(a.vestedBalance)} XEM`],
    [
      "Importance",
      `<span class="importance-val">${formatImportance(a.importance)}</span>`,
    ],
    ["Harvested Blocks", (a.harvestedBlocks || 0).toLocaleString()],
    ["Public Key", pkCell],
    ["Account Status", statusLabel],
    ...cosigRows,
  ]
    .map(
      ([l, v]) =>
        `<div class="ov-row"><div class="ov-label">${l}</div><div class="ov-value">${v}</div></div>`,
    )
    .join("");

  return `
  <div class="card">
    <div class="acct-balance-hero">
      <div class="bal-panel">
        <div class="bal-label">XEM Balance</div>
        <div class="bal-amount-lg">${xem(a.balance)} <span class="bal-unit">XEM</span></div>
      </div>
      <div class="bal-panel">
        <div class="bal-label">Vested Balance</div>
        <div class="bal-amount-sm">${xem(a.vestedBalance)} XEM</div>
      </div>
      <div class="bal-panel">
        <div class="bal-label">Importance Score</div>
        <div class="importance-val-lg">${formatImportance(a.importance)}</div>
      </div>
    </div>
    <div class="ov-list">${rows}</div>
  </div>`;
}

// ── Transaction table HTML ────────────────────────────────────────────────────

export function renderTxRow(pair, accountAddress) {
  const tx = pair.transaction;
  const meta = pair.meta;
  const date = nemDate(tx.timeStamp);
  const hash = meta.hash?.data || "";
  const isTransfer = tx.type === 257;
  const isIncoming = isTransfer && tx.recipient === accountAddress;

  const senderAddr = pubKeyToAddress(tx.signer) ?? tx.signer;
  let dirBadge, fromCell, toCell, amountCell;
  if (isTransfer) {
    if (isIncoming) {
      dirBadge = `<span class="dir-in">▼ IN</span>`;
      fromCell = `<a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${truncKey(senderAddr)}</a>`;
      toCell = `<span class="mono self-addr" title="${accountAddress}">${truncKey(accountAddress)}</span>`;
      amountCell = `<span class="tx-in">+${xem(tx.amount)}</span>`;
    } else {
      dirBadge = `<span class="dir-out">▲ OUT</span>`;
      fromCell = `<span class="mono self-addr" title="${accountAddress}">${truncKey(accountAddress)}</span>`;
      toCell = `<a href="/account/${tx.recipient}" class="mono-link" title="${tx.recipient}">${truncKey(tx.recipient)}</a>`;
      amountCell = `<span class="tx-out">-${xem(tx.amount)}</span>`;
    }
  } else {
    dirBadge = `<span class="dir-other">${TX_TYPES[tx.type] || `T${tx.type}`}</span>`;
    fromCell = `<a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${truncKey(senderAddr)}</a>`;
    toCell = `<span class="muted">—</span>`;
    amountCell = `<span class="muted">—</span>`;
  }

  return `<tr>
    <td>${dirBadge}</td>
    <td><a href="/tx/${hash}?height=${meta.height}&ts=${tx.timeStamp}" class="tx-hash" title="${hash}">${truncHash(hash)}</a></td>
    <td><a href="/block/${meta.height}" class="blk-link">${meta.height || 0}</a></td>
    <td><div class="age-rel">${timeAgo(date)}</div><div class="age-abs">${date.toISOString().slice(0, 16).replace("T", " ")} UTC</div></td>
    <td>${fromCell}</td>
    <td>${toCell}</td>
    <td class="td-right">${amountCell}</td>
    <td class="td-right fee-val">${xem(tx.fee)} XEM</td>
  </tr>`;
}

export function loadMoreRow(txs, address) {
  if (txs.length < 25) return "";
  const lastId = txs[txs.length - 1]?.meta?.id ?? "";
  return `<tr id="load-more-row"><td colspan="7" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/account/${address}/txs/more?id=${lastId}"
            hx-target="#load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

export function txTableHTML(txs, address) {
  if (!txs.length)
    return `<div class="empty-state">No transactions found</div>`;
  return `<div class="tbl-wrap"><table>
    <thead><tr>
      <th>Type</th><th>Txn Hash</th><th>Block</th><th>Age</th>
      <th>From</th><th>To</th><th class="th-right">Amount (XEM)</th><th class="th-right">Fee</th>
    </tr></thead>
    <tbody>${txs.map((p) => renderTxRow(p, address)).join("")}${loadMoreRow(txs, address)}</tbody>
  </table></div>`;
}

export function txMoreRows(txs, address) {
  if (!txs.length) return "";
  return (
    txs.map((p) => renderTxRow(p, address)).join("") + loadMoreRow(txs, address)
  );
}

// ── Global transactions list HTML ─────────────────────────────────────────────

export function renderGlobalTxRow(item) {
  const { tx, height, blockTime } = item;
  const date = nemDate(blockTime);
  const isTransfer = tx.type === 257;
  const senderAddr = pubKeyToAddress(tx.signer) ?? tx.signer;

  const toCell = isTransfer
    ? `<a href="/account/${tx.recipient}" class="mono-link" title="${tx.recipient}">${truncKey(tx.recipient)}</a>`
    : `<span class="muted">—</span>`;
  const amountCell = isTransfer
    ? `${xem(tx.amount)} XEM`
    : `<span class="muted">—</span>`;

  return `<tr>
    <td><a href="/block/${height}" class="blk-link">${height}</a></td>
    <td><a href="/account/${senderAddr}" class="mono-link" title="${senderAddr}">${truncKey(senderAddr)}</a></td>
    <td>${toCell}</td>
    <td><span class="type-pill ${isTransfer ? "type-transfer" : "type-other"}">${TX_TYPES[tx.type] || `Type ${tx.type}`}</span></td>
    <td class="td-right">${amountCell}</td>
    <td class="td-right fee-val">${xem(tx.fee)} XEM</td>
    <td class="mono-muted">${date.toISOString().slice(0, 16).replace("T", " ")} UTC</td>
    <td>${timeAgo(date)}</td>
  </tr>`;
}

export function globalLoadMoreRow(nextFromBlock) {
  if (nextFromBlock < 1) return "";
  return `<tr id="txs-load-more-row"><td colspan="7" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/txs/more?fromBlock=${nextFromBlock}"
            hx-target="#txs-load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

export function globalTxTableHTML(items, chainHeight, nextFromBlock) {
  if (!items.length)
    return `<div class="empty-state">No transactions found in recent blocks</div>`;
  return `
  <div class="card-head">
    <div class="card-title">Latest Transactions <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    <span class="total-txt">Chain height: <strong>${chainHeight}</strong></span>
  </div>
  <div class="tbl-wrap"><table>
    <thead><tr>
      <th>Block</th><th>Sender</th><th>Recipient</th><th>Type</th>
      <th class="th-right">Amount (XEM)</th><th class="th-right">Fee</th><th>Timestamp</th><th>Age</th>
    </tr></thead>
    <tbody>${items.map(renderGlobalTxRow).join("")}${globalLoadMoreRow(nextFromBlock)}</tbody>
  </table></div>`;
}

export function globalTxMoreRows(items, nextFromBlock) {
  if (!items.length) return "";
  return (
    items.map(renderGlobalTxRow).join("") + globalLoadMoreRow(nextFromBlock)
  );
}

// ── Harvests / Mosaics / Namespaces HTML ──────────────────────────────────────

export function harvestsHTML(data) {
  if (!data.length)
    return `<div class="empty-state">No harvested blocks found</div>`;
  const rows = data
    .map((h) => {
      const date = nemDate(h.timeStamp);
      return `<tr>
      <td><a href="/block/${h.height}" class="blk-link">${h.height}</a></td>
      <td><div class="age-rel">${timeAgo(date)}</div><div class="age-abs">${date.toISOString().slice(0, 19).replace("T", " ")} UTC</div></td>
      <td class="diff-val">${formatDiff(h.difficulty)}</td>
      <td class="td-right fee-val">${xem(h.totalFee)} XEM</td>
    </tr>`;
    })
    .join("");
  return `<div class="tbl-wrap"><table>
    <thead><tr><th>Block</th><th>Age</th><th>Difficulty</th><th class="th-right">Fee (XEM)</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export function mosaicsHTML(data) {
  if (!data.length) return `<div class="empty-state">No mosaics owned</div>`;
  const rows = data
    .map(
      (m, i) => `<tr>
    <td class="td-num">${i + 1}</td>
    <td><span class="mosaic-id">${esc(m.mosaicId.namespaceId)}:<strong>${esc(m.mosaicId.name)}</strong></span></td>
    <td class="td-right mono">${m.quantity.toLocaleString()}</td>
  </tr>`,
    )
    .join("");
  return `<div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Mosaic</th><th class="th-right">Quantity</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export function namespacesHTML(data) {
  if (!data.length) return `<div class="empty-state">No namespaces owned</div>`;
  const rows = data
    .map(
      (ns, i) => `<tr>
    <td class="td-num">${i + 1}</td>
    <td><span class="mono">${esc(ns.fqn)}</span></td>
    <td><a href="/block/${ns.height}" class="blk-link">${ns.height}</a></td>
  </tr>`,
    )
    .join("");
  return `<div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Namespace</th><th>Registered at Block</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// ── Global namespaces list HTML ───────────────────────────────────────────────

export function renderNamespaceRow(ns, num) {
  return `<tr>
    <td class="td-num">${num}</td>
    <td><a href="/namespace/${encodeURIComponent(ns.fqn)}" class="mono-link" title="${esc(ns.fqn)}">${esc(ns.fqn)}</a></td>
    <td><a href="/account/${ns.owner}" class="mono-link" title="${ns.owner}">${truncKey(ns.owner)}</a></td>
    <td><a href="/block/${ns.height}" class="blk-link">${ns.height}</a></td>
  </tr>`;
}

export function namespaceLoadMoreRow(offset, total, limit) {
  if (offset >= total) return "";
  return `<tr id="ns-load-more-row"><td colspan="4" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/namespaces/more?offset=${offset}&limit=${limit}"
            hx-target="#ns-load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

export function namespaceMoreRows(items, offset, total, limit) {
  if (!items.length) return "";
  return (
    items.map((ns, i) => renderNamespaceRow(ns, offset + i + 1)).join("") +
    namespaceLoadMoreRow(offset + items.length, total, limit)
  );
}

export function namespacesListHTML(items, updatedAt, limit) {
  if (!items.length)
    return `<div class="empty-state">No namespaces found</div>`;
  const cacheNote = updatedAt
    ? `Cached ${timeAgo(new Date(Number(updatedAt)))}`
    : "Cached just now";
  const total = getNamespacesWithArchiveCount();
  const rItem = (n) =>
    `<a class="rows-menu-item${n === limit ? " active" : ""}" hx-get="/api/namespaces?limit=${n}" hx-target="#namespaces-card" hx-swap="innerHTML" href="#" role="menuitem">${n}</a>`;
  const rowsCtrl = `
      <div class="rows-ctrl">
        <span class="rows-ctrl-label">Show:</span>
        <div class="rows-switch">
          <button type="button" class="rows-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleRowsMenu(event)" title="Rows per page">
            <span class="rows-switch-label">${limit}</span>
            <span class="rows-switch-caret">&#9662;</span>
          </button>
          <div class="rows-menu" role="menu" aria-label="Rows per page">
            ${[10, 25, 50, 100].map(rItem).join("")}
          </div>
        </div>
      </div>`;
  return `
  <div class="card-head">
    <div class="card-title">Registered Namespaces</div>
    <div class="card-head-right">
      <span class="total-txt">${cacheNote} · <strong>${total}</strong> archived</span>
      ${rowsCtrl}
    </div>
  </div>
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>Older namespaces beyond the live node's recent window are backfilled from <a href="https://explorer.nemtool.com/" target="_blank" rel="noopener">explorer.nemtool.com</a>'s historical index (${getArchivedNamespacesCount().toLocaleString("en")} records) and may not reflect the current on-chain state.</p>
  <div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Namespace</th><th>Owner</th><th>Registered at Block</th></tr></thead>
    <tbody>${items.map((ns, i) => renderNamespaceRow(ns, i + 1)).join("")}${namespaceLoadMoreRow(items.length, total, limit)}</tbody>
  </table></div>`;
}

// ── Mosaic detail HTML ────────────────────────────────────────────────────────

export function mosaicNotFoundHTML(namespace, name) {
  return `<div class="error-state">
    <div class="error-icon">⚠</div>
    <p class="error-title">Mosaic not found</p>
    <p class="error-msg">Mosaic <span class="mono">${esc(namespace)}:${esc(name)}</span> wasn't found in the live cache or the historical index.</p>
  </div>`;
}

export function mosaicDetailHTML(m, liveData) {
  const owner = /^[0-9a-f]{64}$/i.test(m.creator)
    ? pubKeyToAddress(m.creator)
    : m.creator;
  const supply = (m.supply / Math.pow(10, m.divisibility)).toLocaleString(
    "en",
    {
      minimumFractionDigits: m.divisibility,
      maximumFractionDigits: m.divisibility,
    },
  );
  const liveProps = liveData
    ? Object.fromEntries(
        (liveData.properties || []).map((p) => [p.name, p.value]),
      )
    : null;
  const supplyMutable = liveProps
    ? liveProps.supplyMutable === "true"
      ? "Yes"
      : "No"
    : null;
  const levy = liveData?.levy;

  const mosaicUrl = `/mosaic/${m.namespace.split(".").join("/")}/${m.name}`;
  const ovRows = [
    [
      "Mosaic ID",
      `<span class="mono">${esc(m.namespace)}:<strong>${esc(m.name)}</strong></span> <button class="copy-btn" onclick="copy('${esc(m.namespace + ":" + m.name)}')">copy</button>`,
    ],
    [
      "Namespace",
      `<a href="/namespace/${encodeURIComponent(m.namespace)}" class="mono-link">${esc(m.namespace)}</a>`,
    ],
    [
      "Creator",
      `<a href="/account/${owner}" class="mono-link" title="${owner}">${truncKey(owner)}</a> <button class="copy-btn" onclick="copy('${owner}')">copy</button>`,
    ],
    [
      "Description",
      m.description ? esc(m.description) : `<span class="muted">—</span>`,
    ],
    ["Supply", `<span class="mono">${supply}</span>`],
    ["Divisibility", `<span class="mono">${m.divisibility}</span>`],
    [
      "Transferable",
      m.transferable
        ? `<span class="status-ok">Yes</span>`
        : `<span class="status-expired">No</span>`,
    ],
    ...(supplyMutable !== null
      ? [
          [
            "Supply Mutable",
            supplyMutable === "Yes"
              ? `<span class="status-ok">Yes</span>`
              : `<span class="status-expired">No</span>`,
          ],
        ]
      : []),
    ...(levy
      ? [
          [
            "Levy",
            `Type ${levy.type} · ${(levy.fee / 1e6).toFixed(6)} ${levy.mosaicId ? `${esc(levy.mosaicId.namespaceId)}:${esc(levy.mosaicId.name)}` : "XEM"} → <a href="/account/${levy.recipient}" class="mono-link">${truncKey(levy.recipient)}</a>`,
          ],
        ]
      : []),
    ...(m.height
      ? [
          [
            "Registered at Block",
            `<a href="/block/${m.height}" class="mono-link">${m.height}</a>`,
          ],
        ]
      : []),
    ...(m.time_stamp
      ? [
          [
            "Create Time",
            nemDate(m.time_stamp).toLocaleString("en", {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              timeZoneName: "short",
            }),
          ],
        ]
      : []),
  ]
    .map(
      ([l, v]) =>
        `<div class="ov-row"><div class="ov-label">${l}</div><div class="ov-value">${v}</div></div>`,
    )
    .join("");

  return `
  <div class="card-head">
    <div class="card-title">Overview</div>
  </div>
  <div class="ov-list">${ovRows}</div>
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

// ── Namespace detail HTML ─────────────────────────────────────────────────────

export function namespaceNotFoundHTML(fqn) {
  return `<div class="error-state">
    <div class="error-icon">⚠</div>
    <p class="error-title">Namespace not found</p>
    <p class="error-msg">Namespace <span class="mono">${esc(fqn)}</span> wasn't found in the live cache or
      the historical index mirrored from explorer.nemtool.com. It may not exist, may have expired and
      been pruned, or may have been registered too recently to appear in either source yet.</p>
  </div>`;
}

export function namespaceDetailHTML(ns, root, subNamespaces, mosaics) {
  const isRoot = ns.fqn === root;
  const ovRows = [
    [
      "Namespace",
      `<span class="mono">${esc(ns.fqn)}</span> <button class="copy-btn" onclick="copy('${esc(ns.fqn)}')">copy</button>`,
    ],
    [
      "Root Namespace",
      isRoot
        ? `<span class="mono">${esc(root)}</span>`
        : `<a href="/namespace/${encodeURIComponent(root)}" class="mono-link">${esc(root)}</a>`,
    ],
    [
      "Owner",
      `<a href="/account/${ns.owner}" class="mono-link" title="${ns.owner}">${truncKey(ns.owner)}</a> <button class="copy-btn" onclick="copy('${ns.owner}')">copy</button>`,
    ],
    [
      "Registered at Block",
      `<a href="/block/${ns.height}" class="mono-link">${ns.height}</a>`,
    ],
    [
      "Sub-namespaces",
      subNamespaces.length
        ? `<strong>${subNamespaces.length}</strong>`
        : `<span class="muted">None</span>`,
    ],
    [
      "Mosaics",
      mosaics.length
        ? `<strong>${mosaics.length}</strong>`
        : `<span class="muted">None</span>`,
    ],
  ]
    .map(
      ([l, v]) =>
        `<div class="ov-row"><div class="ov-label">${l}</div><div class="ov-value">${v}</div></div>`,
    )
    .join("");

  const subsSection = !subNamespaces.length
    ? ""
    : `<div class="card" style="margin-top:16px;">
    <div class="card-head">
      <div class="card-title">Sub-namespaces <span class="count-badge">${subNamespaces.length}</span></div>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Namespace</th><th>Owner</th><th>Registered at Block</th></tr></thead>
      <tbody>${subNamespaces.map((s, i) => renderNamespaceRow(s, i + 1)).join("")}</tbody>
    </table></div>
  </div>`;

  const mosaicsSection = !mosaics.length
    ? ""
    : `<div class="card" style="margin-top:16px;">
    <div class="card-head">
      <div class="card-title">Mosaics <span class="count-badge">${mosaics.length}</span></div>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Mosaic</th><th>Creator</th><th class="th-center">Transferable</th><th class="th-right">Supply</th><th class="th-right">Divisibility</th><th class="th-right">Create Time</th></tr></thead>
      <tbody>${mosaics.map((m, i) => renderMosaicRow(m, i + 1)).join("")}</tbody>
    </table></div>
  </div>`;

  return `
  <div class="card-head">
    <div class="card-title">Overview</div>
  </div>
  <div class="ov-list">${ovRows}</div>
  ${subsSection}
  ${mosaicsSection}
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

// ── Global mosaics list HTML ──────────────────────────────────────────────────

export function renderMosaicRow(m, num) {
  // Live rows store the creator as a hex public key; archive rows imported
  // from explorer.nemtool.com already give us the resolved address.
  const owner = /^[0-9a-f]{64}$/i.test(m.creator)
    ? pubKeyToAddress(m.creator)
    : m.creator;
  const supply = (m.supply / Math.pow(10, m.divisibility)).toLocaleString(
    "en",
    {
      minimumFractionDigits: m.divisibility,
      maximumFractionDigits: m.divisibility,
    },
  );
  const detailUrl = `/mosaic/${m.namespace.split(".").join("/")}/${m.name}`;
  const transferable = m.transferable
    ? `<span class="badge-yes">Yes</span>`
    : `<span class="badge-no">No</span>`;
  const createTime = m.time_stamp
    ? nemDate(m.time_stamp).toLocaleDateString("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : `<span class="muted">—</span>`;
  return `<tr>
    <td class="td-num">${num}</td>
    <td><a href="${detailUrl}" class="mosaic-id-link" title="${esc(m.namespace)}:${esc(m.name)}">${esc(m.namespace)}:<strong>${esc(m.name)}</strong></a></td>
    <td><a href="/account/${owner}" class="mono-link" title="${owner}">${truncKey(owner)}</a></td>
    <td class="td-center">${transferable}</td>
    <td class="td-right mono">${supply}</td>
    <td class="td-right mono">${m.divisibility}</td>
    <td class="td-right">${createTime}</td>
  </tr>`;
}

export function mosaicLoadMoreRow(offset, total, limit) {
  if (offset >= total) return "";
  return `<tr id="mos-load-more-row"><td colspan="7" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/mosaics/more?offset=${offset}&limit=${limit}"
            hx-target="#mos-load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

export function mosaicMoreRows(items, offset, total, limit) {
  if (!items.length) return "";
  return (
    items.map((m, i) => renderMosaicRow(m, offset + i + 1)).join("") +
    mosaicLoadMoreRow(offset + items.length, total, limit)
  );
}

export function mosaicsListHTML(items, updatedAt, limit) {
  if (!items.length) return `<div class="empty-state">No mosaics found</div>`;
  const deepAt = getCacheMeta("mosaics_deep_updated_at");
  const cacheNote =
    (updatedAt
      ? `Quick ${timeAgo(new Date(Number(updatedAt)))}`
      : "Quick: just now") +
    (deepAt
      ? ` · Deep ${timeAgo(new Date(Number(deepAt)))}`
      : " · Deep: pending");
  const total = getMosaicsWithArchiveCount();
  const rItem = (n) =>
    `<a class="rows-menu-item${n === limit ? " active" : ""}" hx-get="/api/mosaics?limit=${n}" hx-target="#mosaics-card" hx-swap="innerHTML" href="#" role="menuitem">${n}</a>`;
  const rowsCtrl = `
      <div class="rows-ctrl">
        <span class="rows-ctrl-label">Show:</span>
        <div class="rows-switch">
          <button type="button" class="rows-switch-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleRowsMenu(event)" title="Rows per page">
            <span class="rows-switch-label">${limit}</span>
            <span class="rows-switch-caret">&#9662;</span>
          </button>
          <div class="rows-menu" role="menu" aria-label="Rows per page">
            ${[10, 25, 50, 100].map(rItem).join("")}
          </div>
        </div>
      </div>`;
  return `
  <div class="card-head">
    <div class="card-title">Mosaics</div>
    <div class="card-head-right">
      <span class="total-txt">${cacheNote} · <strong>${total}</strong> archived</span>
      ${rowsCtrl}
    </div>
  </div>
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>Older mosaics beyond the live node's recent window are backfilled from <a href="https://explorer.nemtool.com/" target="_blank" rel="noopener">explorer.nemtool.com</a>'s historical index (${getArchivedMosaicsCount().toLocaleString("en")} records) and may not reflect the current on-chain state.</p>
  <div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Mosaic</th><th>Creator</th><th class="th-center">Transferable</th><th class="th-right">Supply</th><th class="th-right">Divisibility</th><th class="th-right">Create Time</th></tr></thead>
    <tbody>${items.map((m, i) => renderMosaicRow(m, i + 1)).join("")}${mosaicLoadMoreRow(items.length, total, limit)}</tbody>
  </table></div>`;
}

// ── Supernodes list HTML ──────────────────────────────────────────────────────

export function renderNodeRow(n, num) {
  let host = n.endpoint,
    link = n.endpoint;
  try {
    const u = new URL(n.endpoint);
    host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {}
  return `<tr>
    <td class="td-num">${num}</td>
    <td>${esc(n.name || "—")}</td>
    <td><a href="${esc(link)}" class="mono-link" target="_blank" rel="noopener">${esc(host)}</a></td>
    <td><span class="status-ok">● Active</span></td>
  </tr>`;
}

export function nodesListHTML(nodes) {
  if (!nodes.length)
    return `<div class="empty-state">No active supernodes found</div>`;
  return `
  <div class="card-head">
    <div class="card-title">Active Supernodes <span class="live-pill"><span class="live-dot"></span>Live</span></div>
    <span class="total-txt"><strong>${nodes.length}</strong> active</span>
  </div>
  <p class="archive-note"><span class="archive-note-icon">&#9432;</span>The node information on this page is sourced from <a href="https://nem.io/supernodes/" target="_blank" rel="noopener">nem.io/supernode</a>.</p>
  <div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Name</th><th>Endpoint</th><th>Status</th></tr></thead>
    <tbody>${nodes.map((n, i) => renderNodeRow(n, i + 1)).join("")}</tbody>
  </table></div>`;
}

// ── Rich list (accounts) HTML ─────────────────────────────────────────────────

export function renderAccountRow(a, num) {
  return `<tr>
    <td class="td-num">${num}</td>
    <td><a href="/account/${a.address}" class="mono-link" title="${a.address}">${truncKey(a.address)}</a></td>
    <td class="td-right mono">${xem(a.balance)} XEM</td>
    <td class="td-right mono">${formatImportance(a.importance)}</td>
    <td>${a.info ? esc(a.info) : '<span class="muted">—</span>'}</td>
  </tr>`;
}

export function accountLoadMoreRow(offset, total) {
  if (offset >= total) return "";
  return `<tr id="acc-load-more-row"><td colspan="5" class="load-more-cell">
    <button class="load-more-btn"
            hx-get="/api/accounts/more?offset=${offset}"
            hx-target="#acc-load-more-row" hx-swap="outerHTML">
      <span class="lm-text">Load More</span><span class="lm-spinner"></span>
    </button>
  </td></tr>`;
}

export function accountMoreRows(items, offset, total) {
  if (!items.length) return "";
  return (
    items.map((a, i) => renderAccountRow(a, offset + i + 1)).join("") +
    accountLoadMoreRow(offset + items.length, total)
  );
}

export function accountsListHTML(items, updatedAt, total) {
  if (!items.length) return `<div class="empty-state">No accounts found</div>`;
  const liveNote = updatedAt
    ? `Live · ranking refreshed ${timeAgo(new Date(Number(updatedAt)))}`
    : "Live · ranking refreshing…";
  return `
  <div class="card-head">
    <div class="card-title">Rich List</div>
    <span class="total-txt">${liveNote} · top <strong>${total.toLocaleString()}</strong> accounts by current on-chain balance</span>
  </div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Address</th><th class="th-right">Balance</th><th class="th-right">Importance</th><th>Info</th></tr></thead>
    <tbody>${items.map((a, i) => renderAccountRow(a, i + 1)).join("")}${accountLoadMoreRow(items.length, total)}</tbody>
  </table></div>`;
}
