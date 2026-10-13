import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { parseSysbenchOutput } from "../lib.mjs";
import { validateIndexExperiment,publishIndexExperiment } from "../index-read-results.mjs";
import { projectIndexReadExperiment } from "../../../../site/report.mjs";
import { indexReadFixture } from "./fixtures/index-read.mjs";

test("independent reader derives paired summaries from full original evidence without editing baseline data",()=>{
  const f=indexReadFixture();const result=validateIndexExperiment(f.experiment,f.reader);
  assert.equal(result.groups[0].points.length,3);assert.equal(result.groups[0].points[2].qps,320000);
  const before=JSON.stringify(result);const view=projectIndexReadExperiment({indexReadExperiment:result});
  assert.deepEqual(view.comparisons.map(c=>c.qpsRatio),[100,100,100]);assert.equal(JSON.stringify(result),before);
  assert.equal(projectIndexReadExperiment({}),null);
  const partial=structuredClone(result);partial.groups[1].points.pop();assert.equal(projectIndexReadExperiment({indexReadExperiment:partial}),null);
  result.groups[1].points[1].qps=0;assert.equal(projectIndexReadExperiment({indexReadExperiment:result}).comparisons[1].qpsRatio,null);
});

const rejectCases={
  "verification role":f=>{f.experiment.purpose="verification";},
  "missing group":f=>{f.experiment.groups.pop();},
  "mixed result groups":f=>{f.experiment.groups[1].runGroup="other";},
  "missing repetition":f=>{f.experiment.groups[0].runs.pop();},
  "invalid run timestamps":f=>{f.experiment.groups[0].runs[0].finishedAt="invalid";},
  "reused observation":f=>{f.experiment.groups[0].runs[2].rawOutputPath=f.experiment.groups[0].runs[1].rawOutputPath;},
  "unapproved script":f=>{f.files.set(f.experiment.workload.scriptSnapshotPath,"SELECT COUNT(*)");},
  "changed SQL":f=>{f.experiment.workload.sql="SELECT c FROM sbtestN WHERE id=?";},
  "duplicate options":f=>{f.experiment.groups[0].runs[0].arguments.push("--time=3");},
  "wrong raw concurrency":f=>{const p=f.experiment.groups[0].runs[0].rawOutputPath;f.files.set(p,f.files.get(p).replace("Number of threads: 1","Number of threads: 32"));},
  "short actual duration":f=>{const p=f.experiment.groups[0].runs[1].rawOutputPath;f.files.set(p,f.files.get(p).replace("90.0000s","10.0000s"));},
  "missing return-row evidence":f=>{const p=f.experiment.groups[0].runs[1].rawOutputPath;f.files.set(p,f.files.get(p).replace(/INDEX_READ_VALIDATED[^\n]+/g,""));},
  "SQL errors":f=>{const p=f.experiment.groups[0].runs[1].rawOutputPath;f.files.set(p,f.files.get(p).replace("ignored errors: 0","ignored errors: 1"));},
  "reconnections":f=>{const p=f.experiment.groups[0].runs[1].rawOutputPath;f.files.set(p,f.files.get(p).replace("reconnects: 0","reconnects: 1"));},
  "different paired payloads":f=>{f.files.get(f.experiment.groups[1].datasetPath).tables[0].rowDigest="0".repeat(64);},
  "changed frozen data":f=>{f.files.get(f.experiment.groups[0].finalDatasetPath).tables[0].rows--;},
  "unexpected access plan":f=>{f.files.get(f.experiment.groups[0].plansPath).samples[0].plan.query_block.table.access_type="ALL";},
  "incomplete plan samples":f=>{f.files.get(f.experiment.groups[0].plansPath).samples.pop();},
  "different query payloads":f=>{f.files.get(f.experiment.groups[1].plansPath).samples[0].resultHex="00";f.files.get(f.experiment.groups[1].finalPlansPath).samples[0].resultHex="00";},
  "insufficient sampling":f=>{f.files.get(f.experiment.groups[0].runs[1].resourcePath).samples.splice(2);},
  "samples from another time window":f=>{f.files.get(f.experiment.groups[0].runs[1].resourcePath).samples.forEach(s=>{s.mysql.timeMs+=86400000;s.loadgen.timeMs+=86400000;});},
  "modified CPU counters":f=>{f.files.get(f.experiment.groups[0].runs[1].resourcePath).summary.mysql.meanCpuPercent=900;},
  "wrong load limits":f=>{f.files.get(f.experiment.groups[0].runs[1].resourcePath).summary.limits.loadgen.cpus=8;},
  "overlapping workloads":f=>{f.files.get(f.experiment.groups[0].runs[1].resourcePath).guardChecks[0].outsiders=1;},
  "unverified cleanup":f=>{f.files.get(f.experiment.restorationPath).ownedLoadsStopped=false;},
  "original database mutation":f=>{f.files.get(f.files.get(f.experiment.restorationPath).originalAfterPath).tables.push({name:"changed"});},
  "verification evidence path":f=>{f.experiment.groups[0].datasetPath="benchmarks/mysql/results/verification/invalid.json";},
};
for(const [name,alter]of Object.entries(rejectCases))test(`refuses ${name} before publication`,()=>{const f=indexReadFixture();alter(f);assert.throws(()=>validateIndexExperiment(f.experiment,f.reader));});

test("atomic append preserves all other fields; a concurrent editor is never overwritten",()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),"pp-index-read-")),reportPath=path.join(directory,"report.json");
  const original={component:{id:"mysql",testedAt:"older"},series:[{scenario:"point_select",points:[{concurrency:32,qps:42}]}],bufferPoolExperiment:{id:"keep"},hotUpdateExperiment:{id:"keep"}};
  const fixtures=[];
  try {
    writeFileSync(reportPath,JSON.stringify(original));const first=indexReadFixture();fixtures.push(first);
    const published=publishIndexExperiment(first.experiment,{reportPath,reader:first.reader,backupPath:path.join(directory,"first-backup.json")});
    const {indexReadExperiment,...rest}=published;assert.deepEqual(rest,original);assert.equal(indexReadExperiment.groups.length,2);
    const next=indexReadFixture();fixtures.push(next);const edited={...published,editor:"concurrent"};
    assert.throws(()=>publishIndexExperiment(next.experiment,{reportPath,reader:next.reader,backupPath:path.join(directory,"second-backup.json"),beforeReplace:()=>writeFileSync(reportPath,JSON.stringify(edited))}),/concurrently/);
    assert.deepEqual(JSON.parse(readFileSync(reportPath,"utf8")),edited);
  } finally {
    rmSync(directory,{recursive:true,force:true});
  }
});

test("adaptive third run is mandatory when first two observations differ by more than thirty percent",()=>{
  const f=indexReadFixture(),group=f.experiment.groups[0],second=group.runs[2];
  const changed=f.files.get(second.rawOutputPath).replace(/\b1800000\b/g,"900000").replace(/\b1710000\b/g,"855000").replace(/\b90000\b/g,"45000").replace(/\b20000\.00\b/g,"10000.00");
  f.files.set(second.rawOutputPath,changed);second.metrics=parseSysbenchOutput(changed);
  assert.throws(()=>validateIndexExperiment(f.experiment,f.reader),/adaptive/);
  const third=structuredClone(group.runs[1]);third.runId+="-third";third.repeat=3;
  const previousStart=Date.parse(third.startedAt);third.startedAt=new Date(Date.parse(second.finishedAt)+1000).toISOString();third.finishedAt=new Date(Date.parse(third.startedAt)+90000).toISOString();
  const raw=f.files.get(third.rawOutputPath),resources=structuredClone(f.files.get(third.resourcePath));
  resources.samples.forEach(s=>{s.mysql.timeMs+=Date.parse(third.startedAt)-previousStart;s.loadgen.timeMs+=Date.parse(third.startedAt)-previousStart;});
  third.rawOutputPath+="-third";third.resourcePath+="-third";f.files.set(third.rawOutputPath,raw);f.files.set(third.resourcePath,resources);group.runs.push(third);
  const result=validateIndexExperiment(f.experiment,f.reader);
  assert.equal(result.groups[0].points[0].attempts,3);assert.equal(result.groups[0].points[0].qps,20000);assert.equal(result.groups[0].points[0].stability,"unstable");
});
