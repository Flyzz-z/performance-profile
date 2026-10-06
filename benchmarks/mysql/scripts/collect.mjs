#!/usr/bin/env node

import path from "node:path";
import { copyFileSync, constants, readFileSync, renameSync, readdirSync } from "node:fs";
import { summarizeResources } from "./resources.mjs";
import {
  aggregateCombinations,
  assertUniqueRunIds,
  computeComparisons,
  validateRunRecord,
  validateSiteData,
  validateDurabilityRuns,
  validateFormalRuns,
  summarizeRunResources,
} from "./analytics.mjs";
import {
  PATHS,
  DURABILITY_SCENARIOS,
  FORMAL_SCENARIOS,
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
const formal = cli.formal === true;
const scoped = durability || formal;
const scenarios = formal ? FORMAL_SCENARIOS : durability ? DURABILITY_SCENARIOS : SCENARIO_ORDER;
assert(cli.publish !== true || formal, "Only a complete formal experiment can update the final dashboard");
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
if (formal && !allowPartial) {
  validateFormalRuns(runs);
  for (const run of runs.filter((r) => r.kind === "measured")) {
    assert(run.resources.rawPath, "Missing formal resource sampling artifact");
    const capture = readJson(path.resolve(PATHS.projectRoot, run.resources.rawPath));
    assert(capture.intervalMs === 5000 && summarizeResources(capture.samples, capture.summary.limits,
      120, capture.summary.errors, capture.intervalMs).valid, `Invalid formal resource sampling: ${run.runId}`);
    assert(run.datasetPath, "Missing formal dataset manifest");
    const prepared = readJson(path.resolve(PATHS.projectRoot, run.datasetPath));
    assert(prepared.tableCount === 10 && prepared.tableSize === 100000 && prepared.actualRows === 1000000,
      "Formal dataset size mismatch");
  }
}

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

const comparisons = scoped ? [] : computeComparisons(combinations);
assert(
  scoped || allowPartial || comparisons.length === 3,
  `Expected 3 read/write comparisons but found ${comparisons.length}`,
);

const selectedPoints = combinations.map((combination) => ({
  scenario: combination.scenario,
  concurrency: combination.concurrency,
  ...combination.selected,
  stability: combination.stability,
  attempts: combination.attempts,
  ...(formal ? { resources: summarizeRunResources(combination.runs) } : {}),
}));

const peak = [...selectedPoints].sort(
  (left, right) => right.qps - left.qps,
)[0];
const representativeComparison = comparisons.at(-1) ?? null;

const series = scenarios.map((scenario) => ({
  scenario,
  label: scoped && scenario === "update_index" ? "索引更新（同步刷盘）" : SCENARIOS[scenario].label,
  description: SCENARIOS[scenario].description,
  points: selectedPoints
    .filter((point) => point.scenario === scenario)
    .sort((left, right) => left.concurrency - right.concurrency),
  ...(scoped ? {
    runGroup,
    sourceRole: formal ? allowPartial ? "verification" : "formal" : "paired",
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
  ...(formal ? { resources: summarizeRunResources(combination.runs) } : {}),
  ...(scoped ? {
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
    ...(run.resources ? { resources: run.resources } : {}),
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
  ...(scoped ? { runGroup } : {}),
  ...(formal ? { formalExperiment: { runGroup, purpose: allowPartial ? "verification" : "formal", loadGeneratorCpuLimit: 4 },
    durabilityComparison: { runGroup,
      risk: "异步更新采用2/0，降低持久化保障；系统、VM或断电故障可能丢失已确认事务或binlog。",
      note: allowPartial ? "开发验证资料，不能发布为最终报告。"
        : "四场景均为本轮4 CPU压测端的正式测量，不包含历史或内部验证数据。" } } : {}),
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

if (scoped) {
  const measured = runs.find((run) => run.kind === "measured");
  siteData.dataset = measured.datasetPath ? readJson(path.resolve(PATHS.projectRoot, measured.datasetPath)) : dataset;
  siteData.protocol.warmupSeconds = measured.protocol.warmupSeconds;
  siteData.protocol.durationSeconds = measured.protocol.durationSeconds;
  siteData.protocol.initialRuns = measured.protocol.repeatCount;
  siteData.protocol.varianceThresholdPercent = measured.protocol.adaptiveThresholdPercent;
  combinationsResult.dataset = siteData.dataset;
}
validateSiteData(siteData, { allowPartial, scenarios });

const named = (name) => scoped ? `${runGroup}-${name}` : name;
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
writeJson(path.join(PATHS.summaryDir, `${runGroup}-report.json`), siteData);
if (cli.publish === true) {
    assert(!allowPartial && combinations.every((c) => c.attempts >= 2)
      && siteData.protocol.warmupSeconds === 60 && siteData.protocol.durationSeconds === 120
      && siteData.protocol.initialRuns === 2 && siteData.protocol.varianceThresholdPercent === 10,
    "Only a complete full-duration comparison may update the dashboard");
    validateFormalRuns(runs);
    const target = path.join(PATHS.siteDataDir, "mysql.json");
    validateSiteData(siteData, { scenarios: FORMAL_SCENARIOS });
    copyFileSync(target, path.join(PATHS.summaryDir, `${runGroup}-previous-report.json`), constants.COPYFILE_EXCL);
    const temporary = path.join(PATHS.summaryDir, `${runGroup}-pending.json`);
    writeJson(temporary, siteData);
    for (const name of readdirSync(PATHS.siteDataDir).filter((n) => n.endsWith("-previous.json"))) {
      renameSync(path.join(PATHS.siteDataDir, name), path.join(PATHS.summaryDir, `archived-${name}`));
    }
    renameSync(temporary, target);
    console.log("Final dashboard replaced with this complete formal group; old reports archived outside site data.");
}

console.log(
  `Collected ${runs.length} runs into ${combinations.length} valid combinations.`,
);
console.log(`Report: ${path.join(PATHS.summaryDir, `${runGroup}-report.json`)}`);
