export const MISSING = "未记录";
export const SCENARIOS = [
  { id: "point_select", label: "主键点查", color: "#1769aa", kind: "READ" },
  { id: "update_index", label: "索引更新", color: "#c66a13", kind: "WRITE" },
  { id: "update_index_async", label: "索引更新（异步刷盘）", color: "#a14572", kind: "WRITE" },
  { id: "read_write", label: "读写混合", color: "#1d7a4d", kind: "MIXED" },
];
export const METRICS = [
  { key: "qps", label: "查询吞吐", symbol: "QPS", unit: "queries/s" },
  { key: "tps", label: "事务吞吐", symbol: "TPS", unit: "events/s" },
  { key: "p95Ms", label: "p95 延迟", symbol: "p95", unit: "ms" },
  { key: "p99Ms", label: "p99 延迟", symbol: "p99", unit: "ms" },
];

export function validMetric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function text(value) {
  return value === undefined || value === null || value === "" ? MISSING : String(value);
}

export function formatNumber(value) {
  return validMetric(value)
    ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)
    : MISSING;
}

export function formatLatency(value) {
  if (!validMetric(value)) return MISSING;
  return `${Number(value.toPrecision(4)).toLocaleString("zh-CN", {
    maximumSignificantDigits: 4,
  })} ms`;
}

export function formatTick(value, metric) {
  if (metric.startsWith("p")) return formatLatency(value).replace(" ms", "");
  if (value >= 1e6) return `${Number((value / 1e6).toPrecision(3))}M`;
  if (value >= 1e3) return `${Number((value / 1e3).toPrecision(3))}K`;
  return formatNumber(value);
}

export function memoryBytes(value) {
  if (typeof value === "number") return validMetric(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([bkmg])?(?:i?b)?$/i);
  if (!match) return null;
  const power = { b: 0, k: 1, m: 2, g: 3 }[(match[2] ?? "b").toLowerCase()];
  return Number(match[1]) * 1024 ** power;
}

export function formatMemory(value) {
  const bytes = memoryBytes(value);
  if (bytes === null) return MISSING;
  return `${Number((bytes / 1024 ** 3).toPrecision(4))} GiB`;
}

export function formatDate(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return MISSING;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(value));
}

export function parseRuntime(runtime = {}) {
  const server = typeof runtime.dockerServer === "string" ? runtime.dockerServer.split("|") : [];
  const info = typeof runtime.dockerInfo === "string" ? runtime.dockerInfo.split("|") : [];
  const validInfo = info.length === 5 && info.every(Boolean)
    && Number.isFinite(Number(info[2])) && Number(info[2]) > 0
    && Number.isFinite(Number(info[3])) && Number(info[3]) > 0;
  return {
    version: server.length === 2 && server.every(Boolean) ? server[0] : null,
    platform: server.length === 2 && server.every(Boolean) ? server[1] : null,
    runtime: validInfo ? info[0] : null,
    kernel: validInfo ? info[1] : null,
    cpus: validInfo ? Number(info[2]) : null,
    memory: validInfo ? Number(info[3]) : null,
    storage: validInfo ? info[4] : null,
    compose: runtime.composeVersion,
    raw: runtime.dockerInfo,
  };
}

export function environmentGroups(data) {
  const environment = data.environment ?? {};
  const container = environment.container ?? {};
  const mysql = environment.mysql ?? {};
  const load = environment.loadGenerator ?? {};
  const host = environment.host ?? {};
  const runtime = parseRuntime(environment.runtime);
  const protocol = data.protocol ?? {};
  const dataset = data.dataset ?? {};
  const cpu = (value) => validMetric(value) ? `${formatNumber(value)} CPU` : MISSING;
  const rows = (values) => values.map(([label, value]) => ({ label, value: text(value) }));
  const groups = [
    { name: "MySQL 容器与配置", rows: rows([
      ["CPU 上限（配额）", cpu(container.mysqlCpuLimit)],
      ["内存上限", formatMemory(container.mysqlMemoryLimit)],
      ["InnoDB Buffer Pool", formatMemory(mysql.bufferPoolBytes)],
      ["运行平台", container.platform], ["镜像平台", container.imagePlatform],
      ["MySQL 版本", mysql.version], ["连接上限", mysql.maxConnections],
      ["事务隔离", mysql.transactionIsolation],
      ["innodb_flush_log_at_trx_commit", mysql.flushLogAtTransactionCommit],
      ["sync_binlog", mysql.syncBinlog], ["镜像引用", container.mysqlImage],
      ["镜像摘要", Array.isArray(container.repositoryDigests) ? container.repositoryDigests.join("\n") : null],
    ]) },
    { name: "压测端", rows: rows([
      ["CPU 上限（配额）", cpu(container.loadGeneratorCpuLimit)],
      ["内存上限", formatMemory(container.loadGeneratorMemoryLimit)],
      ["sysbench", load.sysbenchVersion], ["压测镜像", load.image],
    ]) },
    { name: "Docker VM", rows: rows([
      ["运行时", runtime.runtime], ["Docker 版本", runtime.version],
      ["Docker 平台", runtime.platform], ["Compose 版本", runtime.compose],
      ["内核", runtime.kernel], ["VM 可见 CPU", cpu(runtime.cpus)],
      ["VM 可见内存", formatMemory(runtime.memory)], ["存储驱动", runtime.storage],
      ["原始运行时记录", runtime.raw],
    ]) },
    { name: "宿主机", rows: rows([
      ["型号", host.model], ["架构", host.architecture],
      ["逻辑 CPU", cpu(host.cpuCount)], ["物理内存", formatMemory(host.memoryBytes)],
    ]) },
    { name: "实验协议", rows: rows([
      ["数据库", dataset.database], ["表数", dataset.tableCount],
      ["每表行数", formatNumber(dataset.tableSize)], ["总行数", formatNumber(dataset.actualRows)],
      ["并发", Array.isArray(protocol.concurrency) ? protocol.concurrency.join(" / ") : null],
      ["预热", validMetric(protocol.warmupSeconds) ? `${protocol.warmupSeconds} 秒` : null],
      ["单次测量", validMetric(protocol.durationSeconds) ? `${protocol.durationSeconds} 秒` : null],
      ["初始正式运行", protocol.initialRuns], ["最多正式运行", protocol.maximumRuns],
      ["补跑条件", validMetric(protocol.varianceThresholdPercent)
        ? `TPS 或 p99 差异超过 ${protocol.varianceThresholdPercent}%` : null],
      ["测试时间（UTC+8）", formatDate(data.component?.testedAt)],
    ]) },
  ];
  if (data.durabilityComparison) {
    groups[0].rows = groups[0].rows.filter((row) =>
      !["innodb_flush_log_at_trx_commit", "sync_binlog"].includes(row.label));
    for (const series of (data.series ?? []).filter((s) => ["update_index", "update_index_async"].includes(s.scenario))) {
      const logging = series.environment?.mysql ?? {};
      groups.push({ name: `${series.label} · 日志配置`, rows: rows([
        ["报告日期（UTC+8）", formatDate(series.testedAt)],
        ["结果组", series.runGroup],
        ["innodb_flush_log_at_trx_commit", logging.flushLogAtTransactionCommit],
        ["sync_binlog", logging.syncBinlog],
        ["innodb_flush_log_at_timeout", logging.flushLogAtTimeout],
        ["binlog 开启", logging.logBinEnabled === undefined ? null : logging.logBinEnabled ? "ON" : "OFF"],
      ]) });
    }
  }
  return groups;
}

export function projectReport(data) {
  if (!data || data.schemaVersion !== 1 || data.component?.id !== "mysql" || !Array.isArray(data.series)) {
    throw new Error("结果格式不兼容");
  }
  const levels = new Set((data.protocol?.concurrency ?? []).filter((v) => Number.isInteger(v) && v > 0));
  const series = SCENARIOS.filter((definition) => definition.id !== "update_index_async"
    || data.series.some((item) => item.scenario === definition.id)).map((definition) => {
    const source = data.series.find((item) => item.scenario === definition.id);
    const points = (Array.isArray(source?.points) ? source.points : [])
      .filter((point) => Number.isInteger(point.concurrency) && point.concurrency > 0 && point.status !== "failed")
      .map((point) => {
        levels.add(point.concurrency);
        return {
          ...point, scenario: definition.id,
          ...Object.fromEntries(METRICS.map(({ key }) => [key, validMetric(point[key]) ? point[key] : null])),
        };
      })
      .sort((a, b) => a.concurrency - b.concurrency);
    return { ...definition, label: typeof source?.label === "string" ? source.label : definition.label,
      points, environment: source?.environment ?? data.environment,
      testedAt: source?.testedAt ?? data.component.testedAt,
      runGroup: source?.runGroup, sourceRole: source?.sourceRole };
  });
  const concurrency = [...levels].sort((a, b) => a - b);
  return { data, series, concurrency, selectedConcurrency: concurrency.at(-1) ?? null };
}

export function peakPoint(report) {
  return report.series.flatMap((series) => series.points.map((point) => ({
    ...point, label: series.label, testedAt: series.testedAt, sourceRole: series.sourceRole,
  })))
    .filter((point) => validMetric(point.qps)).sort((a, b) => b.qps - a.qps)[0] ?? null;
}

function niceValues(low, high) {
  const values = [];
  for (let power = Math.floor(Math.log10(low)); power <= Math.ceil(Math.log10(high)); power += 1) {
    for (const multiple of [1, 2, 5]) values.push(multiple * 10 ** power);
  }
  return values;
}

export function createAxis(values, mode = "log", maxTicks = 6) {
  const usable = values.filter(validMetric).filter((v) => mode !== "log" || v > 0);
  if (!usable.length) return null;
  let min;
  let max;
  let ticks;
  if (mode === "log") {
    const low = Math.min(...usable);
    const high = Math.max(...usable);
    const candidates = niceValues(low / 2, high * 2);
    min = candidates.filter((value) => value <= low).at(-1);
    max = candidates.find((value) => value > high);
    if (!(min > 0) || !Number.isFinite(max)) return null;
    const within = candidates.filter((value) => value >= min && value <= max);
    const stride = Math.max(1, Math.ceil((within.length - 1) / (maxTicks - 1)));
    ticks = within.filter((_, index) => index % stride === 0);
    if (ticks.at(-1) !== max) ticks.push(max);
  } else {
    min = 0;
    const high = Math.max(...usable) || 1;
    const desiredStep = high / (maxTicks - 1);
    const power = 10 ** Math.floor(Math.log10(desiredStep));
    const step = [1, 2, 5, 10].map((v) => v * power).find((v) => v >= desiredStep);
    max = Math.ceil(high / step) * step;
    ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  }
  return {
    mode, min, max, ticks,
    position(value) {
      if (!validMetric(value) || (mode === "log" && value === 0)) return null;
      return mode === "log"
        ? (Math.log10(value) - Math.log10(min)) / (Math.log10(max) - Math.log10(min))
        : value / max;
    },
  };
}

export function chartSegments(points, concurrency, metric, axis) {
  const segments = [];
  let segment = [];
  for (const level of concurrency) {
    const point = points.find((p) => p.concurrency === level);
    const position = point ? axis?.position(point[metric]) : null;
    if (position === null || position === undefined) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else {
      segment.push({ concurrency: level, value: point[metric], position });
    }
  }
  if (segment.length) segments.push(segment);
  return segments;
}

export function stabilityLabel(value) {
  return { stable: "稳定", acceptable: "可接受", unstable: "不稳定", failed: "失败" }[value] ?? MISSING;
}

export function artifactUrl(rawPath) {
  const prefix = "benchmarks/mysql/results/";
  if (typeof rawPath !== "string" || !rawPath.startsWith(prefix)) return null;
  const parts = rawPath.slice(prefix.length).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return `./artifacts/mysql/${parts.map(encodeURIComponent).join("/")}`;
}
