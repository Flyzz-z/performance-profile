# MySQL Performance Benchmark

本项目在 macOS 的 Docker Linux VM 中运行 MySQL 8.4 LTS 和 sysbench，用于量化不同负载的吞吐和延迟，建立 `linux/arm64` 环境下的本地性能基线。

该结果不是标准 Linux 服务器或生产环境的性能上限。

## 环境

- 平台：`linux/arm64`
- MySQL：`8.4`，固定镜像摘要
- MySQL 资源：`8 CPU / 6 GiB`
- InnoDB Buffer Pool：`3 GiB`
- 负载端：`4 CPU / 1 GiB`
- 数据：10 张表，每张 100,000 行
- 正式场景：`point_select`、`update_index`、`update_index_async`、`update_no_secondary_index`、`insert`、`read_write`
- 协议：预热 30 秒，正式运行 2 次、每次 90 秒；TPS 或 p99 差异超过 30% 时补跑第 3 次
- 最终正式实验：6 个场景 × 并发 1/8/16，另含独立 Buffer Pool 1/2 GiB 两组实验及16并发热点更新实验；主测试与缓存测量约 91.5-133 分钟，热点实验另需3分钟，准备与重启时间另计

## 独立热点更新实验

```bash
npm run mysql:hot-update -- --dry-run
npm run mysql:hot-update -- --verification
caffeinate -i npm run mysql:hot-update
```

固定16并发，每组预热30秒、测量60秒，只测一次、不补跑。两组各自prepare 10表×100000行，均使用标准`oltp_update_index.lua`的单条自动提交`UPDATE k=k+1`及均匀随机选表。分散组访问全100万行，热点组只访问每表id=1（共10行）；热点运行参数`--table-size=1`不表示物理表被缩小。两组相同ARM64、MySQL 8 CPU/6 GiB、sysbench 4 CPU/1 GiB、3 GiB缓存和redo=1/sync_binlog=1/binlog ON。

锁计数仅取预热结束后、正式负载结束后的`Innodb_row_lock_waits`和`Innodb_row_lock_time`差分；平均等待=累计毫秒/次数，等待速率=次数/实际窗口秒数。零等待保留为0，不使用全局累计平均值。累计等待汇总多个线程，不能当墙钟占比；吞吐差额同时包含缓存、日志和调度影响，不能全部称为纯锁开销。失败数取sysbench ignoredErrors，重连另外展示；完整有效的非零错误结果不剔除或重测。

正式资源每5秒采样，60秒测量要求至少48秒覆盖、最多70秒跨度、最大间隔10秒。只在两组原始证据及恢复验收通过后原子合并`hotUpdateExperiment`，不修改主实验、缓存、日期或代表值；`--no-publish`仅保留正式证据。短验证落在`results/verification/`，不能发布。支持SIGINT/SIGTERM清理自己创建的容器及恢复日志；SIGKILL/VM故障后必须人工检查遗留容器及日志，不发布残缺实验。运行期间不要执行其他负载或合盖。

保留的完整正式summary可通过`npm run mysql:hot-update -- --publish-summary=benchmarks/mysql/results/<group>-hot-update.json`重新复算验收并发布。

## 常规命令

```bash
npm run mysql:up
npm run mysql:prepare
npm run mysql:benchmark
npm run mysql:collect
npm run site
```

执行前检查完整运行矩阵而不启动负载：

```bash
npm run mysql:benchmark -- --dry-run
```

清理容器和数据卷：

```bash
npm run mysql:down
```

完整 MVP 可执行：

```bash
npm run mysql:mvp
```

## 同步与异步索引更新

```bash
npm run mysql:durability -- --dry-run
npm run mysql:durability
```

两组复用同一更新 SQL，同批测试并发 `1/8/32`：

- 同步：`innodb_flush_log_at_trx_commit=1`、`sync_binlog=1`。
- 异步：`innodb_flush_log_at_trx_commit=2`、`sync_binlog=0`。
- 两组均要求 binlog 开启，刷盘周期配置为 1 秒，不承诺严格一秒持久化。
- 每组合重新生成原 `sbtest`，保持同规模和种子；不保存原数据库状态或逻辑快照。
- 使用当前默认 30 秒预热、两次 90 秒、超阈值补第三次，准备时间另计。
- 实际参数回读并写入每组环境，结束/错误/可捕获中断后恢复原值。
- 该策略专用入口只保存结果，不更新最终看板；正式发布使用 `mysql:formal`。

短验证不会更新正式看板：

```bash
npm run mysql:durability -- --concurrency=1 --warmup-seconds=2 --duration-seconds=5 --runs=1 --run-group=smoke-durability
```

不要同时运行其他基准。此轻量入口不提供并发锁或强制终止后的自动恢复。若被 SIGKILL 或 VM 故障终止，先停止遗留的本次 sysbench 容器，再检查日志参数；可停止/重新启动项目 MySQL 以恢复 `my.cnf` 默认值，不要继续发布该次结果。

异步刷盘降低持久化保障：系统、VM 或断电故障可能丢失已确认事务或 binlog。该对照同时改变两个日志参数，只量化联合影响，不证明任何独立日志贡献或生产性能。

## 最终正式实验

```bash
npm run mysql:formal -- --dry-run
npm run mysql:formal
```

正式入口固定MySQL 8 CPU、压测端4 CPU，单结果组串行执行六场景各1/8/16并发，共18组合。无二级索引更新只移除k索引，保留主键，仍执行相同的k=k+1单行UPDATE。单行INSERT使用自增主键及k二级索引，每次重复预热前重新准备100万行，记录预热与测量起止行数。INSERT写入完整新记录，与只修改k的UPDATE不构成纯索引维护成本对照。

独立缓存实验固定16并发，使用同一冻结数据集，只有Buffer Pool容量为1 GiB或2 GiB。初始10表各60万行，按实际主键页占用校准至1.4–1.6 GiB，均匀随机访问完整ID范围。两组独立重启、禁用历史缓存加载，instances=1、chunk=128 MiB；固定30秒预热，记录趋稳情况，测量与补跑规则相同。近似页命中率为1减去Innodb_buffer_pool_reads增量/read_requests增量；缺页读取速率为reads增量/窗口秒数。这是InnoDB页面未命中口径，不等于SQL命中率、操作系统缺页或实际SSD物理读取。

只有18组合及缓存两组完整、零错误、资源和数据证据充分、日志及缓存恢复成功才整体替换当前看板。缓存结果独立展示，不加入主场景曲线或交叉比较。只执行测试而暂不发布可传`--no-publish`，验收后执行`npm run mysql:collect -- --formal --run-group=<group> --publish`重新核验和发布。

每次正式测量通过本地Docker Stats API每5秒保存两端CPU累计使用和限流计数，至少覆盖80%测量时长。CPU单核百分比可能超过100%，配额占比分别按MySQL 8 CPU、sysbench 4 CPU归一化；限流累计时间不是墙钟百分比。

正式测量期间应保持宿主机和Docker VM持续运行。采样间隔超过10秒，或采样时间跨度超过100秒，视为证据不足；collector会重新检查原始采样，拒绝发布，不以跨度代替有效覆盖。

macOS可使用 `caffeinate -i npm run mysql:formal` 防止运行期间闲置休眠；避免合盖或手动暂停VM。经用户确认补测的受中断组合先完整隔离到本地 `results/verification/`，不能挑选其中较快的单次记录发布，也不放宽原校验规则。

`mysql:mvp`、`mysql:durability`及短参数仅保存开发资料，不覆盖最终看板。内部接口验证可以选择场景子集与短时长，自动标为verification；禁止作为最终曲线或结论来源。
