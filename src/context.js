import { AsyncLocalStorage } from "node:async_hooks";

// Carries the per-request "preferred connection node" (chosen via the navbar's
// node-switch dropdown and sent back as a cookie) through to nemFetch(), without
// threading it through every route handler and HTML builder by hand.
export const nodeContext = new AsyncLocalStorage();
