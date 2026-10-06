#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  PATHS, assert, listFiles, loadBenchmarkEnv, mysqlQuery, nowIso, parseCliArguments,
  readJson, runProcess, waitForMysql, writeJson,
} from "./lib.mjs";
import {
  LOGGING_MODES, durabilityPlan, readLoggingState, setLoggingState,
  withLoggingRestored, assertLoggingMatch, formalPlan,
} from "./logging.mjs";

const cli = parseCliArguments(process.argv.slice(2));
const env = loadBenchmarkEnv();
const formal = cli.formal === true;
const plan = formal ? formalPlan(env, cli) : { ...durabilityPlan(env, cli), purpose: "verification" };
const group = String(cli["run-group"] ?? `${formal ? plan.isFull ? "formal-8cpu" : "smoke-formal8cpu" : "durability"}-${randomUUID().slice(0, 8)}`);
assert(/^[a-zA-Z0-9_-]+$/.test(group), "Invalid run group");

if (cli["dry-run"] === true) {
  console.log(`Dry run only (${plan.purpose}). No files, containers or MySQL parameters will be changed.`);
  console.log(`Rebuild ${env.MYSQL_DATABASE}: ${env.TABLE_COUNT} tables x ${env.TABLE_SIZE} rows before each combination.`);
  for (const combination of plan.combinations) {
    console.log(`${combination.scenario} c=${combination.concurrency}: redo=${combination.logging.flushLogAtTransactionCommit}, sync_binlog=${combination.logging.syncBinlog}, binlog ON, timeout=1; ${plan.warmupSeconds}s warmup + ${plan.repeats} x ${plan.durationSeconds}s, adaptive third run.`);
  }
  if (formal && plan.isFull) console.log("Independent Buffer Pool experiment: 1/2 GiB, shared ~1.5 GiB dataset, c16, 30s warmup + 2 x 90s, adaptive third run above 30%; publish only after both experiments pass.");
  console.log("Verify logging, restore original parameters before collecting/publishing. Do not run other benchmarks concurrently.");
  process.exit(0);
}

assert(!listFiles(PATHS.rawDir, ".meta.json").some((file) => readJson(file).runGroup === group),
  `Run group ${group} already exists; choose a new name`);
const containerId = await waitForMysql(env);
const inspected = await runProcess("docker", ["inspect", containerId]);
assert(inspected.code === 0, "Cannot inspect project MySQL");
const container = JSON.parse(inspected.stdout)[0];
assert(container.Config.Labels["com.docker.compose.project"] === "performance-profile-mysql"
  && container.Config.Labels["com.docker.compose.service"] === "mysql", "Refusing non-project MySQL");
assert(container.HostConfig.NanoCpus === Number(env.MYSQL_CPUS) * 1e9, "MySQL CPU limit mismatch");
assert(container.HostConfig.Memory === 6 * 1024 ** 3, "Expected 6 GiB MySQL memory limit");

const query = (sql) => mysqlQuery(env, sql);
const aborter = new AbortController();
let activeContainer;
let interrupted = false;
const onSignal = () => { interrupted = true; aborter.abort(); };
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

async function execute(script, args, name) {
  assert(!interrupted, "Test interrupted");
  activeContainer = name;
  const result = await runProcess(process.execPath, [
    path.join(PATHS.benchmarkRoot, "scripts", script), ...args,
  ], { echo: true, signal: aborter.signal });
  assert(result.code === 0, `${script} failed (${result.code})`);
  activeContainer = undefined;
}

try {
  await withLoggingRestored(query, async () => {
    try {
      for (const { scenario, concurrency, logging } of plan.combinations) {
        assert(!interrupted, "Test interrupted");
        console.log(`\n${group}: ${scenario} / concurrency ${concurrency}`);
        await setLoggingState(query, LOGGING_MODES.update_index);
        const prefix = `${group}-${scenario}-c${concurrency}`;
        const environmentPath = path.join(PATHS.resultsDir, `${prefix}-environment.json`);
        const datasetPath = path.join(PATHS.resultsDir, `${prefix}-dataset.json`);
        assert(!existsSync(environmentPath) && !existsSync(datasetPath), `Refusing to overwrite ${prefix}`);
        await execute("prepare.mjs", [
          `--manifest-prefix=${prefix}`, `--container-name=${group}-prepare`,
          ...(scenario === "update_no_secondary_index" ? ["--no-secondary-index"] : []),
        ], `${group}-prepare`);
        const actual = await setLoggingState(query, logging);
        const environment = readJson(environmentPath);
        environment.mysql = { ...environment.mysql, ...actual };
        environment.generatedAt = nowIso();
        writeJson(environmentPath, environment);
        await execute("run.mjs", [
          `--scenario=${scenario}`, `--concurrency=${concurrency}`, `--run-group=${group}`,
          `--environment-path=${environmentPath}`, `--dataset-path=${datasetPath}`,
          `--container-name=${group}-load`,
          `--warmup-seconds=${plan.warmupSeconds}`, `--duration-seconds=${plan.durationSeconds}`,
          `--runs=${plan.repeats}`, `--purpose=${plan.purpose}`,
          ...(formal ? ["--record-resources"] : []),
        ], `${group}-load`);
        assertLoggingMatch(await readLoggingState(query), logging);
      }
    } finally {
      for (const name of [activeContainer,`${group}-prepare`,`${group}-load`].filter(Boolean)) {
        const result = await runProcess("docker", ["inspect", name]);
        if (result.code === 0) {
          const stopped = await runProcess("docker", ["rm", "-f", name]);
          assert(stopped.code === 0, `Failed to stop owned load container ${name}`);
        }
      }
    }
  });
  assert(!interrupted, "Test interrupted");
  for (const file of listFiles(PATHS.rawDir, ".meta.json")) {
    const metadata = readJson(file);
    if (metadata.runGroup !== group) continue;
    metadata.restorationVerified = true;
    writeJson(file, metadata);
  }
  console.log("\nOriginal logging parameters restored and verified.");
  if (formal && plan.isFull) await execute("buffer-pool.mjs", [`--run-group=${group}`], `${group}-load`);
  const full = formal ? plan.isFull : plan.concurrency.length === 3 && plan.warmupSeconds === 60
    && plan.durationSeconds === 120 && plan.repeats === 2;
  const result = await runProcess(process.execPath, [
    path.join(PATHS.benchmarkRoot, "scripts/collect.mjs"),
    `--run-group=${group}`, formal ? "--formal" : "--durability",
    ...(!full ? ["--allow-partial"] : []),
    ...(formal && plan.isFull && cli["no-publish"] !== true ? ["--publish"] : []),
  ], { echo: true });
  assert(result.code === 0, "Result collection failed");
  if (!formal || !plan.isFull) console.log("Development/verification results saved only; final dashboard was not updated.");
  console.log(`Run group: ${group}`);
} catch (error) {
  console.error(error.message);
  if (error.errors) error.errors.forEach((cause) => console.error(cause.message));
  process.exitCode = 1;
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
