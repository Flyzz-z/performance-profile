# mysql-formal-results Specification

## Purpose
在统一的4 CPU压测端条件下完成已有MySQL四场景的正式实验，以同轮数据直观反映吞吐与延迟，并保留资源辅助证据，严格排除内部验证、旧条件及额外试验数据进入最终产物。
## Requirements
### Requirement: Fixed complete formal matrix
系统 SHALL 使用sysbench 4 CPU/1 GiB、MySQL 4 CPU/6 GiB、Buffer Pool 3 GiB、ARM64和固定镜像，在同一组运行四场景各1/8/32并发。

#### Scenario: Full formal experiment executes
- **WHEN** 用户运行正式入口
- **THEN** 串行完成点查、同步更新、异步更新、读写混合的12组合，每组同recipe重建100万行
- **AND** 保持60秒预热、两次120秒、TPS/p99差异超过10%补第三次，原统计算法不变

### Requirement: Formal resource evidence
每次正式测量 SHALL 保存MySQL及压测端CPU使用、实际配额、限流计数与采样原始记录，并明确其是同次正式实验的辅助指标。

#### Scenario: Resource evidence is recorded
- **WHEN** 正式测量完成
- **THEN** 两容器具有覆盖至少80%测量时长的有效采样和汇总
- **AND** CPU百分比区分单核使用与配额占比，限流时间不被错误当作墙钟时间百分比

#### Scenario: Evidence is insufficient
- **WHEN** 实际CPU配额不符、计数缺失或采样不足
- **THEN** 正式结果不得发布，不用缺失值补零或声称瓶颈已定位

### Requirement: Verified logging and restoration
系统 SHALL 保持binlog开启，除异步更新2/0外均为1/1，timeout=1，并在成功、失败、可捕获中断后恢复原参数。

#### Scenario: Experiment finishes or fails
- **WHEN** 正式入口退出
- **THEN** 核验日志原值恢复；失败、无效运行或恢复失败均不更新当前报告

### Requirement: Formal only publication
最终看板及其JSON SHALL 只包含一组完整正式四场景数据，不合并旧点查/混合，不添加压测端配额对照曲线或内部验证结果。

#### Scenario: New report is published
- **WHEN** 12组合完整、错误为零、证据有效且恢复成功
- **THEN** 一次性替换当前报告，所有指标/原始链接均来自该组正式测量
- **AND** 旧报告与验证单独留存于最终站点数据之外，不进入索引或代表指标

#### Scenario: Verification or partial collection is requested
- **WHEN** 输入是短测、验证、旧条件或不完整矩阵
- **THEN** 可以单独保存开发资料，但禁止覆盖最终报告

#### Scenario: Authorized interrupted combination is replaced
- **WHEN** 用户确认替换采样中断的读写混合32并发组合并发布
- **THEN** 完整隔离保存该组合原始资料，按原环境、数据规模和协议重新执行完整组合
- **AND** 其余11组合原始记录不变，替换记录归属原正式结果组，重新核验全部12组合后才发布
- **AND** 普通子集入口仍为verification，不通过删除单次异常观测或放宽门槛替代整组合补测

### Requirement: Evidence bounded conclusions
页面 SHALL 显示4 CPU压测端、正式场景、实际日志参数、重复性及资源辅助指标，结论不得超出采样支持范围。

#### Scenario: Presentation excludes process notices
- **WHEN** 渲染最终页面或读取保留旧字段的兼容报告
- **THEN** 页面不展示持久化风险横幅、历史背景参照或批次拼接等过程说明
- **AND** 风险说明保留在实验README，页面保留场景名称、实际参数、测量日期和稳定性
- **AND** 不改变性能数据及其来源，不将未发布的新数据或旧报告误标为本轮正式结果

#### Scenario: Point select throughput falls
- **WHEN** 正式数据仍出现并发增加但吞吐下降
- **THEN** 结合CPU与限流证据陈述现象，证据不足则标记未定位
- **AND** 不仅凭曲线认定MySQL容量上限，不公开内部诊断为额外性能场景
