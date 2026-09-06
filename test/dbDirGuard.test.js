import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression tests for the NEMSCAN_DB_DIR guard in src/db.js. Spawns a fresh
// child process per case (rather than importing db.js in-process) because
// the guard fires once at module-evaluation time, and because db.js's
// module body unconditionally opens both cache.db/cache-testnet.db as a
// side effect — a case must run with cwd pointed at a scratch directory
// whenever it's expected to fall through to actually opening a DB file, so
// this never touches the real cache.db/cache-testnet.db in the repo root.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Imports db.js by absolute file:// URL rather than a "./src/db.js"
// relative specifier, so the caller can freely point `cwd` at a scratch
// directory (to control where db.js's relative "./cache.db" path resolves)
// without that also breaking module resolution for the import itself.
const dbJsUrl = new URL("src/db.js", `file://${repoRoot}`).href;

function importDb(env, cwd) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(dbJsUrl)}); console.log('OK');`],
    { cwd, env, encoding: "utf8" },
  );
}

test("db.js throws immediately when NODE_TEST_CONTEXT is set but NEMSCAN_DB_DIR isn't — the exact conditions that let a test silently write into the real cache.db", () => {
  const env = { ...process.env, NODE_TEST_CONTEXT: "child-v8" };
  delete env.NEMSCAN_DB_DIR;
  // cwd is irrelevant here: the guard must throw before db.js ever reaches
  // new DatabaseSync(), so repoRoot is safe to use even though "." would
  // otherwise resolve to the real cache.db.
  const result = importDb(env, repoRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEMSCAN_DB_DIR/);
});

test("db.js does not throw outside of node --test (NODE_TEST_CONTEXT unset), even with NEMSCAN_DB_DIR unset — normal server startup is unaffected", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NEMSCAN_DB_DIR;
  // The guard is inert here, so db.js proceeds to actually open "./cache.db"
  // relative to cwd — point cwd at a scratch directory so this can't touch
  // the real repo cache.db.
  const scratchDir = mkdtempSync(join(tmpdir(), "nemscan-dbguard-test-"));
  const result = importDb(env, scratchDir);
  assert.equal(result.status, 0);
});

test("db.js does not throw when both NODE_TEST_CONTEXT and NEMSCAN_DB_DIR are set — the correct, existing test setup", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "nemscan-dbguard-test-"));
  const env = { ...process.env, NODE_TEST_CONTEXT: "child-v8", NEMSCAN_DB_DIR: scratchDir };
  const result = importDb(env, repoRoot);
  assert.equal(result.status, 0);
});

test("constants.js alone (no db.js) is unaffected by the guard even with NODE_TEST_CONTEXT set and NEMSCAN_DB_DIR unset — files that never open a DB connection (helpers.test.js, nodePool.test.js) stay unaffected", () => {
  const env = { ...process.env, NODE_TEST_CONTEXT: "child-v8" };
  delete env.NEMSCAN_DB_DIR;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "await import('./src/constants.js'); console.log('OK');"],
    { cwd: repoRoot, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
});
