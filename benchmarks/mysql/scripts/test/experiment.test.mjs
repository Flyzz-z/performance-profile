import test from "node:test";
import assert from "node:assert/strict";
import { pageMetrics, validateDataset, validateRepeats } from "../experiment.mjs";
import { summarizeRunResources } from "../analytics.mjs";
import { createSysbenchArguments } from "../lib.mjs";
import { validateExpandedRuns } from "../experiment.mjs";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseSysbenchOutput, EXPANDED_SCENARIOS } from "../lib.mjs";
import { loggingMode } from "../logging.mjs";
import { measureRepeats } from "../protocol.mjs";

test("cache counters use a valid window and reject missing/reset counters",()=>{
  const before={timeMs:0,Innodb_buffer_pool_read_requests:100,Innodb_buffer_pool_reads:10};
  const after={timeMs:120000,Innodb_buffer_pool_read_requests:1100,Innodb_buffer_pool_reads:130};
  assert.deepEqual(pageMetrics(before,after),{seconds:120,requests:1000,reads:120,readsPerSecond:1,hitPercent:88});
  for(const invalid of [{...after,timeMs:0},{...after,Innodb_buffer_pool_reads:1},{...after,Innodb_buffer_pool_read_requests:100},{timeMs:120000}]) assert.throws(()=>pageMetrics(before,invalid));
});
test("cache restart verifies startup-only loading without dynamic assignment",()=>{
  const source=readFileSync(new URL("../buffer-pool.mjs",import.meta.url),"utf8");
  const config=readFileSync(new URL("../../config/my.cnf",import.meta.url),"utf8");
  assert.match(config,/innodb_buffer_pool_load_at_startup\s*=\s*OFF/i);
  assert.match(source,/assert\(original\[2\] === 0/);
  for(const statement of source.matchAll(/SET GLOBAL [^;]+;/g))assert.ok(!statement[0].includes("innodb_buffer_pool_load_at_startup"));
});
test("schema evidence enforces primary key, secondary choice and actual working set",()=>{
  const dataset={status:"ready",tableCount:10,tableSize:100000,actualRows:1000000,tables:Array.from({length:10},()=>({indexes:[["PRIMARY","id","0"],["k_1","k","1"]],columns:[["id","int","PRI","auto_increment"],["k","int","MUL",""]]}))};
  validateDataset(dataset);
  assert.throws(()=>validateDataset(dataset,false));
  const cache={...dataset,tableSize:600000,actualRows:6000000,dataBytes:1.5*1024**3};
  validateDataset(cache,true,true);
  assert.throws(()=>validateDataset({...cache,dataBytes:1024**3},true,true));
  const missing=structuredClone(dataset);missing.tables[0].indexes=[];assert.throws(()=>validateDataset(missing));
});
test("same k update is reused and random point selects cover frozen table size",()=>{
  const env={TABLE_COUNT:10,TABLE_SIZE:600000};
  const args=scenario=>createSysbenchArguments({env,scenario,command:"run",concurrency:16,durationSeconds:90});
  assert.deepEqual(args("update_index"),args("update_no_secondary_index"));
  assert.ok(args("point_select").includes("--table-size=600000"));
  assert.ok(args("point_select").includes("--rand-type=uniform"));
});
test("adaptive repetitions require warmup, third observation and insert isolation",()=>{
  const rows=[{scenario:"point_select",concurrency:16,kind:"warmup",repeat:1},...[1,2].map(repeat=>({scenario:"point_select",concurrency:16,kind:"measured",repeat,metrics:{tps:repeat*100,p99Ms:1}}))];
  assert.throws(()=>validateRepeats(rows,"point_select",16),/third/);
  rows.push({...rows[2],repeat:3});validateRepeats(rows,"point_select",16);
  assert.throws(()=>validateRepeats(rows.slice(1),"point_select",16),/warmup/);
});
test("resource averages normalize independently to eight/four CPU",()=>{
  const runs=[{resources:{valid:true,limits:{mysql:{cpus:8},loadgen:{cpus:4}},mysql:{coverageSeconds:120,meanCpuPercent:400,maxCpuPercent:500,periods:1200,throttledPeriods:0,throttledTimeSeconds:0},loadgen:{coverageSeconds:120,meanCpuPercent:200,maxCpuPercent:300,periods:1200,throttledPeriods:0,throttledTimeSeconds:0}}}];
  const summary=summarizeRunResources(runs);assert.equal(summary.mysql.meanQuotaPercent,50);assert.equal(summary.loadgen.meanQuotaPercent,50);
});
test("third observation is required only above thirty percent for TPS or p99",()=>{
  const rows=[{scenario:"point_select",concurrency:16,kind:"warmup",repeat:1},...[1,2].map(repeat=>({scenario:"point_select",concurrency:16,kind:"measured",repeat,metrics:{tps:100,p99Ms:100}}))];
  rows[2].metrics.tps=70;
  validateRepeats(rows,"point_select",16);
  rows[2].metrics.tps=69;
  assert.throws(()=>validateRepeats(rows,"point_select",16),/third/);
  rows[2].metrics={tps:100,p99Ms:70};
  validateRepeats(rows,"point_select",16);
  rows[2].metrics.p99Ms=69;
  assert.throws(()=>validateRepeats(rows,"point_select",16),/third/);
});

test("expanded publication validates all artifacts and rejects old/partial/schema/growth evidence",()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),"mysql-formal-contract-"));
  try {
    const raw=path.join(directory,"run.txt");
    const output=readFileSync(new URL("./fixtures/sysbench-histogram.txt",import.meta.url),"utf8");
    writeFileSync(raw,output);
    const metrics=parseSysbenchOutput(output);
    const sample=timeMs=>({timeMs,cpuUsageNs:timeMs*1e6,periods:timeMs/100,throttledPeriods:0,throttledTimeNs:0});
    const limits={mysql:{cpus:8,memoryBytes:6*1024**3},loadgen:{cpus:4,memoryBytes:1024**3}};
    const capture=path.join(directory,"resources.json");
    writeFileSync(capture,JSON.stringify({intervalMs:5000,samples:Array.from({length:18},(_,i)=>({mysql:sample(i*5000),loadgen:sample(i*5000)})),summary:{limits,errors:[]}}));
    const runs=[];
    for(const scenario of EXPANDED_SCENARIOS) for(const concurrency of [1,8,16]) for(const repeat of [1,2]) {
      const datasetPath=path.join(directory,`${scenario}-${concurrency}-${repeat}.json`);
      const dataset={status:"ready",tableCount:10,tableSize:100000,actualRows:1000000,sqlMode:"STRICT_TRANS_TABLES",tables:Array.from({length:10},()=>({indexes:scenario==="update_no_secondary_index"?[["PRIMARY","id","0"]]:[["PRIMARY","id","0"],["k_1","k","1"]],columns:[["id","int","PRI","auto_increment"],["k","int","",""]]}))};
      writeFileSync(datasetPath,JSON.stringify(dataset));
      const environment={mysql:{...loggingMode(scenario),version:"8.4",bufferPoolBytes:3221225472},container:{mysqlCpuLimit:8,loadGeneratorCpuLimit:4,mysqlMemoryLimit:"6g",loadGeneratorMemoryLimit:"1g",platform:"linux/arm64",imageId:"fixture"},loadGenerator:{sysbenchVersion:"1.0.20"}};
      const run={runId:`${scenario}-${concurrency}-${repeat}`,runGroup:"fixture",purpose:"formal",scenario,concurrency,kind:"measured",repeat,status:"passed",restorationVerified:true,metrics,environment,resources:{rawPath:capture},datasetPath,rawOutputPath:raw,protocol:{warmupSeconds:30,durationSeconds:90,repeatCount:2,adaptiveThresholdPercent:30},command:createSysbenchArguments({env:{TABLE_COUNT:10,TABLE_SIZE:100000},scenario,concurrency,command:"run",durationSeconds:90}).join(" ")};
      if(scenario==="insert")run.rowCounts={beforeWarmup:1000000,afterWarmup:1000100,warmupEvents:100,before:1000100,after:1000200};
      runs.push(run);
      if(repeat===1||scenario==="insert")runs.push({...structuredClone(run),kind:"warmup",protocol:{...run.protocol,durationSeconds:30},...(scenario==="insert"?{rowCounts:{before:1000000,after:1000100}}:{})});
    }
    validateExpandedRuns(runs);
    for(const mutate of [rows=>{rows[0].purpose="verification";},rows=>{rows[0].environment.container.mysqlCpuLimit=4;},rows=>{rows[0].protocol.warmupSeconds=60;},rows=>{rows[0].concurrency=32;},rows=>{rows.pop();},rows=>{rows[0].restorationVerified=false;},rows=>{rows.find(row=>row.scenario==="insert"&&row.kind==="measured").rowCounts.after++;},rows=>{delete rows.find(row=>row.scenario==="insert"&&row.kind==="measured").rowCounts;},rows=>{rows[0].command=rows[0].command.replace("table-size=100000","table-size=10000");}]){
      const invalid=structuredClone(runs);mutate(invalid);assert.throws(()=>validateExpandedRuns(invalid));
    }
    writeFileSync(capture,JSON.stringify({intervalMs:5000,samples:[],summary:{limits,errors:[]}}));
    assert.throws(()=>validateExpandedRuns(runs),/sampling/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test("INSERT adaptive third repeat resets and warms before every measurement",async()=>{
  const sequence=[];
  const result=await measureRepeats({repeatCount:2,thresholdPercent:30,
    beforeRepeat:async repeat=>{sequence.push(`prepare${repeat}`,`warmup${repeat}`);},
    measure:async repeat=>{sequence.push(`measured${repeat}`);return {metrics:{tps:repeat*100,p99Ms:1}};},
  });
  assert.equal(result.length,3);
  assert.deepEqual(sequence,["prepare1","warmup1","measured1","prepare2","warmup2","measured2","prepare3","warmup3","measured3"]);
  const stable=await measureRepeats({repeatCount:2,thresholdPercent:30,measure:async()=>({metrics:{tps:100,p99Ms:1}})});
  assert.equal(stable.length,2);
  await assert.rejects(measureRepeats({repeatCount:2,thresholdPercent:30,beforeRepeat:()=>{throw Error("prepare failed");},measure:()=>assert.fail("must not measure")}),/prepare failed/);
});
