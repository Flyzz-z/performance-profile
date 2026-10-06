# mysql-performance-benchmark Specification

## Purpose
定义 MySQL 在固定本地 Docker 环境中的可复现性能测试、结果记录、读写对比和网页展示行为，为后续组件建立统一测试范式。
## Requirements
### Requirement: Fixed benchmark environment

MySQL 性能测试 SHALL 运行在可识别的固定环境中，记录 MySQL 版本、镜像摘要、CPU 架构、容器资源配额、Buffer Pool 配置、Docker 运行时和宿主机信息。该环境 SHALL 明确标注为本地 Docker 探索性环境，而不是生产服务器基线。

#### Scenario: Environment manifest is produced

- **WHEN** 用户启动一次 MySQL 测试
- **THEN** 系统生成环境清单，包含 MySQL 版本、镜像摘要、`linux/arm64` 平台、`4 vCPU`、`6 GB` 内存、`3 GB` Buffer Pool、Docker 运行时和宿主机信息
- **AND** 环境清单与本次运行结果关联

#### Scenario: Production claim is prevented

- **WHEN** 网页展示本机 Docker 测试结果
- **THEN** 页面必须显示 `local Docker benchmark` 或等价中文标记
- **AND** 不得将结果描述为标准 Linux 服务器或生产环境性能上限

### Requirement: Deterministic benchmark dataset

测试 SHALL 使用固定规模和结构的 sysbench 数据集，并在 `point_select`、`update_index` 和 `read_write` 场景之间复用同一份数据。

#### Scenario: Dataset preparation succeeds

- **WHEN** 用户执行数据准备命令
- **THEN** 系统创建 10 张表，每张表包含 100,000 行
- **AND** 记录表数量、行数、准备命令和完成状态

#### Scenario: Prepared dataset is reused

- **WHEN** 用户依次执行三个测试场景
- **THEN** 每个场景引用同一数据规模和 MySQL 配置
- **AND** 测试过程不得通过额外的数据增长改变场景间的可比性

### Requirement: Representative workload scenarios

测试 SHALL 提供纯读、写路径和读写混合三类场景，并保持每个场景的数据集、MySQL 配置和资源配额一致。

#### Scenario: Pure read workload

- **WHEN** 用户运行 `point_select` 场景
- **THEN** sysbench 按主键执行随机单行查询
- **AND** 结果记录事务数、查询数、TPS、QPS、延迟和错误数

#### Scenario: Write workload

- **WHEN** 用户运行 `update_index` 场景
- **THEN** sysbench 随机更新带索引的数据行
- **AND** 测试结果明确体现写路径、索引维护和持久化开销

#### Scenario: Mixed workload

- **WHEN** 用户运行 `read_write` 场景
- **THEN** sysbench 执行读写混合负载
- **AND** 结果可以与纯读和写场景在相同并发下比较

### Requirement: Adaptive repeat protocol

每个“场景 + 并发”组合 SHALL 先预热 60 秒，再执行两次 120 秒的正式运行；当两次运行的关键指标差异超过 10% 时，系统 SHALL 自动执行第三次正式运行。

#### Scenario: Stable pair completes

- **WHEN** 两次正式运行的 TPS 或 p99 差异不超过 10%
- **THEN** 系统保留两次结果并计算平均值、最小值、最大值和波动比例
- **AND** 不需要执行第三次运行

#### Scenario: Unstable pair triggers third run

- **WHEN** 两次正式运行的 TPS 或 p99 差异超过 10%
- **THEN** 系统自动执行第三次正式运行
- **AND** 在汇总中同时保留三次运行结果和最终选定的汇总值

### Requirement: Traceable benchmark results

系统 SHALL 保存每次测试的原始 sysbench 输出、标准化运行记录和组合汇总，并保证汇总结果可以追溯到原始运行。

#### Scenario: Successful run is persisted

- **WHEN** 一次 sysbench 运行成功
- **THEN** 系统保存原始文本、运行标识、场景、并发、重复次数、环境清单、协议参数、TPS、QPS、延迟和错误数
- **AND** 标准化记录包含对应原始文本的路径

#### Scenario: Failed run is visible

- **WHEN** 一次 sysbench 运行失败或包含非零错误数
- **THEN** 系统将该次运行标记为失败或异常
- **AND** 汇总和网页不得把失败运行当作有效性能结果

### Requirement: Read versus write comparison

结果 SHALL 在相同并发下比较 `point_select`、`update_index` 和 `read_write`，同时提供 TPS、QPS、p95、p99 以及读写比值，避免仅使用 TPS 描述读写差异。

#### Scenario: Comparison metrics are generated

- **WHEN** 三个场景在相同并发下均产生有效结果
- **THEN** 系统计算写吞吐相对读吞吐的比值、写 p95 相对读 p95 的倍数和写 p99 相对读 p99 的倍数
- **AND** 汇总记录各场景每次事务包含的查询数量

#### Scenario: Comparison remains comparable

- **WHEN** 系统生成读写对比
- **THEN** 对比只使用相同数据集、相同 MySQL 配置和相同并发的结果
- **AND** 不同事务语义的值必须带有相应说明

### Requirement: MySQL web presentation

系统 SHALL 生成一个 MySQL 组件详情页，并在项目索引页提供 MySQL 入口卡片。详情页 SHALL 展示环境、测试协议、吞吐、延迟、读写差异、运行稳定性和限制。

#### Scenario: MySQL detail page is generated

- **WHEN** 有效测试结果完成汇总
- **THEN** MySQL 详情页展示并发数到 QPS/TPS 的曲线、并发数到 p95/p99 的曲线和读写对比结果
- **AND** 页面展示测试环境、协议、稳定性结果、原始数据入口和限制说明

#### Scenario: Index page links to MySQL

- **WHEN** 用户打开项目索引页
- **THEN** 页面展示包含 MySQL 版本、环境标签和代表性指标的卡片
- **AND** 用户可以从卡片进入 MySQL 详情页
