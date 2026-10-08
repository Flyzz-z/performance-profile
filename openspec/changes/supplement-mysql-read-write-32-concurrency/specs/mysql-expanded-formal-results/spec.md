## MODIFIED Requirements

### Requirement: Confirmed six scenario matrix
系统 SHALL 在同一正式结果组串行执行主键点查、同步索引更新、异步索引更新、无二级索引更新、单行INSERT和读写混合，各测试1/8/16并发，共18组合；已明确批准的主键点查和同步索引更新32并发补测按独立增量契约验收，不扩大完整入口的默认矩阵。

#### Scenario: Complete matrix executes
- **WHEN** 执行本轮完整正式入口
- **THEN** 六场景18组合全部重新测量，不包含32并发或范围查询
- **AND** MySQL为8 CPU/6 GiB，sysbench为4 CPU/1 GiB，Buffer Pool为3 GiB，平台为ARM64，软件版本与镜像一致
- **AND** 通用短时、子集或不同条件运行仍归类为verification；独立缓存实验按其自身完整两组契约验收，不作为六场景子集；只有满足本规范独立增量契约的两场景32并发补测属于正式增量

### Requirement: Whole current group publication
系统 SHALL 仅在六场景18组合及独立缓存两组完整、错误为零、环境与数据证据有效、重复协议满足且日志和缓存配置恢复成功后整体发布；任何一项失败都必须保留当前报告。用户明确批准的两场景32并发增量 SHALL 在独立契约完整验收后追加，不能通过通用partial模式绕过整组或增量验收。

#### Scenario: Formal report replaces the old one
- **WHEN** 整组验收通过
- **THEN** 最终JSON、索引和六条场景曲线全部来自本轮新测量
- **AND** 独立缓存结果具有自身实验标识和数据清单，只来自本轮两组测量，不混入六场景矩阵
- **AND** 旧4 CPU批次、此前8/2及8/4独立验证和短测不进入本轮结果
- **AND** 旧报告移到站点数据之外留存，新报告一次性替换，正式原始记录可追溯

#### Scenario: Approved supplement appends without replacing the baseline
- **WHEN** 两场景32并发补测完整验收通过
- **THEN** 原子追加两场景的新点、逐次记录及自身来源，不重新测量或改写现有1/8/16结果
- **AND** 缓存、热点实验、其他四场景及原实验日期保持不变，补测使用自己的日期和环境清单
- **AND** 不把新旧测量声称为同一批次，不新增过程说明横幅
- **AND** 缺组、混批、协议或环境不符、错误、恢复失败及原始证据不足均拒绝发布，原报告不变

### Requirement: Objective six scenario presentation
页面 SHALL 使用报告声明展示六场景及各自真实并发范围和实际8/4 CPU资源，保留四指标看板、真实日期、稳定性和原始链接，不恢复过程说明或风险提示横幅。

#### Scenario: New results are displayed
- **WHEN** 加载本轮正式JSON
- **THEN** 基础六场景各有1/8/16三个并发点，CPU列按各自配额归一化；已批准补测存在时，仅主键点查和同步索引更新追加32并发点
- **AND** 无二级索引场景可核验保留主键和缺少`k`索引，INSERT逐次结果展示真实阶段行数及增长
- **AND** 不把INSERT全程声称为固定100万行，不把不同写入语义包装为纯索引成本
- **AND** 桌面和移动端布局、筛选、刻度、并发选择及所有原始链接正常

#### Scenario: Previous report remains during implementation
- **WHEN** 新整组尚未发布而页面读取旧报告
- **THEN** 按旧报告自身场景、并发和配额展示，不提前标成8 CPU或六场景

#### Scenario: Only measured scenes appear at concurrency 32
- **WHEN** 选中32并发或读取其结果明细
- **THEN** 只展示有正式观测的主键点查和同步索引更新，不给其他场景补零、插值或复制旧值
- **AND** 32并发结果使用自身测量日期、环境、稳定性及原始链接；其他曲线保持其真实终点
- **AND** 索引峰值根据真实测量重新计算，日期来自峰值所属观测，不把所有基础结果改标为补测日期
- **AND** 保留读写混合7:2标注，缓存与热点独立区块不受并发筛选影响

## ADDED Requirements

### Requirement: Bounded formal concurrency 32 supplement
系统 SHALL 仅对主键点查和同步索引更新串行补测32并发，每场景独立准备10表各100000行，保留自增主键及k二级索引，均匀随机访问全部100万行；不复测16并发或扩展其他场景。

#### Scenario: Confirmed supplement executes
- **WHEN** 执行已批准补测
- **THEN** 平台为ARM64，MySQL 8 CPU/6 GiB、sysbench 4 CPU/1 GiB、Buffer Pool 3 GiB，软件与基础实验一致，binlog开启，redo/sync_binlog/timeout均为1
- **AND** 每场景预热30秒，执行两次90秒测量，TPS或p99差异超过30%补第三次，两次取均值、三次取中位数，保留原稳定性口径和所有有效观测
- **AND** 正式测量保存两端5秒间隔资源证据，覆盖至少72秒、跨度不超过100秒、连续间隔不超过10秒，展示TPS、QPS、p95/p99、错误数、CPU配额占比及限流计数
- **AND** 核验实际配额和所有权，禁止并行负载，成功、失败或可捕获中断后清理自身负载容器并恢复、回读日志，不删除数据卷
- **AND** 不根据结果是否达到平台决定补测64并发或重测较慢观测，不声称已经定位唯一瓶颈

#### Scenario: Evidence and publication are isolated
- **WHEN** 准备汇总或发布补测
- **THEN** 从原始输出、资源、数据结构及环境证据复算，核验两个组合属于同一独立补测组、正确SQL和访问范围、完整重复协议及恢复状态
- **AND** dry run只读；短验证、排障及未验收记录不进入最终页面，既有通用partial和完整18组合校验不放宽
- **AND** 新正式标识不能覆盖既有原始记录，旧报告备份保留于站点数据之外，所有既有观测及独立实验深度比较不变
