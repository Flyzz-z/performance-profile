import { assert, DURABILITY_SCENARIOS, FORMAL_SCENARIOS, EXPANDED_SCENARIOS, EXPANDED_CONCURRENCY } from "./lib.mjs";

export const LOGGING_MODES = {
  update_index: { logBinEnabled: true, flushLogAtTransactionCommit: 1, syncBinlog: 1, flushLogAtTimeout: 1 },
  update_index_async: { logBinEnabled: true, flushLogAtTransactionCommit: 2, syncBinlog: 0, flushLogAtTimeout: 1 },
};

export function loggingMode(scenario) {
  assert([...FORMAL_SCENARIOS, ...EXPANDED_SCENARIOS].includes(scenario), "Unknown formal scenario");
  return scenario === "update_index_async" ? LOGGING_MODES.update_index_async : LOGGING_MODES.update_index;
}

export function formalPlan(env, cli = {}) {
  assert(Number(env.LOADGEN_CPUS) === 4, "Formal experiment requires sysbench 4 CPU");
  assert(Number(env.MYSQL_CPUS) === 8, "Formal experiment requires MySQL 8 CPU");
  const concurrency = String(cli.concurrency ?? EXPANDED_CONCURRENCY.join(",")).split(",").map(Number);
  assert(concurrency.length > 0 && concurrency.every(c => EXPANDED_CONCURRENCY.includes(c)) && new Set(concurrency).size === concurrency.length, "Invalid expanded concurrency");
  const base = { concurrency, warmupSeconds: Number(cli["warmup-seconds"] ?? env.WARMUP_SECONDS), durationSeconds: Number(cli["duration-seconds"] ?? env.DURATION_SECONDS), repeats: Number(cli.runs ?? 2) };
  assert(base.warmupSeconds >= 0 && base.durationSeconds > 0 && [1,2,3].includes(base.repeats), "Invalid formal protocol");
  const scenarios = cli.scenario ? String(cli.scenario).split(",") : EXPANDED_SCENARIOS;
  assert(scenarios.length > 0 && scenarios.every((s) => EXPANDED_SCENARIOS.includes(s))
    && new Set(scenarios).size === scenarios.length, "Invalid formal scenario selection");
  const isFull = scenarios.length === 6 && base.concurrency.length === 3
    && base.warmupSeconds === 30 && base.durationSeconds === 90
    && base.repeats === 2 && Number(env.VARIANCE_THRESHOLD_PERCENT) === 30;
  return {
    ...base, scenarios, isFull, purpose: isFull ? "formal" : "verification",
    combinations: scenarios.flatMap((scenario) => base.concurrency.map((concurrency) =>
      ({ scenario, concurrency, logging: loggingMode(scenario) }))),
  };
}

export function assertLoggingMatch(actual, expected) {
  for (const key of Object.keys(expected)) {
    assert(actual[key] === expected[key], `Logging mismatch: ${key}, expected ${expected[key]}, received ${actual[key]}`);
  }
}

export async function readLoggingState(query) {
  const output = await query("SELECT @@GLOBAL.log_bin, @@GLOBAL.innodb_flush_log_at_trx_commit, @@GLOBAL.sync_binlog, @@GLOBAL.innodb_flush_log_at_timeout;");
  const values = output.trim().split(/\s+/).map(Number);
  assert(values.length === 4 && values.every(Number.isInteger), "Unable to read logging configuration");
  const [logBinEnabled, flushLogAtTransactionCommit, syncBinlog, flushLogAtTimeout] = values;
  assert([0, 1].includes(logBinEnabled) && [0, 1, 2].includes(flushLogAtTransactionCommit)
    && syncBinlog >= 0 && flushLogAtTimeout >= 1, "Invalid logging configuration");
  return { logBinEnabled: logBinEnabled === 1, flushLogAtTransactionCommit, syncBinlog, flushLogAtTimeout };
}

export async function setLoggingState(query, expected) {
  assert([0, 1, 2].includes(expected.flushLogAtTransactionCommit)
    && Number.isInteger(expected.syncBinlog) && expected.syncBinlog >= 0
    && Number.isInteger(expected.flushLogAtTimeout) && expected.flushLogAtTimeout >= 1, "Invalid logging parameters");
  await query(`SET GLOBAL innodb_flush_log_at_trx_commit=${expected.flushLogAtTransactionCommit}, GLOBAL sync_binlog=${expected.syncBinlog}, GLOBAL innodb_flush_log_at_timeout=${expected.flushLogAtTimeout};`);
  const actual = await readLoggingState(query);
  assertLoggingMatch(actual, expected);
  return actual;
}

export async function withLoggingRestored(query, action) {
  const original = await readLoggingState(query);
  assert(original.logBinEnabled, "log_bin must be ON; no test was started");
  assert(original.flushLogAtTransactionCommit === 1 && original.syncBinlog === 1,
    "Expected original redo=1/sync_binlog=1. Check or restart the project MySQL before testing.");
  let failure;
  try {
    return await action(original);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await setLoggingState(query, original);
    } catch (restoreError) {
      throw new AggregateError([failure, restoreError].filter(Boolean),
        "Failed to restore MySQL logging configuration. Do not publish results; check or restart project MySQL.");
    }
  }
}

export function durabilityPlan(env, cli = {}) {
  const concurrency = String(cli.concurrency ?? "1,8,32").split(",").map(Number);
  const warmupSeconds = Number(cli["warmup-seconds"] ?? env.WARMUP_SECONDS);
  const durationSeconds = Number(cli["duration-seconds"] ?? env.DURATION_SECONDS);
  const repeats = Number(cli.runs ?? 2);
  assert(concurrency.length > 0 && concurrency.every((v) => [1, 8, 32].includes(v))
    && new Set(concurrency).size === concurrency.length, "Concurrency must be unique values from 1,8,32");
  assert(Number.isInteger(warmupSeconds) && warmupSeconds >= 0, "Invalid warmup");
  assert(Number.isInteger(durationSeconds) && durationSeconds > 0, "Invalid duration");
  assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 3, "Invalid repeat count");
  return {
    warmupSeconds, durationSeconds, repeats, concurrency,
    combinations: concurrency.flatMap((level) => DURABILITY_SCENARIOS.map((scenario) =>
      ({ scenario, concurrency: level, logging: LOGGING_MODES[scenario] }))),
  };
}
