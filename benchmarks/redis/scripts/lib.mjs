import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, runProcess, sleep } from "../../mysql/scripts/lib.mjs";
import { parseInfo, infoSnapshot, parseConfigGet } from "./redis-info.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export const PATHS = {
  projectRoot: path.resolve(scriptDirectory, "../../.."),
  benchmarkRoot: path.resolve(scriptDirectory, ".."),
  composeFile: path.resolve(scriptDirectory, "../compose.yaml"),
  envFile: path.resolve(scriptDirectory, "../.env"),
  envExample: path.resolve(scriptDirectory, "../.env.example"),
  resultsDir: path.resolve(scriptDirectory, "../results"),
  siteDataDir: path.resolve(scriptDirectory, "../../../site/data"),
};

export const PROJECT_NAME = "performance-profile-redis";

function parseDotEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

export function envFilePath() {
  return existsSync(PATHS.envFile) ? PATHS.envFile : PATHS.envExample;
}

export function loadRedisEnv() {
  const values = parseDotEnv(readFileSync(envFilePath(), "utf8"));
  for (const key of Object.keys(values)) if (process.env[key] !== undefined && key !== "REDIS_EXTRA_ARGS") values[key] = process.env[key];
  return values;
}

export function composeArguments(...args) {
  return ["compose", "--env-file", envFilePath(), "-f", PATHS.composeFile, "--profile", "tools", ...args];
}

export function compose(env, args, options = {}) {
  return runProcess("docker", composeArguments(...args), { ...options, env: { ...process.env, ...env, ...(options.env ?? {}) } });
}

export async function composeChecked(env, args, options = {}) {
  const result = await compose(env, args, options);
  assert(result.code === 0, `docker compose ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result;
}

export async function execIn(env, service, command, options = {}) {
  return compose(env, ["exec", "-T", service, ...command], options);
}

export async function redisCli(env, args, options = {}) {
  const result = await execIn(env, "bgclient", ["redis-cli", "-h", "redis", ...args], options);
  assert(result.code === 0, `redis-cli ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}

export async function containerId(env, service) {
  const result = await composeChecked(env, ["ps", "-q", service]);
  const id = result.stdout.trim().split(/\r?\n/)[0];
  assert(id, `Unable to resolve the ${service} container`);
  return id;
}

export async function readInfo(env) {
  const text = await redisCli(env, ["INFO", "everything"]);
  return infoSnapshot(parseInfo(text), Date.now());
}

export async function readConfig(env, names) {
  const map = {};
  for (const name of names) Object.assign(map, parseConfigGet(await redisCli(env, ["CONFIG", "GET", name])));
  return map;
}

export const CONFIG_NAMES = ["io-threads", "save", "appendonly", "appendfsync", "maxmemory", "maxmemory-policy", "maxclients", "latency-tracking"];

export async function waitForRedis(env, timeoutMilliseconds = 60_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const result = await execIn(env, "bgclient", ["redis-cli", "-h", "redis", "PING"]);
    if (result.code === 0 && result.stdout.trim() === "PONG") return;
    await sleep(1000);
  }
  throw new Error("Redis did not become ready");
}

export async function startStack(env, profile) {
  const extra = profile.args.join(" ");
  const stackEnv = { ...env, REDIS_EXTRA_ARGS: extra };
  await composeChecked(stackEnv, ["up", "-d", "--force-recreate", "redis"]);
  await composeChecked(stackEnv, ["up", "-d", "memtier", "bgclient"]);
  await waitForRedis(stackEnv);
  return stackEnv;
}

export async function removeOwnedContainers(env) {
  await compose(env, ["rm", "-sf", "memtier", "bgclient", "redis"]);
}

export async function waitForBackgroundIdle(env, timeoutMilliseconds = 180_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const info = await readInfo(env);
    if (!info.bgsaveInProgress && !info.aofRewriteInProgress) return info;
    await sleep(1000);
  }
  throw new Error("Redis background save or AOF rewrite did not finish");
}

export function hostSnapshot() {
  const cpus = os.cpus();
  return { platform: os.platform(), arch: os.arch(), release: os.release(), cpuModel: cpus[0]?.model ?? null, cpuCount: cpus.length, memoryBytes: os.totalmem() };
}

export async function dockerVmSnapshot() {
  const result = await runProcess("docker", ["info", "--format", "{{json .}}"]);
  assert(result.code === 0, "Unable to read docker info");
  const info = JSON.parse(result.stdout);
  return { cpus: info.NCPU, memoryBytes: info.MemTotal, kernel: info.KernelVersion, operatingSystem: info.OperatingSystem,
    architecture: info.Architecture, dockerVersion: info.ServerVersion };
}
