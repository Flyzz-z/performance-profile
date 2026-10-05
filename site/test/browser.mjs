import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatNumber, formatLatency, formatMemory, formatDate } from "../report.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const data = JSON.parse(readFileSync(path.join(project, "site/data/mysql.json")));
let playwright;
try {
  playwright = await import("playwright");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  playwright = await import(pathToFileURL(path.join(globalRoot, "playwright/index.mjs")));
}

const allocator = createServer();
await new Promise((resolve) => allocator.listen(0, "127.0.0.1", resolve));
const port = allocator.address().port;
await new Promise((resolve) => allocator.close(resolve));
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["site/server.mjs"], {
  cwd: project, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
});
let serverErrors = "";
server.stderr.on("data", (chunk) => { serverErrors += chunk; });
const browser = await playwright.chromium.launch({ headless: true });
const screenshotDirectory = process.env.SITE_SCREENSHOTS ?? "/tmp/performance-profile-dashboard";
mkdirSync(screenshotDirectory, { recursive: true });

async function ready(page, route = "mysql.html") {
  await page.goto(`${url}/${route}`);
  await page.locator("#report").waitFor({ state: "visible" });
  if (route === "mysql.html") await page.locator(".chart-panel").first().waitFor();
}

async function noOverflow(page) {
  const sizes = await page.evaluate(() => ({
    viewport: innerWidth, width: document.documentElement.scrollWidth,
    chartOverflow: [...document.querySelectorAll(".chart")].some((node) => node.scrollWidth > node.clientWidth + 1),
  }));
  assert.ok(sizes.width <= sizes.viewport + 1, JSON.stringify(sizes));
  assert.equal(sizes.chartOverflow, false);
}

try {
  for (let retry = 0; retry < 100; retry += 1) {
    try { if ((await fetch(`${url}/mysql.html`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  assert.equal(await page.locator(".chart-panel").count(), 4);
  assert.equal(await page.locator(".chart-dot").count(), 36);
  assert.equal(await page.locator("#comparison-grid").count(), 0);
  assert.equal(await page.locator("#cpu-limit").textContent(), "4 CPU");
  assert.equal(await page.locator("#memory-limit").textContent(), "6 GiB");
  assert.equal(await page.locator("#buffer-pool").textContent(), "3 GiB");
  assert.equal(await page.locator("#report-time").textContent(), formatDate(data.component.testedAt));
  assert.equal(await page.locator("#selected-concurrency").textContent(), "32");
  for (const metric of ["qps", "tps", "p95Ms", "p99Ms"]) {
    const panel = page.locator(`[data-metric="${metric}"]`);
    for (const series of data.series) {
      for (const point of series.points) {
        const dot = panel.locator(`.chart-dot[data-scenario="${series.scenario}"][data-concurrency="${point.concurrency}"]`);
        assert.equal(Number(await dot.getAttribute("data-value")), point[metric]);
      }
    }
  }
  await page.getByRole("button", { name: "并发 8", exact: true }).click();
  assert.equal(await page.locator("#selected-concurrency").textContent(), "8");
  const read = page.locator('#selected-body tr[data-scenario="point_select"]');
  assert.ok((await read.textContent()).includes("135,335.59"));
  assert.ok((await read.textContent()).includes("不稳定"));
  await page.getByRole("button", { name: "TPS 线性刻度", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "TPS 线性刻度", exact: true }).getAttribute("aria-pressed"), "true");
  assert.match(await page.locator('[data-metric="tps"] svg').getAttribute("aria-label"), /线性/);
  await page.getByRole("checkbox", { name: "索引更新", exact: true }).uncheck();
  assert.equal(await page.locator('.chart-dot[data-scenario="update_index"]').count(), 0);
  assert.equal(await page.locator("#selected-body tr").count(), 2);
  assert.equal(await page.locator("#selected-concurrency").textContent(), "8");
  await page.getByRole("checkbox", { name: "主键点查", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "读写混合", exact: true }).uncheck();
  assert.equal(await page.locator(".chart-empty").count(), 4);
  for (const name of ["主键点查", "索引更新", "读写混合"]) await page.getByRole("checkbox", { name, exact: true }).check();
  await page.getByRole("button", { name: "TPS 对数刻度", exact: true }).click();
  const keyboardButton = page.getByRole("button", { name: "并发 1", exact: true });
  await keyboardButton.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#selected-concurrency").textContent(), "1");
  assert.equal(await keyboardButton.evaluate((node) => document.activeElement === node), true);
  assert.ok((await page.locator("#selected-body").textContent()).includes("0.027 ms"));
  await page.locator('[data-metric="qps"] .chart-dot[data-scenario="point_select"][data-concurrency="8"]').hover();
  assert.ok((await page.locator(".chart-tooltip").textContent()).includes("135,335.59"));
  const tooltipBox = await page.locator(".chart-tooltip").boundingBox();
  const chartBox = await page.locator('[data-metric="qps"] .chart').boundingBox();
  assert.ok(tooltipBox.x >= chartBox.x && tooltipBox.x + tooltipBox.width <= chartBox.x + chartBox.width + 1);
  await page.locator("h1").hover();
  assert.equal(await page.locator(".chart-tooltip").count(), 0);
  assert.equal(await page.locator(".result-detail").count(), 9);
  for (const detail of await page.locator(".result-detail").all()) await detail.locator("summary").click();
  assert.equal(await page.locator("a.run-link").count(), 20);
  for (const link of await page.locator("a.run-link").all()) {
    const response = await page.request.get(new URL(await link.getAttribute("href"), `${url}/mysql.html`).href);
    assert.equal(response.status(), 200);
  }
  for (const detail of await page.locator(".result-detail").all()) await detail.locator("summary").click();
  for (const group of await page.locator(".environment-detail").all()) await group.locator("summary").click();
  const environmentText = await page.locator("#environment-groups").textContent();
  for (const expected of [
    "4 CPU", "6 GiB", "3 GiB", "512", "REPEATABLE-READ", "sysbench 1.0.20",
    "1 CPU", "1 GiB", "OrbStack", "10 CPU", "16 GiB", "MacBookPro18,1", "sha256:",
  ]) assert.ok(environmentText.includes(expected), expected);
  await noOverflow(page);
  for (const group of await page.locator(".environment-detail").all()) await group.locator("summary").click();
  await page.getByRole("button", { name: "并发 32", exact: true }).click();

  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844], [375, 812]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    await noOverflow(page);
    const geometry = await page.locator(".chart").evaluateAll((nodes) => nodes.map((node) => {
      const svg = node.querySelector("svg");
      return { clientWidth: node.clientWidth, svgWidth: svg.getBoundingClientRect().width };
    }));
    assert.ok(geometry.every((box) => Math.abs(box.clientWidth - box.svgWidth) < 2));
    await page.screenshot({ path: path.join(screenshotDirectory, `mysql-${width}.png`), fullPage: true });
    for (const group of await page.locator(".environment-detail").all()) await group.locator("summary").click();
    await noOverflow(page);
    const labelOverflow = await page.locator(".environment-detail dt").evaluateAll((nodes) => nodes.some((node) => node.scrollWidth > node.clientWidth + 1));
    assert.equal(labelOverflow, false, "environment labels must not overlap their values");
    if (width === 375) {
      await page.screenshot({ path: path.join(screenshotDirectory, "mysql-environment-mobile.png"), fullPage: true });
      await page.locator(".environment-detail").first().screenshot({ path: path.join(screenshotDirectory, "mysql-config-mobile.png") });
    }
    for (const group of await page.locator(".environment-detail").all()) await group.locator("summary").click();
  }
  const touchPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ready(touchPage);
  await touchPage.locator('[data-metric="qps"] .chart-dot[data-scenario="point_select"][data-concurrency="1"]').tap();
  assert.equal(await touchPage.locator("#selected-concurrency").textContent(), "1");
  assert.ok((await touchPage.locator("#selected-body").textContent()).includes("42,421.84"));
  await noOverflow(touchPage);
  await touchPage.close();

  await ready(page, "index.html");
  assert.equal(await page.locator("#index-peak").textContent(), formatNumber(135335.59));
  assert.ok((await page.locator("#index-peak-scope").textContent()).includes("并发 8 · 不稳定"));
  assert.ok((await page.locator("#index-resources").textContent()).includes("4 CPU / 6 GiB"));
  await noOverflow(page);
  await page.screenshot({ path: path.join(screenshotDirectory, "index-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(screenshotDirectory, "index-desktop.png"), fullPage: true });
  await page.getByRole("link", { name: "查看报告", exact: true }).click();
  await page.locator(".chart svg").first().waitFor();
  await page.getByRole("link", { name: "组件索引", exact: true }).click();
  await page.locator("#index-peak").waitFor();

  for (const route of ["mysql.html", "index.html"]) {
    for (const failure of ["http", "json", "schema"]) {
      let attempts = 0;
      await page.route("**/data/mysql.json", (request) => {
        attempts += 1;
        if (attempts > 1) return request.fulfill({ json: data });
        if (failure === "http") return request.fulfill({ status: 500, body: "failed" });
        if (failure === "json") return request.fulfill({ contentType: "application/json", body: "{broken" });
        return request.fulfill({ json: { schemaVersion: 2 } });
      });
      await page.goto(`${url}/${route}`);
      await page.locator('[data-state="error"]').waitFor();
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await page.locator("#report").waitFor({ state: "visible" });
      await page.unroute("**/data/mysql.json");
    }
    const empty = { ...data, environment: {}, series: [], stability: [], rawResults: [] };
    await page.route("**/data/mysql.json", (request) => request.fulfill({ json: empty }));
    await ready(page, route);
    if (route === "mysql.html") {
      assert.equal(await page.locator(".chart-empty").count(), 4);
      assert.equal(await page.locator("#cpu-limit").textContent(), "未记录");
    } else assert.equal(await page.locator("#index-peak").textContent(), "暂无有效数据");
    await page.unroute("**/data/mysql.json");
  }

  const partial = structuredClone(data);
  partial.series[0].points[0].p95Ms = null;
  partial.series[0].points[1].status = "failed";
  partial.series[1].points[0].qps = 0;
  partial.environment.runtime.dockerInfo = "unreadable";
  partial.stability[0].runs.push({ repeat: 999, errors: 1, status: "failed", rawOutputPath: "not-a-report" });
  await page.route("**/data/mysql.json", (request) => request.fulfill({ json: partial }));
  await ready(page);
  assert.equal(await page.locator('[data-metric="qps"] .chart-dot[data-scenario="update_index"][data-concurrency="1"]').count(), 0);
  assert.ok((await page.locator('[data-metric="qps"] .chart-note').textContent()).includes("零值"));
  await page.getByRole("button", { name: "QPS 线性刻度", exact: true }).click();
  assert.equal(await page.locator('[data-metric="qps"] .chart-dot[data-scenario="update_index"][data-concurrency="1"]').getAttribute("data-value"), "0");
  assert.equal(await page.locator('.chart-dot[data-scenario="point_select"][data-concurrency="8"]').count(), 0);
  await page.locator(".result-detail").first().locator("summary").click();
  assert.equal(await page.locator(".result-detail").first().locator("a.run-link").count(), 2);
  await page.unroute("**/data/mysql.json");
  assert.deepEqual(errors, []);
  console.log("Browser checks passed: four viewports, touch/keyboard, all metrics, filters, raw links, environment and failure states.");
  console.log(`Screenshots: ${screenshotDirectory}`);
} finally {
  await browser.close();
  if (server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  if (serverErrors) process.stderr.write(serverErrors);
}
