import assert from "node:assert/strict";
import test from "node:test";
import {
  computeComparisons,
  computeStats,
  shouldRunThirdRun,
  summarizeCombination,
} from "../analytics.mjs";

function run(tps, p99Ms) {
  return {
    metrics: {
      tps,
      p99Ms,
    },
  };
}

function combination(scenario, concurrency, tps, qps, p95Ms, p99Ms) {
  return {
    scenario,
    concurrency,
    selected: {
      tps,
      qps,
      p95Ms,
      p99Ms,
      queriesPerTransaction: 1,
    },
  };
}

test("does not request a third run for stable results", () => {
  assert.equal(
    shouldRunThirdRun([run(100, 10), run(105, 10.5)], 10),
    false,
  );
});

test("requests a third run when TPS or p99 exceeds threshold", () => {
  assert.equal(shouldRunThirdRun([run(100, 10), run(120, 10)], 10), true);
  assert.equal(shouldRunThirdRun([run(100, 10), run(102, 12)], 10), true);
  assert.equal(shouldRunThirdRun([run(100, 0.04), run(100, 0.05)], 10), true);
});

test("computes mean, median, range and spread", () => {
  const stats = computeStats([100, 110, 120]);
  assert.equal(stats.mean, 110);
  assert.equal(stats.median, 110);
  assert.equal(stats.min, 100);
  assert.equal(stats.max, 120);
  assert.ok(Math.abs(stats.relativeSpreadPercent - 18.1818) < 0.01);
});

test("summarizes a stable pair with the mean as the selected value", () => {
  const summary = summarizeCombination([
    {
      metrics: {
        transactions: 100,
        queries: 100,
        tps: 100,
        qps: 100,
        averageLatencyMs: 1,
        p95Ms: 2,
        p99Ms: 3,
        queriesPerTransaction: 1,
      },
    },
    {
      metrics: {
        transactions: 105,
        queries: 105,
        tps: 105,
        qps: 105,
        averageLatencyMs: 1.1,
        p95Ms: 2.1,
        p99Ms: 3.1,
        queriesPerTransaction: 1,
      },
    },
  ]);
  assert.equal(summary.attempts, 2);
  assert.equal(summary.stability, "stable");
  assert.equal(summary.selected.tps, 102.5);
  assert.equal(summary.selected.qps, 102.5);
});

test("compares write to read only at the same concurrency", () => {
  const comparisons = computeComparisons([
    combination("point_select", 8, 1000, 1000, 1, 2),
    combination("update_index", 8, 200, 200, 5, 10),
    combination("read_write", 8, 300, 3000, 4, 8),
  ]);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].concurrency, 8);
  assert.equal(comparisons[0].writeToRead.tpsRatio, 0.2);
  assert.equal(comparisons[0].writeToRead.qpsRatio, 0.2);
  assert.equal(comparisons[0].writeToRead.p95Ratio, 5);
  assert.equal(comparisons[0].writeToRead.p99Ratio, 5);
});
