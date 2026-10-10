import {
  MISSING, METRICS, projectReport, peakPoint, environmentGroups,
  formatNumber, formatLatency, formatMemory, formatDate, text, stabilityLabel, artifactUrl, experimentConclusions,
} from "./report.mjs";
import { MetricChart } from "./charts.mjs";

const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
const badge = (value) => `<span class="status status-${["stable", "acceptable", "unstable", "failed"].includes(value) ? value : "missing"}">${stabilityLabel(value)}</span>`;
const scenarioName = (series) => `<span class="scenario-name"><i class="swatch" style="background:${series.color}"></i>${escape(series.label)}</span>`;
const quotaPercent = (value) => typeof value === "number" && Number.isFinite(value) ? `${formatNumber(value)}%` : MISSING;
let report;
let state;
let charts = [];
let requestNumber = 0;

function renderCommon() {
  const { data } = report;
  setText("mysql-version", text(data.component.version));
  setText("report-platform", text(data.environment?.container?.platform));
  setText("report-time", formatDate(data.component.testedAt));
}

function renderIndex() {
  const { data } = report;
  const container = data.environment?.container ?? {};
  const mysql = data.environment?.mysql ?? {};
  setText("index-resources", `${formatNumber(container.mysqlCpuLimit)} CPU / ${formatMemory(container.mysqlMemoryLimit)}`);
  setText("index-buffer", `Buffer Pool ${formatMemory(mysql.bufferPoolBytes)}`);
  const peak = peakPoint(report);
  setText("index-peak", peak ? formatNumber(peak.qps) : "暂无有效数据");
  setText("index-peak-scope", peak ? `${peak.label} · 并发 ${peak.concurrency} · ${stabilityLabel(peak.stability)}` : "未记录指标");
  setText("index-tested-at", formatDate(peak?.testedAt ?? data.component.testedAt));
}

function renderEnvironment() {
  const { data } = report;
  const container = data.environment?.container ?? {};
  const mysql = data.environment?.mysql ?? {};
  const protocol = data.protocol ?? {};
  const dataset = data.dataset ?? {};
  const formal = data.formalExperiment?.purpose === "formal";
  setText("dashboard-scope", formal
    ? `sysbench ${formatNumber(container.loadGeneratorCpuLimit)} CPU / ${formatMemory(container.loadGeneratorMemoryLimit)} · ${report.series.length} 场景正式实验`
    : "读、写、混合负载");
  document.querySelectorAll("[data-resource-column]").forEach((node) => { node.hidden = !formal; });
  setText("resource-unit-note", formal ? `CPU为各自配额占比：MySQL ${formatNumber(container.mysqlCpuLimit)} CPU / 压测 ${formatNumber(container.loadGeneratorCpuLimit)} CPU` : "");
  setText("cpu-limit", typeof container.mysqlCpuLimit === "number" ? `${formatNumber(container.mysqlCpuLimit)} CPU` : MISSING);
  setText("memory-limit", formatMemory(container.mysqlMemoryLimit));
  setText("buffer-pool", formatMemory(mysql.bufferPoolBytes));
  setText("dataset-size", typeof dataset.actualRows === "number" ? `${formatNumber(dataset.actualRows)} 行` : MISSING);
  setText("dataset-detail", `${text(dataset.tableCount)} 表 · 每表 ${formatNumber(dataset.tableSize)} 行`);
  document.getElementById("protocol-strip").innerHTML = [
    `预热 <b>${escape(text(protocol.warmupSeconds))}s</b>`,
    `单次测量 <b>${escape(text(protocol.durationSeconds))}s</b>`,
    `正式运行 <b>${escape(text(protocol.initialRuns))}-${escape(text(protocol.maximumRuns))} 次</b>`,
    `TPS / p99 差异 &gt; <b>${escape(text(protocol.varianceThresholdPercent))}%</b> 补跑`,
  ].map((item) => `<span>${item}</span>`).join("");
  document.getElementById("environment-groups").innerHTML = environmentGroups(data).map((group) =>
    `<details class="environment-detail"><summary>${escape(group.name)}</summary><dl>${group.rows.map((row) =>
      `<div class="${row.value.length > 65 ? "long-value" : ""}"><dt>${escape(row.label)}</dt><dd>${escape(row.value)}</dd></div>`).join("")}</dl></details>`).join("");
}

function renderConclusions() {
  const items = experimentConclusions(report.data);
  document.getElementById("experiment-conclusions").hidden = items.length === 0;
  const container = report.data.environment?.container ?? {};
  setText("conclusion-scope", `${text(container.platform)} · MySQL ${formatNumber(container.mysqlCpuLimit)} CPU · sysbench ${formatNumber(container.loadGeneratorCpuLimit)} CPU`);
  document.getElementById("conclusion-grid").innerHTML = items.map(item =>
    `<article class="conclusion-item" data-conclusion="${item.id}">
      <h3>${escape(item.title)}</h3><p class="conclusion-condition">${escape(item.scope)}</p>
      <p class="conclusion-headline"><strong>${escape(item.headline)}</strong><span>${escape(item.headlineLabel)}</span></p>
      <dl>${item.metrics.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>
      <p class="conclusion-note">${escape(item.note)}</p>
      ${item.stability.length ? `<div class="conclusion-stability">${item.stability.map(source => `<span>${escape(source.label)} ${badge(source.value)}</span>`).join("")}</div>` : ""}
    </article>`).join("");
}

function renderControls() {
  document.getElementById("scenario-controls").innerHTML = report.series.map((s) =>
    `<label class="scenario-option"><input type="checkbox" value="${s.id}" checked aria-label="${escape(s.label)}"/>
      <i class="swatch" style="background:${s.color}"></i>${escape(s.label)}</label>`).join("");
  document.getElementById("scenario-controls").onchange = (event) => {
    if (event.target.checked) state.visible.add(event.target.value);
    else state.visible.delete(event.target.value);
    renderDashboard();
  };
  document.getElementById("concurrency-controls").innerHTML = report.concurrency.map((value) =>
    `<button type="button" data-concurrency="${value}" aria-label="并发 ${value}" aria-pressed="${value === state.selectedConcurrency}">${value}</button>`).join("");
  document.getElementById("concurrency-controls").onclick = (event) => {
    const button = event.target.closest("button[data-concurrency]");
    if (button) selectConcurrency(Number(button.dataset.concurrency));
  };
  document.getElementById("chart-grid").innerHTML = METRICS.map((metric) =>
    `<article class="chart-panel" data-metric="${metric.key}" aria-label="${metric.label}">
      <div class="chart-heading"><h3>${metric.label}<span>${metric.unit}</span></h3>
        <div class="chart-scale"><span class="axis-label">Y 轴</span><div class="segmented" aria-label="${metric.symbol} 刻度">
          <button type="button" data-scale="linear" aria-label="${metric.symbol} 线性刻度" aria-pressed="false">线性</button>
          <button type="button" data-scale="log" aria-label="${metric.symbol} 对数刻度" aria-pressed="true">对数</button>
        </div></div></div>
      <div class="chart"></div><div class="chart-note"></div>
    </article>`).join("");
  charts = METRICS.map((metric) => {
    const panel = document.querySelector(`[data-metric="${metric.key}"]`);
    panel.querySelector(".chart-scale").onclick = (event) => {
      const button = event.target.closest("button[data-scale]");
      if (!button) return;
      state.scales[metric.key] = button.dataset.scale;
      renderDashboard();
    };
    return new MetricChart(panel, metric, selectConcurrency);
  });
}

function selectConcurrency(level) {
  state.selectedConcurrency = level;
  renderDashboard();
}

function renderDashboard() {
  const visibleSeries = report.series.filter((s) => state.visible.has(s.id));
  document.querySelectorAll("[data-concurrency]").forEach((button) => {
    if (button.tagName === "BUTTON") button.setAttribute("aria-pressed", String(Number(button.dataset.concurrency) === state.selectedConcurrency));
  });
  charts.forEach((chart) => {
    const mode = state.scales[chart.metric.key];
    chart.panel.querySelectorAll("[data-scale]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.scale === mode)));
    chart.update({ series: visibleSeries, concurrency: report.concurrency, selectedConcurrency: state.selectedConcurrency, mode });
  });
  setText("selected-concurrency", state.selectedConcurrency ?? MISSING);
  const measuredSeries = visibleSeries.filter(series => series.points.some(p => p.concurrency === state.selectedConcurrency));
  document.getElementById("selected-body").innerHTML = measuredSeries.length
    ? measuredSeries.map((series) => {
      const point = series.points.find((p) => p.concurrency === state.selectedConcurrency);
      return `<tr data-scenario="${series.id}"><td>${scenarioName(series)}</td><td>${formatNumber(point?.qps)}</td><td>${formatNumber(point?.tps)}</td>
        <td>${formatLatency(point?.p95Ms)}</td><td>${formatLatency(point?.p99Ms)}</td><td>${formatNumber(point?.queriesPerTransaction)}</td>
        ${report.data.formalExperiment?.purpose === "formal" ? `<td>${quotaPercent(point?.resources?.mysql?.meanQuotaPercent)}</td><td>${quotaPercent(point?.resources?.loadgen?.meanQuotaPercent)}</td>` : ""}
        <td>${badge(point?.stability)}</td></tr>`;
    }).join("")
    : `<tr><td colspan="${report.data.formalExperiment?.purpose === "formal" ? 9 : 7}">${visibleSeries.length ? "该并发无已测结果" : "未选择场景"}</td></tr>`;
}

function renderBufferPool() {
  const experiment = report.data.bufferPoolExperiment;
  const section = document.getElementById("buffer-pool-experiment");
  section.hidden = !experiment;
  if (!experiment) return;
  const groups = experiment.groups;
  const dataset = experiment.dataset;
  const environment = groups[0].environment;
  const fields = [
    {key:"qps",label:"查询吞吐",unit:"QPS",format:formatNumber},
    {key:"p99Ms",label:"p99 延迟",unit:"ms",format:formatLatency},
    {key:"hitPercent",label:"页面命中率",unit:"%",format:value=>`${formatNumber(value)}%`},
    {key:"readsPerSecond",label:"缺页读取",unit:"pages/s",format:formatNumber},
  ];
  document.getElementById("buffer-pool-results").innerHTML = `
    <p class="run-context">并发 ${experiment.concurrency} · ${formatNumber(dataset.actualRows)} 行 / ${dataset.tableCount} 表
      · 主键页占用 ${formatMemory(dataset.dataBytes)} · 预热 ${experiment.protocol.warmupSeconds}s / 测量 ${experiment.protocol.durationSeconds}s</p>
    <div class="cache-metrics">${fields.map(field=>{
      const max = Math.max(...groups.map(group=>group.selected[field.key]),Number.EPSILON);
      return `<article class="cache-metric" aria-label="${field.label}"><h3>${field.label}<small>${field.unit}</small></h3>${groups.map(group=>
        `<div class="cache-bar-row"><span>${group.gib} GiB</span><div class="cache-bar-track"><i style="width:${group.selected[field.key]/max*100}%;background:${group.gib===1?"#008b91":"#b43e3e"}"></i></div><strong>${field.format(group.selected[field.key])}</strong></div>`).join("")}</article>`;
    }).join("")}</div>
    <div class="table-scroll"><table aria-label="Buffer Pool 两组指标"><thead><tr><th>缓存</th><th>QPS</th><th>p95</th><th>p99</th><th>页命中率</th><th>缺页 / 秒</th><th>MySQL CPU</th><th>压测 CPU</th><th>稳定性</th></tr></thead><tbody>
    ${groups.map(group=>`<tr><td>${group.gib} GiB</td><td>${formatNumber(group.selected.qps)}</td><td>${formatLatency(group.selected.p95Ms)}</td><td>${formatLatency(group.selected.p99Ms)}</td><td>${formatNumber(group.selected.hitPercent)}%</td><td>${formatNumber(group.selected.readsPerSecond)}</td><td>${quotaPercent(group.resources.mysql.meanQuotaPercent)}</td><td>${quotaPercent(group.resources.loadgen.meanQuotaPercent)}</td><td>${badge(group.stability)}</td></tr>`).join("")}</tbody></table></div>
    ${groups.map(group=>`<details class="cache-run-detail environment-detail"><summary>${group.gib} GiB · ${group.attempts} 次测量 · ${stabilityLabel(group.stability)}</summary>
      <p class="run-context">MySQL ${group.environment.container.mysqlCpuLimit} CPU / ${formatMemory(group.environment.container.mysqlMemoryLimit)} · 压测 ${group.environment.container.loadGeneratorCpuLimit} CPU / ${formatMemory(group.environment.container.loadGeneratorMemoryLimit)} · ${escape(group.environment.container.platform)} · ${escape(group.environment.mysql.version)}
      · Buffer Pool ${formatMemory(group.bytes)} / ${group.environment.mysql.bufferPoolInstances} 实例 / chunk ${formatMemory(group.environment.mysql.bufferPoolChunkBytes)}
      · redo ${group.environment.mysql.flushLogAtTransactionCommit} / sync_binlog ${group.environment.mysql.syncBinlog}</p>
      <div class="table-scroll"><table><thead><tr><th>运行</th><th>QPS</th><th>p95</th><th>p99</th><th>页请求</th><th>缺页读取</th><th>命中率</th><th>资料</th></tr></thead><tbody>${group.runs.map(run=>`<tr><td>${run.repeat}</td><td>${formatNumber(run.metrics.qps)}</td><td>${formatLatency(run.metrics.p95Ms)}</td><td>${formatLatency(run.metrics.p99Ms)}</td><td>${formatNumber(run.pageMetrics.requests)}</td><td>${formatNumber(run.pageMetrics.reads)}</td><td>${formatNumber(run.pageMetrics.hitPercent)}%</td><td><a class="cache-raw-link" href="${escape(artifactUrl(run.rawOutputPath))}" target="_blank" rel="noreferrer">原始输出</a> · <a class="cache-resource-link" href="${escape(artifactUrl(run.resources.rawPath))}" target="_blank" rel="noreferrer">资源采样</a></td></tr>`).join("")}</tbody></table></div></details>`).join("")}
    <details class="environment-detail"><summary>缓存实验环境与数据清单</summary><div class="environment-groups">${environmentGroups({...report.data,environment,dataset,protocol:{...experiment.protocol,concurrency:[16]},series:[],durabilityComparison:null}).map(group=>`<dl><dt>${escape(group.name)}</dt>${group.rows.map(row=>`<div><dt>${escape(row.label)}</dt><dd>${escape(row.value)}</dd></div>`).join("")}</dl>`).join("")}</div><a href="${escape(artifactUrl(experiment.datasetPath))}" target="_blank" rel="noreferrer">数据与表结构</a></details>`;
}

function renderHotUpdate() {
  const experiment = report.data.hotUpdateExperiment;
  document.getElementById("hot-update-experiment").hidden = !experiment;
  if (!experiment) return;
  const groups = experiment.groups;
  const fields = [
    { label: "事务吞吐", unit: "TPS", value: g => g.metrics.tps, format: formatNumber },
    { label: "p99 延迟", unit: "ms", value: g => g.metrics.p99Ms, format: formatLatency },
    { label: "行锁等待速率", unit: "次 / 秒", value: g => g.locks.waitsPerSecond, format: formatNumber },
    { label: "平均每次等待", unit: "ms", value: g => g.locks.meanWaitMs, format: formatLatency },
  ];
  const link = (file, label) => `<a class="hot-artifact-link" href="${escape(artifactUrl(file))}" target="_blank" rel="noreferrer">${label}</a>`;
  document.getElementById("hot-update-results").innerHTML = `
    <p class="run-context">${escape(formatDate(experiment.testedAt))} · 16 并发 · 预热 30s / 测量 60s · 每组 1 次</p>
    <p class="run-context">10 表 / 共 100 万行 · 分散更新：100 万条活动记录 · 热点更新：每表 id=1，共 10 条活动记录</p>
    <div class="cache-metrics">${fields.map(field => {
      const max = Math.max(...groups.map(field.value), Number.EPSILON);
      return `<article class="cache-metric"><h3>${field.label}<small>${field.unit}</small></h3>${groups.map(g =>
        `<div class="cache-bar-row hot-bar-row"><span>${escape(g.label)}</span><div class="cache-bar-track"><i style="width:${field.value(g) / max * 100}%;background:${g.id === "hot" ? "#b43e3e" : "#008b91"}"></i></div><strong>${field.format(field.value(g))}</strong></div>`).join("")}</article>`;
    }).join("")}</div>
    <div class="table-scroll"><table aria-label="热点更新两组指标"><thead><tr><th>更新范围</th><th>TPS</th><th>p95 (ms)</th><th>p99 (ms)</th><th>等待次数</th><th>等待 / 秒</th><th>累计等待 (ms)</th><th>平均等待 (ms)</th><th>MySQL CPU</th><th>压测 CPU</th><th>失败数</th></tr></thead><tbody>
    ${groups.map(g => `<tr data-hot-group="${g.id}"><td>${escape(g.label)}</td><td>${formatNumber(g.metrics.tps)}</td><td>${formatLatency(g.metrics.p95Ms)}</td><td>${formatLatency(g.metrics.p99Ms)}</td><td>${formatNumber(g.locks.waits)}</td><td>${formatNumber(g.locks.waitsPerSecond)}</td><td>${formatNumber(g.locks.waitMs)}</td><td>${formatLatency(g.locks.meanWaitMs)}</td><td>${quotaPercent(g.resources.mysql.meanQuotaPercent)}</td><td>${quotaPercent(g.resources.loadgen.meanQuotaPercent)}</td><td class="hot-failures">${formatNumber(g.metrics.failureCount)}</td></tr>`).join("")}</tbody></table></div>
    ${groups.map(g => `<details class="hot-run-detail environment-detail"><summary>${escape(g.label)} · ${formatNumber(g.activeRows)} 条活动记录 · 1 次测量</summary>
      <p class="run-context">${escape(g.environment.container.platform)} · MySQL ${escape(g.environment.mysql.version)} · MySQL ${g.environment.container.mysqlCpuLimit} CPU / ${formatMemory(g.environment.container.mysqlMemoryLimit)} · sysbench ${g.environment.container.loadGeneratorCpuLimit} CPU / ${formatMemory(g.environment.container.loadGeneratorMemoryLimit)} · Buffer Pool ${formatMemory(g.environment.mysql.bufferPoolBytes)} · redo ${g.environment.mysql.flushLogAtTransactionCommit} / sync_binlog ${g.environment.mysql.syncBinlog} · binlog ON</p>
      <p class="run-context">每表访问 id=1–${formatNumber(g.idLimit)} · 主键 id + k 二级索引 · 单条自动提交 UPDATE · 均匀随机 · 锁计数窗口 ${formatNumber(g.locks.seconds)}s · 重连 ${formatNumber(g.metrics.reconnects)}</p>
      <p>${link(g.runs[1].rawOutputPath, "原始输出")} · ${link(g.runs[0].rawOutputPath, "预热输出")} · ${link(g.runs[1].lockPath, "锁计数")} · ${link(g.runs[1].resourcePath, "资源采样")} · ${link(g.datasetPath, "数据与索引清单")} · ${link(g.environmentPath, "环境清单")}</p></details>`).join("")}`;
}

function renderResults() {
  const { data } = report;
  const validRuns = (rows) => (Array.isArray(rows) ? rows : [])
    .filter((r) => r.status !== "failed" && r.errors === 0);
  const points = report.series.flatMap((series) => series.points.map((point) => ({ series, point })));
  setText("result-count", `${points.length} 个组合 · ${(data.rawResults ?? []).filter((r) => r.status === "passed").length} 次测量`);
  document.getElementById("result-details").innerHTML = points.length ? points.map(({ series, point }) => {
    const combination = (data.stability ?? []).find((s) => s.scenario === series.id && s.concurrency === point.concurrency);
    const runs = validRuns(combination?.runs);
    const logging = combination?.environment?.mysql ?? series.environment?.mysql ?? {};
    const structure = combination?.dataset;
    const context = `<p class="run-context">报告日期 ${escape(formatDate(combination?.testedAt ?? series.testedAt))}
      · redo ${escape(text(logging.flushLogAtTransactionCommit))} / sync_binlog ${escape(text(logging.syncBinlog))}
      · binlog ${logging.logBinEnabled === undefined ? MISSING : logging.logBinEnabled ? "ON" : "OFF"}
      ${structure?.tables ? ` · 主键 id / 自增 · k 二级索引 ${structure.secondaryIndex ? "有" : "无"}` : ""}</p>`;
    return `<details class="result-detail" data-scenario="${series.id}" data-level="${point.concurrency}">
      <summary><span class="detail-heading">${scenarioName(series)} · 并发 ${point.concurrency}</span>
        <span class="detail-stats"><span>QPS <strong>${formatNumber(point.qps)}</strong></span><span>TPS <strong>${formatNumber(point.tps)}</strong></span>
          <span>p99 <strong>${formatLatency(point.p99Ms)}</strong></span></span>
        <span class="detail-count">${escape(text(combination?.attempts ?? point.attempts))} 次 · 波动 ${formatNumber(combination?.spreadPercent)}%</span>${badge(point.stability)}</summary>
      ${context}<div class="table-scroll"><table aria-label="${escape(series.label)} 并发 ${point.concurrency} 逐次结果"><thead><tr>
        <th>运行</th><th>QPS</th><th>TPS</th><th>p95</th><th>p99</th><th>错误</th><th>原始输出</th></tr></thead><tbody>
      ${runs.length ? runs.map((run) => {
        const link = artifactUrl(run.rawOutputPath);
        const resources = run.resources;
        const resourceLink = artifactUrl(resources?.rawPath);
        const evidence = resources ? `<br><span class="resource-detail">CPU配额占比 DB ${formatNumber(resources.mysql?.meanQuotaPercent)}% / 压测 ${formatNumber(resources.loadgen?.meanQuotaPercent)}%
          · 限流周期 DB ${formatNumber(resources.mysql?.throttledPeriods)} / 压测 ${formatNumber(resources.loadgen?.throttledPeriods)}
          ${resourceLink ? ` · <a class="resource-link" href="${escape(resourceLink)}" target="_blank" rel="noreferrer">资源采样</a>` : ""}</span>` : "";
        return `<tr><td>第 ${escape(run.repeat)} 次</td><td>${formatNumber(run.qps)}</td><td>${formatNumber(run.tps)}</td>
          <td>${formatLatency(run.p95Ms)}</td><td>${formatLatency(run.p99Ms)}</td><td>${formatNumber(run.errors)}</td>
          <td>${link ? `<a class="run-link" href="${escape(link)}" target="_blank" rel="noreferrer">原始输出</a>` : MISSING}${evidence}
          ${run.rowCounts ? `<br>行数：预热前 ${formatNumber(run.rowCounts.beforeWarmup)} → 预热后 ${formatNumber(run.rowCounts.afterWarmup)} → 测量后 ${formatNumber(run.rowCounts.after)}` : ""}
          ${artifactUrl(run.datasetPath) ? ` · <a href="${escape(artifactUrl(run.datasetPath))}" target="_blank" rel="noreferrer">表结构与数据清单</a>` : ""}</td></tr>`;
      }).join("") : '<tr><td colspan="7">未记录逐次运行</td></tr>'}
      </tbody></table></div></details>`;
  }).join("") : '<p class="muted">暂无有效结果</p>';
}

async function loadData() {
  const request = ++requestNumber;
  charts.forEach((chart) => chart.destroy());
  charts = [];
  const status = document.getElementById("load-status");
  const content = document.getElementById("report");
  content.hidden = true;
  status.hidden = false;
  status.dataset.state = "loading";
  status.textContent = "正在读取测试结果...";
  try {
    const response = await fetch("./data/mysql.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
    const data = await response.json();
    if (request !== requestNumber) return;
    report = projectReport(data);
    state = { visible: new Set(report.series.map((s) => s.id)), selectedConcurrency: report.selectedConcurrency,
      scales: Object.fromEntries(METRICS.map((m) => [m.key, "log"])) };
    renderCommon();
    content.hidden = false;
    if (document.body.dataset.page === "mysql") {
      renderEnvironment();
      renderConclusions();
      renderControls();
      renderDashboard();
      renderResults();
      renderBufferPool();
      renderHotUpdate();
    } else renderIndex();
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
