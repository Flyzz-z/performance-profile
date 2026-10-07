#!/usr/bin/env node
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { PATHS, assert, loadBenchmarkEnv, parseCliArguments, runProcess, waitForMysql, mysqlQuery,
  composeServiceShell, createSysbenchArguments, createSysbenchShellCommand, redactSecrets, parseSysbenchOutput,
  readJson, writeJson, nowIso, shellQuote, sleep } from "./lib.mjs";
import { withLoggingRestored, readLoggingState, assertLoggingMatch, LOGGING_MODES } from "./logging.mjs";
import { startResourceCapture } from "./resources.mjs";
import { HOT_PROTOCOL, HOT_GROUPS, activeRows, idLimit, parseLockCounters, lockMetrics,
  validateHotEnvironment, validateHotExperiment, publishHotExperiment } from "./hot-update-results.mjs";

const cli = parseCliArguments(process.argv.slice(2));
const verification = cli.verification === true;
const protocol = verification ? { ...HOT_PROTOCOL, warmupSeconds: 3, durationSeconds: 10 } : HOT_PROTOCOL;
const groupName = String(cli.group ?? `hot-update-${new Date().toISOString().replace(/[^0-9]/g, "")}`);
assert(/^[a-zA-Z0-9_-]+$/.test(groupName), "Invalid group name");
const env = { ...loadBenchmarkEnv(), TABLE_COUNT: "10", TABLE_SIZE: "100000" };
assert(Number(env.MYSQL_CPUS) === 8 && Number(env.LOADGEN_CPUS) === 4 && env.MYSQL_MEMORY === "6g"
  && env.LOADGEN_MEMORY === "1g" && env.MYSQL_PLATFORM === "linux/arm64", "Configured environment mismatch");
if (cli["dry-run"]) {
  console.log(JSON.stringify({ purpose: verification ? "verification" : "formal", protocol,
    groups: HOT_GROUPS.map(id => ({ id, actualRows: 1000000, activeRows: activeRows(id), idLimit: idLimit(id), tables: 10,
      script: "oltp_update_index.lua" })), publish: !verification }, null, 2));
} else if (cli["publish-summary"]) {
  publishHotExperiment(readJson(path.resolve(String(cli["publish-summary"]))));
  console.log("Independent hot update results published after evidence verification.");
} else {
  const root = verification ? path.join(PATHS.resultsDir, "verification", groupName) : PATHS.resultsDir;
  const summaryPath = path.join(root, `${groupName}-hot-update.json`);
  assert(!existsSync(summaryPath) && !HOT_GROUPS.some(id => existsSync(path.join(root, `${groupName}-${id}-dataset.json`))), "Group already exists; refusing overwrite");
  const controller = new AbortController();
  const owned = new Set();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const options = { env: { ...process.env, ...env }, signal: controller.signal };
  const query = sql => mysqlQuery(env, sql);
  const relative = file => path.relative(PATHS.projectRoot, file);
  const experiment = { schemaVersion: 1, purpose: verification ? "verification" : "formal", runGroup: groupName,
    testedAt: nowIso(), protocol, restorationVerified: false, groups: [] };
  mkdirSync(root, { recursive: true });
  try {
    const mysqlId = await waitForMysql(env);
    const inspectResult = await runProcess("docker", ["inspect", mysqlId]);
    assert(inspectResult.code === 0, "Unable to inspect project MySQL");
    const mysql = JSON.parse(inspectResult.stdout)[0];
    assert(mysql.Config.Labels["com.docker.compose.project"] === "performance-profile-mysql"
      && mysql.Config.Labels["com.docker.compose.service"] === "mysql", "MySQL ownership mismatch");
    assert(mysql.HostConfig.NanoCpus === 8e9 && mysql.HostConfig.Memory === 6 * 1024 ** 3, "Actual MySQL quotas mismatch");
    const loadImage = await runProcess("docker", ["image", "inspect", env.LOADGEN_IMAGE]);
    assert(loadImage.code === 0, "Unable to inspect sysbench image");
    const loadImageInfo = JSON.parse(loadImage.stdout)[0];
    assert(loadImageInfo.Os === "linux" && loadImageInfo.Architecture === "arm64", "Actual sysbench platform mismatch");
    assert(Number(await query("SELECT @@innodb_buffer_pool_size;")) === 3 * 1024 ** 3, "Actual buffer pool mismatch");
    const clients = await query("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER <> 'system user' AND ID <> CONNECTION_ID() AND COMMAND <> 'Daemon';");
    assert(Number(clients) === 0, "Other MySQL clients present; refusing overlapping experiment");
    await withLoggingRestored(query, async () => {
      for (const id of HOT_GROUPS) {
        assert(!controller.signal.aborted, "Interrupted before group preparation");
        const prefix = `${groupName}-${id}`;
        const prepareName = `pp-${prefix}-prepare`;
        owned.add(prepareName);
        console.log(`Preparing ${id}: 10 tables / 1,000,000 physical rows`);
        const prepare = await runProcess("node", [path.join(PATHS.benchmarkRoot, "scripts/prepare.mjs"),
          `--manifest-prefix=${prefix}`, `--container-name=${prepareName}`], options);
        assert(prepare.code === 0, redactSecrets(prepare.stderr, env) || "Preparation failed");
        for (const kind of ["dataset", "environment"]) {
          const source = path.join(PATHS.resultsDir, `${prefix}-${kind}.json`);
          if (verification) renameSync(source, path.join(root, `${prefix}-${kind}.json`));
        }
        const datasetPath = path.join(root, `${prefix}-dataset.json`);
        const environmentPath = path.join(root, `${prefix}-environment.json`);
        const environment = readJson(environmentPath);
        assert(environment.container.imageId === mysql.Image, "Running MySQL image differs from manifest");
        environment.loadGenerator.imageId = loadImageInfo.Id;
        environment.loadGenerator.imagePlatform = "linux/arm64";
        environment.exploratory = verification;
        validateHotEnvironment(environment);
        writeJson(environmentPath, environment);
        const group = { id, label: id === "hot" ? "热点更新" : "分散更新", runGroup: groupName, actualRows: 1000000,
          activeRows: activeRows(id), idLimit: idLimit(id), environment, environmentPath: relative(environmentPath),
          datasetPath: relative(datasetPath), runs: [] };
        const targetEnv = { ...env, TABLE_SIZE: String(idLimit(id)) };
        const outsideSum = async () => {
          const sums = [];
          for (let table = 1; table <= 10; table++) sums.push(Number(await query(`SELECT SUM(k) FROM \`${env.MYSQL_DATABASE}\`.sbtest${table} WHERE id>1;`)));
          return sums;
        };
        const outsideBefore = verification ? await outsideSum() : null;
        for (const kind of ["warmup", "measured"]) {
          assert(!controller.signal.aborted, "Interrupted before measurement");
          const seconds = kind === "warmup" ? protocol.warmupSeconds : protocol.durationSeconds;
          const name = `pp-${prefix}-${kind}`;
          owned.add(name);
          const args = createSysbenchArguments({ env: targetEnv, scenario: "update_index", command: "run", concurrency: 16, durationSeconds: seconds });
          const rawPath = path.join(root, `${prefix}-${kind}.txt`);
          const run = { kind, group: id, runGroup: groupName, arguments: args.map(a => redactSecrets(a, env)),
            rawOutputPath: relative(rawPath), startedAt: nowIso() };
          assertLoggingMatch(await readLoggingState(query), LOGGING_MODES.update_index);
          let capture;
          let before;
          if (kind === "measured") {
            before = parseLockCounters(await query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_row_lock_waits','Innodb_row_lock_time');"), Date.now());
            capture = await startResourceCapture({ mysqlId, loadName: name, expectedSeconds: seconds, cpus: 4, mysqlCpus: 8, intervalMs: verification ? 1000 : 5000 });
          }
          console.log(`${id}: ${kind}, 16 threads, ${seconds}s, ${group.activeRows} active rows`);
          let result;
          let resources;
          let completed = false;
          const donePath = path.join(root, `${prefix}-${kind}.done`);
          const releasePath = path.join(root, `${prefix}-${kind}.release`);
          const mounted = file => `/workspace/results/${path.relative(PATHS.resultsDir, file)}`;
          // Keep the container alive until the host closes the evidence window.
          const shell = `${createSysbenchShellCommand(args)}; code=$?; printf '%s' "$code" > ${shellQuote(mounted(donePath))}; while [ ! -f ${shellQuote(mounted(releasePath))} ]; do sleep 0.1; done; exit "$code"`;
          const processResult = composeServiceShell(env, "sysbench", shell, { ...options, containerName: name })
            .finally(() => { completed = true; });
          try {
            const finished = (async () => {
              while (!completed && !existsSync(donePath)) await sleep(100);
            })();
            await Promise.race([processResult, finished]);
            if (capture) { resources = await capture.stop(); capture = null; }
            writeFileSync(releasePath, "release\n", { flag: "wx" });
            result = await processResult;
            rmSync(donePath, { force: true });
            rmSync(releasePath, { force: true });
          } finally {
            if (capture) resources = await capture.stop();
            if (!completed && !existsSync(releasePath)) writeFileSync(releasePath, "release\n", { flag: "wx" });
            await processResult.catch(() => {});
          }
          run.finishedAt = nowIso();
          run.exitCode = result.code;
          writeFileSync(rawPath, redactSecrets(`${result.stdout}\n${result.stderr}`, env), { flag: "wx" });
          assert(result.code === 0, "Fatal sysbench exit; results will not be published");
          run.metrics = parseSysbenchOutput(result.stdout);
          if (kind === "measured") {
            const after = parseLockCounters(await query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_row_lock_waits','Innodb_row_lock_time');"), Date.now());
            group.locks = lockMetrics(before, after);
            const lockPath = path.join(root, `${prefix}-locks.json`);
            const resourcePath = path.join(root, `${prefix}-resources.json`);
            writeJson(lockPath, { before, after });
            writeJson(resourcePath, resources);
            run.lockPath = relative(lockPath);
            run.resourcePath = relative(resourcePath);
            assert(resources.summary.valid, "Resource evidence insufficient; results will not be published");
            console.log(`${id}: TPS ${run.metrics.tps}, p99 ${run.metrics.p99Ms}ms, waits ${group.locks.waits}, failures ${run.metrics.ignoredErrors}`);
          }
          writeJson(path.join(root, `${prefix}-${kind}.json`), run);
          group.runs.push(run);
        }
        if (verification) {
          const outsideAfter = await outsideSum();
          assert(outsideBefore.every((value, i) => id === "hot" ? value === outsideAfter[i] : outsideAfter[i] > value), "Observed updates do not match the target ID range");
          writeJson(path.join(root, `${prefix}-range-check.json`), { outsideBefore, outsideAfter, idLimit: group.idLimit, verified: true });
        }
        experiment.groups.push(group);
      }
    });
    const restoration = await readLoggingState(query);
    assertLoggingMatch(restoration, LOGGING_MODES.update_index);
    const restorationPath = path.join(root, `${groupName}-restoration.json`);
    writeJson(restorationPath, { logging: restoration, checkedAt: nowIso() });
    experiment.restorationPath = relative(restorationPath);
    experiment.restorationVerified = true;
    experiment.finishedAt = nowIso();
    if (!verification) validateHotExperiment(experiment);
    writeJson(summaryPath, experiment);
    if (!verification && !cli["no-publish"]) publishHotExperiment(experiment);
    console.log(verification ? `Verification saved separately: ${summaryPath}` : `Formal experiment complete: ${summaryPath}`);
  } finally {
    for (const name of owned) await runProcess("docker", ["rm", "-f", name]);
    if (verification) {
      for (const id of HOT_GROUPS) for (const kind of ["dataset", "environment"]) {
        const source = path.join(PATHS.resultsDir, `${groupName}-${id}-${kind}.json`);
        if (existsSync(source)) renameSync(source, path.join(root, path.basename(source)));
      }
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
