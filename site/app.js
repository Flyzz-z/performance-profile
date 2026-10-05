import {
  MISSING, SCENARIOS, METRICS, projectReport, peakPoint, environmentGroups,
  formatNumber, formatLatency, formatMemory, formatDate, text, stabilityLabel, artifactUrl,
} from "./report.mjs";
import { MetricChart } from "./charts.mjs";

const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
const badge = (value) => `<span class="status status-${["stable", "acceptable", "unstable", "failed"].includes(value) ? value : "missing"}">${stabilityLabel(value)}</span>`;
const scenarioName = (series) => `<span class="scenario-name"><i class="swatch" style="background:${series.color}"></i>${escape(series.label)}</span>`;
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
  setText("index-tested-at", formatDate(data.component.testedAt));
}

function renderEnvironment() {
  const { data } = report;
  const container = data.environment?.container ?? {};
  const mysql = data.environment?.mysql ?? {};
  const protocol = data.protocol ?? {};
  const dataset = data.dataset ?? {};
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

function renderControls() {
  document.getElementById("scenario-controls").innerHTML = SCENARIOS.map((s) =>
    `<label class="scenario-option"><input type="checkbox" value="${s.id}" checked aria-label="${s.label}"/>
      <i class="swatch" style="background:${s.color}"></i>${s.label}</label>`).join("");
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
  document.getElementById("selected-body").innerHTML = visibleSeries.length
    ? visibleSeries.map((series) => {
      const point = series.points.find((p) => p.concurrency === state.selectedConcurrency);
      return `<tr data-scenario="${series.id}"><td>${scenarioName(series)}</td><td>${formatNumber(point?.qps)}</td><td>${formatNumber(point?.tps)}</td>
        <td>${formatLatency(point?.p95Ms)}</td><td>${formatLatency(point?.p99Ms)}</td><td>${formatNumber(point?.queriesPerTransaction)}</td><td>${badge(point?.stability)}</td></tr>`;
    }).join("")
    : '<tr><td colspan="7">未选择场景</td></tr>';
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
    return `<details class="result-detail" data-scenario="${series.id}" data-level="${point.concurrency}">
      <summary><span class="detail-heading">${scenarioName(series)} · 并发 ${point.concurrency}</span>
        <span class="detail-stats"><span>QPS <strong>${formatNumber(point.qps)}</strong></span><span>TPS <strong>${formatNumber(point.tps)}</strong></span>
          <span>p99 <strong>${formatLatency(point.p99Ms)}</strong></span></span>
        <span class="detail-count">${escape(text(combination?.attempts ?? point.attempts))} 次 · 波动 ${formatNumber(combination?.spreadPercent)}%</span>${badge(point.stability)}</summary>
      <div class="table-scroll"><table aria-label="${series.label} 并发 ${point.concurrency} 逐次结果"><thead><tr>
        <th>运行</th><th>QPS</th><th>TPS</th><th>p95</th><th>p99</th><th>错误</th><th>原始输出</th></tr></thead><tbody>
      ${runs.length ? runs.map((run) => {
        const link = artifactUrl(run.rawOutputPath);
        return `<tr><td>第 ${escape(run.repeat)} 次</td><td>${formatNumber(run.qps)}</td><td>${formatNumber(run.tps)}</td>
          <td>${formatLatency(run.p95Ms)}</td><td>${formatLatency(run.p99Ms)}</td><td>${formatNumber(run.errors)}</td>
          <td>${link ? `<a class="run-link" href="${escape(link)}" target="_blank" rel="noreferrer">原始输出</a>` : MISSING}</td></tr>`;
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
    state = { visible: new Set(SCENARIOS.map((s) => s.id)), selectedConcurrency: report.selectedConcurrency,
      scales: Object.fromEntries(METRICS.map((m) => [m.key, "log"])) };
    renderCommon();
    content.hidden = false;
    if (document.body.dataset.page === "mysql") {
      renderEnvironment();
      renderControls();
      renderDashboard();
      renderResults();
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
