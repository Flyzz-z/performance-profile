# mysql-index-read-comparison Specification

## Purpose

定义相同逻辑数据与等值查询在有二级索引和无可用查询索引时的独立正式性能对照，明确数据选择性、执行计划、资源环境、重复协议及发布证据，使吞吐与延迟差异能够在同并发条件下量化和追溯。

## Requirements

### Requirement: Controlled equality read dataset
系统 SHALL 为有索引与无二级索引两组分别提供 10 张表、每表 100,000 行的相同冻结逻辑数据，保留 `id` 自增主键及现有 `k`、`c`、`pad` 列。`k` SHALL 在每表的 1–100,000 范围内一一对应记录；两组仅改变是否存在单列、非唯一的 `k` 二级索引，MUST NOT 改变载荷、行数、列类型或主键。

#### Scenario: Paired datasets are frozen
- **WHEN** 独立实验数据准备完成
- **THEN** 两组各有 1,000,000 行，并保存每表实际结构、索引、行数、查询键范围与逻辑数据一致性证据
- **AND** 所有可查询的 `k` 都恰好匹配一行，`c` 不包含于 `k` 二级索引
- **AND** 数据在全部预热和测量期间只读，结束后再次核验一致性
- **AND** 实验使用自身专属数据库，不重置、写入或删除既有 `sbtest` 数据及既有实验资料

#### Scenario: Dataset is not comparable
- **WHEN** 两组存在重复或缺失查询键、载荷差异、结构差异超出允许索引差异，或数据在测量期间改变
- **THEN** 实验不能作为正式结果发布，不以抽取较快观测或重新解释场景绕过数据验收

### Requirement: Identical read semantics and verified access paths
两组 SHALL 使用同一条参数化 SQL `SELECT c FROM 表 WHERE k=?`，每事件一条 SELECT，均匀随机选择十张表及完整查询键范围，采用相同随机规则和种子 42；每成功事件 SHALL 返回一行相同载荷。有索引组 SHALL 经 `k` 二级索引定位并回表，无二级索引组 SHALL 全表扫描，保留的主键不作为谓词的访问索引。

#### Scenario: Access paths match the experiment
- **WHEN** 准备测量任一组
- **THEN** 核验十张表的执行计划，有索引组使用 `k` 索引等值访问，无二级索引组为 `ALL` 且不使用查询索引
- **AND** 保存实际 SQL 模板、绑定参数范围、负载脚本身份及原始执行计划，测量后重新核验
- **AND** 不使用 `WHERE id=?`、`SELECT COUNT(*)`、`LIMIT`、覆盖索引查询或批量查询替换本实验语义
- **AND** 保存查询结果正确性证据；正式事件的返回行数异常计为错误

#### Scenario: Workload or plan is unexpected
- **WHEN** 索引组走全表扫描、无二级索引组使用查询索引、SQL 或脚本身份不符、成功事件不返回一行
- **THEN** 正式发布被拒绝，已有报告继续保留

### Requirement: Confirmed independent environment
正式实验 SHALL 使用与既有正式报告一致的 MySQL 版本与镜像、sysbench 软件与基础镜像及 `linux/arm64` 平台；实际配额为 MySQL 8 CPU / 6 GiB、sysbench 4 CPU / 1 GiB，Buffer Pool 3 GiB，binlog 开启且 redo/sync_binlog/timeout 为 1/1/1。两组 SHALL 保存自己的真实环境与测量日期，MUST NOT 用历史清单代替当前回读证据。

#### Scenario: Environment is verified
- **WHEN** 正式实验启动及任一测量开始
- **THEN** 核验实际容器归属、配额、运行镜像、软件、Buffer Pool 和日志策略，确认没有叠加其他负载
- **AND** 两组使用相同硬件与软件条件串行测量，每事件一条查询，因此 QPS 与 TPS 使用相同事件口径
- **AND** 结果标注为本地 Docker 基准，不声称生产容量或独立物理核
- **AND** 周期性容器健康检查仅检查 mysqld 进程和 socket，不建立 MySQL 连接；启动入口继续执行 SQL 确认可用性

#### Scenario: Confirmed conditions cannot be met
- **WHEN** 当前版本、镜像、配额或配置与确认条件不符，或者出现其他负载
- **THEN** 正式测量或发布被拒绝，不自动调整正式条件继续运行；条件变更须另行确认

### Requirement: Complete six combination repeat protocol
系统 SHALL 独立测量两组各 1/8/16 并发，共六组合；每组合先预热 30 秒，再进行两次 90 秒测量，TPS 或 p99 差异超过 30% 时追加第三次 90 秒测量。两次取均值、三次取中位数，沿用现有稳定性口径并保留全部观测。

#### Scenario: Complete paired measurements finish
- **WHEN** 六组合均完成正式测量
- **THEN** 保存各组合预热、两次或三次正式输出、实际参数、时间及错误数
- **AND** 保留不稳定组合的全部有效结果和稳定性标记，不通过剔除较慢观测美化结论
- **AND** 只有相同并发的两组汇总值才能计算吞吐倍数或延迟差异

#### Scenario: Adaptive third measurement is required
- **WHEN** 同组合首两次 TPS 或 p99 波动超过 30%
- **THEN** 该组合必须完成第三次测量才满足正式协议，不接受缺少第三次的汇总

### Requirement: Traceable resource and measurement evidence
每次 90 秒正式测量 SHALL 保存 sysbench 原始输出、标准化记录、数据与环境清单、SQL 与脚本身份，以及两端 5 秒间隔资源原始采样；发布验收 SHALL 从这些原始资料复算指标和重复协议，不只信任汇总 JSON。

#### Scenario: Original evidence passes validation
- **WHEN** 验收一项正式观测
- **THEN** 原始输出证实并发、测量时长、有效事务及查询数，错误和重连均为零，且与标准化记录一致
- **AND** 资源采样至少覆盖 72 秒、跨度不超过 100 秒、最大连续间隔不超过 10 秒，实际 CPU/内存限额与确认条件一致
- **AND** CPU 以两端各自配额归一化，并分别记录采样覆盖、限流次数和累计限流时间

#### Scenario: Evidence is incomplete or inconsistent
- **WHEN** 缺失原始资料、计数无效、采样不足、正式时长不完整或复算与汇总不一致
- **THEN** 拒绝发布，不以零值、预热、短测或额外临时试验补齐正式指标

### Requirement: Owned cleanup and verified restoration
实验 SHALL 在成功、错误及可捕获中断后停止自己创建的压测端容器和资源采样，核验 MySQL 日志、缓存及原有数据库状态符合运行前的确认条件；MUST NOT 删除共享数据卷或处理不属于本次实验的容器、数据库及文件。

#### Scenario: Experiment exits cleanly
- **WHEN** 实验完成或收到 SIGINT/SIGTERM
- **THEN** 清理自身负载，保存退出状态、容器归属和配置回读资料
- **AND** 仅在正式运行成功且结束验收通过时允许发布，错误或中断记录仅供追溯

#### Scenario: Restoration cannot be verified
- **WHEN** 结束回读失败、配置不符、数据改变或无法确认自身负载已停止
- **THEN** 不发布新实验，明确标记需要处理的状态，已有报告不变

### Requirement: Independent formal publication and verification isolation
系统 SHALL 提供独立实验入口及只读 dry run、过程验证、正式只测不发布和原始证据验收发布方式；只有同一正式结果组的六组合、两组数据与计划、软件资源及结束验收全部通过后，才能将 `indexReadExperiment` 原子合并到现有报告。

#### Scenario: Complete formal experiment is appended
- **WHEN** 独立正式验收通过并发布
- **THEN** 新实验携带自身实验标识、日期、协议、两组环境、各并发观测与资料路径
- **AND** 保留发布前备份，并检测并发修改以避免覆盖其他编辑
- **AND** 既有六场景、32 并发补测、缓存、热点、环境及日期等其他字段深度保持一致，主矩阵和通用 partial 验收规则不放宽

#### Scenario: Dry run and verification remain process material
- **WHEN** 执行 dry run 或短参数验证
- **THEN** dry run 只输出计划，不启动服务、创建目录、修改数据库或结果文件
- **AND** 验证资料位于独立验证目录、明确标为 verification，不能被正式发布入口接受或出现在最终页面

#### Scenario: Publication is incomplete or conflicts
- **WHEN** 缺组、混合正式组、重复使用既有原始标识、验证来源、配置或恢复不符，或发布时报告发生并发修改
- **THEN** 拒绝覆盖，保留当前报告和已有原始证据
