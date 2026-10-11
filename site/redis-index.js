import { projectRedisReport, coverageInfo, peakOps, formatOps, formatMemory, formatDate, text, validMetric } from "./redis-report.mjs";

const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };

export function indexSummary(data) {
  const report = projectRedisReport(data);
  const environment = data.environment ?? {};
  const peak = peakOps(report);
  const coverage = coverageInfo(data);
  return {
    version: text(data.component?.version ?? environment.redis?.version),
    platform: text(environment.platform),
    resources: validMetric(environment.redis?.cpus) ? `${environment.redis.cpus} CPU / ${formatMemory(environment.redis.memoryBytes)}` : "未记录",
    loadgen: (validMetric(environment.loadgen?.cpus) ? `压测端 ${environment.loadgen.cpus} CPU / ${formatMemory(environment.loadgen.memoryBytes)}` : "压测端未记录")
      + (coverage.partial ? ` · 已覆盖 ${coverage.groups.length}/${coverage.total} 个场景` : ""),
    peak: peak ? formatOps(peak.ops) : "暂无有效数据",
    peakScope: peak ? `ops/s · ${peak.scope}${peak.point.loadgenBound ? " · 压测端受限" : ""}` : "未记录指标",
    testedAt: formatDate(data.testedAt),
  };
}

async function load() {
  try {
    const response = await fetch("./data/redis.json", { cache: "no-store" });
    if (!response.ok) return;
    const summary = indexSummary(await response.json());
    setText("redis-index-version", summary.version);
    setText("redis-index-platform", summary.platform);
    setText("redis-index-resources", summary.resources);
    setText("redis-index-loadgen", summary.loadgen);
    setText("redis-index-peak", summary.peak);
    setText("redis-index-peak-scope", summary.peakScope);
    setText("redis-index-tested-at", summary.testedAt);
    document.getElementById("redis-entry").hidden = false;
  } catch {
    // Redis is optional on the index page; the entry stays hidden when its data is unavailable.
  }
}

if (typeof document !== "undefined") load();
