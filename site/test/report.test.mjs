import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  projectReport, environmentGroups, createAxis, chartSegments, formatLatency,
  formatMemory, parseRuntime, formatDate, peakPoint, artifactUrl, experimentConclusions,
} from "../report.mjs";

const data = JSON.parse(readFileSync(new URL("../data/mysql.json", import.meta.url)));

test("projects all report combinations without changing source values", () => {
  const before = JSON.stringify(data);
  const report = projectReport(data);
  assert.deepEqual(report.concurrency, [...new Set([...data.protocol.concurrency,
    ...data.series.flatMap(s => s.points.map(p => p.concurrency))])].sort((a,b) => a-b));
  assert.equal(report.series.flatMap((s) => s.points).length, data.series.flatMap((s) => s.points).length);
  for (const series of report.series) {
    for (const point of series.points) {
      const source = data.series.find((s) => s.scenario === series.id).points.find((p) => p.concurrency === point.concurrency);
      for (const metric of ["qps", "tps", "p95Ms", "p99Ms"]) assert.equal(point[metric], source[metric]);
    }
  }
  assert.equal(JSON.stringify(data), before);
  assert.equal(peakPoint(report).qps, Math.max(...data.series.flatMap((s) => s.points.map((p) => p.qps))));
});

test("mixed workload ratio is presentation-only and preserves result data", () => {
  const before = JSON.stringify(data);
  const report = projectReport(data);
  assert.equal(report.series.find((series) => series.id === "read_write").label, "读写混合（读:写 = 7:2）");
  assert.equal(JSON.stringify(data), before);
});

test("accepts empty and partial reports, excludes failed points", () => {
  assert.equal(projectReport({ ...data, series: [] }).series.flatMap((s) => s.points).length, 0);
  const partial = structuredClone(data);
  partial.series[0].points[0].qps = null;
  partial.series[0].points[1].status = "failed";
  const report = projectReport(partial);
  assert.equal(report.series[0].points[0].qps, null);
  assert.equal(report.series[0].points.length, data.series[0].points.length - 1);
  assert.throws(() => projectReport({ schemaVersion: 2 }), /格式/);
});

test("formats binary resources and submillisecond latency truthfully", () => {
  assert.equal(formatMemory("6g"), "6 GiB");
  assert.equal(formatMemory("1g"), "1 GiB");
  assert.equal(formatMemory(3221225472), "3 GiB");
  assert.equal(formatMemory("broken"), "未记录");
  assert.equal(formatLatency(0.027), "0.027 ms");
  assert.equal(formatLatency(0.00001), "0.00001 ms");
  assert.equal(formatLatency(null), "未记录");
  assert.equal(formatLatency(0), "0 ms");
});

test("keeps resource layers distinct and complete", () => {
  const groups = environmentGroups(data);
  const lookup = (name, label) => groups.find((g) => g.name === name).rows.find((r) => r.label === label).value;
  assert.equal(lookup("MySQL 容器与配置", "CPU 上限（配额）"), `${data.environment.container.mysqlCpuLimit} CPU`);
  assert.equal(lookup("压测端", "CPU 上限（配额）"), `${data.environment.container.loadGeneratorCpuLimit} CPU`);
  assert.equal(lookup("Docker VM", "VM 可见 CPU"), "10 CPU");
  assert.equal(lookup("宿主机", "物理内存"), "16 GiB");
  if (!data.durabilityComparison) assert.equal(lookup("MySQL 容器与配置", "sync_binlog"), "1");
  assert.match(lookup("MySQL 容器与配置", "镜像摘要"), /sha256:/);
});

test("fourth series uses its actual environment without inventing historical binlog state", () => {
  const fixture = structuredClone(data);
  fixture.series = fixture.series.filter((series) => ["point_select", "update_index", "read_write"].includes(series.scenario));
  const source = fixture.series.find((series) => series.scenario === "update_index");
  source.label = "索引更新（同步刷盘）";
  source.environment = { mysql: { flushLogAtTransactionCommit: 1, syncBinlog: 1, logBinEnabled: true, flushLogAtTimeout: 1 } };
  fixture.series.push({ ...structuredClone(source), scenario: "update_index_async", label: "索引更新（异步刷盘）",
    environment: { mysql: { flushLogAtTransactionCommit: 2, syncBinlog: 0, logBinEnabled: true, flushLogAtTimeout: 1 } } });
  fixture.durabilityComparison = { runGroup: "fixture" };
  const report = projectReport(fixture);
  assert.equal(report.series.length, 4);
  assert.equal(report.series.find((s) => s.id === "update_index_async").environment.mysql.syncBinlog, 0);
  const groups = environmentGroups(fixture);
  assert.equal(groups.find((g) => g.name.startsWith("索引更新（异步")).rows.find((r) => r.label === "sync_binlog").value, "0");
  assert.ok(!groups[0].rows.some((row) => row.label === "sync_binlog"));
  fixture.series = fixture.series.filter((s) => s.scenario !== "update_index_async");
  assert.equal(projectReport(fixture).series.length, 3);
});

test("handles incomplete and malformed environment without inventing values", () => {
  const groups = environmentGroups({ ...data, environment: {} });
  assert.equal(groups[0].rows[0].value, "未记录");
  assert.equal(parseRuntime({ dockerInfo: "OrbStack|bad|invalid|4|overlayfs" }).cpus, null);
  assert.equal(parseRuntime({ dockerServer: "bad" }).version, null);
  assert.match(formatDate("2026-10-05T15:37:52.442Z"), /23:37:52/);
  assert.equal(formatDate("invalid"), "未记录");
});

test("log axes cover multiple magnitudes with compact limits", () => {
  const axis = createAxis([190.75, 313.625, 135335.59]);
  assert.equal(axis.min, 100);
  assert.equal(axis.max, 200000);
  assert.ok(axis.ticks.every((v) => v > 0));
  assert.ok(axis.position(190.75) < axis.position(313.625));
  assert.ok(axis.position(135335.59) < 1);
  assert.equal(axis.position(0), null);
  assert.equal(axis.position(-1), null);
  assert.equal(axis.position(Infinity), null);
});

test("linear, equal, zero and invalid-only axes are finite", () => {
  const linear = createAxis([0, 190, 1000], "linear");
  assert.equal(linear.position(0), 0);
  assert.equal(createAxis([0, null, NaN, -1]), null);
  assert.ok(Number.isFinite(createAxis([1, 1]).position(1)));
  assert.ok(Number.isFinite(createAxis([0], "linear").position(0)));
  assert.equal(createAxis([0.027, 78]).min, 0.02);
});

test("missing values break lines instead of connecting or fabricating points", () => {
  const axis = createAxis([1, 5]);
  const points = [{ concurrency: 1, tps: 1 }, { concurrency: 8, tps: null }, { concurrency: 32, tps: 5 }];
  assert.deepEqual(chartSegments(points, [1, 8, 32], "tps", axis).map((s) => s.length), [1, 1]);
});

test("raw paths are scoped to benchmark artifacts", () => {
  assert.match(artifactUrl(data.rawResults[0].rawOutputPath), /^\.\/artifacts\/mysql\/raw\//);
  assert.equal(artifactUrl("benchmarks/mysql/results/../.env"), null);
  assert.equal(artifactUrl("https://unknown.example/"), null);
});

test("sparse supplement preserves actual ranges and point-level peak dates", () => {
  const fixture = structuredClone(data);
  for (const series of fixture.series) series.points = series.points.filter(p => p.concurrency !== 32);
  fixture.series[0].points.push({ concurrency:32,qps:1e9,tps:1e9,p95Ms:1,p99Ms:1,
    testedAt:"2026-10-08T09:00:00Z",sourceRole:"formal" });
  const report = projectReport(fixture);
  assert.deepEqual(report.concurrency,[1,8,16,32]);
  assert.equal(report.series.filter(s=>s.points.some(p=>p.concurrency===32)).length,1);
  assert.equal(peakPoint(report).testedAt,"2026-10-08T09:00:00Z");
  assert.equal(peakPoint(report).sourceRole,"formal");
  assert.deepEqual(chartSegments(report.series[1].points,report.concurrency,"tps",
    createAxis(report.series[1].points.map(p=>p.tps))).flat().map(p=>p.concurrency),[1,8,16]);
});

test("four conclusions derive approved 16-thread comparisons without mutating results", () => {
  const before = JSON.stringify(data);
  const conclusions = experimentConclusions(data);
  assert.deepEqual(conclusions.map(c => c.id), ["read-write", "write-policy", "buffer-pool", "hot-update"]);
  assert.equal(conclusions[0].headline, "约 140 倍");
  assert.deepEqual(conclusions[0].metrics, [["主键点查", "291,532 TPS"],
    ["同步索引更新", "2,087 TPS"], ["p99（查 / 写）", "0.22 / 43.39 ms"]]);
  assert.equal(conclusions[1].headline, "5.4 倍");
  assert.match(conclusions[1].note, /\+38.8%/);
  assert.equal(conclusions[2].headline, "+15.5%");
  assert.equal(conclusions[2].metrics[0][1], "0.47 → 0.26 ms");
  assert.equal(conclusions[3].headline, "-27.3%");
  assert.equal(conclusions[3].metrics[1][1], "0.03 → 809.57");
  assert.deepEqual(conclusions[2].stability.map(s => s.value), ["acceptable", "unstable"]);
  assert.match(conclusions[2].scope, /独立实验/);
  assert.match(conclusions[3].scope, /每组 1 次/);
  const fixture = structuredClone(data);
  fixture.series[0].points.find(p => p.concurrency === 32).tps = 1e9;
  assert.deepEqual(experimentConclusions(fixture), conclusions);
  assert.equal(JSON.stringify(data), before);
});

test("missing, failed or verification sources cannot produce a conclusion", () => {
  assert.deepEqual(experimentConclusions({}), []);
  assert.deepEqual(experimentConclusions({ ...data, formalExperiment: { purpose: "verification" } }), []);
  for (const mutate of [p => { p.tps = 0; }, p => { p.tps = null; }, p => { p.status = "failed"; },
    p => { p.sourceRole = "verification"; }, p => { p.p99Ms = null; }]) {
    const fixture = structuredClone(data);
    mutate(fixture.series[0].points.find(p => p.concurrency === 16));
    assert.ok(!experimentConclusions(fixture).some(c => c.id === "read-write"));
  }
  const fixture = structuredClone(data);
  fixture.bufferPoolExperiment.purpose = "verification";
  fixture.hotUpdateExperiment.purpose = "verification";
  assert.deepEqual(experimentConclusions(fixture).map(c => c.id), ["read-write", "write-policy"]);
  delete fixture.bufferPoolExperiment;
  delete fixture.hotUpdateExperiment;
  assert.equal(experimentConclusions(fixture).length, 2);
});

test("conclusion percentages follow changed measurements instead of assuming improvements", () => {
  const fixture = structuredClone(data);
  fixture.bufferPoolExperiment.groups[1].selected.qps = fixture.bufferPoolExperiment.groups[0].selected.qps / 2;
  fixture.hotUpdateExperiment.groups[1].metrics.tps = fixture.hotUpdateExperiment.groups[0].metrics.tps * 2;
  const conclusions = experimentConclusions(fixture);
  assert.equal(conclusions.find(c => c.id === "buffer-pool").headline, "-50%");
  assert.equal(conclusions.find(c => c.id === "hot-update").headline, "+100%");
});
