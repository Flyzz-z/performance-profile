#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { shouldRunThirdRun } from "./analytics.mjs";
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
  parseCliArguments,
  parseSysbenchOutput,
  readJson,
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
ensureDirectories();
mkdirSync(PATHS.rawDir, { recursive: true });

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
const environmentPath = path.join(PATHS.resultsDir, "environment.json");
const environmentSnapshot = readJson(environmentPath);

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

await waitForMysql(env);
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
  const startedAt = nowIso();

  console.log(
    `Running ${scenario} c=${concurrency} ${kind} r=${repeat} for ${runDurationSeconds}s...`,
  );
  const result = await composeServiceShell(env, "sysbench", shellCommand, {
    echo: verbose,
  });
  const finishedAt = nowIso();

  writeFileSync(outputPath, result.stdout, "utf8");
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
      ? "passed"
      : "failed";
  const metadata = {
    schemaVersion: 1,
    runId,
    runGroup,
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
    metrics,
    parseError,
  };
  writeJson(metadataPath, metadata);

  assert(
    result.code === 0,
    `${runId} failed with exit code ${result.code}`,
  );
  assert(
    !parseError,
    `${runId} output could not be parsed: ${parseError}`,
  );
  assert(
    metrics.errors === 0,
    `${runId} reported ${metrics.errors} errors`,
  );

  console.log(
    `  ${status}: TPS ${metrics.tps.toFixed(2)}, QPS ${metrics.qps.toFixed(2)}, p95 ${metrics.p95Ms.toFixed(2)} ms, p99 ${metrics.p99Ms.toFixed(2)} ms`,
  );
  return metadata;
}

for (const combination of combinations) {
  const { scenario, concurrency } = combination;
  if (!skipWarmup && warmupSeconds > 0) {
    await runOnce({
      ...combination,
      kind: "warmup",
      repeat: 1,
      runDurationSeconds: warmupSeconds,
    });
  }

  const measuredRuns = [];
  for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
    measuredRuns.push(
      await runOnce({
        ...combination,
        kind: "measured",
        repeat,
        runDurationSeconds: durationSeconds,
      }),
    );
  }

  if (
    repeatCount === 2 &&
    measuredRuns.length === 2 &&
    shouldRunThirdRun(measuredRuns, thresholdPercent)
  ) {
    console.log(
      `${scenario} c=${concurrency} exceeded the ${thresholdPercent}% variance threshold; running a third measurement.`,
    );
    measuredRuns.push(
      await runOnce({
        ...combination,
        kind: "measured",
        repeat: 3,
        runDurationSeconds: durationSeconds,
      }),
    );
  }
}

console.log("All requested benchmark runs completed.");
