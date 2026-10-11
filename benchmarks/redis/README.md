# Redis Performance Benchmark

在 macOS 的 Docker Linux VM 中运行 Redis 7.4 单实例和 `memtier_benchmark`，量化命令类型、Pipeline、Value 大小、持久化、连接数、内存淘汰与慢命令阻塞七类条件下的吞吐和延迟。

结果是本地 Docker 基准，包含虚拟网络与虚拟存储的影响，不代表生产服务器能力。

## 环境

- 平台：`linux/arm64`；镜像均固定摘要（见 `.env.example`）。
- Redis：7.4，单实例，`io-threads 1`，2 CPU / 4 GiB；默认 `save ""`、`appendonly no`、不设置 `maxmemory`。
- 压测端：`memtier_benchmark 2.1.2`，4 CPU / 1 GiB；后台慢命令客户端使用同版本 Redis 镜像的 `redis-cli`，0.5 CPU。
- 协议：预热 30 秒，两次测量各 60 秒，ops/s 或 p99 差异超过 30% 补第三次；两次取均值、三次取中位数，保留全部有效观测。
- 默认使用 `.env.example`；需要本地覆盖时复制为 `.env`（已被 git 忽略）。

## 正式场景（共 48 个组合）

| 场景 | 矩阵 |
|---|---|
| 1 命令与数据结构基线 | GET、SET、INCR、HGET、HSET、LPUSH+RPOP、ZINCRBY、ZRANGE 0 9，16 连接 |
| 2 Pipeline 深度 | GET 与 SET × 深度 1 / 16 / 64 / 256，16 连接 |
| 3 Value 大小 | GET 与 SET × 64B / 1KB / 10KB / 100KB，16 连接，名义载荷固定 256 MB |
| 4 持久化策略 | 100% SET × 关闭 / RDB / AOF everysec / AOF always × 1 / 16 / 64 连接 |
| 5 客户端连接数 | GET:SET 9:1 × 1 / 16 / 64 / 256 连接 |
| 6 内存压力与淘汰 | maxmemory 1 GiB：全驻留、allkeys-lru 均匀、allkeys-lru 高斯热点、noeviction，16 连接，9:1 |
| 7 慢命令阻塞 | 前台 GET 16 连接 × 无后台 / 后台 HGETALL 大 Hash / KEYS / SCAN |

连接数 = 线程数 × 每线程客户端数：1→1×1，16→2×8，64→4×16，256→4×64。矩阵的单一事实来源是 `scripts/protocol.mjs`。

数据与口径：

- 字符串默认 100 万 key × 256B，均匀随机访问；Hash 10 万个（每个 10 字段）；List、ZSet 各 1000 个、每个 1000 个元素。写命令覆盖已有元素，使结构大小在测量期间稳定。
- ZINCRBY 递增每个 ZSet 中固定成员的分数。ZADD 对同分数重复写入是空操作，不能代表真实的重排成本。
- 场景 4 的装载与写入使用 `--random-data` 生成不可压缩的 value；memtier 默认的重复字符会被 RDB 前导压缩，使基线极小并过于频繁地触发 AOF 重写。
- 场景 4 的 RDB 使用 Redis 默认 `save` 策略；磁盘是 Docker VM 虚拟存储，不代表物理磁盘 fsync 性能。窗口内的 RDB 保存、AOF 重写和 fork 耗时随观测保存。
- 场景 6 的 noeviction 组拒绝写入产生的 OOM 次数取 `INFO errorstats`，作为测量结果；其他组合出现非零错误回复则观测无效。
- 场景 7 的后台频率固定：HGETALL 10 万字段大 Hash 5 次/秒，KEYS 2 次/秒，SCAN（COUNT 100）连续遍历。

## 命令

```bash
npm run redis:formal -- --dry-run
npm run redis:verify -- --only=commands-get,pipeline-get-d1
caffeinate -i npm run redis:formal -- --group=<唯一标识> --no-publish
npm run redis:formal -- --publish-summary=benchmarks/redis/results/<group>/summary.json
npm run test:redis
```

- `--dry-run` 只读列出 48 组合、数据规模、协议和预计时长，不启动容器、不写文件。
- `redis:verify` 是过程验证（冒烟、正确性、压测端标定、参数探索），支持 `--only`、`--warmup-seconds`、`--duration-seconds`、`--runs`，输出写入 `results/verification/`，不能发布，也不进入页面。
- 正式运行串行执行，运行期间不要叠加其他负载或合盖。时间有限时可用 `--groups=pipeline,connections,memory,blocking` 按优先级分批运行，批次之间用同一个 `--group` 加 `--resume` 续跑；已完成的组合不会重测。`--resume --group=<同一标识>` 可跳过已完成的组合继续。
- 正式运行只发布完整、有效的场景组（全部场景组共 48 个组合；未完成的场景组不发布，页面标注为尚未测量）：采样覆盖、未命中、错误回复、驱逐、后台命令执行次数和容器清理均通过才写入 `site/data/redis.json`；旧文件备份到 `results/report-backups/`。
- 容器在运行结束或可捕获中断后被清理，数据卷不会被删除。SIGKILL 或 VM 故障后需手动检查遗留容器。

## 证据

每个组合保存预热和每次测量的 memtier 原始输出与 JSON、测量窗口前后的 `INFO` 快照、5 秒间隔的两端 CPU 与限流采样。60 秒测量窗口要求至少覆盖 48 秒、跨度不超过 70 秒、相邻间隔不超过 10 秒。发布时从这些原始记录重新计算指标，不信任已写入的汇总。

压测端 CPU 达到配额 90% 以上的组合会标记为“可能受压测端限制”，不能当作 Redis 的性能上限。Redis CPU 来自 `INFO` 进程 CPU 增量，包含后台线程，不等同于主线程占用。
