import path from "node:path";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { PATHS, assert, readJson, parseSysbenchOutput } from "./lib.mjs";
import { validateDataset } from "./experiment.mjs";
import { assertLoggingMatch, LOGGING_MODES } from "./logging.mjs";
import { summarizeResources } from "./resources.mjs";

export const HOT_PROTOCOL = { concurrency: 16, warmupSeconds: 30, durationSeconds: 60, repeats: 1 };
export const HOT_GROUPS = ["distributed", "hot"];
export const activeRows = (group) => group === "hot" ? 10 : 1000000;
export const idLimit = (group) => group === "hot" ? 1 : 100000;

export function parseLockCounters(output, timeMs) {
  const values = Object.fromEntries(output.trim().split(/\r?\n/).map(line => {
    const [key, value] = line.split(/\s+/);
    return [key, Number(value)];
  }));
  const result = { timeMs, waits: values.Innodb_row_lock_waits, waitMs: values.Innodb_row_lock_time };
  assert(Object.values(result).every(v => Number.isSafeInteger(v) && v >= 0), "Invalid or missing lock counters");
  return result;
}

export function lockMetrics(before, after) {
  const seconds = (after.timeMs - before.timeMs) / 1000;
  const waits = after.waits - before.waits;
  const waitMs = after.waitMs - before.waitMs;
  assert([before, after].every(p => Object.values(p).length === 3 && Object.values(p).every(v => Number.isSafeInteger(v) && v >= 0))
    && seconds > 0 && waits >= 0 && waitMs >= 0 && (waits > 0 || waitMs === 0), "Invalid lock counter window");
  return { seconds, waits, waitMs, waitsPerSecond: waits / seconds, meanWaitMs: waits ? waitMs / waits : 0 };
}

export function validateHotEnvironment(environment) {
  const c = environment.container;
  assert(c?.mysqlCpuLimit === 8 && c.loadGeneratorCpuLimit === 4 && c.mysqlMemoryLimit === "6g"
    && c.loadGeneratorMemoryLimit === "1g" && c.platform === "linux/arm64" && c.imagePlatform === "linux/arm64", "Hot update environment mismatch");
  assert(environment.mysql.bufferPoolBytes === 3 * 1024 ** 3, "Hot update buffer pool mismatch");
  assert(environment.loadGenerator?.imagePlatform === "linux/arm64" && environment.loadGenerator.imageId, "Missing sysbench image evidence");
  assertLoggingMatch(environment.mysql, LOGGING_MODES.update_index);
}

export function validateHotExperiment(experiment, reader = {
  json: file => readJson(path.resolve(PATHS.projectRoot, file)),
  text: file => readFileSync(path.resolve(PATHS.projectRoot, file), "utf8"),
}) {
  assert(experiment.purpose === "formal" && experiment.restorationVerified === true
    && isDeepStrictEqual(experiment.protocol, HOT_PROTOCOL), "Invalid hot update protocol or restoration");
  assert(/^[a-zA-Z0-9_-]+$/.test(experiment.runGroup) && experiment.groups?.length === 2, "Missing hot update groups");
  assertLoggingMatch(reader.json(experiment.restorationPath).logging, LOGGING_MODES.update_index);
  const first = experiment.groups[0].environment;
  for (const [index, group] of experiment.groups.entries()) {
    assert(group.id === HOT_GROUPS[index] && group.runGroup === experiment.runGroup && group.actualRows === 1000000
      && group.activeRows === activeRows(group.id) && group.idLimit === idLimit(group.id), "Group or target range mismatch");
    validateHotEnvironment(group.environment);
    assert(isDeepStrictEqual(reader.json(group.environmentPath), group.environment), "Environment evidence mismatch");
    assert(group.environment.container.imageId === first.container.imageId && group.environment.mysql.version === first.mysql.version
      && group.environment.loadGenerator.sysbenchVersion === first.loadGenerator.sysbenchVersion
      && group.environment.loadGenerator.imageId === first.loadGenerator.imageId, "Mixed software versions");
    const dataset = reader.json(group.datasetPath);
    validateDataset(dataset);
    assert(dataset.tables.every((table, i) => table.name === `sbtest${i + 1}`), "Unexpected table identities");
    assert(group.runs?.length === 2, "Expected one warmup and one measurement");
    for (const [i, run] of group.runs.entries()) {
      const kind = i === 0 ? "warmup" : "measured";
      const seconds = i === 0 ? 30 : 60;
      assert(run.kind === kind && run.exitCode === 0 && run.runGroup === experiment.runGroup && run.group === group.id, "Invalid run identity or fatal exit");
      const args = run.arguments;
      for (const argument of ["/usr/share/sysbench/oltp_update_index.lua", "--tables=10", `--table-size=${group.idLimit}`,
        "--threads=16", `--time=${seconds}`, "--rand-type=uniform", "--rand-seed=42", "run"]) {
        assert(args?.filter(a => a === argument).length === 1, `Missing workload argument: ${argument}`);
      }
      for (const key of ["tables", "table-size", "threads", "time", "rand-type", "rand-seed"]) {
        assert(args.filter(a => a.startsWith(`--${key}=`)).length === 1, "Duplicate workload option");
      }
      assert(!run.rawOutputPath.includes("/verification/"), "Verification cannot be published");
      const raw = reader.text(run.rawOutputPath);
      const metrics = parseSysbenchOutput(raw);
      assert(Number(raw.match(/Number of threads:\s*(\d+)/)?.[1]) === 16, "Raw concurrency mismatch");
      assert(isDeepStrictEqual(metrics, run.metrics) && metrics.transactions > 0, "Raw metrics mismatch");
      const elapsed = Number(raw.match(/total time:\s*([\d.]+)s/)?.[1]);
      assert(elapsed >= seconds * .95 && elapsed <= seconds + 10, "Incomplete measured duration");
    }
    const run = group.runs[1];
    const capture = reader.json(run.resourcePath);
    const limits = capture.summary.limits;
    assert(limits.mysql.cpus === 8 && limits.loadgen.cpus === 4 && limits.mysql.memoryBytes === 6 * 1024 ** 3
      && limits.loadgen.memoryBytes === 1024 ** 3, "Actual sampling quotas mismatch");
    const resources = summarizeResources(capture.samples, limits, 60, capture.summary.errors, capture.intervalMs);
    assert(capture.intervalMs === 5000 && resources.valid, "Invalid hot update resource coverage");
    const locks = reader.json(run.lockPath);
    const derived = lockMetrics(locks.before, locks.after);
    assert(derived.seconds >= 60 && derived.seconds <= 80, "Lock window does not cover measurement");
    group.metrics = { ...run.metrics, failureCount: run.metrics.ignoredErrors };
    group.locks = derived;
    group.resources = resources;
  }
  assert(experiment.groups[0].datasetPath !== experiment.groups[1].datasetPath, "Groups must be prepared independently");
  return experiment;
}

export function publishHotExperiment(experiment, reportPath = path.join(PATHS.siteDataDir, "mysql.json"), backupPath = path.join(PATHS.resultsDir, "verification/report-backups", `${experiment.runGroup}-report-backup.json`), reader) {
  validateHotExperiment(experiment, reader);
  const original = readFileSync(reportPath, "utf8");
  const data = JSON.parse(original);
  const merged = { ...data, hotUpdateExperiment: experiment };
  const { hotUpdateExperiment: oldHot, ...oldRest } = data;
  const { hotUpdateExperiment: newHot, ...newRest } = merged;
  assert(isDeepStrictEqual(oldRest, newRest), "Unrelated report fields changed");
  mkdirSync(path.dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, original, { flag: "wx" });
  const temporary = `${reportPath}.${experiment.runGroup}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { flag: "wx" });
  assert(readFileSync(reportPath, "utf8") === original, "Report changed concurrently; publication stopped");
  renameSync(temporary, reportPath);
}
