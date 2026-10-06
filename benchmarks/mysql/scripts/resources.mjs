import http from "node:http";
import { assert, runProcess } from "./lib.mjs";

function dockerJson(socketPath, route) {
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: route }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          const error = new Error(`Docker stats HTTP ${response.statusCode}`);
          error.status = response.statusCode;
          reject(error);
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error("Docker stats timeout")));
    request.on("error", reject);
  });
}

export function parseCpuStats(stats) {
  const cpu = stats.cpu_stats;
  const throttle = cpu?.throttling_data;
  const values = {
    timeMs: Date.parse(stats.read),
    cpuUsageNs: cpu?.cpu_usage?.total_usage,
    periods: throttle?.periods,
    throttledPeriods: throttle?.throttled_periods,
    throttledTimeNs: throttle?.throttled_time,
  };
  assert(Object.values(values).every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0),
    "Missing CPU or throttling counters");
  return values;
}

export function summarizeResources(samples, limits, expectedSeconds, errors = [], intervalMs = 5000) {
  const summarize = (name) => {
    const points = samples.map((sample) => sample[name]);
    if (points.length < 2) return null;
    const first = points[0];
    const last = points.at(-1);
    const seconds = (last.timeMs - first.timeMs) / 1000;
    if (!(seconds > 0)) return null;
    const delta = (key) => last[key] - first[key];
    if (["cpuUsageNs", "periods", "throttledPeriods", "throttledTimeNs"].some((key) => delta(key) < 0)) return null;
    const gaps = points.slice(1).map((point, index) => (point.timeMs - points[index].timeMs) / 1000);
    if (gaps.some((gap) => gap <= 0)) return null;
    const intervals = points.slice(1).map((point, index) => {
      const previous = points[index];
      return (point.cpuUsageNs - previous.cpuUsageNs) / ((point.timeMs - previous.timeMs) * 1e6) * 100;
    }).filter(Number.isFinite);
    const meanCpuPercent = delta("cpuUsageNs") / (seconds * 1e9) * 100;
    return {
      coverageSeconds: seconds,
      maxGapSeconds: Math.max(...gaps),
      meanCpuPercent,
      meanQuotaPercent: meanCpuPercent / limits[name].cpus,
      maxCpuPercent: Math.max(...intervals),
      throttledPeriods: delta("throttledPeriods"),
      periods: delta("periods"),
      throttledTimeSeconds: delta("throttledTimeNs") / 1e9,
    };
  };
  const mysql = summarize("mysql");
  const loadgen = summarize("loadgen");
  const coverageSeconds = Math.min(mysql?.coverageSeconds ?? 0, loadgen?.coverageSeconds ?? 0);
  const toleranceSeconds = intervalMs / 1000 * 2;
  const valid = errors.length === 0 && coverageSeconds >= expectedSeconds * .8
    && mysql !== null && loadgen !== null
    && Math.max(mysql.coverageSeconds, loadgen.coverageSeconds) <= expectedSeconds + toleranceSeconds
    && Math.max(mysql.maxGapSeconds, loadgen.maxGapSeconds) <= toleranceSeconds;
  return {
    valid, status: valid ? "complete" : "insufficient",
    sampleCount: samples.length, coverageSeconds, expectedSeconds,
    limits, mysql, loadgen, errors,
    note: "CPU% is relative to one CPU; quota% divides by CPU limit. Throttled time is the kernel's cumulative throttling-time counter, not a wall-clock utilization percentage.",
  };
}

export async function startResourceCapture({ mysqlId, loadName, expectedSeconds, cpus, intervalMs = 5000 }) {
  const context = await runProcess("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  const host = context.stdout.trim();
  assert(context.code === 0 && host.startsWith("unix://"), "Resource sampling requires the local Docker socket");
  const socket = host.slice("unix://".length);
  const samples = [];
  const errors = [];
  let active = true;
  let timer;
  let wake;
  let loadId;
  let limits;
  const loop = (async () => {
    while (active) {
      try {
        if (!loadId) {
          const load = await dockerJson(socket, `/containers/${encodeURIComponent(loadName)}/json`);
          const mysql = await dockerJson(socket, `/containers/${mysqlId}/json`);
          assert(load.HostConfig.NanoCpus === cpus * 1e9 && load.HostConfig.Memory === 1024 ** 3,
            "Actual sysbench resource limit mismatch");
          assert(mysql.HostConfig.NanoCpus === 4e9, "Actual MySQL CPU limit mismatch");
          loadId = load.Id;
          limits = {
            mysql: { cpus: 4, memoryBytes: mysql.HostConfig.Memory },
            loadgen: { cpus, memoryBytes: load.HostConfig.Memory },
          };
        }
        const [mysql, loadgen] = await Promise.all([
          dockerJson(socket, `/containers/${mysqlId}/stats?stream=false&one-shot=true`),
          dockerJson(socket, `/containers/${loadId}/stats?stream=false&one-shot=true`),
        ]);
        samples.push({ sampledAt: new Date().toISOString(), mysql: parseCpuStats(mysql), loadgen: parseCpuStats(loadgen) });
      } catch (error) {
        if (active && error.status !== 404) {
          errors.push(error.message);
          break;
        }
      }
      if (active) await new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, intervalMs);
      });
    }
  })();
  return {
    async stop() {
      active = false;
      clearTimeout(timer);
      wake?.();
      await loop;
      return {
        schemaVersion: 1, intervalMs, samples,
        summary: summarizeResources(samples, limits ?? {
          mysql: { cpus: 4 }, loadgen: { cpus },
        }, expectedSeconds, errors, intervalMs),
      };
    },
  };
}
