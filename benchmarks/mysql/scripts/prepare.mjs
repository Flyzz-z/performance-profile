#!/usr/bin/env node

import path from "node:path";
import {
  PATHS,
  assert,
  compose,
  composeServiceShell,
  createSysbenchArguments,
  createSysbenchShellCommand,
  ensureDirectories,
  loadBenchmarkEnv,
  mysqlQuery,
  nowIso,
  parseCliArguments,
  runProcess,
  waitForMysql,
  writeJson,
} from "./lib.mjs";

const env = loadBenchmarkEnv();
const cli = parseCliArguments(process.argv.slice(2));
if (cli["table-size"]) env.TABLE_SIZE = String(cli["table-size"]);
const secondaryIndex = cli["no-secondary-index"] !== true;
const prefix = cli["manifest-prefix"] ? String(cli["manifest-prefix"]) : "";
assert(!prefix || /^[a-zA-Z0-9_-]+$/.test(prefix), "Invalid manifest prefix");
const containerName = cli["container-name"] ? String(cli["container-name"]) : undefined;
assert(!containerName || /^[a-zA-Z0-9_-]+$/.test(containerName), "Invalid container name");
const manifestName = (name) => prefix ? `${prefix}-${name}` : name;
ensureDirectories();

console.log("Starting MySQL and waiting for health check...");
const containerId = await waitForMysql(env);

const database = env.MYSQL_DATABASE;
console.log(`Resetting database ${database}...`);
await mysqlQuery(
  env,
  [
    `DROP DATABASE IF EXISTS \`${database}\`;`,
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`,
  ].join(" "),
);

const prepareArguments = createSysbenchArguments({
  env,
  scenario: "point_select",
  command: "prepare",
  concurrency: 4,
  durationSeconds: 1,
});
prepareArguments.splice(-1, 0, `--create-secondary=${secondaryIndex ? "on" : "off"}`, "--auto-inc=on");
const prepareCommand = createSysbenchShellCommand(prepareArguments);
const prepareStartedAt = nowIso();
const prepareResult = await composeServiceShell(
  env,
  "sysbench",
  prepareCommand,
  { echo: true, containerName },
);
const prepareFinishedAt = nowIso();
assert(
  prepareResult.code === 0,
  prepareResult.stderr.trim() || "sysbench data preparation failed",
);

const tableCount = Number(env.TABLE_COUNT);
const tableSize = Number(env.TABLE_SIZE);
const countExpression = Array.from(
  { length: tableCount },
  (_, index) =>
    `(SELECT COUNT(*) FROM \`${database}\`.sbtest${index + 1})`,
).join(" + ");
const actualRows = Number(
  await mysqlQuery(env, `SELECT ${countExpression};`),
);
const expectedRows = tableCount * tableSize;
assert(
  actualRows === expectedRows,
  `Expected ${expectedRows} rows but found ${actualRows}`,
);

const tables = [];
for (let index = 1; index <= tableCount; index++) {
  const name = `sbtest${index}`;
  await mysqlQuery(env, `ANALYZE TABLE \`${database}\`.${name};`);
  const columns = await mysqlQuery(env, `SELECT COLUMN_NAME,COLUMN_TYPE,COLUMN_KEY,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${database}' AND TABLE_NAME='${name}' ORDER BY ORDINAL_POSITION;`);
  const indexes = await mysqlQuery(env, `SELECT INDEX_NAME,COLUMN_NAME,NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='${database}' AND TABLE_NAME='${name}' ORDER BY INDEX_NAME,SEQ_IN_INDEX;`);
  const [dataBytes, indexBytes] = (await mysqlQuery(env, `SELECT DATA_LENGTH,INDEX_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA='${database}' AND TABLE_NAME='${name}';`)).split(/\s+/).map(Number);
  tables.push({ name, columns: columns.split("\n").map(row => row.split("\t")), indexes: indexes.split("\n").map(row => row.split("\t")), dataBytes, indexBytes });
  assert(indexes.includes("PRIMARY\tid\t0") && (indexes.includes("\tk\t1") === secondaryIndex), `Unexpected indexes for ${name}`);
  assert(columns.includes("auto_increment"), `Missing auto_increment for ${name}`);
}

const versionResult = await runProcess("docker", [
  "version",
  "--format",
  "{{.Server.Version}}|{{.Server.Os}}/{{.Server.Arch}}",
]);
const infoResult = await runProcess("docker", [
  "info",
  "--format",
  "{{.OperatingSystem}}|{{.KernelVersion}}|{{.NCPU}}|{{.MemTotal}}|{{.Driver}}",
]);
const imageResult = await runProcess("docker", [
  "image",
  "inspect",
  env.MYSQL_IMAGE,
  "--format",
  "{{.Id}}|{{.Os}}/{{.Architecture}}|{{json .RepoDigests}}",
]);
const hostResult = await runProcess("sysctl", [
  "-n",
  "hw.model",
  "hw.ncpu",
  "hw.memsize",
]);
const architectureResult = await runProcess("uname", ["-m"]);
const composeVersionResult = await compose(env, ["version", "--short"]);
const sysbenchVersionResult = await composeServiceShell(
  env,
  "sysbench",
  "sysbench --version",
  { echo: false },
);
const mysqlVersion = await mysqlQuery(env, "SELECT VERSION();");
const mysqlConfiguration = await mysqlQuery(
  env,
  [
    "SELECT",
    "@@innodb_buffer_pool_size,",
    "@@max_connections,",
    "@@innodb_flush_log_at_trx_commit,",
    "@@sync_binlog,",
    "@@log_bin,",
    "@@innodb_flush_log_at_timeout,",
    "@@transaction_isolation;",
  ].join(" "),
);
const [
  bufferPoolBytes,
  maxConnections,
  flushLogAtTransactionCommit,
  syncBinlog,
  logBinEnabled,
  flushLogAtTimeout,
  transactionIsolation,
] = mysqlConfiguration.split(/\t/);

const imageLine = imageResult.stdout.trim();
const [imageId, imagePlatform, repositoryDigestsJson] = imageLine.split("|");
const hostLine = hostResult.stdout.trim();
const [hostModel, hostCpuCount, hostMemoryBytes] = hostLine.split(/\s+/);

const environmentManifest = {
  schemaVersion: 1,
  generatedAt: nowIso(),
  environmentLabel: "local Docker benchmark",
  exploratory: true,
  container: {
    mysqlImage: env.MYSQL_IMAGE,
    imageId,
    imagePlatform,
    repositoryDigests: JSON.parse(repositoryDigestsJson),
    platform: env.MYSQL_PLATFORM,
    mysqlCpuLimit: Number(env.MYSQL_CPUS),
    mysqlMemoryLimit: env.MYSQL_MEMORY,
    loadGeneratorCpuLimit: Number(env.LOADGEN_CPUS),
    loadGeneratorMemoryLimit: env.LOADGEN_MEMORY,
    containerId,
  },
  mysql: {
    version: mysqlVersion,
    bufferPoolBytes: Number(bufferPoolBytes),
    maxConnections: Number(maxConnections),
    flushLogAtTransactionCommit: Number(flushLogAtTransactionCommit),
    syncBinlog: Number(syncBinlog),
    logBinEnabled: Number(logBinEnabled) === 1,
    flushLogAtTimeout: Number(flushLogAtTimeout),
    transactionIsolation,
  },
  loadGenerator: {
    sysbenchVersion: sysbenchVersionResult.stdout.trim(),
    image: env.LOADGEN_IMAGE,
  },
  runtime: {
    dockerServer: versionResult.stdout.trim(),
    dockerInfo: infoResult.stdout.trim(),
    composeVersion: composeVersionResult.stdout.trim(),
  },
  host: {
    architecture: architectureResult.stdout.trim(),
    model: hostModel,
    cpuCount: Number(hostCpuCount),
    memoryBytes: Number(hostMemoryBytes),
  },
  limitations: [
    "Docker on macOS runs Linux containers inside a virtual machine.",
    "Results include OrbStack virtualization and local SSD overhead.",
    "Values are exploratory and must not be treated as production capacity.",
  ],
};

const datasetManifest = {
  schemaVersion: 1,
  generatedAt: nowIso(),
  database,
  tableCount,
  tableSize,
  expectedRows,
  actualRows,
  secondaryIndex,
  tables,
  dataBytes: tables.reduce((sum, table) => sum + table.dataBytes, 0),
  indexBytes: tables.reduce((sum, table) => sum + table.indexBytes, 0),
  pageBytes: Number(await mysqlQuery(env, "SELECT @@innodb_page_size;")),
  sqlMode: await mysqlQuery(env, "SELECT @@sql_mode;"),
  status: "ready",
  command: prepareCommand.replace(env.MYSQL_ROOT_PASSWORD, "***"),
  startedAt: prepareStartedAt,
  finishedAt: prepareFinishedAt,
};

writeJson(path.join(PATHS.resultsDir, manifestName("environment.json")), environmentManifest);
writeJson(path.join(PATHS.resultsDir, manifestName("dataset.json")), datasetManifest);

console.log(`Prepared ${actualRows} rows across ${tableCount} tables.`);
console.log(`Environment manifest: ${path.join(PATHS.resultsDir, manifestName("environment.json"))}`);
