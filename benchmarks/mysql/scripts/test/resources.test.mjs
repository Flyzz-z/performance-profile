import test from "node:test";
import assert from "node:assert/strict";
import { parseCpuStats, summarizeResources } from "../resources.mjs";
import { formalPlan, loggingMode } from "../logging.mjs";
import { validateFormalRuns } from "../analytics.mjs";
import { FORMAL_SCENARIOS } from "../lib.mjs";

const cpu = (timeMs, cpuUsageNs, throttledPeriods = 0, throttledTimeNs = 0) =>
  ({ timeMs, cpuUsageNs, periods: timeMs / 100, throttledPeriods, throttledTimeNs });

test("CPU stats require real usage and throttling counters", () => {
  const stats = { read: "2026-10-06T04:00:00Z",
    cpu_stats: { cpu_usage: { total_usage: 123 }, throttling_data: { periods: 1, throttled_periods: 0, throttled_time: 0 } } };
  assert.equal(parseCpuStats(stats).cpuUsageNs, 123);
  assert.throws(() => parseCpuStats({ read: stats.read, cpu_stats: {} }), /Missing/);
});

test("CPU percent distinguishes one CPU from a four CPU quota", () => {
  const samples = [
    { mysql: cpu(0, 0), loadgen: cpu(0, 0) },
    { mysql: cpu(5000, 10e9, 10, 40e9), loadgen: cpu(5000, 20e9, 20, 60e9) },
    { mysql: cpu(10000, 20e9, 20, 80e9), loadgen: cpu(10000, 40e9, 40, 120e9) },
  ];
  const summary = summarizeResources(samples, { mysql: { cpus: 4 }, loadgen: { cpus: 4 } }, 12);
  assert.equal(summary.valid, true);
  assert.equal(summary.mysql.meanCpuPercent, 200);
  assert.equal(summary.mysql.meanQuotaPercent, 50);
  assert.equal(summary.loadgen.meanCpuPercent, 400);
  assert.equal(summary.loadgen.meanQuotaPercent, 100);
  assert.equal(summary.loadgen.throttledTimeSeconds, 120);
  assert.equal(summary.coverageSeconds, 10);
  assert.equal(summarizeResources(samples, summary.limits, 120).valid, false);
  assert.equal(summarizeResources(samples, summary.limits, 12, ["API failed"]).valid, false);
});

test("a suspended VM or long sampling gap is not valid duration coverage", () => {
  const samples = [
    { mysql: cpu(0, 0), loadgen: cpu(0, 0) },
    { mysql: cpu(115000, 20e9), loadgen: cpu(115000, 10e9) },
  ];
  const limits = { mysql: { cpus: 4 }, loadgen: { cpus: 4 } };
  assert.equal(summarizeResources(samples, limits, 120).valid, false);
  samples[1].mysql.timeMs = 1638000;
  samples[1].loadgen.timeMs = 1638000;
  assert.equal(summarizeResources(samples, limits, 120).valid, false);
});

test("formal matrix has twelve combinations and subsets are verification", () => {
  const env = { LOADGEN_CPUS: 4, WARMUP_SECONDS: 60, DURATION_SECONDS: 120, VARIANCE_THRESHOLD_PERCENT: 10 };
  const plan = formalPlan(env);
  assert.equal(plan.combinations.length, 12);
  assert.equal(plan.purpose, "formal");
  assert.equal(formalPlan(env, { scenario: "point_select" }).purpose, "verification");
  assert.equal(formalPlan(env, { "duration-seconds": 10 }).isFull, false);
  assert.throws(() => formalPlan({ ...env, LOADGEN_CPUS: 1 }), /4 CPU/);
});

function formalRows() {
  return FORMAL_SCENARIOS.flatMap((scenario) => [1, 8, 32].flatMap((concurrency) =>
    [1, 2].map((repeat) => ({
      runGroup: "formal", purpose: "formal", scenario, concurrency, repeat, kind: "measured",
      restorationVerified: true, status: "passed", metrics: { errors: 0 },
      protocol: { warmupSeconds: 60, durationSeconds: 120, repeatCount: 2, adaptiveThresholdPercent: 10 },
      environment: { mysql: { ...loggingMode(scenario), bufferPoolBytes: 3221225472 },
        container: { loadGeneratorCpuLimit: 4, mysqlCpuLimit: 4, mysqlMemoryLimit: "6g",
          loadGeneratorMemoryLimit: "1g", platform: "linux/arm64" } },
      resources: { valid: true, coverageSeconds: 110, limits: {
        loadgen: { cpus: 4, memoryBytes: 1024 ** 3 }, mysql: { cpus: 4, memoryBytes: 6 * 1024 ** 3 },
      } },
    }))));
}

test("publication refuses validation, old CPU quotas, incomplete matrices and missing evidence", () => {
  const rows = formalRows();
  validateFormalRuns(rows);
  for (const mutate of [
    (r) => { r[0].purpose = "verification"; },
    (r) => { r[0].environment.container.loadGeneratorCpuLimit = 1; },
    (r) => { r[0].resources.valid = false; },
    (r) => { r[0].resources.coverageSeconds = 80; },
    (r) => { r[0].resources.coverageSeconds = 1638; },
    (r) => { r[0].restorationVerified = false; },
    (r) => { r.pop(); },
    (r) => { r[0].runGroup = "other"; },
  ]) {
    const invalid = structuredClone(rows);
    mutate(invalid);
    assert.throws(() => validateFormalRuns(invalid));
  }
});
