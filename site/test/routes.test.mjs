import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveSitePath } from "../artifact-routes.mjs";

const root = path.resolve("/project/site");

test("artifact routes map each component to its own results directory", () => {
  assert.equal(resolveSitePath(root, "artifacts/mysql/a/b.json"), path.resolve("/project/benchmarks/mysql/results/a/b.json"));
  assert.equal(resolveSitePath(root, "artifacts/redis/formal-1/commands-get/run1.txt"),
    path.resolve("/project/benchmarks/redis/results/formal-1/commands-get/run1.txt"));
  assert.equal(resolveSitePath(root, "redis.html"), path.resolve("/project/site/redis.html"));
});

test("artifact routes reject traversal outside the served directory", () => {
  assert.equal(resolveSitePath(root, "artifacts/redis/../../mysql/results/x.json"), null);
  assert.equal(resolveSitePath(root, "artifacts/redis/../results-evil/x"), null);
  assert.equal(resolveSitePath(root, "../package.json"), null);
});
