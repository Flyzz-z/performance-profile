import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectRedisReport, chartSpecs, scenarioColumns, peakOps, describePoint, artifactUrl, bandwidthMBps, percentChange,
  signedPercent, ratioLabel, environmentSummary, environmentRows, memoryCards, SCENARIO_ORDER, coverageInfo,
} from "../redis-report.mjs";
import { indexSummary } from "../redis-index.js";
import { buildReportData } from "../../benchmarks/redis/scripts/summary.mjs";
import { recomputeRun } from "../../benchmarks/redis/scripts/collect.mjs";
import { makeSummary } from "../../benchmarks/redis/scripts/test/fixtures.mjs";

function fixture(perCombo = () => ({})) {
  const resultsDir = mkdtempSync(path.join(os.tmpdir(), "redis-site-"));
  const summary = makeSummary(resultsDir, { perCombo });
  return buildReportData({ ...summary, results: summary.results.map(item => ({ combo: item.combo, runs: item.runs.map(run => recomputeRun(run, resultsDir)) })) });
}

const ops = (combo, table) => table[combo.id] ?? table[combo.group] ?? 90000;

test("projection exposes every formal combination and preserves source values", () => {
  const data = fixture();
  const before = JSON.stringify(data);
  const report = projectRedisReport(data);
  assert.equal(report.points.size, 48);
  assert.equal(report.hasAny, true);
  assert.deepEqual([...report.scenarios.keys()], SCENARIO_ORDER);
  assert.equal(report.point("commands-get").selected.opsPerSec, 90000);
  assert.equal(JSON.stringify(data), before);
});

test("combinations without enough observations are not drawn", () => {
  const data = fixture();
  data.scenarios[0].points[0].attempts = 1;
  data.scenarios[0].points[1].selected.opsPerSec = null;
  const report = projectRedisReport(data);
  assert.equal(report.point(data.scenarios[0].points[0].id), null);
  assert.equal(report.point(data.scenarios[0].points[1].id), null);
  assert.equal(projectRedisReport({}).hasAny, false);
  assert.equal(projectRedisReport(undefined).points.size, 0);
});

test("upward and downward changes are signed by their actual direction", () => {
  assert.equal(signedPercent(percentChange(100, 130)), "+30%");
  assert.equal(signedPercent(percentChange(100, 70)), "-30%");
  assert.equal(signedPercent(percentChange(0, 5)), "未记录");
  assert.equal(ratioLabel(11.34), "11.3×");
  assert.equal(ratioLabel(250), "250×");
});

test("loadgen-bound points are flagged without hiding values", () => {
  const data = fixture(combo => (combo.id === "pipeline-get-d256" ? { loadgenRate: 3.9 } : {}));
  const report = projectRedisReport(data);
  assert.deepEqual(report.flagged.map(point => point.id), ["pipeline-get-d256"]);
  assert.equal(report.point("pipeline-get-d256").selected.opsPerSec, 90000);
  const peak = peakOps(report);
  assert.ok(peak.ops > 0);
  assert.equal(chartSpecs(report).pipeline.flags["get:256"], true);
  assert.equal(chartSpecs(report).pipeline.flags["get:16"], false);
});

test("chart specs use scenario-appropriate chart kinds and keep missing values null", () => {
  const data = fixture();
  data.scenarios.find(item => item.id === "pipeline").points.find(point => point.id === "pipeline-set-d64").selected.opsPerSec = null;
  const specs = chartSpecs(projectRedisReport(data));
  assert.equal(specs.commands.kind, "bars");
  assert.equal(specs.commands.categories.length, 8);
  assert.equal(specs.pipeline.kind, "line");
  assert.deepEqual(specs.pipeline.categories.map(item => item.label), ["1", "16", "64", "256"]);
  assert.equal(specs.pipeline.panels[0].series.find(series => series.id === "set").values["64"], null);
  assert.deepEqual(specs["value-size"].categories.map(item => item.label), ["64B", "1KB", "10KB", "100KB"]);
  assert.equal(specs["value-size"].panels.length, 3);
  assert.equal(specs.persistence.kind, "bars");
  assert.equal(specs.persistence.panels[0].series.length, 3);
  assert.equal(specs.connections.categories.length, 4);
  assert.equal(specs.blocking.panels[0].series.length, 3);
  assert.equal(specs.memory, undefined);
});

test("value-size bandwidth is derived from ops and payload size", () => {
  const report = projectRedisReport(fixture());
  assert.equal(bandwidthMBps(report.point("value-size-get-102400")), 90000 * 102400 / 1e6);
  assert.equal(bandwidthMBps(null), null);
});

test("scenario tables expose scenario-specific evidence", () => {
  const report = projectRedisReport(fixture());
  const labels = group => scenarioColumns(group).map(column => column.label);
  assert.ok(labels("memory").includes("命中率") && labels("memory").includes("OOM 拒绝"));
  assert.ok(labels("persistence").includes("RDB 保存") && labels("persistence").includes("AOF 重写"));
  assert.ok(labels("blocking").includes("后台执行") && labels("value-size").includes("载荷带宽"));
  assert.ok(labels("commands").includes("Redis CPU") && labels("commands").includes("压测端 CPU"));
  const noeviction = report.point("memory-noeviction");
  assert.equal(scenarioColumns("memory").find(column => column.key === "oom").value(noeviction), "500");
  assert.equal(memoryCards(report).length, 4);
  assert.match(describePoint(report.point("blocking-hgetall")), /HGETALL 大 Hash/);
});

test("environment summary and rows come only from the historical snapshot", () => {
  const data = fixture();
  const summary = Object.fromEntries(environmentSummary(data));
  assert.equal(summary.Redis, "7.4.2");
  assert.equal(summary["Redis 容器上限"], "2 CPU / 4 GiB");
  assert.equal(summary["压测端上限"], "4 CPU / 1 GiB");
  const missing = Object.fromEntries(environmentSummary({ environment: {} }));
  assert.equal(missing.Redis, "未记录");
  assert.equal(missing["Redis 容器上限"], "未记录");
  assert.ok(environmentRows(data).some(group => group.name === "实验协议"));
  assert.ok(environmentRows({}).every(group => group.rows.every(row => typeof row.value === "string")));
});

test("raw evidence links use the Redis route and reject unsafe paths", () => {
  assert.equal(artifactUrl("formal-1/commands-get/run1.json"), "./artifacts/redis/formal-1/commands-get/run1.json");
  assert.equal(artifactUrl("a b/c.txt"), "./artifacts/redis/a%20b/c.txt");
  assert.equal(artifactUrl("../x"), null);
  assert.equal(artifactUrl("/abs"), null);
  assert.equal(artifactUrl(""), null);
  assert.equal(artifactUrl(undefined), null);
});

test("index summary reports the peak with its scenario scope", () => {
  const data = fixture(combo => (combo.id === "pipeline-get-d256" ? { opsPerSec: 900000, loadgenRate: 3.9 } : {}));
  const summary = indexSummary(data);
  assert.equal(summary.version, "7.4.2");
  assert.equal(summary.peak, "900,000");
  assert.match(summary.peakScope, /GET · Pipeline 256 · 16 连接/);
  assert.match(summary.peakScope, /压测端受限/);
  assert.equal(summary.resources, "2 CPU / 4 GiB");
  assert.equal(indexSummary({}).peak, "暂无有效数据");
});

test("coverage describes which scenario groups were measured", () => {
  const full = fixture();
  assert.deepEqual(coverageInfo(full), { groups: SCENARIO_ORDER, pending: [], total: 7, partial: false });
  const partial = structuredClone(full);
  partial.scenarios = partial.scenarios.filter(item => ["pipeline", "blocking"].includes(item.id));
  partial.coverage = { groups: ["pipeline", "blocking"], pending: ["commands", "value-size", "persistence", "connections", "memory"], incomplete: [], total: 7 };
  const info = coverageInfo(partial);
  assert.equal(info.partial, true);
  assert.deepEqual(info.groups, ["pipeline", "blocking"]);
  const legacy = structuredClone(partial);
  delete legacy.coverage;
  assert.deepEqual(coverageInfo(legacy).groups, ["pipeline", "blocking"]);
  assert.equal(indexSummary(partial).loadgen.includes("已覆盖 2/7 个场景"), true);
  assert.equal(indexSummary(full).loadgen.includes("已覆盖"), false);
});
