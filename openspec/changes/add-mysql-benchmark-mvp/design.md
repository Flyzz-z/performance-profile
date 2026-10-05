# Design

## Context

项目当前只有 Git、OpenSpec 和基础项目元数据，没有既有测试实现。首个组件测试必须在当前 Mac 和 OrbStack Docker 环境中完成；Docker 提供的是 Linux ARM64 虚拟化环境，因此结果用于验证流程和本机相对趋势，不能表达标准 Linux 服务器的绝对性能。

当前宿主机有 16 GB 物理内存，OrbStack 可用 10 CPU 和约 8 GB 内存；`mysql:8.4` 镜像已经存在。MySQL 与 sysbench 必须串行使用同一资源额度，避免多个被测组件争抢资源。

## Goals / Non-Goals

**Goals:**

- 建立可重复执行的 MySQL 容器、数据集、测试协议和结果流水线。
- 用相同数据集和资源配额直观呈现纯读、写路径和读写混合负载差异。
- 生成原始输出、标准化结果、汇总结果和 MySQL 网页数据。
- 让同一套测试控制层可以迁移到 Linux 服务器运行。

**Non-Goals:**

- 比较多个 MySQL 版本或数据库产品。
- 调优 Buffer Pool、隔离级别、redo、binlog 和文件系统参数。
- 测试主从复制、高可用、故障恢复或长时间稳定性。
- 使用复杂业务 SQL、Join 或自定义 schema。
- 在本变更中实现 Redis、etcd 或 HBase。

## Decisions

### 使用独立 MySQL 与 sysbench 容器

MySQL 容器固定为 `linux/arm64`、`4 vCPU`、`6 GB` 内存和 `3 GB` InnoDB Buffer Pool。sysbench 在独立负载容器中运行，使用 `1 vCPU` 和 `1 GB` 内存，并通过 Docker 内部网络连接 MySQL。

选择独立容器是因为负载生成器自身会消耗 CPU 和网络；同容器运行会让 MySQL 与压测程序互相争抢资源。负载容器不暴露到公网，也不参与网页服务。

备选方案是在宿主机运行 sysbench，但 macOS 到 Docker 的额外网络和工具版本差异会增加不可控因素。

### 使用固定 sysbench 数据集和标准场景

数据集固定为 10 张表、每张 100,000 行。场景固定为 `oltp_point_select`、`oltp_update_index` 和 `oltp_read_write`。

选择 `update_index` 而不是插入型场景，是因为更新不会持续改变数据规模，能够在相同并发下与点查直接比较。`insert` 会增长数据并改变后续运行条件，留待后续独立场景。

### 使用可重复的预热和自适应重复协议

每个组合先预热 60 秒，再执行两次 120 秒正式运行。系统比较两次的 TPS 和 p99；任一关键指标差异超过 10% 时增加到三次，并使用中位数作为最终值。两次稳定时使用平均值，同时保留原始两次结果。

选择该协议是因为增加单次时长主要验证稳态，增加重复次数主要验证环境波动。Docker 虚拟化环境的运行间波动较大，因此不能完全用时长替代重复；自适应第三次运行降低了稳定场景的时间成本。

### 使用三层结果流水线

结果分为：

1. `raw/`：sysbench 原始标准输出和实际命令。
2. `normalized/runs.jsonl`：每次运行一条结构化记录，包含环境、协议和指标。
3. `summary/`：按组合聚合的稳定性数据、读写对比和网页数据。

解析和聚合使用项目已有的 Node.js 运行时，避免为 MVP 引入新的应用框架。原始文本始终保留，汇总不得成为唯一事实来源。

### 使用数据驱动的静态页面

网页采用静态 HTML、CSS 和浏览器 JavaScript，从 `site/data/mysql.json` 读取汇总数据。索引页和 MySQL 详情页不直接解析 sysbench 文本。

选择静态页面是因为 MVP 只需要展示固定测试结果，不需要服务端查询。该结构后续可以替换为框架实现，而无需改变结果契约。

### 使用 named volume 保存数据库数据

MySQL 数据使用 Docker named volume，不使用 macOS bind mount。macOS 与 Linux VM 之间的文件共享会增加不稳定的 I/O 开销，named volume 更接近容器内的持久化路径，也更适合重复测试。

## Risks / Trade-offs

- [Docker 虚拟化 I/O 影响写性能] → 固定 named volume、记录或标注依赖默认持久化，并明确结果只代表当前本机环境。
- [sysbench 负载容器成为瓶颈] → 为负载容器保留独立 CPU，并记录客户端侧运行状态；出现异常时不得将结果归因于 MySQL。
- [10% 阈值触发过多补跑] → 每个组合最多增加一次正式运行，不进行无限重试。
- [镜像和 apt 包版本漂移] → 固定 MySQL 镜像摘要并记录 sysbench 包版本；任何版本变化生成新的环境清单。
- [结果文件进入 Git 后体积增长] → 只提交文本原始输出、JSON 和网页数据，不提交数据库卷或镜像。
- [本地结果被称为通用 MySQL 性能] → 数据文件、页面标题和 README 都使用 `local Docker benchmark` 标签。

## Migration Plan

该变更为全新能力，不需要迁移已有数据。首次运行按以下顺序部署：

1. 启动固定配置的 MySQL 并完成健康检查。
2. 准备 sysbench 数据集并记录环境清单。
3. 依次执行三个场景和自适应重复协议。
4. 生成标准化结果、汇总结果和 `site/data/mysql.json`。
5. 构建并检查 MySQL 详情页与索引页。

回滚时可以停止并删除本次容器和数据卷，保留 Git 可恢复的配置与结果文件。
