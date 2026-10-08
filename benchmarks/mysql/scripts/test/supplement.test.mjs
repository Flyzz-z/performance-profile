import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { PATHS, createSysbenchArguments, parseSysbenchOutput } from "../lib.mjs";
import { summarizeResources } from "../resources.mjs";
import { LOGGING_MODES } from "../logging.mjs";
import { SUPPLEMENT_PROTOCOL, validateSupplement, mergeSupplement, publishSupplement } from "../supplement-results.mjs";

const baselineReport = JSON.parse(readFileSync(path.join(PATHS.siteDataDir,"mysql.json")));
delete baselineReport.concurrencySupplement;
for(const series of baselineReport.series) series.points=series.points.filter(p=>p.concurrency!==32);
baselineReport.stability=baselineReport.stability.filter(c=>c.concurrency!==32);
baselineReport.rawResults=baselineReport.rawResults.filter(r=>r.concurrency!==32);
baselineReport.headline.peak={...baselineReport.series[0].points.at(-1),scenario:"point_select"};

function fixture(group="fixture32") {
  const evidence=new Map();
  const prefix=`benchmarks/mysql/results/${group}`;
  const environment=structuredClone(baselineReport.environment);
  environment.loadGenerator.imageId=baselineReport.hotUpdateExperiment?.groups[0].environment.loadGenerator.imageId ?? "fixture-arm-image";
  environment.loadGenerator.imagePlatform="linux/arm64";
  const sample=timeMs=>({timeMs,cpuUsageNs:timeMs*1e6,periods:timeMs/100,throttledPeriods:0,throttledTimeNs:0});
  const limits={mysql:{cpus:8,memoryBytes:6*1024**3},loadgen:{cpus:4,memoryBytes:1024**3}};
  const capture={intervalMs:5000,samples:Array.from({length:18},(_,i)=>({mysql:sample(i*5000),loadgen:sample(i*5000)}))};
  capture.summary=summarizeResources(capture.samples,limits,90,[],5000);
  const experiment={purpose:"formal",runGroup:group,protocol:SUPPLEMENT_PROTOCOL,
    restorationVerified:true,restorationPath:`${prefix}-restoration.json`,finishedAt:"2026-10-08T10:00:00Z",runs:[]};
  evidence.set(experiment.restorationPath,{runGroup:group,bufferPoolBytes:3221225472,logging:structuredClone(LOGGING_MODES.update_index)});
  const rawTemplate=readFileSync(new URL("./fixtures/sysbench-histogram.txt",import.meta.url),"utf8");
  for(const scenario of ["point_select","update_index"]) {
    const environmentPath=`${prefix}-${scenario}-environment.json`;
    const datasetPath=`${prefix}-${scenario}-dataset.json`;
    evidence.set(environmentPath,environment);
    evidence.set(datasetPath,{...baselineReport.dataset,tables:Array.from({length:10},(_,i)=>({
      name:`sbtest${i+1}`,indexes:[["PRIMARY","id","0"],["k_1","k","1"]],
      columns:[["id","int","PRI","auto_increment"],["k","int","",""]] }))});
    for(const [kind,repeat] of [["warmup",1],["measured",1],["measured",2]]) {
      const seconds=kind==="warmup"?30:90;
      const runId=`${group}-${scenario}-c32-${kind}-r${repeat}`;
      const rawOutputPath=`${prefix}-${runId}.txt`;
      const raw=rawTemplate.replace("Number of threads: 1","Number of threads: 32").replace("2.0001s",`${seconds}.0001s`);
      const args=createSysbenchArguments({env:{MYSQL_DATABASE:baselineReport.dataset.database,MYSQL_ROOT_PASSWORD:"***",TABLE_COUNT:10,TABLE_SIZE:100000},scenario,concurrency:32,durationSeconds:seconds,command:"run"});
      const run={runId,runGroup:group,purpose:"formal",scenario,concurrency:32,kind,repeat,exitCode:0,status:"passed",
        restorationVerified:true,protocol:{...SUPPLEMENT_PROTOCOL,durationSeconds:seconds},arguments:args,command:args.join(" "),
        finishedAt:"2026-10-08T09:00:00Z",environment,environmentPath,datasetPath,rawOutputPath,
        metadataPath:`${prefix}-${runId}.meta.json`,metrics:parseSysbenchOutput(raw)};
      evidence.set(rawOutputPath,raw);
      if(kind==="measured") {
        run.resources={...capture.summary,rawPath:`${prefix}-${runId}.resources.json`};
        evidence.set(run.resources.rawPath,structuredClone(capture));
      }
      experiment.runs.push(run);
    }
  }
  const sync=()=>{for(const run of experiment.runs)evidence.set(run.metadataPath,structuredClone(run));};
  sync();
  return {experiment,evidence,environment,sync,reader:{json:file=>structuredClone(evidence.get(file)),text:file=>evidence.get(file)}};
}

test("32 supplement validates raw evidence and preserves every baseline field on merge",()=>{
  const f=fixture();
  const before=structuredClone(baselineReport);
  const combinations=validateSupplement(f.experiment,baselineReport.environment,f.reader);
  assert.equal(combinations.length,2);
  assert.equal(combinations[0].selected.tps,50);
  const merged=mergeSupplement(baselineReport,f.experiment,combinations);
  assert.deepEqual(baselineReport,before);
  for(const [i,series] of before.series.entries()) {
    assert.deepEqual(merged.series[i].points.filter(p=>p.concurrency!==32),series.points);
    assert.equal(merged.series[i].testedAt,series.testedAt);
  }
  for(const key of ["protocol","component","bufferPoolExperiment","hotUpdateExperiment","comparisons","environment"])
    assert.ok(isDeepStrictEqual(merged[key],before[key]),key);
  assert.equal(merged.series.filter(s=>s.points.some(p=>p.concurrency===32)).length,2);
  assert.throws(()=>mergeSupplement(merged,f.experiment,combinations),/already/);
});

test("rejects missing/mixed/unapproved scope, invalid protocol, metadata and restoration",()=>{
  const mutations=[f=>f.experiment.runs.pop(),f=>f.experiment.runs[0].runGroup="other",
    f=>f.experiment.runs[0].concurrency=16,f=>f.experiment.runs[0].scenario="insert",
    f=>f.experiment.restorationVerified=false,f=>f.experiment.purpose="verification",
    f=>f.experiment.runs[1].exitCode=1,f=>f.experiment.runs[1].protocol.durationSeconds=60,
    f=>f.experiment.runs[0].environment.mysql.version="old",
    f=>f.experiment.runs[1].arguments.push("--threads=16"),
    f=>f.experiment.runs[1].rawOutputPath="benchmarks/mysql/results/verification/run.txt",
    f=>f.evidence.get(f.experiment.restorationPath).logging.syncBinlog=0,
    f=>f.experiment.runs[3].datasetPath=f.experiment.runs[0].datasetPath];
  for(const mutate of mutations) {
    const f=fixture();mutate(f);f.sync();
    assert.throws(()=>validateSupplement(f.experiment,baselineReport.environment,f.reader));
  }
  const f=fixture();f.experiment.runs[0].metrics.tps++;
  assert.throws(()=>validateSupplement(f.experiment,baselineReport.environment,f.reader),/metadata/);
});

test("rejects raw wrong threads/duration, missing sampling, long gap/span and quota mismatch",()=>{
  for(const mutate of [
    (f,r)=>f.evidence.set(r.rawOutputPath,f.evidence.get(r.rawOutputPath).replace("threads: 32","threads: 16")),
    (f,r)=>f.evidence.set(r.rawOutputPath,f.evidence.get(r.rawOutputPath).replace("90.0001s","60.0001s")),
    (f,r)=>f.evidence.get(r.resources.rawPath).samples.splice(2),
    (f,r)=>f.evidence.get(r.resources.rawPath).samples.splice(1,3),
    (f,r)=>{f.evidence.get(r.resources.rawPath).samples.at(-1).mysql.timeMs=110000;},
    (f,r)=>{f.evidence.get(r.resources.rawPath).summary.limits.loadgen.cpus=2;},
    (f,r)=>{f.evidence.get(r.resources.rawPath).summary.errors=["timeout"];},
  ]) {
    const f=fixture();mutate(f,f.experiment.runs[1]);
    assert.throws(()=>validateSupplement(f.experiment,baselineReport.environment,f.reader));
  }
});

test("publication rejection leaves report bytes unchanged",()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),"supplement-publish-"));
  const reportPath=path.join(directory,"mysql.json");
  const original=JSON.stringify(baselineReport);
  writeFileSync(reportPath,original);
  try {
    const f=fixture();f.experiment.runs.pop();
    assert.throws(()=>publishSupplement(f.experiment,reportPath,f.reader));
    assert.equal(readFileSync(reportPath,"utf8"),original);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test("successful atomic publication backs up outside site and rejects duplicate publication",()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),"supplement-success-"));
  const reportPath=path.join(directory,"mysql.json");
  const f=fixture(`fixture32_${process.pid}_${Date.now()}`);
  const backup=path.join(PATHS.resultsDir,"verification/report-backups",`${f.experiment.runGroup}-report-backup.json`);
  const original=JSON.stringify(baselineReport);
  writeFileSync(reportPath,original);
  try {
    const merged=publishSupplement(f.experiment,reportPath,f.reader);
    assert.deepEqual(JSON.parse(readFileSync(reportPath)),merged);
    assert.equal(readFileSync(backup,"utf8"),original);
    assert.deepEqual(readdirSync(directory),["mysql.json"]);
    const published=readFileSync(reportPath,"utf8");
    assert.throws(()=>publishSupplement(f.experiment,reportPath,f.reader),/already/);
    assert.equal(readFileSync(reportPath,"utf8"),published);
    const combinations=validateSupplement(f.experiment,baselineReport.environment,f.reader);
    combinations[0].selected.qps=1e9;
    const peakReport=mergeSupplement(baselineReport,f.experiment,combinations);
    assert.equal(peakReport.headline.peak.concurrency,32);
    assert.equal(peakReport.headline.peak.testedAt,"2026-10-08T09:00:00Z");
    assert.equal(peakReport.component.testedAt,baselineReport.component.testedAt);
  } finally {rmSync(directory,{recursive:true,force:true});rmSync(backup,{force:true});}
});

test("dry run uses fixed protocol without creating result files",()=>{
  const before=readdirSync(PATHS.resultsDir,{recursive:true});
  const reportBefore=readFileSync(path.join(PATHS.siteDataDir,"mysql.json"),"utf8");
  const output=execFileSync(process.execPath,[path.join(PATHS.benchmarkRoot,"scripts/supplement.mjs"),"--dry-run"],{encoding:"utf8"});
  const plan=JSON.parse(output);
  assert.deepEqual(plan.protocol,SUPPLEMENT_PROTOCOL);
  assert.deepEqual(plan.scenes,["point_select","update_index"]);
  assert.deepEqual(readdirSync(PATHS.resultsDir,{recursive:true}),before);
  assert.equal(readFileSync(path.join(PATHS.siteDataDir,"mysql.json"),"utf8"),reportBefore);
  assert.throws(()=>execFileSync(process.execPath,[path.join(PATHS.benchmarkRoot,"scripts/supplement.mjs"),"--dry-run","--concurrency=16"],{stdio:"pipe"}));
});

test("adaptive third is required, preserves all observations and selects median",()=>{
  const f=fixture();
  const second=f.experiment.runs[2];
  const raw=f.evidence.get(second.rawOutputPath).replaceAll("50.00 per sec.","25.00 per sec.");
  f.evidence.set(second.rawOutputPath,raw);second.metrics=parseSysbenchOutput(raw);f.sync();
  assert.throws(()=>validateSupplement(f.experiment,baselineReport.environment,f.reader),/third/);
  const third=structuredClone(second);
  third.repeat=3;third.runId=third.runId.replace(/r2$/,"r3");
  third.metadataPath=third.metadataPath.replace(/r2/,"r3");
  third.rawOutputPath=third.rawOutputPath.replace(/r2/,"r3");
  third.resources.rawPath=third.resources.rawPath.replace(/r2/,"r3");
  const thirdRaw=raw.replaceAll("25.00 per sec.","40.00 per sec.");
  third.metrics=parseSysbenchOutput(thirdRaw);
  f.evidence.set(third.rawOutputPath,thirdRaw);
  f.evidence.set(third.resources.rawPath,structuredClone(f.evidence.get(second.resources.rawPath)));
  f.experiment.runs.splice(3,0,third);f.sync();
  const combinations=validateSupplement(f.experiment,baselineReport.environment,f.reader);
  assert.equal(combinations[0].attempts,3);
  assert.equal(combinations[0].selected.tps,40);
  assert.equal(combinations[0].stability,"unstable");
  assert.equal(combinations[0].runs.length,3);
});
