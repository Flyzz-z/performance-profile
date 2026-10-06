# MySQL Performance Benchmark

本项目在 macOS 的 Docker Linux VM 中运行 MySQL 8.4 LTS 和 sysbench，用于量化不同负载的吞吐和延迟，建立 `linux/arm64` 环境下的本地性能基线。

该结果不是标准 Linux 服务器或生产环境的性能上限。

## 环境

- 平台：`linux/arm64`
- MySQL：`8.4`，固定镜像摘要
- MySQL 资源：`4 CPU / 6 GiB`
- InnoDB Buffer Pool：`3 GiB`
- 负载端：`4 CPU / 1 GiB`
- 数据：10 张表，每张 100,000 行
- 正式场景：`point_select`、`update_index`、`update_index_async`、`read_write`
- 协议：预热 60 秒，正式运行 2 次、每次 120 秒；结果波动超过 10% 时补跑第 3 次
- 最终正式实验：4 个场景 × 3 个并发，测量约 60-84 分钟，准备时间另计

## 开发命令

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
- 沿用 60 秒预热、两次 120 秒、超阈值补第三次，纯测量约 30-42 分钟。
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

正式入口固定压测端4 CPU，单结果组串行执行四场景各1/8/32并发，共12组合，测量约60-84分钟，准备时间另计。只有完整协议、零错误、资源证据充分、日志恢复成功才整体替换当前看板，不再合并历史曲线。

每次正式测量通过本地Docker Stats API每5秒保存两端CPU累计使用和限流计数，至少覆盖80%测量时长。CPU单核百分比可达约400%，报告的配额占比按4 CPU归一化；限流累计时间不是墙钟百分比。

正式测量期间应保持宿主机和Docker VM持续运行。采样间隔超过10秒，或采样时间跨度超过130秒，视为证据不足；collector会重新检查原始采样，拒绝发布，不以跨度代替有效覆盖。

macOS可使用 `caffeinate -i npm run mysql:formal` 防止运行期间闲置休眠；避免合盖或手动暂停VM。经用户确认补测的受中断组合先完整隔离到本地 `results/verification/`，不能挑选其中较快的单次记录发布，也不放宽原校验规则。

`mysql:mvp`、`mysql:durability`及短参数仅保存开发资料，不覆盖最终看板。内部接口验证可以选择场景子集与短时长，自动标为verification；禁止作为最终曲线或结论来源。
