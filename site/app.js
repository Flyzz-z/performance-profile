const SERIES_COLORS = {
  point_select: "#1769aa",
  update_index: "#c66a13",
  read_write: "#1d7a4d",
};

const numberFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
});

function formatNumber(value) {
  return Number.isFinite(value) ? numberFormatter.format(value) : "-";
}

function formatMs(value) {
  return Number.isFinite(value) ? `${numberFormatter.format(value)} ms` : "-";
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${numberFormatter.format(value)}%` : "-";
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "-";
  const gib = value / 1024 ** 3;
  return `${numberFormatter.format(gib)} GiB`;
}

function artifactUrl(rawOutputPath) {
  const prefix = "benchmarks/mysql/results/";
  return rawOutputPath.startsWith(prefix)
    ? `./artifacts/mysql/${encodeURI(rawOutputPath.slice(prefix.length))}`
    : "#";
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderLineChart(
  container,
  series,
  {
    metric,
    valueLabel,
    colorByScenario,
    valueFormatter = formatNumber,
  },
) {
  if (!container) return;
  const width = 900;
  const height = 340;
  const margin = { top: 24, right: 34, bottom: 54, left: 76 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const allPoints = series.flatMap((item) => item.points);
  if (!allPoints.length) {
    container.textContent = "暂无测试结果";
    return;
  }

  const xValues = [...new Set(allPoints.map((point) => point.concurrency))].sort(
    (left, right) => left - right,
  );
  const metricFor = (item) => item.metric ?? metric;
  const yValues = series
    .flatMap((item) =>
      item.points.map((point) => point[metricFor(item)]),
    )
    .filter(Number.isFinite);
  const minY = 0;
  const maxY = Math.max(...yValues) * 1.12 || 1;
  const xPosition = (value) =>
    margin.left +
    (xValues.indexOf(value) / Math.max(xValues.length - 1, 1)) * plotWidth;
  const yPosition = (value) =>
    margin.top + plotHeight - ((value - minY) / (maxY - minY)) * plotHeight;

  const gridLines = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = margin.top + plotHeight * ratio;
    const value = maxY * (1 - ratio);
    return `
      <line class="chart-grid-line" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" />
      <text class="chart-axis" x="${margin.left - 12}" y="${y + 4}" text-anchor="end">${escapeHtml(valueFormatter(value))}</text>
    `;
  }).join("");

  const xLabels = xValues
    .map(
      (value) =>
        `<text class="chart-axis" x="${xPosition(value)}" y="${height - 24}" text-anchor="middle">${value}</text>`,
    )
    .join("");

  const paths = series
    .map((item) => {
      const points = item.points
        .filter((point) => Number.isFinite(point[metricFor(item)]))
        .sort((left, right) => left.concurrency - right.concurrency);
      if (!points.length) return "";
      const d = points
        .map(
          (point, index) =>
            `${index === 0 ? "M" : "L"} ${xPosition(point.concurrency)} ${yPosition(point[metricFor(item)])}`,
        )
        .join(" ");
      const circles = points
        .map(
          (point) => `
            <circle class="chart-point" cx="${xPosition(point.concurrency)}" cy="${yPosition(point[metricFor(item)])}" r="4" fill="${colorByScenario[item.scenario]}">
              <title>${escapeHtml(item.label)}，并发 ${point.concurrency}，${valueLabel} ${escapeHtml(valueFormatter(point[metricFor(item)]))}</title>
            </circle>
          `,
        )
        .join("");
      return `
        <path class="chart-series ${item.lineStyle === "dashed" ? "chart-series-dashed" : ""}" d="${d}" stroke="${colorByScenario[item.scenario]}" />
        ${circles}
      `;
    })
    .join("");

  const legend = series
    .map(
      (item) => `
        <span class="legend-item">
          <span class="legend-swatch" style="background:${colorByScenario[item.scenario]}"></span>
          ${escapeHtml(item.label)}
        </span>
      `,
    )
    .join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(valueLabel)}与并发关系图">
      ${gridLines}
      ${xLabels}
      <text class="chart-label" x="${margin.left + plotWidth / 2}" y="${height - 4}" text-anchor="middle">并发数</text>
      ${paths}
    </svg>
    <div class="legend">${legend}</div>
  `;
}

function applyIndexData(data) {
  const headline = data.headline;
  const peak = headline?.peak;
  const comparison = headline?.representativeComparison;
  const container = document.querySelector("[data-mysql-headline]");
  if (!container || !peak) return;
  container.innerHTML = `
    <div><span>最高吞吐</span><strong>${formatNumber(peak.qps)} QPS</strong></div>
    <div><span>写读吞吐比</span><strong>${comparison ? `${numberFormatter.format(comparison.writeToRead.qpsRatio * 100)}%` : "-"}</strong></div>
  `;
  setText("[data-mysql-card] h2", `MySQL ${data.component.version}`);
}

function applyMysqlData(data) {
  const { component, environment, dataset, protocol } = data;
  setText(
    "[data-mysql-summary]",
    `${component.version} 在本机 Docker 环境中的读、写和混合负载探索性结果。`,
  );
  setText("[data-mysql-version]", component.version);
  setText(
    "[data-mysql-platform]",
    `${environment.container.platform} / ${environment.host.architecture}`,
  );
  setText(
    "[data-mysql-resources]",
    `${environment.container.mysqlCpuLimit} vCPU / ${environment.container.mysqlMemoryLimit}`,
  );
  setText(
    "[data-mysql-tested-at]",
    new Date(component.testedAt).toLocaleString("zh-CN", { hour12: false }),
  );
  setText(
    "[data-mysql-dataset]",
    `${dataset.tableCount} 表 / ${formatNumber(dataset.actualRows)} 行`,
  );
  setText("[data-mysql-concurrency]", protocol.concurrency.join(" / "));
  setText(
    "[data-mysql-protocol]",
    `${protocol.warmupSeconds}s 预热 + ${protocol.initialRuns} × ${protocol.durationSeconds}s`,
  );
  setText(
    "[data-mysql-scenarios]",
    data.series.map((item) => item.label).join(" / "),
  );

  const throughputSeries = data.series.flatMap((item) => [
    {
      ...item,
      metric: "qps",
      label: `${item.label} QPS`,
      lineStyle: "solid",
    },
    {
      ...item,
      metric: "tps",
      label: `${item.label} TPS`,
      lineStyle: "dashed",
    },
  ]);
  const latencySeries = data.series.flatMap((item) => [
    {
      ...item,
      metric: "p95Ms",
      label: `${item.label} p95`,
      lineStyle: "dashed",
    },
    {
      ...item,
      metric: "p99Ms",
      label: `${item.label} p99`,
      lineStyle: "solid",
    },
  ]);

  renderLineChart(document.querySelector("#throughput-chart"), throughputSeries, {
    valueLabel: "吞吐",
    colorByScenario: SERIES_COLORS,
  });
  renderLineChart(document.querySelector("#latency-chart"), latencySeries, {
    valueLabel: "延迟",
    colorByScenario: SERIES_COLORS,
    valueFormatter: formatMs,
  });

  const comparisonGrid = document.querySelector("#comparison-grid");
  if (comparisonGrid) {
    comparisonGrid.innerHTML = data.comparisons
      .map(
        (comparison) => `
          <article class="comparison-item">
            <h3>并发 ${comparison.concurrency}</h3>
            <dl>
              <div><dt>写/读 TPS</dt><dd>${formatPercent(comparison.writeToRead.tpsRatio * 100)}</dd></div>
              <div><dt>写/读 QPS</dt><dd>${formatPercent(comparison.writeToRead.qpsRatio * 100)}</dd></div>
              <div><dt>写/读 p95</dt><dd>${numberFormatter.format(comparison.writeToRead.p95Ratio)}×</dd></div>
              <div><dt>写/读 p99</dt><dd>${numberFormatter.format(comparison.writeToRead.p99Ratio)}×</dd></div>
            </dl>
          </article>
        `,
      )
      .join("");
  }

  const stabilityBody = document.querySelector("#stability-body");
  if (stabilityBody) {
    stabilityBody.innerHTML = data.stability
      .map(
        (row) => `
          <tr>
            <td>${escapeHtml(row.scenarioLabel)}</td>
            <td>${row.concurrency}</td>
            <td>${row.attempts}</td>
            <td>${formatNumber(row.selected.tps)}</td>
            <td>${formatMs(row.selected.p99Ms)}</td>
            <td>${formatPercent(row.spreadPercent)}</td>
            <td><span class="status status-${escapeHtml(row.stability)}">${escapeHtml(row.stability)}</span></td>
          </tr>
        `,
      )
      .join("");
  }

  const limitations = document.querySelector("#limitations-list");
  if (limitations) {
    limitations.innerHTML = data.limitations
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
  }

  const rawResultList = document.querySelector("#raw-result-list");
  if (rawResultList) {
    const groups = new Map();
    for (const result of data.rawResults) {
      if (!groups.has(result.scenario)) {
        groups.set(result.scenario, []);
      }
      groups.get(result.scenario).push(result);
    }
    rawResultList.innerHTML = [...groups.entries()]
      .map(([scenario, results]) => {
        const series = data.series.find((item) => item.scenario === scenario);
        return `
          <section>
            <h3>${escapeHtml(series?.label ?? scenario)}</h3>
            <div class="raw-link-grid">
              ${results
                .sort(
                  (left, right) =>
                    left.concurrency - right.concurrency ||
                    left.repeat - right.repeat,
                )
                .map(
                  (result) => `
                    <a href="${artifactUrl(result.rawOutputPath)}" target="_blank" rel="noreferrer">
                      并发 ${result.concurrency} / 第 ${result.repeat} 次
                    </a>
                  `,
                )
                .join("")}
            </div>
          </section>
        `;
      })
      .join("");
  }
}

async function loadData() {
  try {
    const response = await fetch("./data/mysql.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    applyIndexData(data);
    if (document.querySelector("#throughput-chart")) {
      applyMysqlData(data);
    }
  } catch (error) {
    console.error("Unable to load benchmark data", error);
  }
}

loadData();
