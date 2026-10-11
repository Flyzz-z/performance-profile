#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assert, nowIso, parseCliArguments, runProcess, writeJson } from "../../mysql/scripts/lib.mjs";
import { CONFIG_NAMES, PATHS, containerId, dockerVmSnapshot, execIn, hostSnapshot, loadRedisEnv, readConfig,
  readInfo, redisCli, removeOwnedContainers, startStack } from "./lib.mjs";
import { ENVIRONMENT, GROUP_LABELS, GROUP_ORDER, PROTOCOL, buildMatrix, estimatedMinutes, matrixCounts, nominalPayloadBytes } from "./protocol.mjs";
import { memtierRunArguments, parseMemtierJson } from "./memtier.mjs";
import { assertConfigMatches, diffSnapshots, parseSlowlogLen } from "./redis-info.mjs";
import { dockerSocket, inspectContainer, startResourceCapture } from "./resources.mjs";
import { prepareCombination, profileFor } from "./prepare.mjs";
import { startBackground } from "./background.mjs";
import { measureRepeats, observationProblems } from "./summary.mjs";
import { loadSummary, publishRedisReport } from "./collect.mjs";

const cli = parseCliArguments(process.argv.slice(2));
const verification = cli.verification === true;
const formal = !verification;

function resolveProtocol() {
  if (formal) {
    for (const flag of ["only", "warmup-seconds", "duration-seconds", "runs"]) {
      assert(cli[flag] === undefined, `--${flag} is only available with --verification`);
    }
    return { ...PROTOCOL };
  }
  return {
    ...PROTOCOL,
    warmupSeconds: Number(cli["warmup-seconds"] ?? 5),
    durationSeconds: Number(cli["duration-seconds"] ?? 10),
    repeatCount: Number(cli.runs ?? 1),
  };
}

function selectMatrix() {
  const matrix = buildMatrix();
  assert(cli.only === undefined || cli.groups === undefined, "--only and --groups cannot be combined");
  if (cli.groups !== undefined) {
    const wanted = String(cli.groups).split(",").filter(Boolean);
    assert(wanted.length > 0 && wanted.every(group => GROUP_ORDER.includes(group)), `Unknown group in --groups; choose from ${GROUP_ORDER.join(", ")}`);
    assert(new Set(wanted).size === wanted.length, "--groups contains duplicates");
    return wanted.flatMap(group => matrix.filter(item => item.group === group));
  }
  if (cli.only === undefined) return matrix;
  const wanted = String(cli.only).split(",").filter(Boolean);
  const selected = wanted.map(id => matrix.find(item => item.id === id));
  assert(selected.every(Boolean), `Unknown combination in --only: ${wanted.filter((id, i) => !selected[i]).join(", ")}`);
  return selected;
}

function dryRun(protocol, matrix) {
  const { measurementMinutes } = estimatedMinutes(matrix, protocol);
  console.log(JSON.stringify({
    purpose: verification ? "verification" : "formal", protocol, environment: ENVIRONMENT,
    counts: matrixCounts(matrix), total: matrix.length,
    estimatedMeasurementMinutes: measurementMinutes,
    note: "不含数据装载、容器重启、第三次补跑与准备时间；预计总计约为净测量时间的 1.5–1.75 倍",
    groups: Object.entries(GROUP_LABELS).map(([group, label]) => ({
      group, label,
      combinations: matrix.filter(item => item.group === group).map(item => ({
        id: item.id, connections: item.connections, pipeline: item.pipeline, redisProfile: item.redisProfile,
        dataset: item.dataset, nominalPayloadMB: nominalPayloadBytes(item.dataset) === null ? null : nominalPayloadBytes(item.dataset) / 1e6,
        workload: item.workload.type === "ratio" ? `ratio ${item.workload.ratio} ${item.workload.keyPattern}` : item.workload.commands.map(c => c.template),
        background: item.background,
      })),
    })).filter(entry => entry.combinations.length),
    publish: formal && !cli["no-publish"],
  }, null, 2));
}

async function verifyContainer(socket, id, expected, label) {
  const info = await inspectContainer(socket, id);
  assert(info.Config.Labels?.["com.docker.compose.project"] === "performance-profile-redis", `${label} container ownership mismatch`);
  assert(info.HostConfig.NanoCpus === expected.cpus * 1e9 && info.HostConfig.Memory === expected.memoryBytes, `${label} actual resource limits mismatch`);
  const image = await runProcess("docker", ["image", "inspect", info.Image]);
  assert(image.code === 0, `Unable to inspect the ${label} image`);
  const imageInfo = JSON.parse(image.stdout)[0];
  assert(imageInfo.Os === "linux" && imageInfo.Architecture === "arm64", `${label} image platform is not linux/arm64`);
  return { containerId: info.Id, image: info.Config.Image, imageId: info.Image, cpus: expected.cpus, memoryBytes: expected.memoryBytes };
}

async function main() {
  const protocol = resolveProtocol();
  const matrix = selectMatrix();
  if (cli["dry-run"]) return dryRun(protocol, matrix);
  if (cli["publish-summary"]) {
    assert(formal, "Verification summaries cannot be published");
    publishRedisReport(loadSummary(String(cli["publish-summary"])));
    console.log("Redis report published after evidence verification.");
    return;
  }
  const env = loadRedisEnv();
  const groupName = String(cli.group ?? `${verification ? "verify" : "formal"}-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`);
  assert(/^[a-zA-Z0-9_-]+$/.test(groupName), "Invalid group name");
  const resume = cli.resume === true;
  const root = verification ? path.join(PATHS.resultsDir, "verification", groupName) : path.join(PATHS.resultsDir, groupName);
  const summaryPath = path.join(root, "summary.json");
  assert(resume || !existsSync(root), "Group already exists; use --resume to continue it or choose another --group");
  assert(resume || !existsSync(summaryPath), "Group is already complete; refusing to overwrite");
  mkdirSync(root, { recursive: true });
  const relative = file => path.relative(PATHS.resultsDir, file);
  const mounted = file => `/workspace/results/${relative(file)}`;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const checkAborted = () => assert(!controller.signal.aborted, "Interrupted; stopping before the next step");

  let stack = null;
  let activeProfile = null;
  let socket;
  let redisId;
  let loadgenId;
  let limits;
  const environment = { platform: ENVIRONMENT.platform, exploratory: verification, profiles: {} };
  const results = [];
  const preparations = {};
  const startedAt = nowIso();

  async function ensureProfile(profile) {
    if (activeProfile === profile.id) return;
    console.log(`Restarting Redis with profile ${profile.id}: ${profile.args.join(" ") || "(baseline)"}`);
    stack = await startStack(env, profile);
    activeProfile = profile.id;
    redisId = await containerId(env, "redis");
    loadgenId = await containerId(env, "memtier");
    socket ??= await dockerSocket();
    const redis = await verifyContainer(socket, redisId, { cpus: ENVIRONMENT.redisCpus, memoryBytes: ENVIRONMENT.redisMemoryBytes }, "Redis");
    const loadgen = await verifyContainer(socket, loadgenId, { cpus: ENVIRONMENT.loadgenCpus, memoryBytes: ENVIRONMENT.loadgenMemoryBytes }, "memtier");
    const info = await readInfo(stack);
    assert(info.redisVersion?.startsWith(ENVIRONMENT.redisMajorMinor), `Unexpected Redis version ${info.redisVersion}`);
    const config = await readConfig(stack, CONFIG_NAMES);
    assertConfigMatches(config, profile);
    limits = { redis: { cpus: ENVIRONMENT.redisCpus, memoryBytes: ENVIRONMENT.redisMemoryBytes },
      loadgen: { cpus: ENVIRONMENT.loadgenCpus, memoryBytes: ENVIRONMENT.loadgenMemoryBytes } };
    environment.profiles[profile.id] = config;
    environment.redis = { version: info.redisVersion, ...redis, ioThreadsActive: info.ioThreadsActive };
    if (!environment.loadgen) {
      const version = await execIn(stack, "memtier", ["memtier_benchmark", "--version"]);
      environment.loadgen = { tool: "memtier_benchmark", version: (version.stdout || version.stderr).trim().split(/\r?\n/)[0], ...loadgen };
    }
  }

  async function runMemtier(combo, kind, seconds, repeat) {
    const comboDir = path.join(root, combo.id);
    mkdirSync(comboDir, { recursive: true });
    const name = kind === "warmup" ? "warmup" : `run${repeat}`;
    const jsonFile = path.join(comboDir, `${name}.json`);
    const args = memtierRunArguments({ workload: combo.workload, connections: combo.connections, pipeline: combo.pipeline, seconds, jsonOut: mounted(jsonFile) });
    const bg = await startBackground(stack, combo.background);
    let result;
    let background;
    const capture = kind === "measured"
      ? await startResourceCapture({ socket, redisId, loadgenId, limits, expectedSeconds: seconds, intervalMs: protocol.resourceIntervalMs })
      : null;
    try {
      result = await execIn(stack, "memtier", args);
    } finally {
      background = await bg.stop().catch(error => ({ error: error.message }));
    }
    const resources = capture ? await capture.stop() : null;
    const textFile = path.join(comboDir, `${name}.txt`);
    writeFileSync(textFile, `${result.stdout}\n${result.stderr}`);
    return { args, result, jsonFile, textFile, comboDir, name, background, resources };
  }

  async function runCombination(combo) {
    checkAborted();
    const comboDir = path.join(root, combo.id);
    const savedPath = path.join(comboDir, "combo-result.json");
    if (resume && existsSync(savedPath)) {
      const saved = JSON.parse(readFileSync(savedPath, "utf8"));
      console.log(`${combo.id}: already complete, skipping`);
      results.push(saved);
      preparations[combo.id] = saved.preparation;
      return;
    }
    const profile = profileFor(combo);
    await ensureProfile(profile);
    console.log(`[${results.length + 1}/${matrix.length}] ${combo.id}: preparing`);
    const preparation = await prepareCombination(stack, combo, { log: message => console.log(`  ${message}`) });
    preparations[combo.id] = preparation;
    console.log(`  warmup ${protocol.warmupSeconds}s`);
    checkAborted();
    const warmup = await runMemtier(combo, "warmup", protocol.warmupSeconds, 0);
    assert(warmup.result.code === 0, `memtier warmup failed: ${warmup.result.stderr.trim().slice(-300)}`);
    const runs = await measureRepeats({
      repeatCount: protocol.repeatCount, thresholdPercent: protocol.thirdRunThresholdPercent,
      onThird: () => console.log("  difference exceeds the threshold; running a third observation"),
      measure: async repeat => {
        checkAborted();
        console.log(`  measure ${repeat}: ${protocol.durationSeconds}s`);
        const before = await readInfo(stack);
        await redisCli(stack, ["SLOWLOG", "RESET"]);
        const startedAtRun = nowIso();
        const measured = await runMemtier(combo, "measured", protocol.durationSeconds, repeat);
        const after = await readInfo(stack);
        const slowlogEntries = parseSlowlogLen(await redisCli(stack, ["SLOWLOG", "LEN"]));
        const infoFile = path.join(measured.comboDir, `${measured.name}-info.json`);
        const resourceFile = path.join(measured.comboDir, `${measured.name}-resources.json`);
        writeJson(infoFile, { before, after });
        writeJson(resourceFile, measured.resources);
        const run = {
          kind: "measured", repeat, startedAt: startedAtRun, finishedAt: nowIso(), exitCode: measured.result.code,
          arguments: measured.args, rawOutputPath: relative(measured.textFile), memtierJsonPath: relative(measured.jsonFile),
          infoPath: relative(infoFile), resourcePath: relative(resourceFile),
          background: measured.background ? { ...measured.background, slowlogEntries } : null, slowlogEntries,
        };
        if (measured.result.code === 0) {
          run.metrics = parseMemtierJson(readFileSync(measured.jsonFile, "utf8"));
          run.redis = diffSnapshots(before, after, { redisCpus: ENVIRONMENT.redisCpus });
        }
        run.resources = measured.resources.summary;
        run.problems = measured.result.code === 0 ? observationProblems(run, combo) : ["memtier exited with a non-zero code"];
        if (run.problems.length) {
          console.log(`  invalid observation: ${run.problems.join("; ")}`);
          assert(verification, `${combo.id} run ${repeat} is invalid (${run.problems.join("; ")}); results will not be published`);
        } else {
          console.log(`  ops/s ${Math.round(run.metrics.opsPerSec)}, p99 ${run.metrics.p99Ms}ms, redis CPU ${run.redis.redisCpuQuotaPercent.toFixed(0)}% quota, loadgen ${run.resources.loadgen.meanQuotaPercent.toFixed(0)}% quota`);
        }
        return run;
      },
    });
    const result = { combo, preparation, runs };
    writeJson(savedPath, result);
    results.push(result);
  }

  let completed = false;
  let cleanupVerified = false;
  try {
    for (const combo of matrix) await runCombination(combo);
    completed = true;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await removeOwnedContainers(stack ?? env).catch(() => {});
    const remaining = await runProcess("docker", ["ps", "-aq", "--filter", "label=com.docker.compose.project=performance-profile-redis"]);
    cleanupVerified = remaining.code === 0 && remaining.stdout.trim() === "";
    if (!cleanupVerified) console.error("Cleanup incomplete: project containers remain; inspect them manually before another run");
  }
  assert(completed, "Run did not complete");
  assert(cleanupVerified, "Project containers remain after the run; results will not be published");
  environment.dockerVm = await dockerVmSnapshot();
  environment.host = hostSnapshot();
  const datasetPath = path.join(root, "dataset.json");
  const environmentPath = path.join(root, "environment.json");
  if (existsSync(environmentPath)) {
    const earlier = JSON.parse(readFileSync(environmentPath, "utf8"));
    environment.profiles = { ...earlier.profiles, ...environment.profiles };
  }
  const saved = buildMatrix().map(combo => {
    const file = path.join(root, combo.id, "combo-result.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }).filter(Boolean);
  writeJson(datasetPath, { runGroup: groupName, preparations: Object.fromEntries(saved.map(item => [item.combo.id, item.preparation])) });
  writeJson(environmentPath, environment);
  const summary = {
    schemaVersion: 1, purpose: verification ? "verification" : "formal", sourceRole: verification ? "verification" : "formal",
    runGroup: groupName, root: relative(root), startedAt, testedAt: nowIso(), protocol, environment,
    environmentPath: relative(environmentPath), datasetPath: relative(datasetPath), restorationVerified: cleanupVerified, results: saved,
  };
  writeJson(summaryPath, summary);
  if (verification) {
    console.log(`Verification saved separately: ${summaryPath}`);
  } else if (cli["no-publish"]) {
    console.log(`Formal batch complete (not published): ${summaryPath}`);
  } else {
    const report = publishRedisReport(summary);
    console.log(`Formal batch complete and published (${report.coverage.groups.length}/7 scenario groups): ${summaryPath}`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
