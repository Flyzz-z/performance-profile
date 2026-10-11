import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { assert, readJson } from "../../mysql/scripts/lib.mjs";
import { PATHS } from "./lib.mjs";
import { ENVIRONMENT, buildMatrix } from "./protocol.mjs";
import { parseMemtierJson } from "./memtier.mjs";
import { diffSnapshots } from "./redis-info.mjs";
import { summarizeResources } from "./resources.mjs";
import { buildReportData, validateReportData } from "./summary.mjs";

export function assertPublishable(summary) {
  const problems = [];
  if (summary.purpose !== "formal") problems.push("summary is not formal");
  if (summary.sourceRole === "verification" || String(summary.root ?? "").includes("verification")) problems.push("summary comes from verification");
  if (summary.restorationVerified !== true) problems.push("container cleanup was not verified");
  if (!summary.environment || summary.environment.exploratory === true) problems.push("environment is missing or exploratory");
  assert(problems.length === 0, `Refusing to publish: ${problems.join("; ")}`);
}

export function recomputeRun(run, resultsDir = PATHS.resultsDir) {
  const read = relative => {
    assert(typeof relative === "string" && relative.length > 0, "Run is missing a raw evidence path");
    const file = path.resolve(resultsDir, relative);
    assert(file.startsWith(path.resolve(resultsDir)) && existsSync(file), `Raw evidence not found: ${relative}`);
    return readFileSync(file, "utf8");
  };
  const info = JSON.parse(read(run.infoPath));
  const resourceRecord = JSON.parse(read(run.resourcePath));
  const previous = resourceRecord.summary;
  return {
    ...run,
    metrics: parseMemtierJson(read(run.memtierJsonPath)),
    redis: diffSnapshots(info.before, info.after, { redisCpus: ENVIRONMENT.redisCpus }),
    resources: summarizeResources(resourceRecord.samples, previous.limits, previous.expectedSeconds, previous.errors, resourceRecord.intervalMs),
  };
}

export function publishRedisReport(summary, { siteDataDir = PATHS.siteDataDir, backupDir = path.join(PATHS.resultsDir, "report-backups"),
  resultsDir = PATHS.resultsDir, matrix = buildMatrix() } = {}) {
  assertPublishable(summary);
  const report = buildReportData({
    runGroup: summary.runGroup, testedAt: summary.testedAt, environment: summary.environment,
    protocol: summary.protocol, datasetPath: summary.datasetPath,
    results: summary.results.map(result => ({ combo: result.combo, runs: result.runs.map(run => recomputeRun(run, resultsDir)) })),
  });
  const problems = validateReportData(report, matrix);
  assert(problems.length === 0, `Refusing to publish: ${problems.slice(0, 8).join("; ")}${problems.length > 8 ? ` (+${problems.length - 8} more)` : ""}`);
  const target = path.join(siteDataDir, "redis.json");
  mkdirSync(siteDataDir, { recursive: true });
  if (existsSync(target)) {
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(target, path.join(backupDir, `redis-${new Date().toISOString().replace(/[^0-9]/g, "")}.json`));
  }
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
  return report;
}

export function loadSummary(file) {
  return readJson(path.resolve(file));
}

export function readSummaryText(file) {
  return readFileSync(path.resolve(file), "utf8");
}
