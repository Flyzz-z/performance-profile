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
