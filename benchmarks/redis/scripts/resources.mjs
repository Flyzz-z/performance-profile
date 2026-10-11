import http from "node:http";
import { parseCpuStats } from "../../mysql/scripts/resources.mjs";
import { assert, runProcess } from "../../mysql/scripts/lib.mjs";
import { PROTOCOL } from "./protocol.mjs";

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
    request.setTimeout(5000, () => request.destroy(new Error("Docker stats timeout")));
    request.on("error", reject);
  });
}

export async function dockerSocket() {
  const context = await runProcess("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  const host = context.stdout.trim();
  assert(context.code === 0 && host.startsWith("unix://"), "Resource sampling requires the local Docker socket");
  return host.slice("unix://".length);
}

export async function inspectContainer(socket, id) {
  return dockerJson(socket, `/containers/${encodeURIComponent(id)}/json`);
}

const COUNTER_KEYS = ["cpuUsageNs", "periods", "throttledPeriods", "throttledTimeNs"];

export function summarizeResources(samples, limits, expectedSeconds, errors = [], intervalMs = PROTOCOL.resourceIntervalMs) {
  const summarize = (name) => {
    const points = samples.map((sample) => sample[name]);
    if (points.length < 2) return null;
    const first = points[0];
    const last = points.at(-1);
    const seconds = (last.timeMs - first.timeMs) / 1000;
    if (!(seconds > 0)) return null;
    const delta = (key) => last[key] - first[key];
    if (COUNTER_KEYS.some((key) => delta(key) < 0)) return null;
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
  const redis = summarize("redis");
  const loadgen = summarize("loadgen");
  const coverageSeconds = Math.min(redis?.coverageSeconds ?? 0, loadgen?.coverageSeconds ?? 0);
  const toleranceSeconds = intervalMs / 1000 * 2;
  const valid = errors.length === 0 && redis !== null && loadgen !== null
    && coverageSeconds >= expectedSeconds * .8
    && Math.max(redis.coverageSeconds, loadgen.coverageSeconds) <= expectedSeconds + toleranceSeconds
    && Math.max(redis.maxGapSeconds, loadgen.maxGapSeconds) <= toleranceSeconds;
  return {
    valid, status: valid ? "complete" : "insufficient",
    sampleCount: samples.length, coverageSeconds, expectedSeconds, limits, redis, loadgen, errors,
    loadgenBound: loadgen !== null && loadgen.meanQuotaPercent >= PROTOCOL.loadgenBoundQuotaPercent,
    note: "CPU% is relative to one CPU; quota% divides by the CPU limit. Throttled time is the kernel's cumulative throttling-time counter, not a wall-clock percentage.",
  };
}

export async function startResourceCapture({ socket, redisId, loadgenId, limits, expectedSeconds, intervalMs = PROTOCOL.resourceIntervalMs }) {
  const samples = [];
  const errors = [];
  let active = true;
  let timer;
  let wake;
  const loop = (async () => {
    while (active) {
      try {
        const [redis, loadgen] = await Promise.all([
          dockerJson(socket, `/containers/${redisId}/stats?stream=false&one-shot=true`),
          dockerJson(socket, `/containers/${loadgenId}/stats?stream=false&one-shot=true`),
        ]);
        samples.push({ sampledAt: new Date().toISOString(), redis: parseCpuStats(redis), loadgen: parseCpuStats(loadgen) });
      } catch (error) {
        if (active) { errors.push(error.message); break; }
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
        summary: summarizeResources(samples, limits, expectedSeconds, errors, intervalMs),
      };
    },
  };
}
