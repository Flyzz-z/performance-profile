import test from "node:test";
import assert from "node:assert/strict";
import { buildMatrix, matrixCounts, EXPECTED_COMBINATION_COUNTS, CONNECTION_MAP, VALUE_SIZES, MEMORY, REDIS_PROFILES,
  nominalPayloadBytes, estimatedMinutes, GROUP_ORDER } from "../protocol.mjs";
import { memtierRunArguments, memtierFillArguments, parseMemtierJson, connectionArguments } from "../memtier.mjs";

test("matrix declares the confirmed 48 combinations across seven groups", () => {
  const matrix = buildMatrix();
  assert.equal(matrix.length, 48);
  assert.deepEqual(matrixCounts(matrix), EXPECTED_COMBINATION_COUNTS);
  assert.equal(new Set(matrix.map(item => item.id)).size, 48);
  assert.deepEqual(GROUP_ORDER, ["commands", "pipeline", "value-size", "persistence", "connections", "memory", "blocking"]);
});

test("every combination references a known restart profile and supported connection count", () => {
  for (const item of buildMatrix()) {
    assert.ok(REDIS_PROFILES[item.redisProfile], item.id);
    assert.ok(CONNECTION_MAP[item.connections], item.id);
    assert.ok(item.dataset && item.workload, item.id);
  }
});

test("connection mapping is fixed as threads times clients", () => {
  const product = connections => CONNECTION_MAP[connections].threads * CONNECTION_MAP[connections].clients;
  assert.deepEqual([1, 16, 64, 256].map(product), [1, 16, 64, 256]);
  assert.deepEqual(connectionArguments(64), ["--threads=4", "--clients=16"]);
  assert.throws(() => connectionArguments(7), /Unsupported/);
});

test("command group uses the confirmed commands at fixed 16 connections", () => {
  const commands = buildMatrix().filter(item => item.group === "commands");
  assert.deepEqual(commands.map(item => item.variant.command),
    ["get", "set", "incr", "hget", "hset", "list_push_pop", "zincrby", "zrange"]);
  assert.ok(commands.every(item => item.connections === 16 && item.pipeline === 1));
  const listPushPop = commands.find(item => item.variant.command === "list_push_pop").workload;
  assert.deepEqual(listPushPop.commands.map(item => item.ratio), [1, 1]);
});

test("pipeline, value-size, persistence and connection matrices match the scope", () => {
  const matrix = buildMatrix();
  const pipeline = matrix.filter(item => item.group === "pipeline");
  assert.deepEqual([...new Set(pipeline.map(item => item.pipeline))], [1, 16, 64, 256]);
  assert.ok(pipeline.every(item => item.connections === 16));
  const sizes = matrix.filter(item => item.group === "value-size");
  assert.deepEqual([...new Set(sizes.map(item => item.variant.valueBytes))], [64, 1024, 10240, 102400]);
  const persistence = matrix.filter(item => item.group === "persistence");
  assert.deepEqual([...new Set(persistence.map(item => item.variant.mode))], ["off", "rdb", "aof-everysec", "aof-always"]);
  assert.deepEqual([...new Set(persistence.map(item => item.connections))], [1, 16, 64]);
  assert.ok(persistence.every(item => item.workload.ratio === "1:0"));
  const connections = matrix.filter(item => item.group === "connections");
  assert.deepEqual(connections.map(item => item.connections), [1, 16, 64, 256]);
  assert.ok(connections.every(item => item.workload.ratio === "1:9"));
});

test("value-size datasets keep the same nominal payload of 256 MB", () => {
  for (const { valueBytes, keys } of VALUE_SIZES) {
    assert.equal(nominalPayloadBytes({ kind: "strings", keys, valueBytes }), 256_000_000, String(valueBytes));
  }
});

test("memory scenario fits under and exceeds maxmemory", () => {
  const memory = buildMatrix().filter(item => item.group === "memory");
  assert.deepEqual(memory.map(item => item.id), ["memory-fits", "memory-lru-uniform", "memory-lru-gaussian", "memory-noeviction"]);
  const payload = item => nominalPayloadBytes(item.dataset);
  assert.ok(payload(memory[0]) < MEMORY.maxmemoryBytes);
  for (const item of memory.slice(1)) assert.ok(payload(item) > MEMORY.maxmemoryBytes * 1.5, item.id);
  assert.equal(memory[2].workload.keyPattern, "G:G");
  assert.equal(memory[2].workload.keyStddev, MEMORY.gaussianStddev);
  assert.equal(memory[3].expectOomRejections, true);
  assert.equal(memory[0].expectEvictions, false);
  assert.equal(memory[1].expectEvictions, true);
});

test("blocking scenario fixes background commands and parameters", () => {
  const blocking = buildMatrix().filter(item => item.group === "blocking");
  assert.deepEqual(blocking.map(item => item.background?.command ?? null), [null, "HGETALL", "KEYS", "SCAN"]);
  assert.equal(blocking[0].dataset.bigHash.fields, 100000);
  assert.equal(blocking[1].background.intervalSeconds, 0.2);
  assert.equal(blocking[3].background.count, 100);
  assert.ok(blocking.every(item => item.workload.ratio === "0:1" && item.connections === 16));
});

test("estimated measurement time follows the 30 second warmup and two 60 second runs", () => {
  assert.deepEqual(estimatedMinutes(), { measurementMinutes: 120, perComboSeconds: 150 });
});

test("memtier run arguments express ratio and command workloads", () => {
  const get = buildMatrix().find(item => item.id === "pipeline-get-d64");
  const args = memtierRunArguments({ workload: get.workload, connections: get.connections, pipeline: get.pipeline, seconds: 60, jsonOut: "/workspace/out.json" });
  for (const expected of ["--threads=2", "--clients=8", "--pipeline=64", "--test-time=60", "--ratio=0:1", "--key-pattern=R:R",
    "--data-size=256", "--key-minimum=1", "--key-maximum=1000000", "--json-out-file=/workspace/out.json", "--print-percentiles=50,95,99,99.9,99.99"]) {
    assert.ok(args.includes(expected), expected);
  }
  const list = buildMatrix().find(item => item.id === "commands-list_push_pop");
  const listArgs = memtierRunArguments({ workload: list.workload, connections: 16, seconds: 60, jsonOut: "x" });
  assert.equal(listArgs.filter(arg => arg.startsWith("--command=")).length, 2);
  assert.ok(listArgs.includes("--command=LPUSH __key__ __data__"));
  assert.ok(listArgs.includes("--command=RPOP __key__"));
  assert.ok(!listArgs.some(arg => arg.startsWith("--ratio=")));
  const gaussian = buildMatrix().find(item => item.id === "memory-lru-gaussian");
  const gaussianArgs = memtierRunArguments({ workload: gaussian.workload, connections: 16, seconds: 60, jsonOut: "x" });
  assert.ok(gaussianArgs.includes("--key-pattern=G:G") && gaussianArgs.includes("--key-stddev=150000"));
});

test("memtier fill loads every key sequentially", () => {
  const args = memtierFillArguments({ keys: 250000, valueBytes: 1024 });
  for (const expected of ["--ratio=1:0", "--key-pattern=P:P", "--requests=allkeys", "--key-maximum=250000", "--data-size=1024"]) {
    assert.ok(args.includes(expected), expected);
  }
});

const memtierJson = totals => JSON.stringify({ "ALL STATS": { Totals: totals } });
const goodTotals = { "Ops/sec": 91234.5, Count: 5474070, "Hits/sec": 80000, "Misses/sec": 0, "KB/sec": 1234.5, Latency: 0.17,
  "Percentile Latencies": { "p50.00": 0.15, "p95.00": 0.3, "p99.00": 0.5, "p99.90": 1.2, "p99.99": 3.4 }, "Max Latency": 40.5 };

test("memtier JSON parsing extracts throughput and the required percentiles", () => {
  const parsed = parseMemtierJson(memtierJson(goodTotals));
  assert.equal(parsed.opsPerSec, 91234.5);
  assert.equal(parsed.p99Ms, 0.5);
  assert.equal(parsed.p999Ms, 1.2);
  assert.equal(parsed.hitsPerSec, 80000);
  assert.equal(parsed.missesPerSec, 0);
});

test("memtier JSON parsing rejects incomplete output", () => {
  assert.throws(() => parseMemtierJson("not json"), /not parseable/);
  assert.throws(() => parseMemtierJson(JSON.stringify({})), /no Totals/);
  assert.throws(() => parseMemtierJson(memtierJson({ ...goodTotals, "Ops/sec": 0 })), /Ops\/sec/);
  const { "p99.90": _omitted, ...fewer } = goodTotals["Percentile Latencies"];
  assert.throws(() => parseMemtierJson(memtierJson({ ...goodTotals, "Percentile Latencies": fewer })), /p99.9/);
});

test("average latency is derived from the accumulated latency when the Totals average is zero", () => {
  const parsed = parseMemtierJson(memtierJson({ ...goodTotals, "Average Latency": 0, Count: 1000, "Accumulated Latency": 105 }));
  assert.equal(parsed.averageLatencyMs, 0.105);
});

test("tail latency p99.99 and the maximum are parsed and p99.99 is required", () => {
  const parsed = parseMemtierJson(memtierJson(goodTotals));
  assert.equal(parsed.p9999Ms, 3.4);
  assert.equal(parsed.maxMs, 40.5);
  const { "p99.99": _omitted, ...fewer } = goodTotals["Percentile Latencies"];
  assert.throws(() => parseMemtierJson(memtierJson({ ...goodTotals, "Percentile Latencies": fewer })), /p99.99/);
});

test("persistence combinations use incompressible random data for both loading and measurement", () => {
  const persistence = buildMatrix().filter(item => item.group === "persistence");
  assert.ok(persistence.every(item => item.workload.randomData === true && item.dataset.randomData === true));
  const args = memtierRunArguments({ workload: persistence[0].workload, connections: 16, seconds: 60, jsonOut: "x" });
  assert.ok(args.includes("--random-data"));
  assert.ok(memtierFillArguments({ keys: 10, valueBytes: 256, randomData: true }).includes("--random-data"));
  assert.ok(!memtierFillArguments({ keys: 10, valueBytes: 256 }).includes("--random-data"));
  const others = buildMatrix().filter(item => item.group !== "persistence");
  assert.ok(others.every(item => !item.workload.randomData));
});
