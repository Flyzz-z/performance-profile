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
  runProcess,
  waitForMysql,
  writeJson,
} from "./lib.mjs";

const env = loadBenchmarkEnv();
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
const prepareCommand = createSysbenchShellCommand(prepareArguments);
const prepareStartedAt = nowIso();
const prepareResult = await composeServiceShell(
  env,
  "sysbench",
  prepareCommand,
  { echo: true },
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
    "@@transaction_isolation;",
  ].join(" "),
);
const [
  bufferPoolBytes,
  maxConnections,
  flushLogAtTransactionCommit,
  syncBinlog,
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
  status: "ready",
  command: prepareCommand.replace(env.MYSQL_ROOT_PASSWORD, "***"),
  startedAt: prepareStartedAt,
  finishedAt: prepareFinishedAt,
};

writeJson(path.join(PATHS.resultsDir, "environment.json"), environmentManifest);
writeJson(path.join(PATHS.resultsDir, "dataset.json"), datasetManifest);

console.log(`Prepared ${actualRows} rows across ${tableCount} tables.`);
console.log(`Environment manifest: ${path.join(PATHS.resultsDir, "environment.json")}`);
