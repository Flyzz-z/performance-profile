import { CONNECTION_MAP } from "./protocol.mjs";

const PERCENTILES = "50,95,99,99.9,99.99";

function keyArguments(workload) {
  const args = [`--key-minimum=${workload.keyMin}`, `--key-maximum=${workload.keyMax}`];
  if (workload.keyStddev) args.push(`--key-stddev=${workload.keyStddev}`);
  return args;
}

export function connectionArguments(connections) {
  const mapping = CONNECTION_MAP[connections];
  if (!mapping) throw new Error(`Unsupported connection count: ${connections}`);
  return [`--threads=${mapping.threads}`, `--clients=${mapping.clients}`];
}

export function memtierRunArguments({ host = "redis", port = 6379, workload, connections, pipeline = 1, seconds, jsonOut }) {
  const args = ["memtier_benchmark", `--server=${host}`, `--port=${port}`, "--protocol=redis",
    ...connectionArguments(connections), `--pipeline=${pipeline}`, `--test-time=${seconds}`,
    "--hide-histogram", `--print-percentiles=${PERCENTILES}`, `--json-out-file=${jsonOut}`,
    "--distinct-client-seed"];
  if (workload.valueBytes) args.push(`--data-size=${workload.valueBytes}`);
  if (workload.randomData) args.push("--random-data");
  args.push(...keyArguments(workload));
  if (workload.type === "ratio") {
    args.push(`--ratio=${workload.ratio}`, `--key-pattern=${workload.keyPattern}`);
  } else if (workload.type === "command") {
    for (const command of workload.commands) {
      args.push(`--command=${command.template}`, `--command-ratio=${command.ratio}`, `--command-key-pattern=${workload.keyPattern}`);
    }
  } else {
    throw new Error(`Unknown workload type: ${workload.type}`);
  }
  return args;
}

export function memtierFillArguments({ host = "redis", port = 6379, keys, valueBytes, randomData = false }) {
  return ["memtier_benchmark", `--server=${host}`, `--port=${port}`, "--protocol=redis",
    "--threads=4", "--clients=8", "--pipeline=16", "--ratio=1:0", "--key-pattern=P:P",
    `--data-size=${valueBytes}`, "--key-minimum=1", `--key-maximum=${keys}`, "--requests=allkeys", "--hide-histogram", ...(randomData ? ["--random-data"] : [])];
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentileMap(block) {
  const source = block?.["Percentile Latencies"] ?? {};
  const map = {};
  for (const [key, value] of Object.entries(source)) {
    const parsed = Number(String(key).replace(/^p/i, ""));
    if (Number.isFinite(parsed) && numberOrNull(value) !== null) map[parsed] = value;
  }
  return map;
}

export function parseMemtierJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("memtier JSON output is not parseable"); }
  const totals = data?.["ALL STATS"]?.Totals;
  if (!totals) throw new Error("memtier JSON output has no Totals block");
  const percentiles = percentileMap(totals);
  const opsPerSec = numberOrNull(totals["Ops/sec"]);
  if (opsPerSec === null || opsPerSec <= 0) throw new Error("memtier JSON output has no valid Ops/sec");
  for (const required of [50, 95, 99, 99.9, 99.99]) {
    if (percentiles[required] === undefined) throw new Error(`memtier JSON output is missing the p${required} latency`);
  }
  const count = numberOrNull(totals.Count);
  const accumulated = numberOrNull(totals["Accumulated Latency"]);
  const reportedAverage = numberOrNull(totals["Average Latency"] ?? totals.Latency);
  const averageLatencyMs = count > 0 && accumulated !== null ? accumulated / count : reportedAverage;
  return {
    opsPerSec,
    count,
    hitsPerSec: numberOrNull(totals["Hits/sec"]) ?? 0,
    missesPerSec: numberOrNull(totals["Misses/sec"]) ?? 0,
    kbPerSec: numberOrNull(totals["KB/sec"]),
    averageLatencyMs,
    p50Ms: percentiles[50], p95Ms: percentiles[95], p99Ms: percentiles[99], p999Ms: percentiles[99.9], p9999Ms: percentiles[99.99],
    maxMs: numberOrNull(totals["Max Latency"]),
  };
}
