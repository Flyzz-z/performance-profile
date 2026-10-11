## Purpose

在固定的本地 Docker 环境下，以可复现的方式量化 Redis 单实例在命令类型、Pipeline、Value 大小、持久化、连接数、内存淘汰以及慢命令阻塞七类条件下的吞吐与延迟，使 Redis 的性能边界有证据可依。结果仅代表该本地环境，不代表生产服务器能力。

## ADDED Requirements

### Requirement: Fixed Redis test environment

系统 SHALL 在 `linux/arm64` Docker 环境中运行固定版本、固定镜像摘要的 Redis 7.x 单实例，Redis 容器配额为 2 CPU / 4 GiB，压测端 `memtier_benchmark`（固定版本及镜像摘要）配额为 4 CPU / 1 GiB。Redis MUST 使用单个命令执行线程（`io-threads` 为 1），默认关闭 RDB 与 AOF、不设置 `maxmemory`，仅在场景 4、6 中按该场景要求改变。

#### Scenario: Actual limits verified before measurement

- **WHEN** 准备或开始任一正式测量
- **THEN** 回读容器实际 CPU/内存限额、镜像摘要、平台架构、Redis 版本及相关 `CONFIG` 值，与上述固定环境及该场景要求核对
- **AND** 任一项不符时拒绝测量，不静默修改配额或配置

#### Scenario: Environment snapshot recorded

- **WHEN** 一个结果组产生正式观测
- **THEN** 保存该组实际的 Redis 与压测端配置、容器限额、Docker VM 与宿主机快照，以及测试日期
- **AND** 该快照是后续展示的唯一来源，不以当前环境覆盖历史记录

### Requirement: Confirmed formal scenario scope

系统 SHALL 仅把下列七个场景组及其矩阵作为正式实验，MUST NOT 把其他试验自动扩充为正式场景：

1. 命令基线：`get`、`set`、`incr`、`hget`、`hset`、`list_push_pop`、`zincrby`、`zrange`，固定 16 连接。`zincrby` 递增已有成员的分数，以代替对已有成员写同分时退化为空操作的 `zadd`。
2. Pipeline 深度：深度 1 / 16 / 64 / 256，命令 GET 与 SET，固定 16 连接。
3. Value 大小：64B / 1KB / 10KB / 100KB，命令 GET 与 SET，固定 16 连接。
4. 持久化策略：关闭 / RDB / AOF everysec / AOF always，100% SET，连接数 1 / 16 / 64。
5. 连接数：1 / 16 / 64 / 256，GET:SET 为 9:1 的混合负载。
6. 内存与淘汰：全驻留、`allkeys-lru` 均匀访问、`allkeys-lru` 高斯热点访问、`noeviction`，固定 16 连接，GET:SET 为 9:1。
7. 慢命令阻塞：无后台、后台 `HGETALL` 大 key、后台 `KEYS`、后台 `SCAN` 增量遍历，前台 GET 固定 16 连接。

#### Scenario: Complete formal matrix

- **WHEN** 完整执行正式实验
- **THEN** 共 48 个组合（8 + 8 + 8 + 12 + 4 + 4 + 4）均各自具有预热和有效测量记录
- **AND** 缺少任一组合的场景组不得作为完整场景组发布

#### Scenario: Batched execution within one run group

- **WHEN** 因时间限制分批执行场景组
- **THEN** 同一运行组可以按优先级分多次执行，已完成的组合在续跑时保持不变且不重测
- **AND** 各批次使用相同的环境、协议与数据口径，未测量的场景组在报告中明确标注为尚未测量

#### Scenario: Extra trials are not formal

- **WHEN** 存在 dry run、压测端标定、参数探索、瓶颈诊断或临时追加试验
- **THEN** 它们 MUST 被归类为过程验证，不加入七个场景、不作为新增曲线或代表性指标

### Requirement: Workload and dataset definition

压测 SHALL 使用 `memtier_benchmark`。除非场景另有规定，数据集为 100 万个 key、256B value，key 访问为均匀随机；连接数按 线程数×每线程客户端数 记录，映射固定为 1→1×1、16→2×8、64→4×16、256→4×64。每个组合 SHALL 在预热前清空并重新装载该组合所需数据，装载完成后确认 Redis 无进行中的后台保存或 AOF 重写。

#### Scenario: Structure-specific data preparation

- **WHEN** 运行 `hget`、`hset`、`list_push_pop`、`zincrby`、`zrange`
- **THEN** 使用预先装载且大小固定的 Hash、List、ZSet，其元素个数记录在数据清单中
- **AND** 写命令不得使被测结构无界增长，`list_push_pop` 以 1:1 的 LPUSH 与 RPOP 保持长度稳定

#### Scenario: Value-size dataset scaling

- **WHEN** 运行场景 3
- **THEN** key 数按 value 大小反比取整，使名义载荷规模大致相同，实际 key 数与 `used_memory` 写入证据
- **AND** 展示由 ops/s 推导的有效载荷带宽时，明确不含协议开销

#### Scenario: Read workload hit validation

- **WHEN** 读命令测量数据集应全部驻留
- **THEN** 测量窗口内的未命中数 MUST 为 0，否则该观测无效

### Requirement: Measurement protocol

每个组合 SHALL 预热 30 秒，随后正式测量 2 次、每次 60 秒；两次 ops/s 或 p99 相对差异超过 30% 时 MUST 补跑第 3 次。两次结果取均值，三次结果取中位数，并保留全部有效观测与稳定性标记。

#### Scenario: Unstable pair triggers a third run

- **WHEN** 同一组合的两次观测 ops/s 或 p99 差异超过 30%
- **THEN** 补跑第 3 次并采用中位数，三次观测均被保留
- **AND** 不得挑选或剔除其中任一有效观测

#### Scenario: Latency reported from tool output

- **WHEN** 汇总一个观测
- **THEN** 记录 ops/s、p50、p95、p99、p99.9、p99.99、最大延迟与错误数，均来自 `memtier_benchmark` 输出
- **AND** Pipeline 场景的延迟 MUST 标注为每批请求延迟

### Requirement: Persistence scenario configuration

场景 4 SHALL 在每个持久化模式下重启 Redis 并按该模式装载数据：关闭模式 `save ""` 且 `appendonly no`；RDB 模式使用 Redis 默认 `save` 策略且 `appendonly no`；AOF 模式 `appendonly yes` 且分别设置 `appendfsync everysec` 与 `always`。数据目录 MUST 位于 Docker 数据卷；装载与写入的 value MUST 使用不可压缩的随机内容，使 RDB 与 AOF 重写基线接近真实数据大小。

#### Scenario: Persistence activity evidence

- **WHEN** 完成一个持久化模式的测量
- **THEN** 保存测量窗口内 RDB 保存次数、AOF 重写次数、最近 fork 耗时及 AOF 相关计数的差分
- **AND** 结果说明磁盘为 Docker VM 虚拟存储，不代表物理磁盘 fsync 性能

### Requirement: Memory pressure and eviction configuration

场景 6 SHALL 设置 `maxmemory` 为 1 GiB。全驻留组数据名义载荷 MUST 低于 `maxmemory`；`allkeys-lru` 组与 `noeviction` 组数据名义载荷 MUST 明显高于 `maxmemory`。高斯热点组使用高斯 key 分布，其余使用均匀分布。

#### Scenario: Eviction and hit-ratio evidence

- **WHEN** 完成场景 6 的一个观测
- **THEN** 保存测量窗口内 `keyspace_hits`、`keyspace_misses`、`evicted_keys`、`used_memory` 以及 OOM 拒绝计数的差分
- **AND** 命中率由 Redis 命中与未命中增量计算

#### Scenario: Noeviction rejections are measured outcome

- **WHEN** `noeviction` 组因内存已满拒绝写入
- **THEN** 拒绝次数按 `INFO errorstats` 记录为测量结果，不作为无效观测
- **AND** 其他组合中的非零错误仍使观测无效

### Requirement: Slow command blocking configuration

场景 7 SHALL 在前台 GET 负载运行期间，通过独立后台客户端施加慢命令：`HGETALL` 针对固定的大 Hash（10 万字段）、`KEYS` 使用必然不匹配的模式扫描整个 100 万 key 数据集、`SCAN` 以固定 `COUNT` 增量遍历整个键空间。每个后台命令的频率和参数 MUST 在数据清单中固定记录。

#### Scenario: Foreground latency under background load

- **WHEN** 完成场景 7 的一个观测
- **THEN** 前台 GET 的 ops/s、p99、p99.9、p99.99 与最大延迟与无后台基线组使用同一数据和连接数
- **AND** 记录后台命令实际执行次数及 Redis 慢日志条数，页面不将该结果表述为通用的生产延迟

### Requirement: Resource and Redis internal evidence

每个正式测量 SHALL 每 5 秒采样 Redis 与压测端容器 CPU 累计使用和限流计数；60 秒测量窗口的有效采样覆盖 MUST 不少于 48 秒、总跨度不超过 70 秒、相邻间隔不超过 10 秒。系统 SHALL 在预热结束与测量结束时保存 Redis `INFO` 的差分所需字段，包括命令总数、命令累计 CPU、`used_memory`、内存碎片率、命中/未命中、淘汰数及错误统计。

#### Scenario: Insufficient sampling evidence

- **WHEN** 原始采样覆盖、跨度或间隔不满足门槛
- **THEN** 该观测证据不足，不得用于发布
- **AND** collector 从原始采样重新核验，不信任已写入的汇总

#### Scenario: Saturation context is recorded not assumed

- **WHEN** 展示或汇总某组合
- **THEN** 同时保存 Redis 进程 CPU 与压测端 CPU 相对各自配额的占比
- **AND** 压测端 CPU 接近配额时，结果 MUST 标记为可能受压测端限制，不得被称为 Redis 上限

### Requirement: Process verification isolation

dry run、冒烟测试、正确性验证、压测端标定、参数探索与瓶颈诊断 MUST 默认归为过程验证，其输出 SHALL 写入独立的 verification 目录，不得被发布流程读取。

#### Scenario: Dry run changes nothing

- **WHEN** 以 dry run 执行
- **THEN** 只读列出完整 48 组合矩阵、数据规模、协议及预计时长
- **AND** 不启动容器、不写结果文件

#### Scenario: Verification result cannot be published

- **WHEN** 发布流程收到来源为 verification 的结果
- **THEN** 拒绝发布，页面数据文件保持不变

### Requirement: Atomic and verified publication

系统 SHALL 仅发布完整的场景组：组内全部组合有效、零非预期错误、资源与 Redis 证据充分，且容器清理与配置恢复成功，才原子地写入页面数据文件。不完整的场景组 MUST NOT 发布，并在数据文件中记录为未覆盖。发布前 MUST 从原始记录重新计算汇总，并保留正式原始数据以便追溯。

#### Scenario: Incomplete or inconsistent evidence

- **WHEN** 已声明覆盖的场景组存在缺失组合、混批结果、协议或环境不符、采样不足、未命中非零或恢复失败
- **THEN** 拒绝发布，已发布数据文件内容保持不变

#### Scenario: Partially measured group is not published

- **WHEN** 某场景组只完成了部分组合
- **THEN** 该场景组不进入报告，覆盖信息将其列为未完成，其余完整场景组正常发布
- **AND** 没有任何完整场景组时拒绝发布

#### Scenario: Interrupted run cleanup

- **WHEN** 运行因可捕获的中断而终止
- **THEN** 清理本入口创建的压测与后台客户端容器，并记录需要人工检查的状态
- **AND** 不删除数据卷，不发布残缺结果
