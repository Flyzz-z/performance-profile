import { MISSING, createAxis, formatDate, formatLatency, formatMemory, formatNumber, text, validMetric } from "./report.mjs";

export { MISSING, createAxis, formatDate, formatLatency, formatMemory, formatNumber, text, validMetric };

export const SCENARIO_ORDER = ["commands", "pipeline", "value-size", "persistence", "connections", "memory", "blocking"];

export const COMMAND_LABELS = {
  get: "GET", set: "SET", incr: "INCR", hget: "HGET", hset: "HSET", list_push_pop: "LPUSH+RPOP", zincrby: "ZINCRBY", zrange: "ZRANGE 0 9",
};
export const MODE_LABELS = { off: "关闭", rdb: "RDB", "aof-everysec": "AOF everysec", "aof-always": "AOF always" };
export const MEMORY_LABELS = { "memory-fits": "全驻留", "memory-lru-uniform": "LRU · 均匀", "memory-lru-gaussian": "LRU · 高斯热点", "memory-noeviction": "noeviction" };
export const BLOCKING_LABELS = { "blocking-baseline": "无后台", "blocking-hgetall": "HGETALL 大 Hash", "blocking-keys": "KEYS", "blocking-scan": "SCAN 增量" };
export const SERIES_COLORS = ["#1769aa", "#c66a13", "#1d7a4d", "#a14572", "#008b91", "#b43e3e"];

const sizeLabel = bytes => bytes >= 1024 ? `${bytes / 1024}KB` : `${bytes}B`;

export function pointValid(point) {
  return Boolean(point) && point.attempts >= 2 && validMetric(point.selected?.opsPerSec) && point.selected.opsPerSec > 0;
}

export function projectRedisReport(data) {
  const scenarios = new Map((data?.scenarios ?? []).map(scenario => [scenario.id, scenario]));
  const points = new Map();
  for (const scenario of scenarios.values()) {
    for (const point of scenario.points ?? []) points.set(point.id, point);
  }
  return {
    data, scenarios, points,
    point: id => (pointValid(points.get(id)) ? points.get(id) : null),
    hasAny: [...points.values()].some(pointValid),
    flagged: [...points.values()].filter(point => pointValid(point) && point.loadgenBound),
  };
}

export function peakOps(report) {
  const candidates = [...report.points.values()].filter(pointValid);
  if (!candidates.length) return null;
  const peak = candidates.reduce((best, point) => (point.selected.opsPerSec > best.selected.opsPerSec ? point : best));
  return { point: peak, ops: peak.selected.opsPerSec, scope: describePoint(peak) };
}

export function describePoint(point) {
  const variant = point.variant ?? {};
  const parts = [];
  if (point.group === "commands") parts.push(COMMAND_LABELS[variant.command] ?? variant.command);
  if (point.group === "pipeline") parts.push(COMMAND_LABELS[variant.command], `Pipeline ${variant.pipeline}`);
  if (point.group === "value-size") parts.push(COMMAND_LABELS[variant.command], sizeLabel(variant.valueBytes));
  if (point.group === "persistence") parts.push("SET", MODE_LABELS[variant.mode]);
  if (point.group === "connections") parts.push("GET:SET 9:1");
  if (point.group === "memory") parts.push(MEMORY_LABELS[point.id]);
  if (point.group === "blocking") parts.push(`GET · ${BLOCKING_LABELS[point.id]}`);
  parts.push(`${point.connections} 连接`);
  return parts.filter(Boolean).join(" · ");
}

export function bandwidthMBps(point) {
  const bytes = point?.dataset?.valueBytes;
  const ops = point?.selected?.opsPerSec;
  if (!validMetric(bytes) || !validMetric(ops)) return null;
  return ops * bytes / 1e6;
}

export function percentChange(from, to) {
  if (!validMetric(from) || !validMetric(to) || from === 0) return null;
  return (to - from) / from * 100;
}

export function signedPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

export function formatOps(value) {
  return validMetric(value) ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value) : MISSING;
}

export function formatCount(value) {
  return validMetric(value) ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value) : MISSING;
}

export function percentText(value) {
  return validMetric(value) ? `${formatNumber(value)}%` : MISSING;
}

export function ratioLabel(value) {
  if (!validMetric(value)) return MISSING;
  return `${value >= 100 ? Math.round(value) : Number(value.toPrecision(3))}×`;
}

export function artifactUrl(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  const parts = rawPath.split("/");
  if (parts.some(part => !part || part === "." || part === "..") || rawPath.startsWith("/")) return null;
  return `./artifacts/redis/${parts.map(encodeURIComponent).join("/")}`;
}

const percent = percentText;

export function scenarioColumns(group) {
  const base = [
    { key: "ops", label: "ops/s", value: point => formatOps(point.selected?.opsPerSec) },
    { key: "p50", label: "p50", value: point => formatLatency(point.selected?.p50Ms) },
    { key: "p99", label: "p99", value: point => formatLatency(point.selected?.p99Ms) },
    { key: "p999", label: "p99.9", value: point => formatLatency(point.selected?.p999Ms) },
  ];
  const extras = {
    "value-size": [{ key: "bandwidth", label: "载荷带宽", value: point => `${formatCount(bandwidthMBps(point))} MB/s` }],
    persistence: [
      { key: "rdb", label: "RDB 保存", value: point => formatCount(point.redis?.rdbSaves) },
      { key: "aof", label: "AOF 重写", value: point => formatCount(point.redis?.aofRewrites) },
    ],
    memory: [
      { key: "hit", label: "命中率", value: point => percent(point.redis?.hitRatioPercent) },
      { key: "evicted", label: "淘汰/秒", value: point => formatOps(point.redis?.evictedPerSec) },
      { key: "oom", label: "OOM 拒绝", value: point => formatOps(point.redis?.oomRejections) },
      { key: "used", label: "used_memory", value: point => formatMemory(point.redis?.usedMemoryBytes) },
    ],
    blocking: [
      { key: "p9999", label: "p99.99", value: point => formatLatency(point.selected?.p9999Ms) },
      { key: "max", label: "最大延迟", value: point => formatLatency(point.selected?.maxMs) },
      { key: "bg", label: "后台执行", value: point => formatCount(point.runs?.map(run => run.background?.executions).filter(validMetric).reduce((a, b, _, all) => a + b / all.length, 0)) },
      { key: "slow", label: "慢日志条数", value: point => formatCount(point.runs?.map(run => run.background?.slowlogEntries ?? run.slowlogEntries).filter(validMetric).reduce((a, b, _, all) => a + b / all.length, 0)) },
    ],
  };
  return [
    ...base, ...(extras[group] ?? []),
    { key: "redisCpu", label: "Redis CPU", value: point => percent(point.resources?.redisQuotaPercent) },
    { key: "loadCpu", label: "压测端 CPU", value: point => percent(point.resources?.loadgenQuotaPercent) },
  ];
}

export function chartSpecs(report) {
  const series = (id, label, color, values) => ({ id, label, color, values });
  const pointsOf = ids => ids.map(id => report.point(id));
  const metric = (key, point) => point?.selected?.[key] ?? null;
  const specs = {};

  const commandIds = ["get", "set", "incr", "hget", "hset", "list_push_pop", "zincrby", "zrange"];
  specs.commands = {
    kind: "bars", categories: commandIds.map(command => ({ key: command, label: COMMAND_LABELS[command] })),
    panels: [
      { key: "ops", title: "吞吐", unit: "ops/s", metric: "opsPerSec", format: formatOps,
        series: [series("ops", "ops/s", SERIES_COLORS[0], Object.fromEntries(commandIds.map(c => [c, metric("opsPerSec", report.point(`commands-${c}`))])))] },
      { key: "p99", title: "p99 延迟", unit: "ms", metric: "p99Ms", format: formatLatency,
        series: [series("p99", "p99", SERIES_COLORS[1], Object.fromEntries(commandIds.map(c => [c, metric("p99Ms", report.point(`commands-${c}`))])))] },
    ],
    flags: Object.fromEntries(commandIds.map(c => [c, report.point(`commands-${c}`)?.loadgenBound === true])),
  };

  const lineSpec = (groupId, categoryList, categoryLabel, seriesList, pointId, xTitle) => ({
    kind: "line", xTitle, categories: categoryList.map(key => ({ key: String(key), label: categoryLabel(key) })),
    panels: [
      { key: "ops", title: "吞吐", unit: "ops/s", metric: "opsPerSec", format: formatOps,
        series: seriesList.map((entry, index) => series(entry.id, entry.label, SERIES_COLORS[index], Object.fromEntries(categoryList.map(key => [String(key), metric("opsPerSec", report.point(pointId(entry.id, key)))])))) },
      { key: "p99", title: "p99 延迟", unit: "ms", metric: "p99Ms", format: formatLatency,
        series: seriesList.map((entry, index) => series(entry.id, entry.label, SERIES_COLORS[index], Object.fromEntries(categoryList.map(key => [String(key), metric("p99Ms", report.point(pointId(entry.id, key)))])))) },
    ],
    flags: Object.fromEntries(seriesList.flatMap(entry => categoryList.map(key => [`${entry.id}:${key}`, report.point(pointId(entry.id, key))?.loadgenBound === true]))),
  });

  specs.pipeline = lineSpec("pipeline", [1, 16, 64, 256], key => String(key), [{ id: "get", label: "GET" }, { id: "set", label: "SET" }],
    (command, depth) => `pipeline-${command}-d${depth}`, "Pipeline 深度");
  specs["value-size"] = lineSpec("value-size", [64, 1024, 10240, 102400], sizeLabel, [{ id: "get", label: "GET" }, { id: "set", label: "SET" }],
    (command, size) => `value-size-${command}-${size}`, "Value 大小");
  specs["value-size"].panels.push({ key: "bandwidth", title: "有效载荷带宽", unit: "MB/s", metric: "bandwidth", format: value => `${formatCount(value)} MB/s`,
    series: ["get", "set"].map((command, index) => series(command, command.toUpperCase(), SERIES_COLORS[index],
      Object.fromEntries([64, 1024, 10240, 102400].map(size => [String(size), bandwidthMBps(report.point(`value-size-${command}-${size}`))])))) });
  specs.connections = lineSpec("connections", [1, 16, 64, 256], key => String(key), [{ id: "mix", label: "GET:SET 9:1" }],
    (_id, connections) => `connections-c${connections}`, "客户端连接数");

  const modes = ["off", "rdb", "aof-everysec", "aof-always"];
  const conns = [1, 16, 64];
  specs.persistence = {
    kind: "bars", categories: modes.map(mode => ({ key: mode, label: MODE_LABELS[mode] })),
    panels: [
      { key: "ops", title: "SET 吞吐", unit: "ops/s", metric: "opsPerSec", format: formatOps,
        series: conns.map((c, index) => series(`c${c}`, `${c} 连接`, SERIES_COLORS[index], Object.fromEntries(modes.map(mode => [mode, metric("opsPerSec", report.point(`persistence-${mode}-c${c}`))])))) },
      { key: "p99", title: "SET p99 延迟", unit: "ms", metric: "p99Ms", format: formatLatency,
        series: conns.map((c, index) => series(`c${c}`, `${c} 连接`, SERIES_COLORS[index], Object.fromEntries(modes.map(mode => [mode, metric("p99Ms", report.point(`persistence-${mode}-c${c}`))])))) },
    ],
    flags: Object.fromEntries(modes.flatMap(mode => conns.map(c => [`c${c}:${mode}`, report.point(`persistence-${mode}-c${c}`)?.loadgenBound === true]))),
  };

  const blockingIds = Object.keys(BLOCKING_LABELS);
  specs.blocking = {
    kind: "bars", categories: blockingIds.map(id => ({ key: id, label: BLOCKING_LABELS[id] })),
    panels: [{ key: "latency", title: "前台 GET 尾延迟", unit: "ms", metric: "p99Ms", format: formatLatency,
      series: [
        series("p99", "p99", SERIES_COLORS[0], Object.fromEntries(blockingIds.map(id => [id, metric("p99Ms", report.point(id))]))),
        series("p999", "p99.9", SERIES_COLORS[1], Object.fromEntries(blockingIds.map(id => [id, metric("p999Ms", report.point(id))]))),
        series("p9999", "p99.99", SERIES_COLORS[3], Object.fromEntries(blockingIds.map(id => [id, metric("p9999Ms", report.point(id))]))),
      ] },
    { key: "ops", title: "前台 GET 吞吐", unit: "ops/s", metric: "opsPerSec", format: formatOps,
      series: [series("ops", "ops/s", SERIES_COLORS[2], Object.fromEntries(blockingIds.map(id => [id, metric("opsPerSec", report.point(id))])))] }],
    flags: Object.fromEntries(blockingIds.map(id => [id, report.point(id)?.loadgenBound === true])),
  };
  return specs;
}

export function memoryCards(report) {
  return Object.keys(MEMORY_LABELS).map(id => {
    const point = report.point(id);
    return point ? { id, label: MEMORY_LABELS[id], point, loadgenBound: point.loadgenBound === true } : null;
  }).filter(Boolean);
}

export function environmentSummary(data) {
  const environment = data?.environment ?? {};
  const baseline = environment.profiles?.baseline ?? {};
  return [
    ["Redis", text(environment.redis?.version)],
    ["平台", text(environment.platform)],
    ["Redis 容器上限", validMetric(environment.redis?.cpus) ? `${environment.redis.cpus} CPU / ${formatMemory(environment.redis.memoryBytes)}` : MISSING],
    ["压测端上限", validMetric(environment.loadgen?.cpus) ? `${environment.loadgen.cpus} CPU / ${formatMemory(environment.loadgen.memoryBytes)}` : MISSING],
    ["io-threads", text(baseline["io-threads"])],
    ["默认持久化", baseline.appendonly === "no" && baseline.save === "" ? "关闭" : text(baseline.appendonly)],
  ];
}

export function environmentRows(data) {
  const environment = data?.environment ?? {};
  const protocol = data?.protocol ?? {};
  const rows = list => list.map(([label, value]) => ({ label, value: text(value) }));
  const memory = value => (validMetric(value) ? formatMemory(value) : MISSING);
  const cpu = value => (validMetric(value) ? `${value} CPU` : MISSING);
  return [
    { name: "Redis 容器", rows: rows([["版本", environment.redis?.version], ["镜像", environment.redis?.image], ["镜像 ID", environment.redis?.imageId],
      ["CPU 上限（配额）", cpu(environment.redis?.cpus)], ["内存上限", memory(environment.redis?.memoryBytes)]]) },
    { name: "压测端", rows: rows([["工具", environment.loadgen?.tool], ["版本", environment.loadgen?.version], ["镜像", environment.loadgen?.image],
      ["CPU 上限（配额）", cpu(environment.loadgen?.cpus)], ["内存上限", memory(environment.loadgen?.memoryBytes)]]) },
    { name: "Docker VM", rows: rows([["CPU 数", environment.dockerVm?.cpus], ["内存", memory(environment.dockerVm?.memoryBytes)], ["内核", environment.dockerVm?.kernel],
      ["系统", environment.dockerVm?.operatingSystem], ["Docker", environment.dockerVm?.dockerVersion]]) },
    { name: "宿主机", rows: rows([["系统", `${text(environment.host?.platform)} ${text(environment.host?.release)}`], ["架构", environment.host?.arch],
      ["CPU", environment.host?.cpuModel], ["核心数", environment.host?.cpuCount], ["内存", memory(environment.host?.memoryBytes)]]) },
    { name: "实验协议", rows: rows([["预热", `${protocol.warmupSeconds} 秒`], ["单次测量", `${protocol.durationSeconds} 秒`], ["重复", `${protocol.repeatCount} 次`],
      ["补跑阈值", `${protocol.thirdRunThresholdPercent}%`], ["资源采样", `${(protocol.resourceIntervalMs ?? 0) / 1000} 秒`],
      ["压测端受限阈值", `${protocol.loadgenBoundQuotaPercent}% 配额`]]) },
    ...Object.entries(environment.profiles ?? {}).map(([id, config]) => ({
      name: `Redis 配置 · ${id}`, rows: rows(Object.entries(config).map(([key, value]) => [key, value === "" ? "（空）" : value])),
    })),
  ];
}

export function coverageInfo(data) {
  const groups = data?.coverage?.groups ?? SCENARIO_ORDER.filter(id => (data?.scenarios ?? []).some(scenario => scenario.id === id));
  const total = data?.coverage?.total ?? SCENARIO_ORDER.length;
  const pending = data?.coverage?.pending ?? SCENARIO_ORDER.filter(id => !groups.includes(id));
  return { groups, pending, total, partial: groups.length < total };
}
