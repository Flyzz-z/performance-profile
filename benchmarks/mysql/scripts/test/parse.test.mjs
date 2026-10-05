import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseSysbenchOutput } from "../lib.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function fixture(name) {
  return readFileSync(path.join(testDirectory, "fixtures", name), "utf8");
}

test("parses successful sysbench output", () => {
  const metrics = parseSysbenchOutput(fixture("sysbench-success.txt"));
  assert.equal(metrics.transactions, 12_000);
  assert.equal(metrics.queries, 12_000);
  assert.equal(metrics.tps, 100);
  assert.equal(metrics.qps, 100);
  assert.equal(metrics.averageLatencyMs, 2.5);
  assert.equal(metrics.p95Ms, 5);
  assert.equal(metrics.p99Ms, 10);
  assert.equal(metrics.errors, 0);
  assert.equal(metrics.queriesPerTransaction, 1);
});

test("rejects failed sysbench output", () => {
  assert.throws(
    () => parseSysbenchOutput(fixture("sysbench-failure.txt")),
    /Unable to parse sysbench metric/,
  );
});

test("derives p95 from the latency histogram when sysbench omits it", () => {
  const metrics = parseSysbenchOutput(fixture("sysbench-histogram.txt"));
  assert.equal(metrics.p95Ms, 0.07);
  assert.equal(metrics.p99Ms, 0.09);
  assert.equal(metrics.p95Source, "histogram");
  assert.equal(metrics.p99Source, "sysbench");
});
