import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { LOGGING_MODES, readLoggingState, setLoggingState, withLoggingRestored, durabilityPlan } from "../logging.mjs";
import { validateDurabilityRuns, mergeDurabilityReport } from "../analytics.mjs";
import { createSysbenchArguments, SCENARIO_ORDER, PATHS } from "../lib.mjs";

function database(initial = { logBinEnabled: true, flushLogAtTransactionCommit: 1, syncBinlog: 1, flushLogAtTimeout: 1 }) {
  const state = { ...initial };
  const writes = [];
  const names = { innodb_flush_log_at_trx_commit: "flushLogAtTransactionCommit", sync_binlog: "syncBinlog",
    innodb_flush_log_at_timeout: "flushLogAtTimeout" };
  return {
    state, writes,
    query: async (sql) => {
      if (sql.startsWith("SET")) {
        writes.push(sql);
        for (const match of sql.matchAll(/(innodb_flush_log_at_trx_commit|sync_binlog|innodb_flush_log_at_timeout)=(\d+)/g)) {
          state[names[match[1]]] = Number(match[2]);
        }
        return "";
      }
      return `${Number(state.logBinEnabled)}\t${state.flushLogAtTransactionCommit}\t${state.syncBinlog}\t${state.flushLogAtTimeout}`;
    },
  };
}

test("modes reuse the same SQL and preserve default MVP scenarios", () => {
  const env = { MYSQL_ROOT_PASSWORD: "test", MYSQL_DATABASE: "sbtest", TABLE_COUNT: 10, TABLE_SIZE: 100000 };
  const args = (scenario) => createSysbenchArguments({ env, scenario, command: "run", concurrency: 1, durationSeconds: 120 });
  assert.deepEqual(args("update_index"), args("update_index_async"));
  assert.deepEqual(SCENARIO_ORDER, ["point_select", "update_index", "read_write"]);
  assert.equal(LOGGING_MODES.update_index_async.syncBinlog, 0);
  assert.equal(LOGGING_MODES.update_index_async.flushLogAtTransactionCommit, 2);
});

test("logging parameters are read, verified and restored after success", async () => {
  const db = database();
  await withLoggingRestored(db.query, async () => {
    await setLoggingState(db.query, LOGGING_MODES.update_index_async);
    assert.equal((await readLoggingState(db.query)).syncBinlog, 0);
  });
  assert.deepEqual(db.state, LOGGING_MODES.update_index);
});

test("failed workload and interrupt restore original values", async () => {
  for (const message of ["workload failure", "SIGINT", "SIGTERM"]) {
    const db = database({ ...LOGGING_MODES.update_index, flushLogAtTimeout: 2 });
    await assert.rejects(withLoggingRestored(db.query, async () => {
      await setLoggingState(db.query, LOGGING_MODES.update_index_async);
      throw new Error(message);
    }), new RegExp(message));
    assert.equal(db.state.syncBinlog, 1);
    assert.equal(db.state.flushLogAtTimeout, 2);
  }
});

test("binlog OFF refuses to change parameters", async () => {
  const db = database({ ...LOGGING_MODES.update_index, logBinEnabled: false });
  await assert.rejects(withLoggingRestored(db.query, () => assert.fail("must not run")), /log_bin/);
  assert.equal(db.writes.length, 0);
});

test("restore failure is visible and cannot be mistaken for success", async () => {
  const db = database();
  let writes = 0;
  const query = async (sql) => {
    if (sql.startsWith("SET") && ++writes === 2) throw new Error("connection lost");
    return db.query(sql);
  };
  await assert.rejects(withLoggingRestored(query, async () => {
    await setLoggingState(query, LOGGING_MODES.update_index_async);
  }), /Failed to restore/);
});

test("six-combination dry run has no result directory changes", () => {
  const before = readdirSync(PATHS.resultsDir).sort();
  const output = execFileSync(process.execPath, [
    path.join(PATHS.benchmarkRoot, "scripts/durability.mjs"), "--dry-run",
  ], { encoding: "utf8" });
  assert.equal((output.match(/warmup \+/g) ?? []).length, 6);
  assert.ok(output.includes("redo=2, sync_binlog=0"));
  assert.deepEqual(readdirSync(PATHS.resultsDir).sort(), before);
  assert.throws(() => durabilityPlan({ WARMUP_SECONDS: 60, DURATION_SECONDS: 120 }, { concurrency: "0" }), /Concurrency/);
});

test("collection rejects wrong logging or unverified restoration", () => {
  const run = { runId: "test", runGroup: "test", scenario: "update_index_async", status: "passed",
    restorationVerified: true, metrics: { errors: 0 }, environment: { mysql: LOGGING_MODES.update_index_async } };
  validateDurabilityRuns([run]);
  assert.throws(() => validateDurabilityRuns([{ ...run, restorationVerified: false }]), /restoration/);
  assert.throws(() => validateDurabilityRuns([{ ...run, environment: { mysql: LOGGING_MODES.update_index } }]), /mismatch/);
  assert.throws(() => validateDurabilityRuns([run, { ...run, runGroup: "other" }]), /mix/);
});

test("incremental dashboard preserves background and adds actual per-scenario logging", () => {
  const base = { component: { testedAt: "old" }, environment: { mysql: {} }, series: [
    { scenario: "point_select", points: [{ qps: 100 }] },
    { scenario: "update_index", points: [{ qps: 10 }] },
    { scenario: "read_write", points: [{ qps: 20 }] },
  ], stability: [{ scenario: "update_index" }], rawResults: [{ scenario: "update_index" }] };
  const updated = { component: { testedAt: "new" }, runGroup: "new", series: [
    { scenario: "update_index", points: [{ qps: 11 }], environment: { mysql: LOGGING_MODES.update_index } },
    { scenario: "update_index_async", points: [{ qps: 50 }], environment: { mysql: LOGGING_MODES.update_index_async } },
  ], stability: [], rawResults: [] };
  const merged = mergeDurabilityReport(base, updated);
  assert.equal(merged.series.length, 4);
  assert.equal(merged.series[0].points[0].qps, 100);
  assert.equal(merged.series[1].points[0].qps, 11);
  assert.equal(merged.series[2].environment.mysql.syncBinlog, 0);
  assert.equal(merged.series[0].sourceRole, "historical");
  assert.equal(base.series[1].points[0].qps, 10);
});
