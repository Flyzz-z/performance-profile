import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatNumber, formatLatency, formatMemory, formatDate, peakPoint, projectReport, stabilityLabel } from "../report.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const data = JSON.parse(readFileSync(path.join(project, "site/data/mysql.json")));
const seriesCount = data.series.length;
const expectedPeak = peakPoint(projectReport(data));
const readSeries = data.series.find((s) => s.scenario === "point_select");
const read8 = readSeries.points.find((p) => p.concurrency === 8);
const read1 = readSeries.points.find((p) => p.concurrency === 1);
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

async function noProcessNotice(page) {
  assert.equal(await page.locator("#durability-risk").count(), 0);
  const content = await page.locator("body").innerText();
  for (const phrase of ["降低持久化保障", "丢失已确认事务", "历史背景参照", "历史曲线", "历史批次",
    "本轮正式测量", "同批日志策略对照"]) {
    assert.ok(!content.includes(phrase), `Unexpected process notice: ${phrase}`);
  }
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
  await noProcessNotice(page);
  assert.equal(await page.locator("#experiment-conclusions").isVisible(), true);
  assert.equal(await page.locator(".conclusion-item").count(), 4);
  assert.equal(await page.locator('[data-conclusion="read-write"] strong').textContent(), "约 140 倍");
  assert.ok((await page.locator('[data-conclusion="read-write"]').textContent()).includes("0.22 / 43.39 ms"));
  assert.equal(await page.locator('[data-conclusion="write-policy"] strong').textContent(), "5.4 倍");
  assert.equal(await page.locator('[data-conclusion="buffer-pool"] strong').textContent(), "+15.5%");
  assert.equal(await page.locator('[data-conclusion="hot-update"] strong').textContent(), "-27.3%");
  const conclusionText = await page.locator("#experiment-conclusions").textContent();
  assert.equal(await page.locator(".chart-panel").count(), 4);
  assert.equal(await page.locator(".chart-dot").count(), data.series.flatMap((s) => s.points).length * 4);
  assert.equal(await page.locator("#comparison-grid").count(), 0);
  assert.equal(await page.locator("#cpu-limit").textContent(), `${data.environment.container.mysqlCpuLimit} CPU`);
  assert.equal(await page.locator("#memory-limit").textContent(), "6 GiB");
  assert.equal(await page.locator("#buffer-pool").textContent(), "3 GiB");
  assert.equal(await page.locator("#report-time").textContent(), formatDate(data.component.testedAt));
  const highestConcurrency = Math.max(...projectReport(data).concurrency);
  assert.equal(await page.locator("#selected-concurrency").textContent(), String(highestConcurrency));
  assert.equal(await page.locator("#selected-body tr[data-scenario]").count(),
    data.series.filter(s=>s.points.some(p=>p.concurrency===highestConcurrency)).length);
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
  assert.equal(await page.locator("#experiment-conclusions").textContent(), conclusionText);
  assert.equal(await page.locator("#selected-concurrency").textContent(), "8");
  const read = page.locator('#selected-body tr[data-scenario="point_select"]');
  assert.ok((await read.textContent()).includes(formatNumber(read8.qps)));
  assert.ok((await read.textContent()).includes(stabilityLabel(read8.stability)));
  await page.getByRole("button", { name: "TPS 线性刻度", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "TPS 线性刻度", exact: true }).getAttribute("aria-pressed"), "true");
  assert.match(await page.locator('[data-metric="tps"] svg').getAttribute("aria-label"), /线性/);
  await page.locator('input[value="update_index"]').uncheck();
  assert.equal(await page.locator('.chart-dot[data-scenario="update_index"]').count(), 0);
  assert.equal(await page.locator("#selected-body tr").count(), seriesCount - 1);
  assert.equal(await page.locator("#selected-concurrency").textContent(), "8");
  for (const checkbox of await page.locator("#scenario-controls input").all()) await checkbox.uncheck();
  assert.equal(await page.locator(".chart-empty").count(), 4);
  for (const checkbox of await page.locator("#scenario-controls input").all()) await checkbox.check();
  await page.getByRole("button", { name: "TPS 对数刻度", exact: true }).click();
  const keyboardButton = page.getByRole("button", { name: "并发 1", exact: true });
  await keyboardButton.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#selected-concurrency").textContent(), "1");
  assert.equal(await keyboardButton.evaluate((node) => document.activeElement === node), true);
  assert.ok((await page.locator("#selected-body").textContent()).includes(formatLatency(read1.p95Ms)));
  await page.locator('[data-metric="qps"] .chart-dot[data-scenario="point_select"][data-concurrency="8"]').hover();
  assert.ok((await page.locator(".chart-tooltip").textContent()).includes(formatNumber(read8.qps)));
  const tooltipBox = await page.locator(".chart-tooltip").boundingBox();
  const chartBox = await page.locator('[data-metric="qps"] .chart').boundingBox();
  assert.ok(tooltipBox.x >= chartBox.x && tooltipBox.x + tooltipBox.width <= chartBox.x + chartBox.width + 1);
  await page.locator("h1").hover();
  assert.equal(await page.locator(".chart-tooltip").count(), 0);
  assert.equal(await page.locator(".result-detail").count(), data.series.flatMap((s) => s.points).length);
  const mixedLabel = "读写混合（读:写 = 7:2）";
  for (const selector of ["#scenario-controls", "#selected-body"]) {
    assert.ok((await page.locator(selector).textContent()).includes(mixedLabel));
  }
  assert.equal(await page.locator(".result-detail summary").filter({ hasText: mixedLabel }).count(),
    data.series.find((series) => series.scenario === "read_write").points.length);
  for (const detail of await page.locator(".result-detail").all()) await detail.locator("summary").click();
  assert.equal(await page.locator("a.run-link").count(), data.rawResults.length);
  for (const link of await page.locator("a.run-link").all()) {
    const response = await page.request.get(new URL(await link.getAttribute("href"), `${url}/mysql.html`).href);
    assert.equal(response.status(), 200);
  }
  await noProcessNotice(page);
  assert.ok((await page.locator(".run-context").first().textContent()).includes(
    formatDate(data.stability[0].testedAt ?? data.series[0].testedAt)));
  if (data.formalExperiment?.purpose === "formal") {
    assert.equal(await page.locator('[data-resource-column]:visible').count(), 2);
    assert.ok((await page.locator("#dashboard-scope").textContent()).includes("sysbench 4 CPU"));
    assert.equal(await page.locator("a.resource-link").count(), data.rawResults.length);
    for (const link of await page.locator("a.resource-link").all()) {
      const response = await page.request.get(new URL(await link.getAttribute("href"), `${url}/mysql.html`).href);
      assert.equal(response.status(), 200);
      const resource = await response.json();
      assert.equal(resource.summary.valid, true);
      assert.ok(resource.summary.coverageSeconds >= data.protocol.durationSeconds * .8);
      assert.equal(resource.summary.limits.loadgen.cpus, 4);
    }
  }
  for (const detail of await page.locator(".result-detail").all()) await detail.locator("summary").click();
  for (const group of await page.locator(".environment-detail").all()) await group.locator("summary").click();
  const environmentText = await page.locator("#environment-groups").textContent();
  for (const expected of [
    `${data.environment.container.mysqlCpuLimit} CPU`, "6 GiB", "3 GiB", "512", "REPEATABLE-READ", "sysbench 1.0.20",
    `${data.environment.container.loadGeneratorCpuLimit} CPU`, "1 GiB", "OrbStack", "10 CPU", "16 GiB", "MacBookPro18,1", "sha256:",
  ]) assert.ok(environmentText.includes(expected), expected);
  await noOverflow(page);
  for (const group of await page.locator(".environment-detail").all()) await group.locator("summary").click();
  await page.getByRole("button", { name: `并发 ${highestConcurrency}`, exact: true }).click();

  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844], [375, 812]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    await noOverflow(page);
    assert.equal(await page.locator(".conclusion-item").evaluateAll(nodes =>
      nodes.some(node => node.scrollWidth > node.clientWidth + 1)), false, "summary text must fit");
    if (width === 1440 || width === 375) {
      await page.locator("#experiment-conclusions").screenshot({ path: path.join(screenshotDirectory, `conclusions-${width}.png`) });
    }
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
  assert.ok((await touchPage.locator("#selected-body").textContent()).includes(formatNumber(read1.qps)));
  await noOverflow(touchPage);
  await touchPage.close();

  await ready(page, "index.html");
  await noProcessNotice(page);
  assert.equal(await page.locator("#index-peak").textContent(), formatNumber(expectedPeak.qps));
  assert.ok((await page.locator("#index-peak-scope").textContent()).includes(`并发 ${expectedPeak.concurrency} · ${stabilityLabel(expectedPeak.stability)}`));
  assert.equal(await page.locator("#index-tested-at").textContent(),formatDate(expectedPeak.testedAt));
  assert.ok((await page.locator("#index-resources").textContent()).includes(`${data.environment.container.mysqlCpuLimit} CPU / 6 GiB`));
  await noOverflow(page);
  await page.screenshot({ path: path.join(screenshotDirectory, "index-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(screenshotDirectory, "index-desktop.png"), fullPage: true });
  await page.locator('a[href="./mysql.html"]', { hasText: "查看报告" }).click();
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
  assert.equal(await page.locator(".result-detail").first().locator("a.run-link").count(), data.stability[0].runs.length);
  await page.unroute("**/data/mysql.json");
  const four = structuredClone(data);
  delete four.concurrencySupplement;
  for(const series of four.series) series.points = series.points.filter(p=>p.concurrency!==32);
  four.stability = four.stability.filter(row=>row.concurrency!==32);
  four.rawResults = four.rawResults.filter(row=>row.concurrency!==32);
  delete four.hotUpdateExperiment;
  four.series = four.series.filter((s) => ["point_select","update_index","read_write"].includes(s.scenario));
  delete four.bufferPoolExperiment;
  const synchronous = four.series.find((s) => s.scenario === "update_index");
  synchronous.label = "索引更新（同步刷盘）";
  synchronous.environment = { mysql: { flushLogAtTransactionCommit: 1, syncBinlog: 1, flushLogAtTimeout: 1, logBinEnabled: true } };
  four.series.push({ ...structuredClone(synchronous), scenario: "update_index_async", label: "索引更新（异步刷盘）",
    environment: { mysql: { flushLogAtTransactionCommit: 2, syncBinlog: 0, flushLogAtTimeout: 1, logBinEnabled: true } } });
  four.durabilityComparison = { risk: "异步刷盘降低持久化保障；VM、系统或断电故障可能丢失已确认事务或 binlog。",
    note: "新同步/异步更新同批测量；点查和读写混合来自历史批次，仅作背景参照。" };
  await page.route("**/data/mysql.json", (request) => request.fulfill({ json: four }));
  await ready(page);
  assert.equal(await page.locator("#scenario-controls input").count(), 4);
  assert.equal(await page.locator("#hot-update-experiment").isVisible(), false);
  assert.equal(await page.locator('.chart-dot[data-scenario="update_index_async"]').count(), 12);
  await noProcessNotice(page);
  const asyncEnvironment = page.locator(".environment-detail").filter({ hasText: "索引更新（异步刷盘） · 日志配置" });
  await asyncEnvironment.locator("summary").click();
  assert.ok((await asyncEnvironment.textContent()).includes("sync_binlog0"));
  await noOverflow(page);
  await page.screenshot({ path: path.join(screenshotDirectory, "four-series-fixture.png"), fullPage: true });
  await page.unroute("**/data/mysql.json");
  const formalFixture = structuredClone(four);
  formalFixture.formalExperiment = { purpose: "formal", runGroup: "fixture-formal4" };
  formalFixture.environment.container.loadGeneratorCpuLimit = 4;
  formalFixture.durabilityComparison.note = "四场景同轮正式测量，不包含历史或验证";
  for (const series of formalFixture.series) {
    series.sourceRole = "formal";
    for (const point of series.points) point.resources = {
      mysql: { meanQuotaPercent: 95 }, loadgen: { meanQuotaPercent: 38 },
    };
  }
  await page.route("**/data/mysql.json", (request) => request.fulfill({ json: formalFixture }));
  await ready(page);
  await noProcessNotice(page);
  assert.equal(await page.locator('[data-resource-column]:visible').count(), 2);
  assert.ok((await page.locator("#selected-body").textContent()).includes("95%"));
  assert.ok((await page.locator("#selected-body").textContent()).includes("38%"));
  assert.ok((await page.locator("#dashboard-scope").textContent()).includes("sysbench 4 CPU"));
  assert.ok(!(await page.locator("#dashboard-scope").textContent()).includes("历史曲线"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(screenshotDirectory, "formal-presentation-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await noOverflow(page);
  await page.screenshot({ path: path.join(screenshotDirectory, "formal-presentation-mobile.png"), fullPage: true });
  await page.unroute("**/data/mysql.json");
  const expanded = structuredClone(formalFixture);
  expanded.environment.container.mysqlCpuLimit = 8;
  expanded.protocol.concurrency = [1,8,16];
  expanded.protocol.warmupSeconds = 30;
  for (const [scenario,label] of [["update_no_secondary_index","无二级索引更新"],["insert","单行插入"]]) {
    expanded.series.push({...structuredClone(expanded.series.find(s=>s.scenario==="update_index")),scenario,label});
  }
  for(const series of expanded.series) {
    series.points.forEach(point=>{if(point.concurrency===32)point.concurrency=16;});
  }
  expanded.stability = expanded.stability.map(row=>({...row,concurrency:row.concurrency===32?16:row.concurrency}));
  for (const scenario of ["update_no_secondary_index","insert"]) {
    expanded.stability.push(...expanded.stability.filter(row=>row.scenario==="update_index").map(row=>({...structuredClone(row),scenario,dataset:{tables:[{}],secondaryIndex:scenario!=="update_no_secondary_index"},runs:row.runs.map(run=>({...run,...(scenario==="insert"?{rowCounts:{beforeWarmup:1000000,afterWarmup:1001000,before:1001000,after:1011000}}:{})}))})));
  }
  expanded.bufferPoolExperiment = {concurrency:16,dataset:{...data.dataset,actualRows:6000000,tableSize:600000,dataBytes:1.5*1024**3},datasetPath:data.stability[0].runs[0].datasetPath ?? "benchmarks/mysql/results/dataset.json",protocol:{warmupSeconds:30,durationSeconds:90,varianceThresholdPercent:30},groups:[1,2].map(gib=>({gib,bytes:gib*1024**3,attempts:2,stability:"stable",environment:{...expanded.environment,mysql:{...expanded.environment.mysql,bufferPoolBytes:gib*1024**3,bufferPoolInstances:1,bufferPoolChunkBytes:128*1024**2}},selected:{qps:gib*100000,p95Ms:.2,p99Ms:.3,hitPercent:gib===1?90:99.99,readsPerSecond:gib===1?10000:10},resources:{mysql:{meanQuotaPercent:40},loadgen:{meanQuotaPercent:30}},runs:[]}))};
  await page.route("**/data/mysql.json", request=>request.fulfill({json:expanded}));
  await ready(page);
  assert.equal(await page.locator("#scenario-controls input").count(),6);
  assert.equal(await page.locator(".chart-dot").count(),72);
  assert.equal(await page.locator("#cpu-limit").textContent(),"8 CPU");
  assert.equal(await page.locator("#selected-concurrency").textContent(),"16");
  assert.equal(await page.locator(".cache-bar-row").count(),8);
  const insertDetail = page.locator('.result-detail[data-scenario="insert"]').first();
  await insertDetail.locator("summary").click();
  assert.ok((await insertDetail.textContent()).includes("预热前 1,000,000"));
  assert.ok((await page.locator('.result-detail[data-scenario="update_no_secondary_index"]').first().textContent()).includes("k 二级索引 无"));
  const cacheBefore = await page.locator("#buffer-pool-results").textContent();
  await page.getByRole("button",{name:"并发 8",exact:true}).click();
  assert.equal(await page.locator("#buffer-pool-results").textContent(),cacheBefore);
  for(const width of [1440,390,375]) {
    await page.setViewportSize({width,height:900});await noOverflow(page);
    await page.screenshot({path:path.join(screenshotDirectory,`expanded-fixture-${width}.png`),fullPage:true});
  }
  await page.unroute("**/data/mysql.json");
  const sparse = structuredClone(expanded);
  for(const scenario of ["point_select","update_index"]) {
    const series = sparse.series.find(s=>s.scenario===scenario);
    series.points.push({...structuredClone(series.points.at(-1)),concurrency:32,
      testedAt:"2026-10-08T09:00:00Z",runGroup:"fixture-supplement"});
  }
  await page.route("**/data/mysql.json",request=>request.fulfill({json:sparse}));
  await ready(page);
  assert.equal(await page.locator("#selected-concurrency").textContent(),"32");
  assert.deepEqual(await page.locator("#selected-body tr").evaluateAll(nodes=>nodes.map(n=>n.dataset.scenario)),
    ["point_select","update_index"]);
  assert.equal(await page.locator('.chart-dot[data-concurrency="32"]').count(),8);
  await page.locator('[data-metric="qps"] .chart-dot[data-scenario="point_select"][data-concurrency="32"]').hover();
  assert.equal(await page.locator(".chart-tooltip > div").count(),2);
  assert.ok(!(await page.locator(".chart-tooltip").textContent()).includes("未记录"));
  await page.locator("h1").hover();
  const independentCache = await page.locator("#buffer-pool-results").textContent();
  await page.locator('input[value="point_select"]').uncheck();
  await page.locator('input[value="update_index"]').uncheck();
  assert.ok((await page.locator("#selected-body").textContent()).includes("该并发无已测结果"));
  assert.equal(await page.locator("#buffer-pool-results").textContent(),independentCache);
  for(const checkbox of await page.locator("#scenario-controls input").all()) await checkbox.check();
  for(const width of [1440,375]) {
    await page.setViewportSize({width,height:900});await noOverflow(page);
    await page.screenshot({path:path.join(screenshotDirectory,`sparse-fixture-${width}.png`),fullPage:true});
  }
  await page.unroute("**/data/mysql.json");
  const hotFixture = structuredClone(data);
  hotFixture.hotUpdateExperiment = { testedAt: "2026-10-07T04:00:00Z", protocol: { concurrency:16,warmupSeconds:30,durationSeconds:60,repeats:1 }, groups: ["distributed","hot"].map((id,i) => ({
    id, label:i ? "热点更新" : "分散更新", activeRows:i ? 10 : 1000000, idLimit:i ? 1 : 100000,
    environment:data.environment, environmentPath:"benchmarks/mysql/results/environment.json", datasetPath:"benchmarks/mysql/results/dataset.json",
    metrics:{tps:i ? 6000 : 10000,p95Ms:1,p99Ms:2,failureCount:i ? 3 : 0,reconnects:1},
    locks:{seconds:62,waits:0,waitsPerSecond:0,waitMs:0,meanWaitMs:0},
    resources:{mysql:{meanQuotaPercent:20},loadgen:{meanQuotaPercent:15}},
    runs:[{rawOutputPath:data.rawResults[0].rawOutputPath},{rawOutputPath:data.rawResults[0].rawOutputPath,resourcePath:data.stability[0].runs[0].resources.rawPath,lockPath:data.stability[0].runs[0].resources.rawPath}],
  })) };
  await page.route("**/data/mysql.json", request => request.fulfill({json:hotFixture}));
  await ready(page);
  assert.equal(await page.locator("#hot-update-experiment").isVisible(),true);
  assert.equal(await page.locator("#hot-update-results .cache-bar-row").count(),8);
  assert.deepEqual(await page.locator(".hot-failures").allTextContents(),["0","3"]);
  assert.equal(await page.locator("#hot-update-results .status").count(),0);
  assert.equal(await page.locator(".hot-run-detail").count(),2);
  const hotBefore = await page.locator("#hot-update-results").textContent();
  for(const checkbox of await page.locator("#scenario-controls input").all()) await checkbox.uncheck();
  await page.getByRole("button",{name:"并发 8",exact:true}).click();
  assert.equal(await page.locator("#hot-update-results").textContent(),hotBefore);
  for(const width of [1440,390,375]) {
    await page.setViewportSize({width,height:900});
    await noOverflow(page);
    for(const detail of await page.locator(".hot-run-detail").all()) await detail.evaluate(node=>{node.open=true;});
    await noOverflow(page);
    await page.locator("#hot-update-experiment").screenshot({path:path.join(screenshotDirectory,`hot-fixture-${width}.png`)});
  }
  await page.unroute("**/data/mysql.json");
  await ready(page);
  if(data.hotUpdateExperiment) {
    const allArtifacts = [...new Set(await page.locator('a[href*="artifacts/mysql/"]').evaluateAll(nodes => nodes.map(node => node.href)))];
    for(const href of allArtifacts) assert.equal((await page.request.get(href)).status(),200,href);
    console.log(`All ${allArtifacts.length} unique artifact links return HTTP 200.`);
    for(const link of await page.locator("a.hot-artifact-link").all()) {
      assert.equal((await page.request.get(new URL(await link.getAttribute("href"),url).href)).status(),200);
    }
    for(const width of [1440,375]) {
      await page.setViewportSize({width,height:900});
      for(const detail of await page.locator(".hot-run-detail").all()) await detail.evaluate(node=>{node.open=true;});
      await noOverflow(page);
      await page.locator("#hot-update-experiment").screenshot({path:path.join(screenshotDirectory,`hot-actual-${width}.png`)});
    }
  }
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
