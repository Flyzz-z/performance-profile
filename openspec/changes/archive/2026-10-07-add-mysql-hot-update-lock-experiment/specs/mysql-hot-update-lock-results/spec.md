## Purpose

在固定16并发及相同SQL、数据结构和资源限额下，以分散更新与总计10条热点记录的更新对照，量化吞吐、延迟和行锁等待。实验采用用户确认的单次60秒测量协议，作为独立正式区块展示，不混入既有主测试、缓存实验或过程验证数据。

## ADDED Requirements

### Requirement: Independent single measurement pair
系统 SHALL 仅执行16并发的分散与热点两组，每组独立预热30秒、正式测量60秒，仅一次测量，不补跑、不计算重复稳定性评级。

#### Scenario: Complete pair
- **WHEN** 执行已确认的独立正式实验
- **THEN** 同一实验批次串行完成分散与热点两组，分别保存预热和唯一正式测量
- **AND** 不新增1或8并发，不套用主测试的90秒、两次及30%补跑协议

### Requirement: Matched data and bounded update ranges
系统 SHALL 为两组分别准备相同的10张表、每表100000行，保留相同主键、自增属性及k二级索引，使用相同的单行k=k+1主键定位更新和均匀随机选表。

#### Scenario: Dispersed and hot key sets
- **WHEN** 分散组执行更新
- **THEN** 均匀随机访问全部10张表及每表完整ID范围1至100000，共100万条可更新记录
- **WHEN** 热点组执行更新
- **THEN** 在同样10张表中仅更新每表id=1，共10条固定热点记录，不能误作每表10条或单条全局热点
- **AND** 两组可更新记录数与实际数据总量分别标注，原始命令和数据清单能够核验上述范围

### Requirement: Actual environment and resource evidence
系统 SHALL 维持ARM64、MySQL 8 CPU/6 GiB、sysbench 4 CPU/1 GiB、Buffer Pool 3 GiB，使用binlog开启、redo=1、sync_binlog=1、timeout=1及相同软件镜像。

#### Scenario: Resource quotas verified
- **WHEN** 准备或测量独立两组
- **THEN** 回读实际容器限额及MySQL配置，拒绝不同条件并禁止并行压测
- **AND** 每次60秒测量保存两端原始CPU及限流采样，5秒采样间隔，有效覆盖至少48秒、跨度不超过70秒、连续间隔不超过10秒
- **AND** 结束或可捕获中断后清理本实验负载容器，恢复并回读日志配置，不删除数据卷

### Requirement: Windowed row lock counters
系统 SHALL 在每次正式测量窗口前后保存行锁等待次数、累计等待毫秒及实际时间，用有效增量展示等待次数、等待次数每秒、累计等待时间及平均每次等待时间。

#### Scenario: Valid lock evidence
- **WHEN** 原始计数及窗口有效
- **THEN** 等待次数为前后次数差，累计等待毫秒为前后时间差，平均等待毫秒为时间差除以次数差，不直接使用全局累计平均值
- **AND** 等待次数为零且时间差为零时显示零，等待次数为零但时间差非零时拒绝不一致证据
- **AND** 缺失、非数值、负增量或无效时间拒绝验收，不能用缺失值补零

#### Scenario: Correct interpretation
- **WHEN** 显示锁等待和失败指标
- **THEN** 锁等待累计时间可跨线程累计，不作为墙钟时间百分比；锁等待次数不等同于失败事务数
- **AND** 失败数按sysbench正式输出的ignored errors计数保留非零值，reconnects单独留存，不把重连直接计为失败事务；致命退出、无法解析或无效证据不能发布为成功实验
- **AND** 不把两组全部吞吐差异或事务延迟差声称为纯锁耗时，不预设热点组一定出现明显竞争

### Requirement: Isolated result presentation and publication
系统 SHALL 在MySQL页面独立展示两组TPS、p95/p99、锁等待指标、两端CPU配额占比和失败数，以及该实验的日期、协议、目标记录数、真实环境与原始证据链接。

#### Scenario: Complete evidence publishes atomically
- **WHEN** 同一批次两组的正式测量、数据、资源和锁证据及恢复核验完整
- **THEN** 仅更新独立热点实验结果，现有六场景、缓存实验、主测试日期、原始链接和统计结果保持不变
- **AND** 两组不进入主场景曲线、代表性峰值或缓存对比，不受主场景并发/场景筛选影响
- **AND** 单次测量不显示稳定性评级；无该实验的旧报告正常渲染

#### Scenario: Incomplete pair leaves report unchanged
- **WHEN** 只有一组、跨批次拼接、协议或目标范围错误、恢复失败或证据无效
- **THEN** 拒绝更新页面，原报告保持不变；过程验证或无效记录仅在独立验证目录留存
