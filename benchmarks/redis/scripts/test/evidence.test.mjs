import test from "node:test";
import assert from "node:assert/strict";
import { parseInfo, infoSnapshot, diffSnapshots, parseConfigGet, assertConfigMatches, expectedConfig, parseSlowlogLen } from "../redis-info.mjs";
import { REDIS_PROFILES } from "../protocol.mjs";
import { summarizeResources } from "../resources.mjs";

const infoText = (overrides = {}) => {
  const values = {
    redis_version: "7.4.2", total_commands_processed: 1000, used_cpu_sys: 1.5, used_cpu_user: 2.5, keyspace_hits: 800,
    keyspace_misses: 0, evicted_keys: 0, total_error_replies: 0, rdb_saves: 0, aof_rewrites: 0, latest_fork_usec: 0, rdb_last_cow_size: 0,
    used_memory: 400000000, mem_fragmentation_ratio: 1.1, connected_clients: 17, io_threads_active: 0,
    rdb_bgsave_in_progress: 0, aof_rewrite_in_progress: 0, ...overrides,
  };
  return `# Server\r\n${Object.entries(values).map(([key, value]) => `${key}:${value}`).join("\r\n")}\r\n# Errorstats\r\nerrorstat_OOM:count=${overrides.oom ?? 0}\r\n`;
};
const snapshot = (overrides, timeMs) => infoSnapshot(parseInfo(infoText(overrides)), timeMs);

test("INFO parsing reads fields and error statistics", () => {
  const info = parseInfo(infoText({ oom: 7 }));
  assert.equal(info.fields.redis_version, "7.4.2");
  assert.equal(info.errorstats.OOM, 7);
  const snap = infoSnapshot(info, 1000);
  assert.equal(snap.totalCommands, 1000);
  assert.equal(snap.oomRejections, 7);
  assert.throws(() => infoSnapshot(parseInfo("# Server\r\nredis_version:7.4.2\r\n"), 0), /missing total_commands_processed/);
});

test("window differences use the actual elapsed time and Redis CPU quota", () => {
  const before = snapshot({}, 10_000);
  const after = snapshot({ total_commands_processed: 6_001_000, used_cpu_sys: 11.5, used_cpu_user: 62.5, keyspace_hits: 5_400_800,
    keyspace_misses: 600_000, evicted_keys: 300_000, oom: 12, total_error_replies: 12, rdb_saves: 1, latest_fork_usec: 21000 }, 70_500);
  const diff = diffSnapshots(before, after, { redisCpus: 2 });
  assert.equal(diff.windowSeconds, 60.5);
  assert.equal(diff.commands, 6_000_000);
  assert.ok(Math.abs(diff.commandsPerSec - 6_000_000 / 60.5) < 1e-6);
  assert.ok(Math.abs(diff.redisCpuPercent - 70 / 60.5 * 100) < 1e-9);
  assert.ok(Math.abs(diff.redisCpuQuotaPercent - 70 / 60.5 * 50) < 1e-9);
  assert.equal(diff.hitRatioPercent, 90);
  assert.equal(diff.evictedKeys, 300_000);
  assert.equal(diff.oomRejections, 12);
  assert.equal(diff.rdbSaves, 1);
  assert.equal(diff.latestForkUsec, 21000);
});

test("stale fork time is hidden when no background save occurred", () => {
  const diff = diffSnapshots(snapshot({ latest_fork_usec: 9999 }, 0), snapshot({ latest_fork_usec: 9999 }, 1000));
  assert.equal(diff.latestForkUsec, null);
  assert.equal(diff.hitRatioPercent, null);
});

test("window differences reject counter resets and empty windows", () => {
  assert.throws(() => diffSnapshots(snapshot({}, 0), snapshot({ total_commands_processed: 10 }, 1000)), /reset/);
  assert.throws(() => diffSnapshots(snapshot({}, 5), snapshot({}, 5)), /positive duration/);
  assert.throws(() => diffSnapshots(snapshot({ oom: 5 }, 0), snapshot({ oom: 1 }, 1000)), /OOM counter/);
});

test("CONFIG GET parsing and profile verification catch mismatches", () => {
  const config = parseConfigGet("maxmemory\n1073741824\nmaxmemory-policy\nallkeys-lru\nio-threads\n1\nappendonly\nno\nsave\n\n");
  assert.equal(config.maxmemory, "1073741824");
  assert.doesNotThrow(() => assertConfigMatches(config, REDIS_PROFILES["mem-lru"]));
  assert.throws(() => assertConfigMatches(config, REDIS_PROFILES["mem-noeviction"]), /maxmemory-policy/);
  assert.throws(() => assertConfigMatches({ ...config, "io-threads": "4" }, REDIS_PROFILES["mem-lru"]), /io-threads/);
  assert.equal(expectedConfig(REDIS_PROFILES["aof-always"]).appendfsync, "always");
  assert.equal(expectedConfig(REDIS_PROFILES.rdb).save, "3600 1 300 100 60 10000");
  assert.equal(parseSlowlogLen("12\n"), 12);
  assert.throws(() => parseSlowlogLen("x"), /SLOWLOG/);
});

const cpu = (timeMs, cpuUsageNs) => ({ timeMs, cpuUsageNs, periods: timeMs / 100, throttledPeriods: 0, throttledTimeNs: 0 });
const series = (seconds, redisRate, loadgenRate, step = 5) => Array.from({ length: seconds / step + 1 }, (_, i) =>
  ({ redis: cpu(i * step * 1000, i * step * redisRate * 1e9), loadgen: cpu(i * step * 1000, i * step * loadgenRate * 1e9) }));
const limits = { redis: { cpus: 2 }, loadgen: { cpus: 4 } };

test("sixty second resource evidence requires 48 seconds coverage, 70 seconds span and 10 second gaps", () => {
  assert.equal(summarizeResources(series(60, 1, 2), limits, 60).valid, true);
  assert.equal(summarizeResources(series(45, 1, 2), limits, 60).valid, false);
  assert.equal(summarizeResources(series(75, 1, 2), limits, 60).valid, false);
  const gappy = series(60, 1, 2).filter((_, i) => i !== 4 && i !== 5);
  assert.equal(summarizeResources(gappy, limits, 60).valid, false);
  assert.equal(summarizeResources(series(60, 1, 2), limits, 60, ["Docker stats timeout"]).valid, false);
});

test("load generator near its quota is flagged as loadgen bound", () => {
  const bound = summarizeResources(series(60, 1, 3.7), limits, 60);
  assert.equal(bound.loadgen.meanQuotaPercent > 90, true);
  assert.equal(bound.loadgenBound, true);
  assert.equal(bound.redis.meanQuotaPercent, 50);
  assert.equal(summarizeResources(series(60, 1.9, 1), limits, 60).loadgenBound, false);
});
