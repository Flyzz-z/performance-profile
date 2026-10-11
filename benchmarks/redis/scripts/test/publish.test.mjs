import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { observationProblems, shouldRunThird, summarizeCombination, measureRepeats, validateReportData, buildReportData } from "../summary.mjs";
import { publishRedisReport, recomputeRun } from "../collect.mjs";
import { backgroundScript, parseBackgroundCount } from "../background.mjs";
import { luaForDataset, luaForBigHash, expectedDbSize } from "../prepare.mjs";
import { buildMatrix, STRUCTURES, BLOCKING } from "../protocol.mjs";
import { makeSummary, writeRun } from "./fixtures.mjs";

const temp = () => mkdtempSync(path.join(os.tmpdir(), "redis-test-"));
const comboOf = id => buildMatrix().find(item => item.id === id);
const run = (ops, p99) => ({ metrics: { opsPerSec: ops, p99Ms: p99 } });

test("a third run is required only when ops/s or p99 differ by more than 30%", () => {
  assert.equal(shouldRunThird([run(100, 1), run(120, 1.2)]), false);
  assert.equal(shouldRunThird([run(100, 1), run(60, 1)]), true);
  assert.equal(shouldRunThird([run(100, 1), run(100, 2)]), true);
  assert.equal(shouldRunThird([run(100, 1)]), false);
});

test("repeat protocol keeps every observation and adds the third only when needed", async () => {
  const sequence = [run(100, 1), run(50, 1), run(95, 1)];
  let index = 0;
  let thirds = 0;
  const unstable = await measureRepeats({ measure: async () => sequence[index++], onThird: () => thirds++ });
  assert.equal(unstable.length, 3);
  assert.equal(thirds, 1);
  index = 0;
  const stable = await measureRepeats({ measure: async () => [run(100, 1), run(101, 1.01)][index++] });
  assert.equal(stable.length, 2);
});

test("two observations use the mean and three use the median", () => {
  const metrics = (ops, p99) => ({ metrics: { opsPerSec: ops, p99Ms: p99, p50Ms: 0.1, p95Ms: 0.3, p999Ms: 2 }, redis: {}, resources: {} });
  const two = summarizeCombination([metrics(100, 1), metrics(110, 1.2)]);
  assert.equal(two.selected.opsPerSec, 105);
  const three = summarizeCombination([metrics(100, 1), metrics(50, 1), metrics(90, 1)]);
  assert.equal(three.selected.opsPerSec, 90);
  assert.equal(three.attempts, 3);
  assert.equal(three.stability, "unstable");
});

test("loadgen-bound is raised when any measured observation is near the loadgen quota", () => {
  const dir = temp();
  const combo = comboOf("commands-get");
  const bound = summarizeCombination([writeRun(dir, combo, 1), writeRun(dir, combo, 2, { loadgenRate: 3.8 })]);
  assert.equal(bound.loadgenBound, true);
  assert.equal(summarizeCombination([writeRun(dir, combo, 1)]).loadgenBound, false);
});

test("observation validation enforces errors, misses, evictions and background activity", () => {
  const dir = temp();
  const base = id => writeRun(dir, comboOf(id), 1);
  assert.deepEqual(observationProblems(base("commands-get"), comboOf("commands-get")), []);
  const withErrors = { ...base("commands-get"), redis: { ...base("commands-get").redis, errorReplies: 3 } };
  assert.match(observationProblems(withErrors, comboOf("commands-get")).join(), /unexpected error replies/);
  const missed = { ...base("commands-get"), redis: { ...base("commands-get").redis, keyspaceMisses: 5 } };
  assert.match(observationProblems(missed, comboOf("commands-get")).join(), /misses/);
  const noEviction = { ...base("memory-lru-uniform"), redis: { ...base("memory-lru-uniform").redis, evictedKeys: 0 } };
  assert.match(observationProblems(noEviction, comboOf("memory-lru-uniform")).join(), /no evictions/);
  const fits = { ...base("memory-fits"), redis: { ...base("memory-fits").redis, evictedKeys: 7 } };
  assert.match(observationProblems(fits, comboOf("memory-fits")).join(), /unexpected evictions/);
  assert.deepEqual(observationProblems(base("memory-noeviction"), comboOf("memory-noeviction")), []);
  const silent = { ...base("blocking-keys"), background: { executions: 0 } };
  assert.match(observationProblems(silent, comboOf("blocking-keys")).join(), /background/);
  const nonOom = { ...base("memory-noeviction"), redis: { ...base("memory-noeviction").redis, errorReplies: 700 } };
  assert.match(observationProblems(nonOom, comboOf("memory-noeviction")).join(), /unexpected error replies: 200/);
});

test("recomputation reads raw evidence rather than trusting stored summaries", () => {
  const dir = temp();
  const combo = comboOf("commands-get");
  const stored = writeRun(dir, combo, 1);
  const tampered = { ...stored, metrics: { opsPerSec: 999999, p99Ms: 0.0001 } };
  const recomputed = recomputeRun(tampered, dir);
  assert.equal(recomputed.metrics.opsPerSec, 90000);
  assert.equal(recomputed.metrics.p99Ms, 0.6);
  assert.throws(() => recomputeRun({ ...stored, infoPath: "missing.json" }, dir), /Raw evidence not found/);
  assert.throws(() => recomputeRun({ ...stored, infoPath: "../../etc/hosts" }, dir), /Raw evidence not found/);
});

test("a complete formal summary publishes atomically and keeps a backup of the previous report", () => {
  const resultsDir = temp();
  const siteDataDir = temp();
  const backupDir = temp();
  const summary = makeSummary(resultsDir);
  const report = publishRedisReport(summary, { siteDataDir, backupDir, resultsDir });
  assert.equal(report.scenarios.length, 7);
  assert.equal(report.scenarios.flatMap(item => item.points).length, 48);
  const first = readFileSync(path.join(siteDataDir, "redis.json"), "utf8");
  publishRedisReport(summary, { siteDataDir, backupDir, resultsDir });
  assert.equal(readdirSync(backupDir).length, 1);
  assert.equal(readFileSync(path.join(backupDir, readdirSync(backupDir)[0]), "utf8"), first);
  assert.equal(readdirSync(siteDataDir).filter(name => name.endsWith(".tmp")).length, 0);
});

test("publication is refused and leaves the data file untouched for incomplete or unsafe evidence", () => {
  const resultsDir = temp();
  const siteDataDir = temp();
  const target = path.join(siteDataDir, "redis.json");
  writeFileSync(target, "ORIGINAL");
  const options = { siteDataDir, backupDir: temp(), resultsDir };
  const summary = makeSummary(resultsDir);
  const refuse = (value, pattern) => {
    assert.throws(() => publishRedisReport(value, options), pattern);
    assert.equal(readFileSync(target, "utf8"), "ORIGINAL");
  };
  refuse({ ...summary, purpose: "verification" }, /not formal/);
  refuse({ ...summary, sourceRole: "verification" }, /verification/);
  refuse({ ...summary, root: "verification/x" }, /verification/);
  refuse({ ...summary, restorationVerified: false }, /cleanup/);
  refuse({ ...summary, environment: { ...summary.environment, exploratory: true } }, /exploratory/);
  const extraRun = makeSummary(resultsDir, { perCombo: () => ({}) });
  extraRun.results[0].runs.push(writeRun(resultsDir, extraRun.results[0].combo, 3));
  refuse(extraRun, /unneeded third run/);
  const insufficient = makeSummary(resultsDir);
  const brokenPath = path.join(resultsDir, insufficient.results[5].runs[0].resourcePath);
  const record = JSON.parse(readFileSync(brokenPath, "utf8"));
  writeFileSync(brokenPath, JSON.stringify({ ...record, samples: record.samples.slice(0, 4) }));
  refuse(insufficient, /resource evidence insufficient/);
});

test("unstable pairs without a third run are refused", () => {
  const resultsDir = temp();
  const summary = makeSummary(resultsDir, { perCombo: combo => ({ opsPerSec: 90000 }) });
  summary.results[0].runs[1] = writeRun(resultsDir, summary.results[0].combo, 2, { opsPerSec: 30000 });
  assert.throws(() => publishRedisReport(summary, { siteDataDir: temp(), backupDir: temp(), resultsDir }), /missing third run for commands-get/);
});

test("validated report data excludes verification evidence", () => {
  const resultsDir = temp();
  const summary = makeSummary(resultsDir);
  const report = buildReportData({ ...summary, results: summary.results.map(item => ({ combo: item.combo, runs: item.runs.map(entry => recomputeRun(entry, resultsDir)) })) });
  assert.deepEqual(validateReportData(report), []);
  report.scenarios[0].points[0].runs[0].rawOutputPath = "verification/x/run1.txt";
  assert.match(validateReportData(report).join(), /verification evidence/);
});

test("background scripts stop on a file, report execution counts and pace each command", () => {
  const hgetall = backgroundScript(comboOf("blocking-hgetall").background);
  assert.match(hgetall, /HGETALL bighash/);
  assert.match(hgetall, /sleep 0\.2/);
  assert.match(hgetall, /bg-stop/);
  assert.match(backgroundScript(comboOf("blocking-keys").background), /KEYS 'nomatch:\*'/);
  const scan = backgroundScript(comboOf("blocking-scan").background);
  assert.match(scan, /--scan --pattern 'nomatch:\*' --count 100/);
  assert.doesNotMatch(scan, /sleep/);
  assert.equal(parseBackgroundCount("count=42\n"), 42);
  assert.throws(() => parseBackgroundCount(""), /execution count/);
  assert.throws(() => backgroundScript({ command: "FLUSHALL" }), /Unsupported/);
});

test("Lua loaders use the same key naming as memtier and the confirmed structure sizes", () => {
  assert.match(luaForDataset(STRUCTURES.hashes), /'memtier-'\.\.i/);
  assert.match(luaForDataset(STRUCTURES.hashes), /for i=1,100000/);
  assert.match(luaForDataset(STRUCTURES.lists), /RPUSH','memtier-'/);
  assert.match(luaForDataset(STRUCTURES.zsets), /ZADD','memtier-'/);
  assert.match(luaForDataset(STRUCTURES.counters), /SET','memtier-'/);
  assert.match(luaForBigHash(BLOCKING.bigHash), /for c=0,99/);
  assert.throws(() => luaForDataset({ kind: "strings" }), /No Lua loader/);
  assert.throws(() => luaForBigHash({ key: "x", fields: 1500, valueBytes: 1 }), /multiple of 1000/);
});

test("expected key counts include the big hash and skip over-capacity memory datasets", () => {
  assert.equal(expectedDbSize(comboOf("commands-get").dataset, comboOf("commands-get")), 1_000_000);
  assert.equal(expectedDbSize(comboOf("blocking-scan").dataset, comboOf("blocking-scan")), 1_000_001);
  assert.equal(expectedDbSize(comboOf("memory-fits").dataset, comboOf("memory-fits")), 500_000);
  assert.equal(expectedDbSize(comboOf("memory-lru-uniform").dataset, comboOf("memory-lru-uniform")), null);
});

test("a batch publishes only complete scenario groups and records what is still pending", () => {
  const resultsDir = temp();
  const siteDataDir = temp();
  const full = makeSummary(resultsDir);
  const wanted = ["pipeline", "connections", "memory", "blocking"];
  const batch = { ...full, results: full.results.filter(item => wanted.includes(item.combo.group)) };
  const report = publishRedisReport(batch, { siteDataDir, backupDir: temp(), resultsDir });
  assert.deepEqual(report.scenarios.map(item => item.id), ["pipeline", "connections", "memory", "blocking"].sort((a, b) =>
    ["commands", "pipeline", "value-size", "persistence", "connections", "memory", "blocking"].indexOf(a) - ["commands", "pipeline", "value-size", "persistence", "connections", "memory", "blocking"].indexOf(b)));
  assert.deepEqual(report.coverage.pending, ["commands", "value-size", "persistence"]);
  assert.deepEqual(report.coverage.incomplete, []);
  assert.equal(report.scenarios.flatMap(item => item.points).length, 20);
});

test("a partially measured group is left out and reported as incomplete", () => {
  const resultsDir = temp();
  const full = makeSummary(resultsDir);
  const results = full.results.filter(item => !(item.combo.group === "persistence" && item.combo.id.endsWith("aof-always-c64")));
  const report = publishRedisReport({ ...full, results }, { siteDataDir: temp(), backupDir: temp(), resultsDir });
  assert.ok(!report.coverage.groups.includes("persistence"));
  assert.deepEqual(report.coverage.incomplete, ["persistence"]);
  assert.equal(report.coverage.groups.length, 6);
  assert.ok(report.scenarios.every(item => item.points.every(point => point.runs.length >= 2)));
});

test("publication is refused when no scenario group is complete", () => {
  const resultsDir = temp();
  const full = makeSummary(resultsDir);
  const partial = { ...full, results: full.results.filter(item => item.combo.group === "pipeline").slice(0, 3) };
  assert.throws(() => publishRedisReport(partial, { siteDataDir: temp(), backupDir: temp(), resultsDir }), /covers no scenario group/);
});

test("validation still rejects a point missing from a group that the report claims to cover", () => {
  const resultsDir = temp();
  const full = makeSummary(resultsDir);
  const report = buildReportData({ ...full, results: full.results.map(item => ({ combo: item.combo, runs: item.runs.map(entry => recomputeRun(entry, resultsDir)) })) });
  report.scenarios.find(item => item.id === "pipeline").points.pop();
  assert.match(validateReportData(report).join(), /missing combination pipeline-set-d256/);
});
