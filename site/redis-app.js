import {
  MISSING, SCENARIO_ORDER, projectRedisReport, redisConclusions, chartSpecs, scenarioColumns, memoryCards, environmentSummary,
  environmentRows, coverageInfo, describePoint, artifactUrl, formatNumber, formatOps, formatCount, formatLatency, formatMemory, formatDate, text, percentText,
} from "./redis-report.mjs";
import { RedisChart } from "./redis-charts.mjs";

const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
const STABILITY = { stable: "稳定", acceptable: "可接受", unstable: "不稳定" };
const badge = value => `<span class="status status-${STABILITY[value] ? value : "missing"}">${STABILITY[value] ?? MISSING}</span>`;

const SCENARIO_INFO = {
  commands: { title: "命令与数据结构基线", scope: "16 连接 · 无 Pipeline",
    note: "String 为 100 万 key × 256B；Hash 10 万个、每个 10 字段；List 与 ZSet 各 1000 个、每个 1000 个元素。写命令覆盖已有元素以保持结构大小稳定，LPUSH 与 RPOP 以 1:1 保持 List 长度；ZINCRBY 递增每个 ZSet 中固定成员的分数。" },
  pipeline: { title: "Pipeline 深度", scope: "GET 与 SET · 16 连接 · 100 万 key × 256B",
    note: "同一连接一次发送多条命令。延迟为每批请求延迟，不是单条命令延迟。" },
  "value-size": { title: "Value 大小", scope: "GET 与 SET · 16 连接",
    note: "名义载荷固定约 256 MB，key 数随 value 大小反比（64B 为 400 万、100KB 为 2500）。载荷带宽 = ops/s × value 大小，不含协议开销。" },
  persistence: { title: "持久化策略", scope: "100% SET · 100 万 key × 256B · 1 / 16 / 64 连接",
    note: "RDB 使用 Redis 默认 save 策略；AOF 分别为 everysec 与 always。磁盘为 Docker VM 虚拟存储，不代表物理磁盘 fsync 性能。value 为不可压缩的随机数据（避免压缩使 AOF 重写频率失真）。表中保留测量窗口内的 RDB 保存与 AOF 重写次数。" },
  connections: { title: "客户端连接数", scope: "GET:SET = 9:1 · 100 万 key × 256B",
    note: "连接数 = 线程数 × 每线程客户端数（1=1×1，16=2×8，64=4×16，256=4×64）。" },
  memory: { title: "内存压力与淘汰", scope: "GET:SET = 9:1 · 16 连接 · 1KB · maxmemory 1 GiB",
    note: "全驻留为 50 万 key；其余约 180 万 key（约 1.8 倍内存）。命中率 = keyspace 命中 /（命中 + 未命中）。noeviction 组写入被拒绝的 OOM 次数是测量结果。" },
  blocking: { title: "慢命令阻塞", scope: "前台 GET · 16 连接 · 100 万 key × 256B",
    note: "后台单客户端持续执行慢命令：HGETALL 10 万字段的大 Hash（5 次/秒）、KEYS 扫描全部键（2 次/秒）、SCAN（COUNT 100）连续遍历。固定频率与参数，不代表生产延迟。每次阻塞只拖住 16 个在途请求，占请求总数极小，所以 p99 不敏感，尾部请看 p99.99、最大延迟与吞吐变化。" },
};

let report;
let charts = [];
let requestNumber = 0;

const flagMark = point => (point.loadgenBound ? ' <span class="bound-flag" title="压测端 CPU 接近配额，结果可能受压测端限制">压测端受限</span>' : "");

function renderHeader(data) {
  setText("redis-version", text(data.component?.version ?? data.environment?.redis?.version));
  setText("report-platform", text(data.environment?.platform));
  setText("report-time", formatDate(data.testedAt));
  document.getElementById("redis-resources").innerHTML = environmentSummary(data)
    .map(([label, value]) => `<div><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join("");
}

function renderCoverage(data) {
  const coverage = coverageInfo(data);
  const note = document.getElementById("coverage-note");
  note.hidden = !coverage.partial;
  if (!coverage.partial) return;
  const titles = ids => ids.map(id => SCENARIO_INFO[id]?.title ?? id).join("、");
  note.textContent = `已覆盖 ${coverage.groups.length}/${coverage.total} 个场景：${titles(coverage.groups)}。其余场景尚未测量：${titles(coverage.pending)}。`;
}

function renderConclusions(data) {
  const items = redisConclusions(data);
  const section = document.getElementById("experiment-conclusions");
  section.hidden = items.length === 0;
  document.getElementById("conclusion-grid").innerHTML = items.map(item => `
    <article class="conclusion-item" data-conclusion="${item.id}">
      <h3>${escape(item.title)}</h3>
      <p class="conclusion-condition">${escape(item.condition)}</p>
      <p class="conclusion-headline"><strong>${escape(item.headline.value)}</strong><span>${escape(item.headline.label)}</span></p>
      <dl>${item.rows.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>
      <p class="conclusion-note">${escape(item.note)}</p>
      <div class="conclusion-stability">${item.stability ? badge(item.stability) : ""}${item.flagged ? '<span class="bound-flag">含压测端受限点</span>' : ""}</div>
    </article>`).join("");
}

function renderRunTable(point) {
  const link = (path, label) => (artifactUrl(path) ? `<a class="run-link" href="${escape(artifactUrl(path))}" target="_blank" rel="noreferrer">${label}</a>` : "");
  const percent = percentText;
  return `<details class="result-detail"><summary><span class="detail-heading">${escape(describePoint(point))}${flagMark(point)}</span>
    <span class="detail-stats"><span>ops/s <strong>${formatOps(point.selected.opsPerSec)}</strong></span><span>p99 <strong>${formatLatency(point.selected.p99Ms)}</strong></span></span>
    ${badge(point.stability)}<span class="detail-count">${point.attempts} 次观测</span></summary>
    <div class="table-scroll"><table><thead><tr><th>观测</th><th>ops/s</th><th>p50</th><th>p99</th><th>p99.9</th><th>p99.99</th><th>最大</th><th>错误回复</th><th>Redis CPU</th><th>压测端 CPU</th><th>资料</th></tr></thead><tbody>
    ${point.runs.map(run => `<tr><td>${run.repeat}</td><td>${formatOps(run.metrics?.opsPerSec)}</td><td>${formatLatency(run.metrics?.p50Ms)}</td><td>${formatLatency(run.metrics?.p99Ms)}</td>
      <td>${formatLatency(run.metrics?.p999Ms)}</td><td>${formatLatency(run.metrics?.p9999Ms)}</td><td>${formatLatency(run.metrics?.maxMs)}</td><td>${formatOps(run.redis?.errorReplies)}</td><td>${percent(run.resources?.redis?.meanQuotaPercent)}</td><td>${percent(run.resources?.loadgen?.meanQuotaPercent)}</td>
      <td>${link(run.rawOutputPath, "原始输出")} · ${link(run.memtierJsonPath, "memtier JSON")} · ${link(run.infoPath, "INFO")} · ${link(run.resourcePath, "资源采样")}</td></tr>`).join("")}
    </tbody></table></div></details>`;
}

function renderMemoryCards() {
  const cards = memoryCards(report);
  if (!cards.length) return "";
  return `<div class="redis-cards">${cards.map(({ label, point, loadgenBound }) => `
    <article class="redis-card"><h3>${escape(label)}${loadgenBound ? flagMark(point) : ""}</h3>
      <dl><div><dt>ops/s</dt><dd>${formatOps(point.selected.opsPerSec)}</dd></div><div><dt>p99</dt><dd>${formatLatency(point.selected.p99Ms)}</dd></div>
      <div><dt>命中率</dt><dd>${percentText(point.redis?.hitRatioPercent)}</dd></div>
      <div><dt>淘汰/秒</dt><dd>${formatOps(point.redis?.evictedPerSec)}</dd></div>
      <div><dt>OOM 拒绝</dt><dd>${formatOps(point.redis?.oomRejections)}</dd></div>
      <div><dt>used_memory</dt><dd>${formatMemory(point.redis?.usedMemoryBytes)}</dd></div></dl></article>`).join("")}</div>`;
}

function renderScenario(id, spec) {
  const info = SCENARIO_INFO[id];
  const scenario = report.scenarios.get(id);
  const points = (scenario?.points ?? []).filter(point => report.point(point.id));
  const index = SCENARIO_ORDER.indexOf(id) + 1;
  const columns = scenarioColumns(id);
  const panels = spec && id !== "memory" ? spec.panels : [];
  const flagged = points.some(point => point.loadgenBound);
  return `<section class="section-band scenario" id="scenario-${id}" aria-labelledby="title-${id}">
    <div class="section-heading"><h2 id="title-${id}">${index}. ${escape(info.title)}</h2><span class="muted">${escape(info.scope)}</span></div>
    <p class="scenario-note">${escape(info.note)}</p>
    ${points.length ? `${id === "memory" ? renderMemoryCards() : ""}
    <div class="chart-grid redis-chart-grid">${panels.map(panel => `
      <div class="chart-panel" data-scenario="${id}" data-panel="${panel.key}">
        <div class="chart-heading"><h3>${escape(panel.title)}<span>${escape(panel.unit)}</span></h3>
          <div class="chart-scale">${panel.series.length > 1 ? `<span class="legend">${panel.series.map(series => `<span class="scenario-name"><i class="swatch" style="background:${series.color}"></i>${escape(series.label)}</span>`).join("")}</span>` : ""}
          ${spec.kind === "line" ? `<span class="axis-label">刻度</span><div class="segmented" role="group" aria-label="刻度"><button type="button" data-scale="log" aria-pressed="true">对数</button><button type="button" data-scale="linear" aria-pressed="false">线性</button></div>` : ""}</div></div>
        <div class="chart"></div></div>`).join("")}</div>
    <div class="selected-values"><div class="table-scroll"><table aria-label="${escape(info.title)}数值"><thead><tr><th>组合</th>${columns.map(column => `<th>${escape(column.label)}</th>`).join("")}<th>稳定性</th></tr></thead><tbody>
      ${points.map(point => `<tr data-point="${escape(point.id)}"><td>${escape(describePoint(point))}${flagMark(point)}</td>${columns.map(column => `<td>${escape(column.value(point))}</td>`).join("")}<td>${badge(point.stability)}</td></tr>`).join("")}
    </tbody></table></div></div>
    ${flagged ? '<p class="muted flag-note">标记“压测端受限”的点，压测端 CPU 达到配额的 90% 以上，结果可能受压测端限制，不能当作 Redis 的性能上限。</p>' : ""}
    <div class="result-details">${points.map(renderRunTable).join("")}</div>` : '<p class="muted">暂无有效结果</p>'}
  </section>`;
}

function mountCharts(specs) {
  for (const id of SCENARIO_ORDER) {
    const spec = specs[id];
    if (!spec) continue;
    for (const panelElement of document.querySelectorAll(`.chart-panel[data-scenario="${id}"]`)) {
      const panel = spec.panels.find(entry => entry.key === panelElement.dataset.panel);
      const chart = new RedisChart(panelElement.querySelector(".chart"), spec, panel, "log");
      charts.push(chart);
      panelElement.querySelectorAll("[data-scale]").forEach(button => {
        button.onclick = () => {
          panelElement.querySelectorAll("[data-scale]").forEach(other => other.setAttribute("aria-pressed", String(other === button)));
          chart.setMode(button.dataset.scale);
        };
      });
      chart.render();
    }
  }
}

function renderScenarios() {
  const specs = chartSpecs(report);
  const available = SCENARIO_ORDER.filter(id => report.scenarios.has(id));
  document.getElementById("scenario-nav").innerHTML = available.map(id => `<a href="#scenario-${id}">${SCENARIO_ORDER.indexOf(id) + 1} ${escape(SCENARIO_INFO[id].title)}</a>`).join("");
  document.getElementById("scenarios").innerHTML = available.map(id => renderScenario(id, specs[id])).join("");
  mountCharts(specs);
}

function renderEnvironment(data) {
  document.getElementById("environment-groups").innerHTML = environmentRows(data).map(group => `
    <details class="environment-detail"><summary>${escape(group.name)}</summary>
      <dl>${group.rows.map(row => `<div><dt>${escape(row.label)}</dt><dd>${escape(row.value)}</dd></div>`).join("")}</dl></details>`).join("")
    + (artifactUrl(data.datasetPath) ? `<p class="muted dataset-link"><a href="${escape(artifactUrl(data.datasetPath))}" target="_blank" rel="noreferrer">数据装载清单</a></p>` : "");
}

async function loadData() {
  const request = ++requestNumber;
  charts.forEach(chart => chart.destroy());
  charts = [];
  const status = document.getElementById("load-status");
  const content = document.getElementById("report");
  content.hidden = true;
  status.hidden = false;
  status.dataset.state = "loading";
  status.textContent = "正在读取测试结果...";
  try {
    const response = await fetch("./data/redis.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
    const data = await response.json();
    if (request !== requestNumber) return;
    report = projectRedisReport(data);
    renderHeader(data);
    renderCoverage(data);
    renderConclusions(data);
    renderScenarios();
    renderEnvironment(data);
    content.hidden = false;
    status.hidden = true;
  } catch (error) {
    if (request !== requestNumber) return;
    content.hidden = true;
    status.dataset.state = "error";
    status.innerHTML = `<strong>无法读取测试结果</strong><p>${escape(error.message)}</p><button class="retry-button" type="button">重试</button>`;
    status.querySelector("button").onclick = loadData;
  }
}

loadData();
