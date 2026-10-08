#!/usr/bin/env node
import path from "node:path";
import { existsSync, mkdirSync, readdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { PATHS, assert, loadBenchmarkEnv, parseCliArguments, runProcess, waitForMysql, mysqlQuery,
  composeServiceShell, createSysbenchArguments, createSysbenchShellCommand, redactSecrets, parseSysbenchOutput,
  readJson, writeJson, nowIso, shellQuote, sleep } from "./lib.mjs";
import { withLoggingRestored, readLoggingState, assertLoggingMatch, LOGGING_MODES } from "./logging.mjs";
import { startResourceCapture } from "./resources.mjs";
import { measureRepeats } from "./protocol.mjs";
import { SUPPLEMENT_SCENARIOS, SUPPLEMENT_PROTOCOL, validateSupplementEnvironment,
  validateSupplement, publishSupplement } from "./supplement-results.mjs";

const cli = parseCliArguments(process.argv.slice(2));
const allowed = ["group", "dry-run", "verification", "no-publish", "publish-summary"];
assert(Object.keys(cli).every(key => allowed.includes(key)), "Unsupported supplement option; scope/protocol are fixed");
const verification = cli.verification === true;
const protocol = verification ? { ...SUPPLEMENT_PROTOCOL, warmupSeconds: 3, durationSeconds: 10 } : SUPPLEMENT_PROTOCOL;
const groupName = String(cli.group ?? `supplement32-${new Date().toISOString().replace(/[^0-9]/g, "")}`);
assert(/^[a-zA-Z0-9_-]+$/.test(groupName), "Invalid group name");
const env = { ...loadBenchmarkEnv(), TABLE_COUNT: "10", TABLE_SIZE: "100000" };
assert(Number(env.MYSQL_CPUS) === 8 && Number(env.LOADGEN_CPUS) === 4 && env.MYSQL_MEMORY === "6g"
  && env.LOADGEN_MEMORY === "1g" && env.MYSQL_PLATFORM === "linux/arm64", "Configured environment mismatch");
const report = readJson(path.join(PATHS.siteDataDir, "mysql.json"));
const baseline = { ...report.environment, loadGenerator: { ...report.environment.loadGenerator,
  imageId: report.hotUpdateExperiment?.groups[0].environment.loadGenerator.imageId } };

if (cli["dry-run"]) {
  console.log(JSON.stringify({ purpose: verification ? "verification" : "formal", protocol,
    scenes: SUPPLEMENT_SCENARIOS, tables: 10, rowsPerTable: 100000,
    mysql: "8 CPU / 6 GiB / buffer pool 3 GiB", sysbench: "4 CPU / 1 GiB", platform: "linux/arm64",
    publish: !verification && !cli["no-publish"] }, null, 2));
} else if (cli["publish-summary"]) {
  publishSupplement(readJson(path.resolve(String(cli["publish-summary"]))));
  console.log("32-concurrency supplement published after raw evidence validation.");
} else {
  const root = verification ? path.join(PATHS.resultsDir, "verification", groupName) : PATHS.resultsDir;
  const summaryPath = path.join(root, `${groupName}-supplement.json`);
  for (const directory of [PATHS.resultsDir, PATHS.rawDir, root]) {
    assert(!existsSync(directory) || !readdirSync(directory).some(file => file === groupName || file.startsWith(`${groupName}-`)),
      "Group already exists; refusing overwrite");
  }
  const controller = new AbortController();
  const owned = new Set();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const options = { env: { ...process.env, ...env }, signal: controller.signal };
  const query = sql => mysqlQuery(env, sql);
  const relative = file => path.relative(PATHS.projectRoot, file);
  const experiment = { schemaVersion: 1, purpose: verification ? "verification" : "formal", runGroup: groupName,
    testedAt: nowIso(), protocol, restorationVerified: false, runs: [] };
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, `${groupName}-reservation.json`), `${JSON.stringify({ runGroup: groupName,
    purpose: experiment.purpose, protocol, createdAt: experiment.testedAt }, null, 2)}\n`, { flag: "wx" });
  const claimContainer = async name => {
    const existing = await runProcess("docker", ["ps", "-a", "--filter", `name=^/${name}$`, "-q"]);
    assert(existing.code === 0 && !existing.stdout.trim(), "Container name already in use; refusing ownership");
    owned.add(name);
  };
  const cleanup = async () => {
    for (const name of owned) {
      const existing = await runProcess("docker", ["inspect", name]);
      if (existing.code !== 0) {
        assert(existing.stderr.includes("No such object"), "Unable to verify container cleanup");
        continue;
      }
      const container = JSON.parse(existing.stdout)[0];
      assert(container.Config.Labels["com.docker.compose.project"] === "performance-profile-mysql"
        && container.Config.Labels["com.docker.compose.service"] === "sysbench", "Cleanup ownership mismatch");
      const removed = await runProcess("docker", ["rm", "-f", name]);
      assert(removed.code === 0, "Unable to remove owned load container");
    }
  };
  const assertIdle = async () => {
    const clients = await query("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER <> 'system user' AND ID <> CONNECTION_ID() AND COMMAND <> 'Daemon';");
    assert(Number(clients) === 0, "Other MySQL clients present; refusing overlapping experiment");
  };
  try {
    const mysqlId = await waitForMysql(env);
    const inspect = await runProcess("docker", ["inspect", mysqlId]);
    assert(inspect.code === 0, "Unable to inspect project MySQL");
    const mysql = JSON.parse(inspect.stdout)[0];
    assert(mysql.Config.Labels["com.docker.compose.project"] === "performance-profile-mysql"
      && mysql.Config.Labels["com.docker.compose.service"] === "mysql", "MySQL ownership mismatch");
    assert(mysql.HostConfig.NanoCpus === 8e9 && mysql.HostConfig.Memory === 6 * 1024 ** 3, "Actual MySQL quotas mismatch");
    const inspectImage = async image => {
      const result = await runProcess("docker", ["image", "inspect", image]);
      assert(result.code === 0, "Unable to inspect image");
      const info = JSON.parse(result.stdout)[0];
      assert(info.Os === "linux" && info.Architecture === "arm64", "Actual image platform mismatch");
      return info;
    };
    const mysqlImage = await inspectImage(mysql.Image);
    const loadImage = await inspectImage(env.LOADGEN_IMAGE);
    assert(mysqlImage.Id === baseline.container.imageId && loadImage.Id === baseline.loadGenerator.imageId,
      "Actual images differ from baseline evidence");
    assert(Number(await query("SELECT @@innodb_buffer_pool_size;")) === 3221225472, "Actual buffer pool mismatch");
    await assertIdle();
    await withLoggingRestored(query, async () => {
      try {
        for (const scenario of SUPPLEMENT_SCENARIOS) {
          assert(!controller.signal.aborted, "Interrupted before scene preparation");
          await assertIdle();
          const prefix = `${groupName}-${scenario}-c32`;
          const prepareName = `pp-${prefix}-prepare`;
          await claimContainer(prepareName);
          console.log(`Preparing ${scenario}: 10 tables / 1,000,000 rows, primary + k index`);
          const prepare = await runProcess("node", [path.join(PATHS.benchmarkRoot, "scripts/prepare.mjs"),
            `--manifest-prefix=${prefix}`, `--container-name=${prepareName}`], options);
          assert(prepare.code === 0, redactSecrets(prepare.stderr, env) || "Preparation failed");
          for (const kind of ["dataset", "environment"]) {
            if (verification) renameSync(path.join(PATHS.resultsDir, `${prefix}-${kind}.json`), path.join(root, `${prefix}-${kind}.json`));
          }
          const datasetPath = path.join(root, `${prefix}-dataset.json`);
          const environmentPath = path.join(root, `${prefix}-environment.json`);
          const environment = readJson(environmentPath);
          assert(environment.container.imageId === mysql.Image, "Running image differs from manifest");
          environment.loadGenerator.imageId = loadImage.Id;
          environment.loadGenerator.imagePlatform = "linux/arm64";
          environment.exploratory = verification;
          validateSupplementEnvironment(environment, baseline);
          writeJson(environmentPath, environment);
          const measure = async (kind, repeat) => {
            assert(!controller.signal.aborted, "Interrupted before measurement");
            await assertIdle();
            assertLoggingMatch(await readLoggingState(query), LOGGING_MODES.update_index);
            const seconds = kind === "warmup" ? protocol.warmupSeconds : protocol.durationSeconds;
            const runId = `${prefix}-${kind}-r${repeat}`;
            const name = `pp-${runId}`;
            await claimContainer(name);
            const args = createSysbenchArguments({ env, scenario, command: "run", concurrency: 32, durationSeconds: seconds });
            const rawPath = path.join(root, `${runId}.txt`);
            const metadataPath = path.join(root, `${runId}.meta.json`);
            const run = { runId, runGroup: groupName, purpose: experiment.purpose, scenario, concurrency: 32,
              kind, repeat, protocol: { ...protocol, durationSeconds: seconds }, startedAt: nowIso(),
              arguments: args.map(a => redactSecrets(a, env)), rawOutputPath: relative(rawPath),
              metadataPath: relative(metadataPath), environmentPath: relative(environmentPath), environment,
              datasetPath: relative(datasetPath), restorationVerified: false };
            run.command = run.arguments.join(" ");
            let capture = kind === "measured" ? await startResourceCapture({ mysqlId, loadName: name,
              expectedSeconds: seconds, cpus: 4, mysqlCpus: 8, intervalMs: verification ? 2000 : 5000 }) : null;
            const donePath = path.join(root, `${runId}.done`);
            const releasePath = path.join(root, `${runId}.release`);
            const mounted = file => `/workspace/results/${path.relative(PATHS.resultsDir, file)}`;
            // End sampling before the load container exits, preserving the final evidence window.
            const shell = `${createSysbenchShellCommand(args)}; code=$?; printf '%s' "$code" > ${shellQuote(mounted(donePath))}; while [ ! -f ${shellQuote(mounted(releasePath))} ]; do sleep 0.1; done; exit "$code"`;
            let completed = false;
            const pending = composeServiceShell(env, "sysbench", shell, { ...options, containerName: name })
              .finally(() => { completed = true; });
            let result;
            let resources;
            console.log(`${scenario}: ${kind} r${repeat}, 32 threads, ${seconds}s`);
            try {
              await Promise.race([pending, (async () => {
                while (!completed && !existsSync(donePath)) await sleep(100);
              })()]);
              if (capture) { resources = await capture.stop(); capture = null; }
              writeFileSync(releasePath, "release\n", { flag: "wx" });
              result = await pending;
            } finally {
              if (capture) await capture.stop();
              if (!completed && !existsSync(releasePath)) writeFileSync(releasePath, "release\n", { flag: "wx" });
              await pending.catch(() => {});
              rmSync(donePath, { force: true });
              rmSync(releasePath, { force: true });
            }
            run.finishedAt = nowIso();
            run.exitCode = result.code;
            run.status = result.code === 0 ? "passed" : "failed";
            writeFileSync(rawPath, redactSecrets(`${result.stdout}\n${result.stderr}`, env), { flag: "wx" });
            writeJson(metadataPath, run);
            assert(result.code === 0, "Fatal sysbench exit; no publication");
            run.metrics = parseSysbenchOutput(result.stdout);
            assert(run.metrics.errors === 0, "Workload errors; no publication");
            if (resources) {
              const resourcePath = path.join(root, `${runId}.resources.json`);
              writeJson(resourcePath, resources);
              run.resources = { ...resources.summary, rawPath: relative(resourcePath) };
              writeJson(metadataPath, run);
              assert(resources.summary.valid, "Insufficient resource evidence; no publication");
            }
            writeJson(metadataPath, run);
            experiment.runs.push(run);
            console.log(`${scenario} ${kind} r${repeat}: TPS ${run.metrics.tps}, p99 ${run.metrics.p99Ms}ms, errors ${run.metrics.errors}`);
            return run;
          };
          await measure("warmup", 1);
          await measureRepeats({ repeatCount: 2, thresholdPercent: 30,
            measure: repeat => measure("measured", repeat),
            onThird: () => console.log(`${scenario}: TPS/p99 difference >30%, measuring third observation`) });
        }
      } finally { await cleanup(); }
    });
    const restoration = await readLoggingState(query);
    assertLoggingMatch(restoration, LOGGING_MODES.update_index);
    const bufferPoolBytes = Number(await query("SELECT @@innodb_buffer_pool_size;"));
    assert(bufferPoolBytes === 3221225472, "Restored cache mismatch");
    const restorationPath = path.join(root, `${groupName}-restoration.json`);
    writeJson(restorationPath, { runGroup: groupName, logging: restoration, bufferPoolBytes, checkedAt: nowIso() });
    experiment.restorationPath = relative(restorationPath);
    experiment.restorationVerified = true;
    experiment.finishedAt = nowIso();
    for (const run of experiment.runs) {
      run.restorationVerified = true;
      writeJson(path.resolve(PATHS.projectRoot, run.metadataPath), run);
    }
    if (!verification) validateSupplement(experiment, baseline);
    writeJson(summaryPath, experiment);
    if (!verification && !cli["no-publish"]) publishSupplement(experiment);
    console.log(`Complete (${experiment.purpose}): ${summaryPath}`);
  } finally {
    await cleanup();
    if (verification) for (const scenario of SUPPLEMENT_SCENARIOS) for (const kind of ["dataset", "environment"]) {
      const source = path.join(PATHS.resultsDir, `${groupName}-${scenario}-c32-${kind}.json`);
      if (existsSync(source)) renameSync(source, path.join(root, path.basename(source)));
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
