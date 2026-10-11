import { computeStats, relativeDifferencePercent } from "../../mysql/scripts/analytics.mjs";
import { GROUP_LABELS, GROUP_ORDER, PROTOCOL, buildMatrix } from "./protocol.mjs";

const SELECTED_METRICS = ["opsPerSec", "p50Ms", "p95Ms", "p99Ms", "p999Ms", "p9999Ms", "kbPerSec", "averageLatencyMs", "hitsPerSec", "missesPerSec"];
const SELECTED_REDIS = ["redisCpuPercent", "redisCpuQuotaPercent", "hitRatioPercent", "evictedPerSec", "evictedKeys", "oomRejections",
  "keyspaceHits", "keyspaceMisses", "rdbSaves", "aofRewrites", "usedMemoryBytes", "memFragmentationRatio", "commandsPerSec"];

export function shouldRunThird(runs, thresholdPercent = PROTOCOL.thirdRunThresholdPercent) {
  if (runs.length < 2) return false;
  const [first, second] = runs;
  const difference = Math.max(
    relativeDifferencePercent(first.metrics.opsPerSec, second.metrics.opsPerSec),
    relativeDifferencePercent(first.metrics.p99Ms, second.metrics.p99Ms),
  );
  return difference > thresholdPercent;
}

export async function measureRepeats({ repeatCount = PROTOCOL.repeatCount, thresholdPercent = PROTOCOL.thirdRunThresholdPercent, beforeRepeat, measure, onThird }) {
  const runs = [];
  const execute = async repeat => {
    await beforeRepeat?.(repeat);
    runs.push(await measure(repeat));
  };
  for (let repeat = 1; repeat <= repeatCount; repeat++) await execute(repeat);
  if (repeatCount === 2 && shouldRunThird(runs, thresholdPercent)) {
    onThird?.();
    await execute(3);
  }
  return runs;
}

function stabilityLevel(spread) {
  if (spread <= 5) return "stable";
  if (spread <= 10) return "acceptable";
  return "unstable";
}

export function observationProblems(run, combo) {
  const problems = [];
  if (run.exitCode !== 0) problems.push("memtier exited with a non-zero code");
  if (!(run.metrics?.opsPerSec > 0)) problems.push("missing valid ops/sec");
  if (!run.resources?.valid) problems.push("resource evidence insufficient");
  const redis = run.redis;
  if (!redis || !(redis.windowSeconds > 0)) {
    problems.push("missing Redis INFO window");
    return problems;
  }
  const allowedErrors = combo.expectOomRejections ? redis.oomRejections : 0;
  if (redis.errorReplies !== allowedErrors) problems.push(`unexpected error replies: ${redis.errorReplies - allowedErrors}`);
  if (combo.expectOomRejections && redis.oomRejections <= 0) problems.push("noeviction produced no OOM rejections");
  if (combo.reads && combo.group !== "memory" && (redis.keyspaceMisses !== 0 || run.metrics.missesPerSec > 0)) {
    problems.push("read workload had misses");
  }
  if (combo.group === "memory") {
    if (combo.expectEvictions && !(redis.evictedKeys > 0)) problems.push("memory pressure produced no evictions");
    if (!combo.expectEvictions && redis.evictedKeys !== 0) problems.push("unexpected evictions");
  }
  if (combo.background && !(run.background?.executions > 0)) problems.push("background command did not execute");
  return problems;
}

function selectValue(values, attempts) {
  const stats = computeStats(values);
  if (!stats) return null;
  return attempts >= 3 ? stats.median : stats.mean;
}

export function summarizeCombination(runs) {
  if (!runs.length) return null;
  const metrics = (field) => runs.map(run => run.metrics?.[field]).filter(Number.isFinite);
  const redis = (field) => runs.map(run => run.redis?.[field]).filter(Number.isFinite);
  const opsStats = computeStats(metrics("opsPerSec"));
  const p99Stats = computeStats(metrics("p99Ms"));
  const selected = {};
  for (const field of SELECTED_METRICS) selected[field] = selectValue(metrics(field), runs.length);
  const maxima = metrics("maxMs");
  selected.maxMs = maxima.length ? Math.max(...maxima) : null;
  const redisSelected = {};
  for (const field of SELECTED_REDIS) redisSelected[field] = selectValue(redis(field), runs.length);
  const quota = (name) => runs.map(run => run.resources?.[name]?.meanQuotaPercent).filter(Number.isFinite);
  return {
    attempts: runs.length,
    stability: stabilityLevel(Math.max(opsStats?.relativeSpreadPercent ?? 0, p99Stats?.relativeSpreadPercent ?? 0)),
    stats: { opsPerSec: opsStats, p99Ms: p99Stats },
    selected, redis: redisSelected,
    resources: { redisQuotaPercent: selectValue(quota("redis"), runs.length), loadgenQuotaPercent: selectValue(quota("loadgen"), runs.length) },
    loadgenBound: runs.some(run => run.resources?.loadgenBound === true),
  };
}

export function buildReportData({ runGroup, testedAt, environment, protocol = PROTOCOL, results, datasetPath }) {
  const byId = new Map(results.map(result => [result.combo.id, result]));
  const matrix = buildMatrix();
  const measured = combo => (byId.get(combo.id)?.runs?.length ?? 0) > 0;
  const covered = GROUP_ORDER.filter(group => matrix.filter(combo => combo.group === group).every(measured));
  const incomplete = GROUP_ORDER.filter(group => !covered.includes(group) && matrix.some(combo => combo.group === group && measured(combo)));
  const scenarios = covered.map(group => ({
    id: group, label: GROUP_LABELS[group],
    points: matrix.filter(combo => combo.group === group).map(combo => {
      const result = byId.get(combo.id);
      const summary = result ? summarizeCombination(result.runs) : null;
      return {
        id: combo.id, group, variant: combo.variant, connections: combo.connections, pipeline: combo.pipeline,
        redisProfile: combo.redisProfile, dataset: combo.dataset, workload: combo.workload, background: combo.background,
        ...summary,
        runs: result?.runs ?? [],
      };
    }),
  }));
  return {
    schemaVersion: 1, purpose: "formal", runGroup, testedAt,
    component: { id: "redis", name: "Redis", label: "local Docker benchmark", platform: environment.platform, version: environment.redis?.version ?? null },
    environment, protocol, datasetPath, scenarios,
    coverage: { groups: covered, pending: GROUP_ORDER.filter(group => !covered.includes(group)), incomplete, total: GROUP_ORDER.length },
  };
}

export function validateReportData(report, matrix = buildMatrix()) {
  const problems = [];
  if (report.purpose !== "formal") problems.push("report is not formal");
  if (report.environment?.exploratory === true) problems.push("environment is marked exploratory");
  const coveredGroups = report.coverage?.groups ?? GROUP_ORDER;
  if (!coveredGroups.length) problems.push("report covers no scenario group");
  const expected = new Map(matrix.filter(combo => coveredGroups.includes(combo.group)).map(combo => [combo.id, combo]));
  const seen = new Set();
  for (const scenario of report.scenarios ?? []) {
    for (const point of scenario.points ?? []) {
      const combo = expected.get(point.id);
      if (!combo) { problems.push(`unknown combination ${point.id}`); continue; }
      if (seen.has(point.id)) problems.push(`duplicate combination ${point.id}`);
      seen.add(point.id);
      if (!point.runs?.length || point.attempts !== point.runs.length) { problems.push(`missing observations for ${point.id}`); continue; }
      if (point.runs.some(run => String(run.rawOutputPath ?? "").includes("verification"))) problems.push(`verification evidence in ${point.id}`);
      const attemptCount = point.runs.length;
      if (attemptCount < PROTOCOL.repeatCount || attemptCount > PROTOCOL.repeatCount + 1) problems.push(`invalid observation count for ${point.id}`);
      if (attemptCount === 3 && !shouldRunThird(point.runs.slice(0, 2))) problems.push(`unneeded third run for ${point.id}`);
      if (attemptCount === 2 && shouldRunThird(point.runs)) problems.push(`missing third run for ${point.id}`);
      for (const run of point.runs) {
        for (const message of observationProblems(run, combo)) problems.push(`${point.id} run ${run.repeat}: ${message}`);
      }
    }
  }
  for (const id of expected.keys()) if (!seen.has(id)) problems.push(`missing combination ${id}`);
  return problems;
}
