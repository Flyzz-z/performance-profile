import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { PATHS, SCENARIOS, assert, readJson, createSysbenchArguments } from "./lib.mjs";
import { validateExperimentRun, validateRepeats } from "./experiment.mjs";
import { assertUniqueRunIds, shouldRunThirdRun, summarizeCombination, summarizeRunResources } from "./analytics.mjs";
import { assertLoggingMatch, LOGGING_MODES } from "./logging.mjs";

export const SUPPLEMENT_SCENARIOS = ["point_select", "update_index"];
export const SUPPLEMENT_PROTOCOL = { concurrency: 32, warmupSeconds: 30, durationSeconds: 90,
  repeatCount: 2, adaptiveThresholdPercent: 30 };
const diskReader = {
  json: file => readJson(path.resolve(PATHS.projectRoot, file)),
  text: file => readFileSync(path.resolve(PATHS.projectRoot, file), "utf8"),
};

export function validateSupplementEnvironment(environment, baseline) {
  const c = environment.container;
  assert(c?.mysqlCpuLimit === 8 && c.loadGeneratorCpuLimit === 4 && c.mysqlMemoryLimit === "6g"
    && c.loadGeneratorMemoryLimit === "1g" && c.platform === "linux/arm64"
    && c.imagePlatform === "linux/arm64", "Supplement resource/platform mismatch");
  assert(environment.mysql.bufferPoolBytes === 3 * 1024 ** 3, "Supplement buffer pool mismatch");
  assertLoggingMatch(environment.mysql, LOGGING_MODES.update_index);
  assert(environment.loadGenerator.imageId && environment.loadGenerator.imagePlatform === "linux/arm64",
    "Missing sysbench image evidence");
  for (const [actual, expected] of [[c.imageId, baseline.container.imageId],
    [c.mysqlImage, baseline.container.mysqlImage], [environment.mysql.version, baseline.mysql.version],
    [environment.mysql.transactionIsolation, baseline.mysql.transactionIsolation],
    [environment.loadGenerator.image, baseline.loadGenerator.image],
    [environment.loadGenerator.sysbenchVersion, baseline.loadGenerator.sysbenchVersion]]) {
    assert(actual && actual === expected, "Supplement software differs from baseline");
  }
  if (baseline.loadGenerator.imageId) assert(environment.loadGenerator.imageId === baseline.loadGenerator.imageId,
    "Sysbench image differs from baseline evidence");
}

export function validateSupplement(experiment, baseline, reader = diskReader) {
  assert(experiment.purpose === "formal" && experiment.restorationVerified === true
    && isDeepStrictEqual(experiment.protocol, SUPPLEMENT_PROTOCOL), "Invalid supplement protocol or restoration");
  assert(/^[a-zA-Z0-9_-]+$/.test(experiment.runGroup) && experiment.runs?.length >= 6,
    "Incomplete supplement group");
  const evidencePath = file => assert(typeof file === "string" && file.startsWith("benchmarks/mysql/results/")
    && !file.split("/").some(part => ["..", ".", "verification"].includes(part)), "Nonformal evidence path");
  evidencePath(experiment.restorationPath);
  const restoration = reader.json(experiment.restorationPath);
  assert(restoration.runGroup === experiment.runGroup && restoration.bufferPoolBytes === 3221225472,
    "Restoration group/cache mismatch");
  assertLoggingMatch(restoration.logging, LOGGING_MODES.update_index);
  assertUniqueRunIds(experiment.runs);
  const datasets = new Set();
  const first = experiment.runs[0].environment;
  for (const run of experiment.runs) {
    assert(SUPPLEMENT_SCENARIOS.includes(run.scenario) && run.concurrency === 32
      && ["warmup", "measured"].includes(run.kind) && run.runGroup === experiment.runGroup
      && run.exitCode === 0, "Unexpected supplement scene/group or fatal exit");
    const expectedId = `${experiment.runGroup}-${run.scenario}-c32-${run.kind}-r${run.repeat}`;
    assert(run.runId === expectedId && (run.kind !== "warmup" || run.repeat === 1), "Invalid run identity");
    for (const file of [run.rawOutputPath, run.environmentPath, run.datasetPath, run.metadataPath,
      ...(run.kind === "measured" ? [run.resources?.rawPath] : [])]) evidencePath(file);
    assert(isDeepStrictEqual(reader.json(run.metadataPath), run), "Raw metadata mismatch");
    assert(isDeepStrictEqual(reader.json(run.environmentPath), run.environment), "Environment evidence mismatch");
    validateSupplementEnvironment(run.environment, baseline);
    assert(run.environment.loadGenerator.imageId === first.loadGenerator.imageId, "Mixed sysbench images");
    const seconds = run.kind === "warmup" ? 30 : 90;
    const args = run.arguments;
    for (const argument of [`/usr/share/sysbench/${SCENARIOS[run.scenario].script}`, "--tables=10",
      "--table-size=100000", "--threads=32", `--time=${seconds}`, "--rand-type=uniform", "--rand-seed=42", "run"]) {
      assert(args?.filter(a => a === argument).length === 1, `Missing workload argument: ${argument}`);
    }
    for (const key of ["tables", "table-size", "threads", "time", "rand-type", "rand-seed"]) {
      assert(args.filter(a => a.startsWith(`--${key}=`)).length === 1, "Duplicate workload option");
    }
    assert(run.command === args.join(" "), "Command/arguments mismatch");
    const raw = reader.text(run.rawOutputPath);
    assert(Number(raw.match(/Number of threads:\s*(\d+)/)?.[1]) === 32, "Raw concurrency mismatch");
    const elapsed = Number(raw.match(/total time:\s*([\d.]+)s/)?.[1]);
    assert(elapsed >= seconds * .95 && elapsed <= seconds + 10, "Incomplete measured duration");
    const dataset = validateExperimentRun(run, 3221225472, reader);
    const expectedArgs = createSysbenchArguments({ env: { MYSQL_DATABASE: dataset.database,
      MYSQL_ROOT_PASSWORD: "***", TABLE_COUNT: "10", TABLE_SIZE: "100000" }, scenario: run.scenario,
      command: "run", concurrency: 32, durationSeconds: seconds });
    assert(isDeepStrictEqual(args, expectedArgs), "Unexpected SQL or connection arguments");
    assert(run.metrics.transactions > 0 && dataset.tables.every((table, i) => table.name === `sbtest${i + 1}`),
      "Unexpected dataset or empty workload");
    datasets.add(run.datasetPath);
  }
  assert(datasets.size === 2, "Scenes must be prepared independently");
  const combinations = SUPPLEMENT_SCENARIOS.map(scenario => {
    const sceneRuns = experiment.runs.filter(run => run.scenario === scenario);
    assert(new Set(sceneRuns.map(run => run.datasetPath)).size === 1
      && new Set(sceneRuns.map(run => run.environmentPath)).size === 1, "Mixed scene preparations");
    const measured = validateRepeats(experiment.runs, scenario, 32);
    assert(measured.length === (shouldRunThirdRun(measured.slice(0, 2), 30) ? 3 : 2), "Unapproved extra repeat");
    const summary = summarizeCombination(measured);
    return { scenario, scenarioLabel: SCENARIOS[scenario].label, concurrency: 32,
      attempts: summary.attempts, stability: summary.stability, selected: summary.selected,
      spreadPercent: Math.max(summary.stats.tps.relativeSpreadPercent, summary.stats.p99Ms.relativeSpreadPercent),
      resources: summarizeRunResources(measured), environment: measured[0].environment,
      dataset: reader.json(measured[0].datasetPath), runGroup: experiment.runGroup,
      testedAt: measured.at(-1).finishedAt, sourceRole: "formal",
      runs: measured.map(run => ({ runId: run.runId, repeat: run.repeat, ...run.metrics,
        rawOutputPath: run.rawOutputPath, resources: run.resources, datasetPath: run.datasetPath })) };
  });
  return combinations;
}

export function mergeSupplement(data, experiment, combinations) {
  assert(!data.concurrencySupplement && data.formalExperiment?.purpose === "formal", "Supplement already exists or baseline is not formal");
  const merged = structuredClone(data);
  for (const combination of combinations) {
    const series = merged.series.find(s => s.scenario === combination.scenario);
    assert(series && !series.points.some(p => p.concurrency === 32)
      && !merged.stability.some(row => row.scenario === combination.scenario && row.concurrency === 32), "Duplicate supplement point");
    const point = { concurrency: 32, ...combination.selected, attempts: combination.attempts,
      stability: combination.stability, resources: combination.resources, runGroup: experiment.runGroup,
      testedAt: combination.testedAt, sourceRole: "formal", environment: combination.environment };
    series.points.push(point);
    merged.stability.push(combination);
  }
  merged.rawResults.push(...experiment.runs.filter(r => r.kind === "measured").map(run => ({
    runId: run.runId, status: run.status, scenario: run.scenario, concurrency: 32,
    repeat: run.repeat, rawOutputPath: run.rawOutputPath,
  })));
  assertUniqueRunIds(merged.rawResults);
  const best = merged.series.flatMap(series => series.points.map(point => ({ ...point,
    scenario: series.scenario, scenarioLabel: series.label }))).sort((a, b) => b.qps - a.qps)[0];
  if (best.qps > data.headline.peak.qps) merged.headline.peak = best;
  merged.concurrencySupplement = { schemaVersion: 1, runGroup: experiment.runGroup, purpose: "formal",
    scenarios: SUPPLEMENT_SCENARIOS, protocol: experiment.protocol, testedAt: experiment.finishedAt,
    environment: experiment.runs[0].environment, restorationPath: experiment.restorationPath };
  // Removing only the authorized additions must recover the entire baseline.
  const restored = structuredClone(merged);
  delete restored.concurrencySupplement;
  for (const series of restored.series) series.points = series.points.filter(p => p.runGroup !== experiment.runGroup);
  restored.stability = restored.stability.filter(c => c.runGroup !== experiment.runGroup);
  const ids = new Set(experiment.runs.map(run => run.runId));
  restored.rawResults = restored.rawResults.filter(run => !ids.has(run.runId));
  restored.headline.peak = data.headline.peak;
  assert(isDeepStrictEqual(restored, data), "Unrelated baseline fields changed");
  return merged;
}

export function publishSupplement(experiment, reportPath = path.join(PATHS.siteDataDir, "mysql.json"), reader = diskReader) {
  const original = readFileSync(reportPath, "utf8");
  const data = JSON.parse(original);
  const baseline = { ...data.environment, loadGenerator: { ...data.environment.loadGenerator,
    imageId: data.hotUpdateExperiment?.groups[0].environment.loadGenerator.imageId } };
  const combinations = validateSupplement(experiment, baseline, reader);
  const merged = mergeSupplement(data, experiment, combinations);
  const backup = path.join(PATHS.resultsDir, "verification/report-backups", `${experiment.runGroup}-report-backup.json`);
  mkdirSync(path.dirname(backup), { recursive: true });
  writeFileSync(backup, original, { flag: "wx" });
  const temporary = `${reportPath}.${experiment.runGroup}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { flag: "wx" });
    assert(readFileSync(reportPath, "utf8") === original, "Report changed concurrently; publication stopped");
    renameSync(temporary, reportPath);
  } finally { rmSync(temporary, { force: true }); }
  return merged;
}
