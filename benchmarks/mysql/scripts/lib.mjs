import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export const PATHS = {
  projectRoot: path.resolve(scriptDirectory, "../../.."),
  benchmarkRoot: path.resolve(scriptDirectory, ".."),
  composeFile: path.resolve(scriptDirectory, "../compose.yaml"),
  envFile: path.resolve(scriptDirectory, "../.env"),
  resultsDir: path.resolve(scriptDirectory, "../results"),
  rawDir: path.resolve(scriptDirectory, "../results/raw"),
  normalizedDir: path.resolve(scriptDirectory, "../results/normalized"),
  summaryDir: path.resolve(scriptDirectory, "../results/summary"),
  siteDataDir: path.resolve(scriptDirectory, "../../../site/data"),
};

export const SCENARIOS = {
  point_select: {
    id: "point_select",
    label: "主键点查",
    script: "oltp_point_select.lua",
    description: "按主键读取随机单行，代表纯读路径。",
  },
  update_index: {
    id: "update_index",
    label: "索引更新",
    script: "oltp_update_index.lua",
    description: "随机更新一行并维护索引，代表写路径。",
  },
  read_write: {
    id: "read_write",
    label: "读写混合",
    script: "oltp_read_write.lua",
    description: "标准读写混合负载，接近典型 OLTP 访问模式。",
  },
};

export const SCENARIO_ORDER = [
  "point_select",
  "update_index",
  "read_write",
];

export const CONCURRENCY_LEVELS = [1, 8, 32];

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function ensureDirectories() {
  for (const directory of [
    PATHS.resultsDir,
    PATHS.rawDir,
    PATHS.normalizedDir,
    PATHS.summaryDir,
    PATHS.siteDataDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
}

function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function loadBenchmarkEnv() {
  if (!existsSync(PATHS.envFile)) {
    throw new Error(`Missing environment file: ${PATHS.envFile}`);
  }
  const fileValues = parseDotEnv(readFileSync(PATHS.envFile, "utf8"));
  const merged = { ...fileValues };
  for (const key of Object.keys(fileValues)) {
    if (process.env[key] !== undefined) {
      merged[key] = process.env[key];
    }
  }
  return merged;
}

export function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeJsonl(filePath, values) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  writeFileSync(filePath, body ? `${body}\n` : "", "utf8");
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function readJsonl(filePath) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function listFiles(directory, suffix) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => path.join(directory, name));
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

export function redactSecrets(command, env) {
  let redacted = command;
  for (const secret of [
    env.MYSQL_ROOT_PASSWORD,
    env.MYSQL_PASSWORD,
  ].filter(Boolean)) {
    redacted = redacted.replaceAll(secret, "***");
  }
  return redacted;
}

export async function runProcess(command, args, options = {}) {
  const {
    cwd = PATHS.projectRoot,
    echo = false,
    env = process.env,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (echo) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (echo) {
        process.stderr.write(chunk);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

export function composeArguments(env, ...args) {
  return [
    "compose",
    "--env-file",
    PATHS.envFile,
    "-f",
    PATHS.composeFile,
    ...args,
  ];
}

export async function compose(env, args, options = {}) {
  return runProcess("docker", composeArguments(env, ...args), options);
}

export async function composeServiceShell(env, service, command, options = {}) {
  return compose(
    env,
    ["run", "--rm", service, "-lc", command],
    options,
  );
}

export async function composeExecShell(env, service, command, options = {}) {
  return compose(
    env,
    ["exec", "-T", service, "sh", "-lc", command],
    options,
  );
}

export async function waitForMysql(env, timeoutMilliseconds = 120_000) {
  const upResult = await compose(env, ["up", "-d", "mysql"], { echo: false });
  if (upResult.code !== 0) {
    throw new Error(upResult.stderr.trim() || "Unable to start MySQL");
  }

  const containerResult = await compose(env, ["ps", "-q", "mysql"], {
    echo: false,
  });
  const containerId = containerResult.stdout.trim().split(/\r?\n/)[0];
  if (!containerId) {
    throw new Error("Unable to resolve MySQL container id");
  }

  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const inspectResult = await runProcess("docker", [
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      containerId,
    ]);
    if (inspectResult.stdout.trim() === "healthy") {
      return containerId;
    }
    await sleep(1_000);
  }

  throw new Error("MySQL did not become healthy before timeout");
}

export async function mysqlQuery(env, sql, options = {}) {
  const command = [
    'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"',
    "--batch",
    "--skip-column-names",
    "--default-character-set=utf8mb4",
    `-e ${shellQuote(sql)}`,
  ].join(" ");
  const result = await composeExecShell(env, "mysql", command, options);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "MySQL query failed");
  }
  return result.stdout.trim();
}

export function createSysbenchArguments({
  env,
  scenario,
  command,
  concurrency,
  durationSeconds,
}) {
  const scenarioDefinition = SCENARIOS[scenario];
  if (!scenarioDefinition) {
    throw new Error(`Unsupported scenario: ${scenario}`);
  }

  return [
    `/usr/share/sysbench/${scenarioDefinition.script}`,
    "--db-driver=mysql",
    `--mysql-host=${env.MYSQL_HOST ?? "mysql"}`,
    `--mysql-port=${env.MYSQL_PORT ?? "3306"}`,
    `--mysql-user=${env.MYSQL_USER ?? "root"}`,
    `--mysql-password=${env.MYSQL_ROOT_PASSWORD}`,
    `--mysql-db=${env.MYSQL_DATABASE}`,
    `--tables=${env.TABLE_COUNT}`,
    `--table-size=${env.TABLE_SIZE}`,
    `--threads=${concurrency}`,
    `--time=${durationSeconds}`,
    "--report-interval=10",
    "--percentile=99",
    "--histogram=on",
    "--rand-type=uniform",
    "--rand-seed=42",
    "--mysql-ssl=off",
    command,
  ];
}

export function createSysbenchShellCommand(args) {
  return `sysbench ${args.map(shellQuote).join(" ")}`;
}

function parseNumber(value) {
  return Number(String(value).replaceAll(",", ""));
}

function percentileFromHistogram(output, percentile) {
  const lines = output.split(/\r?\n/);
  const histogramStart = lines.findIndex((line) =>
    line.includes("Latency histogram"),
  );
  if (histogramStart === -1) {
    throw new Error("Unable to parse sysbench latency histogram");
  }

  const buckets = [];
  for (const line of lines.slice(histogramStart + 1)) {
    if (line.startsWith("SQL statistics:")) {
      break;
    }
    const match = line.match(/^\s*([\d.]+)\s+\|.*?\s+(\d+)\s*$/);
    if (match) {
      buckets.push({
        upperBoundMs: Number(match[1]),
        count: Number(match[2]),
      });
    }
  }
  if (!buckets.length) {
    throw new Error("Sysbench latency histogram contains no buckets");
  }

  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const threshold = total * (percentile / 100);
  let cumulative = 0;
  for (const bucket of buckets) {
    cumulative += bucket.count;
    if (cumulative >= threshold) {
      return bucket.upperBoundMs;
    }
  }
  return buckets.at(-1).upperBoundMs;
}

export function parseSysbenchOutput(output) {
  const patterns = {
    transactions: /^\s*transactions:\s+([\d,]+)\s+\(([\d.]+)\s+per sec\.\)/m,
    queries: /^\s*queries:\s+([\d,]+)\s+\(([\d.]+)\s+per sec\.\)/m,
    ignoredErrors: /^\s*ignored errors:\s+([\d,]+)/m,
    reconnects: /^\s*reconnects:\s+([\d,]+)/m,
    averageLatencyMs: /^\s*avg:\s+([\d.]+)/m,
    p99Ms: /^\s*99th percentile:\s+([\d.]+)/m,
  };

  const matches = {};
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = output.match(pattern);
    if (!match) {
      throw new Error(`Unable to parse sysbench metric: ${key}`);
    }
    matches[key] = match;
  }

  const transactions = parseNumber(matches.transactions[1]);
  const queries = parseNumber(matches.queries[1]);
  const exactP95 = output.match(/^\s*95th percentile:\s+([\d.]+)/m);
  const exactP99 = output.match(/^\s*99th percentile:\s+([\d.]+)/m);
  const p95Ms = exactP95
    ? parseNumber(exactP95[1])
    : percentileFromHistogram(output, 95);
  const p99Ms = exactP99
    ? parseNumber(exactP99[1])
    : percentileFromHistogram(output, 99);
  const metrics = {
    transactions,
    queries,
    tps: parseNumber(matches.transactions[2]),
    qps: parseNumber(matches.queries[2]),
    averageLatencyMs: parseNumber(matches.averageLatencyMs[1]),
    p95Ms,
    p99Ms,
    p95Source: exactP95 ? "sysbench" : "histogram",
    p99Source: exactP99 ? "sysbench" : "histogram",
    ignoredErrors: parseNumber(matches.ignoredErrors[1]),
    reconnects: parseNumber(matches.reconnects[1]),
  };
  metrics.queriesPerTransaction =
    transactions > 0 ? queries / transactions : null;
  metrics.errors = metrics.ignoredErrors + metrics.reconnects;
  metrics.queriesPerSecondPerTransaction =
    transactions > 0 ? metrics.qps / metrics.tps : null;
  return metrics;
}

export function parseCliArguments(argv) {
  const values = {};
  for (const value of argv) {
    if (!value.startsWith("--")) {
      continue;
    }
    const [rawKey, rawValue] = value.slice(2).split("=", 2);
    values[rawKey] = rawValue === undefined ? true : rawValue;
  }
  return values;
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
