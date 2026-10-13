import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assert, runProcess, createSysbenchArguments, createSysbenchShellCommand, composeServiceShell, nowIso } from "./lib.mjs";
import { readLoggingState } from "./logging.mjs";
import { INDEX_READ_SQL, validatePairedDatasets, validateIndexPlans } from "./index-read-results.mjs";

export function identifier(value) {
  assert(/^[a-zA-Z0-9_]{1,64}$/.test(value), "Unsafe database/table name");
  return `\`${value}\``;
}

export function decodeBatch(value) {
  return value.replace(/\\([0bnrtZ\\])/g, (_,c) => ({"0":"\0",b:"\b",n:"\n",r:"\r",t:"\t",Z:"\x1a","\\":"\\"}[c]));
}

export async function inspectDataset(query, database, group) {
  const db = identifier(database);
  const names = (await query(`SHOW TABLES FROM ${db};`)).split("\n").filter(Boolean);
  assert(names.every(name => /^sbtest([1-9]|10)$/.test(name)), "Unexpected tables in dataset");
  names.sort((a,b) => Number(a.slice(6))-Number(b.slice(6)));
  const tables = [];
  for (const name of names) {
    const table = `${db}.${identifier(name)}`;
    const columns = (await query(`SELECT COLUMN_NAME,COLUMN_TYPE,COLUMN_KEY,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${database}' AND TABLE_NAME='${name}' ORDER BY ORDINAL_POSITION;`)).split("\n").map(line=>line.split("\t"));
    const indexes = (await query(`SELECT INDEX_NAME,COLUMN_NAME,NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='${database}' AND TABLE_NAME='${name}' ORDER BY INDEX_NAME,SEQ_IN_INDEX;`)).split("\n").filter(Boolean).map(line=>line.split("\t"));
    const [rows,distinctK,minK,maxK,kEqualsId] = (await query(`SELECT COUNT(*),COUNT(DISTINCT k),MIN(k),MAX(k),SUM(k=id) FROM ${table};`)).split("\t").map(Number);
    const hash = createHash("sha256");
    let last = 0, seen = 0;
    for (;;) {
      const raw = await query(`SELECT id,SHA2(CONCAT_WS(':',id,k,HEX(c),HEX(pad)),256) FROM ${table} WHERE id>${last} ORDER BY id LIMIT 25000;`);
      const lines = raw ? raw.split("\n") : [];
      for (const line of lines) {
        const [id,digest] = line.split("\t");
        assert(/^[a-f0-9]{64}$/.test(digest) && Number(id)>last, "Invalid ordered row digest");
        last=Number(id); seen++; hash.update(`${digest}\n`);
      }
      if (lines.length<25000) break;
    }
    assert(seen===rows,"Incomplete row digest");
    tables.push({name,columns,indexes,rows,distinctK,minK,maxK,kEqualsId,rowDigest:hash.digest("hex")});
  }
  return {schemaVersion:1,database,tableCount:tables.length,tableSize:100000,actualRows:tables.reduce((sum,t)=>sum+t.rows,0),
    ...(group ? {secondaryIndex:group==="indexed"} : {}),tables};
}

export async function inspectPlans(query,database,group) {
  let seed=42;
  const randomKey=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%100000+1;};
  const keys=[1,50000,100000,randomKey(),randomKey()];
  const samples=[];
  for(let i=1;i<=10;i++) {
    const table=`sbtest${i}`, qualified=`${identifier(database)}.${identifier(table)}`;
    const output=await query(keys.map(key=>`EXPLAIN FORMAT=JSON SELECT c FROM ${qualified} WHERE k=${key}; SELECT HEX(c) FROM ${qualified} WHERE k=${key};`).join(" "));
    const lines=output.split("\n");
    assert(lines.length===keys.length*2,"Plan/result count mismatch");
    keys.forEach((key,j)=>samples.push({table,key,plan:JSON.parse(decodeBatch(lines[j*2])),resultHex:lines[j*2+1]}));
  }
  const evidence={database,group,sql:INDEX_READ_SQL,samples};
  validateIndexPlans(evidence,group);
  return evidence;
}

export async function prepareIndexDatasets({env,databases,query,containerName,options}) {
  for(const database of Object.values(databases)) {
    identifier(database);
    assert(Number(await query(`SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${database}';`))===0,"Owned database already exists; refusing overwrite");
    await query(`CREATE DATABASE ${identifier(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`);
  }
  const args=createSysbenchArguments({env:{...env,MYSQL_DATABASE:databases.indexed,TABLE_COUNT:"10",TABLE_SIZE:"100000"},scenario:"point_select",command:"prepare",concurrency:4,durationSeconds:1});
  args.splice(-1,0,"--create-secondary=on","--auto-inc=on");
  const result=await composeServiceShell(env,"sysbench",createSysbenchShellCommand(args),{...options,containerName});
  assert(result.code===0,"Index read preparation failed");
  for(let i=1;i<=10;i++) {
    const name=identifier(`sbtest${i}`),source=`${identifier(databases.indexed)}.${name}`,target=`${identifier(databases["table-scan"])}.${name}`;
    await query(`UPDATE ${source} SET k=id; CREATE TABLE ${target} LIKE ${source}; ALTER TABLE ${target} DROP INDEX k_${i}; INSERT INTO ${target} (id,k,c,pad) SELECT id,k,c,pad FROM ${source} ORDER BY id; ANALYZE TABLE ${source},${target};`);
  }
  const indexed=await inspectDataset(query,databases.indexed,"indexed");
  const scan=await inspectDataset(query,databases["table-scan"],"table-scan");
  validatePairedDatasets(indexed,scan);
  return {indexed,"table-scan":scan};
}

export async function captureIndexEnvironment(env,query,mysqlId,sysbenchVersion) {
  const inspect=async(kind,id)=>{
    const result=await runProcess("docker",[kind,"inspect",id]);
    assert(result.code===0,"Unable to inspect actual environment");return JSON.parse(result.stdout)[0];
  };
  const mysql=await inspect("container",mysqlId),image=await inspect("image",mysql.Image),load=await inspect("image",env.LOADGEN_IMAGE);
  assert(mysql.Config.Labels["com.docker.compose.project"]==="performance-profile-mysql"
    && mysql.Config.Labels["com.docker.compose.service"]==="mysql" && mysql.State.Running,"MySQL ownership/state mismatch");
  assert(image.Os==="linux"&&image.Architecture==="arm64"&&load.Os==="linux"&&load.Architecture==="arm64","Actual platform mismatch");
  const values=(await query("SELECT VERSION(),@@innodb_buffer_pool_size,@@max_connections,@@transaction_isolation;")).split("\t");
  const logging=await readLoggingState(query);
  const [dockerServer,dockerInfo,host,architecture]=await Promise.all([
    runProcess("docker",["version","--format","{{.Server.Version}}|{{.Server.Os}}/{{.Server.Arch}}"]),
    runProcess("docker",["info","--format","{{.OperatingSystem}}|{{.KernelVersion}}|{{.NCPU}}|{{.MemTotal}}|{{.Driver}}"]),
    runProcess("sysctl",["-n","hw.model","hw.ncpu","hw.memsize"]),runProcess("uname",["-m"]),
  ]);
  const [model,cpuCount,memoryBytes]=host.stdout.trim().split(/\s+/);
  return {schemaVersion:1,generatedAt:nowIso(),environmentLabel:"local Docker benchmark",exploratory:false,
    container:{mysqlImage:env.MYSQL_IMAGE,imageId:image.Id,imagePlatform:`${image.Os}/${image.Architecture}`,repositoryDigests:image.RepoDigests,
      platform:"linux/arm64",mysqlCpuLimit:mysql.HostConfig.NanoCpus/1e9,mysqlMemoryLimit:mysql.HostConfig.Memory===6*1024**3?"6g":String(mysql.HostConfig.Memory),
      loadGeneratorCpuLimit:Number(env.LOADGEN_CPUS),loadGeneratorMemoryLimit:env.LOADGEN_MEMORY,containerId:mysqlId},
    mysql:{version:values[0],bufferPoolBytes:Number(values[1]),maxConnections:Number(values[2]),transactionIsolation:values[3],...logging},
    loadGenerator:{image:env.LOADGEN_IMAGE,imageId:load.Id,imagePlatform:`${load.Os}/${load.Architecture}`,sysbenchVersion},
    runtime:{dockerServer:dockerServer.stdout.trim(),dockerInfo:dockerInfo.stdout.trim()},
    host:{model,cpuCount:Number(cpuCount),memoryBytes:Number(memoryBytes),architecture:architecture.stdout.trim()}};
}

export function assertSameDataset(before,after) { assert(isDeepStrictEqual(before,after),"Dataset changed during read-only experiment"); }
