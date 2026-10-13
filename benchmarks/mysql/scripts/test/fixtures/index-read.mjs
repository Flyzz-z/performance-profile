import path from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PATHS, parseSysbenchOutput } from "../../lib.mjs";
import { INDEX_READ_PROTOCOL, INDEX_READ_SCRIPT, INDEX_READ_SQL, APPROVED_SCRIPT_SHA256, sha256 } from "../../index-read-results.mjs";
import { summarizeResources } from "../../resources.mjs";

export function indexReadFixture() {
  const runGroup=`index-read-test-${randomUUID()}`;
  const files=new Map(),prefix=`benchmarks/mysql/results/${runGroup}`;
  const put=(suffix,value)=>{const file=`${prefix}-${suffix}`;files.set(file,value);return file;};
  const environment={container:{mysqlCpuLimit:8,loadGeneratorCpuLimit:4,mysqlMemoryLimit:"6g",loadGeneratorMemoryLimit:"1g",platform:"linux/arm64",imagePlatform:"linux/arm64",imageId:"fixture-mysql",mysqlImage:"mysql:fixture"},
    mysql:{version:"8.4.11",bufferPoolBytes:3221225472,logBinEnabled:true,flushLogAtTransactionCommit:1,syncBinlog:1,flushLogAtTimeout:1},
    loadGenerator:{image:"fixture-sysbench",imageId:"fixture-load",imagePlatform:"linux/arm64",sysbenchVersion:"sysbench 1.0.20"}};
  const experiment={schemaVersion:1,purpose:"formal",runGroup,testedAt:"2026-10-13T06:00:00Z",protocol:structuredClone(INDEX_READ_PROTOCOL),restorationVerified:true,groups:[],baselineEnvironmentPath:put("baseline.json",environment)};
  const script=readFileSync(path.join(PATHS.benchmarkRoot,"loadgen/scripts/index-read.lua"),"utf8");
  experiment.workload={sql:INDEX_READ_SQL,script:INDEX_READ_SCRIPT,scriptSha256:APPROVED_SCRIPT_SHA256,scriptSnapshotPath:put("workload.lua",script),seed:42,returnedRows:1,queriesPerEvent:1};
  const originalBeforePath=put("original-before.json",{database:"sbtest",tables:[]});
  const originalAfterPath=put("original-after.json",{database:"sbtest",tables:[]});
  experiment.restorationPath=put("restoration.json",{runGroup,ownedLoadsStopped:true,bufferPoolBytes:3221225472,logging:environment.mysql,originalBeforePath,originalAfterPath});
  const limits={mysql:{cpus:8,memoryBytes:6*1024**3},loadgen:{cpus:4,memoryBytes:1024**3}};
  const capture=startedAt=>{
    const samples=Array.from({length:19},(_,i)=>({mysql:{timeMs:Date.parse(startedAt)+i*5000,cpuUsageNs:i*5e9,periods:i*50,throttledPeriods:0,throttledTimeNs:0},loadgen:{timeMs:Date.parse(startedAt)+i*5000,cpuUsageNs:i*1e9,periods:i*50,throttledPeriods:0,throttledTimeNs:0}}));
    return {intervalMs:5000,samples,guardChecks:Array.from({length:18},()=>({outsiders:0})),summary:summarizeResources(samples,limits,90,[],5000)};
  };
  let time=Date.parse("2026-10-13T06:00:00Z");
  for(const [i,id] of ["indexed","table-scan"].entries()) {
    const database=`fixture_${i}`;
    const dataset={schemaVersion:1,database,tableCount:10,tableSize:100000,actualRows:1000000,secondaryIndex:i===0,tables:Array.from({length:10},(_,j)=>({name:`sbtest${j+1}`,rows:100000,distinctK:100000,minK:1,maxK:100000,kEqualsId:100000,rowDigest:sha256(`table-${j}`),
      columns:[["id","int","PRI","auto_increment"],["k","int",i===0?"MUL":"",""],["c","char(120)","",""],["pad","char(60)","",""]],indexes:i===0?[[`k_${j+1}`,"k","1"],["PRIMARY","id","0"]]:[["PRIMARY","id","0"]]}))};
    const plans={database,group:id,sql:INDEX_READ_SQL,samples:dataset.tables.flatMap((t,j)=>[1,50000,100000,42,4242].map(key=>({table:t.name,key,resultHex:"7061796c6f6164",plan:{query_block:{table:{table_name:t.name,access_type:i===0?"ref":"ALL",...(i===0?{key:`k_${j+1}`,used_key_parts:["k"]}:{})}}}})))};
    const group={id,label:i===0?"二级索引查询":"全表扫描",runGroup,database,environment:structuredClone(environment),environmentPath:put(`${id}-env.json`,structuredClone(environment)),
      datasetPath:put(`${id}-dataset.json`,dataset),finalDatasetPath:put(`${id}-dataset-final.json`,structuredClone(dataset)),plansPath:put(`${id}-plans.json`,plans),finalPlansPath:put(`${id}-plans-final.json`,structuredClone(plans)),runs:[]};
    for(const concurrency of [1,8,16]) for(const [kind,repeat] of [["warmup",0],["measured",1],["measured",2]]) {
      const seconds=kind==="warmup"?30:90,tps=(i===0?20000:200)*concurrency,events=tps*seconds;
      const validated=Array.from({length:concurrency},(_,thread)=>`INDEX_READ_VALIDATED thread=${thread} events=${events/concurrency}`).join("\n");
      const raw=`sysbench 1.0.20\nINDEX_READ_SQL=${INDEX_READ_SQL}\nINDEX_READ_RESULT=one-row;payload=c;prepared=true\nNumber of threads: ${concurrency}\nLatency histogram:\n 0.1 | *** ${events*.95}\n 1.0 | * ${events*.05}\nSQL statistics:\n transactions: ${events} (${tps.toFixed(2)} per sec.)\n queries: ${events} (${tps.toFixed(2)} per sec.)\n ignored errors: 0\n reconnects: 0\nGeneral statistics:\n total time: ${seconds}.0000s\nLatency:\n avg: 0.2\n 99th percentile: 1.0\n${validated}\n`;
      const runId=`${runGroup}-${id}-c${concurrency}-${kind}-r${repeat}`;
      const run={runId,runGroup,group:id,kind,repeat,concurrency,exitCode:0,metrics:parseSysbenchOutput(raw),rawOutputPath:put(`${id}-c${concurrency}-${kind}-r${repeat}.txt`,raw),environmentPath:group.environmentPath,
        startedAt:new Date(time).toISOString(),finishedAt:new Date(time+seconds*1000).toISOString(),
        arguments:[INDEX_READ_SCRIPT,"--tables=10","--table-size=100000",`--threads=${concurrency}`,`--time=${seconds}`,`--mysql-db=${database}`,"--rand-type=uniform","--rand-seed=42","--percentile=99","--histogram=on","run"]};
      time+=(seconds+1)*1000;
      if(kind==="measured")run.resourcePath=put(`${id}-c${concurrency}-r${repeat}-resources.json`,capture(run.startedAt));
      group.runs.push(run);
    }
    experiment.groups.push(group);
  }
  return {experiment,files,reader:{json:file=>structuredClone(files.get(file)),text:file=>files.get(file)}};
}
