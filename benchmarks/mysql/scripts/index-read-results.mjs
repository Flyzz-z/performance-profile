import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { PATHS, assert, readJson, parseSysbenchOutput } from "./lib.mjs";
import { summarizeCombination, shouldRunThirdRun, summarizeRunResources } from "./analytics.mjs";
import { assertLoggingMatch, LOGGING_MODES } from "./logging.mjs";
import { summarizeResources } from "./resources.mjs";

export const INDEX_READ_PROTOCOL = { concurrency: [1, 8, 16], warmupSeconds: 30, durationSeconds: 90, repeats: 2, thresholdPercent: 30 };
export const INDEX_READ_GROUPS = ["indexed", "table-scan"];
export const INDEX_READ_SQL = "SELECT c FROM sbtestN WHERE k=?";
export const INDEX_READ_SCRIPT = "/workspace/scripts/index-read.lua";
export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const APPROVED_SCRIPT_SHA256 = "f0485b75696cb76cf578535d077ef91077d4a75203a5e735bc862f26d95f7f1e";

export function validateIndexEnvironment(environment, baseline) {
  const c = environment.container;
  assert(c?.mysqlCpuLimit === 8 && c.loadGeneratorCpuLimit === 4 && c.mysqlMemoryLimit === "6g"
    && c.loadGeneratorMemoryLimit === "1g" && c.platform === "linux/arm64" && c.imagePlatform === "linux/arm64", "Index read resource/platform mismatch");
  assert(environment.mysql?.bufferPoolBytes === 3221225472, "Index read buffer pool mismatch");
  assertLoggingMatch(environment.mysql, LOGGING_MODES.update_index);
  assert(c.imageId === baseline.container.imageId && c.mysqlImage === baseline.container.mysqlImage
    && environment.mysql.version === baseline.mysql.version
    && environment.loadGenerator.imageId === baseline.loadGenerator.imageId
    && environment.loadGenerator.image === baseline.loadGenerator.image
    && environment.loadGenerator.imagePlatform === "linux/arm64"
    && environment.loadGenerator.sysbenchVersion === baseline.loadGenerator.sysbenchVersion, "Index read software differs from confirmed baseline");
}

export function validateIndexDataset(dataset, group) {
  assert(dataset.tableCount === 10 && dataset.tableSize === 100000 && dataset.actualRows === 1000000
    && dataset.secondaryIndex === (group === "indexed") && dataset.tables?.length === 10, "Index read dataset size mismatch");
  for (const [i, table] of dataset.tables.entries()) {
    assert(table.name === `sbtest${i + 1}` && table.rows === 100000 && table.distinctK === 100000
      && table.minK === 1 && table.maxK === 100000 && table.kEqualsId === 100000 && /^[a-f0-9]{64}$/.test(table.rowDigest), "Index read query keys/data evidence mismatch");
    assert(table.columns?.length === 4 && table.columns[0][0] === "id" && table.columns[0][3] === "auto_increment"
      && table.columns.map(c => c[0]).join(",") === "id,k,c,pad", "Index read columns mismatch");
    assert(table.indexes.some(index => isDeepStrictEqual(index, ["PRIMARY", "id", "0"])), "Index read primary key missing");
    assert(isDeepStrictEqual(table.indexes, group === "indexed" ? [[`k_${i + 1}`, "k", "1"], ["PRIMARY", "id", "0"]] : [["PRIMARY", "id", "0"]]), "Index read secondary index mismatch");
  }
}

export function validatePairedDatasets(indexed, scan) {
  validateIndexDataset(indexed, "indexed"); validateIndexDataset(scan, "table-scan");
  assert(indexed.database !== scan.database, "Groups must use separate owned databases");
  for (const [i, a] of indexed.tables.entries()) {
    const b = scan.tables[i];
    // COLUMN_KEY is the one expected column metadata difference.
    assert(isDeepStrictEqual(a.columns.map(c => [c[0], c[1], c[3]]), b.columns.map(c => [c[0], c[1], c[3]]))
      && a.rowDigest === b.rowDigest, "Paired logical data differ");
  }
}

function findPlanTable(plan, name) {
  if (!plan || typeof plan !== "object") return null;
  if (plan.table_name === name) return plan;
  for (const value of Object.values(plan)) { const found = findPlanTable(value, name); if (found) return found; }
  return null;
}

export function validateIndexPlans(evidence, group) {
  assert(evidence.group === group && evidence.sql === INDEX_READ_SQL && evidence.samples?.length === 50, "Index read plan sample coverage mismatch");
  const identities = new Set();
  for (const sample of evidence.samples) {
    assert(/^sbtest([1-9]|10)$/.test(sample.table) && Number.isInteger(sample.key) && sample.key >= 1 && sample.key <= 100000
      && typeof sample.resultHex === "string" && /^[a-fA-F0-9]+$/.test(sample.resultHex), "Invalid plan/result evidence");
    identities.add(`${sample.table}:${sample.key}`);
    const table = findPlanTable(sample.plan, sample.table);
    assert(table, "Missing plan table");
    assert(group === "indexed" ? table.access_type === "ref" && table.key === `k_${sample.table.slice(6)}`
      && isDeepStrictEqual(table.used_key_parts, ["k"]) && table.using_index !== true
      : table.access_type === "ALL" && !table.key, "Unexpected indexed read access path");
  }
  assert(identities.size === 50, "Duplicate plan samples");
  for (let i = 1; i <= 10; i++) {
    const samples = evidence.samples.filter(sample => sample.table === `sbtest${i}`);
    assert(samples.length === 5 && [1, 50000, 100000].every(key => samples.some(s => s.key === key)), "Missing boundary plan samples");
  }
}

const defaultReader = {
  json: file => readJson(path.resolve(PATHS.projectRoot, file)),
  text: file => readFileSync(path.resolve(PATHS.projectRoot, file), "utf8"),
};

export function validateIndexExperiment(experiment, reader = defaultReader) {
  assert(experiment.schemaVersion === 1 && experiment.purpose === "formal" && experiment.restorationVerified === true
    && isDeepStrictEqual(experiment.protocol, INDEX_READ_PROTOCOL), "Index read formal protocol/restoration mismatch");
  assert(/^[a-zA-Z0-9_-]{1,80}$/.test(experiment.runGroup) && experiment.groups?.length === 2, "Index read groups missing");
  const read = (type, file) => {
    assert(typeof file === "string" && file.startsWith("benchmarks/mysql/results/") && !file.split(/[\\/]/).some(p => ["..", "verification"].includes(p)), "Invalid formal evidence path");
    assert(path.resolve(PATHS.projectRoot, file).startsWith(`${PATHS.resultsDir}${path.sep}`), "Evidence outside result directory");
    return reader[type](file);
  };
  const workload = experiment.workload;
  assert(workload.sql === INDEX_READ_SQL && workload.script === INDEX_READ_SCRIPT && workload.scriptSha256 === APPROVED_SCRIPT_SHA256
    && sha256(read("text", workload.scriptSnapshotPath)) === APPROVED_SCRIPT_SHA256
    && workload.seed === 42 && workload.returnedRows === 1 && workload.queriesPerEvent === 1, "Unapproved index read workload/script");
  const baseline = read("json", experiment.baselineEnvironmentPath);
  const restoration = read("json", experiment.restorationPath);
  assert(restoration.runGroup === experiment.runGroup && restoration.ownedLoadsStopped === true
    && restoration.bufferPoolBytes === 3221225472, "Invalid end-state evidence");
  assertLoggingMatch(restoration.logging, LOGGING_MODES.update_index);
  assert(isDeepStrictEqual(read("json", restoration.originalBeforePath), read("json", restoration.originalAfterPath)), "Original database changed");
  const datasets = [];
  const plans = [];
  const runIds = new Set();
  const rawPaths = new Set();
  for (const [i, group] of experiment.groups.entries()) {
    assert(group.id === INDEX_READ_GROUPS[i] && group.runGroup === experiment.runGroup, "Mixed index read groups");
    validateIndexEnvironment(group.environment, baseline);
    assert(isDeepStrictEqual(read("json", group.environmentPath), group.environment), "Environment manifest mismatch");
    const before = read("json", group.datasetPath), after = read("json", group.finalDatasetPath);
    assert(before.database === group.database && isDeepStrictEqual(before, after), "Frozen dataset changed");
    validateIndexDataset(before, group.id); datasets.push(before);
    const startPlans = read("json", group.plansPath), endPlans = read("json", group.finalPlansPath);
    validateIndexPlans(startPlans, group.id); validateIndexPlans(endPlans, group.id);
    assert(startPlans.database === group.database && endPlans.database === group.database
      && isDeepStrictEqual(startPlans.samples.map(s => [s.table,s.key,s.resultHex]), endPlans.samples.map(s => [s.table,s.key,s.resultHex])), "Query results changed");
    plans.push(startPlans);
    assert(Array.isArray(group.runs) && group.runs.length >= 9 && group.runs.length <= 12, "Incomplete index read repetitions");
    for (const run of group.runs) {
      assert(run.runGroup === experiment.runGroup && run.group === group.id && run.exitCode === 0
        && ["warmup", "measured"].includes(run.kind) && INDEX_READ_PROTOCOL.concurrency.includes(run.concurrency), "Invalid run identity");
      assert(!runIds.has(run.runId), "Duplicate run id"); runIds.add(run.runId);
      const seconds = run.kind === "warmup" ? 30 : 90;
      assert(Number.isFinite(Date.parse(run.startedAt)) && Number.isFinite(Date.parse(run.finishedAt))
        && (Date.parse(run.finishedAt)-Date.parse(run.startedAt))/1000 >= seconds*.95, "Invalid run timestamps");
      assert(!rawPaths.has(run.rawOutputPath), "Reused raw observation"); rawPaths.add(run.rawOutputPath);
      const args = run.arguments;
      for (const arg of [INDEX_READ_SCRIPT,"--tables=10","--table-size=100000",`--threads=${run.concurrency}`,`--time=${seconds}`,
        `--mysql-db=${group.database}`,"--rand-type=uniform","--rand-seed=42","--percentile=99","--histogram=on","run"]) {
        assert(args?.filter(a => a === arg).length === 1, `Missing workload argument ${arg}`);
      }
      for (const key of ["tables","table-size","threads","time","mysql-db","rand-type","rand-seed","percentile","histogram"]) {
        assert(args.filter(a => a.startsWith(`--${key}=`)).length === 1, "Duplicate workload option");
      }
      const raw = read("text", run.rawOutputPath), metrics = parseSysbenchOutput(raw);
      const validated = [...raw.matchAll(/INDEX_READ_VALIDATED thread=(\d+) events=(\d+)/g)];
      assert(validated.length === run.concurrency && new Set(validated.map(m => m[1])).size === run.concurrency
        && validated.reduce((sum,m) => sum + Number(m[2]),0) === metrics.transactions
        && raw.includes(`INDEX_READ_SQL=${INDEX_READ_SQL}`) && raw.includes("INDEX_READ_RESULT=one-row;payload=c;prepared=true"), "Missing event result validation");
      assert(metrics.transactions > 0 && metrics.queries === metrics.transactions && metrics.errors === 0 && metrics.reconnects === 0
        && isDeepStrictEqual(metrics, run.metrics), "Invalid raw read metrics");
      const elapsed = Number(raw.match(/total time:\s*([\d.]+)s/)?.[1]);
      assert(elapsed >= seconds * .95 && elapsed <= seconds + 10 && Number(raw.match(/Number of threads:\s*(\d+)/)?.[1]) === run.concurrency, "Incomplete raw measured duration/concurrency");
      validateIndexEnvironment(read("json", run.environmentPath), baseline);
      if (run.kind === "measured") {
        const capture = read("json", run.resourcePath), limits = capture.summary.limits;
        assert(capture.intervalMs === 5000 && limits.mysql.cpus === 8 && limits.loadgen.cpus === 4
          && limits.mysql.memoryBytes === 6 * 1024 ** 3 && limits.loadgen.memoryBytes === 1024 ** 3, "Sampling quotas mismatch");
        assert(capture.guardChecks?.length >= 8 && capture.guardChecks.every(check => check.outsiders === 0), "Missing workload isolation evidence");
        assert(capture.samples.every(sample => ["mysql","loadgen"].every(name => sample[name].timeMs >= Date.parse(run.startedAt)-1000
          && sample[name].timeMs <= Date.parse(run.finishedAt)+1000)), "Resource samples outside measured window");
        const resources = summarizeResources(capture.samples, limits, 90, capture.summary.errors, capture.intervalMs);
        assert(resources.valid && isDeepStrictEqual(resources,capture.summary), "Insufficient or altered resource evidence");
        run.resources = resources;
      }
    }
    group.points = INDEX_READ_PROTOCOL.concurrency.map(concurrency => {
      const warmups = group.runs.filter(r => r.concurrency === concurrency && r.kind === "warmup");
      const runs = group.runs.filter(r => r.concurrency === concurrency && r.kind === "measured").sort((a,b) => a.repeat-b.repeat);
      assert(warmups.length === 1 && warmups[0].repeat === 0 && runs.length === (shouldRunThirdRun(runs,30) ? 3 : 2)
        && runs.every((r,i) => r.repeat === i+1), "Repeat or adaptive measurement mismatch");
      const summary = summarizeCombination(runs);
      return { concurrency, ...summary.selected, attempts: summary.attempts, stability: summary.stability, stats: summary.stats,
        resources: summarizeRunResources(runs), runs };
    });
  }
  validatePairedDatasets(...datasets);
  assert(isDeepStrictEqual(plans[0].samples.map(s=>[s.table,s.key,s.resultHex]),plans[1].samples.map(s=>[s.table,s.key,s.resultHex])), "Paired SELECT payloads differ");
  return experiment;
}

export function publishIndexExperiment(experiment, { reportPath = path.join(PATHS.siteDataDir,"mysql.json"), reader = defaultReader, beforeReplace, backupPath } = {}) {
  validateIndexExperiment(experiment,reader);
  const original = readFileSync(reportPath,"utf8"), data = JSON.parse(original);
  const merged = { ...data, indexReadExperiment: experiment };
  const { indexReadExperiment: oldExperiment, ...oldRest } = data;
  const { indexReadExperiment: newExperiment, ...newRest } = merged;
  assert(isDeepStrictEqual(oldRest,newRest),"Unrelated report fields changed");
  const backup = backupPath ?? path.join(PATHS.resultsDir,"verification/report-backups",`${experiment.runGroup}-index-read-backup.json`);
  mkdirSync(path.dirname(backup),{recursive:true});
  writeFileSync(backup,original,{flag:"wx"});
  const temporary = `${reportPath}.${experiment.runGroup}.tmp`;
  writeFileSync(temporary,`${JSON.stringify(merged,null,2)}\n`,{flag:"wx"});
  beforeReplace?.();
  assert(readFileSync(reportPath,"utf8") === original,"Report changed concurrently; publication stopped");
  renameSync(temporary,reportPath);
  return merged;
}
