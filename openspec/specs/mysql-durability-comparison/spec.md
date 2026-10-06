# mysql-durability-comparison Specification

## Purpose
以复用现有准备、运行、汇总及看板的轻量方式新增异步索引更新，与同批同步更新进行性能对照，并准确记录实际日志配置、恢复原值及说明持久化风险。
## Requirements
### Requirement: Two verified update modes

系统 SHALL 复用同一更新 SQL，测试同步 1/1 与异步 2/0，保持 binlog 开启及 flush timeout=1。普通 MVP 默认不自动新增异步测量。

#### Scenario: Both modes execute
- **WHEN** 运行完整对照
- **THEN** 同步为 redo=1/sync_binlog=1，异步为 redo=2/sync_binlog=0，实际值经回读并保存
- **AND** binlog 关闭或参数不匹配时停止，不将错误配置数据发布

### Requirement: Existing recipe and protocol

系统 SHALL 保持相同资源、表数、行数、SQL、随机种子和测量协议，每组复用原准备脚本重新生成数据，不要求逻辑快照或独立测试数据库。

#### Scenario: Six combinations are measured
- **WHEN** 执行完整对照
- **THEN** 两模式各测试并发 1/8/32，预热60秒、正式两次各120秒，差异超过10%时补第三次
- **AND** 原平均值/中位数和稳定性算法不变，失败运行不参与有效结果

### Requirement: Configuration restoration

系统 SHALL 限定本项目 MySQL，保存进入测试时的参数，在正常退出、失败、SIGINT/SIGTERM时停止本次负载并恢复、核验原值，不永久修改配置。

#### Scenario: Test finishes or is interrupted
- **WHEN** 测试结束或出现可捕获错误/中断
- **THEN** 回读验证原 redo、sync_binlog、timeout 已恢复
- **AND** 恢复失败时报告错误、退出非零、不发布看板

#### Scenario: Forced termination occurs
- **WHEN** 进程被 SIGKILL 或 VM 故障终止
- **THEN** 文档明确要求手动检查/恢复，不能声称此次轻量方案保证自动恢复

### Requirement: Unique output and actual environments

系统 SHALL 在现有目录使用唯一文件名前缀保存新结果、数据/环境清单与汇总，每次结果关联其实际环境，不覆盖旧原始与汇总。

#### Scenario: Results are collected
- **WHEN** 汇总新对照
- **THEN** 只汇总指定 runGroup 的两个更新场景，保持各组实际日志配置和日期
- **AND** 不把第一组同步配置写作所有场景的配置，旧文件保持不变

### Requirement: Fourth dashboard scenario

看板 SHALL 增加异步更新曲线，保留现有指标交互、原始结果入口和场景实际配置，兼容旧三场景数据。

#### Scenario: New results are displayed
- **WHEN** 完整有效对照且参数已恢复
- **THEN** 显示同步/异步更新的QPS、TPS、p95、p99，标明实际参数、日期和持久化风险
- **AND** 历史点查/混合明确是背景参照，不生成跨批次因果结论或独立比值区
- **AND** 发布前保留旧看板JSON副本，不要求历史报告选择功能

### Requirement: Side effect free dry run

新入口 SHALL 支持无需运行MySQL的只读 dry run，不启动容器、连接数据库、修改参数或生成文件。

#### Scenario: Dry run is executed
- **WHEN** 用户指定 dry-run
- **THEN** 输出六组合与预期日志参数、准备及恢复计划，并保持文件和数据库不变
