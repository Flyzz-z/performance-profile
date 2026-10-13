#!/usr/bin/env node
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { PATHS, assert, loadBenchmarkEnv, parseCliArguments, runProcess, waitForMysql, mysqlQuery,
  composeServiceShell, createSysbenchArguments, createSysbenchShellCommand, shellQuote, redactSecrets,
  parseSysbenchOutput, nowIso, readJson, sleep } from "./lib.mjs";
import { readLoggingState, assertLoggingMatch, LOGGING_MODES } from "./logging.mjs";
import { measureRepeats } from "./protocol.mjs";
import { summarizeCombination, summarizeRunResources } from "./analytics.mjs";
import { startResourceCapture, summarizeResources } from "./resources.mjs";
import { INDEX_READ_PROTOCOL, INDEX_READ_GROUPS, INDEX_READ_SCRIPT, INDEX_READ_SQL, APPROVED_SCRIPT_SHA256,
  sha256, validateIndexEnvironment, validateIndexExperiment, publishIndexExperiment } from "./index-read-results.mjs";
import { prepareIndexDatasets, inspectDataset, inspectPlans, captureIndexEnvironment, assertSameDataset } from "./index-read-data.mjs";

const cli=parseCliArguments(process.argv.slice(2));
const allowed=["dry-run","verification","no-publish","group","publish-summary"];
assert(Object.keys(cli).every(key=>allowed.includes(key)),"Unsupported index read option; formal conditions cannot be overridden");
const verification=cli.verification===true;
assert(!cli["publish-summary"]||(!verification&&!cli["dry-run"]),"Invalid publication mode");
const protocol=verification?{...INDEX_READ_PROTOCOL,concurrency:[1],warmupSeconds:3,durationSeconds:15,repeats:1}:INDEX_READ_PROTOCOL;
const groupName=String(cli.group??`index-read-${new Date().toISOString().replace(/\D/g,"")}`);
assert(/^[a-zA-Z0-9_-]{1,80}$/.test(groupName),"Invalid index read group name");
const token=sha256(groupName).slice(0,16);
const databases={indexed:`pp_index_read_${token}_indexed`,"table-scan":`pp_index_read_${token}_scan`};
const env=loadBenchmarkEnv();
assert(env.MYSQL_CPUS==="8"&&env.MYSQL_MEMORY==="6g"&&env.LOADGEN_CPUS==="4"&&env.LOADGEN_MEMORY==="1g"
  &&env.MYSQL_PLATFORM==="linux/arm64","Configured index read environment mismatch");

if(cli["dry-run"]) {
  console.log(JSON.stringify({purpose:verification?"verification":"formal",protocol,databases,sql:INDEX_READ_SQL,
    groups:INDEX_READ_GROUPS,tableCount:10,tableSize:100000,returnedRows:1,publish:!verification&&!cli["no-publish"]},null,2));
} else if(cli["publish-summary"]) {
  publishIndexExperiment(readJson(path.resolve(String(cli["publish-summary"]))));
  console.log("Independent indexed read experiment published after complete evidence validation.");
} else {
  const root=verification?path.join(PATHS.resultsDir,"verification",groupName):PATHS.resultsDir;
  assert(!existsSync(root)||!readdirSync(root).some(file=>file.startsWith(`${groupName}-`)),"Group already exists; refusing overwrite");
  mkdirSync(root,{recursive:true});
  const file=name=>path.join(root,`${groupName}-${name}`);
  const relative=value=>path.relative(PATHS.projectRoot,value);
  const write=(name,value)=>{const p=file(name);writeFileSync(p,`${JSON.stringify(value,null,2)}\n`,{flag:"wx"});return relative(p);};
  write("claim.json",{group:groupName,purpose:verification?"verification":"formal",startedAt:nowIso()});
  const controller=new AbortController(),owned=new Set();
  const interrupt=()=>controller.abort();
  process.on("SIGINT",interrupt);process.on("SIGTERM",interrupt);
  const options={env:{...process.env,...env},signal:controller.signal};
  const query=sql=>mysqlQuery(env,sql,options);
  const cleanupQuery=sql=>mysqlQuery(env,sql,{env:options.env});
  const experiment={schemaVersion:1,purpose:verification?"verification":"formal",runGroup:groupName,testedAt:nowIso(),protocol,
    restorationVerified:false,groups:[]};
  let failure,mysqlId,original,originalBeforePath,loadVersion;
  const claimContainer=async name=>{
    const result=await runProcess("docker",["ps","-a","--filter",`name=^/${name}$`,"-q"]);
    assert(result.code===0&&!result.stdout.trim(),"Owned load name already exists");owned.add(name);
  };
  const removeOwned=async()=>{
    for(const name of owned) {
      const result=await runProcess("docker",["container","inspect",name]);
      if(result.code!==0) {assert(result.stderr.includes("No such"),"Unable to verify owned load cleanup");continue;}
      const item=JSON.parse(result.stdout)[0];
      assert(item.Config.Labels["com.docker.compose.project"]==="performance-profile-mysql"
        &&item.Config.Labels["com.docker.compose.service"]==="sysbench","Owned load identity mismatch");
      const removed=await runProcess("docker",["rm","-f",name]);assert(removed.code===0,"Unable to stop owned load");
    }
  };
  const outsiders=async database=>Number(await query(`SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND USER<>'system user' AND COMMAND<>'Daemon'${database?` AND (DB IS NULL OR DB<>'${database}')`:""};`));
  const assertIdle=async()=>assert(await outsiders()===0,"Other MySQL clients present; refusing overlapping experiment");
  try {
    assert(!controller.signal.aborted,"Interrupted before starting");
    mysqlId=await waitForMysql(env);
    await assertIdle();
    const report=readJson(path.join(PATHS.siteDataDir,"mysql.json"));
    const baseline=report.concurrencySupplement?.environment;
    assert(baseline?.loadGenerator?.imageId,"Missing confirmed baseline image evidence");
    experiment.baselineEnvironmentPath=write("baseline-environment.json",baseline);
    const versionResult=await composeServiceShell(env,"sysbench","sysbench --version",options);
    assert(versionResult.code===0,"Unable to identify sysbench version");loadVersion=versionResult.stdout.trim();
    const environment=await captureIndexEnvironment(env,query,mysqlId,loadVersion);
    validateIndexEnvironment(environment,baseline);
    console.log("Environment verified: MySQL 8 CPU/6 GiB, sysbench 4 CPU/1 GiB, Buffer Pool 3 GiB, matching ARM64 images.");
    original=await inspectDataset(query,env.MYSQL_DATABASE);
    originalBeforePath=write("original-before.json",original);
    const script=readFileSync(path.join(PATHS.benchmarkRoot,"loadgen/scripts/index-read.lua"),"utf8");
    assert(sha256(script)===APPROVED_SCRIPT_SHA256,"Unapproved workload script");
    writeFileSync(file("workload.lua"),script,{flag:"wx"});
    experiment.workload={sql:INDEX_READ_SQL,script:INDEX_READ_SCRIPT,scriptSha256:APPROVED_SCRIPT_SHA256,
      scriptSnapshotPath:relative(file("workload.lua")),seed:42,returnedRows:1,queriesPerEvent:1};
    const prepareName=`pp-ir-${token}-prepare`;
    await claimContainer(prepareName);
    console.log("Preparing paired frozen datasets in owned databases (10 x 100,000 rows each)...");
    const datasets=await prepareIndexDatasets({env,databases,query,containerName:prepareName,options});
    for(const id of INDEX_READ_GROUPS) {
      const plans=await inspectPlans(query,databases[id],id);
      const group={id,label:id==="indexed"?"二级索引查询":"无二级索引（全表扫描）",runGroup:groupName,database:databases[id],
        environment:{...environment,exploratory:verification},datasetPath:write(`${id}-dataset.json`,datasets[id]),
        plansPath:write(`${id}-plans.json`,plans),runs:[],points:[]};
      group.environmentPath=write(`${id}-environment.json`,group.environment);
      experiment.groups.push(group);
    }
    console.log("Datasets/queries/plans verified: identical payloads; indexed ref + table-scan ALL; one row per query.");
    for(const concurrency of protocol.concurrency) {
      for(const id of concurrency===8?["table-scan","indexed"]:INDEX_READ_GROUPS) {
        const group=experiment.groups.find(g=>g.id===id);
        const measure=async(kind,repeat)=>{
          assert(!controller.signal.aborted,"Interrupted before measurement");await assertIdle();
          const current=await captureIndexEnvironment(env,query,mysqlId,loadVersion);
          validateIndexEnvironment(current,baseline);
          assert(sha256(readFileSync(path.join(PATHS.benchmarkRoot,"loadgen/scripts/index-read.lua"),"utf8"))===APPROVED_SCRIPT_SHA256,"Workload changed during experiment");
          const seconds=kind==="warmup"?protocol.warmupSeconds:protocol.durationSeconds;
          const runId=`${groupName}-${id}-c${concurrency}-${kind}-r${repeat}`;
          const name=`pp-ir-${token}-${id}-c${concurrency}-${kind}-r${repeat}`;
          await claimContainer(name);
          const args=createSysbenchArguments({env:{...env,MYSQL_DATABASE:group.database,TABLE_COUNT:"10",TABLE_SIZE:"100000"},
            scenario:"point_select",command:"run",concurrency,durationSeconds:seconds});args[0]=INDEX_READ_SCRIPT;
          const run={runId,runGroup:groupName,group:id,kind,repeat,concurrency,startedAt:nowIso(),
            arguments:args.map(arg=>redactSecrets(arg,env)),environmentPath:write(`${id}-c${concurrency}-${kind}-r${repeat}-environment.json`,current)};
          const done=file(`${id}-c${concurrency}-${kind}-r${repeat}.done`),release=file(`${id}-c${concurrency}-${kind}-r${repeat}.release`);
          const mounted=p=>`/workspace/results/${path.relative(PATHS.resultsDir,p)}`;
          const shell=`${createSysbenchShellCommand(args)}; load_exit_code=$?; printf '%s' "$load_exit_code" > ${shellQuote(mounted(done))}; while [ ! -f ${shellQuote(mounted(release))} ]; do sleep 0.1; done; exit "$load_exit_code"`;
          let capture=kind==="measured"?await startResourceCapture({mysqlId,loadName:name,expectedSeconds:seconds,cpus:4,mysqlCpus:8,intervalMs:verification?1000:5000}):null;
          let resources,completed=false,result,guardTimer,pendingGuard=Promise.resolve();
          const guards=[],guardErrors=[];
          if(kind==="measured") guardTimer=setInterval(()=>{
            pendingGuard=pendingGuard.then(async()=>{try{const count=await outsiders(group.database);guards.push({time:nowIso(),outsiders:count});if(count)guardErrors.push("Overlapping MySQL clients detected");}catch(error){guardErrors.push(redactSecrets(error.message,env));}});
          },5000);
          const progress=setInterval(()=>console.log(`${id} c${concurrency} ${kind} r${repeat}: ${Math.round((Date.now()-Date.parse(run.startedAt))/1000)}s elapsed`),30000);
          console.log(`${id} c${concurrency}: ${kind} r${repeat}, ${seconds}s`);
          const processResult=composeServiceShell(env,"sysbench",shell,{...options,containerName:name}).finally(()=>{completed=true;});
          try {
            await Promise.race([processResult,(async()=>{while(!completed&&!existsSync(done))await sleep(100);})()]);
            clearInterval(guardTimer);await pendingGuard;
            if(capture){resources=await capture.stop();capture=null;}
            writeFileSync(release,"release\n",{flag:"wx"});
            result=await processResult;
          } finally {
            clearInterval(progress);clearInterval(guardTimer);
            if(capture)resources=await capture.stop();
            if(!completed&&!existsSync(release))writeFileSync(release,"release\n",{flag:"wx"});
            await processResult.catch(()=>{});await pendingGuard;
            rmSync(done,{force:true});rmSync(release,{force:true});
          }
          run.finishedAt=nowIso();run.exitCode=result.code;
          writeFileSync(file(`${id}-c${concurrency}-${kind}-r${repeat}.txt`),redactSecrets(`${result.stdout}\n${result.stderr}`,env),{flag:"wx"});
          run.rawOutputPath=relative(file(`${id}-c${concurrency}-${kind}-r${repeat}.txt`));
          assert(result.code===0,"Fatal index read load error; raw output retained");
          run.metrics=parseSysbenchOutput(result.stdout);
          assert(run.metrics.errors===0&&run.metrics.queries===run.metrics.transactions,"Read result/SQL errors");
          if(resources) {
            resources.guardChecks=guards;
            resources.summary=summarizeResources(resources.samples,resources.summary.limits,seconds,[...resources.summary.errors,...guardErrors],resources.intervalMs);
            run.resourcePath=write(`${id}-c${concurrency}-${kind}-r${repeat}-resources.json`,resources);
            run.resources=resources.summary;
            assert(resources.summary.valid,"Resource evidence insufficient; no publication");
          }
          write(`${id}-c${concurrency}-${kind}-r${repeat}.json`,run);group.runs.push(run);
          console.log(`${id} c${concurrency} ${kind} r${repeat}: QPS ${run.metrics.qps}, p99 ${run.metrics.p99Ms}ms`);
          return run;
        };
        await measure("warmup",0);
        const runs=await measureRepeats({repeatCount:protocol.repeats,thresholdPercent:30,measure:repeat=>measure("measured",repeat),
          onThird:()=>console.log(`${id} c${concurrency}: variance >30%; running third formal observation`)});
        const summary=summarizeCombination(runs);
        group.points.push({concurrency,...summary.selected,attempts:summary.attempts,stability:summary.stability,stats:summary.stats,
          resources:summarizeRunResources(runs),runs});
      }
    }
    for(const group of experiment.groups) {
      const dataset=await inspectDataset(query,group.database,group.id);
      assertSameDataset(datasets[group.id],dataset);
      group.finalDatasetPath=write(`${group.id}-dataset-final.json`,dataset);
      group.finalPlansPath=write(`${group.id}-plans-final.json`,await inspectPlans(query,group.database,group.id));
    }
  } catch(error) {failure=error;experiment.failure={message:redactSecrets(error.message,env),time:nowIso()};}
  finally {
    try {
      await removeOwned();
      if(original) {
        const originalAfter=await inspectDataset(cleanupQuery,env.MYSQL_DATABASE);
        const originalAfterPath=write("original-after.json",originalAfter);
        const logging=await readLoggingState(cleanupQuery),bufferPoolBytes=Number(await cleanupQuery("SELECT @@innodb_buffer_pool_size;"));
        assertLoggingMatch(logging,LOGGING_MODES.update_index);
        assert(bufferPoolBytes===3221225472&&isDeepStrictEqual(original,originalAfter),"End configuration or original database changed");
        experiment.restorationPath=write("restoration.json",{runGroup:groupName,logging,bufferPoolBytes,ownedLoadsStopped:true,
          originalBeforePath,originalAfterPath,checkedAt:nowIso()});
        experiment.restorationVerified=true;
      }
    } catch(error) {failure=failure??error;experiment.restorationVerified=false;experiment.restorationError=redactSecrets(error.message,env);}
    process.off("SIGINT",interrupt);process.off("SIGTERM",interrupt);
  }
  if(!failure&&!verification) {
    try{validateIndexExperiment(experiment);}catch(error){failure=error;experiment.failure={message:error.message,time:nowIso()};}
  }
  const summaryPath=write("index-read.json",experiment);
  if(failure) {console.error(`Index read experiment failed: ${redactSecrets(failure.message,env)}. Evidence: ${summaryPath}`);process.exitCode=1;}
  else {
    if(!verification&&!cli["no-publish"])publishIndexExperiment(experiment);
    console.log(`${verification?"Verification":"Formal experiment"} complete: ${summaryPath}`);
  }
}
