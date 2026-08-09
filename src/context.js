import { AsyncLocalStorage } from "node:async_hooks";

// Carries the per-request "preferred connection node" (chosen via the navbar's
// node-switch dropdown and sent back as a cookie) through to nemFetch(), without
// threading it through every route handler and HTML builder by hand.
export const nodeContext = new AsyncLocalStorage();

// Carries the per-request selected network ("mainnet" | "testnet"), chosen via
// the navbar's network-switch dropdown and sent back as the nemscan-network
// cookie. Read by nodePool.js, db.js, cache.js, and html.js so each resolves
// the right node pool / SQLite file / address byte without threading an extra
// parameter through every function call.
export const networkContext = new AsyncLocalStorage();

export function currentNetwork() {
  return networkContext.getStore() === "testnet" ? "testnet" : "mainnet";
}
