import { createAxis, chartSegments, formatTick, formatNumber, formatLatency, stabilityLabel } from "./report.mjs";

const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export class MetricChart {
  constructor(panel, metric, onSelect) {
    this.panel = panel;
    this.metric = metric;
    this.onSelect = onSelect;
    this.container = panel.querySelector(".chart");
    this.note = panel.querySelector(".chart-note");
    this.container.addEventListener("pointermove", (event) => this.inspect(event));
    this.container.addEventListener("pointerleave", () => this.hideTooltip());
    this.container.addEventListener("click", (event) => {
      const index = this.indexAt(event);
      if (index === null) return;
      this.onSelect(this.state.concurrency[index]);
      this.inspect(event);
    });
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(this.container);
  }

  update(state) {
    this.state = state;
    this.render();
  }

  indexAt(event) {
    if (!this.geometry || !this.state?.concurrency.length) return null;
    const box = this.container.getBoundingClientRect();
    const localX = event.clientX - box.left;
    const { left, width } = this.geometry;
    if (localX < left - 16 || localX > left + width + 16) return null;
    return Math.max(0, Math.min(this.state.concurrency.length - 1,
      Math.round((localX - left) / width * (this.state.concurrency.length - 1))));
  }

  inspect(event) {
    const index = this.indexAt(event);
    if (index === null) { this.hideTooltip(); return; }
    const level = this.state.concurrency[index];
    this.hideTooltip();
    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.setAttribute("role", "tooltip");
    const formatter = this.metric.key.startsWith("p") ? formatLatency : formatNumber;
    tooltip.innerHTML = `<h4>并发 ${level} · ${escape(this.metric.symbol)}</h4>${this.state.series.map((series) => {
      const point = series.points.find((p) => p.concurrency === level);
      return `<div><span class="scenario-name"><i class="swatch" style="background:${series.color}"></i>${escape(series.label)}</span>
        <span>${escape(formatter(point?.[this.metric.key]))}${point?.stability === "unstable"
          ? `<small> · ${stabilityLabel(point.stability)}</small>` : ""}</span></div>`;
    }).join("")}`;
    this.container.append(tooltip);
    const box = this.container.getBoundingClientRect();
    const localX = event.clientX - box.left;
    const localY = event.clientY - box.top;
    tooltip.style.left = `${Math.max(6, Math.min(localX + 12, box.width - tooltip.offsetWidth - 6))}px`;
    tooltip.style.top = `${Math.max(6, Math.min(localY + 10, box.height - tooltip.offsetHeight - 6))}px`;
  }

  hideTooltip() { this.container.querySelector(".chart-tooltip")?.remove(); }

  render() {
    if (!this.state) return;
    const { series, concurrency, selectedConcurrency, mode } = this.state;
    const values = series.flatMap((s) => s.points.map((p) => p[this.metric.key]));
    const axis = createAxis(values, mode);
    this.note.textContent = mode === "log" && values.includes(0) ? "零值无法绘于对数轴" : "";
    if (!axis || !series.length || !concurrency.length) {
      this.geometry = null;
      this.container.innerHTML = `<div class="chart-empty">${!series.length ? "未选择场景" : mode === "log" && values.includes(0) ? "无可绘制正值" : "暂无有效数据"}</div>`;
      return;
    }
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    const left = 54;
    const top = 18;
    const width = Math.max(1, w - left - 22);
    const height = h - top - 30;
    this.geometry = { left, width };
    const x = (level) => left + (concurrency.length === 1 ? .5 : concurrency.indexOf(level) / (concurrency.length - 1)) * width;
    const y = (ratio) => top + height * (1 - ratio);
    const grid = axis.ticks.map((tick) => {
      const position = y(axis.position(tick));
      return `<line class="chart-grid-line" x1="${left}" x2="${left + width}" y1="${position}" y2="${position}"/>
        <text class="chart-axis" x="${left - 9}" y="${position + 4}" text-anchor="end">${escape(formatTick(tick, this.metric.key))}</text>`;
    }).join("");
    const labels = concurrency.map((level) =>
      `<text class="chart-axis" x="${x(level)}" y="${h - 9}" text-anchor="middle">${level}</text>`).join("");
    const paths = series.map((s) => chartSegments(s.points, concurrency, this.metric.key, axis).map((segment) => {
      const line = segment.length > 1 ? `<path class="chart-line" stroke="${s.color}" data-scenario="${s.id}"
        d="${segment.map((p, i) => `${i ? "L" : "M"}${x(p.concurrency)},${y(p.position)}`).join(" ")}"/>` : "";
      return line + segment.map((p) => `<circle class="chart-dot" data-scenario="${s.id}" data-concurrency="${p.concurrency}" data-value="${p.value}"
        cx="${x(p.concurrency)}" cy="${y(p.position)}" r="${p.concurrency === selectedConcurrency ? 4.4 : 3.1}" fill="${s.color}"/>`).join("");
    }).join("")).join("");
    const selected = concurrency.includes(selectedConcurrency)
      ? `<line class="chart-selected" x1="${x(selectedConcurrency)}" x2="${x(selectedConcurrency)}" y1="${top}" y2="${top + height}"/>` : "";
    this.container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escape(this.metric.label)}，${mode === "log" ? "对数" : "线性"}刻度，单位 ${escape(this.metric.unit)}，并发 ${concurrency.join("、")}">
      ${grid}${selected}${paths}${labels}</svg>`;
  }

  destroy() { this.observer.disconnect(); }
}
