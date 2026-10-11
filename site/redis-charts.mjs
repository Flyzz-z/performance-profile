import { createAxis, formatLatency, formatNumber } from "./redis-report.mjs";

const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function tickLabel(value, metric) {
  if (metric.endsWith("Ms")) return formatLatency(value).replace(" ms", "");
  if (value >= 1e6) return `${Number((value / 1e6).toPrecision(3))}M`;
  if (value >= 1e3) return `${Number((value / 1e3).toPrecision(3))}K`;
  return formatNumber(value);
}

export class RedisChart {
  constructor(container, spec, panel, mode = "log") {
    this.container = container;
    this.spec = spec;
    this.panel = panel;
    this.mode = spec.kind === "bars" ? "linear" : mode;
    this.container.addEventListener("pointermove", event => this.inspect(event));
    this.container.addEventListener("pointerleave", () => this.hideTooltip());
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(container);
  }

  setMode(mode) {
    this.mode = this.spec.kind === "bars" ? "linear" : mode;
    this.render();
  }

  flagged(series, category) {
    const flags = this.spec.flags ?? {};
    return flags[`${series.id}:${category.key}`] ?? flags[category.key] ?? false;
  }

  categoryAt(event) {
    if (!this.geometry) return null;
    const box = this.container.getBoundingClientRect();
    const localX = event.clientX - box.left;
    const { left, width, count } = this.geometry;
    if (localX < left - 12 || localX > left + width + 12) return null;
    const slot = this.spec.kind === "bars" ? Math.floor((localX - left) / (width / count)) : Math.round((localX - left) / width * (count - 1 || 1));
    return this.spec.categories[Math.max(0, Math.min(count - 1, slot))];
  }

  inspect(event) {
    const category = this.categoryAt(event);
    this.hideTooltip();
    if (!category) return;
    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.innerHTML = `<h4>${escape(category.label)} · ${escape(this.panel.title)}</h4>${this.panel.series.map(series => {
      const value = series.values[category.key];
      const flag = this.flagged(series, category) ? '<small> · 压测端受限</small>' : "";
      return `<div><span class="scenario-name"><i class="swatch" style="background:${series.color}"></i>${escape(series.label)}</span><span>${escape(this.panel.format(value))}${flag}</span></div>`;
    }).join("")}`;
    this.container.append(tooltip);
    const box = this.container.getBoundingClientRect();
    tooltip.style.left = `${Math.max(6, Math.min(event.clientX - box.left + 12, box.width - tooltip.offsetWidth - 6))}px`;
    tooltip.style.top = `${Math.max(6, Math.min(event.clientY - box.top + 10, box.height - tooltip.offsetHeight - 6))}px`;
  }

  hideTooltip() { this.container.querySelector(".chart-tooltip")?.remove(); }

  render() {
    const { categories } = this.spec;
    const { series } = this.panel;
    const values = series.flatMap(entry => categories.map(category => entry.values[category.key]));
    const axis = createAxis(values, this.mode);
    if (!axis) {
      this.geometry = null;
      this.container.innerHTML = `<div class="chart-empty">暂无有效数据</div>`;
      return;
    }
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    const left = 58;
    const top = 16;
    const width = Math.max(1, w - left - 18);
    const height = h - top - 32;
    const count = categories.length;
    this.geometry = { left, width, count };
    const y = ratio => top + height * (1 - ratio);
    const slotWidth = width / count;
    const xCenter = index => (this.spec.kind === "bars" ? left + slotWidth * (index + .5) : left + (count === 1 ? .5 : index / (count - 1)) * width);
    const grid = axis.ticks.map(tick => {
      const position = y(axis.position(tick));
      return `<line class="chart-grid-line" x1="${left}" x2="${left + width}" y1="${position}" y2="${position}"/>
        <text class="chart-axis" x="${left - 8}" y="${position + 4}" text-anchor="end">${escape(tickLabel(tick, this.panel.metric))}</text>`;
    }).join("");
    const labels = categories.map((category, index) =>
      `<text class="chart-axis" x="${xCenter(index)}" y="${h - 10}" text-anchor="middle">${escape(category.label)}</text>`).join("");
    let marks;
    if (this.spec.kind === "bars") {
      const groupWidth = Math.min(slotWidth * .72, 28 * series.length);
      const barWidth = groupWidth / series.length;
      marks = series.map((entry, seriesIndex) => categories.map((category, index) => {
        const value = entry.values[category.key];
        const position = axis.position(value);
        if (position === null || position === undefined) return "";
        const x = xCenter(index) - groupWidth / 2 + seriesIndex * barWidth;
        const flag = this.flagged(entry, category);
        return `<rect class="chart-bar${flag ? " chart-bar-flag" : ""}" x="${x + .5}" y="${y(position)}" width="${Math.max(2, barWidth - 1)}" height="${Math.max(1, top + height - y(position))}" fill="${entry.color}" data-series="${entry.id}" data-category="${category.key}" data-value="${value}"/>`;
      }).join("")).join("");
    } else {
      marks = series.map(entry => {
        const segments = [];
        let segment = [];
        categories.forEach((category, index) => {
          const value = entry.values[category.key];
          const position = axis.position(value);
          if (position === null || position === undefined) { if (segment.length) segments.push(segment); segment = []; }
          else segment.push({ index, category, value, position });
        });
        if (segment.length) segments.push(segment);
        return segments.map(points => (points.length > 1
          ? `<path class="chart-line" stroke="${entry.color}" d="${points.map((p, i) => `${i ? "L" : "M"}${xCenter(p.index)},${y(p.position)}`).join(" ")}"/>` : "")
          + points.map(p => `<circle class="chart-dot${this.flagged(entry, p.category) ? " chart-dot-flag" : ""}" data-series="${entry.id}" data-category="${p.category.key}" data-value="${p.value}" cx="${xCenter(p.index)}" cy="${y(p.position)}" r="3.4" fill="${entry.color}"/>`).join("")).join("");
      }).join("");
    }
    this.container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escape(this.panel.title)}，${this.mode === "log" ? "对数" : "线性"}刻度，单位 ${escape(this.panel.unit)}">${grid}${marks}${labels}</svg>`;
  }

  destroy() { this.observer.disconnect(); }
}
