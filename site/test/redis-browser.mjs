import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReportData } from "../../benchmarks/redis/scripts/summary.mjs";
import { recomputeRun } from "../../benchmarks/redis/scripts/collect.mjs";
import { makeSummary } from "../../benchmarks/redis/scripts/test/fixtures.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let playwright;
try {
  playwright = await import("playwright");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  playwright = await import(pathToFileURL(path.join(globalRoot, "playwright/index.mjs")));
}

function fixture(perCombo) {
  const resultsDir = mkdtempSync(path.join(os.tmpdir(), "redis-browser-"));
  const summary = makeSummary(resultsDir, { perCombo });
  return buildReportData({ ...summary, results: summary.results.map(item => ({ combo: item.combo, runs: item.runs.map(run => recomputeRun(run, resultsDir)) })) });
}

const rates = { "pipeline-get-d1": 80000, "pipeline-get-d16": 400000, "pipeline-get-d64": 700000, "pipeline-get-d256": 900000,
  "persistence-aof-always-c16": 25000, "blocking-keys": 30000 };
const good = fixture(combo => ({ opsPerSec: rates[combo.id] ?? 90000, loadgenRate: combo.id === "pipeline-get-d256" ? 3.9 : 2, p99Ms: combo.id === "blocking-keys" ? 30 : 0.6 }));
const partial = structuredClone(good);
partial.scenarios = partial.scenarios.filter(scenario => scenario.id !== "memory");
partial.coverage = { groups: partial.scenarios.map(scenario => scenario.id), pending: ["memory"], incomplete: [], total: 7 };

const allocator = createServer();
await new Promise(resolve => allocator.listen(0, "127.0.0.1", resolve));
const port = allocator.address().port;
await new Promise(resolve => allocator.close(resolve));
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["site/server.mjs"], { cwd: project, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
const browser = await playwright.chromium.launch({ headless: true });
const screenshots = process.env.SITE_SCREENSHOTS ?? "/tmp/performance-profile-dashboard";
mkdirSync(screenshots, { recursive: true });

async function serve(page, body, status = 200) {
  await page.route("**/data/redis.json", route => route.fulfill({ status, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) }));
}

async function noOverflow(page) {
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
    chartOverflow: [...document.querySelectorAll(".chart")].some(node => node.scrollWidth > node.clientWidth + 1) }));
  assert.ok(sizes.width <= sizes.viewport + 1, JSON.stringify(sizes));
  assert.equal(sizes.chartOverflow, false);
}

try {
  for (let retry = 0; retry < 100; retry += 1) {
    try { if ((await fetch(`${url}/redis.html`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await serve(page, good);
  await page.goto(`${url}/redis.html`);
  await page.locator("#report").waitFor({ state: "visible" });
  await page.locator(".chart-panel svg").first().waitFor();

  assert.equal(await page.locator("section.scenario").count(), 7);
  assert.equal(await page.locator("#coverage-note").isHidden(), true);
  assert.equal(await page.locator(".conclusion-item").count(), 5);
  assert.equal(await page.locator(".chart-panel").count(), 13);
  assert.equal(await page.locator(".chart-panel svg").count(), 13);
  assert.equal(await page.locator("#redis-version").innerText(), "7.4.2");
  assert.match(await page.locator("#redis-resources").innerText(), /2 CPU \/ 4 GiB/);
  assert.match(await page.locator("#redis-resources").innerText(), /4 CPU \/ 1 GiB/);
  assert.match(await page.locator("[data-conclusion=pipeline] .conclusion-headline").innerText(), /11\.3×/);
  assert.match(await page.locator("[data-conclusion=persistence] .conclusion-headline").innerText(), /-72\.2%|-72%/);
  assert.equal(await page.locator("#scenario-nav a").count(), 7);
  assert.equal(await page.locator(".redis-card").count(), 4);
  const bodyText = await page.locator("body").innerText();
  for (const phrase of ["verification", "dry run", "标定", "冒烟"]) assert.ok(!bodyText.includes(phrase), `Unexpected process text: ${phrase}`);

  const flagged = page.locator("#scenario-pipeline .bound-flag");
  assert.ok(await flagged.count() >= 1);
  assert.match(await page.locator("#scenario-pipeline .flag-note").innerText(), /压测端/);
  assert.equal(await page.locator("#scenario-commands .flag-note").count(), 0);
  assert.ok(await page.locator("#scenario-pipeline .chart-dot-flag").count() >= 1);

  const pipelineOps = page.locator('.chart-panel[data-scenario="pipeline"][data-panel="ops"]');
  const logTicks = await pipelineOps.locator(".chart-axis").allInnerTexts();
  await pipelineOps.locator('[data-scale="linear"]').click();
  assert.equal(await pipelineOps.locator('[data-scale="linear"]').getAttribute("aria-pressed"), "true");
  const linearTicks = await pipelineOps.locator(".chart-axis").allInnerTexts();
  assert.notDeepEqual(logTicks, linearTicks);
  assert.equal(await page.locator('.chart-panel[data-scenario="commands"] [data-scale]').count(), 0);

  const dot = pipelineOps.locator(".chart-dot").first();
  await dot.hover({ force: true });
  const box = await pipelineOps.locator(".chart").boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await pipelineOps.locator(".chart-tooltip").waitFor();
  assert.match(await pipelineOps.locator(".chart-tooltip").innerText(), /GET/);

  await page.locator("#scenario-persistence .result-detail summary").first().click();
  const link = page.locator("#scenario-persistence .result-detail[open] a.run-link").first();
  assert.match(await link.getAttribute("href"), /^\.\/artifacts\/redis\/formal-test\/persistence-/);
  assert.equal(await page.locator("#environment details").count() > 4, true);
  await page.locator("#scenario-nav a").nth(3).click();
  assert.match(page.url(), /#scenario-persistence$/);

  for (const [width, height, name] of [[1440, 900, "desktop"], [1024, 768, "tablet-landscape"], [768, 1024, "tablet"], [375, 812, "mobile"]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    await noOverflow(page);
    await page.screenshot({ path: path.join(screenshots, `redis-${name}.png`), fullPage: true });
  }

  const missing = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await serve(missing, partial);
  await missing.goto(`${url}/redis.html`);
  await missing.locator("#report").waitFor({ state: "visible" });
  assert.equal(await missing.locator("#scenario-memory .redis-card").count(), 0);
  assert.match(await missing.locator("#scenario-memory").innerText().catch(() => ""), /暂无有效结果|^$/);
  assert.equal(await missing.locator("section.scenario").count(), 6);
  assert.match(await missing.locator("#coverage-note").innerText(), /已覆盖 6\/7 个场景.*尚未测量：内存压力与淘汰/);
  assert.equal(await missing.locator("#scenario-nav a").last().innerText(), "7 慢命令阻塞");
  assert.equal(await missing.locator("#scenario-nav a", { hasText: "内存压力" }).count(), 0);

  const broken = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await serve(broken, "not json");
  await broken.goto(`${url}/redis.html`);
  await broken.locator("#load-status[data-state=error]").waitFor();
  assert.equal(await broken.locator("#report").isHidden(), true);
  const unavailable = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await serve(unavailable, "missing", 404);
  await unavailable.goto(`${url}/redis.html`);
  await unavailable.locator("#load-status[data-state=error]").waitFor();
  assert.match(await unavailable.locator("#load-status").innerText(), /HTTP 404/);

  const index = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await serve(index, good);
  await index.goto(`${url}/index.html`);
  await index.locator("#redis-entry").waitFor({ state: "visible" });
  assert.equal(await index.locator("#redis-index-peak").innerText(), "900,000");
  assert.match(await index.locator("#redis-index-peak-scope").innerText(), /GET · Pipeline 256 · 16 连接/);
  assert.equal(await index.locator('a.component-name[href="./redis.html"]').count(), 1);
  assert.equal(await index.locator('a.component-name[href="./mysql.html"]').count(), 1);
  assert.match(await index.locator("#index-resources").innerText(), /CPU/);
  const noRedisIndex = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await serve(noRedisIndex, "missing", 404);
  await noRedisIndex.goto(`${url}/index.html`);
  await noRedisIndex.locator("#report").waitFor({ state: "visible" });
  assert.equal(await noRedisIndex.locator("#redis-entry").isHidden(), true);

  assert.deepEqual(errors, []);
  console.log("Redis browser regression passed.");
} finally {
  await browser.close();
  server.kill();
}
