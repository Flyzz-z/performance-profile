import { KEY_PREFIX, MEMORY, REDIS_PROFILES } from "./protocol.mjs";
import { memtierFillArguments } from "./memtier.mjs";
import { execIn, redisCli, waitForBackgroundIdle } from "./lib.mjs";
import { assert } from "../../mysql/scripts/lib.mjs";

export function luaForDataset(dataset) {
  const prefix = KEY_PREFIX;
  if (dataset.kind === "counters") {
    return `for i=1,${dataset.keys} do redis.call('SET','${prefix}'..i,'0') end return ${dataset.keys}`;
  }
  if (dataset.kind === "hashes") {
    return `local v=string.rep('x',${dataset.valueBytes}) for i=1,${dataset.keys} do local a={} for f=1,${dataset.fields} do a[#a+1]='f'..f a[#a+1]=v end redis.call('HSET','${prefix}'..i,unpack(a)) end return ${dataset.keys}`;
  }
  if (dataset.kind === "lists") {
    return `local v=string.rep('x',${dataset.valueBytes}) for i=1,${dataset.keys} do local a={} for e=1,${dataset.elements} do a[e]=v end redis.call('RPUSH','${prefix}'..i,unpack(a)) end return ${dataset.keys}`;
  }
  if (dataset.kind === "zsets") {
    return `for i=1,${dataset.keys} do local a={} for m=1,${dataset.members} do a[#a+1]=m a[#a+1]='m'..m end redis.call('ZADD','${prefix}'..i,unpack(a)) end return ${dataset.keys}`;
  }
  throw new Error(`No Lua loader for dataset kind ${dataset.kind}`);
}

export function luaForBigHash(bigHash) {
  assert(bigHash.fields % 1000 === 0, "Big hash field count must be a multiple of 1000");
  return `local v=string.rep('x',${bigHash.valueBytes}) for c=0,${bigHash.fields / 1000 - 1} do local a={} for j=1,1000 do local n=c*1000+j a[#a+1]='f'..n a[#a+1]=v end redis.call('HSET','${bigHash.key}',unpack(a)) end return ${bigHash.fields}`;
}

export function expectedDbSize(dataset, combo) {
  if (combo.group === "memory" && dataset.keys > MEMORY.fitKeys) return null;
  return dataset.keys + (dataset.bigHash ? 1 : 0);
}

export async function prepareCombination(env, combo, { log = () => {}, resultsMount = "/workspace/results" } = {}) {
  const startedAt = Date.now();
  await redisCli(env, ["FLUSHALL", "SYNC"]);
  const dataset = combo.dataset;
  if (dataset.kind === "strings") {
    log(`loading ${dataset.keys} string keys x ${dataset.valueBytes}B`);
    const fill = await execIn(env, "memtier", memtierFillArguments({ keys: dataset.keys, valueBytes: dataset.valueBytes, randomData: dataset.randomData === true }));
    assert(fill.code === 0, `memtier fill failed: ${fill.stderr.trim() || fill.stdout.trim().slice(-300)}`);
  } else {
    log(`loading ${dataset.kind} dataset`);
    await redisCli(env, ["EVAL", luaForDataset(dataset), "0"]);
  }
  if (dataset.bigHash) {
    log(`loading big hash ${dataset.bigHash.fields} fields`);
    await redisCli(env, ["EVAL", luaForBigHash(dataset.bigHash), "0"]);
  }
  const info = await waitForBackgroundIdle(env);
  const dbSize = Number((await redisCli(env, ["DBSIZE"])).trim());
  const expected = expectedDbSize(dataset, combo);
  if (expected !== null) assert(dbSize === expected, `${combo.id}: DBSIZE ${dbSize} differs from expected ${expected}`);
  else assert(info.usedMemoryBytes >= MEMORY.maxmemoryBytes * 0.8, `${combo.id}: dataset did not fill maxmemory (${info.usedMemoryBytes})`);
  await redisCli(env, ["SLOWLOG", "RESET"]);
  return { loadSeconds: (Date.now() - startedAt) / 1000, dbSize, expectedDbSize: expected, usedMemoryBytes: info.usedMemoryBytes,
    evictedKeysAfterLoad: info.evictedKeys, dataset, profile: combo.redisProfile, resultsMount };
}

export function profileFor(combo) {
  const profile = REDIS_PROFILES[combo.redisProfile];
  if (!profile) throw new Error(`Unknown Redis profile ${combo.redisProfile}`);
  return profile;
}
