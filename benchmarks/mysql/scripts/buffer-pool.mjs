#!/usr/bin/env node
import path from "node:path";
import { readFileSync } from "node:fs";
import { PATHS, assert, loadBenchmarkEnv, mysqlQuery, runProcess, compose, waitForMysql, readJson, writeJson, listFiles, nowIso, sleep, parseCliArguments } from "./lib.mjs";
import { pageMetrics, validateExperimentRun, validateRepeats } from "./experiment.mjs";
import { summarizeCombination, computeStats, summarizeRunResources } from "./analytics.mjs";

const cli = parseCliArguments(process.argv.slice(2));
const group = String(cli["run-group"]);
assert(/^[a-zA-Z0-9_-]+$/.test(group), "Invalid buffer pool group");
const env = loadBenchmarkEnv();
const aborter = new AbortController();
const onSignal = () => aborter.abort();
process.on("SIGINT",onSignal);
process.on("SIGTERM",onSignal);
const query = sql => mysqlQuery(env,sql);
const execute = async (script,args) => {
  const result = await runProcess(process.execPath,[path.join(PATHS.benchmarkRoot,"scripts",script),...args],{echo:true,signal:aborter.signal});
  assert(result.code === 0, `${script} failed`);
};
const original = (await query("SELECT @@innodb_buffer_pool_size,@@innodb_buffer_pool_dump_at_shutdown,@@innodb_buffer_pool_load_at_startup;")).split("\t").map(Number);
assert(original[2] === 0, "Disable Buffer Pool load at startup in my.cnf before the cache experiment");
const prefix = `${group}-cache-dataset`;
let dataset;
let tableSize = 600000;
let environmentPath;
let datasetPath;
const groups = [];
try {
  for (let attempt=1;attempt<=3;attempt++) {
    const current = `${prefix}-a${attempt}`;
    await execute("prepare.mjs",[`--manifest-prefix=${current}`,`--table-size=${tableSize}`,`--container-name=${group}-prepare`]);
    datasetPath = path.join(PATHS.resultsDir,`${current}-dataset.json`);
    environmentPath = path.join(PATHS.resultsDir,`${current}-environment.json`);
    dataset = readJson(datasetPath);
    if (dataset.dataBytes >= 1.4*1024**3 && dataset.dataBytes <= 1.6*1024**3) break;
    tableSize = Math.round(tableSize * 1.5*1024**3 / dataset.dataBytes / 1000)*1000;
    dataset = undefined;
  }
  assert(dataset, "Cannot calibrate cache working set to 1.4–1.6 GiB");
  console.log(`Frozen cache dataset: ${dataset.actualRows} rows, ${(dataset.dataBytes/1024**3).toFixed(3)} GiB clustered allocation`);
  for (const gib of [1,2]) {
    await query("SET GLOBAL innodb_buffer_pool_dump_at_shutdown=OFF;");
    const restart = await compose(env,["restart","mysql"]);
    assert(restart.code===0,"MySQL restart failed");
    await waitForMysql(env);
    await query(`SET GLOBAL innodb_buffer_pool_size=${gib*1024**3}, GLOBAL innodb_buffer_pool_dump_at_shutdown=OFF;`);
    for(let i=0;i<120;i++) {
      const status = await query("SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_resize_status';");
      if (/Completed|complete/i.test(status)) break;
      await sleep(1000);
    }
    const [bytes,instances,chunk,dump,load] = (await query("SELECT @@innodb_buffer_pool_size,@@innodb_buffer_pool_instances,@@innodb_buffer_pool_chunk_size,@@innodb_buffer_pool_dump_at_shutdown,@@innodb_buffer_pool_load_at_startup;")).split("\t").map(Number);
    assert(bytes===gib*1024**3 && instances===1 && chunk===128*1024**2 && dump===0 && load===0,"Actual cache configuration mismatch");
    const environment = readJson(environmentPath);
    environment.mysql = {...environment.mysql, bufferPoolBytes:bytes, bufferPoolInstances:instances, bufferPoolChunkBytes:chunk, bufferPoolDumpAtShutdown:dump, bufferPoolLoadAtStartup:load};
    const snapshot = path.join(PATHS.resultsDir,`${group}-cache${gib}-environment.json`);
    writeJson(snapshot,environment);
    const runGroup = `${group}-cache${gib}`;
    await execute("run.mjs",[`--run-group=${runGroup}`,"--scenario=point_select","--concurrency=16","--warmup-seconds=30","--duration-seconds=90","--runs=2","--purpose=formal","--record-resources","--buffer-pool",`--environment-path=${snapshot}`,`--dataset-path=${datasetPath}`,`--container-name=${group}-load`]);
    const runs = listFiles(PATHS.rawDir,".meta.json").map(file=>({file,run:readJson(file)})).filter(item=>item.run.runGroup===runGroup);
    groups.push({gib,bytes,environment,runs});
  }
} finally {
  for (const name of [`${group}-prepare`,`${group}-load`]) {
    const found = await runProcess("docker",["inspect",name]);
    if(found.code===0) assert((await runProcess("docker",["rm","-f",name])).code===0,"Cannot stop cache test container");
  }
  await query(`SET GLOBAL innodb_buffer_pool_size=${original[0]}, GLOBAL innodb_buffer_pool_dump_at_shutdown=${original[1]};`);
  const restored = (await query("SELECT @@innodb_buffer_pool_size,@@innodb_buffer_pool_dump_at_shutdown,@@innodb_buffer_pool_load_at_startup;")).split("\t").map(Number);
  assert(JSON.stringify(restored)===JSON.stringify(original),"Cache configuration restoration failed");
  process.off("SIGINT",onSignal);
  process.off("SIGTERM",onSignal);
}

const results = groups.map(({gib,bytes,environment,runs})=>{
  for (const {file,run} of runs) {run.restorationVerified=true;writeJson(file,run);validateExperimentRun(run,bytes);}
  const measured = validateRepeats(runs.map(item=>item.run),"point_select",16);
  const summary = summarizeCombination(measured);
  const pages = measured.map(run=>pageMetrics(run.bufferPool.before,run.bufferPool.after));
  const selected = key => {const stat=computeStats(pages.map(p=>p[key])); return measured.length===3?stat.median:stat.mean;};
  const warmup = runs.find(item=>item.run.kind==="warmup").run;
  const warmupOutput = readFileSync(path.resolve(PATHS.projectRoot,warmup.rawOutputPath),"utf8");
  const qpsSegments = [...warmupOutput.matchAll(/\[\s*([\d.]+)s\s*\].*?qps:\s*([\d.]+)/g)].map(match=>({seconds:Number(match[1]),qps:Number(match[2])}));
  const missSegments = warmup.bufferPool.samples.slice(1).flatMap((point,i)=>{
    const previous=warmup.bufferPool.samples[i];
    return point.timeMs-previous.timeMs>=5000 && point.Innodb_buffer_pool_read_requests>previous.Innodb_buffer_pool_read_requests ? [pageMetrics(previous,point)] : [];
  });
  const steady = values => values.length>=2 && Math.abs(values.at(-1)-values.at(-2))/Math.max(values.at(-1),values.at(-2),1) <= .1;
  return {gib,bytes,environment,...summary,selected:{...summary.selected,hitPercent:selected("hitPercent"),readsPerSecond:selected("readsPerSecond")}, resources:summarizeRunResources(measured),
    warmup:{...warmup.bufferPool,metrics:pageMetrics(warmup.bufferPool.before,warmup.bufferPool.after),rawOutputPath:warmup.rawOutputPath,qpsSegments,missSegments,steady:steady(qpsSegments.map(s=>s.qps)) && steady(missSegments.filter(s=>s.seconds>=5).map(s=>s.readsPerSecond))},
    runs:measured.map((run,i)=>({...run,pageMetrics:pages[i]}))};
});
assert(results.length===2,"Incomplete cache experiment");
writeJson(path.join(PATHS.summaryDir,`${group}-buffer-pool.json`),{runGroup:group,purpose:"formal",generatedAt:nowIso(),concurrency:16,protocol:{warmupSeconds:30,durationSeconds:90,initialRuns:2,maximumRuns:3,varianceThresholdPercent:30},dataset,datasetPath:path.relative(PATHS.projectRoot,datasetPath),restorationVerified:true,groups:results});
console.log("Independent Buffer Pool experiment complete; report not published yet.");
