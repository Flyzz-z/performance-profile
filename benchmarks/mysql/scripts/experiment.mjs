import path from "node:path";
import { readFileSync } from "node:fs";
import { PATHS, assert, readJson, parseSysbenchOutput, EXPANDED_SCENARIOS, EXPANDED_CONCURRENCY, SCENARIOS } from "./lib.mjs";
import { assertLoggingMatch, loggingMode } from "./logging.mjs";
import { summarizeResources } from "./resources.mjs";
import { shouldRunThirdRun } from "./analytics.mjs";

export function pageMetrics(before, after) {
  const seconds = (after.timeMs - before.timeMs) / 1000;
  const requests = after.Innodb_buffer_pool_read_requests - before.Innodb_buffer_pool_read_requests;
  const reads = after.Innodb_buffer_pool_reads - before.Innodb_buffer_pool_reads;
  assert(Number.isFinite(seconds) && seconds > 0 && Number.isSafeInteger(requests) && requests > 0
    && Number.isSafeInteger(reads) && reads >= 0 && reads <= requests, "Invalid buffer pool counter window");
  return { seconds, requests, reads, readsPerSecond: reads / seconds, hitPercent: (1 - reads / requests) * 100 };
}

export function validateDataset(dataset, secondary = true, cache = false) {
  assert(dataset.status === "ready" && dataset.tableCount === 10 && dataset.actualRows === dataset.tableSize * 10, "Dataset size mismatch");
  assert(cache ? dataset.dataBytes >= 1.4 * 1024 ** 3 && dataset.dataBytes <= 1.6 * 1024 ** 3 : dataset.tableSize === 100000, "Dataset working set mismatch");
  assert(dataset.tables?.length === 10, "Missing table schema evidence");
  for (const table of dataset.tables) {
    assert(table.indexes.some(row => row[0] === "PRIMARY" && row[1] === "id" && row[2] === "0"), "Missing primary index");
    const other = table.indexes.filter(row => row[0] !== "PRIMARY");
    assert(secondary ? other.length === 1 && other[0][1] === "k" : other.length === 0, "Secondary index mismatch");
    assert(table.columns.some(row => row[0] === "id" && row[3].includes("auto_increment")), "Missing auto increment");
    assert(table.columns.some(row => row[0] === "k" && /^int/.test(row[1])), "Unexpected k column");
  }
}

export function validateExperimentRun(run, bufferBytes = 3221225472) {
  assert(run.purpose === "formal" && run.status === "passed" && run.restorationVerified === true && run.metrics?.errors === 0, "Invalid formal run or restoration");
  const c = run.environment?.container;
  assert(c?.mysqlCpuLimit === 8 && c.loadGeneratorCpuLimit === 4 && c.mysqlMemoryLimit === "6g" && c.loadGeneratorMemoryLimit === "1g" && c.platform === "linux/arm64", "Formal resource configuration mismatch");
  assert(run.environment.mysql.bufferPoolBytes === bufferBytes, "Buffer pool capacity mismatch");
  assertLoggingMatch(run.environment.mysql, loggingMode(run.scenario));
  assert(run.protocol.warmupSeconds === 30 && run.protocol.repeatCount === 2 && run.protocol.adaptiveThresholdPercent === 30, "Formal protocol mismatch");
  assert(run.protocol.durationSeconds === (run.kind === "warmup" ? 30 : 90), "Formal duration mismatch");
  const rawMetrics = parseSysbenchOutput(readFileSync(path.resolve(PATHS.projectRoot, run.rawOutputPath), "utf8"));
  assert(JSON.stringify(rawMetrics) === JSON.stringify(run.metrics), "Raw metrics mismatch");
  const dataset = readJson(path.resolve(PATHS.projectRoot, run.datasetPath));
  validateDataset(dataset, run.scenario !== "update_no_secondary_index", bufferBytes !== 3221225472);
  assert(run.command.includes(`--table-size=${dataset.tableSize}`) && run.command.includes("--rand-type=uniform"), "Query ID range mismatch");
  assert(run.command.includes(`/usr/share/sysbench/${SCENARIOS[run.scenario].script}`), "Unexpected workload SQL script");
  if (run.scenario !== "read_write") assert(rawMetrics.queries === rawMetrics.transactions, "Expected one SQL per event");
  if (run.scenario === "insert") {
    assert(!dataset.sqlMode?.split(",").includes("NO_AUTO_VALUE_ON_ZERO"), "INSERT auto increment SQL mode mismatch");
    const counts = run.rowCounts;
    assert(counts && counts.after - counts.before === rawMetrics.transactions, "INSERT growth mismatch");
    if (run.kind === "measured") assert(counts.beforeWarmup === 1000000 && counts.afterWarmup === counts.before
      && counts.afterWarmup - counts.beforeWarmup === counts.warmupEvents, "INSERT warmup evidence mismatch");
  }
  if (run.kind === "measured") {
    const capture = readJson(path.resolve(PATHS.projectRoot, run.resources.rawPath));
    const limits = capture.summary.limits;
    assert(limits.mysql.cpus === 8 && limits.loadgen.cpus === 4 && limits.mysql.memoryBytes === 6 * 1024 ** 3 && limits.loadgen.memoryBytes === 1024 ** 3, "Sampling quota mismatch");
    const verified = summarizeResources(capture.samples, limits, 90, capture.summary.errors, capture.intervalMs);
    assert(capture.intervalMs === 5000 && verified.valid, "Invalid resource sampling");
    run.resources = {...verified,rawPath:run.resources.rawPath};
    if (bufferBytes !== 3221225472) pageMetrics(run.bufferPool.before, run.bufferPool.after);
  }
  return dataset;
}

export function validateRepeats(runs, scenario, concurrency) {
  const measured = runs.filter(r => r.scenario === scenario && r.concurrency === concurrency && r.kind === "measured").sort((a,b)=>a.repeat-b.repeat);
  assert(measured.length === 2 || measured.length === 3, "Incomplete formal combination");
  assert(measured.every((r,i)=>r.repeat === i+1), "Duplicate or missing repeat");
  assert(!shouldRunThirdRun(measured.slice(0,2),30) || measured.length === 3, "Missing adaptive third run");
  const warmups = runs.filter(r => r.scenario === scenario && r.concurrency === concurrency && r.kind === "warmup");
  assert(warmups.length === (scenario === "insert" ? measured.length : 1), "Missing warmup");
  if (scenario === "insert") {
    assert(new Set(measured.map(r=>r.datasetPath)).size === measured.length, "INSERT repeats share preparation");
    for (const run of measured) {
      const matching = warmups.filter(w=>w.repeat===run.repeat);
      assert(matching.length===1,"Missing or duplicate INSERT warmup repeat");
      const warmup=matching[0];
      assert(warmup.datasetPath===run.datasetPath && warmup.rowCounts.before===run.rowCounts.beforeWarmup
        && warmup.rowCounts.after===run.rowCounts.afterWarmup && warmup.metrics.transactions===run.rowCounts.warmupEvents,
      "INSERT warmup and measurement evidence do not match");
    }
  }
  return measured;
}

export function validateExpandedRuns(runs) {
  assert(runs.length > 0 && new Set(runs.map(r=>r.runGroup)).size === 1, "Mixed formal run groups");
  const first = runs[0].environment;
  for (const run of runs) {
    assert(EXPANDED_SCENARIOS.includes(run.scenario) && EXPANDED_CONCURRENCY.includes(run.concurrency), "Unexpected formal scene/concurrency");
    validateExperimentRun(run);
    assert(run.environment.container.imageId === first.container.imageId && run.environment.container.mysqlImage === first.container.mysqlImage
      && run.environment.mysql.version === first.mysql.version && run.environment.loadGenerator.sysbenchVersion === first.loadGenerator.sysbenchVersion, "Mixed software versions");
  }
  for (const scenario of EXPANDED_SCENARIOS) for (const concurrency of EXPANDED_CONCURRENCY) validateRepeats(runs, scenario, concurrency);
}
