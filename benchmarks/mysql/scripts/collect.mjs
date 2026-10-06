#!/usr/bin/env node

import path from "node:path";
import { copyFileSync, constants, readFileSync, renameSync } from "node:fs";
import {
  aggregateCombinations,
  assertUniqueRunIds,
  computeComparisons,
  validateRunRecord,
  validateSiteData,
  validateDurabilityRuns,
  mergeDurabilityReport,
} from "./analytics.mjs";
import {
  PATHS,
  DURABILITY_SCENARIOS,
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
const durability = cli.durability === true;
const scenarios = durability ? DURABILITY_SCENARIOS : SCENARIO_ORDER;
assert(/^[a-zA-Z0-9_-]+$/.test(runGroup), "Invalid run group");
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
      scenarios.indexOf(left.scenario) -
        scenarios.indexOf(right.scenario) ||
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
if (durability) validateDurabilityRuns(runs);

const failedRuns = runs.filter((run) => run.status !== "passed");
if (failedRuns.length && !allowPartial) {
  const failedIds = failedRuns.map((run) => run.runId).join(", ");
  throw new Error(`Failed runs found: ${failedIds}`);
}

const combinations = aggregateCombinations(runs, scenarios);
if (!allowPartial) {
  assert(
    combinations.length === scenarios.length * 3,
    `Expected ${scenarios.length * 3} valid scenario/concurrency combinations but found ${combinations.length}`,
  );
}
assert(combinations.length > 0, "No valid benchmark combinations found");

const comparisons = durability ? [] : computeComparisons(combinations);
assert(
  durability || allowPartial || comparisons.length === 3,
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

const series = scenarios.map((scenario) => ({
  scenario,
  label: durability && scenario === "update_index" ? "索引更新（同步刷盘）" : SCENARIOS[scenario].label,
  description: SCENARIOS[scenario].description,
  points: selectedPoints
    .filter((point) => point.scenario === scenario)
    .sort((left, right) => left.concurrency - right.concurrency),
  ...(durability ? {
    runGroup,
    sourceRole: "paired",
    environment: runs.find((run) => run.scenario === scenario)?.environment,
    testedAt: runs.filter((run) => run.scenario === scenario).map((run) => run.finishedAt).sort().at(-1),
  } : {}),
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
  ...(durability ? {
    environment: combination.runs[0].environment,
    runGroup,
    testedAt: combination.runs.at(-1).finishedAt,
  } : {}),
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
  methodology: durability ? {
    synchronousScenario: "update_index",
    asynchronousScenario: "update_index_async",
    note: "Compare the paired scenario series at identical concurrency. No cross-batch read/write ratios are generated.",
  } : {
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
  ...(durability ? { runGroup } : {}),
  environment: collectedEnvironment,
  dataset,
  protocol: {
    scenarios,
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

if (durability) {
  const measured = runs.find((run) => run.kind === "measured");
  siteData.dataset = measured.datasetPath ? readJson(path.resolve(PATHS.projectRoot, measured.datasetPath)) : dataset;
  siteData.protocol.warmupSeconds = measured.protocol.warmupSeconds;
  siteData.protocol.durationSeconds = measured.protocol.durationSeconds;
  siteData.protocol.initialRuns = measured.protocol.repeatCount;
  siteData.protocol.varianceThresholdPercent = measured.protocol.adaptiveThresholdPercent;
  combinationsResult.dataset = siteData.dataset;
}
validateSiteData(siteData, { allowPartial, scenarios });

const named = (name) => durability ? `${runGroup}-${name}` : name;
writeJsonl(path.join(PATHS.normalizedDir, named("runs.jsonl")), runs);
writeJson(runEnvironmentPath, collectedEnvironment);
writeJson(
  path.join(PATHS.summaryDir, named("combinations.json")),
  combinationsResult,
);
writeJson(
  path.join(PATHS.summaryDir, named("comparison.json")),
  comparisonResult,
);
if (!durability) {
  writeJson(path.join(PATHS.siteDataDir, "mysql.json"), siteData);
} else {
  writeJson(path.join(PATHS.summaryDir, `${runGroup}-report.json`), siteData);
  if (cli.publish === true) {
    assert(!allowPartial && combinations.every((c) => c.attempts >= 2)
      && siteData.protocol.warmupSeconds === 60 && siteData.protocol.durationSeconds === 120
      && siteData.protocol.initialRuns === 2 && siteData.protocol.varianceThresholdPercent === 10,
    "Only a complete full-duration comparison may update the dashboard");
    const target = path.join(PATHS.siteDataDir, "mysql.json");
    const merged = mergeDurabilityReport(readJson(target), siteData);
    validateSiteData(merged, { scenarios: merged.series.map((s) => s.scenario) });
    copyFileSync(target, path.join(PATHS.siteDataDir, `${runGroup}-previous.json`), constants.COPYFILE_EXCL);
    const temporary = path.join(PATHS.siteDataDir, `${runGroup}-pending.json`);
    writeJson(temporary, merged);
    renameSync(temporary, target);
    console.log("Dashboard updated; previous JSON preserved as a single backup.");
  }
}

console.log(
  `Collected ${runs.length} runs into ${combinations.length} valid combinations.`,
);
console.log(`Report: ${durability ? path.join(PATHS.summaryDir, `${runGroup}-report.json`) : path.join(PATHS.siteDataDir, "mysql.json")}`);
