import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildMatrix, ENVIRONMENT, PROTOCOL } from "../protocol.mjs";
import { infoSnapshot, parseInfo, diffSnapshots } from "../redis-info.mjs";
import { summarizeResources } from "../resources.mjs";

export const goodEnvironment = () => ({
  platform: "linux/arm64", exploratory: false,
  redis: { version: "7.4.2", image: "redis:7.4@sha256:test", imageId: "sha256:redis", cpus: 2, memoryBytes: 4 * 1024 ** 3, ioThreadsActive: 0 },
  loadgen: { tool: "memtier_benchmark", version: "memtier_benchmark 2.1.2", image: "memtier", imageId: "sha256:memtier", cpus: 4, memoryBytes: 1024 ** 3 },
  dockerVm: { cpus: 10, memoryBytes: 8 * 1024 ** 3, kernel: "6.10", operatingSystem: "Docker Desktop", architecture: "aarch64", dockerVersion: "29.4.0" },
  host: { platform: "darwin", arch: "arm64", release: "25.5.0", cpuModel: "Apple", cpuCount: 10, memoryBytes: 16 * 1024 ** 3 },
  profiles: { baseline: { "io-threads": "1" } },
});

function info(overrides, timeMs) {
  const values = { redis_version: "7.4.2", total_commands_processed: 0, used_cpu_sys: 0, used_cpu_user: 0, keyspace_hits: 0, keyspace_misses: 0,
    evicted_keys: 0, total_error_replies: 0, rdb_saves: 0, aof_rewrites: 0, latest_fork_usec: 0, rdb_last_cow_size: 0, used_memory: 1e9,
    mem_fragmentation_ratio: 1.1, connected_clients: 17, io_threads_active: 0, rdb_bgsave_in_progress: 0, aof_rewrite_in_progress: 0, ...overrides };
  const text = Object.entries(values).map(([key, value]) => `${key}:${value}`).join("\r\n") + `\r\nerrorstat_OOM:count=${overrides.oom ?? 0}\r\n`;
  return infoSnapshot(parseInfo(text), timeMs);
}

const cpu = (timeMs, usage) => ({ timeMs, cpuUsageNs: usage, periods: timeMs / 100, throttledPeriods: 0, throttledTimeNs: 0 });

export function writeRun(resultsDir, combo, repeat, { opsPerSec = 90000, p99Ms = 0.6, loadgenRate = 2, mutate = {} } = {}) {
  const dir = path.join(resultsDir, "formal-test", combo.id);
  mkdirSync(dir, { recursive: true });
  const name = `run${repeat}`;
  const memtierPath = path.join(dir, `${name}.json`);
  const totals = { "Ops/sec": opsPerSec, Count: opsPerSec * 60, "Hits/sec": combo.reads ? opsPerSec : 0, "Misses/sec": 0, "KB/sec": 1000, Latency: p99Ms / 3,
    "Percentile Latencies": { "p50.00": p99Ms / 3, "p95.00": p99Ms / 1.5, "p99.00": p99Ms, "p99.90": p99Ms * 2, "p99.99": p99Ms * 4 }, "Max Latency": p99Ms * 20 };
  writeFileSync(memtierPath, JSON.stringify({ "ALL STATS": { Totals: totals } }));
  const commands = Math.round(opsPerSec * 60.4);
  const memoryHits = combo.group === "memory" ? Math.round(commands * (combo.id === "memory-fits" ? 0.9 : 0.45)) : null;
  const memoryMisses = combo.group === "memory" ? Math.round(commands * (combo.id === "memory-fits" ? 0 : 0.45)) : 0;
  const before = info({}, 0);
  const after = info({
    total_commands_processed: commands, used_cpu_sys: 10, used_cpu_user: 50, keyspace_hits: memoryHits ?? (combo.reads ? commands : 0),
    keyspace_misses: memoryMisses,
    evicted_keys: combo.expectEvictions ? 12345 : 0, total_error_replies: combo.expectOomRejections ? 500 : 0, oom: combo.expectOomRejections ? 500 : 0,
    rdb_saves: combo.redisProfile === "rdb" ? 1 : 0, latest_fork_usec: 20000, used_memory: 1.1e9, ...(mutate.info ?? {}),
  }, 60400);
  const infoPath = path.join(dir, `${name}-info.json`);
  writeFileSync(infoPath, JSON.stringify({ before, after }));
  const samples = Array.from({ length: 13 }, (_, i) => ({ redis: cpu(i * 5000, i * 5e9 * 1.2), loadgen: cpu(i * 5000, i * 5e9 * loadgenRate) }));
  const limits = { redis: { cpus: 2, memoryBytes: 4 * 1024 ** 3 }, loadgen: { cpus: 4, memoryBytes: 1024 ** 3 } };
  const summary = summarizeResources(samples, limits, 60, [], 5000);
  const resourcePath = path.join(dir, `${name}-resources.json`);
  writeFileSync(resourcePath, JSON.stringify({ schemaVersion: 1, intervalMs: 5000, samples, summary }));
  const relative = file => path.relative(resultsDir, file);
  return {
    kind: "measured", repeat, exitCode: 0, rawOutputPath: relative(path.join(dir, `${name}.txt`)), memtierJsonPath: relative(memtierPath),
    infoPath: relative(infoPath), resourcePath: relative(resourcePath),
    metrics: { opsPerSec, p99Ms }, redis: diffSnapshots(before, after), resources: summary,
    background: combo.background ? { command: combo.background.command, executions: 25, slowlogEntries: 3 } : null,
  };
}

export function makeSummary(resultsDir, { perCombo = () => ({}) } = {}) {
  const matrix = buildMatrix();
  const results = matrix.map(combo => {
    const options = perCombo(combo);
    return { combo, runs: [1, 2].map(repeat => writeRun(resultsDir, combo, repeat, options)) };
  });
  return {
    schemaVersion: 1, purpose: "formal", sourceRole: "formal", runGroup: "formal-test", root: "formal-test", startedAt: "2026-10-12T00:00:00.000Z",
    testedAt: "2026-10-12T03:00:00.000Z", protocol: { ...PROTOCOL }, environment: goodEnvironment(), datasetPath: "formal-test/dataset.json",
    restorationVerified: true, results,
  };
}

export { ENVIRONMENT };
