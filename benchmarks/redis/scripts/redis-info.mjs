const COUNTERS = ["totalCommands", "usedCpuSys", "usedCpuUser", "keyspaceHits", "keyspaceMisses", "evictedKeys", "errorReplies", "rdbSaves", "aofRewrites"];

export function parseInfo(text) {
  const fields = {};
  const errorstats = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key.startsWith("errorstat_")) {
      const match = /count=(\d+)/.exec(value);
      if (match) errorstats[key.slice("errorstat_".length)] = Number(match[1]);
    } else {
      fields[key] = value;
    }
  }
  return { fields, errorstats };
}

function numberField(fields, key, { required = false } = {}) {
  const value = fields[key];
  if (value === undefined) {
    if (required) throw new Error(`Redis INFO is missing ${key}`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Redis INFO field ${key} is not numeric`);
  return parsed;
}

export function infoSnapshot(info, timeMs) {
  const { fields, errorstats } = info;
  return {
    timeMs,
    redisVersion: fields.redis_version ?? null,
    totalCommands: numberField(fields, "total_commands_processed", { required: true }),
    usedCpuSys: numberField(fields, "used_cpu_sys", { required: true }),
    usedCpuUser: numberField(fields, "used_cpu_user", { required: true }),
    keyspaceHits: numberField(fields, "keyspace_hits", { required: true }),
    keyspaceMisses: numberField(fields, "keyspace_misses", { required: true }),
    evictedKeys: numberField(fields, "evicted_keys", { required: true }),
    errorReplies: numberField(fields, "total_error_replies", { required: true }),
    rdbSaves: numberField(fields, "rdb_saves") ?? 0,
    aofRewrites: numberField(fields, "aof_rewrites") ?? 0,
    latestForkUsec: numberField(fields, "latest_fork_usec"),
    rdbLastCowSize: numberField(fields, "rdb_last_cow_size"),
    usedMemoryBytes: numberField(fields, "used_memory", { required: true }),
    memFragmentationRatio: numberField(fields, "mem_fragmentation_ratio"),
    connectedClients: numberField(fields, "connected_clients"),
    ioThreadsActive: numberField(fields, "io_threads_active"),
    oomRejections: errorstats.OOM ?? 0,
    errorstats: { ...errorstats },
    bgsaveInProgress: fields.rdb_bgsave_in_progress === "1",
    aofRewriteInProgress: fields.aof_rewrite_in_progress === "1",
  };
}

export function diffSnapshots(before, after, { redisCpus = 2 } = {}) {
  const windowSeconds = (after.timeMs - before.timeMs) / 1000;
  if (!(windowSeconds > 0)) throw new Error("Redis INFO window has no positive duration");
  const delta = {};
  for (const key of COUNTERS) {
    delta[key] = after[key] - before[key];
    if (delta[key] < 0) throw new Error(`Redis counter ${key} was reset or decreased during the window`);
  }
  const oomRejections = after.oomRejections - before.oomRejections;
  if (oomRejections < 0) throw new Error("Redis OOM counter was reset during the window");
  const cpuSeconds = delta.usedCpuSys + delta.usedCpuUser;
  const lookups = delta.keyspaceHits + delta.keyspaceMisses;
  const forked = delta.rdbSaves > 0 || delta.aofRewrites > 0;
  return {
    windowSeconds,
    commands: delta.totalCommands,
    commandsPerSec: delta.totalCommands / windowSeconds,
    redisCpuSeconds: cpuSeconds,
    redisCpuPercent: cpuSeconds / windowSeconds * 100,
    redisCpuQuotaPercent: cpuSeconds / windowSeconds * 100 / redisCpus,
    keyspaceHits: delta.keyspaceHits,
    keyspaceMisses: delta.keyspaceMisses,
    hitRatioPercent: lookups > 0 ? delta.keyspaceHits / lookups * 100 : null,
    evictedKeys: delta.evictedKeys,
    evictedPerSec: delta.evictedKeys / windowSeconds,
    errorReplies: delta.errorReplies,
    oomRejections,
    rdbSaves: delta.rdbSaves,
    aofRewrites: delta.aofRewrites,
    latestForkUsec: forked ? after.latestForkUsec : null,
    rdbLastCowSize: delta.rdbSaves > 0 ? after.rdbLastCowSize : null,
    usedMemoryBytes: after.usedMemoryBytes,
    memFragmentationRatio: after.memFragmentationRatio,
  };
}

export function parseConfigGet(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const map = {};
  for (let index = 0; index + 1 < lines.length; index += 2) map[lines[index]] = lines[index + 1];
  return map;
}

const POLICY_DEFAULT = { maxmemory: "0", "maxmemory-policy": "noeviction" };

export function expectedConfig(profile) {
  const args = profile.args;
  const expected = { "io-threads": "1", appendonly: "no", save: "", maxmemory: POLICY_DEFAULT.maxmemory };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].replace(/^--/, "");
    const value = args[index + 1];
    expected[name] = name === "maxmemory" ? String(parseMemory(value)) : value;
  }
  return expected;
}

function parseMemory(value) {
  const match = /^(\d+)(gb|mb)?$/i.exec(value);
  if (!match) throw new Error(`Unsupported maxmemory value: ${value}`);
  const unit = (match[2] ?? "").toLowerCase();
  return Number(match[1]) * (unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : 1);
}

export function assertConfigMatches(actual, profile) {
  const expected = expectedConfig(profile);
  const problems = Object.entries(expected).filter(([name, value]) => String(actual[name]) !== value)
    .map(([name, value]) => `${name}: expected "${value}", actual "${actual[name]}"`);
  if (problems.length) throw new Error(`Redis configuration mismatch for ${profile.id}: ${problems.join("; ")}`);
}

export function parseSlowlogLen(text) {
  const value = Number(String(text).trim());
  if (!Number.isInteger(value) || value < 0) throw new Error("Unable to parse SLOWLOG LEN");
  return value;
}
