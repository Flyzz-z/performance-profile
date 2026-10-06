# MySQL Performance Benchmark

本项目在 macOS 的 Docker Linux VM 中运行 MySQL 8.4 LTS 和 sysbench，用于验证性能测试流程并建立 `linux/arm64` 环境下的本地探索性基线。

该结果不是标准 Linux 服务器或生产环境的性能上限。

## 环境

- 平台：`linux/arm64`
- MySQL：`8.4`，固定镜像摘要
- MySQL 资源：`4 vCPU / 6 GB`
- InnoDB Buffer Pool：`3 GB`
- 负载端：`1 vCPU / 1 GB`
- 数据：10 张表，每张 100,000 行
- 场景：`point_select`、`update_index`、`read_write`
- 协议：预热 60 秒，正式运行 2 次、每次 120 秒；结果波动超过 10% 时补跑第 3 次
- 完整 MVP：3 个场景 × 3 个并发，预计 45-65 分钟

## 命令

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
- 完整测试恢复成功后自动汇总和更新看板；`--no-publish` 可以只保存结果。

短验证不会更新正式看板：

```bash
npm run mysql:durability -- --concurrency=1 --warmup-seconds=2 --duration-seconds=5 --runs=1 --run-group=smoke-durability
```

不要同时运行其他基准。此轻量入口不提供并发锁或强制终止后的自动恢复。若被 SIGKILL 或 VM 故障终止，先停止遗留的本次 sysbench 容器，再检查日志参数；可停止/重新启动项目 MySQL 以恢复 `my.cnf` 默认值，不要继续发布该次结果。

异步刷盘降低持久化保障：系统、VM 或断电故障可能丢失已确认事务或 binlog。该对照同时改变两个日志参数，只量化联合影响，不证明任何独立日志贡献或生产性能。
