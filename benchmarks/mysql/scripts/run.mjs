#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { measureRepeats } from "./protocol.mjs";
import { LOGGING_MODES, readLoggingState, assertLoggingMatch } from "./logging.mjs";
import { startResourceCapture } from "./resources.mjs";
import {
  CONCURRENCY_LEVELS,
  PATHS,
  SCENARIO_ORDER,
  SCENARIOS,
  assert,
  composeServiceShell,
  createSysbenchArguments,
  createSysbenchShellCommand,
  ensureDirectories,
  loadBenchmarkEnv,
  nowIso,
  mysqlQuery,
  parseCliArguments,
  parseSysbenchOutput,
  readJson,
  runProcess,
  redactSecrets,
  waitForMysql,
  writeJson,
} from "./lib.mjs";

function parseList(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const cli = parseCliArguments(process.argv.slice(2));
const env = loadBenchmarkEnv();

const scenarios = parseList(cli.scenario, SCENARIO_ORDER);
const concurrencies = parseList(cli.concurrency, CONCURRENCY_LEVELS).map(Number);
const warmupSeconds = Number(cli["warmup-seconds"] ?? env.WARMUP_SECONDS);
const durationSeconds = Number(cli["duration-seconds"] ?? env.DURATION_SECONDS);
const thresholdPercent = Number(
  cli["threshold-percent"] ?? env.VARIANCE_THRESHOLD_PERCENT,
);
const repeatCount = Number(cli.runs ?? 2);
const runGroup = String(cli["run-group"] ?? "mvp");
const skipWarmup = cli["skip-warmup"] === true;
const dryRun = cli["dry-run"] === true;
const verbose = cli.verbose === true;
const containerName = cli["container-name"] ? String(cli["container-name"]) : undefined;
const purpose = cli.purpose === "formal" ? "formal" : "verification";
const recordResources = cli["record-resources"] === true;
assert(!recordResources || containerName, "Resource sampling requires a named load container");
assert(/^[a-zA-Z0-9_-]+$/.test(runGroup), "Invalid run group");
assert(!containerName || /^[a-zA-Z0-9_-]+$/.test(containerName), "Invalid container name");

for (const scenario of scenarios) {
  assert(SCENARIOS[scenario], `Unsupported scenario: ${scenario}`);
}
for (const concurrency of concurrencies) {
  assert(
    Number.isInteger(concurrency) && concurrency > 0,
    `Invalid concurrency: ${concurrency}`,
  );
}
assert(warmupSeconds >= 0, "warmup-seconds must be zero or greater");
assert(durationSeconds > 0, "duration-seconds must be greater than zero");
assert(repeatCount >= 1 && repeatCount <= 3, "runs must be between 1 and 3");

const combinations = scenarios.flatMap((scenario) =>
  concurrencies.map((concurrency) => ({ scenario, concurrency })),
);
let environmentPath = cli["environment-path"]
  ? path.resolve(PATHS.projectRoot, String(cli["environment-path"]))
  : path.join(PATHS.resultsDir, "environment.json");

if (dryRun) {
  console.log("Dry run: no benchmark commands will be executed.\n");
  for (const combination of combinations) {
    const common = {
      env,
      scenario: combination.scenario,
      concurrency: combination.concurrency,
      durationSeconds,
    };
    const warmupArguments = createSysbenchArguments({
      ...common,
      durationSeconds: warmupSeconds,
      command: "run",
    });
    const measuredArguments = createSysbenchArguments({
      ...common,
      command: "run",
    });
    if (!skipWarmup) {
      console.log(
        `[warmup] ${redactSecrets(createSysbenchShellCommand(warmupArguments), env)}`,
      );
      console.log(`         duration=${warmupSeconds}s`);
    }
    console.log(
      `[measure] ${redactSecrets(createSysbenchShellCommand(measuredArguments), env)}`,
    );
    console.log(
      `          runs=${repeatCount}, duration=${durationSeconds}s, adaptiveThird=${repeatCount === 2}`,
    );
  }
  process.exit(0);
}

ensureDirectories();
mkdirSync(PATHS.rawDir, { recursive: true });
const mysqlId = await waitForMysql(env);
let environmentSnapshot = readJson(environmentPath);
let datasetPath = cli["dataset-path"] ? path.resolve(PATHS.projectRoot, String(cli["dataset-path"])) : undefined;
if (datasetPath) env.TABLE_SIZE = String(readJson(datasetPath).tableSize);
const bufferPoolExperiment = cli["buffer-pool"] === true;
const rowCount = async () => Number(await mysqlQuery(env, `SELECT ${Array.from({length: Number(env.TABLE_COUNT)}, (_,i) => `(SELECT COUNT(*) FROM \`${env.MYSQL_DATABASE}\`.sbtest${i+1})`).join("+")};`));
const pageCounters = async () => {
  const values = await mysqlQuery(env, "SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads');");
  return { timeMs: Date.now(), ...Object.fromEntries(values.split("\n").map(row => {const [key,value]=row.split("\t"); return [key,Number(value)];})) };
};
let insertStart;
if (scenarios.includes("update_index_async")) {
  assertLoggingMatch(await readLoggingState((sql) => mysqlQuery(env, sql)), LOGGING_MODES.update_index_async);
}
console.log(
  `Running ${combinations.length} combinations sequentially with group "${runGroup}".`,
);

async function runOnce({
  scenario,
  concurrency,
  kind,
  repeat,
  runDurationSeconds,
}) {
  const runId = `${runGroup}-${scenario}-c${concurrency}-${kind}-r${repeat}`;
  const argumentsList = createSysbenchArguments({
    env,
    scenario,
    command: "run",
    concurrency,
    durationSeconds: runDurationSeconds,
  });
  const shellCommand = createSysbenchShellCommand(argumentsList);
  const outputPath = path.join(PATHS.rawDir, `${runId}.txt`);
  const stderrPath = path.join(PATHS.rawDir, `${runId}.stderr.txt`);
  const metadataPath = path.join(PATHS.rawDir, `${runId}.meta.json`);
  if (cli["environment-path"]) {
    assert(!existsSync(outputPath) && !existsSync(metadataPath), `Refusing to overwrite existing result ${runId}`);
  }
  const startedAt = nowIso();

  console.log(
    `Running ${scenario} c=${concurrency} ${kind} r=${repeat} for ${runDurationSeconds}s...`,
  );
  const capture = kind === "measured" && recordResources ? await startResourceCapture({
    mysqlId, loadName: containerName, expectedSeconds: runDurationSeconds,
    cpus: Number(env.LOADGEN_CPUS), mysqlCpus: Number(env.MYSQL_CPUS), intervalMs: runDurationSeconds < 20 ? 1000 : 5000,
  }) : null;
  let result;
  let resourceData;
  const rowsBefore = scenario === "insert" ? await rowCount() : undefined;
  const pagesBefore = bufferPoolExperiment ? await pageCounters() : undefined;
  const pageSamples = pagesBefore ? [pagesBefore] : [];
  let samplingPages = true;
  let pageTimer;
  let pageWake;
  let pageSampleError;
  const pageLoop = bufferPoolExperiment ? (async () => {
    while (samplingPages) {
      await new Promise(resolve=>{pageWake=resolve;pageTimer=setTimeout(resolve,10000);});
      if (samplingPages) pageSamples.push(await pageCounters());
    }
  })().catch(error=>{pageSampleError=error;}) : null;
  try {
    result = await composeServiceShell(env, "sysbench", shellCommand, { echo: verbose, containerName });
  } finally {
    if (capture) resourceData = await capture.stop();
    samplingPages = false;
    clearTimeout(pageTimer);
    pageWake?.();
    if (pageLoop) await pageLoop;
  }
  const finishedAt = nowIso();
  const pagesAfter = bufferPoolExperiment ? await pageCounters() : undefined;
  const rowsAfter = scenario === "insert" ? await rowCount() : undefined;

  writeFileSync(outputPath, `${result.stdout.replace(/[ \t]+$/gm, "").trimEnd()}\n`, "utf8");
  writeFileSync(stderrPath, result.stderr, "utf8");

  let metrics = null;
  let parseError = null;
  try {
    metrics = parseSysbenchOutput(result.stdout);
  } catch (error) {
    parseError = error.message;
  }

  const status =
    result.code === 0 && metrics && metrics.errors === 0
      && !(purpose === "formal" && kind === "measured" && !resourceData?.summary.valid)
      ? "passed"
      : "failed";
  const metadata = {
    schemaVersion: 1,
    runId,
    runGroup,
    purpose,
    scenario,
    scenarioLabel: SCENARIOS[scenario].label,
    concurrency,
    kind,
    repeat,
    status,
    exitCode: result.code,
    protocol: {
      warmupSeconds,
      durationSeconds: runDurationSeconds,
      adaptiveThresholdPercent: thresholdPercent,
      repeatCount,
    },
    startedAt,
    finishedAt,
    command: redactSecrets(shellCommand, env),
    rawOutputPath: path.relative(PATHS.projectRoot, outputPath),
    stderrPath: path.relative(PATHS.projectRoot, stderrPath),
    environmentPath: path.relative(
      PATHS.projectRoot,
      environmentPath,
    ),
    environment: environmentSnapshot,
    ...(datasetPath ? { datasetPath: path.relative(PATHS.projectRoot, datasetPath) } : {}),
    ...(scenario === "insert" ? { rowCounts: { before: rowsBefore, after: rowsAfter, ...insertStart } } : {}),
    ...(bufferPoolExperiment ? { bufferPool: { before: pagesBefore, after: pagesAfter, samples: [...pageSamples,pagesAfter] } } : {}),
    metrics,
    parseError,
    ...(resourceData ? {
      resources: { ...resourceData.summary, rawPath: path.relative(PATHS.projectRoot, path.join(PATHS.rawDir, `${runId}.resources.json`)) },
    } : {}),
  };
  if (resourceData) writeJson(path.join(PATHS.rawDir, `${runId}.resources.json`), resourceData);
  writeJson(metadataPath, metadata);
  assert(!pageSampleError, `Buffer Pool sampling failed: ${pageSampleError?.message}`);

  assert(
    result.code === 0,
    `${runId} failed with exit code ${result.code}`,
  );
  assert(purpose !== "formal" || kind !== "measured" || resourceData?.summary.valid,
    `${runId} has insufficient resource evidence: ${JSON.stringify(resourceData?.summary)}`);
  assert(
    !parseError,
    `${runId} output could not be parsed: ${parseError}`,
  );
  assert(
    metrics.errors === 0,
    `${runId} reported ${metrics.errors} errors`,
  );
  if (scenario === "insert") assert(rowsAfter - rowsBefore === metrics.transactions && metrics.queries === metrics.transactions, "INSERT growth/event mismatch");

  console.log(
    `  ${status}: TPS ${metrics.tps.toFixed(2)}, QPS ${metrics.qps.toFixed(2)}, p95 ${metrics.p95Ms.toFixed(2)} ms, p99 ${metrics.p99Ms.toFixed(2)} ms`,
  );
  return metadata;
}

for (const combination of combinations) {
  const { scenario, concurrency } = combination;
  if (scenario !== "insert" && !skipWarmup && warmupSeconds > 0) {
    await runOnce({
      ...combination,
      kind: "warmup",
      repeat: 1,
      runDurationSeconds: warmupSeconds,
    });
  }

  async function prepareInsert(repeat) {
    if (repeat > 1) {
      const prefix = `${runGroup}-insert-c${concurrency}-repeat${repeat}`;
      const result = await runProcess(process.execPath, [path.join(PATHS.benchmarkRoot,"scripts/prepare.mjs"), `--manifest-prefix=${prefix}`, `--container-name=${containerName?.replace(/-load$/, "-prepare") ?? prefix + "-prepare"}`], {echo:true});
      assert(result.code === 0, "INSERT repeat preparation failed");
      environmentPath = path.join(PATHS.resultsDir, `${prefix}-environment.json`);
      datasetPath = path.join(PATHS.resultsDir, `${prefix}-dataset.json`);
      environmentSnapshot = readJson(environmentPath);
    }
    const beforeWarmup = await rowCount();
    assert(beforeWarmup === Number(env.TABLE_COUNT) * Number(env.TABLE_SIZE), "INSERT repeat initial row count mismatch");
    const warmup = await runOnce({...combination, kind:"warmup", repeat, runDurationSeconds:warmupSeconds});
    insertStart = { beforeWarmup, afterWarmup: warmup.rowCounts.after, warmupEvents: warmup.metrics.transactions };
  }
  await measureRepeats({repeatCount,thresholdPercent,
    beforeRepeat:scenario === "insert" ? prepareInsert : undefined,
    measure: repeat => runOnce({...combination,kind:"measured",repeat,runDurationSeconds:durationSeconds}),
    onThird:()=>console.log(`${scenario} c=${concurrency} exceeded the ${thresholdPercent}% variance threshold; running a third measurement.`),
  });
}

console.log("All requested benchmark runs completed.");
