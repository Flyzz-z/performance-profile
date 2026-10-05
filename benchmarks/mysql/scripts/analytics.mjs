import {
  CONCURRENCY_LEVELS,
  SCENARIO_ORDER,
  SCENARIOS,
  assert,
} from "./lib.mjs";

function numericValues(runs, field) {
  return runs
    .map((run) => run.metrics?.[field])
    .filter((value) => Number.isFinite(value));
}

export function computeStats(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const mean = sum / sorted.length;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const relativeSpreadPercent =
    mean === 0 ? 0 : ((max - min) / Math.abs(mean)) * 100;
  return {
    mean,
    median,
    min,
    max,
    relativeSpreadPercent,
  };
}

export function relativeDifferencePercent(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return Number.POSITIVE_INFINITY;
  }
  const denominator = Math.max(
    Math.abs(left),
    Math.abs(right),
    Number.EPSILON,
  );
  return (Math.abs(left - right) / denominator) * 100;
}

export function shouldRunThirdRun(
  runs,
  thresholdPercent,
) {
  if (runs.length < 2) {
    return false;
  }
  const [first, second] = runs;
  const tpsDifference = relativeDifferencePercent(
    first.metrics.tps,
    second.metrics.tps,
  );
  const p99Difference = relativeDifferencePercent(
    first.metrics.p99Ms,
    second.metrics.p99Ms,
  );
  return Math.max(tpsDifference, p99Difference) > thresholdPercent;
}

function stabilityLevel(relativeSpreadPercent) {
  if (relativeSpreadPercent <= 5) {
    return "stable";
  }
  if (relativeSpreadPercent <= 10) {
    return "acceptable";
  }
  return "unstable";
}

const SUMMARY_FIELDS = [
  "transactions",
  "queries",
  "tps",
  "qps",
  "averageLatencyMs",
  "p95Ms",
  "p99Ms",
  "queriesPerTransaction",
];

export function summarizeCombination(runs) {
  if (!runs.length) {
    return null;
  }

  const stats = {};
  for (const field of SUMMARY_FIELDS) {
    stats[field] = computeStats(numericValues(runs, field));
  }

  const stability = stabilityLevel(
    Math.max(
      stats.tps?.relativeSpreadPercent ?? 0,
      stats.p99Ms?.relativeSpreadPercent ?? 0,
    ),
  );
  const selectedTps =
    runs.length >= 3 ? stats.tps.median : stats.tps.mean;
  const selectedQps =
    runs.length >= 3 ? stats.qps.median : stats.qps.mean;
  const selectedP95 =
    runs.length >= 3 ? stats.p95Ms.median : stats.p95Ms.mean;
  const selectedP99 =
    runs.length >= 3 ? stats.p99Ms.median : stats.p99Ms.mean;

  return {
    attempts: runs.length,
    stability,
    stats,
    selected: {
      tps: selectedTps,
      qps: selectedQps,
      p95Ms: selectedP95,
      p99Ms: selectedP99,
      queriesPerTransaction:
        stats.queriesPerTransaction?.median ??
        stats.queriesPerTransaction?.mean ??
        null,
    },
  };
}

function successfulMeasuredRuns(runs) {
  return runs.filter(
    (run) =>
      run.kind === "measured" &&
      run.status === "passed" &&
      run.metrics?.errors === 0,
  );
}

export function aggregateCombinations(runs) {
  const combinations = [];
  for (const scenario of SCENARIO_ORDER) {
    for (const concurrency of CONCURRENCY_LEVELS) {
      const matching = successfulMeasuredRuns(runs)
        .filter(
          (run) =>
            run.scenario === scenario &&
            run.concurrency === concurrency,
        )
        .sort((left, right) => left.repeat - right.repeat);
      const summary = summarizeCombination(matching);
      if (summary) {
        combinations.push({
          scenario,
          scope: SCENARIOS[scenario],
          concurrency,
          ...summary,
          runs: matching,
        });
      }
    }
  }
  return combinations;
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

export function computeComparisons(combinations) {
  const byKey = new Map(
    combinations.map((combination) => [
      `${combination.scenario}:${combination.concurrency}`,
      combination,
    ]),
  );

  return CONCURRENCY_LEVELS.flatMap((concurrency) => {
    const read = byKey.get(`point_select:${concurrency}`);
    const write = byKey.get(`update_index:${concurrency}`);
    const mixed = byKey.get(`read_write:${concurrency}`);
    if (!read || !write || !mixed) {
      return [];
    }
    return [
      {
        concurrency,
        read: read.selected,
        write: write.selected,
        mixed: mixed.selected,
        writeToRead: {
          tpsRatio: ratio(write.selected.tps, read.selected.tps),
          qpsRatio: ratio(write.selected.qps, read.selected.qps),
          p95Ratio: ratio(write.selected.p95Ms, read.selected.p95Ms),
          p99Ratio: ratio(write.selected.p99Ms, read.selected.p99Ms),
        },
        stability: {
          read: read.stability,
          write: write.stability,
          mixed: mixed.stability,
        },
      },
    ];
  });
}

export function assertUniqueRunIds(runs) {
  const seen = new Set();
  for (const run of runs) {
    if (seen.has(run.runId)) {
      throw new Error(`Duplicate runId: ${run.runId}`);
    }
    seen.add(run.runId);
  }
}

export function validateRunRecord(run) {
  for (const field of [
    "runId",
    "runGroup",
    "scenario",
    "concurrency",
    "kind",
    "repeat",
    "status",
    "startedAt",
    "finishedAt",
    "command",
    "rawOutputPath",
    "environmentPath",
  ]) {
    assert(run[field] !== undefined && run[field] !== null, `Missing run field: ${field}`);
  }
  if (run.status === "passed") {
    assert(run.metrics, `Passed run ${run.runId} is missing metrics`);
    for (const field of [
      "transactions",
      "queries",
      "tps",
      "qps",
      "averageLatencyMs",
      "p95Ms",
      "p99Ms",
      "errors",
    ]) {
      assert(
        Number.isFinite(run.metrics[field]),
        `Run ${run.runId} has invalid metric: ${field}`,
      );
    }
  }
}

export function validateSiteData(siteData, { allowPartial = false } = {}) {
  assert(siteData.schemaVersion === 1, "Unsupported site data schema");
  assert(siteData.component?.id === "mysql", "Site data must describe MySQL");
  assert(Array.isArray(siteData.series), "Site data is missing scenario series");
  assert(
    siteData.series.length === SCENARIO_ORDER.length,
    "Site data must contain all MySQL scenarios",
  );
  assert(Array.isArray(siteData.comparisons), "Site data is missing comparisons");
  for (const series of siteData.series) {
    if (!allowPartial) {
      assert(
        series.points.length === CONCURRENCY_LEVELS.length,
        `Scenario ${series.scenario} does not contain all concurrency points`,
      );
    }
  }
}
