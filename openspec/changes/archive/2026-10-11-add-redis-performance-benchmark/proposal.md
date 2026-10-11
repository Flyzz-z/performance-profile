## Why

项目已有 MySQL 的可复现性能画像，但缺少内存型缓存组件的量化认知。Redis 的性能结构与 MySQL 不同：命令执行基本单线程，吞吐由网络往返、命令复杂度、value 大小、持久化和内存策略共同决定，且存在大 key、O(N) 命令阻塞所有客户端的风险。需要一组针对这些因素的正式实验，使“Redis 在什么条件下快、在什么条件下变慢”有证据可依。

## What Changes

- 新增 Redis 本地 Docker 基准：Redis 7.x 固定版本和镜像摘要，`linux/arm64`，单实例，Redis 容器 2 CPU / 4 GiB，压测端 `memtier_benchmark` 4 CPU / 1 GiB，沿用 MySQL 的环境快照、5 秒资源采样和证据验收风格。
- 确认的 7 个正式场景组（不新增、不替换）：
  1. 命令与数据结构基线：GET、SET、INCR、HSET、HGET、LPUSH+RPOP、ZINCRBY（更新已有成员分数，以代替会退化为空操作的 ZADD）、ZRANGE。
  2. Pipeline 深度：1 / 16 / 64 / 256，GET 与 SET。
  3. Value 大小：64B / 1KB / 10KB / 100KB，GET 与 SET，保持总载荷规模一致。
  4. 持久化策略：关闭 / RDB / AOF everysec / AOF always，写密集，多并发。
  5. 客户端连接数：1 / 16 / 64 / 256，读多写少混合负载。
  6. 内存压力与淘汰：数据可全驻留、超出 `maxmemory` 的 `allkeys-lru`（均匀与高斯热点访问）、`noeviction`。
  7. 大 key / 慢命令对其他请求的阻塞：基线、`HGETALL` 大 key、`KEYS`、`SCAN` 增量遍历，前台测 GET 吞吐与尾延迟。
- 每个场景组指标统一为 ops/s、p50/p95/p99/p99.9/p99.99、最大延迟、错误数，另按场景记录带宽、命中率、淘汰数、Redis 进程 CPU 与内存等 `INFO` 差分证据。
- 沿用既有协议：预热 30 秒、两次测量取均值、两次 ops/s 或 p99 差异超 30% 补第三次取中位数；**测量时长拟定为每次 60 秒（MySQL 为 90 秒）**，因 Redis 吞吐稳定且矩阵较大，已获用户确认。
- 新增 Redis 结果页 `redis.html` 与数据文件 `site/data/redis.json`：不同场景用适合各自自变量的图（柱状、折线、成对对比），页首环境摘要，页内由已发布正式数据推导“实验结论”；索引页新增 Redis 入口。
- dry run、压测端容量标定、正确性验证、参数探索一律为过程验证，输出落在 `verification/`，不得进入最终页面或数据文件。

## Capabilities

### New Capabilities

- `redis-performance-benchmark`：Redis 实验环境、7 个正式场景、测量协议、数据准备、证据采集与发布验收要求。
- `redis-results-dashboard`：Redis 详情页、索引页入口、各场景展示方式、环境明细与实验结论要求。

### Modified Capabilities

无。MySQL 既有规格的要求不变。

## Impact

- 新增目录 `benchmarks/redis/`（`compose.yaml`、`.env.example`、`config/`、`loadgen/`、`scripts/`、`results/`、`README.md`），复用 `benchmarks/mysql/scripts` 中与组件无关的工具（进程调用、JSON 读写、统计、重复运行协议），不改动 MySQL 脚本行为。
- 新增站点文件 `site/redis.html`、`site/redis-report.mjs` 及测试；修改 `site/index.html`、`site/app.js`、`site/server.mjs`（增加 `/artifacts/redis/` 路由）以挂接索引与原始数据。
- `package.json` 增加 `redis:*` 与 `test:redis` 脚本；根 `README.md` 增加 Redis 说明。
- 依赖：Docker 镜像 `redis:7.x` 与 `memtier_benchmark` 官方镜像（均需固定摘要并确认 arm64）。
- 不修改 MySQL 测量数据、页面和规格；不涉及复制、Sentinel、Cluster、Lua、事务、`io-threads` 对比和 BGSAVE/AOF rewrite 尾延迟实验。
