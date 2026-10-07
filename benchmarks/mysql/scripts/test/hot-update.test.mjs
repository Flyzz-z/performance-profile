import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSysbenchArguments, parseSysbenchOutput } from "../lib.mjs";
import { summarizeResources } from "../resources.mjs";
import { HOT_PROTOCOL, parseLockCounters, lockMetrics, validateHotExperiment, publishHotExperiment } from "../hot-update-results.mjs";

function fixture() {
  const files = {};
  const environment = { container: { mysqlCpuLimit: 8, loadGeneratorCpuLimit: 4, mysqlMemoryLimit: "6g", loadGeneratorMemoryLimit: "1g", platform: "linux/arm64", imagePlatform: "linux/arm64", imageId: "same" },
    mysql: { version: "8.4", bufferPoolBytes: 3 * 1024 ** 3, logBinEnabled: true, flushLogAtTransactionCommit: 1, syncBinlog: 1, flushLogAtTimeout: 1 }, loadGenerator: { sysbenchVersion: "1.0.20", imagePlatform:"linux/arm64", imageId:"load-image" } };
  const dataset = { status: "ready", tableCount: 10, tableSize: 100000, actualRows: 1000000, tables: Array.from({ length: 10 }, (_, i) => ({ name: `sbtest${i + 1}`, indexes: [["PRIMARY", "id", "0"], ["k_1", "k", "1"]], columns: [["id", "int", "PRI", "auto_increment"], ["k", "int", "MUL", ""]] })) };
  const point = timeMs => ({ timeMs, cpuUsageNs: timeMs * 1e6, periods: timeMs / 100, throttledPeriods: 0, throttledTimeNs: 0 });
  const limits = { mysql: { cpus: 8, memoryBytes: 6 * 1024 ** 3 }, loadgen: { cpus: 4, memoryBytes: 1024 ** 3 } };
  const groups = ["distributed", "hot"].map(id => {
    const limit = id === "hot" ? 1 : 100000;
    files[`${id}-dataset`] = structuredClone(dataset);
    files[`${id}-env`] = structuredClone(environment);
    const runs = ["warmup", "measured"].map(kind => {
      const seconds = kind === "warmup" ? 30 : 60;
      const raw = readFileSync(new URL("./fixtures/sysbench-histogram.txt", import.meta.url), "utf8").replace("2.0001s", `${seconds}.0001s`).replace("Number of threads: 1", "Number of threads: 16").replace("ignored errors:                      0", "ignored errors:                      2");
      files[`${id}-${kind}.txt`] = raw;
      return { kind, exitCode: 0, group: id, runGroup: "fixture", rawOutputPath: `${id}-${kind}.txt`, metrics: parseSysbenchOutput(raw), arguments: createSysbenchArguments({ env: { TABLE_COUNT: 10, TABLE_SIZE: limit }, scenario: "update_index", concurrency: 16, durationSeconds: seconds, command: "run" }) };
    });
    files[`${id}-resources`] = { intervalMs: 5000, summary: { limits, errors: [] }, samples: Array.from({ length: 12 }, (_, i) => ({ mysql: point(i * 5000), loadgen: point(i * 5000) })) };
    files[`${id}-locks`] = { before: { timeMs: 0, waits: 10, waitMs: 20 }, after: { timeMs: 62000, waits: 10, waitMs: 20 } };
    runs[1].resourcePath = `${id}-resources`;
    runs[1].lockPath = `${id}-locks`;
    return { id, runGroup: "fixture", actualRows: 1000000, activeRows: limit * 10, idLimit: limit, datasetPath: `${id}-dataset`, environmentPath: `${id}-env`, environment: structuredClone(environment), runs };
  });
  files.restoration = { logging: environment.mysql };
  return { experiment: { purpose: "formal", restorationVerified: true, restorationPath:"restoration", protocol: { ...HOT_PROTOCOL }, runGroup: "fixture", groups }, files,
    reader: { json: file => structuredClone(files[file]), text: file => files[file] } };
}

test("lock differences preserve zero and reject reset/missing/inconsistent counters", () => {
  const before = parseLockCounters("Innodb_row_lock_time\t100\nInnodb_row_lock_waits\t10", 1000);
  const after = parseLockCounters("Innodb_row_lock_time\t160\nInnodb_row_lock_waits\t20", 61000);
  assert.deepEqual(lockMetrics(before, after), { seconds: 60, waits: 10, waitMs: 60, waitsPerSecond: 1 / 6, meanWaitMs: 6 });
  assert.equal(lockMetrics(before, { ...before, timeMs: 61000 }).meanWaitMs, 0);
  for (const value of [{ ...after, timeMs: 1000 }, { ...after, waits: 9 }, { ...after, waitMs: 90 }, { ...after, waits: 10 }, { timeMs: 61000 }]) assert.throws(() => lockMetrics(before, value));
  assert.throws(() => parseLockCounters("Innodb_row_lock_time\t10", 1000));
  assert.throws(() => parseLockCounters("Innodb_row_lock_time\tNaN\nInnodb_row_lock_waits\t10", 1000));
});

test("formal contract preserves nonzero ignored errors and zero waits", () => {
  const { experiment, reader } = fixture();
  validateHotExperiment(experiment, reader);
  assert.equal(experiment.groups[1].metrics.failureCount, 2);
  assert.equal(experiment.groups[1].locks.waits, 0);
  assert.equal(experiment.groups[1].activeRows, 10);
});

test("wrong protocol, SQL range, incomplete evidence and fatal exits cannot publish", () => {
  const mutations = [e => { e.protocol.durationSeconds = 90; }, e => { e.protocol.repeats = 2; }, e => { e.protocol.concurrency = 8; },
    e => { e.purpose = "verification"; }, e => { e.restorationVerified = false; }, e => { e.groups.pop(); },
    e => { e.groups[1].runGroup = "other"; }, e => { e.groups[1].activeRows = 100; }, e => { e.groups[1].idLimit = 10; },
    e => { e.groups[1].runs[1].exitCode = 1; }, e => { e.groups[1].runs.push(e.groups[1].runs[1]); },
    e => { e.groups[1].runs[0].arguments.push("--table-size=10"); }, e => { e.groups[1].environment.container.mysqlCpuLimit = 4; },
    e => { e.groups[1].runs[1].rawOutputPath = "results/verification/output.txt"; }];
  for (const mutate of mutations) {
    const { experiment, reader } = fixture(); mutate(experiment);
    assert.throws(() => validateHotExperiment(experiment, reader));
  }
  for (const mutate of [f => { f["hot-resources"].samples = []; }, f => { f["hot-locks"].after.waits = 0; }, f => { f["hot-dataset"].tableSize = 1; }, f => { f["hot-measured.txt"] = f["hot-measured.txt"].replace("60.0001s", "2s"); }]) {
    const { experiment, reader, files } = fixture(); mutate(files);
    assert.throws(() => validateHotExperiment(experiment, reader));
  }
});

test("60s resource coverage enforces 48s / 70s / 10s gates", () => {
  const { files } = fixture();
  const c = files["hot-resources"];
  const check = samples => summarizeResources(samples, c.summary.limits, 60, [], 5000).valid;
  assert.equal(check(c.samples), true);
  assert.equal(check(c.samples.slice(0, 10)), false);
  const gap = structuredClone(c.samples); gap.splice(3, 2); assert.equal(check(gap), false);
  const long = structuredClone(c.samples); long.forEach((s, i) => { s.mysql.timeMs = s.loadgen.timeMs = i * 7000; }); assert.equal(check(long), false);
});

test("publication rejects before writes and atomically adds only independent field", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hot-publish-"));
  try {
    const report = path.join(dir, "mysql.json");
    const backup = path.join(dir, "backup.json");
    const original = JSON.stringify({ component: { testedAt: "unchanged" }, series: [1], bufferPoolExperiment: { unchanged: true } });
    writeFileSync(report, original);
    const invalid = fixture(); invalid.experiment.groups.pop();
    assert.throws(() => publishHotExperiment(invalid.experiment, report, backup, invalid.reader));
    assert.equal(readFileSync(report, "utf8"), original);
    const valid = fixture(); publishHotExperiment(valid.experiment, report, backup, valid.reader);
    const { hotUpdateExperiment, ...rest } = JSON.parse(readFileSync(report, "utf8"));
    assert.deepEqual(rest, JSON.parse(original));
    assert.equal(hotUpdateExperiment.groups.length, 2);
    assert.equal(readFileSync(backup, "utf8"), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("entry isolates dry run and owns cancellable containers with logging restoration", () => {
  const source = readFileSync(new URL("../hot-update.mjs", import.meta.url), "utf8");
  assert.ok(source.indexOf('if (cli["dry-run"])') < source.indexOf("await waitForMysql"));
  assert.match(source, /withLoggingRestored/);
  assert.match(source, /signal: controller.signal/);
  assert.match(source, /for \(const name of owned\) await runProcess\("docker", \["rm", "-f", name\]\)/);
});
