export const PROTOCOL = Object.freeze({
  warmupSeconds: 30,
  durationSeconds: 60,
  repeatCount: 2,
  thirdRunThresholdPercent: 30,
  resourceIntervalMs: 5000,
  loadgenBoundQuotaPercent: 90,
});

export const ENVIRONMENT = Object.freeze({
  platform: "linux/arm64",
  redisCpus: 2,
  redisMemoryBytes: 4 * 1024 ** 3,
  loadgenCpus: 4,
  loadgenMemoryBytes: 1024 ** 3,
  bgclientCpus: 0.5,
  redisMajorMinor: "7.4",
  memtierVersion: "2.1.2",
});

export const KEY_PREFIX = "memtier-";

export const CONNECTION_MAP = Object.freeze({
  1: { threads: 1, clients: 1 },
  16: { threads: 2, clients: 8 },
  64: { threads: 4, clients: 16 },
  256: { threads: 4, clients: 64 },
});

export const GROUP_ORDER = ["commands", "pipeline", "value-size", "persistence", "connections", "memory", "blocking"];

export const GROUP_LABELS = {
  commands: "命令与数据结构基线",
  pipeline: "Pipeline 深度",
  "value-size": "Value 大小",
  persistence: "持久化策略",
  connections: "客户端连接数",
  memory: "内存压力与淘汰",
  blocking: "慢命令阻塞",
};

export const EXPECTED_COMBINATION_COUNTS = { commands: 8, pipeline: 8, "value-size": 8, persistence: 12, connections: 4, memory: 4, blocking: 4 };

const MIB = 1024 ** 2;
const STRING_KEYS = 1_000_000;
const STRING_BYTES = 256;

export const STRUCTURES = {
  hashes: { kind: "hashes", keys: 100_000, fields: 10, valueBytes: 256 },
  lists: { kind: "lists", keys: 1_000, elements: 1_000, valueBytes: 256 },
  zsets: { kind: "zsets", keys: 1_000, members: 1_000 },
  counters: { kind: "counters", keys: STRING_KEYS },
};

export const BLOCKING = {
  bigHash: { key: "bighash", fields: 100_000, valueBytes: 64 },
  hgetallIntervalSeconds: 0.2,
  keysIntervalSeconds: 0.5,
  scanCount: 100,
  noMatchPattern: "nomatch:*",
};

export const MEMORY = {
  maxmemory: "1gb",
  maxmemoryBytes: 1024 ** 3,
  valueBytes: 1024,
  fitKeys: 500_000,
  overKeys: 1_800_000,
  gaussianStddev: 150_000,
};

export const VALUE_SIZES = [
  { valueBytes: 64, keys: 4_000_000 },
  { valueBytes: 1024, keys: 250_000 },
  { valueBytes: 10_240, keys: 25_000 },
  { valueBytes: 102_400, keys: 2_500 },
];

export const REDIS_PROFILES = {
  baseline: { id: "baseline", args: [] },
  rdb: { id: "rdb", args: ["--save", "3600 1 300 100 60 10000"] },
  "aof-everysec": { id: "aof-everysec", args: ["--appendonly", "yes", "--appendfsync", "everysec"] },
  "aof-always": { id: "aof-always", args: ["--appendonly", "yes", "--appendfsync", "always"] },
  "mem-fit": { id: "mem-fit", args: ["--maxmemory", MEMORY.maxmemory, "--maxmemory-policy", "allkeys-lru"] },
  "mem-lru": { id: "mem-lru", args: ["--maxmemory", MEMORY.maxmemory, "--maxmemory-policy", "allkeys-lru"] },
  "mem-noeviction": { id: "mem-noeviction", args: ["--maxmemory", MEMORY.maxmemory, "--maxmemory-policy", "noeviction"] },
};

const strings = (keys, valueBytes) => ({ kind: "strings", keys, valueBytes });

const ratioWorkload = (ratio, keys, valueBytes, keyPattern = "R:R", extra = {}) =>
  ({ type: "ratio", ratio, keyMin: 1, keyMax: keys, keyPattern, valueBytes, ...extra });

const commandWorkload = (commands, keys, valueBytes) =>
  ({ type: "command", commands, keyMin: 1, keyMax: keys, keyPattern: "R", valueBytes });

const COMMAND_WORKLOADS = {
  get: { dataset: strings(STRING_KEYS, STRING_BYTES), workload: ratioWorkload("0:1", STRING_KEYS, STRING_BYTES), reads: true },
  set: { dataset: strings(STRING_KEYS, STRING_BYTES), workload: ratioWorkload("1:0", STRING_KEYS, STRING_BYTES), reads: false },
  incr: {
    dataset: STRUCTURES.counters,
    workload: commandWorkload([{ template: "INCR __key__", ratio: 1 }], STRING_KEYS, STRING_BYTES), reads: false,
  },
  hget: {
    dataset: STRUCTURES.hashes,
    workload: commandWorkload([{ template: "HGET __key__ f1", ratio: 1 }], STRUCTURES.hashes.keys, STRUCTURES.hashes.valueBytes), reads: true,
  },
  hset: {
    dataset: STRUCTURES.hashes,
    workload: commandWorkload([{ template: "HSET __key__ f1 __data__", ratio: 1 }], STRUCTURES.hashes.keys, STRUCTURES.hashes.valueBytes), reads: false,
  },
  list_push_pop: {
    dataset: STRUCTURES.lists,
    workload: commandWorkload([
      { template: "LPUSH __key__ __data__", ratio: 1 },
      { template: "RPOP __key__", ratio: 1 },
    ], STRUCTURES.lists.keys, STRUCTURES.lists.valueBytes), reads: false,
  },
  zincrby: {
    dataset: STRUCTURES.zsets,
    workload: commandWorkload([{ template: "ZINCRBY __key__ 1 m1", ratio: 1 }], STRUCTURES.zsets.keys, 0), reads: false,
  },
  zrange: {
    dataset: STRUCTURES.zsets,
    workload: commandWorkload([{ template: "ZRANGE __key__ 0 9", ratio: 1 }], STRUCTURES.zsets.keys, 0), reads: true,
  },
};

export const COMMAND_IDS = Object.keys(COMMAND_WORKLOADS);

function combination(group, id, fields) {
  return {
    id: `${group}-${id}`, group, label: id, connections: 16, pipeline: 1,
    redisProfile: "baseline", background: null, reads: false, ...fields,
  };
}

export function buildMatrix() {
  const combos = [];
  for (const command of COMMAND_IDS) {
    const spec = COMMAND_WORKLOADS[command];
    combos.push(combination("commands", command, {
      variant: { command }, dataset: spec.dataset, workload: spec.workload, reads: spec.reads,
    }));
  }
  for (const command of ["get", "set"]) {
    for (const pipeline of [1, 16, 64, 256]) {
      const spec = COMMAND_WORKLOADS[command];
      combos.push(combination("pipeline", `${command}-d${pipeline}`, {
        variant: { command, pipeline }, pipeline, dataset: spec.dataset, workload: spec.workload, reads: spec.reads,
      }));
    }
  }
  for (const command of ["get", "set"]) {
    for (const { valueBytes, keys } of VALUE_SIZES) {
      combos.push(combination("value-size", `${command}-${valueBytes}`, {
        variant: { command, valueBytes }, dataset: strings(keys, valueBytes),
        workload: ratioWorkload(command === "get" ? "0:1" : "1:0", keys, valueBytes), reads: command === "get",
      }));
    }
  }
  for (const mode of ["off", "rdb", "aof-everysec", "aof-always"]) {
    for (const connections of [1, 16, 64]) {
      combos.push(combination("persistence", `${mode}-c${connections}`, {
        variant: { mode, connections }, connections, redisProfile: mode === "off" ? "baseline" : mode,
        dataset: { ...strings(STRING_KEYS, STRING_BYTES), randomData: true }, workload: ratioWorkload("1:0", STRING_KEYS, STRING_BYTES, "R:R", { randomData: true }),
      }));
    }
  }
  for (const connections of [1, 16, 64, 256]) {
    combos.push(combination("connections", `c${connections}`, {
      variant: { connections }, connections, dataset: strings(STRING_KEYS, STRING_BYTES),
      workload: ratioWorkload("1:9", STRING_KEYS, STRING_BYTES),
    }));
  }
  const over = strings(MEMORY.overKeys, MEMORY.valueBytes);
  const memory = [
    { id: "fits", policy: "allkeys-lru", profile: "mem-fit", dataset: strings(MEMORY.fitKeys, MEMORY.valueBytes), pattern: "R:R", keys: MEMORY.fitKeys },
    { id: "lru-uniform", policy: "allkeys-lru", profile: "mem-lru", dataset: over, pattern: "R:R", keys: MEMORY.overKeys },
    { id: "lru-gaussian", policy: "allkeys-lru", profile: "mem-lru", dataset: over, pattern: "G:G", keys: MEMORY.overKeys, stddev: MEMORY.gaussianStddev },
    { id: "noeviction", policy: "noeviction", profile: "mem-noeviction", dataset: over, pattern: "R:R", keys: MEMORY.overKeys },
  ];
  for (const item of memory) {
    combos.push(combination("memory", item.id, {
      variant: { policy: item.policy, distribution: item.pattern === "G:G" ? "gaussian" : "uniform", dataKeys: item.keys },
      redisProfile: item.profile, dataset: item.dataset,
      workload: ratioWorkload("1:9", item.keys, MEMORY.valueBytes, item.pattern, item.stddev ? { keyStddev: item.stddev } : {}),
      expectEvictions: item.id !== "fits" && item.id !== "noeviction",
      expectOomRejections: item.id === "noeviction",
    }));
  }
  const blockingDataset = { ...strings(STRING_KEYS, STRING_BYTES), bigHash: BLOCKING.bigHash };
  const blocking = [
    { id: "baseline", background: null },
    { id: "hgetall", background: { command: "HGETALL", target: BLOCKING.bigHash.key, intervalSeconds: BLOCKING.hgetallIntervalSeconds } },
    { id: "keys", background: { command: "KEYS", pattern: BLOCKING.noMatchPattern, intervalSeconds: BLOCKING.keysIntervalSeconds } },
    { id: "scan", background: { command: "SCAN", pattern: BLOCKING.noMatchPattern, count: BLOCKING.scanCount, intervalSeconds: 0 } },
  ];
  for (const item of blocking) {
    combos.push(combination("blocking", item.id, {
      variant: { background: item.background?.command ?? "none" }, dataset: blockingDataset,
      workload: ratioWorkload("0:1", STRING_KEYS, STRING_BYTES), reads: true, background: item.background,
    }));
  }
  return combos;
}

export function matrixCounts(matrix = buildMatrix()) {
  const counts = Object.fromEntries(GROUP_ORDER.map(group => [group, 0]));
  for (const item of matrix) counts[item.group] += 1;
  return counts;
}

export function nominalPayloadBytes(dataset) {
  if (dataset.kind === "strings") return dataset.keys * dataset.valueBytes;
  if (dataset.kind === "hashes") return dataset.keys * dataset.fields * dataset.valueBytes;
  if (dataset.kind === "lists") return dataset.keys * dataset.elements * dataset.valueBytes;
  return null;
}

export function estimatedMinutes(matrix = buildMatrix(), protocol = PROTOCOL) {
  const perCombo = protocol.warmupSeconds + protocol.durationSeconds * protocol.repeatCount;
  return { measurementMinutes: Math.round(matrix.length * perCombo / 60), perComboSeconds: perCombo };
}

export const MIB_BYTES = MIB;
