#!/usr/bin/env node

import path from "node:path";
import { readFileSync } from "node:fs";
import {
  aggregateCombinations,
  assertUniqueRunIds,
  computeComparisons,
  validateRunRecord,
  validateSiteData,
} from "./analytics.mjs";
import {
  PATHS,
  SCENARIO_ORDER,
  SCENARIOS,
  assert,
  ensureDirectories,
  listFiles,
  loadBenchmarkEnv,
  nowIso,
  parseCliArguments,
  parseSysbenchOutput,
  readJson,
  writeJson,
  writeJsonl,
} from "./lib.mjs";

const cli = parseCliArguments(process.argv.slice(2));
const runGroup = String(cli["run-group"] ?? "mvp");
const allowPartial = cli["allow-partial"] === true;
const env = loadBenchmarkEnv();
ensureDirectories();

const environmentPath = path.join(PATHS.resultsDir, "environment.json");
const datasetPath = path.join(PATHS.resultsDir, "dataset.json");
const environment = readJson(environmentPath);
const dataset = readJson(datasetPath);
const runEnvironmentPath = path.join(
  PATHS.summaryDir,
  `${runGroup}-environment.json`,
);

const metadataFiles = listFiles(PATHS.rawDir, ".meta.json").filter((filePath) =>
  filePath.endsWith("meta.json"),
);

const runs = metadataFiles
  .map((metadataPath) => readJson(metadataPath))
  .filter((metadata) => metadata.runGroup === runGroup)
  .map((metadata) => {
    const rawOutputPath = path.resolve(
      PATHS.projectRoot,
      metadata.rawOutputPath,
    );
    let metrics = null;
    let parseError = null;
    try {
      metrics = parseSysbenchOutput(readFileSync(rawOutputPath, "utf8"));
    } catch (error) {
      parseError = error.message;
    }
    const status =
      metadata.exitCode === 0 && metrics && metrics.errors === 0
        ? "passed"
        : "failed";
    return {
      ...metadata,
      environment: metadata.environment ?? environment,
      status,
      metrics,
      parseError,
    };
  })
  .sort(
    (left, right) =>
      SCENARIO_ORDER.indexOf(left.scenario) -
        SCENARIO_ORDER.indexOf(right.scenario) ||
      left.concurrency - right.concurrency ||
      left.kind.localeCompare(right.kind) ||
      left.repeat - right.repeat,
  );

assert(runs.length > 0, `No raw runs found for run group "${runGroup}"`);
assertUniqueRunIds(runs);
const collectedEnvironment = runs[0].environment ?? environment;
for (const run of runs) {
  validateRunRecord(run);
}

const failedRuns = runs.filter((run) => run.status !== "passed");
if (failedRuns.length && !allowPartial) {
  const failedIds = failedRuns.map((run) => run.runId).join(", ");
  throw new Error(`Failed runs found: ${failedIds}`);
}

const combinations = aggregateCombinations(runs);
if (!allowPartial) {
  assert(
    combinations.length === SCENARIO_ORDER.length * 3,
    `Expected 9 valid scenario/concurrency combinations but found ${combinations.length}`,
  );
}
assert(combinations.length > 0, "No valid benchmark combinations found");

const comparisons = computeComparisons(combinations);
assert(
  allowPartial || comparisons.length === 3,
  `Expected 3 read/write comparisons but found ${comparisons.length}`,
);

const selectedPoints = combinations.map((combination) => ({
  scenario: combination.scenario,
  concurrency: combination.concurrency,
  ...combination.selected,
  stability: combination.stability,
  attempts: combination.attempts,
}));

const peak = [...selectedPoints].sort(
  (left, right) => right.qps - left.qps,
)[0];
const representativeComparison = comparisons.at(-1) ?? null;

const series = SCENARIO_ORDER.map((scenario) => ({
  scenario,
  label: SCENARIOS[scenario].label,
  description: SCENARIOS[scenario].description,
  points: selectedPoints
    .filter((point) => point.scenario === scenario)
    .sort((left, right) => left.concurrency - right.concurrency),
}));

const stability = combinations.map((combination) => ({
  scenario: combination.scenario,
  scenarioLabel: SCENARIOS[combination.scenario].label,
  concurrency: combination.concurrency,
  attempts: combination.attempts,
  stability: combination.stability,
  spreadPercent: Math.max(
    combination.stats.tps?.relativeSpreadPercent ?? 0,
    combination.stats.p99Ms?.relativeSpreadPercent ?? 0,
  ),
  selected: combination.selected,
  runs: combination.runs.map((run) => ({
    runId: run.runId,
    repeat: run.repeat,
    tps: run.metrics.tps,
    qps: run.metrics.qps,
    p95Ms: run.metrics.p95Ms,
    p99Ms: run.metrics.p99Ms,
    errors: run.metrics.errors,
    rawOutputPath: run.rawOutputPath,
  })),
}));

const combinationsResult = {
  schemaVersion: 1,
  generatedAt: nowIso(),
  runGroup,
  environment: collectedEnvironment,
  dataset,
  combinations,
};

const comparisonResult = {
  schemaVersion: 1,
  generatedAt: nowIso(),
  runGroup,
  methodology: {
    readScenario: "point_select",
    writeScenario: "update_index",
    mixedScenario: "read_write",
    note: "TPS is not compared across different transaction semantics without also considering QPS and queries per transaction.",
  },
  comparisons,
};

const siteData = {
  schemaVersion: 1,
  component: {
    id: "mysql",
    name: "MySQL",
    version: collectedEnvironment.mysql.version,
    environmentLabel: "local Docker benchmark",
    testedAt:
      runs
        .map((run) => run.finishedAt)
        .sort()
        .at(-1) ?? nowIso(),
  },
  environment: collectedEnvironment,
  dataset,
  protocol: {
    scenarios: SCENARIO_ORDER,
    concurrency: [1, 8, 32],
    warmupSeconds: Number(env.WARMUP_SECONDS),
    durationSeconds: Number(env.DURATION_SECONDS),
    initialRuns: 2,
    maximumRuns: 3,
    varianceThresholdPercent: Number(env.VARIANCE_THRESHOLD_PERCENT),
  },
  headline: {
    peak,
    representativeComparison,
  },
  series,
  comparisons,
  stability,
  rawResults: runs
    .filter((run) => run.kind === "measured")
    .map((run) => ({
      runId: run.runId,
      status: run.status,
      scenario: run.scenario,
      concurrency: run.concurrency,
      repeat: run.repeat,
      rawOutputPath: run.rawOutputPath,
    })),
  limitations: collectedEnvironment.limitations,
};

validateSiteData(siteData, { allowPartial });

writeJsonl(path.join(PATHS.normalizedDir, "runs.jsonl"), runs);
writeJson(runEnvironmentPath, collectedEnvironment);
writeJson(
  path.join(PATHS.summaryDir, "combinations.json"),
  combinationsResult,
);
writeJson(
  path.join(PATHS.summaryDir, "comparison.json"),
  comparisonResult,
);
writeJson(path.join(PATHS.siteDataDir, "mysql.json"), siteData);

console.log(
  `Collected ${runs.length} runs into ${combinations.length} valid combinations.`,
);
console.log(`Site data: ${path.join(PATHS.siteDataDir, "mysql.json")}`);
