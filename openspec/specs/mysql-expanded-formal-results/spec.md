# mysql-expanded-formal-results Specification

## Purpose

在用户选定的MySQL 8 CPU和sysbench 4 CPU条件下，以1/8/16并发统一测量六类读写场景，提供可核验的索引维护对照和单行插入增长记录；另以16并发独立比较1/2 GiB Buffer Pool。最终产物只使用本轮完整正式实验，不混入旧批次、临时验证或未确认的场景。

## Requirements

### Requirement: Confirmed six scenario matrix
系统 SHALL 在同一正式结果组串行执行主键点查、同步索引更新、异步索引更新、无二级索引更新、单行INSERT和读写混合，各测试1/8/16并发，共18组合。

#### Scenario: Complete matrix executes
- **WHEN** 执行本轮完整正式入口
- **THEN** 六场景18组合全部重新测量，不包含32并发或范围查询
- **AND** MySQL为8 CPU/6 GiB，sysbench为4 CPU/1 GiB，Buffer Pool为3 GiB，平台为ARM64，软件版本与镜像一致
- **AND** 六场景的短时、子集或不同条件运行归类为verification；独立缓存实验按其自身完整两组契约验收，不作为六场景子集

### Requirement: Same update workload without secondary index
无二级索引更新 SHALL 与同步索引更新使用相同的数据列、初始行数、随机规则、单行UPDATE及1/1日志策略，仅改变是否存在`k`的二级索引，主键必须保留。

#### Scenario: Controlled index comparison runs
- **WHEN** 测量无二级索引更新
- **THEN** 每组合重新准备10表各100000行，`id`为主键，`k`仍为相同类型字段，但没有`k`二级索引
- **AND** 执行`UPDATE ... SET k=k+1 WHERE id=?`，每事件一条SQL，不改为更新`c`字段
- **AND** 记录并核验所有表的实际列与索引结构，结构或策略不符则拒绝发布

### Requirement: Single row insert with repeat isolation
单行INSERT SHALL 使用每表顺序自增主键，保留`k`二级索引，每事件插入一行；每次正式重复测量的预热前重新准备100万行，不继承上一重复的增长结果。

#### Scenario: Insert repetitions start from the confirmed recipe
- **WHEN** 执行INSERT的第一次、第二次或补充第三次测量
- **THEN** 先独立准备10表各100000行，核验自增主键、二级索引和自增SQL行为，再执行30秒INSERT预热及90秒测量
- **AND** 每次准备具有独立且不可覆盖的环境和数据集清单
- **AND** 记录预热前、预热后、测量前、测量后的实际行数，插入增长与对应阶段成功事件数一致
- **AND** 不通过删除旧行、批量INSERT或固定行数假象改变该场景含义

#### Scenario: Insert evidence is insufficient
- **WHEN** 初始行数不是100万、自增或索引结构不符、阶段行数缺失或增长不匹配
- **THEN** 本轮正式结果不能发布

### Requirement: Preserved measurement and logging protocol
系统 SHALL 保持30秒预热、两次90秒正式测量，TPS或p99差异超过30%补第三次；非INSERT每组合预热一次，INSERT每次重复独立预热。两次取均值、三次取中位数，保留原稳定性算法和所有有效观测。

#### Scenario: Logging and repetitions are verified
- **WHEN** 启动和结束任一场景
- **THEN** binlog开启，timeout为1，仅异步索引更新使用redo=2/sync_binlog=0，其余场景使用1/1
- **AND** 成功、失败和可捕获中断后恢复并回读原日志参数
- **AND** 不隐藏不稳定结果，不通过挑选较快观测绕过补跑规则

### Requirement: Resource evidence uses actual individual quotas
每次正式测量 SHALL 核验两端实际限额并保存5秒间隔原始CPU采样，MySQL配额占比按8 CPU计算，sysbench按4 CPU计算。

#### Scenario: Resource evidence is sufficient
- **WHEN** 测量结束
- **THEN** 两端采样覆盖至少72秒，跨度不超过100秒，连续间隔不超过10秒，计数有效且实际限额与本轮一致
- **AND** 单核CPU百分比、配额占比、限流次数和累计限流时间分别解释，不把累计限流时间当作墙钟利用率

#### Scenario: Quota or sampling is invalid
- **WHEN** 实际CPU仍为旧配额、采样不足或计数缺失
- **THEN** 正式发布被拒绝，不用缺失值补零或仅凭配置文件声称资源已生效

### Requirement: Whole current group publication
系统 SHALL 仅在六场景18组合及独立缓存两组完整、错误为零、环境与数据证据有效、重复协议满足且日志和缓存配置恢复成功后整体发布；任何一项失败都必须保留当前报告。

#### Scenario: Formal report replaces the old one
- **WHEN** 整组验收通过
- **THEN** 最终JSON、索引和六条场景曲线全部来自本轮新测量
- **AND** 独立缓存结果具有自身实验标识和数据清单，只来自本轮两组测量，不混入六场景矩阵
- **AND** 旧4 CPU批次、此前8/2及8/4独立验证和短测不进入本轮结果
- **AND** 旧报告移到站点数据之外留存，新报告一次性替换，正式原始记录可追溯

### Requirement: Objective six scenario presentation
页面 SHALL 使用报告声明展示六场景、1/8/16并发和实际8/4 CPU资源，保留四指标看板、真实日期、稳定性和原始链接，不恢复过程说明或风险提示横幅。

#### Scenario: New results are displayed
- **WHEN** 加载本轮正式JSON
- **THEN** 六场景各有三个并发点，CPU列按各自配额归一化
- **AND** 无二级索引场景可核验保留主键和缺少`k`索引，INSERT逐次结果展示真实阶段行数及增长
- **AND** 不把INSERT全程声称为固定100万行，不把不同写入语义包装为纯索引成本
- **AND** 桌面和移动端布局、筛选、刻度、并发选择及所有原始链接正常

#### Scenario: Previous report remains during implementation
- **WHEN** 新整组尚未发布而页面读取旧报告
- **THEN** 按旧报告自身场景、并发和配额展示，不提前标成8 CPU或六场景

### Requirement: Independent two capacity buffer pool experiment
系统 SHALL 在16并发下独立比较1 GiB和2 GiB Buffer Pool，两组使用同一冻结数据集、MySQL 8 CPU/6 GiB、sysbench 4 CPU/1 GiB、ARM64、相同镜像和1/1日志策略，只改变缓存容量。

#### Scenario: Dataset is calibrated and shared
- **WHEN** 准备独立缓存实验数据
- **THEN** 从10张表各600000行的标准sysbench结构开始，核验实际主键索引页占用，调整行数使总占用达到1.4–1.6 GiB后冻结同一份数据
- **AND** 保存行数、索引结构、页大小、占用和数据集标识，二级索引占用单独记录，不以行数估算或ibd文件大小代替主键工作集证据
- **AND** 两组均匀随机查询全部表及全ID范围，table-size与冻结的实际每表行数一致，组间不重建或写入数据
- **AND** 校准与短验证记录属于过程资料，不出现在最终对比中

#### Scenario: Both cache capacities are measured
- **WHEN** 运行任一缓存组
- **THEN** 独立重启MySQL、禁用Buffer Pool dump/load，回读容量为1073741824或2147483648字节，两组instances=1且chunk=128 MiB
- **AND** 准备活动结束后预热30秒，记录分段QPS和页面读取速率核验趋稳，未趋稳则记录现象及重复波动，不自动延长预热
- **AND** 执行两次90秒测量，QPS或p99差异超过30%追加第三次，两次取均值、三次取中位数，保留所有有效观测与稳定性
- **AND** 成功、失败及可捕获中断后恢复并回读原3 GiB缓存、dump/load和日志配置

### Requirement: Window based buffer pool miss evidence
系统 SHALL 保存每次缓存正式测量窗口前后的Innodb_buffer_pool_read_requests、Innodb_buffer_pool_reads和时间，以增量计算页面请求、缺页读取速率及近似页命中率，同时保存QPS、p95/p99与两端资源证据。

#### Scenario: Miss metrics are derived from valid counters
- **WHEN** 汇总缓存测量
- **THEN** 缺页读取速率等于reads增量除以实际窗口秒数，近似页命中率等于1减去reads增量/read_requests增量
- **AND** 原始计数与窗口可追溯，计数重置、缺失、请求增量为零或无效时间导致发布拒绝，不用缺失值补零或显示100%命中
- **AND** 指标口径为InnoDB页面请求与Buffer Pool未命中，不解释成SQL命中率、操作系统缺页或已证实的SSD物理读取

### Requirement: Standalone buffer pool comparison presentation
页面 SHALL 独立展示1 GiB与2 GiB两组缓存结果、实际数据集和各自环境，不与其他实验交叉比较。

#### Scenario: Cache results are displayed separately
- **WHEN** 加载本轮完整正式报告
- **THEN** 独立区域展示两组QPS、p95/p99、页命中率、缺页读取速率、稳定性和原始链接
- **AND** 显示实际缓存容量、8/4 CPU及6/1 GiB内存、ARM64、16并发、真实行数与主键页占用
- **AND** 两组不加入六场景并发曲线、不受其并发筛选影响，也不与六场景或历史数据计算性能差异
- **AND** 不预设必然的性能差距，未出现预期差异时保留实测结果
