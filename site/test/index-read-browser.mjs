import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { indexReadFixture } from "../../benchmarks/mysql/scripts/test/fixtures/index-read.mjs";
import { validateIndexExperiment, sha256 } from "../../benchmarks/mysql/scripts/index-read-results.mjs";

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const reportPath=path.join(project,"site/data/mysql.json"),conclusionsPath=path.join(project,"site/data/conclusions.json");
const original=readFileSync(reportPath,"utf8"),originalConclusions=readFileSync(conclusionsPath,"utf8");
const baseline=JSON.parse(original),fixture=indexReadFixture();
const experiment=validateIndexExperiment(fixture.experiment,fixture.reader);
let current={...baseline,indexReadExperiment:experiment};
let conclusions={...JSON.parse(originalConclusions),mysql:{...JSON.parse(originalConclusions).mysql,"index-read":"索引可提高吞吐：测试量化说明"}};
let playwright;
try{playwright=await import("playwright");}catch(error){if(error.code!=="ERR_MODULE_NOT_FOUND")throw error;playwright=await import(pathToFileURL(path.join(execFileSync("npm",["root","-g"],{encoding:"utf8"}).trim(),"playwright/index.mjs")));}
const allocator=createServer();await new Promise(resolve=>allocator.listen(0,"127.0.0.1",resolve));
const port=allocator.address().port;await new Promise(resolve=>allocator.close(resolve));
const server=spawn(process.execPath,["site/server.mjs"],{cwd:project,env:{...process.env,PORT:String(port)},stdio:"ignore"});
const browser=await playwright.chromium.launch({headless:true});
const screenshots="/tmp/performance-profile-index-read";mkdirSync(screenshots,{recursive:true});
try{
  const url=`http://127.0.0.1:${port}/mysql.html`;
  for(let i=0;i<100;i++){try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  const page=await browser.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/data/mysql.json",r=>r.fulfill({json:current}));
  await page.route("**/data/conclusions.json",r=>r.fulfill({json:conclusions}));
  const ready=async()=>{await page.goto(url);await page.locator("#report").waitFor({state:"visible"});};
  await ready();
  assert.equal(await page.locator("#index-read-experiment").isVisible(),true);
  assert.equal(await page.locator('.dashboard .chart-dot[data-scenario="indexed"], .dashboard .chart-dot[data-scenario="table-scan"]').count(),24);
  assert.equal(await page.locator("#scenario-controls input").count(),baseline.series.length+2);
  assert.match(await page.locator("#index-read-comparison").textContent(),/100 倍/);
  assert.equal(await page.locator('[data-summary="formal-dashboard"] strong').last().textContent(),"索引可提高吞吐：");
  assert.equal(await page.locator('#index-read-details .index-read-detail').count(),6);
  await page.getByRole("button",{name:"并发 1",exact:true}).click();
  assert.equal(await page.locator("#selected-concurrency").textContent(),"1");
  await page.getByRole("button",{name:"并发 8",exact:true}).click();
  await page.locator('#scenario-controls input[value="point_select"]').uncheck();
  assert.equal(await page.locator("#selected-concurrency").textContent(),"8");
  assert.equal(await page.locator('.dashboard .chart-dot[data-scenario="indexed"], .dashboard .chart-dot[data-scenario="table-scan"]').count(),24);
  await page.getByRole("button",{name:"QPS 线性刻度",exact:true}).click();
  assert.match(await page.locator('[data-metric="qps"] svg').getAttribute("aria-label"),/线性/);
  assert.equal(await page.getByRole("button",{name:"QPS 对数刻度",exact:true}).getAttribute("aria-pressed"),"false");
  for(const [width,height]of [[1440,900],[1024,768],[390,844],[375,812]]){
    await page.setViewportSize({width,height});await page.locator('#dashboard-title').scrollIntoViewIfNeeded();
    const sizes=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,overflow:[...document.querySelectorAll('#chart-grid .chart')].some(n=>n.scrollWidth>n.clientWidth+1)}));
    assert.ok(sizes.width<=sizes.viewport+1,JSON.stringify(sizes));assert.equal(sizes.overflow,false);
    await page.screenshot({path:path.join(screenshots,`index-read-${width}.png`)});
  }
  const links=await page.locator("#index-read-details a").evaluateAll(nodes=>nodes.map(a=>a.getAttribute("href")));
  assert.ok(links.length>=50&&links.every(h=>h.startsWith("./artifacts/mysql/")));
  for(const invalid of [undefined,{...experiment,purpose:"verification"}, {...experiment,groups:[experiment.groups[0]]},
    {...experiment,groups:[{...experiment.groups[0],points:experiment.groups[0].points.slice(0,2)},experiment.groups[1]]},
    {...experiment,groups:[{...experiment.groups[0],points:experiment.groups[0].points.map(p=>({...p,runs:[{}]}))},experiment.groups[1]]}]){
    current={...baseline,indexReadExperiment:invalid};await ready();
    assert.equal(await page.locator("#index-read-experiment").isHidden(),true);
    assert.equal(await page.locator(".dashboard").isVisible(),true);
  }
  current={...baseline,indexReadExperiment:experiment};conclusions.mysql["index-read"]="";await ready();
  assert.equal((await page.locator('[data-summary="formal-dashboard"]').innerText()).includes("索引可提高吞吐"),false);
  assert.equal(await page.locator("#index-read-experiment").isVisible(),true);
  assert.deepEqual(errors,[]);
  assert.equal(sha256(readFileSync(reportPath,"utf8")),sha256(original));
  assert.equal(sha256(readFileSync(conclusionsPath,"utf8")),sha256(originalConclusions));
  console.log("Index read browser checks passed: same-concurrency ratios, shared dashboard controls, four viewports, optional/invalid data and author-written conclusions. Source report unchanged.");
  console.log(`Verification screenshots: ${screenshots}`);
} finally{await browser.close();server.kill("SIGTERM");}
