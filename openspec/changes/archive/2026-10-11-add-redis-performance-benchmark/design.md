## Context

见 proposal.md。现有 MySQL 体系：`benchmarks/mysql/scripts` 提供进程调用、JSON 读写、统计、重复运行协议（`measureRepeats`）、Docker Stats 资源采样与摘要校验；`site/` 为无框架静态站，`app.js` 与 `report.mjs` 针对 MySQL 的 `mysql.json` 结构，`site/server.mjs` 仅有 `/artifacts/mysql/` 原始数据路由。Docker VM 当前为 10 CPU / 8 GiB，足以容纳 Redis 2 CPU / 4 GiB 与压测端 4 CPU / 1 GiB。

Redis 与 MySQL 的差异决定了本设计不能照搬“场景 × 并发”矩阵：各场景自变量不同（命令、Pipeline 深度、value 大小、持久化模式、连接数、内存策略、后台慢命令），同一页面需要多种图表。

## Goals / Non-Goals

**Goals:**
- 以最小新增代码完成七个确认场景共 48 个组合，原始证据可复算，发布前整体验收。
- 让各场景呈现其自变量的真实影响，并如实标明压测端、Docker VM 带来的解释边界。

**Non-Goals:**
- 不建立通用多组件实验框架，不重构 MySQL 脚本或页面。
- 不做复制、Sentinel、Cluster、Lua、事务、`io-threads` 对比、BGSAVE/AOF rewrite 尾延迟专项、热 key 专项、`DEL` 与 `UNLINK` 对比。
- 不调和 Redis 与 MySQL 的数据结构或页面，也不新增跨组件对比图。

## Decisions

### 1. 工具与环境

压测工具选 `memtier_benchmark`（固定 2.1.x 及镜像摘要，实现时核验 arm64 清单），原因是它支持读写比、`--key-pattern` 的均匀/高斯分布、`--command` 自定义命令、`--pipeline`、`--print-percentiles` 与 JSON 输出；`redis-benchmark` 的比例控制与分位数输出较弱。Redis 选固定 7.4.x 镜像摘要；单实例、`io-threads 1`，默认 `save ""`、`appendonly no`、无 `maxmemory`，`protected-mode no`（仅内部网络）。Redis 2 CPU 用于覆盖单命令线程加后台线程与 fork，不期望 CPU 线性扩展。采用独立 compose 项目与独立网络、数据卷名，避免与 MySQL 容器冲突。后台慢命令客户端使用同一 Redis 镜像的 `redis-cli`（固定摘要，限 0.5 CPU），因为 memtier 无法驱动 `SCAN` 游标迭代，而 `redis-cli --scan` 可以。

备选：把 redis-cli 通过 `docker exec` 放进 Redis 容器 → 会占用被测容器的 CPU 配额，拒绝。

### 2. 复用与新增的脚本边界

新增 `benchmarks/redis/scripts/`：`protocol`（七场景矩阵与参数的单一事实来源）、`memtier`（参数构造与 JSON 解析）、`redis-info`（`INFO`/`CONFIG` 读取与窗口差分）、`prepare`（按组合装载数据）、`run`（执行器）、`collect`（复算与发布）、`resources`。进程调用、JSON 读写、`measureRepeats`、统计函数直接 `import` 自 MySQL 脚本，只在函数含 MySQL 专有假设时（例如 `summarizeResources` 以 `mysqlCpus` 命名参数）在 Redis 侧写薄封装，不改动 MySQL 文件，使既有 MySQL 单测保持原样。Redis 单个入口通过 `--formal`、`--dry-run`、`--verification`、`--no-publish`、`--publish-summary=<file>` 支持与 MySQL 相同的使用习惯。

### 3. 矩阵与数据准备

`protocol` 以数据形式声明七组 48 个组合，dry run 与正式执行读取同一份。每个组合流程：重启或复用该场景组需要的配置 → `FLUSHALL` → 按组合装载（`memtier --ratio=1:0 --key-pattern=P:P -n allkeys` 顺序填充；Hash/List/ZSet/计数器用 Lua `EVAL` 装载）→ 等待 `rdb_bgsave_in_progress=0` 且 `aof_rewrite_in_progress=0` → 预热 → 测量 ×2（可补第 3 次）。写命令设计为稳态：`set`/`incr`/`hset` 覆盖已有 key/field，`list_push_pop` 用 `LPUSH:RPOP=1:1`，ZSet 写使用 `ZINCRBY` 递增已有成员的分数。不用 `ZADD`：memtier 无法为同一 key 随机选择成员或生成分数，`ZADD` 对已有成员写同分是空操作，预热后几乎不触发重排，测出的不是真实的 O(log N) 更新成本；每次新增成员又会使结构无界增长。装载时间不计入测量但保存。

场景 3 的 key 数取名义载荷约 256 MiB：64B≈400 万、1KB≈25 万、10KB≈2.5 万、100KB≈2500。场景 6：`maxmemory 1 GiB`，全驻留约 0.5 GiB 载荷，超限组约 1.8 GiB 载荷（1KB × 约 180 万 key），均匀与高斯分布的标准差在数据清单中固定记录。场景 7：大 Hash 10 万字段；后台频率固定为 `HGETALL` 5 次/秒（`redis-cli -r -1 -i 0.2`）、`KEYS` 2 次/秒、`SCAN`（`redis-cli --scan --count 100`）连续循环，前台为 16 连接 GET；各参数在数据清单中记录而不是由运行时推断。

备选：全部场景共享一个“并集数据集”只装载一次 → 能省约 40 分钟，但不同命令互相影响内存布局与可比性，拒绝。

### 4. 测量协议与时长

沿用预热 30 秒、两次测量、差异超 30% 补第三次、均值/中位数规则；**每次测量 60 秒，而非 MySQL 的 90 秒**。理由：Redis 吞吐稳定，样本量充足，缩短后 48 组合净运行约 2 小时（48 × 150 秒 = 120 分钟），装载、重启、补跑另计，总计预计 3–3.5 小时。该偏离已写入 proposal 并需用户确认。资源采样门槛按 60 秒窗口设为覆盖 ≥48 秒、跨度 ≤70 秒、间隔 ≤10 秒（与热点实验一致）。已知风险：亚毫秒 p99 抖动可能使补跑频繁，规则不放宽。

### 5. 指标来源与 Redis 内部证据

吞吐与分位数取 memtier JSON（`--print-percentiles 50,95,99,99.9`）；hits/misses 取 memtier 并用 Redis `INFO` 交叉核对。预热结束与测量结束各读一次 `INFO`（`stats`、`memory`、`persistence`、`cpu`、`commandstats`、`errorstats`），保存原值和读取时间，指标为窗口差分：命令数、`used_cpu_sys/user` 增量（折算成相对窗口的 Redis 进程 CPU，含后台线程，不当作“主线程占用”）、`keyspace_hits/misses`、`evicted_keys`、`rdb_saves`、`aof_rewrites`、`latest_fork_usec`、`errorstat_OOM`。窗口秒数取实际读取时间差，而非名义 60 秒。

`noeviction` 组的拒绝写入以 `errorstat_OOM` 为准，不依赖 memtier 对错误回复的计数；memtier 对错误回复的行为在短验证中确认，若 memtier 对错误回复提前终止则调整该组 memtier 参数而非降低验收标准。

### 6. 饱和与压测端限制的判定

不以“Redis 吞吐上限”为前提：保存两端 CPU（占各自配额）。压测端 CPU ≥ 90% 配额的点标记 `loadgenBound`，页面显示标记且不归因为 Redis 上限。压测端容量标定（例如空 Redis 与不同 memtier 线程数）属于过程验证，只用于确定固定的线程与连接映射，不发布。Pipeline 256 与小 value 高连接组合最可能触发该标记。

### 7. 持久化场景细节

每个模式重启 Redis（数据卷挂载 `/data`），装载 100 万 key 后等待持久化稳定。RDB 模式沿用默认 `save 3600 1 300 100 60 10000`，写密集负载在 60 秒点必触发 BGSAVE，窗口内 `rdb_saves` 与 `latest_fork_usec` 随观测保存；AOF 模式依赖默认 `auto-aof-rewrite-*`，窗口内重写次数同样保存，不人为阻止后台活动。`always` 在 1 连接下表现最差而多连接可由组提交摊销，该结论由实测呈现，不预设。Docker VM（本机为 OrbStack）的存储是 VM 虚拟盘，页面与 README 必须说明其不代表物理 fsync。

### 8. 发布与数据文件

`site/data/redis.json` 由 collect 复算后原子写入，结构按场景分节（`scenarios.commands.points[]` 等），每点含汇总指标、全部观测、资源与 Redis 窗口证据、`loadgenBound` 标记及原始文件相对路径；`environment`、`protocol`、`dataset` 与 `testedAt` 位于顶层。原始输出、memtier JSON、INFO 快照、资源采样与数据清单保存在 `benchmarks/redis/results/`，由 `/artifacts/redis/` 路由提供。验证输出写入 `results/verification/`（gitignored），collect 拒绝读取该目录。发布前备份旧 `redis.json` 到 `site/data` 之外。

### 9. 页面结构

新增 `redis.html`、`redis-app.js`、`redis-report.mjs`，沿用 `styles.css` 与 `charts.mjs`、`report.mjs` 中与 MySQL 无关的格式化与坐标轴函数，不修改 MySQL 页面逻辑。版面：页头与环境摘要 → 实验结论 → 场景导航（锚点吸顶）→ 七个场景章节 → 可展开环境明细与逐次观测。每个章节包含一张主图、一张数值表和一句口径说明：

| 场景 | 主图 |
|---|---|
| 命令基线 | 按命令分组的 ops/s 条形，表含 p99 |
| Pipeline | 横轴深度（对数）折线，GET/SET 两线，吞吐与每批延迟双面板 |
| Value 大小 | 横轴大小（对数）折线，ops/s 与有效载荷带宽双面板 |
| 持久化 | 模式 × 连接数分组柱，ops/s 与 p99 双面板 |
| 连接数 | 横轴连接数折线，ops/s 与 p99 双面板 |
| 内存淘汰 | 四组指标卡：ops/s、p99、命中率、淘汰/秒、`used_memory` |
| 慢命令阻塞 | 四组前台 p99 / p99.9 / p99.99 条形与吞吐条形，表含最大延迟和后台命令次数 |

实验结论由页面端从数据推导，范围与稳定性随条目显示，缺失则不生成。`loadgenBound` 点用图标和脚注标记。索引页新增 Redis 条目；`site/server.mjs` 增加 `/artifacts/redis/` 路由。

备选：把 Redis 数据塞进现有 `mysql.json` 结构与页面 → 两个组件的自变量与指标不同，强行统一会污染 MySQL 的稳定逻辑，拒绝。

## Risks / Trade-offs

- [压测端先成为瓶颈，掩盖 Redis 差异] → 记录两端 CPU，标注 `loadgenBound`，标定在过程验证里固定线程映射；不声称 Redis 上限。
- [Docker VM（OrbStack）虚拟网络和虚拟盘影响延迟与 fsync] → 页面和 README 明确环境口径，不外推到生产。
- [60 秒测量短于 MySQL 协议] → 在 proposal 中显式列为待确认项；短测量用于稳态负载，两次加补跑规则保留稳定性标记。
- [亚毫秒 p99 抖动触发补跑过多，超出预计时长] → 规则不放宽，保留全部观测，时长预算含补跑。
- [memtier 对 OOM 错误回复的处理未知] → 以 `INFO errorstats` 为权威，在短验证中确认并调整参数。
- [写命令使数据逐步变化] → 设计为覆盖已有元素的稳态写，每个组合重新装载。
- [自定义命令（`--command`）的速率可能低于原生 GET/SET 路径] → 命令基线只在同一工具和同一连接数下相互比较，页面不与其他工具的数字对比。

## Migration Plan

先实现矩阵声明、memtier 与 `INFO` 解析、差分与验收的单测及页面 fixture 测试。再用 dry run 核对 48 组合，用短验证（过程验证、不发布）确认各组合的命令、数据、memtier 对错误回复的行为及压测端标定，并把结论告知用户；若需调整正式条件，先更新本 change 再实施。随后用防闲置休眠保护串行执行正式实验、复算、发布并检查桌面与移动截图和全部原始链接。发布失败保持原页面；不删除数据卷；归档按既有授权在验收后进行。

## Verification Findings

- memtier 要求 `__key__` 必须是独立参数，不能与前缀拼接，因此命令模板使用 `INCR __key__` 等，各组合开始前清库，装载 key 统一为 `memtier-<n>`。
- 闭环压测下一次阻塞只拖住 16 个在途请求，占请求总数不到万分之一，场景 7 的 p99 几乎不变（短验证：基线 0.319ms，后台 KEYS 0.327ms），而前台吞吐下降约 14%。因此场景 7 额外记录 p99.99 与最大延迟，并以吞吐变化与尾延迟表述结论。这只增加输出指标，不改变负载、矩阵或协议。
- 默认 AOF 自动重写在 100 万 key 覆盖写下约每 8 秒触发一次，AOF 组的窗口内重写次数随观测保存，不人为阻止。
- 高斯热点组在顺序装载后热点中心已被淘汰，需靠 SET 回填，命中率随预热时长收敛；以正式的 30 秒预热为准，页面说明该口径。
- memtier 默认以重复字符填充 value，RDB 前导压缩后基线极小，自动 AOF 重写阈值（基线的 2 倍）被频繁触发（60 秒窗口 25 次）。持久化场景因此使用 `--random-data` 装载并写入不可压缩的随机内容，窗口内重写降为约 5 次、RDB 的 COW 内存也接近真实。该选项只用于场景 4，其他场景为内存内读写，不受压缩影响。
- 时间受限时分批执行：`--groups` 按优先级选择场景组，同一 `--group` 下用 `--resume` 续跑；汇总从各组合保存的结果重建，发布只包含完整的场景组，覆盖信息写入 `coverage`，页面标注已覆盖与未测量场景。
