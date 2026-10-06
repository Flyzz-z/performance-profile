# Proposal

## Why

项目需要先完成一个可复现的组件性能测试闭环，证明测试环境、实验协议、结果模型和网页呈现能够协同工作。MySQL 作为第一个组件，可以在相同资源、数据和并发条件下直接比较读、写及混合负载，为后续 Redis、etcd 和 HBase 建立统一范式。

## What Changes

- 新增 MySQL 8.4 LTS 的容器化性能测试环境，固定 ARM64 平台、镜像摘要、资源配额和 InnoDB 配置。
- 使用 sysbench 准备 10 张表、每张 100,000 行的固定数据集。
- 新增 `point_select`、`update_index` 和 `read_write` 三个场景，分别代表纯读、写路径和读写混合负载。
- 每个“场景 + 并发”组合预热 60 秒，正式运行 2 次、每次 120 秒；两次关键指标差异超过 10% 时自动补跑第 3 次。
- 保存 sysbench 原始输出、标准化的单次运行记录、组合汇总和读写对比结果。
- 新增 MySQL 组件详情页和索引页入口，明确标注结果来自 macOS 上的本地 Docker 探索性环境。
- 新增一条可复现的命令链，用于准备数据、执行测试、汇总结果并生成页面数据。

## Capabilities

### New Capabilities

- `mysql-performance-benchmark`: 定义 MySQL MVP 的固定运行环境、三类测试场景、运行协议、结果契约和网页展示要求。

### Modified Capabilities

无。

## Impact

- 新增 `benchmarks/mysql/` 下的容器编排、MySQL 配置、测试脚本、解析脚本和结果文件。
- 新增网页数据、MySQL 详情页和索引页入口。
- 新增 npm 脚本，用于准备数据、运行测试、汇总结果和生成本地页面。
- 数据库数据卷、Docker 镜像和临时文件不进入 Git；可复现配置、原始 sysbench 输出、标准化结果和汇总结果进入 Git。
- 本变更只建立 MySQL 的本地 Docker 探索性基线，不声明生产服务器性能，也不修改其他组件能力。
